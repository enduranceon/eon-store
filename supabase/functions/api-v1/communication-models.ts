import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid = (message: string) => jsonResponse({ error: message, code: "invalid_request" }, 400);

function failure(error: { code?: string; message?: string }): Response {
  if (error.code === "P0002") return jsonResponse({ error: error.message, code: "not_found" }, 404);
  if (["P0001", "23505"].includes(error.code || "")) {
    return jsonResponse({ error: error.code === "23505" ? "Já existe um modelo com essa identificação" : error.message, code: "publication_conflict" }, 409);
  }
  if (["22023", "22P02", "23514", "22007", "22008"].includes(error.code || "")) return invalid(error.code === "22023" ? error.message || "Modelo inválido" : "Dados do modelo inválidos");
  return jsonResponse({ error: "Não foi possível processar o modelo", code: "database_error" }, 500);
}

// Called only after requireAdmin in index.ts. The database RPC is executable
// exclusively by service_role and receives the actor from that gate.
export async function handleCommunicationModelRequest(req: Request, path: string, client: SupabaseClient, actorId: string): Promise<Response | null> {
  if (!path.startsWith("/communications/models")) return null;
  if (!actorId || !UUID.test(actorId)) return jsonResponse({ error: "Acesso não autorizado", code: "unauthorized" }, 401);
  const versions = path.match(/^\/communications\/models\/([^/]+)\/versions$/);
  const actionMatch = path.match(/^\/communications\/models\/drafts\/([^/]+)\/(simulate|publish)$/);
  const isConfig = path === "/communications/models";
  const isDraft = path === "/communications/models/drafts";
  if (!isConfig && !isDraft && !versions && !actionMatch) return jsonResponse({ error: "Rota não encontrada", code: "not_found" }, 404);
  const expectedMethod = isConfig || versions ? "GET" : "POST";
  if (req.method !== expectedMethod) return jsonResponse({ error: "Método não permitido", code: "method_not_allowed" }, 405);
  if (versions) {
    if (!UUID.test(versions[1])) return invalid("Modelo inválido");
    const params = new URL(req.url).searchParams;
    const limit = Number(params.get("limit") || 20);
    const cursor = params.get("cursor");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor && !/^[1-9][0-9]*$/.test(cursor))) return invalid("Paginação inválida");
    let query = client.from("communication_rule_versions").select("*").eq("rule_id", versions[1]).order("version", { ascending: false }).limit(limit + 1);
    if (cursor) query = query.lt("version", Number(cursor));
    const { data, error } = await query;
    if (error) return failure(error);
    const items = (data || []).slice(0, limit);
    return jsonResponse({ data: { items, next_cursor: (data || []).length > limit ? String(items.at(-1)?.version) : null } });
  }
  let payload: Record<string, unknown> = {};
  if (req.method === "POST") {
    const raw = await req.text();
    if (raw.length > 30_000) return invalid("Rascunho muito grande");
    try {
      const parsed = JSON.parse(raw || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalid("Corpo JSON inválido");
      payload = parsed;
    } catch { return invalid("Corpo JSON inválido"); }
  }
  let action = isConfig ? "get_config" : "save_draft";
  if (actionMatch) {
    if (!UUID.test(actionMatch[1])) return invalid("Rascunho inválido");
    action = actionMatch[2];
    const allowed = action === "simulate" ? [] : ["expected_updated_at", "simulation_fingerprint"];
    if (Object.keys(payload).some(key => !allowed.includes(key))) return invalid("Campos da publicação inválidos");
    if (action === "publish" && (typeof payload.expected_updated_at !== "string" || !Number.isFinite(Date.parse(payload.expected_updated_at)) || typeof payload.simulation_fingerprint !== "string" || !/^[a-f0-9]{32}$/.test(payload.simulation_fingerprint))) return invalid("Simulação e versão obrigatórias");
    payload = { ...payload, draft_id: actionMatch[1] };
  } else if (isDraft) {
    const allowed = ["rule_id", "base_version", "rule", "policy", "base_policy_version"];
    if (Object.keys(payload).some(key => !allowed.includes(key))) return invalid("Campos do rascunho inválidos");
    if (payload.rule_id != null && (typeof payload.rule_id !== "string" || !UUID.test(payload.rule_id))) return invalid("Modelo inválido");
    for (const key of ["base_version", "base_policy_version"]) {
      if (payload[key] != null && (!Number.isInteger(payload[key]) || Number(payload[key]) < 0)) return invalid("Versão inválida");
    }
  }
  const { data, error } = await client.rpc("communication_model_command", { p_action: action, p_actor_id: actorId, p_payload: payload });
  if (error) return failure(error);
  return jsonResponse({ data });
}
