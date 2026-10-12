import { handleCoachMatchAdmin } from "./handler.ts";
import { coachMatchTokenHash, COACH_MATCH_TOKEN } from "../_shared/coach-match-token.ts";
import { ADMIN_ID, assert, COACH_ID, equal, post, RECORD_ID, rpcMock } from "../coach-match-form/test-utils.ts";

const URL = `https://example.test/functions/v1/coach-match-admin/coach-match/${COACH_ID}`;
const requireAdmin = () => Promise.resolve({ ok: true, status: 200, userId: ADMIN_ID });

Deno.test("coach match admin gate runs before creating a privileged client", async () => {
  for (const gate of [{ ok: false, status: 401 }, { ok: false, status: 403 }, { ok: true, status: 200 }]) {
    const deps = rpcMock();
    const response = await handleCoachMatchAdmin(post({}, `${URL}/invite`), { ...deps, requireAdmin: () => Promise.resolve(gate) });
    equal(response.status, gate.ok ? 403 : gate.status);
    equal(deps.factories(), 0);
    equal(deps.calls, []);
  }
});

Deno.test("admin load returns separate latest and published versions from one RPC", async () => {
  const data = { coach: { id: COACH_ID }, latest: { status: "pending" }, published: { status: "approved" }, invites: [] };
  const deps = rpcMock(data);
  const response = await handleCoachMatchAdmin(new Request(URL), { ...deps, requireAdmin });
  equal(response.status, 200);
  equal(await response.json(), { data });
  equal(deps.calls, [{ name: "get_assessment_coach_match_admin", args: { p_coach_id: COACH_ID } }]);
});

Deno.test("admin invite returns token only to caller and passes admin identity and digest to atomic RPC", async () => {
  const deps = rpcMock({ id: RECORD_ID });
  const response = await handleCoachMatchAdmin(post({ created_by: "forged" }, `${URL}/invite`), { ...deps, requireAdmin });
  equal(response.status, 200);
  const { data } = await response.json();
  assert(COACH_MATCH_TOKEN.test(data.token));
  equal(data.id, RECORD_ID);
  equal(deps.calls.length, 1);
  equal(deps.calls[0], { name: "issue_assessment_coach_match_invite", args: {
    p_coach_id: COACH_ID, p_token_hash: await coachMatchTokenHash(data.token),
    p_expires_at: data.expires_at, p_created_by: ADMIN_ID,
  } });
  assert(!JSON.stringify(deps.calls).includes(data.token));
  assert(Date.parse(data.expires_at) > Date.now() + 29 * 86_400_000);
});

Deno.test("admin revoke and review use only match RPCs with authenticated reviewer identity", async () => {
  const deps = rpcMock({ status: "approved" });
  equal((await handleCoachMatchAdmin(post({ invite_id: RECORD_ID }, `${URL}/revoke`), { ...deps, requireAdmin })).status, 200);
  equal((await handleCoachMatchAdmin(post({ submission_id: RECORD_ID, decision: "approved", reviewed_by: "forged" }, `${URL}/review`), { ...deps, requireAdmin })).status, 200);
  equal(deps.calls, [
    { name: "revoke_assessment_coach_match_invite", args: { p_coach_id: COACH_ID, p_invite_id: RECORD_ID } },
    { name: "review_assessment_coach_match_submission", args: { p_coach_id: COACH_ID, p_submission_id: RECORD_ID, p_decision: "approved", p_reviewed_by: ADMIN_ID } },
  ]);
});

Deno.test("admin refuses stale review via atomic RPC and redacts database error details", async () => {
  for (const [code, status] of [["PT409", 409], ["PT404", 404], ["42P01", 500]] as const) {
    const deps = rpcMock(null, { code, message: "secret table name" });
    const response = await handleCoachMatchAdmin(post({ submission_id: RECORD_ID, decision: "approved" }, `${URL}/review`), { ...deps, requireAdmin });
    equal(response.status, status);
    assert(!(await response.text()).includes("secret"));
    equal(deps.calls.length, 1);
  }
});

Deno.test("admin rejects invalid IDs, method, action, payload before RPC", async () => {
  const deps = rpcMock();
  const requests: [Request, number][] = [
    [new Request(URL.replace(COACH_ID, "invalid")), 400],
    [new Request(`${URL}/invite`), 405],
    [post({}, `${URL}/delete`), 404],
    [post(null, `${URL}/invite`), 400],
    [post({ invite_id: "invalid" }, `${URL}/revoke`), 400],
    [post({ submission_id: RECORD_ID, decision: "pending" }, `${URL}/review`), 400],
    [post({ submission_id: RECORD_ID, decision: ["approved"] }, `${URL}/review`), 400],
    [post({ huge: "x".repeat(9000) }, `${URL}/review`), 413],
  ];
  for (const [request, status] of requests) equal((await handleCoachMatchAdmin(request, { ...deps, requireAdmin })).status, status);
  equal(deps.calls, []);
  equal(deps.factories(), 0);
});

Deno.test("admin preflight bypasses auth but no data; missing service and thrown gate fail closed", async () => {
  const deps = rpcMock();
  let gates = 0;
  equal((await handleCoachMatchAdmin(new Request(URL, { method: "OPTIONS" }), { ...deps, requireAdmin() { gates++; throw new Error("unexpected"); } })).status, 204);
  equal(gates, 0);
  equal(deps.factories(), 0);
  equal((await handleCoachMatchAdmin(new Request(URL), { requireAdmin, createServiceClient: () => null })).status, 503);
  equal((await handleCoachMatchAdmin(new Request(URL), { ...deps, requireAdmin() { throw new Error("auth down"); } })).status, 500);
  equal(deps.factories(), 0);
});
