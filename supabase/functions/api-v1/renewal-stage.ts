import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

// Ações do quadro de Renovações que não têm efeito financeiro: registrar a
// mensagem de intenção, a resposta do atleta, o follow-up e a mudança de
// plano/treinador resolvida. Cobrança, pagamento e "Não vou renovar" seguem
// pelas rotas que já existem; a etapa acompanha essas rotas no banco.

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const RENEWAL_STAGE_PATH = /^\/orders\/contract\/([^/]+)\/renewal-stage$/;

const ACTION_KEYS: Record<string, string[]> = {
  message_sent: ["action", "expected_updated_at", "follow_up_at", "message"],
  register_response: [
    "action",
    "expected_updated_at",
    "response_code",
    "follow_up_at",
    "notes",
  ],
  set_follow_up: ["action", "expected_updated_at", "follow_up_at"],
  change_resolved: ["action", "expected_updated_at", "notes"],
};
const RESPONSE_CODES = new Set([
  "will_renew",
  "thinking",
  "change_plan_or_coach",
  "needs_agent",
]);

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 50 &&
    Number.isFinite(Date.parse(value));
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
}

function isOptionalText(value: unknown, maxLength: number): boolean {
  return value === null ||
    (typeof value === "string" && value.length <= maxLength);
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function exactKeys(body: Record<string, unknown>, allowed: string[]): boolean {
  const keys = Object.keys(body);
  return keys.length === allowed.length &&
    keys.every((key) => allowed.includes(key));
}

function invalid(message: string): Response {
  return jsonResponse({ error: message, code: "invalid_request" }, 400);
}

function databaseError(
  error: { code?: string; message?: string },
  contractId: string,
): Response {
  console.error("api-v1 renewal stage:", contractId, error.code, error.message);
  if (error.code === "P0002") {
    return jsonResponse({ error: error.message, code: "not_found" }, 404);
  }
  if (error.code === "22023") {
    return jsonResponse({ error: error.message, code: "invalid_request" }, 400);
  }
  if (error.code === "P0001" || error.code === "23505") {
    return jsonResponse({
      error: error.message,
      code: "invalid_transition",
    }, 409);
  }
  return jsonResponse({
    error: "Não foi possível atualizar a renovação",
    code: "database_error",
  }, 500);
}

export async function handleRenewalStageRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  const match = path.match(RENEWAL_STAGE_PATH);
  if (!match) return null;
  const [, contractId] = match;
  if (!UUID_PATTERN.test(contractId)) {
    return invalid("Renovação inválida");
  }
  if (req.method !== "POST") {
    return jsonResponse({
      error: "Método não permitido",
      code: "method_not_allowed",
    }, 405);
  }

  const idempotencyKey = req.headers.get("Idempotency-Key") || "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return invalid("Chave de idempotência inválida");
  }

  const body = await readBody(req);
  const action = typeof body?.action === "string" ? body.action : "";
  const allowedKeys = ACTION_KEYS[action];
  if (!body || !allowedKeys) {
    return invalid("Ação de renovação inválida");
  }
  if (!exactKeys(body, allowedKeys) || !isTimestamp(body.expected_updated_at)) {
    return invalid("Requisição inválida");
  }
  if ("follow_up_at" in body && !(body.follow_up_at === null || isDate(body.follow_up_at))) {
    return invalid("Data de follow-up inválida");
  }
  if ("message" in body && !isOptionalText(body.message, 4000)) {
    return invalid("Mensagem inválida");
  }
  if ("notes" in body && !isOptionalText(body.notes, 500)) {
    return invalid("Observação inválida");
  }
  if (action === "register_response") {
    if (body.response_code === "not_renewing") {
      return invalid('Para "Não vou renovar", use o encerramento da renovação');
    }
    if (typeof body.response_code !== "string" || !RESPONSE_CODES.has(body.response_code)) {
      return invalid("Resposta de renovação inválida");
    }
  }

  const { data, error } = await supabase.rpc(
    "transition_assessment_renewal_stage",
    {
      p_contract_id: contractId,
      p_action: action,
      p_expected_updated_at: body.expected_updated_at,
      p_idempotency_key: idempotencyKey,
      p_actor_id: actorId,
      p_response_code: action === "register_response" ? body.response_code : null,
      p_follow_up_at: "follow_up_at" in body ? body.follow_up_at : null,
      p_notes: "notes" in body ? body.notes : null,
      p_message: "message" in body ? body.message : null,
    },
  );
  if (error) return databaseError(error, contractId);
  return jsonResponse({ data });
}
