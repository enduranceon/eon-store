import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import {
  asaasPaymentIdFromLink,
  handleAsaasPaymentCheckRequest,
  MAX_CHECK_ORDERS,
  parseCheckOrders,
} from "./asaas-payment-check.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const CONTRACT_PAID = "11111111-1111-4111-8111-111111111111";
const PRESALE_CARD = "22222222-2222-4222-8222-222222222222";
const STOCK_CLOSED = "33333333-3333-4333-8333-333333333333";
const EVENT_OTHER_LINK = "44444444-4444-4444-8444-444444444444";
const CONTRACT_MISSING_IN_ASAAS = "55555555-5555-4555-8555-555555555555";
const CONTRACT_UNKNOWN = "66666666-6666-4666-8666-666666666666";

const TABLE_ROWS: Record<string, Record<string, unknown>[]> = {
  assessment_contracts: [
    {
      id: CONTRACT_PAID,
      payment_status: "charge_sent",
      external_payment_link: "https://www.asaas.com/i/pixpago0000000001",
      asaas_charge_id: null,
    },
    {
      id: CONTRACT_MISSING_IN_ASAAS,
      payment_status: "overdue",
      external_payment_link: "https://www.asaas.com/i/sumiu00000000001",
      asaas_charge_id: null,
    },
  ],
  presale_orders: [{
    id: PRESALE_CARD,
    payment_status: "charge_sent",
    external_payment_link: " https://www.asaas.com/i/cartao3x00000001/ ",
    asaas_charge_id: null,
  }],
  stock_orders: [{
    id: STOCK_CLOSED,
    payment_status: "paid",
    external_payment_link: "https://www.asaas.com/i/japago0000000001",
    asaas_charge_id: null,
  }],
  event_registrations: [{
    id: EVENT_OTHER_LINK,
    payment_status: "charge_sent",
    external_payment_link: "https://conta.stone.com.br/vendas/123",
    asaas_charge_id: null,
  }],
};

