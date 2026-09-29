import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

// Mudança de plano no meio do ciclo (upgrade ou lateral). Todas as regras e
// travas ficam no banco; aqui só validamos o formato de cada pedido.
//
//   POST  /orders/contract/:id/plan-changes/preview
//   POST  /orders/contract/:id/plan-changes
//   PATCH /plan-changes/:id
//   POST  /plan-changes/:id/cancellation
//   PUT   /plan-changes/:id/external-charge
//
// O pagamento manual da diferença usa /orders/plan-change/:id/manual-payment
// (payments.ts).

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PAYMENT_METHOD_PATTERN = /^(pix|boleto|card_[1-6]x)$/;
const CONTRACT_PATH =
  /^\/orders\/contract\/([^/]+)\/plan-changes(\/preview)?$/;
const CHANGE_PATH = /^\/plan-changes\/([^/]+)(?:\/(cancellation|external-charge))?$/;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

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

function isOptionalText(value: unknown, maxLength: number): value is string | null {
  return value === null ||
    (typeof value === "string" && value.length <= maxLength);
}

function isReason(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= 500;
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await req.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
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

function methodNotAllowed(): Response {
  return jsonResponse({
    error: "Método não permitido",
    code: "method_not_allowed",
  }, 405);
}

function databaseError(error: { code?: string; message?: string }): Response {
  console.error("api-v1 plan changes:", error);
  if (error.code === "P0002") {
    return jsonResponse({ error: error.message, code: "not_found" }, 404);
  }
  if (error.code === "22023") {
    return jsonResponse({ error: error.message, code: "invalid_request" }, 400);
  }
  if (error.code === "P0001" || error.code === "23505") {
    return jsonResponse(
      { error: error.message, code: "invalid_transition" },
      409,
    );
  }
  return jsonResponse({
    error: "Não foi possível atualizar a mudança de plano",
    code: "database_error",
  }, 500);
}

async function callRpc(
  supabase: SupabaseClient,
  rpc: string,
  args: Record<string, unknown>,
  status = 200,
): Promise<Response> {
  const { data, error } = await supabase.rpc(rpc, args);
  if (error) return databaseError(error);
  return jsonResponse({ data }, status);
}

function validChangeFields(body: Record<string, unknown>): boolean {
  return isUuid(body.to_plan_id) && isCalendarDate(body.effective_date) &&
    (body.to_coach_id === null || isUuid(body.to_coach_id));
}

export async function handlePlanChangeRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  const contractMatch = path.match(CONTRACT_PATH);
  if (contractMatch) {
    const [, contractId, preview] = contractMatch;
    if (!isUuid(contractId)) return invalid("Contrato inválido");
    if (req.method !== "POST") return methodNotAllowed();
    const body = await readBody(req);
    if (!body) return invalid("Requisição inválida");

    if (preview) {
      if (
        !exactKeys(body, [
          "to_plan_id",
          "effective_date",
          "to_coach_id",
          "plan_change_id",
        ]) || !validChangeFields(body) ||
        !(body.plan_change_id === null || isUuid(body.plan_change_id))
      ) {
        return invalid("Dados da mudança de plano são inválidos");
      }
      return callRpc(supabase, "preview_assessment_plan_change", {
        p_contract_id: contractId,
        p_to_plan_id: body.to_plan_id,
        p_effective_date: body.effective_date,
        p_to_coach_id: body.to_coach_id,
        p_plan_change_id: body.plan_change_id,
      });
    }

    if (
      !exactKeys(body, [
        "to_plan_id",
        "effective_date",
        "to_coach_id",
        "notes",
        "expected_updated_at",
      ]) || !validChangeFields(body) || !isOptionalText(body.notes, 1000) ||
      !isTimestamp(body.expected_updated_at)
    ) {
      return invalid("Dados da mudança de plano são inválidos");
    }
    return callRpc(supabase, "create_assessment_plan_change", {
      p_contract_id: contractId,
      p_to_plan_id: body.to_plan_id,
      p_effective_date: body.effective_date,
      p_to_coach_id: body.to_coach_id,
      p_notes: body.notes,
      p_expected_updated_at: body.expected_updated_at,
      p_actor_id: actorId,
    }, 201);
  }

  const changeMatch = path.match(CHANGE_PATH);
  if (!changeMatch) return null;
  const [, planChangeId, action] = changeMatch;
  if (!isUuid(planChangeId)) return invalid("Mudança de plano inválida");

  const expectedMethod = action === "cancellation"
    ? "POST"
    : action === "external-charge"
    ? "PUT"
    : "PATCH";
  if (req.method !== expectedMethod) return methodNotAllowed();
  const body = await readBody(req);
  if (!body || !isTimestamp(body.expected_updated_at)) {
    return invalid("Versão da mudança de plano inválida");
  }

  if (action === "cancellation") {
    if (!exactKeys(body, ["reason", "expected_updated_at"]) || !isReason(body.reason)) {
      return invalid("Informe o motivo do cancelamento");
    }
    return callRpc(supabase, "cancel_assessment_plan_change", {
      p_plan_change_id: planChangeId,
      p_reason: body.reason,
      p_expected_updated_at: body.expected_updated_at,
      p_actor_id: actorId,
    });
  }

  if (action === "external-charge") {
    if (
      !exactKeys(body, [
        "external_link",
        "due_date",
        "payment_method",
        "invoice_number",
        "expected_updated_at",
      ]) || !isHttpsUrl(body.external_link) || !isCalendarDate(body.due_date) ||
      typeof body.payment_method !== "string" ||
      !PAYMENT_METHOD_PATTERN.test(body.payment_method) ||
      !isOptionalText(body.invoice_number, 200)
    ) {
      return invalid("Dados da cobrança externa são inválidos");
    }
    return callRpc(supabase, "save_assessment_plan_change_external_charge", {
      p_plan_change_id: planChangeId,
      p_external_link: body.external_link,
      p_due_date: body.due_date,
      p_payment_method: body.payment_method,
      p_invoice_number: body.invoice_number,
      p_expected_updated_at: body.expected_updated_at,
      p_actor_id: actorId,
    });
  }

  if (
    !exactKeys(body, [
      "to_plan_id",
      "effective_date",
      "to_coach_id",
      "reason",
      "expected_updated_at",
    ]) || !validChangeFields(body) || !isReason(body.reason)
  ) {
    return invalid("Dados da correção são inválidos");
  }
  return callRpc(supabase, "update_assessment_plan_change", {
    p_plan_change_id: planChangeId,
    p_to_plan_id: body.to_plan_id,
    p_effective_date: body.effective_date,
    p_to_coach_id: body.to_coach_id,
    p_reason: body.reason,
    p_expected_updated_at: body.expected_updated_at,
    p_actor_id: actorId,
  });
}
