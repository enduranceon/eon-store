import { jsonResponse } from "./http.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function storePilotOrderIds(value: string | undefined): string[] {
  const ids = (value ?? "").split(",").map((id) => id.trim().toLowerCase());
  // A malformed allowlist must not partially enable real charges.
  return ids.length > 0 && ids.every((id) => UUID.test(id))
    ? [...new Set(ids)]
    : [];
}

export async function checkAsaasChargeRollout(
  req: Request,
  path: string,
  configuredIds = Deno.env.get("ASAAS_STORE_PILOT_ORDER_IDS"),
  enabled = Deno.env.get("ASAAS_STORE_CHARGES_ENABLED"),
): Promise<Response | null> {
  const match = path.match(
    /^\/orders\/(stock|presale|contract|event)\/([^/]+)\/charge$/,
  );
  if (req.method !== "POST" || !match) return null;
  const [, orderType, orderId] = match;
  if (
    enabled === "true" && orderType === "stock" &&
    storePilotOrderIds(configuredIds).includes(orderId.toLowerCase())
  ) {
    try {
      const body = await req.clone().json();
      const installments = body?.installments === undefined
        ? 1
        : body.installments;
      if (
        (body?.billing_type === "PIX" && installments === 1) ||
        (body?.billing_type === "CREDIT_CARD" &&
          Number.isInteger(installments) &&
          installments >= 1 && installments <= 12)
      ) {
        return null;
      }
    } catch {
      return jsonResponse({
        error: "Dados da cobranca invalidos",
        code: "invalid_request",
      }, 400);
    }
    return jsonResponse({
      error:
        "O piloto permite Pix a vista ou cartao de credito de 1 a 12 parcelas.",
      code: "asaas_pilot_payment_method_disabled",
    }, 403);
  }
  return jsonResponse({
    error:
      "Emissao Asaas ainda nao liberada para este pedido. Use o fluxo externo/manual.",
    code: "asaas_rollout_disabled",
  }, 403);
}
