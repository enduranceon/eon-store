const REQUEST_TIMEOUT_MS = 12_000;

type AsaasPayload = Record<string, unknown>;

export interface AsaasCustomerInput {
  name: string;
  cpfCnpj: string;
  email?: string;
  phone?: string;
  externalReference?: string;
}

export interface AsaasPaymentInput {
  customer: string;
  billingType: "PIX" | "BOLETO" | "CREDIT_CARD";
  value?: number;
  dueDate: string;
  description: string;
  externalReference: string;
  installmentCount?: number;
  totalValue?: number;
}

export class AsaasApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code = "asaas_error") {
    super(message);
    this.name = "AsaasApiError";
    this.status = status;
    this.code = code;
  }
}

function config(): { baseUrl: string; apiKey: string } {
  const baseUrl = Deno.env.get("ASAAS_BASE_URL")?.replace(/\/$/, "");
  const apiKey = Deno.env.get("ASAAS_API_KEY");

  if (!baseUrl || !apiKey) {
    throw new AsaasApiError(
      "Integração com o Asaas não configurada",
      500,
      "asaas_misconfigured",
    );
  }

  return { baseUrl, apiKey };
}

async function responsePayload(response: Response): Promise<AsaasPayload> {
  try {
    const value = await response.json();
    return value && typeof value === "object" ? value as AsaasPayload : {};
  } catch {
    return {};
  }
}

function errorMessage(payload: AsaasPayload, fallback: string): string {
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  const first = errors[0];
  if (first && typeof first === "object" && "description" in first) {
    const description = (first as { description?: unknown }).description;
    if (typeof description === "string" && description.trim()) {
      return description;
    }
  }
  return fallback;
}

async function asaasFetch(
  path: string,
  init: RequestInit = {},
  unavailableCode = "asaas_unavailable",
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const { baseUrl, apiKey } = config();

  try {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        access_token: apiKey,
        Accept: "application/json",
        "User-Agent": "EON-Store/1.0 (Supabase Edge Functions)",
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    console.error(
      "api-v1 Asaas request failed:",
      error instanceof Error ? error.message : error,
    );
    throw new AsaasApiError(
      "Não foi possível confirmar a cobrança no Asaas",
      502,
      unavailableCode,
    );
  }
}

export type AsaasPaymentLookup =
  | { found: false }
  | { found: true; status: string; payment: AsaasPayload };

export async function getAsaasPayment(
  chargeId: string,
): Promise<AsaasPaymentLookup> {
  const response = await asaasFetch(
    `/payments/${encodeURIComponent(chargeId)}`,
    {},
    "asaas_lookup_unavailable",
  );
  const payload = await responsePayload(response);

  if (response.status === 404) return { found: false };
  if (!response.ok) {
    throw new AsaasApiError(
      errorMessage(payload, "Não foi possível consultar a cobrança no Asaas"),
      response.status >= 500 ? 502 : 409,
      "asaas_lookup_failed",
    );
  }

  const status = typeof payload.status === "string"
    ? payload.status
    : "UNKNOWN";
  return { found: true, status, payment: payload };
}

function listData(payload: AsaasPayload, resource: string): AsaasPayload[] {
  if (!Array.isArray(payload.data)) {
    throw new AsaasApiError(
      `O Asaas retornou uma lista de ${resource} inválida`,
      502,
      `asaas_${resource}_search_invalid`,
    );
  }
  if (payload.hasMore === true) {
    throw new AsaasApiError(
      `O Asaas retornou uma lista de ${resource} incompleta`,
      502,
      `asaas_${resource}_search_incomplete`,
    );
  }
  if (
    payload.data.some((item) =>
      !item || typeof item !== "object" || Array.isArray(item)
    )
  ) {
    throw new AsaasApiError(
      `O Asaas retornou itens de ${resource} inválidos`,
      502,
      `asaas_${resource}_search_invalid`,
    );
  }
  return payload.data as AsaasPayload[];
}

export async function getAsaasCustomer(
  customerId: string,
): Promise<AsaasPayload> {
  const response = await asaasFetch(
    `/customers/${encodeURIComponent(customerId)}`,
    {},
    "asaas_customer_lookup_unavailable",
  );
  const payload = await responsePayload(response);
  if (response.status === 404) {
    return { id: customerId, deleted: true };
  }
  if (!response.ok) {
    throw new AsaasApiError(
      errorMessage(payload, "Não foi possível confirmar o cliente no Asaas"),
      response.status >= 500 ? 502 : 409,
      "asaas_customer_lookup_failed",
    );
  }
  return payload;
}

async function findAsaasCustomers(
  params: URLSearchParams,
): Promise<AsaasPayload[]> {
  params.set("limit", "100");
  const response = await asaasFetch(
    `/customers?${params.toString()}`,
    {},
    "asaas_customer_search_unavailable",
  );
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new AsaasApiError(
      errorMessage(payload, "Não foi possível localizar o cliente no Asaas"),
      response.status >= 500 ? 502 : 409,
      "asaas_customer_search_failed",
    );
  }
  return listData(payload, "customer");
}

export async function findAsaasCustomersByCpf(
  cpfCnpj: string,
): Promise<AsaasPayload[]> {
  return await findAsaasCustomers(new URLSearchParams({ cpfCnpj }));
}

export async function findAsaasCustomersByExternalReference(
  externalReference: string,
  cpfCnpj: string,
): Promise<AsaasPayload[]> {
  return await findAsaasCustomers(
    new URLSearchParams({ externalReference, cpfCnpj }),
  );
}

