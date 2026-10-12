import { handlePublicCoachMatch } from "./handler.ts";
import { ANSWERS, assert, COACH_ID, equal, LEGACY_ANSWERS, rpcMock } from "../coach-match-form/test-utils.ts";

Deno.test("public match exposes only allowlisted approved profile fields, never internal fields or token", async () => {
  const reviewedAt = "2026-10-12T12:00:00Z";
  const deps = rpcMock([
    { coach_id: COACH_ID, answers: LEGACY_ANSWERS, reviewed_at: reviewedAt, token_hash: "secret", reviewed_by: "secret" },
    { coach_id: COACH_ID, answers: ANSWERS, reviewed_at: reviewedAt },
    { coach_id: "bad", answers: LEGACY_ANSWERS, reviewed_at: reviewedAt },
    { coach_id: COACH_ID, answers: LEGACY_ANSWERS, reviewed_at: null },
  ]);
  const response = await handlePublicCoachMatch(new Request("https://example.test"), deps);
  equal(response.status, 200);
  equal(await response.json(), { data: [{ coach_id: COACH_ID, answers: LEGACY_ANSWERS, reviewed_at: reviewedAt }] });
  equal(deps.calls, [{ name: "list_public_coach_match_profiles" }]);
  equal(response.headers.get("cache-control"), "no-store");
});

Deno.test("public match empty catalog is valid and unavailable or malformed RPC is not an empty success", async () => {
  const response = await handlePublicCoachMatch(new Request("https://example.test"), rpcMock([]));
  equal(await response.json(), { data: [] });
  for (const deps of [rpcMock(null), rpcMock(null, { code: "42P01", message: "secret schema" })]) {
    const failed = await handlePublicCoachMatch(new Request("https://example.test"), deps);
    equal(failed.status, 500);
    assert(!(await failed.text()).includes("secret"));
  }
  equal((await handlePublicCoachMatch(new Request("https://example.test"), { createServiceClient: () => null })).status, 503);
});

Deno.test("public match accepts only GET and preflight, never writes", async () => {
  const deps = rpcMock();
  equal((await handlePublicCoachMatch(new Request("https://example.test", { method: "OPTIONS" }), deps)).status, 204);
  for (const method of ["POST", "PUT", "DELETE"]) {
    equal((await handlePublicCoachMatch(new Request("https://example.test", { method }), deps)).status, 405);
  }
  equal(deps.calls, []);
  equal(deps.factories(), 0);
});
