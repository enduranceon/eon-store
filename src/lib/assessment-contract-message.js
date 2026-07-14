import { formatCurrency, formatDate } from '@/lib/utils';
import { getContractTotalValue, isRenewalContract } from '@/lib/assessment-contract-lifecycle';

const PERIOD_LABELS = {
  mensal: 'Mensal',
  trimestral: 'Trimestral',
  semestral: 'Semestral',
  anual: 'Anual',
};

const MONTH_LABELS = {
  1: 'Mensal',
  3: 'Trimestral',
  6: 'Semestral',
  12: 'Anual',
};

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'aluno(a)';
}

function capitalizeFirst(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function contractPlan(contract = {}, plan = {}) {
  return {
    ...(plan || {}),
    ...(contract.plan_snapshot || {}),
  };
}

function periodLabel(contract = {}, plan = {}) {
  const effectivePlan = contractPlan(contract, plan);
  if (PERIOD_LABELS[effectivePlan.period]) return PERIOD_LABELS[effectivePlan.period];
  if (MONTH_LABELS[Number(effectivePlan.period_months)]) return MONTH_LABELS[Number(effectivePlan.period_months)];
  if (effectivePlan.name?.trim()) return effectivePlan.name.trim();
  return 'Plano';
}

export function buildAssessmentContractMessage({
  contract,
  customer,
  plan,
  modality,
  coach,
  totalValue,
  externalLink,
  dueDate,
} = {}) {
  if (!contract || !customer) return '';

  const effectivePlan = contractPlan(contract, plan);
  const modalityName = modality?.name || contract.plan_snapshot?.modality_name || '';
  const coachName = coach?.name || '';
  const installments = Number(contract.installments) || 1;
  const total = totalValue == null
    ? getContractTotalValue(contract, plan?.id ? { [contract.plan_id]: plan } : {})
    : Math.max(0, Number(totalValue) || 0);
  const instValue = installments > 1 ? total / installments : null;
  const enrollment = Number(contract.enrollment_fee || 0);
  const pix = contract.asaas_pix_copy;
  const link = contract.asaas_payment_link || String(externalLink ?? contract.external_payment_link ?? '').trim();
  const confirmationLabel = isRenewalContract(contract) ? 'renovação' : 'adesão';
  const paymentDueDate = dueDate ?? contract.due_date;

  let message = `Olá, ${firstName(customer.full_name)}!\n\n`;
  message += `Sua ${confirmationLabel} na *Assessoria Esportiva Endurance On* está confirmada! 💙🧡\n\n`;
  if (modalityName) message += `🏃 Modalidade: *${capitalizeFirst(modalityName)}*\n`;

  const planName = periodLabel(contract, effectivePlan);
  const planValidity = contract.start_date && contract.end_date
    ? `${planName} - ${formatDate(contract.start_date)} → ${formatDate(contract.end_date)}`
    : planName;
  message += `📅 Plano: *${planValidity}*\n`;
  if (coachName) message += `👤 Coach: *${coachName}*\n`;
  message += `💰 Total: *${formatCurrency(total)}*`;
  if (instValue) message += ` em *${installments}x de ${formatCurrency(instValue)}*`;
  message += '\n';
  if (enrollment > 0) message += `📌 Matrícula: ${formatCurrency(enrollment)} _(cobrada na 1ª mensalidade)_\n`;
  if (paymentDueDate) message += `📆 Vencimento: *${formatDate(paymentDueDate)}*\n`;
  message += '\n';
  if (pix) message += `📲 PIX Copia e Cola:\n\`${pix}\`\n\n`;
  if (link) message += `🔗 Link de pagamento:\n${link}\n\n`;
  message += 'Qualquer dúvida, estou à disposição!';
  return message;
}
