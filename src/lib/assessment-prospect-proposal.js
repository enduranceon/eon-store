// Proposta do prospect: antes de mandar o link dá para ajustar plano, coach,
// início, parcelas, matrícula e desconto. Cada ajuste usa a operação que já
// existe no banco, e o banco exige a cada passo que o coach atenda a
// modalidade do plano, então a ordem de salvar importa.

const PERIOD_MONTHS = { mensal: 1, trimestral: 3, semestral: 6, anual: 12 };
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function planMonths(plan) {
  return Number(plan?.period_months) || PERIOD_MONTHS[plan?.period] || 1;
}

// Igual ao banco (data + intervalo em meses): o dia passa do fim do mês e
// fica no último dia, como 31/01 + 1 mês = 28/02.
export function addMonthsToDate(dateStr, months) {
  if (!DATE_PATTERN.test(dateStr || '')) return '';
  const [year, month, day] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

// O plano como foi gravado no contrato. Vale enquanto o plano não é trocado.
export function contractPlanSnapshot(contract) {
  const snapshot = contract?.plan_snapshot || {};
  return {
    id: contract?.plan_id || snapshot.plan_id || '',
    name: snapshot.name || '',
    modality_id: snapshot.modality_id || null,
    price_total: Number(snapshot.price_total || 0),
    enrollment_fee: Number(snapshot.enrollment_fee || 0),
    max_installments: Number(snapshot.max_installments) || null,
    period_months: Number(snapshot.period_months) || null,
    period: snapshot.period || null,
  };
}

export function proposalFormFrom(contract, { paymentLink = '', defaultDueDate = '' } = {}) {
  return {
    plan_id: contract?.plan_id || '',
    coach_id: contract?.coach_id || '',
    start_date: contract?.start_date || '',
    installments: Number(contract?.installments) || 1,
    enrollment_fee: String(Number(contract?.enrollment_fee || 0)),
    manual_discount: String(Number(contract?.manual_discount || 0)),
    payment_link: paymentLink,
    due_date: contract?.due_date || defaultDueDate,
  };
}

export function coachServesModality(coach, modalityId) {
  return Boolean(coach && coach.active !== false && modalityId
    && (coach.modality_ids || []).includes(modalityId));
}

function parseMoney(value) {
  if (value === '' || value === null || value === undefined) return 0;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : NaN;
}

// Como a proposta fica com o formulário atual: preço, total, término e se
// precisa passar pela troca de plano (plano, parcelas ou início mudaram).
export function describeProspectProposal({ contract, form, plans = [] }) {
  const livePlans = new Map(plans.map(plan => [plan.id, plan]));
  const snapshot = contractPlanSnapshot(contract);
  const livePlan = livePlans.get(form.plan_id) || null;
  const planChanged = form.plan_id !== contract.plan_id;
  const installments = Number(form.installments) || 1;
  const needsPlanUpdate = planChanged
    || installments !== (Number(contract.installments) || 1)
    || form.start_date !== contract.start_date;
  // A troca de plano grava um retrato novo do plano, com o preço de hoje.
  const pricing = needsPlanUpdate ? (livePlan || snapshot) : snapshot;
  const modalityId = (planChanged ? livePlan?.modality_id : null)
    || livePlans.get(contract.plan_id)?.modality_id
    || snapshot.modality_id
    || null;
  const enrollmentFee = parseMoney(form.enrollment_fee);
  const manualDiscount = parseMoney(form.manual_discount);
  const base = Number(pricing?.price_total || 0);
  const total = Math.max(0, Math.round((base + (enrollmentFee || 0) - (manualDiscount || 0)) * 100) / 100);
  const months = planMonths(pricing);
  return {
    planChanged,
    needsPlanUpdate,
    livePlan,
    pricing,
    modalityId,
    base,
    enrollmentFee,
    manualDiscount,
    total,
    installments,
    perInstallment: installments > 0 ? total / installments : total,
    maxInstallments: Math.max(1, Number((livePlan || snapshot).max_installments) || 1),
    months,
    endDate: addMonthsToDate(form.start_date, months),
    planEnrollmentFee: Number(pricing?.enrollment_fee || 0),
  };
}

// Confere o formulário e devolve os passos na ordem em que o banco aceita:
// troca de plano, troca de coach e, por último, a proposta com o link.
export function planProspectProposalSave({ contract, form, plans = [], coaches = [], today }) {
  // A troca de plano cancelaria a cobrança no Asaas; esse caso fica na tela do contrato.
  if (contract.asaas_charge_id || contract.asaas_payment_link) {
    return { error: 'Este prospect tem cobrança no Asaas. Ajuste pela tela do contrato.' };
  }
  if (!form.plan_id) return { error: 'Selecione o plano' };
  if (!DATE_PATTERN.test(form.start_date || '')) return { error: 'Informe a data de início' };
  const proposal = describeProspectProposal({ contract, form, plans });
  const { planChanged, needsPlanUpdate, livePlan, modalityId } = proposal;
  if (planChanged && !livePlan) return { error: 'Selecione um plano ativo' };
  if (needsPlanUpdate && !livePlan) {
    return { error: 'O plano atual foi desativado. Escolha outro plano para mudar parcelas ou início.' };
  }
  const installments = Number(form.installments);
  if (needsPlanUpdate && (!Number.isInteger(installments) || installments < 1 || installments > proposal.maxInstallments)) {
    return { error: `Escolha entre 1 e ${proposal.maxInstallments} parcelas` };
  }

  const coachById = new Map(coaches.map(coach => [coach.id, coach]));
  const coach = coachById.get(form.coach_id);
  const coachChanged = form.coach_id !== contract.coach_id;
  if (!form.coach_id) return { error: 'Selecione o coach' };
  if ((coachChanged || planChanged) && !coachServesModality(coach, modalityId)) {
    return { error: coach ? `${coach.name} não atende a modalidade deste plano` : 'Selecione um coach ativo' };
  }

  const steps = [];
  if (needsPlanUpdate && coachChanged && planChanged) {
    const currentModalityId = plans.find(plan => plan.id === contract.plan_id)?.modality_id
      || contractPlanSnapshot(contract).modality_id;
    if (coachServesModality(coachById.get(contract.coach_id), modalityId)) steps.push('plan', 'coach');
    else if (coachServesModality(coach, currentModalityId)) steps.push('coach', 'plan');
    else {
      return {
        error: 'O coach atual não atende o novo plano e o novo coach não atende o plano atual. Troque o coach pela tela do contrato antes de trocar o plano.',
      };
    }
  } else {
    if (needsPlanUpdate) steps.push('plan');
    if (coachChanged) steps.push('coach');
  }
  steps.push('proposal');

  const { enrollmentFee, manualDiscount, base } = proposal;
  if (!Number.isFinite(enrollmentFee) || enrollmentFee < 0) return { error: 'Informe uma matrícula válida' };
  if (!Number.isFinite(manualDiscount) || manualDiscount < 0) return { error: 'Informe um desconto válido' };
  if (manualDiscount > base + enrollmentFee) return { error: 'O desconto não pode ser maior que o valor da proposta' };

  const paymentLink = (form.payment_link || '').trim();
  if (!paymentLink) return { error: 'Cole o link de pagamento' };
  if (!/^https:\/\/\S+$/.test(paymentLink)) return { error: 'O link de pagamento precisa começar com https://' };
  if (!DATE_PATTERN.test(form.due_date || '')) return { error: 'Informe o vencimento' };
  if (today && form.due_date < today) return { error: 'O vencimento não pode ser antes de hoje' };

  return {
    steps,
    proposal,
    values: {
      planId: form.plan_id,
      coachId: form.coach_id,
      startDate: form.start_date,
      installments: needsPlanUpdate ? installments : Number(contract.installments) || 1,
      enrollmentFee,
      manualDiscount,
      paymentLink,
      dueDate: form.due_date,
    },
  };
}
