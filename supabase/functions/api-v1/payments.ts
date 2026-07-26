import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MANUAL_PAYMENT_PATH =
  /^\/orders\/(presale|stock|contract)\/([^/]+)\/manual-payment$/;

interface PaymentMethodConfig {
  id: string;
  installments: number | null;
  credit_days_first: number | null;
  credit_days_between: number | null;
}

interface ManualPaymentBody {
  payment_method_id: string;
  payment_date: string;
  total: number;
}

interface ManualAdjustmentBody {
  total: number;
  manual_discount: number;
  discount_reason: string;
  discount_recurring: boolean;
}

export interface ProjectedInstallment {
  number: number;
  total: number;
  due_date: string;
  credit_date: string;
}

function databaseError(
  error: { code?: string; message?: string },
  operation: string,
): Response {
  console.error(`api-v1 payments ${operation}:`, error);

  if (error.code === "P0002") {
    return jsonResponse({ error: error.message, code: "not_found" }, 404);
  }
  if (error.code === "22023") {
    return jsonResponse({ error: error.message, code: "invalid_request" }, 400);
  }
  if (error.code === "P0001") {
    return jsonResponse(
      { error: error.message, code: "invalid_transition" },
      409,
    );
  }

  return jsonResponse({
    error: "Não foi possível processar o pagamento manual",
    code: "database_error",
  }, 500);
}

function parseObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function parseBody(
  req: Request,
): Promise<Record<string, unknown> | null> {
  try {
    return parseObject(await req.json());
  } catch {
    return null;
  }
}

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function easterDate(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function nationalHolidays(year: number): Set<string> {
  const easter = easterDate(year).toISOString().slice(0, 10);
  return new Set([
    `${year}-01-01`,
    `${year}-04-21`,
    `${year}-05-01`,
    `${year}-09-07`,
    `${year}-10-12`,
    `${year}-11-02`,
    `${year}-11-15`,
    `${year}-11-20`,
    `${year}-12-25`,
    addDays(easter, -48),
    addDays(easter, -47),
    addDays(easter, -2),
    addDays(easter, 60),
  ]);
}

function nextBusinessDay(date: string): string {
  let current = date;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const [year, month, day] = current.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    const weekday = parsed.getUTCDay();
    if (
      weekday !== 0 && weekday !== 6 && !nationalHolidays(year).has(current)
    ) {
      return current;
    }
    current = addDays(current, 1);
  }
  return current;
}

export function projectManualInstallments(
  method: PaymentMethodConfig,
  paymentDate: string,
): ProjectedInstallment[] {
  if (!isValidIsoDate(paymentDate)) {
    throw new Error("Data de pagamento inválida");
  }

  const installments = Math.max(
    1,
    Math.min(12, Number(method.installments) || 1),
  );
  const firstOffset = Number(method.credit_days_first) || 0;
  const nextOffset = Number(method.credit_days_between) || 32;
  const projection: ProjectedInstallment[] = [];
  let previousDate = paymentDate;

  for (let number = 1; number <= installments; number += 1) {
    const rawDate = addDays(
      previousDate,
      number === 1 ? firstOffset : nextOffset,
    );
    const creditDate = nextBusinessDay(rawDate);
    projection.push({
      number,
      total: installments,
      due_date: creditDate,
      credit_date: creditDate,
    });
    previousDate = creditDate;
  }

  return projection;
}

function normalizeManualPaymentBody(
  body: Record<string, unknown> | null,
): ManualPaymentBody | null {
  const paymentMethodId = typeof body?.payment_method_id === "string"
    ? body.payment_method_id
    : "";
  const paymentDate = typeof body?.payment_date === "string"
    ? body.payment_date
    : "";
  const total = typeof body?.total === "number"
    ? body.total
    : Number(body?.total);

  if (
    !UUID_PATTERN.test(paymentMethodId) ||
    !isValidIsoDate(paymentDate) ||
    !Number.isFinite(total) ||
    total <= 0 ||
    total > 100_000_000
  ) {
    return null;
  }

  return {
    payment_method_id: paymentMethodId,
    payment_date: paymentDate,
    total: Math.round(total * 100) / 100,
  };
}

