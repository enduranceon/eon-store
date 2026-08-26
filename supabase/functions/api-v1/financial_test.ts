import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import {
  handleFinancialRequest,
  parseFinancialQualityFilters,
  parseFinancialMovementFilters,
} from "./financial.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type QueryCall = { method: string; args: unknown[] };

function clientWithResult(result: { data: unknown[] | null; error: null }) {
  const calls: QueryCall[] = [];
  const query = {
    select(columns: string) {
      calls.push({ method: "select", args: [columns] });
      return query;
    },
    order(field: string, options: { ascending: boolean }) {
      calls.push({ method: "order", args: [field, options] });
      return query;
    },
    limit(limit: number) {
      calls.push({ method: "limit", args: [limit] });
      return query;
    },
    eq(field: string, value: unknown) {
      calls.push({ method: "eq", args: [field, value] });
      return query;
    },
    gte(field: string, value: unknown) {
      calls.push({ method: "gte", args: [field, value] });
      return query;
    },
    lte(field: string, value: unknown) {
      calls.push({ method: "lte", args: [field, value] });
      return query;
    },
    then(resolve: (value: typeof result) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };

  const client = {
    from(table: string) {
      calls.push({ method: "from", args: [table] });
      return query;
    },
  } as unknown as SupabaseClient;

  return { client, calls };
}

Deno.test("financial movement filters accept only a bounded, valid query", () => {
  const filters = parseFinancialMovementFilters(
    new URL(
      "https://example.test/api-v1/financial/movements?business_unit=eventos&order_type=event&movement_kind=receipt&is_actual=true&scheduled_from=2026-08-01&scheduled_to=2026-08-31&sort=-scheduled_on&limit=250",
    ),
  );

  assert(filters.businessUnit === "eventos", "business unit changed");
  assert(filters.orderType === "event", "order type changed");
  assert(filters.movementKind === "receipt", "movement kind changed");
  assert(filters.isActual === true, "actual filter changed");
  assert(filters.scheduledFrom === "2026-08-01", "start date changed");
  assert(filters.scheduledTo === "2026-08-31", "end date changed");
  assert(filters.sort.field === "scheduled_on" && !filters.sort.ascending, "sort changed");
  assert(filters.limit === 250, "limit changed");
});

Deno.test("financial movements are queried through an allowlisted server route", async () => {
  const { client, calls } = clientWithResult({
    data: [{ movement_id: "event-registration-1" }],
    error: null,
  });
  const path = "/financial/movements";
  const response = await handleFinancialRequest(
    new Request(
      "https://example.test/api-v1/financial/movements?order_type=event&is_actual=false&scheduled_from=2026-08-01&scheduled_to=2026-08-31&sort=due_on",
    ),
    path,
    client,
  );

  assert(response?.status === 200, "financial movement request failed");
  const body = await response.json();
  assert(body.data.length === 1, "movement response changed");
  assert(calls[0].args[0] === "financial_movements", "wrong relation was queried");
  assert(calls.some(call => call.method === "eq" && call.args[0] === "order_type" && call.args[1] === "event"), "order type filter was lost");
  assert(calls.some(call => call.method === "eq" && call.args[0] === "is_actual" && call.args[1] === false), "actual filter was lost");
  assert(calls.some(call => call.method === "gte" && call.args[1] === "2026-08-01"), "start date filter was lost");
  assert(calls.some(call => call.method === "lte" && call.args[1] === "2026-08-31"), "end date filter was lost");
});

Deno.test("financial quality uses the protected quality view", async () => {
  const { client, calls } = clientWithResult({
    data: [{ issue_id: "pending_charge:1" }],
    error: null,
  });
  const response = await handleFinancialRequest(
    new Request("https://example.test/api-v1/financial/quality?business_unit=assessoria&severity=high&issue_type=pending_refund&sort=-occurred_on&limit=10"),
    "/financial/quality",
    client,
  );

  assert(response?.status === 200, "financial quality request failed");
  assert(calls[0].args[0] === "financial_data_quality", "wrong quality relation was queried");
  assert(calls.some(call => call.method === "order" && call.args[0] === "occurred_on"), "quality sort was lost");
  assert(calls.some(call => call.method === "limit" && call.args[0] === 10), "quality limit was lost");
  assert(calls.some(call => call.method === "eq" && call.args[0] === "business_unit" && call.args[1] === "assessoria"), "quality business unit filter was lost");
  assert(calls.some(call => call.method === "eq" && call.args[0] === "severity" && call.args[1] === "high"), "quality severity filter was lost");
  assert(calls.some(call => call.method === "eq" && call.args[0] === "issue_type" && call.args[1] === "pending_refund"), "quality issue type filter was lost");
});

Deno.test("financial quality filters accept only known reconciliation dimensions", () => {
  const filters = parseFinancialQualityFilters(
    new URL("https://example.test/api-v1/financial/quality?business_unit=loja&severity=medium&issue_type=movement_without_revenue_center&sort=-occurred_on&limit=50"),
  );

  assert(filters.businessUnit === "loja", "quality business unit changed");
  assert(filters.severity === "medium", "quality severity changed");
  assert(filters.issueType === "movement_without_revenue_center", "quality issue type changed");
  assert(filters.sort.field === "occurred_on" && !filters.sort.ascending, "quality sort changed");
  assert(filters.limit === 50, "quality limit changed");
});

Deno.test("financial route rejects invalid filters and write methods", async () => {
  const { client } = clientWithResult({ data: [], error: null });
  const invalid = await handleFinancialRequest(
    new Request("https://example.test/api-v1/financial/movements?sort=password"),
    "/financial/movements",
    client,
  );
  assert(invalid?.status === 400, "invalid sort was accepted");

  const invalidQuality = await handleFinancialRequest(
    new Request("https://example.test/api-v1/financial/quality?issue_type=unexpected"),
    "/financial/quality",
    client,
  );
  assert(invalidQuality?.status === 400, "invalid quality filter was accepted");

  const write = await handleFinancialRequest(
    new Request("https://example.test/api-v1/financial/movements", { method: "POST" }),
    "/financial/movements",
    client,
  );
  assert(write?.status === 405, "write method was accepted");
});
