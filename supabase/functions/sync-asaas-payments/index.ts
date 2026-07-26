import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requireAdmin } from "../_shared/requireAdmin.ts";

// Backfill / reconciliação do cache asaas_payments a partir da API do Asaas.

// ✅ SEGURANÇA: sem fallback hardcoded. Falha se as envs não estiverem setadas.
const ASAAS_BASE    = Deno.env.get("ASAAS_BASE_URL");
const ASAAS_API_KEY = Deno.env.get("ASAAS_API_KEY");

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function toPaymentRow(p: any, orderId: string | null, orderType: string | null, totalInstallments: number | null) {
  return {
    asaas_payment_id:     p.id,
    asaas_customer_id:    p.customer || null,
    installment_group_id: p.installment || null,
    installment_number:   p.installmentNumber ?? null,
    total_installments:   totalInstallments,
    billing_type:         p.billingType || null,
    status:               p.status,
    value:                Number(p.value) || 0,
    net_value:            p.netValue != null ? Number(p.netValue) : null,
    due_date:             p.dueDate || null,
    payment_date:         p.paymentDate || null,
    credit_date:          p.creditDate || null,
    description:          p.description || null,
    external_reference:   p.externalReference || null,
    order_id:             orderId,
    order_type:           orderType,
    raw:                  p,
    last_synced_at:       new Date().toISOString(),
  };
}

async function fetchPaymentsForCharge(chargeId: string): Promise<any[]> {
  const mainRes = await fetch(`${ASAAS_BASE}/payments/${chargeId}`, {
    headers: { access_token: ASAAS_API_KEY! },
  });
  if (!mainRes.ok) {
    throw new Error(`Asaas GET /payments/${chargeId} → ${mainRes.status}`);
  }
  const main = await mainRes.json();

  if (!main.installment) return [main];

  const listRes = await fetch(
    `${ASAAS_BASE}/payments?installment=${main.installment}&limit=100`,
    { headers: { access_token: ASAAS_API_KEY! } },
  );
  if (!listRes.ok) return [main];
  const data = await listRes.json();
  return (data.data || []).sort((a: any, b: any) =>
    (a.installmentNumber ?? 0) - (b.installmentNumber ?? 0)
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  // 🔒 AUTHZ: só admin allowlistado
  const gate = await requireAdmin(req);
  if (!gate.ok) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: gate.status, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // ✅ SEGURANÇA: aborta se as envs críticas não estão configuradas
  if (!ASAAS_BASE || !ASAAS_API_KEY) {
    console.error("sync-asaas-payments: ASAAS_BASE_URL ou ASAAS_API_KEY não configurados");
    return new Response(JSON.stringify({ error: "server misconfigured" }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const body = await req.json().catch(() => ({}));
    const onlyOrderId    = body?.only_order_id as string | undefined;
    const onlyOrderType  = body?.only_order_type as string | undefined;
    const sinceDays      = Number(body?.since_days) || 365;

    const sinceDate = new Date();
    sinceDate.setUTCDate(sinceDate.getUTCDate() - sinceDays);
    const sinceStr = sinceDate.toISOString();

    const targets: Array<{ id: string; charge_id: string; type: string; installments?: number }> = [];

    if (onlyOrderId && onlyOrderType) {
      const table = onlyOrderType === "contract" ? "assessment_contracts"
        : onlyOrderType === "presale" ? "presale_orders"
        : "stock_orders";
      const { data } = await supabase.from(table)
        .select("id, asaas_charge_id, installments")
        .eq("id", onlyOrderId).maybeSingle();
      if (data?.asaas_charge_id) {
        targets.push({
          id: data.id, charge_id: data.asaas_charge_id, type: onlyOrderType,
          installments: (data as any).installments || 1,
        });
      }
    } else {
      const [presaleRes, stockRes, contractRes] = await Promise.all([
        supabase.from("presale_orders")
          .select("id, asaas_charge_id")
          .not("asaas_charge_id", "is", null)
          .gte("created_date", sinceStr),
        supabase.from("stock_orders")
          .select("id, asaas_charge_id")
          .not("asaas_charge_id", "is", null)
          .gte("created_date", sinceStr),
        supabase.from("assessment_contracts")
          .select("id, asaas_charge_id, installments")
          .not("asaas_charge_id", "is", null)
          .gte("created_at", sinceStr),
      ]);
      for (const o of presaleRes.data || []) targets.push({ id: o.id, charge_id: o.asaas_charge_id, type: "presale" });
      for (const o of stockRes.data   || []) targets.push({ id: o.id, charge_id: o.asaas_charge_id, type: "stock" });
      for (const c of contractRes.data || []) targets.push({
        id: c.id, charge_id: c.asaas_charge_id, type: "contract",
        installments: (c as any).installments || 1,
      });
    }

    if (targets.length === 0) {
      return new Response(JSON.stringify({
        ok: true, scanned: 0, upserted: 0,
        message: "Nenhum order/contrato com asaas_charge_id encontrado.",
      }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    let upserted = 0;
    let manualCleared = 0;
    const errors: any[] = [];

    for (const t of targets) {
      try {
        const payments = await fetchPaymentsForCharge(t.charge_id);
        if (!payments.length) continue;

        const totalInstallments = payments.length > 1 ? payments.length
          : (payments[0].installment ? (t.installments || null) : null);

        const hasRealPayment = payments.some(p =>
          ["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"].includes(p.status)
        );
        if (hasRealPayment) {
          const { error: delErr, count } = await supabase
            .from("asaas_payments")
            .delete({ count: "exact" })
            .eq("order_id", t.id)
            .eq("order_type", t.type)
            .eq("source", "manual");
          if (delErr) {
            console.warn("[sync] fail to clear manual rows for", t.id, delErr.message);
          } else if (count) {
            manualCleared += count;
          }
        }

        const rows = payments.map(p => toPaymentRow(p, t.id, t.type, totalInstallments));

        const { error: upErr } = await supabase
          .from("asaas_payments")
          .upsert(rows, { onConflict: "asaas_payment_id" });
        if (upErr) throw upErr;

        upserted += rows.length;
      } catch (e: any) {
        errors.push({
          order_id:   t.id,
          order_type: t.type,
          charge_id:  t.charge_id,
          error:      String(e?.message || e),
        });
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      scanned: targets.length,
      upserted,
      manual_cleared: manualCleared,
      errors,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
