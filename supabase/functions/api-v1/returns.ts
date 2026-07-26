import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

const RETURN_STATUSES = new Set(["pending_return", "received", "completed"]);
const RETURN_COLUMNS = [
  "id",
  "order_id",
  "order_type",
  "order_number",
  "customer_name",
  "item_index",
  "product_id",
  "product_name",
  "variation",
  "quantity",
  "unit_price",
  "refund_value",
  "was_delivered",
  "status",
  "notes",
  "created_at",
  "received_at",
  "completed_at",
].join(",");

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function databaseError(error: { code?: string; message?: string }, operation: string): Response {
  console.error(`api-v1 returns ${operation}:`, error);

  if (error.code === "P0002") {
    return jsonResponse({ error: error.message, code: "not_found" }, 404);
  }
  if (error.code === "22023") {
    return jsonResponse({ error: error.message, code: "invalid_request" }, 400);
  }
  if (error.code === "P0001") {
    return jsonResponse({ error: error.message, code: "invalid_transition" }, 409);
  }

  return jsonResponse({
    error: "Não foi possível processar a devolução",
    code: "database_error",
  }, 500);
}

export async function handleReturnsRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
): Promise<Response | null> {
  if (req.method === "GET" && path === "/returns") {
    const status = new URL(req.url).searchParams.get("status");
    if (status && !RETURN_STATUSES.has(status)) {
      return jsonResponse({
        error: "Status de devolução inválido",
        code: "invalid_status",
      }, 400);
    }

    let query = supabase
      .from("order_returns")
      .select(RETURN_COLUMNS)
      .order("created_at", { ascending: false });

    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) return databaseError(error, "list");
    return jsonResponse({ data: data ?? [] });
  }

  const transitionMatch = path.match(
    /^\/returns\/([^/]+)\/(receive|complete)$/,
  );
  if (req.method === "POST" && transitionMatch) {
    const [, returnId, action] = transitionMatch;
    if (!isUuid(returnId)) {
      return jsonResponse({
        error: "Identificador de devolução inválido",
        code: "invalid_return_id",
      }, 400);
    }

    const { data, error } = await supabase.rpc("transition_order_return", {
      p_return_id: returnId,
      p_action: action,
    });

    if (error) return databaseError(error, action);
    return jsonResponse({ data });
  }

  return null;
}
