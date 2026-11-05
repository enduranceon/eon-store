import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";
import {
  AsaasApiError,
  getAsaasCustomer,
  getAsaasInstallmentPayments,
  getAsaasPayment,
} from "../_shared/asaas.ts";
import {
  asaasConfigured,
  asaasPaymentIdFromLink,
  asaasSandboxConfigured,
  dateValue,
  digits,
  moneyValue,
  PAID_STATUSES,
} from "./asaas-payment-check.ts";

// Carnê de boleto/PIX parcelado do Asaas ligado a um contrato.
//
// O parcelamento é criado à mão no Asaas. Aqui o sistema só LÊ (GET /payments e
// GET /installments/:id/payments), guarda cada parcela com o seu link e, quando
// o administrador confirma, registra o pagamento de cada parcela como linha
// manual confirmada. Nada é criado, alterado, cancelado ou estornado no Asaas.
// A gravação passa pelas funções import/sync/record/reopen/remove do banco.

type AsaasPayload = Record<string, unknown>;
type Row = Record<string, unknown>;

export interface ParcelFacts {
  installment_number: number;
  value: number;
  due_date: string;
  asaas_payment_id: string;
  asaas_installment_id: string;
  billing_type: string | null;
  asaas_status: string;
  invoice_url: string | null;
  // Quando a pessoa pagou e quando o dinheiro entra (só parcela já paga).
  paid_date: string | null;
  credit_date: string | null;
}

export type CustomerCheck = "match" | "match_cnpj" | "mismatch" | "unknown";

type ParcelDraft = Omit<ParcelFacts, "installment_number"> & {
  installment_number: number | null;
};

export interface ParcelsDeps {
  getPayment: typeof getAsaasPayment;
  getInstallmentPayments: typeof getAsaasInstallmentPayments;
  getCustomer: typeof getAsaasCustomer;
}

