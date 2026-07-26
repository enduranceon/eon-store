import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { AsaasApiError } from "../_shared/asaas.ts";
import { changeAsaasPaymentDueDate, handleBillingRequest } from "./billing.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function responseBody(
  response: Response,
): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function fakeClient(
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): SupabaseClient {
  return { rpc } as unknown as SupabaseClient;
}

Deno.test("Asaas due-date change sends the provider's billing type and exact value", async () => {
  const originalFetch = globalThis.fetch;
  const originalBase = Deno.env.get("ASAAS_BASE_URL");
  const originalKey = Deno.env.get("ASAAS_API_KEY");
  Deno.env.set("ASAAS_BASE_URL", "https://asaas.test/v3");
  Deno.env.set("ASAAS_API_KEY", "test-key");

  try {
    const requests: Array<{
      url: string;
      method: string;
      body?: Record<string, unknown>;
      contentType?: string | null;
    }> = [];
    globalThis.fetch = (input, init) => {
      const method = init?.method || "GET";
      requests.push({
        url: String(input),
        method,
        body: typeof init?.body === "string"
          ? JSON.parse(init.body) as Record<string, unknown>
          : undefined,
        contentType: new Headers(init?.headers).get("content-type"),
      });
      if (method === "PUT") {
        return Promise.resolve(Response.json({
          id: "pay_1",
          status: "PENDING",
          dueDate: "2026-08-20",
        }));
      }
      return Promise.resolve(Response.json({
        id: "pay_1",
        status: "PENDING",
        dueDate: "2026-08-10",
        billingType: "PIX",
        value: 123.45,
      }));
    };

    const result = await changeAsaasPaymentDueDate(
      "pay_1",
      "2026-08-20",
    );
    assert(result.outcome === "updated", "provider update was not confirmed");
    assert(requests.length === 2, "expected one lookup and one update");
    assert(
      requests[0].url === "https://asaas.test/v3/payments/pay_1",
      "lookup used the wrong endpoint",
    );
    assert(
      requests[1].url === "https://asaas.test/v3/payments/pay_1",
      "update used the wrong endpoint",
    );
    assert(requests[1].method === "PUT", "due date did not use PUT");
    assert(
      requests[1].contentType === "application/json",
      "update did not send JSON",
    );
    assert(requests[1].body?.billingType === "PIX", "billing type changed");
    assert(requests[1].body?.value === 123.45, "payment value changed");
    assert(
      requests[1].body?.dueDate === "2026-08-20",
      "target due date changed",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) Deno.env.delete("ASAAS_BASE_URL");
    else Deno.env.set("ASAAS_BASE_URL", originalBase);
    if (originalKey === undefined) Deno.env.delete("ASAAS_API_KEY");
    else Deno.env.set("ASAAS_API_KEY", originalKey);
  }
});

Deno.test("Asaas due-date retry is idempotent even after the payment becomes terminal", async () => {
  const originalFetch = globalThis.fetch;
  const originalBase = Deno.env.get("ASAAS_BASE_URL");
  const originalKey = Deno.env.get("ASAAS_API_KEY");
  Deno.env.set("ASAAS_BASE_URL", "https://asaas.test/v3");
  Deno.env.set("ASAAS_API_KEY", "test-key");

  try {
    let calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      return Promise.resolve(Response.json({
        id: "pay_2",
        status: "RECEIVED",
        dueDate: "2026-08-20",
        billingType: "PIX",
        value: 100,
      }));
    };

    const result = await changeAsaasPaymentDueDate(
      "pay_2",
      "2026-08-20",
    );
    assert(result.outcome === "already_current", "retry was not idempotent");
    assert(calls === 1, "retry unexpectedly issued a PUT");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) Deno.env.delete("ASAAS_BASE_URL");
    else Deno.env.set("ASAAS_BASE_URL", originalBase);
    if (originalKey === undefined) Deno.env.delete("ASAAS_API_KEY");
    else Deno.env.set("ASAAS_API_KEY", originalKey);
  }
});

