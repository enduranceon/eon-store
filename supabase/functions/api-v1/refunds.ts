import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

const BUCKET = "refund-receipts";
const SOURCE_TYPES = new Set([
  "assessment_contract",
  "presale_order",
  "stock_order",
]);
const STATUSES = new Set(["pending", "done"]);
const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
]);
const MAX_SIZE = 10 * 1024 * 1024;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isCalendarDate(value: unknown): value is string {
  return typeof value === "string" && DATE_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value));
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function exactKeys(body: Record<string, unknown>, allowed: string[]): boolean {
  const keys = Object.keys(body);
  return keys.length === allowed.length &&
    keys.every((key) => allowed.includes(key));
}

// O nome vindo do navegador nunca entra no caminho do arquivo: ele é gravado
// como metadado e o caminho é gerado aqui. Evita travessia de diretório e
// colisão entre uploads.
function safeExtension(fileName: string, mime: string): string {
  const byMime: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "application/pdf": "pdf",
  };
  return byMime[mime] || "bin";
}

function databaseError(
  error: { code?: string; message?: string },
  operation: string,
): Response {
  console.error(`api-v1 refunds ${operation}:`, error);
  if (error.code === "P0002") {
    return jsonResponse({ error: error.message, code: "not_found" }, 404);
  }
  if (error.code === "22023") {
    return jsonResponse({ error: error.message, code: "invalid_request" }, 400);
  }
  if (error.code === "P0001" || error.code === "23505") {
    return jsonResponse({ error: error.message, code: "invalid_transition" }, 409);
  }
  return jsonResponse({
    error: "Não foi possível processar o estorno",
    code: "database_error",
  }, 500);
}

