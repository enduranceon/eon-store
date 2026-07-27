import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

type Mode = "create" | "update";
type Payload = Record<string, unknown>;
type FieldKind =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "uuid"
  | "date"
  | "timestamp"
  | "json"
  | "string_array"
  | "uuid_array";

interface FieldSpec {
  kind: FieldKind;
  required?: boolean;
  nullable?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  values?: readonly string[];
  shape?: "array" | "object";
  preserveWhitespace?: boolean;
}

interface ResourceSpec {
  table: string;
  fields: Record<string, FieldSpec>;
  defaultSort: string;
  sortFields: readonly string[];
  updatedColumn?: "updated_at" | "updated_date";
  allowCreate?: boolean;
  allowDelete?: boolean;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const s = (maxLength = 500, options: Partial<FieldSpec> = {}): FieldSpec => ({
  kind: "string",
  maxLength,
  ...options,
});
const n = (options: Partial<FieldSpec> = {}): FieldSpec => ({
  kind: "number",
  min: -1_000_000_000,
  max: 1_000_000_000,
  ...options,
});
const i = (options: Partial<FieldSpec> = {}): FieldSpec => ({
  kind: "integer",
  min: -1_000_000,
  max: 1_000_000,
  ...options,
});
const b = (options: Partial<FieldSpec> = {}): FieldSpec => ({
  kind: "boolean",
  ...options,
});
const u = (options: Partial<FieldSpec> = {}): FieldSpec => ({
  kind: "uuid",
  ...options,
});
const d = (options: Partial<FieldSpec> = {}): FieldSpec => ({
  kind: "date",
  ...options,
});
const t = (options: Partial<FieldSpec> = {}): FieldSpec => ({
  kind: "timestamp",
  ...options,
});
const j = (
  shape: "array" | "object",
  options: Partial<FieldSpec> = {},
): FieldSpec => ({
  kind: "json",
  shape,
  ...options,
});
const sa = (options: Partial<FieldSpec> = {}): FieldSpec => ({
  kind: "string_array",
  ...options,
});
const ua = (options: Partial<FieldSpec> = {}): FieldSpec => ({
  kind: "uuid_array",
  ...options,
});

const ADMIN_RESOURCES: Record<string, ResourceSpec> = {
  campaigns: {
    table: "presale_campaigns",
    fields: {
      name: s(120, { required: true }),
      description: s(5_000, { nullable: true, preserveWhitespace: true }),
      status: s(32, { values: ["draft", "active", "ended", "archived"] }),
      start_date: d({ nullable: true }),
      end_date: d({ nullable: true }),
      goal_amount: n({ min: 0, nullable: true }),
      product_order: ua({ nullable: true }),
      supplier: s(200, { nullable: true }),
      receipts: j("object"),
      delivery_days: i({ min: 0, max: 3650, nullable: true }),
      slug: s(120, { nullable: true }),
    },
    defaultSort: "-created_date",
    sortFields: [
      "id",
      "name",
      "status",
      "start_date",
      "end_date",
      "created_date",
      "updated_date",
    ],
    updatedColumn: "updated_date",
    allowCreate: true,
    allowDelete: true,
  },
  "presale-products": {
    table: "presale_products",
    fields: {
      campaign_id: u({ nullable: true }),
      name: s(200, { required: true }),
      description: s(10_000, { nullable: true, preserveWhitespace: true }),
      status: s(32, { values: ["active", "inactive"] }),
      sale_price: n({ min: 0, nullable: true }),
      regular_price: n({ min: 0, nullable: true }),
      cost_price: n({ min: 0, nullable: true }),
      supplier_id: u({ nullable: true }),
      supplier: s(200, { nullable: true }),
      category: s(120, { nullable: true }),
      subcategory: s(120, { nullable: true }),
      variations: j("array"),
      images: sa(),
      notes: s(10_000, { nullable: true, preserveWhitespace: true }),
      extra_cost: n({ min: 0, nullable: true }),
      extra_cost_description: s(1_000, { nullable: true }),
      total_cost: n({ min: 0, nullable: true }),
      profit_per_unit: n({ nullable: true }),
      margin_percent: n({ nullable: true }),
      discount_percent: n({ min: 0, max: 100, nullable: true }),
      campaign_ids: ua(),
      sku: s(120, { nullable: true }),
      extras: j("array"),
      product_id: u({ nullable: true }),
      revenue_center_id: u({ nullable: true }),
      product_number: i({ min: 1, nullable: true }),
    },
    defaultSort: "-created_date",
    sortFields: [
      "id",
      "name",
      "status",
      "product_number",
      "created_date",
      "updated_date",
    ],
    updatedColumn: "updated_date",
    allowCreate: true,
    allowDelete: true,
  },
  customers: {
    table: "presale_customers",
    fields: {
      full_name: s(200, { required: true }),
      whatsapp: s(32, { nullable: true }),
      email: s(254, { nullable: true }),
      internal_notes: s(20_000, { nullable: true, preserveWhitespace: true }),
      cpf: s(20, { nullable: true }),
      active: b(),
      gender: s(32, { nullable: true }),
      birth_date: d({ nullable: true }),
      coach_id: u({ nullable: true }),
      customer_code: s(80, { nullable: true }),
      address_zip: s(20, { nullable: true }),
      address_street: s(300, { nullable: true }),
      address_number: s(50, { nullable: true }),
      address_complement: s(300, { nullable: true }),
      address_neighborhood: s(200, { nullable: true }),
      address_city: s(200, { nullable: true }),
      address_state: s(2, { nullable: true }),
    },
    defaultSort: "full_name",
    sortFields: [
      "id",
      "full_name",
      "customer_code",
      "created_date",
      "updated_date",
    ],
    updatedColumn: "updated_date",
    allowCreate: true,
  },
  products: {
    table: "products",
    fields: {
      name: s(200, { required: true }),
      description: s(10_000, { nullable: true, preserveWhitespace: true }),
      category: s(120, { nullable: true }),
      subcategory: s(120, { nullable: true }),
      images: j("array"),
      sale_price: n({ min: 0, nullable: true }),
      regular_price: n({ min: 0, nullable: true }),
      cost_price: n({ min: 0, nullable: true }),
      extra_cost: n({ min: 0, nullable: true }),
      supplier: s(200, { nullable: true }),
      supplier_id: u({ nullable: true }),
      notes: s(10_000, { nullable: true, preserveWhitespace: true }),
      status: s(32, { values: ["active", "inactive"] }),
      variations: j("array"),
      extras: j("array"),
    },
    defaultSort: "-created_date",
    sortFields: [
      "id",
      "name",
      "status",
      "product_number",
      "created_date",
      "updated_date",
    ],
    updatedColumn: "updated_date",
    allowCreate: true,
  },
  coupons: {
    table: "coupons",
    fields: {
      code: s(30, { required: true }),
      description: s(1_000, { nullable: true }),
      discount_type: s(20, { required: true, values: ["percentage", "fixed"] }),
      discount_value: n({ required: true, min: 0.01 }),
      min_purchase: n({ min: 0, nullable: true }),
      max_discount: n({ min: 0, nullable: true }),
      valid_from: d({ nullable: true }),
      valid_until: d({ nullable: true }),
      usage_limit_total: i({ min: 1, nullable: true }),
      usage_limit_per_customer: i({ min: 1, nullable: true }),
      active: b(),
    },
    defaultSort: "-created_date",
    sortFields: [
      "id",
      "code",
      "active",
      "valid_from",
      "valid_until",
      "created_date",
      "updated_date",
    ],
    updatedColumn: "updated_date",
    allowCreate: true,
    allowDelete: true,
  },
  "discount-logs": {
    table: "discount_log",
    fields: {
      entity_type: s(32, {
        required: true,
        values: ["presale_order", "stock_order", "assessment_contract"],
      }),
      entity_id: u({ required: true }),
      previous_value: n({ min: 0 }),
      new_value: n({ required: true, min: 0 }),
      reason: s(1_000, { nullable: true, preserveWhitespace: true }),
    },
    defaultSort: "-created_at",
    sortFields: ["id", "entity_type", "entity_id", "created_at"],
    allowCreate: true,
  },
  "renewal-rules": {
    table: "renewal_rules",
    fields: {
      name: s(200, { required: true }),
      days_offset: i({ required: true, min: -3650, max: 3650 }),
      action_type: s(64, {
        values: ["whatsapp", "generate_charge_and_whatsapp"],
      }),
      message_template: s(20_000, { required: true, preserveWhitespace: true }),
      icon: s(32, { nullable: true }),
      color: s(7),
      active: b(),
      order_index: i(),
      rule_type: s(32, { values: ["renewal", "payment"] }),
    },
    defaultSort: "order_index",
    sortFields: [
      "id",
      "name",
      "rule_type",
      "days_offset",
      "active",
      "order_index",
      "created_at",
      "updated_at",
    ],
    updatedColumn: "updated_at",
    allowCreate: true,
    allowDelete: true,
  },
  modalities: {
    table: "assessment_modalities",
    fields: { name: s(120, { required: true }), active: b() },
    defaultSort: "name",
    sortFields: ["id", "name", "active", "created_at", "updated_at"],
    updatedColumn: "updated_at",
    allowCreate: true,
    allowDelete: true,
  },
  plans: {
    table: "assessment_plans",
    fields: {
      modality_id: u({ required: true }),
      period: s(32, { nullable: true }),
      price_monthly: n({ required: true, min: 0.01 }),
      price_total: n({ required: true, min: 0.01 }),
      max_installments: i({ min: 1, max: 120 }),
      active: b(),
      period_months: i({ min: 1, max: 120, nullable: true }),
      enrollment_fee: n({ min: 0 }),
      name: s(200, { nullable: true }),
      revenue_center_id: u({ nullable: true }),
      available_online: b(),
    },
    defaultSort: "name",
    sortFields: [
      "id",
      "name",
      "period",
      "price_monthly",
      "active",
      "created_at",
      "updated_at",
    ],
    updatedColumn: "updated_at",
    allowCreate: true,
  },
  coaches: {
    table: "assessment_coaches",
    fields: {
      name: s(200, { required: true }),
      email: s(254, { required: true }),
      phone: s(32, { nullable: true }),
      active: b(),
      role: s(32, { required: true, values: ["junior", "pleno", "senior"] }),
      leader_id: u({ nullable: true }),
      co_leader_ids: ua(),
    },
    defaultSort: "name",
    sortFields: [
      "id",
      "name",
      "email",
      "role",
      "active",
      "created_at",
      "updated_at",
    ],
    updatedColumn: "updated_at",
    allowCreate: true,
  },
  "payout-rates": {
    table: "payout_role_modality_rates",
    fields: { role: s(32), modality_id: u(), rate: n({ min: 0 }) },
    defaultSort: "role",
    sortFields: [
      "id",
      "role",
      "modality_id",
      "rate",
      "created_at",
      "updated_at",
    ],
    updatedColumn: "updated_at",
  },
  "payout-tiers": {
    table: "payout_growth_tiers",
    fields: {
      name: s(120),
      min_athletes: i({ min: 0 }),
      increment_per_athlete: n({ min: 0 }),
      leadership_bonus: n({ min: 0 }),
      co_leadership_bonus: n({ min: 0 }),
    },
    defaultSort: "min_athletes",
    sortFields: ["id", "name", "min_athletes", "created_at", "updated_at"],
    updatedColumn: "updated_at",
  },
  "payout-closings": {
    table: "payout_monthly_closings",
    fields: {},
    defaultSort: "-competence",
    sortFields: [
      "id",
      "competence",
      "status",
      "generated_at",
      "approved_at",
      "paid_at",
    ],
  },
  "payout-items": {
    table: "payout_monthly_statement_items",
    fields: {},
    defaultSort: "-created_at",
    sortFields: [
      "id",
      "closing_id",
      "coach_id",
      "source_type",
      "created_at",
      "reference_competence",
    ],
  },
  "communication-rules": {
    table: "communication_rules",
    fields: {
      slug: s(120, { required: true }),
      name: s(200, { required: true }),
      journey: s(32, {
        required: true,
        values: ["billing", "onboarding", "renewal", "reactivation"],
      }),
      trigger_event: s(64, { required: true }),
      task_kind: s(64, { required: true }),
      days_offset: i({ min: -3650, max: 3650 }),
      channel: s(32, { values: ["whatsapp"] }),
      message_template: s(20_000, { required: true, preserveWhitespace: true }),
      active: b(),
      order_index: i(),
    },
    defaultSort: "order_index",
    sortFields: [
      "id",
      "slug",
      "name",
      "journey",
      "active",
      "order_index",
      "created_at",
      "updated_at",
    ],
    updatedColumn: "updated_at",
    allowCreate: true,
    allowDelete: true,
  },
  "legacy-presale-orders": {
    table: "presale_orders",
    fields: {
      order_number: s(80, { nullable: true }),
      campaign_id: u({ nullable: true }),
      customer_id: u({ nullable: true }),
      customer_name: s(200, { nullable: true }),
      customer_whatsapp: s(32, { nullable: true }),
      customer_email: s(254, { nullable: true }),
      status: s(32, { nullable: true }),
      items: j("array", { required: true }),
      total_amount: n({ nullable: true }),
      notes: s(10_000, { nullable: true, preserveWhitespace: true }),
      checkout_name: s(200, { nullable: true }),
      checkout_whatsapp: s(32, { nullable: true }),
      checkout_email: s(254, { nullable: true }),
      total_value: n({ min: 0, nullable: true }),
      total_cost: n({ min: 0, nullable: true }),
      payment_status: s(32, {
        values: [
          "pending",
          "awaiting_charge",
          "charge_sent",
          "paid",
          "partially_paid",
          "cancelled",
          "refunded",
        ],
      }),
      delivery_status: s(32, { nullable: true }),
      payment_date: d({ nullable: true }),
      delivery_date: d({ nullable: true }),
      internal_notes: s(20_000, { nullable: true, preserveWhitespace: true }),
      delivery_method: s(80, { nullable: true }),
      delivery_city: s(200, { nullable: true }),
      payment_method: s(80, { nullable: true }),
      due_date: d({ nullable: true }),
      cancellation_reason: s(2_000, { nullable: true }),
      coupon_code: s(30, { nullable: true }),
      discount_value: n({ min: 0, nullable: true }),
      manual_discount: n({ min: 0, nullable: true }),
      discount_reason: s(2_000, { nullable: true }),
      manual_fee: n({ min: 0, nullable: true }),
      manual_payment: b(),
      external_payment_link: s(2_048, { nullable: true }),
      payment_preference: s(80, { nullable: true }),
      coach_id: u({ nullable: true }),
    },
    defaultSort: "-created_date",
    sortFields: ["id", "order_number", "created_date"],
    allowCreate: true,
  },
};

export class AdminRecordInputError extends Error {
  status: number;
  code: string;

