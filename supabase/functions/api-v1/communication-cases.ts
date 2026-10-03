import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{8,100}$/;
const HASH = /^[0-9a-f]{32}$/;
const SOURCE = new Set(["contract", "presale", "stock", "event"]);
const PURPOSE = new Set(["billing", "onboarding", "renewal"]);
const STATE = new Set(["to_do", "following_up", "scheduled", "resolved", "open"]);
const ACTION_FIELDS: Record<string, string[]> = {
  message_sent: ["message", "channel", "confirmed_external_send", "expected_rule_version", "next_action_at"],
  response_recorded: ["response_code", "note", "follow_up_at"],
  return_scheduled: ["next_action_at", "note"],
  review_requested: ["reason", "note", "next_action_at"],
  review_completed: ["note"],
  resolve_case: ["reason"],
};
const COMMON_FIELDS = ["action", "expected_version", "expected_source_fingerprint", "source_ui"];

function invalid(message: string): Response {
  return jsonResponse({ error: message, code: "invalid_request" }, 400);
}

function dbError(error: { code?: string; message?: string }, operation: string): Response {
  console.error(`api-v1 communication ${operation}:`, error.code, error.message);
  if (error.code === "P0002") return jsonResponse({ error: error.message, code: "not_found" }, 404);
  if (["P0001", "23505", "55P03"].includes(error.code || "")) {
    return jsonResponse({ error: error.message || "Acompanhamento alterado", code: "conflict" }, 409);
  }
  if (["22023", "22P02", "22007", "22008", "23514", "23502", "23503"].includes(error.code || "")) {
    return invalid(error.code === "22023" ? error.message || "Dados inválidos" : "Dados inválidos");
  }
  return jsonResponse({ error: "Não foi possível processar o acompanhamento", code: "database_error" }, 500);
}