Deno.test("Asaas due-date change rejects installments and non-adjustable statuses", async () => {
  const originalFetch = globalThis.fetch;
  const originalBase = Deno.env.get("ASAAS_BASE_URL");
  const originalKey = Deno.env.get("ASAAS_API_KEY");
  Deno.env.set("ASAAS_BASE_URL", "https://asaas.test/v3");
  Deno.env.set("ASAAS_API_KEY", "test-key");

  try {
    globalThis.fetch = () =>
      Promise.resolve(Response.json({
        id: "pay_installment",
        status: "PENDING",
        dueDate: "2026-08-20",
        billingType: "BOLETO",
        value: 50,
        installment: "ins_1",
      }));

    let installmentRejected = false;
    try {
      await changeAsaasPaymentDueDate("pay_installment", "2026-08-20");
    } catch (error) {
      installmentRejected = error instanceof AsaasApiError &&
        error.code === "asaas_installment_due_date_unsupported";
    }
    assert(installmentRejected, "installment was not rejected");

    globalThis.fetch = () =>
      Promise.resolve(Response.json({
        id: "pay_received",
        status: "RECEIVED",
        dueDate: "2026-08-10",
        billingType: "PIX",
        value: 50,
      }));

    let statusRejected = false;
    try {
      await changeAsaasPaymentDueDate("pay_received", "2026-08-20");
    } catch (error) {
      statusRejected = error instanceof AsaasApiError &&
        error.code === "asaas_status_not_adjustable";
    }
    assert(statusRejected, "terminal payment status was not rejected");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) Deno.env.delete("ASAAS_BASE_URL");
    else Deno.env.set("ASAAS_BASE_URL", originalBase);
    if (originalKey === undefined) Deno.env.delete("ASAAS_API_KEY");
    else Deno.env.set("ASAAS_API_KEY", originalKey);
  }
});

Deno.test("Asaas due-date change distinguishes lookup and update network failures", async () => {
  const originalFetch = globalThis.fetch;
  const originalBase = Deno.env.get("ASAAS_BASE_URL");
  const originalKey = Deno.env.get("ASAAS_API_KEY");
  Deno.env.set("ASAAS_BASE_URL", "https://asaas.test/v3");
  Deno.env.set("ASAAS_API_KEY", "test-key");

  try {
    globalThis.fetch = () => Promise.reject(new Error("lookup offline"));
    let lookupCode = "";
    try {
      await changeAsaasPaymentDueDate("pay_lookup", "2026-08-20");
    } catch (error) {
      if (error instanceof AsaasApiError) lookupCode = error.code;
    }
    assert(
      lookupCode === "asaas_lookup_unavailable",
      "lookup failure was classified as a possible PUT",
    );

    let calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(Response.json({
          id: "pay_update",
          status: "PENDING",
          dueDate: "2026-08-10",
          billingType: "PIX",
          value: 80,
        }));
      }
      return Promise.reject(new Error("update timeout"));
    };
    let updateCode = "";
    try {
      await changeAsaasPaymentDueDate("pay_update", "2026-08-20");
    } catch (error) {
      if (error instanceof AsaasApiError) updateCode = error.code;
    }
    assert(
      updateCode === "asaas_due_date_update_unavailable",
      "PUT failure was not marked as ambiguous",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) Deno.env.delete("ASAAS_BASE_URL");
    else Deno.env.set("ASAAS_BASE_URL", originalBase);
    if (originalKey === undefined) Deno.env.delete("ASAAS_API_KEY");
    else Deno.env.set("ASAAS_API_KEY", originalKey);
  }
});

Deno.test("Due-date route rejects invalid payloads before touching the database", async () => {
  let rpcCalls = 0;
  const client = fakeClient(() => {
    rpcCalls += 1;
    return Promise.resolve({ data: null, error: null });
  });

  const invalidDate = await handleBillingRequest(
    new Request(
      "https://example.test/api-v1/orders/presale/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/due-date",
      {
        method: "PATCH",
        headers: { "Idempotency-Key": "test-invalid-date" },
        body: JSON.stringify({ due_date: "2026-02-30" }),
      },
    ),
    "/orders/presale/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/due-date",
    client,
    "5cfe13fe-3150-4f5f-bbc8-f8ca3a25cc93",
  );
  assert(invalidDate?.status === 400, "invalid calendar date was accepted");

  const extraField = await handleBillingRequest(
    new Request(
      "https://example.test/api-v1/orders/presale/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/due-date",
      {
        method: "PATCH",
        headers: { "Idempotency-Key": "test-extra-field" },
        body: JSON.stringify({ due_date: "2026-08-20", force: true }),
      },
    ),
    "/orders/presale/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/due-date",
    client,
    "5cfe13fe-3150-4f5f-bbc8-f8ca3a25cc93",
  );
  assert(extraField?.status === 400, "unknown field was accepted");
  assert(rpcCalls === 0, "invalid payload reached the database");
});

