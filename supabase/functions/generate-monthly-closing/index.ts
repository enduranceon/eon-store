import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requireAdmin } from "../_shared/requireAdmin.ts";
import {
  buildClosingGroups,
  buildGroupedItems,
  type ClosingContext,
  competenceBounds,
  effectiveEndExclusive,
  groupByContract,
  mergePendingCollisions,
  parseDateUTC,
} from "./calculation.ts";

// Gera o fechamento de repasse de uma competência.
//
// Modelo de pendências (carry-forward):
//   - Contratos PAGOS vigentes no mês  -> itens do fechamento (reference = competência atual).
//   - Contratos ATIVOS NÃO pagos       -> PENDÊNCIAS congeladas (payout_pending_repasse), com o
//                                          valor calculado pelas regras do mês em que ficaram devendo.
//   - Pendências de meses anteriores cujo contrato JÁ pagou -> RESGATADAS: entram como item no
//                                          fechamento atual, mas carimbadas com reference = mês original.
//
// Body: { competence: "YYYY-MM-01", regenerate?: boolean }. Aprovado/pago nunca recalcula.
//
// O valor de cada dia segue o plano e o treinador que valiam naquele dia
// (históricos de plano e de treinador do contrato); ver calculation.ts.
// Mudança de plano com cobrança em aberto: o contrato pago recebe pela taxa do
// plano anterior e a diferença vira pendência ligada ao pedido
// (plan_change_id), resgatada quando o pedido for pago.
//
// ORDEM DO HANDLER (não reordenar): OPTIONS -> método -> requireAdmin -> corpo.
// O preflight do navegador não manda Authorization; se o guard vier antes, ele
// responde 401 e o botão "Recalcular" quebra na tela. E todas as respostas —
// inclusive 401/403 — precisam sair com os headers de CORS, senão o navegador
// não consegue ler a mensagem de erro.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Lê a tabela inteira, em páginas ordenadas por id: o PostgREST corta cada
// resposta no limite de linhas da API, e um fechamento com contratos faltando
// pagaria errado sem avisar. Erro de leitura interrompe o fechamento.
// deno-lint-ignore no-explicit-any
async function fetchAllRows(supabase: any, table: string, columns: string, filter?: (query: any) => any) {
  // deno-lint-ignore no-explicit-any
  const rows: any[] = [];
  for (;;) {
    let query = supabase.from(table).select(columns).order("id", { ascending: true })
      .range(rows.length, rows.length + 999);
    if (filter) query = filter(query);
    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) return rows;
    rows.push(...data);
  }
}

