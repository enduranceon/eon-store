// Verificação do Cloudflare Turnstile para formulários públicos do site.
export class TurnstileUnavailableError extends Error {
  constructor() {
    super("Turnstile unavailable");
    this.name = "TurnstileUnavailableError";
  }
}

const SITE_HOSTS = new Set([
  "enduranceon.com.br",
  "www.enduranceon.com.br",
  "localhost",
]);

export function clientIp(req: Request): string {
  return String(
    req.headers.get("cf-connecting-ip") ||
      req.headers.get("x-forwarded-for")?.split(",")[0] || "",
  ).trim().slice(0, 80);
}

// Válido só para o site da EON e para uma das ações aceitas (ou sem ação).
export async function verifyTurnstile(
  req: Request,
  token: string,
  actions: readonly string[],
): Promise<boolean> {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) throw new TurnstileUnavailableError();

  const form = new FormData();
  form.set("secret", secret);
  form.set("response", token);
  const ip = clientIp(req);
  if (ip) form.set("remoteip", ip);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const result = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form, signal: controller.signal },
    );
    if (!result.ok) throw new TurnstileUnavailableError();
    const outcome = await result.json().catch(() => null) as {
      success?: boolean;
      hostname?: string;
      action?: string;
    } | null;
    if (!outcome) throw new TurnstileUnavailableError();
    return outcome.success === true && SITE_HOSTS.has(outcome.hostname || "") &&
      (!outcome.action || actions.includes(outcome.action));
  } catch {
    throw new TurnstileUnavailableError();
  } finally {
    clearTimeout(timeout);
  }
}
