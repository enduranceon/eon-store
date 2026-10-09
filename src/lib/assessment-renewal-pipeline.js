// Regras do quadro de Renovações que não dependem de banco nem de tela.
// A etapa (renewal_stage) é gravada pelo servidor; aqui só se lê.

export const RENEWAL_STAGE = {
  CONTACT_PENDING: 'contact_pending',
  WAITING_RESPONSE: 'waiting_response',
  CHARGE_PENDING: 'charge_pending',
  WAITING_PAYMENT: 'waiting_payment',
  RENEWED: 'renewed',
  NOT_RENEWED: 'not_renewed',
  DISCARDED: 'discarded',
};

export const RENEWAL_STAGE_LABELS = {
  contact_pending: 'Enviar mensagem',
  waiting_response: 'Aguardando decisão',
  charge_pending: 'Enviar cobrança',
  waiting_payment: 'Aguardando pagamento',
  renewed: 'Renovou',
  not_renewed: 'Não renovou',
  discarded: 'Descartada',
};

export const RENEWAL_RESPONSE_LABELS = {
  will_renew: 'Sim, vou renovar',
  thinking: 'Ainda estou pensando',
  change_plan_or_coach: 'Mudar plano/treinador',
  needs_agent: 'Falar com um atendente',
  not_renewing: 'Não vou renovar',
};

// "Mudar plano/treinador": o atendente escolhe o que muda e já cai na troca
// certa do contrato da renovação.
export const RENEWAL_CHANGE_TARGETS = {
  plan: { label: 'Plano', hint: 'Abre a troca de plano da renovação.', query: 'ajustar-plano' },
  coach: { label: 'Treinador', hint: 'Abre a troca de coach da renovação.', query: 'trocar-coach' },
};

export function renewalChangeHref(contractId, target) {
  const change = RENEWAL_CHANGE_TARGETS[target];
  if (!contractId || !change) return null;
  return `/assessoria/contratos/${contractId}?${change.query}=1`;
}

// Renovação parada em "Aguardando decisão" esperando a troca de plano/coach.
export function awaitsRenewalChange(contract) {
  return contract?.renewal_stage === RENEWAL_STAGE.WAITING_RESPONSE
    && contract?.renewal_response_code === 'change_plan_or_coach';
}

export const OPEN_RENEWAL_STAGES = new Set([
  RENEWAL_STAGE.CONTACT_PENDING,
  RENEWAL_STAGE.WAITING_RESPONSE,
  RENEWAL_STAGE.CHARGE_PENDING,
  RENEWAL_STAGE.WAITING_PAYMENT,
]);

// Renovou / Não renovou ficam no quadro por 5 dias depois da decisão; depois
// disso só saem da tela (o registro e o histórico continuam).
export const RENEWAL_TERMINAL_VISIBLE_DAYS = 5;

const DAY_MS = 86400000;
const BUSINESS_TIME_ZONE = 'America/Sao_Paulo';

function dateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

// Dias de `todayStr` até `dateStr` (negativo quando a data já passou).
export function daysUntil(dateStr, todayStr) {
  const target = dateOnly(dateStr);
  const today = dateOnly(todayStr);
  if (target === null || today === null) return null;
  return Math.round((target - today) / DAY_MS);
}

// Data de negócio (São Paulo) de um instante gravado pelo servidor.
function addDays(dateStr, days) {
  const base = dateOnly(dateStr);
  if (base === null) return '';
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}

function shortDate(dateStr) {
  const date = String(dateStr || '').slice(0, 10);
  return date ? `${date.slice(8, 10)}/${date.slice(5, 7)}` : '';
}

export function businessDate(timestamp) {
  const time = Date.parse(timestamp || '');
  if (!Number.isFinite(time)) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(time));
}

export function renewalDueLabel(daysToEnd) {
  if (daysToEnd === null || daysToEnd === undefined) return 'sem data';
  if (daysToEnd > 1) return `vence em ${daysToEnd} dias`;
  if (daysToEnd === 1) return 'vence amanhã';
  if (daysToEnd === 0) return 'vence hoje';
  if (daysToEnd === -1) return 'venceu ontem';
  return `venceu há ${Math.abs(daysToEnd)} dias`;
}

