// Conferência das cobranças externas no Asaas. O servidor só lê o Asaas e
// devolve os fatos (status, forma, valor e datas); aqui decidimos o que já dá
// para registrar, o que precisa de conferência e o que segue em aberto. O
// registro é o pagamento manual de sempre (mesma forma, data e valor do
// "Receber"), com as parcelas no valor e na data de crédito do Asaas.

const INVOICE_LINK = /^https:\/\/www\.asaas\.com\/i\/[A-Za-z0-9]{6,40}\/?$/;
const CLOSED_PAYMENT_STATUSES = new Set(['paid', 'partially_paid', 'cancelled', 'refunded']);
const PAID = new Set(['RECEIVED', 'CONFIRMED']);
const OPEN = new Set(['PENDING', 'OVERDUE', 'AWAITING_RISK_ANALYSIS']);

export const ASAAS_STATUS_LABELS = {
  PENDING: 'Aguardando pagamento',
  OVERDUE: 'Vencida no Asaas',
  AWAITING_RISK_ANALYSIS: 'Em análise no Asaas',
  RECEIVED: 'Recebida',
  CONFIRMED: 'Confirmada',
  RECEIVED_IN_CASH: 'Marcada no Asaas como recebida em dinheiro',
  REFUNDED: 'Estornada no Asaas',
  REFUND_REQUESTED: 'Estorno pedido no Asaas',
  REFUND_IN_PROGRESS: 'Estorno em andamento no Asaas',
  CHARGEBACK_REQUESTED: 'Contestação do cartão no Asaas',
  CHARGEBACK_DISPUTE: 'Contestação do cartão no Asaas',
  AWAITING_CHARGEBACK_REVERSAL: 'Contestação do cartão no Asaas',
  DUNNING_REQUESTED: 'Em negativação no Asaas',
  DUNNING_RECEIVED: 'Negativação recebida no Asaas',
  DELETED: 'Cobrança removida no Asaas',
};

const BILLING_TYPE_LABELS = {
  PIX: 'PIX',
  BOLETO: 'Boleto',
  CREDIT_CARD: 'Cartão de crédito',
  DEBIT_CARD: 'Cartão de débito',
  UNDEFINED: 'Forma não definida',
};

const CHECK_RESULT_REASONS = {
  not_found: 'Venda não encontrada no sistema.',
  asaas_api_charge: 'Cobrança da integração automática: siga pela tela da venda.',
  unsupported_link: 'O link salvo não é uma fatura do Asaas.',
  asaas_not_found: 'Cobrança não encontrada no Asaas. Confira o link salvo.',
  not_checked: 'Não deu tempo de consultar esta cobrança. Confira de novo.',
};

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const cents = value => Math.round((Number(value) || 0) * 100);

export function asaasStatusLabel(status) {
  return ASAAS_STATUS_LABELS[status] || `Situação no Asaas: ${status || 'desconhecida'}`;
}

export function billingTypeLabel(billingType) {
  return BILLING_TYPE_LABELS[billingType] || billingType || 'Forma não informada';
}

export function hasAsaasInvoiceLink(order) {
  return INVOICE_LINK.test(String(order?.external_payment_link || '').trim());
}

// Vendas abertas, com fatura do Asaas e sem cobrança da integração automática.
export function asaasCheckCandidates(orders) {
  return (orders || []).filter(order =>
    order
    && !order.asaas_charge_id
    && Number(order.total_value) > 0
    && !CLOSED_PAYMENT_STATUSES.has(order.payment_status)
    && hasAsaasInvoiceLink(order));
}

// Mesmas formas que o administrador escolheria no "Receber".
export function methodForAsaasPayment(methods, billingType, installmentCount = 1) {
  const code = billingType === 'PIX' ? 'pix'
    : billingType === 'BOLETO' ? 'boleto'
      : billingType === 'CREDIT_CARD' ? (installmentCount > 1 ? `card_${installmentCount}x` : 'credit_card')
        : null;
  if (!code) return null;
  return (methods || []).find(method => method.internal_code === code) || null;
}

function paidOn(fact) {
  return fact?.client_payment_date || fact?.confirmed_date || fact?.payment_date || null;
}

// Parcelas como estão no Asaas: valor e data em que o dinheiro entra (já
// creditado ou a previsão). A última absorve os centavos para a soma bater
// com o total do sistema. Sem data ou valor em alguma parcela, devolve null
// e o registro usa a projeção de sempre.
export function asaasCreditSchedule(facts, total) {
  const rows = (facts || []).map((fact, index) => ({
    number: index + 1,
    date: fact?.credit_date || fact?.estimated_credit_date || null,
    value: Number(fact?.value) || 0,
  }));
  if (!rows.length || rows.some(row => !row.date || !(row.value > 0))) return null;
  const allocated = rows.slice(0, -1).reduce((sum, row) => sum + cents(row.value), 0);
  const last = (cents(total) - allocated) / 100;
  if (!(last > 0)) return null;
  rows[rows.length - 1].value = last;
  return rows;
}