export interface ParcelsOptions {
  deps?: ParcelsDeps;
  configured?: boolean;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYMENT_ID_PATTERN = /^pay_[A-Za-z0-9]{6,40}$/;
const INSTALLMENT_ID_PATTERN = /^[A-Za-z0-9_-]{6,80}$/;
const INVOICE_URL_PATTERN = /^https:\/\/www\.asaas\.com\/i\/[A-Za-z0-9]{6,40}$/;
const STATUS_PATTERN = /^[A-Z_]{3,40}$/;
const BILLING_PATTERN = /^[A-Z_]{3,30}$/;
const MAX_PARCELS = 24;

const defaultDeps: ParcelsDeps = {
  getPayment: getAsaasPayment,
  getInstallmentPayments: getAsaasInstallmentPayments,
  getCustomer: getAsaasCustomer,
};

function invoiceUrl(payment: AsaasPayload, paymentId: string): string {
  const raw = typeof payment.invoiceUrl === "string"
    ? payment.invoiceUrl.trim().replace(/\/$/, "")
    : "";
  return INVOICE_URL_PATTERN.test(raw)
    ? raw
    : `https://www.asaas.com/i/${paymentId.slice(4)}`;
}

// Só o que o carnê usa de cada parcela; nenhum dado do cliente sai do Asaas.
export function parcelFacts(
  payment: AsaasPayload,
  installmentId: string,
): ParcelDraft | null {
  const id = typeof payment.id === "string" ? payment.id.trim() : "";
  if (!PAYMENT_ID_PATTERN.test(id)) return null;
  const value = moneyValue(payment.value);
  const dueDate = dateValue(payment.dueDate);
  if (value === null || value <= 0 || !dueDate) return null;
  const rawStatus = payment.deleted === true
    ? "DELETED"
    : typeof payment.status === "string"
    ? payment.status.trim().toUpperCase()
    : "UNKNOWN";
  const status = STATUS_PATTERN.test(rawStatus) ? rawStatus : "UNKNOWN";
  const billing = typeof payment.billingType === "string" &&
      BILLING_PATTERN.test(payment.billingType)
    ? payment.billingType
    : null;
  const paid = PAID_STATUSES.has(status);
  return {
    installment_number: Number.isInteger(payment.installmentNumber)
      ? payment.installmentNumber as number
      : null,
    value,
    due_date: dueDate,
    asaas_payment_id: id,
    asaas_installment_id: installmentId,
    billing_type: billing,
    asaas_status: status,
    invoice_url: invoiceUrl(payment, id),
    paid_date: paid
      ? dateValue(payment.clientPaymentDate) ??
        dateValue(payment.confirmedDate) ?? dateValue(payment.paymentDate)
      : null,
    credit_date: paid
      ? dateValue(payment.creditDate) ?? dateValue(payment.estimatedCreditDate)
      : null,
  };
}

type CarneRead =
  | {
    ok: true;
    installment_id: string;
    asaas_customer_id: string | null;
    parcels: ParcelFacts[];
  }
  | {
    ok: false;
    code: "asaas_not_found" | "not_installment" | "invalid_installments";
    message: string;
  };

// Acha o parcelamento a partir de uma cobrança (qualquer parcela) e lê todas.
async function readCarne(
  deps: ParcelsDeps,
  paymentId: string,
): Promise<CarneRead> {
  const lookup = await deps.getPayment(paymentId);
  if (!lookup.found) {
    return {
      ok: false,
      code: "asaas_not_found",
      message: "Essa cobrança não foi encontrada no Asaas.",
    };
  }
  const installmentId = typeof lookup.payment.installment === "string"
    ? lookup.payment.installment.trim()
    : "";
  if (!INSTALLMENT_ID_PATTERN.test(installmentId)) {
    return {
      ok: false,
      code: "not_installment",
      message:
        "Essa cobrança não faz parte de um parcelamento no Asaas (não é carnê).",
    };
  }
  const payments = await deps.getInstallmentPayments(installmentId);
  const facts = payments
    .map((payment) => parcelFacts(payment, installmentId))
    .filter((fact): fact is NonNullable<typeof fact> => fact !== null)
    .sort((a, b) =>
      (a.installment_number ?? 0) - (b.installment_number ?? 0) ||
      a.due_date.localeCompare(b.due_date)
    );
  // Sem número de parcela no Asaas, vale a ordem de vencimento.
  const numbered = facts.every((fact) => fact.installment_number !== null)
    ? facts
    : [...facts].sort((a, b) => a.due_date.localeCompare(b.due_date)).map((
      fact,
      index,
    ) => ({ ...fact, installment_number: index + 1 }));
  const parcels = numbered.map((fact) => ({
    ...fact,
    installment_number: fact.installment_number as number,
  }));
  const numbers = parcels.map((parcel) => parcel.installment_number);
  const sequential = numbers.every((number, index) => number === index + 1);
  if (
    parcels.length < 2 || parcels.length > MAX_PARCELS || !sequential ||
    !parcels.some((parcel) => parcel.asaas_payment_id === paymentId)
  ) {
    return {
      ok: false,
      code: "invalid_installments",
      message:
        "Não foi possível montar as parcelas deste parcelamento no Asaas (parcelas faltando ou fora de ordem).",
    };
  }
  return {
    ok: true,
    installment_id: installmentId,
    asaas_customer_id: typeof lookup.payment.customer === "string"
      ? lookup.payment.customer
      : null,
    parcels,
  };
}

async function checkCustomer(
  deps: ParcelsDeps,
  supabase: SupabaseClient,
  customerId: unknown,
  asaasCustomerId: string | null,
): Promise<CustomerCheck> {
  if (typeof customerId !== "string" || !customerId || !asaasCustomerId) {
    return "unknown";
  }
  const { data, error } = await supabase
    .from("presale_customers")
    .select("id, cpf, cnpj")
    .eq("id", customerId)
    .maybeSingle();
  if (error) throw error;
  const local = data as Row | null;
  const cpf = digits(local?.cpf);
  const cnpj = digits(local?.cnpj);
  if (!cpf && !cnpj) return "unknown";
  const customer = await deps.getCustomer(asaasCustomerId);
  const asaasDocument = digits(customer.cpfCnpj);
  if (!asaasDocument) return "unknown";
  if (cpf && asaasDocument === cpf) return "match";
  if (cnpj && asaasDocument === cnpj) return "match_cnpj";
  return "mismatch";
}

function contractTotal(contract: Row): number | null {
  const snapshot = contract.plan_snapshot as Row | null;
  const price = moneyValue(snapshot?.price_total);
  if (price === null) return null;
  return Math.max(
    0,
    Math.round(
      (price + (moneyValue(contract.enrollment_fee) ?? 0) -
        (moneyValue(contract.manual_discount) ?? 0) -
        (moneyValue(contract.credit_balance) ?? 0)) * 100,
    ) / 100,
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 50 &&
    Number.isFinite(Date.parse(value));
}

async function readBody(req: Request): Promise<Row | null> {
  try {
    const text = await req.text();
    if (!text.trim()) return {};
    const body = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Row
      : null;
  } catch {
    return null;
  }
}

function onlyKeys(body: Row, allowed: string[]): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}

function invalidRequest(message = "Dados inválidos"): Response {
  return jsonResponse({ error: message, code: "invalid_request" }, 400);
}

function rpcError(error: { code?: string; message?: string }): Response {
  console.error("api-v1 contract parcels:", error.code, error.message);
  if (error.code === "P0002") {
    return jsonResponse({ error: error.message, code: "not_found" }, 404);
  }
  if (error.code === "22023") {
    return jsonResponse({ error: error.message, code: "invalid_request" }, 400);
  }
  if (error.code === "P0001" || error.code === "23505") {
    return jsonResponse({ error: error.message, code: "conflict" }, 409);
  }
  return jsonResponse({
    error: "Não foi possível atualizar as parcelas",
    code: "database_error",
  }, 500);
}

function asaasFailure(error: AsaasApiError): Response {
  if (error.code === "asaas_misconfigured") {
    return jsonResponse({
      error: "A conferência com o Asaas ainda não foi configurada",
      code: "asaas_not_configured",
    }, 503);
  }
  return jsonResponse({
    error: `Não foi possível consultar o Asaas: ${error.message}`,
    code: "asaas_check_failed",
  }, 502);
}

async function loadContract(
  supabase: SupabaseClient,
  contractId: string,
): Promise<Row | null> {
  const { data, error } = await supabase
    .from("assessment_contracts")
    .select(
      "id, contract_number, customer_id, status, payment_status, external_payment_link, plan_snapshot, enrollment_fee, manual_discount, credit_balance, updated_at",
    )
    .eq("id", contractId)
    .maybeSingle();
  if (error) throw error;
  return (data as Row | null) ?? null;
}

async function loadParcels(
  supabase: SupabaseClient,
  contractId: string,
): Promise<Row[]> {
  const { data, error } = await supabase
    .from("assessment_contract_parcels")
    .select(
      "id, installment_number, asaas_payment_id, asaas_installment_id, payment_row_id",
    )
    .eq("contract_id", contractId);
  if (error) throw error;
  return (data ?? []) as Row[];
}

function rpcParcels(parcels: ParcelFacts[]) {
  return parcels.map((parcel) => ({
    installment_number: parcel.installment_number,
    value: parcel.value,
    due_date: parcel.due_date,
    asaas_payment_id: parcel.asaas_payment_id,
    asaas_installment_id: parcel.asaas_installment_id,
    billing_type: parcel.billing_type,
    asaas_status: parcel.asaas_status,
    invoice_url: parcel.invoice_url,
    paid_date: parcel.paid_date,
    credit_date: parcel.credit_date,
  }));
}

function resolveLink(body: Row, contract: Row): string | null {
  const link = typeof body.link === "string" && body.link.trim()
    ? body.link
    : contract.external_payment_link;
  return asaasPaymentIdFromLink(link);
}

function checkGuards(options: ParcelsOptions): Response | null {
  if (!(options.configured ?? asaasConfigured())) {
    return jsonResponse({
      error: "A conferência com o Asaas ainda não foi configurada",
      code: "asaas_not_configured",
    }, 503);
  }
  if (options.configured === undefined && asaasSandboxConfigured()) {
    return jsonResponse({
      error:
        "A chave configurada é do sandbox do Asaas (teste). As faturas cadastradas são da conta real: configure a chave de produção.",
      code: "asaas_sandbox_configured",
    }, 503);
  }
  return null;
}

export async function handleContractParcelsRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
  options: ParcelsOptions = {},
): Promise<Response | null> {
  const contractMatch = path.match(
    /^\/orders\/contract\/([^/]+)\/parcels\/(preview|import|sync|remove)$/,
  );
  const parcelMatch = path.match(
    /^\/orders\/contract\/([^/]+)\/parcels\/([^/]+)\/(payment|reopen)$/,
  );
  if (!contractMatch && !parcelMatch) return null;
  if (req.method !== "POST") {
    return jsonResponse(
      { error: "Método não permitido", code: "method_not_allowed" },
      405,
    );
  }
  const contractId = (contractMatch?.[1] ?? parcelMatch?.[1] ?? "")
    .toLowerCase();
  const action = contractMatch?.[2] ?? parcelMatch?.[3] ?? "";
  const parcelId = (parcelMatch?.[2] ?? "").toLowerCase();
  if (!UUID_PATTERN.test(contractId) || (parcelMatch && !UUID_PATTERN.test(parcelId))) {
    return invalidRequest("Identificador inválido");
  }
  const body = await readBody(req);
  if (!body) return invalidRequest();
  const deps = options.deps ?? defaultDeps;

  try {
    const contract = await loadContract(supabase, contractId);
    if (!contract) {
      return jsonResponse(
        { error: "Contrato não encontrado", code: "not_found" },
        404,
      );
    }

    // Ações só do banco: desfazer o registro e remover o carnê.
    if (action === "remove" || action === "reopen") {
      if (
        !onlyKeys(body, ["expected_updated_at"]) ||
        !isTimestamp(body.expected_updated_at)
      ) {
        return invalidRequest("Informe a versão do contrato");
      }
      const { data, error } = action === "remove"
        ? await supabase.rpc("remove_assessment_contract_parcels", {
          p_contract_id: contractId,
          p_expected_updated_at: body.expected_updated_at,
          p_actor_id: actorId,
        })
        : await supabase.rpc("reopen_assessment_contract_parcel_payment", {
          p_contract_id: contractId,
          p_parcel_id: parcelId,
          p_expected_updated_at: body.expected_updated_at,
          p_actor_id: actorId,
        });
      if (error) return rpcError(error);
      return jsonResponse({ data });
    }

    const guard = checkGuards(options);
    if (guard) return guard;

    if (action === "preview" || action === "import") {
      const allowed = action === "import"
        ? ["link", "expected_updated_at"]
        : ["link"];
      if (!onlyKeys(body, allowed)) return invalidRequest();
      if (
        action === "import" && !isTimestamp(body.expected_updated_at)
      ) {
        return invalidRequest("Informe a versão do contrato");
      }
      const paymentId = resolveLink(body, contract);
      if (!paymentId) {
        return jsonResponse({
          error:
            "Cole o link de uma parcela do Asaas (www.asaas.com/i/código).",
          code: "unsupported_link",
        }, 400);
      }
      const carne = await readCarne(deps, paymentId);
      if (!carne.ok) {
        return jsonResponse({ error: carne.message, code: carne.code }, 409);
      }
      const customerCheck = await checkCustomer(
        deps,
        supabase,
        contract.customer_id,
        carne.asaas_customer_id,
      );
      const totalValue = Math.round(
        carne.parcels.reduce((sum, parcel) => sum + parcel.value, 0) * 100,
      ) / 100;
      const expectedTotal = contractTotal(contract);
      const blockers: string[] = [];
      if (carne.parcels.some((parcel) => parcel.asaas_status === "DELETED")) {
        blockers.push("Há parcela removida no Asaas.");
      }
      if (customerCheck === "mismatch") {
        blockers.push("O documento do cliente no Asaas não é o desta pessoa.");
      } else if (customerCheck === "unknown") {
        blockers.push(
          "Não foi possível conferir o documento do cliente no Asaas (CPF/CNPJ não cadastrado na ficha ou na fatura).",
        );
      }
      if (
        expectedTotal !== null && Math.abs(totalValue - expectedTotal) > 0.05
      ) {
        blockers.push(
          "A soma das parcelas é diferente do valor do contrato.",
        );
      }

      if (action === "preview") {
        const existing = await loadParcels(supabase, contractId);
        return jsonResponse({
          data: {
            installment_id: carne.installment_id,
            parcels: carne.parcels,
            total_value: totalValue,
            contract_total: expectedTotal,
            customer_check: customerCheck,
            already_imported: existing.length > 0,
            blockers,
            checked_at: new Date().toISOString(),
          },
        });
      }

      if (blockers.length > 0) {
        return jsonResponse(
          { error: blockers.join(" "), code: "import_blocked", blockers },
          409,
        );
      }
      const { data, error } = await supabase.rpc(
        "import_assessment_contract_parcels",
        {
          p_contract_id: contractId,
          p_parcels: rpcParcels(carne.parcels),
          p_expected_updated_at: body.expected_updated_at,
          p_actor_id: actorId,
        },
      );
      if (error) return rpcError(error);
      return jsonResponse({
        data: { ...(data as Row), customer_check: customerCheck },
      });
    }

    // sync e payment partem das parcelas já importadas.
    const stored = await loadParcels(supabase, contractId);
    if (stored.length === 0) {
      return jsonResponse({
        error: "Este contrato não tem parcelas importadas",
        code: "no_parcels",
      }, 409);
    }
    const target = action === "payment"
      ? stored.find((parcel) => String(parcel.id).toLowerCase() === parcelId)
      : stored[0];
    if (!target) {
      return jsonResponse(
        { error: "Parcela não encontrada", code: "not_found" },
        404,
      );
    }
    const carne = await readCarne(deps, String(target.asaas_payment_id));
    if (!carne.ok) {
      return jsonResponse({ error: carne.message, code: carne.code }, 409);
    }

    if (action === "payment") {
      if (
        !onlyKeys(body, ["expected_updated_at"]) ||
        !isTimestamp(body.expected_updated_at)
      ) {
        return invalidRequest("Informe a versão do contrato");
      }
      if (contract.updated_at !== body.expected_updated_at) {
        return jsonResponse({
          error:
            "O contrato foi alterado por outra ação. Atualize a página e tente novamente",
          code: "conflict",
        }, 409);
      }
      const facts = carne.parcels.find((parcel) =>
        parcel.asaas_payment_id === target.asaas_payment_id
      );
      if (!facts || !PAID_STATUSES.has(facts.asaas_status)) {
        return jsonResponse({
          error: "Esta parcela ainda não consta como paga no Asaas.",
          code: "parcel_not_paid",
        }, 409);
      }
      if (!facts.paid_date) {
        return jsonResponse({
          error: "O Asaas não informou a data do pagamento desta parcela.",
          code: "parcel_without_payment_date",
        }, 409);
      }
      const customerCheck = await checkCustomer(
        deps,
        supabase,
        contract.customer_id,
        carne.asaas_customer_id,
      );
      if (customerCheck !== "match" && customerCheck !== "match_cnpj") {
        return jsonResponse({
          error: customerCheck === "mismatch"
            ? "O documento do cliente no Asaas não é o desta pessoa."
            : "Não foi possível conferir o documento do cliente no Asaas.",
          code: customerCheck === "mismatch"
            ? "customer_mismatch"
            : "customer_unknown",
        }, 409);
      }
      // A situação de todas as parcelas entra antes, para o banco enxergar
      // esta como paga; o vencimento do contrato pode mudar nessa hora.
      const synced = await supabase.rpc("sync_assessment_contract_parcels", {
        p_contract_id: contractId,
        p_parcels: rpcParcels(carne.parcels),
        p_actor_id: actorId,
      });
      if (synced.error) return rpcError(synced.error);
      const syncedContract = (synced.data as Row | null)?.contract as
        | Row
        | undefined;
      const credit = facts.credit_date && facts.credit_date >= facts.paid_date
        ? facts.credit_date
        : facts.paid_date;
      const { data, error } = await supabase.rpc(
        "record_assessment_contract_parcel_payment",
        {
          p_contract_id: contractId,
          p_parcel_id: parcelId,
          p_payment_date: facts.paid_date,
          p_credit_date: credit,
          p_expected_updated_at: syncedContract?.updated_at ??
            body.expected_updated_at,
          p_actor_id: actorId,
        },
      );
      if (error) return rpcError(error);
      return jsonResponse({ data: { ...(data as Row), customer_check: customerCheck } });
    }

    // sync
    if (!onlyKeys(body, [])) return invalidRequest();
    const { data, error } = await supabase.rpc(
      "sync_assessment_contract_parcels",
      {
        p_contract_id: contractId,
        p_parcels: rpcParcels(carne.parcels),
        p_actor_id: actorId,
      },
    );
    if (error) return rpcError(error);
    return jsonResponse({
      data: { ...(data as Row), checked_at: new Date().toISOString() },
    });
  } catch (error) {
    if (error instanceof AsaasApiError) return asaasFailure(error);
    console.error(
      "api-v1 contract parcels:",
      (error as { code?: string })?.code,
      error instanceof Error ? error.message : (error as { message?: string })?.message,
    );
    return jsonResponse({
      error: "Não foi possível atualizar as parcelas",
      code: "parcels_failed",
    }, 500);
  }
}
