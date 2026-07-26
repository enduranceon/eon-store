import { defaultPaymentDueDate } from '@/lib/payment-methods';
import { formatCurrency, formatDate, todayLocalStr, toLocalDateStr } from '@/lib/utils';
import { DEFAULT_COMMUNICATION_RULES } from '@/lib/communication-config';
import { buildAssessmentContractMessage } from '@/lib/assessment-contract-message';

export const COMMUNICATION_EVENT_TYPES = [
  'payment_message_sent',
  'onboarding_welcome_sent',
  'onboarding_checkin_sent',
  'renewal_message_sent',
  'communication_task_ignored',
];

export const TASK_KIND = {
  CHARGE_SEND: 'charge_send',
  CHARGE_OVERDUE: 'charge_overdue',
  ONBOARDING_WELCOME: 'onboarding_welcome',
  ONBOARDING_CHECKIN: 'onboarding_checkin',
  RENEWAL_REMINDER: 'renewal_reminder',
};

export const TASK_BUCKET = {
  CHARGES: 'charges',
  ONBOARDING: 'onboarding',
  RENEWAL: 'renewal',
};

const DAY_MS = 86400000;
const OPEN_PAYMENT_STATUSES = new Set(['pending', 'awaiting_charge', 'charge_sent', 'overdue', 'partially_paid']);
const TERMINAL_PAYMENT_STATUSES = new Set(['paid', 'cancelled', 'refunded']);
const CONTRACT_OPERATIONAL_STATUSES = new Set(['active', 'on_leave', 'overdue']);

function localDate(dateStr) {
  if (!dateStr) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))
    ? new Date(`${dateStr}T00:00:00`)
    : new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysBetween(dateStr, todayStr = todayLocalStr()) {
  const a = localDate(dateStr);
  const b = localDate(todayStr);
  if (!a || !b) return null;
  return Math.round((a - b) / DAY_MS);
}

function addDays(dateStr, days) {
  const d = localDate(dateStr);
  if (!d) return '';
  d.setDate(d.getDate() + days);
  return toLocalDateStr(d);
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'aluno(a)';
}

function periodLabel(plan) {
  if (!plan) return 'Plano';
  if (plan.name?.trim()) return plan.name.trim();
  const map = { mensal: 'Mensal', trimestral: 'Trimestral', semestral: 'Semestral', anual: 'Anual' };
  return map[plan.period] || `${plan.period_months || 1} meses`;
}

function variationLabel(variation) {
  if (!variation) return '';
  if (typeof variation === 'string') return variation.trim();
  return String(variation.name || variation.label || variation.size || variation.gender || '').trim();
}

function normalizeSaleItems(items = []) {
  if (!Array.isArray(items)) return [];
  return items
    .filter(item => item && !item.cancelled)
    .map((item, index) => {
      const quantity = Math.max(1, Number(item.quantity) || 1);
      const name = String(item.product_name || item.name || item.description || `Item ${index + 1}`).trim();
      const variation = variationLabel(item.variation || item.variation_name);
      const label = variation && !name.toLowerCase().includes(variation.toLowerCase())
        ? `${name} - ${variation}`
        : name;
      const unitPrice = Number(item.sale_price ?? item.unit_price ?? item.price ?? 0) || 0;
      const extrasTotal = Number(item.extras_total) || 0;
      const lineTotal = Math.max(0, (unitPrice + extrasTotal) * quantity);
      return { label, quantity, unitPrice, extrasTotal, lineTotal };
    })
    .filter(item => item.label);
}

function itemLines(items = []) {
  return items
    .map(item => {
      const total = item.lineTotal > 0 ? ` - ${formatCurrency(item.lineTotal)}` : '';
      return `- ${item.label} x${item.quantity || 1}${total}`;
    })
    .join('\n');
}

function itemSummary(items = []) {
  if (!items.length) return '';
  const first = items[0];
  const suffix = items.length > 1 ? ` +${items.length - 1}` : '';
  return `${first.label}${suffix}`;
}

