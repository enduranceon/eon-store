import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

type ProductPayload = Record<string, unknown>;
type ProductMode = "create" | "update";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCT_STATUSES = new Set(["active", "inactive"]);
const WRITABLE_FIELDS = new Set([
  "name",
  "description",
  "category",
  "images",
  "sale_price",
  "regular_price",
  "cost_price",
  "quantity",
  "status",
  "notes",
  "product_id",
  "revenue_center_id",
]);

export class InventoryInputError extends Error {
  status: number;
  code: string;

  constructor(message: string, code = "invalid_request", status = 400) {
    super(message);
    this.name = "InventoryInputError";
    this.status = status;
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is ProductPayload {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalText(
  input: ProductPayload,
  output: ProductPayload,
  field: string,
  maxLength: number,
): void {
  if (!(field in input)) return;
  const value = input[field];
  if (value === null || value === "") {
    output[field] = null;
    return;
  }
  if (typeof value !== "string") {
    throw new InventoryInputError(`Campo inválido: ${field}`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new InventoryInputError(`Campo muito longo: ${field}`);
  }
  output[field] = normalized || null;
}

function optionalNumber(
  input: ProductPayload,
  output: ProductPayload,
  field: string,
): void {
  if (!(field in input)) return;
  const value = Number(input[field]);
  if (!Number.isFinite(value) || value < 0 || value > 100_000_000) {
    throw new InventoryInputError(`Valor inválido: ${field}`);
  }
  output[field] = Math.round(value * 100) / 100;
}

function optionalUuid(
  input: ProductPayload,
  output: ProductPayload,
  field: string,
): void {
  if (!(field in input)) return;
  const value = input[field];
  if (value === null || value === "") {
    output[field] = null;
    return;
  }
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new InventoryInputError(`Identificador inválido: ${field}`);
  }
  output[field] = value;
}

export function normalizeStockProductPayload(
  payload: unknown,
  mode: ProductMode,
): ProductPayload {
  if (!isPlainObject(payload)) {
    throw new InventoryInputError("Corpo JSON inválido", "invalid_json");
  }
  for (const field of Object.keys(payload)) {
    if (!WRITABLE_FIELDS.has(field)) {
      throw new InventoryInputError(`Campo não permitido: ${field}`);
    }
  }

  const output: ProductPayload = {};
  if ("name" in payload) {
    if (typeof payload.name !== "string" || !payload.name.trim()) {
      throw new InventoryInputError("Informe o nome do produto");
    }
    if (payload.name.trim().length > 200) {
      throw new InventoryInputError("Nome do produto muito longo");
    }
    output.name = payload.name.trim();
  } else if (mode === "create") {
    throw new InventoryInputError("Informe o nome do produto");
  }

  optionalText(payload, output, "description", 5_000);
  optionalText(payload, output, "category", 200);
  optionalText(payload, output, "notes", 5_000);
  optionalNumber(payload, output, "sale_price");
  optionalNumber(payload, output, "regular_price");
  optionalNumber(payload, output, "cost_price");
  optionalUuid(payload, output, "product_id");
  optionalUuid(payload, output, "revenue_center_id");

  if ("quantity" in payload) {
    const quantity = Number(payload.quantity);
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 10_000_000) {
      throw new InventoryInputError("Quantidade inválida");
    }
    output.quantity = quantity;
  }

  if ("status" in payload) {
    if (
      typeof payload.status !== "string" ||
      !PRODUCT_STATUSES.has(payload.status)
    ) {
      throw new InventoryInputError("Status de produto inválido");
    }
    output.status = payload.status;
  }

  if ("images" in payload) {
    if (
      !Array.isArray(payload.images) || payload.images.length > 3 ||
      payload.images.some((image) =>
        typeof image !== "string" || image.length > 2_500_000
      )
    ) {
      throw new InventoryInputError("Imagens do produto inválidas");
    }
    output.images = payload.images;
  }

  if (mode === "update" && Object.keys(output).length === 0) {
    throw new InventoryInputError("Nenhuma alteração válida foi informada");
  }
  return output;
}

async function requestPayload(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new InventoryInputError("Corpo JSON inválido", "invalid_json");
  }
}

function databaseError(
  error: { code?: string; message?: string },
  operation: string,
): Response {
  console.error(`api-v1 inventory ${operation}:`, error);
  if (error.code === "23503") {
    return jsonResponse({
      error: "O cadastro relacionado não foi encontrado",
      code: "invalid_reference",
    }, 409);
  }
  if (error.code === "23505") {
    return jsonResponse({
      error: "Já existe um produto com estes dados",
      code: "duplicate_product",
    }, 409);
  }
  return jsonResponse({
    error: "Não foi possível atualizar o estoque",
    code: "database_error",
  }, 500);
}

function inputError(error: unknown): Response {
  if (error instanceof InventoryInputError) {
    return jsonResponse(
      { error: error.message, code: error.code },
      error.status,
    );
  }
  console.error("api-v1 inventory invalid payload:", error);
  return jsonResponse(
    { error: "Requisição inválida", code: "invalid_request" },
    400,
  );
}

function notFoundResponse(): Response {
  return jsonResponse(
    { error: "Produto não encontrado", code: "not_found" },
    404,
  );
}

export async function handleInventoryRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
): Promise<Response | null> {
  const match = path.match(/^\/inventory\/products(?:\/([^/]+))?$/);
  if (!match) return null;
  const productId = match[1];

  if (productId && !UUID_PATTERN.test(productId)) {
    return jsonResponse({
      error: "Identificador de produto inválido",
      code: "invalid_product_id",
    }, 400);
  }

  if (req.method === "GET" && !productId) {
    const { data, error } = await supabase
      .from("stock_products")
      .select("*")
      .order("created_date", { ascending: false });
    if (error) return databaseError(error, "list products");
    return jsonResponse({ data: data ?? [] });
  }

  if (req.method === "GET" && productId) {
    const { data, error } = await supabase
      .from("stock_products")
      .select("*")
      .eq("id", productId)
      .maybeSingle();
    if (error) return databaseError(error, "get product");
    return data ? jsonResponse({ data }) : notFoundResponse();
  }

  if (req.method === "POST" && !productId) {
    let payload: ProductPayload;
    try {
      payload = normalizeStockProductPayload(
        await requestPayload(req),
        "create",
      );
    } catch (error) {
      return inputError(error);
    }
    const { data, error } = await supabase
      .from("stock_products")
      .insert(payload)
      .select("*")
      .single();
    if (error) return databaseError(error, "create product");
    return jsonResponse({ data }, 201);
  }

  if (req.method === "PATCH" && productId) {
    let payload: ProductPayload;
    try {
      payload = normalizeStockProductPayload(
        await requestPayload(req),
        "update",
      );
    } catch (error) {
      return inputError(error);
    }
    const { data, error } = await supabase
      .from("stock_products")
      .update({ ...payload, updated_date: new Date().toISOString() })
      .eq("id", productId)
      .select("*")
      .maybeSingle();
    if (error) return databaseError(error, "update product");
    return data ? jsonResponse({ data }) : notFoundResponse();
  }

  if (req.method === "DELETE" && productId) {
    const { count, error: countError } = await supabase
      .from("stock_orders")
      .select("id", { count: "exact", head: true })
      .contains("items", [{ product_id: productId }]);
    if (countError) return databaseError(countError, "check product usage");
    if ((count ?? 0) > 0) {
      return jsonResponse({
        error: "O produto possui pedidos vinculados e não pode ser excluído",
        code: "product_in_use",
      }, 409);
    }

    const { data, error } = await supabase
      .from("stock_products")
      .delete()
      .eq("id", productId)
      .select("id")
      .maybeSingle();
    if (error) return databaseError(error, "delete product");
    return data ? jsonResponse({ data }) : notFoundResponse();
  }

  return jsonResponse({
    error: "Método não permitido",
    code: "method_not_allowed",
  }, 405);
}
