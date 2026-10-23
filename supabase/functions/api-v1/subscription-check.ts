import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";
import { asaasLookupConfigured } from "../_shared/asaas-subscription-link.ts";
import {
  checkAutoRenewalSubscriptions,
  enableAutoRenewalFromSubscription,
  type SubscriptionCheckDeps,
} from "../_shared/asaas-subscription-check.ts";

// "Conferir assinaturas no Asaas" no quadro de Renovações: lista os planos
// mensais com a renovação automática desligada e quem tem assinatura mensal
// ativa no Asaas (só consulta); "Ligar automática" confere de novo e grava.

const CHECK_PATH = "/renewals/subscription-check";
const ENABLE_PATH = "/renewals/subscription-check/enable";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBSCRIPTION_PATTERN = /^sub_[A-Za-z0-9]{4,40}$/;

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const raw = await req.text();
  if (!raw.trim()) return {};
  try {
    const body = JSON.parse(raw);
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function failure(error: unknown, operation: string): Response {
  const code = (error as { code?: string })?.code;
  const message = error instanceof Error ? error.message : (error as { message?: string })?.message;
  console.error(`api-v1 subscription check ${operation}:`, code, message);
  if (code === "P0002") {
    return jsonResponse({ error: message || "Contrato não encontrado", code: "not_found" }, 404);
  }
  if (code === "P0001") {
    return jsonResponse({ error: message, code: "conflict" }, 409);
  }
  if (code === "22023") {
    return jsonResponse({ error: message || "Dados inválidos", code: "invalid_request" }, 400);
  }
  return jsonResponse({
    error: "Não foi possível consultar as assinaturas no Asaas",
    code: "subscription_check_failed",
  }, 502);
}

export async function handleSubscriptionCheckRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
  options: { deps?: SubscriptionCheckDeps; configured?: boolean } = {},
): Promise<Response | null> {
  if (path !== CHECK_PATH && path !== ENABLE_PATH) return null;
  if (req.method !== "POST") {
    return jsonResponse({ error: "Método não permitido", code: "method_not_allowed" }, 405);
  }

  const body = await readBody(req);
  const enable = path === ENABLE_PATH;
  const valid = body !== null && (enable
    ? Object.keys(body).length === 2 &&
      typeof body.contract_id === "string" && UUID_PATTERN.test(body.contract_id) &&
      typeof body.subscription_id === "string" && SUBSCRIPTION_PATTERN.test(body.subscription_id)
    : Object.keys(body).length === 0);
  if (!valid) {
    return jsonResponse({ error: "Requisição inválida", code: "invalid_request" }, 400);
  }

  if (!(options.configured ?? asaasLookupConfigured())) {
    return jsonResponse({
      error: "A consulta ao Asaas não está configurada (chave de produção nos secrets das Edge Functions).",
      code: "asaas_not_configured",
    }, 503);
  }

  if (!enable) {
    try {
      return jsonResponse({ data: await checkAutoRenewalSubscriptions(supabase, { deps: options.deps }) });
    } catch (error) {
      return failure(error, "list");
    }
  }

  try {
    const result = await enableAutoRenewalFromSubscription(supabase, {
      contractId: String(body!.contract_id).toLowerCase(),
      subscriptionId: String(body!.subscription_id),
      actorId,
      deps: options.deps,
    });
    if (!result.ok) {
      return jsonResponse({ error: result.message, code: result.code }, 409);
    }
    return jsonResponse({ data: { contract: result.contract } });
  } catch (error) {
    return failure(error, "enable");
  }
}
