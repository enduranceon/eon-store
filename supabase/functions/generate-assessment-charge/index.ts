import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requireAdmin } from "../_shared/requireAdmin.ts";

// ✅ SEGURANÇA: sem fallback hardcoded.
const ASAAS_BASE    = Deno.env.get("ASAAS_BASE_URL");
const ASAAS_API_KEY = Deno.env.get("ASAAS_API_KEY");

const DEFAULT_DUE_DAYS = 7;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // 🔒 AUTHZ: só admin allowlistado
  const gate = await requireAdmin(req);
  if (!gate.ok) return jsonResponse({ error: "unauthorized" }, gate.status);

  // ✅ SEGURANÇA: aborta se envs não configuradas
  if (!ASAAS_BASE || !ASAAS_API_KEY) {
    console.error("generate-assessment-charge: ASAAS_BASE_URL ou ASAAS_API_KEY não configurados");
    return jsonResponse({ error: "server misconfigured" }, 500);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: "SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY não configurados" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const { contract_id, installments, cpf, billing_type, due_date } = await req.json();
    if (!contract_id) return jsonResponse({ error: "contract_id obrigatório" }, 400);

    const { data: contract, error: cErr } = await supabase
      .from("assessment_contracts")
      .select("*")
      .eq("id", contract_id)
      .single();
    if (cErr || !contract) return jsonResponse({ error: "Contrato não encontrado", details: cErr?.message }, 404);
    if (["cancelled", "voided", "finished", "draft"].includes(contract.status)) {
      return jsonResponse({ error: "Este contrato não aceita nova cobrança" }, 400);
    }
    if (["paid", "refunded", "cancelled"].includes(contract.payment_status)) {
      return jsonResponse({ error: "Este pagamento já está encerrado" }, 400);
    }

    const [planRes, studentRes] = await Promise.all([
      supabase.from("assessment_plans").select("*").eq("id", contract.plan_id).single(),
      supabase.from("presale_customers").select("*").eq("id", contract.customer_id).single(),
    ]);
    const plan    = planRes.data;
    const student = studentRes.data;
    if (!plan)    return jsonResponse({ error: "Plano não encontrado", details: planRes.error?.message }, 404);
    if (!student) return jsonResponse({ error: "Aluno não encontrado", details: studentRes.error?.message }, 404);

    const cleanCpf = (cpf || student.cpf || "").replace(/\D/g, "");
    if (cleanCpf.length < 11) {
      return jsonResponse({ error: "CPF do aluno obrigatório (11 dígitos)" }, 400);
    }

    const base       = Number(plan.price_total)        || 0;
    const enrollment = Number(contract.enrollment_fee) || 0;
    const discount   = Number(contract.manual_discount) || 0;
    const credit     = Number(contract.credit_balance) || 0;
    const totalValue = Math.max(0, base + enrollment - discount - credit);
    if (totalValue <= 0) {
      return jsonResponse({ error: "Valor zerado após descontos/créditos" }, 400);
    }

    const inst       = Math.max(1, Math.min(Number(installments) || contract.installments || 1, plan.max_installments || 1));
    const billing    = billing_type || "PIX";
    const cleanPhone = (student.whatsapp || "").replace(/\D/g, "");

    let asaasCustomerId: string | null = null;
    const searchRes  = await fetch(
      `${ASAAS_BASE}/customers?cpfCnpj=${cleanCpf}`,
      { headers: { access_token: ASAAS_API_KEY } },
    );
    const searchData = await searchRes.json();
    if (searchData?.data?.length > 0) {
      asaasCustomerId = searchData.data[0].id;
    } else {
      const createRes  = await fetch(`${ASAAS_BASE}/customers`, {
        method: "POST",
        headers: {
          access_token: ASAAS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name:    student.full_name,
          cpfCnpj: cleanCpf,
          email:   student.email || undefined,
          phone:   cleanPhone || undefined,
        }),
      });
      const createData = await createRes.json();
      if (!createRes.ok) {
        return jsonResponse({
          error: createData.errors?.[0]?.description || "Erro ao criar cliente Asaas",
          asaas_details: createData,
        }, 400);
      }
      asaasCustomerId = createData.id;
    }

    let dueDate: string;
    if (due_date && /^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
      dueDate = due_date;
    } else {
      const due = new Date();
      due.setDate(due.getDate() + DEFAULT_DUE_DAYS);
      const pad = (n: number) => String(n).padStart(2, "0");
      dueDate = `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}`;
    }

    const planLabel = (plan.name || "").trim() || `${plan.period_months || ""}m`;
    const paymentBody: Record<string, unknown> = {
      customer:          asaasCustomerId,
      billingType:       billing,
      value:             totalValue,
      dueDate,
      description:       `Contrato ${contract.contract_number} — ${planLabel}`,
      externalReference: contract.contract_number,
    };
    if (billing === "CREDIT_CARD" && inst > 1) {
      paymentBody.installmentCount = inst;
      paymentBody.installmentValue = Math.ceil((totalValue / inst) * 100) / 100;
    }

    const payRes  = await fetch(`${ASAAS_BASE}/payments`, {
      method: "POST",
      headers: {
        access_token: ASAAS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(paymentBody),
    });
    const payData = await payRes.json();
    if (!payRes.ok) {
      return jsonResponse({
        error: payData.errors?.[0]?.description || "Erro ao criar cobrança Asaas",
        asaas_details: payData,
      }, 400);
    }

    const chargeId    = payData.id;
    const paymentLink = payData.invoiceUrl || payData.bankSlipUrl || null;
    let pixQrCode: string | null = null;
    let pixCopy:   string | null = null;

    if (billing === "PIX") {
      const pixRes  = await fetch(
        `${ASAAS_BASE}/payments/${chargeId}/pixQrCode`,
        { headers: { access_token: ASAAS_API_KEY } },
      );
      const pixData = await pixRes.json();
      if (pixRes.ok) {
        pixQrCode = pixData.encodedImage || null;
        pixCopy   = pixData.payload      || null;
      }
    }

    const paymentMethod = billing === "CREDIT_CARD" ? `card_${inst}x`
                        : billing === "BOLETO"      ? "boleto"
                        : "pix";

    const { error: updErr } = await supabase
      .from("assessment_contracts")
      .update({
        asaas_charge_id:    chargeId,
        asaas_payment_link: paymentLink,
        asaas_pix_qrcode:   pixQrCode,
        asaas_pix_copy:     pixCopy,
        payment_method:     paymentMethod,
        payment_status:     "charge_sent",
        installments:       inst,
        due_date:           dueDate,
      })
      .eq("id", contract_id);
    if (updErr) {
      return jsonResponse({
        error: "Cobrança criada no Asaas mas falhou ao atualizar contrato: " + updErr.message,
        charge_id: chargeId,
      }, 500);
    }

    return jsonResponse({
      ok:           true,
      charge_id:    chargeId,
      payment_link: paymentLink,
      pix_copy:     pixCopy,
      due_date:     dueDate,
      total_value:  totalValue,
    });
  } catch (e) {
    return jsonResponse({ error: String((e as Error)?.message || e) }, 500);
  }
});
