import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { handleRenewalStageRequest } from "./renewal-stage.ts";

const id = "11111111-1111-4111-8111-111111111111";
const actor = "22222222-2222-4222-8222-222222222222";
const path = `/orders/contract/${id}/renewal-stage`;
const version = "2026-10-02T08:00:00.000Z";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function request(body: unknown, key = "renewal:test:001"): Request {
  return new Request(`https://example.test/api-v1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

Deno.test("renewal stage sends a validated response and concurrency snapshot to the RPC", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve({ data: { contract: { id } }, error: null });
    },
  } as unknown as SupabaseClient;
  const response = await handleRenewalStageRequest(request({
    action: "register_response",
    response_code: "thinking",
    follow_up_at: "2026-10-10",
    expected_updated_at: version,
  }), path, client, actor);
  assert(response?.status === 200, "valid response was rejected");
  assert(calls.length === 1, "RPC was not called exactly once");
  assert(calls[0].name === "transition_assessment_renewal_stage", "wrong RPC");
  assert(calls[0].args.p_expected_updated_at === version, "version changed");
  assert(calls[0].args.p_idempotency_key === "renewal:test:001", "key changed");
  assert(calls[0].args.p_actor_id === actor, "actor changed");
});

Deno.test("renewal stage rejects unsafe actions before touching the database", async () => {
  let calls = 0;
  const client = {
    rpc: () => { calls++; return Promise.resolve({ data: null, error: null }); },
  } as unknown as SupabaseClient;
  for (const body of [
    { action: "payment_confirmed", expected_updated_at: version },
    { action: "register_response", response_code: "not_renewing", expected_updated_at: version },
    { action: "set_follow_up", follow_up_at: "2026-02-30", expected_updated_at: version },
    { action: "message_sent", renewal_stage: "renewed", expected_updated_at: version },
    { action: "message_sent", follow_up_at: "2026-10-10", expected_updated_at: version },
    { action: "register_subscription_link", subscription_link: "http://example.com/pay", expected_updated_at: version },
    { action: "register_subscription_link", subscription_link: "https://user@billing.example/pay", expected_updated_at: version },
    { action: "register_subscription_link", subscription_link: "https://localhost/pay", expected_updated_at: version },
    { action: "message_sent", subscription_link: "https://example.com/pay", expected_updated_at: version },
  ]) {
    const response = await handleRenewalStageRequest(request(body), path, client, actor);
    assert(response?.status === 400, "invalid action was accepted");
  }
  assert(calls === 0, "invalid action reached the RPC");
});

Deno.test("renewal stage forwards only a normalized existing subscription link", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    rpc: (_name: string, args: Record<string, unknown>) => {
      calls.push(args);
      return Promise.resolve({ data: { contract: { id } }, error: null });
    },
  } as unknown as SupabaseClient;
  const response = await handleRenewalStageRequest(request({
    action: "register_subscription_link",
    subscription_link: "https://pagamentos.example/assinatura/123",
    expected_updated_at: version,
  }), path, client, actor);
  assert(response?.status === 200, "valid subscription link was rejected");
  assert(calls.length === 1, "subscription link did not reach the RPC once");
  assert(calls[0].p_subscription_link === "https://pagamentos.example/assinatura/123", "link changed");
  assert(calls[0].p_action === "register_subscription_link", "wrong action");
});

Deno.test("renewal stage reports a stale contract as 409", async () => {
  const client = {
    rpc: () => Promise.resolve({ data: null, error: { code: "P0001", message: "stale" } }),
  } as unknown as SupabaseClient;
  const response = await handleRenewalStageRequest(request({
    action: "message_sent", expected_updated_at: version,
  }), path, client, actor);
  assert(response?.status === 409, "stale update did not return conflict");
});
