import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const ACTION_PATH =
  /^\/orders\/contract\/([^/]+)\/(renewal|renewal-activation|auto-renewal|non-renewal|enrollment-confirmation|enrollment-refusal|prospect-proposal|prospect-message-sent|prospect-lost)$/;
const PROSPECT_LOSS_REASONS = new Set([
  "price",
  "no_response",
  "changed_mind",
  "chose_competitor",
  "coach_availability",
  "other",
]);

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 50 &&
    Number.isFinite(Date.parse(value));
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) &&
      !/[\s\u0000-\u001f\u007f]/.test(value);
  } catch {
    return false;
  }
}

function isMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= 0 && value <= 1_000_000;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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

function databaseError(error: { code?: string; message?: string }): Response {
  console.error("api-v1 contract membership:", error);
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
    error: "Não foi possível atualizar o vínculo da assessoria",
    code: "database_error",
  }, 500);
}

export async function handleContractMembershipRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  const match = path.match(ACTION_PATH);
  if (!match) return null;
  const [, contractId, action] = match;
  if (!UUID_PATTERN.test(contractId)) {
    return jsonResponse(
      { error: "Contrato inválido", code: "invalid_request" },
      400,
    );
  }

  const expectedMethod = action === "auto-renewal" ? "PATCH" : "POST";
  if (req.method !== expectedMethod) {
    return jsonResponse({
      error: "Método não permitido",
      code: "method_not_allowed",
    }, 405);
  }
  const body = await readBody(req);
  if (!body || !isTimestamp(body.expected_updated_at)) {
    return jsonResponse({
      error: "Versão do contrato inválida",
      code: "invalid_request",
    }, 400);
  }

  let rpc: string;
  let args: Record<string, unknown> = {};
  if (action === "renewal") {
    if (!exactKeys(body, ["expected_updated_at"])) {
      return jsonResponse({
        error: "Requisição inválida",
        code: "invalid_request",
      }, 400);
    }
    const idempotencyKey = req.headers.get("Idempotency-Key") || "";
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return jsonResponse({
        error: "Chave de idempotência inválida",
        code: "invalid_request",
      }, 400);
    }
    rpc = "create_assessment_contract_renewal";
    args = { p_idempotency_key: idempotencyKey };
  } else if (action === "renewal-activation") {
    if (!exactKeys(body, ["expected_updated_at"])) {
      return jsonResponse({
        error: "Requisição inválida",
        code: "invalid_request",
      }, 400);
    }
    rpc = "activate_assessment_contract_renewal";
  } else if (action === "auto-renewal") {
    if (
      !exactKeys(body, ["auto_renewal", "expected_updated_at"]) ||
      typeof body.auto_renewal !== "boolean"
    ) {
      return jsonResponse({
        error: "Requisição inválida",
        code: "invalid_request",
      }, 400);
    }
    rpc = "set_assessment_contract_auto_renewal";
    args = { p_auto_renewal: body.auto_renewal };
  } else if (action === "non-renewal") {
    if (!exactKeys(body, ["expected_updated_at"])) {
      return jsonResponse({
        error: "Requisição inválida",
        code: "invalid_request",
      }, 400);
    }
    rpc = "mark_assessment_contract_non_renewal";
  } else if (action === "enrollment-confirmation") {
    const link = body.external_payment_link;
    if (
      !exactKeys(body, [
        "enrollment_fee",
        "manual_discount",
        "external_payment_link",
        "expected_updated_at",
      ]) || !isMoney(body.enrollment_fee) || !isMoney(body.manual_discount) ||
      !(link === null || isHttpsUrl(link))
    ) {
      return jsonResponse({
        error: "Dados da adesão são inválidos",
        code: "invalid_request",
      }, 400);
    }
    rpc = "confirm_assessment_contract_enrollment";
    args = {
      p_enrollment_fee: body.enrollment_fee,
      p_manual_discount: body.manual_discount,
      p_external_payment_link: link,
    };
  } else if (action === "enrollment-refusal") {
    if (!exactKeys(body, ["expected_updated_at"])) {
      return jsonResponse({
        error: "Requisição inválida",
        code: "invalid_request",
      }, 400);
    }
    rpc = "refuse_assessment_contract_enrollment";
  } else if (action === "prospect-proposal") {
    if (
      !exactKeys(body, [
        "enrollment_fee",
        "manual_discount",
        "external_payment_link",
        "due_date",
        "expected_updated_at",
      ]) || !isMoney(body.enrollment_fee) || !isMoney(body.manual_discount) ||
      !isHttpsUrl(body.external_payment_link) || !isDate(body.due_date)
    ) {
      return jsonResponse({
        error: "Dados da proposta são inválidos",
        code: "invalid_request",
      }, 400);
    }
    rpc = "prepare_assessment_prospect_proposal";
    args = {
      p_enrollment_fee: body.enrollment_fee,
      p_manual_discount: body.manual_discount,
      p_external_payment_link: body.external_payment_link,
      p_due_date: body.due_date,
    };
  } else if (action === "prospect-message-sent") {
    if (!exactKeys(body, ["expected_updated_at"])) {
      return jsonResponse({
        error: "Requisição inválida",
        code: "invalid_request",
      }, 400);
    }
    rpc = "mark_assessment_prospect_message_sent";
  } else {
    const reasonNotes = body.reason_notes;
    if (
      !exactKeys(body, [
        "reason_code",
        "reason_notes",
        "external_cancellation_confirmed",
        "expected_updated_at",
      ]) || typeof body.reason_code !== "string" ||
      !PROSPECT_LOSS_REASONS.has(body.reason_code) ||
      !(reasonNotes === null ||
        (typeof reasonNotes === "string" && reasonNotes.length <= 500)) ||
      typeof body.external_cancellation_confirmed !== "boolean"
    ) {
      return jsonResponse({
        error: "Dados do encerramento são inválidos",
        code: "invalid_request",
      }, 400);
    }
    rpc = "lose_assessment_prospect";
    args = {
      p_reason_code: body.reason_code,
      p_reason_notes: reasonNotes,
      p_external_cancellation_confirmed:
        body.external_cancellation_confirmed,
    };
  }

  const { data, error } = await supabase.rpc(rpc, {
    p_contract_id: contractId,
    p_expected_updated_at: body.expected_updated_at,
    p_actor_id: actorId,
    ...args,
  });
  if (error) return databaseError(error);
  return jsonResponse({ data });
}
