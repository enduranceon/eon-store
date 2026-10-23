import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";
import {
  asaasLookupConfigured,
  type SubscriptionLinkDeps,
  syncSubscriptionInvoiceLinks,
} from "../_shared/asaas-subscription-link.ts";

// "Buscar link no Asaas" no card da renovação mensal automática. Só consulta
// a assinatura no Asaas; a gravação passa por apply_assessment_subscription_lookup.

const PATH = "/renewals/subscription-link";
const MAX_IDS = 50;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleSubscriptionLinkRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
  options: { deps?: SubscriptionLinkDeps; configured?: boolean } = {},
): Promise<Response | null> {
  if (path !== PATH) return null;
  if (req.method !== "POST") {
    return jsonResponse({ error: "Método não permitido", code: "method_not_allowed" }, 405);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const ids = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).contract_ids
    : null;
  if (
    !Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS ||
    ids.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id)) ||
    Object.keys(body as Record<string, unknown>).length !== 1
  ) {
    return jsonResponse({ error: "Contratos inválidos", code: "invalid_request" }, 400);
  }

  if (!(options.configured ?? asaasLookupConfigured())) {
    return jsonResponse({
      error: "A consulta ao Asaas não está configurada (chave de produção nos secrets das Edge Functions).",
      code: "asaas_not_configured",
    }, 503);
  }

  try {
    const data = await syncSubscriptionInvoiceLinks(supabase, {
      contractIds: [...new Set(ids.map((id) => String(id).toLowerCase()))],
      actorId,
      deps: options.deps,
    });
    return jsonResponse({ data });
  } catch (error) {
    console.error(
      "api-v1 subscription link:",
      (error as { code?: string })?.code,
      error instanceof Error ? error.message : (error as { message?: string })?.message,
    );
    return jsonResponse({
      error: "Não foi possível buscar o link no Asaas",
      code: "subscription_link_failed",
    }, 502);
  }
}
