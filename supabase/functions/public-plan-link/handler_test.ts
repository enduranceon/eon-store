import { allowedOrigin, handlePublicPlanLink, type PlanLinkDeps } from "./handler.ts";

const TOKEN = "linkcorridateste0001";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";
const COACH_ID = "33333333-3333-4333-8333-333333333333";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Call = { name: string; args: Record<string, unknown> };

function deps(data: unknown, error: { code?: string; message?: string } | null = null) {
  const calls: Call[] = [];
  const value: PlanLinkDeps = {
    createServiceClient: () => ({
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data, error });
      },
    }),
    hashSalt: () => "salt",
  };
  return { value, calls };
}

const ORIGIN = { origin: "https://eon-store.netlify.app" };

function post(body: unknown, headers: Record<string, string> = ORIGIN) {
  return new Request("https://example.test", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const VALID = {
  token: TOKEN,
  request_id: REQUEST_ID,
  plan_id: PLAN_ID,
  coach_id: COACH_ID,
  full_name: "  pessoa   link fictícia ",
  whatsapp: "(48) 99999-0601",
  email: "Pessoa@Example.test",
  cpf: "529.982.247-25",
  region: "online",
  address_zip: "88000-000",
  address_street: "Rua Fictícia",
  address_number: "10",
  address_complement: "",
  address_neighborhood: "Centro",
  address_city: "Florianópolis",
  address_state: "sc",
  confirmed: true,
};

Deno.test("plan link shows the plan of a valid link and nothing for an unknown one", async () => {
  const found = deps({ family: { name: "Corrida - Essencial" }, options: [], coach: null, coaches: [] });
  const response = await handlePublicPlanLink(
    new Request(`https://example.test/?token=${TOKEN}&coach=${COACH_ID}`, { headers: ORIGIN }),
    found.value,
  );
  assert(response.status === 200, `expected 200, received ${response.status}`);
  assert((await response.json()).family.name === "Corrida - Essencial", "plan was not returned");
  assert(found.calls[0].name === "get_plan_link" && found.calls[0].args.p_coach_id === COACH_ID, "wrong lookup");

  const missing = deps(null);
  const gone = await handlePublicPlanLink(new Request(`https://example.test/?token=${TOKEN}`, { headers: ORIGIN }), missing.value);
  assert(gone.status === 404, "unknown link was found");
  assert(missing.calls[0].args.p_coach_id === null, "missing coach was not null");

  const bad = deps(null);
  const malformed = await handlePublicPlanLink(new Request("https://example.test/?token=../x", { headers: ORIGIN }), bad.value);
  assert(malformed.status === 404 && bad.calls.length === 0, "malformed link reached the database");
});

Deno.test("plan link sends the normalized person to the database", async () => {
  const mock = deps({ status: "created", contract_id: "x", request_id: REQUEST_ID, submitted_at: "2026-10-13T12:00:00Z" });
  const response = await handlePublicPlanLink(post(VALID), mock.value);
  assert(response.status === 201, `expected 201, received ${response.status}`);
  const body = await response.json();
  assert(body.ok === true && body.status === "created" && !("contract_id" in body), "receipt leaked internal ids");
  const args = mock.calls[0].args;
  assert(mock.calls[0].name === "submit_plan_link_prospect", "wrong rpc");
  assert(args.p_full_name === "pessoa link fictícia", "name was not cleaned");
  assert(args.p_whatsapp === "+5548999990601" && args.p_cpf === "52998224725", "phone or cpf not normalized");
  assert(args.p_email === "pessoa@example.test" && args.p_address_state === "SC", "email or state not normalized");
  assert(args.p_address_zip === "88000000" && args.p_region === "online", "address not normalized");
  assert(typeof args.p_ip_hash === "string" && (args.p_ip_hash as string).length === 64, "ip not hashed");
});

Deno.test("plan link refuses bad fields, missing confirmation and the honeypot before the database", async () => {
  const mock = deps({});
  const response = await handlePublicPlanLink(
    post({ ...VALID, cpf: "111.111.111-11", email: "x@", address_zip: "123", confirmed: false }),
    mock.value,
  );
  assert(response.status === 400, "invalid data was accepted");
  const fields = (await response.json()).field_errors.map((item: { field: string }) => item.field).sort();
  assert(JSON.stringify(fields) === JSON.stringify(["address_zip", "confirmed", "cpf", "email"]), `fields ${fields}`);
  const bot = await handlePublicPlanLink(post({ ...VALID, website: "spam" }), mock.value);
  assert(bot.status === 400, "honeypot was accepted");
  assert(mock.calls.length === 0, "database was called");
});

Deno.test("plan link only answers the store pages", async () => {
  assert(allowedOrigin("https://eon-store.netlify.app"), "production page");
  assert(allowedOrigin("https://deploy-preview-12--eon-store.netlify.app"), "preview page");
  assert(allowedOrigin("http://localhost:5173"), "local page");
  assert(!allowedOrigin("https://eon-store.netlify.app.evil.test"), "lookalike origin");
  assert(!allowedOrigin("https://evil--eon-store.netlify.app.test"), "lookalike preview");
  const mock = deps({});
  const foreign = await handlePublicPlanLink(post(VALID, { origin: "https://evil.example" }), mock.value);
  assert(foreign.status === 403 && mock.calls.length === 0, "foreign origin reached the database");
  const preflight = await handlePublicPlanLink(new Request("https://example.test", { method: "OPTIONS", headers: ORIGIN }), mock.value);
  assert(preflight.status === 204, "preflight failed");
  const put = await handlePublicPlanLink(new Request("https://example.test", { method: "PUT", headers: ORIGIN }), mock.value);
  assert(put.status === 405, "PUT was accepted");
});

Deno.test("plan link maps database refusals without leaking details", async () => {
  const cases: Array<[{ code: string; message: string }, number, string]> = [
    [{ code: "P0001", message: "Muitas tentativas. Aguarde antes de enviar novamente" }, 429, "RATE_LIMITED"],
    [{ code: "P0001", message: "CPF duplicado no cadastro interno; atendimento manual necessário" }, 409, "MANUAL_REVIEW_REQUIRED"],
    [{ code: "P0002", message: "Link indisponível" }, 404, "LINK_UNAVAILABLE"],
    [{ code: "P0002", message: "Plano indisponível" }, 422, "INVALID_SELECTION"],
    [{ code: "P0002", message: "Treinador indisponível para este plano" }, 422, "INVALID_SELECTION"],
    [{ code: "XX000", message: "secret internal detail" }, 500, "SUBMISSION_FAILED"],
  ];
  for (const [error, status, code] of cases) {
    const response = await handlePublicPlanLink(post(VALID), deps(null, error).value);
    assert(response.status === status, `${error.message} returned ${response.status}`);
    const text = await response.text();
    assert(JSON.parse(text).code === code, `${error.message} returned the wrong code`);
    assert(!text.includes("secret") && !text.includes("CPF duplicado"), "database detail leaked");
  }
});
