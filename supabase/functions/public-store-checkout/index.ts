import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2.110.7";

const ALLOWED_ORIGINS = new Set([
  "https://eon-store.netlify.app",
  "https://enduranceon.com.br",
  "https://www.enduranceon.com.br",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://eon-store.netlify.app",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function response(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json; charset=utf-8" },
  });
}

function clientIp(req: Request) {
  return (req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0] || "").trim();
}

function phoneDigits(value: unknown) {
  return String(value ?? "").replace(/\D/g, "");
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return response(req, { ok: false, error: "Origem não permitida" }, 403);
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(req) });
  }
  if (req.method !== "POST") {
    return response(req, { ok: false, error: "Método não permitido" }, 405);
  }

  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > 100_000) {
    return response(req, { ok: false, error: "Pedido muito grande" }, 413);
  }

  const body = await req.json().catch(() => null);
  const payload = body?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return response(req, { ok: false, error: "Dados do pedido inválidos" }, 400);
  }

  const phone = phoneDigits(payload.customer?.whatsapp);
  if (phone.length < 10 || phone.length > 11) {
    return response(req, { ok: false, error: "WhatsApp inválido" }, 400);
  }

  const ip = clientIp(req);
  const salt = Deno.env.get("PUBLIC_FORM_HASH_SALT") || Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!ip || !salt) {
    console.error("public-store-checkout: origin hash configuration unavailable");
    return response(req, { ok: false, error: "Loja temporariamente indisponível" }, 503);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    console.error("public-store-checkout: Supabase configuration unavailable");
    return response(req, { ok: false, error: "Loja temporariamente indisponível" }, 503);
  }

  const [ipHash, phoneHash] = await Promise.all([
    sha256(`${salt}:public-store-ip:${ip}`),
    sha256(`${salt}:public-store-phone:${phone}`),
  ]);

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.rpc(
    "create_rate_limited_public_stock_order",
    {
      p_payload: payload,
      p_ip_hash: ipHash,
      p_phone_hash: phoneHash,
    },
  );

  if (error) {
    const rateLimited = error.code === "P0001" && (
      error.message.startsWith("Muitas tentativas de pedido") ||
      error.message.startsWith("Este telefone já enviou vários pedidos")
    );
    const status = rateLimited ? 429
      : error.code === "22023" || error.code === "P0001" ? 400
      : error.code === "P0002" ? 404
      : 400;
    console.warn("public-store-checkout failed", { code: error.code, message: error.message });
    return response(req, {
      ok: false,
      error: error.message || "Não foi possível concluir o pedido",
    }, status);
  }

  return response(req, { ok: true, data });
});
