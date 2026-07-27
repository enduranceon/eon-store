import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { AsaasApiError } from "../_shared/asaas.ts";
import { executeAsaasChargeCreation, handleChargeRequest } from "./charges.ts";

const CUSTOMER_CPF = "12345678901";
const CUSTOMER_REFERENCE = "EONCUS-0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd";
const PAYMENT_REFERENCE = "EONCHG-f1bd863e-c244-4bdd-a69c-1321d5b94b54";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function prepared(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: "f1bd863e-c244-4bdd-a69c-1321d5b94b54",
    status: "prepared" as const,
    lease_acquired: true,
    lease_token: "b0338110-1074-43e0-9b02-f0bb3439ee32",
    billing_type: "BOLETO" as const,
    due_date: "2026-08-20",
    installments: 1,
    total_value: 100,
    customer_cpf: CUSTOMER_CPF,
    customer_name: "Cliente Teste",
    customer_email: "cliente@example.test",
    customer_phone: "11999999999",
    asaas_customer_id: "cus_test",
    customer_external_reference: CUSTOMER_REFERENCE,
    payment_external_reference: PAYMENT_REFERENCE,
    description: "Pedido PED-TESTE",
    source: "order_detail" as const,
    ...overrides,
  };
}

function fakeClient(
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): SupabaseClient {
  return { rpc } as unknown as SupabaseClient;
}

async function responseBody(
  response: Response,
): Promise<Record<string, unknown>> {
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

async function expectAsaasError(
  operation: () => Promise<unknown>,
  code: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await operation();
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof AsaasApiError, `expected AsaasApiError ${code}`);
  assert(thrown.code === code, `expected ${code}, received ${thrown.code}`);
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

function customer(
  id = "cus_test",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    cpfCnpj: CUSTOMER_CPF,
    externalReference: CUSTOMER_REFERENCE,
    ...overrides,
  };
}

function payment(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "pay_test",
    customer: "cus_test",
    billingType: "BOLETO",
    status: "PENDING",
    value: 100,
    netValue: 98.5,
    dueDate: "2026-08-20",
    description: "Pedido PED-TESTE",
    externalReference: PAYMENT_REFERENCE,
    invoiceUrl: "https://asaas.test/invoice/pay_test",
    ...overrides,
  };
}

function installmentPayments(
  overrides: Record<number, Record<string, unknown>> = {},
): Array<Record<string, unknown>> {
  return [
    payment({
      id: "pay_installment_1",
      billingType: "CREDIT_CARD",
      value: 33.33,
      dueDate: "2026-08-20",
      installment: "ins_test",
      installmentNumber: 1,
    }),
    payment({
      id: "pay_installment_2",
      billingType: "CREDIT_CARD",
      value: 33.33,
      dueDate: "2026-09-20",
      installment: "ins_test",
      installmentNumber: 2,
    }),
    payment({
      id: "pay_installment_3",
      billingType: "CREDIT_CARD",
      value: 33.34,
      dueDate: "2026-10-20",
      installment: "ins_test",
      installmentNumber: 3,
    }),
  ].map((item, index) => ({ ...item, ...(overrides[index + 1] || {}) }));
}

function savedCustomerResponse(url: URL): Response | null {
  return url.pathname === "/v3/customers/cus_test"
    ? Response.json(customer())
    : null;
}

