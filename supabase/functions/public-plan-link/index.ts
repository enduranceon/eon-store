import { createServiceClient } from "../_shared/serviceClient.ts";
import { handlePublicPlanLink } from "./handler.ts";

Deno.serve((req: Request) =>
  handlePublicPlanLink(req, {
    createServiceClient,
    hashSalt: () => Deno.env.get("PUBLIC_FORM_HASH_SALT") || Deno.env.get("TURNSTILE_SECRET_KEY") || "",
  })
);
