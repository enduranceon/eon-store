import { storePilotOrderIds } from "../_shared/asaas-rollout.ts";

type Result = { data: { status?: string } | null; error: unknown };
export interface WebhookDependencies {
  token?: string;
  orderIds?: string;
  process: (
    event: Record<string, unknown>,
    orderIds: string[],
  ) => PromiseLike<Result>;
}

function reply(status: number, code: string): Response {
  return new Response(JSON.stringify({ ok: status === 200, code }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function secretsMatch(received: string, expected: string): boolean {
  const a = new TextEncoder().encode(received);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function handleStoreWebhook(
  req: Request,
  deps: WebhookDependencies,
): Promise<Response> {
  if (req.method !== "POST") return reply(405, "method_not_allowed");
  const orderIds = storePilotOrderIds(deps.orderIds);
  if (!deps.token || deps.token.length < 32 || orderIds.length === 0) {
    return reply(503, "webhook_disabled");
  }
  if (!secretsMatch(req.headers.get("asaas-access-token") ?? "", deps.token)) {
    return reply(401, "unauthorized");
  }
  // Bound the authenticated body before decoding or persisting personal data.
  const reader = req.body?.getReader();
  if (!reader) return reply(400, "invalid_payload");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 256 * 1024) {
        await reader.cancel();
        return reply(413, "payload_too_large");
      }
      chunks.push(value);
    }
  } catch {
    return reply(400, "invalid_payload");
  }
  let event: Record<string, unknown>;
  try {
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    event = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !event || Array.isArray(event) || typeof event !== "object" ||
      typeof event.id !== "string" || !event.id.trim() ||
      event.id.length > 200 ||
      typeof event.event !== "string" || !event.event.trim() ||
      event.event.length > 100
    ) {
      return reply(400, "invalid_payload");
    }
    if (event.event.startsWith("PAYMENT_")) {
      const payment = event.payment as Record<string, unknown> | null;
      if (
        !payment || typeof payment !== "object" || Array.isArray(payment) ||
        typeof payment.id !== "string" || !payment.id.trim() ||
        payment.id.length > 200
      ) {
        return reply(400, "invalid_payload");
      }
    }
  } catch {
    return reply(400, "invalid_payload");
  }
  try {
    const { data, error } = await deps.process(event, orderIds);
    if (error || !data) return reply(503, "persistence_failed");
    if (data.status === "pending") return reply(503, "charge_link_pending");
    if (
      !["processed", "ignored", "reconciliation_required"].includes(
        data.status ?? "",
      )
    ) {
      return reply(503, "unexpected_result");
    }
    if (data.status === "reconciliation_required") {
      console.warn("asaas-store-webhook: reconciliation required", event.id);
    }
    // Only committed events are acknowledged. Pending links rely on Asaas retry.
    return reply(200, data.status!);
  } catch {
    return reply(503, "persistence_failed");
  }
}
