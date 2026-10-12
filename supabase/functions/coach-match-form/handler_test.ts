import { handleCoachMatchForm } from "./handler.ts";
import { coachMatchTokenHash, COACH_MATCH_TOKEN, newCoachMatchToken } from "../_shared/coach-match-token.ts";
import { ANSWERS, assert, equal, post, rpcMock, TOKEN } from "./test-utils.ts";

Deno.test("coach form rejects malformed, missing and forged requests before database access", async () => {
  const deps = rpcMock();
  for (const body of [null, [], {}, { action: "load", token: "invalid" }, { action: "approve", token: TOKEN },
    { action: ["load"], token: TOKEN },
    { action: "submit", token: TOKEN, answers: { ...ANSWERS, version: 2 } },
    { action: "submit", token: TOKEN, answers: { ...ANSWERS, focus_goals: ["start", "start"] } }]) {
    equal((await handleCoachMatchForm(post(body), deps)).status, 400);
  }
  equal((await handleCoachMatchForm(new Request("https://example.test", { method: "POST", body: "{" }), deps)).status, 400);
  equal(deps.calls, []);
  equal(deps.factories(), 0);
});

Deno.test("coach form measures streamed UTF-8 bytes even with absent or misleading content length", async () => {
  for (const headers of [new Headers(), new Headers({ "Content-Length": "10" })]) {
    const deps = rpcMock();
    let canceled = false;
    const encoded = new TextEncoder().encode(JSON.stringify({ action: "load", token: TOKEN, extra: "á".repeat(5_000) }));
    let offset = 0;
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(encoded.slice(offset, offset + 500));
        offset += 500;
        if (offset >= encoded.length) controller.close();
      },
      cancel() { canceled = true; },
    });
    const response = await handleCoachMatchForm(new Request("https://example.test", { method: "POST", headers, body: stream }), deps);
    equal(response.status, 413);
    assert(canceled, "Oversize stream must stop being consumed");
    equal(deps.calls, []);
  }
});

Deno.test("coach form load uses only digest and the atomic load RPC", async () => {
  const data = { coach: { name: "Coach de teste" }, latest: null, expires_at: "2026-11-01T12:00:00Z" };
  const deps = rpcMock(data);
  const response = await handleCoachMatchForm(post({ action: "load", token: TOKEN }), deps);
  equal(response.status, 200);
  equal(await response.json(), { data });
  equal(deps.calls, [{ name: "load_assessment_coach_match_form", args: { p_token_hash: await coachMatchTokenHash(TOKEN) } }]);
  equal(response.headers.get("cache-control"), "no-store");
  equal(response.headers.get("referrer-policy"), "no-referrer");
});

Deno.test("coach form submit strips injected status/coach and sends only validated answers to atomic RPC", async () => {
  const data = { received: true, id: "test", submitted_at: "2026-10-12T12:00:00Z" };
  const deps = rpcMock(data);
  const response = await handleCoachMatchForm(post({
    action: "submit", token: TOKEN, coach_id: "forged", status: "approved",
    answers: { ...ANSWERS, approach: `  ${ANSWERS.approach}  `, status: "approved", internal_note: "private" },
  }), deps);
  equal(response.status, 200);
  equal(await response.json(), { data });
  equal(deps.calls, [{ name: "submit_assessment_coach_match_answers", args: { p_token_hash: await coachMatchTokenHash(TOKEN), p_answers: ANSWERS } }]);
});

Deno.test("coach form maps expired/revoked, rate-limited and database errors without leaking details", async () => {
  for (const [code, status] of [["PT410", 410], ["PT429", 429], ["PT400", 400], ["PT404", 404], ["42501", 500]] as const) {
    const deps = rpcMock(null, { code, message: "secret database information" });
    const response = await handleCoachMatchForm(post({ action: "submit", token: TOKEN, answers: ANSWERS }), deps);
    equal(response.status, status);
    assert(!(await response.text()).includes("secret"));
    equal(deps.calls.length, 1);
  }
});

Deno.test("coach form handles preflight, methods and unavailable backend without unintended calls", async () => {
  const deps = rpcMock();
  equal((await handleCoachMatchForm(new Request("https://example.test", { method: "OPTIONS" }), deps)).status, 204);
  equal((await handleCoachMatchForm(new Request("https://example.test"), deps)).status, 405);
  equal(deps.factories(), 0);
  equal((await handleCoachMatchForm(post({ action: "load", token: TOKEN }), { createServiceClient: () => null })).status, 503);
  const response = await handleCoachMatchForm(post({ action: "load", token: TOKEN }), { createServiceClient() { throw new Error("secret"); } });
  equal(response.status, 500);
  assert(!(await response.text()).includes("secret"));
});

Deno.test("coach invitation tokens have independent random values and SHA-256 digests", async () => {
  const one = newCoachMatchToken();
  const two = newCoachMatchToken();
  assert(COACH_MATCH_TOKEN.test(one) && COACH_MATCH_TOKEN.test(two));
  assert(one !== two);
  const digest = await coachMatchTokenHash(one);
  assert(/^[0-9a-f]{64}$/.test(digest));
  equal(await coachMatchTokenHash(one), digest);
  assert(digest !== await coachMatchTokenHash(two));
});
