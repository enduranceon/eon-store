import { handleAsaasWebhook } from "./index.ts";

const WEBHOOK_TOKEN = "test-webhook-token";
const STOCK_ORDER_ID = "6deeeaf6-5cdf-4e96-9b8a-ce8a0c3c4dfa";
const CONTRACT_ID = "9d13d068-85e9-40f7-9f8d-91a08ac0c543";

type Call = {
  kind: string;
  table?: string;
  name?: string;
  args?: Record<string, unknown>;
  values?: Record<string, unknown>;
  row?: Record<string, unknown>;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function webhookRequest(
  event: string,
  payment: Record<string, unknown>,
): Request {
  return new Request("https://example.test/functions/v1/asaas-webhook", {
    method: "POST",
    headers: {
      "asaas-access-token": WEBHOOK_TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify({ event, payment }),
  });
}

function terminalWebhookClient(options: {
  reconciliation?: Record<string, unknown> | null;
  reconciliationError?: { message: string } | null;
  contract?: Record<string, unknown> | null;
}) {
  const calls: Call[] = [];
  const productTableAccesses: string[] = [];

  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ kind: "rpc", name, args });
      return Promise.resolve({
        data: options.reconciliation ?? null,
        error: options.reconciliationError ?? null,
      });
    },
    from(table: string) {
      calls.push({ kind: "from", table });

      if (table === "stock_orders" || table === "presale_orders") {
        productTableAccesses.push(table);
        throw new Error(`terminal webhook must not access ${table} directly`);
      }

      if (table === "asaas_payments") {
        return {
          upsert(row: Record<string, unknown>) {
            calls.push({ kind: "upsert", table, row });
            return Promise.resolve({ error: null });
          },
        };
      }

      if (table === "assessment_contracts") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: () => Promise.resolve({
                    data: options.contract ?? null,
                    error: null,
                  }),
                };
              },
            };
          },
          update(values: Record<string, unknown>) {
            calls.push({ kind: "update", table, values });
            return {
              eq: () => Promise.resolve({ error: null }),
            };
          },
        };
      }

      throw new Error(`unexpected table access: ${table}`);
    },
  };

  return { client, calls, productTableAccesses };
}

Deno.test("PAYMENT_DELETED reconciliado delega à RPC sem atualizar pedido diretamente", async () => {
  const payment = { id: "pay_deleted_1", status: "DELETED", value: 129.9 };
  const { client, calls, productTableAccesses } = terminalWebhookClient({
    reconciliation: {
      status: "handled",
      order_id: STOCK_ORDER_ID,
      order_type: "stock",
    },
  });

  const response = await handleAsaasWebhook(
    webhookRequest("PAYMENT_DELETED", payment),
    client,
    WEBHOOK_TOKEN,
  );

  assert(response.status === 200, "terminal event was not accepted");
  assert(
    productTableAccesses.length === 0,
    "terminal event accessed a product order directly",
  );

  const reconciliationCall = calls.find((call) => call.kind === "rpc");
  assert(
    reconciliationCall?.name === "reconcile_asaas_terminal_order_event",
    "terminal event did not call the reconciliation RPC",
  );
  assert(
    reconciliationCall.args?.p_event === "PAYMENT_DELETED" &&
      reconciliationCall.args?.p_charge_id === payment.id,
    "reconciliation RPC received the wrong terminal event",
  );
  const reconciledPayment = reconciliationCall.args?.p_payment as Record<
    string,
    unknown
  >;
  assert(
    reconciledPayment?.id === payment.id,
    "reconciliation RPC did not receive the provider payment payload",
  );

  const cacheWrite = calls.find((call) => call.kind === "upsert");
  assert(cacheWrite?.row?.order_id === STOCK_ORDER_ID, "cache lost order id");
  assert(cacheWrite?.row?.order_type === "stock", "cache lost order type");
});

Deno.test("PAYMENT_REFUNDED sem operação reconciliada usa apenas o fallback de contrato", async () => {
  const payment = { id: "pay_refunded_1", status: "REFUNDED", value: 200 };
  const { client, calls, productTableAccesses } = terminalWebhookClient({
    reconciliation: { status: "unmatched", order_id: null, order_type: null },
    contract: { id: CONTRACT_ID, payment_status: "paid", installments: 1 },
  });

  const response = await handleAsaasWebhook(
    webhookRequest("PAYMENT_REFUNDED", payment),
    client,
    WEBHOOK_TOKEN,
  );

  assert(response.status === 200, "contract fallback was not accepted");
  assert(
    productTableAccesses.length === 0,
    "unmatched terminal event fell through to a product order update",
  );

  const contractUpdate = calls.find((call) =>
    call.kind === "update" && call.table === "assessment_contracts"
  );
  assert(
    contractUpdate?.values?.payment_status === "refunded",
    "contract fallback did not apply the refunded status",
  );
  const cacheWrite = calls.find((call) => call.kind === "upsert");
  assert(cacheWrite?.row?.order_id === CONTRACT_ID, "cache lost contract id");
  assert(cacheWrite?.row?.order_type === "contract", "cache lost contract type");
});

Deno.test("evento terminal sem operação mantém o vínculo do cache e não altera o pedido", async () => {
  const payment = { id: "pay_unmatched_product_1", status: "DELETED", value: 80 };
  const { client, calls, productTableAccesses } = terminalWebhookClient({
    reconciliation: {
      status: "unmatched",
      order_id: STOCK_ORDER_ID,
      order_type: "stock",
      requires_manual_reconciliation: true,
    },
  });

  const response = await handleAsaasWebhook(
    webhookRequest("PAYMENT_DELETED", payment),
    client,
    WEBHOOK_TOKEN,
  );

  assert(response.status === 200, "unmatched product event was not accepted");
  assert(
    productTableAccesses.length === 0,
    "unmatched product event altered a product order directly",
  );
  const cacheWrite = calls.find((call) => call.kind === "upsert");
  assert(
    cacheWrite?.row?.order_id === STOCK_ORDER_ID,
    "unmatched event detached the cache from its product order",
  );
  assert(cacheWrite?.row?.order_type === "stock", "unmatched cache lost order type");
});

Deno.test("falha da RPC de reconciliação retorna 500 sem gravar cache", async () => {
  const { client, calls, productTableAccesses } = terminalWebhookClient({
    reconciliationError: { message: "database unavailable" },
  });

  const response = await handleAsaasWebhook(
    webhookRequest("PAYMENT_DELETED", {
      id: "pay_failed_1",
      status: "DELETED",
    }),
    client,
    WEBHOOK_TOKEN,
  );

  assert(response.status === 500, "reconciliation failure did not fail closed");
  assert(
    productTableAccesses.length === 0,
    "failed terminal event accessed a product order directly",
  );
  assert(
    calls.filter((call) => call.kind === "rpc").length === 1,
    "failed terminal event did not stop after the reconciliation RPC",
  );
  assert(
    !calls.some((call) => call.kind === "upsert"),
    "failed terminal event wrote the payment cache",
  );
});
