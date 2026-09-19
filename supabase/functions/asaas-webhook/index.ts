import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Never acknowledge or mutate payments through the retired, non-atomic receiver.
Deno.serve(() =>
  new Response(
    JSON.stringify({
      error: "Webhook legado desativado; configure asaas-store-webhook",
      code: "legacy_webhook_retired",
    }),
    {
      status: 410,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  )
);
