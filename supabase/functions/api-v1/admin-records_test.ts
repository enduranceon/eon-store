import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import {
  AdminRecordInputError,
  handleAdminRecordRequest,
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

Deno.test("plan transitions only change the type of an existing pair", async () => {
  const payload = normalizeAdminRecordPayload("plan-transitions", {
    transition_type: " not_allowed ",
  }, "update");
  assert(payload.transition_type === "not_allowed", "type was not normalized");
  expectError(() =>
    normalizeAdminRecordPayload("plan-transitions", {
      transition_type: "swap",
    }, "update"), "invalid_field");
  expectError(() =>
    normalizeAdminRecordPayload("plan-transitions", {
      from_plan_id: TARGET_ID,
    }, "update"), "invalid_field");
  expectError(() =>
    normalizeAdminRecordPayload("plan-transitions", {
      transition_type: "upgrade",
    }, "create"), "method_not_allowed");

  const databaseClient = {
    from() {
      throw new Error("database must not be called");
    },
  } as unknown as SupabaseClient;
  const response = await handleAdminRecordRequest(
    new Request("https://example.test", { method: "DELETE" }),
    `/admin-records/plan-transitions/${TARGET_ID}`,
    databaseClient,
    ACTOR_ID,
  );
  assert(response?.status === 405, "a pair was deleted through the API");
});

Deno.test("coach site plans pick one plan per modality and duration", async () => {
  const payload = normalizeAdminRecordPayload("coach-site-plans", {
    coach_id: TARGET_ID,
    modality_id: DUPLICATE_ID,
    period_months: 3,
    plan_id: ACTOR_ID,
  }, "create");
  assert(payload.period_months === 3, "duration was not kept");
  const update = normalizeAdminRecordPayload("coach-site-plans", { plan_id: TARGET_ID }, "update");
  assert(update.plan_id === TARGET_ID, "plan was not updated");
  expectError(() =>
    normalizeAdminRecordPayload("coach-site-plans", { period_months: 6 }, "update"), "invalid_field");
  expectError(() =>
    normalizeAdminRecordPayload("coach-site-plans", {
      coach_id: TARGET_ID,
      modality_id: DUPLICATE_ID,
      period_months: 0,
      plan_id: ACTOR_ID,
    }, "create"), "invalid_field");

  // A regra do banco (plano de outra duração) chega na tela com a mensagem dela.
  const databaseClient = {
    from(table: string) {
      assert(table === "assessment_coach_site_plans", "wrong table");
      return {
        insert: () => ({
          select: () => ({
            single: () => Promise.resolve({
              data: null,
              error: { code: "22023", message: "O plano escolhido é de outra duração" },
            }),
          }),
        }),
      };
    },
  } as unknown as SupabaseClient;
  const response = await handleAdminRecordRequest(
    new Request("https://example.test", {
      method: "POST",
      body: JSON.stringify({ coach_id: TARGET_ID, modality_id: DUPLICATE_ID, period_months: 1, plan_id: ACTOR_ID }),
    }),
    "/admin-records/coach-site-plans",
    databaseClient,
    ACTOR_ID,
  );
  assert(response?.status === 400, `expected 400, received ${response?.status}`);
  const body = await response.json();
  assert(body.error === "O plano escolhido é de outra duração", "database message was lost");
});

Deno.test("legacy presale updates reject identity fields before the database", async () => {
  const protectedFields: Record<string, unknown>[] = [
    { customer_id: TARGET_ID },
    { checkout_name: "Atleta" },
    { checkout_whatsapp: "5511999999999" },
    { checkout_email: "atleta@example.test" },
  ];
  let databaseCalls = 0;
  const databaseClient = {
    from() {
      databaseCalls += 1;
      throw new Error("database must not be called");
    },
  } as unknown as SupabaseClient;

  for (const payload of protectedFields) {
    const response = await handleAdminRecordRequest(
      new Request("https://example.test", {
        method: "PATCH",
        body: JSON.stringify(payload),
      }),
      `/admin-records/legacy-presale-orders/${TARGET_ID}`,
      databaseClient,
      ACTOR_ID,
    );
    const field = Object.keys(payload)[0];
    assert(response?.status === 400, `${field} was accepted`);
    const body = await response.json();
    assert(body.code === "invalid_field", `${field} returned the wrong error`);
  }

  assert(databaseCalls === 0, "database was called for protected fields");
});

Deno.test("legacy presale creation keeps checkout identity fields", () => {
  const payload = normalizeAdminRecordPayload("legacy-presale-orders", {
    items: [],
    customer_id: TARGET_ID,
    checkout_name: "Atleta",
    checkout_whatsapp: "5511999999999",
    checkout_email: "atleta@example.test",
  }, "create");

  assert(payload.customer_id === TARGET_ID, "customer link was removed");
  assert(payload.checkout_name === "Atleta", "checkout name was removed");
  assert(
    payload.checkout_whatsapp === "5511999999999",
    "checkout whatsapp was removed",
  );
  assert(
    payload.checkout_email === "atleta@example.test",
    "checkout email was removed",
  );
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
