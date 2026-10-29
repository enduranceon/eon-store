import { createServiceClient } from "../_shared/serviceClient.ts";
import { verifyTurnstile } from "../_shared/turnstile.ts";
import { handlePublicContactRequest } from "./handler.ts";

Deno.serve((req: Request) =>
  handlePublicContactRequest(req, {
    createServiceClient,
    verifyTurnstile: (request, token) => verifyTurnstile(request, token, ["contact_submit", "prospect_submit"]),
    hashSalt: () => Deno.env.get("PUBLIC_FORM_HASH_SALT") || Deno.env.get("TURNSTILE_SECRET_KEY") || "",
  })
);
