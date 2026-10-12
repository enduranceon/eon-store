import { handleCoachMatchForm } from "./handler.ts";
import { coachMatchTokenHash, COACH_MATCH_TOKEN, newCoachMatchToken } from "../_shared/coach-match-token.ts";
import { ANSWERS, assert, equal, LEGACY_ANSWERS, post, RECORD_ID, rpcMock, TOKEN } from "./test-utils.ts";

Deno.test("coach form rejects malformed, missing and forged requests before database access", async () => {
  const deps = rpcMock();
  for (const body of [null, [], {}, { action: "load", token: "invalid" }, { action: "approve", token: TOKEN },
    { action: ["load"], token: TOKEN },
    { action: "load", token: TOKEN, profile_version: 1 },
    { action: "submit", token: TOKEN, answers: ANSWERS },
    { action: "submit", token: TOKEN, profile_version: 2, answers: LEGACY_ANSWERS },
    { action: "submit", token: TOKEN, profile_version: 2, answers: { ...ANSWERS,
      focus_goals: { primary: "performance", secondary: "performance" } } }]) {
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

Deno.test("coach form load defaults legacy clients to v1 and selects v2 only explicitly", async () => {
  const data = { coach: { name: "Coach de teste", modalities: [{ id: RECORD_ID, name: "Corrida" }] },
    latest: null, expires_at: "2026-11-01T12:00:00Z" };
  const deps = rpcMock(data);
  const legacyResponse = await handleCoachMatchForm(post({ action: "load", token: TOKEN }), deps);
  const v2Response = await handleCoachMatchForm(post({ action: "load", token: TOKEN, profile_version: 2 }), deps);
  equal(legacyResponse.status, 200);
  equal(v2Response.status, 200);
  equal(await legacyResponse.json(), { data });
  equal(await v2Response.json(), { data });
  equal(deps.calls, [
    { name: "load_assessment_coach_match_form", args: { p_token_hash: await coachMatchTokenHash(TOKEN) } },
    { name: "load_assessment_coach_match_form_v2", args: { p_token_hash: await coachMatchTokenHash(TOKEN) } },
  ]);
  equal(v2Response.headers.get("cache-control"), "no-store");
  equal(v2Response.headers.get("referrer-policy"), "no-referrer");
});

Deno.test("coach form submit defaults legacy clients to v1 and sends explicit v2 to its atomic RPC", async () => {
  const data = { received: true, id: "test", submitted_at: "2026-10-12T12:00:00Z" };
  const deps = rpcMock(data);
  const legacyResponse = await handleCoachMatchForm(post({
    action: "submit", token: TOKEN, answers: LEGACY_ANSWERS,
  }), deps);
  const v2Response = await handleCoachMatchForm(post({
    action: "submit", token: TOKEN, coach_id: "forged", status: "approved",
    profile_version: 2, answers: ANSWERS,
  }), deps);
  equal(legacyResponse.status, 200);
  equal(v2Response.status, 200);
  equal(await legacyResponse.json(), { data });
  equal(await v2Response.json(), { data });
  equal(deps.calls, [
    { name: "submit_assessment_coach_match_answers", args: { p_token_hash: await coachMatchTokenHash(TOKEN), p_answers: LEGACY_ANSWERS } },
    { name: "submit_assessment_coach_match_answers_v2", args: { p_token_hash: await coachMatchTokenHash(TOKEN), p_answers: ANSWERS } },
  ]);
});

Deno.test("coach form maps expired/revoked, rate-limited and database errors without leaking details", async () => {
  for (const [code, status] of [["PT410", 410], ["PT429", 429], ["PT400", 400], ["PT404", 404], ["42501", 500]] as const) {
    const deps = rpcMock(null, { code, message: "secret database information" });
    const response = await handleCoachMatchForm(post({
      action: "submit", token: TOKEN, profile_version: 2, answers: ANSWERS,
    }), deps);
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
