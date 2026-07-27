import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import {
  handleContractResidualRequest,
  handlePublicAssessmentRequest,
} from "./contract-residual.ts";

const CONTRACT_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_ID = "22222222-2222-4222-8222-222222222222";
const COACH_ID = "33333333-3333-4333-8333-333333333333";
const PLAN_ID = "44444444-4444-4444-8444-444444444444";
const ACTOR_ID = "55555555-5555-4555-8555-555555555555";
const UPDATED_AT = "2026-07-27T18:00:00.000Z";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function request(
  path: string,
  method: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Request {
  return new Request(`https://example.test/api-v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

function client(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  error: Record<string, unknown> | null = null,
): SupabaseClient {
  return {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({ data: { ok: true }, error });
    },
  } as unknown as SupabaseClient;
}

function validAdminBody(overrides: Record<string, unknown> = {}) {
  return {
    customer_id: CUSTOMER_ID,
    coach_id: COACH_ID,
    plan_id: PLAN_ID,
    start_date: "2026-08-01",
    installments: 3,
    enrollment_fee: 50,
    manual_discount: 25,
    discount_reason: "Condição comercial",
    auto_renewal: false,
    notes: "Observação",
    replacement_contract_id: null,
    ...overrides,
  };
}

function validPublicBody(overrides: Record<string, unknown> = {}) {
  return {
    plan_id: PLAN_ID,
    coach_id: COACH_ID,
    full_name: "Pessoa Teste",
    whatsapp: "51999999999",
    email: "pessoa@example.test",
    cpf: "12345678909",
    gender: null,
    birth_date: null,
    payment_type: "card",
    installments: 3,
    ...overrides,
  };
}

Deno.test("Admin contract creation requires a stable idempotency key", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const response = await handleContractResidualRequest(
    request("/orders/contracts", "POST", validAdminBody()),
    "/orders/contracts",
    client(calls),
    ACTOR_ID,
  );
  assert(response?.status === 400, "missing idempotency was accepted");
  assert(calls.length === 0, "database was called for an invalid request");
});

Deno.test("Admin contract creation forwards only normalized business fields", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const response = await handleContractResidualRequest(
    request(
      "/orders/contracts",
      "POST",
      validAdminBody(),
      "contract:create:test-001",
    ),
    "/orders/contracts",
    client(calls),
    ACTOR_ID,
  );
  assert(response?.status === 201, "valid contract was rejected");
  assert(
    calls[0].name === "create_assessment_contract_from_admin",
    "wrong RPC",
  );
  assert(calls[0].args.p_actor_id === ACTOR_ID, "actor changed");
  assert(
    calls[0].args.p_idempotency_key === "contract:create:test-001",
    "key changed",
  );
  assert(
    !("p_plan_snapshot" in calls[0].args),
    "client controlled the snapshot",
  );
  assert(!("p_end_date" in calls[0].args), "client controlled the end date");
});

Deno.test("Automatic transitions accept no client-controlled dates", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const invalid = await handleContractResidualRequest(
    request("/orders/contracts/transitions", "POST", { today: "2030-01-01" }),
    "/orders/contracts/transitions",
    client(calls),
    ACTOR_ID,
  );
  assert(
    invalid?.status === 400,
    "client-controlled transition date was accepted",
  );
  const valid = await handleContractResidualRequest(
    request("/orders/contracts/transitions", "POST", {}),
    "/orders/contracts/transitions",
    client(calls),
    ACTOR_ID,
  );
  assert(valid?.status === 200, "valid transition request failed");
  assert(
    calls[0].name === "apply_assessment_contract_transitions",
    "wrong RPC",
  );
  assert(
    Object.keys(calls[0].args).join() === "p_actor_id",
    "extra transition input forwarded",
  );
});

Deno.test("Discount update validates concurrency and money", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const path = `/orders/contract/${CONTRACT_ID}/discount`;
  const invalid = await handleContractResidualRequest(
    request(path, "PATCH", {
      manual_discount: -1,
      discount_reason: null,
      discount_recurring: false,
      expected_updated_at: UPDATED_AT,
    }),
    path,
    client(calls),
    ACTOR_ID,
  );
  assert(invalid?.status === 400, "negative discount was accepted");
  const valid = await handleContractResidualRequest(
    request(path, "PATCH", {
      manual_discount: 20,
      discount_reason: "Ajuste",
      discount_recurring: true,
      expected_updated_at: UPDATED_AT,
    }),
    path,
    client(calls),
    ACTOR_ID,
  );
  assert(valid?.status === 200, "valid discount failed");
  assert(
    calls[0].name === "update_assessment_contract_discount",
    "wrong discount RPC",
  );
  assert(
    calls[0].args.p_expected_updated_at === UPDATED_AT,
    "snapshot changed",
  );
});

Deno.test("Refund completion validates the date and optimistic snapshot", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const path = `/orders/contract/${CONTRACT_ID}/refund-completion`;
  const response = await handleContractResidualRequest(
    request(path, "POST", {
      refund_date: "2026-07-27",
      refund_notes: "Comprovante conferido",
      expected_updated_at: UPDATED_AT,
    }),
    path,
    client(calls),
    ACTOR_ID,
  );
  assert(response?.status === 200, "valid refund completion failed");
  assert(
    calls[0].name === "complete_assessment_contract_refund",
    "wrong refund RPC",
  );
  assert(calls[0].args.p_actor_id === ACTOR_ID, "actor changed");
});

Deno.test("Public enrollment rejects extra fields and malformed contacts", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const path = "/public/assessment-enrollments";
  const response = await handlePublicAssessmentRequest(
    request(
      path,
      "POST",
      validPublicBody({ whatsapp: "123", status: "active" }),
      "public:enrollment:test-001",
    ),
    path,
    client(calls),
  );
  assert(response?.status === 400, "invalid public payload was accepted");
  assert(calls.length === 0, "database was called for invalid public input");
});

Deno.test("Public enrollment does not expose lifecycle fields to the client", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const path = "/public/assessment-enrollments";
  const response = await handlePublicAssessmentRequest(
    request(
      path,
      "POST",
      validPublicBody(),
      "public:enrollment:test-002",
    ),
    path,
    client(calls),
  );
  assert(response?.status === 201, "valid public enrollment failed");
  assert(
    calls[0].name === "create_public_assessment_enrollment",
    "wrong public RPC",
  );
  assert(!("p_status" in calls[0].args), "client controlled public status");
  assert(
    !("p_plan_snapshot" in calls[0].args),
    "client controlled public snapshot",
  );
  assert(
    !("p_customer_id" in calls[0].args),
    "client controlled public customer identity",
  );
});

Deno.test("Database conflicts preserve an actionable API code", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const response = await handleContractResidualRequest(
    request(
      "/orders/contracts",
      "POST",
      validAdminBody(),
      "contract:create:test-003",
    ),
    "/orders/contracts",
    client(calls, { code: "P0001", message: "Conflito de teste" }),
    ACTOR_ID,
  );
  const payload = await response?.json();
  assert(response?.status === 409, "database conflict status changed");
  assert(
    payload.code === "invalid_transition",
    "database conflict code changed",
  );
});
