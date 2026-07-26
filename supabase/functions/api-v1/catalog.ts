import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

type CatalogPayload = Record<string, unknown>;
type CatalogMode = "create" | "update";

interface DeleteGuard {
  table: string;
  foreignKey: string;
  message: string;
}

interface CatalogResource {
  table: string;
  selectColumns: string;
  writableFields: readonly string[];
  sortFields: readonly string[];
  defaultSort: string;
  updatedColumn: "updated_at" | "updated_date";
  deleteGuard?: DeleteGuard;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REVENUE_CENTER_TYPES = new Set([
  "assessoria",
  "loja",
  "eventos",
  "general",
]);

const CATALOG_RESOURCES: Record<string, CatalogResource> = {
  categories: {
    table: "presale_categories",
    selectColumns: "id,name,subcategories,created_date,updated_date",
    writableFields: ["name", "subcategories"],
    sortFields: ["id", "name", "created_date", "updated_date"],
    defaultSort: "-created_date",
    updatedColumn: "updated_date",
  },
  suppliers: {
    table: "presale_suppliers",
    selectColumns:
      "id,name,contact_name,whatsapp,email,website,notes,created_date,updated_date",
    writableFields: [
      "name",
      "contact_name",
      "whatsapp",
      "email",
      "website",
      "notes",
    ],
    sortFields: ["id", "name", "contact_name", "created_date", "updated_date"],
    defaultSort: "-created_date",
    updatedColumn: "updated_date",
    deleteGuard: {
      table: "presale_products",
      foreignKey: "supplier_id",
      message: "O fornecedor possui produtos vinculados",
    },
  },
  trainers: {
    table: "presale_trainers",
    selectColumns: "id,name,whatsapp,email,created_date,updated_date",
    writableFields: ["name", "whatsapp", "email"],
    sortFields: ["id", "name", "created_date", "updated_date"],
    defaultSort: "-created_date",
    updatedColumn: "updated_date",
  },
  "revenue-centers": {
    table: "revenue_centers",
    selectColumns:
      "id,name,description,color,type,active,created_at,updated_at",
    writableFields: ["name", "description", "color", "type", "active"],
    sortFields: ["id", "name", "type", "active", "created_at", "updated_at"],
    defaultSort: "name",
    updatedColumn: "updated_at",
  },
};

export class CatalogInputError extends Error {
  status: number;
  code: string;

