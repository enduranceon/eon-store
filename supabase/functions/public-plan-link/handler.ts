import {
  clean,
  digits,
  type FieldError,
  normalizeBrazilPhone,
  UUID_PATTERN,
  validCpf,
} from "../public-assessment-prospect/validation.ts";
import { clientIp } from "../_shared/turnstile.ts";

// Link do plano que a equipe manda no WhatsApp. GET mostra o plano e as
// durações; POST cria o prospect no quadro. Sem login: a proteção é o segredo
// do link, a origem da página, o campo isca e o limite de tentativas no banco.

const TOKEN_PATTERN = /^[a-z0-9]{16,40}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATE_PATTERN = /^[A-Z]{2}$/;
const REGIONS = new Set(["florianopolis", "online"]);
const STORE_ORIGINS = new Set(["https://eon-store.netlify.app"]);
const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+--eon-store\.netlify\.app$/;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

type RpcError = { code?: string; message?: string };
export type PlanLinkRpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
};
export type PlanLinkDeps = {
  createServiceClient(): PlanLinkRpcClient | null;
  hashSalt(): string;
};

export function allowedOrigin(origin: string): boolean {
  return STORE_ORIGINS.has(origin) || PREVIEW_ORIGIN.test(origin) || LOCAL_ORIGIN.test(origin);
}

