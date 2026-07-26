import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import {
  AsaasApiError,
  getAsaasPayment,
  updateAsaasPaymentDueDate,
} from "../_shared/asaas.ts";
import { jsonResponse } from "../_shared/http.ts";
import { isValidIsoDate } from "./payments.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const ADJUSTABLE_ASAAS_STATUSES = new Set(["PENDING", "OVERDUE"]);
const AMBIGUOUS_ASAAS_ERROR_CODES = new Set([
  "asaas_due_date_update_unavailable",
  "asaas_due_date_update_unconfirmed",
]);
const DUE_DATE_PATH = /^\/orders\/(presale|stock|contract)\/([^/]+)\/due-date$/;

interface PreparedDueDateChange {
  operation_id: string;
  status: "prepared" | "completed" | "reconciliation_required" | "failed";
  asaas_charge_id?: string | null;
  lease_acquired?: boolean;
  lease_token?: string | null;
  lease_expires_at?: string | null;
  result?: Record<string, unknown> | null;
  error_code?: string | null;
  error?: string | null;
}

function databaseError(
  error: { code?: string; message?: string },
  operation: string,
): Response {
  console.error(`api-v1 billing ${operation}:`, error);

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
    error: "Não foi possível alterar o vencimento",
    code: "database_error",
  }, 500);
}

function externalError(error: unknown, operationId: string): Response {
  if (error instanceof AsaasApiError) {
    return jsonResponse({
      error: error.message,
      code: error.code,
      details: { operation_id: operationId },
    }, error.status);
  }

  console.error(
    "api-v1 billing unexpected external error:",
    error instanceof Error ? error.message : error,
  );
  return jsonResponse({
    error: "Não foi possível confirmar o vencimento no Asaas",
    code: "external_error",
    details: { operation_id: operationId },
  }, 502);
}

