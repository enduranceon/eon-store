import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { handlePlanChangeRequest } from "./plan-changes.ts";
import { handlePaymentsRequest } from "./payments.ts";

const CONTRACT_ID = "11111111-1111-4111-8111-111111111111";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";
const COACH_ID = "33333333-3333-4333-8333-333333333333";
const CHANGE_ID = "44444444-4444-4444-8444-444444444444";
const ACTOR_ID = "55555555-5555-4555-8555-555555555555";
const METHOD_ID = "66666666-6666-4666-8666-666666666666";
const UPDATED_AT = "2026-09-29T18:00:00.000Z";

type Call = { name: string; args: Record<string, unknown> };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function request(path: string, method: string, body: unknown): Request {
  return new Request(`https://example.test/api-v1${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function client(calls: Call[], error: Record<string, unknown> | null = null): SupabaseClient {
  return {
    from() {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        maybeSingle() {
          return Promise.resolve({
            data: { id: METHOD_ID, installments: 3, credit_days_first: 30, credit_days_between: 30 },
            error: null,
          });
        },
      };
      return chain;
    },
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({ data: { ok: true }, error });
    },
  } as unknown as SupabaseClient;
}

const CHANGE_FIELDS = {
  to_plan_id: PLAN_ID,
  effective_date: "2026-11-01",
  to_coach_id: COACH_ID,
};

Deno.test("plan change preview forwards only the quote fields", async () => {
  const calls: Call[] = [];
  const path = `/orders/contract/${CONTRACT_ID}/plan-changes/preview`;
  const response = await handlePlanChangeRequest(
    request(path, "POST", { ...CHANGE_FIELDS, plan_change_id: null }),
    path,
    client(calls),
    ACTOR_ID,
  );
  assert(response?.status === 200, "valid preview failed");
  assert(calls[0].name === "preview_assessment_plan_change", "wrong RPC");
  assert(
    JSON.stringify(calls[0].args) === JSON.stringify({
      p_contract_id: CONTRACT_ID,
      p_to_plan_id: PLAN_ID,
      p_effective_date: "2026-11-01",
      p_to_coach_id: COACH_ID,
      p_plan_change_id: null,
    }),
    "preview arguments changed",
  );
});

Deno.test("plan change creation needs the contract version and valid dates", async () => {
  const calls: Call[] = [];
  const path = `/orders/contract/${CONTRACT_ID}/plan-changes`;
  const bad = [
    { ...CHANGE_FIELDS, notes: null },
    { ...CHANGE_FIELDS, effective_date: "2026-02-30", notes: null, expected_updated_at: UPDATED_AT },
    { ...CHANGE_FIELDS, to_plan_id: "plano", notes: null, expected_updated_at: UPDATED_AT },
    { ...CHANGE_FIELDS, notes: null, expected_updated_at: UPDATED_AT, amount: 1 },
  ];
  for (const body of bad) {
    const response = await handlePlanChangeRequest(request(path, "POST", body), path, client(calls), ACTOR_ID);
    assert(response?.status === 400, `invalid body accepted: ${JSON.stringify(body)}`);
  }
  assert(calls.length === 0, "the database was called for an invalid body");

  const response = await handlePlanChangeRequest(
    request(path, "POST", { ...CHANGE_FIELDS, to_coach_id: null, notes: "Quer triathlon", expected_updated_at: UPDATED_AT }),
    path,
    client(calls),
    ACTOR_ID,
  );
  assert(response?.status === 201, "valid creation failed");
  assert(calls[0].name === "create_assessment_plan_change", "wrong RPC");
  assert(calls[0].args.p_actor_id === ACTOR_ID, "actor not forwarded");
  assert(calls[0].args.p_to_coach_id === null, "keeping the coach must send null");
});

Deno.test("plan change edit and cancellation require a reason", async () => {
  const calls: Call[] = [];
  const editPath = `/plan-changes/${CHANGE_ID}`;
  const noReason = await handlePlanChangeRequest(
    request(editPath, "PATCH", { ...CHANGE_FIELDS, reason: "  ", expected_updated_at: UPDATED_AT }),
    editPath,
    client(calls),
    ACTOR_ID,
  );
  assert(noReason?.status === 400, "edit without reason accepted");
  const edit = await handlePlanChangeRequest(
    request(editPath, "PATCH", { ...CHANGE_FIELDS, reason: "Aluno pediu outra data", expected_updated_at: UPDATED_AT }),
    editPath,
    client(calls),
    ACTOR_ID,
  );
  assert(edit?.status === 200, "valid edit failed");
  assert(calls[0].name === "update_assessment_plan_change", "wrong edit RPC");

  const cancelPath = `/plan-changes/${CHANGE_ID}/cancellation`;
  const wrongMethod = await handlePlanChangeRequest(
    request(cancelPath, "DELETE", { reason: "Desistiu", expected_updated_at: UPDATED_AT }),
    cancelPath,
    client(calls),
    ACTOR_ID,
  );
  assert(wrongMethod?.status === 405, "cancellation accepted another method");
  const cancel = await handlePlanChangeRequest(
    request(cancelPath, "POST", { reason: "Desistiu", expected_updated_at: UPDATED_AT }),
    cancelPath,
    client(calls),
    ACTOR_ID,
  );
  assert(cancel?.status === 200, "valid cancellation failed");
  assert(calls[1].name === "cancel_assessment_plan_change", "wrong cancel RPC");
});

Deno.test("plan change external charge allows at most 6 installments", async () => {
  const calls: Call[] = [];
  const path = `/plan-changes/${CHANGE_ID}/external-charge`;
  const body = {
    external_link: "https://pagamento.example.test/upgrade",
    due_date: "2026-10-10",
    payment_method: "card_7x",
    invoice_number: null,
    expected_updated_at: UPDATED_AT,
  };
  const tooMany = await handlePlanChangeRequest(request(path, "PUT", body), path, client(calls), ACTOR_ID);
  assert(tooMany?.status === 400, "7x accepted");
  const http = await handlePlanChangeRequest(
    request(path, "PUT", { ...body, payment_method: "pix", external_link: "http://inseguro.test" }),
    path,
    client(calls),
    ACTOR_ID,
  );
  assert(http?.status === 400, "plain http link accepted");
  const valid = await handlePlanChangeRequest(
    request(path, "PUT", { ...body, payment_method: "card_6x" }),
    path,
    client(calls),
    ACTOR_ID,
  );
  assert(valid?.status === 200, "valid charge failed");
  assert(calls[0].name === "save_assessment_plan_change_external_charge", "wrong RPC");
});

Deno.test("plan change database refusals keep their message", async () => {
  const calls: Call[] = [];
  const path = `/plan-changes/${CHANGE_ID}/cancellation`;
  const response = await handlePlanChangeRequest(
    request(path, "POST", { reason: "Desistiu", expected_updated_at: UPDATED_AT }),
    path,
    client(calls, { code: "P0001", message: "Mudança já paga" }),
    ACTOR_ID,
  );
  assert(response?.status === 409, "business refusal is not a conflict");
  const body = await response.json();
  assert(body.error === "Mudança já paga", "message changed");
});

Deno.test("unrelated paths are left to other handlers", async () => {
  const response = await handlePlanChangeRequest(
    request("/orders/contract/x/discount", "PATCH", {}),
    "/orders/contract/x/discount",
    client([]),
    ACTOR_ID,
  );
  assert(response === null, "plan change handler took another route");
});

Deno.test("plan change payments go to their own RPCs", async () => {
  const calls: Call[] = [];
  const path = `/orders/plan-change/${CHANGE_ID}/manual-payment`;
  const record = await handlePaymentsRequest(
    request(path, "POST", { payment_method_id: METHOD_ID, payment_date: "2026-09-29", total: 397.79 }),
    path,
    client(calls),
    ACTOR_ID,
  );
  assert(record?.status === 200, "valid plan change payment failed");
  assert(calls[0].name === "api_record_plan_change_manual_payment", "wrong record RPC");
  assert(Array.isArray(calls[0].args.p_installments) && (calls[0].args.p_installments as unknown[]).length === 3,
    "installments were not projected");

  const adjust = await handlePaymentsRequest(
    request(path, "PATCH", { total: 1, manual_discount: 0, discount_reason: null, discount_recurring: false }),
    path,
    client(calls),
    ACTOR_ID,
  );
  assert(adjust?.status === 400, "plan change payments cannot be adjusted");

  const undo = await handlePaymentsRequest(request(path, "DELETE", {}), path, client(calls), ACTOR_ID);
  assert(undo?.status === 200, "undo failed");
  assert(calls[1].name === "api_reopen_plan_change_manual_payment", "wrong undo RPC");
});
