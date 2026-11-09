import { generateTemporaryPassword, handleCoachAccessRequest } from "./coach-access.ts";
import type { CoachAccessClient } from "./coach-access.ts";

const COACH_ID = "7838481a-f3f8-42b2-a462-fb3f32e5ab11";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const NEW_USER = "33333333-3333-4333-8333-333333333333";
const OLD_USER = "44444444-4444-4444-8444-444444444444";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Target = {
  coach_id: string; name: string; email: string | null; active: boolean; auth_user_id: string | null;
};

function setup(options: {
  target?: Partial<Target>;
  targetError?: { code: string; message: string };
  createError?: { code?: string; message?: string };
  linkError?: { code: string; message: string };
  unlinkResult?: string | null;
  deleteError?: { message: string };
} = {}) {
  const calls: Array<{ kind: string; name?: string; args?: unknown }> = [];
  const target: Target = {
    coach_id: COACH_ID, name: "Coach Teste", email: "Coach.Teste@Example.Test",
    active: true, auth_user_id: null, ...options.target,
  };
  const client: CoachAccessClient = {
    rpc(name, args) {
      calls.push({ kind: "rpc", name, args });
      if (name === "coach_access_target") {
        return Promise.resolve(options.targetError
          ? { data: null, error: options.targetError }
          : { data: target, error: null });
      }
      if (name === "link_coach_auth_user") {
        return Promise.resolve(options.linkError
          ? { data: null, error: options.linkError }
          : { data: { ok: true }, error: null });
      }
      if (name === "unlink_coach_auth_user") {
        return Promise.resolve({ data: options.unlinkResult ?? null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    auth: {
      admin: {
        createUser(attributes) {
          calls.push({ kind: "createUser", args: attributes });
          return Promise.resolve(options.createError
            ? { data: null, error: options.createError }
            : { data: { user: { id: NEW_USER } }, error: null });
        },
        updateUserById(id, attributes) {
          calls.push({ kind: "updateUserById", args: { id, attributes } });
          return Promise.resolve({ data: { user: { id } }, error: null });
        },
        deleteUser(id) {
          calls.push({ kind: "deleteUser", args: id });
          return Promise.resolve({ error: options.deleteError ?? null });
        },
      },
    },
  };
  return { client, calls };
}

const request = (method: string) =>
  new Request("https://example.test/api-v1/x", { method });
const run = (
  method: string,
  path: string,
  client: CoachAccessClient,
  password = "SenhaTeste12",
) => handleCoachAccessRequest(request(method), path, client, ACTOR_ID, { generatePassword: () => password });

Deno.test("a senha provisória usa só caracteres sem ambiguidade e muda a cada vez", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const password = generateTemporaryPassword();
    assert(password.length === 12, "12 caracteres");
    assert(/^[A-HJ-NP-Za-km-z2-9]+$/.test(password), "sem 0, O, 1, l, I");
    seen.add(password);
  }
  assert(seen.size === 50, "senhas diferentes");
  // Bytes acima do limite (que enviesariam a escolha) são descartados; o sorteador
  // devolve só bytes descartados na primeira vez e bytes válidos depois.
  let calls = 0;
  const retried = generateTemporaryPassword((size) => {
    calls += 1;
    return calls === 1 ? new Uint8Array(size).fill(255) : new Uint8Array(size).fill(0);
  });
  assert(calls === 2, "pede mais bytes quando todos foram descartados");
  assert(retried === "AAAAAAAAAAAA", "usa só os bytes dentro do limite");
});

Deno.test("criar o acesso cria a conta confirmada, liga ao coach e mostra a senha uma vez", async () => {
  const { client, calls } = setup();
  const response = await run("POST", `/coaches/${COACH_ID}/access`, client);
  assert(response?.status === 201, "criado");
  const body = await response!.json();
  assert(body.data.temporary_password === "SenhaTeste12", "senha provisória na resposta");
  assert(body.data.email === "coach.teste@example.test", "e-mail em minúsculas");
  const create = calls.find((call) => call.kind === "createUser")!.args as Record<string, unknown>;
  assert(create.email === "coach.teste@example.test", "cria com o e-mail do cadastro");
  assert(create.email_confirm === true, "conta já confirmada");
  assert((create.user_metadata as Record<string, unknown>).must_change_password === true, "troca de senha no primeiro acesso");
  const link = calls.find((call) => call.name === "link_coach_auth_user")!.args as Record<string, unknown>;
  assert(link.p_auth_user_id === NEW_USER && link.p_coach_id === COACH_ID && link.p_actor_id === ACTOR_ID, "liga a conta ao coach");
  assert(!calls.some((call) => call.kind === "deleteUser"), "nada é apagado quando deu certo");
});

Deno.test("não cria acesso para coach inativo, que já tem acesso ou sem e-mail", async () => {
  for (
    const [label, target, status] of [
      ["inativo", { active: false }, 409],
      ["já tem acesso", { auth_user_id: OLD_USER }, 409],
      ["sem e-mail", { email: "" }, 400],
      ["e-mail inválido", { email: "sem-arroba" }, 400],
    ] as Array<[string, Partial<Target>, number]>
  ) {
    const { client, calls } = setup({ target });
    const response = await run("POST", `/coaches/${COACH_ID}/access`, client);
    assert(response?.status === status, `${label}: deve responder ${status}`);
    assert(!calls.some((call) => call.kind === "createUser"), `${label}: não cria conta`);
  }
});

Deno.test("e-mail que já tem conta (por exemplo de administrador) é recusado sem tocar nela", async () => {
  const { client, calls } = setup({ createError: { code: "email_exists", message: "A user with this email address has already been registered" } });
  const response = await run("POST", `/coaches/${COACH_ID}/access`, client);
  assert(response?.status === 409, "conflito");
  const body = await response!.json();
  assert(body.code === "email_already_registered", "código do conflito");
  assert(!calls.some((call) => call.kind === "updateUserById" || call.kind === "deleteUser" || call.name === "link_coach_auth_user"), "não mexe em conta existente nem liga");
});

Deno.test("se não der para ligar, a conta recém-criada é apagada", async () => {
  const { client, calls } = setup({ linkError: { code: "P0001", message: "Conta de administrador não pode ser conta de coach" } });
  const response = await run("POST", `/coaches/${COACH_ID}/access`, client);
  assert(response?.status === 409, "erro de regra");
  const deleted = calls.find((call) => call.kind === "deleteUser");
  assert(deleted && deleted.args === NEW_USER, "apaga a conta que acabou de criar");
});

Deno.test("falha ao criar a conta no login volta como erro sem vazar detalhes", async () => {
  const { client } = setup({ createError: { code: "unexpected_failure", message: "detalhe interno do servidor" } });
  const response = await run("POST", `/coaches/${COACH_ID}/access`, client);
  assert(response?.status === 502, "erro do serviço de login");
  assert(!JSON.stringify(await response!.json()).includes("detalhe interno"), "não vaza a mensagem interna");
});

Deno.test("redefinir a senha vale só para quem já tem acesso e exige trocar no próximo login", async () => {
  const withAccess = setup({ target: { auth_user_id: OLD_USER } });
  const response = await run("POST", `/coaches/${COACH_ID}/access/password`, withAccess.client, "NovaSenha1234");
  assert(response?.status === 200, "ok");
  assert((await response!.json()).data.temporary_password === "NovaSenha1234", "nova senha provisória");
  const update = withAccess.calls.find((call) => call.kind === "updateUserById")!.args as { id: string; attributes: Record<string, unknown> };
  assert(update.id === OLD_USER && update.attributes.password === "NovaSenha1234", "troca a senha da conta ligada");
  assert((update.attributes.user_metadata as Record<string, unknown>).must_change_password === true, "obriga a trocar");

  const without = setup();
  const refused = await run("POST", `/coaches/${COACH_ID}/access/password`, without.client);
  assert(refused?.status === 409, "sem acesso não há senha para redefinir");
  assert(!without.calls.some((call) => call.kind === "updateUserById"), "nada é alterado");
});

Deno.test("remover o acesso desliga o coach e apaga a conta", async () => {
  const { client, calls } = setup({ unlinkResult: OLD_USER });
  const response = await run("DELETE", `/coaches/${COACH_ID}/access`, client);
  assert(response?.status === 200, "ok");
  const body = await response!.json();
  assert(body.data.had_access === true && body.data.account_removed === true, "acesso removido");
  const order = calls.map((call) => call.name ?? call.kind);
  assert(order.indexOf("unlink_coach_auth_user") < order.indexOf("deleteUser"), "primeiro desliga, depois apaga a conta");
  assert(calls.find((call) => call.kind === "deleteUser")!.args === OLD_USER, "apaga a conta ligada");

  const none = setup({ unlinkResult: null });
  const idle = await run("DELETE", `/coaches/${COACH_ID}/access`, none.client);
  assert((await idle!.json()).data.had_access === false, "quem não tinha acesso não é erro");
  assert(!none.calls.some((call) => call.kind === "deleteUser"), "nada para apagar");

  const failing = setup({ unlinkResult: OLD_USER, deleteError: { message: "falha" } });
  const partial = await run("DELETE", `/coaches/${COACH_ID}/access`, failing.client);
  assert(partial?.status === 200 && (await partial!.json()).data.account_removed === false, "o coach já está desligado, mesmo se a conta não saiu");
});

Deno.test("coach desconhecido, id inválido e rotas de outros assuntos", async () => {
  const missing = setup({ targetError: { code: "P0002", message: "Coach não encontrado" } });
  const notFound = await run("POST", `/coaches/${COACH_ID}/access`, missing.client);
  assert(notFound?.status === 404, "coach inexistente vira 404");

  const bad = setup();
  const invalid = await run("POST", "/coaches/nao-e-uuid/access", bad.client);
  assert(invalid?.status === 400 && bad.calls.length === 0, "id inválido não chega ao banco");

  const other = setup();
  assert(await run("GET", `/coaches/${COACH_ID}/access`, other.client) === null, "GET não é desta rota");
  assert(await run("DELETE", `/coaches/${COACH_ID}/access/password`, other.client) === null, "DELETE na senha não é desta rota");
  assert(await run("POST", "/events/x/coaches", other.client) === null, "outras rotas seguem adiante");
  assert(other.calls.length === 0, "nada foi chamado");
});
