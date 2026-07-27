import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { AsaasApiError, getAsaasPayment } from "../_shared/asaas.ts";
import {
  type AsaasCancellationSnapshot,
  cancelExternalCharge,
} from "../_shared/asaas-cancellation.ts";
import { jsonResponse } from "../_shared/http.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const PAID_ASAAS_STATUSES = new Set([
  "RECEIVED",
  "CONFIRMED",
  "RECEIVED_IN_CASH",
]);

interface PreparedCancellation {
  operation_id: string;
  status: "prepared" | "completed" | "reconciliation_required" | "failed";
  asaas_charge_id?: string | null;
  had_external_link?: boolean;
  lease_acquired?: boolean;
  lease_token?: string | null;
  external_result?: Record<string, unknown> | null;
  result?: unknown;
  error?: string | null;
}

interface CachedAsaasPayment {
  asaas_payment_id?: string | null;
  installment_group_id?: string | null;
  raw?: Record<string, unknown> | null;
}

function databaseError(
  error: { code?: string; message?: string },
  operation: string,
): Response {
  console.error(`api-v1 charge lifecycle ${operation}:`, error);
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
  return jsonResponse({
    error: "Não foi possível atualizar a cobrança",
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
  console.error("api-v1 charge lifecycle external error:", error);
  return jsonResponse({
    error: "Não foi possível confirmar a cobrança no Asaas",
    code: "external_error",
  }, 502);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function tableForType(orderType: string): string | null {
  if (orderType === "presale") return "presale_orders";
  if (orderType === "stock") return "stock_orders";
  if (orderType === "contract") return "assessment_contracts";
  return null;
}

function mapPaymentMethod(
  billingType: unknown,
  installments: unknown,
): string | null {
  const method = stringValue(billingType).toUpperCase();
  if (method === "PIX") return "pix";
  if (method === "BOLETO") return "boleto";
  if (method === "CREDIT_CARD") {
    const count = Math.max(Number(installments) || 1, 1);
    return count > 1 ? `card_${count}x` : "credit_card";
  }
  return null;
}

function statusView(status: string) {
  if (PAID_ASAAS_STATUSES.has(status)) {
    return { label: "Pago", color: "success", is_paid: true };
  }
  if (status === "PENDING") {
    return { label: "Aguardando pagamento", color: "warning", is_paid: false };
  }
  if (status === "OVERDUE") {
    return { label: "Vencido", color: "danger", is_paid: false };
  }
  if (status === "REFUNDED") {
    return { label: "Estornado", color: "info", is_paid: false };
  }
  if (status === "CANCELLED" || status === "CANCELED") {
    return { label: "Cancelado", color: "danger", is_paid: false };
  }
  return { label: status, color: "secondary", is_paid: false };
}

function paymentCacheRow(
  payment: Record<string, unknown>,
  orderId: string,
  orderType: string,
) {
  return {
    asaas_payment_id: stringValue(payment.id),
    asaas_customer_id: stringValue(payment.customer) || null,
    installment_group_id: stringValue(payment.installment) || null,
    installment_number: Number(payment.installmentNumber) || null,
    total_installments: null,
    billing_type: stringValue(payment.billingType) || null,
    status: stringValue(payment.status) || "UNKNOWN",
    value: Number(payment.value) || 0,
    net_value: payment.netValue == null ? null : Number(payment.netValue),
    due_date: stringValue(payment.dueDate) || null,
    payment_date: stringValue(payment.paymentDate) || null,
    credit_date: stringValue(payment.creditDate) || null,
    description: stringValue(payment.description) || null,
    external_reference: stringValue(payment.externalReference) || null,
    order_id: orderId,
    order_type: orderType,
    source: "asaas",
    raw: payment,
    last_synced_at: new Date().toISOString(),
  };
}

async function syncChargeStatus(
  supabase: SupabaseClient,
  orderType: string,
  orderId: string,
): Promise<Response> {
  const table = tableForType(orderType);
  if (!table || !UUID_PATTERN.test(orderId)) {
    return jsonResponse({
      error: "Venda inválida",
      code: "invalid_request",
    }, 400);
  }

  const selectColumns = orderType === "contract"
    ? "id,payment_status,asaas_charge_id,installments"
    : "id,payment_status,asaas_charge_id";
  const { data: order, error: orderError } = await supabase
    .from(table)
    .select(selectColumns)
    .eq("id", orderId)
    .maybeSingle();
  if (orderError) return databaseError(orderError, "load status");
  if (!order) {
    return jsonResponse(
      { error: "Venda não encontrada", code: "not_found" },
      404,
    );
  }
  const orderRecord = order as unknown as Record<string, unknown>;

  const chargeId = stringValue(orderRecord.asaas_charge_id);
  if (!chargeId) {
    return jsonResponse({
      error: "Esta venda não possui cobrança Asaas",
      code: "charge_not_found",
    }, 400);
  }

  let lookup;
  try {
    lookup = await getAsaasPayment(chargeId);
  } catch (error) {
    return externalError(error);
  }
  if (!lookup.found) {
    return jsonResponse({
      error: "A cobrança não foi encontrada no Asaas e precisa de conferência",
      code: "asaas_payment_not_found",
    }, 409);
  }

  const payment = lookup.payment;
  const view = statusView(lookup.status);
  let paymentStatusUpdated = false;

  if (view.is_paid && orderRecord.payment_status !== "paid") {
    const updates: Record<string, unknown> = {
      payment_status: "paid",
      payment_date: stringValue(payment.paymentDate) ||
        new Date().toISOString().slice(0, 10),
    };
    if (orderType === "contract") {
      const method = mapPaymentMethod(
        payment.billingType,
        orderRecord.installments,
      );
      if (method) updates.payment_method = method;
      updates.updated_at = new Date().toISOString();
    } else {
      updates.updated_date = new Date().toISOString();
    }

    const { data: updated, error: updateError } = await supabase
      .from(table)
      .update(updates)
      .eq("id", orderId)
      .eq("asaas_charge_id", chargeId)
      .select("id")
      .maybeSingle();
    if (updateError) return databaseError(updateError, "sync paid status");
    if (!updated) {
      return jsonResponse({
        error: "A cobrança vinculada à venda mudou durante a consulta",
        code: "charge_changed",
      }, 409);
    }
    paymentStatusUpdated = true;
  }

  const { error: cacheError } = await supabase
    .from("asaas_payments")
    .upsert(
      paymentCacheRow(
        {
          ...payment,
          id: stringValue(payment.id) || chargeId,
        },
        orderId,
        orderType,
      ),
      {
        onConflict: "asaas_payment_id",
      },
    );
  if (cacheError) return databaseError(cacheError, "cache status");

  return jsonResponse({
    data: {
      ...view,
      status: lookup.status,
      payment_status_updated: paymentStatusUpdated,
    },
  });
}

async function parseCancellationReason(req: Request): Promise<string | null> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const keys = Object.keys(body);
    if (keys.some((key) => key !== "reason")) return null;
    const reason = stringValue((body as Record<string, unknown>).reason).trim();
    return reason.length >= 1 && reason.length <= 500 ? reason : null;
  } catch {
    return null;
  }
}

function snapshotFromStored(
  stored: Record<string, unknown> | null,
): { installmentId: string; standalone: boolean } {
  if (stored?.outcome !== "cancellation_snapshot") {
    return { installmentId: "", standalone: false };
  }
  const kind = stringValue(stored.kind);
  return {
    installmentId: kind === "installment"
      ? stringValue(stored.installment_id)
      : "",
    standalone: kind === "standalone",
  };
}

async function loadCancellationCache(
  supabase: SupabaseClient,
  orderType: string,
  orderId: string,
  chargeId: string,
): Promise<
  {
    installmentId: string;
    standalone: boolean;
    paymentIds: string[];
  } | Response
> {
  const { data, error } = await supabase
    .from("asaas_payments")
    .select("asaas_payment_id,installment_group_id,raw")
    .eq("order_id", orderId)
    .eq("order_type", orderType)
    .eq("source", "asaas");
  if (error) return databaseError(error, "load cancellation cache");

  const rows = (data || []) as CachedAsaasPayment[];
  const installmentIds = Array.from(
    new Set(rows.flatMap((row) => {
      const fromColumn = stringValue(row.installment_group_id);
      const fromRaw = stringValue(objectValue(row.raw)?.installment);
      const value = fromColumn || fromRaw;
      return value ? [value] : [];
    })),
  );
  if (installmentIds.length > 1) {
    return jsonResponse({
      error: "O cache local possui mais de um parcelamento para esta venda",
      code: "asaas_installment_mismatch",
    }, 409);
  }

  const paymentIds = Array.from(
    new Set(rows.flatMap((row) => {
      const value = stringValue(row.asaas_payment_id);
      return value ? [value] : [];
    })),
  );
  const chargeRow = rows.find((row) => row.asaas_payment_id === chargeId);
  const chargeInstallment = stringValue(chargeRow?.installment_group_id) ||
    stringValue(objectValue(chargeRow?.raw)?.installment);

  return {
    installmentId: installmentIds[0] || "",
    standalone: Boolean(chargeRow && !chargeInstallment),
    paymentIds,
  };
}

function cancellationMayBeAmbiguous(error: unknown): boolean {
  return error instanceof AsaasApiError && [
    "asaas_unavailable",
    "asaas_installment_cancel_unavailable",
  ].includes(error.code);
}

async function cancelCharge(
  req: Request,
  supabase: SupabaseClient,
  orderType: string,
  orderId: string,
  actorId: string,
): Promise<Response> {
  const table = tableForType(orderType);
  if (!table || !UUID_PATTERN.test(orderId)) {
    return jsonResponse(
      { error: "Venda inválida", code: "invalid_request" },
      400,
    );
  }
  const idempotencyKey = req.headers.get("Idempotency-Key")?.trim() || "";
  if (!IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    return jsonResponse({
      error: "Informe uma chave de idempotência válida",
      code: "invalid_idempotency_key",
    }, 400);
  }
  const reason = await parseCancellationReason(req);
  if (!reason) {
    return jsonResponse({
      error: "Informe um motivo de cancelamento válido",
      code: "invalid_request",
    }, 400);
  }

  const { data, error } = await supabase.rpc(
    "prepare_order_charge_cancellation",
    {
      p_order_type: orderType,
      p_order_id: orderId,
      p_reason: reason,
      p_idempotency_key: idempotencyKey,
      p_actor_id: actorId,
    },
  );
  if (error) return databaseError(error, "prepare cancellation");
  const prepared = data as PreparedCancellation;
  if (prepared.status === "completed") {
    return jsonResponse({ data: prepared.result });
  }
  if (prepared.status === "reconciliation_required") {
    return jsonResponse({
      error: prepared.error ||
        "Este cancelamento precisa de conferência manual",
      code: "reconciliation_required",
      operation_id: prepared.operation_id,
    }, 409);
  }
  if (!prepared.lease_acquired || !prepared.lease_token) {
    return jsonResponse({
      error: "O cancelamento já está em processamento",
      code: "operation_in_progress",
      operation_id: prepared.operation_id,
    }, 409);
  }

  const chargeId = stringValue(prepared.asaas_charge_id);
  const storedSnapshot = objectValue(prepared.external_result);
  let persistedSnapshot = storedSnapshot;
  let externalResult: Record<string, unknown> | null = null;

  try {
    if (chargeId) {
      const cached = await loadCancellationCache(
        supabase,
        orderType,
        orderId,
        chargeId,
      );
      if (cached instanceof Response) {
        const { error: finalizeError } = await supabase.rpc(
          "finalize_order_charge_cancellation_failure",
          {
            p_operation_id: prepared.operation_id,
            p_lease_token: prepared.lease_token,
            p_error_code: "local_cache_invalid",
            p_error_message:
              "Não foi possível validar o cache local da cobrança",
            p_requires_reconciliation: false,
            p_external_result: storedSnapshot || {},
          },
        );
        if (finalizeError) {
          console.error(
            "api-v1 charge lifecycle finalize cache:",
            finalizeError,
          );
        }
        return cached;
      }
      const stored = snapshotFromStored(storedSnapshot);
      const knownInstallmentId = stored.installmentId || cached.installmentId;
      const knownStandalone = stored.standalone || cached.standalone;

      externalResult = await cancelExternalCharge(
        chargeId,
        knownInstallmentId,
        knownStandalone,
        cached.paymentIds,
        async (snapshot: AsaasCancellationSnapshot) => {
          const persisted = {
            ...snapshot,
            outcome: "cancellation_snapshot",
          };
          const { error: snapshotError } = await supabase.rpc(
            "record_order_charge_cancellation_snapshot",
            {
              p_operation_id: prepared.operation_id,
              p_lease_token: prepared.lease_token,
              p_external_result: persisted,
            },
          );
          if (snapshotError) {
            throw new AsaasApiError(
              "Não foi possível registrar a conferência da cobrança",
              500,
              "cancellation_snapshot_failed",
            );
          }
          persistedSnapshot = persisted;
        },
      );
    } else if (prepared.had_external_link) {
      externalResult = { provider: "external_link", outcome: "detached" };
    } else {
      externalResult = { provider: "none", outcome: "not_required" };
    }

    const { data: completed, error: completeError } = await supabase.rpc(
      "complete_order_charge_cancellation",
      {
        p_operation_id: prepared.operation_id,
        p_lease_token: prepared.lease_token,
        p_external_result: externalResult,
      },
    );
    if (completeError) {
      const response = databaseError(completeError, "complete cancellation");
      const { error: finalizeError } = await supabase.rpc(
        "finalize_order_charge_cancellation_failure",
        {
          p_operation_id: prepared.operation_id,
          p_lease_token: prepared.lease_token,
          p_error_code: "local_completion_failed",
          p_error_message:
            "O Asaas confirmou o cancelamento, mas o registro local falhou",
          p_requires_reconciliation: true,
          p_external_result: externalResult,
        },
      );
      if (finalizeError) {
        console.error(
          "api-v1 charge lifecycle finalize completion:",
          finalizeError,
        );
      }
      return response;
    }
    if (completed?.status === "reconciliation_required") {
      return jsonResponse({
        error: completed.error ||
          "O cancelamento precisa de conferência manual",
        code: "reconciliation_required",
        operation_id: prepared.operation_id,
      }, 409);
    }
    return jsonResponse({ data: completed });
  } catch (error) {
    const requiresReconciliation = externalResult !== null ||
      cancellationMayBeAmbiguous(error);
    const errorCode = error instanceof AsaasApiError
      ? error.code
      : "external_error";
    const errorMessage = error instanceof Error
      ? error.message
      : "Falha ao cancelar a cobrança";
    const failureExternalResult = externalResult || persistedSnapshot || {};
    const { error: finalizeError } = await supabase.rpc(
      "finalize_order_charge_cancellation_failure",
      {
        p_operation_id: prepared.operation_id,
        p_lease_token: prepared.lease_token,
        p_error_code: errorCode,
        p_error_message: errorMessage.slice(0, 500),
        p_requires_reconciliation: requiresReconciliation,
        p_external_result: failureExternalResult,
      },
    );
    if (finalizeError) {
      console.error(
        "api-v1 charge lifecycle finalize external:",
        finalizeError,
      );
    }
    return externalError(error);
  }
}

export async function handleChargeLifecycleRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  const statusMatch = path.match(
    /^\/orders\/(presale|stock|contract)\/([^/]+)\/charge\/status$/,
  );
  if (statusMatch) {
    if (req.method !== "POST") {
      return jsonResponse({
        error: "Método não permitido",
        code: "method_not_allowed",
      }, 405);
    }
    return await syncChargeStatus(supabase, statusMatch[1], statusMatch[2]);
  }

  const cancelMatch = path.match(
    /^\/orders\/(presale|stock|contract)\/([^/]+)\/charge\/cancel$/,
  );
  if (!cancelMatch) return null;
  if (req.method !== "POST") {
    return jsonResponse({
      error: "Método não permitido",
      code: "method_not_allowed",
    }, 405);
  }
  return await cancelCharge(
    req,
    supabase,
    cancelMatch[1],
    cancelMatch[2],
    actorId,
  );
}