export async function createAsaasCustomer(
  customer: AsaasCustomerInput,
): Promise<AsaasPayload> {
  const response = await asaasFetch(
    "/customers",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(customer),
    },
    "asaas_customer_create_unavailable",
  );
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new AsaasApiError(
      errorMessage(payload, "O Asaas recusou a criação do cliente"),
      response.status >= 500 ? 502 : 409,
      "asaas_customer_create_failed",
    );
  }
  if (typeof payload.id !== "string" || !payload.id) {
    throw new AsaasApiError(
      "O Asaas não confirmou a criação do cliente",
      502,
      "asaas_customer_create_unconfirmed",
    );
  }
  return payload;
}

export async function findAsaasPaymentsByExternalReference(
  externalReference: string,
): Promise<AsaasPayload[]> {
  const params = new URLSearchParams({ externalReference, limit: "100" });
  const response = await asaasFetch(
    `/payments?${params.toString()}`,
    {},
    "asaas_payment_search_unavailable",
  );
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new AsaasApiError(
      errorMessage(payload, "Não foi possível reconciliar a cobrança no Asaas"),
      response.status >= 500 ? 502 : 409,
      "asaas_payment_search_failed",
    );
  }
  return listData(payload, "payment");
}

export async function getAsaasInstallmentPayments(
  installmentId: string,
): Promise<AsaasPayload[]> {
  const response = await asaasFetch(
    `/installments/${encodeURIComponent(installmentId)}/payments?limit=100`,
    {},
    "asaas_installment_search_unavailable",
  );
  const payload = await responsePayload(response);
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new AsaasApiError(
      errorMessage(payload, "Não foi possível confirmar as parcelas no Asaas"),
      response.status >= 500 ? 502 : 409,
      "asaas_installment_search_failed",
    );
  }
  return listData(payload, "installment");
}

export async function createAsaasPayment(
  payment: AsaasPaymentInput,
): Promise<AsaasPayload> {
  const response = await asaasFetch(
    "/payments",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payment),
    },
    "asaas_payment_create_unavailable",
  );
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new AsaasApiError(
      errorMessage(payload, "O Asaas recusou a criação da cobrança"),
      response.status >= 500 ? 502 : 409,
      "asaas_payment_create_failed",
    );
  }
  if (typeof payload.id !== "string" || !payload.id) {
    throw new AsaasApiError(
      "O Asaas não confirmou a criação da cobrança",
      502,
      "asaas_payment_create_unconfirmed",
    );
  }
  return payload;
}

export async function getAsaasPixQrCode(
  chargeId: string,
): Promise<AsaasPayload> {
  const response = await asaasFetch(
    `/payments/${encodeURIComponent(chargeId)}/pixQrCode`,
    {},
    "asaas_pix_lookup_unavailable",
  );
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new AsaasApiError(
      errorMessage(payload, "Não foi possível obter o Pix da cobrança"),
      response.status >= 500 ? 502 : 409,
      "asaas_pix_lookup_failed",
    );
  }
  return payload;
}

export async function deleteAsaasPayment(
  chargeId: string,
): Promise<"deleted" | "already_missing"> {
  const response = await asaasFetch(
    `/payments/${encodeURIComponent(chargeId)}`,
    {
      method: "DELETE",
    },
  );
  const payload = await responsePayload(response);

  if (response.status === 404) return "already_missing";
  if (!response.ok) {
    throw new AsaasApiError(
      errorMessage(payload, "O Asaas recusou o cancelamento da cobrança"),
      response.status >= 500 ? 502 : 409,
      "asaas_cancel_failed",
    );
  }

  return "deleted";
}

export async function deleteAsaasInstallmentPayments(
  installmentId: string,
): Promise<"deleted" | "already_missing"> {
  const response = await asaasFetch(
    `/installments/${encodeURIComponent(installmentId)}/payments`,
    { method: "DELETE" },
    "asaas_installment_cancel_unavailable",
    65_000,
  );
  const payload = await responsePayload(response);

  if (response.status === 404) return "already_missing";
  if (!response.ok) {
    throw new AsaasApiError(
      errorMessage(payload, "O Asaas recusou o cancelamento das parcelas"),
      response.status >= 500 ? 502 : 409,
      "asaas_installment_cancel_failed",
    );
  }

  return "deleted";
}

export async function updateAsaasPaymentDueDate(
  chargeId: string,
  billingType: string,
  value: number,
  dueDate: string,
): Promise<AsaasPayload> {
  const response = await asaasFetch(
    `/payments/${encodeURIComponent(chargeId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        billingType,
        value,
        dueDate,
      }),
    },
    "asaas_due_date_update_unavailable",
  );
  const payload = await responsePayload(response);

  if (!response.ok) {
    throw new AsaasApiError(
      errorMessage(payload, "O Asaas recusou a alteração de vencimento"),
      response.status >= 500 ? 502 : 409,
      "asaas_due_date_update_failed",
    );
  }

  return payload;
}

export async function refundAsaasPayment(
  chargeId: string,
  value: number,
  description: string,
): Promise<AsaasPayload> {
  const response = await asaasFetch(
    `/payments/${encodeURIComponent(chargeId)}/refund`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value, description }),
    },
  );
  const payload = await responsePayload(response);

  if (!response.ok) {
    throw new AsaasApiError(
      errorMessage(payload, "O Asaas recusou o estorno"),
      response.status >= 500 ? 502 : 409,
      "asaas_refund_failed",
    );
  }

  return payload;
}