export function followUpLabel(daysLate) {
  if (!daysLate || daysLate <= 0) return 'follow-up hoje';
  return `follow-up atrasado há ${daysLate} dia${daysLate === 1 ? '' : 's'}`;
}

// Trecho das mensagens da renovação, igual ao {aviso_vencimento} do banco:
// "seu plano Corrida - Trimestral vence em 18/10" (ou "venceu em").
export function renewalDueNotice(endDate, todayStr, planName = '') {
  const days = daysUntil(endDate, todayStr);
  if (days === null) return 'a data de vencimento do seu plano precisa ser confirmada';
  const plan = String(planName || '').trim();
  return `seu plano${plan ? ` ${plan}` : ''} ${days >= 0 ? 'vence' : 'venceu'} em ${shortDate(endDate)}`;
}

// ── Régua de contato (igual a eon_private.assessment_renewal_contact_plan) ──
// Pebinha 10 dias antes; sem resposta, lembrete 2 dias depois, mensagem no
// último dia do plano e encerramento 5 dias depois do fim. "Ainda pensando"
// recebe o "combinado" na hora e o retorno na data marcada (padrão: 2 dias).

export const RENEWAL_CONTACT_STEPS = {
  intent: { label: 'Pebinha', action: 'Enviar mensagem', offset: -10, trigger: 'contract_end_date' },
  reminder: { label: 'Lembrete', action: 'Enviar lembrete', offset: -8, trigger: 'contract_end_date' },
  last_day: { label: 'Último dia do plano', action: 'Enviar último dia', offset: 0, trigger: 'contract_end_date' },
  closing: { label: 'Encerramento sem resposta', action: 'Enviar encerramento', offset: 5, trigger: 'contract_end_date' },
  thinking_ack: { label: '"Combinado" (ainda pensando)', action: 'Enviar "combinado"', offset: 1, trigger: 'manual' },
  thinking_return: { label: 'Retorno (ainda pensando)', action: 'Enviar retorno', offset: 2, trigger: 'manual' },
  farewell: { label: 'Despedida', action: 'Enviar despedida', offset: 3, trigger: 'manual' },
  close: { label: 'Encerrar como "Não renovou"', action: 'Encerrar: não respondeu' },
};

const DECIDED_RESPONSES = new Set(['will_renew', 'change_plan_or_coach', 'needs_agent', 'not_renewing']);

function laterDate(a, b) {
  return String(a || '') > String(b || '') ? a : b;
}

export function renewalContactPlan({
  step = null, stepAt = null, responseCode = null, responseAt = null, followUpAt = null, endDate = null,
} = {}, todayStr) {
  if (DECIDED_RESPONSES.has(responseCode) || step === 'farewell') return { step: 'none', eligibleAt: null };
  const last = businessDate(stepAt);
  if (step === 'closing') return { step: 'close', eligibleAt: last };
  const stepTime = Date.parse(stepAt || '');
  const responseTime = Date.parse(responseAt || '');
  let next;
  let at;
  if (responseCode === 'thinking'
    && (!stepAt || responseTime > stepTime || !['thinking_ack', 'thinking_return'].includes(step))) {
    next = 'thinking_ack';
    at = businessDate(responseAt) || todayStr;
  } else if (!step) {
    next = 'intent';
    at = endDate && addDays(endDate, -10) < todayStr ? addDays(endDate, -10) : todayStr;
  } else if (step === 'thinking_ack') {
    next = 'thinking_return';
    at = followUpAt || addDays(last, 2);
  } else if (!endDate) {
    return { step: 'none', eligibleAt: null };
  } else if (step === 'intent' && addDays(last, 2) < endDate) {
    next = 'reminder';
    at = addDays(last, 2);
  } else if (['intent', 'reminder', 'thinking_return'].includes(step) && last < endDate) {
    next = 'last_day';
    at = endDate;
  } else {
    next = 'closing';
    at = laterDate(addDays(endDate, 5), addDays(last, 1));
  }
  if (followUpAt && !['thinking_ack', 'thinking_return'].includes(next)) at = laterDate(at, followUpAt);
  return { step: next, eligibleAt: at };
}