function mapById(rows = []) {
  return new Map(rows.map(row => [row.id, row]));
}

function groupContractEvents(events = []) {
  return events.reduce((acc, ev) => {
    if (!ev.contract_id) return acc;
    if (!acc.has(ev.contract_id)) acc.set(ev.contract_id, []);
    acc.get(ev.contract_id).push(ev);
    return acc;
  }, new Map());
}

function groupSaleEvents(events = []) {
  return events.reduce((acc, ev) => {
    if (!ev.order_type || !ev.order_id) return acc;
    const sourceType = ev.order_type === 'stock' ? 'stock' : 'presale';
    const key = `${sourceType}:${ev.order_id}`;
    if (!acc.has(key)) acc.set(key, []);
    acc.get(key).push(ev);
    return acc;
  }, new Map());
}

function eventPayload(event = {}) {
  return { ...(event.metadata || {}), ...(event.payload || {}) };
}

function isFutureDate(dateStr, todayStr) {
  return Boolean(dateStr && String(dateStr) > todayStr);
}

// Uma regra fica resolvida quando existe histórico cujo payload/metadata
// referencia o mesmo slug. "Adiada" só resolve temporariamente antes da data
// escolhida; no dia agendado a etapa volta para a fila.
function ruleAlreadyHandled(events = [], rule, todayStr = todayLocalStr()) {
  if (!rule?.slug) return false;
  return events.some(ev => {
    const payload = eventPayload(ev);
    if ((payload.rule_slug || null) !== rule.slug) return false;
    if (payload.action === 'snoozed') return isFutureDate(payload.snooze_until, todayStr);
    return true;
  });
}

function latestEvent(events = [], eventType) {
  return events
    .filter(ev => ev.event_type === eventType)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0] || null;
}

function hasChargeInfo(row) {
  return Boolean(row?.asaas_charge_id || row?.asaas_payment_link || row?.asaas_pix_copy || row?.external_payment_link);
}

function activeRulesByKind(rules = DEFAULT_COMMUNICATION_RULES) {
  return rules
    .filter(rule => rule.active !== false)
    .sort((a, b) => (Number(a.order_index) || 0) - (Number(b.order_index) || 0))
    .reduce((acc, rule) => {
      if (!acc[rule.task_kind]) acc[rule.task_kind] = [];
      acc[rule.task_kind].push(rule);
      return acc;
    }, {});
}

function withRule(rule, extra = {}) {
  return {
    ruleId: rule?.id || null,
    ruleSlug: rule?.slug || null,
    ruleName: rule?.name || null,
    triggerEvent: rule?.trigger_event || null,
    daysOffset: Number(rule?.days_offset) || 0,
    messageTemplate: rule?.message_template || '',
    ...extra,
  };
}

function isDueByOffset(baseDate, offset, todayStr) {
  const scheduled = addDays(baseDate, Number(offset) || 0);
  return Boolean(scheduled && scheduled <= todayStr);
}

function normalizePresale(order) {
  const items = normalizeSaleItems(order.items);
  return {
    sourceType: 'presale',
    tableName: 'presale_orders',
    sourceLabel: 'Pedido',
    sourceId: order.id,
    orderNumber: order.order_number,
    customerName: order.checkout_name,
    customerWhatsapp: order.checkout_whatsapp,
    totalValue: Number(order.total_value) || 0,
    paymentStatus: order.payment_status || 'awaiting_charge',
    dueDate: order.due_date || '',
    paymentDate: order.payment_date || '',
    asaasChargeId: order.asaas_charge_id,
    asaasPaymentLink: order.asaas_payment_link,
    asaasPixCopy: order.asaas_pix_copy,
    externalPaymentLink: order.external_payment_link,
    paymentMessageSentAt: order.payment_message_sent_at,
    items,
    itemSummary: itemSummary(items),
    href: `/pedidos/${order.id}`,
    createdAt: order.created_date,
  };
}

