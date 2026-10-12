import { COACH_MATCH_TOKEN, coachMatchTokenHash } from "../_shared/coach-match-token.ts";
import {
  validateCoachMatchV2Answers,
  validateLegacyCoachMatchAnswers,
} from "../_shared/coach-match-contract.js";
import { isRecord, options, readLimitedJson, reply, rpcFailure } from "./http.ts";
import type { MatchRpcClient } from "./http.ts";

export async function handleCoachMatchForm(req: Request, deps: { createServiceClient(): MatchRpcClient | null }): Promise<Response> {
  if (req.method === "OPTIONS") return options();
  if (req.method !== "POST") return reply({ error: "Método não permitido." }, 405);
  try {
    const requestPayload = await readLimitedJson(req);
    if (requestPayload.tooLarge) return reply({ error: "Formulário muito grande." }, 413);
    const body = requestPayload.body;
    if (!isRecord(body) || (body.action !== "load" && body.action !== "submit") ||
        typeof body.token !== "string" || !COACH_MATCH_TOKEN.test(body.token) ||
        (body.profile_version !== undefined && body.profile_version !== 2)) {
      return reply({ error: "Link inválido." }, 400);
    }
    const useV2 = body.profile_version === 2;
    const parsed = body.action === "submit"
      ? (useV2 ? validateCoachMatchV2Answers(body.answers) : validateLegacyCoachMatchAnswers(body.answers))
      : null;
    if (parsed && !parsed.ok) return reply({ error: parsed.error }, 400);
    const service = deps.createServiceClient();
    if (!service) return reply({ error: "Serviço indisponível." }, 503);
    const hash = await coachMatchTokenHash(body.token);
    // RPC owns token expiry/revocation, rate limit and insert in one transaction.
    const rpc = body.action === "load"
      ? (useV2 ? "load_assessment_coach_match_form_v2" : "load_assessment_coach_match_form")
      : (useV2 ? "submit_assessment_coach_match_answers_v2" : "submit_assessment_coach_match_answers");
    const { data, error } = body.action === "load"
      ? await service.rpc(rpc, { p_token_hash: hash })
      : await service.rpc(rpc, { p_token_hash: hash, p_answers: parsed!.answers });
    return error ? rpcFailure(error) : reply({ data });
  } catch {
    return rpcFailure({});
  }
}
