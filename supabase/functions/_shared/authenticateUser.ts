import { createClient } from "jsr:@supabase/supabase-js@2.110.7";

// Valida o JWT do chamador e devolve o id do usuário. Não decide permissão: quem
// chama (coach-api) confere no banco se a conta é de um coach ativo.
//
// PORQUÊ: `verify_jwt = true` só garante que o token é válido, e a anon key pública
// também é um JWT válido. getUser valida a assinatura E o sujeito: a anon key não
// tem usuário e volta sem conta.

export type UserAuth =
  | { ok: true; userId: string }
  | { ok: false; status: number; error: string };

export async function authenticateUser(req: Request): Promise<UserAuth> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return { ok: false, status: 401, error: "missing_token" };
  }
  const jwt = authHeader.slice(7).trim();

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    return { ok: false, status: 500, error: "auth_misconfigured" };
  }

  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error } = await caller.auth.getUser(jwt);
  if (error || !user) {
    return { ok: false, status: 401, error: "invalid_token" };
  }
  return { ok: true, userId: user.id };
}