Deno.test("Asaas installment creation validates the full group and preserves totalValue", async () => {
  await withAsaas(async () => {
    const requests: Array<{
      pathname: string;
      method: string;
      body?: Record<string, unknown>;
    }> = [];
    globalThis.fetch = (input, init) => {
      const url = requestUrl(input);
      const method = init?.method || "GET";
      requests.push({
        pathname: url.pathname,
        method,
        body: typeof init?.body === "string"
          ? JSON.parse(init.body) as Record<string, unknown>
          : undefined,
      });
      const saved = savedCustomerResponse(url);
      if (saved) return Promise.resolve(saved);
      if (url.pathname === "/v3/installments/ins_test/payments") {
        return Promise.resolve(Response.json({ data: installmentPayments() }));
      }
      if (url.pathname === "/v3/payments" && method === "POST") {
        return Promise.resolve(Response.json(installmentPayments()[0]));
      }
      return Promise.resolve(Response.json({ data: [] }));
    };

    const result = await executeAsaasChargeCreation(prepared({
      billing_type: "CREDIT_CARD",
      installments: 3,
    }));
    const post = requests.find((request) => request.method === "POST");
    assert(post, "payment POST was not issued");
    assert(post.body?.installmentCount === 3, "installment count changed");
    assert(post.body?.totalValue === 100, "total value was not preserved");
    assert(
      !("installmentValue" in post.body!),
      "rounded installmentValue was sent",
    );
    assert(!("value" in post.body!), "single-payment value was sent");
    const normalized = result.payments as Array<Record<string, unknown>>;
    assert(normalized.length === 3, "full installment set was not returned");
    assert(normalized[0].payment_id === "pay_installment_1", "order changed");
    assert(
      normalized[2].value === 33.34,
      "last installment adjustment changed",
    );
    assert(!("id" in normalized[0]), "raw provider payment leaked");
  });
});

Deno.test("Asaas retry revalidates the stored customer and recovers one payment", async () => {
  await withAsaas(async () => {
    let customerLookups = 0;
    let postCalls = 0;
    globalThis.fetch = (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/v3/customers/cus_test") {
        customerLookups += 1;
        return Promise.resolve(Response.json(customer()));
      }
      if (init?.method === "POST") postCalls += 1;
      return Promise.resolve(Response.json({
        data: [payment({ id: "pay_recovered" })],
      }));
    };

    const result = await executeAsaasChargeCreation(prepared());
    assert(customerLookups === 1, "stored customer was not revalidated");
    assert(postCalls === 0, "retry issued a duplicate payment POST");
    assert(result.outcome === "recovered", "existing charge was not recovered");
    assert(result.payment_id === "pay_recovered", "recovered id changed");
    const normalized = result.payments as Array<Record<string, unknown>>;
    assert(normalized[0].customer_id === "cus_test", "customer was lost");
  });
});

Deno.test("Asaas retry recovers a charge already confirmed by the provider", async () => {
  await withAsaas(async () => {
    globalThis.fetch = (input) => {
      const url = requestUrl(input);
      if (url.pathname === "/v3/customers/cus_test") {
        return Promise.resolve(Response.json(customer()));
      }
      return Promise.resolve(Response.json({
        data: [payment({
          id: "pay_already_paid",
          status: "CONFIRMED",
          paymentDate: "2026-07-26",
        })],
      }));
    };

    const result = await executeAsaasChargeCreation(prepared());
    assert(result.outcome === "recovered", "paid charge was not recovered");
    assert(result.payment_id === "pay_already_paid", "paid charge id changed");
    const normalized = result.payments as Array<Record<string, unknown>>;
    assert(normalized[0].status === "CONFIRMED", "paid status was downgraded");
    assert(
      normalized[0].payment_date === "2026-07-26",
      "provider payment date was lost",
    );
  });
});

Deno.test("A removed stored customer is replaced by the canonical CPF match", async () => {
  await withAsaas(async () => {
    let customerPosts = 0;
    globalThis.fetch = (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/v3/customers/cus_test") {
        return Promise.resolve(Response.json({}, { status: 404 }));
      }
      if (
        url.pathname === "/v3/customers" &&
        url.searchParams.has("externalReference")
      ) {
        return Promise.resolve(Response.json({ data: [] }));
      }
      if (url.pathname === "/v3/customers") {
        return Promise.resolve(Response.json({
          data: [customer("cus_recovered", { externalReference: null })],
        }));
      }
      if (url.pathname === "/v3/payments" && init?.method === "POST") {
        customerPosts += 1;
        return Promise.resolve(Response.json(payment({
          customer: "cus_recovered",
          id: "pay_recovered_customer",
        })));
      }
      return Promise.resolve(Response.json({ data: [] }));
    };

    const result = await executeAsaasChargeCreation(prepared());
    assert(result.customer_id === "cus_recovered", "replacement was not used");
    assert(customerPosts === 1, "payment was not created exactly once");
  });
});

