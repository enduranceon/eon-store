import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import {
  AsaasApiError,
  type AsaasPaymentInput,
  createAsaasCustomer,
  createAsaasPayment,
  findAsaasCustomersByCpf,
  findAsaasCustomersByExternalReference,
  findAsaasPaymentsByExternalReference,
  getAsaasCustomer,
  getAsaasInstallmentPayments,
  getAsaasPixQrCode,
} from "../_shared/asaas.ts";
import { jsonResponse } from "../_shared/http.ts";
import { isValidIsoDate } from "./payments.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const CHARGE_PATH = /^\/orders\/(presale|stock|contract)\/([^/]+)\/charge$/;
const BILLING_TYPES = new Set(["PIX", "BOLETO", "CREDIT_CARD"]);
const CONTRACT_SOURCES = new Set(["contract_detail", "renewals_page"]);
const RECOVERABLE_PAYMENT_STATUSES = new Set([
  "PENDING",
  "OVERDUE",
  "RECEIVED",
  "CONFIRMED",
  "RECEIVED_IN_CASH",
]);
const AMBIGUOUS_CREATION_CODES = new Set([
  "asaas_customer_create_unavailable",
  "asaas_customer_create_unconfirmed",
  "asaas_customer_lookup_unavailable",
  "asaas_customer_lookup_failed",
  "asaas_customer_search_unavailable",
  "asaas_customer_search_failed",
  "asaas_customer_search_invalid",
  "asaas_customer_search_incomplete",
  "asaas_customer_mismatch",
  "asaas_duplicate_customers",
  "asaas_payment_create_unavailable",
  "asaas_payment_create_unconfirmed",
  "asaas_payment_search_unavailable",
  "asaas_payment_search_failed",
  "asaas_payment_search_invalid",
  "asaas_payment_search_incomplete",
  "asaas_installment_search_unavailable",
  "asaas_installment_search_failed",
  "asaas_installment_search_invalid",
  "asaas_installment_search_incomplete",
  "asaas_duplicate_payments",
  "asaas_recovered_payment_mismatch",
]);

type ContractSource = "contract_detail" | "renewals_page";
type ChargeSource = "order_detail" | ContractSource;

interface PreparedChargeCreation {
  operation_id: string;
  status: "prepared" | "completed" | "reconciliation_required" | "failed";
  lease_acquired?: boolean;
  lease_token?: string | null;
  lease_expires_at?: string | null;
  billing_type: "PIX" | "BOLETO" | "CREDIT_CARD";
  due_date: string;
  installments: number;
  total_value: number;
  customer_cpf: string;
  customer_name: string;
  customer_email?: string | null;
  customer_phone?: string | null;
  asaas_customer_id?: string | null;
  customer_external_reference: string;
  payment_external_reference: string;
  description: string;
  source: ChargeSource;
  result?: Record<string, unknown> | null;
  error_code?: string | null;
  error?: string | null;
}

interface ExternalContext extends Record<string, unknown> {
  provider: "asaas";
  outcome: string;
  external_reference: string;
  customer_id?: string;
  source: ChargeSource;
}

interface NormalizedPayment {
  payment_id: string;
  customer_id: string;
  billing_type: "PIX" | "BOLETO" | "CREDIT_CARD";
  status: string;
  value: number;
  net_value: number | null;
  due_date: string;
  payment_date: string | null;
  credit_date: string | null;
  description: string | null;
  external_reference: string;
  installment_group_id: string | null;
  installment_number: number | null;
  payment_link: string | null;
}

