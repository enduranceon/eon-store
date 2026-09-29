// Cálculo do fechamento de repasse de uma competência, sem acesso ao banco.
// O handler (index.ts) busca as tabelas, chama buildGroupedItems e grava.
//
// Cada dia vigente do contrato na competência tem um plano e um treinador:
//   - plano: assessment_contract_plan_history, a linha com o maior valid_from
//     até o dia (antes da primeira linha, vale a primeira);
//   - treinador: assessment_contract_coach_history, a última linha registrada
//     cujo started_at já chegou (antes de todas, vale a primeira).
// Contrato com uma linha só (ou nenhuma) em um histórico usa o plano ou o
// treinador do próprio contrato, exatamente como antes dos históricos.
//
// Os dias do contrato com o mesmo treinador e a mesma modalidade formam um
// trecho, e cada trecho contribui para os grupos de sempre: treinador + aluno,
// líder + treinador + aluno e co-líder + treinador + aluno. Se dois contratos do
// aluno cobrem o mesmo dia no mesmo grupo, vale o maior valor diário.
//
// No item do fechamento, os dias com a mesma taxa mensal formam um trecho:
// valor = taxa ÷ dias do mês, somado dia a dia e arredondado em centavos. O
// valor do item é a soma dos trechos, para a tela bater centavo a centavo.

export const DAY_MS = 86400000;

// deno-lint-ignore no-explicit-any
type Row = any;

export interface ClosingContext {
  monthStart: Date;
  monthEndExclusive: Date;
  monthDays: number;
  leaves: Row[];
  coaches: Row[];
  plans: Row[];
  modalities: Row[];
  rates: Row[];
  tier: Row | null;
  tierSnapshot: Row | null;
  customersById: Map<string, Row>;
  planHistoryByContract: Map<string, Row[]>;
  coachHistoryByContract: Map<string, Row[]>;
}

export interface PayoutSegment {
  rate: number;
  valid_days: number;
  amount: number;
  first_day: string;
  last_day: string;
  modalities: string[];
}

export function roundCents(value: number) {
  return Math.round(value * 100) / 100;
}

export function parseDateUTC(value: string | null | undefined, fallback: Date) {
  if (!value) return fallback;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return fallback;
  return new Date(Date.UTC(year, month - 1, day));
}

export function dateKeyUTC(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function competenceBounds(competence: string) {
  const monthStart = new Date(competence + "T00:00:00Z");
  const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0));
  const monthEndExclusive = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
  return { monthStart, monthEndExclusive, monthDays: monthEnd.getUTCDate() };
}

export function effectiveEndExclusive(contract: Row, fallback: Date) {
  const start = parseDateUTC(contract.start_date, fallback);
  let endExclusive = parseDateUTC(contract.end_date, fallback);

  if (contract.end_date && endExclusive.getTime() === start.getTime()) {
    endExclusive = new Date(endExclusive.getTime() + DAY_MS);
  }

  if (contract.status === "cancelled" && contract.cancellation_date) {
    const cancellationEndExclusive = new Date(
      parseDateUTC(contract.cancellation_date, fallback).getTime() + DAY_MS,
    );
    if (cancellationEndExclusive < endExclusive) {
      endExclusive = cancellationEndExclusive;
    }
  }

  return endExclusive;
}

export function activeDayKeys(contract: Row, leaves: Row[], monthStart: Date, monthEndExclusive: Date) {
  const start = parseDateUTC(contract.start_date, monthStart);
  const endExclusive = effectiveEndExclusive(contract, monthEndExclusive);

  const current = start > monthStart ? new Date(start) : new Date(monthStart);
  const end = endExclusive < monthEndExclusive ? endExclusive : monthEndExclusive;
  const keys = new Set<string>();

  while (current < end) {
    keys.add(dateKeyUTC(current));
    current.setTime(current.getTime() + DAY_MS);
  }

  for (const leave of leaves.filter((l: Row) => l.contract_id === contract.id)) {
    const leaveStart = parseDateUTC(leave.start_date, monthStart);
    // end_date nulo = licença EM ABERTO (o constraint de assessment_leaves exige
    // days nulo e status 'active' nesse caso). Ela vale até o fim da competência,
    // e volta a valer nos meses seguintes enquanto o aluno não retornar.
    // Antes isto caía no fallback = leaveStart e descontava um único dia: no mês
    // em que a licença começava perdia-se só 1 dia, e nos meses seguintes o aluno
    // voltava a contar integralmente mesmo seguindo afastado.
    const leaveEndExclusive = leave.end_date
      ? new Date(parseDateUTC(leave.end_date, leaveStart).getTime() + DAY_MS)
      : new Date(monthEndExclusive);
    const leaveCurrent = leaveStart > monthStart ? new Date(leaveStart) : new Date(monthStart);
    const leaveLimit = leaveEndExclusive < monthEndExclusive ? leaveEndExclusive : monthEndExclusive;

    while (leaveCurrent < leaveLimit) {
      keys.delete(dateKeyUTC(leaveCurrent));
      leaveCurrent.setTime(leaveCurrent.getTime() + DAY_MS);
    }
  }

  return [...keys];
}

