import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import {
  type AsaasCancellationSnapshot,
  cancelExternalCharge,
} from "../_shared/asaas-cancellation.ts";
import { AsaasApiError } from "../_shared/asaas.ts";
import { jsonResponse } from "../_shared/http.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const RENEWAL_RESOLUTION_PATH =
  /^\/orders\/contract\/([^/]+)\/renewal-resolution$/;
const OPEN_PAYMENT_STATUSES = new Set([
  "pending",
  "awaiting_charge",
  "charge_sent",
  "overdue",
]);
const RENEWAL_REASON_TEXT: Record<RenewalReasonCode, string> = {
  customer_declined: "Atleta decidiu não renovar",
  duplicate: "Renovação criada em duplicidade",
  created_in_error: "Renovação criada por engano",
};
const BODY_KEYS = new Set([
  "resolution",
  "reason_code",
  "reason",
  "expected_updated_at",
  "expected_payment_status",
  "expected_charge_id",
  "external_cancellation_confirmed",
  "external_confirmation_note",
  "service_started",
]);

type RenewalResolution = "non_renewal" | "discard";
type RenewalReasonCode =
  | "customer_declined"
  | "duplicate"
  | "created_in_error";

interface RenewalResolutionBody {
  resolution: RenewalResolution;
  reason_code: RenewalReasonCode;
  reason: string;
  expected_updated_at: string;
  expected_payment_status: string;
  expected_charge_id: string | null;
  external_cancellation_confirmed: boolean;
  external_confirmation_note: string | null;
  service_started: boolean;
}

interface PreparedRenewalResolution {
  operation_id: string;
  status: "prepared" | "completed" | "reconciliation_required";
  renewal_id?: string;
  resolution?: RenewalResolution;
  reason_code?: RenewalReasonCode;
  asaas_charge_id?: string | null;
  external_payment_link?: string | null;
  external_invoice_number?: string | null;
  external_cancellation_confirmed?: boolean;
  external_confirmation_note?: string | null;
  provider_snapshot?: Record<string, unknown> | null;
  external_result?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
}