interface ValidatedPaymentSet {
  primary: NormalizedPayment;
  payments: NormalizedPayment[];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numericValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function centsValue(value: unknown): number | null {
  const number = numericValue(value);
  if (number === null || number <= 0) return null;
  const cents = Math.round(number * 100);
  if (
    !Number.isSafeInteger(cents) ||
    Math.abs(number * 100 - cents) > 0.000001
  ) {
    return null;
  }
  return cents;
}

function canonicalDocument(value: unknown): string {
  return stringValue(value).replace(/\D/g, "");
}

function creationIsAmbiguous(error: AsaasApiError): boolean {
  return AMBIGUOUS_CREATION_CODES.has(error.code) ||
    (error.code.endsWith("_create_failed") && error.status >= 500);
}

function customerMismatch(message: string): never {
  throw new AsaasApiError(message, 409, "asaas_customer_mismatch");
}

function selectCustomerId(
  customers: Array<Record<string, unknown>>,
  prepared: PreparedChargeCreation,
  requireExternalReference: boolean,
): string | null {
  if (customers.length === 0) return null;

  const candidates = customers.map((customer) => {
    const id = stringValue(customer.id);
    if (
      !id || customer.deleted === true ||
      canonicalDocument(customer.cpfCnpj) !== prepared.customer_cpf
    ) {
      customerMismatch(
        "O cliente localizado no Asaas diverge dos dados desta operação",
      );
    }
    if (
      requireExternalReference &&
      stringValue(customer.externalReference) !==
        prepared.customer_external_reference
    ) {
      customerMismatch(
        "A referência do cliente no Asaas diverge desta operação",
      );
    }
    return { id, externalReference: stringValue(customer.externalReference) };
  });

  const referenced = candidates.filter((customer) =>
    customer.externalReference === prepared.customer_external_reference
  );
  if (referenced.length > 1) {
    throw new AsaasApiError(
      "Mais de um cliente foi encontrado para a mesma referência",
      409,
      "asaas_duplicate_customers",
    );
  }
  if (referenced.length === 1) return referenced[0].id;
  if (requireExternalReference) {
    customerMismatch(
      "O cliente localizado no Asaas não corresponde à referência esperada",
    );
  }
  if (candidates.length > 1) {
    throw new AsaasApiError(
      "Mais de um cliente foi encontrado para o mesmo CPF",
      409,
      "asaas_duplicate_customers",
    );
  }
  return candidates[0].id;
}

async function findPreparedCustomer(
  prepared: PreparedChargeCreation,
): Promise<string | null> {
  const byReference = await findAsaasCustomersByExternalReference(
    prepared.customer_external_reference,
    prepared.customer_cpf,
  );
  const referencedId = selectCustomerId(byReference, prepared, true);
  if (referencedId) return referencedId;

  const byCpf = await findAsaasCustomersByCpf(prepared.customer_cpf);
  return selectCustomerId(byCpf, prepared, false);
}

async function resolveCustomer(
  prepared: PreparedChargeCreation,
  context: ExternalContext,
): Promise<string> {
  if (prepared.asaas_customer_id) {
    const saved = await getAsaasCustomer(prepared.asaas_customer_id);
    const savedId = stringValue(saved.id);
    const savedMatches = savedId === prepared.asaas_customer_id &&
      canonicalDocument(saved.cpfCnpj) === prepared.customer_cpf &&
      saved.deleted !== true;
    if (!savedMatches) {
      context.outcome = "customer_saved_ignored";
      prepared.asaas_customer_id = null;
    } else {
      context.outcome = "customer_revalidated";
      context.customer_id = savedId;
      return savedId;
    }
  }

  const existingId = await findPreparedCustomer(prepared);
  if (existingId) {
    context.outcome = "customer_reused";
    context.customer_id = existingId;
    return existingId;
  }

  try {
    const created = await createAsaasCustomer({
      name: prepared.customer_name,
      cpfCnpj: prepared.customer_cpf,
      ...(prepared.customer_email ? { email: prepared.customer_email } : {}),
      ...(prepared.customer_phone ? { phone: prepared.customer_phone } : {}),
      externalReference: prepared.customer_external_reference,
    });
    const createdId = selectCustomerId([created], prepared, true);
    if (!createdId) {
      customerMismatch("O Asaas não confirmou o cliente criado");
    }
    context.outcome = "customer_created";
    context.customer_id = createdId;
    return createdId;
  } catch (error) {
    if (!(error instanceof AsaasApiError) || !creationIsAmbiguous(error)) {
      throw error;
    }

    try {
      const recoveredId = await findPreparedCustomer(prepared);
      if (recoveredId) {
        context.outcome = "customer_recovered";
        context.customer_id = recoveredId;
        return recoveredId;
      }
    } catch (lookupError) {
      console.error(
        "api-v1 charge customer recovery failed:",
        lookupError instanceof Error ? lookupError.message : lookupError,
      );
      if (
        lookupError instanceof AsaasApiError &&
        creationIsAmbiguous(lookupError)
      ) {
        throw lookupError;
      }
    }
    throw error;
  }
}

function recoveredPaymentMismatch(message: string): never {
  throw new AsaasApiError(
    message,
    409,
    "asaas_recovered_payment_mismatch",
  );
}

function normalizePayment(
  payment: Record<string, unknown>,
  prepared: PreparedChargeCreation,
  expectedInstallmentGroup: string | null,
): NormalizedPayment {
  const paymentId = stringValue(payment.id);
  const customerId = stringValue(payment.customer);
  const billingType = stringValue(payment.billingType);
  const status = stringValue(payment.status);
  const dueDate = stringValue(payment.dueDate);
  const paymentDate = stringValue(payment.paymentDate) || null;
  const creditDate = stringValue(payment.creditDate) || null;
  const externalReference = stringValue(payment.externalReference);
  const installmentGroupId = stringValue(payment.installment) || null;
  const installmentNumberValue = numericValue(payment.installmentNumber);
  const installmentNumber = installmentNumberValue === null
    ? null
    : installmentNumberValue;
  const value = numericValue(payment.value);

  if (
    !paymentId || customerId !== prepared.asaas_customer_id ||
    billingType !== prepared.billing_type ||
    !RECOVERABLE_PAYMENT_STATUSES.has(status) ||
    !isValidIsoDate(dueDate) ||
    (paymentDate !== null && !isValidIsoDate(paymentDate)) ||
    (creditDate !== null && !isValidIsoDate(creditDate)) ||
    externalReference !== prepared.payment_external_reference ||
    installmentGroupId !== expectedInstallmentGroup ||
    centsValue(value) === null ||
    (installmentNumber !== null && !Number.isInteger(installmentNumber)) ||
    (expectedInstallmentGroup === null && installmentNumber !== null) ||
    (expectedInstallmentGroup !== null && installmentNumber === null)
  ) {
    recoveredPaymentMismatch(
      "A cobrança localizada no Asaas diverge dos dados desta operação",
    );
  }

  return {
    payment_id: paymentId,
    customer_id: customerId,
    billing_type: billingType as NormalizedPayment["billing_type"],
    status,
    value: value as number,
    net_value: numericValue(payment.netValue),
    due_date: dueDate,
    payment_date: paymentDate,
    credit_date: creditDate,
    description: stringValue(payment.description) || null,
    external_reference: externalReference,
    installment_group_id: installmentGroupId,
    installment_number: installmentNumber,
    payment_link: stringValue(payment.invoiceUrl) ||
      stringValue(payment.bankSlipUrl) || null,
  };
}

async function recoveredPayments(
  payments: Array<Record<string, unknown>>,
  prepared: PreparedChargeCreation,
): Promise<ValidatedPaymentSet | null> {
  if (payments.length === 0) return null;

  if (
    payments.some((payment) =>
      stringValue(payment.externalReference) !==
        prepared.payment_external_reference
    )
  ) {
    recoveredPaymentMismatch(
      "O resultado da busca no Asaas não corresponde à operação",
    );
  }

  if (prepared.installments === 1) {
    if (payments.length !== 1) {
      throw new AsaasApiError(
        "Mais de uma cobrança foi encontrada para a mesma operação",
        409,
        "asaas_duplicate_payments",
      );
    }
    const normalized = normalizePayment(payments[0], prepared, null);
    if (
      normalized.due_date !== prepared.due_date ||
      centsValue(normalized.value) !== centsValue(prepared.total_value)
    ) {
      recoveredPaymentMismatch(
        "A cobrança localizada no Asaas diverge do valor ou vencimento esperado",
      );
    }
    return { primary: normalized, payments: [normalized] };
  }

  const groupIds = payments.map((payment) => stringValue(payment.installment));
  if (groupIds.some((groupId) => !groupId)) {
    recoveredPaymentMismatch(
      "O Asaas não confirmou o grupo do parcelamento",
    );
  }
  const groups = new Set(groupIds);
  if (groups.size !== 1) {
    throw new AsaasApiError(
      "Mais de um parcelamento foi encontrado para a mesma operação",
      409,
      "asaas_duplicate_payments",
    );
  }
  const groupId = groupIds[0];
  const installmentPayments = await getAsaasInstallmentPayments(groupId);
  if (installmentPayments.length !== prepared.installments) {
    recoveredPaymentMismatch(
      "A quantidade de parcelas no Asaas diverge desta operação",
    );
  }

  const normalized = installmentPayments.map((payment) =>
    normalizePayment(payment, prepared, groupId)
  ).sort((left, right) =>
    (left.installment_number as number) -
    (right.installment_number as number)
  );
  const paymentIds = new Set(normalized.map((payment) => payment.payment_id));
  const installmentNumbers = new Set(
    normalized.map((payment) => payment.installment_number),
  );
  if (
    paymentIds.size !== prepared.installments ||
    installmentNumbers.size !== prepared.installments ||
    normalized.some((payment, index) =>
      payment.installment_number !== index + 1
    ) ||
    normalized[0].due_date !== prepared.due_date
  ) {
    recoveredPaymentMismatch(
      "A sequência do parcelamento no Asaas diverge desta operação",
    );
  }

  const totalCents = normalized.reduce(
    (total, payment) => total + (centsValue(payment.value) as number),
    0,
  );
  if (totalCents !== centsValue(prepared.total_value)) {
    recoveredPaymentMismatch(
      "A soma das parcelas no Asaas diverge do total desta operação",
    );
  }
  return { primary: normalized[0], payments: normalized };
}

function paymentResult(
  paymentSet: ValidatedPaymentSet,
  prepared: PreparedChargeCreation,
  outcome: "created" | "recovered",
  pix: Record<string, unknown> | null,
): Record<string, unknown> {
  const payment = paymentSet.primary;

  return {
    provider: "asaas",
    outcome,
    source: prepared.source,
    payment_id: payment.payment_id,
    customer_id: payment.customer_id,
    billing_type: payment.billing_type,
    status_after: payment.status,
    payment_value: payment.value,
    requested_total_value: prepared.total_value,
    net_value: payment.net_value,
    due_date: payment.due_date,
    description: payment.description,
    external_reference: payment.external_reference,
    installment_group_id: payment.installment_group_id,
    installment_number: payment.installment_number,
    total_installments: prepared.installments,
    payment_link: payment.payment_link,
    pix_qrcode: pix ? stringValue(pix.encodedImage) || null : null,
    pix_copy: pix ? stringValue(pix.payload) || null : null,
    payments: paymentSet.payments,
  };
}

export async function executeAsaasChargeCreation(
  prepared: PreparedChargeCreation,
  context: ExternalContext = {
    provider: "asaas",
    outcome: "started",
    external_reference: prepared.payment_external_reference,
    source: prepared.source,
  },
): Promise<Record<string, unknown>> {
  const customerId = await resolveCustomer(prepared, context);
  prepared.asaas_customer_id = customerId;

  const found = await findAsaasPaymentsByExternalReference(
    prepared.payment_external_reference,
  );
  let paymentSet = await recoveredPayments(found, prepared);
  let outcome: "created" | "recovered" = "recovered";

  if (!paymentSet) {
    const request: AsaasPaymentInput = {
      customer: customerId,
      billingType: prepared.billing_type,
      dueDate: prepared.due_date,
      description: prepared.description,
      externalReference: prepared.payment_external_reference,
      ...(prepared.installments > 1
        ? {
          installmentCount: prepared.installments,
          totalValue: prepared.total_value,
        }
        : { value: prepared.total_value }),
    };

    try {
      const created = await createAsaasPayment(request);
      paymentSet = await recoveredPayments([created], prepared);
      outcome = "created";
    } catch (error) {
      if (!(error instanceof AsaasApiError) || !creationIsAmbiguous(error)) {
        throw error;
      }

      try {
        const recovered = await findAsaasPaymentsByExternalReference(
          prepared.payment_external_reference,
        );
        paymentSet = await recoveredPayments(recovered, prepared);
      } catch (lookupError) {
        console.error(
          "api-v1 charge payment recovery failed:",
          lookupError instanceof Error ? lookupError.message : lookupError,
        );
        if (
          lookupError instanceof AsaasApiError &&
          AMBIGUOUS_CREATION_CODES.has(lookupError.code)
        ) {
          throw lookupError;
        }
      }
      if (!paymentSet) throw error;
      outcome = "recovered";
    }
  }

  if (!paymentSet) {
    throw new AsaasApiError(
      "O Asaas não confirmou a criação da cobrança",
      502,
      "asaas_payment_create_unconfirmed",
    );
  }

  let pix: Record<string, unknown> | null = null;
  if (prepared.billing_type === "PIX") {
    try {
      pix = await getAsaasPixQrCode(paymentSet.primary.payment_id);
    } catch (error) {
      // The invoice link remains usable. A Pix lookup failure must not orphan
      // a charge that the provider already confirmed.
      console.warn(
        "api-v1 charge Pix lookup failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  context.outcome = outcome;
  context.customer_id = customerId;
  return paymentResult(paymentSet, prepared, outcome, pix);
}

function databaseError(
  error: { code?: string; message?: string },
  operation: string,
): Response {
  console.error(`api-v1 charge ${operation}:`, error);
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
    error: "Não foi possível criar a cobrança",
    code: "database_error",
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

async function finalizeFailure(
  supabase: SupabaseClient,
  prepared: PreparedChargeCreation,
  error: AsaasApiError,
  requiresReconciliation: boolean,
  context: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const { data, error: finalizeError } = await supabase.rpc(
    "finalize_order_charge_creation_failure",
    {
      p_operation_id: prepared.operation_id,
      p_lease_token: prepared.lease_token,
      p_error_code: error.code,
      p_error_message: error.message.slice(0, 500),
      p_requires_reconciliation: requiresReconciliation,
      p_external_result: context,
    },
  );
  if (finalizeError) {
    console.error("api-v1 charge finalize failure:", finalizeError);
    return null;
  }
  return data as Record<string, unknown>;
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

export async function handleChargeRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  const match = path.match(CHARGE_PATH);
  if (!match) return null;
  if (req.method !== "POST") {
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
  const allowedKeys = orderType === "contract"
    ? new Set(["billing_type", "due_date", "source"])
    : new Set(["billing_type", "due_date", "installments", "cpf"]);
  if (!body || Object.keys(body).some((key) => !allowedKeys.has(key))) {
    return jsonResponse({
      error: "Dados da cobrança inválidos",
      code: "invalid_request",
    }, 400);
  }

  const billingType = stringValue(body.billing_type).toUpperCase();
  const dueDate = stringValue(body.due_date);
  const installments = body.installments === undefined
    ? 1
    : Number(body.installments);
  const cpf = stringValue(body.cpf).replace(/\D/g, "");
  const sourceValue = stringValue(body.source);
  const source = orderType === "contract"
    ? sourceValue as ContractSource
    : null;
  if (
    !BILLING_TYPES.has(billingType) || !isValidIsoDate(dueDate) ||
    !Number.isInteger(installments) || installments < 1 || installments > 12 ||
    (billingType !== "CREDIT_CARD" && installments !== 1) ||
    (orderType !== "contract" && cpf.length !== 11) ||
    (orderType === "contract" && !CONTRACT_SOURCES.has(sourceValue))
  ) {
    return jsonResponse({
      error: "Dados da cobrança inválidos",
      code: "invalid_request",
    }, 400);
  }

  const { data, error } = await supabase.rpc("prepare_order_charge_creation", {
    p_order_type: orderType,
    p_order_id: orderId,
    p_billing_type: billingType,
    p_due_date: dueDate,
    p_installments: installments,
    p_customer_cpf: orderType === "contract" ? null : cpf,
    p_idempotency_key: idempotencyKey,
    p_actor_id: actorId,
    p_source: source,
  });
  if (error) return databaseError(error, "prepare");

  const prepared = data as PreparedChargeCreation;
  if (
    (orderType === "contract" && prepared.source !== source) ||
    (orderType !== "contract" && prepared.source !== "order_detail")
  ) {
    console.error("api-v1 charge prepare source mismatch", {
      operation_id: prepared.operation_id,
    });
    return jsonResponse({
      error: "Não foi possível confirmar a origem da cobrança",
      code: "database_result_invalid",
    }, 500);
  }
  if (prepared.status === "completed") {
    return jsonResponse({ data: prepared.result });
  }
  if (prepared.status === "reconciliation_required") {
    return reconciliationResponse(
      prepared.error || "Esta criação precisa de conferência manual",
      prepared.operation_id,
    );
  }
  if (prepared.status === "failed") {
    return jsonResponse({
      error: prepared.error || "A cobrança não pôde ser criada",
      code: prepared.error_code || "operation_failed",
      details: { operation_id: prepared.operation_id },
    }, 409);
  }
  if (!prepared.lease_acquired || !prepared.lease_token) {
    return jsonResponse({
      error: "A criação da cobrança já está em processamento",
      code: "operation_in_progress",
      details: {
        operation_id: prepared.operation_id,
        retry_after: prepared.lease_expires_at,
      },
    }, 409);
  }

  const context: ExternalContext = {
    provider: "asaas",
    outcome: "started",
    external_reference: prepared.payment_external_reference,
    source: prepared.source,
  };
  let externalResult: Record<string, unknown>;
  try {
    externalResult = await executeAsaasChargeCreation(prepared, context);
  } catch (externalFailure) {
    const error = externalFailure instanceof AsaasApiError
      ? externalFailure
      : new AsaasApiError(
        "Não foi possível confirmar a criação da cobrança no Asaas",
        502,
        "asaas_charge_external_error",
      );
    const requiresReconciliation = creationIsAmbiguous(error);
    const finalized = await finalizeFailure(
      supabase,
      prepared,
      error,
      requiresReconciliation,
      context,
    );
    if (finalized?.status === "completed") {
      return jsonResponse({ data: finalized.result });
    }
    if (finalized?.status === "reconciliation_required") {
      return reconciliationResponse(error.message, prepared.operation_id);
    }
    return jsonResponse({
      error: error.message,
      code: error.code,
      details: { operation_id: prepared.operation_id },
    }, error.status);
  }

  const { data: completed, error: completeError } = await supabase.rpc(
    "complete_order_charge_creation",
    {
      p_operation_id: prepared.operation_id,
      p_lease_token: prepared.lease_token,
      p_external_result: externalResult,
    },
  );
  if (completeError) {
    console.error(
      "api-v1 charge complete after Asaas creation:",
      completeError,
    );
    const persisted = await finalizeFailure(
      supabase,
      prepared,
      new AsaasApiError(
        "O Asaas criou a cobrança, mas a venda precisa de reconciliação",
        409,
        "database_complete_failed",
      ),
      true,
      {
        ...context,
        ...externalResult,
        outcome: "provider_confirmed_database_failed",
      },
    );
    if (persisted?.status === "completed") {
      return jsonResponse({ data: persisted.result });
    }
    return reconciliationResponse(
      "O Asaas criou a cobrança, mas a venda precisa de reconciliação",
      prepared.operation_id,
    );
  }
  if (completed?.status === "reconciliation_required") {
    return reconciliationResponse(
      completed.error || "A venda mudou e precisa de conferência manual",
      prepared.operation_id,
    );
  }

  return jsonResponse({ data: completed }, 201);
}
