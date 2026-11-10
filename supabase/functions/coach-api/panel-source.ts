import {
  loadAssessmentMetricContracts,
  loadAssessmentMetricPlans,
} from "../_shared/assessment-metrics/assessment-metric-data.js";
import {
  computeCoachPanel,
  customerIdsOf,
  presentCoachPanel,
} from "../_shared/assessment-metrics/coach-panel.js";
import { businessDayOf } from "../_shared/assessment-metrics/dates.js";

// Carrega os dados do painel do coach com a chave de serviço e monta o resultado com as
// MESMAS regras do perfil do coach no painel da equipe. Todos os contratos entram na conta
// (quem é entrada, retorno ou renovação depende deles), mas só o resultado do coach logado
// sai daqui, sem ids internos, valores nem contatos (ver coach-panel.js).

// deno-lint-ignore no-explicit-any
type Row = any;

// deno-lint-ignore no-explicit-any
interface Client { from(table: string): any }

interface Source {
  contracts: Row[];
  plans: Row[];
  modalities: Row[];
}

const NAME_CHUNK = 100;

async function loadNames(client: Client, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let index = 0; index < ids.length; index += NAME_CHUNK) {
    const chunk = ids.slice(index, index + NAME_CHUNK);
    const { data, error } = await client.from("presale_customers")
      .select("id, full_name").in("id", chunk);
    if (error) throw error;
    for (const row of (data ?? []) as Row[]) {
      if (row.full_name) names.set(row.id, String(row.full_name));
    }
  }
  return names;
}

export function createPanelLoader(
  client: Client,
  options: { ttlMs?: number; clock?: () => number } = {},
): (coachId: string) => Promise<unknown> {
  const ttlMs = options.ttlMs ?? 60_000;
  const clock = options.clock ?? (() => Date.now());
  let cached: { at: number; source: Source } | null = null;
  let pending: Promise<Source> | null = null;

  function loadSource(): Promise<Source> {
    if (cached && clock() - cached.at < ttlMs) return Promise.resolve(cached.source);
    // Chamadas ao mesmo tempo dividem uma única leitura; uma falha não fica guardada.
    pending ??= (async () => {
      const [contracts, plans, modalitiesResult] = await Promise.all([
        loadAssessmentMetricContracts(client),
        loadAssessmentMetricPlans(client),
        client.from("assessment_modalities").select("id, name"),
      ]);
      if (modalitiesResult.error) throw modalitiesResult.error;
      const source = { contracts, plans, modalities: modalitiesResult.data ?? [] };
      cached = { at: clock(), source };
      return source;
    })().finally(() => {
      pending = null;
    });
    return pending;
  }

  return async (coachId: string) => {
    const { contracts, plans, modalities } = await loadSource();
    // Hoje em Brasília (o servidor roda em UTC): sempre explícito para a conta.
    const today = businessDayOf(new Date(clock()));
    const panel = computeCoachPanel({ coachId, contracts, plans, today });
    const customerNames = await loadNames(client, customerIdsOf(panel));
    const modalityNames = new Map<string, string>(
      modalities.map((row: Row) => [row.id, row.name]),
    );
    return presentCoachPanel(panel, { customerNames, modalityNames });
  };
}