function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigin(origin) ? origin : "https://eon-store.netlify.app",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function reply(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function fail(req: Request, status: number, code: string, error: string, fieldErrors: FieldError[] = []) {
  return reply(req, { ok: false, code, error, ...(fieldErrors.length ? { field_errors: fieldErrors } : {}) }, status);
}

function log(level: "info" | "warn" | "error", event: string, details: Record<string, unknown> = {}) {
  console[level](JSON.stringify({ event, ...details }));
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type PlanLinkPayload = {
  token: string;
  requestId: string;
  planId: string;
  coachId: string;
  fullName: string;
  whatsapp: string;
  email: string;
  cpf: string;
  region: string | null;
  addressZip: string;
  addressStreet: string;
  addressNumber: string;
  addressComplement: string;
  addressNeighborhood: string;
  addressCity: string;
  addressState: string;
};

export function validatePlanLink(body: Record<string, unknown>): { payload: PlanLinkPayload; fieldErrors: FieldError[] } {
  const rawEmail = String(body.email ?? "").trim();
  const region = clean(body.region, 20).toLowerCase();
  const payload: PlanLinkPayload = {
    token: clean(body.token, 40),
    requestId: clean(body.request_id, 36),
    planId: clean(body.plan_id, 36),
    coachId: clean(body.coach_id, 36),
    fullName: clean(body.full_name, 160),
    whatsapp: normalizeBrazilPhone(body.whatsapp),
    email: clean(rawEmail, 180).toLowerCase(),
    cpf: digits(body.cpf),
    region: region || null,
    addressZip: digits(body.address_zip),
    addressStreet: clean(body.address_street, 160),
    addressNumber: clean(body.address_number, 40),
    addressComplement: clean(body.address_complement, 120),
    addressNeighborhood: clean(body.address_neighborhood, 120),
    addressCity: clean(body.address_city, 120),
    addressState: clean(body.address_state, 8).toUpperCase(),
  };
  const fieldErrors: FieldError[] = [];
  const invalid = (field: string, code: string) => fieldErrors.push({ field, code });
  if (!TOKEN_PATTERN.test(payload.token)) invalid("token", "INVALID_LINK");
  if (!UUID_PATTERN.test(payload.requestId)) invalid("request_id", "INVALID_REQUEST_ID");
  if (!UUID_PATTERN.test(payload.planId)) invalid("plan_id", "INVALID_PLAN");
  if (!UUID_PATTERN.test(payload.coachId)) invalid("coach_id", "INVALID_COACH");
  if (payload.fullName.length < 3) invalid("full_name", "INVALID_NAME");
  if (!payload.whatsapp) invalid("whatsapp", "INVALID_PHONE");
  if (!payload.email || rawEmail.length > 180 || !EMAIL_PATTERN.test(payload.email)) invalid("email", "INVALID_EMAIL");
  if (!validCpf(payload.cpf)) invalid("cpf", "INVALID_CPF");
  if (payload.region && !REGIONS.has(payload.region)) invalid("region", "INVALID_REGION");
  if (payload.addressZip.length !== 8) invalid("address_zip", "INVALID_ZIP");
  if (!payload.addressStreet) invalid("address_street", "REQUIRED");
  if (!payload.addressNumber) invalid("address_number", "REQUIRED");
  if (!payload.addressNeighborhood) invalid("address_neighborhood", "REQUIRED");
  if (!payload.addressCity) invalid("address_city", "REQUIRED");
  if (!STATE_PATTERN.test(payload.addressState)) invalid("address_state", "INVALID_STATE");
  if (body.confirmed !== true) invalid("confirmed", "CONFIRMATION_REQUIRED");
  return { payload, fieldErrors };
}

function rpcFailure(req: Request, error: RpcError) {
  const message = String(error.message || "");
  if (error.code === "P0001" && (message.includes("Muitas tentativas") || message.includes("vários cadastros"))) {
    return fail(req, 429, "RATE_LIMITED", "Muitas tentativas. Aguarde um pouco e tente de novo.");
  }
  if (error.code === "P0001" && message.includes("chave de envio")) {
    return fail(req, 409, "IDEMPOTENCY_KEY_CONFLICT", "Este envio já foi usado com outros dados. Atualize a página e tente de novo.");
  }
  if (error.code === "P0001") {
    return fail(req, 409, "MANUAL_REVIEW_REQUIRED", "Não conseguimos concluir sozinhos. Nossa equipe vai falar com você pelo WhatsApp.");
  }
  if (error.code === "P0002" && message.includes("Link")) {
    return fail(req, 404, "LINK_UNAVAILABLE", "Este link não está mais ativo. Peça um novo para a equipe.");
  }
  if (error.code === "P0002" && message.includes("Plano")) {
    return fail(req, 422, "INVALID_SELECTION", "Esta opção de plano não está mais disponível. Atualize a página.", [
      { field: "plan_id", code: "INVALID_PLAN" },
    ]);
  }
  if (error.code === "P0002") {
    return fail(req, 422, "INVALID_SELECTION", "O treinador escolhido não está disponível para este plano.", [
      { field: "coach_id", code: "INVALID_COACH" },
    ]);
  }
  if (error.code === "22023") return fail(req, 400, "VALIDATION_ERROR", "Revise os campos obrigatórios.");
  return fail(req, 500, "SUBMISSION_FAILED", "Não foi possível enviar agora. Tente de novo.");
}

export async function handlePublicPlanLink(req: Request, deps: PlanLinkDeps): Promise<Response> {
  try {
    const origin = req.headers.get("origin");
    if (origin && !allowedOrigin(origin)) return fail(req, 403, "ORIGIN_NOT_ALLOWED", "Origem não permitida.");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });

    if (req.method === "GET") {
      const url = new URL(req.url);
      const token = clean(url.searchParams.get("token"), 40);
      const coach = clean(url.searchParams.get("coach"), 36);
      if (!TOKEN_PATTERN.test(token)) return fail(req, 404, "LINK_UNAVAILABLE", "Link não encontrado.");
      const supabase = deps.createServiceClient();
      if (!supabase) return fail(req, 503, "SERVICE_UNAVAILABLE", "Serviço temporariamente indisponível.");
      const { data, error } = await supabase.rpc("get_plan_link", {
        p_token: token,
        p_coach_id: UUID_PATTERN.test(coach) ? coach : null,
      });
      if (error) {
        log("error", "plan_link_load_failed", { database_code: error.code || null });
        return fail(req, 500, "LOAD_FAILED", "Não foi possível abrir o link agora.");
      }
      if (!data || typeof data !== "object") {
        return fail(req, 404, "LINK_UNAVAILABLE", "Este link não está mais ativo. Peça um novo para a equipe.");
      }
      return reply(req, { ok: true, ...(data as Record<string, unknown>) });
    }

    if (req.method !== "POST") return fail(req, 405, "METHOD_NOT_ALLOWED", "Método não permitido.");
    if (Number(req.headers.get("content-length") || 0) > 16_000) {
      return fail(req, 413, "PAYLOAD_TOO_LARGE", "Dados muito grandes.");
    }
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail(req, 400, "INVALID_JSON", "Dados inválidos.");
    const input = body as Record<string, unknown>;
    if (clean(input.website, 50)) {
      log("warn", "plan_link_honeypot_rejected");
      return fail(req, 400, "SUBMISSION_REJECTED", "Não foi possível confirmar o envio. Atualize a página e tente de novo.");
    }
    const { payload, fieldErrors } = validatePlanLink(input);
    if (fieldErrors.length) {
      return fail(req, 400, "VALIDATION_ERROR", "Revise os campos destacados.", fieldErrors);
    }

    const supabase = deps.createServiceClient();
    if (!supabase) return fail(req, 503, "SERVICE_UNAVAILABLE", "Serviço temporariamente indisponível.");
    const salt = deps.hashSalt();
    const [ipHash, phoneHash] = await Promise.all([
      sha256(`${salt}:ip:${clientIp(req) || "unknown"}`),
      sha256(`${salt}:phone:${payload.whatsapp}`),
    ]);
    const { data, error } = await supabase.rpc("submit_plan_link_prospect", {
      p_token: payload.token,
      p_request_id: payload.requestId,
      p_plan_id: payload.planId,
      p_coach_id: payload.coachId,
      p_full_name: payload.fullName,
      p_whatsapp: payload.whatsapp,
      p_email: payload.email,
      p_cpf: payload.cpf,
      p_region: payload.region,
      p_address_zip: payload.addressZip,
      p_address_street: payload.addressStreet,
      p_address_number: payload.addressNumber,
      p_address_complement: payload.addressComplement,
      p_address_neighborhood: payload.addressNeighborhood,
      p_address_city: payload.addressCity,
      p_address_state: payload.addressState,
      p_confirmed_at: new Date().toISOString(),
      p_ip_hash: ipHash,
      p_phone_hash: phoneHash,
      p_user_agent: clean(req.headers.get("user-agent"), 500),
    });
    if (error) {
      log("error", "plan_link_submit_failed", { database_code: error.code || null });
      return rpcFailure(req, error);
    }
    const result = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
    if (typeof result.submitted_at !== "string") {
      log("error", "plan_link_receipt_missing");
      return fail(req, 500, "SUBMISSION_FAILED", "Não foi possível enviar agora. Tente de novo.");
    }
    const status = result.status === "duplicate" ? "duplicate" : "created";
    log("info", "plan_link_confirmed", { request_id: payload.requestId, status });
    return reply(req, { ok: true, status, request_id: payload.requestId, submitted_at: result.submitted_at }, status === "created" ? 201 : 200);
  } catch (error) {
    log("error", "plan_link_unexpected_error", { error_type: error instanceof Error ? error.name : typeof error });
    return fail(req, 500, "INTERNAL_ERROR", "Não foi possível concluir agora. Tente de novo.");
  }
}