Deno.serve(async (req: Request) => {
  // 1) Preflight do navegador: responde na hora, SEM auth e SEM tocar no banco.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 2) Só POST executa. Evita que GET/HEAD disparem geração de competência.
  if (req.method !== "POST") {
    return json({ error: "Método não permitido. Use POST." }, 405);
  }

  // 3) 🔒 AUTHZ: só admin allowlistado. verify_jwt sozinho não basta — a anon key
  //    pública também é um JWT válido, e esta função usa service_role (ignora RLS).
  const gate = await requireAdmin(req);
  if (!gate.ok) {
    return json({ error: gate.error || "unauthorized" }, gate.status);
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const body = await req.json().catch(() => ({}));
    const competence = body?.competence as string | undefined;

    // Competência é obrigatória: nunca assume "mês atual" por conta própria.
    // (Era o default silencioso que fez um preflight gerar um fechamento fantasma.)
    if (!competence || !/^\d{4}-\d{2}-01$/.test(competence)) {
      return json({ error: "Informe a competência no formato YYYY-MM-01." }, 400);
    }

    const regenerate = body?.regenerate === true;

    // Já existe fechamento pra essa competência?
    const { data: existing } = await supabase.from("payout_monthly_closings")
      .select("id, status").eq("competence", competence).maybeSingle();

    // Aprovado/pago nunca recalcula — protege valores já congelados.
    if (existing && existing.status !== "pending_approval") {
      return json({
        error: "Fechamento já existe e foi aprovado/pago para essa competência.",
        closing_id: existing.id,
      }, 409);
    }

    // Existe em revisão, mas o recálculo não foi pedido explicitamente.
    if (existing && !regenerate) {
      return json({
        error: "Fechamento já existe para essa competência (em revisão).",
        closing_id: existing.id,
      }, 409);
    }

    const { monthStart, monthEndExclusive, monthDays } = competenceBounds(competence);

    // Fetch tudo (inclui plan_snapshot e os históricos pra preservar o que valia em cada dia)
    const [
      contracts, plans, modalities, coaches, customers, leaves, rates, tierRows,
      planHistory, coachHistory, planChanges,
    ] =
      await Promise.all([
        fetchAllRows(supabase, "assessment_contracts", "*"),
        fetchAllRows(supabase, "assessment_plans", "*"),
        fetchAllRows(supabase, "assessment_modalities", "*"),
        fetchAllRows(supabase, "assessment_coaches", "*"),
        fetchAllRows(supabase, "presale_customers", "id, full_name"),
        fetchAllRows(supabase, "assessment_leaves", "*"),
        fetchAllRows(supabase, "payout_role_modality_rates", "*"),
        fetchAllRows(supabase, "payout_growth_tiers", "*"),
        fetchAllRows(
          supabase,
          "assessment_contract_plan_history",
          "id, contract_id, plan_id, plan_snapshot, valid_from, change_type, plan_change_id",
        ),
        fetchAllRows(supabase, "assessment_contract_coach_history", "id, contract_id, coach_id, started_at, ended_at, created_at"),
        fetchAllRows(supabase, "assessment_contract_plan_changes", "id, contract_id, status, payment_status"),
      ]);

    const tiers = tierRows.sort((a: any, b: any) => b.min_athletes - a.min_athletes);
    const customersById = new Map(customers.map((c: any) => [c.id, c]));

    // Contrato tem vigência (dias) dentro da competência?
    const overlapsMonth = (c: any) => {
      const cStart = parseDateUTC(c.start_date, monthStart);
      const cEnd = effectiveEndExclusive(c, monthEndExclusive);
      return cStart < monthEndExclusive && cEnd > monthStart;
    };

    // Pagos e vigentes no mês (base do repasse e do tier). Contratos
    // cancelados contam até a cancellation_date; draft/voided nunca contam.
    const paidContracts = contracts.filter((c: any) =>
      !["draft", "voided"].includes(c.status) &&
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

    const closingContext: ClosingContext = {
      monthStart, monthEndExclusive, monthDays,
      leaves, coaches, plans, modalities, rates,
      tier, tierSnapshot, customersById,
      planHistoryByContract: groupByContract(planHistory),
      coachHistoryByContract: groupByContract(coachHistory),
      planChangesById: new Map(planChanges.map((change: any) => [change.id, change])),
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

    // Itens do mês corrente (pagos) e pendências (não pagos e diferenças de
    // mudanças de plano ainda não pagas).
    const paidGroups = buildClosingGroups(paidContracts, closingContext, true);
    const currentItems = paidGroups.items
      .map((it: any) => ({ ...it, closing_id: closing.id, reference_competence: competence }));

    const pendingRows = mergePendingCollisions(
      [...buildGroupedItems(unpaidContracts, closingContext), ...paidGroups.differences]
        .map((it: any) => ({ ...it, reference_competence: competence, status: "open", detected_in_closing_id: closing.id })),
    );

    // Resgata pendências de meses anteriores cujo contrato já foi pago.
    const openPendings = await fetchAllRows(supabase, "payout_pending_repasse", "*",
      (query) => query.eq("status", "open").lt("reference_competence", competence));
    const paidContractIds = new Set(
      contracts.filter((c: any) => c.payment_status === "paid").map((c: any) => c.id)
    );
    const settledPlanChangeIds = new Set(
      planChanges
        .filter((change: any) => ["paid", "not_required"].includes(change.payment_status))
        .map((change: any) => change.id),
    );
    const carriedItems: any[] = [];
    const resolvedIds: string[] = [];
    for (const pend of openPendings) {
      const releasable = pend.plan_change_id
        ? settledPlanChangeIds.has(pend.plan_change_id)
        : paidContractIds.has(pend.contract_id);
      if (!releasable) continue;
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
        segments: pend.segments ?? null,
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

    return json({
      ok: true, closing_id: closing.id,
      regenerated: !!existing,
      tier_name: tier?.name, total_athletes: totalActive,
      items_count: items.length,
      items_current: currentItems.length,
      items_carried_in: carriedItems.length,
      pendings_count: pendingRows.length,
      total_amount: total,
      tier_snapshot: tierSnapshot,
    });
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