Deno.test("Due-date route completes a local-only change through prepare/complete RPCs", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = fakeClient((name, args) => {
    calls.push({ name, args });
    if (name === "prepare_order_due_date_change") {
      return Promise.resolve({
        data: {
          operation_id: "c2c58cec-d5f2-4ff8-87b3-820b262ddc3f",
          status: "prepared",
          lease_acquired: true,
          lease_token: "fa1b65c4-6157-49c7-926c-c3a71d21cc14",
          asaas_charge_id: null,
        },
        error: null,
      });
    }
    return Promise.resolve({
      data: {
        operation_id: "c2c58cec-d5f2-4ff8-87b3-820b262ddc3f",
        status: "completed",
        due_date: "2026-08-20",
      },
      error: null,
    });
  });

  const response = await handleBillingRequest(
    new Request(
      "https://example.test/api-v1/orders/contract/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/due-date",
      {
        method: "PATCH",
        headers: { "Idempotency-Key": "test-local-change" },
        body: JSON.stringify({ due_date: "2026-08-20" }),
      },
    ),
    "/orders/contract/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/due-date",
    client,
    "5cfe13fe-3150-4f5f-bbc8-f8ca3a25cc93",
  );
  assert(response?.status === 200, "local-only change did not complete");
  assert(calls.length === 2, "prepare/complete pair was not used");
  assert(
    calls[0].args.p_idempotency_key === "test-local-change",
    "idempotency key did not reach prepare",
  );
  assert(
    calls[1].args.p_external_result &&
      (calls[1].args.p_external_result as Record<string, unknown>).outcome ===
        "not_required",
    "local-only completion received an external result",
  );

  const payload = await responseBody(response!);
  const data = payload.data as Record<string, unknown>;
  assert(data.due_date === "2026-08-20", "response lost the saved date");
});

Deno.test("Due-date route completes an Asaas change and forwards the confirmed result", async () => {
  const originalFetch = globalThis.fetch;
  const originalBase = Deno.env.get("ASAAS_BASE_URL");
  const originalKey = Deno.env.get("ASAAS_API_KEY");
  Deno.env.set("ASAAS_BASE_URL", "https://asaas.test/v3");
  Deno.env.set("ASAAS_API_KEY", "test-key");

  try {
    globalThis.fetch = (_input, init) => {
      if (init?.method === "PUT") {
        return Promise.resolve(Response.json({
          id: "pay_route",
          status: "PENDING",
          dueDate: "2026-08-20",
        }));
      }
      return Promise.resolve(Response.json({
        id: "pay_route",
        status: "OVERDUE",
        dueDate: "2026-07-20",
        billingType: "BOLETO",
        value: 80,
      }));
    };

    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = fakeClient((name, args) => {
      calls.push({ name, args });
      if (name === "prepare_order_due_date_change") {
        return Promise.resolve({
          data: {
            operation_id: "2fb9b6d4-074e-4d0c-89de-3e5e85d3df93",
            status: "prepared",
            lease_acquired: true,
            lease_token: "649de296-379d-45f1-9602-d6913e57e6e2",
            asaas_charge_id: "pay_route",
          },
          error: null,
        });
      }
      return Promise.resolve({
        data: {
          operation_id: "2fb9b6d4-074e-4d0c-89de-3e5e85d3df93",
          status: "completed",
          due_date: "2026-08-20",
        },
        error: null,
      });
    });

    const response = await handleBillingRequest(
      new Request(
        "https://example.test/api-v1/orders/presale/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/due-date",
        {
          method: "PATCH",
          headers: { "Idempotency-Key": "test-asaas-change" },
          body: JSON.stringify({ due_date: "2026-08-20" }),
        },
      ),
      "/orders/presale/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/due-date",
      client,
      "5cfe13fe-3150-4f5f-bbc8-f8ca3a25cc93",
    );
    assert(response?.status === 200, "Asaas-backed change did not complete");
    assert(calls.length === 2, "Asaas route did not prepare and complete");
    const external = calls[1].args.p_external_result as Record<string, unknown>;
    assert(external.outcome === "updated", "confirmed outcome was lost");
    assert(external.payment_id === "pay_route", "payment id was lost");
    assert(external.due_date === "2026-08-20", "confirmed due date was lost");
    assert(external.status_after === "PENDING", "provider status was lost");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) Deno.env.delete("ASAAS_BASE_URL");
    else Deno.env.set("ASAAS_BASE_URL", originalBase);
    if (originalKey === undefined) Deno.env.delete("ASAAS_API_KEY");
    else Deno.env.set("ASAAS_API_KEY", originalKey);
  }
});

