import { type ContactDeps, handlePublicContactRequest } from "./handler.ts";
import { TurnstileUnavailableError } from "../_shared/turnstile.ts";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

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
  const value: ContactDeps = {
    createServiceClient: () => ({
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data: options.data === undefined
            ? { status: "created", request_id: REQUEST_ID, submitted_at: "2026-10-28T12:00:00Z" }
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
  full_name: "  Pessoa   Fictícia ",
  whatsapp: "(48) 99999-0601",
  email: "Pessoa@Example.test",
  subject: "  Dúvida   sobre planos ",
  message: "Gostaria de entender como funciona o acompanhamento.\nObrigada!",
  turnstile_token: "token",
  landing_page: "https://www.enduranceon.com.br/contato",
  utm: { utm_source: "instagram" },
};

Deno.test("contact sends the normalized message to the database function", async () => {
  const mock = deps();
  const response = await handlePublicContactRequest(post(VALID), mock.value);
  assert(response.status === 201, `expected 201, received ${response.status}`);
  const body = await response.json();
  assert(body.ok === true && body.status === "created", "receipt was not returned");
  assert(body.request_id === REQUEST_ID, "request id was lost");
  assert(mock.calls.length === 1 && mock.calls[0].name === "submit_public_contact_request", "wrong rpc");
  const args = mock.calls[0].args;
  assert(args.p_full_name === "Pessoa Fictícia", "name was not cleaned");
  assert(args.p_whatsapp === "+5548999990601", "phone was not normalized");
  assert(args.p_email === "pessoa@example.test", "e-mail was not lowered");
  assert(args.p_subject === "Dúvida sobre planos", "subject was not cleaned");
  assert(args.p_message === "Gostaria de entender como funciona o acompanhamento.\nObrigada!", "line breaks were lost");
  assert(typeof args.p_ip_hash === "string" && (args.p_ip_hash as string).length === 64, "ip was not hashed");
  assert(response.headers.get("access-control-allow-origin") === "https://www.enduranceon.com.br", "cors");
});

Deno.test("contact accepts the e-mail empty and replays as duplicate", async () => {
  const mock = deps({
    data: { status: "duplicate", request_id: REQUEST_ID, submitted_at: "2026-10-28T12:00:00Z" },
  });
  const response = await handlePublicContactRequest(post({ ...VALID, email: "" }), mock.value);
  assert(response.status === 200, `expected 200, received ${response.status}`);
  assert((await response.json()).status === "duplicate", "duplicate was not reported");
  assert(mock.calls[0].args.p_email === null, "empty e-mail was not stored as null");
});

Deno.test("contact rejects bad fields, honeypot and failed checks before the database", async () => {
  const invalid = deps();
  const response = await handlePublicContactRequest(
    post({ ...VALID, whatsapp: "123", email: "x@", subject: "ab", message: "curta", full_name: "Jo" }),
    invalid.value,
  );
  assert(response.status === 400, "invalid fields were accepted");
  const fields = (await response.json()).field_errors.map((item: { field: string }) => item.field).sort();
  assert(
    JSON.stringify(fields) === JSON.stringify(["email", "full_name", "message", "subject", "whatsapp"]),
    `fields ${fields}`,
  );
  assert(invalid.turnstileCalls() === 0 && invalid.calls.length === 0, "checks ran for invalid data");

  const long = deps();
  const tooLong = await handlePublicContactRequest(post({ ...VALID, message: "a".repeat(1_501) }), long.value);
  assert(tooLong.status === 400, "a message over the limit was accepted");
  assert((await tooLong.json()).field_errors[0].code === "INVALID_MESSAGE", "wrong code for the long message");
  assert(long.calls.length === 0, "a long message reached the database");

  const bot = deps();
  assert((await handlePublicContactRequest(post({ ...VALID, website: "spam" }), bot.value)).status === 400, "bot");
  assert(bot.calls.length === 0, "honeypot reached the database");

  const expired = deps({ turnstile: false });
  assert((await handlePublicContactRequest(post(VALID), expired.value)).status === 403, "turnstile");
  const down = deps({ turnstile: "down" });
  assert((await handlePublicContactRequest(post(VALID), down.value)).status === 503, "turnstile down");
  assert(expired.calls.length === 0 && down.calls.length === 0, "unverified request reached the database");
});

Deno.test("contact only answers the site, by POST", async () => {
  const mock = deps();
  const foreign = await handlePublicContactRequest(post(VALID, { origin: "https://evil.example" }), mock.value);
  assert(foreign.status === 403, "foreign origin was accepted");
  const staging = await handlePublicContactRequest(post(VALID, { origin: "https://eon-novo.netlify.app" }), mock.value);
  assert(staging.status === 403, "the test site must not reach the production database");
  const preflight = await handlePublicContactRequest(
    new Request("https://example.test", { method: "OPTIONS", headers: { origin: "https://enduranceon.com.br" } }),
    mock.value,
  );
  assert(preflight.status === 204, "preflight failed");
  const get = await handlePublicContactRequest(new Request("https://example.test"), mock.value);
  assert(get.status === 405, "GET was accepted");
  assert(mock.calls.length === 0, "database was called");
});

Deno.test("contact maps database refusals without leaking details", async () => {
  const cases: Array<[{ code: string; message: string }, number, string]> = [
    [{ code: "P0001", message: "Muitas tentativas. Aguarde antes de enviar novamente" }, 429, "RATE_LIMITED"],
    [{ code: "P0001", message: "Este telefone já enviou vários cadastros hoje" }, 429, "RATE_LIMITED"],
    [{ code: "P0001", message: "Esta chave de envio já foi usada com outros dados" }, 409, "IDEMPOTENCY_KEY_CONFLICT"],
    [{ code: "22023", message: "Dados obrigatórios inválidos" }, 400, "VALIDATION_ERROR"],
    [{ code: "XX000", message: "secret internal detail" }, 500, "SUBMISSION_FAILED"],
  ];
  for (const [error, status, code] of cases) {
    const response = await handlePublicContactRequest(post(VALID), deps({ error, data: null }).value);
    assert(response.status === status, `${error.code} returned ${response.status}`);
    const text = await response.text();
    assert(JSON.parse(text).code === code, `${error.code} returned the wrong code`);
    assert(!text.includes("secret"), "database detail leaked");
  }
  const malformed = await handlePublicContactRequest(post(VALID), deps({ data: { status: "created" } }).value);
  assert(malformed.status === 500, "a missing receipt was reported as success");
});
