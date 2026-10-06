import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";
import {
  AsaasApiError,
  getAsaasInstallmentPayments,
  getAsaasPayment,
} from "../_shared/asaas.ts";

// Conferência das cobranças externas no Asaas. Só lê: o link de fatura
// (www.asaas.com/i/<código>) aponta para a cobrança pay_<código>, e a rota
// devolve status, forma, valor e datas. Nada é gravado aqui; quem registra o
// pagamento é o fluxo manual de sempre, depois que o administrador confirma.

const ORDER_TABLES = {
  contract: "assessment_contracts",
  presale: "presale_orders",
  stock: "stock_orders",
  event: "event_registrations",
} as const;

type OrderType = keyof typeof ORDER_TABLES;
type AsaasPayload = Record<string, unknown>;

interface OrderRef {
  type: OrderType;
  id: string;
}

export interface AsaasPaymentFacts {
  status: string;
  billing_type: string | null;
  value: number | null;
  installment_number: number | null;
  due_date: string | null;
  client_payment_date: string | null;
  confirmed_date: string | null;
  payment_date: string | null;
}

export type AsaasCheckResult =
  & OrderRef
  & (
    | {
      result: "checked";
      payment: AsaasPaymentFacts;
      installments: AsaasPaymentFacts[] | null;
    }
    | { result: "closed"; local_status: string }
    | { result: "asaas_error"; message: string }
    | {
      result:
        | "not_found"
        | "asaas_api_charge"
        | "unsupported_link"
        | "asaas_not_found"
        | "not_checked";
    }
  );

export const MAX_CHECK_ORDERS = 100;
const CHECK_PATH = "/asaas/payment-check";
const CONCURRENCY = 4;
const DEADLINE_MS = 60_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVOICE_LINK_PATTERN =
  /^https:\/\/www\.asaas\.com\/i\/([A-Za-z0-9]{6,40})\/?$/;
const CLOSED_STATUSES = new Set([
  "paid",
  "partially_paid",
  "cancelled",
  "refunded",
]);

export function asaasPaymentIdFromLink(link: unknown): string | null {
  if (typeof link !== "string") return null;
  const match = link.trim().match(INVOICE_LINK_PATTERN);
  return match ? `pay_${match[1]}` : null;
}

export function parseCheckOrders(body: unknown): OrderRef[] | null {
  const list = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).orders
    : null;
  if (
    !Array.isArray(list) || list.length === 0 ||
    list.length > MAX_CHECK_ORDERS
  ) {
    return null;
  }

  const seen = new Set<string>();
  const orders: OrderRef[] = [];
  for (const item of list) {
    const type = (item as Record<string, unknown> | null)?.type;
    const id = (item as Record<string, unknown> | null)?.id;
    if (
      typeof type !== "string" || !Object.hasOwn(ORDER_TABLES, type) ||
      typeof id !== "string" || !UUID_PATTERN.test(id)
    ) {
      return null;
    }
    const ref = { type: type as OrderType, id: id.toLowerCase() };
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    orders.push(ref);
  }
  return orders;
}

function dateValue(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? value.slice(0, 10)
    : null;
}

function moneyValue(value: unknown): number | null {
  const amount = typeof value === "number" ? value : Number(value);
  return value !== null && value !== "" && Number.isFinite(amount)
    ? Math.round(amount * 100) / 100
    : null;
}

// Só o que a conferência usa: nenhum dado do cliente sai do Asaas.
export function paymentFacts(payment: AsaasPayload): AsaasPaymentFacts {
  const status = payment.deleted === true
    ? "DELETED"
    : typeof payment.status === "string"
    ? payment.status
    : "UNKNOWN";
  return {
    status,
    billing_type: typeof payment.billingType === "string"
      ? payment.billingType
      : null,
    value: moneyValue(payment.value),
    installment_number: Number.isInteger(payment.installmentNumber)
      ? payment.installmentNumber as number
      : null,
    due_date: dateValue(payment.dueDate),
    client_payment_date: dateValue(payment.clientPaymentDate),
    confirmed_date: dateValue(payment.confirmedDate),
    payment_date: dateValue(payment.paymentDate),
  };
}

function byInstallmentOrder(a: AsaasPaymentFacts, b: AsaasPaymentFacts) {
  return (a.installment_number ?? 0) - (b.installment_number ?? 0) ||
    String(a.due_date).localeCompare(String(b.due_date));
}

function asaasConfigured(): boolean {
  return Boolean(
    Deno.env.get("ASAAS_BASE_URL")?.trim() &&
      Deno.env.get("ASAAS_API_KEY")?.trim(),
  );
}