function normalizeStock(order) {
  const items = normalizeSaleItems(order.items);
  return {
    sourceType: 'stock',
    tableName: 'stock_orders',
    sourceLabel: 'Pedido estoque',
    sourceId: order.id,
    orderNumber: order.order_number,
    customerName: order.customer_name,
    customerWhatsapp: order.customer_whatsapp,
    totalValue: Number(order.total_value) || 0,
    paymentStatus: order.payment_status || 'awaiting_charge',
    dueDate: order.due_date || '',
    paymentDate: order.payment_date || '',
    asaasChargeId: order.asaas_charge_id,
    asaasPaymentLink: order.asaas_payment_link,
    asaasPixCopy: order.asaas_pix_copy,
    externalPaymentLink: order.external_payment_link,
    paymentMessageSentAt: order.payment_message_sent_at,
    items,
    itemSummary: itemSummary(items),
    href: `/estoque/pedidos/${order.id}`,
    createdAt: order.created_date,
  };
}

function normalizeContract(contract, maps) {
  const customer = maps.customers.get(contract.customer_id) || {};
  const plan = maps.plans.get(contract.plan_id) || {};
  const modality = maps.modalities.get(plan.modality_id || contract.plan_snapshot?.modality_id) || {};
  const coach = maps.coaches.get(contract.coach_id) || {};
  const planSnapshot = contract.plan_snapshot || {};
  const baseValue = Number(planSnapshot.price_total ?? plan.price_total ?? 0);
  const enrollment = Number(contract.enrollment_fee) || 0;
  const discount = Number(contract.manual_discount) || 0;
  const renewalDiscount = contract.discount_recurring ? discount : 0;
  const credit = Number(contract.credit_balance) || 0;
  const totalValue = Math.max(0, baseValue + enrollment - discount - credit);
  const renewalTotalValue = Math.max(0, baseValue - renewalDiscount);
  const planLabel = periodLabel(planSnapshot.name ? planSnapshot : plan);
  const contractItemLabel = [planLabel, modality.name || planSnapshot.modality_name].filter(Boolean).join(' - ');
  const items = normalizeSaleItems([{ product_name: contractItemLabel || 'Contrato', quantity: 1, sale_price: totalValue }]);
  const renewalItems = normalizeSaleItems([{ product_name: contractItemLabel || 'Contrato', quantity: 1, sale_price: renewalTotalValue }]);

  return {
    sourceType: 'contract',
    tableName: 'assessment_contracts',
    sourceLabel: 'Contrato',
    sourceId: contract.id,
    orderNumber: contract.contract_number,
    customerName: customer.full_name,
    customerWhatsapp: customer.whatsapp,
    customerEmail: customer.email,
    totalValue,
    paymentStatus: contract.payment_status || 'pending',
    contractStatus: contract.status,
    dueDate: contract.due_date || '',
    paymentDate: contract.payment_date || '',
    startDate: contract.start_date || '',
    endDate: contract.end_date || '',
    asaasChargeId: contract.asaas_charge_id,
    asaasPaymentLink: contract.asaas_payment_link,
    asaasPixCopy: contract.asaas_pix_copy,
    externalPaymentLink: contract.external_payment_link,
    paymentMessageSentAt: contract.payment_message_sent_at,
    parentContractId: contract.parent_contract_id,
    plan,
    planSnapshot,
    planLabel,
    modalityName: modality.name || planSnapshot.modality_name || '',
    coachName: coach.name || '',
    items,
    itemSummary: itemSummary(items),
    renewalTotalValue,
    renewalItems,
    renewalItemSummary: itemSummary(renewalItems),
    href: `/assessoria/contratos/${contract.id}`,
    createdAt: contract.created_at,
  };
}

