import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

// Área de Eventos, Fase 1: apenas escrita (criar inscrição, marcar pago,
// cancelar). Leitura de events/event_registration_types/event_registrations
// é direta pelo navegador via RLS (mesmo padrão de stock_orders) — não
// duplicada aqui.

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function parseObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return isPlainObject(body) ? body : null;
  } catch {
    return null;
  }
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function databaseError(
  error: { code?: string; message?: string },
  operation: string,
): Response {
  console.error(`api-v1 events ${operation}:`, error);
  if (error.code === "P0002") {
    return jsonResponse({ error: error.message, code: "not_found" }, 404);
  }
  if (error.code === "22023") {
    return jsonResponse({ error: error.message, code: "invalid_request" }, 400);
  }
  if (error.code === "P0001") {
    return jsonResponse(
      { error: error.message, code: "invalid_transition" },
      409,
    );
  }
  return jsonResponse({
    error: "Não foi possível processar a inscrição",
    code: "database_error",
  }, 500);
}

export async function handleEventsRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  if (path === "/events/registrations" && req.method === "POST") {
    const body = await parseObject(req);
    if (
      !body ||
      typeof body.event_id !== "string" || !UUID_PATTERN.test(body.event_id) ||
      typeof body.registration_type_id !== "string" || !UUID_PATTERN.test(body.registration_type_id) ||
      typeof body.customer_id !== "string" || !UUID_PATTERN.test(body.customer_id) ||
      (body.form_answers !== undefined && !isPlainObject(body.form_answers))
    ) {
      return jsonResponse({
        error: "Dados da inscrição inválidos",
        code: "invalid_request",
      }, 400);
    }

    const { data, error } = await supabase.rpc("create_event_registration", {
      p_event_id: body.event_id,
      p_registration_type_id: body.registration_type_id,
      p_customer_id: body.customer_id,
      p_form_answers: body.form_answers ?? {},
      p_actor_id: actorId,
    });
    if (error) return databaseError(error, "create registration");
    return jsonResponse({ data }, 201);
  }

  const payMatch = path.match(/^\/events\/registrations\/([^/]+)\/payment$/);
  if (payMatch && req.method === "POST") {
    const [, registrationId] = payMatch;
    if (!UUID_PATTERN.test(registrationId)) {
      return jsonResponse({
        error: "Identificador de inscrição inválido",
        code: "invalid_registration_id",
      }, 400);
    }

    const body = await parseObject(req);
    if (
      !body ||
      typeof body.payment_method !== "string" || !body.payment_method.trim() ||
      (body.payment_date !== undefined && body.payment_date !== null && !isCalendarDate(body.payment_date))
    ) {
      return jsonResponse({
        error: "Dados de pagamento inválidos",
        code: "invalid_request",
      }, 400);
    }

    const { data, error } = await supabase.rpc("record_event_registration_manual_payment", {
      p_registration_id: registrationId,
      p_payment_method: body.payment_method,
      p_payment_date: body.payment_date ?? null,
      p_actor_id: actorId,
    });
    if (error) return databaseError(error, "record payment");
    return jsonResponse({ data });
  }

  const cancelMatch = path.match(/^\/events\/registrations\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const [, registrationId] = cancelMatch;
    if (!UUID_PATTERN.test(registrationId)) {
      return jsonResponse({
        error: "Identificador de inscrição inválido",
        code: "invalid_registration_id",
      }, 400);
    }

    const body = await parseObject(req);
    if (!body || typeof body.reason !== "string" || !body.reason.trim()) {
      return jsonResponse({
        error: "Informe o motivo do cancelamento",
        code: "invalid_request",
      }, 400);
    }

    const { data, error } = await supabase.rpc("cancel_event_registration", {
      p_registration_id: registrationId,
      p_reason: body.reason,
      p_actor_id: actorId,
    });
    if (error) return databaseError(error, "cancel registration");
    return jsonResponse({ data });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Rota PÚBLICA (sem login). Fica separada do resto porque roda antes do
// requireAdmin no index.ts. O hash de IP é feito aqui: é o único ponto que
// conhece o cabeçalho da requisição, e o limite de taxa depende dele.
// ---------------------------------------------------------------------------

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0] ||
    ""
  ).trim().slice(0, 80);
}

