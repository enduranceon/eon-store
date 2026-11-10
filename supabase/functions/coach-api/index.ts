import { authenticateUser } from "../_shared/authenticateUser.ts";
import { jsonResponse, optionsResponse } from "../_shared/http.ts";
import { createServiceClient } from "../_shared/serviceClient.ts";
import { handleCoachApi } from "./handler.ts";
import { createPanelLoader } from "./panel-source.ts";

// O carregador guarda os contratos por alguns segundos entre as chamadas da mesma instância.
let panelLoader: ReturnType<typeof createPanelLoader> | null = null;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();

  const service = createServiceClient();
  if (!service) {
    console.error("coach-api: SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente");
    return jsonResponse(
      { error: "API não configurada", code: "api_misconfigured" },
      500,
    );
  }

  return handleCoachApi(req, {
    authenticate: authenticateUser,
    rpc: (name, args) => service.rpc(name, args),
    loadPanel: (coachId) => {
      panelLoader ??= createPanelLoader(service);
      return panelLoader(coachId);
    },
  });
});
