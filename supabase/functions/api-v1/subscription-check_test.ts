import { handleSubscriptionCheckRequest } from "./subscription-check.ts";
import {
  checkAutoRenewalSubscriptions,
  type SubscriptionCheckDeps,
} from "../_shared/asaas-subscription-check.ts";
import { AsaasApiError } from "../_shared/asaas.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Row = Record<string, unknown>;

const CONTRACT_A = "00000000-0000-4000-8000-000000000101";
const CONTRACT_B = "00000000-0000-4000-8000-000000000102";

// Banco simulado: a lista de candidatos e a gravação são RPCs.
function fakeDatabase(candidates: Row[], enableError: Row | null = null) {
  const rpcCalls: Array<{ name: string; args: Row }> = [];
  return {
    rpcCalls,
    client: {
      rpc(name: string, args: Row) {
        rpcCalls.push({ name, args });
        if (name === "list_assessment_auto_renewal_candidates") {
          const ids = args.p_contract_ids as string[] | null;
          return Promise.resolve({
            data: candidates.filter((row) => !ids || ids.includes(String(row.contract_id))),
            error: null,
          });
        }
        if (enableError) return Promise.resolve({ data: null, error: enableError });
        return Promise.resolve({
          data: { contract: { id: args.p_contract_id, auto_renewal: true, asaas_subscription_id: args.p_subscription_id } },
          error: null,
        });
      },
    },
  };
}

function candidate(overrides: Row = {}): Row {
  return {
    contract_id: CONTRACT_A,
    contract_number: "ASS-TESTE-101",
    customer_name: "Pessoa Teste",
    cpf: "529.982.247-25",
    cnpj: null,
    plan_name: "Corrida - Mensal",
    end_date: "2026-11-10",
    updated_at: "2026-10-10T12:00:00+00:00",
    expected_value: 210,
    ...overrides,
  };
}

function subscription(overrides: Row = {}): Row {
  return {
    id: "sub_teste123",
    customer: "cus_1",
    status: "ACTIVE",
    cycle: "MONTHLY",
    value: 210,
    nextDueDate: "2026-11-10",
    billingType: "PIX",
    description: "Assessoria mensal",
    ...overrides,
  };
}

function asaas(
  options: { customers?: Record<string, Row[]>; subscriptions?: Record<string, Row[]> } = {},
): SubscriptionCheckDeps & { calls: string[] } {
  const calls: string[] = [];
  const customers = options.customers ?? { "52998224725": [{ id: "cus_1", cpfCnpj: "52998224725" }] };
  const subscriptions = options.subscriptions ?? { cus_1: [subscription()] };
  return {
    calls,
    findCustomers: (document) => {
      calls.push(`customers:${document}`);
      return Promise.resolve(customers[document] ?? []);
    },
    getCustomerSubscriptions: (customerId) => {
      calls.push(`subscriptions:${customerId}`);
      return Promise.resolve(subscriptions[customerId] ?? []);
    },
  };
}

Deno.test("a monthly contract with one active subscription is found", async () => {
  const db = fakeDatabase([candidate()]);
  const deps = asaas();
  const result = await checkAutoRenewalSubscriptions(db.client as never, { deps });
  assert(result.checked === 1 && result.found === 1, "the subscription was not found");
  const row = result.results[0];
  assert(row.status === "subscription" && row.subscription?.id === "sub_teste123", "wrong result");
  assert(row.subscription.value === 210 && row.subscription.next_due_date === "2026-11-10", "subscription data missing");
  assert(row.customer_name === "Pessoa Teste" && row.expected_value === 210, "contract data missing");
  assert(deps.calls[0] === "customers:52998224725", "the CPF was not searched without punctuation");
  assert(db.rpcCalls.every((call) => call.name === "list_assessment_auto_renewal_candidates"), "the check wrote something");
});

Deno.test("inactive, yearly, deleted or other customers' subscriptions do not count", async () => {
  const db = fakeDatabase([candidate()]);
  const result = await checkAutoRenewalSubscriptions(db.client as never, {
    deps: asaas({
      subscriptions: {
        cus_1: [
          subscription({ id: "sub_inativa1", status: "INACTIVE" }),
          subscription({ id: "sub_anual123", cycle: "YEARLY" }),
          subscription({ id: "sub_apagada1", deleted: true }),
          subscription({ id: "sub_outrocli", customer: "cus_2" }),
        ],
      },
    }),
  });
  assert(result.results[0].status === "no_subscription", "an unusable subscription was taken");
});

