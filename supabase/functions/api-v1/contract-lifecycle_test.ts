import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { handleContractLifecycleRequest } from "./contract-lifecycle.ts";

const CONTRACT_ID = "11111111-1111-4111-8111-111111111111";
const COACH_ID = "22222222-2222-4222-8222-222222222222";
const LEAVE_ID = "33333333-3333-4333-8333-333333333333";
const ACTOR_ID = "44444444-4444-4444-8444-444444444444";
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

Deno.test("Contract dates use the atomic lifecycle RPC", async () => {
  const { fake, calls } = client();
  const path = `/orders/contract/${CONTRACT_ID}/dates`;
  const response = await handleContractLifecycleRequest(
    request(path, "PATCH", {
      start_date: "2026-08-01",
      end_date: "2027-07-31",
      expected_updated_at: UPDATED_AT,
    }),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 200, "date update failed");
  assert(calls[0].name === "update_assessment_contract_dates", "wrong RPC");
  assert(calls[0].args.p_contract_id === CONTRACT_ID, "contract id changed");
  assert(calls[0].args.p_actor_id === ACTOR_ID, "actor was not recorded");
  assert(
    calls[0].args.p_expected_updated_at === UPDATED_AT,
    "version was lost",
  );
});

Deno.test("Coach change sends only the selected coach and version", async () => {
  const { fake, calls } = client();
  const path = `/orders/contract/${CONTRACT_ID}/coach`;
  const response = await handleContractLifecycleRequest(
    request(path, "PATCH", {
      coach_id: COACH_ID,
      expected_updated_at: UPDATED_AT,
    }),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 200, "coach change failed");
  assert(calls[0].name === "change_assessment_contract_coach", "wrong RPC");
  assert(calls[0].args.p_coach_id === COACH_ID, "coach id changed");
});

Deno.test("Starting a leave preserves dates, reason, actor and version", async () => {
  const { fake, calls } = client();
  const path = `/orders/contract/${CONTRACT_ID}/leaves`;
  const response = await handleContractLifecycleRequest(
    request(path, "POST", {
      start_date: "2026-08-10",
      end_date: "2026-08-20",
      reason: "Viagem",
      expected_updated_at: UPDATED_AT,
    }),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 200, "leave start failed");
  assert(calls[0].name === "start_assessment_contract_leave", "wrong RPC");
  assert(calls[0].args.p_reason === "Viagem", "reason changed");
});

Deno.test("Finishing a leave binds it to the contract", async () => {
  const { fake, calls } = client();
  const path = `/orders/contract/${CONTRACT_ID}/leaves/${LEAVE_ID}/finish`;
  const response = await handleContractLifecycleRequest(
    request(path, "POST", { expected_updated_at: UPDATED_AT }),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 200, "leave finish failed");
  assert(calls[0].name === "finish_assessment_contract_leave", "wrong RPC");
  assert(calls[0].args.p_leave_id === LEAVE_ID, "leave id changed");
});

Deno.test("Cancellation sends inputs for authoritative server calculation", async () => {
  const { fake, calls } = client();
  const path = `/orders/contract/${CONTRACT_ID}/cancel`;
  const response = await handleContractLifecycleRequest(
    request(path, "POST", {
      cancellation_date: "2026-07-27",
      cancellation_fee_pct: 20,
      reason: "Solicitação do atleta",
      expected_updated_at: UPDATED_AT,
    }),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 200, "cancellation failed");
  assert(calls[0].name === "cancel_assessment_contract", "wrong RPC");
  assert(calls[0].args.p_cancellation_fee_pct === 20, "fee changed");
  assert(
    calls[0].args.p_expected_updated_at === UPDATED_AT,
    "version was lost",
  );
});

Deno.test("Invalid lifecycle input is rejected before database access", async () => {
  const { fake, calls } = client();
  const path = `/orders/contract/${CONTRACT_ID}/cancel`;
  const response = await handleContractLifecycleRequest(
    request(path, "POST", {
      cancellation_date: "2026-02-30",
      cancellation_fee_pct: 101,
      reason: null,
      expected_updated_at: UPDATED_AT,
    }),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 400, "invalid input was accepted");
  assert(calls.length === 0, "database was called for invalid input");
});

Deno.test("Concurrent contract changes surface as conflicts", async () => {
  const { fake } = client({
    code: "P0001",
    message: "O contrato foi alterado por outra ação",
  });
  const path = `/orders/contract/${CONTRACT_ID}/coach`;
  const response = await handleContractLifecycleRequest(
    request(path, "PATCH", {
      coach_id: COACH_ID,
      expected_updated_at: UPDATED_AT,
    }),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 409, "conflict did not return HTTP 409");
  const body = await response.json();
  assert(body.code === "invalid_transition", "conflict code changed");
});
