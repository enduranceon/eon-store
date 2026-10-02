import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { gateLegacyCommunication } from "./communication-legacy-gate.ts";
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function client(enabled: boolean, fails = false): SupabaseClient {
  const result = { data: { value: { enabled } }, error: fails ? { message: "query failed" } : null };
  return { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }) } as unknown as SupabaseClient;
}
const request = new Request("https://example.invalid", { method: "POST" });
Deno.test("rollout active blocks every legacy contact writer", async () => {
  for (const path of ["/communications/events", ...["contract", "presale", "stock", "event"].map(type => `/orders/${type}/example/payment-message`)]) {
    const response = await gateLegacyCommunication(request, path, client(true));
    assert(response?.status === 409, `writer ${path} remained active`);
  }
});
Deno.test("financial charge registration and renewal domain operations are preserved", async () => {
  for (const path of ["/orders/contract/example/external-charge", "/orders/contract/example/renewal-stage", "/orders/presale/example/manual-payment"]) {
    assert(await gateLegacyCommunication(request, path, {} as SupabaseClient) === null, `domain ${path} blocked`);
  }
});
Deno.test("inactive rollout preserves legacy compatibility", async () => {
  assert(await gateLegacyCommunication(request, "/communications/events", client(false)) === null, "legacy disabled before rollout");
});
Deno.test("uncertain rollout fails closed rather than allowing two writers", async () => {
  const response = await gateLegacyCommunication(request, "/communications/events", client(false, true));
  assert(response?.status === 503, "unknown rollout allowed write");
});
