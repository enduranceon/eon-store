import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { handleCommunicationModelRequest } from "./communication-models.ts";

const ACTOR = "22222222-2222-4222-8222-222222222222";
const DRAFT = "11111111-1111-4111-8111-111111111111";
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return new Request(`https://example.invalid/api-v1${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function fake(error: { code: string; message: string } | null = null) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = { rpc(name: string, args: Record<string, unknown>) { calls.push({ name, args }); return Promise.resolve({ data: { id: DRAFT }, error }); } } as unknown as SupabaseClient;
  return { calls, client };
}

Deno.test("model routes never trust actor supplied in body", async () => {
  const { calls, client } = fake();
  const path = "/communications/models/drafts";
  const response = await handleCommunicationModelRequest(request(path, { actor_id: ACTOR, rule: {} }), path, client, ACTOR);
  assert(response?.status === 400 && calls.length === 0, "client actor reached database");
});
Deno.test("missing authenticated actor cannot read model configuration", async () => {
  const { calls, client } = fake();
  const path = "/communications/models";
  const response = await handleCommunicationModelRequest(request(path), path, client, "");
  assert(response?.status === 401 && calls.length === 0, "anonymous actor reached configuration");
});
Deno.test("draft goes to atomic command with gate actor", async () => {
  const { calls, client } = fake();
  const path = "/communications/models/drafts";
  await handleCommunicationModelRequest(request(path, { rule_id: DRAFT, base_version: 1, rule: { name: "Teste fictício" } }), path, client, ACTOR);
  assert(calls[0].args.p_action === "save_draft" && calls[0].args.p_actor_id === ACTOR, "incorrect actor or write path");
});
Deno.test("publication requires both simulation fingerprint and version", async () => {
  const { calls, client } = fake();
  const path = `/communications/models/drafts/${DRAFT}/publish`;
  for (const body of [{}, { simulation_fingerprint: "a".repeat(32) }, { simulation_fingerprint: "x", expected_updated_at: "2026-10-02T12:00:00Z" }]) {
    const response = await handleCommunicationModelRequest(request(path, body), path, client, ACTOR);
    assert(response?.status === 400, "unreviewed publication accepted");
  }
  assert(calls.length === 0, "invalid publication reached database");
});
Deno.test("publication cannot replace draft contents after simulation", async () => {
  const { calls, client } = fake();
  const path = `/communications/models/drafts/${DRAFT}/publish`;
  const response = await handleCommunicationModelRequest(request(path, { expected_updated_at: "2026-10-02T12:00:00Z", simulation_fingerprint: "a".repeat(32), rule: { active: true } }), path, client, ACTOR);
  assert(response?.status === 400 && calls.length === 0, "draft mutation smuggled through publication");
});
Deno.test("simulation receives stored draft identifier, not caller replacement", async () => {
  const { calls, client } = fake();
  const path = `/communications/models/drafts/${DRAFT}/simulate`;
  await handleCommunicationModelRequest(request(path, {}), path, client, ACTOR);
  assert(calls[0].args.p_action === "simulate", "wrong command");
  assert((calls[0].args.p_payload as Record<string, unknown>).draft_id === DRAFT, "wrong draft");
});
Deno.test("stale publication reports a conflict instead of success", async () => {
  const { client } = fake({ code: "P0001", message: "O modelo mudou após a simulação" });
  const path = `/communications/models/drafts/${DRAFT}/publish`;
  const response = await handleCommunicationModelRequest(request(path, { expected_updated_at: "2026-10-02T12:00:00Z", simulation_fingerprint: "a".repeat(32) }), path, client, ACTOR);
  assert(response?.status === 409, "lost concurrent update not reported");
});
Deno.test("database internals are not exposed on unexpected failures", async () => {
  const { client } = fake({ code: "XX000", message: "sensitive internal diagnostic" });
  const path = "/communications/models";
  const response = await handleCommunicationModelRequest(request(path), path, client, ACTOR);
  assert(response?.status === 500, "failure reported as success");
  assert(!(await response.text()).includes("sensitive"), "internal diagnostic exposed");
});
Deno.test("invalid versions cursor is rejected without a query", async () => {
  const { client } = fake();
  const path = `/communications/models/${DRAFT}/versions`;
  const response = await handleCommunicationModelRequest(request(`${path}?cursor=garbage`), path, client, ACTOR);
  assert(response?.status === 400, "invalid cursor accepted");
});
