import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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
    const monthDays = monthEnd.getUTCDate();

    // Fetch tudo (inclui plan_snapshot pra preservar histórico)
    const [contractsRes, plansRes, modalitiesRes, coachesRes, leavesRes, ratesRes, tiersRes] = await Promise.all([
      supabase.from("assessment_contracts").select("*"),
      supabase.from("assessment_plans").select("*"),
      supabase.from("assessment_modalities").select("*"),
      supabase.from("assessment_coaches").select("*"),
      supabase.from("assessment_leaves").select("*"),
      supabase.from("payout_role_modality_rates").select("*"),
      supabase.from("payout_growth_tiers").select("*"),
    ]);

    const contracts = contractsRes.data || [];
    const plans = plansRes.data || [];
    const modalities = modalitiesRes.data || [];
    const coaches = coachesRes.data || [];
    const leaves = leavesRes.data || [];
    const rates = ratesRes.data || [];
    const tiers = (tiersRes.data || []).sort((a: any, b: any) => b.min_athletes - a.min_athletes);

    // Contratos elegiveis: pagos e ativos/overdue/on_leave (exclui draft e finished)
    const eligible = contracts.filter((c: any) =>
      ["active", "overdue", "on_leave"].includes(c.status) && c.payment_status === "paid"
    );

    // Determina tier baseado no total de atletas ativos
    const totalActive = eligible.length;
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

    const items: any[] = [];

    for (const contract of eligible) {
      const cStart = new Date(contract.start_date + "T00:00:00Z");
      const cEnd = new Date(contract.end_date + "T00:00:00Z");
      if (cEnd < monthStart || cStart > monthEnd) continue;

      const periodStart = cStart > monthStart ? cStart : monthStart;
      const periodEnd = cEnd < monthEnd ? cEnd : monthEnd;
      let daysInMonth = Math.round((periodEnd.getTime() - periodStart.getTime()) / 86400000) + 1;

      // Subtrai dias de licença que caem no período
      const contractLeaves = leaves.filter((l: any) => l.contract_id === contract.id);
      for (const leave of contractLeaves) {
        const lStart = new Date(leave.start_date + "T00:00:00Z");
        const lEnd = new Date(leave.end_date + "T00:00:00Z");
        const ovStart = lStart > periodStart ? lStart : periodStart;
        const ovEnd = lEnd < periodEnd ? lEnd : periodEnd;
        if (ovEnd >= ovStart) {
          daysInMonth -= Math.round((ovEnd.getTime() - ovStart.getTime()) / 86400000) + 1;
        }
      }

      if (daysInMonth <= 0) continue;

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
      const prorata     = daysInMonth / monthDays;
      const amount      = Math.round(baseRate * prorata * 100) / 100;

      items.push({
        closing_id: closing.id, coach_id: coach.id, source_type: "athlete_repasse",
        contract_id: contract.id,
        description: `${contract.contract_number} — ${modality.name}`,
        amount,
        valid_days: daysInMonth, month_days: monthDays, prorata_factor: prorata,
        // Snapshots de auditoria
        rate_applied:     baseRate,
        tier_applied:     tierSnapshot,
        base_value:       baseRate,
        leadership_bonus: 0,
      });

      // Bonus de liderança
      const leadershipBonus = Number(tier?.leadership_bonus || 0);
      if (coach.leader_id && leadershipBonus > 0) {
        const lAmount = Math.round(leadershipBonus * prorata * 100) / 100;
        items.push({
          closing_id: closing.id, coach_id: coach.leader_id, source_type: "direct_leadership",
          contract_id: contract.id,
          description: `Liderança sobre ${coach.name} — ${contract.contract_number}`,
          amount: lAmount,
          valid_days: daysInMonth, month_days: monthDays, prorata_factor: prorata,
          rate_applied:     leadershipBonus,
          tier_applied:     tierSnapshot,
          base_value:       leadershipBonus,
          leadership_bonus: leadershipBonus,
        });
      }

      // Bonus de co-liderança
      const coLeadershipBonus = Number(tier?.co_leadership_bonus || 0);
      for (const coLeaderId of (coach.co_leader_ids || [])) {
        if (coLeadershipBonus > 0) {
          const cAmount = Math.round(coLeadershipBonus * prorata * 100) / 100;
          items.push({
            closing_id: closing.id, coach_id: coLeaderId, source_type: "co_leadership",
            contract_id: contract.id,
            description: `Co-liderança sobre ${coach.name} — ${contract.contract_number}`,
            amount: cAmount,
            valid_days: daysInMonth, month_days: monthDays, prorata_factor: prorata,
            rate_applied:     coLeadershipBonus,
            tier_applied:     tierSnapshot,
            base_value:       coLeadershipBonus,
            leadership_bonus: coLeadershipBonus,
          });
        }
      }
    }

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
