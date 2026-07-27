import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { handleChargeLifecycleRequest } from "./charge-lifecycle.ts";

const ORDER_ID = "0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd";
const ACTOR_ID = "5cfe13fe-3150-4f5f-bbc8-f8ca3a25cc93";
const OPERATION_ID = "f1bd863e-c244-4bdd-a69c-1321d5b94b54";
const LEASE_TOKEN = "b0338110-1074-43e0-9b02-f0bb3439ee32";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function withAsaas(test: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalBase = Deno.env.get("ASAAS_BASE_URL");
  const originalKey = Deno.env.get("ASAAS_API_KEY");
  Deno.env.set("ASAAS_BASE_URL", "https://asaas.test/v3");
  Deno.env.set("ASAAS_API_KEY", "test-key");
  try {
    await test();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) Deno.env.delete("ASAAS_BASE_URL");
    else Deno.env.set("ASAAS_BASE_URL", originalBase);
    if (originalKey === undefined) Deno.env.delete("ASAAS_API_KEY");
    else Deno.env.set("ASAAS_API_KEY", originalKey);
  }
}

function statusClient() {
  const updates: Array<Record<string, unknown>> = [];
  const upserts: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      if (table === "presale_orders") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: () =>
                    Promise.resolve({
                      data: {
                        id: ORDER_ID,
                        payment_status: "charge_sent",
                        asaas_charge_id: "pay_1",
                      },
                      error: null,
                    }),
                };
              },
            };
          },
          update(values: Record<string, unknown>) {
            updates.push(values);
            const chain = {
              eq() {
                return chain;
              },
              select() {
                return chain;
              },
              maybeSingle: () =>
                Promise.resolve({ data: { id: ORDER_ID }, error: null }),
            };
            return chain;
          },
        };
      }
      if (table === "asaas_payments") {
        return {
          upsert(values: Record<string, unknown>) {
            upserts.push(values);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return { client, updates, upserts };
}

function cancellationClient(
  preparedOverrides: Record<string, unknown> = {},
  cacheRows: Array<Record<string, unknown>> = [{
    asaas_payment_id: "pay_1",
    installment_group_id: null,
    raw: { id: "pay_1", status: "PENDING" },
  }],
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "prepare_order_charge_cancellation") {
        return Promise.resolve({
          data: {
            operation_id: OPERATION_ID,
            status: "prepared",
            asaas_charge_id: "pay_1",
            had_external_link: false,
            lease_acquired: true,
            lease_token: LEASE_TOKEN,
            ...preparedOverrides,
          },
          error: null,
        });
      }
      if (name === "complete_order_charge_cancellation") {
        return Promise.resolve({
          data: {
            operation_id: OPERATION_ID,
            status: "completed",
            payment_status: "awaiting_charge",
          },
          error: null,
        });
      }
      return Promise.resolve({ data: { status: "prepared" }, error: null });
    },
    from(table: string) {
      assert(table === "asaas_payments", `unexpected table ${table}`);
      const chain = {
        select() {
          return chain;
        },
        eq() {
          return chain;
        },
        then(resolve: (value: unknown) => void) {
          resolve({ data: cacheRows, error: null });
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

function cancelRequest(path: string, bodyValue: Record<string, unknown> = {
  reason: "Cobrança será refeita",
}): Request {
  return new Request(`https://example.test/api-v1${path}`, {
    method: "POST",
    headers: { "Idempotency-Key": "cancel-charge-test" },
    body: JSON.stringify(bodyValue),
  });
}

Deno.test("Charge status sync confirms payment through api-v1 and refreshes cache", async () => {
  await withAsaas(async () => {
    globalThis.fetch = () =>
      Promise.resolve(Response.json({
        id: "pay_1",
        customer: "cus_1",
        status: "CONFIRMED",
        billingType: "PIX",
        value: 100,
        netValue: 98,
        dueDate: "2026-08-20",
        paymentDate: "2026-08-19",
        externalReference: "EONCHG-test",
      }));
    const { client, updates, upserts } = statusClient();
    const path = `/orders/presale/${ORDER_ID}/charge/status`;
    const response = await handleChargeLifecycleRequest(
      new Request(`https://example.test/api-v1${path}`, { method: "POST" }),
      path,
      client,
      ACTOR_ID,
    );
    assert(response?.status === 200, "status sync failed");
    const payload = await body(response!);
    const data = payload.data as Record<string, unknown>;
    assert(data.is_paid === true, "paid status was not mapped");
    assert(
      data.payment_status_updated === true,
      "local payment was not updated",
    );
    assert(updates[0].payment_status === "paid", "canonical status changed");
    assert(updates[0].payment_date === "2026-08-19", "payment date was lost");
    assert(
      upserts[0].asaas_payment_id === "pay_1",
      "provider cache was not refreshed",
    );
  });
});

Deno.test("Standalone charge cancellation snapshots provider before DELETE and completes", async () => {
  await withAsaas(async () => {
    const requests: string[] = [];
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(`${init?.method || "GET"} ${url.pathname}`);
      return Promise.resolve(Response.json({
        id: "pay_1",
        status: "PENDING",
      }));
    };
    const { client, calls } = cancellationClient();
    const path = `/orders/presale/${ORDER_ID}/charge/cancel`;
    const response = await handleChargeLifecycleRequest(
      cancelRequest(path),
      path,
      client,
      ACTOR_ID,
    );
    assert(response?.status === 200, "cancellation failed");
    assert(
      requests.join(",") === "GET /v3/payments/pay_1,DELETE /v3/payments/pay_1",
      "provider sequence changed",
    );
    assert(
      calls.map((call) => call.name).join(",") ===
        "prepare_order_charge_cancellation,record_order_charge_cancellation_snapshot,complete_order_charge_cancellation",
      "safe cancellation RPC sequence changed",
    );
    const snapshot = calls[1].args.p_external_result as Record<string, unknown>;
    assert(
      snapshot.kind === "standalone",
      "standalone shape was not persisted",
    );
    assert(
      snapshot.outcome === "cancellation_snapshot",
      "snapshot marker changed",
    );
    const completed = calls[2].args.p_external_result as Record<
      string,
      unknown
    >;
    assert(
      completed.outcome === "deleted",
      "provider result was not completed",
    );
  });
});

Deno.test("Installment cancellation uses cached group and deletes the complete page", async () => {
  await withAsaas(async () => {
    const requests: string[] = [];
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(`${init?.method || "GET"} ${url.pathname}`);
      if (url.pathname === "/v3/payments/pay_1") {
        return Promise.resolve(Response.json({
          id: "pay_1",
          status: "PENDING",
          installment: "ins_1",
        }));
      }
      if (url.pathname === "/v3/installments/ins_1/payments" && !init?.method) {
        return Promise.resolve(Response.json({
          data: [
            { id: "pay_1", status: "PENDING", installment: "ins_1" },
            { id: "pay_2", status: "PENDING", installment: "ins_1" },
          ],
        }));
      }
      return Promise.resolve(Response.json({ ok: true }));
    };
    const { client, calls } = cancellationClient({}, [{
      asaas_payment_id: "pay_1",
      installment_group_id: "ins_1",
      raw: { id: "pay_1", status: "PENDING", installment: "ins_1" },
    }]);
    const path = `/orders/contract/${ORDER_ID}/charge/cancel`;
    const response = await handleChargeLifecycleRequest(
      cancelRequest(path),
      path,
      client,
      ACTOR_ID,
    );
    assert(response?.status === 200, "installment cancellation failed");
    assert(
      requests.includes("DELETE /v3/installments/ins_1/payments"),
      "installment group was not deleted",
    );
    const snapshot = calls[1].args.p_external_result as Record<string, unknown>;
    assert(
      snapshot.kind === "installment",
      "installment shape was not persisted",
    );
    assert(snapshot.installment_id === "ins_1", "installment id changed");
  });
});

Deno.test("External payment link is detached locally without calling Asaas", async () => {
  await withAsaas(async () => {
    let providerCalls = 0;
    globalThis.fetch = () => {
      providerCalls += 1;
      return Promise.resolve(Response.json({}));
    };
    const { client, calls } = cancellationClient({
      asaas_charge_id: null,
      had_external_link: true,
    }, []);
    const path = `/orders/contract/${ORDER_ID}/charge/cancel`;
    const response = await handleChargeLifecycleRequest(
      cancelRequest(path),
      path,
      client,
      ACTOR_ID,
    );
    assert(response?.status === 200, "external link detach failed");
    assert(providerCalls === 0, "external link triggered an Asaas request");
    const result = calls[1].args.p_external_result as Record<string, unknown>;
    assert(
      result.provider === "external_link",
      "external link provider changed",
    );
    assert(result.outcome === "detached", "external link was not detached");
  });
});

Deno.test("Paid Asaas charge is never cancelled and failure is persisted", async () => {
  await withAsaas(async () => {
    let deletes = 0;
    globalThis.fetch = (_input, init) => {
      if (init?.method === "DELETE") deletes += 1;
      return Promise.resolve(
        Response.json({ id: "pay_1", status: "CONFIRMED" }),
      );
    };
    const { client, calls } = cancellationClient();
    const path = `/orders/presale/${ORDER_ID}/charge/cancel`;
    const response = await handleChargeLifecycleRequest(
      cancelRequest(path),
      path,
      client,
      ACTOR_ID,
    );
    assert(response?.status === 409, "paid charge was accepted");
    assert(deletes === 0, "paid charge reached provider DELETE");
    const finalized = calls.at(-1)!;
    assert(
      finalized.name === "finalize_order_charge_cancellation_failure",
      "provider refusal was not recorded",
    );
    assert(
      finalized.args.p_requires_reconciliation === false,
      "deterministic refusal was marked ambiguous",
    );
  });
});

Deno.test("Ambiguous provider DELETE is blocked for reconciliation", async () => {
  await withAsaas(async () => {
    globalThis.fetch = (_input, init) => {
      if (init?.method === "DELETE") {
        return Promise.reject(new Error("timeout"));
      }
      return Promise.resolve(Response.json({ id: "pay_1", status: "PENDING" }));
    };
    const { client, calls } = cancellationClient();
    const path = `/orders/presale/${ORDER_ID}/charge/cancel`;
    const response = await handleChargeLifecycleRequest(
      cancelRequest(path),
      path,
      client,
      ACTOR_ID,
    );
    assert(
      response?.status === 502,
      "ambiguous provider failure changed status",
    );
    const finalized = calls.at(-1)!;
    assert(
      finalized.name === "finalize_order_charge_cancellation_failure",
      "ambiguous failure was not persisted",
    );
    assert(
      finalized.args.p_requires_reconciliation === true,
      "ambiguous DELETE was not marked for reconciliation",
    );
  });
});

Deno.test("Charge lifecycle rejects invalid methods, payloads, and idempotency keys", async () => {
  let rpcCalls = 0;
  const client = {
    rpc() {
      rpcCalls += 1;
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;
  const statusPath = `/orders/presale/${ORDER_ID}/charge/status`;
  const wrongMethod = await handleChargeLifecycleRequest(
    new Request(`https://example.test/api-v1${statusPath}`),
    statusPath,
    client,
    ACTOR_ID,
  );
  assert(wrongMethod?.status === 405, "GET status route was accepted");

  const cancelPath = `/orders/presale/${ORDER_ID}/charge/cancel`;
  const invalidKey = await handleChargeLifecycleRequest(
    new Request(`https://example.test/api-v1${cancelPath}`, {
      method: "POST",
      headers: { "Idempotency-Key": "short" },
      body: JSON.stringify({ reason: "Teste" }),
    }),
    cancelPath,
    client,
    ACTOR_ID,
  );
  assert(invalidKey?.status === 400, "short idempotency key was accepted");

  const extraField = await handleChargeLifecycleRequest(
    cancelRequest(cancelPath, { reason: "Teste", order_id: "spoofed" }),
    cancelPath,
    client,
    ACTOR_ID,
  );
  assert(extraField?.status === 400, "unknown cancellation field was accepted");
  assert(rpcCalls === 0, "invalid requests reached the database");
});