function baseTask(kind, bucket, sale, extra = {}) {
  return {
    id: `${extra.ruleSlug || kind}:${sale.sourceType}:${sale.sourceId}`,
    kind,
    bucket,
    sourceType: sale.sourceType,
    tableName: sale.tableName,
    sourceId: sale.sourceId,
    sourceLabel: sale.sourceLabel,
    orderNumber: sale.orderNumber,
    customerName: sale.customerName || 'Cliente',
    customerWhatsapp: sale.customerWhatsapp || '',
    totalValue: sale.totalValue || 0,
    paymentStatus: sale.paymentStatus,
    dueDate: sale.dueDate || '',
    paymentDate: sale.paymentDate || '',
    asaasChargeId: sale.asaasChargeId,
    asaasPaymentLink: sale.asaasPaymentLink,
    asaasPixCopy: sale.asaasPixCopy,
    externalPaymentLink: sale.externalPaymentLink,
    items: sale.items || [],
    itemSummary: sale.itemSummary || '',
    href: sale.href,
    createdAt: sale.createdAt,
    ...extra,
  };
}

// Uma etapa de cobrança vencida conta como tratada se QUALQUER mensagem de cobrança
// foi registrada depois que a etapa disparou — independente da tela de origem
// (Central, Vendas em aberto, detalhe do pedido/contrato). Sem isso, enviar por
// outra tela deixava a etapa "pendente" na fila e induzia cobrança duplicada.
function chargeMessageSentSince(sale, events, triggerDate) {
  if (!triggerDate) return false;
  if (sale.paymentMessageSentAt && toLocalDateStr(sale.paymentMessageSentAt) >= triggerDate) return true;
  return events.some(ev => {
    const isChargeMessage =
      ev.event_type === 'payment_message_sent' ||
      ev.new_status === 'charge_sent' ||
      ['charge_sent', 'charge_resent'].includes(eventPayload(ev).action);
    if (!isChargeMessage) return false;
    const sentDate = toLocalDateStr(ev.created_at);
    return Boolean(sentDate && sentDate >= triggerDate);
  });
}

function buildChargeTasks(sale, todayStr, { sendRule, overdueRules = [] }, events = []) {
  if (TERMINAL_PAYMENT_STATUSES.has(sale.paymentStatus)) return [];
  if (!OPEN_PAYMENT_STATUSES.has(sale.paymentStatus)) return [];

  const dueDelta = daysBetween(sale.dueDate, todayStr);
  const chargeEvidence = hasChargeInfo(sale) || Boolean(sale.paymentMessageSentAt);

  if (sale.dueDate && chargeEvidence) {
    const dueOverdueRules = overdueRules
      .filter(rule => {
        const offset = Math.max(0, Number(rule.days_offset) || 0);
        return dueDelta <= -offset
          && !ruleAlreadyHandled(events, rule, todayStr)
          && !chargeMessageSentSince(sale, events, addDays(sale.dueDate, offset));
      })
      .sort((a, b) => (Number(a.days_offset) || 0) - (Number(b.days_offset) || 0));

    const overdueRule = dueOverdueRules[0];
    if (overdueRule) {
      return [baseTask(TASK_KIND.CHARGE_OVERDUE, TASK_BUCKET.CHARGES, sale, withRule(overdueRule, {
        title: overdueRule.name || 'Reenviar cobrança vencida',
        statusLabel: `${Math.abs(dueDelta)} dia${Math.abs(dueDelta) === 1 ? '' : 's'} em atraso`,
        scheduledDate: sale.dueDate,
        sortDate: addDays(sale.dueDate, overdueRule.days_offset),
        priority: 10,
        needsPaymentLink: !sale.asaasPaymentLink && !sale.asaasPixCopy,
      }))];
    }
  }

  if (
    sendRule
    && !ruleAlreadyHandled(events, sendRule, todayStr)
    && !sale.paymentMessageSentAt
    && ['awaiting_charge', 'pending'].includes(sale.paymentStatus)
  ) {
    const scheduled = sale.dueDate || defaultPaymentDueDate();
    return [baseTask(TASK_KIND.CHARGE_SEND, TASK_BUCKET.CHARGES, sale, withRule(sendRule, {
      title: 'Enviar cobrança',
      statusLabel: sale.dueDate ? `vence em ${formatDate(sale.dueDate)}` : 'definir vencimento',
      scheduledDate: scheduled,
      sortDate: scheduled,
      priority: 20,
      needsPaymentLink: !sale.asaasPaymentLink && !sale.asaasPixCopy,
    }))];
  }

  return [];
}

