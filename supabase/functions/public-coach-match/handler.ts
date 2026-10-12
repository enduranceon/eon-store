import { publicCoachMatchAnswers } from "../_shared/coach-match-contract.js";
import { isRecord, MATCH_UUID, options, reply, rpcFailure } from "../coach-match-form/http.ts";
import type { MatchRpcClient } from "../coach-match-form/http.ts";

export async function handlePublicCoachMatch(req: Request, deps: { createServiceClient(): MatchRpcClient | null }): Promise<Response> {
  if (req.method === "OPTIONS") return options();
  if (req.method !== "GET") return reply({ error: "Método não permitido." }, 405);
  try {
    const service = deps.createServiceClient();
    if (!service) return reply({ error: "Serviço indisponível." }, 503);
    // Only the RPC's latest approved profiles for active, visible coaches.
    const { data, error } = await service.rpc("list_public_coach_match_profiles");
    if (error) return rpcFailure(error);
    if (!Array.isArray(data)) return rpcFailure({});
    const profiles = data.flatMap((row: unknown) => {
      if (!isRecord(row) || typeof row.coach_id !== "string" || !MATCH_UUID.test(row.coach_id) ||
          typeof row.reviewed_at !== "string" || !Number.isFinite(Date.parse(row.reviewed_at))) return [];
      const answers = publicCoachMatchAnswers(row.answers);
      return answers ? [{ coach_id: row.coach_id, answers, reviewed_at: row.reviewed_at }] : [];
    });
    return reply({ data: profiles });
  } catch {
    return rpcFailure({});
  }
}
