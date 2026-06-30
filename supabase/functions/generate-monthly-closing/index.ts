import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const DAY_MS = 86400000;

function parseDateUTC(value: string | null | undefined, fallback: Date) {
  if (!value) return fallback;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return fallback;
  return new Date(Date.UTC(year, month - 1, day));
}

function dateKeyUTC(date: Date) {
  return date.toISOString().slice(0, 10);
}

function activeDayKeys(contract: any, leaves: any[], monthStart: Date, monthEndExclusive: Date) {
  const start = parseDateUTC(contract.start_date, monthStart);
  let endExclusive = parseDateUTC(contract.end_date, monthEndExclusive);
  if (contract.end_date && endExclusive.getTime() === start.getTime()) {
    endExclusive = new Date(endExclusive.getTime() + DAY_MS);
  }

  const current = start > monthStart ? new Date(start) : new Date(monthStart);
  const end = endExclusive < monthEndExclusive ? endExclusive : monthEndExclusive;
  const keys = new Set<string>();

  while (current < end) {
    keys.add(dateKeyUTC(current));
    current.setTime(current.getTime() + DAY_MS);
  }

  for (const leave of leaves.filter((l: any) => l.contract_id === contract.id)) {
    const leaveStart = parseDateUTC(leave.start_date, monthStart);
    const leaveEnd = parseDateUTC(leave.end_date, leaveStart);
    const leaveEndExclusive = new Date(leaveEnd.getTime() + DAY_MS);
    const leaveCurrent = leaveStart > monthStart ? new Date(leaveStart) : new Date(monthStart);
    const leaveLimit = leaveEndExclusive < monthEndExclusive ? leaveEndExclusive : monthEndExclusive;

    while (leaveCurrent < leaveLimit) {
      keys.delete(dateKeyUTC(leaveCurrent));
      leaveCurrent.setTime(leaveCurrent.getTime() + DAY_MS);
    }
  }

  return [...keys];
}