// O passo da vez de um card aberto em "Enviar mensagem" ou "Aguardando decisão".
export function renewalContactStep(contract, parent, todayStr) {
  if (!contract || contract.auto_renewal) return null;
  if (![RENEWAL_STAGE.CONTACT_PENDING, RENEWAL_STAGE.WAITING_RESPONSE].includes(contract.renewal_stage)) return null;
  const plan = renewalContactPlan({
    step: contract.renewal_contact_step,
    stepAt: contract.renewal_contact_step_at,
    responseCode: contract.renewal_response_code,
    responseAt: contract.renewal_response_at,
    followUpAt: contract.renewal_follow_up_at,
    endDate: parent?.end_date || (contract.start_date ? addDays(contract.start_date, -1) : null),
  }, todayStr);
  if (plan.step === 'none') return null;
  return { ...plan, due: !plan.eligibleAt || plan.eligibleAt <= todayStr };
}

export function renewalStepLabel(plan, todayStr) {
  if (!plan) return '';
  const meta = RENEWAL_CONTACT_STEPS[plan.step];
  if (!meta) return '';
  if (plan.step === 'close') return `${meta.label}: falta encerrar`;
  if (!plan.eligibleAt || plan.eligibleAt <= todayStr) return `${meta.label}: hoje`;
  return `${meta.label}: ${shortDate(plan.eligibleAt)}`;
}

// Quantos dias um card final ainda fica no quadro (0 = último dia).
export function terminalDaysLeft(resolvedAt, todayStr) {
  const resolvedDate = businessDate(resolvedAt);
  if (!resolvedDate) return null;
  const elapsed = -daysUntil(resolvedDate, todayStr);
  return RENEWAL_TERMINAL_VISIBLE_DAYS - elapsed;
}

// Uma renovação aberta nunca sai do quadro por data; só as finais saem, e só
// depois da janela de 5 dias.
export function isVisibleOnBoard(contract, todayStr) {
  const stage = contract?.renewal_stage;
  if (OPEN_RENEWAL_STAGES.has(stage)) return true;
  if (stage !== RENEWAL_STAGE.RENEWED && stage !== RENEWAL_STAGE.NOT_RENEWED) return false;
  const left = terminalDaysLeft(contract.renewal_resolved_at, todayStr);
  return left !== null && left >= 0;
}

const PERIOD_MONTHS = { mensal: 1, trimestral: 3, semestral: 6, anual: 12 };

export function planPeriodMonths(plan) {
  const months = Number(plan?.period_months);
  if (Number.isInteger(months) && months > 0) return months;
  return PERIOD_MONTHS[plan?.period] || null;
}

// Renovação automática é só para o plano mensal (assinatura que já existe no
// Asaas). Plano desconhecido não é bloqueado aqui; o servidor decide.
export function allowsAutoRenewal(plan) {
  const months = planPeriodMonths(plan);
  return months === null || months === 1;
}

export const AUTO_RENEWAL_MONTHLY_ONLY_MESSAGE = 'A renovação automática só vale para plano mensal';

// ── Quadro ────────────────────────────────────────────────────────────────

export const RENEWAL_BOARD_COLUMNS = [
  {
    stage: RENEWAL_STAGE.CONTACT_PENDING,
    title: 'Enviar mensagem',
    hint: 'Só sai daqui quando a mensagem for registrada como enviada.',
    badge: 'bg-blue-100 text-blue-700',
    dot: 'bg-blue-500',
  },
  {
    stage: RENEWAL_STAGE.WAITING_RESPONSE,
    title: 'Aguardando decisão',
    hint: 'Sem resposta, o card fica aqui; o atraso só aumenta a prioridade.',
    badge: 'bg-violet-100 text-violet-700',
    dot: 'bg-violet-500',
  },
  {
    stage: RENEWAL_STAGE.CHARGE_PENDING,
    title: 'Enviar cobrança',
    hint: 'Depois da cobrança, a venda também aparece em Vendas em aberto.',
    badge: 'bg-amber-100 text-amber-800',
    dot: 'bg-amber-500',
  },
  {
    stage: RENEWAL_STAGE.WAITING_PAYMENT,
    title: 'Aguardando pagamento',
    hint: 'Pagamento pendente nunca some, mesmo depois do início da nova vigência.',
    badge: 'bg-orange-100 text-orange-800',
    dot: 'bg-orange-500',
  },
  {
    stage: RENEWAL_STAGE.RENEWED,
    title: 'Renovou',
    hint: 'Fica 5 dias depois da confirmação do pagamento.',
    badge: 'bg-green-100 text-green-700',
    dot: 'bg-green-500',
  },
  {
    stage: RENEWAL_STAGE.NOT_RENEWED,
    title: 'Não renovou',
    hint: 'Fica 5 dias depois da decisão final.',
    badge: 'bg-gray-200 text-gray-700',
    dot: 'bg-gray-500',
  },
];