Deno.test("Due-date route closes deterministic Asaas failures in the ledger", async () => {
  const originalFetch = globalThis.fetch;
  const originalBase = Deno.env.get("ASAAS_BASE_URL");
  const originalKey = Deno.env.get("ASAAS_API_KEY");
  Deno.env.set("ASAAS_BASE_URL", "https://asaas.test/v3");
  Deno.env.set("ASAAS_API_KEY", "test-key");

  try {
    globalThis.fetch = () =>
      Promise.resolve(Response.json({
        id: "pay_installment_route",
        status: "PENDING",
        dueDate: "2026-08-10",
        billingType: "BOLETO",
        value: 80,
        installment: "ins_route",
      }));

    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = fakeClient((name, args) => {
      calls.push({ name, args });
      if (name === "prepare_order_due_date_change") {
        return Promise.resolve({
          data: {
            operation_id: "2fb9b6d4-074e-4d0c-89de-3e5e85d3df93",
            status: "prepared",
            lease_acquired: true,
            lease_token: "649de296-379d-45f1-9602-d6913e57e6e2",
            asaas_charge_id: "pay_installment_route",
          },
          error: null,
        });
      }
      return Promise.resolve({
        data: {
          operation_id: "2fb9b6d4-074e-4d0c-89de-3e5e85d3df93",
          status: "failed",
          error_code: "asaas_installment_due_date_unsupported",
        },
        error: null,
      });
    });

    const response = await handleBillingRequest(
      new Request(
        "https://example.test/api-v1/orders/presale/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/due-date",
        {
          method: "PATCH",
          headers: { "Idempotency-Key": "test-installment-failure" },
          body: JSON.stringify({ due_date: "2026-08-20" }),
        },
      ),
      "/orders/presale/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/due-date",
      client,
      "5cfe13fe-3150-4f5f-bbc8-f8ca3a25cc93",
    );
    assert(response?.status === 409, "deterministic failure changed status");
    assert(calls.length === 2, "deterministic failure was not finalized");
    assert(
      calls[1].name === "finalize_order_due_date_failure",
      "wrong failure RPC was used",
    );
    assert(
      calls[1].args.p_requires_reconciliation === false,
      "deterministic failure was incorrectly sent to reconciliation",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) Deno.env.delete("ASAAS_BASE_URL");
    else Deno.env.set("ASAAS_BASE_URL", originalBase);
    if (originalKey === undefined) Deno.env.delete("ASAAS_API_KEY");
    else Deno.env.set("ASAAS_API_KEY", originalKey);
  }
});

Deno.test("Due-date route persists an unconfirmed provider update for reconciliation", async () => {
  const originalFetch = globalThis.fetch;
  const originalBase = Deno.env.get("ASAAS_BASE_URL");
  const originalKey = Deno.env.get("ASAAS_API_KEY");
  Deno.env.set("ASAAS_BASE_URL", "https://asaas.test/v3");
  Deno.env.set("ASAAS_API_KEY", "test-key");

  try {
    globalThis.fetch = (_input, init) => {
      if (init?.method === "PUT") {
        return Promise.resolve(Response.json({
          id: "pay_unconfirmed",
          status: "PENDING",
          dueDate: "2026-08-19",
        }));
      }
      return Promise.resolve(Response.json({
        id: "pay_unconfirmed",
        status: "PENDING",
        dueDate: "2026-08-10",
        billingType: "PIX",
        value: 80,
      }));
    };

    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = fakeClient((name, args) => {
      calls.push({ name, args });
      if (name === "prepare_order_due_date_change") {
        return Promise.resolve({
          data: {
            operation_id: "2fb9b6d4-074e-4d0c-89de-3e5e85d3df93",
            status: "prepared",
            lease_acquired: true,
            lease_token: "649de296-379d-45f1-9602-d6913e57e6e2",
            asaas_charge_id: "pay_unconfirmed",
          },
          error: null,
        });
      }
      return Promise.resolve({
        data: {
          operation_id: "2fb9b6d4-074e-4d0c-89de-3e5e85d3df93",
          status: "reconciliation_required",
        },
        error: null,
      });
    });

    const response = await handleBillingRequest(
      new Request(
        "https://example.test/api-v1/orders/presale/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/due-date",
        {
          method: "PATCH",
          headers: { "Idempotency-Key": "test-unconfirmed-update" },
          body: JSON.stringify({ due_date: "2026-08-20" }),
        },
      ),
      "/orders/presale/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/due-date",
      client,
      "5cfe13fe-3150-4f5f-bbc8-f8ca3a25cc93",
    );
    assert(
      response?.status === 409,
      "unconfirmed PUT did not require reconciliation",
    );
    assert(calls.length === 2, "unconfirmed PUT was not persisted");
    assert(
      calls[1].args.p_requires_reconciliation === true,
      "ambiguous result was finalized as a deterministic failure",
    );
    const payload = await responseBody(response!);
    assert(
      payload.code === "reconciliation_required",
      "wrong reconciliation code",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) Deno.env.delete("ASAAS_BASE_URL");
    else Deno.env.set("ASAAS_BASE_URL", originalBase);
    if (originalKey === undefined) Deno.env.delete("ASAAS_API_KEY");
    else Deno.env.set("ASAAS_API_KEY", originalKey);
  }
});

