import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import {
  AdminRecordInputError,
  normalizeAdminRecordPayload,
} from "./admin-records.ts";
import { handleAdminOperationRequest } from "./admin-operations.ts";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const DUPLICATE_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectError(run: () => unknown, code: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof AdminRecordInputError, `expected ${code}`);
  assert(caught.code === code, `expected ${code}, received ${caught.code}`);
}

Deno.test("admin campaigns normalize dates, arrays and reject system fields", () => {
  const payload = normalizeAdminRecordPayload("campaigns", {
    name: "  Inverno  ",
    start_date: "",
    end_date: "2026-08-30",
    product_order: [TARGET_ID],
    receipts: { pix: 100 },
  }, "create");
  assert(payload.name === "Inverno", "name was not normalized");
  assert(payload.start_date === null, "empty nullable date was not cleared");
  assert(Array.isArray(payload.product_order), "product order changed");
  expectError(() =>
    normalizeAdminRecordPayload("campaigns", {
      name: "Teste",
      created_date: "2026-01-01",
    }, "create"), "invalid_field");
});

Deno.test("admin products validate UUID arrays and bounded JSON", () => {
  const payload = normalizeAdminRecordPayload("presale-products", {
    name: "Camiseta",
    sale_price: 99.9,
    campaign_ids: [TARGET_ID, TARGET_ID],
    variations: [{ name: "M", sale_price: 99.9 }],
    images: ["https://example.test/a.jpg"],
  }, "create");
  assert(
    (payload.campaign_ids as string[]).length === 1,
    "duplicate UUID was kept",
  );
  expectError(() =>
    normalizeAdminRecordPayload("presale-products", {
      name: "Camiseta",
      campaign_ids: ["not-a-uuid"],
    }, "create"), "invalid_field");
});

Deno.test("admin plans and coupons enforce business-safe states", () => {
  expectError(() =>
    normalizeAdminRecordPayload("plans", {
      modality_id: TARGET_ID,
      price_monthly: 100,
      price_total: 300,
      active: false,
      available_online: true,
    }, "create"), "invalid_plan_state");
  expectError(() =>
    normalizeAdminRecordPayload("coupons", {
      code: "PROMO",
      discount_type: "percentage",
      discount_value: 10,
      valid_from: "2026-09-01",
      valid_until: "2026-08-01",
    }, "create"), "invalid_date_range");
});

function rpcClient(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
): SupabaseClient {
  return {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({ data: { ok: true }, error: null });
    },
  } as unknown as SupabaseClient;
}

Deno.test("customer merge reaches only the transactional server RPC", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const response = await handleAdminOperationRequest(
    new Request("https://example.test", {
      method: "POST",
      body: JSON.stringify({
        duplicate_id: DUPLICATE_ID,
        customer: { full_name: "Atleta", cpf: "12345678901" },
      }),
    }),
    `/customers/${TARGET_ID}/merge`,
    rpcClient(calls),
    ACTOR_ID,
  );
  assert(response?.status === 200, "merge failed");
  assert(
    calls.length === 1 && calls[0].name === "merge_presale_customers_from_api",
    "wrong merge operation",
  );
  assert(calls[0].args.p_actor_id === ACTOR_ID, "actor was not preserved");
});

Deno.test("order item replacement reaches only the recalculating RPC", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const response = await handleAdminOperationRequest(
    new Request("https://example.test", {
      method: "PUT",
      body: JSON.stringify({
        items: [{
          product_name: "Camiseta",
          quantity: 1,
          sale_price: 100,
          cost_price: 40,
        }],
      }),
    }),
    `/orders/presale/${TARGET_ID}/items`,
    rpcClient(calls),
    ACTOR_ID,
  );
  assert(response?.status === 200, "item replacement failed");
  assert(
    calls.length === 1 &&
      calls[0].name === "replace_presale_order_items_from_api",
    "wrong item operation",
  );
});

Deno.test("admin operations reject unknown customer fields before the database", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const response = await handleAdminOperationRequest(
    new Request("https://example.test", {
      method: "POST",
      body: JSON.stringify({
        duplicate_id: DUPLICATE_ID,
        customer: { full_name: "Atleta", created_by: ACTOR_ID },
      }),
    }),
    `/customers/${TARGET_ID}/merge`,
    rpcClient(calls),
    ACTOR_ID,
  );
  assert(response?.status === 400, "unknown merge field was accepted");
  assert(calls.length === 0, "database was called for invalid merge");
});