interface ExternalOperationClaim {
  status: "prepared" | "completed" | "reconciliation_required";
  lease_acquired?: boolean;
  lease_token?: string | null;
  lease_expires_at?: string | null;
  provider_snapshot?: Record<string, unknown> | null;
  external_result?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function databaseError(
  error: { code?: string; message?: string },
  operation: string,
  operationId?: string,
): Response {
  console.error(`api-v1 renewal ${operation}:`, error);
  const operationDetails = operationId
    ? { details: { operation_id: operationId } }
    : {};

  if (error.code === "P0002") {
    return jsonResponse({
      error: error.message,
      code: "not_found",
      ...operationDetails,
    }, 404);
  }
  if (error.code === "22023") {
    return jsonResponse({
      error: error.message,
      code: "invalid_request",
      ...operationDetails,
    }, 400);
  }
  if (error.code === "P0001" || error.code === "23505") {
    return jsonResponse(
      {
        error: error.message,
        code: "invalid_transition",
        ...operationDetails,
      },
      409,
    );
  }

  return jsonResponse({
    error: "Não foi possível resolver a renovação",
    code: "database_error",
    ...operationDetails,
  }, 500);
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

function externalError(error: unknown, operationId: string): Response {
  if (error instanceof AsaasApiError) {
    return jsonResponse({
      error: error.message,
      code: error.code,
      details: { operation_id: operationId },
    }, error.status);
  }

  console.error(
    "api-v1 renewal unexpected external error:",
    error instanceof Error ? error.message : error,
  );
  return jsonResponse({
    error: "Não foi possível confirmar o cancelamento da cobrança",
    code: "external_error",
    details: { operation_id: operationId },
  }, 502);
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

function isValidTimestamp(value: string): boolean {
  const match = value.match(ISO_TIMESTAMP_PATTERN);
  if (!match || !Number.isFinite(Date.parse(value))) return false;

  const [datePart, timeAndZone] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const timePart = timeAndZone.match(/^(\d{2}):(\d{2}):(\d{2})/);
  if (!timePart) return false;
  const [, hourText, minuteText, secondText] = timePart;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) return false;

  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  return calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() === month - 1 &&
    calendarDate.getUTCDate() === day;
}

function parseResolutionBody(
  body: Record<string, unknown> | null,
): RenewalResolutionBody | null {
  if (
    !body || Object.keys(body).length !== BODY_KEYS.size ||
    Object.keys(body).some((key) => !BODY_KEYS.has(key)) ||
    [...BODY_KEYS].some((key) => !Object.hasOwn(body, key))
  ) {
    return null;
  }

  const resolution = body.resolution;
  const reasonCode = body.reason_code;
  const reason = stringValue(body.reason).trim();
  const expectedUpdatedAt = stringValue(body.expected_updated_at);
  const expectedPaymentStatus = stringValue(body.expected_payment_status);
  const expectedChargeId = body.expected_charge_id;
  const externalConfirmationNote = body.external_confirmation_note;

  const resolutionMatchesReason =
    (resolution === "non_renewal" && reasonCode === "customer_declined") ||
    (resolution === "discard" &&
      (reasonCode === "duplicate" || reasonCode === "created_in_error"));
  const canonicalReason = typeof reasonCode === "string" &&
      reasonCode in RENEWAL_REASON_TEXT
    ? RENEWAL_REASON_TEXT[reasonCode as RenewalReasonCode]
    : null;
  const chargeIdIsValid = expectedChargeId === null ||
    (typeof expectedChargeId === "string" &&
      expectedChargeId.length >= 1 && expectedChargeId.length <= 100 &&
      expectedChargeId.trim() === expectedChargeId);
  const noteIsValid = externalConfirmationNote === null ||
    (typeof externalConfirmationNote === "string" &&
      externalConfirmationNote.trim().length >= 1 &&
      externalConfirmationNote.trim().length <= 500);
  const confirmationIsConsistent = body.external_cancellation_confirmed === true
    ? typeof externalConfirmationNote === "string"
    : externalConfirmationNote === null;

  if (
    !resolutionMatchesReason || reason !== canonicalReason ||
    !isValidTimestamp(expectedUpdatedAt) ||
    !OPEN_PAYMENT_STATUSES.has(expectedPaymentStatus) || !chargeIdIsValid ||
    typeof body.external_cancellation_confirmed !== "boolean" ||
    !noteIsValid || !confirmationIsConsistent || body.service_started !== false
  ) {
    return null;
  }

  return {
    resolution,
    reason_code: reasonCode,
    reason,
    expected_updated_at: expectedUpdatedAt,
    expected_payment_status: expectedPaymentStatus,
    expected_charge_id: expectedChargeId,
    external_cancellation_confirmed: body.external_cancellation_confirmed,
    external_confirmation_note: typeof externalConfirmationNote === "string"
      ? externalConfirmationNote.trim()
      : null,
    service_started: body.service_started,
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function confirmedAsaasCancellation(
  value: unknown,
  expectedChargeId: string,
): Record<string, unknown> | null {
  const result = asObject(value);
  if (!result) return null;
  const paymentIds = Array.isArray(result.payment_ids) &&
      result.payment_ids.every((entry) => typeof entry === "string" && entry)
    ? result.payment_ids as string[]
    : [];
  return result.provider === "asaas" &&
      ["deleted", "already_missing", "already_cancelled"].includes(
        stringValue(result.outcome),
      ) && result.payment_id === expectedChargeId &&
      paymentIds.includes(expectedChargeId)
    ? result
    : null;
}

function confirmedProviderSnapshot(
  value: unknown,
  expectedChargeId: string,
): AsaasCancellationSnapshot | null {
  const snapshot = asObject(value);
  if (
    !snapshot || snapshot.provider !== "asaas" ||
    snapshot.payment_id !== expectedChargeId ||
    !["standalone", "installment"].includes(stringValue(snapshot.kind))
  ) {
    return null;
  }

  const installmentId = stringValue(snapshot.installment_id);
  const installmentGroupId = stringValue(snapshot.installment_group_id);
  if (snapshot.kind === "standalone") {
    return !installmentId && !installmentGroupId
      ? snapshot as unknown as AsaasCancellationSnapshot
      : null;
  }
  return installmentId && installmentGroupId === installmentId
    ? snapshot as unknown as AsaasCancellationSnapshot
    : null;
}

function confirmedExternalAttestation(
  value: unknown,
  expectedPaymentLink: string,
  expectedInvoiceNumber: string | null,
  expectedConfirmationNote: string,
  expectedActorId: string,
): Record<string, unknown> | null {
  const result = asObject(value);
  if (!result) return null;
  const confirmedBy = stringValue(result.confirmed_by);
  const invoiceNumber = result.external_invoice_number;
  const invoiceMatches = expectedInvoiceNumber === null
    ? invoiceNumber === null || invoiceNumber === undefined
    : invoiceNumber === expectedInvoiceNumber;
  return result.provider === "external" &&
      result.outcome === "operator_confirmed_cancelled" &&
      result.external_payment_link === expectedPaymentLink &&
      result.confirmation_note === expectedConfirmationNote &&
      confirmedBy === expectedActorId && invoiceMatches
    ? result
    : null;
}

function confirmedNoProvider(value: unknown): Record<string, unknown> | null {
  const result = asObject(value);
  return result?.provider === "none" && result.outcome === "not_required"
    ? result
    : null;
}

function confirmedCompletion(
  value: unknown,
  renewalId: string,
  resolution: RenewalResolution,
  reasonCode: RenewalReasonCode,
): Record<string, unknown> | null {
  const result = asObject(value);
  return result?.status === "completed" && result.renewal_id === renewalId &&
      result.resolution === resolution && result.reason_code === reasonCode &&
      result.renewal_status === "voided" &&
      result.renewal_payment_status === "cancelled"
    ? result
    : null;
}

function invalidPersistedResult(operationId: string): Response {
  console.error("api-v1 renewal invalid persisted external result", {
    operation_id: operationId,
  });
  return reconciliationResponse(
    "O resultado externo registrado precisa de conferência manual",
    operationId,
  );
}

async function reconcileInvalidPersistedResult(
  supabase: SupabaseClient,
  operationId: string,
  leaseToken: string,
  value: unknown,
): Promise<Response> {
  const persisted = asObject(value);
  if (!persisted) return invalidPersistedResult(operationId);

  const { data, error } = await supabase.rpc(
    "complete_assessment_renewal_resolution",
    {
      p_operation_id: operationId,
      p_lease_token: leaseToken,
      p_external_result: persisted,
    },
  );
  if (error) {
    console.error("api-v1 renewal reconcile invalid external result:", error);
    return invalidPersistedResult(operationId);
  }
  if (data?.status !== "reconciliation_required") {
    console.error("api-v1 renewal invalid result was not fail-closed", {
      operation_id: operationId,
      status: data?.status,
    });
    return jsonResponse({
      error: "A reconciliação da renovação retornou um resultado inválido",
      code: "database_result_invalid",
    }, 500);
  }
  return reconciliationResponse(
    data.error ||
      "O resultado externo registrado precisa de conferência manual",
    operationId,
  );
}

async function recordExternalResult(
  supabase: SupabaseClient,
  operationId: string,
  leaseToken: string,
  externalResult: Record<string, unknown>,
): Promise<Record<string, unknown> | Response> {
  const { data, error } = await supabase.rpc(
    "record_assessment_renewal_external_result",
    {
      p_operation_id: operationId,
      p_lease_token: leaseToken,
      p_external_result: externalResult,
    },
  );
  if (error) {
    console.error("api-v1 renewal record external result:", error);
    return reconciliationResponse(
      "A ação externa foi confirmada, mas seu resultado precisa de reconciliação",
      operationId,
    );
  }

  const persisted = asObject(data)?.external_result;
  return asObject(persisted) || invalidPersistedResult(operationId);
}

async function loadAndCancelAsaasCharge(
  supabase: SupabaseClient,
  renewalId: string,
  chargeId: string,
  operationId: string,
  leaseToken: string,
  providerSnapshot: AsaasCancellationSnapshot | null,
): Promise<Record<string, unknown> | Response> {
  const { data: cachedPayments, error } = await supabase
    .from("asaas_payments")
    .select("asaas_payment_id, installment_group_id, total_installments")
    .eq("order_id", renewalId)
    .eq("order_type", "contract")
    .eq("source", "asaas");
  if (error) {
    return databaseError(error, "load Asaas cancellation", operationId);
  }

  const cachedPrimary = cachedPayments?.find((payment) =>
    payment.asaas_payment_id === chargeId
  );
  const cachedInstallmentId = stringValue(cachedPrimary?.installment_group_id);
  const cachedInstallments = Number(cachedPrimary?.total_installments);
  const snapshotInstallmentId = providerSnapshot?.kind === "installment"
    ? providerSnapshot.installment_id || ""
    : "";
  if (
    (providerSnapshot?.kind === "standalone" && cachedInstallmentId) ||
    (snapshotInstallmentId && cachedInstallmentId &&
      snapshotInstallmentId !== cachedInstallmentId)
  ) {
    throw new AsaasApiError(
      "A conferência da cobrança diverge do grupo salvo no EON",
      409,
      "renewal_provider_snapshot_mismatch",
    );
  }
  const installmentId = snapshotInstallmentId || cachedInstallmentId;
  const knownStandalone = providerSnapshot?.kind === "standalone" || Boolean(
    cachedPrimary && !cachedInstallmentId &&
      Number.isInteger(cachedInstallments) && cachedInstallments === 1,
  );
  const knownPaymentIds = (cachedPayments || [])
    .filter((payment) =>
      payment.asaas_payment_id === chargeId ||
      (cachedInstallmentId &&
        payment.installment_group_id === cachedInstallmentId)
    )
    .map((payment) => payment.asaas_payment_id)
    .filter((paymentId): paymentId is string =>
      typeof paymentId === "string" && paymentId.length > 0
    );

  return await cancelExternalCharge(
    chargeId,
    installmentId,
    knownStandalone,
    knownPaymentIds,
    async (snapshot) => {
      const { data: snapshotData, error: snapshotError } = await supabase.rpc(
        "record_assessment_renewal_provider_snapshot",
        {
          p_operation_id: operationId,
          p_lease_token: leaseToken,
          p_provider_snapshot: snapshot,
        },
      );
      if (snapshotError) {
        console.error(
          "api-v1 renewal record provider snapshot:",
          snapshotError,
        );
        throw new AsaasApiError(
          "Não foi possível registrar a conferência da cobrança antes do cancelamento",
          502,
          "renewal_provider_snapshot_unavailable",
        );
      }
      if (
        !confirmedProviderSnapshot(
          asObject(snapshotData)?.provider_snapshot,
          chargeId,
        )
      ) {
        throw new AsaasApiError(
          "A conferência persistida da cobrança é inválida",
          409,
          "renewal_provider_snapshot_invalid",
        );
      }
    },
  );
}

export async function handleRenewalRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  const match = path.match(RENEWAL_RESOLUTION_PATH);
  if (!match) return null;
  if (req.method !== "POST") {
    return jsonResponse({
      error: "Método não permitido",
      code: "method_not_allowed",
    }, 405);
  }

  const renewalId = match[1];
  if (!UUID_PATTERN.test(renewalId)) {
    return jsonResponse({
      error: "Identificador de renovação inválido",
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

  const body = parseResolutionBody(await parseObject(req));
  if (!body) {
    return jsonResponse({
      error: "Dados da resolução da renovação são inválidos",
      code: "invalid_request",
    }, 400);
  }

  const { data, error } = await supabase.rpc(
    "prepare_assessment_renewal_resolution",
    {
      p_renewal_id: renewalId,
      p_resolution: body.resolution,
      p_reason_code: body.reason_code,
      p_reason: body.reason,
      p_expected_updated_at: body.expected_updated_at,
      p_expected_payment_status: body.expected_payment_status,
      p_expected_charge_id: body.expected_charge_id,
      p_external_cancellation_confirmed: body.external_cancellation_confirmed,
      p_external_confirmation_note: body.external_confirmation_note,
      p_service_started: body.service_started,
      p_idempotency_key: idempotencyKey,
      p_actor_id: actorId,
    },
  );
  if (error) return databaseError(error, "prepare");

  const prepared = data as PreparedRenewalResolution;
  if (!prepared || !UUID_PATTERN.test(stringValue(prepared.operation_id))) {
    return jsonResponse({
      error: "A preparação da renovação retornou um resultado inválido",
      code: "database_result_invalid",
    }, 500);
  }
  if (prepared.status === "reconciliation_required") {
    return reconciliationResponse(
      prepared.error || "Esta renovação precisa de conferência manual",
      prepared.operation_id,
    );
  }
  if (prepared.status !== "prepared" && prepared.status !== "completed") {
    return jsonResponse({
      error: "A preparação da renovação retornou um estado inválido",
      code: "database_result_invalid",
    }, 500);
  }
  const preparedChargeId = stringValue(prepared.asaas_charge_id) || null;
  if (
    prepared.renewal_id !== renewalId ||
    prepared.resolution !== body.resolution ||
    prepared.reason_code !== body.reason_code ||
    preparedChargeId !== body.expected_charge_id
  ) {
    return reconciliationResponse(
      "A operação preparada diverge da renovação solicitada",
      prepared.operation_id,
    );
  }
  if (prepared.status === "completed") {
    const result = confirmedCompletion(
      prepared.result,
      renewalId,
      body.resolution,
      body.reason_code,
    );
    if (!result) {
      return jsonResponse({
        error: "O resultado concluído da renovação é inválido",
        code: "database_result_invalid",
      }, 500);
    }
    return jsonResponse({ data: result });
  }

  const { data: claimData, error: claimError } = await supabase.rpc(
    "claim_assessment_renewal_resolution",
    {
      p_operation_id: prepared.operation_id,
    },
  );
  if (claimError) {
    return databaseError(
      claimError,
      "claim external operation",
      prepared.operation_id,
    );
  }

  const claimed = claimData as ExternalOperationClaim;
  if (claimed?.status === "completed") {
    const result = confirmedCompletion(
      claimed.result,
      renewalId,
      body.resolution,
      body.reason_code,
    );
    if (!result) {
      return jsonResponse({
        error: "O resultado concluído da renovação é inválido",
        code: "database_result_invalid",
      }, 500);
    }
    return jsonResponse({ data: result });
  }
  if (claimed?.status === "reconciliation_required") {
    return reconciliationResponse(
      claimed.error || "Esta renovação precisa de conferência manual",
      prepared.operation_id,
    );
  }
  if (
    claimed?.status !== "prepared" || !claimed.lease_acquired ||
    !UUID_PATTERN.test(stringValue(claimed.lease_token))
  ) {
    return jsonResponse({
      error: "A resolução desta renovação já está em processamento",
      code: "operation_in_progress",
      details: {
        operation_id: prepared.operation_id,
        retry_after: claimed?.lease_expires_at,
      },
    }, 409);
  }

  const leaseToken = claimed.lease_token!;
  const asaasChargeId = stringValue(prepared.asaas_charge_id);
  const externalPaymentLink = stringValue(prepared.external_payment_link);
  const externalInvoiceNumber = stringValue(
    prepared.external_invoice_number,
  ) || null;
  const externalCancellationConfirmed =
    prepared.external_cancellation_confirmed === true;
  const externalConfirmationNote = stringValue(
    prepared.external_confirmation_note,
  ) || null;
  const hasExternalCharge = Boolean(
    externalPaymentLink || externalInvoiceNumber,
  );
  if (
    hasExternalCharge &&
    (!externalCancellationConfirmed || !externalConfirmationNote)
  ) {
    return reconciliationResponse(
      "A confirmação persistida da cobrança externa está incompleta",
      prepared.operation_id,
    );
  }
  if (
    !hasExternalCharge &&
    (externalCancellationConfirmed || externalConfirmationNote)
  ) {
    return reconciliationResponse(
      "A operação possui uma confirmação externa sem cobrança correspondente",
      prepared.operation_id,
    );
  }
  const recordedResult = claimed.external_result ?? prepared.external_result;
  const storedProviderSnapshot = claimed.provider_snapshot ??
    prepared.provider_snapshot;
  const providerSnapshot = asaasChargeId && storedProviderSnapshot != null
    ? confirmedProviderSnapshot(storedProviderSnapshot, asaasChargeId)
    : null;
  if (
    (asaasChargeId && storedProviderSnapshot != null && !providerSnapshot) ||
    (!asaasChargeId && storedProviderSnapshot != null)
  ) {
    return reconciliationResponse(
      "A conferência persistida da cobrança Asaas é inválida",
      prepared.operation_id,
    );
  }

  let externalResult: Record<string, unknown> | null = null;
  if (recordedResult !== null && recordedResult !== undefined) {
    externalResult = asaasChargeId
      ? confirmedAsaasCancellation(recordedResult, asaasChargeId)
      : hasExternalCharge
      ? confirmedExternalAttestation(
        recordedResult,
        externalPaymentLink,
        externalInvoiceNumber,
        externalConfirmationNote || "",
        actorId,
      )
      : confirmedNoProvider(recordedResult);
    if (!externalResult) {
      return await reconcileInvalidPersistedResult(
        supabase,
        prepared.operation_id,
        leaseToken,
        recordedResult,
      );
    }
  } else if (asaasChargeId) {
    try {
      const cancelled = await loadAndCancelAsaasCharge(
        supabase,
        renewalId,
        asaasChargeId,
        prepared.operation_id,
        leaseToken,
        providerSnapshot,
      );
      if (cancelled instanceof Response) return cancelled;
      externalResult = cancelled;
    } catch (externalFailure) {
      return externalError(externalFailure, prepared.operation_id);
    }
  } else if (hasExternalCharge) {
    if (!externalCancellationConfirmed || !externalConfirmationNote) {
      return jsonResponse({
        error: "Confirme o cancelamento da cobrança externa antes de continuar",
        code: "external_cancellation_required",
        details: { operation_id: prepared.operation_id },
      }, 409);
    }
    externalResult = {
      provider: "external",
      outcome: "operator_confirmed_cancelled",
      confirmed_by: actorId,
      confirmation_note: externalConfirmationNote,
      external_payment_link: externalPaymentLink,
      external_invoice_number: externalInvoiceNumber,
    };
  } else {
    externalResult = { provider: "none", outcome: "not_required" };
  }

  if (!recordedResult) {
    const persisted = await recordExternalResult(
      supabase,
      prepared.operation_id,
      leaseToken,
      externalResult,
    );
    if (persisted instanceof Response) return persisted;
    externalResult = asaasChargeId
      ? confirmedAsaasCancellation(persisted, asaasChargeId)
      : hasExternalCharge
      ? confirmedExternalAttestation(
        persisted,
        externalPaymentLink,
        externalInvoiceNumber,
        externalConfirmationNote || "",
        actorId,
      )
      : confirmedNoProvider(persisted);
    if (!externalResult) {
      return await reconcileInvalidPersistedResult(
        supabase,
        prepared.operation_id,
        leaseToken,
        persisted,
      );
    }
  }

  const { data: completed, error: completeError } = await supabase.rpc(
    "complete_assessment_renewal_resolution",
    {
      p_operation_id: prepared.operation_id,
      p_lease_token: leaseToken,
      p_external_result: externalResult,
    },
  );
  if (completeError) {
    return databaseError(completeError, "complete", prepared.operation_id);
  }
  if (completed?.status === "reconciliation_required") {
    return reconciliationResponse(
      completed.error ||
        "A renovação mudou durante a resolução e precisa de conferência manual",
      prepared.operation_id,
    );
  }
  const completion = confirmedCompletion(
    completed,
    renewalId,
    body.resolution,
    body.reason_code,
  );
  if (!completion) {
    return jsonResponse({
      error: "A conclusão da renovação retornou um resultado inválido",
      code: "database_result_invalid",
    }, 500);
  }

  return jsonResponse({ data: completion });
}
