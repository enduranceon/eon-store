import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ASAAS_BASE = Deno.env.get("ASAAS_BASE_URL") ?? "https://sandbox.asaas.com/api/v3";
const ASAAS_API_KEY = Deno.env.get("ASAAS_API_KEY");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  try {
    if (!ASAAS_API_KEY) {
      return json({ error: "ASAAS_API_KEY não configurada" }, 500);
    }

    // Busca cobranças que ainda vão gerar receita (PENDING, CONFIRMED, OVERDUE)
    // PENDING:   aguardando pagamento
    // CONFIRMED: cartão autorizado, será creditado em D+30
    // OVERDUE:   vencido sem pagar
    const statuses = ["PENDING", "CONFIRMED", "OVERDUE"];
    const allPayments: any[] = [];
    let totalFetched = 0;

    for (const status of statuses) {
      let offset = 0;
      const limit = 100;
      let hasMore = true;

      while (hasMore && offset < 500) {
        const url = `${ASAAS_BASE}/payments?status=${status}&limit=${limit}&offset=${offset}&order=dueDate&sort=asc`;
        const res = await fetch(url, { headers: { access_token: ASAAS_API_KEY } });
        const data = await res.json();

        if (!res.ok) {
          return json({
            error: `Erro ao buscar cobranças ${status} no Asaas`,
            asaas_details: data,
          }, 500);
        }

        const items = data.data || [];
        allPayments.push(...items);
        totalFetched += items.length;
        hasMore = data.hasMore === true && items.length === limit;
        offset += limit;
      }
    }

    // Retorna lista enxuta (sem campos que não usamos)
    const slim = allPayments.map((p: any) => ({
      id:                p.id,
      customer:          p.customer,
      value:             Number(p.value) || 0,
      netValue:          Number(p.netValue) || Number(p.value) || 0,
      status:            p.status,
      billingType:       p.billingType,
      dueDate:           p.dueDate,
      paymentDate:       p.paymentDate || null,
      creditDate:        p.creditDate  || null,
      installment:       p.installment || null,
      installmentNumber: p.installmentNumber || null,
      description:       p.description || null,
      externalReference: p.externalReference || null,
    }));

    return json({
      ok:       true,
      count:    slim.length,
      payments: slim,
      fetched_at: new Date().toISOString(),
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
