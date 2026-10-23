import { handleSubscriptionLinkRequest } from "./subscription-link.ts";
import {
  expectedContractValue,
  paymentMethodFor,
  pickSubscriptionInvoice,
  type SubscriptionLinkDeps,
  syncSubscriptionInvoiceLinks,
} from "../_shared/asaas-subscription-link.ts";
import { AsaasApiError } from "../_shared/asaas.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Row = Record<string, unknown>;

// Banco simulado: só o que a busca usa (select com filtros simples e rpc).
function fakeDatabase(tables: Record<string, Row[]>) {
  const rpcCalls: Array<{ name: string; args: Row }> = [];
  class Query {
    private filters: Array<(row: Row) => boolean> = [];
    constructor(private table: string) {}
    select() { return this; }
    order() { return this; }
    limit() { return this; }
    eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
    in(column: string, values: unknown[]) { this.filters.push((row) => values.includes(row[column])); return this; }
    is(column: string, value: null) { this.filters.push((row) => (row[column] ?? null) === value); return this; }
    not(column: string, _op: string, value: null) { this.filters.push((row) => (row[column] ?? null) !== value); return this; }
    private rows() { return (tables[this.table] ?? []).filter((row) => this.filters.every((filter) => filter(row))); }
    maybeSingle() { return Promise.resolve({ data: this.rows()[0] ?? null, error: null }); }
    then(resolve: (value: { data: Row[]; error: null }) => unknown) { return Promise.resolve({ data: this.rows(), error: null }).then(resolve); }
  }
  return {
    rpcCalls,
    client: {
      from: (table: string) => new Query(table),
      rpc(name: string, args: Row) {
        rpcCalls.push({ name, args });
        const attach = ["attached", "value_mismatch"].includes(String(args.p_status));
        return Promise.resolve({ data: { attached: attach }, error: null });
      },
    },
  };
}

const PERSON = "00000000-0000-4000-8000-000000000001";
const PARENT = "00000000-0000-4000-8000-000000000010";
const RENEWAL = "00000000-0000-4000-8000-000000000011";
const snapshot = { period: "mensal", price_total: 300 };

function scenario(overrides: { renewal?: Row; parent?: Row; person?: Row } = {}) {
  return fakeDatabase({
    presale_customers: [{ id: PERSON, cpf: "529.982.247-25", cnpj: null, ...overrides.person }],
    assessment_contracts: [
      {
        id: PARENT, contract_number: "ASS-TESTE-10", customer_id: PERSON, parent_contract_id: null,
        start_date: "2026-10-05", due_date: "2026-10-05", plan_snapshot: snapshot, payment_method: "pix",
        external_payment_link: "https://www.asaas.com/i/prevcode123", auto_renewal: true, status: "active",
        payment_status: "paid", asaas_charge_id: null, ...overrides.parent,
      },
      {
        id: RENEWAL, contract_number: "ASS-TESTE-11", customer_id: PERSON, parent_contract_id: PARENT,
        start_date: "2026-11-05", due_date: null, plan_snapshot: snapshot, payment_method: "pix",
        external_payment_link: null, auto_renewal: true, status: "scheduled", payment_status: "awaiting_charge",
        asaas_charge_id: null, asaas_subscription_id: null, ...overrides.renewal,
      },
    ],
  });
}

function asaas(overrides: Partial<SubscriptionLinkDeps> = {}, next: Row = {}): SubscriptionLinkDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getPayment: (id) => {
      calls.push(`payment:${id}`);
      return Promise.resolve({ found: true, status: "RECEIVED", payment: { id, subscription: "sub_abc123" } });
    },
    getSubscriptionPayments: (id) => {
      calls.push(`subscription:${id}`);
      return Promise.resolve([
        { id: "pay_prevcode123", invoiceUrl: "https://www.asaas.com/i/prevcode123", dueDate: "2026-10-05", status: "RECEIVED", value: 300, customer: "cus_1" },
        { id: "pay_nextcode456", invoiceUrl: "https://www.asaas.com/i/nextcode456", dueDate: "2026-11-05", status: "PENDING", value: 300, billingType: "BOLETO", customer: "cus_1", invoiceNumber: 999, ...next },
      ]);
    },
    getCustomer: (id) => {
      calls.push(`customer:${id}`);
      return Promise.resolve({ id, cpfCnpj: "52998224725" });
    },
    ...overrides,
  };
}