function dayOf(value: string) {
  return String(value).slice(0, 10);
}

// Plano de cada dia. Devolve { plan_id, plan_snapshot }.
export function planSourceByDay(contract: Row, historyRows: Row[] | undefined) {
  const rows = (historyRows || [])
    .filter((row: Row) => row.plan_id && row.valid_from)
    .sort((a: Row, b: Row) => dayOf(a.valid_from).localeCompare(dayOf(b.valid_from)));

  if (rows.length <= 1) {
    const own = { plan_id: contract.plan_id, plan_snapshot: contract.plan_snapshot };
    return (_dayKey: string) => own;
  }

  return (dayKey: string) => {
    let current = rows[0];
    for (const row of rows) {
      if (dayOf(row.valid_from) > dayKey) break;
      current = row;
    }
    return { plan_id: current.plan_id, plan_snapshot: current.plan_snapshot };
  };
}

// Ordem de registro das trocas de treinador. No mesmo instante, a linha já
// encerrada veio antes da que ficou aberta.
function compareCoachRows(a: Row, b: Row) {
  const byCreated = String(a.created_at || "").localeCompare(String(b.created_at || ""));
  if (byCreated) return byCreated;
  const openA = a.ended_at == null ? 1 : 0;
  const openB = b.ended_at == null ? 1 : 0;
  if (openA !== openB) return openA - openB;
  const byStart = dayOf(a.started_at).localeCompare(dayOf(b.started_at));
  if (byStart) return byStart;
  return String(a.id || "").localeCompare(String(b.id || ""));
}

// Treinador de cada dia: a troca registrada por último já em vigor naquele
// dia. Uma troca registrada depois vale por cima das anteriores a partir do
// started_at dela, inclusive quando foi feita antes do contrato começar.
export function coachIdByDay(contract: Row, historyRows: Row[] | undefined) {
  const rows = (historyRows || [])
    .filter((row: Row) => row.coach_id && row.started_at)
    .sort(compareCoachRows);

  if (rows.length <= 1) {
    return (_dayKey: string) => contract.coach_id as string;
  }

  return (dayKey: string) => {
    let current = rows[0];
    for (const row of rows) {
      if (dayOf(row.started_at) <= dayKey) current = row;
    }
    return current.coach_id as string;
  };
}

function modalityIdOf(planSource: Row, plans: Row[]) {
  return planSource.plan_snapshot?.modality_id
    || plans.find((p: Row) => p.id === planSource.plan_id)?.modality_id;
}

// Dias do contrato agrupados por treinador e modalidade, na ordem do primeiro dia.
export function contractSlices(contract: Row, dayKeys: string[], ctx: ClosingContext) {
  const planOf = planSourceByDay(contract, ctx.planHistoryByContract.get(contract.id));
  const coachOf = coachIdByDay(contract, ctx.coachHistoryByContract.get(contract.id));
  const slices = new Map<string, { coachId: string; modalityId: string; dayKeys: string[] }>();

  for (const dayKey of dayKeys) {
    const coachId = coachOf(dayKey);
    const modalityId = modalityIdOf(planOf(dayKey), ctx.plans);
    const key = `${coachId}|${modalityId}`;
    if (!slices.has(key)) slices.set(key, { coachId, modalityId, dayKeys: [] });
    slices.get(key)!.dayKeys.push(dayKey);
  }

  return [...slices.values()];
}

