import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const EVENT_MAP: Record<string, string> = {
  PAYMENT_RECEIVED:  "paid",
  PAYMENT_CONFIRMED: "paid",
  PAYMENT_DELETED:   "cancelled",
  PAYMENT_REFUNDED:  "refunded",
  PAYMENT_OVERDUE:   "overdue",
  PAYMENT_RESTORED:  "charge_sent",
};

function mapPaymentMethod(asaasMethod: string, installments?: number): string {
  if (!asaasMethod) return "pix";
  const m = asaasMethod.toUpperCase();
  if (m === "PIX")    return "pix";
  if (m === "BOLETO") return "boleto";
  if (m === "CREDIT_CARD") {
    const n = Number(installments) || 1;
    return n > 1 ? `card_${n}x` : "credit_card";
  }
  return asaasMethod.toLowerCase();
}

async function returnCouponUse(supabase: any, orderId: string, orderType: string) {
  const { data: uses } = await supabase
    .from("coupon_uses").select("id")
    .eq("order_id", orderId).eq("order_type", orderType).eq("cancelled", false);
  if (!uses || uses.length === 0) return;
  for (const u of uses) {
    await supabase.from("coupon_uses").update({ cancelled: true }).eq("id", u.id);
  }
}

async function deleteAsaasPayment(supabase: any, paymentId: string) {
  try {
    await supabase.from("asaas_payments").delete().eq("asaas_payment_id", paymentId);
  } catch (e) {
    console.warn("[asaas-webhook] fail to delete asaas_payment:", e);
  }
}

async function upsertAsaasPayment(
  supabase: any,
  payment: any,
  orderId: string | null,
  orderType: string | null,
) {
  if (!payment?.id) return;

  if (payment.status === "CANCELLED") {
    await deleteAsaasPayment(supabase, payment.id);
    return;
  }

  try {
    if (orderId && orderType && ["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"].includes(payment.status)) {
      const { error: delErr } = await supabase
        .from("asaas_payments")
        .delete()
        .eq("order_id", orderId)
        .eq("order_type", orderType)
        .eq("source", "manual");
      if (delErr) {
        console.warn("[asaas-webhook] fail to clear manual rows:", delErr.message);
      }
    }

    const row = {
      asaas_payment_id:     payment.id,
      asaas_customer_id:    payment.customer || null,
      installment_group_id: payment.installment || null,
      installment_number:   payment.installmentNumber ?? null,
      total_installments:   null,
      billing_type:         payment.billingType || null,
      status:               payment.status,
      value:                Number(payment.value) || 0,
      net_value:            payment.netValue != null ? Number(payment.netValue) : null,
      due_date:             payment.dueDate || null,
      payment_date:         payment.paymentDate || null,
      credit_date:          payment.creditDate || null,
      description:          payment.description || null,
      external_reference:   payment.externalReference || null,
      order_id:             orderId,
      order_type:           orderType,
      raw:                  payment,
      last_synced_at:       new Date().toISOString(),
    };
    const { error } = await supabase
      .from("asaas_payments")
      .upsert(row, { onConflict: "asaas_payment_id" });
    if (error) console.warn("[asaas-webhook] upsert asaas_payments failed:", error.message);
  } catch (e) {
    console.warn("[asaas-webhook] upsert asaas_payments exception:", e);
  }
}

