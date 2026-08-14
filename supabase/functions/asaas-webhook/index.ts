import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const EVENT_MAP: Record<string, string> = {
  PAYMENT_RECEIVED:  "paid",
  PAYMENT_CONFIRMED: "paid",
  PAYMENT_DELETED:   "cancelled",
  PAYMENT_REFUNDED:  "refunded",
  PAYMENT_OVERDUE:   "overdue",
  PAYMENT_RESTORED:  "charge_sent",
};

const TERMINAL_PRODUCT_EVENTS = new Set([
  "PAYMENT_DELETED",
  "PAYMENT_REFUNDED",
]);

const RECONCILIATION_STATUSES = new Set([
  "handled",
  "already_completed",
  "unmatched",
  "reconciliation_required",
]);

function throwIfDatabaseError(error: any, operation: string) {
  if (!error) return;
  throw new Error(`${operation}: ${error.message || "database error"}`);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mapPaymentMethod(asaasMethod: string, installments?: number): string {
  if (!asaasMethod) return "pix";
  const m = asaasMethod.toUpperCase();
  if (m === "PIX")    return "pix";
  if (m === "BOLETO") return "boleto";
  if (m === "CREDIT_CARD") {
    const n = Number(installments) || 1;
    return n > 1 ? `card_${n}x` : "credit_card";
  }
  return asaasMethod.toLowerCase();
}

async function upsertAsaasPayment(
  supabase: any,
  payment: any,
  orderId: string | null,
  orderType: string | null,
): Promise<void> {
  if (!payment?.id) return;

  if (orderId && orderType && ["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"].includes(payment.status)) {
    const { error: delErr } = await supabase
      .from("asaas_payments")
      .delete()
      .eq("order_id", orderId)
      .eq("order_type", orderType)
      .eq("source", "manual");
    throwIfDatabaseError(delErr, "clear manual payment cache");
  }

  const row = {
    asaas_payment_id:     payment.id,
    asaas_customer_id:    payment.customer || null,
    installment_group_id: payment.installment || null,
    installment_number:   payment.installmentNumber ?? null,
    total_installments:   null,
    billing_type:         payment.billingType || null,
    status:               payment.status,
    value:                Number(payment.value) || 0,
    net_value:            payment.netValue != null ? Number(payment.netValue) : null,
    due_date:             payment.dueDate || null,
    payment_date:         payment.paymentDate || null,
    credit_date:          payment.creditDate || null,
    description:          payment.description || null,
    external_reference:   payment.externalReference || null,
    order_id:             orderId,
    order_type:           orderType,
    raw:                  payment,
    last_synced_at:       new Date().toISOString(),
  };
  const { error } = await supabase
    .from("asaas_payments")
    .upsert(row, { onConflict: "asaas_payment_id" });
  throwIfDatabaseError(error, "upsert Asaas payment cache");
}

async function updateContractFromAsaasEvent(
  supabase: any,
  contract: any,
  payment: any,
  newStatus: string,
): Promise<void> {
  const updates: Record<string, unknown> = { payment_status: newStatus };
  if (newStatus === "paid") {
    updates.payment_date = payment.paymentDate || new Date().toISOString().split("T")[0];
    if (payment.billingType) {
      updates.payment_method = mapPaymentMethod(payment.billingType, contract.installments);
    }
  }
  if (newStatus === "cancelled") {
    updates.asaas_charge_id = null;
    updates.asaas_payment_link = null;
    updates.asaas_pix_qrcode = null;
    updates.asaas_pix_copy = null;
  }

  const { error } = await supabase
    .from("assessment_contracts")
    .update(updates)
    .eq("id", contract.id);
  throwIfDatabaseError(error, "update assessment contract");
}

export async function handleAsaasWebhook(
  req: Request,
  supabase: any,
  expectedToken: string | undefined,
): Promise<Response> {
  const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  const unauthorized = () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  const misconfigured = () => new Response(JSON.stringify({ error: "webhook misconfigured" }), { status: 500, headers: { "Content-Type": "application/json" } });
  const processingFailed = () => new Response(JSON.stringify({ error: "webhook processing failed" }), { status: 500, headers: { "Content-Type": "application/json" } });

  // ✅ SEGURANÇA: token agora é OBRIGATÓRIO. Sem token configurado = recusa todas as requisições.
  if (!expectedToken) {
    console.error("asaas-webhook: ASAAS_WEBHOOK_TOKEN não configurado");
    return misconfigured();
  }
  const received = req.headers.get("asaas-access-token") || "";
  if (received !== expectedToken) {
    console.warn("asaas-webhook: token mismatch");
    return unauthorized();
  }

  try {
    if (!supabase) throw new Error("Supabase client is not configured");

    const body    = await req.json().catch(() => ({}));
    const event   = body?.event as string;
    const payment = body?.payment;
    if (!event || !payment?.id) return ok();

    const chargeId = payment.id;
    console.log("[asaas-webhook]", event, "chargeId:", chargeId);

    if (event === "PAYMENT_UPDATED") {
      let matchedOrderId: string | null = null;
      let matchedOrderType: string | null = null;

      if (payment.dueDate) {
        for (const [table, type] of [
          ["presale_orders", "presale"],
          ["stock_orders", "stock"],
          ["assessment_contracts", "contract"],
        ]) {
          const { data: row, error: lookupError } = await supabase
            .from(table).select("id").eq("asaas_charge_id", chargeId).maybeSingle();
          throwIfDatabaseError(lookupError, `find ${table} for due date update`);
          if (row) {
            const { error: updateError } = await supabase
              .from(table)
              .update({ due_date: payment.dueDate })
              .eq("id", row.id);
            throwIfDatabaseError(updateError, `update ${table} due date`);
            matchedOrderId   = row.id;
            matchedOrderType = type;
            console.log("[asaas-webhook] updated due_date on", table, row.id);
            break;
          }
        }
      }
      await upsertAsaasPayment(supabase, payment, matchedOrderId, matchedOrderType);
      return ok();
    }

    const newStatus = EVENT_MAP[event];
    if (!newStatus) {
      await upsertAsaasPayment(supabase, payment, null, null);
      return ok();
    }

    // Cancelamentos e estornos de pedidos de produto podem chegar do Asaas
    // entre a etapa externa e a conclusão da operação local. A RPC aplica a
    // transição idempotente com os efeitos de estoque/cupom corretos; este
    // webhook não pode sobrescrever esse resultado diretamente.
    if (TERMINAL_PRODUCT_EVENTS.has(event)) {
      const { data: reconciliation, error: reconciliationError } = await supabase.rpc(
        "reconcile_asaas_terminal_order_event",
        {
          p_event: event,
          p_charge_id: chargeId,
          p_payment: payment,
        },
      );
      throwIfDatabaseError(
        reconciliationError,
        "reconcile terminal product order event",
      );

      const reconciliationResult = reconciliation && typeof reconciliation === "object"
        ? reconciliation as Record<string, unknown>
        : null;
      const reconciliationStatus = stringOrNull(reconciliationResult?.status);
      if (!reconciliationStatus || !RECONCILIATION_STATUSES.has(reconciliationStatus)) {
        throw new Error("terminal order reconciliation returned an invalid status");
      }

      const reconciledOrderId = stringOrNull(reconciliationResult?.order_id);
      const reconciledOrderType = stringOrNull(reconciliationResult?.order_type);

      if (reconciliationStatus !== "unmatched") {
        await upsertAsaasPayment(
          supabase,
          payment,
          reconciledOrderId,
          reconciledOrderType,
        );
        console.log(
          "[asaas-webhook] terminal product event reconciled",
          reconciliationStatus,
          reconciledOrderType,
          reconciledOrderId,
        );
        return ok();
      }

      // `unmatched` must never fall through to the legacy direct product
      // updates below. Contracts do not use product-order operations, so they
      // retain their previous webhook fallback.
      const { data: contract, error: contractLookupError } = await supabase
        .from("assessment_contracts")
        .select("id, payment_status, installments")
        .eq("asaas_charge_id", chargeId)
        .maybeSingle();
      throwIfDatabaseError(contractLookupError, "find contract for terminal event");

      if (contract) {
        await updateContractFromAsaasEvent(supabase, contract, payment, newStatus);
        await upsertAsaasPayment(supabase, payment, contract.id, "contract");
        console.log("[asaas-webhook] assessment_contract", contract.id, "→", newStatus);
        return ok();
      }

      await upsertAsaasPayment(
        supabase,
        payment,
        reconciledOrderId,
        reconciledOrderType,
      );
      console.log("[asaas-webhook] no product operation or contract for chargeId", chargeId);
      return ok();
    }

    const { data: presaleOrder, error: presaleLookupError } = await supabase
      .from("presale_orders")
      .select("id, payment_status")
      .eq("asaas_charge_id", chargeId)
      .maybeSingle();
    throwIfDatabaseError(presaleLookupError, "find presale order");

    if (presaleOrder) {
      const updates: Record<string, unknown> = { payment_status: newStatus };
      if (newStatus === "paid") {
        updates.payment_date = payment.paymentDate || new Date().toISOString().split("T")[0];
      }
      if (newStatus === "cancelled") {
        updates.asaas_charge_id    = null;
        updates.asaas_payment_link = null;
        updates.asaas_pix_qrcode   = null;
        updates.asaas_pix_copy     = null;
      }
      const { error: updateError } = await supabase
        .from("presale_orders")
        .update(updates)
        .eq("id", presaleOrder.id);
      throwIfDatabaseError(updateError, "update presale order");
      await upsertAsaasPayment(supabase, payment, presaleOrder.id, "presale");
      console.log("[asaas-webhook] presale_order", presaleOrder.id, "→", newStatus);
      return ok();
    }

    const { data: stockOrder, error: stockLookupError } = await supabase
      .from("stock_orders")
      .select("id, payment_status")
      .eq("asaas_charge_id", chargeId)
      .maybeSingle();
    throwIfDatabaseError(stockLookupError, "find stock order");

    if (stockOrder) {
      const updates: Record<string, unknown> = { payment_status: newStatus };
      if (newStatus === "paid") {
        updates.payment_date = payment.paymentDate || new Date().toISOString().split("T")[0];
      }
      if (newStatus === "cancelled") {
        updates.asaas_charge_id    = null;
        updates.asaas_payment_link = null;
        updates.asaas_pix_qrcode   = null;
        updates.asaas_pix_copy     = null;
      }
      const { error: updateError } = await supabase
        .from("stock_orders")
        .update(updates)
        .eq("id", stockOrder.id);
      throwIfDatabaseError(updateError, "update stock order");
      await upsertAsaasPayment(supabase, payment, stockOrder.id, "stock");
      console.log("[asaas-webhook] stock_order", stockOrder.id, "→", newStatus);
      return ok();
    }

    const { data: contract, error: contractLookupError } = await supabase
      .from("assessment_contracts")
      .select("id, payment_status, installments")
      .eq("asaas_charge_id", chargeId)
      .maybeSingle();
    throwIfDatabaseError(contractLookupError, "find assessment contract");

    if (contract) {
      await updateContractFromAsaasEvent(supabase, contract, payment, newStatus);
      await upsertAsaasPayment(supabase, payment, contract.id, "contract");
      console.log("[asaas-webhook] assessment_contract", contract.id, "→", newStatus);
      return ok();
    }

    await upsertAsaasPayment(supabase, payment, null, null);
    console.log("[asaas-webhook] no match for chargeId", chargeId);
    return ok();
  } catch (e) {
    console.error("[asaas-webhook] error", e);
    return processingFailed();
  }
}

if (import.meta.main) {
  Deno.serve((req: Request) => {
    // `Asaas_webhook_token` is the legacy production secret name. Keep the
    // canonical all-caps name first, so environments can be standardized
    // without taking the webhook offline during the transition.
    const expectedToken = Deno.env.get("ASAAS_WEBHOOK_TOKEN")
      ?? Deno.env.get("Asaas_webhook_token");
    const supabase = expectedToken
      ? createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      )
      : null;
    return handleAsaasWebhook(req, supabase, expectedToken);
  });
}
