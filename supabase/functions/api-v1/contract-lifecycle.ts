import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type LifecycleAction =
  | "dates"
  | "coach"
  | "start_leave"
  | "finish_leave"
  | "cancel"
  | "schedule_cancel"
  | "unschedule_cancel";

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
  console.error("api-v1 contract lifecycle:", error);
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
    error: "Não foi possível atualizar o contrato",
    code: "database_error",
  }, 500);
}

export async function handleContractLifecycleRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  const baseMatch = path.match(
    /^\/orders\/contract\/([^/]+)\/(dates|coach|leaves|cancel|cancellation-schedule)$/,
  );
  const finishMatch = path.match(
    /^\/orders\/contract\/([^/]+)\/leaves\/([^/]+)\/finish$/,
  );
  if (!baseMatch && !finishMatch) return null;

  const contractId = baseMatch?.[1] || finishMatch?.[1] || "";
  if (
    !UUID_PATTERN.test(contractId) ||
    (finishMatch && !UUID_PATTERN.test(finishMatch[2]))
  ) {
    return jsonResponse({
      error: "Contrato ou licença inválida",
      code: "invalid_request",
    }, 400);
  }

  const action: LifecycleAction = finishMatch
    ? "finish_leave"
    : baseMatch![2] === "leaves"
    ? "start_leave"
    : baseMatch![2] === "cancellation-schedule"
    // Mesmo recurso, dois verbos: POST agenda, DELETE desfaz o agendamento.
    ? (req.method === "DELETE" ? "unschedule_cancel" : "schedule_cancel")
    : baseMatch![2] as LifecycleAction;
  const expectedMethod = ["dates", "coach"].includes(action)
    ? "PATCH"
    : action === "unschedule_cancel"
    ? "DELETE"
    : "POST";
  if (req.method !== expectedMethod) {
    return jsonResponse({
      error: "Método não permitido",
      code: "method_not_allowed",
    }, 405);
  }

  const body = await readBody(req);
  if (!body) {
    return jsonResponse({
      error: "Requisição inválida",
      code: "invalid_request",
    }, 400);
  }

  let rpc = "";
  let args: Record<string, unknown> = {};
  const expectedUpdatedAt = body.expected_updated_at;
  if (!isTimestamp(expectedUpdatedAt)) {
    return jsonResponse({
      error: "Versão do contrato inválida",
      code: "invalid_request",
    }, 400);
  }

  if (action === "dates") {
    if (
      !exactKeys(body, ["start_date", "end_date", "expected_updated_at"]) ||
      !isCalendarDate(body.start_date) || !isCalendarDate(body.end_date) ||
      body.end_date <= body.start_date
    ) {
      return jsonResponse({
        error: "Informe um período válido",
        code: "invalid_request",
      }, 400);
    }
    rpc = "update_assessment_contract_dates";
    args = { p_start_date: body.start_date, p_end_date: body.end_date };
  } else if (action === "coach") {
    if (
      !exactKeys(body, ["coach_id", "expected_updated_at"]) ||
      typeof body.coach_id !== "string" || !UUID_PATTERN.test(body.coach_id)
    ) {
      return jsonResponse({
        error: "Selecione um coach válido",
        code: "invalid_request",
      }, 400);
    }
    rpc = "change_assessment_contract_coach";
    args = { p_coach_id: body.coach_id };
  } else if (action === "start_leave") {
    if (
      !exactKeys(body, [
        "start_date",
        "end_date",
        "reason",
        "expected_updated_at",
      ]) ||
      !isCalendarDate(body.start_date) ||
      !(body.end_date === null || isCalendarDate(body.end_date)) ||
      (typeof body.end_date === "string" && body.end_date < body.start_date) ||
      !(body.reason === null || typeof body.reason === "string") ||
      (typeof body.reason === "string" && body.reason.length > 1000)
    ) {
      return jsonResponse({
        error: "Informe uma licença válida",
        code: "invalid_request",
      }, 400);
    }
    rpc = "start_assessment_contract_leave";
    args = {
      p_start_date: body.start_date,
      p_end_date: body.end_date,
      p_reason: body.reason,
    };
  } else if (action === "finish_leave") {
    if (!exactKeys(body, ["expected_updated_at"])) {
      return jsonResponse({
        error: "Requisição inválida",
        code: "invalid_request",
      }, 400);
    }
    rpc = "finish_assessment_contract_leave";
    args = { p_leave_id: finishMatch![2] };
  } else if (action === "unschedule_cancel") {
    if (!exactKeys(body, ["expected_updated_at"])) {
      return jsonResponse({
        error: "Requisição inválida",
        code: "invalid_request",
      }, 400);
    }
    rpc = "unschedule_assessment_contract_cancellation";
    args = {};
  } else {
    // "cancel" e "schedule_cancel" recebem exatamente o mesmo payload; quem
    // decide se a data pode ser futura é a RPC correspondente.
    if (
      !exactKeys(body, [
        "cancellation_date",
        "cancellation_fee_pct",
        "reason",
        "expected_updated_at",
      ]) ||
      !isCalendarDate(body.cancellation_date) ||
      typeof body.cancellation_fee_pct !== "number" ||
      !Number.isFinite(body.cancellation_fee_pct) ||
      body.cancellation_fee_pct < 0 || body.cancellation_fee_pct > 100 ||
      !(body.reason === null || typeof body.reason === "string") ||
      (typeof body.reason === "string" && body.reason.length > 1000)
    ) {
      return jsonResponse({
        error: "Informe dados válidos para o cancelamento",
        code: "invalid_request",
      }, 400);
    }
    rpc = action === "schedule_cancel"
      ? "schedule_assessment_contract_cancellation"
      : "cancel_assessment_contract";
    args = {
      p_cancellation_date: body.cancellation_date,
      p_cancellation_fee_pct: body.cancellation_fee_pct,
      p_reason: body.reason,
    };
  }

  const { data, error } = await supabase.rpc(rpc, {
    p_contract_id: contractId,
    p_expected_updated_at: expectedUpdatedAt,
    p_actor_id: actorId,
    ...args,
  });
  if (error) return databaseError(error);
  return jsonResponse({ data });
}
