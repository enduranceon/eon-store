import {
  clean,
  type FieldError,
  normalizeBrazilPhone,
  UUID_PATTERN,
} from "../public-assessment-prospect/validation.ts";
import { clientIp, TurnstileUnavailableError } from "../_shared/turnstile.ts";

// Lista de espera de um coach pelo site. Só grava a pessoa na fila; contato,
// troca de coach e matrícula ficam com a equipe no painel.

const ALLOWED_ORIGINS = new Set([
  "https://www.enduranceon.com.br",
  "https://enduranceon.com.br",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REGIONS = new Set(["florianopolis", "online"]);

type RpcError = { code?: string; message?: string };
export type WaitlistRpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
};
export type WaitlistDeps = {
  createServiceClient(): WaitlistRpcClient | null;
  verifyTurnstile(req: Request, token: string): Promise<boolean>;
  hashSalt(): string;
};

export type WaitlistPayload = {
  requestId: string;
  coachId: string;
  modalityId: string | null;
  fullName: string;
  whatsapp: string;
  email: string | null;
  region: string | null;
  notes: string | null;
  turnstileToken: string;
};

function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://www.enduranceon.com.br",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function reply(
  req: Request,
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(req),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function fail(
  req: Request,
  status: number,
  code: string,
  error: string,
  requestId: string,
  fieldErrors: FieldError[] = [],
  headers: Record<string, string> = {},
) {
  return reply(req, {
    ok: false,
    code,
    error,
    request_id: requestId,
    ...(fieldErrors.length ? { field_errors: fieldErrors } : {}),
  }, status, headers);
}

function log(level: "info" | "warn" | "error", event: string, details: Record<string, unknown> = {}) {
  console[level](JSON.stringify({ event, ...details }));
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validateWaitlist(
  body: Record<string, unknown>,
): { payload: WaitlistPayload; fieldErrors: FieldError[] } {
  const rawEmail = String(body.email ?? "").trim();
  const email = clean(rawEmail, 180).toLowerCase();
  const modalityId = clean(body.modality_id, 36);
  const region = clean(body.region, 20).toLowerCase();
  const notes = String(body.notes ?? "").trim().slice(0, 500);
  const payload: WaitlistPayload = {
    requestId: clean(body.request_id, 36),
    coachId: clean(body.coach_id, 36),
    modalityId: modalityId || null,
    fullName: clean(body.full_name, 160),
    whatsapp: normalizeBrazilPhone(body.whatsapp),
    email: email || null,
    region: region || null,
    notes: notes || null,
    turnstileToken: clean(body.turnstile_token, 4096),
  };

  const fieldErrors: FieldError[] = [];
  const invalid = (field: string, code: string) => fieldErrors.push({ field, code });
  if (!UUID_PATTERN.test(payload.requestId)) invalid("request_id", "INVALID_REQUEST_ID");
  if (!UUID_PATTERN.test(payload.coachId)) invalid("coach_id", "INVALID_COACH");
  if (payload.modalityId && !UUID_PATTERN.test(payload.modalityId)) {
    invalid("modality_id", "INVALID_MODALITY");
  }
  if (payload.fullName.length < 3) invalid("full_name", "INVALID_NAME");
  if (!payload.whatsapp) invalid("whatsapp", "INVALID_PHONE");
  if (payload.email && (rawEmail.length > 180 || !EMAIL_PATTERN.test(payload.email))) {
    invalid("email", "INVALID_EMAIL");
  }
  if (payload.region && !REGIONS.has(payload.region)) invalid("region", "INVALID_REGION");
  if (!payload.turnstileToken) invalid("turnstile_token", "TURNSTILE_REQUIRED");
  return { payload, fieldErrors };
}

function rpcFailure(req: Request, error: RpcError, requestId: string) {
  const message = String(error.message || "");
  if (error.code === "P0001" && (message.includes("Muitas tentativas") || message.includes("vários cadastros"))) {
    return fail(req, 429, "RATE_LIMITED", "Muitas tentativas. Aguarde antes de enviar novamente.", requestId, [], {
      "Retry-After": "3600",
    });
  }
  if (error.code === "P0001" && message.includes("chave de envio")) {
    return fail(
      req,
      409,
      "IDEMPOTENCY_KEY_CONFLICT",
      "Este envio já foi usado com outros dados. Atualize a página e tente novamente.",
      requestId,
    );
  }
  if (error.code === "P0002") {
    return fail(req, 422, "INVALID_SELECTION", "Este treinador não está disponível no site.", requestId, [
      { field: "coach_id", code: "INVALID_COACH" },
    ]);
  }
  if (error.code === "22023") {
    return fail(req, 400, "VALIDATION_ERROR", "Revise os campos obrigatórios.", requestId);
  }
  return fail(req, 500, "SUBMISSION_FAILED", "Não foi possível entrar na lista agora. Tente novamente.", requestId);
}

export async function handlePublicCoachWaitlist(req: Request, deps: WaitlistDeps): Promise<Response> {
  let requestReference: string = crypto.randomUUID();
  try {
    const origin = req.headers.get("origin");
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return fail(req, 403, "ORIGIN_NOT_ALLOWED", "Origem não permitida.", requestReference);
    }
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    if (req.method !== "POST") {
      return fail(req, 405, "METHOD_NOT_ALLOWED", "Método não permitido.", requestReference, [], {
        "Allow": "POST, OPTIONS",
      });
    }
    if (Number(req.headers.get("content-length") || 0) > 12_000) {
      return fail(req, 413, "PAYLOAD_TOO_LARGE", "Dados muito grandes.", requestReference);
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return fail(req, 400, "INVALID_JSON", "Dados inválidos.", requestReference);
    }
    const input = body as Record<string, unknown>;
    const suppliedRequestId = clean(input.request_id, 36);
    if (UUID_PATTERN.test(suppliedRequestId)) requestReference = suppliedRequestId;

    if (clean(input.website, 50)) {
      log("warn", "public_waitlist_honeypot_rejected", { request_id: requestReference });
      return fail(
        req,
        400,
        "SUBMISSION_REJECTED",
        "Não foi possível confirmar o envio. Atualize a página e tente novamente.",
        requestReference,
      );
    }

    const { payload, fieldErrors } = validateWaitlist(input);
    if (fieldErrors.length) {
      return fail(
        req,
        400,
        "VALIDATION_ERROR",
        "Revise os campos destacados antes de enviar.",
        requestReference,
        fieldErrors,
      );
    }

    try {
      if (!(await deps.verifyTurnstile(req, payload.turnstileToken))) {
        return fail(
          req,
          403,
          "TURNSTILE_INVALID",
          "A verificação de segurança expirou ou não foi aceita. Marque novamente.",
          requestReference,
          [{ field: "turnstile_token", code: "TURNSTILE_INVALID" }],
        );
      }
    } catch (error) {
      if (!(error instanceof TurnstileUnavailableError)) throw error;
      log("error", "public_waitlist_turnstile_unavailable", { request_id: requestReference });
      return fail(
        req,
        503,
        "TURNSTILE_UNAVAILABLE",
        "A verificação de segurança está indisponível. Tente novamente em instantes.",
        requestReference,
      );
    }

    const supabase = deps.createServiceClient();
    if (!supabase) {
      return fail(req, 503, "SERVICE_UNAVAILABLE", "Serviço temporariamente indisponível.", requestReference);
    }
    const salt = deps.hashSalt();
    const [ipHash, phoneHash] = await Promise.all([
      sha256(`${salt}:ip:${clientIp(req) || "unknown"}`),
      sha256(`${salt}:phone:${payload.whatsapp}`),
    ]);
    const utm = input.utm && typeof input.utm === "object" && !Array.isArray(input.utm)
      ? Object.fromEntries(
        Object.entries(input.utm).slice(0, 8).map(([key, value]) => [clean(key, 40), clean(value, 160)]),
      )
      : {};

    const { data, error } = await supabase.rpc("submit_public_coach_waitlist", {
      p_request_id: payload.requestId,
      p_coach_id: payload.coachId,
      p_modality_id: payload.modalityId,
      p_full_name: payload.fullName,
      p_whatsapp: payload.whatsapp,
      p_email: payload.email,
      p_region: payload.region,
      p_notes: payload.notes,
      p_landing_page: clean(input.landing_page, 500),
      p_utm: utm,
      p_ip_hash: ipHash,
      p_phone_hash: phoneHash,
    });
    if (error) {
      log("error", "public_waitlist_rpc_failed", { request_id: requestReference, database_code: error.code || null });
      return rpcFailure(req, error, requestReference);
    }
    const result = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
    if (typeof result.entry_id !== "string" || typeof result.submitted_at !== "string") {
      log("error", "public_waitlist_receipt_missing", { request_id: requestReference });
      return fail(req, 500, "SUBMISSION_FAILED", "Não foi possível entrar na lista agora. Tente novamente.", requestReference);
    }
    const status = result.status === "duplicate" ? "duplicate" : "created";
    log("info", "public_waitlist_confirmed", { request_id: payload.requestId, status });
    return reply(req, {
      ok: true,
      status,
      request_id: payload.requestId,
      submitted_at: result.submitted_at,
    }, status === "created" ? 201 : 200);
  } catch (error) {
    log("error", "public_waitlist_unexpected_error", {
      request_id: requestReference,
      error_type: error instanceof Error ? error.name : typeof error,
    });
    return fail(req, 500, "INTERNAL_ERROR", "Não foi possível concluir o envio. Tente novamente.", requestReference);
  }
}
