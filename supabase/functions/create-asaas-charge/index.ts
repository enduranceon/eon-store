import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { jsonResponse, optionsResponse } from "../_shared/http.ts";
import { requireAdmin } from "../_shared/requireAdmin.ts";

// Retired: all supported callers use the guarded api-v1 operation ledger.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  const gate = await requireAdmin(req);
  if (!gate.ok) return jsonResponse({ error: "unauthorized" }, gate.status);
  return jsonResponse({
    error: "Use api-v1 para operar cobrancas",
    code: "api_required",
  }, 410);
});
