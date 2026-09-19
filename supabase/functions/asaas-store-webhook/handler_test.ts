import { handleStoreWebhook, type WebhookDependencies } from "./handler.ts";
import {
  checkAsaasChargeRollout,
  storePilotOrderIds,
} from "../_shared/asaas-rollout.ts";

const ORDER = "10000000-0000-4000-a000-000000000001";
const TOKEN = "test-only-webhook-token-32-characters";
const EVENT = {
  id: "evt_test&1",
  event: "PAYMENT_RECEIVED",
  payment: { id: "pay_test" },
};
function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function request(body: unknown = EVENT, token = TOKEN, method = "POST") {
  return new Request("https://example.test/webhook", {
    method,
    headers: { "asaas-access-token": token },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}
function deps(
  overrides: Partial<WebhookDependencies> = {},
): WebhookDependencies {
  return {
    token: TOKEN,
    orderIds: ORDER,
    process: () =>
      Promise.resolve({ data: { status: "processed" }, error: null }),
    ...overrides,
  };
}

for (
  const [label, options] of [
    ["no token", { token: undefined }],
    ["short token", { token: "short" }],
    ["no orders", { orderIds: undefined }],
    ["invalid orders", { orderIds: `${ORDER},invalid` }],
  ] as const
) {
  Deno.test(`webhook fails closed with ${label}`, async () => {
    const response = await handleStoreWebhook(
      request(),
      deps({
        ...options,
        process: () => {
          throw new Error("must not access database");
        },
      }),
    );
    assert(response.status === 503);
  });
}
Deno.test("webhook rejects wrong token before accessing database", async () => {
  let calls = 0;
  const response = await handleStoreWebhook(
    request(EVENT, "wrong"),
    deps({
      process: () => {
        calls++;
        throw new Error("unexpected");
      },
    }),
  );
  assert(response.status === 401 && calls === 0);
});
Deno.test("webhook rejects GET", async () => {
  assert(
    (await handleStoreWebhook(request(null, TOKEN, "GET"), deps())).status ===
      405,
  );
});
for (
  const body of [null, [], {}, { event: "PAYMENT_RECEIVED" }, {
    ...EVENT,
    id: " ",
  }]
) {
  Deno.test(`webhook rejects malformed envelope ${JSON.stringify(body)}`, async () => {
    assert((await handleStoreWebhook(request(body), deps())).status === 400);
  });
}
Deno.test("webhook rejects invalid JSON", async () => {
  const req = new Request("https://example.test", {
    method: "POST",
    headers: { "asaas-access-token": TOKEN },
    body: "{",
  });
  assert((await handleStoreWebhook(req, deps())).status === 400);
});

Deno.test("payment event must identify its payment", async () => {
  for (const payment of [undefined, null, [], {}, { id: "" }]) {
    assert(
      (await handleStoreWebhook(request({ ...EVENT, payment }), deps()))
        .status === 400,
    );
  }
});
Deno.test("webhook limits streamed payload size without trusting Content-Length", async () => {
  assert(
    (await handleStoreWebhook(
      request({ ...EVENT, padding: "x".repeat(262145) }),
      deps(),
    )).status === 413,
  );
});
for (const status of ["processed", "ignored", "reconciliation_required"]) {
  Deno.test(`webhook acknowledges committed ${status} result`, async () => {
    let calls = 0;
    const response = await handleStoreWebhook(
      request(),
      deps({
        process: (event, ids) => {
          assert(event.id === EVENT.id && ids.length === 1 && ids[0] === ORDER);
          calls++;
          return Promise.resolve({ data: { status }, error: null });
        },
      }),
    );
    assert(response.status === 200 && calls === 1);
  });
}
for (const status of ["pending", "unexpected", undefined]) {
  Deno.test(`webhook does not acknowledge ${status} result`, async () => {
    assert(
      (await handleStoreWebhook(
        request(),
        deps({
          process: () => Promise.resolve({ data: { status }, error: null }),
        }),
      )).status === 503,
    );
  });
}
Deno.test("webhook does not acknowledge database error or expose its content", async () => {
  const response = await handleStoreWebhook(
    request(),
    deps({
      process: () =>
        Promise.resolve({ data: null, error: { message: "private data" } }),
    }),
  );
  assert(
    response.status === 503 &&
      !(await response.text()).includes("private data"),
  );
});
Deno.test("webhook does not acknowledge thrown database failure", async () => {
  assert(
    (await handleStoreWebhook(
      request(),
      deps({
        process: () => {
          throw new Error("database unavailable");
        },
      }),
    )).status === 503,
  );
});
Deno.test("allowlist normalizes, deduplicates and fails closed", () => {
  assert(storePilotOrderIds(` ${ORDER},${ORDER} `).length === 1);
  for (const value of [undefined, "", "*", `${ORDER},`, "invalid"]) {
    assert(storePilotOrderIds(value).length === 0);
  }
});
function chargeRequest(billing_type = "PIX", installments = 1) {
  return new Request("https://example.test", {
    method: "POST",
    body: JSON.stringify({ billing_type, installments }),
  });
}
Deno.test("charge creation remains disabled when only API key is configured", async () => {
  assert(
    (await checkAsaasChargeRollout(
      chargeRequest(),
      `/orders/stock/${ORDER}/charge`,
      "",
    ))?.status === 403,
  );
});
Deno.test("only allowlisted store Pix is allowed and request body remains readable", async () => {
  const req = chargeRequest();
  assert(
    await checkAsaasChargeRollout(
      req,
      `/orders/stock/${ORDER}/charge`,
      ORDER,
      "true",
    ) === null,
  );
  assert((await req.json()).billing_type === "PIX");
});
for (const type of ["presale", "contract", "event"]) {
  Deno.test(`pilot blocks ${type} charge creation`, async () => {
    assert(
      (await checkAsaasChargeRollout(
        chargeRequest(),
        `/orders/${type}/${ORDER}/charge`,
        ORDER,
        "true",
      ))?.status === 403,
    );
  });
}
Deno.test("pilot blocks non-allowlisted orders", async () => {
  assert(
    (await checkAsaasChargeRollout(
      chargeRequest(),
      `/orders/stock/10000000-0000-4000-a000-000000000002/charge`,
      ORDER,
      "true",
    ))?.status === 403,
  );
});
for (const method of ["BOLETO", "UNDEFINED"]) {
  Deno.test(`pilot keeps ${method} disabled`, async () => {
    assert(
      (await checkAsaasChargeRollout(
        chargeRequest(method),
        `/orders/stock/${ORDER}/charge`,
        ORDER,
        "true",
      ))?.status === 403,
    );
  });
}
for (const installments of [1, 2, 3, 12]) {
  Deno.test(`pilot allows credit card ${installments}x only on the selected order`, async () => {
    assert(
      await checkAsaasChargeRollout(
        chargeRequest("CREDIT_CARD", installments),
        `/orders/stock/${ORDER}/charge`,
        ORDER,
        "true",
      ) === null,
    );
  });
}
for (const installments of [0, -1, 1.5, 13, NaN]) {
  Deno.test(`pilot rejects invalid card installments ${installments}`, async () => {
    const response = await checkAsaasChargeRollout(
      chargeRequest("CREDIT_CARD", installments),
      `/orders/stock/${ORDER}/charge`,
      ORDER,
      "true",
    );
    assert(response?.status === 403);
  });
}
Deno.test("pilot does not intercept manual or external billing", async () => {
  for (
    const action of [
      "manual-payment",
      "external-charge",
      "charge/status",
      "charge/cancel",
    ]
  ) {
    assert(
      await checkAsaasChargeRollout(
        chargeRequest(),
        `/orders/stock/${ORDER}/${action}`,
        "",
      ) === null,
    );
  }
});

Deno.test("emergency stop blocks creation without disabling receipt processing", async () => {
  for (const enabled of ["", "false", "TRUE"]) {
    assert(
      (await checkAsaasChargeRollout(
        chargeRequest(),
        `/orders/stock/${ORDER}/charge`,
        ORDER,
        enabled,
      ))?.status === 403,
    );
  }
  assert((await handleStoreWebhook(request(), deps())).status === 200);
});
