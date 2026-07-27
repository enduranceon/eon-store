import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { handleContractRequest } from "./contracts.ts";

const CONTRACT_ID = "11111111-1111-4111-8111-111111111111";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const OPERATION_ID = "44444444-4444-4444-8444-444444444444";
const LEASE_TOKEN = "55555555-5555-4555-8555-555555555555";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function responseBody(
  response: Response,
): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function request(
  suffix: "void-sale" | "plan",
  body: Record<string, unknown>,
  method = suffix === "void-sale" ? "POST" : "PATCH",
): Request {
  return new Request(
    `https://example.test/api-v1/orders/contract/${CONTRACT_ID}/${suffix}`,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `contract:${suffix}:test`,
      },
      body: JSON.stringify(body),
    },
  );
}

function validPlanBody(overrides: Record<string, unknown> = {}) {
  return {
    plan_id: PLAN_ID,
    start_date: "2026-08-01",
    installments: 3,
    enrollment_fee: 50,
    manual_discount: 25,
    discount_reason: "Condição comercial",
    ...overrides,
  };
}

function client(
  preparedOverrides: Record<string, unknown> = {},
  cacheRows: Array<Record<string, unknown>> = [],
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const fake = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "prepare_assessment_contract_mutation") {
        return Promise.resolve({
          data: {
            operation_id: OPERATION_ID,
            status: "prepared",
            asaas_charge_id: null,
            had_external_charge: false,
            lease_acquired: true,
            lease_token: LEASE_TOKEN,
            ...preparedOverrides,
          },
          error: null,
        });
      }
      if (name === "complete_assessment_contract_mutation") {
        return Promise.resolve({
          data: {
            operation_id: OPERATION_ID,
            status: "completed",
            contract_id: CONTRACT_ID,
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
  return { fake, calls };
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

Deno.test("Void sale completes atomically when no provider action is needed", async () => {
  const { fake, calls } = client();
  const path = `/orders/contract/${CONTRACT_ID}/void-sale`;
  const response = await handleContractRequest(
    request("void-sale", {}),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 200, "void sale failed");
  assert(
    calls.map((call) => call.name).join(",") ===
      "prepare_assessment_contract_mutation,complete_assessment_contract_mutation",
    "unexpected local operation sequence",
  );
  assert(
    calls[0].args.p_operation_type === "void_contract_sale",
    "wrong mutation type",
  );
  const external = calls[1].args.p_external_result as Record<string, unknown>;
  assert(external.provider === "none", "provider action was invented");
  assert(external.outcome === "not_required", "wrong no-provider outcome");
});

Deno.test("Plan change sends normalized target fields to the prepare RPC", async () => {
  const { fake, calls } = client();
  const path = `/orders/contract/${CONTRACT_ID}/plan`;
  const response = await handleContractRequest(
    request("plan", validPlanBody()),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 200, "plan change failed");
  const args = calls[0].args;
  assert(
    args.p_operation_type === "change_contract_plan",
    "wrong mutation type",
  );
  assert(args.p_plan_id === PLAN_ID, "plan id changed");
  assert(args.p_start_date === "2026-08-01", "start date changed");
  assert(args.p_installments === 3, "installments changed");
  assert(args.p_enrollment_fee === 50, "enrollment fee changed");
  assert(args.p_manual_discount === 25, "discount changed");
  assert(args.p_discount_reason === "Condição comercial", "reason changed");
});

Deno.test("Contract mutation snapshots and cancels an Asaas charge before completion", async () => {
  await withAsaas(async () => {
    const providerRequests: string[] = [];
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      providerRequests.push(`${init?.method || "GET"} ${url.pathname}`);
      return Promise.resolve(Response.json({ id: "pay_1", status: "PENDING" }));
    };
    const { fake, calls } = client(
      { asaas_charge_id: "pay_1" },
      [{
        asaas_payment_id: "pay_1",
        installment_group_id: null,
        raw: { id: "pay_1", status: "PENDING" },
      }],
    );
    const path = `/orders/contract/${CONTRACT_ID}/void-sale`;
    const response = await handleContractRequest(
      request("void-sale", {}),
      path,
      fake,
      ACTOR_ID,
    );
    assert(response?.status === 200, "Asaas-backed mutation failed");
    assert(
      providerRequests.join(",") ===
        "GET /v3/payments/pay_1,DELETE /v3/payments/pay_1",
      "provider sequence changed",
    );
    assert(
      calls.map((call) => call.name).join(",") ===
        "prepare_assessment_contract_mutation,record_assessment_contract_mutation_snapshot,complete_assessment_contract_mutation",
      "snapshot was not persisted before completion",
    );
  });
});

Deno.test("External references are detached without calling Asaas", async () => {
  const { fake, calls } = client({ had_external_charge: true });
  const path = `/orders/contract/${CONTRACT_ID}/plan`;
  const response = await handleContractRequest(
    request("plan", validPlanBody()),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 200, "external reference mutation failed");
  const external = calls[1].args.p_external_result as Record<string, unknown>;
  assert(external.provider === "external_reference", "wrong external provider");
  assert(
    external.outcome === "detached",
    "external reference was not detached",
  );
});

Deno.test("Completed idempotent mutation returns cached result without side effects", async () => {
  const cached = {
    operation_id: OPERATION_ID,
    status: "completed",
    contract_id: CONTRACT_ID,
  };
  const { fake, calls } = client({
    status: "completed",
    lease_acquired: false,
    lease_token: null,
    result: cached,
  });
  const path = `/orders/contract/${CONTRACT_ID}/void-sale`;
  const response = await handleContractRequest(
    request("void-sale", {}),
    path,
    fake,
    ACTOR_ID,
  );
  const body = await responseBody(response!);
  assert(response?.status === 200, "completed replay failed");
  assert(calls.length === 1, "completed replay performed another side effect");
  assert(
    (body.data as Record<string, unknown>).contract_id === CONTRACT_ID,
    "cached result changed",
  );
});

Deno.test("Reconciliation-required mutation cannot be retried automatically", async () => {
  const { fake, calls } = client({
    status: "reconciliation_required",
    lease_acquired: false,
    lease_token: null,
    error: "Conferência necessária",
  });
  const path = `/orders/contract/${CONTRACT_ID}/void-sale`;
  const response = await handleContractRequest(
    request("void-sale", {}),
    path,
    fake,
    ACTOR_ID,
  );
  const body = await responseBody(response!);
  assert(response?.status === 409, "reconciliation was not blocked");
  assert(body.code === "reconciliation_required", "wrong reconciliation code");
  assert(calls.length === 1, "reconciliation started external work");
});

Deno.test("Plan change rejects unknown fields before opening an operation", async () => {
  const { fake, calls } = client();
  const path = `/orders/contract/${CONTRACT_ID}/plan`;
  const response = await handleContractRequest(
    request("plan", validPlanBody({ plan_snapshot: { price_total: 1 } })),
    path,
    fake,
    ACTOR_ID,
  );
  const body = await responseBody(response!);
  assert(response?.status === 400, "unknown field was accepted");
  assert(body.code === "invalid_request", "wrong validation code");
  assert(calls.length === 0, "invalid body reached the database");
});

Deno.test("Plan change rejects impossible dates and numeric strings", async () => {
  const invalidBodies = [
    validPlanBody({ start_date: "2026-02-30" }),
    validPlanBody({ installments: "3" }),
    validPlanBody({ enrollment_fee: "50" }),
    validPlanBody({ discount_reason: 123 }),
  ];
  for (const invalidBody of invalidBodies) {
    const { fake, calls } = client();
    const path = `/orders/contract/${CONTRACT_ID}/plan`;
    const response = await handleContractRequest(
      request("plan", invalidBody),
      path,
      fake,
      ACTOR_ID,
    );
    assert(response?.status === 400, "invalid plan body was accepted");
    assert(calls.length === 0, "invalid plan body reached the database");
  }
});

Deno.test("Contract mutation routes enforce their HTTP methods", async () => {
  const { fake, calls } = client();
  const path = `/orders/contract/${CONTRACT_ID}/void-sale`;
  const response = await handleContractRequest(
    request("void-sale", {}, "PATCH"),
    path,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 405, "wrong method was accepted");
  assert(calls.length === 0, "wrong method reached the database");
});