Deno.test("Corrected CPF ignores the old Asaas customer and creates the new linkage", async () => {
  await withAsaas(async () => {
    const correctedCpf = "98765432100";
    let oldCustomerLookups = 0;
    let customerSearches = 0;
    let customerPosts = 0;
    let paymentPosts = 0;
    globalThis.fetch = (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/v3/customers/cus_test") {
        oldCustomerLookups += 1;
        return Promise.resolve(Response.json(customer()));
      }
      if (url.pathname === "/v3/customers" && init?.method === "POST") {
        customerPosts += 1;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        assert(body.cpfCnpj === correctedCpf, "corrected CPF was not sent");
        assert(
          body.externalReference === CUSTOMER_REFERENCE,
          "customer reference changed",
        );
        return Promise.resolve(Response.json(customer("cus_corrected", {
          cpfCnpj: correctedCpf,
        })));
      }
      if (url.pathname === "/v3/customers") {
        customerSearches += 1;
        assert(
          url.searchParams.get("cpfCnpj") === correctedCpf,
          "customer search reused the old CPF",
        );
        return Promise.resolve(Response.json({ data: [] }));
      }
      if (url.pathname === "/v3/payments" && init?.method === "POST") {
        paymentPosts += 1;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        assert(body.customer === "cus_corrected", "old customer was charged");
        return Promise.resolve(Response.json(payment({
          id: "pay_corrected",
          customer: "cus_corrected",
        })));
      }
      if (url.pathname === "/v3/payments") {
        return Promise.resolve(Response.json({ data: [] }));
      }
      throw new Error(`unexpected request ${url}`);
    };

    const result = await executeAsaasChargeCreation(prepared({
      customer_cpf: correctedCpf,
    }));
    assert(oldCustomerLookups === 1, "old customer was not checked once");
    assert(customerSearches === 2, "new CPF lookup was incomplete");
    assert(customerPosts === 1, "new customer was not created once");
    assert(paymentPosts === 1, "corrected customer was not charged once");
    assert(result.customer_id === "cus_corrected", "old customer was reused");
    assert(result.payment_id === "pay_corrected", "new charge was lost");
  });
});

Deno.test("Customer externalReference is preferred before CPF fallback", async () => {
  await withAsaas(async () => {
    let cpfOnlySearches = 0;
    let customerPosts = 0;
    globalThis.fetch = (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/v3/customers") {
        if (url.searchParams.has("externalReference")) {
          assert(
            url.searchParams.get("externalReference") === CUSTOMER_REFERENCE,
            "customer reference changed",
          );
          assert(
            url.searchParams.get("cpfCnpj") === CUSTOMER_CPF,
            "customer CPF filter was omitted",
          );
          return Promise.resolve(Response.json({
            data: [customer("cus_reference")],
          }));
        }
        cpfOnlySearches += 1;
      }
      if (url.pathname === "/v3/customers" && init?.method === "POST") {
        customerPosts += 1;
      }
      if (url.pathname === "/v3/payments") {
        return Promise.resolve(Response.json({
          data: [payment({ customer: "cus_reference" })],
        }));
      }
      throw new Error(`unexpected request ${url}`);
    };

    const result = await executeAsaasChargeCreation(prepared({
      asaas_customer_id: null,
    }));
    assert(result.customer_id === "cus_reference", "reference match was lost");
    assert(cpfOnlySearches === 0, "CPF fallback ran after exact match");
    assert(customerPosts === 0, "an exact customer was duplicated");
  });
});

Deno.test("Duplicate CPF customers without an exact reference require reconciliation", async () => {
  await withAsaas(async () => {
    let customerPosts = 0;
    globalThis.fetch = (input, init) => {
      const url = requestUrl(input);
      if (url.pathname !== "/v3/customers") {
        throw new Error(`unexpected request ${url}`);
      }
      if (init?.method === "POST") customerPosts += 1;
      if (url.searchParams.has("externalReference")) {
        return Promise.resolve(Response.json({ data: [] }));
      }
      return Promise.resolve(Response.json({
        data: [
          customer("cus_first", { externalReference: "LEGACY-1" }),
          customer("cus_second", { externalReference: "LEGACY-2" }),
        ],
      }));
    };

    await expectAsaasError(
      () => executeAsaasChargeCreation(prepared({ asaas_customer_id: null })),
      "asaas_duplicate_customers",
    );
    assert(customerPosts === 0, "ambiguous customer triggered a create POST");
  });
});

