import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  createClient,
  type SupabaseClient,
} from "jsr:@supabase/supabase-js@2.110.7";
import {
  clean,
  type FieldError,
  type ProspectPayload,
  UUID_PATTERN,
  validateAndNormalizeProspect,
} from "./validation.ts";
import { attachSitePlans, planAllowedForCoach } from "./site-plans.ts";

const ALLOWED_ORIGINS = new Set([
  "https://www.enduranceon.com.br",
  "https://enduranceon.com.br",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

type RpcResult = {
  status?: unknown;
  customer_id?: unknown;
  contract_id?: unknown;
  contract_number?: unknown;
  submission_id?: unknown;
  request_id?: unknown;
  submitted_at?: unknown;
};

type Receipt = {
  submission_id: string;
  request_id: string;
  submitted_at: string;
  customer_id: string;
  contract_id: string;
  contract_number: string;
};

const RECEIPT_SELECT =
  "id,request_id,submitted_at,customer_id,contract_id,plan_id,coach_id,region,submitted_full_name,submitted_whatsapp,submitted_email,submitted_cpf,submitted_address_zip,submitted_address_street,submitted_address_number,submitted_address_complement,submitted_address_neighborhood,submitted_address_city,submitted_address_state";

class TurnstileUnavailableError extends Error {
  constructor() {
    super("Turnstile unavailable");
    this.name = "TurnstileUnavailableError";
  }
}

function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://www.enduranceon.com.br",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function response(
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

function errorResponse(
  req: Request,
  status: number,
  code: string,
  message: string,
  requestId: string,
  fieldErrors: FieldError[] = [],
  headers: Record<string, string> = {},
) {
  return response(
    req,
    {
      ok: false,
      code,
      error: message,
      request_id: requestId,
      ...(fieldErrors.length ? { field_errors: fieldErrors } : {}),
    },
    status,
    headers,
  );
}

function log(
  level: "info" | "warn" | "error",
  event: string,
  details: Record<string, unknown> = {},
) {
  console[level](JSON.stringify({ event, ...details }));
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function clientIp(req: Request) {
  return clean(
    req.headers.get("cf-connecting-ip") ||
      req.headers.get("x-forwarded-for")?.split(",")[0],
    80,
  );
}

async function verifyTurnstile(req: Request, token: string) {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) throw new TurnstileUnavailableError();

  const form = new FormData();
  form.set("secret", secret);
  form.set("response", token);
  const ip = clientIp(req);
  if (ip) form.set("remoteip", ip);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const result = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form, signal: controller.signal },
    );
    if (!result.ok) throw new TurnstileUnavailableError();
    const outcome = await result.json().catch(() => null) as {
      success?: boolean;
      hostname?: string;
      action?: string;
    } | null;
    if (!outcome) throw new TurnstileUnavailableError();
    const allowedHost = outcome.hostname === "enduranceon.com.br" ||
      outcome.hostname === "www.enduranceon.com.br" ||
      outcome.hostname === "localhost";
    return outcome.success === true && allowedHost &&
      (!outcome.action || outcome.action === "prospect_submit");
  } catch (error) {
    if (error instanceof TurnstileUnavailableError) throw error;
    throw new TurnstileUnavailableError();
  } finally {
    clearTimeout(timeout);
  }
}

function asRpcResult(value: unknown): RpcResult {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RpcResult
    : {};
}

