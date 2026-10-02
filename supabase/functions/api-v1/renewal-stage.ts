import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

const PATH = /^\/orders\/contract\/([0-9a-f-]+)\/renewal-stage$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{8,100}$/;
const ACTIONS = new Set([
  "message_sent", "register_response", "set_follow_up", "change_resolved",
  "register_subscription_link",
]);
const RESPONSES = new Set([
  "will_renew", "thinking", "change_plan_or_coach", "needs_agent",
]);

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function normalizeSubscriptionLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048 ||
      /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname.includes(".") ||
        url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function handleRenewalStageRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  const match = path.match(PATH);
  if (!match) return null;
  if (req.method !== "POST") {
    return jsonResponse({ error: "Método não permitido", code: "method_not_allowed" }, 405);
  }
  const contractId = match[1];
  if (!UUID.test(contractId)) {
    return jsonResponse({ error: "Contrato inválido", code: "invalid_request" }, 400);
  }
  const idempotencyKey = req.headers.get("Idempotency-Key") || "";
  if (!KEY.test(idempotencyKey)) {
    return jsonResponse({ error: "Chave de idempotência inválida", code: "invalid_request" }, 400);
  }
  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (!raw || raw.length > 4096) throw new Error("invalid size");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid body");
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "Requisição inválida", code: "invalid_request" }, 400);
  }
  const allowed = new Set([
    "action", "response_code", "follow_up_at", "expected_updated_at",
    "subscription_link",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key)) ||
      typeof body.action !== "string" || !ACTIONS.has(body.action) ||
      typeof body.expected_updated_at !== "string" ||
      body.expected_updated_at.length > 50 ||
      !Number.isFinite(Date.parse(body.expected_updated_at))) {
    return jsonResponse({ error: "Dados da transição inválidos", code: "invalid_request" }, 400);
  }
  const responseCode = body.response_code ?? null;
  const followUpAt = body.follow_up_at ?? null;
  const subscriptionLink = body.action === "register_subscription_link"
    ? normalizeSubscriptionLink(body.subscription_link)
    : null;
  if (body.action === "register_response"
      ? !RESPONSES.has(String(responseCode))
      : responseCode !== null) {
    return jsonResponse({ error: "Resposta inválida", code: "invalid_request" }, 400);
  }
  if (followUpAt !== null && !validDate(followUpAt)) {
    return jsonResponse({ error: "Data de follow-up inválida", code: "invalid_request" }, 400);
  }
  if (body.action === "set_follow_up" && followUpAt === null) {
    return jsonResponse({ error: "Informe a data de follow-up", code: "invalid_request" }, 400);
  }
  if (followUpAt !== null && !["register_response", "set_follow_up"].includes(body.action)) {
    return jsonResponse({ error: "Data de follow-up inesperada", code: "invalid_request" }, 400);
  }
  if (body.action === "register_subscription_link"
      ? subscriptionLink === null
      : body.subscription_link !== undefined) {
    return jsonResponse({ error: "Link da assinatura inválido", code: "invalid_request" }, 400);
  }

  const { data, error } = await supabase.rpc("transition_assessment_renewal_stage", {
    p_contract_id: contractId,
    p_action: body.action,
    p_response_code: responseCode,
    p_follow_up_at: followUpAt,
    p_expected_updated_at: body.expected_updated_at,
    p_actor_id: actorId,
    p_idempotency_key: idempotencyKey,
    p_subscription_link: subscriptionLink,
  });
  if (error) {
    if (error.code === "P0002") {
      return jsonResponse({ error: error.message, code: "not_found" }, 404);
    }
    if (error.code === "P0001" || error.code === "23505") {
      return jsonResponse({ error: error.message, code: "conflict" }, 409);
    }
    if (error.code === "22023" || error.code === "23514") {
      return jsonResponse({ error: error.message, code: "invalid_request" }, 400);
    }
    console.error("api-v1 renewal stage:", { code: error.code });
    return jsonResponse({ error: "Não foi possível atualizar a renovação", code: "database_error" }, 500);
  }
  return jsonResponse({ data });
}
