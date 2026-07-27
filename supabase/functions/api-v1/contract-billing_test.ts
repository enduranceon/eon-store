import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { handleContractBillingRequest } from "./contract-billing.ts";

const CONTRACT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const UPDATED_AT = "2026-07-27T12:00:00.000Z";

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
        data: { contract: { id: CONTRACT_ID } },
        error,
      });
    },
  } as unknown as SupabaseClient;
  return { fake, calls };
}

function externalChargeBody(overrides: Record<string, unknown> = {}) {
  return {
    external_link: "https://payments.example.test/invoice/123",
    due_date: "2026-08-01",
    payment_method: "card_3x",
    invoice_number: "NF-123",
    source: "contract_detail",
    expected_updated_at: UPDATED_AT,
    ...overrides,
  };
}

Deno.test("External charge save uses the protected atomic RPC", async () => {
  const { fake, calls } = client();
  const path = `/orders/contract/${CONTRACT_ID}/external-charge`;
  const response = await handleContractBillingRequest(
    request(path, "PUT", externalChargeBody()),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 200, "external charge save failed");
  assert(
    calls[0].name === "save_assessment_contract_external_charge",
    "wrong RPC",
  );
  assert(
    calls[0].args.p_external_link ===
      "https://payments.example.test/invoice/123",
    "link changed",
  );
  assert(calls[0].args.p_payment_method === "card_3x", "method changed");
  assert(calls[0].args.p_actor_id === ACTOR_ID, "actor was not recorded");
});

Deno.test("External charge removal keeps optimistic concurrency", async () => {
  const { fake, calls } = client();
  const path = `/orders/contract/${CONTRACT_ID}/external-charge`;
  const response = await handleContractBillingRequest(
    request(path, "DELETE", { expected_updated_at: UPDATED_AT }),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 200, "external charge removal failed");
  assert(
    calls[0].name === "remove_assessment_contract_external_charge",
    "wrong RPC",
  );
  assert(
    calls[0].args.p_expected_updated_at === UPDATED_AT,
    "version was lost",
  );
});

Deno.test("Payment message sends controlled metadata to one RPC", async () => {
  const { fake, calls } = client();
  const path = `/orders/contract/${CONTRACT_ID}/payment-message`;
  const response = await handleContractBillingRequest(
    request(path, "POST", {
      source: "communication_center",
      external_link: "https://payments.example.test/invoice/123",
      due_date: "2026-08-01",
      metadata: { task_kind: "charge_send", message: "Mensagem" },
      expected_updated_at: UPDATED_AT,
    }),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 200, "message registration failed");
  assert(
    calls[0].name === "mark_assessment_contract_payment_message_sent",
    "wrong RPC",
  );
  const metadata = calls[0].args.p_metadata as Record<string, unknown>;
  assert(metadata.task_kind === "charge_send", "metadata changed");
});

Deno.test("Native payment message accepts null external fields", async () => {
  const { fake, calls } = client();
  const path = `/orders/contract/${CONTRACT_ID}/payment-message`;
  const response = await handleContractBillingRequest(
    request(path, "POST", {
      source: "contract_detail",
      external_link: null,
      due_date: null,
      metadata: {},
      expected_updated_at: UPDATED_AT,
    }),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 200, "native message registration failed");
  assert(calls[0].args.p_external_link === null, "external link was invented");
});

Deno.test("External billing rejects HTTP and impossible dates before the database", async () => {
  const { fake, calls } = client();
  const path = `/orders/contract/${CONTRACT_ID}/external-charge`;
  const response = await handleContractBillingRequest(
    request(
      path,
      "PUT",
      externalChargeBody({
        external_link: "http://payments.example.test/invoice/123",
        due_date: "2026-02-30",
      }),
    ),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 400, "unsafe charge was accepted");
  assert(calls.length === 0, "database was called for invalid input");
});

Deno.test("External billing routes enforce HTTP methods", async () => {
  const { fake, calls } = client();
  const path = `/orders/contract/${CONTRACT_ID}/external-charge`;
  const response = await handleContractBillingRequest(
    request(path, "PATCH", externalChargeBody()),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 405, "invalid method was accepted");
  assert(calls.length === 0, "database was called for invalid method");
});

Deno.test("Concurrent billing changes surface as conflicts", async () => {
  const { fake } = client({
    code: "P0001",
    message: "O contrato foi alterado por outra ação",
  });
  const path = `/orders/contract/${CONTRACT_ID}/external-charge`;
  const response = await handleContractBillingRequest(
    request(path, "PUT", externalChargeBody()),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 409, "conflict did not return HTTP 409");
  const body = await response.json();
  assert(body.code === "invalid_transition", "conflict code changed");
});
