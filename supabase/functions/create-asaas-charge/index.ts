import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requireAdmin } from "../_shared/requireAdmin.ts";

// ✅ SEGURANÇA: sem fallback hardcoded.
const ASAAS_BASE    = Deno.env.get("ASAAS_BASE_URL");
const ASAAS_API_KEY = Deno.env.get("ASAAS_API_KEY");

function mapStatus(s: string) {
  switch (s) {
    case "RECEIVED": case "CONFIRMED": return { label: "Pago", color: "success", is_paid: true };
    case "PENDING":  return { label: "Aguardando pagamento", color: "warning", is_paid: false };
    case "OVERDUE":  return { label: "Vencido", color: "danger",  is_paid: false };
    case "REFUNDED": return { label: "Estornado", color: "info",   is_paid: false };
    case "CANCELLED":return { label: "Cancelado", color: "danger", is_paid: false };
    default:         return { label: s, color: "secondary", is_paid: false };
  }
}

Deno.serve(async (req: Request) => {
  // 🔒 AUTHZ: só admin allowlistado (verify_jwt sozinho aceita a anon key pública)
  const gate = await requireAdmin(req);
  if (!gate.ok) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: gate.status, headers: { "Content-Type": "application/json" },
    });
  }

  // ✅ SEGURANÇA: aborta se envs não configuradas
  if (!ASAAS_BASE || !ASAAS_API_KEY) {
    console.error("create-asaas-charge: ASAAS_BASE_URL ou ASAAS_API_KEY não configurados");
    return new Response(JSON.stringify({ error: "server misconfigured" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const body = await req.json();
  const { action, order_id, order_type, cpf, billing_type, due_date, installments, reason, value } = body;

  const table = order_type === "stock"
    ? "stock_orders"
    : order_type === "contract"
      ? "assessment_contracts"
      : "presale_orders";

  const { data: order, error: orderError } = await supabase
    .from(table).select("*").eq("id", order_id).single();

  if (orderError || !order) {
    return new Response(JSON.stringify({ error: "Pedido não encontrado" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }

  const chargeId = order.asaas_charge_id;

  if (action === "status") {
    if (!chargeId) return new Response(JSON.stringify({ error: "Sem cobrança Asaas" }), { status: 400 });

    const res  = await fetch(`${ASAAS_BASE}/payments/${chargeId}`, { headers: { access_token: ASAAS_API_KEY } });
    const data = await res.json();
    const mapped = mapStatus(data.status);

    if (mapped.is_paid) {
      await supabase.from(table).update({
        payment_status: "paid",
        payment_date: data.paymentDate || new Date().toISOString().split("T")[0],
      }).eq("id", order_id);
    }

    return new Response(JSON.stringify(mapped), { headers: { "Content-Type": "application/json" } });
  }

  if (action === "cancel") {
    if (!chargeId) return new Response(JSON.stringify({ error: "Sem cobrança Asaas" }), { status: 400 });

    const res = await fetch(`${ASAAS_BASE}/payments/${chargeId}`, {
      method: "DELETE",
      headers: { access_token: ASAAS_API_KEY },
    });

    if (!res.ok) {
      const err = await res.json();
      return new Response(JSON.stringify({ error: err.errors?.[0]?.description || "Erro ao cancelar" }), { status: 400 });
    }

    await supabase.from(table).update({
      payment_status: "cancelled",
      asaas_charge_id: null,
      asaas_payment_link: null,
      asaas_pix_qrcode: null,
      asaas_pix_copy: null,
    }).eq("id", order_id);

    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  }

  if (action === "refund") {
    if (!chargeId) return new Response(JSON.stringify({ error: "Sem cobrança Asaas" }), { status: 400 });

    const refundBody: Record<string, unknown> = {
      description: reason || "Estorno solicitado",
    };
    if (value !== undefined && value !== null) {
      refundBody.value = parseFloat(String(value));
    }

    const res = await fetch(`${ASAAS_BASE}/payments/${chargeId}/refund`, {
      method: "POST",
      headers: { access_token: ASAAS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(refundBody),
    });

    if (!res.ok) {
      const err = await res.json();
      return new Response(JSON.stringify({ error: err.errors?.[0]?.description || "Erro ao estornar" }), { status: 400 });
    }

    const isFullRefund = value === undefined || value === null;
    if (isFullRefund) {
      await supabase.from(table).update({ payment_status: "refunded" }).eq("id", order_id);
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  }

  if (action === "create") {
    if (order_type === "contract") {
      return new Response(JSON.stringify({ error: "Use generate-assessment-charge para contratos" }), { status: 400 });
    }
    const customerName  = order_type === "stock" ? order.customer_name  : order.checkout_name;
    const customerEmail = order_type === "stock" ? order.customer_email : order.checkout_email;
    const customerPhone = order_type === "stock" ? order.customer_whatsapp : order.checkout_whatsapp;
    const cleanCpf = (cpf || "").replace(/\D/g, "");

    let asaasCustomerId = order.asaas_customer_id;

    if (!asaasCustomerId) {
      const searchRes  = await fetch(`${ASAAS_BASE}/customers?cpfCnpj=${cleanCpf}`, { headers: { access_token: ASAAS_API_KEY } });
      const searchData = await searchRes.json();

      if (searchData.data?.length > 0) {
        asaasCustomerId = searchData.data[0].id;
      } else {
        const createRes  = await fetch(`${ASAAS_BASE}/customers`, {
          method: "POST",
          headers: { access_token: ASAAS_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ name: customerName, cpfCnpj: cleanCpf, email: customerEmail || undefined, phone: customerPhone || undefined }),
        });
        const createData = await createRes.json();
        if (!createRes.ok) {
          return new Response(JSON.stringify({ error: createData.errors?.[0]?.description || "Erro ao criar cliente no Asaas" }), { status: 400 });
        }
        asaasCustomerId = createData.id;
      }
      await supabase.from(table).update({ asaas_customer_id: asaasCustomerId }).eq("id", order_id);
    }

    const paymentBody: Record<string, unknown> = {
      customer: asaasCustomerId,
      billingType: billing_type || "PIX",
      value: order.total_value,
      dueDate: due_date,
      description: `Pedido ${order.order_number}`,
      externalReference: order.order_number,
    };

    if (billing_type === "CREDIT_CARD" && installments > 1) {
      paymentBody.installmentCount = installments;
      paymentBody.installmentValue = Math.ceil((order.total_value / installments) * 100) / 100;
    }

    const payRes  = await fetch(`${ASAAS_BASE}/payments`, {
      method: "POST",
      headers: { access_token: ASAAS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(paymentBody),
    });
    const payData = await payRes.json();

    if (!payRes.ok) {
      return new Response(JSON.stringify({ error: payData.errors?.[0]?.description || "Erro ao criar cobrança" }), { status: 400 });
    }

    const newChargeId  = payData.id;
    const paymentLink  = payData.invoiceUrl || payData.bankSlipUrl || null;
    let pixQrCode: string | null = null;
    let pixCopy:   string | null = null;

    if (billing_type === "PIX") {
      const pixRes  = await fetch(`${ASAAS_BASE}/payments/${newChargeId}/pixQrCode`, { headers: { access_token: ASAAS_API_KEY } });
      const pixData = await pixRes.json();
      if (pixRes.ok) { pixQrCode = pixData.encodedImage || null; pixCopy = pixData.payload || null; }
    }

    await supabase.from(table).update({
      asaas_charge_id:    newChargeId,
      asaas_payment_link: paymentLink,
      asaas_pix_qrcode:   pixQrCode,
      asaas_pix_copy:     pixCopy,
      payment_status:     "charge_sent",
      payment_method: billing_type === "CREDIT_CARD" ? `card_${installments}x` : billing_type === "BOLETO" ? "boleto" : "pix",
    }).eq("id", order_id);

    return new Response(JSON.stringify({ ok: true, charge_id: newChargeId }), { headers: { "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({ error: "Action inválida" }), { status: 400 });
});
