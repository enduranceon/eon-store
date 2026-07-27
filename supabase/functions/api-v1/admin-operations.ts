import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const COMMUNICATION_EVENT_TYPES = new Set([
  "payment_message_sent",
  "onboarding_welcome_sent",
  "onboarding_checkin_sent",
  "renewal_message_sent",
  "communication_task_ignored",
]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Payload = Record<string, unknown>;

async function readBody(req: Request, max = 262_144): Promise<Payload | null> {
  try {
    const raw = await req.text();
    if (!raw || raw.length > max) return null;
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function databaseError(
  error: { code?: string; message?: string },
  operation: string,
): Response {
  console.error(`api-v1 admin operation ${operation}:`, error);
  if (error.code === "P0002") {
    return jsonResponse({ error: error.message, code: "not_found" }, 404);
  }
  if (error.code === "P0001" || error.code === "23505") {
    return jsonResponse({ error: error.message, code: "conflict" }, 409);
  }
  if (
    ["22023", "22P02", "23514", "23503", "23502"].includes(error.code ?? "")
  ) {
    return jsonResponse({
      error: error.message || "Dados inválidos",
      code: "invalid_request",
    }, 400);
  }
  return jsonResponse({
    error: "Não foi possível concluir a operação",
    code: "database_error",
  }, 500);
}

function invalid(message = "Dados inválidos"): Response {
  return jsonResponse({ error: message, code: "invalid_request" }, 400);
}

async function handleCustomerMerge(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  const match = path.match(/^\/customers\/([^/]+)\/merge$/);
  if (!match) return null;
  if (req.method !== "POST") {
    return jsonResponse({
      error: "Método não permitido",
      code: "method_not_allowed",
    }, 405);
  }
  const targetId = match[1];
  const body = await readBody(req, 65_536);
  if (
    !UUID_PATTERN.test(targetId) || !body ||
    typeof body.duplicate_id !== "string" ||
    !UUID_PATTERN.test(body.duplicate_id) || !body.customer ||
    typeof body.customer !== "object" ||
    Array.isArray(body.customer)
  ) return invalid("Dados da mesclagem inválidos");

  const allowed = new Set([
    "full_name",
    "whatsapp",
    "email",
    "cpf",
    "internal_notes",
  ]);
  const customer = body.customer as Payload;
  if (
    Object.keys(customer).some((key) => !allowed.has(key)) ||
    Object.values(customer).some((value) =>
      value !== null && typeof value !== "string"
    )
  ) {
    return invalid("Dados do cliente inválidos");
  }
  const fullName = typeof customer.full_name === "string"
    ? customer.full_name.trim()
    : "";
  const email = typeof customer.email === "string" ? customer.email.trim() : "";
  const cpf = typeof customer.cpf === "string"
    ? customer.cpf.replace(/\D/g, "")
    : "";
  if (
    !fullName || fullName.length > 200 ||
    (typeof customer.whatsapp === "string" && customer.whatsapp.length > 32) ||
    (email && (email.length > 254 || !EMAIL_PATTERN.test(email))) ||
    (cpf && cpf.length !== 11) ||
    (typeof customer.internal_notes === "string" &&
      customer.internal_notes.length > 20_000)
  ) {
    return invalid("Dados do cliente inválidos");
  }
  const { data, error } = await supabase.rpc(
    "merge_presale_customers_from_api",
    {
      p_target_id: targetId,
      p_duplicate_id: body.duplicate_id,
      p_customer: customer,
      p_actor_id: actorId,
    },
  );
  if (error) return databaseError(error, "merge customers");
  return jsonResponse({ data });
}

async function handleOrderItems(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  const match = path.match(/^\/orders\/presale\/([^/]+)\/items$/);
  if (!match) return null;
  if (req.method !== "PUT") {
    return jsonResponse({
      error: "Método não permitido",
      code: "method_not_allowed",
    }, 405);
  }
  const body = await readBody(req);
  if (
    !UUID_PATTERN.test(match[1]) || !body || !Array.isArray(body.items) ||
    body.items.length < 1 || body.items.length > 100
  ) {
    return invalid("Itens inválidos");
  }
  const { data, error } = await supabase.rpc(
    "replace_presale_order_items_from_api",
    {
      p_order_id: match[1],
      p_items: body.items,
      p_actor_id: actorId,
    },
  );
  if (error) return databaseError(error, "replace order items");
  return jsonResponse({ data });
}

async function handleCommunityLink(
  req: Request,
  path: string,
  supabase: SupabaseClient,
): Promise<Response | null> {
  if (path !== "/communications/settings/community-link") return null;
  if (req.method !== "PUT") {
    return jsonResponse({
      error: "Método não permitido",
      code: "method_not_allowed",
    }, 405);
  }
  const body = await readBody(req, 8_192);
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (url.length > 2_048 || (url && !/^https:\/\/[^\s]+$/i.test(url))) {
    return invalid("Link da comunidade inválido");
  }
  const { data, error } = await supabase.from("communication_settings").upsert({
    key: "community_link",
    value: { url },
    updated_at: new Date().toISOString(),
  }, { onConflict: "key" }).select("*").single();
  if (error) return databaseError(error, "save community link");
  return jsonResponse({ data });
}

async function handleCommunicationEvent(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  if (path !== "/communications/events") return null;
  if (req.method !== "POST") {
    return jsonResponse({
      error: "Método não permitido",
      code: "method_not_allowed",
    }, 405);
  }
  const body = await readBody(req, 65_536);
  const sourceType = body?.source_type;
  const sourceId = body?.source_id;
  const eventType = body?.event_type;
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  const payload = body?.payload;
  if (
    !body || !["contract", "presale", "stock"].includes(String(sourceType)) ||
    typeof sourceId !== "string" || !UUID_PATTERN.test(sourceId) ||
    typeof eventType !== "string" ||
    !COMMUNICATION_EVENT_TYPES.has(eventType) ||
    !reason || reason.length > 1_000 || !payload ||
    typeof payload !== "object" || Array.isArray(payload) ||
    JSON.stringify(payload).length > 30_000
  ) return invalid("Evento de comunicação inválido");

  if (sourceType === "contract") {
    const { data: contract } = await supabase.from("assessment_contracts")
      .select("id").eq("id", sourceId).maybeSingle();
    if (!contract) {
      return jsonResponse({
        error: "Contrato não encontrado",
        code: "not_found",
      }, 404);
    }
    const { data, error } = await supabase.from("assessment_contract_event")
      .insert({
        contract_id: sourceId,
        event_type: eventType,
        payload,
        notes: reason,
        created_by: actorId,
      }).select("*").single();
    if (error) return databaseError(error, "contract communication event");
    return jsonResponse({ data }, 201);
  }

  const table = sourceType === "stock" ? "stock_orders" : "presale_orders";
  const { data: order } = await supabase.from(table).select("id,payment_status")
    .eq("id", sourceId).maybeSingle();
  if (!order) {
    return jsonResponse(
      { error: "Pedido não encontrado", code: "not_found" },
      404,
    );
  }
  const { data, error } = await supabase.from("sales_status_events").insert({
    order_type: sourceType,
    order_id: sourceId,
    previous_status: order.payment_status,
    new_status: order.payment_status || "pending",
    reason,
    metadata: payload,
    actor_id: actorId,
  }).select("*").single();
  if (error) return databaseError(error, "sales communication event");
  return jsonResponse({ data }, 201);
}

async function handlePayout(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  const actionMatch = path.match(
    /^\/payouts\/closings\/([^/]+)\/(approve|pay|reopen)$/,
  );
  if (actionMatch) {
    if (req.method !== "POST") {
      return jsonResponse({
        error: "Método não permitido",
        code: "method_not_allowed",
      }, 405);
    }
    const [, id, action] = actionMatch;
    if (!UUID_PATTERN.test(id)) return invalid("Fechamento inválido");
    const transition = action === "approve"
      ? {
        from: "pending_approval",
        values: {
          status: "approved",
          approved_at: new Date().toISOString(),
          approved_by: actorId,
        },
      }
      : action === "pay"
      ? {
        from: "approved",
        values: {
          status: "paid",
          paid_at: new Date().toISOString(),
          paid_by: actorId,
        },
      }
      : {
        from: "approved",
        values: {
          status: "pending_approval",
          approved_at: null,
          approved_by: null,
        },
      };
    const { data, error } = await supabase.from("payout_monthly_closings")
      .update(transition.values)
      .eq("id", id).eq("status", transition.from).select("*").maybeSingle();
    if (error) return databaseError(error, `payout ${action}`);
    if (!data) {
      return jsonResponse({
        error: "Fechamento alterado ou em estado incompatível",
        code: "conflict",
      }, 409);
    }
    return jsonResponse({ data });
  }

  const adjustmentMatch = path.match(
    /^\/payouts\/closings\/([^/]+)\/adjustments(?:\/([^/]+))?$/,
  );
  if (!adjustmentMatch) return null;
  const [, closingId, itemId] = adjustmentMatch;
  if (!UUID_PATTERN.test(closingId) || (itemId && !UUID_PATTERN.test(itemId))) {
    return invalid("Lançamento inválido");
  }
  const { data: closing } = await supabase.from("payout_monthly_closings")
    .select("id,status").eq("id", closingId).maybeSingle();
  if (!closing) {
    return jsonResponse({
      error: "Fechamento não encontrado",
      code: "not_found",
    }, 404);
  }
  if (closing.status !== "pending_approval") {
    return jsonResponse({
      error: "Fechamento bloqueado para ajustes",
      code: "conflict",
    }, 409);
  }

  if (req.method === "POST" && !itemId) {
    const body = await readBody(req, 32_768);
    const amount = Number(body?.amount);
    if (
      !body || typeof body.coach_id !== "string" ||
      !UUID_PATTERN.test(body.coach_id) ||
      !Number.isFinite(amount) || amount === 0 ||
      Math.abs(amount) > 1_000_000 ||
      typeof body.adjustment_reason !== "string" ||
      !body.adjustment_reason.trim() || body.adjustment_reason.length > 2_000 ||
      (body.description !== null && body.description !== undefined &&
        typeof body.description !== "string") ||
      (body.expense_category !== null && body.expense_category !== undefined &&
        typeof body.expense_category !== "string")
    ) {
      return invalid("Dados do lançamento inválidos");
    }
    const { data, error } = await supabase.from(
      "payout_monthly_statement_items",
    ).insert({
      closing_id: closingId,
      coach_id: body.coach_id,
      source_type: "manual_adjustment",
      amount,
      description: typeof body.description === "string"
        ? body.description.trim().slice(0, 2_000)
        : null,
      adjustment_reason: body.adjustment_reason.trim(),
      expense_category: typeof body.expense_category === "string"
        ? body.expense_category.trim().slice(0, 100)
        : "outros",
    }).select("*").single();
    if (error) return databaseError(error, "add payout adjustment");
    return jsonResponse({ data }, 201);
  }

  if (req.method === "DELETE" && itemId) {
    const { data, error } = await supabase.from(
      "payout_monthly_statement_items",
    ).delete()
      .eq("id", itemId).eq("closing_id", closingId).eq(
        "source_type",
        "manual_adjustment",
      ).select("id").maybeSingle();
    if (error) return databaseError(error, "delete payout adjustment");
    if (!data) {
      return jsonResponse({
        error: "Ajuste manual não encontrado",
        code: "not_found",
      }, 404);
    }
    return jsonResponse({ data: { id: itemId, deleted: true } });
  }
  return jsonResponse({
    error: "Método não permitido",
    code: "method_not_allowed",
  }, 405);
}

export async function handleAdminOperationRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  return await handleCustomerMerge(req, path, supabase, actorId) ??
    await handleOrderItems(req, path, supabase, actorId) ??
    await handleCommunityLink(req, path, supabase) ??
    await handleCommunicationEvent(req, path, supabase, actorId) ??
    await handlePayout(req, path, supabase, actorId);
}
