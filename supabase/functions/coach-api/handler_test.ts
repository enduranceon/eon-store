import { handleCoachApi } from "./handler.ts";
import type { CoachApiDeps, RpcResult } from "./handler.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "99999999-9999-4999-8999-999999999999";
const EVENT_ID = "7838481a-f3f8-42b2-a462-fb3f32e5ab11";
const REGISTRATION_ID = "8a38481a-f3f8-42b2-a462-fb3f32e5ab22";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function request(path: string, method = "GET", body?: unknown) {
  return new Request(`https://example.test/functions/v1/coach-api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function deps(options: {
  authorized?: boolean;
  result?: RpcResult;
} = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const fake: CoachApiDeps = {
    authenticate: () =>
      Promise.resolve(
        options.authorized === false
          ? { ok: false as const, status: 401, error: "invalid_token" }
          : { ok: true as const, userId: USER_ID },
      ),
    rpc(name, args) {
      calls.push({ name, args });
      return Promise.resolve(options.result ?? { data: { ok: true }, error: null });
    },
    loadPanel: () => Promise.resolve(null),
  };
  return { fake, calls };
}

Deno.test("sem sessão válida nada chega ao banco", async () => {
  const { fake, calls } = deps({ authorized: false });
  for (
    const [path, method] of [
      ["/me", "GET"],
      ["/events", "GET"],
      [`/events/${EVENT_ID}`, "GET"],
      [`/registrations/${REGISTRATION_ID}/whatsapp-group`, "PATCH"],
    ]
  ) {
    const response = await handleCoachApi(
      request(path, method, method === "PATCH" ? { status: "added" } : undefined),
      fake,
    );
    assert(response.status === 401, `${method} ${path}: deve responder 401`);
  }
  assert(calls.length === 0, "nenhuma função do banco pode ser chamada");
});

Deno.test("a identidade vem sempre da sessão, nunca do que o cliente envia", async () => {
  const { fake, calls } = deps();
  await handleCoachApi(request(`/me?user_id=${OTHER_USER}`), fake);
  await handleCoachApi(request(`/events?p_user_id=${OTHER_USER}`), fake);
  await handleCoachApi(request(`/events/${EVENT_ID}?user_id=${OTHER_USER}`), fake);
  await handleCoachApi(
    request(`/registrations/${REGISTRATION_ID}/whatsapp-group`, "PATCH", {
      status: "added",
      user_id: OTHER_USER,
      p_user_id: OTHER_USER,
    }),
    fake,
  );
  assert(calls.length === 4, "as quatro chamadas chegam ao banco");
  for (const call of calls) {
    assert(call.args.p_user_id === USER_ID, `${call.name}: usa o usuário da sessão`);
    assert(
      !JSON.stringify(call.args).includes(OTHER_USER),
      `${call.name}: não repassa o usuário informado pelo cliente`,
    );
  }
});

Deno.test("GET /me, /events e /events/:id chamam as funções certas", async () => {
  const { fake, calls } = deps();
  assert((await handleCoachApi(request("/me"), fake)).status === 200, "/me");
  assert((await handleCoachApi(request("/events"), fake)).status === 200, "/events");
  assert((await handleCoachApi(request(`/events/${EVENT_ID}`), fake)).status === 200, "/events/:id");
  assert(
    calls.map((call) => call.name).join(",") === "coach_me,coach_list_events,coach_get_event",
    "funções chamadas",
  );
  assert(calls[2].args.p_event_id === EVENT_ID, "evento da rota");
});

Deno.test("evento ou inscrição com identificador inválido não chega ao banco", async () => {
  const { fake, calls } = deps();
  const badEvent = await handleCoachApi(request("/events/nao-e-uuid"), fake);
  assert(badEvent.status === 400, "evento inválido");
  const badRegistration = await handleCoachApi(
    request("/registrations/x/whatsapp-group", "PATCH", { status: "added" }),
    fake,
  );
  assert(badRegistration.status === 400, "inscrição inválida");
  assert(calls.length === 0, "nada foi ao banco");
});

Deno.test("PATCH whatsapp-group valida a situação e repassa ao banco", async () => {
  const path = `/registrations/${REGISTRATION_ID}/whatsapp-group`;
  for (const status of ["pending", "added", "declined"]) {
    const { fake, calls } = deps();
    const response = await handleCoachApi(request(path, "PATCH", { status }), fake);
    assert(response.status === 200, `${status}: aceito`);
    assert(calls[0].name === "coach_set_registration_whatsapp_group", "função certa");
    assert(calls[0].args.p_status === status, "situação repassada");
    assert(calls[0].args.p_registration_id === REGISTRATION_ID, "inscrição da rota");
  }
  for (const body of [undefined, {}, { status: "maybe" }, { status: 1 }, []]) {
    const { fake, calls } = deps();
    const response = await handleCoachApi(request(path, "PATCH", body), fake);
    assert(response.status === 400 && calls.length === 0, "situação inválida não chega ao banco");
  }
});

Deno.test("erros do banco viram respostas claras sem vazar detalhes", async () => {
  const cases: Array<[string, number, string]> = [
    ["42501", 403, "forbidden"],
    ["P0002", 404, "not_found"],
    ["P0001", 409, "invalid_transition"],
    ["22023", 400, "invalid_request"],
    ["XX000", 500, "database_error"],
  ];
  for (const [code, status, expected] of cases) {
    const { fake } = deps({
      result: { data: null, error: { code, message: "mensagem interna com detalhes: tabela x" } },
    });
    const response = await handleCoachApi(request("/events"), fake);
    assert(response.status === status, `${code}: deve responder ${status}`);
    const body = await response.json();
    assert(body.code === expected, `${code}: código ${expected}`);
    if (code === "XX000" || code === "42501") {
      assert(!JSON.stringify(body).includes("tabela x"), `${code}: não vaza a mensagem interna`);
    }
  }
});

Deno.test("rota ou método desconhecido responde 404 sem tocar no banco", async () => {
  const { fake, calls } = deps();
  for (
    const [path, method] of [
      ["/admin", "GET"],
      ["/events", "DELETE"],
      [`/events/${EVENT_ID}`, "PUT"],
      ["/orders", "GET"],
    ]
  ) {
    const response = await handleCoachApi(request(path, method), fake);
    assert(response.status === 404, `${method} ${path}: deve responder 404`);
  }
  assert(calls.length === 0, "nenhuma chamada ao banco");
});

function panelDeps(options: { loader?: (coachId: string) => Promise<unknown>; meError?: { code: string; message: string } } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const loaded: string[] = [];
  const fake: CoachApiDeps = {
    authenticate: () => Promise.resolve({ ok: true as const, userId: USER_ID }),
    rpc(name, args) {
      calls.push({ name, args });
      return Promise.resolve(options.meError
        ? { data: null, error: options.meError }
        : { data: { coach_id: "coach-from-db", name: "Coach Teste" }, error: null });
    },
    loadPanel(coachId) {
      loaded.push(coachId);
      return options.loader ? options.loader(coachId) : Promise.resolve({ students: [] });
    },
  };
  return { fake, calls, loaded };
}

Deno.test("GET /panel usa o coach que o banco achou pela conta da sessão", async () => {
  const { fake, calls, loaded } = panelDeps();
  const response = await handleCoachApi(request(`/panel?coach_id=outro&coachId=outro`), fake);
  assert(response.status === 200, "painel carregado");
  assert(calls.length === 1 && calls[0].name === "coach_me", "confere a conta antes de tudo");
  assert(calls[0].args.p_user_id === USER_ID, "usa o usuário da sessão");
  assert(loaded.length === 1 && loaded[0] === "coach-from-db", "carrega o coach do banco, não o da chamada");
  assert((await response.json()).data.students.length === 0, "devolve o painel");
});

Deno.test("GET /panel recusa conta sem acesso de coach sem carregar nada", async () => {
  const { fake, loaded } = panelDeps({ meError: { code: "42501", message: "Esta conta não tem acesso de coach" } });
  const response = await handleCoachApi(request("/panel"), fake);
  assert(response.status === 403, "sem acesso de coach");
  assert(loaded.length === 0, "não carrega painel nenhum");
});

Deno.test("GET /panel sem sessão não chega ao banco nem ao carregador", async () => {
  const calls: string[] = [];
  const fake: CoachApiDeps = {
    authenticate: () => Promise.resolve({ ok: false as const, status: 401, error: "invalid_token" }),
    rpc: (name) => { calls.push(name); return Promise.resolve({ data: null, error: null }); },
    loadPanel: () => { calls.push("loadPanel"); return Promise.resolve(null); },
  };
  const response = await handleCoachApi(request("/panel"), fake);
  assert(response.status === 401 && calls.length === 0, "401 e nada chamado");
});

Deno.test("GET /panel não vaza detalhes quando o carregamento falha", async () => {
  const { fake } = panelDeps({ loader: () => Promise.reject(new Error("detalhe interno: tabela secreta")) });
  const response = await handleCoachApi(request("/panel"), fake);
  assert(response.status === 500, "erro do servidor");
  const body = await response.json();
  assert(body.code === "panel_unavailable", "código claro");
  assert(!JSON.stringify(body).includes("tabela secreta"), "sem detalhe interno");
});
