import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import {
  AsaasApiError,
  deleteAsaasPayment,
  getAsaasPayment,
  refundAsaasPayment,
} from "../_shared/asaas.ts";
import { jsonResponse } from "../_shared/http.ts";

const CANCELLABLE_ASAAS_STATUSES = new Set(["PENDING", "OVERDUE"]);
const REFUNDABLE_ASAAS_STATUSES = new Set([
  "RECEIVED",
  "CONFIRMED",
  "RECEIVED_IN_CASH",
]);
const INACTIVE_REFUND_STATUSES = new Set(["FAILED", "CANCELLED", "CANCELED"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class OrderInputError extends Error {
  code: string;

  constructor(message: string, code = "invalid_request") {
    super(message);
    this.name = "OrderInputError";
    this.code = code;
  }
}

export function requireIdempotencyKey(value: string | null): string {
  const normalized = value?.trim() ?? "";
  if (!UUID_PATTERN.test(normalized)) {
    throw new OrderInputError(
      "Chave de idempotência inválida",
      "invalid_idempotency_key",
    );
  }
  return normalized;
}

export function normalizeStockOrderCreationPayload(
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OrderInputError("Corpo JSON inválido", "invalid_json");
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.customer_id !== "string" ||
    !UUID_PATTERN.test(payload.customer_id)
  ) {
    throw new OrderInputError("Cliente inválido");
  }
  if (
    !Array.isArray(payload.items) || payload.items.length < 1 ||
    payload.items.length > 100
  ) {
    throw new OrderInputError("Informe entre 1 e 100 itens");
  }
  return payload;
}

interface PreparedCancellation {
  operation_id: string;
  status: "prepared" | "completed" | "reconciliation_required";
  asaas_charge_id?: string | null;
  result?: unknown;
}

interface PreparedRefund extends PreparedCancellation {
  refund_value: number;
  refund_marker: string;
  requires_external_refund?: boolean;
  target_payment_status?: string;
  external_result?: Record<string, unknown> | null;
}

function databaseError(
  error: { code?: string; message?: string },
  operation: string,
): Response {
  console.error(`api-v1 orders ${operation}:`, error);

  if (error.code === "P0002") {
    return jsonResponse({ error: error.message, code: "not_found" }, 404);
  }
  if (error.code === "22023") {
    return jsonResponse({ error: error.message, code: "invalid_request" }, 400);
  }
  if (error.code === "P0001" || error.code === "23505") {
    return jsonResponse(
      { error: error.message, code: "invalid_transition" },
      409,
    );
  }

  return jsonResponse({
    error: "Não foi possível processar o pedido",
    code: "database_error",
  }, 500);
}

function externalError(error: unknown): Response {
  if (error instanceof AsaasApiError) {
    return jsonResponse(
      { error: error.message, code: error.code },
      error.status,
    );
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

async function parseObject(
  req: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function cancelExternalCharge(
  chargeId: string,
): Promise<Record<string, unknown>> {
  const lookup = await getAsaasPayment(chargeId);

  if (!lookup.found) {
    return { provider: "asaas", outcome: "already_missing" };
  }

  if (lookup.status === "CANCELLED") {
    return {
      provider: "asaas",
      outcome: "already_cancelled",
      previous_status: lookup.status,
    };
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

function numericValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function confirmedExternalResult(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  return result.outcome === "refunded" || result.outcome === "already_refunded"
    ? result
    : null;
}

async function persistExternalResult(
  supabase: SupabaseClient,
  operationId: string,
  externalResult: Record<string, unknown>,
): Promise<Response | null> {
  const { error } = await supabase.rpc(
    "record_order_operation_external_result",
    {
      p_operation_id: operationId,
      p_external_result: externalResult,
    },
  );
  return error ? databaseError(error, "record external refund") : null;
}

export async function executeExternalRefund(
  chargeId: string,
  requestedValue: number,
  marker: string,
  allowAlreadyFullyRefunded: boolean,
): Promise<Record<string, unknown>> {
  if (!Number.isFinite(requestedValue) || requestedValue <= 0) {
    throw new AsaasApiError(
      "Valor de estorno inválido",
      409,
      "invalid_refund_value",
    );
  }

  const lookup = await getAsaasPayment(chargeId);
  if (!lookup.found) {
    throw new AsaasApiError(
      "A cobrança não foi encontrada no Asaas e precisa de conferência",
      409,
      "asaas_payment_not_found",
    );
  }

  const refunds = Array.isArray(lookup.payment.refunds)
    ? lookup.payment.refunds.filter((entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object"
    )
    : [];

  const matchingRefund = refunds.find((entry) => entry.description === marker);
  if (matchingRefund) {
    return {
      provider: "asaas",
      outcome: "already_refunded",
      requested_value: requestedValue,
      provider_refund_id: typeof matchingRefund.id === "string"
        ? matchingRefund.id
        : null,
    };
  }

  const refundedTotal = refunds.reduce((sum, entry) => {
    const status = typeof entry.status === "string" ? entry.status : "";
    if (INACTIVE_REFUND_STATUSES.has(status)) return sum;
    return sum + Math.max(0, numericValue(entry.value));
  }, 0);
  const paymentValue = Math.max(0, numericValue(lookup.payment.value));
  const remainingValue = Math.max(
    0,
    Math.round((paymentValue - refundedTotal) * 100) / 100,
  );

  if (lookup.status === "REFUNDED" || remainingValue < 0.01) {
    if (allowAlreadyFullyRefunded) {
      return {
        provider: "asaas",
        outcome: "already_refunded",
        requested_value: requestedValue,
        previous_status: lookup.status,
      };
    }
    throw new AsaasApiError(
      "A cobrança já está totalmente estornada e o pedido precisa de reconciliação",
      409,
      "asaas_unexpected_full_refund",
    );
  }

  if (!REFUNDABLE_ASAAS_STATUSES.has(lookup.status)) {
    throw new AsaasApiError(
      `A cobrança está com status ${lookup.status} e não pode ser estornada automaticamente`,
      409,
      "asaas_status_not_refundable",
    );
  }

  if (requestedValue > remainingValue + 0.01) {
    throw new AsaasApiError(
      "O valor solicitado supera o saldo disponível para estorno no Asaas",
      409,
      "asaas_refund_value_exceeds_remaining",
    );
  }

  const refund = await refundAsaasPayment(chargeId, requestedValue, marker);
  return {
    provider: "asaas",
    outcome: "refunded",
    requested_value: requestedValue,
    previous_status: lookup.status,
    provider_refund_id: typeof refund.id === "string" ? refund.id : null,
  };
}

function reconciliationResponse(
  message: string,
  completed: Record<string, unknown>,
): Response {
  return jsonResponse({
    error: message,
    code: "reconciliation_required",
    details: { operation_id: completed.operation_id },
  }, 409);
}

export async function handleOrdersRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  if (req.method === "POST" && path === "/orders/stock") {
    let payload: Record<string, unknown>;
    let idempotencyKey: string;
    try {
      payload = normalizeStockOrderCreationPayload(await req.json());
      idempotencyKey = requireIdempotencyKey(
        req.headers.get("Idempotency-Key"),
      );
    } catch (error) {
      if (error instanceof OrderInputError) {
        return jsonResponse({ error: error.message, code: error.code }, 400);
      }
      return jsonResponse({
        error: "Corpo JSON inválido",
        code: "invalid_json",
      }, 400);
    }

    const { data, error } = await supabase.rpc(
      "create_stock_order_from_admin",
      {
        p_payload: payload,
        p_actor_id: actorId,
        p_idempotency_key: idempotencyKey,
      },
    );
    if (error) return databaseError(error, "create stock order");
    return jsonResponse({ data }, 201);
  }

  const fulfillmentMatch = path.match(
    /^\/orders\/(presale|stock)\/([^/]+)\/fulfillment$/,
  );
  if (req.method === "PATCH" && fulfillmentMatch) {
    const [, orderType, orderId] = fulfillmentMatch;
    if (!UUID_PATTERN.test(orderId)) {
      return jsonResponse({
        error: "Identificador de pedido inválido",
        code: "invalid_order_id",
      }, 400);
    }
    const body = await parseObject(req);
    if (
      !body || typeof body.delivery_status !== "string" ||
      (body.delivery_date !== null && body.delivery_date !== undefined &&
        typeof body.delivery_date !== "string") ||
      (body.internal_notes !== null && body.internal_notes !== undefined &&
        typeof body.internal_notes !== "string")
    ) {
      return jsonResponse({
        error: "Dados de entrega inválidos",
        code: "invalid_request",
      }, 400);
    }
    const { data, error } = await supabase.rpc("update_order_fulfillment", {
      p_order_type: orderType,
      p_order_id: orderId,
      p_delivery_status: body.delivery_status,
      p_delivery_date: body.delivery_date ?? null,
      p_internal_notes: body.internal_notes ?? null,
      p_actor_id: actorId,
    });
    if (error) return databaseError(error, "update fulfillment");
    return jsonResponse({ data });
  }

  const messageMatch = path.match(
    /^\/orders\/(presale|stock)\/([^/]+)\/payment-message$/,
  );
  if (req.method === "POST" && messageMatch) {
    const [, orderType, orderId] = messageMatch;
    if (!UUID_PATTERN.test(orderId)) {
      return jsonResponse({
        error: "Identificador de pedido inválido",
        code: "invalid_order_id",
      }, 400);
    }
    const body = await parseObject(req);
    if (
      !body ||
      (body.external_payment_link !== null &&
        body.external_payment_link !== undefined &&
        typeof body.external_payment_link !== "string") ||
      (body.due_date !== null && body.due_date !== undefined &&
        typeof body.due_date !== "string") ||
      (body.metadata !== undefined &&
        (!body.metadata || typeof body.metadata !== "object" ||
          Array.isArray(body.metadata) ||
          JSON.stringify(body.metadata).length > 30_000))
    ) {
      return jsonResponse({
        error: "Dados da mensagem de cobrança inválidos",
        code: "invalid_request",
      }, 400);
    }
    const { data, error } = await supabase.rpc(
      "mark_order_payment_message_sent_with_metadata",
      {
        p_order_type: orderType,
        p_order_id: orderId,
        p_external_payment_link: body.external_payment_link ?? null,
        p_due_date: body.due_date ?? null,
        p_metadata: body.metadata ?? {},
        p_actor_id: actorId,
      },
    );
    if (error) return databaseError(error, "mark payment message");
    return jsonResponse({ data });
  }

  const discountMatch = path.match(
    /^\/orders\/(presale|stock)\/([^/]+)\/discount$/,
  );
  if (req.method === "PATCH" && discountMatch) {
    const [, orderType, orderId] = discountMatch;
    if (!UUID_PATTERN.test(orderId)) {
      return jsonResponse({
        error: "Identificador de pedido inválido",
        code: "invalid_order_id",
      }, 400);
    }
    const body = await parseObject(req);
    const discount = Number(body?.manual_discount);
    if (
      !body || !Number.isFinite(discount) || discount < 0 ||
      (body.discount_reason !== null && body.discount_reason !== undefined &&
        typeof body.discount_reason !== "string")
    ) {
      return jsonResponse({
        error: "Dados do desconto inválidos",
        code: "invalid_request",
      }, 400);
    }
    const { data, error } = await supabase.rpc("update_order_discount", {
      p_order_type: orderType,
      p_order_id: orderId,
      p_manual_discount: discount,
      p_discount_reason: body.discount_reason ?? null,
      p_actor_id: actorId,
    });
    if (error) return databaseError(error, "update discount");
    return jsonResponse({ data });
  }

  if (req.method !== "POST") return null;

  const refundMatch = path.match(
    /^\/orders\/(presale|stock)\/([^/]+)\/refund$/,
  );
  if (refundMatch) {
    const [, orderType, orderId] = refundMatch;
    if (!UUID_PATTERN.test(orderId)) {
      return jsonResponse({
        error: "Identificador de pedido inválido",
        code: "invalid_order_id",
      }, 400);
    }

    const reason = await parseReason(req);
    if (!reason) {
      return jsonResponse({
        error: "Informe um motivo de estorno válido",
        code: "invalid_reason",
      }, 400);
    }

    const { data, error } = await supabase.rpc("prepare_order_refund", {
      p_order_type: orderType,
      p_order_id: orderId,
      p_reason: reason,
      p_actor_id: actorId,
    });
    if (error) return databaseError(error, "prepare refund");
    const prepared = data as PreparedRefund;

    if (prepared.status === "completed") {
      return jsonResponse({ data: prepared.result });
    }
    if (prepared.status === "reconciliation_required") {
      return jsonResponse({
        error: "Este estorno precisa de conferência manual",
        code: "reconciliation_required",
      }, 409);
    }

    let externalResult = confirmedExternalResult(prepared.external_result);
    if (!externalResult) {
      try {
        externalResult = await executeExternalRefund(
          prepared.asaas_charge_id!,
          numericValue(prepared.refund_value),
          prepared.refund_marker,
          true,
        );
      } catch (externalFailure) {
        return externalError(externalFailure);
      }

      const persistError = await persistExternalResult(
        supabase,
        prepared.operation_id,
        externalResult,
      );
      if (persistError) return persistError;
    }

    const { data: completed, error: completeError } = await supabase.rpc(
      "complete_order_refund",
      {
        p_operation_id: prepared.operation_id,
        p_external_result: externalResult,
      },
    );
    if (completeError) return databaseError(completeError, "complete refund");
    if (completed?.status === "reconciliation_required") {
      return reconciliationResponse(
        "O pedido mudou durante o estorno e precisa de conferência manual",
        completed,
      );
    }
    return jsonResponse({ data: completed });
  }

  const itemMatch = path.match(
    /^\/orders\/(presale|stock)\/([^/]+)\/items\/(\d+)\/cancel$/,
  );
  if (itemMatch) {
    const [, orderType, orderId, itemIndexText] = itemMatch;
    if (!UUID_PATTERN.test(orderId)) {
      return jsonResponse({
        error: "Identificador de pedido inválido",
        code: "invalid_order_id",
      }, 400);
    }

    const body = await parseObject(req);
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (
      !body || reason.length > 500 || typeof body.was_delivered !== "boolean"
    ) {
      return jsonResponse({
        error: "Dados do cancelamento do item são inválidos",
        code: "invalid_request",
      }, 400);
    }

    const { data, error } = await supabase.rpc("prepare_item_cancellation", {
      p_order_type: orderType,
      p_order_id: orderId,
      p_item_index: Number(itemIndexText),
      p_was_delivered: body.was_delivered,
      p_reason: reason,
      p_actor_id: actorId,
    });
    if (error) return databaseError(error, "prepare item cancellation");
    const prepared = data as PreparedRefund;

    if (prepared.status === "completed") {
      return jsonResponse({ data: prepared.result });
    }
    if (prepared.status === "reconciliation_required") {
      return jsonResponse({
        error: "Este cancelamento de item precisa de conferência manual",
        code: "reconciliation_required",
      }, 409);
    }

    let externalResult: Record<string, unknown> = {
      provider: "none",
      outcome: "not_required",
    };
    if (prepared.requires_external_refund) {
      const recordedResult = confirmedExternalResult(prepared.external_result);
      if (recordedResult) {
        externalResult = recordedResult;
      } else {
        try {
          externalResult = await executeExternalRefund(
            prepared.asaas_charge_id!,
            numericValue(prepared.refund_value),
            prepared.refund_marker,
            prepared.target_payment_status === "refunded",
          );
        } catch (externalFailure) {
          return externalError(externalFailure);
        }

        const persistError = await persistExternalResult(
          supabase,
          prepared.operation_id,
          externalResult,
        );
        if (persistError) return persistError;
      }
    }

    const { data: completed, error: completeError } = await supabase.rpc(
      "complete_item_cancellation",
      {
        p_operation_id: prepared.operation_id,
        p_external_result: externalResult,
      },
    );
    if (completeError) {
      return databaseError(completeError, "complete item cancellation");
    }
    if (completed?.status === "reconciliation_required") {
      return reconciliationResponse(
        "O pedido mudou durante o cancelamento do item e precisa de conferência manual",
        completed,
      );
    }
    return jsonResponse({ data: completed });
  }

  const match = path.match(/^\/orders\/(presale|stock)\/([^/]+)\/cancel$/);
  if (!match) return null;

  const [, orderType, orderId] = match;
  if (!UUID_PATTERN.test(orderId)) {
    return jsonResponse({
      error: "Identificador de pedido inválido",
      code: "invalid_order_id",
    }, 400);
  }

  const reason = await parseReason(req);
  if (!reason) {
    return jsonResponse({
      error: "Informe um motivo de cancelamento válido",
      code: "invalid_reason",
    }, 400);
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

  if (completeError) {
    return databaseError(completeError, "complete cancellation");
  }
  if (completed?.status === "reconciliation_required") {
    return jsonResponse({
      error:
        "O pedido mudou durante o cancelamento e precisa de conferência manual",
      code: "reconciliation_required",
      details: { operation_id: completed.operation_id },
    }, 409);
  }

  return jsonResponse({ data: completed });
}