async function readBody(req: Request, max = 10_000): Promise<Record<string, unknown> | null> {
  try {
    const raw = await req.text();
    if (!raw || raw.length > max) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function positiveLimit(value: string | null, fallback: number, max: number): number | null {
  if (value === null) return fallback;
  if (!/^[0-9]{1,3}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= max ? parsed : null;
}

function normalizeCursor(value: string | null): string | null | undefined {
  if (value === null) return null;
  if (value.length > 512) return undefined;
  // PostgreSQL encode(..., 'base64') wraps long values with CR/LF.
  const cursor = value.replace(/[\r\n]/g, "");
  return cursor && /^[A-Za-z0-9+/=]+$/.test(cursor) ? cursor : undefined;
}

function isDate(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export async function handleCommunicationCaseRequest(
  req: Request,
  path: string,
  client: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  if (!path.startsWith("/communications/cases")) return null;
  if (!UUID.test(actorId)) return jsonResponse({ error: "Sessão inválida", code: "unauthorized" }, 401);
  const url = new URL(req.url);
  const params = url.searchParams;

  if (path === "/communications/cases" && req.method === "GET") {
    if ([...params.keys()].some((key) => !["state", "purpose", "source_type", "source_id", "customer_id", "q", "cursor", "limit"].includes(key))) return invalid("Filtro inválido");
    const state = params.get("state") || null;
    const purpose = params.get("purpose") || null;
    const sourceType = params.get("source_type") || null;
    const sourceId = params.get("source_id") || null;
    const customerId = params.get("customer_id") || null;
    const query = params.get("q") || null;
    const cursor = normalizeCursor(params.get("cursor"));
    const limit = positiveLimit(params.get("limit"), 20, 100);
    if ((state && !STATE.has(state)) || (purpose && !PURPOSE.has(purpose)) ||
      (sourceType && !SOURCE.has(sourceType)) || (sourceId && !UUID.test(sourceId)) ||
      (customerId && !UUID.test(customerId)) || (query && query.length > 120) ||
      cursor === undefined || limit === null) return invalid("Filtro inválido");
    const { data, error } = await client.rpc("list_communication_cases", {
      p_state: state, p_purpose: purpose, p_source_type: sourceType,
      p_source_id: sourceId, p_customer_id: customerId,
      p_query: query, p_cursor: cursor, p_limit: limit,
    });
    return error ? dbError(error, "list") : jsonResponse({ data });
  }

  if (path === "/communications/cases/prepare") {
    if (req.method !== "POST") return jsonResponse({ error: "Método não permitido", code: "method_not_allowed" }, 405);
    const body = await readBody(req, 1000);
    if (!body || Object.keys(body).some((key) => !["source_type", "source_id", "purpose"].includes(key)) ||
      !SOURCE.has(String(body.source_type)) || !UUID.test(String(body.source_id)) ||
      !PURPOSE.has(String(body.purpose))) return invalid("Origem inválida");
    const { data, error } = await client.rpc("prepare_communication_case", {
      p_source_type: body.source_type, p_source_id: body.source_id, p_purpose: body.purpose,
    });
    return error ? dbError(error, "prepare") : jsonResponse({ data });
  }

  if (path === "/communications/cases/sync/preview") {
    if (req.method !== "GET") return jsonResponse({ error: "Método não permitido", code: "method_not_allowed" }, 405);
    const sourceType = params.get("source_type");
    const limit = positiveLimit(params.get("limit"), 20, 50);
    if ((sourceType && !SOURCE.has(sourceType)) || limit === null || [...params.keys()].some((key) => !["source_type", "limit"].includes(key))) return invalid("Filtro inválido");
    const { data, error } = await client.rpc("preview_communication_case_sync", { p_source_type: sourceType, p_limit: limit });
    return error ? dbError(error, "preview sync") : jsonResponse({ data });
  }

  if (path === "/communications/cases/sync") {
    if (req.method !== "POST") return jsonResponse({ error: "Método não permitido", code: "method_not_allowed" }, 405);
    const body = await readBody(req, 1000);
    if (!body || Object.keys(body).some((key) => !["source_type", "after", "limit"].includes(key)) ||
      !SOURCE.has(String(body.source_type)) || (body.after != null && !UUID.test(String(body.after))) ||
      !Number.isInteger(body.limit ?? 100) || Number(body.limit ?? 100) < 1 || Number(body.limit ?? 100) > 500) return invalid("Lote inválido");
    const { data, error } = await client.rpc("sync_communication_cases", {
      p_source_type: body.source_type, p_after: body.after ?? null, p_limit: body.limit ?? 100,
    });
    return error ? dbError(error, "sync") : jsonResponse({ data });
  }

  if (path === "/communications/cases/rollout") {
    if (req.method === "GET") {
      const { data, error } = await client.from("communication_settings").select("value").eq("key", "cases_rollout").single();
      return error ? dbError(error, "rollout status") : jsonResponse({ data: data?.value || { enabled: false } });
    }
    if (req.method !== "POST") return jsonResponse({ error: "Método não permitido", code: "method_not_allowed" }, 405);
    const body = await readBody(req, 1000);
    if (!body || Object.keys(body).length !== 1 || typeof body.enabled !== "boolean") return invalid("Ativação inválida");
    const { data, error } = await client.rpc("set_communication_cases_rollout", { p_enabled: body.enabled, p_actor_id: actorId });
    return error ? dbError(error, "rollout change") : jsonResponse({ data });
  }

  const events = path.match(/^\/communications\/cases\/([^/]+)\/events$/);
  if (events) {
    if (req.method !== "GET") return jsonResponse({ error: "Método não permitido", code: "method_not_allowed" }, 405);
    const cursor = normalizeCursor(params.get("cursor"));
    const limit = positiveLimit(params.get("limit"), 30, 100);
    if (!UUID.test(events[1]) || cursor === undefined || limit === null ||
      [...params.keys()].some((key) => !["cursor", "limit"].includes(key))) return invalid("Paginação inválida");
    const { data, error } = await client.rpc("list_communication_case_events", {
      p_case_id: events[1], p_cursor: cursor, p_limit: limit,
    });
    return error ? dbError(error, "events") : jsonResponse({ data });
  }

  const actions = path.match(/^\/communications\/cases\/([^/]+)\/actions$/);
  if (actions) {
    if (req.method !== "POST") return jsonResponse({ error: "Método não permitido", code: "method_not_allowed" }, 405);
    const idempotencyKey = req.headers.get("Idempotency-Key") || "";
    const body = await readBody(req);
    if (!UUID.test(actions[1]) || !KEY.test(idempotencyKey) || !body ||
      typeof body.action !== "string" || !ACTION_FIELDS[body.action]) return invalid("Ação inválida");
    const allowed = [...COMMON_FIELDS, ...ACTION_FIELDS[body.action]];
    if (Object.keys(body).some((key) => !allowed.includes(key)) ||
      !Number.isSafeInteger(body.expected_version) || Number(body.expected_version) < 1 ||
      typeof body.expected_source_fingerprint !== "string" || !HASH.test(body.expected_source_fingerprint) ||
      typeof body.source_ui !== "string" || !body.source_ui || body.source_ui.length > 80 ||
      Object.entries(body).some(([key, value]) =>
        ["next_action_at", "follow_up_at"].includes(key) && value != null && !isDate(value)) ||
      (body.action === "message_sent" &&
        (typeof body.message !== "string" || !body.message.trim() || body.message.length > 4000 ||
          body.channel !== "whatsapp" || body.confirmed_external_send !== true ||
          !Number.isInteger(body.expected_rule_version) || Number(body.expected_rule_version) < 1)) ||
      (body.action === "response_recorded" &&
        (typeof body.response_code !== "string" || body.response_code.length > 50)) ||
      (body.action === "review_completed" &&
        (typeof body.note !== "string" || !body.note.trim() || body.note.length > 1000)) ||
      (body.action === "return_scheduled" && !isDate(body.next_action_at))) return invalid("Dados da ação inválidos");
    const { data, error } = await client.rpc("apply_communication_case_action", {
      p_case_id: actions[1], p_request: body, p_idempotency_key: idempotencyKey,
      p_actor_id: actorId,
    });
    return error ? dbError(error, "action") : jsonResponse({ data });
  }

  const detail = path.match(/^\/communications\/cases\/([^/]+)$/);
  if (detail) {
    if (req.method !== "GET") return jsonResponse({ error: "Método não permitido", code: "method_not_allowed" }, 405);
    if (!UUID.test(detail[1])) return invalid("Acompanhamento inválido");
    const { data, error } = await client.rpc("get_communication_case", { p_case_id: detail[1] });
    return error ? dbError(error, "detail") : jsonResponse({ data });
  }
  return jsonResponse({ error: "Rota não encontrada", code: "not_found" }, 404);
}
