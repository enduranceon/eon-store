import {
  activeDayKeys,
  buildClosingGroups,
  buildGroupedItems,
  type ClosingContext,
  coachIdByDay,
  competenceBounds,
  groupByContract,
  mergePendingCollisions,
  planSourceByDay,
  roundCents,
} from "./calculation.ts";

// deno-lint-ignore no-explicit-any
type Row = any;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  actual:   ${a}\n  expected: ${e}`);
}

// Dados fictícios -------------------------------------------------------------

const CORRIDA = { id: "mod-corrida", name: "Corrida" };
const TRIATHLON = { id: "mod-triathlon", name: "Triathlon" };
const DUAS = { id: "mod-duas", name: "2 Modalidades" };

const PLANS = [
  { id: "plan-corrida", modality_id: CORRIDA.id },
  { id: "plan-corrida-essencial", modality_id: CORRIDA.id },
  { id: "plan-triathlon", modality_id: TRIATHLON.id },
  { id: "plan-duas", modality_id: DUAS.id },
];

const RATES = [
  { role: "junior", modality_id: CORRIDA.id, rate: 50 },
  { role: "junior", modality_id: TRIATHLON.id, rate: 90 },
  { role: "junior", modality_id: DUAS.id, rate: 70 },
  { role: "pleno", modality_id: CORRIDA.id, rate: 70 },
  { role: "pleno", modality_id: TRIATHLON.id, rate: 110 },
  { role: "pleno", modality_id: DUAS.id, rate: 90 },
  { role: "senior", modality_id: CORRIDA.id, rate: 80 },
  { role: "senior", modality_id: TRIATHLON.id, rate: 130 },
  { role: "senior", modality_id: DUAS.id, rate: 110 },
];

const LEADER = { id: "coach-lider", name: "Lider", role: "senior", leader_id: null, co_leader_ids: [] };
const PLENO_A = { id: "coach-a", name: "Pleno A", role: "pleno", leader_id: LEADER.id, co_leader_ids: [] };
const PLENO_B = { id: "coach-b", name: "Pleno B", role: "pleno", leader_id: LEADER.id, co_leader_ids: [] };

const BASE_TIER = {
  id: "tier-base", name: "Base", min_athletes: 0,
  increment_per_athlete: 0, leadership_bonus: 3, co_leadership_bonus: 1.5,
};

function context(competence: string, overrides: Partial<ClosingContext> = {}): ClosingContext {
  return {
    ...competenceBounds(competence),
    leaves: [],
    coaches: [LEADER, PLENO_A, PLENO_B],
    plans: PLANS,
    modalities: [CORRIDA, TRIATHLON, DUAS],
    rates: RATES,
    tier: BASE_TIER,
    tierSnapshot: { name: "Base" },
    customersById: new Map([["cliente-1", { id: "cliente-1", full_name: "Aluno Um" }]]),
    planHistoryByContract: new Map(),
    coachHistoryByContract: new Map(),
    ...overrides,
  };
}

function contract(overrides: Row = {}): Row {
  return {
    id: "contrato-1",
    contract_number: "ASS-1",
    customer_id: "cliente-1",
    coach_id: PLENO_A.id,
    plan_id: "plan-corrida",
    plan_snapshot: { modality_id: CORRIDA.id },
    status: "active",
    payment_status: "paid",
    start_date: "2026-09-01",
    end_date: "2027-02-28",
    ...overrides,
  };
}

function athleteItems(items: Row[]) {
  return items.filter((item) => item.source_type === "athlete_repasse");
}

// Regras do documento -------------------------------------------------------

Deno.test("a full month on one plan pays exactly the monthly rate", () => {
  const items = buildGroupedItems([contract()], context("2026-09-01"));
  const [athlete] = athleteItems(items);

  assertEquals(athlete.amount, 70, "full month changed");
  assertEquals(athlete.valid_days, 30, "valid days changed");
  assertEquals(athlete.segments, [{
    rate: 70, valid_days: 30, amount: 70,
    first_day: "2026-09-01", last_day: "2026-09-30", modalities: ["Corrida"],
  }], "single segment changed");
});

Deno.test("an upgrade on October 11 pays 10 days of Corrida and 21 of Triathlon", () => {
  const upgraded = contract({ plan_id: "plan-triathlon", plan_snapshot: { modality_id: TRIATHLON.id } });
  const ctx = context("2026-10-01", {
    planHistoryByContract: groupByContract([
      { contract_id: upgraded.id, plan_id: "plan-corrida", plan_snapshot: { modality_id: CORRIDA.id }, valid_from: "2026-09-01" },
      { contract_id: upgraded.id, plan_id: "plan-triathlon", plan_snapshot: { modality_id: TRIATHLON.id }, valid_from: "2026-10-11" },
    ]),
  });

  const [athlete] = athleteItems(buildGroupedItems([upgraded], ctx));

  assertEquals(athlete.segments.map((s: Row) => [s.rate, s.valid_days, s.amount]), [[70, 10, 22.58], [110, 21, 74.52]],
    "segments differ from the approved example");
  assertEquals(athlete.amount, 97.1, "the item is the sum of the rounded segments");
  assertEquals(athlete.valid_days, 31, "every day of the month counts once");
  assertEquals(athlete.description, "Aluno Um — Corrida +1 (ASS-1)", "description changed");
});

Deno.test("the month after the upgrade pays the new rate only", () => {
  const upgraded = contract({ plan_id: "plan-triathlon", plan_snapshot: { modality_id: TRIATHLON.id } });
  const ctx = context("2026-11-01", {
    planHistoryByContract: groupByContract([
      { contract_id: upgraded.id, plan_id: "plan-corrida", plan_snapshot: { modality_id: CORRIDA.id }, valid_from: "2026-09-01" },
      { contract_id: upgraded.id, plan_id: "plan-triathlon", plan_snapshot: { modality_id: TRIATHLON.id }, valid_from: "2026-10-11" },
    ]),
  });

  const [athlete] = athleteItems(buildGroupedItems([upgraded], ctx));

  assertEquals(athlete.amount, 110, "the new plan pays its full monthly rate");
  assertEquals(athlete.segments.length, 1, "one segment in a month without change");
});

Deno.test("a lateral change inside the same modality keeps a single segment", () => {
  const ctx = context("2026-09-01", {
    planHistoryByContract: groupByContract([
      { contract_id: "contrato-1", plan_id: "plan-corrida", plan_snapshot: { modality_id: CORRIDA.id }, valid_from: "2026-09-01" },
      { contract_id: "contrato-1", plan_id: "plan-corrida-essencial", plan_snapshot: { modality_id: CORRIDA.id }, valid_from: "2026-09-16" },
    ]),
  });

  const [athlete] = athleteItems(buildGroupedItems([contract({ plan_id: "plan-corrida-essencial" })], ctx));

  assertEquals(athlete.amount, 70, "same modality, same pay");
  assertEquals(athlete.segments.length, 1, "no split without a rate change");
});

Deno.test("leave days are left out of each segment", () => {
  const upgraded = contract({ plan_id: "plan-triathlon", plan_snapshot: { modality_id: TRIATHLON.id } });
  const ctx = context("2026-09-01", {
    leaves: [{ contract_id: upgraded.id, start_date: "2026-09-11", end_date: "2026-09-20" }],
    planHistoryByContract: groupByContract([
      { contract_id: upgraded.id, plan_id: "plan-corrida", plan_snapshot: { modality_id: CORRIDA.id }, valid_from: "2026-09-01" },
      { contract_id: upgraded.id, plan_id: "plan-triathlon", plan_snapshot: { modality_id: TRIATHLON.id }, valid_from: "2026-09-16" },
    ]),
  });

  const [athlete] = athleteItems(buildGroupedItems([upgraded], ctx));

  // Corrida: 1–10 (10 dias); licença 11–20; Triathlon: 21–30 (10 dias).
  assertEquals(athlete.segments.map((s: Row) => [s.rate, s.valid_days, s.amount]), [[70, 10, 23.33], [110, 10, 36.67]],
    "leave days must not be paid");
  assertEquals(athlete.amount, 60, "sum of segments");
  assertEquals(athlete.valid_days, 20, "leave days are not valid days");
});

// Troca de treinador ------------------------------------------------------------

Deno.test("a coach change splits the month between the two coaches", () => {
  const moved = contract({ coach_id: PLENO_B.id });
  const ctx = context("2026-09-01", {
    coachHistoryByContract: groupByContract([
      { id: "h1", contract_id: moved.id, coach_id: PLENO_A.id, started_at: "2026-09-01", ended_at: "2026-09-16", created_at: "2026-09-01T10:00:00+00:00" },
      { id: "h2", contract_id: moved.id, coach_id: PLENO_B.id, started_at: "2026-09-16", ended_at: null, created_at: "2026-09-16T10:00:00+00:00" },
    ]),
  });

  const items = buildGroupedItems([moved], ctx);
  const byCoach = new Map(athleteItems(items).map((item) => [item.coach_id, item]));

  assertEquals([byCoach.get(PLENO_A.id)?.valid_days, byCoach.get(PLENO_A.id)?.amount], [15, 35], "first coach keeps days 1–15");
  assertEquals([byCoach.get(PLENO_B.id)?.valid_days, byCoach.get(PLENO_B.id)?.amount], [15, 35], "second coach gets days 16–30");

  const leadership = items.filter((item) => item.source_type === "direct_leadership");
  assertEquals(leadership.map((item) => [item.coach_id, item.valid_days, item.amount]),
    [[LEADER.id, 15, 1.5], [LEADER.id, 15, 1.5]], "the leader is paid once per day, split by coach");
});

Deno.test("a coach change made before the contract starts covers the whole contract", () => {
  const future = contract({ coach_id: PLENO_B.id, start_date: "2026-09-10" });
  const ctx = context("2026-09-01", {
    coachHistoryByContract: groupByContract([
      { id: "h1", contract_id: future.id, coach_id: PLENO_A.id, started_at: "2026-09-10", ended_at: "2026-09-05", created_at: "2026-09-01T10:00:00+00:00" },
      { id: "h2", contract_id: future.id, coach_id: PLENO_B.id, started_at: "2026-09-05", ended_at: null, created_at: "2026-09-05T10:00:00+00:00" },
    ]),
  });

  const athletes = athleteItems(buildGroupedItems([future], ctx));

  assertEquals(athletes.map((item) => [item.coach_id, item.valid_days]), [[PLENO_B.id, 21]],
    "the later decision wins from its start date");
});

Deno.test("a coach row recorded later overrides earlier rows from its start date", () => {
  const coachOf = coachIdByDay(contract(), [
    { id: "h1", coach_id: "a", started_at: "2026-09-01", ended_at: "2026-11-01", created_at: "2026-09-01T00:00:00+00:00" },
    { id: "h2", coach_id: "b", started_at: "2026-11-01", ended_at: "2026-10-25", created_at: "2026-10-20T00:00:00+00:00" },
    { id: "h3", coach_id: "c", started_at: "2026-10-25", ended_at: null, created_at: "2026-10-25T00:00:00+00:00" },
  ]);

  assertEquals(["2026-10-24", "2026-10-25", "2026-11-05"].map(coachOf), ["a", "c", "c"],
    "the most recent decision wins");
});

Deno.test("rows recorded at the same instant put the open row last", () => {
  const coachOf = coachIdByDay(contract(), [
    { id: "z", coach_id: "c", started_at: "2026-09-10", ended_at: null, created_at: "2026-09-10T00:00:00+00:00" },
    { id: "y", coach_id: "b", started_at: "2026-09-10", ended_at: "2026-09-10", created_at: "2026-09-10T00:00:00+00:00" },
    { id: "x", coach_id: "a", started_at: "2026-09-01", ended_at: "2026-09-10", created_at: "2026-09-01T00:00:00+00:00" },
  ]);

  assertEquals(["2026-09-09", "2026-09-10"].map(coachOf), ["a", "c"], "the open row is the current coach");
});

Deno.test("a single history row always falls back to the contract itself", () => {
  const own = contract({ coach_id: "coach-atual", plan_id: "plan-triathlon", plan_snapshot: { modality_id: TRIATHLON.id } });

  assertEquals(coachIdByDay(own, [{ coach_id: "outro", started_at: "2026-09-01" }])("2026-09-15"), "coach-atual",
    "one coach row uses the contract coach");
  assertEquals(planSourceByDay(own, [{ plan_id: "plan-corrida", valid_from: "2026-09-01" }])("2026-09-15").plan_id,
    "plan-triathlon", "one plan row uses the contract plan");
  assertEquals(planSourceByDay(own, [
    { plan_id: "plan-corrida", valid_from: "2026-09-05" },
    { plan_id: "plan-triathlon", valid_from: "2026-10-01" },
  ])("2026-09-01").plan_id, "plan-corrida", "days before the first row use the first row");
});

// Pendências --------------------------------------------------------------------

Deno.test("leadership pendings of one unpaid contract with two coaches become one row", () => {
  const moved = contract({ coach_id: PLENO_B.id, payment_status: "pending" });
  const ctx = context("2026-09-01", {
    coachHistoryByContract: groupByContract([
      { id: "h1", contract_id: moved.id, coach_id: PLENO_A.id, started_at: "2026-09-01", ended_at: "2026-09-11", created_at: "2026-09-01T10:00:00+00:00" },
      { id: "h2", contract_id: moved.id, coach_id: PLENO_B.id, started_at: "2026-09-11", ended_at: null, created_at: "2026-09-11T10:00:00+00:00" },
    ]),
  });

  const rows = mergePendingCollisions(buildGroupedItems([moved], ctx)
    .map((item) => ({ ...item, reference_competence: "2026-09-01", status: "open" })));
  const keys = rows.map((row) => `${row.contract_id}|${row.coach_id}|${row.source_type}`);
  assertEquals(new Set(keys).size, keys.length, "pending rows must respect the unique key");

  const leadership = rows.filter((row) => row.source_type === "direct_leadership");
  assertEquals(leadership.length, 1, "one leadership pending for the leader");
  assertEquals([leadership[0].valid_days, leadership[0].amount, leadership[0].rate_applied], [30, 3, 3],
    "the merged pending keeps every day and the flat bonus");
  assertEquals(leadership[0].segments.reduce((s: number, seg: Row) => s + seg.amount, 0), 3,
    "the merged segments still add up");
  assert(leadership[0].description.includes("Pleno A") && leadership[0].description.includes("Pleno B"),
    "the description names both coaches");
});

Deno.test("pendings with distinct keys are kept as they are", () => {
  const rows = [
    { contract_id: "c1", coach_id: "x", source_type: "athlete_repasse", reference_competence: "2026-09-01", amount: 10 },
    { contract_id: "c1", coach_id: "y", source_type: "athlete_repasse", reference_competence: "2026-09-01", amount: 20 },
  ];
  assertEquals(mergePendingCollisions(rows), rows, "no merge without a collision");
});

// Mudança de plano ainda não paga -------------------------------------------------

function upgradeHistory(contractId: string, upgradeFrom: string, planChangeId = "chg-1", originalFrom = "2026-09-01") {
  return groupByContract([
    { contract_id: contractId, plan_id: "plan-corrida", plan_snapshot: { modality_id: CORRIDA.id }, valid_from: originalFrom, change_type: "original" },
    {
      contract_id: contractId, plan_id: "plan-triathlon", plan_snapshot: { modality_id: TRIATHLON.id },
      valid_from: upgradeFrom, change_type: "upgrade", plan_change_id: planChangeId,
    },
  ]);
}

function planChanges(status: string) {
  return new Map([["chg-1", { id: "chg-1", payment_status: status, status: "applied" }]]);
}

Deno.test("an unpaid upgrade pays the previous rate and holds the difference", () => {
  const upgraded = contract({ plan_id: "plan-triathlon" });
  const ctx = context("2026-10-01", {
    planHistoryByContract: upgradeHistory(upgraded.id, "2026-10-11"),
    planChangesById: planChanges("charge_sent"),
  });

  const { items, differences } = buildClosingGroups([upgraded], ctx, true);
  const [athlete] = athleteItems(items);

  assertEquals([athlete.amount, athlete.valid_days, athlete.segments.length], [70, 31, 1],
    "the coach is paid the corrida rate for the whole month");
  assertEquals(differences.map((row) => [row.plan_change_id, row.coach_id, row.valid_days, row.amount, row.rate_applied]),
    [["chg-1", PLENO_A.id, 21, 27.1, 40]], "21 days of (110 - 70) / 31 wait for the upgrade payment");
  assertEquals(differences[0].description, "Diferença da mudança de plano — Aluno Um — Triathlon (ASS-1)",
    "the pending explains where it comes from");
});

Deno.test("a paid upgrade pays the new rate right away", () => {
  const upgraded = contract({ plan_id: "plan-triathlon" });
  const ctx = context("2026-10-01", {
    planHistoryByContract: upgradeHistory(upgraded.id, "2026-10-11"),
    planChangesById: planChanges("paid"),
  });

  const { items, differences } = buildClosingGroups([upgraded], ctx, true);
  const [athlete] = athleteItems(items);

  assertEquals(athlete.segments.map((s: Row) => [s.rate, s.valid_days, s.amount]), [[70, 10, 22.58], [110, 21, 74.52]],
    "paid upgrade: the approved example");
  assertEquals(differences.length, 0, "nothing waits");
});

Deno.test("an unpaid contract keeps the full rate of each day", () => {
  const unpaid = contract({ plan_id: "plan-triathlon", payment_status: "pending" });
  const ctx = context("2026-10-01", {
    planHistoryByContract: upgradeHistory(unpaid.id, "2026-10-11"),
    planChangesById: planChanges("charge_sent"),
  });

  const [athlete] = athleteItems(buildGroupedItems([unpaid], ctx));

  assertEquals(athlete.amount, 97.1, "the contract pending already covers every day at its plan");
});

Deno.test("the held difference follows the coach of each day", () => {
  const moved = contract({ plan_id: "plan-triathlon", coach_id: PLENO_B.id });
  const ctx = context("2026-10-01", {
    planHistoryByContract: upgradeHistory(moved.id, "2026-10-11"),
    coachHistoryByContract: groupByContract([
      { id: "h1", contract_id: moved.id, coach_id: PLENO_A.id, started_at: "2026-09-01", ended_at: null, created_at: "2026-09-01T10:00:00+00:00" },
      { id: "h2", contract_id: moved.id, coach_id: PLENO_B.id, started_at: "2026-10-11", ended_at: null, created_at: "2026-10-05T10:00:00+00:00" },
    ]),
    planChangesById: planChanges("awaiting_charge"),
  });

  const { items, differences } = buildClosingGroups([moved], ctx, true);

  assertEquals(athleteItems(items).map((item) => [item.coach_id, item.valid_days, item.amount]),
    [[PLENO_A.id, 10, 22.58], [PLENO_B.id, 21, 47.42]], "both coaches are paid the corrida rate");
  assertEquals(differences.map((row) => [row.coach_id, row.valid_days, row.amount]), [[PLENO_B.id, 21, 27.1]],
    "the new coach waits for the difference");
});

Deno.test("an upgrade from the first day holds the whole month", () => {
  const upgraded = contract({ plan_id: "plan-triathlon", start_date: "2026-10-01" });
  const ctx = context("2026-10-01", {
    planHistoryByContract: upgradeHistory(upgraded.id, "2026-10-01", "chg-1", "2026-10-01"),
    planChangesById: planChanges("charge_sent"),
  });

  const { items, differences } = buildClosingGroups([upgraded], ctx, true);

  assertEquals(athleteItems(items)[0].amount, 70, "the change row wins over the original on the same day");
  assertEquals(differences.map((row) => [row.valid_days, row.amount]), [[31, 40]], "the whole month waits");
});

Deno.test("an upgrade pending and a contract pending never collide", () => {
  const rows = [
    { contract_id: "c1", coach_id: "x", source_type: "athlete_repasse", reference_competence: "2026-10-01", amount: 10 },
    { contract_id: "c1", coach_id: "x", source_type: "athlete_repasse", reference_competence: "2026-10-01", amount: 5, plan_change_id: "chg-1" },
  ];
  assertEquals(mergePendingCollisions(rows).length, 2, "the plan change is part of the pending key");
});

// Equivalência com o cálculo anterior ---------------------------------------------

// Cópia do cálculo que o fechamento usava antes dos históricos (sem trechos).
function legacyBuildGroupedItems(contractList: Row[], ctx: ClosingContext) {
  const { monthDays, tier, tierSnapshot, leaves, coaches, plans, modalities, rates, customersById } = ctx;
  const groups = new Map<string, Row>();
  const add = (key: string, payload: Row) => {
    if (!groups.has(key)) {
      groups.set(key, {
        coach_id: payload.coach_id, source_type: payload.source_type, contract_id: payload.contract.id,
        descriptionBase: payload.descriptionBase, month_days: payload.monthDays, tier_applied: payload.tierSnapshot,
        contracts: new Set<string>(), modalities: new Set<string>(), dailyValues: new Map<string, number>(),
        rateValues: new Set<number>(),
      });
    }
    const group = groups.get(key);
    group.contracts.add(payload.contract.contract_number || payload.contract.id);
    group.modalities.add(payload.modalityName);
    group.rateValues.add(payload.rateApplied);
    for (const dayKey of payload.dayKeys) {
      group.dailyValues.set(dayKey, Math.max(group.dailyValues.get(dayKey) || 0, payload.dailyAmount));
    }
  };

  for (const c of contractList) {
    const dayKeys = activeDayKeys(c, leaves, ctx.monthStart, ctx.monthEndExclusive);
    if (dayKeys.length <= 0) continue;
    const coach = coaches.find((x: Row) => x.id === c.coach_id);
    if (!coach) continue;
    const modalityId = c.plan_snapshot?.modality_id || plans.find((p: Row) => p.id === c.plan_id)?.modality_id;
    const modality = modalities.find((m: Row) => m.id === modalityId);
    if (!modality) continue;
    const rate = rates.find((r: Row) => r.role === coach.role && r.modality_id === modality.id);
    if (!rate) continue;
    const baseRate = (Number(rate.rate) || 0) + Number(tier?.increment_per_athlete || 0);
    const studentName = customersById.get(c.customer_id)?.full_name || c.contract_number || "Aluno";
    add(`athlete_repasse:${coach.id}:${c.customer_id || c.id}`, {
      coach_id: coach.id, source_type: "athlete_repasse", contract: c, descriptionBase: studentName,
      modalityName: modality.name, dayKeys, monthDays, dailyAmount: baseRate / monthDays, rateApplied: baseRate, tierSnapshot,
    });
    const leadershipBonus = Number(tier?.leadership_bonus || 0);
    if (coach.leader_id && leadershipBonus > 0) {
      add(`direct_leadership:${coach.leader_id}:${coach.id}:${c.customer_id || c.id}`, {
        coach_id: coach.leader_id, source_type: "direct_leadership", contract: c,
        descriptionBase: `Liderança sobre ${coach.name} — ${studentName}`, modalityName: modality.name, dayKeys, monthDays,
        dailyAmount: leadershipBonus / monthDays, rateApplied: leadershipBonus, tierSnapshot,
      });
    }
    const coLeadershipBonus = Number(tier?.co_leadership_bonus || 0);
    for (const coLeaderId of (coach.co_leader_ids || [])) {
      if (coLeadershipBonus > 0) {
        add(`co_leadership:${coLeaderId}:${coach.id}:${c.customer_id || c.id}`, {
          coach_id: coLeaderId, source_type: "co_leadership", contract: c,
          descriptionBase: `Co-liderança sobre ${coach.name} — ${studentName}`, modalityName: modality.name, dayKeys, monthDays,
          dailyAmount: coLeadershipBonus / monthDays, rateApplied: coLeadershipBonus, tierSnapshot,
        });
      }
    }
  }

  return [...groups.values()].map((group: Row) => {
    const values = [...group.dailyValues.values()] as number[];
    const amount = Math.round(values.reduce((s, v) => s + v, 0) * 100) / 100;
    const validDays = group.dailyValues.size;
    const prorata = validDays / group.month_days;
    const rateValues = [...group.rateValues];
    const effectiveRate = rateValues.length === 1 ? rateValues[0] : Math.round((prorata > 0 ? amount / prorata : 0) * 100) / 100;
    const modalitiesList = [...group.modalities].filter(Boolean) as string[];
    const modalityLabel = modalitiesList.length > 1 ? `${modalitiesList[0]} +${modalitiesList.length - 1}` : modalitiesList[0] || "Assessoria";
    return {
      coach_id: group.coach_id, source_type: group.source_type, contract_id: group.contract_id,
      description: `${group.descriptionBase} — ${modalityLabel} (${[...group.contracts].join(", ")})`,
      amount, valid_days: validDays, month_days: group.month_days, prorata_factor: prorata,
      rate_applied: effectiveRate, tier_applied: group.tier_applied, base_value: effectiveRate,
      leadership_bonus: group.source_type === "athlete_repasse" ? 0 : effectiveRate,
    };
  }).filter((item: Row) => item.valid_days > 0 && item.amount > 0);
}

function randomGenerator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TIERS = [
  BASE_TIER,
  { id: "t2", name: "Bronze", min_athletes: 300, increment_per_athlete: 5, leadership_bonus: 3.5, co_leadership_bonus: 1.75 },
  { id: "t3", name: "Gold", min_athletes: 700, increment_per_athlete: 9, leadership_bonus: 4.5, co_leadership_bonus: 2.25 },
];

const COMPETENCES = ["2026-02-01", "2028-02-01", "2026-06-01", "2026-07-01", "2026-09-01", "2026-10-01"];

function addDays(day: string, days: number) {
  const date = new Date(day + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Contratos sem troca no meio do ciclo. Com sameModalityPerCustomer, cada aluno
// fica numa modalidade só (nenhum grupo mistura taxas).
function randomScenario(seed: number, competence: string, sameModalityPerCustomer: boolean) {
  const random = randomGenerator(seed);
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)];
  const coaches = [
    { id: "k-senior", name: "Senior", role: "senior", leader_id: null, co_leader_ids: [] },
    { id: "k-pleno", name: "Pleno", role: "pleno", leader_id: "k-senior", co_leader_ids: ["k-co"] },
    { id: "k-junior", name: "Junior", role: "junior", leader_id: "k-senior", co_leader_ids: [] },
    { id: "k-co", name: "Co", role: "pleno", leader_id: "k-senior", co_leader_ids: ["k-junior"] },
  ];
  const customers = Array.from({ length: 25 }, (_, i) => ({ id: `cliente-${i}`, full_name: `Aluno ${i}` }));
  const contracts: Row[] = [];
  const leaves: Row[] = [];
  const monthStart = competence;

  for (const customer of customers) {
    const plan = pick(PLANS);
    const count = 1 + Math.floor(random() * 3);
    let start = addDays(monthStart, Math.floor(random() * 90) - 60);
    for (let n = 0; n < count; n++) {
      const chosenPlan = sameModalityPerCustomer ? plan : pick(PLANS);
      const length = pick([30, 90, 180]);
      const end = addDays(start, length - 1);
      const status = pick(["active", "active", "active", "cancelled", "finished", "overdue", "on_leave"]);
      const id = `${customer.id}-c${n}`;
      contracts.push({
        id,
        contract_number: `ASS-${seed}-${customer.id}-${n}`,
        customer_id: random() < 0.95 ? customer.id : null,
        coach_id: pick(coaches).id,
        plan_id: chosenPlan.id,
        plan_snapshot: random() < 0.8 ? { modality_id: chosenPlan.modality_id } : null,
        status,
        cancellation_date: status === "cancelled" ? addDays(start, Math.floor(random() * length)) : null,
        start_date: start,
        end_date: end,
      });
      if (random() < 0.2) {
        const leaveStart = addDays(monthStart, Math.floor(random() * 28));
        leaves.push({
          contract_id: id,
          start_date: leaveStart,
          end_date: random() < 0.3 ? null : addDays(leaveStart, Math.floor(random() * 20)),
        });
      }
      start = addDays(end, pick([-3, 1, 1, 10]));
    }
  }

  const tier = pick(TIERS);
  // Uma linha de histórico por contrato, como a carga inicial grava. Em parte
  // dos contratos, uma segunda linha repete o mesmo plano ou treinador no
  // meio do mês: sem troca de verdade, o resultado não pode mudar.
  const planRows: Row[] = [];
  const coachRows: Row[] = [];
  for (const c of contracts) {
    planRows.push({ contract_id: c.id, plan_id: c.plan_id, plan_snapshot: c.plan_snapshot, valid_from: c.start_date });
    coachRows.push({ id: `h-${c.id}`, contract_id: c.id, coach_id: c.coach_id, started_at: c.start_date, ended_at: null, created_at: "2026-01-01T00:00:00+00:00" });
    if (random() < 0.3) {
      const middle = addDays(monthStart, 1 + Math.floor(random() * 27));
      planRows.push({ contract_id: c.id, plan_id: c.plan_id, plan_snapshot: c.plan_snapshot, valid_from: middle });
      coachRows[coachRows.length - 1].ended_at = middle;
      coachRows.push({ id: `h2-${c.id}`, contract_id: c.id, coach_id: c.coach_id, started_at: middle, ended_at: null, created_at: "2026-02-01T00:00:00+00:00" });
    }
  }

  return {
    contracts,
    ctx: context(competence, {
      leaves,
      coaches,
      rates: RATES.filter((r) => !(r.role === "junior" && r.modality_id === DUAS.id)),
      tier,
      tierSnapshot: { name: tier.name },
      customersById: new Map(customers.map((c) => [c.id, c])),
      planHistoryByContract: groupByContract(planRows),
      coachHistoryByContract: groupByContract(coachRows),
    }),
  };
}

function withoutSegments(items: Row[]) {
  return items.map(({ segments: _segments, ...item }) => item);
}

Deno.test("without mid-cycle changes the result is identical to the previous calculation", () => {
  let compared = 0;
  for (const competence of COMPETENCES) {
    for (let seed = 1; seed <= 40; seed++) {
      const { contracts, ctx } = randomScenario(seed, competence, true);
      const legacy = legacyBuildGroupedItems(contracts, ctx);
      const current = buildGroupedItems(contracts, ctx);
      assertEquals(withoutSegments(current), legacy, `divergence in ${competence} seed ${seed}`);
      compared += legacy.length;
    }
  }
  assert(compared > 5000, `too few items compared: ${compared}`);
});

Deno.test("segments always add up to the item amount", () => {
  for (const competence of COMPETENCES) {
    for (let seed = 1; seed <= 40; seed++) {
      const { contracts, ctx } = randomScenario(seed, competence, false);
      for (const item of buildGroupedItems(contracts, ctx)) {
        const sum = roundCents(item.segments.reduce((s: number, seg: Row) => s + seg.amount, 0));
        assertEquals(sum, item.amount, `segments do not add up in ${competence} seed ${seed}`);
        assertEquals(item.segments.reduce((s: number, seg: Row) => s + seg.valid_days, 0), item.valid_days,
          `segment days do not add up in ${competence} seed ${seed}`);
      }
    }
  }
});

Deno.test("mixed rates in one group differ from the previous rounding by at most one cent per extra segment", () => {
  let mixedGroups = 0;
  for (const competence of COMPETENCES) {
    for (let seed = 1; seed <= 40; seed++) {
      const { contracts, ctx } = randomScenario(seed, competence, false);
      const legacy = legacyBuildGroupedItems(contracts, ctx);
      const current = buildGroupedItems(contracts, ctx);
      assertEquals(current.length, legacy.length, `item count changed in ${competence} seed ${seed}`);
      current.forEach((item, index) => {
        const before = legacy[index];
        assertEquals([item.coach_id, item.source_type, item.valid_days], [before.coach_id, before.source_type, before.valid_days],
          `item identity changed in ${competence} seed ${seed}`);
        const tolerance = 0.01 * (item.segments.length - 1) + 1e-9;
        assert(Math.abs(item.amount - before.amount) <= tolerance,
          `amount moved more than rounding in ${competence} seed ${seed}: ${before.amount} -> ${item.amount}`);
        if (item.segments.length > 1) mixedGroups++;
      });
    }
  }
  assert(mixedGroups > 40, `too few mixed groups exercised: ${mixedGroups}`);
});
