import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { handleEventsRequest } from "./events.ts";

const EVENT_ID = "7838481a-f3f8-42b2-a462-fb3f32e5ab11";
const REGISTRATION_ID = "8a38481a-f3f8-42b2-a462-fb3f32e5ab22";
const COACH_A = "9b38481a-f3f8-42b2-a462-fb3f32e5ab33";
const COACH_B = "ac38481a-f3f8-42b2-a462-fb3f32e5ab44";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function request(path: string, method: string, body?: unknown) {
  return new Request(`https://example.test/api-v1${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function client(error: { code: string; message: string } | null = null) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const fake = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({ data: { ok: true }, error });
    },
  } as unknown as SupabaseClient;
  return { fake, calls };
}

Deno.test("PUT /events/:id/coaches troca a lista de responsáveis pelo banco", async () => {
  const { fake, calls } = client();
  const response = await handleEventsRequest(
    request(`/events/${EVENT_ID}/coaches`, "PUT", { coach_ids: [COACH_A, COACH_B] }),
    `/events/${EVENT_ID}/coaches`,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 200, "a lista válida deve ser aceita");
  assert(calls.length === 1 && calls[0].name === "set_event_coaches", "chama a função certa");
  assert(calls[0].args.p_event_id === EVENT_ID, "envia o evento da rota");
  assert(
    JSON.stringify(calls[0].args.p_coach_ids) === JSON.stringify([COACH_A, COACH_B]),
    "envia os coaches informados",
  );
  assert(calls[0].args.p_actor_id === ACTOR_ID, "envia o operador autenticado");
});

Deno.test("PUT /events/:id/coaches aceita lista vazia para tirar todos", async () => {
  const { fake, calls } = client();
  const response = await handleEventsRequest(
    request(`/events/${EVENT_ID}/coaches`, "PUT", { coach_ids: [] }),
    `/events/${EVENT_ID}/coaches`,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 200, "lista vazia é válida");
  assert(JSON.stringify(calls[0].args.p_coach_ids) === "[]", "envia a lista vazia");
});

Deno.test("PUT /events/:id/coaches recusa entrada inválida sem chamar o banco", async () => {
  const cases: Array<[string, unknown]> = [
    ["sem lista", {}],
    ["não é lista", { coach_ids: COACH_A }],
    ["id que não é uuid", { coach_ids: ["abc"] }],
    ["id que não é texto", { coach_ids: [123] }],
    ["lista grande demais", { coach_ids: Array.from({ length: 51 }, () => COACH_A) }],
  ];
  for (const [label, body] of cases) {
    const { fake, calls } = client();
    const response = await handleEventsRequest(
      request(`/events/${EVENT_ID}/coaches`, "PUT", body),
      `/events/${EVENT_ID}/coaches`,
      fake,
      ACTOR_ID,
    );
    assert(response?.status === 400, `${label}: deve responder 400`);
    assert(calls.length === 0, `${label}: não deve chamar o banco`);
  }
  const { fake, calls } = client();
  const badEvent = await handleEventsRequest(
    request("/events/nao-e-uuid/coaches", "PUT", { coach_ids: [] }),
    "/events/nao-e-uuid/coaches",
    fake,
    ACTOR_ID,
  );
  assert(badEvent?.status === 400 && calls.length === 0, "evento inválido não chama o banco");
});

Deno.test("PUT /events/:id/coaches traduz os erros do banco", async () => {
  const { fake } = client({ code: "P0001", message: "Coach inativo não pode ser responsável por evento" });
  const response = await handleEventsRequest(
    request(`/events/${EVENT_ID}/coaches`, "PUT", { coach_ids: [COACH_A] }),
    `/events/${EVENT_ID}/coaches`,
    fake,
    ACTOR_ID,
  );
  assert(response?.status === 409, "regra de negócio vira 409");
  const body = await response!.json();
  assert(body.error.includes("inativo"), "devolve a mensagem do banco");
});

Deno.test("PATCH /events/registrations/:id/whatsapp-group grava a situação pelo banco", async () => {
  for (const status of ["pending", "added", "declined"]) {
    const { fake, calls } = client();
    const path = `/events/registrations/${REGISTRATION_ID}/whatsapp-group`;
    const response = await handleEventsRequest(request(path, "PATCH", { status }), path, fake, ACTOR_ID);
    assert(response?.status === 200, `${status}: deve ser aceito`);
    assert(calls[0].name === "set_event_registration_whatsapp_group", "chama a função certa");
    assert(calls[0].args.p_registration_id === REGISTRATION_ID, "envia a inscrição da rota");
    assert(calls[0].args.p_status === status, "envia a situação");
    assert(calls[0].args.p_actor_id === ACTOR_ID, "envia o operador autenticado");
  }
});

Deno.test("PATCH /events/registrations/:id/whatsapp-group recusa situação inválida e traduz erros", async () => {
  const path = `/events/registrations/${REGISTRATION_ID}/whatsapp-group`;
  for (const body of [{}, { status: "maybe" }, { status: 1 }]) {
    const { fake, calls } = client();
    const response = await handleEventsRequest(request(path, "PATCH", body), path, fake, ACTOR_ID);
    assert(response?.status === 400 && calls.length === 0, "situação inválida não chama o banco");
  }
  const { fake: unpaid } = client({ code: "P0001", message: "Só inscrição paga entra no controle do grupo" });
  const conflict = await handleEventsRequest(request(path, "PATCH", { status: "added" }), path, unpaid, ACTOR_ID);
  assert(conflict?.status === 409, "inscrição não paga vira 409");
  const { fake: missing } = client({ code: "P0002", message: "Inscrição não encontrada" });
  const notFound = await handleEventsRequest(request(path, "PATCH", { status: "added" }), path, missing, ACTOR_ID);
  assert(notFound?.status === 404, "inscrição inexistente vira 404");
  const { fake: badId, calls } = client();
  const invalid = await handleEventsRequest(
    request("/events/registrations/x/whatsapp-group", "PATCH", { status: "added" }),
    "/events/registrations/x/whatsapp-group",
    badId,
    ACTOR_ID,
  );
  assert(invalid?.status === 400 && calls.length === 0, "inscrição inválida não chama o banco");
});
