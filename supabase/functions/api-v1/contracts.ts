import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { AsaasApiError } from "../_shared/asaas.ts";
import {
  type AsaasCancellationSnapshot,
  cancelExternalCharge,
} from "../_shared/asaas-cancellation.ts";
import { jsonResponse } from "../_shared/http.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type MutationType = "void_contract_sale" | "change_contract_plan";

interface PreparedMutation {
  operation_id: string;
  status: "prepared" | "completed" | "reconciliation_required" | "failed";
  asaas_charge_id?: string | null;
  had_external_charge?: boolean;
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

interface MutationInput {
  operationType: MutationType;
  reason: string;
  planId: string | null;
  startDate: string | null;
  installments: number | null;
  enrollmentFee: number | null;
  manualDiscount: number | null;
  discountReason: string | null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function databaseError(
  error: { code?: string; message?: string },
  operation: string,
): Response {
  console.error(`api-v1 contracts ${operation}:`, error);
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
    error: "Não foi possível atualizar o contrato",
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
  console.error("api-v1 contracts external error:", error);
  return jsonResponse({
    error: "Não foi possível confirmar a cobrança no Asaas",
    code: "external_error",
  }, 502);
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
  contractId: string,
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
    .eq("order_id", contractId)
    .eq("order_type", "contract")
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
      error: "O cache local possui mais de um parcelamento para este contrato",
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

async function parseInput(
  req: Request,
  operationType: MutationType,
): Promise<MutationInput | null> {
  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  if (operationType === "void_contract_sale") {
    if (Object.keys(body).length !== 0) return null;
    return {
      operationType,
      reason: "Venda não concretizada (cliente nunca pagou)",
      planId: null,
      startDate: null,
      installments: null,
      enrollmentFee: null,
      manualDiscount: null,
      discountReason: null,
    };
  }

  const allowed = new Set([
    "plan_id",
    "start_date",
    "installments",
    "enrollment_fee",
    "manual_discount",
    "discount_reason",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;

  const planId = stringValue(body.plan_id).trim();
  const startDate = stringValue(body.start_date).trim();
  const installments = body.installments;
  const enrollmentFee = body.enrollment_fee;
  const manualDiscount = body.manual_discount;
  const discountReason = body.discount_reason == null
    ? null
    : stringValue(body.discount_reason).trim() || null;

  if (
    !UUID_PATTERN.test(planId) || !isCalendarDate(startDate) ||
    typeof installments !== "number" ||
    !Number.isInteger(installments) || installments < 1 ||
    typeof enrollmentFee !== "number" ||
    !Number.isFinite(enrollmentFee) || enrollmentFee < 0 ||
    typeof manualDiscount !== "number" ||
    !Number.isFinite(manualDiscount) || manualDiscount < 0 ||
    (body.discount_reason != null &&
      typeof body.discount_reason !== "string") ||
    (discountReason !== null && discountReason.length > 500)
  ) return null;

  return {
    operationType,
    reason: "Plano do contrato alterado antes do pagamento",
    planId,
    startDate,
    installments,
    enrollmentFee,
    manualDiscount,
    discountReason,
  };
}

async function runContractMutation(
  req: Request,
  supabase: SupabaseClient,
  contractId: string,
  actorId: string,
  operationType: MutationType,
): Promise<Response> {
  if (!UUID_PATTERN.test(contractId)) {
    return jsonResponse(
      { error: "Contrato inválido", code: "invalid_request" },
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
  const input = await parseInput(req, operationType);
  if (!input) {
    return jsonResponse({
      error: operationType === "change_contract_plan"
        ? "Informe os dados válidos do novo plano"
        : "Requisição inválida",
      code: "invalid_request",
    }, 400);
  }

  const { data, error } = await supabase.rpc(
    "prepare_assessment_contract_mutation",
    {
      p_operation_type: input.operationType,
      p_contract_id: contractId,
      p_plan_id: input.planId,
      p_start_date: input.startDate,
      p_installments: input.installments,
      p_enrollment_fee: input.enrollmentFee,
      p_manual_discount: input.manualDiscount,
      p_discount_reason: input.discountReason,
      p_reason: input.reason,
      p_idempotency_key: idempotencyKey,
      p_actor_id: actorId,
    },
  );
  if (error) return databaseError(error, "prepare mutation");
  const prepared = data as PreparedMutation;
  if (prepared.status === "completed") {
    return jsonResponse({ data: prepared.result });
  }
  if (prepared.status === "reconciliation_required") {
    return jsonResponse({
      error: prepared.error || "Esta alteração precisa de conferência manual",
      code: "reconciliation_required",
      operation_id: prepared.operation_id,
    }, 409);
  }
  if (!prepared.lease_acquired || !prepared.lease_token) {
    return jsonResponse({
      error: "A alteração já está em processamento",
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
        contractId,
        chargeId,
      );
      if (cached instanceof Response) {
        const { error: finalizeError } = await supabase.rpc(
          "finalize_assessment_contract_mutation_failure",
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
          console.error("api-v1 contracts finalize cache:", finalizeError);
        }
        return cached;
      }
      const stored = snapshotFromStored(storedSnapshot);
      externalResult = await cancelExternalCharge(
        chargeId,
        stored.installmentId || cached.installmentId,
        stored.standalone || cached.standalone,
        cached.paymentIds,
        async (snapshot: AsaasCancellationSnapshot) => {
          const persisted = { ...snapshot, outcome: "cancellation_snapshot" };
          const { error: snapshotError } = await supabase.rpc(
            "record_assessment_contract_mutation_snapshot",
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
    } else if (prepared.had_external_charge) {
      externalResult = { provider: "external_reference", outcome: "detached" };
    } else {
      externalResult = { provider: "none", outcome: "not_required" };
    }

    const { data: completed, error: completeError } = await supabase.rpc(
      "complete_assessment_contract_mutation",
      {
        p_operation_id: prepared.operation_id,
        p_lease_token: prepared.lease_token,
        p_external_result: externalResult,
      },
    );
    if (completeError) {
      const response = databaseError(completeError, "complete mutation");
      const { error: finalizeError } = await supabase.rpc(
        "finalize_assessment_contract_mutation_failure",
        {
          p_operation_id: prepared.operation_id,
          p_lease_token: prepared.lease_token,
          p_error_code: "local_completion_failed",
          p_error_message:
            "O Asaas confirmou o cancelamento, mas a alteração local falhou",
          p_requires_reconciliation: true,
          p_external_result: externalResult,
        },
      );
      if (finalizeError) {
        console.error("api-v1 contracts finalize completion:", finalizeError);
      }
      return response;
    }
    if (completed?.status === "reconciliation_required") {
      return jsonResponse({
        error: completed.error || "A alteração precisa de conferência manual",
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
    const { error: finalizeError } = await supabase.rpc(
      "finalize_assessment_contract_mutation_failure",
      {
        p_operation_id: prepared.operation_id,
        p_lease_token: prepared.lease_token,
        p_error_code: errorCode,
        p_error_message: errorMessage.slice(0, 500),
        p_requires_reconciliation: requiresReconciliation,
        p_external_result: externalResult || persistedSnapshot || {},
      },
    );
    if (finalizeError) {
      console.error("api-v1 contracts finalize external:", finalizeError);
    }
    return externalError(error);
  }
}

export async function handleContractRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  const match = path.match(
    /^\/orders\/contract\/([^/]+)\/(void-sale|plan)$/,
  );
  if (!match) return null;

  const operationType: MutationType = match[2] === "void-sale"
    ? "void_contract_sale"
    : "change_contract_plan";
  const expectedMethod = operationType === "void_contract_sale"
    ? "POST"
    : "PATCH";
  if (req.method !== expectedMethod) {
    return jsonResponse({
      error: "Método não permitido",
      code: "method_not_allowed",
    }, 405);
  }

  return await runContractMutation(
    req,
    supabase,
    match[1],
    actorId,
    operationType,
  );
}