const TERMINAL_STAGES = new Set([RENEWAL_STAGE.RENEWED, RENEWAL_STAGE.NOT_RENEWED]);
const PAID_STATUSES = new Set(['paid', 'refunded', 'partially_refunded']);

function money(value) {
  return Number(value) || 0;
}

// Valor da venda da renovação, como o registro de pagamento calcula.
export function renewalSaleTotal(contract) {
  const base = money(contract?.plan_snapshot?.price_total ?? contract?.plan?.price_total);
  return Math.max(
    0,
    base + money(contract?.enrollment_fee) - money(contract?.manual_discount) - money(contract?.credit_balance),
  );
}

export function hasRenewalChargeLink(contract) {
  return Boolean(
    contract?.asaas_payment_link
    || contract?.asaas_pix_copy
    || contract?.external_payment_link,
  );
}

export function hasRenewalChargeInfo(contract) {
  return Boolean(
    hasRenewalChargeLink(contract)
    || contract?.asaas_charge_id
    || contract?.external_invoice_number,
  );
}

// Tudo o que o card mostra: prazo, selos, alertas e se exige atenção. As
// mensagens sempre trazem texto (nunca só cor).
export function renewalCardState(contract, { parent = null, issues = [], todayStr } = {}) {
  const stage = contract?.renewal_stage || null;
  const isOpen = OPEN_RENEWAL_STAGES.has(stage);
  const endDate = parent?.end_date || contract?.start_date || '';
  const daysToEnd = daysUntil(endDate, todayStr);
  const alerts = [];
  const badges = [];
  let needsAttention = false;

  if (contract?.auto_renewal) badges.push({ tone: 'violet', text: 'Automática' });

  const preCharge = stage === RENEWAL_STAGE.CONTACT_PENDING
    || stage === RENEWAL_STAGE.WAITING_RESPONSE
    || stage === RENEWAL_STAGE.CHARGE_PENDING;
  if (preCharge && daysToEnd !== null) {
    badges.push({
      tone: daysToEnd <= 3 ? 'red' : 'blue',
      text: renewalDueLabel(daysToEnd),
    });
    if (daysToEnd <= 3) needsAttention = true;
  }

  if (stage === RENEWAL_STAGE.CONTACT_PENDING && daysToEnd !== null && daysToEnd < 0) {
    alerts.push({ tone: 'red', text: 'A abordagem ficou atrasada, mas o card continua no quadro.' });
  }

  // Próximo passo da régua de contato: mensagem do dia deixa o card em atenção.
  const contactStep = renewalContactStep(contract, parent, todayStr);
  if (contactStep) {
    badges.push({ tone: contactStep.due ? 'amber' : 'gray', text: renewalStepLabel(contactStep, todayStr) });
    if (contactStep.due) needsAttention = true;
  }

  let followUpDaysLate = null;
  if (stage === RENEWAL_STAGE.WAITING_RESPONSE) {
    const response = contract.renewal_response_code;
    if (response === 'change_plan_or_coach') badges.push({ tone: 'violet', text: 'mudar plano/coach' });
    if (response === 'needs_agent') {
      badges.push({ tone: 'amber', text: 'atendimento pendente' });
      alerts.push({ tone: 'amber', text: 'O atleta pediu para falar com um atendente.' });
    }
    if (response === 'thinking') badges.push({ tone: 'blue', text: 'ainda pensando' });
    if (contract.renewal_follow_up_at) {
      followUpDaysLate = -daysUntil(contract.renewal_follow_up_at, todayStr);
      if (followUpDaysLate > 0) {
        needsAttention = true;
        alerts.push({ tone: 'red', text: `Follow-up atrasado há ${followUpDaysLate} dia${followUpDaysLate === 1 ? '' : 's'}.` });
      }
    }
  }

  if (stage === RENEWAL_STAGE.CHARGE_PENDING && contract.renewal_response_code === 'change_plan_or_coach') {
    badges.push({ tone: 'violet', text: 'plano/coach alterado' });
    alerts.push({ tone: 'blue', text: 'Mudança resolvida. Falta só registrar e enviar a cobrança.' });
  }

  let termStartedDays = null;
  const missingLink = stage === RENEWAL_STAGE.WAITING_PAYMENT && !hasRenewalChargeLink(contract);
  if (stage === RENEWAL_STAGE.WAITING_PAYMENT) {
    if (missingLink) {
      badges.push({ tone: 'amber', text: 'Sem link' });
      alerts.push({
        tone: 'amber',
        text: contract.auto_renewal
          ? 'Link da cobrança ainda não informado.'
          : 'Cobrança ainda não registrada.',
      });
    }
    const startedDays = -daysUntil(contract.start_date, todayStr);
    if (startedDays > 0 && !PAID_STATUSES.has(contract.payment_status)) {
      termStartedDays = startedDays;
      needsAttention = true;
      alerts.push({
        tone: 'red',
        text: `A vigência começou há ${startedDays} dia${startedDays === 1 ? '' : 's'} e o pagamento continua pendente.`,
      });
    }
  }

  if (issues.length > 0 && (isOpen || TERMINAL_STAGES.has(stage))) {
    needsAttention = true;
    issues.forEach(issue => alerts.push({ tone: 'red', text: `Precisa de conferência: ${issue.issue_label}.` }));
  }

  const terminalLeft = TERMINAL_STAGES.has(stage)
    ? terminalDaysLeft(contract.renewal_resolved_at, todayStr)
    : null;

  return {
    stage,
    isOpen,
    endDate,
    daysToEnd,
    contactStep,
    followUpDaysLate,
    termStartedDays,
    missingLink,
    needsAttention: isOpen && needsAttention || (TERMINAL_STAGES.has(stage) && issues.length > 0),
    badges,
    alerts,
    terminalDaysLeft: terminalLeft,
    leavesLabel: terminalLeft === null
      ? ''
      : terminalLeft <= 0
        ? 'Último dia no quadro; o histórico continua no contrato.'
        : `Fica no quadro até ${shortDate(addDays(todayStr, terminalLeft))}; o histórico continua no contrato.`,
    total: renewalSaleTotal(contract),
  };
}