async function confirmReceipt(
  supabase: SupabaseClient,
  requestId: string,
  rpcResult: RpcResult,
  expected: ProspectPayload,
): Promise<Receipt | null> {
  const { data: submission, error: submissionError } = await supabase
    .from("assessment_prospect_submissions")
    .select(RECEIPT_SELECT)
    .eq("request_id", requestId)
    .maybeSingle();
  if (submissionError || !submission) {
    log("error", "public_prospect_receipt_missing", {
      request_id: requestId,
      database_code: submissionError?.code || null,
    });
    return null;
  }

  const same = (actual: unknown, wanted: string) =>
    String(actual ?? "") === wanted;
  const sameUuid = (actual: unknown, wanted: string) =>
    String(actual ?? "").toLowerCase() === wanted.toLowerCase();
  if (
    !same(submission.submitted_full_name, expected.fullName) ||
    !same(submission.submitted_whatsapp, expected.whatsapp) ||
    !same(submission.submitted_email, expected.email) ||
    !same(submission.submitted_cpf, expected.cpf) ||
    !sameUuid(submission.plan_id, expected.planId) ||
    !sameUuid(submission.coach_id, expected.coachId) ||
    !same(submission.region, expected.region) ||
    !same(submission.submitted_address_zip, expected.addressZip) ||
    !same(submission.submitted_address_street, expected.addressStreet) ||
    !same(submission.submitted_address_number, expected.addressNumber) ||
    !same(
      submission.submitted_address_complement,
      expected.addressComplement,
    ) ||
    !same(
      submission.submitted_address_neighborhood,
      expected.addressNeighborhood,
    ) ||
    !same(submission.submitted_address_city, expected.addressCity) ||
    !same(submission.submitted_address_state, expected.addressState)
  ) {
    log("error", "public_prospect_receipt_payload_mismatch", {
      request_id: requestId,
    });
    return null;
  }

  if (
    typeof rpcResult.contract_id === "string" &&
    rpcResult.contract_id !== submission.contract_id
  ) {
    log("error", "public_prospect_receipt_mismatch", {
      request_id: requestId,
    });
    return null;
  }

  const { data: contract, error: contractError } = await supabase
    .from("assessment_contracts")
    .select("id,contract_number")
    .eq("id", submission.contract_id)
    .maybeSingle();
  if (contractError || !contract || !contract.contract_number) {
    log("error", "public_prospect_contract_missing", {
      request_id: requestId,
      database_code: contractError?.code || null,
    });
    return null;
  }

  return {
    submission_id: submission.id,
    request_id: submission.request_id,
    submitted_at: submission.submitted_at,
    customer_id: submission.customer_id,
    contract_id: submission.contract_id,
    contract_number: contract.contract_number,
  };
}

function rpcErrorResponse(
  req: Request,
  error: { code?: string; message?: string },
  requestId: string,
) {
  const message = String(error.message || "");
  if (
    error.code === "P0001" &&
    (message.includes("Muitas tentativas") ||
      message.includes("vários cadastros"))
  ) {
    return errorResponse(
      req,
      429,
      "RATE_LIMITED",
      "Muitas tentativas. Aguarde antes de enviar novamente.",
      requestId,
      [],
      { "Retry-After": "3600" },
    );
  }
  if (error.code === "P0001" && message.includes("chave de envio")) {
    return errorResponse(
      req,
      409,
      "IDEMPOTENCY_KEY_CONFLICT",
      "Este envio já foi usado com outros dados. Atualize a página e tente novamente.",
      requestId,
    );
  }
  if (error.code === "P0001") {
    return errorResponse(
      req,
      409,
      "MANUAL_REVIEW_REQUIRED",
      "Não foi possível concluir automaticamente. Fale com a equipe e informe o protocolo.",
      requestId,
    );
  }
  if (error.code === "P0002" && message.includes("Plano")) {
    return errorResponse(
      req,
      422,
      "INVALID_SELECTION",
      "O plano selecionado não está mais disponível.",
      requestId,
      [{ field: "plan_id", code: "INVALID_PLAN" }],
    );
  }
  if (error.code === "P0002") {
    return errorResponse(
      req,
      422,
      "INVALID_SELECTION",
      "O treinador selecionado não está disponível para este plano.",
      requestId,
      [{ field: "coach_id", code: "INVALID_COACH" }],
    );
  }
  if (error.code === "22023") {
    return errorResponse(
      req,
      400,
      "VALIDATION_ERROR",
      "Revise os campos obrigatórios.",
      requestId,
    );
  }
  return errorResponse(
    req,
    500,
    "SUBMISSION_FAILED",
    "Não foi possível registrar o cadastro. Tente novamente.",
    requestId,
  );
}

