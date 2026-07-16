import { createClient } from "jsr:@supabase/supabase-js@2";

// Guard de autorização para edge functions "admin".
//
// PORQUÊ: `verify_jwt = true` no config.toml só garante que o JWT é válido — e a
// anon key pública (embutida no bundle) É um JWT válido. Ela NÃO distingue um
// operador logado de um visitante anônimo. Como estas funções usam a
// service_role (que ignora o RLS), sem esta checagem qualquer um com a anon key
// consegue chamá-las. Aqui validamos o usuário real e exigimos que ele esteja na
// allowlist `app_admins` (via RPC public.is_app_admin, que roda no contexto do
// usuário e retorna false para anon / não-allowlisted).

export interface AdminGate {
  ok: boolean;
  status: number;
  error?: string;
  userId?: string;
}

export async function requireAdmin(req: Request): Promise<AdminGate> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return { ok: false, status: 401, error: "missing_token" };
  }
  const jwt = authHeader.slice(7).trim();

  const url     = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    return { ok: false, status: 500, error: "auth_misconfigured" };
  }

  // Cliente no contexto do CHAMADOR (repassa o JWT do header). Nunca usa
  // service_role aqui — a validação precisa refletir o papel real do usuário.
  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth:   { persistSession: false, autoRefreshToken: false },
  });

  // getUser valida a assinatura E o subject: a anon key não tem usuário → null.
  const { data: { user }, error: userErr } = await caller.auth.getUser(jwt);
  if (userErr || !user) {
    return { ok: false, status: 401, error: "invalid_token" };
  }

  // is_app_admin() roda como o usuário; retorna false p/ quem não está na allowlist.
  const { data: isAdmin, error: adminErr } = await caller.rpc("is_app_admin");
  if (adminErr) {
    return { ok: false, status: 403, error: "admin_check_failed" };
  }
  if (!isAdmin) {
    return { ok: false, status: 403, error: "forbidden" };
  }

  return { ok: true, status: 200, userId: user.id };
}
