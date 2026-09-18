import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requireAdmin } from "../_shared/requireAdmin.ts";
import {
  normalizeRenewalRequest,
  RenewalRequestValidationError,
} from "./policy.ts";

// Processa a continuidade interna dos contratos sem acessar o Asaas.
// Renovações manuais viram rascunho; automáticas são agendadas 5 dias antes.
//
// Body (opcional):
//   { horizon_days: 15 }  // janela em dias antes do end_date (default 15)
//   { auto_horizon_days: 5 }  // antecedência da renovação automática
//   { contract_ids: ["uuid", ...] }  // força renovação só desses (ignora horizon)
//
// Retorna contadores de rascunhos, automações e transições de vigência.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Comparação em tempo constante: evita que a diferença de tempo entre um
// "errou no 1º caractere" e um "errou no último" vaze o segredo por timing.
function secretsMatch(received: string, expected: string): boolean {
  const a = new TextEncoder().encode(received);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// AUTHZ: aceita DUAS identidades e nada além disso.
//   1. admin allowlistado (uso humano, pelo botão da tela)
//   2. o agendador, provando posse do CRON_SECRET
// Se CRON_SECRET não estiver configurado, o caminho do agendador simplesmente
// não existe — nunca vira uma porta aberta por omissão.
async function authorize(
  req: Request,
): Promise<{ ok: boolean; status: number; actor: string }> {
  const expected = Deno.env.get("CRON_SECRET");
  const received = req.headers.get("x-cron-secret");
  if (expected && received && secretsMatch(received, expected)) {
    return { ok: true, status: 200, actor: "cron" };
  }
  const gate = await requireAdmin(req);
  return { ok: gate.ok, status: gate.status, actor: "admin" };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // 🔒 AUTHZ: admin allowlistado OU o agendador com o CRON_SECRET
  const gate = await authorize(req);
  if (!gate.ok) return jsonResponse({ error: "unauthorized" }, gate.status);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const body = await req.json().catch(() => ({}));
    const normalized = normalizeRenewalRequest(body);
    const { data, error } = await supabase.rpc(
      "process_internal_assessment_renewals",
      {
        p_horizon_days: normalized.horizonDays,
        p_auto_horizon_days: normalized.autoHorizonDays,
        p_contract_ids: normalized.contractIds,
      },
    );
    if (error) throw error;
    return jsonResponse(data ?? {
      ok: true,
      processed: 0,
      contracts_created: 0,
      drafts_created: 0,
      automatic_renewals_scheduled: 0,
      automatic_renewals_activated: 0,
      automatic_drafts_approved: 0,
      scheduled_renewals_activated: 0,
      results: [],
      errors: [],
      message: "Nenhum contrato dentro da janela de renovação.",
    });
  } catch (error: unknown) {
    if (error instanceof RenewalRequestValidationError) {
      return jsonResponse({ error: error.message }, 400);
    }
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
});