  constructor(message: string, code = "invalid_request", status = 400) {
    super(message);
    this.name = "AdminRecordInputError";
    this.status = status;
    this.code = code;
  }
}

function resourceFor(key: string): ResourceSpec {
  const resource = ADMIN_RESOURCES[key];
  if (!resource) {
    throw new AdminRecordInputError("Recurso não encontrado", "not_found", 404);
  }
  return resource;
}

function isObject(value: unknown): value is Payload {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeField(
  field: string,
  value: unknown,
  spec: FieldSpec,
): unknown {
  if (value === null || value === "") {
    if (spec.nullable) return null;
    throw new AdminRecordInputError(`Campo ${field} inválido`, "invalid_field");
  }

  if (spec.kind === "string") {
    if (typeof value !== "string") {
      throw new AdminRecordInputError(
        `Campo ${field} inválido`,
        "invalid_field",
      );
    }
    const normalized = spec.preserveWhitespace ? value.trim() : value.trim();
    if (!normalized || normalized.length > (spec.maxLength ?? 500)) {
      throw new AdminRecordInputError(
        `Campo ${field} inválido`,
        "invalid_field",
      );
    }
    if (spec.values && !spec.values.includes(normalized)) {
      throw new AdminRecordInputError(
        `Campo ${field} inválido`,
        "invalid_field",
      );
    }
    if (field === "color" && !HEX_COLOR_PATTERN.test(normalized)) {
      throw new AdminRecordInputError("Cor inválida", "invalid_field");
    }
    if (field === "email") {
      const email = normalized.toLowerCase();
      if (!EMAIL_PATTERN.test(email)) {
        throw new AdminRecordInputError("E-mail inválido", "invalid_field");
      }
      return email;
    }
    if (field === "cpf") {
      const cpf = normalized.replace(/\D/g, "");
      if (cpf.length !== 11) {
        throw new AdminRecordInputError("CPF inválido", "invalid_field");
      }
      return cpf;
    }
    if (field === "code") return normalized.toUpperCase();
    if (field === "slug" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
      throw new AdminRecordInputError("Slug inválido", "invalid_field");
    }
    return normalized;
  }

  if (spec.kind === "number" || spec.kind === "integer") {
    if (
      typeof value !== "number" || !Number.isFinite(value) ||
      value < (spec.min ?? -Infinity) || value > (spec.max ?? Infinity) ||
      (spec.kind === "integer" && !Number.isInteger(value))
    ) {
      throw new AdminRecordInputError(
        `Campo ${field} inválido`,
        "invalid_field",
      );
    }
    return value;
  }
  if (spec.kind === "boolean") {
    if (typeof value !== "boolean") {
      throw new AdminRecordInputError(
        `Campo ${field} inválido`,
        "invalid_field",
      );
    }
    return value;
  }
  if (spec.kind === "uuid") {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
      throw new AdminRecordInputError(
        `Campo ${field} inválido`,
        "invalid_field",
      );
    }
    return value;
  }
  if (spec.kind === "date") {
    if (
      typeof value !== "string" || !DATE_PATTERN.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    ) {
      throw new AdminRecordInputError(
        `Campo ${field} inválido`,
        "invalid_field",
      );
    }
    return value;
  }
  if (spec.kind === "timestamp") {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      throw new AdminRecordInputError(
        `Campo ${field} inválido`,
        "invalid_field",
      );
    }
    return value;
  }
  if (spec.kind === "json") {
    const validShape = spec.shape === "array"
      ? Array.isArray(value)
      : isObject(value);
    if (!validShape || JSON.stringify(value).length > 200_000) {
      throw new AdminRecordInputError(
        `Campo ${field} inválido`,
        "invalid_field",
      );
    }
    return value;
  }
  if (spec.kind === "string_array") {
    if (
      !Array.isArray(value) || value.length > 100 ||
      value.some((entry) => typeof entry !== "string" || entry.length > 2_000)
    ) {
      throw new AdminRecordInputError(
        `Campo ${field} inválido`,
        "invalid_field",
      );
    }
    return value;
  }
  if (spec.kind === "uuid_array") {
    if (
      !Array.isArray(value) || value.length > 500 ||
      value.some((entry) =>
        typeof entry !== "string" || !UUID_PATTERN.test(entry)
      )
    ) {
      throw new AdminRecordInputError(
        `Campo ${field} inválido`,
        "invalid_field",
      );
    }
    return [...new Set(value)];
  }
  throw new AdminRecordInputError(`Campo ${field} inválido`, "invalid_field");
}

