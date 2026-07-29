import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2.110.7";

const ALLOWED_ORIGINS = new Set([
  "https://www.enduranceon.com.br",
  "https://enduranceon.com.br",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://www.enduranceon.com.br",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function response(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function clean(value: unknown, max: number) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

function digits(value: unknown) {
  return String(value ?? "").replace(/\D/g, "");
}

function validCpf(value: string) {
  if (value.length !== 11 || /^(\d)\1+$/.test(value)) return false;
  const check = (size: number) => {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += Number(value[i]) * (size + 1 - i);
    const rest = (sum * 10) % 11;
    return (rest === 10 ? 0 : rest) === Number(value[size]);
  };
  return check(9) && check(10);
}

function normalizePhone(value: unknown) {
  const phone = digits(value);
  if (phone.length === 10 || phone.length === 11) return `+55${phone}`;
  if (phone.length === 12 || phone.length === 13) return `+${phone}`;
  return "";
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function clientIp(req: Request) {
  return clean(req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0], 80);
}

async function verifyTurnstile(req: Request, token: string) {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) throw new Error("TURNSTILE_SECRET_KEY is not configured");
  const form = new FormData();
  form.set("secret", secret);
  form.set("response", token);
  const ip = clientIp(req);
  if (ip) form.set("remoteip", ip);
  const result = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  if (!result.ok) return false;
  const outcome = await result.json();
  const allowedHost = outcome.hostname === "enduranceon.com.br" ||
    outcome.hostname === "www.enduranceon.com.br" || outcome.hostname === "localhost";
  return outcome.success === true && allowedHost && (!outcome.action || outcome.action === "prospect_submit");
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) return response(req, { ok: false, error: "Origem não permitida" }, 403);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return response(req, { ok: false, error: "Serviço indisponível" }, 503);
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

  if (req.method === "GET") {
    const [{ data: plans, error: planError }, { data: modalities, error: modalityError }, { data: coaches, error: coachError }] = await Promise.all([
      supabase.from("assessment_plans")
        .select("id,name,period,period_months,price_monthly,price_total,enrollment_fee,max_installments,modality_id")
        .eq("active", true).eq("available_online", true).order("price_monthly"),
      supabase.from("assessment_modalities").select("id,name").eq("active", true).order("name"),
      supabase.from("assessment_coaches").select("id,name,modality_ids")
        .eq("active", true).eq("public_visible", true).order("name"),
    ]);
    if (planError || modalityError || coachError) {
      console.error("public prospect catalog", planError || modalityError || coachError);
      return response(req, { ok: false, error: "Não foi possível carregar os planos" }, 500);
    }
    return response(req, { ok: true, plans, modalities, coaches });
  }

  if (req.method !== "POST") return response(req, { ok: false, error: "Método não permitido" }, 405);
  const length = Number(req.headers.get("content-length") || 0);
  if (length > 24_000) return response(req, { ok: false, error: "Dados muito grandes" }, 413);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return response(req, { ok: false, error: "Dados inválidos" }, 400);
  }
  if (clean(body.website, 50)) return response(req, { ok: true, status: "received" });

  const requestId = clean(body.request_id, 36);
  const fullName = clean(body.full_name, 160);
  const whatsapp = normalizePhone(body.whatsapp);
  const email = clean(body.email, 180).toLowerCase();
  const cpf = digits(body.cpf);
  const planId = clean(body.plan_id, 36);
  const coachId = clean(body.coach_id, 36);
  const zip = digits(body.address_zip);
  const addressNumber = clean(body.address_number, 40);
  const turnstileToken = clean(body.turnstile_token, 4096);

  if (!UUID.test(requestId) || fullName.length < 3 || !whatsapp || !validCpf(cpf) ||
      !UUID.test(planId) || !UUID.test(coachId) || zip.length !== 8 || !addressNumber ||
      body.terms_accepted !== true || !turnstileToken) {
    return response(req, { ok: false, error: "Revise os campos obrigatórios" }, 400);
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return response(req, { ok: false, error: "E-mail inválido" }, 400);
  }
  if (!(await verifyTurnstile(req, turnstileToken))) {
    return response(req, { ok: false, error: "Não foi possível validar o envio. Tente novamente" }, 403);
  }

  const salt = Deno.env.get("PUBLIC_FORM_HASH_SALT") || Deno.env.get("TURNSTILE_SECRET_KEY") || "";
  const [ipHash, phoneHash] = await Promise.all([
    sha256(`${salt}:ip:${clientIp(req) || "unknown"}`),
    sha256(`${salt}:phone:${whatsapp}`),
  ]);
  const utm = body.utm && typeof body.utm === "object" && !Array.isArray(body.utm)
    ? Object.fromEntries(Object.entries(body.utm).slice(0, 8).map(([key, value]) => [clean(key, 40), clean(value, 160)]))
    : {};

  const { data, error } = await supabase.rpc("submit_public_assessment_prospect", {
    p_request_id: requestId,
    p_full_name: fullName,
    p_whatsapp: whatsapp,
    p_email: email,
    p_cpf: cpf,
    p_plan_id: planId,
    p_coach_id: coachId,
    p_region: clean(body.region, 80),
    p_address_zip: zip,
    p_address_street: clean(body.address_street, 160),
    p_address_number: addressNumber,
    p_address_complement: clean(body.address_complement, 120),
    p_address_neighborhood: clean(body.address_neighborhood, 120),
    p_address_city: clean(body.address_city, 120),
    p_address_state: clean(body.address_state, 2).toUpperCase(),
    p_terms_accepted_at: new Date().toISOString(),
    p_landing_page: clean(body.landing_page, 500),
    p_utm: utm,
    p_ip_hash: ipHash,
    p_phone_hash: phoneHash,
    p_user_agent: clean(req.headers.get("user-agent"), 500),
  });
  if (error) {
    console.error("public prospect submit", error);
    if (error.code === "P0001") return response(req, { ok: false, error: error.message }, 409);
    if (error.code === "P0002" || error.code === "22023") return response(req, { ok: false, error: error.message }, 400);
    return response(req, { ok: false, error: "Não foi possível registrar o cadastro" }, 500);
  }
  return response(req, { ok: true, ...data }, 201);
});
