// Used only by the isolated coach match functions. No catalog or financial calls.
export const MATCH_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

export const MATCH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type MatchRpcClient = {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { code?: string } | null;
  }>;
};

export function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: MATCH_HEADERS });
}

export function options(): Response {
  return new Response(null, { status: 204, headers: MATCH_HEADERS });
}

export function rpcFailure(error: { code?: string }): Response {
  const failures: Record<string, [number, string]> = {
    PT400: [400, "Dados inválidos."],
    PT404: [404, "Registro não encontrado."],
    PT409: [409, "Esta versão mudou. Atualize a página antes de continuar."],
    PT410: [410, "Este link expirou ou foi substituído. Peça um novo link à equipe."],
    PT429: [429, "Limite temporário de envios. Aguarde antes de enviar novamente."],
  };
  const [status, message] = failures[error.code || ""] || [500, "Não foi possível concluir a operação."];
  return reply({ error: message }, status);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function readLimitedJson(req: Request): Promise<{ body: unknown; tooLarge: boolean }> {
  if (Number(req.headers.get("content-length") || 0) > 8_192) return { body: null, tooLarge: true };
  const reader = req.body?.getReader();
  if (!reader) return { body: null, tooLarge: false };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8_192) {
        await reader.cancel().catch(() => {});
        return { body: null, tooLarge: true };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { body: JSON.parse(text), tooLarge: false };
  } catch {
    return { body: null, tooLarge: false };
  } finally {
    reader.releaseLock();
  }
}