interface ContributionPayload {
  coach_id: string;
  source_type: string;
  contract: Row;
  descriptionBase: string;
  modalityName: string;
  dayKeys: string[];
  monthDays: number;
  dailyAmount: number;
  rateApplied: number;
  tierSnapshot: Row | null;
}

function addContribution(groups: Map<string, Row>, key: string, payload: ContributionPayload) {
  if (!groups.has(key)) {
    groups.set(key, {
      coach_id: payload.coach_id,
      source_type: payload.source_type,
      contract_id: payload.contract.id,
      descriptionBase: payload.descriptionBase,
      month_days: payload.monthDays,
      tier_applied: payload.tierSnapshot,
      contracts: new Set<string>(),
      modalities: new Set<string>(),
      dailyValues: new Map<string, { daily: number; rate: number; modalityName: string }>(),
      rateValues: new Set<number>(),
    });
  }

  const group = groups.get(key);
  group.contracts.add(payload.contract.contract_number || payload.contract.id);
  group.modalities.add(payload.modalityName);
  group.rateValues.add(payload.rateApplied);

  for (const dayKey of payload.dayKeys) {
    const current = group.dailyValues.get(dayKey);
    if (!current || payload.dailyAmount > current.daily) {
      group.dailyValues.set(dayKey, {
        daily: payload.dailyAmount,
        rate: payload.rateApplied,
        modalityName: payload.modalityName,
      });
    }
  }
}

// Um trecho por taxa mensal, na ordem do primeiro dia.
function groupSegments(group: Row): PayoutSegment[] {
  const byRate = new Map<number, { daily: number; days: string[]; modalities: Set<string> }>();
  for (const [dayKey, value] of group.dailyValues as Map<string, Row>) {
    if (!byRate.has(value.rate)) {
      byRate.set(value.rate, { daily: value.daily, days: [], modalities: new Set<string>() });
    }
    const segment = byRate.get(value.rate)!;
    segment.days.push(dayKey);
    if (value.modalityName) segment.modalities.add(value.modalityName);
  }

  return [...byRate.entries()].map(([rate, segment]) => {
    // Soma dia a dia, como o fechamento sempre fez: o mês inteiro no mesmo
    // plano continua pagando exatamente a taxa mensal.
    let total = 0;
    for (let i = 0; i < segment.days.length; i++) total += segment.daily;
    const days = [...segment.days].sort();
    return {
      rate,
      valid_days: days.length,
      amount: roundCents(total),
      first_day: days[0],
      last_day: days[days.length - 1],
      modalities: [...segment.modalities],
    };
  }).sort((a, b) => a.first_day.localeCompare(b.first_day));
}

function finalizeGroups(groups: Map<string, Row>) {
  return [...groups.values()].map((group: Row) => {
    const segments = groupSegments(group);
    const amount = segments.length === 1
      ? segments[0].amount
      : roundCents(segments.reduce((s, segment) => s + segment.amount, 0));
    const validDays = group.dailyValues.size;
    const prorata = validDays / group.month_days;
    const rateValues = [...group.rateValues];
    const effectiveRate = rateValues.length === 1
      ? rateValues[0]
      : roundCents(prorata > 0 ? amount / prorata : 0);
    const contractNumbers = [...group.contracts].join(", ");
    const modalitiesList = [...group.modalities].filter(Boolean);
    const modalityLabel = modalitiesList.length > 1
      ? `${modalitiesList[0]} +${modalitiesList.length - 1}`
      : modalitiesList[0] || "Assessoria";

    return {
      coach_id: group.coach_id,
      source_type: group.source_type,
      contract_id: group.contract_id,
      description: `${group.descriptionBase} — ${modalityLabel} (${contractNumbers})`,
      amount,
      valid_days: validDays,
      month_days: group.month_days,
      prorata_factor: prorata,
      rate_applied: effectiveRate,
      tier_applied: group.tier_applied,
      base_value: effectiveRate,
      leadership_bonus: group.source_type === "athlete_repasse" ? 0 : effectiveRate,
      segments,
    };
  }).filter((item: Row) => item.valid_days > 0 && item.amount > 0);
}