async function parseBody(
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

function hasInstallment(payment: Record<string, unknown>): boolean {
  if (payment.installment != null && payment.installment !== "") return true;
  const installmentNumber = Number(payment.installmentNumber);
  const installmentCount = Number(payment.installmentCount);
  return (Number.isFinite(installmentNumber) && installmentNumber > 0) ||
    (Number.isFinite(installmentCount) && installmentCount > 1);
}

export async function changeAsaasPaymentDueDate(
  chargeId: string,
  dueDate: string,
): Promise<Record<string, unknown>> {
  const lookup = await getAsaasPayment(chargeId);
  if (!lookup.found) {
    throw new AsaasApiError(
      "A cobrança não foi encontrada no Asaas e precisa de conferência",
      409,
      "asaas_payment_not_found",
    );
  }

  const payment = lookup.payment;
  const currentDueDate = typeof payment.dueDate === "string"
    ? payment.dueDate
    : null;

  if (hasInstallment(payment)) {
    throw new AsaasApiError(
      "Parcelamentos exigem conferência individual antes de alterar o vencimento",
      409,
      "asaas_installment_due_date_unsupported",
    );
  }

  if (currentDueDate === dueDate) {
    return {
      provider: "asaas",
      outcome: "already_current",
      payment_id: chargeId,
      due_date: dueDate,
      previous_due_date: currentDueDate,
      previous_status: lookup.status,
      status_after: lookup.status,
    };
  }

  if (!ADJUSTABLE_ASAAS_STATUSES.has(lookup.status)) {
    throw new AsaasApiError(
      `A cobrança está com status ${lookup.status} e não permite alterar o vencimento`,
      409,
      "asaas_status_not_adjustable",
    );
  }

  const billingType = typeof payment.billingType === "string"
    ? payment.billingType
    : "";
  const value = typeof payment.value === "number"
    ? payment.value
    : Number(payment.value);
  if (!billingType || !Number.isFinite(value) || value <= 0) {
    throw new AsaasApiError(
      "A cobrança retornou dados incompletos e precisa de conferência",
      409,
      "asaas_payment_invalid",
    );
  }

  const updated = await updateAsaasPaymentDueDate(
    chargeId,
    billingType,
    value,
    dueDate,
  );
  if (updated.dueDate !== dueDate) {
    throw new AsaasApiError(
      "O Asaas não confirmou o novo vencimento",
      502,
      "asaas_due_date_update_unconfirmed",
    );
  }

  return {
    provider: "asaas",
    outcome: "updated",
    payment_id: chargeId,
    due_date: dueDate,
    previous_due_date: currentDueDate,
    previous_status: lookup.status,
    status_after: typeof updated.status === "string"
      ? updated.status
      : lookup.status,
  };
}

function reconciliationResponse(
  message: string,
  operationId: string,
): Response {
  return jsonResponse({
    error: message,
    code: "reconciliation_required",
    details: { operation_id: operationId },
  }, 409);
}

async function finalizeFailure(
  supabase: SupabaseClient,
  prepared: PreparedDueDateChange,
  error: AsaasApiError,
  dueDate: string,
  requiresReconciliation: boolean,
  externalResult: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const { data, error: finalizeError } = await supabase.rpc(
    "finalize_order_due_date_failure",
    {
      p_operation_id: prepared.operation_id,
      p_lease_token: prepared.lease_token,
      p_error_code: error.code,
      p_error_message: error.message.slice(0, 500),
      p_requires_reconciliation: requiresReconciliation,
      p_external_result: {
        payment_id: prepared.asaas_charge_id || null,
        due_date: dueDate,
        ...externalResult,
      },
    },
  );
  if (finalizeError) {
    console.error("api-v1 billing finalize failure:", finalizeError);
    return null;
  }
  return data as Record<string, unknown>;
}

export async function handleBillingRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  const match = path.match(DUE_DATE_PATH);
  if (!match) return null;

  if (req.method !== "PATCH") {
    return jsonResponse({
      error: "Método não permitido",
      code: "method_not_allowed",
    }, 405);
  }

  const [, orderType, orderId] = match;
  if (!UUID_PATTERN.test(orderId)) {
    return jsonResponse({
      error: "Identificador de venda inválido",
      code: "invalid_order_id",
    }, 400);
  }

  const idempotencyKey = req.headers.get("Idempotency-Key")?.trim() || "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return jsonResponse({
      error: "Informe uma chave de idempotência válida",
      code: "invalid_idempotency_key",
    }, 400);
  }

  const body = await parseBody(req);
  const keys = body ? Object.keys(body) : [];
  const dueDate = typeof body?.due_date === "string" ? body.due_date : "";
  if (
    !body || keys.length !== 1 || keys[0] !== "due_date" ||
    !isValidIsoDate(dueDate)
  ) {
    return jsonResponse({
      error: "Informe um vencimento válido",
      code: "invalid_due_date",
    }, 400);
  }

  const { data, error } = await supabase.rpc(
    "prepare_order_due_date_change",
    {
      p_order_type: orderType,
      p_order_id: orderId,
      p_due_date: dueDate,
      p_idempotency_key: idempotencyKey,
      p_actor_id: actorId,
    },
  );
  if (error) return databaseError(error, "prepare due date change");

  const prepared = data as PreparedDueDateChange;
  if (prepared.status === "completed") {
    return jsonResponse({ data: prepared.result });
  }
  if (prepared.status === "reconciliation_required") {
    return reconciliationResponse(
      prepared.error || "Esta alteração precisa de conferência manual",
      prepared.operation_id,
    );
  }
  if (prepared.status === "failed") {
    return jsonResponse({
      error: prepared.error || "Esta alteração não pôde ser concluída",
      code: prepared.error_code || "operation_failed",
      details: { operation_id: prepared.operation_id },
    }, 409);
  }
  if (!prepared.lease_acquired || !prepared.lease_token) {
    return jsonResponse({
      error: "A alteração de vencimento já está em processamento",
      code: "operation_in_progress",
      details: {
        operation_id: prepared.operation_id,
        retry_after: prepared.lease_expires_at,
      },
    }, 409);
  }

  let externalResult: Record<string, unknown> = {
    provider: "none",
    outcome: "not_required",
  };
  if (prepared.asaas_charge_id) {
    try {
      externalResult = await changeAsaasPaymentDueDate(
        prepared.asaas_charge_id,
        dueDate,
      );
    } catch (externalFailure) {
      if (externalFailure instanceof AsaasApiError) {
        const requiresReconciliation = AMBIGUOUS_ASAAS_ERROR_CODES.has(
          externalFailure.code,
        ) ||
          (externalFailure.code === "asaas_due_date_update_failed" &&
            externalFailure.status >= 500);
        const finalized = await finalizeFailure(
          supabase,
          prepared,
          externalFailure,
          dueDate,
          requiresReconciliation,
          {
            provider: "asaas",
            outcome: requiresReconciliation ? "unconfirmed" : "rejected",
            error_code: externalFailure.code,
          },
        );
        if (finalized?.status === "completed") {
          return jsonResponse({ data: finalized.result });
        }
        if (finalized?.status === "reconciliation_required") {
          return reconciliationResponse(
            externalFailure.message,
            prepared.operation_id,
          );
        }
      }
      return externalError(externalFailure, prepared.operation_id);
    }
  }

  const { data: completed, error: completeError } = await supabase.rpc(
    "complete_order_due_date_change",
    {
      p_operation_id: prepared.operation_id,
      p_lease_token: prepared.lease_token,
      p_external_result: externalResult,
    },
  );
  if (completeError) {
    if (prepared.asaas_charge_id) {
      console.error(
        "api-v1 billing complete after Asaas update:",
        completeError,
      );
      const persisted = await finalizeFailure(
        supabase,
        prepared,
        new AsaasApiError(
          "O resultado externo precisa de reconciliação com a venda",
          409,
          "database_complete_failed",
        ),
        dueDate,
        true,
        externalResult,
      );
      if (persisted?.status === "completed") {
        return jsonResponse({ data: persisted.result });
      }
      return reconciliationResponse(
        "O Asaas recebeu o vencimento, mas a venda precisa ser reconciliada",
        prepared.operation_id,
      );
    }
    return databaseError(completeError, "complete due date change");
  }
  if (completed?.status === "reconciliation_required") {
    return reconciliationResponse(
      completed.error || "A venda mudou e precisa de conferência manual",
      prepared.operation_id,
    );
  }

  return jsonResponse({ data: completed });
}
