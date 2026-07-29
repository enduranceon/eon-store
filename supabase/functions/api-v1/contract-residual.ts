import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 50 &&
    Number.isFinite(Date.parse(value));
}

function isMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    value <= 1_000_000;
}

function nullableText(value: unknown, max: number): boolean {
  return value === null ||
    (typeof value === "string" && value.trim().length <= max);
}

function exactKeys(body: Record<string, unknown>, allowed: string[]): boolean {
  const keys = Object.keys(body);
  return keys.length === allowed.length &&
    keys.every((key) => allowed.includes(key));
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function operationKey(req: Request): string | null {
  const key = req.headers.get("Idempotency-Key")?.trim() || "";
  return IDEMPOTENCY_PATTERN.test(key) ? key : null;
}

function databaseError(
  error: { code?: string; message?: string },
  publicMessage = "Não foi possível atualizar o contrato",
): Response {
  console.error("api-v1 contract residual:", error);
  if (error.code === "P0002") {
    return jsonResponse({ error: error.message, code: "not_found" }, 404);
  }
  if (error.code === "22023") {
    return jsonResponse({ error: error.message, code: "invalid_request" }, 400);
  }
  if (error.code === "P0001" || error.code === "23505") {
    return jsonResponse({
      error: error.message,
      code: "invalid_transition",
    }, 409);
  }
  return jsonResponse({ error: publicMessage, code: "database_error" }, 500);
}

function validAdminCreation(body: Record<string, unknown>): boolean {
  return exactKeys(body, [
    "customer_id",
    "coach_id",
    "plan_id",
    "start_date",
    "installments",
    "enrollment_fee",
    "manual_discount",
    "discount_reason",
    "auto_renewal",
    "notes",
    "replacement_contract_id",
  ]) && typeof body.customer_id === "string" &&
    UUID_PATTERN.test(body.customer_id) && typeof body.coach_id === "string" &&
    UUID_PATTERN.test(body.coach_id) && typeof body.plan_id === "string" &&
    UUID_PATTERN.test(body.plan_id) && isCalendarDate(body.start_date) &&
    typeof body.installments === "number" &&
    Number.isInteger(body.installments) && body.installments >= 1 &&
    body.installments <= 120 && isMoney(body.enrollment_fee) &&
    isMoney(body.manual_discount) && nullableText(body.discount_reason, 500) &&
    typeof body.auto_renewal === "boolean" && nullableText(body.notes, 2000) &&
    (body.replacement_contract_id === null ||
      (typeof body.replacement_contract_id === "string" &&
        UUID_PATTERN.test(body.replacement_contract_id)));
}

export async function handleContractResidualRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  if (path === "/orders/contracts") {
    if (req.method !== "POST") {
      return jsonResponse({
        error: "Método não permitido",
        code: "method_not_allowed",
      }, 405);
    }
    const key = operationKey(req);
    const body = await readBody(req);
    if (!key || !body || !validAdminCreation(body)) {
      return jsonResponse({
        error: "Dados do contrato ou chave de idempotência inválidos",
        code: "invalid_request",
      }, 400);
    }
    const { data, error } = await supabase.rpc(
      "create_assessment_contract_from_admin",
      {
        p_customer_id: body.customer_id,
        p_coach_id: body.coach_id,
        p_plan_id: body.plan_id,
        p_start_date: body.start_date,
        p_installments: body.installments,
        p_enrollment_fee: body.enrollment_fee,
        p_manual_discount: body.manual_discount,
        p_discount_reason: body.discount_reason,
        p_auto_renewal: body.auto_renewal,
        p_notes: body.notes,
        p_replacement_contract_id: body.replacement_contract_id,
        p_idempotency_key: key,
        p_actor_id: actorId,
      },
    );
    if (error) return databaseError(error, "Não foi possível criar o contrato");
    return jsonResponse({ data }, 201);
  }

  if (path === "/orders/contracts/transitions") {
    if (req.method !== "POST") {
      return jsonResponse({
        error: "Método não permitido",
        code: "method_not_allowed",
      }, 405);
    }
    const body = await readBody(req);
    if (!body || !exactKeys(body, [])) {
      return jsonResponse({
        error: "Requisição inválida",
        code: "invalid_request",
      }, 400);
    }
    const { data, error } = await supabase.rpc(
      "apply_assessment_contract_transitions",
      { p_actor_id: actorId },
    );
    if (error) return databaseError(error);
    return jsonResponse({ data });
  }

  const match = path.match(
    /^\/orders\/contract\/([^/]+)\/(discount|refund-completion)$/,
  );
  if (!match) return null;
  const [, contractId, action] = match;
  if (!UUID_PATTERN.test(contractId)) {
    return jsonResponse(
      { error: "Contrato inválido", code: "invalid_request" },
      400,
    );
  }
  const expectedMethod = action === "discount" ? "PATCH" : "POST";
  if (req.method !== expectedMethod) {
    return jsonResponse({
      error: "Método não permitido",
      code: "method_not_allowed",
    }, 405);
  }
  const body = await readBody(req);
  if (!body || !isTimestamp(body.expected_updated_at)) {
    return jsonResponse({
      error: "Versão do contrato inválida",
      code: "invalid_request",
    }, 400);
  }

  if (action === "discount") {
    if (
      !exactKeys(body, [
        "manual_discount",
        "discount_reason",
        "discount_recurring",
        "expected_updated_at",
      ]) || !isMoney(body.manual_discount) ||
      !nullableText(body.discount_reason, 500) ||
      typeof body.discount_recurring !== "boolean"
    ) {
      return jsonResponse({
        error: "Desconto inválido",
        code: "invalid_request",
      }, 400);
    }
    const { data, error } = await supabase.rpc(
      "update_assessment_contract_discount",
      {
        p_contract_id: contractId,
        p_manual_discount: body.manual_discount,
        p_discount_reason: body.discount_reason,
        p_discount_recurring: body.discount_recurring,
        p_expected_updated_at: body.expected_updated_at,
        p_actor_id: actorId,
      },
    );
    if (error) return databaseError(error);
    return jsonResponse({ data });
  }

  if (
    !exactKeys(body, ["refund_date", "refund_notes", "expected_updated_at"]) ||
    !isCalendarDate(body.refund_date) || !nullableText(body.refund_notes, 1000)
  ) {
    return jsonResponse({
      error: "Dados do estorno inválidos",
      code: "invalid_request",
    }, 400);
  }
  const { data, error } = await supabase.rpc(
    "complete_assessment_contract_refund",
    {
      p_contract_id: contractId,
      p_refund_date: body.refund_date,
      p_refund_notes: body.refund_notes,
      p_expected_updated_at: body.expected_updated_at,
      p_actor_id: actorId,
    },
  );
  if (error) return databaseError(error, "Não foi possível concluir o estorno");
  return jsonResponse({ data });
}

