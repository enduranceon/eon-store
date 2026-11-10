import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

// Acesso (login) do coach, administrado pela equipe. A conta é criada no Supabase Auth
// com a chave de serviço, com senha provisória que aparece UMA vez para quem
// administra e que o coach troca no primeiro acesso. A ligação conta -> coach e as
// regras ficam nas funções do banco (coach_access_target, link_coach_auth_user,
// unlink_coach_auth_user). Nada daqui chama o Asaas.
//
//   POST   /coaches/:id/access           cria a conta e liga ao coach
//   POST   /coaches/:id/access/password  gera nova senha provisória
//   DELETE /coaches/:id/access           tira o acesso e apaga a conta

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Sem caracteres que se confundem (0/O, 1/l/I) para ditar a senha por mensagem.
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const PASSWORD_LENGTH = 12;

export function generateTemporaryPassword(
  random: (size: number) => Uint8Array = (size) => crypto.getRandomValues(new Uint8Array(size)),
): string {
  // Rejeição de bytes que enviesariam a escolha (256 não divide o alfabeto).
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  let password = "";
  while (password.length < PASSWORD_LENGTH) {
    for (const byte of random(PASSWORD_LENGTH * 2)) {
      if (byte < limit && password.length < PASSWORD_LENGTH) {
        password += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      }
    }
  }
  return password;
}

interface AuthAdminResult {
  data: { user: { id: string } | null } | null;
  error: { code?: string; message?: string; status?: number } | null;
}

export interface CoachAccessClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
  auth: {
    admin: {
      createUser(attributes: Record<string, unknown>): Promise<AuthAdminResult>;
      updateUserById(id: string, attributes: Record<string, unknown>): Promise<AuthAdminResult>;
      deleteUser(id: string): Promise<{ error: { message?: string } | null }>;
    };
  };
}

function databaseError(
  error: { code?: string; message?: string },
  operation: string,
): Response {
  console.error(`api-v1 coach access ${operation}:`, error.code);
  if (error.code === "P0002") {
    return jsonResponse({ error: error.message, code: "not_found" }, 404);
  }
  if (error.code === "22023") {
    return jsonResponse({ error: error.message, code: "invalid_request" }, 400);
  }
  if (error.code === "P0001") {
    return jsonResponse({ error: error.message, code: "invalid_transition" }, 409);
  }
  if (error.code === "23505") {
    return jsonResponse({
      error: "Esta conta já está ligada a outro coach",
      code: "already_linked",
    }, 409);
  }
  return jsonResponse({
    error: "Não foi possível processar o acesso do coach",
    code: "database_error",
  }, 500);
}

function isEmailTaken(error: { code?: string; message?: string; status?: number }): boolean {
  return error.code === "email_exists" ||
    error.code === "user_already_exists" ||
    /already (been )?registered|already exists/i.test(error.message ?? "");
}

export async function handleCoachAccessRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient | CoachAccessClient,
  actorId: string,
  options: { generatePassword?: () => string } = {},
): Promise<Response | null> {
  const match = path.match(/^\/coaches\/([^/]+)\/access(\/password)?$/);
  if (!match) return null;
  const [, coachId, passwordSuffix] = match;
  const isPassword = Boolean(passwordSuffix);
  const allowed = isPassword ? "POST" : ["POST", "DELETE"].includes(req.method) ? req.method : "";
  if (req.method !== allowed) return null;

  if (!UUID_PATTERN.test(coachId)) {
    return jsonResponse(
      { error: "Identificador de coach inválido", code: "invalid_coach_id" },
      400,
    );
  }

  const client = supabase as CoachAccessClient;
  const generatePassword = options.generatePassword ?? generateTemporaryPassword;

  // Remover o acesso: desliga primeiro (o coach perde os dados na hora) e depois apaga a conta.
  if (req.method === "DELETE") {
    const { data, error } = await client.rpc("unlink_coach_auth_user", {
      p_coach_id: coachId,
      p_actor_id: actorId,
    });
    if (error) return databaseError(error, "unlink");
    const previous = typeof data === "string" ? data : null;
    let accountRemoved = true;
    if (previous) {
      const { error: deleteError } = await client.auth.admin.deleteUser(previous);
      if (deleteError) {
        accountRemoved = false;
        console.error("api-v1 coach access delete user failed");
      }
    }
    return jsonResponse({
      data: { coach_id: coachId, had_access: Boolean(previous), account_removed: accountRemoved },
    });
  }

  const target = await client.rpc("coach_access_target", { p_coach_id: coachId });
  if (target.error) return databaseError(target.error, "target");
  const info = target.data as {
    coach_id: string;
    name: string | null;
    email: string | null;
    active: boolean;
    auth_user_id: string | null;
  };

  // Nova senha provisória para quem já tem acesso.
  if (isPassword) {
    if (!info.auth_user_id) {
      return jsonResponse(
        { error: "Este coach ainda não tem acesso", code: "invalid_transition" },
        409,
      );
    }
    const password = generatePassword();
    const { error } = await client.auth.admin.updateUserById(info.auth_user_id, {
      password,
      user_metadata: { must_change_password: true },
    });
    if (error) {
      console.error("api-v1 coach access reset password failed:", error.code);
      return jsonResponse(
        { error: "Não foi possível gerar a nova senha", code: "auth_error" },
        502,
      );
    }
    return jsonResponse({
      data: { coach_id: coachId, email: info.email, temporary_password: password },
    });
  }

  // Criar o acesso.
  if (!info.active) {
    return jsonResponse(
      { error: "Coach inativo não pode ter acesso", code: "invalid_transition" },
      409,
    );
  }
  if (info.auth_user_id) {
    return jsonResponse(
      { error: "Este coach já tem acesso", code: "invalid_transition" },
      409,
    );
  }
  const email = String(info.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return jsonResponse(
      { error: "Cadastre um e-mail válido para o coach antes de criar o acesso", code: "invalid_request" },
      400,
    );
  }

  const password = generatePassword();
  const created = await client.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { must_change_password: true },
    app_metadata: { eon_role: "coach" },
  });
  if (created.error || !created.data?.user) {
    if (created.error && isEmailTaken(created.error)) {
      return jsonResponse({
        error: "Já existe uma conta com este e-mail. Use outro e-mail no cadastro do coach.",
        code: "email_already_registered",
      }, 409);
    }
    console.error("api-v1 coach access create user failed:", created.error?.code);
    return jsonResponse(
      { error: "Não foi possível criar a conta de acesso", code: "auth_error" },
      502,
    );
  }
  const authUserId = created.data.user.id;

  const link = await client.rpc("link_coach_auth_user", {
    p_coach_id: coachId,
    p_auth_user_id: authUserId,
    p_actor_id: actorId,
  });
  if (link.error) {
    // Não deixa conta solta: se não foi possível ligar, apaga a que acabou de ser criada.
    const { error: cleanupError } = await client.auth.admin.deleteUser(authUserId);
    if (cleanupError) console.error("api-v1 coach access cleanup failed");
    return databaseError(link.error, "link");
  }

  return jsonResponse({
    data: { coach_id: coachId, email, temporary_password: password },
  }, 201);
}
