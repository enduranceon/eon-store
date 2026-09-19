import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createServiceClient } from "../_shared/serviceClient.ts";
import { handleStoreWebhook } from "./handler.ts";

Deno.serve((req: Request) =>
  handleStoreWebhook(req, {
    token: Deno.env.get("ASAAS_STORE_WEBHOOK_TOKEN"),
    orderIds: Deno.env.get("ASAAS_STORE_PILOT_ORDER_IDS"),
    process: (event, orderIds) => {
      const client = createServiceClient();
      if (!client) throw new Error("Server misconfigured");
      return client.rpc("process_asaas_store_webhook", {
        p_event: event,
        p_allowed_order_ids: orderIds,
      });
    },
  })
);