function addStatementContribution(groups: Map<string, any>, key: string, payload: any) {
  if (!groups.has(key)) {
    groups.set(key, {
      closing_id: payload.closing_id,
      coach_id: payload.coach_id,
      source_type: payload.source_type,
      contract_id: payload.contract.id,
      descriptionBase: payload.descriptionBase,
      month_days: payload.monthDays,
      tier_applied: payload.tierSnapshot,
      contracts: new Set<string>(),
      modalities: new Set<string>(),
      dailyValues: new Map<string, number>(),
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
}

Deno.serve(async (req: Request) => {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const body = await req.json().catch(() => ({}));
    let competence = body?.competence as string | undefined;

    // Default: mês atual (primeiro dia)
    if (!competence) {
      const d = new Date();
      competence = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
    }

    // Já existe?
    const { data: existing } = await supabase.from("payout_monthly_closings")
      .select("id, status").eq("competence", competence).maybeSingle();
    if (existing) {
      return new Response(JSON.stringify({
        error: existing.status === "pending_approval"
          ? "Fechamento já existe para essa competência (em revisão)."
          : "Fechamento já existe e foi aprovado/pago para essa competência.",
        closing_id: existing.id,
      }), {
        status: 409, headers: { "Content-Type": "application/json" },
      });
    }

    const monthStart = new Date(competence + "T00:00:00Z");
    const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0));
    const monthEndExclusive = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
    const monthDays = monthEnd.getUTCDate();

    // Fetch tudo (inclui plan_snapshot pra preservar histórico)
    const [contractsRes, plansRes, modalitiesRes, coachesRes, customersRes, leavesRes, ratesRes, tiersRes] = await Promise.all([
      supabase.from("assessment_contracts").select("*"),
      supabase.from("assessment_plans").select("*"),
      supabase.from("assessment_modalities").select("*"),
      supabase.from("assessment_coaches").select("*"),
      supabase.from("presale_customers").select("id, full_name"),
      supabase.from("assessment_leaves").select("*"),
      supabase.from("payout_role_modality_rates").select("*"),
      supabase.from("payout_growth_tiers").select("*"),
    ]);

    const contracts = contractsRes.data || [];
    const plans = plansRes.data || [];
    const modalities = modalitiesRes.data || [];
    const coaches = coachesRes.data || [];
    const customers = customersRes.data || [];
    const leaves = leavesRes.data || [];
    const rates = ratesRes.data || [];
    const tiers = (tiersRes.data || []).sort((a: any, b: any) => b.min_athletes - a.min_athletes);

    // Contratos elegíveis: pagos, não descartados/cancelados e com dias na competência.
    const eligible = contracts.filter((c: any) => {
      if (["cancelled", "draft", "voided"].includes(c.status)) return false;
      if (c.payment_status !== "paid") return false;
      const cStart = parseDateUTC(c.start_date, monthStart);
      let cEnd = parseDateUTC(c.end_date, monthEndExclusive);
      if (c.end_date && cEnd.getTime() === cStart.getTime()) {
        cEnd = new Date(cEnd.getTime() + DAY_MS);
      }
      return cStart < monthEndExclusive && cEnd > monthStart;
    });

    // Determina tier baseado no total de atletas únicos com contrato pago no mês
    const totalActive = new Set(eligible.map((c: any) => c.customer_id).filter(Boolean)).size;
    const tier = tiers.find((t: any) => t.min_athletes <= totalActive) || tiers[tiers.length - 1] || null;

    // Snapshot completo do tier (preservado no item)
    const tierSnapshot = tier ? {
      id:                    tier.id,
      name:                  tier.name,
      min_athletes:          tier.min_athletes,
      increment_per_athlete: Number(tier.increment_per_athlete) || 0,
      leadership_bonus:      Number(tier.leadership_bonus) || 0,
      co_leadership_bonus:   Number(tier.co_leadership_bonus) || 0,
      total_active_at_close: totalActive,
      snapshot_at:           new Date().toISOString(),
    } : null;

    // Cria fechamento
    const { data: closing, error: closingError } = await supabase.from("payout_monthly_closings").insert({
      competence, status: "pending_approval",
    }).select().single();
    if (closingError) throw closingError;

    const groups = new Map<string, any>();
    const customersById = new Map(customers.map((c: any) => [c.id, c]));

    for (const contract of eligible) {
      const dayKeys = activeDayKeys(contract, leaves, monthStart, monthEndExclusive);
      if (dayKeys.length <= 0) continue;

      const coach = coaches.find((c: any) => c.id === contract.coach_id);
      if (!coach) continue;

      // Modality: prefere o snapshot do contrato (preserva histórico)
      const modalityId = contract.plan_snapshot?.modality_id
        || plans.find((p: any) => p.id === contract.plan_id)?.modality_id;
      const modality = modalities.find((m: any) => m.id === modalityId);
      if (!modality) continue;

      const rate = rates.find((r: any) => r.role === coach.role && r.modality_id === modality.id);
      if (!rate) continue;

      const rateValue   = Number(rate.rate) || 0;
      const tierIncrement = Number(tier?.increment_per_athlete || 0);
      const baseRate    = rateValue + tierIncrement;
      const studentName = customersById.get(contract.customer_id)?.full_name || contract.contract_number || "Aluno";

      addStatementContribution(groups, `athlete_repasse:${coach.id}:${contract.customer_id || contract.id}`, {
        closing_id: closing.id,
        coach_id: coach.id,
        source_type: "athlete_repasse",
        contract,
        descriptionBase: studentName,
        modalityName: modality.name,
        dayKeys,
        monthDays,
        dailyAmount: baseRate / monthDays,
        rateApplied: baseRate,
        tierSnapshot,
      });

      // Bonus de liderança
      const leadershipBonus = Number(tier?.leadership_bonus || 0);
      if (coach.leader_id && leadershipBonus > 0) {
        addStatementContribution(groups, `direct_leadership:${coach.leader_id}:${coach.id}:${contract.customer_id || contract.id}`, {
          closing_id: closing.id,
          coach_id: coach.leader_id,
          source_type: "direct_leadership",
          contract,
          descriptionBase: `Liderança sobre ${coach.name} — ${studentName}`,
          modalityName: modality.name,
          dayKeys,
          monthDays,
          dailyAmount: leadershipBonus / monthDays,
          rateApplied: leadershipBonus,
          tierSnapshot,
        });
      }

      // Bonus de co-liderança
      const coLeadershipBonus = Number(tier?.co_leadership_bonus || 0);
      for (const coLeaderId of (coach.co_leader_ids || [])) {
        if (coLeadershipBonus > 0) {
          addStatementContribution(groups, `co_leadership:${coLeaderId}:${coach.id}:${contract.customer_id || contract.id}`, {
            closing_id: closing.id,
            coach_id: coLeaderId,
            source_type: "co_leadership",
            contract,
            descriptionBase: `Co-liderança sobre ${coach.name} — ${studentName}`,
            modalityName: modality.name,
            dayKeys,
            monthDays,
            dailyAmount: coLeadershipBonus / monthDays,
            rateApplied: coLeadershipBonus,
            tierSnapshot,
          });
        }
      }
    }

    const items = [...groups.values()].map((group: any) => {
      const values = [...group.dailyValues.values()];
      const amount = Math.round(values.reduce((s: number, v: number) => s + v, 0) * 100) / 100;
      const validDays = group.dailyValues.size;
      const prorata = validDays / group.month_days;
      const rateValues = [...group.rateValues];
      const effectiveRate = rateValues.length === 1
        ? rateValues[0]
        : Math.round((prorata > 0 ? amount / prorata : 0) * 100) / 100;
      const contractNumbers = [...group.contracts].join(", ");
      const modalitiesList = [...group.modalities].filter(Boolean);
      const modalityLabel = modalitiesList.length > 1
        ? `${modalitiesList[0]} +${modalitiesList.length - 1}`
        : modalitiesList[0] || "Assessoria";

      return {
        closing_id: group.closing_id,
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
      };
    }).filter((item: any) => item.valid_days > 0 && item.amount > 0);

    if (items.length > 0) {
      await supabase.from("payout_monthly_statement_items").insert(items);
    }

    const total = items.reduce((s, i) => s + i.amount, 0);

    return new Response(JSON.stringify({
      ok: true, closing_id: closing.id,
      tier_name: tier?.name, total_athletes: totalActive,
      items_count: items.length, total_amount: total,
      tier_snapshot: tierSnapshot,
    }), { headers: { "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
