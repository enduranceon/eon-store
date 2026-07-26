import {
  CatalogInputError,
  normalizeCatalogPayload,
  parseCatalogSort,
} from "./catalog.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectCatalogError(run: () => unknown, code: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  assert(
    caught instanceof CatalogInputError,
    `expected CatalogInputError ${code}`,
  );
  assert(caught.code === code, `expected ${code}, received ${caught.code}`);
}

Deno.test("catalog payload accepts only allowlisted supplier fields", () => {
  const payload = normalizeCatalogPayload("suppliers", {
    name: "  Fornecedor Teste  ",
    email: " CONTATO@EXAMPLE.COM ",
    whatsapp: " 48999999999 ",
  }, "create");

  assert(payload.name === "Fornecedor Teste", "supplier name was not trimmed");
  assert(
    payload.email === "contato@example.com",
    "supplier email was not normalized",
  );
  assert(
    payload.whatsapp === "48999999999",
    "supplier whatsapp was not trimmed",
  );

  expectCatalogError(() =>
    normalizeCatalogPayload("suppliers", {
      name: "Teste",
      created_date: "2026-01-01",
    }, "create"), "invalid_field");
});

Deno.test("catalog categories reject duplicate and invalid subcategories", () => {
  const payload = normalizeCatalogPayload("categories", {
    name: "Roupas",
    subcategories: [" Camisetas ", "Calções"],
  }, "create");

  assert(
    Array.isArray(payload.subcategories),
    "subcategories were not preserved",
  );
  assert(
    payload.subcategories[0] === "Camisetas",
    "subcategory was not trimmed",
  );

  expectCatalogError(() =>
    normalizeCatalogPayload("categories", {
      name: "Roupas",
      subcategories: ["Camisetas", "camisetas"],
    }, "create"), "duplicate_subcategory");
});

Deno.test("catalog revenue centers validate type, color and booleans", () => {
  const payload = normalizeCatalogPayload("revenue-centers", {
    name: "Loja",
    type: "loja",
    color: "#AABBCC",
    active: true,
  }, "create");

  assert(payload.color === "#aabbcc", "color was not normalized");

  expectCatalogError(() =>
    normalizeCatalogPayload("revenue-centers", {
      name: "Loja",
      type: "financeiro",
    }, "create"), "invalid_type");

  expectCatalogError(() =>
    normalizeCatalogPayload("revenue-centers", {
      name: "Loja",
      active: "yes",
    }, "create"), "invalid_active");
});

Deno.test("catalog sorting is restricted per resource", () => {
  const descending = parseCatalogSort("suppliers", "-created_date");
  assert(
    descending.field === "created_date" && !descending.ascending,
    "descending sort changed",
  );

  const byName = parseCatalogSort("revenue-centers", "name");
  assert(byName.field === "name" && byName.ascending, "ascending sort changed");

  expectCatalogError(
    () => parseCatalogSort("suppliers", "password"),
    "invalid_sort",
  );
  expectCatalogError(() => parseCatalogSort("unknown", "name"), "not_found");
});
