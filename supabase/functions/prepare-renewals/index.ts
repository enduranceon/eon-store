import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Cria contratos de renovação em status 'draft' para contratos que estão prestes a vencer.
// Idempotente: usa renewal_generated=true como flag para nunca gerar 2x.
//
// Body (opcional):
//   { horizon_days: 30 }  // janela em dias antes do end_date (default 30)
//   { contract_ids: ["uuid", ...] }  // força renovação só desses (ignora horizon)
//
// Retorna: { ok, processed, drafts_created, errors }

function addMonthsToDate(dateStr: string, months: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function getPlanMonths(plan: any, snapshot: any): number {
  if (snapshot?.period_months) return Number(snapshot.period_months);
  if (plan?.period_months) return Number(plan.period_months);
  const periodMap: Record<string, number> = { mensal: 1, trimestral: 3, semestral: 6, anual: 12 };
  return periodMap[snapshot?.period || plan?.period] || 1;
}

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const body = await req.json().catch(() => ({}));
    const horizonDays = Math.max(1, Math.min(90, Number(body?.horizon_days) || 30));
    const forcedIds: string[] | null = Array.isArray(body?.contract_ids) ? body.contract_ids : null;

    // Janela: hoje até hoje+horizonte
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayStr = today.toISOString().slice(0, 10);
    const horizon = new Date(today);
    horizon.setUTCDate(horizon.getUTCDate() + horizonDays);
    const horizonStr = horizon.toISOString().slice(0, 10);

    // Busca contratos candidatos
    let query = supabase
      .from("assessment_contracts")
      .select("*")
      .in("status", ["active", "on_leave", "overdue"])
      .or("renewal_generated.is.null,renewal_generated.eq.false");

    if (forcedIds && forcedIds.length > 0) {
      query = query.in("id", forcedIds);
    } else {
      query = query.gte("end_date", todayStr).lte("end_date", horizonStr);
    }

    const { data: candidates, error: candErr } = await query;
    if (candErr) throw candErr;

    if (!candidates || candidates.length === 0) {
      return new Response(JSON.stringify({
        ok: true, processed: 0, drafts_created: 0,
        message: "Nenhum contrato dentro da janela de renovação.",
      }), { headers: { "Content-Type": "application/json" } });
    }

    // Busca planos para fallback de snapshot (caso contrato antigo sem snapshot)
    const planIds = [...new Set(candidates.map((c: any) => c.plan_id))];
    const { data: plans } = await supabase
      .from("assessment_plans").select("*").in("id", planIds);
    const planMap = new Map((plans || []).map((p: any) => [p.id, p]));

    const results: any[] = [];
    const errors: any[] = [];
    let draftsCreated = 0;

    for (const parent of candidates) {
      try {
        const plan = planMap.get(parent.plan_id);
        // Snapshot: prefere o do contrato pai (preserva valor original);
        // se não tiver, monta do plano vivo.
        let snapshot = parent.plan_snapshot;
        if (!snapshot && plan) {
          snapshot = {
            plan_id:           plan.id,
            name:              plan.name || null,
            modality_id:       plan.modality_id,
            price_total:       Number(plan.price_total) || 0,
            price_monthly:     Number(plan.price_monthly) || 0,
            enrollment_fee:    Number(plan.enrollment_fee) || 0,
            max_installments:  plan.max_installments,
            period_months:     plan.period_months,
            period:            plan.period,
            revenue_center_id: plan.revenue_center_id || null,
            snapshot_at:       new Date().toISOString(),
            snapshot_source:   "prepare_renewals_fallback",
          };
        }
        // Renovação começa quando o atual termina
        const newStart = parent.end_date;
        const months   = getPlanMonths(plan, snapshot);
        const newEnd   = addMonthsToDate(newStart, months);

        // Cria o draft
        const { data: draft, error: draftErr } = await supabase
          .from("assessment_contracts")
          .insert({
            customer_id:        parent.customer_id,
            coach_id:           parent.coach_id,
            plan_id:            parent.plan_id,
            plan_snapshot:      snapshot,
            status:             "draft",
            start_date:         newStart,
            end_date:           newEnd,
            original_end_date:  newEnd,
            due_date:           newEnd,
            installments:       parent.installments || 1,
            enrollment_fee:     0, // renovações não cobram matrícula
            manual_discount:    0,
            payment_status:     "pending",
            payment_method:     parent.payment_method,
            auto_renewal:       parent.auto_renewal || false,
            parent_contract_id: parent.id,
            notes:              `Renovação gerada automaticamente de ${parent.contract_number} em ${todayStr}`,
          })
          .select()
          .single();
        if (draftErr) throw draftErr;

        // Marca o pai
        await supabase
          .from("assessment_contracts")
          .update({ renewal_generated: true })
          .eq("id", parent.id);

        // Evento no pai
        await supabase.from("assessment_contract_event").insert({
          contract_id: parent.id,
          event_type:  "renewal_drafted",
          payload: {
            draft_contract_id:     draft.id,
            draft_contract_number: draft.contract_number,
            draft_start:           newStart,
            draft_end:             newEnd,
            auto_generated:        true,
            horizon_days:          horizonDays,
          },
          notes: "Rascunho de renovação gerado automaticamente. Aguardando revisão.",
        });

        // Evento no draft (rastreia origem)
        await supabase.from("assessment_contract_event").insert({
          contract_id: draft.id,
          event_type:  "created",
          payload: {
            via:                  "auto_renewal_draft",
            parent_contract_id:   parent.id,
            parent_contract_num:  parent.contract_number,
            plan_id:              parent.plan_id,
            installments:         parent.installments,
          },
          notes: `Rascunho de renovação de ${parent.contract_number}`,
        });

        draftsCreated++;
        results.push({
          parent_id:          parent.id,
          parent_number:      parent.contract_number,
          draft_id:           draft.id,
          draft_number:       draft.contract_number,
          new_start:          newStart,
          new_end:            newEnd,
        });
      } catch (e: any) {
        errors.push({
          contract_id:     parent.id,
          contract_number: parent.contract_number,
          error:           String(e?.message || e),
        });
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      processed:      candidates.length,
      drafts_created: draftsCreated,
      results,
      errors,
    }), { headers: { "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
