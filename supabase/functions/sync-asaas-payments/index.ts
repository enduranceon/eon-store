import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { jsonResponse, optionsResponse } from "../_shared/http.ts";
import { requireAdmin } from "../_shared/requireAdmin.ts";

// Legacy backfill could erase manual receipts and bypass installment checks.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  const gate = await requireAdmin(req);
  if (!gate.ok) return jsonResponse({ error: "unauthorized" }, gate.status);
  return jsonResponse({
    error:
      "Sincronizacao legada desativada. O piloto recebe pagamentos pelo webhook da loja.",
    code: "legacy_sync_retired",
  }, 410);
});
