import { AsaasApiError } from "../_shared/asaas.ts";
import { executeExternalRefund } from "./orders.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("Asaas refund is marker-idempotent and validates remaining value", async () => {
  const originalFetch = globalThis.fetch;
  const originalBase = Deno.env.get("ASAAS_BASE_URL");
  const originalKey = Deno.env.get("ASAAS_API_KEY");

  Deno.env.set("ASAAS_BASE_URL", "https://asaas.test/v3");
  Deno.env.set("ASAAS_API_KEY", "test-key");

  try {
    let calls = 0;
    globalThis.fetch = (_input, _init) => {
      calls += 1;
      return Promise.resolve(Response.json({
        id: "pay_1",
        status: "CONFIRMED",
        value: 100,
        refunds: [{
          id: "ref_1",
          status: "DONE",
          value: 25,
          description: "EON refund operation-1",
        }],
      }));
    };

    const repeated = await executeExternalRefund(
      "pay_1",
      25,
      "EON refund operation-1",
      false,
    );
    assert(repeated.outcome === "already_refunded", "existing marker was not recognized");
    assert(calls === 1, "marker retry unexpectedly issued a second refund request");

    const requests: Array<{ method: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = (_input, init) => {
      const method = init?.method || "GET";
      requests.push({
        method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (method === "POST") {
        return Promise.resolve(Response.json({ id: "ref_2", status: "PENDING" }));
      }
      return Promise.resolve(Response.json({
        id: "pay_2",
        status: "RECEIVED",
        value: 100,
        refunds: [{ status: "DONE", value: 20, description: "older operation" }],
      }));
    };

    const created = await executeExternalRefund(
      "pay_2",
      30,
      "EON refund operation-2",
      false,
    );
    assert(created.outcome === "refunded", "new refund was not issued");
    assert(requests.length === 2 && requests[1].method === "POST", "refund POST was not issued once");
    assert(requests[1].body?.value === 30, "refund value changed before reaching Asaas");
    assert(
      requests[1].body?.description === "EON refund operation-2",
      "idempotency marker changed before reaching Asaas",
    );

    globalThis.fetch = () => Promise.resolve(Response.json({
      id: "pay_3",
      status: "REFUNDED",
      value: 100,
      refunds: [{ status: "DONE", value: 100, description: "manual refund" }],
    }));

    let rejected = false;
    try {
      await executeExternalRefund("pay_3", 20, "EON refund operation-3", false);
    } catch (error) {
      rejected = error instanceof AsaasApiError
        && error.code === "asaas_unexpected_full_refund";
    }
    assert(rejected, "unexpected full refund was not sent to reconciliation");

    const full = await executeExternalRefund(
      "pay_3",
      100,
      "EON refund operation-4",
      true,
    );
    assert(full.outcome === "already_refunded", "full refund retry was not treated as complete");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) Deno.env.delete("ASAAS_BASE_URL");
    else Deno.env.set("ASAAS_BASE_URL", originalBase);
    if (originalKey === undefined) Deno.env.delete("ASAAS_API_KEY");
    else Deno.env.set("ASAAS_API_KEY", originalKey);
  }
});