// Agrupa as contribuições de repasse de uma lista de contratos (atleta +
// liderança + co-liderança).
export function buildGroupedItems(contractList: Row[], ctx: ClosingContext) {
  const { monthDays, tier, tierSnapshot } = ctx;
  const groups = new Map<string, Row>();

  for (const contract of contractList) {
    const contractDayKeys = activeDayKeys(contract, ctx.leaves, ctx.monthStart, ctx.monthEndExclusive);
    if (contractDayKeys.length <= 0) continue;

    const studentName = ctx.customersById.get(contract.customer_id)?.full_name
      || contract.contract_number || "Aluno";

    for (const slice of contractSlices(contract, contractDayKeys, ctx)) {
      const dayKeys = slice.dayKeys;

      const coach = ctx.coaches.find((c: Row) => c.id === slice.coachId);
      if (!coach) continue;

      const modality = ctx.modalities.find((m: Row) => m.id === slice.modalityId);
      if (!modality) continue;

      const rate = ctx.rates.find((r: Row) => r.role === coach.role && r.modality_id === modality.id);
      if (!rate) continue;

      const rateValue = Number(rate.rate) || 0;
      const tierIncrement = Number(tier?.increment_per_athlete || 0);
      const baseRate = rateValue + tierIncrement;

      addContribution(groups, `athlete_repasse:${coach.id}:${contract.customer_id || contract.id}`, {
        coach_id: coach.id, source_type: "athlete_repasse", contract,
        descriptionBase: studentName, modalityName: modality.name, dayKeys, monthDays,
        dailyAmount: baseRate / monthDays, rateApplied: baseRate, tierSnapshot,
      });

      const leadershipBonus = Number(tier?.leadership_bonus || 0);
      if (coach.leader_id && leadershipBonus > 0) {
        addContribution(groups, `direct_leadership:${coach.leader_id}:${coach.id}:${contract.customer_id || contract.id}`, {
          coach_id: coach.leader_id, source_type: "direct_leadership", contract,
          descriptionBase: `Liderança sobre ${coach.name} — ${studentName}`, modalityName: modality.name, dayKeys, monthDays,
          dailyAmount: leadershipBonus / monthDays, rateApplied: leadershipBonus, tierSnapshot,
        });
      }

      const coLeadershipBonus = Number(tier?.co_leadership_bonus || 0);
      for (const coLeaderId of (coach.co_leader_ids || [])) {
        if (coLeadershipBonus > 0) {
          addContribution(groups, `co_leadership:${coLeaderId}:${coach.id}:${contract.customer_id || contract.id}`, {
            coach_id: coLeaderId, source_type: "co_leadership", contract,
            descriptionBase: `Co-liderança sobre ${coach.name} — ${studentName}`, modalityName: modality.name, dayKeys, monthDays,
            dailyAmount: coLeadershipBonus / monthDays, rateApplied: coLeadershipBonus, tierSnapshot,
          });
        }
      }
    }
  }

  return finalizeGroups(groups);
}

// payout_pending_repasse aceita uma pendência por contrato + recebedor + tipo
// + competência. Um contrato não pago que trocou de treinador no mês gera um
// grupo de liderança por treinador para o mesmo líder: esses grupos viram uma
// pendência só, com a soma dos valores e todos os trechos.
export function mergePendingCollisions(rows: Row[]) {
  const merged = new Map<string, Row>();

  for (const row of rows) {
    const key = [row.contract_id, row.coach_id, row.source_type, row.reference_competence].join("|");
    const current = merged.get(key);
    if (!current) {
      merged.set(key, row);
      continue;
    }

    const amount = roundCents(Number(current.amount) + Number(row.amount));
    const validDays = current.valid_days + row.valid_days;
    const prorata = validDays / current.month_days;
    const rate = Number(current.rate_applied) === Number(row.rate_applied)
      ? current.rate_applied
      : roundCents(prorata > 0 ? amount / prorata : 0);

    merged.set(key, {
      ...current,
      description: `${current.description} + ${row.description}`,
      amount,
      valid_days: validDays,
      prorata_factor: prorata,
      rate_applied: rate,
      base_value: rate,
      leadership_bonus: current.source_type === "athlete_repasse" ? 0 : rate,
      segments: [...(current.segments || []), ...(row.segments || [])],
    });
  }

  return [...merged.values()];
}

export function groupByContract(rows: Row[]) {
  const byContract = new Map<string, Row[]>();
  for (const row of rows) {
    if (!byContract.has(row.contract_id)) byContract.set(row.contract_id, []);
    byContract.get(row.contract_id)!.push(row);
  }
  return byContract;
}
