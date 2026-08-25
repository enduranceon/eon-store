import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { handleEventBillingRequest } from "./event-billing.ts";

const REGISTRATION_ID = "7838481a-f3f8-42b2-a462-fb3f32e5ab11";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const UPDATED_AT = "2026-08-20T15:30:46.359Z";

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
        data: { registration: { id: REGISTRATION_ID } },
        error,
      });
    },
  } as unknown as SupabaseClient;
  return { fake, calls };
}

function externalChargeBody(overrides: Record<string, unknown> = {}) {
  return {
    external_link: "https://payments.example.test/invoice/evt-1",
    due_date: "2026-08-20",
    payment_method: "pix",
    invoice_number: null,
    expected_updated_at: UPDATED_AT,
    ...overrides,
  };
}

Deno.test("Event external charge accepts real UUIDs and uses the protected RPC", async () => {
  const { fake, calls } = client();
  const path = `/orders/event/${REGISTRATION_ID}/external-charge`;
  const response = await handleEventBillingRequest(
    request(path, "PUT", externalChargeBody()),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 200, "external event charge save failed");
  assert(calls[0].name === "save_event_external_charge", "wrong RPC");
  assert(calls[0].args.p_order_id === REGISTRATION_ID, "registration changed");
  assert(calls[0].args.p_actor_id === ACTOR_ID, "actor was not recorded");
});

Deno.test("Event external charge rejects public registration numbers", async () => {
  const { fake, calls } = client();
  const path = "/orders/event/EVT-000001/external-charge";
  const response = await handleEventBillingRequest(
    request(path, "PUT", externalChargeBody()),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 400, "registration number was accepted");
  assert(calls.length === 0, "database was called for invalid route id");
});

Deno.test("Event external charge rejects event registration links", async () => {
  const { fake, calls } = client();
  const path = `/orders/event/${REGISTRATION_ID}/external-charge`;
  const response = await handleEventBillingRequest(
    request(
      path,
      "PUT",
      externalChargeBody({
        external_link: "https://eon-store.netlify.app/inscricao/briefingmif",
      }),
    ),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 400, "registration link was accepted");
  assert(calls.length === 0, "database was called for registration link");
});

Deno.test("Event external charge removal uses its protected RPC", async () => {
  const { fake, calls } = client();
  const path = `/orders/event/${REGISTRATION_ID}/external-charge`;
  const response = await handleEventBillingRequest(
    request(path, "DELETE", { expected_updated_at: UPDATED_AT }),
    path,
    fake,
    ACTOR_ID,
  );

  assert(response?.status === 200, "external event charge removal failed");
  assert(calls[0].name === "remove_event_external_charge", "wrong removal RPC");
  assert(
    calls[0].args.p_expected_updated_at === UPDATED_AT,
    "concurrency value changed",
  );
  assert(calls[0].args.p_actor_id === ACTOR_ID, "actor was not recorded");
});
