import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { handleContractMembershipRequest } from "./contract-membership.ts";

const CONTRACT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const UPDATED_AT = "2026-07-27T12:00:00.000Z";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function request(
  action: string,
  body: Record<string, unknown>,
  method = "POST",
  idempotencyKey?: string,
): Request {
  return new Request(
    `https://example.test/api-v1/orders/contract/${CONTRACT_ID}/${action}`,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function client(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  error: Record<string, unknown> | null = null,
): SupabaseClient {
  return {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve({ data: { ok: true }, error });
    },
  } as unknown as SupabaseClient;
}

Deno.test("Manual renewal requires idempotency and forwards the concurrency snapshot", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const path = `/orders/contract/${CONTRACT_ID}/renewal`;
  const response = await handleContractMembershipRequest(
    request(
      "renewal",
      { expected_updated_at: UPDATED_AT },
      "POST",
      "renewal:test:0001",
    ),
    path,
    client(calls),
    ACTOR_ID,
  );

  assert(response?.status === 200, "renewal was not accepted");
  assert(calls.length === 1, "renewal called the database more than once");
  assert(
    calls[0].name === "create_assessment_contract_renewal",
    "wrong renewal RPC",
  );
  assert(calls[0].args.p_contract_id === CONTRACT_ID, "contract id changed");
  assert(calls[0].args.p_actor_id === ACTOR_ID, "actor id changed");
  assert(
    calls[0].args.p_expected_updated_at === UPDATED_AT,
    "snapshot changed",
  );
  assert(
    calls[0].args.p_idempotency_key === "renewal:test:0001",
    "idempotency key changed",
  );
});

Deno.test("Manual renewal rejects a missing idempotency key", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const path = `/orders/contract/${CONTRACT_ID}/renewal`;
  const response = await handleContractMembershipRequest(
    request("renewal", { expected_updated_at: UPDATED_AT }),
    path,
    client(calls),
    ACTOR_ID,
  );

  assert(response?.status === 400, "missing idempotency was accepted");
  assert(calls.length === 0, "database was called for invalid idempotency");
});

Deno.test("Renewal activation uses the server-derived lifecycle", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const path = `/orders/contract/${CONTRACT_ID}/renewal-activation`;
  const response = await handleContractMembershipRequest(
    request("renewal-activation", { expected_updated_at: UPDATED_AT }),
    path,
    client(calls),
    ACTOR_ID,
  );

  assert(response?.status === 200, "activation was not accepted");
  assert(
    calls[0].name === "activate_assessment_contract_renewal",
    "wrong activation RPC",
  );
  assert(
    !("p_status" in calls[0].args),
    "client controlled the lifecycle status",
  );
});

Deno.test("Auto-renewal requires PATCH and a boolean", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const path = `/orders/contract/${CONTRACT_ID}/auto-renewal`;
  const wrongMethod = await handleContractMembershipRequest(
    request("auto-renewal", {
      auto_renewal: true,
      expected_updated_at: UPDATED_AT,
    }),
    path,
    client(calls),
    ACTOR_ID,
  );
  assert(wrongMethod?.status === 405, "wrong method was accepted");

  const invalidValue = await handleContractMembershipRequest(
    request("auto-renewal", {
      auto_renewal: "true",
      expected_updated_at: UPDATED_AT,
    }, "PATCH"),
    path,
    client(calls),
    ACTOR_ID,
  );
  assert(invalidValue?.status === 400, "non-boolean toggle was accepted");

  const valid = await handleContractMembershipRequest(
    request("auto-renewal", {
      auto_renewal: true,
      expected_updated_at: UPDATED_AT,
    }, "PATCH"),
    path,
    client(calls),
    ACTOR_ID,
  );
  assert(valid?.status === 200, "valid toggle failed");
  assert(
    calls[0].name === "set_assessment_contract_auto_renewal",
    "wrong toggle RPC",
  );
  assert(calls[0].args.p_auto_renewal === true, "toggle value changed");
});

Deno.test("Non-renewal does not accept client-controlled churn fields", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const path = `/orders/contract/${CONTRACT_ID}/non-renewal`;
  const invalid = await handleContractMembershipRequest(
    request("non-renewal", {
      expected_updated_at: UPDATED_AT,
      cancellation_reason: "Outro motivo",
    }),
    path,
    client(calls),
    ACTOR_ID,
  );
  assert(invalid?.status === 400, "client-controlled reason was accepted");
  assert(calls.length === 0, "database was called for an invalid reason");

  const valid = await handleContractMembershipRequest(
    request("non-renewal", { expected_updated_at: UPDATED_AT }),
    path,
    client(calls),
    ACTOR_ID,
  );
  assert(valid?.status === 200, "valid non-renewal failed");
  assert(
    calls[0].name === "mark_assessment_contract_non_renewal",
    "wrong non-renewal RPC",
  );
});

Deno.test("Prospect confirmation validates money and HTTPS links", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const path = `/orders/contract/${CONTRACT_ID}/enrollment-confirmation`;
  const invalid = await handleContractMembershipRequest(
    request("enrollment-confirmation", {
      enrollment_fee: -1,
      manual_discount: 0,
      external_payment_link: "http://unsafe.test/pay",
      expected_updated_at: UPDATED_AT,
    }),
    path,
    client(calls),
    ACTOR_ID,
  );
  assert(invalid?.status === 400, "invalid enrollment data was accepted");
  assert(calls.length === 0, "database was called for invalid enrollment data");

  const valid = await handleContractMembershipRequest(
    request("enrollment-confirmation", {
      enrollment_fee: 100,
      manual_discount: 25.5,
      external_payment_link: "https://payments.example.test/invoice/1",
      expected_updated_at: UPDATED_AT,
    }),
    path,
    client(calls),
    ACTOR_ID,
  );
  assert(valid?.status === 200, "valid enrollment confirmation failed");
  assert(
    calls[0].name === "confirm_assessment_contract_enrollment",
    "wrong confirmation RPC",
  );
  assert(calls[0].args.p_enrollment_fee === 100, "enrollment fee changed");
  assert(calls[0].args.p_manual_discount === 25.5, "discount changed");
});

Deno.test("Prospect refusal forwards only the concurrency snapshot", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const path = `/orders/contract/${CONTRACT_ID}/enrollment-refusal`;
  const response = await handleContractMembershipRequest(
    request("enrollment-refusal", { expected_updated_at: UPDATED_AT }),
    path,
    client(calls),
    ACTOR_ID,
  );
  assert(response?.status === 200, "prospect refusal failed");
  assert(
    calls[0].name === "refuse_assessment_contract_enrollment",
    "wrong refusal RPC",
  );
  assert(
    Object.keys(calls[0].args).length === 3,
    "unexpected refusal fields reached the RPC",
  );
});

Deno.test("Database conflicts become HTTP 409", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const path = `/orders/contract/${CONTRACT_ID}/non-renewal`;
  const response = await handleContractMembershipRequest(
    request("non-renewal", { expected_updated_at: UPDATED_AT }),
    path,
    client(calls, { code: "P0001", message: "Contrato mudou" }),
    ACTOR_ID,
  );
  const payload = await body(response!);
  assert(response?.status === 409, "database conflict did not become 409");
  assert(payload.code === "invalid_transition", "wrong conflict code");
});
