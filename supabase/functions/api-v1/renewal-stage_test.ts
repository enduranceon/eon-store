import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { handleRenewalStageRequest } from "./renewal-stage.ts";

const CONTRACT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const UPDATED_AT = "2026-10-02T12:00:00.000Z";
const PATH = `/orders/contract/${CONTRACT_ID}/renewal-stage`;
const KEY = "rs:message_sent:test:0001";

type Call = { name: string; args: Record<string, unknown> };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function request(
  body: unknown,
  { method = "POST", idempotencyKey = KEY }: {
    method?: string;
    idempotencyKey?: string | null;
  } = {},
): Request {
  return new Request(`https://example.test/api-v1${PATH}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

function client(
  calls: Call[],
  error: Record<string, unknown> | null = null,
): SupabaseClient {
  return {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve({
        data: error ? null : { status: "completed", stage_after: "waiting_response" },
        error,
      });
    },
  } as unknown as SupabaseClient;
}

async function body(response: Response | null): Promise<Record<string, unknown>> {
  assert(response, "handler ignored the renewal stage path");
  return await response.json() as Record<string, unknown>;
}

const messageBody = {
  action: "message_sent",
  expected_updated_at: UPDATED_AT,
  follow_up_at: null,
  message: "Oi, Ana! Tudo bem?",
};

Deno.test("message sent forwards the version, the key and the message", async () => {
  const calls: Call[] = [];
  const response = await handleRenewalStageRequest(
    request(messageBody),
    PATH,
    client(calls),
    ACTOR_ID,
  );

  assert(response?.status === 200, "message was not accepted");
  assert(calls.length === 1, "message called the database more than once");
  assert(calls[0].name === "transition_assessment_renewal_stage", "wrong RPC");
  assert(calls[0].args.p_contract_id === CONTRACT_ID, "contract id changed");
  assert(calls[0].args.p_action === "message_sent", "action changed");
  assert(calls[0].args.p_expected_updated_at === UPDATED_AT, "version changed");
  assert(calls[0].args.p_idempotency_key === KEY, "idempotency key changed");
  assert(calls[0].args.p_actor_id === ACTOR_ID, "actor changed");
  assert(calls[0].args.p_message === "Oi, Ana! Tudo bem?", "message changed");
  assert(calls[0].args.p_response_code === null, "message sent a response code");
  assert(calls[0].args.p_follow_up_at === null, "follow-up invented");
  assert(calls[0].args.p_notes === null, "notes invented");
});

Deno.test("a response forwards the answer, the follow-up and the notes", async () => {
  const calls: Call[] = [];
  const response = await handleRenewalStageRequest(
    request({
      action: "register_response",
      expected_updated_at: UPDATED_AT,
      response_code: "thinking",
      follow_up_at: "2026-10-06",
      notes: "Vai conversar com a família",
    }),
    PATH,
    client(calls),
    ACTOR_ID,
  );

  assert(response?.status === 200, "response was not accepted");
  assert(calls[0].args.p_action === "register_response", "action changed");
  assert(calls[0].args.p_response_code === "thinking", "answer changed");
  assert(calls[0].args.p_follow_up_at === "2026-10-06", "follow-up changed");
  assert(calls[0].args.p_notes === "Vai conversar com a família", "notes changed");
  assert(calls[0].args.p_message === null, "response sent a message");
});

Deno.test("follow-up and resolved change use their own payloads", async () => {
  const calls: Call[] = [];
  const followUp = await handleRenewalStageRequest(
    request({
      action: "set_follow_up",
      expected_updated_at: UPDATED_AT,
      follow_up_at: null,
    }, { idempotencyKey: "rs:set_follow_up:test:0001" }),
    PATH,
    client(calls),
    ACTOR_ID,
  );
  const resolved = await handleRenewalStageRequest(
    request({
      action: "change_resolved",
      expected_updated_at: UPDATED_AT,
      notes: null,
    }, { idempotencyKey: "rs:change_resolved:test:0001" }),
    PATH,
    client(calls),
    ACTOR_ID,
  );

  assert(followUp?.status === 200, "follow-up was not accepted");
  assert(resolved?.status === 200, "resolved change was not accepted");
  assert(calls[0].args.p_action === "set_follow_up", "follow-up action changed");
  assert(calls[0].args.p_follow_up_at === null, "follow-up removal changed");
  assert(calls[1].args.p_action === "change_resolved", "change action changed");
});

Deno.test("requests without an idempotency key never reach the database", async () => {
  const calls: Call[] = [];
  const response = await handleRenewalStageRequest(
    request(messageBody, { idempotencyKey: null }),
    PATH,
    client(calls),
    ACTOR_ID,
  );

  assert(response?.status === 400, "missing key was accepted");
  assert(calls.length === 0, "missing key reached the database");
});

Deno.test("invalid payloads are rejected before the database", async () => {
  const invalidBodies: unknown[] = [
    { ...messageBody, action: "renewed" },
    { ...messageBody, action: "payment_confirmed" },
    { action: "message_sent", expected_updated_at: UPDATED_AT },
    { ...messageBody, renewal_stage: "renewed" },
    { ...messageBody, expected_updated_at: "ontem" },
    { ...messageBody, follow_up_at: "2026-02-30" },
    { ...messageBody, message: "x".repeat(4001) },
    {
      action: "register_response",
      expected_updated_at: UPDATED_AT,
      response_code: "maybe",
      follow_up_at: null,
      notes: null,
    },
    {
      action: "register_response",
      expected_updated_at: UPDATED_AT,
      response_code: "thinking",
      follow_up_at: null,
      notes: "x".repeat(501),
    },
    ["message_sent"],
  ];
  for (const invalidBody of invalidBodies) {
    const calls: Call[] = [];
    const response = await handleRenewalStageRequest(
      request(invalidBody),
      PATH,
      client(calls),
      ACTOR_ID,
    );
    assert(response?.status === 400, `invalid body was accepted: ${JSON.stringify(invalidBody).slice(0, 80)}`);
    assert(calls.length === 0, "invalid body reached the database");
  }
});

Deno.test("'Não vou renovar' is sent to the safe resolution", async () => {
  const calls: Call[] = [];
  const response = await handleRenewalStageRequest(
    request({
      action: "register_response",
      expected_updated_at: UPDATED_AT,
      response_code: "not_renewing",
      follow_up_at: null,
      notes: null,
    }),
    PATH,
    client(calls),
    ACTOR_ID,
  );
  const payload = await body(response);

  assert(response?.status === 400, "non-renewal was accepted as a plain answer");
  assert(
    String(payload.error).includes("encerramento da renovação"),
    "the operator is not pointed to the safe resolution",
  );
  assert(calls.length === 0, "non-renewal reached the database");
});

Deno.test("only POST and valid contract ids are accepted", async () => {
  const calls: Call[] = [];
  const wrongMethod = await handleRenewalStageRequest(
    request(messageBody, { method: "PATCH" }),
    PATH,
    client(calls),
    ACTOR_ID,
  );
  const wrongId = await handleRenewalStageRequest(
    request(messageBody),
    "/orders/contract/not-a-uuid/renewal-stage",
    client(calls),
    ACTOR_ID,
  );
  const otherPath = await handleRenewalStageRequest(
    request(messageBody),
    `/orders/contract/${CONTRACT_ID}/renewal`,
    client(calls),
    ACTOR_ID,
  );

  assert(wrongMethod?.status === 405, "wrong method was accepted");
  assert(wrongId?.status === 400, "invalid contract id was accepted");
  assert(otherPath === null, "handler captured another route");
  assert(calls.length === 0, "rejected requests reached the database");
});

Deno.test("a stale version becomes a 409 with the database message", async () => {
  const calls: Call[] = [];
  const response = await handleRenewalStageRequest(
    request(messageBody),
    PATH,
    client(calls, {
      code: "P0001",
      message: "A renovação foi alterada por outra ação. Atualize a página e tente novamente",
    }),
    ACTOR_ID,
  );
  const payload = await body(response);

  assert(response?.status === 409, "stale version did not become 409");
  assert(payload.code === "invalid_transition", "wrong conflict code");
  assert(
    payload.error === "A renovação foi alterada por outra ação. Atualize a página e tente novamente",
    "conflict message changed",
  );
});

Deno.test("database errors keep their meaning without leaking internals", async () => {
  const cases: Array<[Record<string, unknown>, number, string]> = [
    [{ code: "P0002", message: "Renovação não encontrada" }, 404, "not_found"],
    [{ code: "22023", message: "Informe um follow-up a partir de hoje" }, 400, "invalid_request"],
    [{ code: "23505", message: "duplicate key value" }, 409, "invalid_transition"],
    [{ code: "XX000", message: "internal detail" }, 500, "database_error"],
  ];
  for (const [error, status, code] of cases) {
    const calls: Call[] = [];
    const response = await handleRenewalStageRequest(
      request(messageBody),
      PATH,
      client(calls, error),
      ACTOR_ID,
    );
    const payload = await body(response);
    assert(response?.status === status, `${error.code} became ${response?.status}`);
    assert(payload.code === code, `${error.code} became ${payload.code}`);
    if (status === 500) {
      assert(!String(payload.error).includes("internal detail"), "internal error leaked");
    }
  }
});

Deno.test("the farewell is forwarded with its message and needs one", async () => {
  const calls: Call[] = [];
  const sent = await handleRenewalStageRequest(
    request({
      action: "farewell_sent",
      expected_updated_at: UPDATED_AT,
      message: "Obrigado por treinar com a gente!",
    }, { idempotencyKey: "rs:farewell_sent:test:0001" }),
    PATH,
    client(calls),
    ACTOR_ID,
  );
  const empty = await handleRenewalStageRequest(
    request({
      action: "farewell_sent",
      expected_updated_at: UPDATED_AT,
      message: "   ",
    }, { idempotencyKey: "rs:farewell_sent:test:0002" }),
    PATH,
    client(calls),
    ACTOR_ID,
  );

  assert(sent?.status === 200, "farewell was not accepted");
  assert(calls[0].args.p_action === "farewell_sent", "farewell action changed");
  assert(calls[0].args.p_message === "Obrigado por treinar com a gente!", "farewell message changed");
  assert(empty?.status === 400, "an empty farewell was accepted");
  assert(calls.length === 1, "the empty farewell reached the database");
});
