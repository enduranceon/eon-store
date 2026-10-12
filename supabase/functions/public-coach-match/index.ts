import { createServiceClient } from "../_shared/serviceClient.ts";
import { handlePublicCoachMatch } from "./handler.ts";

Deno.serve((req: Request) => handlePublicCoachMatch(req, { createServiceClient }));
