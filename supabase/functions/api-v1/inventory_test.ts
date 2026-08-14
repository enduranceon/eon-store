import {
  handleInventoryRequest,
  InventoryInputError,
  normalizeStockEntryPayload,
  normalizeStockWithdrawalPayload,
  normalizeStockProductPayload,
} from "./inventory.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertRejects(input: unknown, expected: string): void {
  try {
    normalizeStockProductPayload(input, "create");
    throw new Error(`expected rejection containing: ${expected}`);
  } catch (error) {
    assert(error instanceof InventoryInputError, "unexpected error type");
    assert(
      error.message.includes(expected),
      `unexpected error: ${error.message}`,
    );
  }
}

Deno.test("stock product payload keeps only validated writable fields", () => {
  const payload = normalizeStockProductPayload({
    name: "  Camiseta EON  ",
    description: "  Modelo treino  ",
    sale_price: "129.905",
    regular_price: 149.9,
    cost_price: 60,
    quantity: "12",
    status: "active",
    show_in_store: false,
    images: ["data:image/jpeg;base64,abc"],
    product_id: crypto.randomUUID(),
    product_number: "42",
    supplier: "  Woom  ",
    subcategory: "  Regata  ",
    supplier_id: crypto.randomUUID(),
    variations: [{ name: "M", sku: "0042-M" }],
    extras: [{ name: "Bordado", price: 10 }],
  }, "create");

  assert(payload.name === "Camiseta EON", "name was not normalized");
  assert(
    payload.description === "Modelo treino",
    "description was not normalized",
  );
  assert(payload.sale_price === 129.91, "price was not rounded");
  assert(payload.quantity === 12, "quantity was not normalized");
  assert(payload.show_in_store === false, "store visibility was not preserved");
  assert(Array.isArray(payload.images), "images were not preserved");
  assert(payload.product_number === 42, "product number was not normalized");
  assert(payload.supplier === "Woom", "supplier was not normalized");
  assert(payload.subcategory === "Regata", "subcategory was not normalized");
  assert(Array.isArray(payload.variations), "variations were not preserved");
  assert(Array.isArray(payload.extras), "extras were not preserved");
});

Deno.test("stock product payload rejects server fields and invalid inventory", () => {
  assertRejects(
    { name: "Produto", id: crypto.randomUUID() },
    "Campo não permitido",
  );
  assertRejects({ name: "Produto", quantity: -1 }, "Quantidade inválida");
  assertRejects(
    { name: "Produto", status: "deleted" },
    "Status de produto inválido",
  );
  assertRejects({ name: "Produto", images: ["a", "b", "c", "d"] }, "Imagens");
  assertRejects({ name: "Produto", product_number: 0 }, "Valor inválido");
  assertRejects({ name: "Produto", variations: {} }, "Campo inválido");
});

Deno.test("stock product update requires at least one valid change", () => {
  let rejected = false;
  try {
    normalizeStockProductPayload({}, "update");
  } catch (error) {
    rejected = error instanceof InventoryInputError;
  }
  assert(rejected, "empty update was accepted");
});

Deno.test("stock product update can clear an optional reference price", () => {
  const payload = normalizeStockProductPayload({ regular_price: null }, "update");
  assert(payload.regular_price === null, "reference price was not cleared");
});

Deno.test("stock entry payload requires a positive integer quantity", () => {
  const payload = normalizeStockEntryPayload({
    quantity: "8",
    variation: "  Feminino - M ",
    reason: "  Recebimento de fornecedor ",
  });
  assert(payload.quantity === 8, "quantity was not normalized");
  assert(payload.variation === "Feminino - M", "variation was not normalized");
  assert(payload.reason === "Recebimento de fornecedor", "reason was not normalized");

  let rejected = false;
  try {
    normalizeStockEntryPayload({ quantity: 0 });
  } catch (error) {
    rejected = error instanceof InventoryInputError;
  }
  assert(rejected, "invalid entry quantity was accepted");
});

Deno.test("stock withdrawal payload requires a reason", () => {
  const payload = normalizeStockWithdrawalPayload({
    quantity: 2,
    variation: "M",
    reason: "  Avaria ou perda ",
  });
  assert(payload.reason === "Avaria ou perda", "withdrawal reason was not normalized");

  let rejected = false;
  try {
    normalizeStockWithdrawalPayload({ quantity: 1 });
  } catch (error) {
    rejected = error instanceof InventoryInputError;
  }
  assert(rejected, "withdrawal without a reason was accepted");
});

Deno.test("stock movements route returns ordered movement data", async () => {
  const rows = [{ id: crypto.randomUUID(), movement_type: "opening_balance" }];
  const query = {
    data: rows,
    error: null,
    select: () => query,
    order: () => query,
    limit: () => query,
    eq: () => query,
    gte: () => query,
    lte: () => query,
  };
  const supabase = { from: (table: string) => {
    assert(table === "stock_movements", "unexpected table");
    return query;
  } };

  const response = await handleInventoryRequest(
    new Request("https://example.test/inventory/movements?limit=50"),
    "/inventory/movements",
    supabase as never,
  );
  assert(response?.status === 200, "movement request did not succeed");
  const body = await response?.json();
  assert(body.data.length === 1, "movement rows were not returned");
  assert(body.data[0].movement_type === "opening_balance", "wrong movement row");
});
