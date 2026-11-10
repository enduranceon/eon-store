import { createPanelLoader } from "./panel-source.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// deno-lint-ignore no-explicit-any
type Row = any;

const CONTRACTS: Row[] = [
  { id: "a", customer_id: "c1", coach_id: "k1", plan_id: "run", status: "active", payment_status: "paid", start_date: "2026-01-01", end_date: "2027-01-01", created_at: "2026-01-01T12:00:00Z" },
  { id: "b", customer_id: "c2", coach_id: "k2", plan_id: "run", status: "active", payment_status: "paid", start_date: "2026-01-01", end_date: "2027-01-01", created_at: "2026-01-01T12:00:00Z" },
];
const PLANS: Row[] = [{ id: "run", name: "Corrida - Mensal", modality_id: "m-run", period_months: 1, price_monthly: 300, price_total: 300 }];

function fakeClient(options: { failContractsOnce?: boolean } = {}) {
  const stats = { contractReads: 0, nameRequests: [] as string[][] };
  const reads = () => stats.contractReads;
  let failures = options.failContractsOnce ? 1 : 0;
  function query(table: string) {
    const state: { cursor: string | null; ids: string[] | null } = { cursor: null, ids: null };
    const builder = {
      select: () => builder,
      order: () => builder,
      limit: () => builder,
      eq: () => builder,
      gt: (_column: string, value: string) => { state.cursor = value; return builder; },
      in: (_column: string, ids: string[]) => { state.ids = ids; return builder; },
      // deno-lint-ignore no-explicit-any
      then(resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(run()).then(resolve, reject);
      },
    };
    function run() {
      if (table === "assessment_contracts") {
        if (state.cursor) return { data: [], error: null };
        stats.contractReads += 1;
        if (failures > 0) { failures -= 1; return { data: null, error: { code: "XX000", message: "falha" } }; }
        return { data: CONTRACTS, error: null };
      }
      if (table === "assessment_plans") return { data: state.cursor ? [] : PLANS, error: null };
      if (table === "assessment_modalities") return { data: [{ id: "m-run", name: "Corrida" }], error: null };
      if (table === "presale_customers") {
        stats.nameRequests.push(state.ids ?? []);
        const all: Record<string, string> = { c1: "Ana Souza", c2: "Pessoa De Outro Coach" };
        return { data: (state.ids ?? []).filter((id) => all[id]).map((id) => ({ id, full_name: all[id] })), error: null };
      }
      return { data: [], error: null };
    }
    return builder;
  }
  return { client: { from: query }, stats, reads };
}

// 2026-11-10T01:10:00Z = 22h10 de 09/11 em Brasília.
const CLOCK_START = Date.parse("2026-11-10T01:10:00Z");

Deno.test("o painel usa o dia de Brasília e traz só o que é do coach", async () => {
  const { client, stats } = fakeClient();
  const load = createPanelLoader(client, { clock: () => CLOCK_START });
  // deno-lint-ignore no-explicit-any
  const panel = await load("k1") as any;
  assert(panel.today === "2026-11-09", "hoje é o dia de Brasília, não o de UTC");
  assert(panel.students.length === 1 && panel.students[0].name === "Ana Souza", "só o aluno do coach");
  assert(panel.students[0].modality === "Corrida", "nome da modalidade");
  assert(!JSON.stringify(panel).includes("Pessoa De Outro Coach"), "nada de outro coach");
  assert(stats.nameRequests.length === 1 && stats.nameRequests[0].join() === "c1", "só os nomes dos alunos do coach são pedidos");
});

Deno.test("os contratos ficam em memória pelo prazo e voltam a ser lidos depois dele", async () => {
  const { client, reads } = fakeClient();
  let now = CLOCK_START;
  const load = createPanelLoader(client, { ttlMs: 60_000, clock: () => now });
  await load("k1");
  now += 30_000;
  await load("k2");
  assert(reads() === 1, "dentro do prazo, uma leitura só");
  now += 31_000;
  await load("k1");
  assert(reads() === 2, "depois do prazo, lê de novo");
});

Deno.test("chamadas ao mesmo tempo dividem uma única leitura", async () => {
  const { client, reads } = fakeClient();
  const load = createPanelLoader(client, { clock: () => CLOCK_START });
  await Promise.all([load("k1"), load("k2"), load("k1")]);
  assert(reads() === 1, "uma leitura para três chamadas");
});

Deno.test("uma falha na leitura não fica guardada: a próxima chamada tenta de novo", async () => {
  const { client, reads } = fakeClient({ failContractsOnce: true });
  const load = createPanelLoader(client, { clock: () => CLOCK_START });
  let failed = false;
  try { await load("k1"); } catch { failed = true; }
  assert(failed, "a primeira chamada falha");
  // deno-lint-ignore no-explicit-any
  const panel = await load("k1") as any;
  assert(panel.students.length === 1, "a segunda funciona");
  assert(reads() === 2, "leu de novo depois da falha");
});