Deno.test("Due-date route returns the stored result for an idempotent retry", async () => {
  let rpcCalls = 0;
  const client = fakeClient(() => {
    rpcCalls += 1;
    return Promise.resolve({
      data: {
        operation_id: "2fb9b6d4-074e-4d0c-89de-3e5e85d3df93",
        status: "completed",
        result: {
          operation_id: "2fb9b6d4-074e-4d0c-89de-3e5e85d3df93",
          status: "completed",
          due_date: "2026-08-20",
        },
      },
      error: null,
    });
  });

  const path = "/orders/contract/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/due-date";
  const response = await handleBillingRequest(
    new Request(`https://example.test/api-v1${path}`, {
      method: "PATCH",
      headers: { "Idempotency-Key": "test-completed-retry" },
      body: JSON.stringify({ due_date: "2026-08-20" }),
    }),
    path,
    client,
    "5cfe13fe-3150-4f5f-bbc8-f8ca3a25cc93",
  );
  assert(response?.status === 200, "completed retry did not succeed");
  assert(rpcCalls === 1, "completed retry called complete or Asaas again");
  const payload = await responseBody(response!);
  const data = payload.data as Record<string, unknown>;
  assert(data.due_date === "2026-08-20", "stored result changed on retry");
});

Deno.test("Due-date route requires idempotency and rejects other methods", async () => {
  let rpcCalls = 0;
  const client = fakeClient(() => {
    rpcCalls += 1;
    return Promise.resolve({ data: null, error: null });
  });
  const path = "/orders/presale/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/due-date";

  const missingKey = await handleBillingRequest(
    new Request(`https://example.test/api-v1${path}`, {
      method: "PATCH",
      body: JSON.stringify({ due_date: "2026-08-20" }),
    }),
    path,
    client,
    "5cfe13fe-3150-4f5f-bbc8-f8ca3a25cc93",
  );
  assert(missingKey?.status === 400, "missing idempotency key was accepted");

  const wrongMethod = await handleBillingRequest(
    new Request(`https://example.test/api-v1${path}`, { method: "POST" }),
    path,
    client,
    "5cfe13fe-3150-4f5f-bbc8-f8ca3a25cc93",
  );
  assert(wrongMethod?.status === 405, "wrong method was accepted");
  assert(rpcCalls === 0, "invalid requests touched the database");
});

Deno.test("Due-date route exposes operation contention without a second external call", async () => {
  const client = fakeClient(() =>
    Promise.resolve({
      data: {
        operation_id: "c2c58cec-d5f2-4ff8-87b3-820b262ddc3f",
        status: "prepared",
        lease_acquired: false,
        lease_expires_at: "2026-07-26T22:30:00Z",
        asaas_charge_id: "pay_1",
      },
      error: null,
    })
  );

  const response = await handleBillingRequest(
    new Request(
      "https://example.test/api-v1/orders/presale/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/due-date",
      {
        method: "PATCH",
        headers: { "Idempotency-Key": "test-contention" },
        body: JSON.stringify({ due_date: "2026-08-20" }),
      },
    ),
    "/orders/presale/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/due-date",
    client,
    "5cfe13fe-3150-4f5f-bbc8-f8ca3a25cc93",
  );
  assert(response?.status === 409, "active lease did not block the duplicate");
  const payload = await responseBody(response!);
  assert(payload.code === "operation_in_progress", "wrong contention code");
});