Deno.test("Ambiguous customer creation is recovered by exact externalReference", async () => {
  await withAsaas(async () => {
    let referenceSearches = 0;
    let customerPosts = 0;
    globalThis.fetch = (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/v3/customers" && init?.method === "POST") {
        customerPosts += 1;
        return Promise.reject(new Error("customer timeout"));
      }
      if (
        url.pathname === "/v3/customers" &&
        url.searchParams.has("externalReference")
      ) {
        referenceSearches += 1;
        return Promise.resolve(Response.json({
          data: referenceSearches === 1 ? [] : [customer("cus_recovered")],
        }));
      }
      if (url.pathname === "/v3/customers") {
        return Promise.resolve(Response.json({ data: [] }));
      }
      if (url.pathname === "/v3/payments") {
        return Promise.resolve(Response.json({
          data: [payment({ customer: "cus_recovered" })],
        }));
      }
      throw new Error(`unexpected request ${url}`);
    };

    const result = await executeAsaasChargeCreation(prepared({
      asaas_customer_id: null,
    }));
    assert(customerPosts === 1, "customer create was not attempted once");
    assert(referenceSearches === 2, "customer was not reconciled by reference");
    assert(
      result.customer_id === "cus_recovered",
      "recovered customer changed",
    );
  });
});

Deno.test("Installment recovery rejects detached, partial, malformed, or mismatched sets", async () => {
  const scenarios: Array<{
    name: string;
    initial?: Array<Record<string, unknown>>;
    group?: Array<Record<string, unknown>>;
    code?: string;
  }> = [
    {
      name: "detached payment",
      initial: [payment({ billingType: "CREDIT_CARD", value: 33.33 })],
    },
    { name: "partial group", group: installmentPayments().slice(0, 2) },
    {
      name: "duplicate installment number",
      group: installmentPayments({ 2: { installmentNumber: 1 } }),
    },
    {
      name: "duplicate payment id",
      group: installmentPayments({ 2: { id: "pay_installment_1" } }),
    },
    {
      name: "wrong customer",
      group: installmentPayments({ 2: { customer: "cus_other" } }),
    },
    {
      name: "wrong billing type",
      group: installmentPayments({ 2: { billingType: "BOLETO" } }),
    },
    {
      name: "non-recoverable status",
      group: installmentPayments({ 2: { status: "REFUNDED" } }),
    },
    {
      name: "wrong external reference",
      group: installmentPayments({ 2: { externalReference: "OTHER" } }),
    },
    {
      name: "wrong first due date",
      group: installmentPayments({ 1: { dueDate: "2026-08-21" } }),
    },
    {
      name: "non-positive value",
      group: installmentPayments({ 2: { value: 0 } }),
    },
    {
      name: "wrong cent sum",
      group: installmentPayments({ 3: { value: 33.33 } }),
    },
    {
      name: "wrong group",
      group: installmentPayments({ 2: { installment: "ins_other" } }),
    },
  ];

  for (const scenario of scenarios) {
    await withAsaas(async () => {
      globalThis.fetch = (input) => {
        const url = requestUrl(input);
        const saved = savedCustomerResponse(url);
        if (saved) return Promise.resolve(saved);
        if (url.pathname === "/v3/installments/ins_test/payments") {
          return Promise.resolve(Response.json({
            data: scenario.group || installmentPayments(),
          }));
        }
        if (url.pathname === "/v3/payments") {
          return Promise.resolve(Response.json({
            data: scenario.initial || [installmentPayments()[0]],
          }));
        }
        throw new Error(`unexpected request ${scenario.name}: ${url}`);
      };

      await expectAsaasError(
        () =>
          executeAsaasChargeCreation(prepared({
            billing_type: "CREDIT_CARD",
            installments: 3,
          })),
        scenario.code || "asaas_recovered_payment_mismatch",
      );
    });
  }
});

