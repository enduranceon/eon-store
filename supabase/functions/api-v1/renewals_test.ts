import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { handleRenewalRequest } from "./renewals.ts";

const RENEWAL_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const LEASE_TOKEN = "44444444-4444-4444-8444-444444444444";
const PATH = `/orders/contract/${RENEWAL_ID}/renewal-resolution`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    resolution: "non_renewal",
    reason_code: "customer_declined",
    reason: "Atleta decidiu não renovar",
    expected_updated_at: "2026-07-27T12:00:00.000Z",
    expected_payment_status: "charge_sent",
    expected_charge_id: null,
    external_cancellation_confirmed: false,
    external_confirmation_note: null,
    service_started: false,
    ...overrides,
  };
}

function completedResult(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: OPERATION_ID,
    status: "completed",
    renewal_id: RENEWAL_ID,
    parent_contract_id: "55555555-5555-4555-8555-555555555555",
    resolution: "non_renewal",
    reason_code: "customer_declined",
    renewal_status: "voided",
    renewal_payment_status: "cancelled",
    parent_status: "completed",
    parent_non_renewal: true,
    cancelled_open_payouts: 0,
    cancelled_charge_id: null,
    external_charge_removed: false,
    ...overrides,
  };
}

function request(
  body: Record<string, unknown>,
  idempotencyKey = "renewal:test:0001",
): Request {
  return new Request(`https://example.test/api-v1${PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

async function responseBody(
  response: Response,
): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function withAsaas(test: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalBase = Deno.env.get("ASAAS_BASE_URL");
  const originalKey = Deno.env.get("ASAAS_API_KEY");
  Deno.env.set("ASAAS_BASE_URL", "https://asaas.test/v3");
  Deno.env.set("ASAAS_API_KEY", "test-key");
  try {
    await test();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) Deno.env.delete("ASAAS_BASE_URL");
    else Deno.env.set("ASAAS_BASE_URL", originalBase);
    if (originalKey === undefined) Deno.env.delete("ASAAS_API_KEY");
    else Deno.env.set("ASAAS_API_KEY", originalKey);
  }
}

Deno.test("Renewal resolution without a charge records that no provider action was needed", async () => {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "prepare_assessment_renewal_resolution") {
        return Promise.resolve({
          data: {
            operation_id: OPERATION_ID,
            status: "prepared",
            renewal_id: RENEWAL_ID,
            resolution: "non_renewal",
            reason_code: "customer_declined",
          },
          error: null,
        });
      }
      if (name === "claim_assessment_renewal_resolution") {
        return Promise.resolve({
          data: {
            status: "prepared",
            lease_acquired: true,
            lease_token: LEASE_TOKEN,
          },
          error: null,
        });
      }
      if (name === "record_assessment_renewal_external_result") {
        return Promise.resolve({
          data: { external_result: args.p_external_result },
          error: null,
        });
      }
      if (name === "complete_assessment_renewal_resolution") {
        return Promise.resolve({
          data: completedResult(),
          error: null,
        });
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  } as unknown as SupabaseClient;

  const response = await handleRenewalRequest(
    request(validBody()),
    PATH,
    client,
    ACTOR_ID,
  );

  assert(response?.status === 200, "charge-free resolution did not complete");
  assert(
    rpcCalls.map((call) => call.name).join(",") ===
      "prepare_assessment_renewal_resolution,claim_assessment_renewal_resolution,record_assessment_renewal_external_result,complete_assessment_renewal_resolution",
    "operation sequence changed",
  );
  assert(
    rpcCalls[0].args.p_idempotency_key === "renewal:test:0001",
    "idempotency key was not preserved",
  );
  assert(
    rpcCalls[0].args.p_expected_charge_id === null,
    "null charge snapshot changed",
  );
  const recorded = rpcCalls[2].args.p_external_result as Record<
    string,
    unknown
  >;
  assert(recorded.provider === "none", "a provider action was invented");
  assert(recorded.outcome === "not_required", "no-provider outcome changed");
  assert(
    rpcCalls[3].args.p_external_result ===
      (rpcCalls[2].args.p_external_result as Record<string, unknown>),
    "persisted external result was not reused for completion",
  );
});

Deno.test("External renewal charge requires cancellation confirmation in the prepare RPC", async () => {
  const rpcNames: string[] = [];
  let confirmationValue: unknown;
  const client = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcNames.push(name);
      confirmationValue = args.p_external_cancellation_confirmed;
      return Promise.resolve({
        data: null,
        error: {
          code: "P0001",
          message: "Confirme o cancelamento da cobrança externa",
        },
      });
    },
  } as unknown as SupabaseClient;

  const response = await handleRenewalRequest(
    request(validBody()),
    PATH,
    client,
    ACTOR_ID,
  );
  const body = await responseBody(response!);

  assert(response?.status === 409, "missing confirmation was not rejected");
  assert(body.code === "invalid_transition", "wrong rejection code");
  assert(confirmationValue === false, "false confirmation was not preserved");
  assert(
    rpcNames.join(",") === "prepare_assessment_renewal_resolution",
    "external work started after prepare rejected the request",
  );
});

Deno.test("Confirmed external cancellation reuses the persisted attestation and completes", async () => {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "prepare_assessment_renewal_resolution") {
        return Promise.resolve({
          data: {
            operation_id: OPERATION_ID,
            status: "prepared",
            renewal_id: RENEWAL_ID,
            resolution: "non_renewal",
            reason_code: "customer_declined",
            external_payment_link: "https://external.test/invoice/ABC-123",
            external_invoice_number: "ABC-123",
            external_cancellation_confirmed: true,
            external_confirmation_note: "Cancelada no painel do provedor",
          },
          error: null,
        });
      }
      if (name === "claim_assessment_renewal_resolution") {
        return Promise.resolve({
          data: {
            status: "prepared",
            lease_acquired: true,
            lease_token: LEASE_TOKEN,
          },
          error: null,
        });
      }
      if (name === "record_assessment_renewal_external_result") {
        return Promise.resolve({
          data: { external_result: args.p_external_result },
          error: null,
        });
      }
      if (name === "complete_assessment_renewal_resolution") {
        return Promise.resolve({
          data: completedResult({ external_charge_removed: true }),
          error: null,
        });
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    from: () => {
      throw new Error("Asaas cache must not be read for an external link");
    },
  } as unknown as SupabaseClient;

  const response = await handleRenewalRequest(
    request(validBody({
      external_cancellation_confirmed: true,
      external_confirmation_note: "Nota digitada novamente após recarregar",
    })),
    PATH,
    client,
    ACTOR_ID,
  );

  assert(response?.status === 200, "external resolution did not complete");
  const recorded = rpcCalls[2].args.p_external_result as Record<
    string,
    unknown
  >;
  assert(recorded.provider === "external", "external provider was lost");
  assert(
    recorded.outcome === "operator_confirmed_cancelled",
    "operator confirmation was represented as automatic cancellation",
  );
  assert(recorded.confirmed_by === ACTOR_ID, "confirming operator was lost");
  assert(
    recorded.confirmation_note === "Cancelada no painel do provedor",
    "the persisted confirmation note was not authoritative on retry",
  );
  assert(
    recorded.external_invoice_number === "ABC-123",
    "external invoice audit reference was lost",
  );
  assert(
    recorded.external_payment_link ===
      "https://external.test/invoice/ABC-123",
    "external payment link audit reference was lost",
  );
  assert(
    rpcCalls[3].args.p_external_result === recorded,
    "completion did not receive the persisted attestation",
  );
});

Deno.test("Fresh Asaas renewal cancellation uses the contract cache and persists provider success", async () => {
  await withAsaas(async () => {
    const providerRequests: string[] = [];
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method || "GET";
      providerRequests.push(`${method} ${url.pathname}`);
      if (method === "GET" && url.pathname === "/v3/payments/pay_fresh") {
        return Promise.resolve(Response.json({
          id: "pay_fresh",
          status: "PENDING",
        }));
      }
      if (method === "DELETE" && url.pathname === "/v3/payments/pay_fresh") {
        return Promise.resolve(Response.json({ deleted: true }));
      }
      throw new Error(`unexpected Asaas request ${method} ${url.pathname}`);
    };

    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const queryFilters: Array<[string, unknown]> = [];
    const client = {
      rpc: (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        if (name === "prepare_assessment_renewal_resolution") {
          return Promise.resolve({
            data: {
              operation_id: OPERATION_ID,
              status: "prepared",
              renewal_id: RENEWAL_ID,
              resolution: "non_renewal",
              reason_code: "customer_declined",
              asaas_charge_id: "pay_fresh",
            },
            error: null,
          });
        }
        if (name === "claim_assessment_renewal_resolution") {
          return Promise.resolve({
            data: {
              status: "prepared",
              lease_acquired: true,
              lease_token: LEASE_TOKEN,
            },
            error: null,
          });
        }
        if (name === "record_assessment_renewal_provider_snapshot") {
          return Promise.resolve({
            data: { provider_snapshot: args.p_provider_snapshot },
            error: null,
          });
        }
        if (name === "record_assessment_renewal_external_result") {
          return Promise.resolve({
            data: { external_result: args.p_external_result },
            error: null,
          });
        }
        if (name === "complete_assessment_renewal_resolution") {
          return Promise.resolve({
            data: completedResult({ cancelled_charge_id: "pay_fresh" }),
            error: null,
          });
        }
        throw new Error(`unexpected RPC ${name}`);
      },
      from: (table: string) => {
        assert(table === "asaas_payments", "unexpected cache table");
        const query = {
          select: () => query,
          eq: (column: string, value: unknown) => {
            queryFilters.push([column, value]);
            return query;
          },
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({
              data: [{
                asaas_payment_id: "pay_fresh",
                installment_group_id: null,
                total_installments: 1,
              }],
              error: null,
            }).then(resolve),
        };
        return query;
      },
    } as unknown as SupabaseClient;

    const response = await handleRenewalRequest(
      request(validBody({ expected_charge_id: "pay_fresh" })),
      PATH,
      client,
      ACTOR_ID,
    );

    assert(response?.status === 200, "fresh Asaas cancellation did not finish");
    assert(
      providerRequests.join(",") ===
        "GET /v3/payments/pay_fresh,DELETE /v3/payments/pay_fresh",
      "provider cancellation sequence changed",
    );
    assert(
      queryFilters.some(([column, value]) =>
        column === "order_id" && value === RENEWAL_ID
      ) && queryFilters.some(([column, value]) =>
        column === "order_type" && value === "contract"
      ) && queryFilters.some(([column, value]) =>
        column === "source" && value === "asaas"
      ),
      "Asaas cache was not scoped to the renewal contract",
    );
    const snapshotCall = rpcCalls.find((call) =>
      call.name === "record_assessment_renewal_provider_snapshot"
    );
    assert(
      snapshotCall,
      "provider shape was not persisted before cancellation",
    );
    const snapshot = snapshotCall.args.p_provider_snapshot as Record<
      string,
      unknown
    >;
    assert(snapshot.kind === "standalone", "standalone shape was not proven");
    const persistedCall = rpcCalls.find((call) =>
      call.name === "record_assessment_renewal_external_result"
    );
    assert(persistedCall, "provider result was not persisted");
    const persisted = persistedCall.args.p_external_result as Record<
      string,
      unknown
    >;
    assert(persisted.provider === "asaas", "Asaas provider was lost");
    assert(
      persisted.outcome === "deleted",
      "provider success was not recorded",
    );
    assert(persisted.payment_id === "pay_fresh", "charge id was lost");
  });
});

Deno.test("Installment cancellation requests the complete Asaas page before deleting", async () => {
  await withAsaas(async () => {
    const providerRequests: string[] = [];
    const installmentPayments = Array.from({ length: 12 }, (_, index) => ({
      id: `pay_many_${index + 1}`,
      installment: "ins_many",
      status: "PENDING",
    }));
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method || "GET";
      providerRequests.push(`${method} ${url.pathname}${url.search}`);
      if (method === "GET" && url.pathname === "/v3/payments/pay_many_1") {
        return Promise.resolve(Response.json({
          id: "pay_many_1",
          installment: "ins_many",
          status: "PENDING",
        }));
      }
      if (
        method === "GET" &&
        url.pathname === "/v3/installments/ins_many/payments"
      ) {
        return Promise.resolve(Response.json({
          data: installmentPayments,
          hasMore: false,
        }));
      }
      if (
        method === "DELETE" &&
        url.pathname === "/v3/installments/ins_many/payments"
      ) {
        return Promise.resolve(Response.json({ deleted: true }));
      }
      throw new Error(`unexpected Asaas request ${method} ${url.pathname}`);
    };

    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = {
      rpc: (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        if (name === "prepare_assessment_renewal_resolution") {
          return Promise.resolve({
            data: {
              operation_id: OPERATION_ID,
              status: "prepared",
              renewal_id: RENEWAL_ID,
              resolution: "non_renewal",
              reason_code: "customer_declined",
              asaas_charge_id: "pay_many_1",
            },
            error: null,
          });
        }
        if (name === "claim_assessment_renewal_resolution") {
          return Promise.resolve({
            data: {
              status: "prepared",
              lease_acquired: true,
              lease_token: LEASE_TOKEN,
            },
            error: null,
          });
        }
        if (name === "record_assessment_renewal_provider_snapshot") {
          return Promise.resolve({
            data: { provider_snapshot: args.p_provider_snapshot },
            error: null,
          });
        }
        if (name === "record_assessment_renewal_external_result") {
          return Promise.resolve({
            data: { external_result: args.p_external_result },
            error: null,
          });
        }
        if (name === "complete_assessment_renewal_resolution") {
          return Promise.resolve({
            data: completedResult({ cancelled_charge_id: "pay_many_1" }),
            error: null,
          });
        }
        throw new Error(`unexpected RPC ${name}`);
      },
      from: () => {
        const query = {
          select: () => query,
          eq: () => query,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({
              data: installmentPayments.map((payment, index) => ({
                asaas_payment_id: payment.id,
                installment_group_id: "ins_many",
                total_installments: 12,
                installment_number: index + 1,
              })),
              error: null,
            }).then(resolve),
        };
        return query;
      },
    } as unknown as SupabaseClient;

    const response = await handleRenewalRequest(
      request(validBody({ expected_charge_id: "pay_many_1" })),
      PATH,
      client,
      ACTOR_ID,
    );
    assert(response?.status === 200, "installment cancellation did not finish");
    assert(
      providerRequests.includes(
        "GET /v3/installments/ins_many/payments?limit=100",
      ),
      "installment lookup did not request the complete supported page",
    );
    const snapshotCall = rpcCalls.find((call) =>
      call.name === "record_assessment_renewal_provider_snapshot"
    );
    const snapshot = snapshotCall?.args.p_provider_snapshot as Record<
      string,
      unknown
    >;
    assert(snapshot?.kind === "installment", "installment shape was not saved");
    assert(
      snapshot?.installment_id === "ins_many",
      "installment id was not saved",
    );
  });
});

Deno.test("Missing Asaas primary with an ambiguous cache fails closed without assuming standalone", async () => {
  await withAsaas(async () => {
    const providerRequests: string[] = [];
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method || "GET";
      providerRequests.push(`${method} ${url.pathname}`);
      return Promise.resolve(Response.json({}, { status: 404 }));
    };

    const rpcNames: string[] = [];
    const client = {
      rpc: (name: string) => {
        rpcNames.push(name);
        if (name === "prepare_assessment_renewal_resolution") {
          return Promise.resolve({
            data: {
              operation_id: OPERATION_ID,
              status: "prepared",
              renewal_id: RENEWAL_ID,
              resolution: "non_renewal",
              reason_code: "customer_declined",
              asaas_charge_id: "pay_ambiguous",
            },
            error: null,
          });
        }
        if (name === "claim_assessment_renewal_resolution") {
          return Promise.resolve({
            data: {
              status: "prepared",
              lease_acquired: true,
              lease_token: LEASE_TOKEN,
            },
            error: null,
          });
        }
        throw new Error(`unexpected RPC ${name}`);
      },
      from: () => {
        const query = {
          select: () => query,
          eq: () => query,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({
              data: [{
                asaas_payment_id: "pay_ambiguous",
                installment_group_id: null,
                total_installments: 3,
              }],
              error: null,
            }).then(resolve),
        };
        return query;
      },
    } as unknown as SupabaseClient;

    const response = await handleRenewalRequest(
      request(validBody({ expected_charge_id: "pay_ambiguous" })),
      PATH,
      client,
      ACTOR_ID,
    );
    const body = await responseBody(response!);

    assert(response?.status === 409, "ambiguous missing charge was accepted");
    assert(
      body.code === "asaas_charge_missing_unconfirmed",
      "ambiguous cache returned the wrong code",
    );
    assert(
      providerRequests.join(",") === "GET /v3/payments/pay_ambiguous",
      "ambiguous cache triggered a destructive provider request",
    );
    assert(
      rpcNames.join(",") ===
        "prepare_assessment_renewal_resolution,claim_assessment_renewal_resolution",
      "ambiguous provider state was persisted or completed",
    );
  });
});

Deno.test("Provider success followed by ledger failure reconciles and retries without a second delete", async () => {
  await withAsaas(async () => {
    let providerMissing = false;
    let deleteCalls = 0;
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method || "GET";
      if (url.pathname !== "/v3/payments/pay_retry") {
        throw new Error(`unexpected Asaas request ${method} ${url.pathname}`);
      }
      if (method === "GET") {
        return Promise.resolve(
          providerMissing
            ? Response.json({}, { status: 404 })
            : Response.json({ id: "pay_retry", status: "PENDING" }),
        );
      }
      if (method === "DELETE") {
        deleteCalls += 1;
        providerMissing = true;
        return Promise.resolve(Response.json({ deleted: true }));
      }
      throw new Error(`unexpected Asaas method ${method}`);
    };

    let recordCalls = 0;
    let providerSnapshot: Record<string, unknown> | null = null;
    const client = {
      rpc: (name: string, args: Record<string, unknown>) => {
        if (name === "prepare_assessment_renewal_resolution") {
          return Promise.resolve({
            data: {
              operation_id: OPERATION_ID,
              status: "prepared",
              renewal_id: RENEWAL_ID,
              resolution: "non_renewal",
              reason_code: "customer_declined",
              asaas_charge_id: "pay_retry",
            },
            error: null,
          });
        }
        if (name === "claim_assessment_renewal_resolution") {
          return Promise.resolve({
            data: {
              status: "prepared",
              lease_acquired: true,
              lease_token: LEASE_TOKEN,
              provider_snapshot: providerSnapshot,
            },
            error: null,
          });
        }
        if (name === "record_assessment_renewal_provider_snapshot") {
          const next = args.p_provider_snapshot as Record<string, unknown>;
          if (providerSnapshot && providerSnapshot !== next) {
            assert(
              JSON.stringify(providerSnapshot) === JSON.stringify(next),
              "retry changed the provider snapshot",
            );
          }
          providerSnapshot = next;
          return Promise.resolve({
            data: { provider_snapshot: providerSnapshot },
            error: null,
          });
        }
        if (name === "record_assessment_renewal_external_result") {
          recordCalls += 1;
          return recordCalls === 1
            ? Promise.resolve({
              data: null,
              error: { code: "08006", message: "ledger unavailable" },
            })
            : Promise.resolve({
              data: { external_result: args.p_external_result },
              error: null,
            });
        }
        if (name === "complete_assessment_renewal_resolution") {
          return Promise.resolve({
            data: completedResult({ cancelled_charge_id: "pay_retry" }),
            error: null,
          });
        }
        throw new Error(`unexpected RPC ${name}`);
      },
      from: () => {
        const query = {
          select: () => query,
          eq: () => query,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({
              data: [{
                asaas_payment_id: "pay_retry",
                installment_group_id: null,
                total_installments: null,
              }],
              error: null,
            }).then(resolve),
        };
        return query;
      },
    } as unknown as SupabaseClient;

    const first = await handleRenewalRequest(
      request(validBody({ expected_charge_id: "pay_retry" })),
      PATH,
      client,
      ACTOR_ID,
    );
    const firstBody = await responseBody(first!);
    assert(first?.status === 409, "lost ledger write was not reconciled");
    assert(
      firstBody.code === "reconciliation_required",
      "lost ledger write returned a misleading error",
    );

    const retry = await handleRenewalRequest(
      request(validBody({ expected_charge_id: "pay_retry" })),
      PATH,
      client,
      ACTOR_ID,
    );
    assert(retry?.status === 200, "safe retry did not finish");
    assert(deleteCalls === 1, "retry issued a second provider delete");
    assert(recordCalls === 2, "retry did not persist the recovered outcome");
    const savedSnapshot = providerSnapshot as Record<string, unknown> | null;
    assert(
      savedSnapshot?.kind === "standalone",
      "provider-inspected standalone proof was not reused after the crash",
    );
  });
});

Deno.test("Asaas renewal retry reuses a stored cancellation without provider access", async () => {
  const stored = {
    provider: "asaas",
    outcome: "deleted",
    payment_id: "pay_renewal",
    payment_ids: ["pay_renewal", "pay_renewal_2"],
    installment_id: "ins_renewal",
  };
  const rpcNames: string[] = [];
  let completedExternalResult: unknown;
  let cacheCalls = 0;
  const client = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcNames.push(name);
      if (name === "prepare_assessment_renewal_resolution") {
        return Promise.resolve({
          data: {
            operation_id: OPERATION_ID,
            status: "prepared",
            renewal_id: RENEWAL_ID,
            resolution: "non_renewal",
            reason_code: "customer_declined",
            asaas_charge_id: "pay_renewal",
          },
          error: null,
        });
      }
      if (name === "claim_assessment_renewal_resolution") {
        return Promise.resolve({
          data: {
            status: "prepared",
            lease_acquired: true,
            lease_token: LEASE_TOKEN,
            external_result: stored,
          },
          error: null,
        });
      }
      if (name === "complete_assessment_renewal_resolution") {
        completedExternalResult = args.p_external_result;
        return Promise.resolve({
          data: completedResult({ cancelled_charge_id: "pay_renewal" }),
          error: null,
        });
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    from: () => {
      cacheCalls += 1;
      throw new Error("stored Asaas outcome must prevent provider work");
    },
  } as unknown as SupabaseClient;

  const response = await handleRenewalRequest(
    request(validBody({ expected_charge_id: "pay_renewal" })),
    PATH,
    client,
    ACTOR_ID,
  );

  assert(response?.status === 200, "stored Asaas result did not complete");
  assert(cacheCalls === 0, "Asaas cache/provider path was entered on retry");
  assert(
    rpcNames.join(",") ===
      "prepare_assessment_renewal_resolution,claim_assessment_renewal_resolution,complete_assessment_renewal_resolution",
    "stored provider result was persisted or executed twice",
  );
  assert(
    completedExternalResult === stored,
    "stored Asaas cancellation changed before completion",
  );
});

Deno.test("Invalid persisted provider result is closed as reconciliation in the ledger", async () => {
  const invalidStored = {
    provider: "asaas",
    outcome: "deleted",
    payment_id: "pay_wrong",
    payment_ids: ["pay_wrong"],
  };
  const rpcNames: string[] = [];
  let reconciliationResult: unknown;
  const client = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcNames.push(name);
      if (name === "prepare_assessment_renewal_resolution") {
        return Promise.resolve({
          data: {
            operation_id: OPERATION_ID,
            status: "prepared",
            renewal_id: RENEWAL_ID,
            resolution: "non_renewal",
            reason_code: "customer_declined",
            asaas_charge_id: "pay_expected",
          },
          error: null,
        });
      }
      if (name === "claim_assessment_renewal_resolution") {
        return Promise.resolve({
          data: {
            status: "prepared",
            lease_acquired: true,
            lease_token: LEASE_TOKEN,
            external_result: invalidStored,
          },
          error: null,
        });
      }
      if (name === "complete_assessment_renewal_resolution") {
        reconciliationResult = args.p_external_result;
        return Promise.resolve({
          data: {
            operation_id: OPERATION_ID,
            status: "reconciliation_required",
            error: "Resultado externo divergente",
          },
          error: null,
        });
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    from: () => {
      throw new Error("invalid stored result must not reach the provider");
    },
  } as unknown as SupabaseClient;

  const response = await handleRenewalRequest(
    request(validBody({ expected_charge_id: "pay_expected" })),
    PATH,
    client,
    ACTOR_ID,
  );
  const body = await responseBody(response!);

  assert(response?.status === 409, "invalid stored result was not reconciled");
  assert(body.code === "reconciliation_required", "wrong ledger state code");
  assert(
    reconciliationResult === invalidStored,
    "invalid persisted result was not sent to the fail-closed completion",
  );
  assert(
    rpcNames.join(",") ===
      "prepare_assessment_renewal_resolution,claim_assessment_renewal_resolution,complete_assessment_renewal_resolution",
    "invalid persisted result triggered an external side effect",
  );
});

Deno.test("Completed renewal resolution is idempotent without a new lease or provider action", async () => {
  const finalResult = completedResult();
  const rpcNames: string[] = [];
  const client = {
    rpc: (name: string) => {
      rpcNames.push(name);
      return Promise.resolve({
        data: {
          operation_id: OPERATION_ID,
          status: "completed",
          renewal_id: RENEWAL_ID,
          resolution: "non_renewal",
          reason_code: "customer_declined",
          result: finalResult,
        },
        error: null,
      });
    },
    from: () => {
      throw new Error("completed operation must not access a provider");
    },
  } as unknown as SupabaseClient;

  const response = await handleRenewalRequest(
    request(validBody()),
    PATH,
    client,
    ACTOR_ID,
  );
  const body = await responseBody(response!);

  assert(response?.status === 200, "completed operation did not succeed");
  assert(
    rpcNames.join(",") === "prepare_assessment_renewal_resolution",
    "completed operation acquired a new lease",
  );
  const data = body.data as Record<string, unknown>;
  assert(data.status === "completed", "stored completion status changed");
  assert(
    data.renewal_id === RENEWAL_ID,
    "stored completion result was not returned",
  );
});

Deno.test("Renewal resolution rejects invalid idempotency keys and strict body violations", async () => {
  let rpcCalls = 0;
  const client = {
    rpc: () => {
      rpcCalls += 1;
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;

  const badKeyResponse = await handleRenewalRequest(
    request(validBody(), "short"),
    PATH,
    client,
    ACTOR_ID,
  );
  const badKeyBody = await responseBody(badKeyResponse!);
  assert(badKeyResponse?.status === 400, "short key was accepted");
  assert(
    badKeyBody.code === "invalid_idempotency_key",
    "short key returned the wrong code",
  );

  const invalidBodyResponse = await handleRenewalRequest(
    request(
      validBody({
        unexpected: true,
      }),
      "renewal:test:0002",
    ),
    PATH,
    client,
    ACTOR_ID,
  );
  const invalidBody = await responseBody(invalidBodyResponse!);
  assert(invalidBodyResponse?.status === 400, "invalid body was accepted");
  assert(invalidBody.code === "invalid_request", "wrong body error code");

  const mismatchedReasonResponse = await handleRenewalRequest(
    request(
      validBody({ resolution: "discard", reason_code: "customer_declined" }),
      "renewal:test:0004",
    ),
    PATH,
    client,
    ACTOR_ID,
  );
  assert(
    mismatchedReasonResponse?.status === 400,
    "resolution with an incompatible reason was accepted",
  );

  const nonCanonicalReasonResponse = await handleRenewalRequest(
    request(
      validBody({ reason: "Cliente desistiu" }),
      "renewal:test:0007",
    ),
    PATH,
    client,
    ACTOR_ID,
  );
  assert(
    nonCanonicalReasonResponse?.status === 400,
    "non-canonical reason text was accepted",
  );

  const impossibleTimestampResponse = await handleRenewalRequest(
    request(
      validBody({
        expected_updated_at: "2026-02-30T12:00:00.000Z",
      }),
      "renewal:test:0005",
    ),
    PATH,
    client,
    ACTOR_ID,
  );
  assert(
    impossibleTimestampResponse?.status === 400,
    "impossible timestamp was accepted",
  );

  const serviceStartedResponse = await handleRenewalRequest(
    request(
      validBody({ service_started: true }),
      "renewal:test:0006",
    ),
    PATH,
    client,
    ACTOR_ID,
  );
  assert(
    serviceStartedResponse?.status === 400,
    "renewal with service already started was accepted",
  );
  assert(rpcCalls === 0, "database was called for invalid input");
});

Deno.test("Post-prepare database errors preserve the operation protocol", async () => {
  const client = {
    rpc: (name: string) => {
      if (name === "prepare_assessment_renewal_resolution") {
        return Promise.resolve({
          data: {
            operation_id: OPERATION_ID,
            status: "prepared",
            renewal_id: RENEWAL_ID,
            resolution: "non_renewal",
            reason_code: "customer_declined",
          },
          error: null,
        });
      }
      return Promise.resolve({
        data: null,
        error: { code: "08006", message: "database unavailable" },
      });
    },
  } as unknown as SupabaseClient;

  const response = await handleRenewalRequest(
    request(validBody(), "renewal:test:0008"),
    PATH,
    client,
    ACTOR_ID,
  );
  const body = await responseBody(response!);
  const details = body.details as Record<string, unknown>;

  assert(response?.status === 500, "database error status changed");
  assert(body.code === "database_error", "database error code changed");
  assert(
    details.operation_id === OPERATION_ID,
    "post-prepare database error lost the operation protocol",
  );
});

Deno.test("Renewal resolution reports reconciliation and in-progress states", async () => {
  const reconciliationClient = {
    rpc: () =>
      Promise.resolve({
        data: {
          operation_id: OPERATION_ID,
          status: "reconciliation_required",
          error: "A renovação mudou",
        },
        error: null,
      }),
  } as unknown as SupabaseClient;
  const reconciliation = await handleRenewalRequest(
    request(validBody()),
    PATH,
    reconciliationClient,
    ACTOR_ID,
  );
  const reconciliationBody = await responseBody(reconciliation!);
  assert(reconciliation?.status === 409, "reconciliation status changed");
  assert(
    reconciliationBody.code === "reconciliation_required",
    "reconciliation code changed",
  );

  let calls = 0;
  const inProgressClient = {
    rpc: (name: string) => {
      calls += 1;
      if (name === "prepare_assessment_renewal_resolution") {
        return Promise.resolve({
          data: {
            operation_id: OPERATION_ID,
            status: "prepared",
            renewal_id: RENEWAL_ID,
            resolution: "non_renewal",
            reason_code: "customer_declined",
          },
          error: null,
        });
      }
      return Promise.resolve({
        data: {
          status: "prepared",
          lease_acquired: false,
          lease_expires_at: "2026-07-27T12:05:00.000Z",
        },
        error: null,
      });
    },
  } as unknown as SupabaseClient;
  const inProgress = await handleRenewalRequest(
    request(validBody(), "renewal:test:0003"),
    PATH,
    inProgressClient,
    ACTOR_ID,
  );
  const inProgressBody = await responseBody(inProgress!);
  assert(inProgress?.status === 409, "in-progress status changed");
  assert(
    inProgressBody.code === "operation_in_progress",
    "in-progress code changed",
  );
  assert(calls === 2, "in-progress operation performed extra work");
});
