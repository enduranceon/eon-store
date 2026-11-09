// Vendas em aberto de todas as áreas (loja, pré-venda, assessoria e eventos),
// montadas como a página Cobranças as mostra. A Visão geral usa a mesma fonte
// para que o total vencido bata com a lista.
//
// Contrato com carnê de boleto/PIX parcelado: o saldo está nas parcelas; cada
// parcela sem registro é uma linha e a linha do contrato fica só para
// identificar os recebimentos (`carne`), fora da lista de cobrança.

import { fetchAllPages } from './fetch-all-pages.js';
import { buildContractLifecycleRows } from './assessment-contract-lifecycle.js';
import { isBillableProspectOpenSale, isOpenCollectionSale } from './sales.js';
import { attachCarneToContracts, carneParcelRows } from './carne-open-sales.js';

// `client` é o cliente do Supabase (RLS de administrador).
export async function loadOpenSalesOrders(client) {
  const supabase = client;
  const [presaleRes, stockRes, contractRes, plansRes, customersRes, eventRegsRes, eventTypesRes, eventsRes, parcelsRes] = await Promise.all([
    supabase.from('presale_orders')
      .select('id, order_number, checkout_name, checkout_whatsapp, customer_whatsapp, total_value, payment_status, payment_date, due_date, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, external_invoice_number, payment_message_sent_at, payment_method, items')
      .neq('payment_status', 'cancelled').neq('payment_status', 'refunded'),
    supabase.from('stock_orders')
      .select('id, order_number, customer_name, customer_whatsapp, total_value, payment_status, payment_date, due_date, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, external_invoice_number, payment_message_sent_at, payment_method, items')
      .neq('payment_status', 'cancelled').neq('payment_status', 'refunded'),
    fetchAllPages(() => supabase.from('assessment_contracts')
      .select('id, contract_number, customer_id, plan_id, payment_status, payment_date, manual_payment, due_date, start_date, end_date, created_at, updated_at, parent_contract_id, cancellation_date, cancellation_fee, cancellation_reason, refund_status, refund_amount, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, external_invoice_number, payment_message_sent_at, payment_method, enrollment_fee, manual_discount, credit_balance, status, installments, plan_snapshot, prospect_stage')
      .not('status', 'in', '("cancelled","voided")').neq('payment_status', 'refunded')
      .order('id', { ascending: true })),
    supabase.from('assessment_plans').select('id, price_total, price_monthly, name, revenue_center_id'),
    supabase.from('presale_customers').select('id, full_name, whatsapp, email, cpf'),
    supabase.from('event_registrations')
      .select('id, registration_number, event_id, registration_type_id, customer_id, coach_id, payment_status, payment_method, payment_date, due_date, manual_payment, asaas_charge_id, asaas_payment_link, asaas_pix_copy, external_payment_link, external_invoice_number, payment_message_sent_at, customer_link_confirmed_at, customer_link_confirmed_by, created_at, updated_at')
      .neq('payment_status', 'cancelled')
      .neq('payment_status', 'refunded'),
    supabase.from('event_registration_types').select('id, event_id, name, price'),
    supabase.from('events').select('id, name, revenue_center_id, status'),
    // Parcelas do carnê de boleto/PIX parcelado: cada uma em aberto vira uma venda em aberto.
    supabase.from('assessment_contract_parcels')
      .select('id, contract_id, installment_number, total_installments, value, due_date, asaas_status, invoice_url, payment_row_id'),
  ]);
  for (const result of [presaleRes, stockRes, contractRes, plansRes, customersRes, eventRegsRes, eventTypesRes, eventsRes, parcelsRes]) {
    if (result.error) throw result.error;
  }

  const plansMap         = Object.fromEntries((plansRes.data         || []).map(p => [p.id, p]));
  const customersMap     = Object.fromEntries((customersRes.data     || []).map(c => [c.id, c]));
  const eventTypesMap    = Object.fromEntries((eventTypesRes.data    || []).map(t => [t.id, t]));
  const eventsMap        = Object.fromEntries((eventsRes.data        || []).map(e => [e.id, e]));

  const presale   = (presaleRes.data   || []).map(o => ({
    ...o,
    type: 'presale',
    customer: o.checkout_name,
    customer_whatsapp: o.checkout_whatsapp || o.customer_whatsapp || null,
  }));
  const stock     = (stockRes.data     || []).map(o => ({ ...o, type: 'stock',    customer: o.customer_name }));
  const contractRows = contractRes.data || [];
  const contracts = buildContractLifecycleRows(contractRows, { plansById: plansMap })
    .filter(c => {
      if (c.lifecycle?.type === 'voided_sale') return false;
      if (c.lifecycle?.type === 'pending_sale') return isBillableProspectOpenSale(c);
      return (
        c.lifecycle?.counts?.active ||
        c.payment_status === 'paid' ||
        isOpenCollectionSale(c)
      );
    })
    .map(c => {
      return {
        id: c.id, order_number: c.contract_number, customer_id: c.customer_id,
        customer: customersMap[c.customer_id]?.full_name || '—',
        customer_whatsapp: customersMap[c.customer_id]?.whatsapp || null,
        total_value: Number(c.value) || 0,
        payment_status: c.payment_status,
        payment_method: c.payment_method,
        payment_date: c.payment_date, due_date: c.due_date,
        asaas_charge_id: c.asaas_charge_id,
        asaas_payment_link: c.asaas_payment_link,
        asaas_pix_copy: c.asaas_pix_copy,
        external_payment_link: c.external_payment_link,
        external_invoice_number: c.external_invoice_number,
        payment_message_sent_at: c.payment_message_sent_at,
        updated_at: c.updated_at,
        status: c.status,
        parent_contract_id: c.parent_contract_id,
        prospect_stage: c.prospect_stage,
        is_prospect: isBillableProspectOpenSale(c),
        type: 'contract',
        installments: c.installments || 1,
      };
    });
  const eventOrders = (eventRegsRes.data || [])
    .map(reg => {
      const type = eventTypesMap[reg.registration_type_id] || {};
      const eventRecord = eventsMap[reg.event_id] || {};
      const customer = customersMap[reg.customer_id] || {};
      const value = Number(type.price) || 0;
      return {
        id: reg.id,
        order_number: reg.registration_number,
        customer: customer.full_name || 'Cliente',
        customer_whatsapp: customer.whatsapp || null,
        customer_email: customer.email || null,
        customer_cpf: customer.cpf || null,
        total_value: value,
        payment_status: reg.payment_status,
        payment_method: reg.payment_method,
        payment_date: reg.payment_date,
        due_date: reg.due_date,
        asaas_charge_id: reg.asaas_charge_id,
        asaas_payment_link: reg.asaas_payment_link,
        asaas_pix_copy: reg.asaas_pix_copy,
        external_payment_link: reg.external_payment_link,
        payment_message_sent_at: reg.payment_message_sent_at,
        updated_at: reg.updated_at,
        created_at: reg.created_at,
        type: 'event',
        event_id: reg.event_id,
        event_name: eventRecord.name || 'Evento',
        registration_type_name: type.name || 'Inscrição',
        customer_link_confirmed_at: reg.customer_link_confirmed_at || null,
        items: [{
          name: [eventRecord.name, type.name].filter(Boolean).join(' - ') || 'Inscrição de evento',
          quantity: 1,
          sale_price: value,
        }],
      };
    })
    .filter(o => o.total_value > 0);

  // Contrato com carnê: o saldo está nas parcelas, uma linha por parcela em aberto.
  // A linha do contrato fica (identifica os recebimentos), fora da lista de cobrança.
  const contractsWithCarne = attachCarneToContracts(contracts, parcelsRes.data || []);
  const carneRows = contractsWithCarne.flatMap(carneParcelRows);
  return [...presale, ...stock, ...contractsWithCarne, ...carneRows, ...eventOrders];
}

// Lista de cobrança: vendas abertas e sem recebimento registrado. A linha de uma
// parcela de carnê vale mesmo que o contrato já tenha recebimento.
export function selectActiveOpenOrders(orders, receiptOrderIds = new Set()) {
  return (orders || []).filter(order =>
    isOpenCollectionSale(order)
    && !order.carne
    && (order.is_carne_parcel || !receiptOrderIds.has(order.id)));
}