Deno.test("without an Asaas customer for the document, it says so", async () => {
  const db = fakeDatabase([candidate()]);
  const result = await checkAutoRenewalSubscriptions(db.client as never, { deps: asaas({ customers: {} }) });
  assert(result.results[0].status === "no_customer", "a missing customer was not reported");
});

Deno.test("a customer returned with another document is ignored", async () => {
  const db = fakeDatabase([candidate()]);
  const result = await checkAutoRenewalSubscriptions(db.client as never, {
    deps: asaas({ customers: { "52998224725": [{ id: "cus_1", cpfCnpj: "11144477735" }] } }),
  });
  assert(result.results[0].status === "no_customer", "another person's customer was used");
});

Deno.test("without CPF or CNPJ, Asaas is not called", async () => {
  const db = fakeDatabase([candidate({ cpf: null })]);
  const deps = asaas();
  const result = await checkAutoRenewalSubscriptions(db.client as never, { deps });
  assert(result.results[0].status === "no_document" && deps.calls.length === 0, "a person without document was searched");
});

Deno.test("the company CNPJ registered for the person is searched too", async () => {
  const db = fakeDatabase([candidate({ cnpj: "11.222.333/0001-81" })]);
  const deps = asaas({
    customers: { "11222333000181": [{ id: "cus_pj", cpfCnpj: "11222333000181" }] },
    subscriptions: { cus_pj: [subscription({ id: "sub_empresa1", customer: "cus_pj" })] },
  });
  const result = await checkAutoRenewalSubscriptions(db.client as never, { deps });
  assert(deps.calls.includes("customers:52998224725") && deps.calls.includes("customers:11222333000181"), "both documents were not searched");
  assert(result.results[0].subscription?.id === "sub_empresa1", "the company subscription was not found");
});

Deno.test("with two subscriptions, the one with the contract value wins; otherwise it asks to check", async () => {
  const two = (secondValue: number) =>
    asaas({ subscriptions: { cus_1: [subscription({ id: "sub_primeira", value: 300 }), subscription({ id: "sub_segunda", value: secondValue })] } });
  const db = fakeDatabase([candidate()]);
  const picked = await checkAutoRenewalSubscriptions(db.client as never, { deps: two(210) });
  assert(picked.results[0].status === "subscription" && picked.results[0].subscription?.id === "sub_segunda", "the matching value was not picked");
  const unclear = await checkAutoRenewalSubscriptions(db.client as never, { deps: two(250) });
  assert(unclear.results[0].status === "multiple" && unclear.results[0].subscriptions?.length === 2, "an unclear case was not flagged");
});

Deno.test("an Asaas failure marks the contract and the others are still checked", async () => {
  const db = fakeDatabase([
    candidate(),
    candidate({ contract_id: CONTRACT_B, contract_number: "ASS-TESTE-102", cpf: "11144477735" }),
  ]);
  const deps = asaas({
    customers: { "11144477735": [{ id: "cus_2", cpfCnpj: "11144477735" }] },
    subscriptions: { cus_2: [subscription({ id: "sub_dois1234", customer: "cus_2" })] },
  });
  deps.findCustomers = (document) => {
    if (document === "52998224725") return Promise.reject(new AsaasApiError("fora do ar", 502));
    return Promise.resolve([{ id: "cus_2", cpfCnpj: "11144477735" }]);
  };
  const result = await checkAutoRenewalSubscriptions(db.client as never, { deps });
  assert(result.results[0].status === "asaas_error", "the failure was not reported");
  assert(result.results[1].status === "subscription" && result.found === 1, "the next contract was not checked");
});

Deno.test("the same person with two contracts is looked up once", async () => {
  const db = fakeDatabase([candidate(), candidate({ contract_id: CONTRACT_B, contract_number: "ASS-TESTE-102" })]);
  const deps = asaas();
  const result = await checkAutoRenewalSubscriptions(db.client as never, { deps });
  assert(result.found === 2, "both contracts should show the subscription");
  assert(deps.calls.filter((call) => call.startsWith("customers:")).length === 1, "the person was searched twice");
});

