import {
  handlePaymentsRequest,
  isValidIsoDate,
  projectManualInstallments,
} from "./payments.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("manual payment projection preserves the configured cadence", () => {
  const projection = projectManualInstallments({
    id: "00000000-0000-4000-8000-000000000001",
    installments: 3,
    credit_days_first: 1,
    credit_days_between: 30,
  }, "2026-07-24");

  assert(projection.length === 3, "installment count changed");
  assert(projection[0].credit_date === "2026-07-27", "weekend was not skipped");
  assert(
    projection[1].credit_date === "2026-08-26",
    "second installment cadence changed",
  );
  assert(
    projection[2].number === 3 && projection[2].total === 3,
    "sequence metadata changed",
  );
});

Deno.test("manual payment projection skips Brazilian national holidays", () => {
  const projection = projectManualInstallments({
    id: "00000000-0000-4000-8000-000000000001",
    installments: 1,
    credit_days_first: 0,
    credit_days_between: 30,
  }, "2026-11-20");

  assert(
    projection[0].credit_date === "2026-11-23",
    "holiday and weekend were not skipped",
  );
});

Deno.test("manual payment dates reject impossible calendar values", () => {
  assert(isValidIsoDate("2026-02-28"), "valid date was rejected");
  assert(!isValidIsoDate("2026-02-30"), "impossible date was accepted");
  assert(!isValidIsoDate("26-02-28"), "non-ISO date was accepted");
});

Deno.test("manual payment route derives the schedule and forwards the admin actor", async () => {
  let rpcName = "";
  let rpcArguments: Record<string, unknown> = {};
  const methodQuery = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    maybeSingle() {
      return Promise.resolve({
        data: {
          id: "00000000-0000-4000-8000-000000000001",
          installments: 2,
          credit_days_first: 1,
          credit_days_between: 30,
        },
        error: null,
      });
    },
  };
  const supabase = {
    from(table: string) {
      assert(table === "payment_methods", "unexpected table lookup");
      return methodQuery;
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcName = name;
      rpcArguments = args;
      return Promise.resolve({ data: { installments: 2 }, error: null });
    },
  };

  const response = await handlePaymentsRequest(
    new Request("https://example.test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payment_method_id: "00000000-0000-4000-8000-000000000001",
        payment_date: "2026-07-24",
        total: 101.01,
      }),
    }),
    "/orders/presale/00000000-0000-4000-8000-000000000002/manual-payment",
    supabase as never,
    "00000000-0000-4000-8000-000000000003",
  );

  assert(response?.status === 200, "manual payment route did not succeed");
  assert(
    rpcName === "api_record_manual_payment",
    "wrong database operation was called",
  );
  assert(
    rpcArguments.p_actor_id === "00000000-0000-4000-8000-000000000003",
    "authenticated actor was not forwarded",
  );
  const installments = rpcArguments.p_installments as Array<
    Record<string, unknown>
  >;
  assert(
    installments.length === 2,
    "server-side installment projection was not used",
  );
  assert(
    installments[0].credit_date === "2026-07-27",
    "projected credit date changed",
  );
});

Deno.test("manual payment adjustment forwards discount data atomically", async () => {
  let rpcArguments: Record<string, unknown> = {};
  const supabase = {
    rpc(name: string, args: Record<string, unknown>) {
      assert(name === "api_adjust_manual_payment", "wrong adjustment RPC");
      rpcArguments = args;
      return Promise.resolve({
        data: { adjusted: true, audit_logged: true },
        error: null,
      });
    },
  };

  const response = await handlePaymentsRequest(
    new Request("https://example.test", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        total: 90,
        manual_discount: 10,
        discount_reason: "Fidelidade",
        discount_recurring: true,
      }),
    }),
    "/orders/contract/00000000-0000-4000-8000-000000000002/manual-payment",
    supabase as never,
    "00000000-0000-4000-8000-000000000003",
  );

  assert(response?.status === 200, "manual adjustment route did not succeed");
  assert(rpcArguments.p_total === 90, "adjusted total changed");
  assert(rpcArguments.p_manual_discount === 10, "manual discount changed");
  assert(rpcArguments.p_discount_recurring === true, "recurring flag changed");
});