function buildWelcomeTask(contractSale, events, todayStr, rule) {
  if (!rule) return null;
  if (contractSale.sourceType !== 'contract') return null;
  if (contractSale.paymentStatus !== 'paid') return null;
  if (contractSale.parentContractId) return null;
  if (!CONTRACT_OPERATIONAL_STATUSES.has(contractSale.contractStatus)) return null;
  if (ruleAlreadyHandled(events, rule, todayStr)) return null;
  const baseDate = contractSale.paymentDate || toLocalDateStr(contractSale.createdAt) || todayLocalStr();
  if (!isDueByOffset(baseDate, rule.days_offset, todayStr)) return null;

  const scheduled = addDays(baseDate, rule.days_offset);
  return baseTask(TASK_KIND.ONBOARDING_WELCOME, TASK_BUCKET.ONBOARDING, contractSale, withRule(rule, {
    title: rule.name || 'Enviar boas-vindas',
    statusLabel: contractSale.paymentDate ? `pagou em ${formatDate(contractSale.paymentDate)}` : 'pagamento confirmado',
    scheduledDate: scheduled,
    sortDate: scheduled,
    priority: 30,
    planLabel: contractSale.planLabel,
    modalityName: contractSale.modalityName,
    coachName: contractSale.coachName,
    endDate: contractSale.endDate,
  }));
}

function buildCheckinTask(contractSale, events, todayStr, rule) {
  if (!rule) return null;
  if (contractSale.sourceType !== 'contract') return null;
  if (contractSale.parentContractId) return null;
  if (!CONTRACT_OPERATIONAL_STATUSES.has(contractSale.contractStatus)) return null;
  if (ruleAlreadyHandled(events, rule, todayStr)) return null;
  const welcome = latestEvent(events, 'onboarding_welcome_sent');
  if (!welcome?.created_at) return null;
  const dueDate = addDays(toLocalDateStr(welcome.created_at), rule.days_offset);
  if (!dueDate || dueDate > todayStr) return null;

  return baseTask(TASK_KIND.ONBOARDING_CHECKIN, TASK_BUCKET.ONBOARDING, contractSale, withRule(rule, {
    title: rule.name || 'Check-in inicial',
    statusLabel: `boas-vindas em ${formatDate(welcome.created_at)}`,
    scheduledDate: dueDate,
    sortDate: dueDate,
    priority: 40,
    planLabel: contractSale.planLabel,
    modalityName: contractSale.modalityName,
    coachName: contractSale.coachName,
  }));
}

function buildRenewalTask(contractSale, events, todayStr, rule) {
  if (!rule) return null;
  if (contractSale.sourceType !== 'contract') return null;
  if (contractSale.paymentStatus !== 'paid') return null;
  if (!CONTRACT_OPERATIONAL_STATUSES.has(contractSale.contractStatus)) return null;
  if (ruleAlreadyHandled(events, rule, todayStr)) return null;
  const daysToEnd = daysBetween(contractSale.endDate, todayStr);
  const windowDays = Math.abs(Number(rule.days_offset) || 0);
  if (daysToEnd === null || daysToEnd < 0 || daysToEnd > windowDays) return null;

  return baseTask(TASK_KIND.RENEWAL_REMINDER, TASK_BUCKET.RENEWAL, contractSale, withRule(rule, {
    title: rule.name || 'Renovação próxima',
    statusLabel: daysToEnd === 0 ? 'vence hoje' : `vence em ${daysToEnd} dia${daysToEnd === 1 ? '' : 's'}`,
    scheduledDate: contractSale.endDate,
    sortDate: contractSale.endDate,
    priority: 50,
    totalValue: contractSale.renewalTotalValue,
    items: contractSale.renewalItems,
    itemSummary: contractSale.renewalItemSummary,
    planLabel: contractSale.planLabel,
    modalityName: contractSale.modalityName,
    coachName: contractSale.coachName,
    endDate: contractSale.endDate,
  }));
}