export function normalizeAdminRecordPayload(
  resourceKey: string,
  value: unknown,
  mode: Mode,
): Payload {
  const resource = resourceFor(resourceKey);
  if (!isObject(value)) {
    throw new AdminRecordInputError("Corpo JSON inválido", "invalid_json");
  }
  if (mode === "create" && !resource.allowCreate) {
    throw new AdminRecordInputError(
      "Criação não permitida",
      "method_not_allowed",
      405,
    );
  }
  const fields = Object.entries(value);
  if (fields.length === 0) {
    throw new AdminRecordInputError("Nenhum campo informado", "empty_payload");
  }

  const output: Payload = {};
  for (const [field, raw] of fields) {
    const spec = resource.fields[field];
    if (!spec) {
      throw new AdminRecordInputError(
        `Campo não permitido: ${field}`,
        "invalid_field",
      );
    }
    output[field] = normalizeField(field, raw, spec);
  }
  if (mode === "create") {
    for (const [field, spec] of Object.entries(resource.fields)) {
      if (spec.required && !(field in output)) {
        throw new AdminRecordInputError(
          `Campo obrigatório: ${field}`,
          "missing_field",
        );
      }
    }
  }
  if (
    resourceKey === "campaigns" && output.start_date && output.end_date &&
    output.end_date < output.start_date
  ) {
    throw new AdminRecordInputError(
      "Data final anterior à inicial",
      "invalid_date_range",
    );
  }
  if (
    resourceKey === "coupons" && output.valid_from && output.valid_until &&
    output.valid_until < output.valid_from
  ) {
    throw new AdminRecordInputError(
      "Validade final anterior à inicial",
      "invalid_date_range",
    );
  }
  if (
    resourceKey === "plans" && output.available_online === true &&
    output.active === false
  ) {
    throw new AdminRecordInputError(
      "Plano inativo não pode estar disponível online",
      "invalid_plan_state",
    );
  }
  return output;
}