function normalizeManualAdjustmentBody(
  body: Record<string, unknown> | null,
): ManualAdjustmentBody | null {
  const total = typeof body?.total === "number"
    ? body.total
    : Number(body?.total);
  const manualDiscount = typeof body?.manual_discount === "number"
    ? body.manual_discount
    : Number(body?.manual_discount);
  const discountReason = body?.discount_reason == null
    ? ""
    : typeof body.discount_reason === "string"
    ? body.discount_reason.trim()
    : null;
  const discountRecurring = body?.discount_recurring == null
    ? false
    : body.discount_recurring;

  if (
    !Number.isFinite(total) ||
    total < 0 ||
    total > 100_000_000 ||
    !Number.isFinite(manualDiscount) ||
    manualDiscount < 0 ||
    manualDiscount > 100_000_000 ||
    discountReason == null ||
    discountReason.length > 500 ||
    typeof discountRecurring !== "boolean"
  ) {
    return null;
  }

  return {
    total: Math.round(total * 100) / 100,
    manual_discount: Math.round(manualDiscount * 100) / 100,
    discount_reason: discountReason,
    discount_recurring: discountRecurring,
  };
}

export async function handlePaymentsRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  if (path === "/payments/methods") {
    if (req.method !== "GET") {
      return jsonResponse({
        error: "Método não permitido",
        code: "method_not_allowed",
      }, 405);
    }

    const { data, error } = await supabase
      .from("payment_methods")
      .select(
        "id, group_name, name, kind, fee_percent, fee_fixed, credit_days_first, credit_days_between, installments, internal_code, order_index",
      )
      .eq("active", true)
      .order("order_index", { ascending: true });

    if (error) return databaseError(error, "list methods");
    return jsonResponse({ data: data || [] });
  }

  const match = path.match(MANUAL_PAYMENT_PATH);
  if (!match) return null;

  const [, orderType, orderId] = match;
  if (!UUID_PATTERN.test(orderId)) {
    return jsonResponse({
      error: "Identificador de venda inválido",
      code: "invalid_order_id",
    }, 400);
  }

  if (req.method === "POST") {
    const body = normalizeManualPaymentBody(await parseBody(req));
    if (!body) {
      return jsonResponse({
        error: "Dados do pagamento manual são inválidos",
        code: "invalid_request",
      }, 400);
    }

    const { data: method, error: methodError } = await supabase
      .from("payment_methods")
      .select("id, installments, credit_days_first, credit_days_between")
      .eq("id", body.payment_method_id)
      .eq("active", true)
      .maybeSingle();

    if (methodError) return databaseError(methodError, "load method");
    if (!method) {
      return jsonResponse({
        error: "Método de pagamento inválido ou inativo",
        code: "invalid_payment_method",
      }, 400);
    }

    const installments = projectManualInstallments(
      method as PaymentMethodConfig,
      body.payment_date,
    );
    const { data, error } = await supabase.rpc("api_record_manual_payment", {
      p_order_type: orderType,
      p_order_id: orderId,
      p_payment_method_id: body.payment_method_id,
      p_payment_date: body.payment_date,
      p_total: body.total,
      p_installments: installments,
      p_actor_id: actorId,
    });

    if (error) return databaseError(error, "record");
    return jsonResponse({ data });
  }

  if (req.method === "PATCH") {
    const body = normalizeManualAdjustmentBody(await parseBody(req));
    if (!body) {
      return jsonResponse({
        error: "Dados do ajuste manual são inválidos",
        code: "invalid_request",
      }, 400);
    }

    const { data, error } = await supabase.rpc("api_adjust_manual_payment", {
      p_order_type: orderType,
      p_order_id: orderId,
      p_total: body.total,
      p_manual_discount: body.manual_discount,
      p_discount_reason: body.discount_reason,
      p_discount_recurring: body.discount_recurring,
      p_actor_id: actorId,
    });

    if (error) return databaseError(error, "adjust");
    return jsonResponse({ data });
  }

  if (req.method === "DELETE") {
    const { data, error } = await supabase.rpc("api_reopen_manual_payment", {
      p_order_type: orderType,
      p_order_id: orderId,
      p_actor_id: actorId,
    });

    if (error) return databaseError(error, "reopen");
    return jsonResponse({ data });
  }

  return jsonResponse({
    error: "Método não permitido",
    code: "method_not_allowed",
  }, 405);
}
