import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

const MOVEMENT_COLUMNS = [
  "movement_id",
  "source",
  "source_table",
  "source_id",
  "order_id",
  "order_type",
  "reference",
  "business_unit",
  "revenue_center_id",
  "movement_kind",
  "cash_direction",
  "is_actual",
  "is_legacy",
  "status",
  "gross_amount",
  "fee_amount",
  "net_amount",
  "signed_net_amount",
  "payment_method",
  "occurred_on",
  "due_on",
  "recognition_on",
  "scheduled_on",
  "description",
  "created_at",
  "metadata",
].join(",");

const QUALITY_COLUMNS = [
  "issue_id",
  "severity",
  "issue_type",
  "business_unit",
  "source_table",
  "source_id",
  "order_id",
  "order_type",
  "reference",
  "amount",
  "occurred_on",
  "message",
  "metadata",
].join(",");

const BUSINESS_UNITS = new Set([
  "assessoria",
  "eventos",
  "loja",
  "pre_venda",
]);
const ORDER_TYPES = new Set(["contract", "event", "presale", "stock"]);
const MOVEMENT_KINDS = new Set([
  "expense",
  "payout",
  "payout_adjustment",
  "receipt",
  "receivable",
  "refund",
]);
const MOVEMENT_SORT_FIELDS = new Set([
  "created_at",
  "due_on",
  "movement_id",
  "occurred_on",
  "recognition_on",
  "scheduled_on",
]);
const QUALITY_SORT_FIELDS = new Set([
  "business_unit",
  "issue_id",
  "occurred_on",
  "severity",
]);
const QUALITY_SEVERITIES = new Set(["high", "medium", "low"]);
const QUALITY_ISSUE_TYPES = new Set([
  "event_refund_without_details",
  "movement_without_revenue_center",
  "open_sale_without_due_date",
  "pending_refund",
  "receipt_without_payment_row",
]);

class FinancialQueryError extends Error {
  code: string;

  constructor(message: string, code = "invalid_query") {
    super(message);
    this.code = code;
  }
}

type Sort = { field: string; ascending: boolean };

export type FinancialMovementFilters = {
  businessUnit: string | null;
  orderType: string | null;
  movementKind: string | null;
  isActual: boolean | null;
  scheduledFrom: string | null;
  scheduledTo: string | null;
  sort: Sort;
  limit: number;
};

export type FinancialQualityFilters = {
  businessUnit: string | null;
  severity: string | null;
  issueType: string | null;
  sort: Sort;
  limit: number;
};

function optionalEnum(
  params: URLSearchParams,
  key: string,
  allowed: Set<string>,
): string | null {
  const value = params.get(key);
  if (value === null || value === "") return null;
  if (!allowed.has(value)) {
    throw new FinancialQueryError(`Filtro ${key} inválido`);
  }
  return value;
}

function optionalBoolean(params: URLSearchParams, key: string): boolean | null {
  const value = params.get(key);
  if (value === null || value === "") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new FinancialQueryError(`Filtro ${key} inválido`);
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function optionalDate(params: URLSearchParams, key: string): string | null {
  const value = params.get(key);
  if (value === null || value === "") return null;
  if (!isIsoDate(value)) throw new FinancialQueryError(`Filtro ${key} inválido`);
  return value;
}

function parseSort(
  params: URLSearchParams,
  allowed: Set<string>,
  fallback: string,
): Sort {
  const raw = params.get("sort") || fallback;
  const field = raw.startsWith("-") ? raw.slice(1) : raw;
  if (!allowed.has(field)) throw new FinancialQueryError("Ordenação inválida");
  return { field, ascending: !raw.startsWith("-") };
}

function parseLimit(params: URLSearchParams): number {
  const raw = params.get("limit");
  if (!raw) return 5000;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
    throw new FinancialQueryError("Limite inválido");
  }
  return limit;
}