function request(path: string, body: unknown, method = "POST") {
  return new Request(`https://example.test${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

Deno.test("the check route validates, needs Asaas configured and returns the list", async () => {
  const db = fakeDatabase([candidate()]);
  const call = (body: unknown, options: { configured?: boolean; method?: string } = {}) =>
    handleSubscriptionCheckRequest(
      request("/renewals/subscription-check", body, options.method),
      "/renewals/subscription-check",
      db.client as never,
      "actor-1",
      { deps: asaas(), configured: options.configured ?? true },
    );

  assert((await call({ extra: 1 }))?.status === 400, "an unexpected body was accepted");
  assert((await call({}, { method: "GET" }))?.status === 405, "GET was accepted");
  assert((await call({}, { configured: false }))?.status === 503, "an unconfigured Asaas was not reported");
  assert(db.rpcCalls.length === 0, "an invalid request reached the database");

  const response = await call({});
  assert(response?.status === 200, "the check failed");
  const body = await response!.json();
  assert(body.data.found === 1 && body.data.results[0].subscription.id === "sub_teste123", "the result was not returned");

  const other = await handleSubscriptionCheckRequest(
    request("/renewals/other", {}),
    "/renewals/other",
    db.client as never,
    "actor-1",
  );
  assert(other === null, "another path was handled");
});

Deno.test("enabling checks Asaas again and records the subscription", async () => {
  const db = fakeDatabase([candidate()]);
  const enable = (body: unknown, deps = asaas()) =>
    handleSubscriptionCheckRequest(
      request("/renewals/subscription-check/enable", body),
      "/renewals/subscription-check/enable",
      db.client as never,
      "actor-1",
      { deps, configured: true },
    );

  for (const body of [
    {},
    { contract_id: CONTRACT_A },
    { contract_id: "x", subscription_id: "sub_teste123" },
    { contract_id: CONTRACT_A, subscription_id: "pay_teste123" },
    { contract_id: CONTRACT_A, subscription_id: "sub_teste123", extra: true },
  ]) {
    assert((await enable(body))?.status === 400, `invalid body accepted: ${JSON.stringify(body)}`);
  }

  const changed = await enable({ contract_id: CONTRACT_A, subscription_id: "sub_antiga99" });
  assert(changed?.status === 409 && (await changed.json()).code === "subscription_changed", "a stale subscription was accepted");
  const gone = await enable({ contract_id: CONTRACT_B, subscription_id: "sub_teste123" });
  assert(gone?.status === 409 && (await gone.json()).code === "not_eligible", "a contract outside the list was accepted");
  assert(!db.rpcCalls.some((call) => call.name !== "list_assessment_auto_renewal_candidates"), "a refused request wrote");

  const response = await enable({ contract_id: CONTRACT_A, subscription_id: "sub_teste123" });
  assert(response?.status === 200, "enabling failed");
  const write = db.rpcCalls.find((call) => call.name === "enable_assessment_auto_renewal_from_subscription");
  assert(write?.args.p_contract_id === CONTRACT_A && write.args.p_subscription_id === "sub_teste123", "wrong contract or subscription");
  assert(write.args.p_actor_id === "actor-1", "the actor was not recorded");
  const body = await response!.json();
  assert(body.data.contract.auto_renewal === true, "the contract was not returned");
});

Deno.test("a database refusal comes back as a conflict with its message", async () => {
  const db = fakeDatabase([candidate()], { code: "P0001", message: "Esta assinatura do Asaas já está no contrato de outra pessoa" });
  const response = await handleSubscriptionCheckRequest(
    request("/renewals/subscription-check/enable", { contract_id: CONTRACT_A, subscription_id: "sub_teste123" }),
    "/renewals/subscription-check/enable",
    db.client as never,
    "actor-1",
    { deps: asaas(), configured: true },
  );
  assert(response?.status === 409, "the refusal was not a conflict");
  const body = await response!.json();
  assert(body.error.includes("outra pessoa"), "the message was lost");
});
