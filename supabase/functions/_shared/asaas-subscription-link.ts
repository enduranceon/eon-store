import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import {
  AsaasApiError,
  getAsaasCustomer,
  getAsaasPayment,
  getAsaasSubscriptionPayments,
} from "./asaas.ts";

// Renovação mensal automática = assinatura no Asaas, que gera e avisa a fatura
// de cada mês. Aqui só se consulta (GET): a assinatura sai do link da fatura de
// um contrato anterior (www.asaas.com/i/<código> = cobrança pay_<código>, que
// informa a assinatura), e a fatura do mês é a dessa assinatura com vencimento
// mais perto do esperado. Quem grava é apply_assessment_subscription_lookup;
// nada é criado, alterado ou cancelado no Asaas.

type AsaasPayload = Record<string, unknown>;

export type SubscriptionLookupStatus =
  | "attached"
  | "value_mismatch"
  | "waiting_invoice"
  | "no_subscription"
  | "customer_mismatch"
  | "asaas_error";

export interface SubscriptionLookupResult {
  contract_id: string;
  contract_number: string | null;
  status: SubscriptionLookupStatus | "skipped";
  note?: string;
}

export interface SubscriptionLinkDeps {
  getPayment: typeof getAsaasPayment;
  getSubscriptionPayments: typeof getAsaasSubscriptionPayments;
  getCustomer: typeof getAsaasCustomer;
}

const DEFAULT_DEPS: SubscriptionLinkDeps = {
  getPayment: getAsaasPayment,
  getSubscriptionPayments: getAsaasSubscriptionPayments,
  getCustomer: getAsaasCustomer,
};

const CONTRACT_COLUMNS = [
  "id",
  "contract_number",
  "customer_id",
  "parent_contract_id",
  "start_date",
  "due_date",
  "plan_snapshot",
  "enrollment_fee",
  "manual_discount",
  "credit_balance",
  "payment_method",
  "asaas_subscription_id",
  "external_payment_link",
].join(", ");

const INVOICE_LINK_PATTERN =
  /^https:\/\/www\.asaas\.com\/i\/([A-Za-z0-9]{6,40})\/?$/;
const SUBSCRIPTION_PATTERN = /^sub_[A-Za-z0-9]{4,40}$/;
// Fatura cancelada, estornada ou em disputa não serve de cobrança do mês.
const UNUSABLE_STATUSES = new Set([
  "REFUNDED",
  "REFUND_REQUESTED",
  "REFUND_IN_PROGRESS",
  "CHARGEBACK_REQUESTED",
  "CHARGEBACK_DISPUTE",
  "AWAITING_CHARGEBACK_REVERSAL",
  "DUNNING_REQUESTED",
]);
const MATCH_WINDOW_DAYS = 20;
const MAX_ANCESTORS = 6;
const MAX_CONTRACTS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

function digits(value: unknown): string {
  return typeof value === "string" ? value.replace(/\D/g, "") : "";
}

function dateOnly(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? value.slice(0, 10)
    : null;
}

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T12:00:00Z`) / DAY_MS);
}

function addOneMonth(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const next = new Date(Date.UTC(year, month, Math.min(day, last)));
  return next.toISOString().slice(0, 10);
}

export function invoiceCodeFromLink(link: unknown): string | null {
  if (typeof link !== "string") return null;
  return link.trim().match(INVOICE_LINK_PATTERN)?.[1] ?? null;
}

function invoiceLink(payment: AsaasPayload): string | null {
  const fromUrl = invoiceCodeFromLink(payment.invoiceUrl);
  if (fromUrl) return `https://www.asaas.com/i/${fromUrl}`;
  const id = typeof payment.id === "string" ? payment.id : "";
  const code = id.startsWith("pay_") ? id.slice(4) : "";
  return /^[A-Za-z0-9]{6,40}$/.test(code)
    ? `https://www.asaas.com/i/${code}`
    : null;
}

