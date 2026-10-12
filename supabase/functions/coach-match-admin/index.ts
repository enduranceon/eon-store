import { createServiceClient } from "../_shared/serviceClient.ts";
import { requireAdmin } from "../_shared/requireAdmin.ts";
import { handleCoachMatchAdmin } from "./handler.ts";

Deno.serve((req: Request) => handleCoachMatchAdmin(req, { requireAdmin, createServiceClient }));