export function buildCommunicationTasks(data, options = {}) {
  const todayStr = options.todayStr || todayLocalStr();
  const rulesByKind = activeRulesByKind(options.rules || data.communicationRules || DEFAULT_COMMUNICATION_RULES);
  // Cobrança usa a regra primária (um pedido tem um único estado de pagamento);
  // onboarding e renovação suportam múltiplas regras convivendo.
  const chargeRules = {
    sendRule: (rulesByKind[TASK_KIND.CHARGE_SEND] || [])[0],
    overdueRules: rulesByKind[TASK_KIND.CHARGE_OVERDUE] || [],
  };
  const welcomeRules = rulesByKind[TASK_KIND.ONBOARDING_WELCOME] || [];
  const checkinRules = rulesByKind[TASK_KIND.ONBOARDING_CHECKIN] || [];
  const renewalRules = rulesByKind[TASK_KIND.RENEWAL_REMINDER] || [];
  const maps = {
    customers: mapById(data.customers || []),
    plans: mapById(data.plans || []),
    modalities: mapById(data.modalities || []),
    coaches: mapById(data.coaches || []),
  };
  const eventsByContract = groupContractEvents(data.contractEvents || []);
  const eventsBySale = groupSaleEvents(data.saleEvents || []);
  const presaleSales = (data.presaleOrders || []).map(normalizePresale);
  const stockSales = (data.stockOrders || []).map(normalizeStock);
  const contractSales = (data.contracts || []).map(contract => normalizeContract(contract, maps));
  const tasks = [];

  [...presaleSales, ...stockSales, ...contractSales].forEach(sale => {
    const events = sale.sourceType === 'contract'
      ? eventsByContract.get(sale.sourceId) || []
      : eventsBySale.get(`${sale.sourceType}:${sale.sourceId}`) || [];
    buildChargeTasks(sale, todayStr, chargeRules, events).forEach(task => tasks.push(task));
  });

  contractSales.forEach(contractSale => {
    const events = eventsByContract.get(contractSale.sourceId) || [];
    welcomeRules.forEach(rule => { const t = buildWelcomeTask(contractSale, events, todayStr, rule); if (t) tasks.push(t); });
    checkinRules.forEach(rule => { const t = buildCheckinTask(contractSale, events, todayStr, rule); if (t) tasks.push(t); });
    renewalRules.forEach(rule => { const t = buildRenewalTask(contractSale, events, todayStr, rule); if (t) tasks.push(t); });
  });

  return tasks.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return String(a.sortDate || '').localeCompare(String(b.sortDate || ''));
  });
}

function paymentLinkFor(task, externalLink = task.externalPaymentLink) {
  return task.asaasPaymentLink || String(externalLink || '').trim();
}

function renderCommunicationTemplate(template, task, options = {}) {
  if (!template) return '';
  const externalLink = options.externalLink ?? task.externalPaymentLink;
  const dueDate = options.dueDate ?? task.dueDate;
  const communityLink = String(options.communityLink || '').trim();
  const paymentLink = paymentLinkFor(task, externalLink);
  const pixCopy = task.asaasPixCopy;
  const saleType = task.sourceType === 'contract' ? 'contrato' : 'pedido';
  const due = dueDate ? formatDate(dueDate) : '';
  const daysToEnd = task.endDate ? daysBetween(task.endDate, todayLocalStr()) : null;
  const items = task.items || [];
  const itemsText = itemLines(items);
  const values = {
    '{nome}': firstName(task.customerName),
    '{nome_completo}': task.customerName || '',
    '{tipo}': saleType,
    '{numero}': task.orderNumber || '',
    '{valor}': formatCurrency(task.totalValue || 0),
    '{item}': task.itemSummary || items[0]?.label || '',
    '{itens}': itemsText,
    '{itens_bloco}': itemsText ? `Itens:\n${itemsText}\n\n` : '',
    '{vencimento}': due,
    '{vencimento_texto}': due ? `, com vencimento em *${due}*` : '',
    '{vencimento_atraso}': due ? ` em *${due}*` : '',
    '{link_pagamento}': paymentLink,
    '{link_bloco}': paymentLink ? `Link de pagamento:\n${paymentLink}\n\n` : '',
    '{pix_copia_cola}': pixCopy || '',
    '{pix_bloco}': pixCopy ? `PIX Copia e Cola:\n\`${pixCopy}\`\n\n` : '',
    '{plano}': task.planLabel || '',
    '{modalidade}': task.modalityName || '',
    '{coach}': task.coachName || 'a definir',
    '{comunidade}': communityLink || '(link da comunidade nao configurado)',
    '{data_fim}': task.endDate ? formatDate(task.endDate) : '',
    '{dias}': daysToEnd == null ? '' : String(daysToEnd),
  };

  return Object.entries(values).reduce(
    (msg, [key, value]) => msg.replaceAll(key, value),
    template
  ).trim();
}

