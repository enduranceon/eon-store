import { deepStrictEqual, strictEqual } from "node:assert";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { handleContractBillingRequest } from "./contract-billing.ts";
import { handleEventBillingRequest } from "./event-billing.ts";
import { handleOrderExternalBillingRequest } from "./order-external-billing.ts";
import { handlePaymentsRequest } from "./payments.ts";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const METHOD_ID = "33333333-3333-4333-8333-333333333333";
const UPDATED_AT = "2026-09-12T12:00:00.000Z";
const ORDER_TYPES = ["contract", "presale", "stock", "event"] as const;
type OrderType = typeof ORDER_TYPES[number];
type DatabaseError = { code: string; message: string };

// These tests exercise HTTP handlers and their database boundary. The RPCs are
// mocked; transaction behavior still needs a separate disposable-database test.
function database(options: {
  missingMethod?: boolean;
  methodError?: DatabaseError;
  rpcError?: DatabaseError;
} = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const methodFilters: Array<[string, unknown]> = [];
  const fake = {
    from(table: string) {
      strictEqual(table, "payment_methods", "unexpected direct table access");
      return {
        select() {
          return this;
        },
        eq(column: string, value: unknown) {
          methodFilters.push([column, value]);
          return this;
        },
        maybeSingle() {
          return Promise.resolve({
            data: options.missingMethod ? null : {
              id: METHOD_ID,
              installments: 3,
              credit_days_first: 1,
              credit_days_between: 30,
            },
            error: options.methodError ?? null,
          });
        },
      };
    },
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({
        data: options.rpcError ? null : { id: ORDER_ID },
        error: options.rpcError ?? null,
      });
    },
  } as unknown as SupabaseClient;
  return { fake, calls, methodFilters };
}

async function withoutProviderCalls(run: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = () => {
    attempts += 1;
    throw new Error(
      "External/manual payments must not call Asaas or the network",
    );
  };
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    // Also catch provider calls whose failures were swallowed by a handler.
    strictEqual(
      attempts,
      0,
      "an external/manual flow attempted a network call",
    );
  }
}

