import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PAYMENT_METHOD_PATTERN = /^(pix|boleto|card_([1-9]|1[0-2])x)$/;

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

function databaseError(error: { code?: string; message?: string }): Response {
  console.error("api-v1 contract billing:", error);
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
    error: "Não foi possível atualizar a cobrança do contrato",
    code: "database_error",
  }, 500);
}

export async function handleContractBillingRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  const match = path.match(
    /^\/orders\/contract\/([^/]+)\/(external-charge|payment-message)$/,
  );
  if (!match) return null;
  const [, contractId, action] = match;
  if (!UUID_PATTERN.test(contractId)) {
    return jsonResponse(
      { error: "Contrato inválido", code: "invalid_request" },
      400,
    );
  }

  const expectedMethod = action === "payment-message"
    ? "POST"
    : req.method === "DELETE"
    ? "DELETE"
    : "PUT";
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
  let args: Record<string, unknown>;
  if (action === "external-charge" && req.method === "DELETE") {
    if (!exactKeys(body, ["expected_updated_at"])) {
      return jsonResponse({
        error: "Requisição inválida",
        code: "invalid_request",
      }, 400);
    }
    rpc = "remove_assessment_contract_external_charge";
    args = {};
  } else if (action === "external-charge") {
    if (
      !exactKeys(body, [
        "external_link",
        "due_date",
        "payment_method",
        "invoice_number",
        "source",
        "expected_updated_at",
      ]) || !isHttpsUrl(body.external_link) || !isCalendarDate(body.due_date) ||
      typeof body.payment_method !== "string" ||
      !PAYMENT_METHOD_PATTERN.test(body.payment_method) ||
      !(body.invoice_number === null ||
        typeof body.invoice_number === "string") ||
      (typeof body.invoice_number === "string" &&
        body.invoice_number.length > 200) ||
      !["contract_detail", "renewals_page"].includes(String(body.source))
    ) {
      return jsonResponse({
        error: "Dados da cobrança externa são inválidos",
        code: "invalid_request",
      }, 400);
    }
    rpc = "save_assessment_contract_external_charge";
    args = {
      p_external_link: body.external_link,
      p_due_date: body.due_date,
      p_payment_method: body.payment_method,
      p_invoice_number: body.invoice_number,
      p_source: body.source,
    };
  } else {
    if (
      !exactKeys(body, [
        "source",
        "external_link",
        "due_date",
        "metadata",
        "expected_updated_at",
      ]) ||
      !["contract_detail", "communication_center", "renewals_page"].includes(
        String(body.source),
      ) ||
      !(body.external_link === null || isHttpsUrl(body.external_link)) ||
      !(body.due_date === null || isCalendarDate(body.due_date)) ||
      !body.metadata || typeof body.metadata !== "object" ||
      Array.isArray(body.metadata) ||
      JSON.stringify(body.metadata).length > 30000
    ) {
      return jsonResponse({
        error: "Dados do envio são inválidos",
        code: "invalid_request",
      }, 400);
    }
    rpc = "mark_assessment_contract_payment_message_sent";
    args = {
      p_source: body.source,
      p_external_link: body.external_link,
      p_due_date: body.due_date,
      p_metadata: body.metadata,
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