Deno.test("Installment recovery rejects duplicate externalReference groups", async () => {
  await withAsaas(async () => {
    globalThis.fetch = (input) => {
      const url = requestUrl(input);
      const saved = savedCustomerResponse(url);
      if (saved) return Promise.resolve(saved);
      return Promise.resolve(Response.json({
        data: [
          installmentPayments()[0],
          {
            ...installmentPayments()[0],
            id: "pay_other",
            installment: "ins_other",
          },
        ],
      }));
    };

    await expectAsaasError(
      () =>
        executeAsaasChargeCreation(prepared({
          billing_type: "CREDIT_CARD",
          installments: 3,
        })),
      "asaas_duplicate_payments",
    );
  });
});

Deno.test("Charge route rejects invalid fields and contract sources before the database", async () => {
  let rpcCalls = 0;
  const client = fakeClient(() => {
    rpcCalls += 1;
    return Promise.resolve({ data: null, error: null });
  });
  const presalePath =
    "/orders/presale/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/charge";
  const contractPath =
    "/orders/contract/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/charge";

  const requests = [
    new Request(`https://example.test/api-v1${presalePath}`, {
      method: "POST",
      headers: { "Idempotency-Key": "charge-invalid" },
      body: JSON.stringify({
        billing_type: "PIX",
        due_date: "2026-02-30",
        installments: 1,
        cpf: CUSTOMER_CPF,
      }),
    }),
    new Request(`https://example.test/api-v1${presalePath}`, {
      method: "POST",
      headers: { "Idempotency-Key": "charge-extra-field" },
      body: JSON.stringify({
        billing_type: "PIX",
        due_date: "2026-08-20",
        installments: 1,
        cpf: CUSTOMER_CPF,
        value: 1,
      }),
    }),
    new Request(`https://example.test/api-v1${contractPath}`, {
      method: "POST",
      headers: { "Idempotency-Key": "charge-source-missing" },
      body: JSON.stringify({ billing_type: "PIX", due_date: "2026-08-20" }),
    }),
    new Request(`https://example.test/api-v1${contractPath}`, {
      method: "POST",
      headers: { "Idempotency-Key": "charge-source-invalid" },
      body: JSON.stringify({
        billing_type: "PIX",
        due_date: "2026-08-20",
        source: "untrusted_source",
      }),
    }),
  ];

  const paths = [presalePath, presalePath, contractPath, contractPath];
  for (let index = 0; index < requests.length; index += 1) {
    const response = await handleChargeRequest(
      requests[index],
      paths[index],
      client,
      "5cfe13fe-3150-4f5f-bbc8-f8ca3a25cc93",
    );
    assert(response?.status === 400, `invalid request ${index} was accepted`);
  }
  assert(rpcCalls === 0, "invalid request reached the database");
});

Deno.test("Contract source is forwarded to prepare and stored idempotent result is returned", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = fakeClient((name, args) => {
    calls.push({ name, args });
    return Promise.resolve({
      data: {
        operation_id: "f1bd863e-c244-4bdd-a69c-1321d5b94b54",
        status: "completed",
        source: "contract_detail",
        result: {
          operation_id: "f1bd863e-c244-4bdd-a69c-1321d5b94b54",
          status: "completed",
          charge_id: "pay_stored",
          source: "contract_detail",
        },
      },
      error: null,
    });
  });
  const path = "/orders/contract/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/charge";
  const response = await handleChargeRequest(
    new Request(`https://example.test/api-v1${path}`, {
      method: "POST",
      headers: { "Idempotency-Key": "charge-stored-result" },
      body: JSON.stringify({
        billing_type: "PIX",
        due_date: "2026-08-20",
        source: "contract_detail",
      }),
    }),
    path,
    client,
    "5cfe13fe-3150-4f5f-bbc8-f8ca3a25cc93",
  );
  assert(response?.status === 200, "stored result did not succeed");
  assert(calls.length === 1, "stored retry called another RPC");
  assert(calls[0].args.p_source === "contract_detail", "source was not sent");
  const payload = await responseBody(response!);
  assert(
    (payload.data as Record<string, unknown>).charge_id === "pay_stored",
    "stored charge changed",
  );
});

