import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requireAdmin } from "../_shared/requireAdmin.ts";

// Gera o fechamento de repasse de uma competência.
//
// Modelo de pendências (carry-forward):
//   - Contratos PAGOS vigentes no mês  -> itens do fechamento (reference = competência atual).
//   - Contratos ATIVOS NÃO pagos       -> PENDÊNCIAS congeladas (payout_pending_repasse), com o
//                                          valor calculado pelas regras do mês em que ficaram devendo.
//   - Pendências de meses anteriores cujo contrato JÁ pagou -> RESGATADAS: entram como item no
//                                          fechamento atual, mas carimbadas com reference = mês original.
//
// Body: { competence?: "YYYY-MM-01", regenerate?: boolean }. Aprovado/pago nunca recalcula.

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

function addContribution(groups: Map<string, any>, key: string, payload: any) {
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

function finalizeGroups(groups: Map<string, any>) {
  return [...groups.values()].map((group: any) => {
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
}

Deno.serve(async (req: Request) => {
  // 🔒 AUTHZ: só admin allowlistado
  const gate = await requireAdmin(req);
  if (!gate.ok) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: gate.status, headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const body = await req.json().catch(() => ({}));
    let competence = body?.competence as string | undefined;

    // Default: mês atual (primeiro dia)
    if (!competence) {
      const d = new Date();
      competence = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
    }

    const regenerate = body?.regenerate === true;

    // Já existe fechamento pra essa competência?
    const { data: existing } = await supabase.from("payout_monthly_closings")
      .select("id, status").eq("competence", competence).maybeSingle();

    // Aprovado/pago nunca recalcula — protege valores já congelados.
    if (existing && existing.status !== "pending_approval") {
      return new Response(JSON.stringify({
        error: "Fechamento já existe e foi aprovado/pago para essa competência.",
        closing_id: existing.id,
      }), { status: 409, headers: { "Content-Type": "application/json" } });
    }

    // Existe em revisão, mas o recálculo não foi pedido explicitamente.
    if (existing && !regenerate) {
      return new Response(JSON.stringify({
        error: "Fechamento já existe para essa competência (em revisão).",
        closing_id: existing.id,
      }), { status: 409, headers: { "Content-Type": "application/json" } });
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
    const customersById = new Map(customers.map((c: any) => [c.id, c]));

    // Contrato tem vigência (dias) dentro da competência?
    const overlapsMonth = (c: any) => {
      const cStart = parseDateUTC(c.start_date, monthStart);
      let cEnd = parseDateUTC(c.end_date, monthEndExclusive);
      if (c.end_date && cEnd.getTime() === cStart.getTime()) cEnd = new Date(cEnd.getTime() + DAY_MS);
      return cStart < monthEndExclusive && cEnd > monthStart;
    };

    // Pagos e vigentes no mês (base do repasse e do tier).
    const paidContracts = contracts.filter((c: any) =>
      !["cancelled", "draft", "voided"].includes(c.status) &&
      c.payment_status === "paid" &&
      overlapsMonth(c)
    );

    // Ativos, ainda NÃO pagos e vigentes no mês (viram pendência).
    const unpaidContracts = contracts.filter((c: any) =>
      ["active", "overdue", "on_leave"].includes(c.status) &&
      c.payment_status !== "paid" &&
      overlapsMonth(c)
    );

    // Determina tier baseado no total de atletas únicos com contrato pago no mês
    const totalActive = new Set(paidContracts.map((c: any) => c.customer_id).filter(Boolean)).size;
    const tier = tiers.find((t: any) => t.min_athletes <= totalActive) || tiers[tiers.length - 1] || null;

    // Snapshot completo do tier (preservado no item / na pendência)
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

    // Agrupa as contribuições de repasse de uma lista de contratos (athlete + liderança + co-liderança).
    const buildGroupedItems = (contractList: any[]) => {
      const groups = new Map<string, any>();
      for (const contract of contractList) {
        const dayKeys = activeDayKeys(contract, leaves, monthStart, monthEndExclusive);
        if (dayKeys.length <= 0) continue;

        const coach = coaches.find((c: any) => c.id === contract.coach_id);
        if (!coach) continue;

        const modalityId = contract.plan_snapshot?.modality_id
          || plans.find((p: any) => p.id === contract.plan_id)?.modality_id;
        const modality = modalities.find((m: any) => m.id === modalityId);
        if (!modality) continue;

        const rate = rates.find((r: any) => r.role === coach.role && r.modality_id === modality.id);
        if (!rate) continue;

        const rateValue = Number(rate.rate) || 0;
        const tierIncrement = Number(tier?.increment_per_athlete || 0);
        const baseRate = rateValue + tierIncrement;
        const studentName = customersById.get(contract.customer_id)?.full_name || contract.contract_number || "Aluno";

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
      return finalizeGroups(groups);
    };

    // Cria (ou reusa, em recálculo) o fechamento da competência.
    let closing: any;
    if (existing) {
      // Limpa itens calculados automaticamente (preserva ajustes manuais).
      const { error: delErr } = await supabase
        .from("payout_monthly_statement_items")
        .delete().eq("closing_id", existing.id).neq("source_type", "manual_adjustment");
      if (delErr) throw delErr;
      // Reverte resgates que ESTE fechamento havia feito (voltam a ficar pendentes).
      await supabase.from("payout_pending_repasse")
        .update({ status: "open", resolved_in_closing_id: null, resolved_at: null })
        .eq("resolved_in_closing_id", existing.id);
      // Remove as pendências que ESTE fechamento havia detectado (serão redetectadas do zero).
      await supabase.from("payout_pending_repasse")
        .delete().eq("detected_in_closing_id", existing.id).eq("status", "open");
      await supabase.from("payout_monthly_closings")
        .update({ generated_at: new Date().toISOString() }).eq("id", existing.id);
      closing = existing;
    } else {
      const { data: newClosing, error: closingError } = await supabase.from("payout_monthly_closings").insert({
        competence, status: "pending_approval",
      }).select().single();
      if (closingError) throw closingError;
      closing = newClosing;
    }

    // Itens do mês corrente (pagos) e pendências (não pagos).
    const currentItems = buildGroupedItems(paidContracts)
      .map((it: any) => ({ ...it, closing_id: closing.id, reference_competence: competence }));

    const pendingRows = buildGroupedItems(unpaidContracts)
      .map((it: any) => ({ ...it, reference_competence: competence, status: "open", detected_in_closing_id: closing.id }));

    // Resgata pendências de meses anteriores cujo contrato já foi pago.
    const { data: openPendings } = await supabase.from("payout_pending_repasse")
      .select("*").eq("status", "open").lt("reference_competence", competence);
    const paidContractIds = new Set(
      contracts.filter((c: any) => c.payment_status === "paid").map((c: any) => c.id)
    );
    const carriedItems: any[] = [];
    const resolvedIds: string[] = [];
    for (const pend of (openPendings || [])) {
      if (!paidContractIds.has(pend.contract_id)) continue;
      carriedItems.push({
        closing_id:  closing.id,
        coach_id:    pend.coach_id,
        source_type: pend.source_type,
        contract_id: pend.contract_id,
        description: pend.description,
        amount:      Number(pend.amount),
        valid_days:  pend.valid_days, month_days: pend.month_days, prorata_factor: pend.prorata_factor,
        rate_applied: pend.rate_applied, tier_applied: pend.tier_applied,
        base_value: pend.base_value, leadership_bonus: pend.leadership_bonus,
        reference_competence: pend.reference_competence, // mês original (carimbo do resgate)
      });
      resolvedIds.push(pend.id);
    }

    const items = [...currentItems, ...carriedItems];

    // Persiste
    if (items.length > 0) {
      const { error } = await supabase.from("payout_monthly_statement_items").insert(items);
      if (error) throw error;
    }
    if (pendingRows.length > 0) {
      const { error } = await supabase.from("payout_pending_repasse").insert(pendingRows);
      if (error) throw error;
    }
    if (resolvedIds.length > 0) {
      await supabase.from("payout_pending_repasse")
        .update({ status: "resolved", resolved_in_closing_id: closing.id, resolved_at: new Date().toISOString() })
        .in("id", resolvedIds);
    }

    // Total a pagar = itens (mês corrente + resgatados). Pendências não somam.
    const total = items.reduce((s, i) => s + Number(i.amount), 0);

    return new Response(JSON.stringify({
      ok: true, closing_id: closing.id,
      regenerated: !!existing,
      tier_name: tier?.name, total_athletes: totalActive,
      items_count: items.length,
      items_current: currentItems.length,
      items_carried_in: carriedItems.length,
      pendings_count: pendingRows.length,
      total_amount: total,
      tier_snapshot: tierSnapshot,
    }), { headers: { "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
