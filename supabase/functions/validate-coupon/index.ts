import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function computeDiscount(coupon: any, subtotal: number) {
  let d;
  if (coupon.discount_type === "percentage") {
    d = subtotal * (Number(coupon.discount_value) / 100);
    if (coupon.max_discount) d = Math.min(d, Number(coupon.max_discount));
  } else {
    d = Math.min(Number(coupon.discount_value), subtotal);
  }
  return Math.round(d * 100) / 100;
}

function todayLocalStr() {
  // Server roda em UTC. Usa BRT (-3) pra alinhar com o app.
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json", ...CORS },
  });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json().catch(() => ({}));
    const code = (body?.code || "").trim().toUpperCase();
    const subtotal = Number(body?.subtotal) || 0;
    const customerIdentifier = body?.customer_identifier || null;

    if (!code) return json({ ok: false, error: "Informe o código" });

    const { data: coupon } = await supabase
      .from("coupons").select("*").ilike("code", code).maybeSingle();

    if (!coupon)        return json({ ok: false, error: "Cupom não encontrado" });
    if (!coupon.active) return json({ ok: false, error: "Cupom indisponível" });

    const today = todayLocalStr();
    if (coupon.valid_from  && coupon.valid_from  > today) return json({ ok: false, error: "Cupom ainda não está válido" });
    if (coupon.valid_until && coupon.valid_until < today) return json({ ok: false, error: "Cupom expirado" });

    if (coupon.min_purchase && subtotal < Number(coupon.min_purchase)) {
      return json({
        ok: false,
        error: `Pedido mínimo de R$ ${Number(coupon.min_purchase).toFixed(2).replace(".", ",")} para usar`,
      });
    }

    if (coupon.usage_limit_total && coupon.uses_count >= coupon.usage_limit_total) {
      return json({ ok: false, error: "Cupom esgotado" });
    }

    if (customerIdentifier && coupon.usage_limit_per_customer) {
      const { count } = await supabase
        .from("coupon_uses").select("id", { count: "exact", head: true })
        .eq("coupon_id", coupon.id)
        .eq("customer_identifier", customerIdentifier)
        .eq("cancelled", false);
      if ((count || 0) >= coupon.usage_limit_per_customer) {
        return json({ ok: false, error: "Você já usou esse cupom" });
      }
    }

    // Retorna apenas campos necessários (não vaza description, limites, etc)
    const safeCoupon = {
      id:             coupon.id,
      code:           coupon.code,
      discount_type:  coupon.discount_type,
      discount_value: coupon.discount_value,
      max_discount:   coupon.max_discount,
      min_purchase:   coupon.min_purchase,
      uses_count:     coupon.uses_count,
    };
    return json({ ok: true, coupon: safeCoupon, discount: computeDiscount(coupon, subtotal) });
  } catch (e) {
    return json({ ok: false, error: "Erro ao validar cupom" }, 500);
  }
});
