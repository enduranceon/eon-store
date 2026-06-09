import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  ...CORS_HEADERS,
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function publicItems(items: Array<Record<string, unknown>> = []) {
  return items.map(({ cost_price: _costPrice, ...item }) => item);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = req.method === "POST"
      ? await req.json().catch(() => ({}))
      : {};
    const url = new URL(req.url);
    const token = body?.public_token || body?.order_id || url.searchParams.get("token") || url.searchParams.get("id");

    if (!token || !UUID_PATTERN.test(token)) {
      return response({ error: "invalid_token" }, 400);
    }

    const presaleColumns = [
      "id", "public_token", "order_number", "total_value", "payment_status",
      "delivery_status", "payment_date", "delivery_date", "due_date", "items",
      "asaas_pix_copy", "asaas_pix_qrcode", "asaas_payment_link",
      "external_payment_link", "checkout_name", "coupon_code", "discount_value",
      "delivery_method", "delivery_city", "created_date", "payment_method",
      "payment_preference",
    ].join(",");

    const { data: presale } = await supabase
      .from("presale_orders")
      .select(presaleColumns)
      .or(`public_token.eq.${token},id.eq.${token}`)
      .maybeSingle();

    if (presale) {
      return response({
        order_type: "presale",
        order_number: presale.order_number,
        total_value: presale.total_value,
        payment_status: presale.payment_status,
        delivery_status: presale.delivery_status,
        payment_date: presale.payment_date,
        delivery_date: presale.delivery_date,
        due_date: presale.due_date,
        items: publicItems(presale.items || []),
        asaas_pix_copy: presale.asaas_pix_copy,
        asaas_pix_qrcode: presale.asaas_pix_qrcode,
        asaas_payment_link: presale.asaas_payment_link,
        external_payment_link: presale.external_payment_link,
        customer_name: presale.checkout_name,
        coupon_code: presale.coupon_code,
        discount_value: presale.discount_value,
        delivery_method: presale.delivery_method,
        delivery_city: presale.delivery_city,
        created_date: presale.created_date,
        payment_method: presale.payment_method,
        payment_preference: presale.payment_preference,
      });
    }

    const stockColumns = [
      "id", "public_token", "order_number", "total_value", "payment_status",
      "delivery_status", "payment_date", "delivery_date", "due_date", "items",
      "asaas_pix_copy", "asaas_pix_qrcode", "asaas_payment_link",
      "external_payment_link", "customer_name", "coupon_code", "discount_value",
      "delivery_method", "delivery_city", "created_date", "payment_method",
      "payment_preference",
    ].join(",");

    const { data: stock } = await supabase
      .from("stock_orders")
      .select(stockColumns)
      .or(`public_token.eq.${token},id.eq.${token}`)
      .maybeSingle();

    if (stock) {
      return response({
        order_type: "stock",
        order_number: stock.order_number,
        total_value: stock.total_value,
        payment_status: stock.payment_status,
        delivery_status: stock.delivery_status,
        payment_date: stock.payment_date,
        delivery_date: stock.delivery_date,
        due_date: stock.due_date,
        items: publicItems(stock.items || []),
        asaas_pix_copy: stock.asaas_pix_copy,
        asaas_pix_qrcode: stock.asaas_pix_qrcode,
        asaas_payment_link: stock.asaas_payment_link,
        external_payment_link: stock.external_payment_link,
        customer_name: stock.customer_name,
        coupon_code: stock.coupon_code,
        discount_value: stock.discount_value,
        delivery_method: stock.delivery_method,
        delivery_city: stock.delivery_city,
        created_date: stock.created_date,
        payment_method: stock.payment_method,
        payment_preference: stock.payment_preference,
      });
    }

    return response({ error: "not_found" }, 404);
  } catch (error) {
    return response({ error: String(error?.message || error) }, 500);
  }
});
