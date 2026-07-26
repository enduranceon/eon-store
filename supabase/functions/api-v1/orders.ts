import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import {
  AsaasApiError,
  deleteAsaasPayment,
  getAsaasPayment,
} from "../_shared/asaas.ts";
import { jsonResponse } from "../_shared/http.ts";

const CANCELLABLE_ASAAS_STATUSES = new Set(["PENDING", "OVERDUE"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PreparedCancellation {
  operation_id: string;
  status: "prepared" | "completed" | "reconciliation_required";
  asaas_charge_id?: string | null;
  result?: unknown;
}

function databaseError(error: { code?: string; message?: string }, operation: string): Response {
  console.error(`api-v1 orders ${operation}:`, error);

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
    error: "Não foi possível processar o cancelamento",
    code: "database_error",
  }, 500);
}

function externalError(error: unknown): Response {
  if (error instanceof AsaasApiError) {
    return jsonResponse({ error: error.message, code: error.code }, error.status);
  }

  console.error("api-v1 orders unexpected external error:", error);
  return jsonResponse({
    error: "Não foi possível confirmar a cobrança externa",
    code: "external_error",
  }, 502);
}

async function parseReason(req: Request): Promise<string | null> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || typeof body.reason !== "string") {
      return null;
    }
    const reason = body.reason.trim();
    return reason.length >= 1 && reason.length <= 500 ? reason : null;
  } catch {
    return null;
  }
}

async function cancelExternalCharge(chargeId: string): Promise<Record<string, unknown>> {
  const lookup = await getAsaasPayment(chargeId);

  if (!lookup.found) {
    return { provider: "asaas", outcome: "already_missing" };
  }

  if (lookup.status === "CANCELLED") {
    return { provider: "asaas", outcome: "already_cancelled", previous_status: lookup.status };
  }

  if (!CANCELLABLE_ASAAS_STATUSES.has(lookup.status)) {
    throw new AsaasApiError(
      `A cobrança está com status ${lookup.status} e exige conferência antes do cancelamento`,
      409,
      "asaas_status_not_cancellable",
    );
  }

  const outcome = await deleteAsaasPayment(chargeId);
  return { provider: "asaas", outcome, previous_status: lookup.status };
}

export async function handleOrdersRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  const match = path.match(/^\/orders\/(presale|stock)\/([^/]+)\/cancel$/);
  if (req.method !== "POST" || !match) return null;

  const [, orderType, orderId] = match;
  if (!UUID_PATTERN.test(orderId)) {
    return jsonResponse({ error: "Identificador de pedido inválido", code: "invalid_order_id" }, 400);
  }

  const reason = await parseReason(req);
  if (!reason) {
    return jsonResponse({ error: "Informe um motivo de cancelamento válido", code: "invalid_reason" }, 400);
  }

  const { data: preparedData, error: prepareError } = await supabase.rpc(
    "prepare_order_cancellation",
    {
      p_order_type: orderType,
      p_order_id: orderId,
      p_reason: reason,
      p_actor_id: actorId,
    },
  );

  if (prepareError) return databaseError(prepareError, "prepare cancellation");
  const prepared = preparedData as PreparedCancellation;

  if (prepared.status === "completed") {
    return jsonResponse({ data: prepared.result });
  }
  if (prepared.status === "reconciliation_required") {
    return jsonResponse({
      error: "Este cancelamento precisa de conferência manual",
      code: "reconciliation_required",
    }, 409);
  }

  let externalResult: Record<string, unknown> = {
    provider: "none",
    outcome: "not_required",
  };

  if (prepared.asaas_charge_id) {
    try {
      externalResult = await cancelExternalCharge(prepared.asaas_charge_id);
    } catch (error) {
      return externalError(error);
    }
  }

  const { data: completed, error: completeError } = await supabase.rpc(
    "complete_order_cancellation",
    {
      p_operation_id: prepared.operation_id,
      p_external_result: externalResult,
    },
  );

  if (completeError) return databaseError(completeError, "complete cancellation");
  if (completed?.status === "reconciliation_required") {
    return jsonResponse({
      error: "O pedido mudou durante o cancelamento e precisa de conferência manual",
      code: "reconciliation_required",
      details: { operation_id: completed.operation_id },
    }, 409);
  }

  return jsonResponse({ data: completed });
}