export async function handleRefundsRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
  actorId: string,
): Promise<Response | null> {
  // ── Lista unificada ───────────────────────────────────────────────────────
  if (req.method === "GET" && path === "/refunds") {
    const params = new URL(req.url).searchParams;
    const status = params.get("status");
    const from = params.get("from");
    const to = params.get("to");

    if (status && !STATUSES.has(status)) {
      return jsonResponse({ error: "Status inválido", code: "invalid_status" }, 400);
    }
    if ((from && !isCalendarDate(from)) || (to && !isCalendarDate(to))) {
      return jsonResponse({ error: "Período inválido", code: "invalid_request" }, 400);
    }

    let query = supabase
      .from("refunds_overview")
      .select("*")
      .order("updated_at", { ascending: false });

    if (status) query = query.eq("status", status);
    // O filtro de período olha a data de conclusão para os já feitos e a data
    // do pedido de estorno para os pendentes, que é o que o operador espera.
    if (from) query = query.or(`completed_on.gte.${from},requested_on.gte.${from}`);
    if (to) query = query.or(`completed_on.lte.${to},requested_on.lte.${to}`);

    const { data, error } = await query;
    if (error) return databaseError(error, "list");

    const rows = data ?? [];
    const ids = rows.map((row: Record<string, unknown>) => row.source_id);
    let receipts: Record<string, unknown>[] = [];
    if (ids.length) {
      const { data: receiptRows, error: receiptError } = await supabase
        .from("refund_receipts")
        .select("id,source_type,source_id,file_name,mime_type,size_bytes,uploaded_at")
        .in("source_id", ids)
        .order("uploaded_at", { ascending: false });
      if (receiptError) return databaseError(receiptError, "list receipts");
      receipts = receiptRows ?? [];
    }

    const withReceipts = rows.map((row: Record<string, unknown>) => ({
      ...row,
      receipts: receipts.filter((r) =>
        r.source_id === row.source_id && r.source_type === row.source_type
      ),
    }));

    return jsonResponse({ data: withReceipts });
  }

  // ── URL assinada de upload ────────────────────────────────────────────────
  const uploadMatch = path.match(/^\/refunds\/([^/]+)\/([^/]+)\/receipts\/upload-url$/);
  if (req.method === "POST" && uploadMatch) {
    const [, sourceType, sourceId] = uploadMatch;
    if (!SOURCE_TYPES.has(sourceType) || !isUuid(sourceId)) {
      return jsonResponse({ error: "Origem inválida", code: "invalid_request" }, 400);
    }

    const body = await readBody(req);
    if (
      !body || !exactKeys(body, ["mime_type", "size_bytes"]) ||
      typeof body.mime_type !== "string" || !ALLOWED_MIME.has(body.mime_type) ||
      typeof body.size_bytes !== "number" || !Number.isFinite(body.size_bytes) ||
      body.size_bytes <= 0 || body.size_bytes > MAX_SIZE
    ) {
      return jsonResponse({
        error: "Envie um PNG, JPG, WEBP ou PDF de até 10 MB",
        code: "invalid_request",
      }, 400);
    }

    const filePath = `${sourceType}/${sourceId}/${crypto.randomUUID()}.${
      safeExtension("", body.mime_type)
    }`;
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(filePath);
    if (error) {
      console.error("api-v1 refunds upload-url:", error);
      return jsonResponse({
        error: "Não foi possível preparar o envio",
        code: "storage_error",
      }, 500);
    }
    return jsonResponse({ data: { path: filePath, token: data.token } });
  }

  // ── Registro do comprovante depois do upload ──────────────────────────────
  const registerMatch = path.match(/^\/refunds\/([^/]+)\/([^/]+)\/receipts$/);
  if (req.method === "POST" && registerMatch) {
    const [, sourceType, sourceId] = registerMatch;
    if (!SOURCE_TYPES.has(sourceType) || !isUuid(sourceId)) {
      return jsonResponse({ error: "Origem inválida", code: "invalid_request" }, 400);
    }

    const body = await readBody(req);
    if (
      !body ||
      !exactKeys(body, ["file_path", "file_name", "mime_type", "size_bytes"]) ||
      typeof body.file_path !== "string" ||
      // O caminho tem que ser exatamente o que esta API gerou.
      !body.file_path.startsWith(`${sourceType}/${sourceId}/`) ||
      body.file_path.includes("..") ||
      typeof body.file_name !== "string" || body.file_name.length > 260 ||
      typeof body.mime_type !== "string" || !ALLOWED_MIME.has(body.mime_type) ||
      typeof body.size_bytes !== "number" || body.size_bytes <= 0 ||
      body.size_bytes > MAX_SIZE
    ) {
      return jsonResponse({ error: "Comprovante inválido", code: "invalid_request" }, 400);
    }

    const { data, error } = await supabase.rpc("register_refund_receipt", {
      p_source_type: sourceType,
      p_source_id: sourceId,
      p_file_path: body.file_path,
      p_file_name: body.file_name,
      p_mime_type: body.mime_type,
      p_size_bytes: body.size_bytes,
      p_actor_id: actorId,
    });
    if (error) return databaseError(error, "register receipt");
    return jsonResponse({ data });
  }

  // ── Link temporário de download ───────────────────────────────────────────
  const downloadMatch = path.match(/^\/refunds\/receipts\/([^/]+)\/download$/);
  if (req.method === "GET" && downloadMatch) {
    const receiptId = downloadMatch[1];
    if (!isUuid(receiptId)) {
      return jsonResponse({ error: "Comprovante inválido", code: "invalid_request" }, 400);
    }
    const { data: receipt, error } = await supabase
      .from("refund_receipts")
      .select("file_path,file_name")
      .eq("id", receiptId)
      .maybeSingle();
    if (error) return databaseError(error, "receipt lookup");
    if (!receipt) {
      return jsonResponse({ error: "Comprovante não encontrado", code: "not_found" }, 404);
    }

    const { data: signed, error: signError } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(receipt.file_path, 300, { download: receipt.file_name });
    if (signError) {
      console.error("api-v1 refunds download:", signError);
      return jsonResponse({
        error: "Não foi possível gerar o link",
        code: "storage_error",
      }, 500);
    }
    return jsonResponse({ data: { url: signed.signedUrl, expires_in: 300 } });
  }

  // ── Remoção ───────────────────────────────────────────────────────────────
  const deleteMatch = path.match(/^\/refunds\/receipts\/([^/]+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    const receiptId = deleteMatch[1];
    if (!isUuid(receiptId)) {
      return jsonResponse({ error: "Comprovante inválido", code: "invalid_request" }, 400);
    }
    const { data, error } = await supabase.rpc("delete_refund_receipt", {
      p_receipt_id: receiptId,
      p_actor_id: actorId,
    });
    if (error) return databaseError(error, "delete receipt");

    // O arquivo sai depois da linha: se o Storage falhar, sobra um objeto órfão
    // no bucket, que é bem menos grave do que um ponteiro apontando para nada.
    const filePath = data?.receipt?.file_path;
    if (filePath) {
      const { error: removeError } = await supabase.storage
        .from(BUCKET)
        .remove([filePath]);
      if (removeError) console.error("api-v1 refunds remove object:", removeError);
    }
    return jsonResponse({ data });
  }

  return null;
}