function money(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function brl(value: number): string {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// Valor do contrato como em getContractTotalValue (preço + matrícula −
// desconto − crédito).
export function expectedContractValue(contract: Record<string, unknown>): number {
  const snapshot = (contract.plan_snapshot ?? {}) as Record<string, unknown>;
  const total = money(snapshot.price_total) + money(contract.enrollment_fee) -
    money(contract.manual_discount) - money(contract.credit_balance);
  return Math.max(0, Math.round(total * 100) / 100);
}

export function paymentMethodFor(
  payment: AsaasPayload,
  fallback: unknown,
): string {
  const billing = String(payment.billingType ?? "").toUpperCase();
  if (billing === "PIX") return "pix";
  if (billing === "BOLETO") return "boleto";
  if (billing === "CREDIT_CARD") {
    const count = Number(payment.installmentCount ?? 1);
    return `card_${Number.isInteger(count) && count >= 1 && count <= 12 ? count : 1}x`;
  }
  // UNDEFINED (a pessoa escolhe no Asaas): mantém a forma do contrato.
  return typeof fallback === "string" &&
      /^(pix|boleto|card_([1-9]|1[0-2])x)$/.test(fallback)
    ? fallback
    : "pix";
}

// A fatura do mês: da assinatura, não cancelada nem usada por outro
// contrato, com vencimento até 20 dias do esperado (a fatura anterior + 1
// mês, ou o início da renovação). A mais perto ganha.
export function pickSubscriptionInvoice(
  payments: AsaasPayload[],
  expectedDue: string,
  usedCodes: Set<string>,
): AsaasPayload | null {
  const target = dayNumber(expectedDue);
  let best: { payment: AsaasPayload; distance: number; due: number } | null = null;
  for (const payment of payments) {
    if (payment.deleted === true) continue;
    if (UNUSABLE_STATUSES.has(String(payment.status ?? ""))) continue;
    const due = dateOnly(payment.dueDate);
    const link = invoiceLink(payment);
    if (!due || !link) continue;
    if (usedCodes.has(invoiceCodeFromLink(link)!)) continue;
    const distance = Math.abs(dayNumber(due) - target);
    if (distance > MATCH_WINDOW_DAYS) continue;
    if (
      !best || distance < best.distance ||
      (distance === best.distance && dayNumber(due) < best.due)
    ) {
      best = { payment, distance, due: dayNumber(due) };
    }
  }
  return best?.payment ?? null;
}

async function loadAncestors(
  supabase: SupabaseClient,
  contract: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const chain: Record<string, unknown>[] = [];
  let parentId = contract.parent_contract_id as string | null;
  while (parentId && chain.length < MAX_ANCESTORS) {
    const { data, error } = await supabase
      .from("assessment_contracts")
      .select(CONTRACT_COLUMNS)
      .eq("id", parentId)
      .maybeSingle();
    if (error) throw error;
    if (!data) break;
    chain.push(data as unknown as Record<string, unknown>);
    parentId = (data as unknown as Record<string, unknown>).parent_contract_id as string | null;
  }
  return chain;
}

// Assinatura: a já guardada no contrato ou num anterior; senão, a da última
// fatura do Asaas colada num contrato anterior.
async function resolveSubscription(
  contract: Record<string, unknown>,
  ancestors: Record<string, unknown>[],
  deps: SubscriptionLinkDeps,
): Promise<string | null> {
  for (const row of [contract, ...ancestors]) {
    const stored = row.asaas_subscription_id;
    if (typeof stored === "string" && SUBSCRIPTION_PATTERN.test(stored)) return stored;
  }
  for (const row of ancestors) {
    const code = invoiceCodeFromLink(row.external_payment_link);
    if (!code) continue;
    const lookup = await deps.getPayment(`pay_${code}`);
    if (!lookup.found) continue;
    const subscription = lookup.payment.subscription;
    if (typeof subscription === "string" && SUBSCRIPTION_PATTERN.test(subscription)) {
      return subscription;
    }
  }
  return null;
}

async function personDocuments(
  supabase: SupabaseClient,
  customerId: unknown,
): Promise<{ cpf: string; cnpj: string }> {
  if (typeof customerId !== "string") return { cpf: "", cnpj: "" };
  const { data, error } = await supabase
    .from("presale_customers")
    .select("cpf, cnpj")
    .eq("id", customerId)
    .maybeSingle();
  if (error) throw error;
  return { cpf: digits(data?.cpf), cnpj: digits(data?.cnpj) };
}

async function usedInvoiceCodes(
  supabase: SupabaseClient,
  customerId: unknown,
): Promise<Set<string>> {
  const codes = new Set<string>();
  if (typeof customerId !== "string") return codes;
  const { data, error } = await supabase
    .from("assessment_contracts")
    .select("external_payment_link")
    .eq("customer_id", customerId)
    .not("external_payment_link", "is", null);
  if (error) throw error;
  for (const row of data ?? []) {
    const code = invoiceCodeFromLink((row as Record<string, unknown>).external_payment_link);
    if (code) codes.add(code);
  }
  return codes;
}

interface Lookup {
  status: SubscriptionLookupStatus;
  subscriptionId: string | null;
  note: string | null;
  invoice: Record<string, unknown> | null;
}

async function lookupContract(
  supabase: SupabaseClient,
  contract: Record<string, unknown>,
  deps: SubscriptionLinkDeps,
): Promise<Lookup> {
  const ancestors = await loadAncestors(supabase, contract);
  const subscriptionId = await resolveSubscription(contract, ancestors, deps);
  if (!subscriptionId) {
    return {
      status: "no_subscription",
      subscriptionId: null,
      note: "A fatura anterior não é de uma assinatura do Asaas. Cole o link deste mês uma vez; os próximos vêm sozinhos.",
      invoice: null,
    };
  }

  const previousDue = dateOnly(ancestors[0]?.due_date);
  const expectedDue = previousDue
    ? addOneMonth(previousDue)
    : dateOnly(contract.start_date)!;
  const payments = await deps.getSubscriptionPayments(subscriptionId);
  const used = await usedInvoiceCodes(supabase, contract.customer_id);
  const payment = pickSubscriptionInvoice(payments, expectedDue, used);
  if (!payment) {
    return {
      status: "waiting_invoice",
      subscriptionId,
      note: "A fatura deste mês ainda não apareceu na assinatura do Asaas. O sistema tenta de novo amanhã.",
      invoice: null,
    };
  }

  // Mesma conferência da baixa: o documento do cliente da fatura tem que ser
  // o CPF (ou o CNPJ cadastrado) da pessoa.
  const documents = await personDocuments(supabase, contract.customer_id);
  const asaasCustomer = typeof payment.customer === "string" && payment.customer
    ? await deps.getCustomer(payment.customer)
    : {};
  const asaasDocument = digits((asaasCustomer as AsaasPayload).cpfCnpj);
  const sameDocument = Boolean(asaasDocument) &&
    (asaasDocument === documents.cpf || asaasDocument === documents.cnpj);
  if (!sameDocument) {
    return {
      status: "customer_mismatch",
      subscriptionId,
      note: documents.cpf || documents.cnpj
        ? "O CPF/CNPJ da assinatura no Asaas não é o da pessoa. Confira antes de colar o link."
        : "A pessoa não tem CPF/CNPJ no cadastro para conferir com a assinatura.",
      invoice: null,
    };
  }

  const value = Math.round(money(payment.value) * 100) / 100;
  const expected = expectedContractValue(contract);
  const valueMatches = Math.abs(value - expected) < 0.01;
  return {
    status: valueMatches ? "attached" : "value_mismatch",
    subscriptionId,
    note: valueMatches
      ? null
      : `No Asaas ${brl(value)}; no contrato ${brl(expected)}.`,
    invoice: {
      link: invoiceLink(payment),
      due_date: dateOnly(payment.dueDate),
      payment_method: paymentMethodFor(payment, contract.payment_method),
      invoice_number: typeof payment.invoiceNumber === "string"
        ? payment.invoiceNumber
        : payment.invoiceNumber != null
        ? String(payment.invoiceNumber)
        : null,
    },
  };
}

// Renovações mensais automáticas ainda sem link (ou só as pedidas).
export async function syncSubscriptionInvoiceLinks(
  supabase: SupabaseClient,
  options: {
    contractIds?: string[] | null;
    actorId?: string | null;
    deps?: SubscriptionLinkDeps;
  } = {},
): Promise<{ checked: number; attached: number; results: SubscriptionLookupResult[] }> {
  const deps = options.deps ?? DEFAULT_DEPS;
  let query = supabase
    .from("assessment_contracts")
    .select(CONTRACT_COLUMNS)
    .eq("auto_renewal", true)
    .not("parent_contract_id", "is", null)
    .is("external_payment_link", null)
    .is("asaas_charge_id", null)
    .in("status", ["draft", "scheduled", "active", "overdue"])
    .in("payment_status", ["pending", "awaiting_charge"])
    .order("start_date", { ascending: true })
    .limit(MAX_CONTRACTS);
  if (options.contractIds?.length) query = query.in("id", options.contractIds);
  const { data, error } = await query;
  if (error) throw error;

  const results: SubscriptionLookupResult[] = [];
  let attached = 0;
  for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
    let lookup: Lookup;
    try {
      lookup = await lookupContract(supabase, row, deps);
    } catch (lookupError) {
      if (!(lookupError instanceof AsaasApiError)) throw lookupError;
      lookup = {
        status: "asaas_error",
        subscriptionId: null,
        note: "Não foi possível consultar o Asaas agora. O sistema tenta de novo amanhã.",
        invoice: null,
      };
    }
    const { data: applied, error: applyError } = await supabase.rpc(
      "apply_assessment_subscription_lookup",
      {
        p_contract_id: row.id,
        p_subscription_id: lookup.subscriptionId,
        p_status: lookup.status,
        p_note: lookup.note,
        p_invoice: lookup.invoice,
        p_actor_id: options.actorId ?? null,
      },
    );
    if (applyError) throw applyError;
    const skipped = (applied as Record<string, unknown> | null)?.skipped === true;
    if (!skipped && (applied as Record<string, unknown> | null)?.attached === true) attached += 1;
    results.push({
      contract_id: String(row.id),
      contract_number: (row.contract_number as string | null) ?? null,
      status: skipped ? "skipped" : lookup.status,
      ...(lookup.note ? { note: lookup.note } : {}),
    });
  }
  return { checked: results.length, attached, results };
}

export function asaasLookupConfigured(): boolean {
  const baseUrl = Deno.env.get("ASAAS_BASE_URL")?.trim() ?? "";
  const apiKey = Deno.env.get("ASAAS_API_KEY")?.trim() ?? "";
  // As faturas são da conta real; com o sandbox, nada seria encontrado.
  return Boolean(baseUrl && apiKey) && !/sandbox/i.test(baseUrl) &&
    !apiKey.startsWith("$aact_hmlg_");
}
