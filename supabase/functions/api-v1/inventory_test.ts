import {
  InventoryInputError,
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
    images: ["data:image/jpeg;base64,abc"],
    product_id: null,
  }, "create");

  assert(payload.name === "Camiseta EON", "name was not normalized");
  assert(
    payload.description === "Modelo treino",
    "description was not normalized",
  );
  assert(payload.sale_price === 129.91, "price was not rounded");
  assert(payload.quantity === 12, "quantity was not normalized");
  assert(Array.isArray(payload.images), "images were not preserved");
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