Deno.test("Charge route completes a contract creation with allowlisted source and payments", async () => {
  await withAsaas(async () => {
    globalThis.fetch = (input, init) => {
      const url = requestUrl(input);
      const saved = savedCustomerResponse(url);
      if (saved) return Promise.resolve(saved);
      if (url.pathname === "/v3/payments" && init?.method === "POST") {
        return Promise.resolve(Response.json(payment({ id: "pay_created" })));
      }
      return Promise.resolve(Response.json({ data: [] }));
    };

    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = fakeClient((name, args) => {
      calls.push({ name, args });
      if (name === "prepare_order_charge_creation") {
        return Promise.resolve({
          data: prepared({ source: "renewals_page" }),
          error: null,
        });
      }
      return Promise.resolve({
        data: {
          operation_id: "f1bd863e-c244-4bdd-a69c-1321d5b94b54",
          status: "completed",
          charge_id: "pay_created",
          source: "renewals_page",
        },
        error: null,
      });
    });

    const path = "/orders/contract/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/charge";
    const response = await handleChargeRequest(
      new Request(`https://example.test/api-v1${path}`, {
        method: "POST",
        headers: { "Idempotency-Key": "charge-provider-success" },
        body: JSON.stringify({
          billing_type: "BOLETO",
          due_date: "2026-08-20",
          source: "renewals_page",
        }),
      }),
      path,
      client,
      "5cfe13fe-3150-4f5f-bbc8-f8ca3a25cc93",
    );
    assert(response?.status === 201, "confirmed charge was not created");
    assert(calls.length === 2, "prepare/complete RPC pair changed");
    assert(calls[0].args.p_source === "renewals_page", "prepare lost source");
    assert(
      calls[1].name === "complete_order_charge_creation",
      "confirmed charge did not reach completion",
    );
    const external = calls[1].args.p_external_result as Record<string, unknown>;
    assert(external.payment_id === "pay_created", "provider id was lost");
    assert(external.requested_total_value === 100, "server total changed");
    assert(external.source === "renewals_page", "result lost source");
    const payments = external.payments as Array<Record<string, unknown>>;
    assert(payments.length === 1, "normalized payment was not included");
    assert(payments[0].value === 100, "actual provider value changed");
  });
});

Deno.test("Ambiguous payment timeout is persisted for reconciliation", async () => {
  await withAsaas(async () => {
    let paymentSearches = 0;
    globalThis.fetch = (input, init) => {
      const url = requestUrl(input);
      const saved = savedCustomerResponse(url);
      if (saved) return Promise.resolve(saved);
      if (url.pathname === "/v3/payments" && init?.method === "POST") {
        return Promise.reject(new Error("provider timeout"));
      }
      if (url.pathname === "/v3/payments") paymentSearches += 1;
      return Promise.resolve(Response.json({ data: [] }));
    };

    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = fakeClient((name, args) => {
      calls.push({ name, args });
      if (name === "prepare_order_charge_creation") {
        return Promise.resolve({ data: prepared(), error: null });
      }
      return Promise.resolve({
        data: {
          operation_id: "f1bd863e-c244-4bdd-a69c-1321d5b94b54",
          status: "reconciliation_required",
        },
        error: null,
      });
    });
    const path = "/orders/presale/0f127b5e-63b0-4b21-9b4d-b0bcc4d0d2dd/charge";
    const response = await handleChargeRequest(
      new Request(`https://example.test/api-v1${path}`, {
        method: "POST",
        headers: { "Idempotency-Key": "charge-timeout-test" },
        body: JSON.stringify({
          billing_type: "BOLETO",
          due_date: "2026-08-20",
          installments: 1,
          cpf: CUSTOMER_CPF,
        }),
      }),
      path,
      client,
      "5cfe13fe-3150-4f5f-bbc8-f8ca3a25cc93",
    );
    assert(response?.status === 409, "ambiguous timeout was not blocked");
    assert(paymentSearches === 2, "timeout was not reconciled by lookup");
    assert(
      calls[1].name === "finalize_order_charge_creation_failure",
      "ambiguous timeout was not persisted",
    );
    assert(
      calls[1].args.p_requires_reconciliation === true,
      "ambiguous timeout was marked deterministic",
    );
  });
});
