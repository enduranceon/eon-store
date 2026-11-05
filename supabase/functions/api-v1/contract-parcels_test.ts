import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import {
  handleContractParcelsRequest,
  parcelFacts,
  type ParcelsDeps,
} from "./contract-parcels.ts";
import { AsaasApiError } from "../_shared/asaas.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Row = Record<string, unknown>;

const CONTRACT = "00000000-0000-4000-8000-0000000000a1";
const PERSON = "00000000-0000-4000-8000-0000000000b1";
const PARCEL_1 = "00000000-0000-4000-8000-0000000000c1";
const PARCEL_2 = "00000000-0000-4000-8000-0000000000c2";
const ACTOR = "00000000-0000-4000-8000-0000000000ff";
const VERSION = "2026-11-05T12:00:00.000Z";
const LINK = "https://www.asaas.com/i/aaa111";

// Banco simulado: select com igualdade, maybeSingle e rpc gravado.
function fakeDatabase(
  tables: Record<string, Row[]>,
  rpcResult: (name: string, args: Row) => { data: unknown; error: unknown } = () => ({
    data: { contract: { updated_at: VERSION }, parcels: [] },
    error: null,
  }),
) {
  const rpcCalls: Array<{ name: string; args: Row }> = [];
  class Query {
    private filters: Array<(row: Row) => boolean> = [];
    constructor(private table: string) {}
    select() {
      return this;
    }
    eq(column: string, value: unknown) {
      this.filters.push((row) => row[column] === value);
      return this;
    }
    private rows() {
      return (tables[this.table] ?? []).filter((row) =>
        this.filters.every((filter) => filter(row))
      );
    }
    maybeSingle() {
      return Promise.resolve({ data: this.rows()[0] ?? null, error: null });
    }
    then(resolve: (value: { data: Row[]; error: null }) => unknown) {
      return Promise.resolve({ data: this.rows(), error: null }).then(resolve);
    }
  }
  return {
    rpcCalls,
    client: {
      from: (table: string) => new Query(table),
      rpc(name: string, args: Row) {
        rpcCalls.push({ name, args });
        return Promise.resolve(rpcResult(name, args));
      },
    } as unknown as SupabaseClient,
  };
}

function asaasPayment(
  id: string,
  number: number,
  dueDate: string,
  extra: Row = {},
): Row {
  return {
    id,
    installment: "ins-abc123",
    installmentNumber: number,
    customer: "cus_000001",
    value: 200,
    dueDate,
    status: "PENDING",
    billingType: "BOLETO",
    invoiceUrl: `https://www.asaas.com/i/${id.slice(4)}`,
    ...extra,
  };
}

function baseInstallment(extra: Row[] = [{}, {}, {}]): Row[] {
  return [
    asaasPayment("pay_aaa111", 1, "2026-11-10", extra[0]),
    asaasPayment("pay_bbb222", 2, "2026-12-10", extra[1]),
    asaasPayment("pay_ccc333", 3, "2027-01-10", extra[2]),
  ];
}

function fakeDeps(
  payments: Row[],
  options: { cpf?: string; single?: boolean } = {},
): ParcelsDeps {
  const calls = { payment: 0, installment: 0, customer: 0 };
  const deps = {
    calls,
    getPayment(id: string) {
      calls.payment += 1;
      const found = payments.find((payment) => payment.id === id);
      if (options.single && found) {
        const { installment: _omit, ...single } = found;
        return Promise.resolve({ found: true, status: "PENDING", payment: single });
      }
      return Promise.resolve(
        found
          ? { found: true, status: String(found.status), payment: found }
          : { found: false },
      );
    },
    getInstallmentPayments() {
      calls.installment += 1;
      return Promise.resolve(payments);
    },
    getCustomer() {
      calls.customer += 1;
      return Promise.resolve({ cpfCnpj: options.cpf ?? "529.982.247-25" });
    },
  };
  return deps as unknown as ParcelsDeps & { calls: typeof calls };
}

function tables(contract: Row = {}, parcels: Row[] = []): Record<string, Row[]> {
  return {
    presale_customers: [{ id: PERSON, cpf: "52998224725", cnpj: null }],
    assessment_contracts: [{
      id: CONTRACT,
      contract_number: "ASS-TESTE-1",
      customer_id: PERSON,
      status: "scheduled",
      payment_status: "charge_sent",
      external_payment_link: LINK,
      plan_snapshot: { price_total: 600 },
      enrollment_fee: 0,
      manual_discount: 0,
      credit_balance: 0,
      updated_at: VERSION,
      ...contract,
    }],
    assessment_contract_parcels: parcels,
  };
}

