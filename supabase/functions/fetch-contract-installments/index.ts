import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requireAdmin } from "../_shared/requireAdmin.ts";

const ASAAS_BASE    = Deno.env.get("ASAAS_BASE_URL") ?? "https://sandbox.asaas.com/api/v3";
const ASAAS_API_KEY = Deno.env.get("ASAAS_API_KEY");

// Statuses Asaas que significam "já foi cobrado/recebido" (dinheiro entrou)
const PAID_STATUSES    = new Set(["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"]);
// Statuses que significam "ainda não foi cobrado" (cancelar sem estornar)
const PENDING_STATUSES = new Set(["PENDING", "AWAITING_RISK_ANALYSIS"]);
// Vencidas mas não pagas → cancelar também
const OVERDUE_STATUSES = new Set(["OVERDUE"]);

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  // 🔒 AUTHZ: só admin allowlistado
  const gate = await requireAdmin(req);
  if (!gate.ok) return json({ error: "unauthorized" }, gate.status);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey || !ASAAS_API_KEY) return json({ error: "Env vars missing" }, 500);
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const { contract_id } = await req.json();
    if (!contract_id) return json({ error: "contract_id obrigatório" }, 400);

    const { data: contract, error: cErr } = await supabase
      .from("assessment_contracts")
      .select("asaas_charge_id, installments, payment_method")
      .eq("id", contract_id)
      .single();

    if (cErr || !contract) return json({ error: "Contrato não encontrado" }, 404);

    // Sem cobrança Asaas
    if (!contract.asaas_charge_id) {
      return json({ installments: [], isSingle: false, noCharge: true });
    }

    const chargeId = contract.asaas_charge_id;

    // ─── Busca pagamento principal ────────────────────────────────
    const mainRes = await fetch(`${ASAAS_BASE}/payments/${chargeId}`, {
      headers: { access_token: ASAAS_API_KEY },
    });

    if (!mainRes.ok) {
      const body = await mainRes.json().catch(() => ({}));
      console.error("[fetch-contract-installments] Asaas error:", body);
      return json({ installments: [], asaasError: true, noCharge: false });
    }

    const mainPayment = await mainRes.json();

    const buildItem = (p: Record<string, unknown>) => ({
      id:          p.id,
      number:      (p.installmentNumber as number) ?? 1,
      total:       1,
      value:       Number(p.value)    || 0,
      netValue:    Number(p.netValue) || Number(p.value) || 0,
      status:      p.status as string,
      dueDate:     p.dueDate     ?? null,
      paymentDate: p.paymentDate ?? null,
      creditDate:  p.creditDate  ?? null,
      isPaid:      PAID_STATUSES.has(p.status as string),
      isPending:   PENDING_STATUSES.has(p.status as string) || OVERDUE_STATUSES.has(p.status as string),
    });

    // ─── Pagamento único (sem grupo de parcelamento) ───────────────
    if (!mainPayment.installment) {
      return json({
        installments: [{ ...buildItem(mainPayment), total: 1 }],
        isSingle: true,
        installmentGroupId: null,
      });
    }

    // ─── Parcelado: busca todas as parcelas do grupo ───────────────
    const groupId = mainPayment.installment as string;
    const listRes = await fetch(
      `${ASAAS_BASE}/payments?installment=${groupId}&limit=100`,
      { headers: { access_token: ASAAS_API_KEY } },
    );

    if (!listRes.ok) {
      // Fallback: retorna só o principal
      return json({
        installments: [{ ...buildItem(mainPayment), total: 1 }],
        isSingle: false,
        asaasError: false,
        installmentGroupId: groupId,
      });
    }

    const listData = await listRes.json();
    const payments = ((listData.data ?? []) as Record<string, unknown>[])
      .sort((a, b) => ((a.installmentNumber as number) ?? 0) - ((b.installmentNumber as number) ?? 0));

    const total = payments.length;
    return json({
      installments: payments.map(p => ({ ...buildItem(p), total })),
      isSingle: false,
      installmentGroupId: groupId,
    });

  } catch (e) {
    console.error("[fetch-contract-installments]", e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
