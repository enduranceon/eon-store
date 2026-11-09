import { jsonResponse } from "../_shared/http.ts";
import type { UserAuth } from "../_shared/authenticateUser.ts";

// API do coach. É a ÚNICA porta de dados do coach: o navegador dele não lê nenhuma
// tabela. A identidade vem do JWT validado aqui; todas as regras (é coach ativo, o
// evento é dele, só campos permitidos, sem valores) ficam nas funções coach_* do
// banco, que recebem o id da conta e devolvem uma lista fixa de campos. Esta camada só
// valida a entrada e traduz erros.

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WHATSAPP_GROUP_STATUSES = ["pending", "added", "declined"];

export interface RpcResult {
  data: unknown;
  error: { code?: string; message?: string } | null;
}

export interface CoachApiDeps {
  authenticate(req: Request): Promise<UserAuth>;
  rpc(name: string, args: Record<string, unknown>): Promise<RpcResult>;
}

function databaseError(
  error: { code?: string; message?: string },
  operation: string,
): Response {
  // O erro completo fica no log do servidor; o coach só recebe a mensagem de regra.
  console.error(`coach-api ${operation}:`, error.code);
  if (error.code === "42501") {
    return jsonResponse(
      { error: "Esta conta não tem acesso de coach", code: "forbidden" },
      403,
    );
  }
  if (error.code === "P0002") {
    return jsonResponse({ error: error.message, code: "not_found" }, 404);
  }
  if (error.code === "22023") {
    return jsonResponse({ error: error.message, code: "invalid_request" }, 400);
  }
  if (error.code === "P0001") {
    return jsonResponse(
      { error: error.message, code: "invalid_transition" },
      409,
    );
  }
  return jsonResponse({
    error: "Não foi possível processar o pedido",
    code: "database_error",
  }, 500);
}

function routePath(req: Request): string {
  const pathname = new URL(req.url).pathname;
  const prefix = "/coach-api";
  const index = pathname.indexOf(prefix);
  if (index === -1) return pathname;
  return pathname.slice(index + prefix.length) || "/";
}

async function parseObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function handleCoachApi(
  req: Request,
  deps: CoachApiDeps,
): Promise<Response> {
  const auth = await deps.authenticate(req);
  if (!auth.ok) {
    const message = auth.status === 401
      ? "Sessão inválida ou expirada"
      : "Não foi possível validar a sessão";
    return jsonResponse({ error: message, code: auth.error }, auth.status);
  }
  const userId = auth.userId;
  const path = routePath(req);

  if (req.method === "GET" && path === "/me") {
    const { data, error } = await deps.rpc("coach_me", { p_user_id: userId });
    if (error) return databaseError(error, "me");
    return jsonResponse({ data });
  }

  if (req.method === "GET" && path === "/events") {
    const { data, error } = await deps.rpc("coach_list_events", {
      p_user_id: userId,
    });
    if (error) return databaseError(error, "list events");
    return jsonResponse({ data });
  }

  const eventMatch = path.match(/^\/events\/([^/]+)$/);
  if (req.method === "GET" && eventMatch) {
    const [, eventId] = eventMatch;
    if (!UUID_PATTERN.test(eventId)) {
      return jsonResponse(
        { error: "Identificador de evento inválido", code: "invalid_event_id" },
        400,
      );
    }
    const { data, error } = await deps.rpc("coach_get_event", {
      p_user_id: userId,
      p_event_id: eventId,
    });
    if (error) return databaseError(error, "get event");
    return jsonResponse({ data });
  }

  const groupMatch = path.match(/^\/registrations\/([^/]+)\/whatsapp-group$/);
  if (req.method === "PATCH" && groupMatch) {
    const [, registrationId] = groupMatch;
    if (!UUID_PATTERN.test(registrationId)) {
      return jsonResponse({
        error: "Identificador de inscrição inválido",
        code: "invalid_registration_id",
      }, 400);
    }
    const body = await parseObject(req);
    if (
      !body || typeof body.status !== "string" ||
      !WHATSAPP_GROUP_STATUSES.includes(body.status)
    ) {
      return jsonResponse(
        { error: "Situação do grupo inválida", code: "invalid_request" },
        400,
      );
    }
    const { data, error } = await deps.rpc(
      "coach_set_registration_whatsapp_group",
      {
        p_user_id: userId,
        p_registration_id: registrationId,
        p_status: body.status,
      },
    );
    if (error) return databaseError(error, "set whatsapp group");
    return jsonResponse({ data });
  }

  return jsonResponse({ error: "Rota não encontrada", code: "not_found" }, 404);
}