function normalizeSearch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export function matchesRenewalFilters(card, filters = {}) {
  if (filters.hideCompleted && TERMINAL_STAGES.has(card.contract.renewal_stage)) return false;
  if (filters.planName && (card.contract.plan_snapshot?.name || '') !== filters.planName) return false;
  if (filters.coachId && card.contract.coach_id !== filters.coachId) return false;
  if (filters.modalityId && card.contract.plan_snapshot?.modality_id !== filters.modalityId) return false;
  const query = normalizeSearch(filters.search);
  if (!query) return true;
  return [
    card.customer?.full_name,
    card.contract.contract_number,
    card.parent?.contract_number,
  ].some(value => normalizeSearch(value).includes(query));
}

// Monta as colunas: mais urgente primeiro (fim de vigência mais antigo).
export function buildRenewalBoard(contracts = [], {
  parents = {},
  customers = {},
  issuesByContract = {},
  todayStr,
  filters = {},
} = {}) {
  const cards = contracts
    .filter(contract => isVisibleOnBoard(contract, todayStr))
    .map(contract => {
      const parent = parents[contract.parent_contract_id] || null;
      const issues = issuesByContract[contract.id] || [];
      return {
        contract,
        parent,
        customer: customers[contract.customer_id] || null,
        state: renewalCardState(contract, { parent, issues, todayStr }),
      };
    });

  const filtered = cards.filter(card => matchesRenewalFilters(card, filters));
  const columns = RENEWAL_BOARD_COLUMNS
    .filter(column => !(filters.hideCompleted && TERMINAL_STAGES.has(column.stage)))
    .map(column => {
      const items = filtered
        .filter(card => card.contract.renewal_stage === column.stage)
        .sort((a, b) => {
          if (TERMINAL_STAGES.has(column.stage)) {
            return String(b.contract.renewal_resolved_at || '').localeCompare(String(a.contract.renewal_resolved_at || ''));
          }
          // Em "Aguardando pagamento", quem ainda está sem link vem primeiro.
          if (a.state.missingLink !== b.state.missingLink) return a.state.missingLink ? -1 : 1;
          if (a.state.needsAttention !== b.state.needsAttention) return a.state.needsAttention ? -1 : 1;
          const byDate = String(a.state.endDate || '9999').localeCompare(String(b.state.endDate || '9999'));
          if (byDate !== 0) return byDate;
          return String(a.customer?.full_name || '').localeCompare(String(b.customer?.full_name || ''), 'pt-BR');
        });
      return {
        ...column,
        items,
        total: items.reduce((sum, card) => sum + card.state.total, 0),
        missingLinkCount: items.filter(card => card.state.missingLink).length,
      };
    });

  return { cards, columns };
}