export async function handlePublicEventRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
): Promise<Response | null> {
  const publicEventMatch = path.match(/^\/public\/events\/([^/]+)$/);
  if (publicEventMatch) {
    if (req.method !== "GET") {
      return jsonResponse({
        error: "Método não permitido",
        code: "method_not_allowed",
      }, 405);
    }

    let slug = "";
    try {
      slug = decodeURIComponent(publicEventMatch[1]).trim();
    } catch {
      return jsonResponse({
        error: "Link de inscrição inválido",
        code: "invalid_slug",
      }, 400);
    }

    if (!slug || slug.length > 200) {
      return jsonResponse({
        error: "Link de inscrição inválido",
        code: "invalid_slug",
      }, 400);
    }

    const { data, error } = await supabase.rpc("get_public_event", {
      p_slug: slug,
    });
    if (error) return databaseError(error, "public event");
    if (!data) {
      return jsonResponse({
        error: "Inscrições indisponíveis",
        code: "not_found",
      }, 404);
    }

    const { data: coaches, error: coachesError } = await supabase
      .from("assessment_coaches")
      .select("id,name")
      .eq("active", true)
      .eq("public_visible", true)
      .order("name");
    if (coachesError) return databaseError(coachesError, "public coaches");

    return jsonResponse({
      ok: true,
      data: isPlainObject(data) ? { ...data, coaches: coaches || [] } : data,
    });
  }

  if (path !== "/public/event-registrations") return null;
  if (req.method !== "POST") {
    return jsonResponse({
      error: "Método não permitido",
      code: "method_not_allowed",
    }, 405);
  }

  const body = await parseObject(req);
  const payload = body && isPlainObject(body.payload) ? body.payload : null;
  const customer = payload && isPlainObject(payload.customer) ? payload.customer : null;
  const optionalCustomerFields = ["whatsapp", "email", "cpf"];

  if (
    !payload || !customer ||
    typeof payload.event_slug !== "string" || !payload.event_slug.trim() ||
    typeof payload.registration_type_id !== "string" ||
    !UUID_PATTERN.test(payload.registration_type_id) ||
    typeof customer.full_name !== "string" || !customer.full_name.trim() ||
    typeof customer.coach_id !== "string" ||
    !UUID_PATTERN.test(customer.coach_id) ||
    optionalCustomerFields.some((field) =>
      customer[field] !== undefined && customer[field] !== null &&
      typeof customer[field] !== "string"
    ) ||
    (payload.form_answers !== undefined && !isPlainObject(payload.form_answers))
  ) {
    return jsonResponse({
      error: "Dados da inscrição inválidos",
      code: "invalid_request",
    }, 400);
  }

  const ip = clientIp(req);
  if (!ip) {
    return jsonResponse({
      error: "Não foi possível validar a origem da inscrição",
      code: "invalid_origin",
    }, 400);
  }

  const cpfSeed = typeof customer.cpf === "string"
    ? customer.cpf.replace(/\D/g, "")
    : "";
  const phoneSeed = typeof customer.whatsapp === "string"
    ? customer.whatsapp.replace(/\D/g, "")
    : "";
  const emailSeed = typeof customer.email === "string"
    ? customer.email.trim().toLowerCase()
    : "";
  const fallbackSeed = [
    payload.event_slug.trim().toLowerCase(),
    customer.coach_id,
    customer.full_name.trim().toLowerCase(),
  ].join("|");

  const [ipHash, phoneHash] = await Promise.all([
    sha256Hex(ip),
    sha256Hex(cpfSeed || phoneSeed || emailSeed || fallbackSeed),
  ]);

  const { data, error } = await supabase.rpc(
    "create_rate_limited_public_event_registration",
    { p_ip_hash: ipHash, p_phone_hash: phoneHash, p_payload: payload },
  );
  if (error) return databaseError(error, "public registration");
  return jsonResponse({ ok: true, data }, 201);
}