export function classifyAsaasCheck(order, check, methods, today) {
  const base = { key: `${order.type}:${order.id}`, order };
  const review = reason => ({ ...base, kind: 'review', reason });

  if (!check) return review('Sem resposta do Asaas para esta cobrança.');
  if (check.result === 'closed') return { ...base, kind: 'skip', reason: 'Já está paga ou encerrada no sistema.' };
  if (check.result === 'asaas_error') return review(`Erro ao consultar o Asaas: ${check.message || 'sem detalhe'}.`);
  if (check.result !== 'checked') return review(CHECK_RESULT_REASONS[check.result] || 'Não foi possível conferir.');

  const parcels = Array.isArray(check.installments) ? check.installments : null;
  if (parcels && parcels.length === 0) return review('Parcelas não encontradas no Asaas.');
  const facts = parcels || [check.payment];
  const statuses = facts.map(fact => fact?.status);

  const problem = statuses.find(status => !PAID.has(status) && !OPEN.has(status));
  if (problem) return review(`${asaasStatusLabel(problem)}.`);

  const paidCount = statuses.filter(status => PAID.has(status)).length;
  if (paidCount === 0) {
    const status = statuses.includes('OVERDUE') ? 'OVERDUE' : statuses[0];
    return { ...base, kind: 'open', status, label: asaasStatusLabel(status) };
  }
  if (paidCount < facts.length) return review(`${paidCount} de ${facts.length} parcelas pagas no Asaas.`);

  // A fatura precisa ser do mesmo CPF da venda: pega link colado na venda errada.
  if (check.customer_check === 'mismatch') {
    return review('A fatura no Asaas é de outra pessoa (CPF diferente). Confira o link salvo nesta venda.');
  }
  if (check.customer_check !== 'match') {
    return review('Não deu para conferir o CPF do cliente no Asaas. Confira e registre pelo "Receber".');
  }

  const billingTypes = [...new Set(facts.map(fact => fact?.billing_type))];
  const billingType = billingTypes.length === 1 ? billingTypes[0] : null;
  if (!billingType) return review('As parcelas foram pagas de formas diferentes no Asaas.');
  if (parcels && billingType !== 'CREDIT_CARD') {
    return review(`${billingTypeLabel(billingType)} parcelado no Asaas: registre pelo "Receber".`);
  }

  // Ao dividir em parcelas, o arredondamento pode deixar até 1 centavo por parcela.
  const asaasTotal = facts.reduce((sum, fact) => sum + (Number(fact?.value) || 0), 0);
  if (Math.abs(cents(asaasTotal) - cents(order.total_value)) > Math.max(1, facts.length)) {
    return review(`Valor no Asaas ${money.format(asaasTotal)}; no sistema ${money.format(Number(order.total_value) || 0)}.`);
  }

  const method = methodForAsaasPayment(methods, billingType, facts.length);
  if (!method) {
    return review(billingType === 'CREDIT_CARD'
      ? `Forma "Cartão ${facts.length}x" não está ativa nas formas de pagamento.`
      : `Pago com ${billingTypeLabel(billingType).toLowerCase()}: registre pelo "Receber".`);
  }

  const paymentDate = paidOn(facts[0]);
  if (!paymentDate) return review('O Asaas não informou a data do pagamento.');
  if (today && paymentDate > today) return review('O Asaas informou uma data de pagamento no futuro.');

  const total = Number(order.total_value);
  return {
    ...base,
    kind: 'ready',
    method,
    paymentDate,
    total,
    installments: facts.length,
    billingType,
    schedule: asaasCreditSchedule(facts, total),
  };
}

export function summarizeAsaasCheck(orders, results, methods, today) {
  const byKey = new Map((results || []).map(item => [`${item.type}:${item.id}`, item]));
  const groups = { ready: [], review: [], open: [], skip: [] };
  for (const order of orders || []) {
    const item = classifyAsaasCheck(order, byKey.get(`${order.type}:${order.id}`), methods, today);
    groups[item.kind].push(item);
  }
  return groups;
}

function sameRegistration(shown, now) {
  return Boolean(shown && now && now.kind === 'ready'
    && shown.method?.id === now.method?.id
    && shown.paymentDate === now.paymentDate
    && cents(shown.total) === cents(now.total)
    && JSON.stringify(shown.schedule || null) === JSON.stringify(now.schedule || null));
}

// Segunda conferência, logo antes de gravar: só segue o que continua igual
// ao que foi mostrado na lista. O que mudou no Asaas fica de fora, com o motivo.
export function reconfirmAsaasItems(selected, freshGroups) {
  const fresh = new Map(
    ['ready', 'review', 'open', 'skip'].flatMap(kind => freshGroups?.[kind] || []).map(item => [item.key, item]),
  );
  const confirmed = [];
  const changed = [];
  for (const item of selected || []) {
    const now = fresh.get(item.key);
    if (sameRegistration(item, now)) {
      confirmed.push(now);
    } else {
      changed.push({
        item,
        reason: now?.kind === 'ready'
          ? 'Forma, data, valor ou parcelas mudaram no Asaas desde a conferência.'
          : now?.reason || now?.label || 'Não está mais paga no Asaas.',
      });
    }
  }
  return { confirmed, changed };
}

// Registra uma por vez; um erro não impede as outras.
export async function registerAsaasPayments(items, register) {
  const results = [];
  for (const item of items) {
    try {
      await register(item);
      results.push({ key: item.key, ok: true });
    } catch (error) {
      results.push({ key: item.key, ok: false, message: error?.message || 'Não foi possível registrar' });
    }
  }
  return results;
}