Deno.serve(async (req: Request) => {
  let requestReference: string = crypto.randomUUID();
  try {
    const origin = req.headers.get("origin");
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return errorResponse(
        req,
        403,
        "ORIGIN_NOT_ALLOWED",
        "Origem não permitida.",
        requestReference,
      );
    }
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(req) });
    }

    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) {
      log("error", "public_prospect_configuration_missing", {
        request_id: requestReference,
      });
      return errorResponse(
        req,
        503,
        "SERVICE_UNAVAILABLE",
        "Serviço temporariamente indisponível.",
        requestReference,
      );
    }
    const supabase = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });

    if (req.method === "GET") {
      const [
        { data: plans, error: planError },
        { data: modalities, error: modalityError },
        { data: coaches, error: coachError },
        { data: sitePlans, error: sitePlanError },
      ] = await Promise.all([
        supabase.from("assessment_plans")
          .select(
            "id,name,period,period_months,price_monthly,price_total,enrollment_fee,max_installments,modality_id",
          )
          .eq("active", true).eq("available_online", true)
          .order("price_monthly"),
        supabase.from("assessment_modalities").select("id,name")
          .eq("active", true).order("name"),
        supabase.from("assessment_coaches").select("id,name,modality_ids")
          .eq("active", true).eq("public_visible", true).order("name"),
        // Plano de cada coach no site (um por modalidade e duração).
        supabase.from("assessment_coach_site_plans").select(
          "coach_id,modality_id,period_months,plan:assessment_plans(id,name,period,period_months,price_monthly,price_total,enrollment_fee,max_installments,modality_id,active)",
        ),
      ]);
      if (planError || modalityError || coachError || sitePlanError) {
        log("error", "public_prospect_catalog_failed", {
          request_id: requestReference,
          database_code: planError?.code || modalityError?.code ||
            coachError?.code || sitePlanError?.code || null,
        });
        return errorResponse(
          req,
          500,
          "CATALOG_UNAVAILABLE",
          "Não foi possível carregar os planos.",
          requestReference,
        );
      }
      return response(req, {
        ok: true,
        plans,
        modalities,
        coaches: attachSitePlans(coaches || [], sitePlans || []),
      });
    }

    if (req.method !== "POST") {
      return errorResponse(
        req,
        405,
        "METHOD_NOT_ALLOWED",
        "Método não permitido.",
        requestReference,
        [],
        { "Allow": "GET, POST, OPTIONS" },
      );
    }
    const length = Number(req.headers.get("content-length") || 0);
    if (length > 24_000) {
      return errorResponse(
        req,
        413,
        "PAYLOAD_TOO_LARGE",
        "Dados muito grandes.",
        requestReference,
      );
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse(
        req,
        400,
        "INVALID_JSON",
        "Dados inválidos.",
        requestReference,
      );
    }
    const input = body as Record<string, unknown>;
    const suppliedRequestId = clean(input.request_id, 36);
    if (UUID_PATTERN.test(suppliedRequestId)) {
      requestReference = suppliedRequestId;
    }

    if (clean(input.website, 50)) {
      log("warn", "public_prospect_honeypot_rejected", {
        request_id: requestReference,
      });
      return errorResponse(
        req,
        400,
        "SUBMISSION_REJECTED",
        "Não foi possível confirmar o envio. Atualize a página e tente novamente.",
        requestReference,
      );
    }

    const { payload, fieldErrors } = validateAndNormalizeProspect(input);
    if (fieldErrors.length) {
      log("warn", "public_prospect_validation_failed", {
        request_id: requestReference,
        fields: fieldErrors.map((item) => item.field),
      });
      return errorResponse(
        req,
        400,
        "VALIDATION_ERROR",
        "Revise os campos destacados antes de enviar.",
        requestReference,
        fieldErrors,
      );
    }

    try {
      if (!(await verifyTurnstile(req, payload.turnstileToken))) {
        return errorResponse(
          req,
          403,
          "TURNSTILE_INVALID",
          "A verificação de segurança expirou ou não foi aceita. Marque novamente.",
          requestReference,
          [{ field: "turnstile_token", code: "TURNSTILE_INVALID" }],
        );
      }
    } catch (error) {
      if (error instanceof TurnstileUnavailableError) {
        log("error", "public_prospect_turnstile_unavailable", {
          request_id: requestReference,
        });
        return errorResponse(
          req,
          503,
          "TURNSTILE_UNAVAILABLE",
          "A verificação de segurança está indisponível. Tente novamente em instantes.",
          requestReference,
        );
      }
      throw error;
    }

    // Plano geral do site ou o plano escolhido para este coach no site.
    const [planResult, coachResult, sitePlanResult] = await Promise.all([
      supabase.from("assessment_plans").select("id,modality_id,available_online")
        .eq("id", payload.planId).eq("active", true).maybeSingle(),
      supabase.from("assessment_coaches")
        .select("id,modality_ids")
        .eq("id", payload.coachId).eq("active", true)
        .eq("public_visible", true).maybeSingle(),
      supabase.from("assessment_coach_site_plans").select("plan_id")
        .eq("coach_id", payload.coachId),
    ]);
    if (planResult.error || coachResult.error || sitePlanResult.error) {
      log("error", "public_prospect_selection_check_failed", {
        request_id: requestReference,
        database_code: planResult.error?.code || coachResult.error?.code ||
          sitePlanResult.error?.code || null,
      });
      return errorResponse(
        req,
        503,
        "SERVICE_UNAVAILABLE",
        "Não foi possível confirmar o plano agora. Tente novamente.",
        requestReference,
      );
    }
    const selection = planResult.data
      ? planAllowedForCoach(
        planResult.data,
        coachResult.data,
        (sitePlanResult.data || []).map((row) => row.plan_id),
      )
      : "plan";
    if (selection === "plan") {
      return errorResponse(
        req,
        422,
        "INVALID_SELECTION",
        "O plano selecionado não está mais disponível.",
        requestReference,
        [{ field: "plan_id", code: "INVALID_PLAN" }],
      );
    }
    if (selection === "coach") {
      return errorResponse(
        req,
        422,
        "INVALID_SELECTION",
        "O treinador selecionado não está disponível para este plano.",
        requestReference,
        [{ field: "coach_id", code: "INVALID_COACH" }],
      );
    }

    const salt = Deno.env.get("PUBLIC_FORM_HASH_SALT") ||
      Deno.env.get("TURNSTILE_SECRET_KEY") || "";
    const [ipHash, phoneHash] = await Promise.all([
      sha256(`${salt}:ip:${clientIp(req) || "unknown"}`),
      sha256(`${salt}:phone:${payload.whatsapp}`),
    ]);
    const utm = input.utm && typeof input.utm === "object" &&
        !Array.isArray(input.utm)
      ? Object.fromEntries(
        Object.entries(input.utm).slice(0, 8).map(([key, value]) => [
          clean(key, 40),
          clean(value, 160),
        ]),
      )
      : {};

    const { data, error } = await supabase.rpc(
      "submit_public_assessment_prospect",
      {
        p_request_id: payload.requestId,
        p_full_name: payload.fullName,
        p_whatsapp: payload.whatsapp,
        p_email: payload.email,
        p_cpf: payload.cpf,
        p_plan_id: payload.planId,
        p_coach_id: payload.coachId,
        p_region: payload.region,
        p_address_zip: payload.addressZip,
        p_address_street: payload.addressStreet,
        p_address_number: payload.addressNumber,
        p_address_complement: payload.addressComplement,
        p_address_neighborhood: payload.addressNeighborhood,
        p_address_city: payload.addressCity,
        p_address_state: payload.addressState,
        p_terms_accepted_at: new Date().toISOString(),
        p_landing_page: clean(input.landing_page, 500),
        p_utm: utm,
        p_ip_hash: ipHash,
        p_phone_hash: phoneHash,
        p_user_agent: clean(req.headers.get("user-agent"), 500),
      },
    );
    if (error) {
      // The RPC serializes normal retries by request ID. If another privileged
      // writer still causes a unique-key race, only accept a receipt whose
      // complete submitted payload matches this request.
      if (error.code === "23505") {
        const receipt = await confirmReceipt(
          supabase,
          payload.requestId,
          {},
          payload,
        );
        if (receipt) {
          return response(req, { ok: true, status: "duplicate", ...receipt });
        }
      }
      log("error", "public_prospect_rpc_failed", {
        request_id: requestReference,
        database_code: error.code || null,
      });
      return rpcErrorResponse(req, error, requestReference);
    }

    const rpcResult = asRpcResult(data);
    const receipt = await confirmReceipt(
      supabase,
      payload.requestId,
      rpcResult,
      payload,
    );
    if (!receipt) {
      return errorResponse(
        req,
        500,
        "RECEIPT_NOT_CONFIRMED",
        "O envio pode ter sido recebido, mas não foi possível confirmá-lo. Tente novamente com o mesmo protocolo.",
        requestReference,
      );
    }

    const status = rpcResult.status === "duplicate" ? "duplicate" : "created";
    log("info", "public_prospect_confirmed", {
      request_id: receipt.request_id,
      submission_id: receipt.submission_id,
      contract_id: receipt.contract_id,
      status,
    });
    return response(req, {
      ok: true,
      ...rpcResult,
      status,
      ...receipt,
    }, status === "created" ? 201 : 200);
  } catch (error) {
    log("error", "public_prospect_unexpected_error", {
      request_id: requestReference,
      error_type: error instanceof Error ? error.name : typeof error,
    });
    return errorResponse(
      req,
      500,
      "INTERNAL_ERROR",
      "Não foi possível concluir o envio. Tente novamente.",
      requestReference,
    );
  }
});
