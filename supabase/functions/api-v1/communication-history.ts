import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE = new Set(["contract", "presale", "stock", "event"]);
const PARAMS = new Set(["customer_id", "source_type", "source_id", "q", "from", "to", "cursor", "limit"]);

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function invalid(): Response {
  return jsonResponse({ error: "Filtro de histórico inválido", code: "invalid_request" }, 400);
}

export async function handleCommunicationHistoryRequest(
  req: Request,
  path: string,
  client: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  if (path !== "/communications/history") return null;
  if (!actorId || !UUID.test(actorId)) {
    return jsonResponse({ error: "Sessão inválida", code: "unauthorized" }, 401);
  }
  if (req.method !== "GET") {
    return jsonResponse({ error: "Método não permitido", code: "method_not_allowed" }, 405);
  }
  const params = new URL(req.url).searchParams;
  if ([...params.keys()].some((key) => !PARAMS.has(key))) return invalid();
  const customerId = params.get("customer_id") || null;
  const sourceType = params.get("source_type") || null;
  const sourceId = params.get("source_id") || null;
  const query = params.get("q")?.trim() || null;
  const from = params.get("from") || null;
  const to = params.get("to") || null;
  const rawCursor = params.get("cursor") || null;
  // PostgreSQL encode(..., 'base64') wraps long cursors at 76 characters.
  const cursor = rawCursor?.replace(/[\r\n]/g, "") ?? null;
  const limitRaw = params.get("limit") || "30";
  const limit = Number(limitRaw);
  if ((customerId && !UUID.test(customerId)) ||
    (sourceType && !SOURCE.has(sourceType)) ||
    (sourceId && (!sourceType || !UUID.test(sourceId))) ||
    (query && query.length > 120) ||
    (from && !validDate(from)) || (to && !validDate(to)) ||
    (from && to && from > to) ||
    (rawCursor && (rawCursor.length > 512 || !cursor || !/^[A-Za-z0-9+/=]+$/.test(cursor))) ||
    !/^[0-9]{1,3}$/.test(limitRaw) || !Number.isInteger(limit) || limit < 1 || limit > 100) return invalid();

  const { data, error } = await client.rpc("search_communication_history", {
    p_customer_id: customerId,
    p_source_type: sourceType,
    p_source_id: sourceId,
    p_query: query,
    p_from: from,
    p_to: to,
    p_cursor: cursor,
    p_limit: limit,
  });
  if (error) {
    if (["22023", "22P02", "22007", "22008"].includes(error.code || "")) return invalid();
    console.error("api-v1 communication history:", error.code, error.message);
    return jsonResponse({ error: "Não foi possível consultar o histórico", code: "database_error" }, 500);
  }
  return jsonResponse({ data });
}