export function buildTaskMessage(task, options = {}) {
  if (!task) return '';
  const externalLink = options.externalLink ?? task.externalPaymentLink;
  const dueDate = options.dueDate ?? task.dueDate;
  const communityLink = String(options.communityLink || '').trim();

  if (task.messageVariant === 'assessment_contract_confirmation') {
    return buildAssessmentContractMessage({
      contract: {
        parent_contract_id: task.parentContractId,
        start_date: task.startDate,
        end_date: task.endDate,
        due_date: dueDate,
        installments: task.installments,
        enrollment_fee: task.enrollmentFee,
        manual_discount: task.manualDiscount,
        credit_balance: task.creditBalance,
        asaas_pix_copy: task.asaasPixCopy,
        asaas_payment_link: task.asaasPaymentLink,
        external_payment_link: task.externalPaymentLink,
        plan_snapshot: {
          name: task.planLabel,
          period: task.planPeriod,
          period_months: task.periodMonths,
          price_total: task.totalValue,
          modality_name: task.modalityName,
        },
      },
      customer: { full_name: task.customerName },
      modality: { name: task.modalityName },
      coach: { name: task.coachName },
      totalValue: task.totalValue,
      externalLink,
      dueDate,
    });
  }

  const configuredMessage = renderCommunicationTemplate(task.messageTemplate, task, options);
  if (configuredMessage) return configuredMessage;

  const paymentLink = paymentLinkFor(task, externalLink);
  const pixCopy = task.asaasPixCopy;
  const name = firstName(task.customerName);
  const itemsText = itemLines(task.items || []);

  if (task.kind === TASK_KIND.CHARGE_OVERDUE) {
    // Lembrete de cobrança vencida — mensagem direta (sem número de contrato nem lista de itens)
    const due = dueDate ? formatDate(dueDate) : '';
    let msg = `Oi, ${name}!\n\n`;
    msg += `Passando pra lembrar da cobrança de *${formatCurrency(task.totalValue)}* que venceu${due ? ` em *${due}*` : ''}.\n\n`;
    if (paymentLink) msg += `Link de pagamento:\n${paymentLink}\n\n`;
    else if (pixCopy) msg += `PIX Copia e Cola:\n\`${pixCopy}\`\n\n`;
    msg += 'Se já tiver pago, é só desconsiderar. Qualquer dúvida, me chama aqui!';
    return msg;
  }

  if (task.kind === TASK_KIND.CHARGE_SEND) {
    const saleType = task.sourceType === 'contract' ? 'contrato' : 'pedido';
    const due = dueDate ? formatDate(dueDate) : '';
    let msg = `Olá, ${name}! Tudo bem?\n\n`;
    msg += `Segue a cobrança do seu ${saleType} *${task.orderNumber}*, no valor de *${formatCurrency(task.totalValue)}*${due ? `, com vencimento em *${due}*` : ''}.\n\n`;
    if (itemsText) msg += `Itens:\n${itemsText}\n\n`;
    if (pixCopy) msg += `PIX Copia e Cola:\n\`${pixCopy}\`\n\n`;
    if (paymentLink) msg += `Link de pagamento:\n${paymentLink}\n\n`;
    msg += 'Se o pagamento já foi realizado, pode desconsiderar esta mensagem. Qualquer dúvida, estou por aqui.';
    return msg;
  }

  if (task.kind === TASK_KIND.ONBOARDING_WELCOME) {
    let msg = `Olá, ${name}! Tudo certo?\n\n`;
    msg += 'Pagamento confirmado. Seja bem-vindo(a) à Assessoria Esportiva Endurance ON.\n\n';
    if (task.modalityName) msg += `Modalidade: *${task.modalityName}*\n`;
    if (task.planLabel) msg += `Plano: *${task.planLabel}*\n`;
    if (task.coachName) msg += `Coach: *${task.coachName}*\n`;
    if (communityLink) msg += `\nComunidade Endurance ON:\n${communityLink}\n`;
    msg += '\nNos próximos passos, o time vai alinhar seu início e acompanhar sua adaptação. Qualquer dúvida, me chama por aqui.';
    return msg;
  }

  if (task.kind === TASK_KIND.ONBOARDING_CHECKIN) {
    return (
      `Olá, ${name}! Tudo bem?\n\n` +
      'Passando para saber se deu tudo certo nesses primeiros dias e se o treinador já entrou em contato com você.\n\n' +
      'Se ficou alguma dúvida para começar ou se precisar de qualquer ajuste, me chama por aqui.'
    );
  }

  if (task.kind === TASK_KIND.RENEWAL_REMINDER) {
    const due = task.endDate ? formatDate(task.endDate) : '';
    let msg = `Olá, ${name}! Tudo bem?\n\n`;
    msg += `Seu acompanhamento na Endurance ON${task.planLabel ? ` pelo plano *${task.planLabel}*` : ''} está chegando perto do vencimento${due ? ` em *${due}*` : ''}.\n\n`;
    msg += 'Quero deixar sua continuidade organizada para você não interromper o acompanhamento. Posso te enviar as opções de renovação?';
    return msg;
  }

  return '';
}

