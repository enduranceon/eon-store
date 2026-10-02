import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { handleCommunicationHistoryRequest } from "./communication-history.ts";

const ACTOR = "22222222-2222-4222-8222-222222222222";
const CUSTOMER = "33333333-3333-4333-8333-333333333333";
const SOURCE = "44444444-4444-4444-8444-444444444444";
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function fake(error: { code?: string; message?: string } | null = null) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({ data: { items: [], next_cursor: null, as_of: "2026-10-02T12:00:00Z" }, error });
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}
function request(query = "", method = "GET") {
  return new Request(`https://example.invalid/api-v1/communications/history${query}`, { method });
}

Deno.test("history requires the admin actor from the route gate", async () => {
  const { client, calls } = fake();
  const response = await handleCommunicationHistoryRequest(request(), "/communications/history", client, "");
  assert(response?.status === 401 && calls.length === 0, "unauthorized history reached database");
});

Deno.test("history passes person, source, period and keyset filters to one read-only RPC", async () => {
  const { client, calls } = fake();
  const query = `?customer_id=${CUSTOMER}&source_type=stock&source_id=${SOURCE}&q=Marina&from=2026-01-01&to=2026-10-02&limit=75&cursor=YWJjZA==`;
  const response = await handleCommunicationHistoryRequest(request(query), "/communications/history", client, ACTOR);
  assert(response?.status === 200, "valid history query failed");
  assert(calls.length === 1 && calls[0].name === "search_communication_history", "history used a wrong or multiple queries");
  const args = calls[0].args;
  assert(args.p_customer_id === CUSTOMER && args.p_source_type === "stock" && args.p_source_id === SOURCE, "identity filters lost");
  assert(args.p_query === "Marina" && args.p_from === "2026-01-01" && args.p_to === "2026-10-02", "search period lost");
  assert(args.p_cursor === "YWJjZA==" && args.p_limit === 75, "pagination lost");
});

Deno.test("history rejects malformed filters before database work", async () => {
  const { client, calls } = fake();
  for (const query of [
    "?customer_id=wrong", `?source_id=${SOURCE}`, "?source_type=unknown",
    "?from=2026-02-30", "?from=2026-10-03&to=2026-10-02",
    "?limit=101", "?cursor=bad!", "?unknown=x",
  ]) {
    const response = await handleCommunicationHistoryRequest(request(query), "/communications/history", client, ACTOR);
    assert(response?.status === 400, `invalid filter accepted: ${query}`);
  }
  assert(calls.length === 0, "invalid history filter reached database");
});

Deno.test("history is read-only and hides unexpected database diagnostics", async () => {
  const { client, calls } = fake({ code: "XX000", message: "sensitive internal data" });
  const rejected = await handleCommunicationHistoryRequest(request(), "/communications/history", client, ACTOR);
  assert(rejected?.status === 500, "unexpected database failure reported as success");
  assert(!(await rejected.text()).includes("sensitive"), "database details leaked");
  const write = await handleCommunicationHistoryRequest(request("", "POST"), "/communications/history", client, ACTOR);
  assert(write?.status === 405 && calls.length === 1, "history accepted a mutation method");
});