Deno.test("the renewal gets this month's invoice from the Asaas subscription", async () => {
  const db = scenario();
  const deps = asaas();
  const result = await syncSubscriptionInvoiceLinks(db.client as never, { actorId: "actor-1", deps });

  assert(result.checked === 1 && result.attached === 1, "the renewal was not attached");
  assert(deps.calls.includes("payment:pay_prevcode123"), "the subscription did not come from the previous invoice");
  assert(deps.calls.includes("subscription:sub_abc123"), "the subscription invoices were not listed");
  const call = db.rpcCalls[0];
  assert(call.name === "apply_assessment_subscription_lookup", "wrong RPC");
  assert(call.args.p_contract_id === RENEWAL && call.args.p_status === "attached", "wrong status");
  assert(call.args.p_subscription_id === "sub_abc123" && call.args.p_actor_id === "actor-1", "wrong subscription or actor");
  const invoice = call.args.p_invoice as Row;
  assert(invoice.link === "https://www.asaas.com/i/nextcode456", "the previous month's invoice was picked");
  assert(invoice.due_date === "2026-11-05" && invoice.payment_method === "boleto" && invoice.invoice_number === "999", "invoice data was not forwarded");
});

Deno.test("a stored subscription skips the lookup of the previous invoice", async () => {
  const db = scenario({ parent: { asaas_subscription_id: "sub_stored999" } });
  const deps = asaas();
  await syncSubscriptionInvoiceLinks(db.client as never, { deps });
  assert(!deps.calls.some((call) => call.startsWith("payment:")), "the previous invoice was looked up again");
  assert(deps.calls.includes("subscription:sub_stored999"), "the stored subscription was not used");
});

Deno.test("a different value still attaches, with a warning", async () => {
  const db = scenario();
  await syncSubscriptionInvoiceLinks(db.client as never, { deps: asaas({}, { value: 280 }) });
  const call = db.rpcCalls[0];
  assert(call.args.p_status === "value_mismatch", "a different value was not flagged");
  assert(String(call.args.p_note).includes("280,00") && String(call.args.p_note).includes("300,00"), "the warning does not show both values");
  assert((call.args.p_invoice as Row).link === "https://www.asaas.com/i/nextcode456", "the link was not attached");
});

Deno.test("another person's subscription is not attached", async () => {
  const db = scenario();
  await syncSubscriptionInvoiceLinks(db.client as never, {
    deps: asaas({ getCustomer: (id) => Promise.resolve({ id, cpfCnpj: "11144477735" }) }),
  });
  const call = db.rpcCalls[0];
  assert(call.args.p_status === "customer_mismatch" && call.args.p_invoice === null, "a mismatching document was attached");
});

Deno.test("the company CNPJ registered for the person is accepted", async () => {
  const db = scenario({ person: { cnpj: "11.222.333/0001-81" } });
  await syncSubscriptionInvoiceLinks(db.client as never, {
    deps: asaas({ getCustomer: (id) => Promise.resolve({ id, cpfCnpj: "11222333000181" }) }),
  });
  assert(db.rpcCalls[0].args.p_status === "attached", "the CNPJ was not accepted");
});

Deno.test("without this month's invoice yet, it waits and says why", async () => {
  const db = scenario();
  await syncSubscriptionInvoiceLinks(db.client as never, {
    deps: asaas({}, { dueDate: "2027-01-05" }),
  });
  const call = db.rpcCalls[0];
  assert(call.args.p_status === "waiting_invoice" && call.args.p_invoice === null, "an invoice far from the month was attached");
  assert(call.args.p_subscription_id === "sub_abc123", "the subscription found was not kept");
});

Deno.test("a previous invoice outside a subscription asks for the link once", async () => {
  const db = scenario();
  await syncSubscriptionInvoiceLinks(db.client as never, {
    deps: asaas({ getPayment: (id) => Promise.resolve({ found: true, status: "RECEIVED", payment: { id } }) }),
  });
  assert(db.rpcCalls[0].args.p_status === "no_subscription", "a loose invoice was treated as a subscription");
});

