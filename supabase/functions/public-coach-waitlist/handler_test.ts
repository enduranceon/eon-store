import { handlePublicCoachWaitlist, type WaitlistDeps } from "./handler.ts";
import { TurnstileUnavailableError } from "../_shared/turnstile.ts";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const COACH_ID = "22222222-2222-4222-8222-222222222222";
const MODALITY_ID = "33333333-3333-4333-8333-333333333333";
const ENTRY_ID = "44444444-4444-4444-8444-444444444444";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Call = { name: string; args: Record<string, unknown> };

function deps(
  options: {
    data?: unknown;
    error?: { code?: string; message?: string } | null;
    turnstile?: boolean | "down";
  } = {},
) {
  const calls: Call[] = [];
  let turnstileCalls = 0;
  const value: WaitlistDeps = {
    createServiceClient: () => ({
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data: options.data === undefined
            ? { status: "created", entry_id: ENTRY_ID, request_id: REQUEST_ID, submitted_at: "2026-10-13T12:00:00Z" }
            : options.data,
          error: options.error ?? null,
        });
      },
    }),
    verifyTurnstile: () => {
      turnstileCalls += 1;
      if (options.turnstile === "down") return Promise.reject(new TurnstileUnavailableError());
      return Promise.resolve(options.turnstile ?? true);
    },
    hashSalt: () => "salt",
  };
  return { value, calls, turnstileCalls: () => turnstileCalls };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://example.test", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://www.enduranceon.com.br", ...headers },
    body: JSON.stringify(body),
  });
}

const VALID = {
  request_id: REQUEST_ID,
  coach_id: COACH_ID,
  modality_id: MODALITY_ID,
  full_name: "  Pessoa   Fictícia ",
  whatsapp: "(48) 99999-0401",
  email: "Pessoa@Example.test",
  region: "online",
  notes: "Prefiro treinar de manhã",
  turnstile_token: "token",
  landing_page: "https://www.enduranceon.com.br/coach",
  utm: { utm_source: "instagram" },
};

Deno.test("waitlist sends the normalized person to the database function", async () => {
  const mock = deps();
  const response = await handlePublicCoachWaitlist(post(VALID), mock.value);
  assert(response.status === 201, `expected 201, received ${response.status}`);
  const body = await response.json();
  assert(body.ok === true && body.status === "created", "receipt was not returned");
  assert(body.request_id === REQUEST_ID, "request id was lost");
  assert(!("entry_id" in body), "internal id leaked to the site");
  assert(mock.calls.length === 1 && mock.calls[0].name === "submit_public_coach_waitlist", "wrong rpc");
  const args = mock.calls[0].args;
  assert(args.p_full_name === "Pessoa Fictícia", "name was not cleaned");
  assert(args.p_whatsapp === "+5548999990401", "phone was not normalized");
  assert(args.p_email === "pessoa@example.test", "e-mail was not lowered");
  assert(args.p_region === "online" && args.p_modality_id === MODALITY_ID, "selection was lost");
  assert(typeof args.p_ip_hash === "string" && (args.p_ip_hash as string).length === 64, "ip was not hashed");
  assert(response.headers.get("access-control-allow-origin") === "https://www.enduranceon.com.br", "cors");
});

Deno.test("waitlist accepts optional fields empty and replays as duplicate", async () => {
  const mock = deps({
    data: { status: "duplicate", entry_id: ENTRY_ID, request_id: REQUEST_ID, submitted_at: "2026-10-13T12:00:00Z" },
  });
  const response = await handlePublicCoachWaitlist(
    post({ ...VALID, modality_id: "", email: "", region: "", notes: "" }),
    mock.value,
  );
  assert(response.status === 200, `expected 200, received ${response.status}`);
  assert((await response.json()).status === "duplicate", "duplicate was not reported");
  const args = mock.calls[0].args;
  assert(args.p_modality_id === null && args.p_email === null && args.p_region === null, "empty optionals");
});

Deno.test("waitlist rejects bad fields, honeypot and failed checks before the database", async () => {
  const invalid = deps();
  const response = await handlePublicCoachWaitlist(
    post({ ...VALID, whatsapp: "123", email: "x@", region: "lua", coach_id: "x" }),
    invalid.value,
  );
  assert(response.status === 400, "invalid fields were accepted");
  const fields = (await response.json()).field_errors.map((item: { field: string }) => item.field).sort();
  assert(JSON.stringify(fields) === JSON.stringify(["coach_id", "email", "region", "whatsapp"]), `fields ${fields}`);
  assert(invalid.turnstileCalls() === 0 && invalid.calls.length === 0, "checks ran for invalid data");

  const bot = deps();
  assert((await handlePublicCoachWaitlist(post({ ...VALID, website: "spam" }), bot.value)).status === 400, "bot");
  assert(bot.calls.length === 0, "honeypot reached the database");

  const expired = deps({ turnstile: false });
  assert((await handlePublicCoachWaitlist(post(VALID), expired.value)).status === 403, "turnstile");
  const down = deps({ turnstile: "down" });
  assert((await handlePublicCoachWaitlist(post(VALID), down.value)).status === 503, "turnstile down");
  assert(expired.calls.length === 0 && down.calls.length === 0, "unverified request reached the database");
});

Deno.test("waitlist only answers the site, by POST", async () => {
  const mock = deps();
  const foreign = await handlePublicCoachWaitlist(post(VALID, { origin: "https://evil.example" }), mock.value);
  assert(foreign.status === 403, "foreign origin was accepted");
  const preflight = await handlePublicCoachWaitlist(
    new Request("https://example.test", { method: "OPTIONS", headers: { origin: "https://enduranceon.com.br" } }),
    mock.value,
  );
  assert(preflight.status === 204, "preflight failed");
  const get = await handlePublicCoachWaitlist(new Request("https://example.test"), mock.value);
  assert(get.status === 405, "GET was accepted");
  assert(mock.calls.length === 0, "database was called");
});

Deno.test("waitlist maps database refusals without leaking details", async () => {
  const cases: Array<[{ code: string; message: string }, number, string]> = [
    [{ code: "P0001", message: "Muitas tentativas. Aguarde antes de enviar novamente" }, 429, "RATE_LIMITED"],
    [{ code: "P0001", message: "Esta chave de envio já foi usada com outros dados" }, 409, "IDEMPOTENCY_KEY_CONFLICT"],
    [{ code: "P0002", message: "Coach indisponível" }, 422, "INVALID_SELECTION"],
    [{ code: "XX000", message: "secret internal detail" }, 500, "SUBMISSION_FAILED"],
  ];
  for (const [error, status, code] of cases) {
    const response = await handlePublicCoachWaitlist(post(VALID), deps({ error, data: null }).value);
    assert(response.status === status, `${error.code} returned ${response.status}`);
    const text = await response.text();
    assert(JSON.parse(text).code === code, `${error.code} returned the wrong code`);
    assert(!text.includes("secret"), "database detail leaked");
  }
  const malformed = await handlePublicCoachWaitlist(post(VALID), deps({ data: { status: "created" } }).value);
  assert(malformed.status === 500, "a missing receipt was reported as success");
});
