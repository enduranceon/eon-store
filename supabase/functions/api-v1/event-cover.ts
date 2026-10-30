import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.7";
import { jsonResponse } from "../_shared/http.ts";

// Capa da página de inscrição do evento. O arquivo vai do navegador direto
// para o bucket público event-covers por uma URL assinada gerada aqui; depois
// o caminho é gravado no evento e a capa anterior sai do bucket.

const BUCKET = "event-covers";
const MAX_SIZE = 5 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE_PATTERN = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;

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

// O caminho tem que ser exatamente o formato que esta API gera, dentro da
// pasta do próprio evento.
export function isEventCoverPath(eventId: string, value: unknown): value is string {
  if (typeof value !== "string") return false;
  const [folder, file, ...rest] = value.split("/");
  return rest.length === 0 && folder === eventId && FILE_PATTERN.test(file ?? "");
}

function databaseError(error: { code?: string; message?: string }): Response {
  console.error("api-v1 event cover:", error);
  if (error.code === "P0002") {
    return jsonResponse({ error: error.message, code: "not_found" }, 404);
  }
  if (error.code === "22023") {
    return jsonResponse({ error: error.message, code: "invalid_request" }, 400);
  }
  return jsonResponse({
    error: "Não foi possível salvar a capa",
    code: "database_error",
  }, 500);
}

export async function handleEventCoverRequest(
  req: Request,
  path: string,
  supabase: SupabaseClient,
): Promise<Response | null> {
  const match = path.match(/^\/events\/([^/]+)\/cover(\/upload-url)?$/);
  if (!match) return null;
  const [, eventId, uploadUrl] = match;
  if (!UUID_PATTERN.test(eventId)) {
    return jsonResponse({ error: "Evento inválido", code: "invalid_request" }, 400);
  }

  if (uploadUrl) {
    if (req.method !== "POST") {
      return jsonResponse({ error: "Método não permitido", code: "method_not_allowed" }, 405);
    }
    const body = await readBody(req);
    if (
      !body || !exactKeys(body, ["mime_type", "size_bytes"]) ||
      typeof body.mime_type !== "string" || !EXTENSIONS[body.mime_type] ||
      typeof body.size_bytes !== "number" || !Number.isFinite(body.size_bytes) ||
      body.size_bytes <= 0 || body.size_bytes > MAX_SIZE
    ) {
      return jsonResponse({
        error: "Envie um JPG, PNG ou WEBP de até 5 MB",
        code: "invalid_request",
      }, 400);
    }

    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id")
      .eq("id", eventId)
      .maybeSingle();
    if (eventError) return databaseError(eventError);
    if (!event) {
      return jsonResponse({ error: "Evento não encontrado", code: "not_found" }, 404);
    }

    const filePath = `${eventId}/${crypto.randomUUID()}.${EXTENSIONS[body.mime_type]}`;
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(filePath);
    if (error) {
      console.error("api-v1 event cover upload-url:", error);
      return jsonResponse({
        error: "Não foi possível preparar o envio",
        code: "storage_error",
      }, 500);
    }
    return jsonResponse({ data: { path: filePath, token: data.token } });
  }

  if (req.method !== "PUT") {
    return jsonResponse({ error: "Método não permitido", code: "method_not_allowed" }, 405);
  }
  const body = await readBody(req);
  if (
    !body || !exactKeys(body, ["path"]) ||
    (body.path !== null && !isEventCoverPath(eventId, body.path))
  ) {
    return jsonResponse({ error: "Capa inválida", code: "invalid_request" }, 400);
  }
  const coverPath = body.path as string | null;

  // Só aponta para um arquivo que de fato chegou ao bucket.
  if (coverPath) {
    const fileName = coverPath.split("/")[1];
    const { data: found, error: listError } = await supabase.storage
      .from(BUCKET)
      .list(eventId, { search: fileName, limit: 1 });
    if (listError) {
      console.error("api-v1 event cover list:", listError);
      return jsonResponse({
        error: "Não foi possível conferir o arquivo enviado",
        code: "storage_error",
      }, 500);
    }
    if (!(found ?? []).some((item: { name?: string }) => item.name === fileName)) {
      return jsonResponse({
        error: "O arquivo da capa não chegou. Envie de novo",
        code: "invalid_request",
      }, 400);
    }
  }

  const { data, error } = await supabase.rpc("set_event_cover_image", {
    p_event_id: eventId,
    p_path: coverPath,
  });
  if (error) return databaseError(error);

  // O arquivo antigo sai depois da troca: se o Storage falhar, sobra um objeto
  // órfão no bucket, nunca um evento apontando para uma imagem que não existe.
  const previous = (data as { previous_path?: string | null } | null)?.previous_path;
  if (previous && previous !== coverPath && isEventCoverPath(eventId, previous)) {
    const { error: removeError } = await supabase.storage.from(BUCKET).remove([previous]);
    if (removeError) console.error("api-v1 event cover remove:", removeError);
  }
  return jsonResponse({ data: { cover_image_path: coverPath } });
}