  constructor(message: string, code = "invalid_request", status = 400) {
    super(message);
    this.name = "CatalogInputError";
    this.status = status;
    this.code = code;
  }
}

function resourceFor(resourceKey: string): CatalogResource {
  const resource = CATALOG_RESOURCES[resourceKey];
  if (!resource) {
    throw new CatalogInputError(
      "Recurso de catálogo não encontrado",
      "not_found",
      404,
    );
  }
  return resource;
}

function isPlainObject(value: unknown): value is CatalogPayload {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredName(
  payload: CatalogPayload,
  output: CatalogPayload,
  mode: CatalogMode,
): void {
  if (!("name" in payload)) {
    if (mode === "create") {
      throw new CatalogInputError("Nome é obrigatório", "invalid_name");
    }
    return;
  }

  if (typeof payload.name !== "string") {
    throw new CatalogInputError("Nome inválido", "invalid_name");
  }

  const name = payload.name.trim();
  if (!name || name.length > 120) {
    throw new CatalogInputError(
      "Nome deve ter entre 1 e 120 caracteres",
      "invalid_name",
    );
  }
  output.name = name;
}

function optionalText(
  payload: CatalogPayload,
  output: CatalogPayload,
  field: string,
  maxLength: number,
): void {
  if (!(field in payload)) return;

  const value = payload[field];
  if (value === null) {
    output[field] = null;
    return;
  }
  if (typeof value !== "string") {
    throw new CatalogInputError(`Campo ${field} inválido`, "invalid_field");
  }

  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new CatalogInputError(
      `Campo ${field} excede ${maxLength} caracteres`,
      "invalid_field",
    );
  }
  output[field] = normalized;
}

function normalizeContactFields(
  payload: CatalogPayload,
  output: CatalogPayload,
): void {
  optionalText(payload, output, "whatsapp", 32);
  optionalText(payload, output, "email", 254);

  if (typeof output.email === "string" && output.email) {
    const email = output.email.toLowerCase();
    if (!EMAIL_PATTERN.test(email)) {
      throw new CatalogInputError("E-mail inválido", "invalid_email");
    }
    output.email = email;
  }
}

function normalizeCategories(
  payload: CatalogPayload,
  output: CatalogPayload,
): void {
  if (!("subcategories" in payload)) return;
  if (
    !Array.isArray(payload.subcategories) || payload.subcategories.length > 100
  ) {
    throw new CatalogInputError(
      "Lista de subcategorias inválida",
      "invalid_subcategories",
    );
  }

  const seen = new Set<string>();
  const subcategories = payload.subcategories.map((value) => {
    if (typeof value !== "string") {
      throw new CatalogInputError(
        "Subcategoria inválida",
        "invalid_subcategories",
      );
    }
    const name = value.trim();
    if (!name || name.length > 120) {
      throw new CatalogInputError(
        "Subcategoria deve ter entre 1 e 120 caracteres",
        "invalid_subcategories",
      );
    }
    const key = name.toLocaleLowerCase("pt-BR");
    if (seen.has(key)) {
      throw new CatalogInputError(
        "Subcategorias duplicadas",
        "duplicate_subcategory",
      );
    }
    seen.add(key);
    return name;
  });

  output.subcategories = subcategories;
}

function normalizeRevenueCenter(
  payload: CatalogPayload,
  output: CatalogPayload,
): void {
  optionalText(payload, output, "description", 500);

  if ("color" in payload) {
    if (
      typeof payload.color !== "string" ||
      !HEX_COLOR_PATTERN.test(payload.color)
    ) {
      throw new CatalogInputError("Cor inválida", "invalid_color");
    }
    output.color = payload.color.toLowerCase();
  }

  if ("type" in payload) {
    if (
      typeof payload.type !== "string" ||
      !REVENUE_CENTER_TYPES.has(payload.type)
    ) {
      throw new CatalogInputError(
        "Tipo de centro de receita inválido",
        "invalid_type",
      );
    }
    output.type = payload.type;
  }

  if ("active" in payload) {
    if (typeof payload.active !== "boolean") {
      throw new CatalogInputError(
        "Situação do centro de receita inválida",
        "invalid_active",
      );
    }
    output.active = payload.active;
  }
}

export function normalizeCatalogPayload(
  resourceKey: string,
  payload: unknown,
  mode: CatalogMode,
): CatalogPayload {
  const resource = resourceFor(resourceKey);
  if (!isPlainObject(payload)) {
    throw new CatalogInputError("Corpo JSON inválido", "invalid_json");
  }

  const allowed = new Set(resource.writableFields);
  for (const field of Object.keys(payload)) {
    if (!allowed.has(field)) {
      throw new CatalogInputError(
        `Campo não permitido: ${field}`,
        "invalid_field",
      );
    }
  }

  if (mode === "update" && Object.keys(payload).length === 0) {
    throw new CatalogInputError("Nenhum campo para atualizar", "empty_update");
  }

  const output: CatalogPayload = {};
  requiredName(payload, output, mode);

  if (resourceKey === "categories") {
    normalizeCategories(payload, output);
    if (mode === "create" && !("subcategories" in output)) {
      output.subcategories = [];
    }
  } else if (resourceKey === "suppliers") {
    optionalText(payload, output, "contact_name", 120);
    optionalText(payload, output, "website", 500);
    optionalText(payload, output, "notes", 2_000);
    normalizeContactFields(payload, output);
  } else if (resourceKey === "trainers") {
    normalizeContactFields(payload, output);
  } else if (resourceKey === "revenue-centers") {
    normalizeRevenueCenter(payload, output);
  }

  return output;
}

export function parseCatalogSort(
  resourceKey: string,
  requestedSort: string | null | undefined,
): { field: string; ascending: boolean } {
  const resource = resourceFor(resourceKey);
  const sort = requestedSort || resource.defaultSort;
  const ascending = !sort.startsWith("-");
  const field = ascending ? sort : sort.slice(1);

  if (!field || !resource.sortFields.includes(field)) {
    throw new CatalogInputError("Ordenação inválida", "invalid_sort");
  }
  return { field, ascending };
}

async function requestPayload(req: Request): Promise<unknown> {
  const raw = await req.text();
  if (!raw || raw.length > 32_768) {
    throw new CatalogInputError(
      "Corpo JSON inválido ou muito grande",
      "invalid_json",
    );
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new CatalogInputError("Corpo JSON inválido", "invalid_json");
  }
}

function databaseError(
  error: { code?: string; message?: string },
  resourceKey: string,
  operation: string,
): Response {
  console.error(`api-v1 catalog ${resourceKey} ${operation}:`, error);

  if (error.code === "23505") {
    return jsonResponse({
      error: "Já existe um cadastro com esses dados",
      code: "conflict",
    }, 409);
  }
  if (error.code === "23503") {
    return jsonResponse({
      error: "O cadastro ainda está em uso",
      code: "resource_in_use",
    }, 409);
  }
  if (
    error.code === "22P02" || error.code === "22001" || error.code === "23514"
  ) {
    return jsonResponse({
      error: "Dados do cadastro inválidos",
      code: "invalid_request",
    }, 400);
  }

  return jsonResponse({
    error: "Não foi possível processar o cadastro",
    code: "database_error",
  }, 500);
}

function inputError(error: unknown): Response {
  if (error instanceof CatalogInputError) {
    return jsonResponse(
      { error: error.message, code: error.code },
      error.status,
    );
  }
  throw error;
}

function notFoundResponse(): Response {
  return jsonResponse(
    { error: "Cadastro não encontrado", code: "not_found" },
    404,
  );
}

export async function handleCatalogRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
): Promise<Response | null> {
  const match = path.match(/^\/catalog\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return null;

  const [, resourceKey, itemId] = match;
  let resource: CatalogResource;
  try {
    resource = resourceFor(resourceKey);
  } catch (error) {
    return inputError(error);
  }

  if (itemId && !UUID_PATTERN.test(itemId)) {
    return jsonResponse(
      { error: "Identificador inválido", code: "invalid_id" },
      400,
    );
  }

  if (req.method === "GET" && !itemId) {
    let sort: { field: string; ascending: boolean };
    try {
      sort = parseCatalogSort(
        resourceKey,
        new URL(req.url).searchParams.get("sort"),
      );
    } catch (error) {
      return inputError(error);
    }

    const { data, error } = await supabase
      .from(resource.table)
      .select(resource.selectColumns)
      .order(sort.field, { ascending: sort.ascending });

    if (error) return databaseError(error, resourceKey, "list");
    return jsonResponse({ data: data ?? [] });
  }

  if (req.method === "GET" && itemId) {
    const { data, error } = await supabase
      .from(resource.table)
      .select(resource.selectColumns)
      .eq("id", itemId)
      .maybeSingle();

    if (error) return databaseError(error, resourceKey, "get");
    if (!data) return notFoundResponse();
    return jsonResponse({ data });
  }

  if (req.method === "POST" && !itemId) {
    let payload: CatalogPayload;
    try {
      payload = normalizeCatalogPayload(
        resourceKey,
        await requestPayload(req),
        "create",
      );
    } catch (error) {
      return inputError(error);
    }

    const { data, error } = await supabase
      .from(resource.table)
      .insert(payload)
      .select(resource.selectColumns)
      .single();

    if (error) return databaseError(error, resourceKey, "create");
    return jsonResponse({ data }, 201);
  }

  if (req.method === "PATCH" && itemId) {
    let payload: CatalogPayload;
    try {
      payload = normalizeCatalogPayload(
        resourceKey,
        await requestPayload(req),
        "update",
      );
    } catch (error) {
      return inputError(error);
    }

    const { data, error } = await supabase
      .from(resource.table)
      .update({
        ...payload,
        [resource.updatedColumn]: new Date().toISOString(),
      })
      .eq("id", itemId)
      .select(resource.selectColumns)
      .maybeSingle();

    if (error) return databaseError(error, resourceKey, "update");
    if (!data) return notFoundResponse();
    return jsonResponse({ data });
  }

  if (req.method === "DELETE" && itemId) {
    if (resource.deleteGuard) {
      const { count, error } = await supabase
        .from(resource.deleteGuard.table)
        .select("id", { count: "exact", head: true })
        .eq(resource.deleteGuard.foreignKey, itemId);

      if (error) return databaseError(error, resourceKey, "delete_guard");
      if ((count ?? 0) > 0) {
        return jsonResponse({
          error: resource.deleteGuard.message,
          code: "resource_in_use",
        }, 409);
      }
    }

    const { data, error } = await supabase
      .from(resource.table)
      .delete()
      .eq("id", itemId)
      .select("id")
      .maybeSingle();

    if (error) return databaseError(error, resourceKey, "delete");
    if (!data) return notFoundResponse();
    return jsonResponse({ data });
  }

  return jsonResponse({
    error: "Método não permitido",
    code: "method_not_allowed",
  }, 405);
}
