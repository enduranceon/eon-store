import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

// New cases call the existing domain RPCs inside one transaction. Old browser
// routes must not create a second contact writer after the controlled rollout.
export async function gateLegacyCommunication(req: Request, path: string, client: SupabaseClient): Promise<Response | null> {
  if (req.method !== "POST" || !(path === "/communications/events" || /^\/orders\/(contract|presale|stock|event)\/[^/]+\/payment-message$/.test(path))) return null;
  const { data, error } = await client.from("communication_settings").select("value").eq("key", "cases_rollout").maybeSingle();
  if (error) return jsonResponse({ error: "Não foi possível conferir o acompanhamento. Tente novamente.", code: "communication_state_unavailable" }, 503);
  if (data?.value?.enabled !== true) return null;
  return jsonResponse({ error: "Este atendimento usa o acompanhamento atualizado. Recarregue a página e abra a mensagem novamente.", code: "communication_case_required" }, 409);
}