function errorResponse(error: unknown): Response {
  if (error instanceof AdminRecordInputError) {
    return jsonResponse(
      { error: error.message, code: error.code },
      error.status,
    );
  }
  throw error;
}

function databaseError(
  error: { code?: string; message?: string },
  operation: string,
): Response {
  console.error(`api-v1 admin records ${operation}:`, error);
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
  if (["22001", "22P02", "23514", "23502"].includes(error.code ?? "")) {
    return jsonResponse(
      { error: "Dados inválidos", code: "invalid_request" },
      400,
    );
  }
  return jsonResponse({
    error: "Não foi possível processar o cadastro",
    code: "database_error",
  }, 500);
}

async function requestPayload(req: Request): Promise<unknown> {
  const raw = await req.text();
  if (!raw || raw.length > 262_144) {
    throw new AdminRecordInputError(
      "Corpo JSON inválido ou muito grande",
      "invalid_json",
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new AdminRecordInputError("Corpo JSON inválido", "invalid_json");
  }
}

export async function handleAdminRecordRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  const match = path.match(/^\/admin-records\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return null;
  const [, resourceKey, itemId] = match;
  let resource: ResourceSpec;
  try {
    resource = resourceFor(resourceKey);
  } catch (error) {
    return errorResponse(error);
  }

  if (itemId && !UUID_PATTERN.test(itemId)) {
    return jsonResponse(
      { error: "Identificador inválido", code: "invalid_id" },
      400,
    );
  }

  if (req.method === "GET" && !itemId) {
    const requested = new URL(req.url).searchParams.get("sort") ||
      resource.defaultSort;
    const ascending = !requested.startsWith("-");
    const field = ascending ? requested : requested.slice(1);
    if (!resource.sortFields.includes(field)) {
      return jsonResponse(
        { error: "Ordenação inválida", code: "invalid_sort" },
        400,
      );
    }
    const { data, error } = await supabase.from(resource.table).select("*")
      .order(field, { ascending });
    if (error) return databaseError(error, `${resourceKey} list`);
    return jsonResponse({ data: data ?? [] });
  }

  if (req.method === "GET" && itemId) {
    const { data, error } = await supabase.from(resource.table).select("*").eq(
      "id",
      itemId,
    ).maybeSingle();
    if (error) return databaseError(error, `${resourceKey} get`);
    if (!data) {
      return jsonResponse({
        error: "Cadastro não encontrado",
        code: "not_found",
      }, 404);
    }
    return jsonResponse({ data });
  }

  if (req.method === "POST" && !itemId) {
    let payload: Payload;
    try {
      payload = normalizeAdminRecordPayload(
        resourceKey,
        await requestPayload(req),
        "create",
      );
    } catch (error) {
      return errorResponse(error);
    }
    if ("created_by" in resource.fields) payload.created_by = actorId;
    const { data, error } = await supabase.from(resource.table).insert(payload)
      .select("*").single();
    if (error) return databaseError(error, `${resourceKey} create`);
    return jsonResponse({ data }, 201);
  }

  if (req.method === "PATCH" && itemId) {
    let payload: Payload;
    try {
      payload = normalizeAdminRecordPayload(
        resourceKey,
        await requestPayload(req),
        "update",
      );
    } catch (error) {
      return errorResponse(error);
    }
    if (resource.updatedColumn) {
      payload[resource.updatedColumn] = new Date().toISOString();
    }
    const { data, error } = await supabase.from(resource.table).update(payload)
      .eq("id", itemId).select("*").maybeSingle();
    if (error) return databaseError(error, `${resourceKey} update`);
    if (!data) {
      return jsonResponse({
        error: "Cadastro não encontrado",
        code: "not_found",
      }, 404);
    }
    return jsonResponse({ data });
  }

  if (req.method === "DELETE" && itemId) {
    if (!resource.allowDelete) {
      return jsonResponse({
        error: "Exclusão não permitida",
        code: "method_not_allowed",
      }, 405);
    }
    const { data, error } = await supabase.from(resource.table).delete().eq(
      "id",
      itemId,
    ).select("id").maybeSingle();
    if (error) return databaseError(error, `${resourceKey} delete`);
    if (!data) {
      return jsonResponse({
        error: "Cadastro não encontrado",
        code: "not_found",
      }, 404);
    }
    return jsonResponse({ data: { id: itemId, deleted: true } });
  }

  return jsonResponse({
    error: "Método não permitido",
    code: "method_not_allowed",
  }, 405);
}
