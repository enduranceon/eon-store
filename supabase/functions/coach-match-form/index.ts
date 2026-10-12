import { createServiceClient } from "../_shared/serviceClient.ts";
import { handleCoachMatchForm } from "./handler.ts";

Deno.serve((req: Request) => handleCoachMatchForm(req, { createServiceClient }));
