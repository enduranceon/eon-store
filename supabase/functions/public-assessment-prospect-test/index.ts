import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://www.enduranceon.com.br",
  "https://enduranceon.com.br",
  "http://localhost:8080",
  "http://localhost:8000",
  "http://127.0.0.1:8080",
  "http://127.0.0.1:8000",
]);

const PERIOD_MONTHS: Record<string, number> = {
  mensal: 1,
  trimestral: 3,
  semestral: 6,
  anual: 12,
};

function corsHeaders(req: Request) {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://www.enduranceon.com.br";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function hasAllowedOrigin(req: Request) {
  const origin = req.headers.get("Origin");
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req) },
  });
}

function digits(value: unknown) {
  return String(value || "").replace(/\D/g, "");
}

function cleanText(value: unknown, maxLength = 180) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text ? text.slice(0, maxLength) : "";
}

function slug(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function validateCpf(value: unknown) {
  const d = digits(value);
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * (10 - i);
  let r = sum % 11;
  if ((r < 2 ? 0 : 11 - r) !== Number(d[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(d[i]) * (11 - i);
  r = sum % 11;
  return (r < 2 ? 0 : 11 - r) === Number(d[10]);
}

function normalizeBrazilPhone(value: unknown) {
  const d = digits(value);
  if (d.length === 10 || d.length === 11) return `+55${d}`;
  if (d.length === 12 || d.length === 13) return `+${d}`;
  return "";
}

function todayLocalStr() {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addMonths(dateStr: string, months: number) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setMonth(d.getMonth() + months);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function planMonths(plan: any) {
  return Number(plan?.period_months) || PERIOD_MONTHS[slug(plan?.period)] || 1;
}

function firstFilled<T extends string | null | undefined>(next: T, current: T) {
  return next === undefined || next === null || String(next).trim() === "" ? current : next;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "Método não permitido." }, 405);
  if (!hasAllowedOrigin(req)) return json(req, { ok: false, error: "Origem não permitida." }, 403);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return json(req, { ok: false, error: "Configuração do servidor incompleta." }, 500);
    }

    const payload = await req.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      return json(req, { ok: false, error: "JSON inválido." }, 400);
    }

    if (cleanText(payload.website, 40)) {
      return json(req, { ok: true, status: "ignored", message: "Cadastro recebido." });
    }

    const fullName = cleanText(payload.full_name || payload.nome, 160);
    const whatsapp = normalizeBrazilPhone(payload.whatsapp);
    const email = cleanText(payload.email, 180).toLowerCase();
    const cpf = digits(payload.cpf);
    const modalitySlug = slug(payload.modality || payload.modalidade);
    const periodSlug = slug(payload.period || payload.periodicidade);
    const region = slug(payload.region || payload.regiao);
    const coachInput = cleanText(payload.coach || payload.treinador, 120);
    const coachSlug = slug(coachInput);
    const zip = digits(payload.address_zip || payload.cep);
    const addressNumber = cleanText(payload.address_number || payload.numero, 40);
    const addressComplement = cleanText(payload.address_complement || payload.complemento, 120);
    const addressStreet = cleanText(payload.address_street || payload.rua, 160);
    const addressNeighborhood = cleanText(payload.address_neighborhood || payload.bairro, 120);
    const addressCity = cleanText(payload.address_city || payload.cidade, 120);
    const addressState = cleanText(payload.address_state || payload.uf, 2).toUpperCase();

    if (!fullName) return json(req, { ok: false, error: "Informe o nome completo." }, 400);
    if (!whatsapp) return json(req, { ok: false, error: "Informe um WhatsApp válido." }, 400);
    if (!validateCpf(cpf)) return json(req, { ok: false, error: "Informe um CPF válido." }, 400);
    if (!modalitySlug) return json(req, { ok: false, error: "Informe a modalidade." }, 400);
    if (!PERIOD_MONTHS[periodSlug]) return json(req, { ok: false, error: "Informe uma periodicidade válida." }, 400);
    if (!coachSlug) return json(req, { ok: false, error: "Informe o treinador." }, 400);
    if (zip.length !== 8) return json(req, { ok: false, error: "Informe um CEP válido com 8 dígitos." }, 400);
    if (!addressNumber) return json(req, { ok: false, error: "Informe o número do endereço." }, 400);

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const [{ data: modalities, error: modalityError }, { data: coaches, error: coachError }] = await Promise.all([
      supabase.from("assessment_modalities").select("id,name").eq("active", true),
      supabase.from("assessment_coaches").select("id,name").eq("active", true),
    ]);
    if (modalityError) throw modalityError;
    if (coachError) throw coachError;

    const modality = (modalities || []).find((item: any) => slug(item.name) === modalitySlug);
    if (!modality) {
      return json(req, { ok: false, error: "Modalidade não encontrada no EON Store." }, 422);
    }

    const coach = (coaches || []).find((item: any) => slug(item.name) === coachSlug);
    if (!coach) {
      return json(req, {
        ok: false,
        error: "Treinador não encontrado no EON Store.",
        received_coach: coachInput,
        available_coaches: (coaches || []).map((item: any) => item.name),
      }, 422);
    }

    const { data: plans, error: planError } = await supabase
      .from("assessment_plans")
      .select("*")
      .eq("active", true)
      .eq("available_online", true)
      .eq("modality_id", modality.id);
    if (planError) throw planError;

    const matchingPlans = (plans || [])
      .filter((plan: any) => slug(plan.period) === periodSlug || planMonths(plan) === PERIOD_MONTHS[periodSlug])
      .sort((a: any, b: any) => Number(a.price_monthly || 0) - Number(b.price_monthly || 0));

    const plan = matchingPlans[0];
    if (!plan) {
      return json(req, { ok: false, error: "Plano online não encontrado para essa modalidade e periodicidade." }, 422);
    }

    let status = "created";
    const { data: existingCustomer, error: existingCustomerError } = await supabase
      .from("presale_customers")
      .select("*")
      .eq("cpf", cpf)
      .maybeSingle();
    if (existingCustomerError) throw existingCustomerError;

    const customerPayload = {
      full_name: fullName,
      whatsapp,
      email: email || null,
      cpf,
      coach_id: coach.id,
      address_zip: zip,
      address_street: addressStreet || null,
      address_number: addressNumber,
      address_complement: addressComplement || null,
      address_neighborhood: addressNeighborhood || null,
      address_city: addressCity || null,
      address_state: addressState || null,
    };

    let customer = existingCustomer;
    if (customer) {
      status = "updated";
      const { data: updatedCustomer, error: updateCustomerError } = await supabase
        .from("presale_customers")
        .update({
          full_name: firstFilled(customerPayload.full_name, customer.full_name),
          whatsapp: firstFilled(customerPayload.whatsapp, customer.whatsapp),
          email: firstFilled(customerPayload.email, customer.email),
          coach_id: firstFilled(customerPayload.coach_id, customer.coach_id),
          address_zip: firstFilled(customerPayload.address_zip, customer.address_zip),
          address_street: firstFilled(customerPayload.address_street, customer.address_street),
          address_number: firstFilled(customerPayload.address_number, customer.address_number),
          address_complement: firstFilled(customerPayload.address_complement, customer.address_complement),
          address_neighborhood: firstFilled(customerPayload.address_neighborhood, customer.address_neighborhood),
          address_city: firstFilled(customerPayload.address_city, customer.address_city),
          address_state: firstFilled(customerPayload.address_state, customer.address_state),
          updated_date: new Date().toISOString(),
        })
        .eq("id", customer.id)
        .select("*")
        .single();
      if (updateCustomerError) throw updateCustomerError;
      customer = updatedCustomer;
    } else {
      const { data: createdCustomer, error: createCustomerError } = await supabase
        .from("presale_customers")
        .insert(customerPayload)
        .select("*")
        .single();
      if (createCustomerError) throw createCustomerError;
      customer = createdCustomer;
    }

    const startDate = todayLocalStr();
    const months = planMonths(plan);
    const endDate = addMonths(startDate, months);
    const planSnapshot = {
      plan_id: plan.id,
      name: plan.name || null,
      modality_id: plan.modality_id,
      price_total: Number(plan.price_total) || 0,
      price_monthly: Number(plan.price_monthly) || 0,
      enrollment_fee: Number(plan.enrollment_fee) || 0,
      max_installments: plan.max_installments,
      period_months: months,
      snapshot_at: new Date().toISOString(),
      snapshot_source: "enduranceon_site_test",
      match_strategy: matchingPlans.length > 1 ? "lowest_monthly_online_plan" : "single_online_plan",
    };
    const notes = [
      "Pré-matrícula via site Endurance On (TESTE).",
      region ? `Região: ${region}.` : "",
      `Treinador escolhido: ${coach.name}.`,
      matchingPlans.length > 1 ? `Havia ${matchingPlans.length} planos possíveis; escolhido o menor valor mensal.` : "",
    ].filter(Boolean).join(" ");

    const { data: existingDraft, error: existingDraftError } = await supabase
      .from("assessment_contracts")
      .select("id")
      .eq("customer_id", customer.id)
      .eq("plan_id", plan.id)
      .eq("status", "draft")
      .is("parent_contract_id", null)
      .maybeSingle();
    if (existingDraftError) throw existingDraftError;

    let contract;
    if (existingDraft) {
      status = "updated";
      const { data: updatedContract, error: updateContractError } = await supabase
        .from("assessment_contracts")
        .update({
          coach_id: coach.id,
          plan_snapshot: planSnapshot,
          start_date: startDate,
          end_date: endDate,
          original_end_date: endDate,
          payment_method: "pix_boleto",
          installments: 1,
          enrollment_fee: Number(plan.enrollment_fee) || 0,
          notes,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingDraft.id)
        .select("id, contract_number")
        .single();
      if (updateContractError) throw updateContractError;
      contract = updatedContract;
    } else {
      const { data: createdContract, error: createContractError } = await supabase
        .from("assessment_contracts")
        .insert({
          customer_id: customer.id,
          coach_id: coach.id,
          plan_id: plan.id,
          plan_snapshot: planSnapshot,
          status: "draft",
          payment_status: "pending",
          start_date: startDate,
          end_date: endDate,
          original_end_date: endDate,
          payment_method: "pix_boleto",
          installments: 1,
          enrollment_fee: Number(plan.enrollment_fee) || 0,
          auto_renewal: false,
          notes,
        })
        .select("id, contract_number")
        .single();
      if (createContractError) throw createContractError;
      contract = createdContract;
    }

    return json(req, {
      ok: true,
      status,
      prospect_id: customer.id,
      contract_id: contract.id,
      contract_number: contract.contract_number,
      customer_id: customer.id,
      message: "Pré-matrícula recebida no EON Store.",
    });
  } catch (e) {
    console.error("[public-assessment-prospect-test]", e);
    return json(req, { ok: false, error: "Erro ao registrar pré-matrícula." }, 500);
  }
});
