import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { handleCommunicationCaseRequest } from "./communication-cases.ts";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const KEY = "case:test:00000001";
const FINGERPRINT = "a".repeat(32);
type Call = { name: string; args: Record<string, unknown> };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function client(calls: Call[], error: Record<string, unknown> | null = null): SupabaseClient {
  return {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve({ data: { items: [], next_cursor: null }, error });
    },
  } as unknown as SupabaseClient;
}

function req(path: string, body?: unknown, key?: string): Request {
  return new Request(`https://example.test/api-v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const common = {
  expected_version: 4,
  expected_source_fingerprint: FINGERPRINT,
  source_ui: "communication_center",
};

Deno.test("case list uses server pagination and confines customer profile", async () => {
  const calls: Call[] = [];
  const path = `/communications/cases?customer_id=${CUSTOMER_ID}&state=to_do&limit=30`;
  const response = await handleCommunicationCaseRequest(req(path), "/communications/cases", client(calls), ACTOR_ID);
  assert(response?.status === 200, "list failed");
  assert(calls.length === 1 && calls[0].name === "list_communication_cases", "list used wrong RPC");
  assert(calls[0].args.p_customer_id === CUSTOMER_ID, "customer scope was lost");
  assert(calls[0].args.p_state === "to_do" && calls[0].args.p_limit === 30, "pagination changed");
});

Deno.test("manual send requires confirmation, version and idempotency key", async () => {
  const calls: Call[] = [];
  const path = `/communications/cases/${CASE_ID}/actions`;
  const valid = {
    ...common,
    action: "message_sent",
    message: "Oi, Ana!",
    channel: "whatsapp",
    confirmed_external_send: true,
    expected_rule_version: 2,
  };
  for (const [body, key] of [
    [{ ...valid, confirmed_external_send: false }, KEY],
    [valid, undefined],
    [{ ...valid, expected_source_fingerprint: "stale" }, KEY],
  ] as const) {
    const response = await handleCommunicationCaseRequest(req(path, body, key), path, client(calls), ACTOR_ID);
    assert(response?.status === 400, "unsafe send was accepted");
  }
  assert(calls.length === 0, "unsafe send reached database");
  const response = await handleCommunicationCaseRequest(req(path, valid, KEY), path, client(calls), ACTOR_ID);
  assert(response?.status === 200, "valid send failed");
  assert(calls[0].name === "apply_communication_case_action", "wrong action RPC");
  assert(calls[0].args.p_idempotency_key === KEY && calls[0].args.p_actor_id === ACTOR_ID, "actor or key lost");
});

Deno.test("response and scheduling keep dates in the request sent to the atomic RPC", async () => {
  const calls: Call[] = [];
  const path = `/communications/cases/${CASE_ID}/actions`;
  const response = await handleCommunicationCaseRequest(req(path, {
    ...common, action: "response_recorded", response_code: "thinking",
    note: "Retornar após a conversa", follow_up_at: "2026-10-07",
  }, KEY), path, client(calls), ACTOR_ID);
  assert(response?.status === 200, "response failed");
  const forwarded = calls[0].args.p_request as Record<string, unknown>;
  assert(forwarded.follow_up_at === "2026-10-07", "follow-up lost");
  assert(forwarded.response_code === "thinking", "response lost");
});

Deno.test("database stale-state conflicts are returned as 409", async () => {
  const calls: Call[] = [];
  const path = `/communications/cases/${CASE_ID}/actions`;
  const response = await handleCommunicationCaseRequest(req(path, {
    ...common, action: "return_scheduled", next_action_at: "2026-10-07",
  }, KEY), path, client(calls, { code: "P0001", message: "A origem mudou" }), ACTOR_ID);
  assert(response?.status === 409, "stale source was not surfaced as a conflict");
});

Deno.test("sync preview is read-only and sync requires an explicit POST", async () => {
  const calls: Call[] = [];
  const preview = await handleCommunicationCaseRequest(req("/communications/cases/sync/preview"),
    "/communications/cases/sync/preview", client(calls), ACTOR_ID);
  assert(preview?.status === 200 && calls[0].name === "preview_communication_case_sync", "preview RPC missing");
  const syncPath = "/communications/cases/sync";
  const sync = await handleCommunicationCaseRequest(req(syncPath, { source_type: "contract", limit: 100 }),
    syncPath, client(calls), ACTOR_ID);
  assert(sync?.status === 200 && calls[1].name === "sync_communication_cases", "explicit sync RPC missing");
});
