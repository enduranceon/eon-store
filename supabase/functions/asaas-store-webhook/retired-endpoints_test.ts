type Handler = (request: Request) => Response | Promise<Response>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

for (
  const [endpoint, expectedCode, load] of [
    [
      "asaas-webhook",
      "legacy_webhook_retired",
      () => import("../asaas-webhook/index.ts"),
    ],
    [
      "sync-asaas-payments",
      "legacy_sync_retired",
      () => import("../sync-asaas-payments/index.ts"),
    ],
    [
      "create-asaas-charge",
      "api_required",
      () => import("../create-asaas-charge/index.ts"),
    ],
    [
      "generate-assessment-charge",
      "api_required",
      () => import("../generate-assessment-charge/index.ts"),
    ],
  ] as const
) {
  Deno.test(`retired ${endpoint} cannot mutate payments even with configured credentials`, async () => {
    const originalServe = Deno.serve;
    const originalFetch = globalThis.fetch;
    const environment = {
      SUPABASE_URL: "https://supabase.example.test",
      SUPABASE_ANON_KEY: "test-public-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
      ASAAS_API_KEY: "test-provider-key",
      ASAAS_BASE_URL: "https://asaas.example.test/v3",
      ASAAS_WEBHOOK_TOKEN: "test-legacy-token",
    };
    const previous = new Map(
      Object.keys(environment).map((key) => [key, Deno.env.get(key)]),
    );
    let handler: Handler | undefined;
    let requests = 0;
    let administrator = false;
    try {
      for (const [key, value] of Object.entries(environment)) {
        Deno.env.set(key, value);
      }
      Deno.serve = ((callback: Handler) => {
        handler = callback;
        return {};
      }) as typeof Deno.serve;
      globalThis.fetch = (input) => {
        requests += 1;
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        assert(
          url.origin === environment.SUPABASE_URL,
          "retired endpoint contacted Asaas",
        );
        if (url.pathname === "/auth/v1/user") {
          return Promise.resolve(
            Response.json({ id: "90000000-0000-4000-a000-000000000003" }),
          );
        }
        assert(
          url.pathname === "/rest/v1/rpc/is_app_admin",
          "retired endpoint accessed payment data",
        );
        return Promise.resolve(Response.json(administrator));
      };
      await load();
      assert(handler, "endpoint did not register a handler");
      const request = (authenticated = false) =>
        new Request(`https://example.test/${endpoint}`, {
          method: "POST",
          headers: {
            ...(authenticated
              ? { Authorization: "Bearer test-user-token" }
              : {}),
            "asaas-access-token": environment.ASAAS_WEBHOOK_TOKEN,
          },
          body: JSON.stringify({
            action: "create",
            event: "PAYMENT_RECEIVED",
            payment: { id: "pay_test" },
          }),
        });
      if (endpoint !== "asaas-webhook") {
        assert(
          (await handler(request())).status === 401,
          "anonymous caller bypassed authorization",
        );
        assert(requests === 0, "anonymous request reached a dependency");
        assert(
          (await handler(request(true))).status === 403,
          "non-admin caller bypassed authorization",
        );
      }
      administrator = true;
      const response = await handler(request(true));
      assert(response.status === 410, "retired endpoint accepted an operation");
      assert(
        (await response.json()).code === expectedCode,
        "retirement reason changed",
      );
      assert(
        requests === (endpoint === "asaas-webhook" ? 0 : 4),
        "unexpected dependency calls",
      );
    } finally {
      Deno.serve = originalServe;
      globalThis.fetch = originalFetch;
      for (const [key, value] of previous) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  });
}
