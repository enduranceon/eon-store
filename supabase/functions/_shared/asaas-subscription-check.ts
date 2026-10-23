import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import {
  AsaasApiError,
  findAsaasCustomersByCpf,
  getAsaasCustomerSubscriptions,
} from "./asaas.ts";

// "Conferir assinaturas no Asaas" (quadro de Renovações). Para cada plano
// mensal com a renovação automática desligada, procura no Asaas (só GET) os
// clientes com o CPF ou o CNPJ da pessoa e as assinaturas mensais ativas
// deles. Ligar a automática confere de novo antes de gravar, por
// enable_assessment_auto_renewal_from_subscription; nada muda no Asaas.

type AsaasPayload = Record<string, unknown>;

export type SubscriptionCheckStatus =
  | "subscription"
  | "multiple"
  | "no_subscription"
  | "no_customer"
  | "no_document"
  | "asaas_error";

export interface SubscriptionSummary {
  id: string;
  value: number;
  next_due_date: string | null;
  billing_type: string | null;
  description: string | null;
}

export interface SubscriptionCheckResult {
  contract_id: string;
  contract_number: string | null;
  customer_name: string | null;
  plan_name: string | null;
  end_date: string | null;
  updated_at: string | null;
  expected_value: number;
  status: SubscriptionCheckStatus;
  subscription?: SubscriptionSummary;
  subscriptions?: SubscriptionSummary[];
}

export interface SubscriptionCheckDeps {
  findCustomers: typeof findAsaasCustomersByCpf;
  getCustomerSubscriptions: typeof getAsaasCustomerSubscriptions;
}

const DEFAULT_DEPS: SubscriptionCheckDeps = {
  findCustomers: findAsaasCustomersByCpf,
  getCustomerSubscriptions: getAsaasCustomerSubscriptions,
};

const SUBSCRIPTION_PATTERN = /^sub_[A-Za-z0-9]{4,40}$/;
const CONCURRENCY = 4;

function digits(value: unknown): string {
  return typeof value === "string" ? value.replace(/\D/g, "") : "";
}

function money(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function summary(subscription: AsaasPayload): SubscriptionSummary {
  return {
    id: String(subscription.id),
    value: money(subscription.value),
    next_due_date: typeof subscription.nextDueDate === "string"
      ? subscription.nextDueDate.slice(0, 10)
      : null,
    billing_type: text(subscription.billingType),
    description: text(subscription.description),
  };
}

// Assinaturas mensais ativas dos clientes do Asaas com o CPF/CNPJ da pessoa.
async function personSubscriptions(
  documents: string[],
  deps: SubscriptionCheckDeps,
): Promise<{ customers: number; subscriptions: SubscriptionSummary[] }> {
  const customerIds = new Set<string>();
  for (const document of documents) {
    for (const customer of await deps.findCustomers(document)) {
      if (customer.deleted === true || digits(customer.cpfCnpj) !== document) continue;
      if (typeof customer.id === "string" && customer.id) customerIds.add(customer.id);
    }
  }
  const subscriptions: SubscriptionSummary[] = [];
  for (const customerId of customerIds) {
    for (const subscription of await deps.getCustomerSubscriptions(customerId)) {
      if (
        subscription.deleted === true || subscription.status !== "ACTIVE" ||
        subscription.cycle !== "MONTHLY" || subscription.customer !== customerId ||
        typeof subscription.id !== "string" || !SUBSCRIPTION_PATTERN.test(subscription.id)
      ) continue;
      subscriptions.push(summary(subscription));
    }
  }
  return { customers: customerIds.size, subscriptions };
}

// Com mais de uma assinatura ativa, só fica a que tem o valor do contrato.
function classify(
  found: { customers: number; subscriptions: SubscriptionSummary[] },
  expectedValue: number,
): Pick<SubscriptionCheckResult, "status" | "subscription" | "subscriptions"> {
  if (found.customers === 0) return { status: "no_customer" };
  if (found.subscriptions.length === 0) return { status: "no_subscription" };
  if (found.subscriptions.length === 1) {
    return { status: "subscription", subscription: found.subscriptions[0] };
  }
  const sameValue = found.subscriptions.filter((item) =>
    Math.abs(item.value - expectedValue) < 0.01
  );
  return sameValue.length === 1
    ? { status: "subscription", subscription: sameValue[0] }
    : { status: "multiple", subscriptions: found.subscriptions };
}

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function checkAutoRenewalSubscriptions(
  supabase: SupabaseClient,
  options: { contractIds?: string[] | null; deps?: SubscriptionCheckDeps } = {},
): Promise<{ checked: number; found: number; results: SubscriptionCheckResult[] }> {
  const deps = options.deps ?? DEFAULT_DEPS;
  const { data, error } = await supabase.rpc("list_assessment_auto_renewal_candidates", {
    p_contract_ids: options.contractIds?.length ? options.contractIds : null,
  });
  if (error) throw error;
  const rows = (data ?? []) as Record<string, unknown>[];

  // A mesma pessoa com dois contratos é consultada uma vez só.
  const byPerson = new Map<string, Promise<{ customers: number; subscriptions: SubscriptionSummary[] }>>();
  const results = await mapWithLimit(rows, CONCURRENCY, async (row) => {
    const documents = [...new Set([digits(row.cpf), digits(row.cnpj)].filter(Boolean))];
    const expectedValue = money(row.expected_value);
    const base = {
      contract_id: String(row.contract_id),
      contract_number: text(row.contract_number),
      customer_name: text(row.customer_name),
      plan_name: text(row.plan_name),
      end_date: text(row.end_date),
      updated_at: text(row.updated_at),
      expected_value: expectedValue,
    };
    if (documents.length === 0) return { ...base, status: "no_document" as const };
    const key = documents.join("|");
    if (!byPerson.has(key)) byPerson.set(key, personSubscriptions(documents, deps));
    try {
      return { ...base, ...classify(await byPerson.get(key)!, expectedValue) };
    } catch (lookupError) {
      if (!(lookupError instanceof AsaasApiError)) throw lookupError;
      return { ...base, status: "asaas_error" as const };
    }
  });

  return {
    checked: results.length,
    found: results.filter((result) => result.status === "subscription").length,
    results,
  };
}

export type EnableFromSubscriptionResult =
  | { ok: true; contract: unknown }
  | { ok: false; code: "not_eligible" | "subscription_changed"; message: string };

// Confere de novo no Asaas e só então liga a automática com a assinatura.
export async function enableAutoRenewalFromSubscription(
  supabase: SupabaseClient,
  options: {
    contractId: string;
    subscriptionId: string;
    actorId: string | null;
    deps?: SubscriptionCheckDeps;
  },
): Promise<EnableFromSubscriptionResult> {
  const check = await checkAutoRenewalSubscriptions(supabase, {
    contractIds: [options.contractId],
    deps: options.deps,
  });
  const result = check.results[0];
  if (!result) {
    return {
      ok: false,
      code: "not_eligible",
      message: "Este contrato não está mais na lista de planos mensais sem renovação automática. Atualize a conferência.",
    };
  }
  if (result.status !== "subscription" || result.subscription?.id !== options.subscriptionId) {
    return {
      ok: false,
      code: "subscription_changed",
      message: "A assinatura não confere mais no Asaas. Consulte de novo.",
    };
  }
  const { data, error } = await supabase.rpc("enable_assessment_auto_renewal_from_subscription", {
    p_contract_id: options.contractId,
    p_subscription_id: options.subscriptionId,
    p_actor_id: options.actorId,
  });
  if (error) throw error;
  return { ok: true, contract: (data as Record<string, unknown> | null)?.contract ?? null };
}