export function parseFinancialMovementFilters(url: URL): FinancialMovementFilters {
  const params = url.searchParams;
  const scheduledFrom = optionalDate(params, "scheduled_from");
  const scheduledTo = optionalDate(params, "scheduled_to");
  if (scheduledFrom && scheduledTo && scheduledFrom > scheduledTo) {
    throw new FinancialQueryError("Período financeiro inválido");
  }

  return {
    businessUnit: optionalEnum(params, "business_unit", BUSINESS_UNITS),
    orderType: optionalEnum(params, "order_type", ORDER_TYPES),
    movementKind: optionalEnum(params, "movement_kind", MOVEMENT_KINDS),
    isActual: optionalBoolean(params, "is_actual"),
    scheduledFrom,
    scheduledTo,
    sort: parseSort(params, MOVEMENT_SORT_FIELDS, "-scheduled_on"),
    limit: parseLimit(params),
  };
}

export function parseFinancialQualityFilters(url: URL): FinancialQualityFilters {
  const params = url.searchParams;
  return {
    businessUnit: optionalEnum(params, "business_unit", BUSINESS_UNITS),
    severity: optionalEnum(params, "severity", QUALITY_SEVERITIES),
    issueType: optionalEnum(params, "issue_type", QUALITY_ISSUE_TYPES),
    sort: parseSort(params, QUALITY_SORT_FIELDS, "issue_id"),
    limit: parseLimit(params),
  };
}

function queryErrorResponse(error: unknown): Response {
  if (error instanceof FinancialQueryError) {
    return jsonResponse({ error: error.message, code: error.code }, 400);
  }
  console.error("api-v1 financial query:", error);
  return jsonResponse({
    error: "Não foi possível consultar os dados financeiros",
    code: "financial_query_error",
  }, 500);
}

function databaseError(error: { message?: string }, resource: string): Response {
  console.error(`api-v1 financial ${resource}:`, error);
  return jsonResponse({
    error: "Não foi possível carregar os dados financeiros",
    code: "financial_read_error",
  }, 500);
}

export async function handleFinancialRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
): Promise<Response | null> {
  if (path !== "/financial/movements" && path !== "/financial/quality") {
    return null;
  }

  if (req.method !== "GET") {
    return jsonResponse({
      error: "Método não permitido",
      code: "method_not_allowed",
    }, 405);
  }

  try {
    const url = new URL(req.url);

    if (path === "/financial/movements") {
      const filters = parseFinancialMovementFilters(url);
      let query = supabase
        .from("financial_movements")
        .select(MOVEMENT_COLUMNS)
        .order(filters.sort.field, { ascending: filters.sort.ascending })
        .limit(filters.limit);

      if (filters.businessUnit) query = query.eq("business_unit", filters.businessUnit);
      if (filters.orderType) query = query.eq("order_type", filters.orderType);
      if (filters.movementKind) query = query.eq("movement_kind", filters.movementKind);
      if (filters.isActual !== null) query = query.eq("is_actual", filters.isActual);
      if (filters.scheduledFrom) query = query.gte("scheduled_on", filters.scheduledFrom);
      if (filters.scheduledTo) query = query.lte("scheduled_on", filters.scheduledTo);

      const { data, error } = await query;
      if (error) return databaseError(error, "movements");
      return jsonResponse({ data: data ?? [] });
    }

    const filters = parseFinancialQualityFilters(url);
    let query = supabase
      .from("financial_data_quality")
      .select(QUALITY_COLUMNS)
      .order(filters.sort.field, { ascending: filters.sort.ascending })
      .limit(filters.limit);

    if (filters.businessUnit) query = query.eq("business_unit", filters.businessUnit);
    if (filters.severity) query = query.eq("severity", filters.severity);
    if (filters.issueType) query = query.eq("issue_type", filters.issueType);

    const { data, error } = await query;
    if (error) return databaseError(error, "quality");
    return jsonResponse({ data: data ?? [] });
  } catch (error) {
    return queryErrorResponse(error);
  }
}