async function loadOrders(
  supabase: SupabaseClient,
  orders: OrderRef[],
): Promise<Map<string, Record<string, unknown>>> {
  const rows = new Map<string, Record<string, unknown>>();
  for (const type of Object.keys(ORDER_TABLES) as OrderType[]) {
    const ids = orders.filter((order) => order.type === type).map((order) =>
      order.id
    );
    if (ids.length === 0) continue;
    const { data, error } = await supabase
      .from(ORDER_TABLES[type])
      .select("id, payment_status, external_payment_link, asaas_charge_id")
      .in("id", ids);
    if (error) throw error;
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      rows.set(`${type}:${String(row.id).toLowerCase()}`, row);
    }
  }
  return rows;
}

async function checkOrder(
  order: OrderRef,
  row: Record<string, unknown> | undefined,
): Promise<AsaasCheckResult> {
  if (!row) return { ...order, result: "not_found" };
  const localStatus = String(row.payment_status ?? "");
  if (CLOSED_STATUSES.has(localStatus)) {
    return { ...order, result: "closed", local_status: localStatus };
  }
  // Cobrança criada pela integração automática segue o fluxo próprio dela.
  if (row.asaas_charge_id) return { ...order, result: "asaas_api_charge" };

  const paymentId = asaasPaymentIdFromLink(row.external_payment_link);
  if (!paymentId) return { ...order, result: "unsupported_link" };

  try {
    const lookup = await getAsaasPayment(paymentId);
    if (!lookup.found) return { ...order, result: "asaas_not_found" };

    const installmentId = typeof lookup.payment.installment === "string"
      ? lookup.payment.installment.trim()
      : "";
    const installments = installmentId
      ? (await getAsaasInstallmentPayments(installmentId))
        .map(paymentFacts)
        .sort(byInstallmentOrder)
      : null;

    return {
      ...order,
      result: "checked",
      payment: paymentFacts(lookup.payment),
      installments,
    };
  } catch (error) {
    if (error instanceof AsaasApiError && error.code !== "asaas_misconfigured") {
      return { ...order, result: "asaas_error", message: error.message };
    }
    throw error;
  }
}

async function runLimited<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, lane),
  );
  return results;
}

export async function handleAsaasPaymentCheckRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
): Promise<Response | null> {
  if (path !== CHECK_PATH) return null;
  if (req.method !== "POST") {
    return jsonResponse({
      error: "Método não permitido",
      code: "method_not_allowed",
    }, 405);
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const orders = parseCheckOrders(body);
  if (!orders) {
    return jsonResponse({
      error: `Envie de 1 a ${MAX_CHECK_ORDERS} cobranças válidas`,
      code: "invalid_request",
    }, 400);
  }

  if (!asaasConfigured()) {
    return jsonResponse({
      error: "A conferência com o Asaas ainda não foi configurada",
      code: "asaas_not_configured",
    }, 503);
  }

  let rows: Map<string, Record<string, unknown>>;
  try {
    rows = await loadOrders(supabase, orders);
  } catch (error) {
    console.error(
      "api-v1 asaas payment check: load orders",
      (error as { code?: string })?.code,
      (error as { message?: string })?.message,
    );
    return jsonResponse({
      error: "Não foi possível carregar as cobranças",
      code: "database_error",
    }, 500);
  }

  const startedAt = Date.now();
  let results: AsaasCheckResult[];
  try {
    results = await runLimited(orders, CONCURRENCY, (order) =>
      Date.now() - startedAt > DEADLINE_MS
        ? Promise.resolve({ ...order, result: "not_checked" as const })
        : checkOrder(order, rows.get(`${order.type}:${order.id}`)));
  } catch (error) {
    if (error instanceof AsaasApiError) {
      return jsonResponse({
        error: "A conferência com o Asaas ainda não foi configurada",
        code: "asaas_not_configured",
      }, 503);
    }
    console.error(
      "api-v1 asaas payment check:",
      error instanceof Error ? error.message : error,
    );
    return jsonResponse({
      error: "Não foi possível conferir as cobranças no Asaas",
      code: "asaas_check_failed",
    }, 502);
  }

  // Se nenhuma consulta deu certo, o problema é de acesso (chave, conta ou
  // rede), não de uma cobrança: avisa uma vez em vez de repetir por linha.
  const consulted = results.filter((item) =>
    item.result === "checked" || item.result === "asaas_not_found" ||
    item.result === "asaas_error"
  );
  const firstError = consulted.find((item) => item.result === "asaas_error");
  if (
    firstError && consulted.every((item) => item.result === "asaas_error")
  ) {
    return jsonResponse({
      error: `Não foi possível consultar o Asaas: ${
        (firstError as { message: string }).message
      }`,
      code: "asaas_check_failed",
    }, 502);
  }

  return jsonResponse({
    data: {
      checked_at: new Date().toISOString(),
      results,
    },
  });
}
