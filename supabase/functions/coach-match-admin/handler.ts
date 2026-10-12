import { coachMatchTokenHash, newCoachMatchToken } from "../_shared/coach-match-token.ts";
import { isRecord, MATCH_UUID, options, readLimitedJson, reply, rpcFailure } from "../coach-match-form/http.ts";
import type { MatchRpcClient } from "../coach-match-form/http.ts";

type AdminGate = { ok: boolean; status: number; userId?: string; error?: string };
type Dependencies = {
  requireAdmin(req: Request): Promise<AdminGate>;
  createServiceClient(): MatchRpcClient | null;
};

export async function handleCoachMatchAdmin(req: Request, deps: Dependencies): Promise<Response> {
  if (req.method === "OPTIONS") return options();
  try {
    // The service client is created only after the existing admin allowlist gate.
    const gate = await deps.requireAdmin(req);
    if (!gate.ok || !gate.userId) return reply({ error: "Acesso restrito aos administradores." }, gate.ok ? 403 : gate.status);

    const path = new URL(req.url).pathname.replace(/^\/(?:functions\/v1\/)?coach-match-admin/, "");
    const match = /^\/coach-match\/([^/]+)(?:\/(invite|revoke|review))?\/?$/.exec(path);
    if (!match) return reply({ error: "Rota não encontrada." }, 404);
    const [, coachId, action] = match;
    if (!MATCH_UUID.test(coachId)) return reply({ error: "Coach inválido." }, 400);
    if (!((req.method === "GET" && !action) || (req.method === "POST" && action))) {
      return reply({ error: "Método não permitido." }, 405);
    }
    let body: Record<string, unknown> = {};
    if (req.method === "POST") {
      const parsed = await readLimitedJson(req);
      if (parsed.tooLarge) return reply({ error: "Formulário muito grande." }, 413);
      if (!isRecord(parsed.body)) return reply({ error: "Dados inválidos." }, 400);
      body = parsed.body;
      if (action === "revoke" && (typeof body.invite_id !== "string" || !MATCH_UUID.test(body.invite_id))) {
        return reply({ error: "Link inválido." }, 400);
      }
      if (action === "review" && (typeof body.submission_id !== "string" || !MATCH_UUID.test(body.submission_id) ||
          typeof body.decision !== "string" || !["approved", "rejected"].includes(body.decision))) {
        return reply({ error: "Revisão inválida." }, 400);
      }
    }
    const service = deps.createServiceClient();
    if (!service) return reply({ error: "Serviço indisponível." }, 503);
    if (!action) {
      const { data, error } = await service.rpc("get_assessment_coach_match_admin", { p_coach_id: coachId });
      return error ? rpcFailure(error) : reply({ data });
    }
    if (action === "invite") {
      const token = newCoachMatchToken();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await service.rpc("issue_assessment_coach_match_invite", {
        p_coach_id: coachId, p_token_hash: await coachMatchTokenHash(token),
        p_expires_at: expiresAt, p_created_by: gate.userId,
      });
      if (error) return rpcFailure(error);
      // Raw token returned once only; database stores the digest.
      return reply({ data: { ...(isRecord(data) ? data : {}), token, expires_at: expiresAt } });
    }
    const { data, error } = action === "revoke"
      ? await service.rpc("revoke_assessment_coach_match_invite", { p_coach_id: coachId, p_invite_id: body.invite_id })
      : await service.rpc("review_assessment_coach_match_submission", {
        p_coach_id: coachId, p_submission_id: body.submission_id,
        p_decision: body.decision, p_reviewed_by: gate.userId,
      });
    return error ? rpcFailure(error) : reply({ data });
  } catch {
    return rpcFailure({});
  }
}