function validPublicEnrollment(body: Record<string, unknown>): boolean {
  const cpf = typeof body.cpf === "string" ? body.cpf.replace(/\D/g, "") : "";
  const phone = typeof body.whatsapp === "string"
    ? body.whatsapp.replace(/\D/g, "")
    : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  return exactKeys(body, [
    "plan_id",
    "coach_id",
    "full_name",
    "whatsapp",
    "email",
    "cpf",
    "gender",
    "birth_date",
    "payment_type",
    "installments",
  ]) && typeof body.plan_id === "string" && UUID_PATTERN.test(body.plan_id) &&
    typeof body.coach_id === "string" && UUID_PATTERN.test(body.coach_id) &&
    typeof body.full_name === "string" && body.full_name.trim().length >= 2 &&
    body.full_name.trim().length <= 200 && phone.length >= 10 &&
    phone.length <= 13 && cpf.length === 11 &&
    (email === "" || (email.length <= 320 && EMAIL_PATTERN.test(email))) &&
    (body.gender === null ||
      (typeof body.gender === "string" && body.gender.length <= 50)) &&
    (body.birth_date === null || isCalendarDate(body.birth_date)) &&
    ["card", "pix_boleto"].includes(String(body.payment_type)) &&
    typeof body.installments === "number" &&
    Number.isInteger(body.installments) && body.installments >= 1 &&
    body.installments <= 120;
}

export async function handlePublicAssessmentRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
): Promise<Response | null> {
  if (path !== "/public/assessment-enrollments") return null;
  if (req.method !== "POST") {
    return jsonResponse({
      error: "Método não permitido",
      code: "method_not_allowed",
    }, 405);
  }
  const key = operationKey(req);
  const body = await readBody(req);
  if (!key || !body || !validPublicEnrollment(body)) {
    return jsonResponse({
      error: "Dados da adesão ou chave de idempotência inválidos",
      code: "invalid_request",
    }, 400);
  }
  const [{ data: publicPlan, error: planError }, { data: publicCoach, error: coachError }] = await Promise.all([
    supabase.from("assessment_plans")
      .select("id,modality_id")
      .eq("id", body.plan_id)
      .eq("active", true)
      .eq("available_online", true)
      .maybeSingle(),
    supabase.from("assessment_coaches")
      .select("id,modality_ids")
      .eq("id", body.coach_id)
      .eq("active", true)
      .eq("public_visible", true)
      .maybeSingle(),
  ]);
  if (planError) return databaseError(planError, "Não foi possível validar o plano");
  if (coachError) return databaseError(coachError, "Não foi possível validar o treinador");
  if (!publicPlan || !publicCoach ||
      !Array.isArray(publicCoach.modality_ids) ||
      !publicCoach.modality_ids.includes(publicPlan.modality_id)) {
    return jsonResponse({
      error: "Treinador indisponível para a modalidade deste plano",
      code: "invalid_request",
    }, 400);
  }
  const { data, error } = await supabase.rpc(
    "create_public_assessment_enrollment",
    {
      p_plan_id: body.plan_id,
      p_coach_id: body.coach_id,
      p_full_name: String(body.full_name).trim(),
      p_whatsapp: String(body.whatsapp).replace(/\D/g, ""),
      p_email: String(body.email).trim().toLowerCase() || null,
      p_cpf: String(body.cpf).replace(/\D/g, ""),
      p_gender: body.gender || null,
      p_birth_date: body.birth_date || null,
      p_payment_type: body.payment_type,
      p_installments: body.installments,
      p_idempotency_key: key,
    },
  );
  if (error) {
    return databaseError(error, "Não foi possível registrar a adesão");
  }
  return jsonResponse({ data }, 201);
}