Deno.test("an Asaas failure is recorded and the next renewal is still checked", async () => {
  const db = fakeDatabase({
    presale_customers: [{ id: PERSON, cpf: "52998224725" }],
    assessment_contracts: [
      { id: PARENT, customer_id: PERSON, parent_contract_id: null, due_date: "2026-10-05", external_payment_link: "https://www.asaas.com/i/prevcode123" },
      { id: RENEWAL, customer_id: PERSON, parent_contract_id: PARENT, start_date: "2026-11-05", plan_snapshot: snapshot,
        external_payment_link: null, auto_renewal: true, status: "scheduled", payment_status: "awaiting_charge", asaas_charge_id: null },
      { id: "00000000-0000-4000-8000-000000000012", customer_id: PERSON, parent_contract_id: PARENT, start_date: "2026-11-06",
        plan_snapshot: snapshot, external_payment_link: null, auto_renewal: true, status: "scheduled", payment_status: "pending", asaas_charge_id: null },
    ],
  });
  let first = true;
  const deps = asaas({
    getSubscriptionPayments: () => {
      if (first) {
        first = false;
        return Promise.reject(new AsaasApiError("fora do ar", 502));
      }
      return Promise.resolve([]);
    },
  });
  const result = await syncSubscriptionInvoiceLinks(db.client as never, { deps });
  assert(result.checked === 2, "the failure stopped the other renewals");
  assert(db.rpcCalls[0].args.p_status === "asaas_error", "the failure was not recorded");
  assert(db.rpcCalls[1].args.p_status === "waiting_invoice", "the second renewal was not checked");
});

Deno.test("renewals that already have a link or are not automatic are not checked", async () => {
  const db = scenario({ renewal: { external_payment_link: "https://www.asaas.com/i/already0001" } });
  const result = await syncSubscriptionInvoiceLinks(db.client as never, { deps: asaas() });
  assert(result.checked === 0 && db.rpcCalls.length === 0, "a renewal with link was checked");
  const manual = scenario({ renewal: { auto_renewal: false } });
  assert((await syncSubscriptionInvoiceLinks(manual.client as never, { deps: asaas() })).checked === 0, "a manual renewal was checked");
});

Deno.test("the closest unused invoice of the month wins", () => {
  const used = new Set(["usedcode001"]);
  const pick = pickSubscriptionInvoice([
    { id: "pay_usedcode001", dueDate: "2026-11-05", status: "PENDING" },
    { id: "pay_deleted0001", dueDate: "2026-11-05", status: "PENDING", deleted: true },
    { id: "pay_refunded001", dueDate: "2026-11-05", status: "REFUNDED" },
    { id: "pay_farfrom0001", dueDate: "2026-12-05", status: "PENDING" },
    { id: "pay_closest0001", dueDate: "2026-11-07", status: "OVERDUE" },
    { id: "pay_further0001", dueDate: "2026-11-15", status: "PENDING" },
  ], "2026-11-05", used);
  assert(pick?.id === "pay_closest0001", `wrong invoice: ${pick?.id}`);
  assert(pickSubscriptionInvoice([], "2026-11-05", used) === null, "an empty subscription returned an invoice");
});

Deno.test("method and value follow the Asaas invoice and the contract", () => {
  assert(paymentMethodFor({ billingType: "PIX" }, "boleto") === "pix", "PIX");
  assert(paymentMethodFor({ billingType: "BOLETO" }, "pix") === "boleto", "boleto");
  assert(paymentMethodFor({ billingType: "CREDIT_CARD" }, "pix") === "card_1x", "card");
  assert(paymentMethodFor({ billingType: "UNDEFINED" }, "card_3x") === "card_3x", "undefined keeps the contract method");
  assert(paymentMethodFor({ billingType: "UNDEFINED" }, null) === "pix", "undefined without method falls back to PIX");
  assert(expectedContractValue({ plan_snapshot: { price_total: 300 }, manual_discount: 30, enrollment_fee: 0 }) === 270, "discount");
});

Deno.test("the button route validates, needs Asaas configured and returns the results", async () => {
  const db = scenario();
  const post = (body: unknown, configured = true) =>
    handleSubscriptionLinkRequest(
      new Request("https://example.test/renewals/subscription-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      "/renewals/subscription-link",
      db.client as never,
      "actor-1",
      { deps: asaas(), configured },
    );

  for (const body of [{}, { contract_ids: [] }, { contract_ids: ["x"] }, { contract_ids: [RENEWAL], extra: 1 }]) {
    const rejected = await post(body);
    assert(rejected?.status === 400, `invalid body accepted: ${JSON.stringify(body)}`);
  }
  assert((await post({ contract_ids: [RENEWAL] }, false))?.status === 503, "an unconfigured Asaas was not reported");
  assert(db.rpcCalls.length === 0, "an invalid request reached the database");

  const response = await post({ contract_ids: [RENEWAL] });
  assert(response?.status === 200, "the button request failed");
  const body = await response!.json();
  assert(body.data.attached === 1 && body.data.results[0].status === "attached", "the result was not returned");

  const other = await handleSubscriptionLinkRequest(
    new Request("https://example.test/renewals/other", { method: "POST" }),
    "/renewals/other",
    db.client as never,
    "actor-1",
  );
  assert(other === null, "another path was handled");
});