export function taskEventType(task) {
  if (!task) return null;
  if (task.kind === TASK_KIND.ONBOARDING_WELCOME) return 'onboarding_welcome_sent';
  if (task.kind === TASK_KIND.ONBOARDING_CHECKIN) return 'onboarding_checkin_sent';
  if (task.kind === TASK_KIND.RENEWAL_REMINDER) return 'renewal_message_sent';
  return 'payment_message_sent';
}

export function taskChannelLabel(task) {
  if (!task) return '';
  if (task.bucket === TASK_BUCKET.CHARGES) return 'Cobrança';
  if (task.bucket === TASK_BUCKET.ONBOARDING) return 'Onboarding';
  if (task.bucket === TASK_BUCKET.RENEWAL) return 'Renovação';
  return 'Comunicação';
}

// Metadados dos eventos de comunicação para exibição em históricos (perfil do aluno).
export const COMMUNICATION_EVENT_META = {
  payment_message_sent:       { label: 'Cobrança enviada', tone: 'info' },
  onboarding_welcome_sent:    { label: 'Boas-vindas',      tone: 'success' },
  onboarding_checkin_sent:    { label: 'Check-in',         tone: 'success' },
  renewal_message_sent:       { label: 'Renovação',        tone: 'purple' },
  communication_task_ignored: { label: 'Ignorada',         tone: 'secondary' },
};

const CHANNEL_LABEL = { whatsapp: 'WhatsApp', email: 'E-mail' };

// Resumo curto de um evento de comunicação a partir do payload, tolerante a
// eventos antigos (gerados na tela do contrato) e novos (Central de Comunicação).
export function summarizeCommunicationEvent(event) {
  const p = eventPayload(event);
  const channel = CHANNEL_LABEL[p.channel || p.via] || '';
  const parts = [];
  if (channel) parts.push(`via ${channel}`);
  if (p.rule_name) parts.push(p.rule_name);
  if (p.action === 'snoozed' && p.snooze_until) parts.push(`adiada para ${formatDate(p.snooze_until)}`);
  if (p.reason) parts.push(p.reason);
  return parts.join(' · ');
}