function request(path: string, method: string, body: Record<string, unknown>) {
  return new Request(`https://example.test/api-v1${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function billingHandler(type: OrderType) {
  return type === "contract"
    ? handleContractBillingRequest
    : type === "event"
    ? handleEventBillingRequest
    : handleOrderExternalBillingRequest;
}

function orderArguments(type: OrderType): Record<string, unknown> {
  return type === "contract"
    ? { p_contract_id: ORDER_ID }
    : type === "event"
    ? { p_order_id: ORDER_ID }
    : { p_order_type: type, p_order_id: ORDER_ID };
}

function externalBody(type: OrderType) {
  return {
    external_link: "https://payments.example.test/invoice/external-123",
    // An externally agreed due date must not be shifted past a holiday.
    due_date: "2027-01-01",
    payment_method: "card_3x",
    invoice_number: "EXTERNAL-123",
    ...(type === "contract" ? { source: "contract_detail" } : {}),
    expected_updated_at: UPDATED_AT,
  };
}

Deno.test("external charge preserves billing details without contacting a provider", async (t) => {
  for (const type of ORDER_TYPES) {
    await t.step(type, () =>
      withoutProviderCalls(async () => {
        const { fake, calls } = database();
        const path = `/orders/${type}/${ORDER_ID}/external-charge`;
        const response = await billingHandler(type)(
          request(path, "PUT", externalBody(type)),
          path,
          fake,
          ACTOR_ID,
        );
        strictEqual(response?.status, 200);
        deepStrictEqual(calls, [{
          name: type === "contract"
            ? "save_assessment_contract_external_charge"
            : type === "event"
            ? "save_event_external_charge"
            : "save_order_external_charge",
          args: {
            ...orderArguments(type),
            p_external_link:
              "https://payments.example.test/invoice/external-123",
            p_due_date: "2027-01-01",
            p_payment_method: "card_3x",
            p_invoice_number: "EXTERNAL-123",
            ...(type === "contract" ? { p_source: "contract_detail" } : {}),
            p_expected_updated_at: UPDATED_AT,
            p_actor_id: ACTOR_ID,
          },
        }], "save must preserve all details and use one atomic operation");
      }));
  }
});

Deno.test("removing an external link requests only link removal, never sale cancellation", async (t) => {
  for (const type of ORDER_TYPES) {
    await t.step(type, () =>
      withoutProviderCalls(async () => {
        const { fake, calls } = database();
        const path = `/orders/${type}/${ORDER_ID}/external-charge`;
        const handler = billingHandler(type);
        const response = await handler(
          request(path, "DELETE", { expected_updated_at: UPDATED_AT }),
          path,
          fake,
          ACTOR_ID,
        );
        strictEqual(response?.status, 200);
        deepStrictEqual(calls, [{
          name: type === "contract"
            ? "remove_assessment_contract_external_charge"
            : type === "event"
            ? "remove_event_external_charge"
            : "remove_order_external_charge",
          args: {
            ...orderArguments(type),
            p_expected_updated_at: UPDATED_AT,
            p_actor_id: ACTOR_ID,
          },
        }], "removal must not reopen payment, cancel a sale or end a contract");

        const invalidResponse = await handler(
          request(path, "DELETE", {
            expected_updated_at: UPDATED_AT,
            status: "cancelled",
            cancelled_at: "2026-09-12",
          }),
          path,
          fake,
          ACTOR_ID,
        );
        strictEqual(invalidResponse?.status, 400);
        strictEqual(
          calls.length,
          1,
          "cancellation fields reached the database",
        );
      }));
  }
});

Deno.test("external billing surfaces conflicts and failed writes instead of claiming success", async (t) => {
  for (const type of ORDER_TYPES) {
    for (const method of ["PUT", "DELETE"]) {
      await t.step(`${type} ${method}`, () =>
        withoutProviderCalls(async () => {
          for (
            const failure of [
              {
                code: "P0001",
                message: "Registro alterado por outra ação",
                status: 409,
                responseCode: "invalid_transition",
              },
              {
                code: "XX000",
                message: "PRIVATE_DATABASE_DETAIL",
                status: 500,
                responseCode: "database_error",
              },
            ]
          ) {
            const { fake, calls } = database({ rpcError: failure });
            const path = `/orders/${type}/${ORDER_ID}/external-charge`;
            const response = await billingHandler(type)(
              request(
                path,
                method,
                method === "PUT"
                  ? externalBody(type)
                  : { expected_updated_at: UPDATED_AT },
              ),
              path,
              fake,
              ACTOR_ID,
            );
            strictEqual(response?.status, failure.status);
            const body = await response!.json();
            strictEqual(body.code, failure.responseCode);
            strictEqual(
              body.data,
              undefined,
              "failed writes must not return success data",
            );
            if (failure.status === 500) {
              strictEqual(
                JSON.stringify(body).includes(failure.message),
                false,
              );
            }
            strictEqual(
              calls.length,
              1,
              "failed external write must not trigger a fallback mutation",
            );
          }
        }));
    }
  }
});

// Explicit overrides represent what happened outside EON, including weekends,
// holidays and settlement dates different from the installment due dates.
const EDITED_INSTALLMENTS = [
  {
    number: 1,
    due_date: "2026-07-25",
    credit_date: "2026-07-26",
    value: 168.01,
  },
  { number: 2, due_date: "2026-08-24", credit_date: "2026-08-27", value: 166 },
  { number: 3, due_date: "2027-01-01", credit_date: "2027-01-04", value: 166 },
];

function manualBody() {
  return {
    payment_method_id: METHOD_ID,
    payment_date: "2026-07-24",
    total: 500.01,
    installments: structuredClone(EDITED_INSTALLMENTS),
  };
}

Deno.test("manual payment preserves every edited installment for all sale types without Asaas", async (t) => {
  for (const type of ORDER_TYPES) {
    await t.step(type, () =>
      withoutProviderCalls(async () => {
        const { fake, calls, methodFilters } = database();
        const path = `/orders/${type}/${ORDER_ID}/manual-payment`;
        const response = await handlePaymentsRequest(
          request(path, "POST", manualBody()),
          path,
          fake,
          ACTOR_ID,
        );
        strictEqual(response?.status, 200);
        deepStrictEqual(methodFilters, [["id", METHOD_ID], ["active", true]]);
        deepStrictEqual(calls, [{
          name: type === "event"
            ? "api_record_event_manual_payment"
            : "api_record_manual_payment",
          args: {
            ...(type === "event" ? {} : { p_order_type: type }),
            p_order_id: ORDER_ID,
            p_payment_method_id: METHOD_ID,
            p_payment_date: "2026-07-24",
            p_total: 500.01,
            p_installments: EDITED_INSTALLMENTS.map((item) => ({
              ...item,
              total: 3,
            })),
            p_actor_id: ACTOR_ID,
          },
        }], "external settlement dates and amounts must not be regenerated");
      }));
  }
});

Deno.test("invalid edited installments do not fall back to a different payment schedule", async (t) => {
  const cases = [
    {
      name: "missing installment",
      edit: (body: ReturnType<typeof manualBody>) => {
        body.installments.pop();
      },
    },
    {
      name: "duplicate installment number",
      edit: (body: ReturnType<typeof manualBody>) => {
        body.installments[1].number = 1;
      },
    },
    {
      name: "impossible settlement date",
      edit: (body: ReturnType<typeof manualBody>) => {
        body.installments[1].credit_date = "2026-02-30";
      },
    },
    {
      name: "zero installment",
      edit: (body: ReturnType<typeof manualBody>) => {
        body.installments[1].value = 0;
        body.installments[2].value = 332;
      },
    },
  ];
  for (const testCase of cases) {
    await t.step(testCase.name, () =>
      withoutProviderCalls(async () => {
        const { fake, calls } = database();
        const body = manualBody();
        testCase.edit(body);
        const path = `/orders/contract/${ORDER_ID}/manual-payment`;
        const response = await handlePaymentsRequest(
          request(path, "POST", body),
          path,
          fake,
          ACTOR_ID,
        );
        strictEqual(response?.status, 400);
        strictEqual((await response!.json()).code, "invalid_request");
        deepStrictEqual(
          calls,
          [],
          "invalid edited values must never be written",
        );
      }));
  }
});

Deno.test("manual payment stops when the payment method cannot be loaded", async (t) => {
  for (
    const testCase of [
      {
        name: "inactive or missing method",
        options: { missingMethod: true },
        status: 400,
        code: "invalid_payment_method",
      },
      {
        name: "database unavailable",
        options: {
          methodError: { code: "08006", message: "PRIVATE_CONNECTION_DETAIL" },
        },
        status: 500,
        code: "database_error",
      },
    ]
  ) {
    await t.step(testCase.name, () =>
      withoutProviderCalls(async () => {
        const { fake, calls } = database(testCase.options);
        const path = `/orders/stock/${ORDER_ID}/manual-payment`;
        const response = await handlePaymentsRequest(
          request(path, "POST", manualBody()),
          path,
          fake,
          ACTOR_ID,
        );
        strictEqual(response?.status, testCase.status);
        const body = await response!.json();
        strictEqual(body.code, testCase.code);
        strictEqual(
          JSON.stringify(body).includes("PRIVATE_CONNECTION_DETAIL"),
          false,
        );
        deepStrictEqual(
          calls,
          [],
          "method lookup failure must not register payment",
        );
      }));
  }
});

Deno.test("manual payment reports duplicate registration as conflict without retrying or charging", async (t) => {
  for (const type of ORDER_TYPES) {
    await t.step(type, () =>
      withoutProviderCalls(async () => {
        const { fake, calls } = database({
          rpcError: { code: "P0001", message: "Pagamento já registrado" },
        });
        const path = `/orders/${type}/${ORDER_ID}/manual-payment`;
        const response = await handlePaymentsRequest(
          request(path, "POST", manualBody()),
          path,
          fake,
          ACTOR_ID,
        );
        strictEqual(response?.status, 409);
        const body = await response!.json();
        strictEqual(body.code, "invalid_transition");
        strictEqual(body.data, undefined);
        strictEqual(
          calls.length,
          1,
          "duplicate registration triggered another write",
        );
      }));
  }
});
