import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { handleOrderExternalBillingRequest } from "./order-external-billing.ts";

const ORDER_ID = "7838481a-f3f8-42b2-a462-fb3f32e5ab11";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const UPDATED_AT = "2026-08-24T18:15:46.359Z";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function request(path: string, method: string, body: Record<string, unknown>) {
  return new Request(`https://example.test/api-v1${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function client(error: { code: string; message: string } | null = null) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const fake = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({
        data: { order: { id: ORDER_ID } },
        error,
      });
    },
  } as unknown as SupabaseClient;
  return { fake, calls };
}

function externalChargeBody(overrides: Record<string, unknown> = {}) {
  return {
    external_link: "https://payments.example.test/invoice/order-1",
    due_date: "2026-08-31",
    payment_method: "card_3x",
    invoice_number: "INV-2026-001",
    expected_updated_at: UPDATED_AT,
    ...overrides,
  };
}

Deno.test("Order external charge saves through the protected RPC", async () => {
  const { fake, calls } = client();
  const path = `/orders/presale/${ORDER_ID}/external-charge`;
  const response = await handleOrderExternalBillingRequest(
    request(path, "PUT", externalChargeBody()),
    path,
    fake,
    ACTOR_ID,
  );

  assert(response?.status === 200, "external order charge save failed");
  assert(calls.length === 1, "save did not call the database");
  assert(calls[0].name === "save_order_external_charge", "wrong RPC");
  assert(calls[0].args.p_order_type === "presale", "wrong order type");
  assert(calls[0].args.p_order_id === ORDER_ID, "order id changed");
  assert(calls[0].args.p_actor_id === ACTOR_ID, "actor was not recorded");
  assert(
    calls[0].args.p_payment_method === "card_3x",
    "payment method changed",
  );
});

Deno.test("Order external charge accepts store orders", async () => {
  const { fake, calls } = client();
  const path = `/orders/stock/${ORDER_ID}/external-charge`;
  const response = await handleOrderExternalBillingRequest(
    request(path, "PUT", externalChargeBody({ payment_method: "pix" })),
    path,
    fake,
    ACTOR_ID,
  );

  assert(response?.status === 200, "stock external charge save failed");
  assert(calls[0].args.p_order_type === "stock", "stock type was not sent");
});

Deno.test("Order external charge rejects unsafe data before reaching the RPC", async () => {
  const { fake, calls } = client();
  const path = `/orders/presale/${ORDER_ID}/external-charge`;
  const response = await handleOrderExternalBillingRequest(
    request(
      path,
      "PUT",
      externalChargeBody({
        external_link: "http://payments.example.test/invoice/order-1",
        due_date: "2026-02-30",
      }),
    ),
    path,
    fake,
    ACTOR_ID,
  );

  assert(response?.status === 400, "unsafe external charge was accepted");
  assert(calls.length === 0, "database was called for invalid input");
});

Deno.test("Order external charge removal uses its protected RPC", async () => {
  const { fake, calls } = client();
  const path = `/orders/stock/${ORDER_ID}/external-charge`;
  const response = await handleOrderExternalBillingRequest(
    request(path, "DELETE", { expected_updated_at: UPDATED_AT }),
    path,
    fake,
    ACTOR_ID,
  );

  assert(response?.status === 200, "external order charge removal failed");
  assert(calls[0].name === "remove_order_external_charge", "wrong removal RPC");
  assert(
    calls[0].args.p_expected_updated_at === UPDATED_AT,
    "concurrency value changed",
  );
  assert(calls[0].args.p_actor_id === ACTOR_ID, "actor was not recorded");
});

Deno.test("Order external charge maps invalid transitions to conflict", async () => {
  const { fake } = client({
    code: "P0001",
    message: "Este pedido já possui cobrança Asaas",
  });
  const path = `/orders/presale/${ORDER_ID}/external-charge`;
  const response = await handleOrderExternalBillingRequest(
    request(path, "PUT", externalChargeBody()),
    path,
    fake,
    ACTOR_ID,
  );

  assert(
    response?.status === 409,
    "invalid transition was not mapped to conflict",
  );
});
