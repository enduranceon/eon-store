import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { jsonResponse, optionsResponse } from "../_shared/http.ts";
import { requireAdmin } from "../_shared/requireAdmin.ts";
import { createServiceClient } from "../_shared/serviceClient.ts";
import { handleBillingRequest } from "./billing.ts";
import { handleCatalogRequest } from "./catalog.ts";
import { handleChargeLifecycleRequest } from "./charge-lifecycle.ts";
import { handleChargeRequest } from "./charges.ts";
import { handleContractRequest } from "./contracts.ts";
import { handleContractLifecycleRequest } from "./contract-lifecycle.ts";
import { handleOrdersRequest } from "./orders.ts";
import { handlePaymentsRequest } from "./payments.ts";
import { handleRenewalRequest } from "./renewals.ts";
import { handleReturnsRequest } from "./returns.ts";

function routePath(req: Request): string {
  const pathname = new URL(req.url).pathname;
  const functionPrefix = "/api-v1";
  const prefixIndex = pathname.indexOf(functionPrefix);

  if (prefixIndex === -1) return pathname;
  return pathname.slice(prefixIndex + functionPrefix.length) || "/";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();

  const gate = await requireAdmin(req);
  if (!gate.ok) {
    const code = gate.error || "unauthorized";
    const message = gate.status === 403
      ? "Esta conta não tem acesso ao painel"
      : "Sessão inválida ou expirada";

    return jsonResponse({ error: message, code }, gate.status);
  }

  const path = routePath(req);

  if (req.method === "GET" && path === "/session") {
    return jsonResponse({
      data: {
        user_id: gate.userId,
        role: "admin",
      },
    });
  }

  const serviceClient = createServiceClient();
  if (!serviceClient) {
    console.error("api-v1: SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente");
    return jsonResponse({
      error: "API não configurada",
      code: "api_misconfigured",
    }, 500);
  }

  const catalogResponse = await handleCatalogRequest(req, path, serviceClient);
  if (catalogResponse) return catalogResponse;

  const returnsResponse = await handleReturnsRequest(req, path, serviceClient);
  if (returnsResponse) return returnsResponse;

  const chargeResponse = await handleChargeRequest(
    req,
    path,
    serviceClient,
    gate.userId!,
  );
  if (chargeResponse) return chargeResponse;

  const chargeLifecycleResponse = await handleChargeLifecycleRequest(
    req,
    path,
    serviceClient,
    gate.userId!,
  );
  if (chargeLifecycleResponse) return chargeLifecycleResponse;

  const contractResponse = await handleContractRequest(
    req,
    path,
    serviceClient,
    gate.userId!,
  );
  if (contractResponse) return contractResponse;

  const contractLifecycleResponse = await handleContractLifecycleRequest(
    req,
    path,
    serviceClient,
    gate.userId!,
  );
  if (contractLifecycleResponse) return contractLifecycleResponse;

  const billingResponse = await handleBillingRequest(
    req,
    path,
    serviceClient,
    gate.userId!,
  );
  if (billingResponse) return billingResponse;

  const renewalResponse = await handleRenewalRequest(
    req,
    path,
    serviceClient,
    gate.userId!,
  );
  if (renewalResponse) return renewalResponse;

  const paymentsResponse = await handlePaymentsRequest(
    req,
    path,
    serviceClient,
    gate.userId!,
  );
  if (paymentsResponse) return paymentsResponse;

  const ordersResponse = await handleOrdersRequest(
    req,
    path,
    serviceClient,
    gate.userId!,
  );
  if (ordersResponse) return ordersResponse;

  return jsonResponse({
    error: "Rota não encontrada",
    code: "not_found",
  }, 404);
});