const storedParcels: Row[] = [
  {
    id: PARCEL_1,
    contract_id: CONTRACT,
    installment_number: 1,
    asaas_payment_id: "pay_aaa111",
    asaas_installment_id: "ins-abc123",
    payment_row_id: null,
  },
  {
    id: PARCEL_2,
    contract_id: CONTRACT,
    installment_number: 2,
    asaas_payment_id: "pay_bbb222",
    asaas_installment_id: "ins-abc123",
    payment_row_id: null,
  },
];

function post(action: string, body: Row = {}, parcelId?: string) {
  const path = parcelId
    ? `/orders/contract/${CONTRACT}/parcels/${parcelId}/${action}`
    : `/orders/contract/${CONTRACT}/parcels/${action}`;
  return {
    path,
    req: new Request(`https://example.test/api-v1${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  };
}

async function call(
  action: string,
  body: Row,
  database: ReturnType<typeof fakeDatabase>,
  deps: ParcelsDeps,
  parcelId?: string,
) {
  const { path, req } = post(action, body, parcelId);
  const response = await handleContractParcelsRequest(
    req,
    path,
    database.client,
    ACTOR,
    { deps, configured: true },
  );
  assert(response, "a rota deveria responder");
  return { status: response.status, json: await response.json() };
}

Deno.test("rotas que não são do carnê passam adiante", async () => {
  const response = await handleContractParcelsRequest(
    new Request("https://example.test/api-v1/orders/contract/x/dates", { method: "POST" }),
    "/orders/contract/x/dates",
    fakeDatabase(tables()).client,
    ACTOR,
  );
  assert(response === null, "outra rota não é do carnê");
});

Deno.test("só POST", async () => {
  const response = await handleContractParcelsRequest(
    new Request("https://example.test/x", { method: "GET" }),
    `/orders/contract/${CONTRACT}/parcels/preview`,
    fakeDatabase(tables()).client,
    ACTOR,
  );
  assert(response?.status === 405, "GET é recusado");
});

Deno.test("parcelFacts guarda só o que o carnê usa e monta o link da parcela", () => {
  const paid = parcelFacts(
    asaasPayment("pay_ddd444", 1, "2026-11-10", {
      status: "RECEIVED",
      clientPaymentDate: "2026-11-05",
      creditDate: "2026-11-06",
      invoiceUrl: "https://evil.example/x",
      nossoNumero: "123",
    }),
    "ins-abc123",
  );
  assert(paid?.asaas_status === "RECEIVED", "status lido");
  assert(paid.paid_date === "2026-11-05" && paid.credit_date === "2026-11-06", "datas da parcela paga");
  assert(
    paid.invoice_url === "https://www.asaas.com/i/ddd444",
    "link fora do Asaas é trocado pelo derivado do código",
  );
  assert(!("nossoNumero" in paid), "campo extra não sai");
  const pending = parcelFacts(
    asaasPayment("pay_eee555", 2, "2026-12-10", { estimatedCreditDate: "2026-12-11" }),
    "ins-abc123",
  );
  assert(pending?.paid_date === null && pending.credit_date === null, "parcela em aberto não tem data de pagamento");
  assert(parcelFacts({ id: "x", value: 10, dueDate: "2026-11-10" }, "ins-abc123") === null, "id inválido é descartado");
  const deleted = parcelFacts(asaasPayment("pay_fff666", 3, "2027-01-10", { deleted: true }), "ins-abc123");
  assert(deleted?.asaas_status === "DELETED", "cobrança removida fica como DELETED");
});

Deno.test("preview lê o parcelamento pelo link do contrato e não grava nada", async () => {
  const database = fakeDatabase(tables());
  const { status, json } = await call("preview", {}, database, fakeDeps(baseInstallment()));
  assert(status === 200, `status ${status}`);
  assert(json.data.installment_id === "ins-abc123", "id do parcelamento");
  assert(json.data.parcels.length === 3, "três parcelas");
  assert(json.data.parcels[0].invoice_url === "https://www.asaas.com/i/aaa111", "cada parcela traz o seu link");
  assert(json.data.total_value === 600 && json.data.contract_total === 600, "soma e valor do contrato");
  assert(json.data.customer_check === "match", "CPF confere");
  assert(json.data.already_imported === false, "ainda não importado");
  assert(json.data.blockers.length === 0, "sem bloqueios");
  assert(database.rpcCalls.length === 0, "preview não grava");
});

Deno.test("preview aceita o link de qualquer parcela e acha as outras", async () => {
  const database = fakeDatabase(tables({ external_payment_link: null }));
  const { status, json } = await call(
    "preview",
    { link: "https://www.asaas.com/i/ccc333" },
    database,
    fakeDeps(baseInstallment()),
  );
  assert(status === 200 && json.data.parcels.length === 3, "achou as três parcelas pela última");
});

Deno.test("preview recusa link que não é de fatura do Asaas", async () => {
  const database = fakeDatabase(tables({ external_payment_link: null }));
  const { status, json } = await call(
    "preview",
    { link: "https://example.test/pay/1" },
    database,
    fakeDeps(baseInstallment()),
  );
  assert(status === 400 && json.code === "unsupported_link", "link inválido");
});

Deno.test("preview avisa quando a cobrança não é parcelada", async () => {
  const database = fakeDatabase(tables());
  const { status, json } = await call(
    "preview",
    {},
    database,
    fakeDeps(baseInstallment(), { single: true }),
  );
  assert(status === 409 && json.code === "not_installment", "não é carnê");
});

Deno.test("preview bloqueia soma diferente do contrato e CPF de outra pessoa", async () => {
  const database = fakeDatabase(tables({ plan_snapshot: { price_total: 570 } }));
  const { status, json } = await call(
    "preview",
    {},
    database,
    fakeDeps(baseInstallment(), { cpf: "111.444.777-35" }),
  );
  assert(status === 200, "preview responde mesmo com bloqueios");
  assert(json.data.customer_check === "mismatch", "CPF diferente");
  assert(json.data.blockers.length === 2, "dois bloqueios");
});

Deno.test("importar manda as parcelas ao banco depois de ler o Asaas de novo", async () => {
  const database = fakeDatabase(tables());
  const deps = fakeDeps(baseInstallment());
  const { status, json } = await call("import", { expected_updated_at: VERSION }, database, deps);
  assert(status === 200, `status ${status}`);
  assert(database.rpcCalls.length === 1, "uma chamada ao banco");
  const rpc = database.rpcCalls[0];
  assert(rpc.name === "import_assessment_contract_parcels", "função de importar");
  assert(rpc.args.p_expected_updated_at === VERSION && rpc.args.p_actor_id === ACTOR, "versão e operador");
  const sent = rpc.args.p_parcels as Row[];
  assert(sent.length === 3 && sent[2].installment_number === 3, "parcelas em ordem");
  assert(json.data.customer_check === "match", "resposta traz a conferência");
});

Deno.test("importar recusa quando há bloqueio e não grava", async () => {
  const database = fakeDatabase(tables());
  const { status, json } = await call(
    "import",
    { expected_updated_at: VERSION },
    database,
    fakeDeps(baseInstallment(), { cpf: "111.444.777-35" }),
  );
  assert(status === 409 && json.code === "import_blocked", "bloqueado");
  assert(database.rpcCalls.length === 0, "nada gravado");
});

Deno.test("importar sem a versão do contrato é pedido inválido", async () => {
  const database = fakeDatabase(tables());
  const { status } = await call("import", {}, database, fakeDeps(baseInstallment()));
  assert(status === 400, "falta a versão");
});

Deno.test("atualizar lê o Asaas pelas parcelas guardadas e chama o banco", async () => {
  const database = fakeDatabase(tables({}, storedParcels));
  const { status, json } = await call("sync", {}, database, fakeDeps(baseInstallment()));
  assert(status === 200, `status ${status}`);
  assert(database.rpcCalls[0].name === "sync_assessment_contract_parcels", "função de atualizar");
  assert(typeof json.data.checked_at === "string", "hora da conferência");
});

Deno.test("atualizar sem carnê importado avisa", async () => {
  const database = fakeDatabase(tables());
  const { status, json } = await call("sync", {}, database, fakeDeps(baseInstallment()));
  assert(status === 409 && json.code === "no_parcels", "sem parcelas");
});

Deno.test("registrar parcela atualiza as situações e depois registra com as datas do Asaas", async () => {
  const database = fakeDatabase(tables({}, storedParcels));
  const deps = fakeDeps(baseInstallment([
    { status: "RECEIVED", clientPaymentDate: "2026-11-05", creditDate: "2026-11-06" },
    {},
    {},
  ]));
  const { status, json } = await call("payment", { expected_updated_at: VERSION }, database, deps, PARCEL_1);
  assert(status === 200, `status ${status}`);
  assert(database.rpcCalls.map((c) => c.name).join() === "sync_assessment_contract_parcels,record_assessment_contract_parcel_payment", "primeiro atualiza, depois registra");
  const record = database.rpcCalls[1].args;
  assert(record.p_parcel_id === PARCEL_1, "parcela certa");
  assert(record.p_payment_date === "2026-11-05" && record.p_credit_date === "2026-11-06", "datas do Asaas");
  assert(json.data.customer_check === "match", "CPF conferido");
});

Deno.test("registrar parcela que o Asaas ainda mostra em aberto é recusado", async () => {
  const database = fakeDatabase(tables({}, storedParcels));
  const { status, json } = await call("payment", { expected_updated_at: VERSION }, database, fakeDeps(baseInstallment()), PARCEL_1);
  assert(status === 409 && json.code === "parcel_not_paid", "parcela em aberto");
  assert(database.rpcCalls.length === 0, "nada gravado");
});

Deno.test("registrar parcela com CPF diferente ou sem conferência é recusado", async () => {
  const paid = baseInstallment([{ status: "CONFIRMED", clientPaymentDate: "2026-11-05" }, {}, {}]);
  const mismatch = await call(
    "payment",
    { expected_updated_at: VERSION },
    fakeDatabase(tables({}, storedParcels)),
    fakeDeps(paid, { cpf: "111.444.777-35" }),
    PARCEL_1,
  );
  assert(mismatch.status === 409 && mismatch.json.code === "customer_mismatch", "CPF de outra pessoa");
  const database = fakeDatabase({
    ...tables({}, storedParcels),
    presale_customers: [{ id: PERSON, cpf: null, cnpj: null }],
  });
  const unknown = await call("payment", { expected_updated_at: VERSION }, database, fakeDeps(paid), PARCEL_1);
  assert(unknown.status === 409 && unknown.json.code === "customer_unknown", "sem CPF na ficha");
  assert(database.rpcCalls.length === 0, "nada gravado");
});

Deno.test("registrar parcela com a versão do contrato desatualizada pede para recarregar", async () => {
  const database = fakeDatabase(tables({}, storedParcels));
  const paid = baseInstallment([{ status: "CONFIRMED", clientPaymentDate: "2026-11-05" }, {}, {}]);
  const { status, json } = await call(
    "payment",
    { expected_updated_at: "2026-11-05T11:00:00.000Z" },
    database,
    fakeDeps(paid),
    PARCEL_1,
  );
  assert(status === 409 && json.code === "conflict", "versão antiga");
  assert(database.rpcCalls.length === 0, "nada gravado");
});

Deno.test("desfazer e remover só falam com o banco, sem consultar o Asaas", async () => {
  const noAsaas = {
    getPayment: () => Promise.reject(new Error("não deveria consultar o Asaas")),
    getInstallmentPayments: () => Promise.reject(new Error("não deveria consultar o Asaas")),
    getCustomer: () => Promise.reject(new Error("não deveria consultar o Asaas")),
  } as unknown as ParcelsDeps;
  const database = fakeDatabase(tables({}, storedParcels));
  const reopen = await call("reopen", { expected_updated_at: VERSION }, database, noAsaas, PARCEL_1);
  const remove = await call("remove", { expected_updated_at: VERSION }, database, noAsaas);
  assert(reopen.status === 200 && remove.status === 200, "as duas respondem");
  assert(
    database.rpcCalls.map((c) => c.name).join() === "reopen_assessment_contract_parcel_payment,remove_assessment_contract_parcels",
    "funções certas",
  );
});

Deno.test("erro de regra do banco volta como conflito com a mensagem", async () => {
  const database = fakeDatabase(tables(), () => ({
    data: null,
    error: { code: "P0001", message: "Há parcela com pagamento registrado." },
  }));
  const { status, json } = await call("remove", { expected_updated_at: VERSION }, database, fakeDeps([]));
  assert(status === 409 && json.code === "conflict" && json.error.includes("parcela"), "conflito");
});

Deno.test("sem configuração do Asaas, preview responde 503", async () => {
  const database = fakeDatabase(tables());
  const { path, req } = post("preview");
  const response = await handleContractParcelsRequest(req, path, database.client, ACTOR, {
    deps: fakeDeps(baseInstallment()),
    configured: false,
  });
  assert(response?.status === 503, "não configurado");
});

Deno.test("falha do Asaas vira 502 sem gravar", async () => {
  const database = fakeDatabase(tables());
  const deps = {
    getPayment: () => Promise.reject(new AsaasApiError("fora do ar", 502, "asaas_lookup_failed")),
    getInstallmentPayments: () => Promise.resolve([]),
    getCustomer: () => Promise.resolve({}),
  } as unknown as ParcelsDeps;
  const { status, json } = await call("preview", {}, database, deps);
  assert(status === 502 && json.code === "asaas_check_failed", "falha do Asaas");
});