Deno.serve(async (req: Request) => {
  const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  const unauthorized = () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  const misconfigured = () => new Response(JSON.stringify({ error: "webhook misconfigured" }), { status: 500, headers: { "Content-Type": "application/json" } });

  // ✅ SEGURANÇA: token agora é OBRIGATÓRIO. Sem token configurado = recusa todas as requisições.
  const expectedToken = Deno.env.get("ASAAS_WEBHOOK_TOKEN");
  if (!expectedToken) {
    console.error("asaas-webhook: ASAAS_WEBHOOK_TOKEN não configurado");
    return misconfigured();
  }
  const received = req.headers.get("asaas-access-token") || "";
  if (received !== expectedToken) {
    console.warn("asaas-webhook: token mismatch");
    return unauthorized();
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body    = await req.json().catch(() => ({}));
    const event   = body?.event as string;
    const payment = body?.payment;
    if (!event || !payment?.id) return ok();

    const chargeId = payment.id;
    console.log("[asaas-webhook]", event, "chargeId:", chargeId);

    if (event === "PAYMENT_DELETED") {
      await deleteAsaasPayment(supabase, chargeId);
    }

    if (event === "PAYMENT_UPDATED") {
      let matchedOrderId: string | null = null;
      let matchedOrderType: string | null = null;

      if (payment.dueDate) {
        for (const [table, type] of [
          ["presale_orders", "presale"],
          ["stock_orders", "stock"],
          ["assessment_contracts", "contract"],
        ]) {
          const { data: row } = await supabase
            .from(table).select("id").eq("asaas_charge_id", chargeId).maybeSingle();
          if (row) {
            await supabase.from(table).update({ due_date: payment.dueDate }).eq("id", row.id);
            matchedOrderId   = row.id;
            matchedOrderType = type;
            console.log("[asaas-webhook] updated due_date on", table, row.id);
            break;
          }
        }
      }
      await upsertAsaasPayment(supabase, payment, matchedOrderId, matchedOrderType);
      return ok();
    }

    const newStatus = EVENT_MAP[event];
    if (!newStatus) {
      await upsertAsaasPayment(supabase, payment, null, null);
      return ok();
    }

    let { data: presaleOrder } = await supabase
      .from("presale_orders")
      .select("id, payment_status")
      .eq("asaas_charge_id", chargeId)
      .maybeSingle();

    if (presaleOrder) {
      const updates: Record<string, unknown> = { payment_status: newStatus };
      if (newStatus === "paid") {
        updates.payment_date = payment.paymentDate || new Date().toISOString().split("T")[0];
      }
      if (newStatus === "cancelled") {
        updates.asaas_charge_id    = null;
        updates.asaas_payment_link = null;
        updates.asaas_pix_qrcode   = null;
        updates.asaas_pix_copy     = null;
      }
      await supabase.from("presale_orders").update(updates).eq("id", presaleOrder.id);
      if (newStatus === "refunded" || newStatus === "cancelled") {
        await returnCouponUse(supabase, presaleOrder.id, "presale");
      }
      await upsertAsaasPayment(supabase, payment, presaleOrder.id, "presale");
      console.log("[asaas-webhook] presale_order", presaleOrder.id, "→", newStatus);
      return ok();
    }

    let { data: stockOrder } = await supabase
      .from("stock_orders")
      .select("id, payment_status")
      .eq("asaas_charge_id", chargeId)
      .maybeSingle();

    if (stockOrder) {
      const updates: Record<string, unknown> = { payment_status: newStatus };
      if (newStatus === "paid") {
        updates.payment_date = payment.paymentDate || new Date().toISOString().split("T")[0];
      }
      if (newStatus === "cancelled") {
        updates.asaas_charge_id    = null;
        updates.asaas_payment_link = null;
        updates.asaas_pix_qrcode   = null;
        updates.asaas_pix_copy     = null;
      }
      await supabase.from("stock_orders").update(updates).eq("id", stockOrder.id);
      if (newStatus === "refunded" || newStatus === "cancelled") {
        await returnCouponUse(supabase, stockOrder.id, "stock");
      }
      await upsertAsaasPayment(supabase, payment, stockOrder.id, "stock");
      console.log("[asaas-webhook] stock_order", stockOrder.id, "→", newStatus);
      return ok();
    }

    let { data: contract } = await supabase
      .from("assessment_contracts")
      .select("id, payment_status, installments")
      .eq("asaas_charge_id", chargeId)
      .maybeSingle();

    if (contract) {
      const updates: Record<string, unknown> = { payment_status: newStatus };
      if (newStatus === "paid") {
        updates.payment_date = payment.paymentDate || new Date().toISOString().split("T")[0];
        if (payment.billingType) {
          updates.payment_method = mapPaymentMethod(payment.billingType, contract.installments);
        }
      }
      if (newStatus === "cancelled") {
        updates.asaas_charge_id    = null;
        updates.asaas_payment_link = null;
        updates.asaas_pix_qrcode   = null;
        updates.asaas_pix_copy     = null;
      }
      await supabase.from("assessment_contracts").update(updates).eq("id", contract.id);
      await upsertAsaasPayment(supabase, payment, contract.id, "contract");
      console.log("[asaas-webhook] assessment_contract", contract.id, "→", newStatus);
      return ok();
    }

    await upsertAsaasPayment(supabase, payment, null, null);
    console.log("[asaas-webhook] no match for chargeId", chargeId);
    return ok();
  } catch (e) {
    console.error("[asaas-webhook] error", e);
    return ok();
  }
});
