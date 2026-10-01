import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { handleAdminOperationRequest } from "./admin-operations.ts";

const CLOSING_ID = "61000000-0000-4000-8000-000000000001";
const COACH_ID = "62000000-0000-4000-8000-000000000001";
const ITEM_ID = "63000000-0000-4000-8000-000000000001";
const ACTOR_ID = "64000000-0000-4000-8000-000000000001";
const ADJUSTMENTS_PATH = `/payouts/closings/${CLOSING_ID}/adjustments`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function post(body: Record<string, unknown>) {
  return new Request(`https://example.test/api-v1${ADJUSTMENTS_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function client(status = "pending_approval") {
  const inserts: Array<Record<string, unknown>> = [];
  const closing = { id: CLOSING_ID, status, competence: "2026-09-01" };
  const fake = {
    from(table: string) {
      if (table === "payout_monthly_closings") {
        const query = {
          select: () => query,
          eq: () => query,
          maybeSingle: () => Promise.resolve({ data: closing, error: null }),
        };
        return query;
      }
      if (table === "payout_monthly_statement_items") {
        return {
          insert(row: Record<string, unknown>) {
            inserts.push(row);
            return {
              select: () => ({
                single: () => Promise.resolve({ data: { id: ITEM_ID, ...row }, error: null }),
              }),
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return { fake, inserts };
}

async function send(body: Record<string, unknown>, status?: string) {
  const { fake, inserts } = client(status);
  const response = await handleAdminOperationRequest(post(body), ADJUSTMENTS_PATH, fake, ACTOR_ID);
  return { response, inserts };
}

const entry = (category: string, amount: number) => ({
  coach_id: COACH_ID,
  expense_category: category,
  amount,
  description: category,
  adjustment_reason: "Explicação do lançamento",
});

Deno.test("an extra repasse is saved positive, in the closing month", async () => {
  const { response, inserts } = await send(entry("repasse_extra", 21));
  assert(response?.status === 201, `extra repasse was refused (${response?.status})`);
  assert(inserts.length === 1, "extra repasse was not inserted");
  assert(inserts[0].amount === 21, "extra repasse amount changed");
  assert(inserts[0].source_type === "manual_adjustment", "extra repasse is not a manual entry");
  assert(inserts[0].expense_category === "repasse_extra", "extra repasse lost its kind");
  assert(inserts[0].reference_competence === "2026-09-01", "entry is not in the closing month");
});

Deno.test("a discount is saved negative", async () => {
  const { response, inserts } = await send(entry("desconto", -30));
  assert(response?.status === 201, `discount was refused (${response?.status})`);
  assert(inserts[0].amount === -30, "discount amount changed");
  assert(inserts[0].expense_category === "desconto", "discount lost its kind");
});

Deno.test("a positive discount is refused", async () => {
  const { response, inserts } = await send(entry("desconto", 30));
  assert(response?.status === 400, "positive discount was accepted");
  assert(inserts.length === 0, "positive discount was inserted");
});

Deno.test("a negative extra repasse or expense is refused", async () => {
  for (const category of ["repasse_extra", "reembolso_combustivel"]) {
    const { response, inserts } = await send(entry(category, -10));
    assert(response?.status === 400, `negative ${category} was accepted`);
    assert(inserts.length === 0, `negative ${category} was inserted`);
  }
});

Deno.test("an entry without category is an expense under Outros", async () => {
  const { response, inserts } = await send({ ...entry("", 15), expense_category: undefined });
  assert(response?.status === 201, "entry without category was refused");
  assert(inserts[0].expense_category === "outros", "entry without category is not Outros");
});

Deno.test("an approved closing takes no entries", async () => {
  const { response, inserts } = await send(entry("repasse_extra", 21), "approved");
  assert(response?.status === 409, "approved closing took an entry");
  assert(inserts.length === 0, "entry was inserted in an approved closing");
});