function fakeDatabase() {
  const queries: { table: string; columns: string; ids: string[] }[] = [];
  const client = {
    from(table: string) {
      let columns = "";
      const query = {
        select(selected: string) {
          columns = selected;
          return query;
        },
        in(_field: string, ids: string[]) {
          queries.push({ table, columns, ids });
          const data = (TABLE_ROWS[table] ?? []).filter((row) =>
            ids.includes(String(row.id))
          );
          return Promise.resolve({ data, error: null });
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  return { client, queries };
}

function asaasPayment(overrides: Record<string, unknown> = {}) {
  return {
    object: "payment",
    customer: "cus_cliente_ficticio",
    description: "Cobrança de Cliente Fictício",
    invoiceUrl: "https://www.asaas.com/i/qualquer",
    value: 250,
    netValue: 248.01,
    billingType: "PIX",
    status: "RECEIVED",
    dueDate: "2026-10-05",
    clientPaymentDate: "2026-10-04",
    paymentDate: "2026-10-04",
    confirmedDate: "2026-10-04",
    deleted: false,
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type FetchCall = { url: URL; method: string };

async function withAsaas(
  respond: (url: URL) => Response,
  test: (calls: FetchCall[]) => Promise<void>,
  env: { base?: string | null; key?: string | null } = {},
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalBase = Deno.env.get("ASAAS_BASE_URL");
  const originalKey = Deno.env.get("ASAAS_API_KEY");
  const base = env.base === undefined ? "https://asaas.test/v3" : env.base;
  const key = env.key === undefined ? "test-key" : env.key;
  if (base === null) Deno.env.delete("ASAAS_BASE_URL");
  else Deno.env.set("ASAAS_BASE_URL", base);
  if (key === null) Deno.env.delete("ASAAS_API_KEY");
  else Deno.env.set("ASAAS_API_KEY", key);
  const calls: FetchCall[] = [];
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    return Promise.resolve(respond(url));
  };
  try {
    await test(calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) Deno.env.delete("ASAAS_BASE_URL");
    else Deno.env.set("ASAAS_BASE_URL", originalBase);
    if (originalKey === undefined) Deno.env.delete("ASAAS_API_KEY");
    else Deno.env.set("ASAAS_API_KEY", originalKey);
  }
}

function checkRequest(orders: unknown, method = "POST"): Request {
  return new Request("https://example.test/api-v1/asaas/payment-check", {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify({ orders }),
  });
}

Deno.test("the invoice link gives the Asaas payment id", () => {
  assert(
    asaasPaymentIdFromLink("https://www.asaas.com/i/abc123DEF456ghi7") ===
      "pay_abc123DEF456ghi7",
    "plain invoice link",
  );
  assert(
    asaasPaymentIdFromLink(" https://www.asaas.com/i/abc123DEF456ghi7/ ") ===
      "pay_abc123DEF456ghi7",
    "spaces and trailing slash",
  );
  for (
    const link of [
      "http://www.asaas.com/i/abc123DEF456ghi7",
      "https://sandbox.asaas.com/i/abc123DEF456ghi7",
      "https://www.asaas.com/payment/123",
      "https://www.asaas.com/i/abc123?x=1",
      "https://conta.stone.com.br/vendas/123",
      "",
      null,
    ]
  ) {
    assert(asaasPaymentIdFromLink(link) === null, `rejects ${link}`);
  }
});

Deno.test("the order list is validated and deduplicated", () => {
  const ok = parseCheckOrders({
    orders: [
      { type: "contract", id: CONTRACT_PAID.toUpperCase() },
      { type: "contract", id: CONTRACT_PAID },
      { type: "event", id: EVENT_OTHER_LINK },
    ],
  });
  assert(ok?.length === 2, "duplicates are dropped");
  assert(ok?.[0].id === CONTRACT_PAID, "ids are normalized");

  const tooMany = Array.from({ length: MAX_CHECK_ORDERS + 1 }, () => ({
    type: "contract",
    id: CONTRACT_PAID,
  }));
  for (
    const body of [
      null,
      {},
      { orders: [] },
      { orders: tooMany },
      { orders: [{ type: "plan-change", id: CONTRACT_PAID }] },
      { orders: [{ type: "toString", id: CONTRACT_PAID }] },
      { orders: [{ type: "contract", id: "não-é-uuid" }] },
    ]
  ) {
    assert(parseCheckOrders(body) === null, `rejects ${JSON.stringify(body)}`);
  }
});

Deno.test("other paths and methods are not handled as a check", async () => {
  const { client } = fakeDatabase();
  const other = await handleAsaasPaymentCheckRequest(
    checkRequest([]),
    "/financial/movements",
    client,
  );
  assert(other === null, "other path is ignored");
  const get = await handleAsaasPaymentCheckRequest(
    checkRequest(null, "GET"),
    "/asaas/payment-check",
    client,
  );
  assert(get?.status === 405, "GET is not allowed");
  const invalid = await handleAsaasPaymentCheckRequest(
    checkRequest([{ type: "contract", id: "x" }]),
    "/asaas/payment-check",
    client,
  );
  assert(invalid?.status === 400, "invalid list is refused");
});

Deno.test("without the Asaas key nothing is read", async () => {
  await withAsaas(() => json({}), async (calls) => {
    const { client, queries } = fakeDatabase();
    const response = await handleAsaasPaymentCheckRequest(
      checkRequest([{ type: "contract", id: CONTRACT_PAID }]),
      "/asaas/payment-check",
      client,
    );
    assert(response?.status === 503, "not configured");
    const body = await response.json();
    assert(body.code === "asaas_not_configured", "explains the setup");
    assert(calls.length === 0, "Asaas is not called");
    assert(queries.length === 0, "database is not read");
  }, { key: null });
});

Deno.test("a sandbox key or address is reported instead of 'not found'", async () => {
  for (
    const env of [
      { base: "https://sandbox.asaas.com/api/v3" },
      { base: "https://api-sandbox.asaas.com/v3" },
      { key: "$aact_hmlg_chave_de_teste" },
    ]
  ) {
    await withAsaas(() => json({}), async (calls) => {
      const { client, queries } = fakeDatabase();
      const response = await handleAsaasPaymentCheckRequest(
        checkRequest([{ type: "contract", id: CONTRACT_PAID }]),
        "/asaas/payment-check",
        client,
      );
      assert(response?.status === 503, `sandbox refused: ${JSON.stringify(env)}`);
      const body = await response.json();
      assert(body.code === "asaas_sandbox_configured", "explains the sandbox");
      assert(calls.length === 0, "Asaas is not called");
      assert(queries.length === 0, "database is not read");
    }, env);
  }
});

Deno.test("checks open charges in Asaas with read-only calls", async () => {
  const respond = (url: URL) => {
    if (url.pathname === "/v3/payments/pay_pixpago0000000001") {
      return json(asaasPayment());
    }
    if (url.pathname === "/v3/payments/pay_cartao3x00000001") {
      return json(asaasPayment({
        billingType: "CREDIT_CARD",
        status: "CONFIRMED",
        value: 200,
        installment: "ins_cartao3x",
        installmentNumber: 1,
        paymentDate: null,
      }));
    }
    if (url.pathname === "/v3/installments/ins_cartao3x/payments") {
      return json({
        object: "list",
        hasMore: false,
        data: [3, 1, 2].map((number) =>
          asaasPayment({
            billingType: "CREDIT_CARD",
            status: "CONFIRMED",
            value: 200,
            installmentNumber: number,
            dueDate: `2026-1${number - 1}-04`,
            paymentDate: null,
          })
        ),
      });
    }
    if (url.pathname === "/v3/payments/pay_sumiu00000000001") {
      return json({ errors: [{ description: "Não encontrado" }] }, 404);
    }
    return json({ errors: [{ description: "rota inesperada" }] }, 500);
  };

  await withAsaas(respond, async (calls) => {
    const { client, queries } = fakeDatabase();
    const response = await handleAsaasPaymentCheckRequest(
      checkRequest([
        { type: "contract", id: CONTRACT_PAID },
        { type: "presale", id: PRESALE_CARD },
        { type: "stock", id: STOCK_CLOSED },
        { type: "event", id: EVENT_OTHER_LINK },
        { type: "contract", id: CONTRACT_MISSING_IN_ASAAS },
        { type: "contract", id: CONTRACT_UNKNOWN },
      ]),
      "/asaas/payment-check",
      client,
    );
    assert(response?.status === 200, `status ${response?.status}`);
    const text = await response.text();
    assert(
      !text.includes("cus_cliente_ficticio") && !text.includes("Fictício"),
      "no customer data leaves Asaas",
    );
    const { data } = JSON.parse(text);
    const byId = Object.fromEntries(
      data.results.map((item: { id: string }) => [item.id, item]),
    );

    assert(byId[CONTRACT_PAID].result === "checked", "pix checked");
    assert(byId[CONTRACT_PAID].payment.status === "RECEIVED", "pix status");
    assert(byId[CONTRACT_PAID].payment.billing_type === "PIX", "pix type");
    assert(byId[CONTRACT_PAID].payment.value === 250, "pix value");
    assert(
      byId[CONTRACT_PAID].payment.client_payment_date === "2026-10-04",
      "pix date",
    );
    assert(byId[CONTRACT_PAID].installments === null, "single payment");

    const card = byId[PRESALE_CARD];
    assert(card.result === "checked", "card checked");
    assert(card.installments.length === 3, "all installments");
    assert(
      card.installments.map((item: { installment_number: number }) =>
        item.installment_number
      ).join() === "1,2,3",
      "installments in order",
    );

    assert(byId[STOCK_CLOSED].result === "closed", "already paid here");
    assert(
      byId[EVENT_OTHER_LINK].result === "unsupported_link",
      "other provider link",
    );
    assert(
      byId[CONTRACT_MISSING_IN_ASAAS].result === "asaas_not_found",
      "missing in Asaas",
    );
    assert(byId[CONTRACT_UNKNOWN].result === "not_found", "unknown order");

    assert(calls.every((call) => call.method === "GET"), "only GET requests");
    assert(
      calls.map((call) => call.url.pathname).sort().join() ===
        [
          "/v3/installments/ins_cartao3x/payments",
          "/v3/payments/pay_cartao3x00000001",
          "/v3/payments/pay_pixpago0000000001",
          "/v3/payments/pay_sumiu00000000001",
        ].join(),
      `unexpected calls ${calls.map((call) => call.url.pathname)}`,
    );
    assert(
      queries.every((query) =>
        query.columns ===
          "id, payment_status, external_payment_link, asaas_charge_id"
      ),
      "reads only the charge columns",
    );
  });
});

Deno.test("one failing charge does not hide the others", async () => {
  const respond = (url: URL) =>
    url.pathname === "/v3/payments/pay_pixpago0000000001"
      ? json(asaasPayment())
      : json({ errors: [{ description: "Instabilidade" }] }, 500);
  await withAsaas(respond, async () => {
    const { client } = fakeDatabase();
    const response = await handleAsaasPaymentCheckRequest(
      checkRequest([
        { type: "contract", id: CONTRACT_PAID },
        { type: "contract", id: CONTRACT_MISSING_IN_ASAAS },
      ]),
      "/asaas/payment-check",
      client,
    );
    assert(response?.status === 200, "partial result");
    const { data } = await response.json();
    const failed = data.results.find((item: { id: string }) =>
      item.id === CONTRACT_MISSING_IN_ASAAS
    );
    assert(failed.result === "asaas_error", "failure is per charge");
    assert(failed.message === "Instabilidade", "Asaas message is kept");
  });
});

Deno.test("when every lookup fails the access problem is reported once", async () => {
  const respond = () =>
    json({ errors: [{ description: "A chave de API fornecida é inválida" }] }, 401);
  await withAsaas(respond, async () => {
    const { client } = fakeDatabase();
    const response = await handleAsaasPaymentCheckRequest(
      checkRequest([
        { type: "contract", id: CONTRACT_PAID },
        { type: "presale", id: PRESALE_CARD },
      ]),
      "/asaas/payment-check",
      client,
    );
    assert(response?.status === 502, `status ${response?.status}`);
    const body = await response.json();
    assert(body.code === "asaas_check_failed", "single access error");
    assert(
      String(body.error).includes("chave de API fornecida é inválida"),
      "keeps the Asaas reason",
    );
  });
});