export function summarizeRenewalBoard(cards = []) {
  const open = cards.filter(card => card.state.isOpen);
  const waitingPayment = open.filter(card => card.contract.renewal_stage === RENEWAL_STAGE.WAITING_PAYMENT);
  return {
    inPipeline: open.length,
    needsAttention: open.filter(card => card.state.needsAttention).length,
    waitingPaymentCount: waitingPayment.length,
    waitingPaymentTotal: waitingPayment.reduce((sum, card) => sum + card.state.total, 0),
  };
}

// ── Linha do tempo ────────────────────────────────────────────────────────

export const RENEWAL_EVENT_LABELS = {
  created: 'Renovação criada',
  renewal_drafted: 'Rascunho de renovação criado',
  renewal_pipeline_entered: 'Entrou no quadro',
  renewal_message_sent: 'Mensagem de renovação enviada',
  renewal_farewell_sent: 'Despedida enviada',
  renewal_response_recorded: 'Resposta registrada',
  renewal_follow_up_set: 'Follow-up',
  renewal_change_resolved: 'Mudança de plano/coach resolvida',
  renewal_stage_changed: 'Etapa atualizada',
  renewal_scheduled: 'Renovação aprovada',
  renewal_activated: 'Renovação ativada',
  renewed: 'Renovação registrada',
  renewal_declined: 'Não renovou',
  renewal_discarded: 'Venda de renovação descartada',
  open_sale_registered: 'Venda aberta no Financeiro',
  external_charge_registered: 'Cobrança cadastrada',
  external_charge_updated: 'Cobrança atualizada',
  external_charge_removed: 'Cobrança removida',
  payment_message_sent: 'Cobrança enviada',
  manual_payment_recorded: 'Pagamento registrado',
  payment_reverted: 'Pagamento desfeito',
  sale_voided: 'Venda anulada',
  plan_changed: 'Plano alterado',
  coach_changed: 'Coach alterado',
  auto_renewal_changed: 'Renovação automática alterada',
  status_transitioned: 'Situação do contrato',
};

// Eventos do contrato anterior que contam a história da renovação.
const PARENT_RENEWAL_EVENTS = new Set([
  'renewal_drafted',
  'renewed',
  'renewal_declined',
  'renewal_discarded',
  'renewal_message_sent',
]);

export function buildRenewalTimeline({ contract, parent, contractEvents = [], saleEvents = [] } = {}) {
  const rows = [];
  contractEvents.forEach(event => {
    const fromParent = parent && event.contract_id === parent.id;
    if (fromParent && !PARENT_RENEWAL_EVENTS.has(event.event_type)) return;
    if (!fromParent && event.contract_id !== contract?.id) return;
    rows.push({
      id: `event:${event.id}`,
      at: event.created_at,
      title: RENEWAL_EVENT_LABELS[event.event_type] || 'Registro',
      detail: event.notes || '',
      fromParent,
    });
  });
  saleEvents.forEach(event => {
    if (event.order_id !== contract?.id) return;
    rows.push({
      id: `sale:${event.id}`,
      at: event.created_at,
      title: 'Financeiro',
      detail: event.reason || '',
      fromParent: false,
    });
  });
  return rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}
