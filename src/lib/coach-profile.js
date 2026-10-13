// Perfil do coach para o gestor: carteira de hoje, mês a mês, saídas com
// motivo, prospects e renovações em andamento e repasses. Contagem de alunos,
// entradas e saídas segue as regras da tela Entradas e saídas.
import { buildMonthlyMovement } from './assessment-movement.js';
import {
  OPEN_PAYMENT_STATUSES,
  getContractMonthlyValue,
  isContractPaymentOverdue,
} from './assessment-contract-lifecycle.js';
import { OPEN_RENEWAL_STAGES, RENEWAL_STAGE_LABELS } from './assessment-renewal-pipeline.js';
import { dateOnly } from './assessment-yearly-indicators.js';

// Mesmas etapas abertas do quadro de Prospects.
export const OPEN_PROSPECT_STAGE_LABELS = {
  new: 'Novo',
  awaiting_reply: 'Aguardando resposta',
  clarifying: 'Tirando dúvidas',
  proposal_ready: 'Proposta pronta',
  payment_link_sent: 'Link enviado',
};

export const CLOSING_STATUS_LABELS = {
  pending_approval: 'Em revisão',
  approved: 'Aprovado',
  paid: 'Pago',
};

const money = value => Math.round(Number(value || 0) * 100) / 100;

function planNameOf(contract, plansById) {
  return contract?.plan_snapshot?.name || plansById[contract?.plan_id]?.name || '';
}

function isOpenProspect(contract) {
  return !contract.parent_contract_id
    && !['cancelled', 'voided'].includes(contract.status)
    && Object.hasOwn(OPEN_PROSPECT_STAGE_LABELS, contract.prospect_stage || '')
    && OPEN_PAYMENT_STATUSES.has(contract.payment_status || 'pending')
    && !contract.payment_date;
}

// Como está cada aluno ativo hoje. Atraso de pagamento vem antes, porque é o
// que pede ação; depois licença e renovação em andamento.
export function studentSituation(contract, renewal, today) {
  if (isContractPaymentOverdue(contract, today)) return { key: 'overdue', label: 'Pagamento atrasado' };
  if (contract?.status === 'on_leave') return { key: 'leave', label: 'Em licença' };
  if (renewal) return { key: 'renewal', label: `Renovação: ${RENEWAL_STAGE_LABELS[renewal.renewal_stage] || 'em andamento'}` };
  return { key: 'active', label: 'Ativo' };
}

export function buildCoachProfile({
  coachId,
  contracts = [],
  plans = [],
  today,
  statementItems = [],
  closings = [],
  pendingRepasse = [],
  months = 12,
} = {}) {
  const plansById = Object.fromEntries(plans.map(plan => [plan.id, plan]));
  const contractsById = new Map(contracts.map(contract => [contract.id, contract]));
  const monthly = buildMonthlyMovement(contracts, plans, { asOf: today, months, coachId });
  const current = monthly.at(-1);

  const openRenewals = contracts.filter(contract =>
    contract.parent_contract_id && OPEN_RENEWAL_STAGES.has(contract.renewal_stage));
  const renewalByParent = new Map(openRenewals.map(contract => [contract.parent_contract_id, contract]));

  const students = current.lists.baseEnd.map(entry => {
    const contract = contractsById.get(entry.contractId) || {};
    const renewal = renewalByParent.get(entry.contractId) || null;
    return {
      ...entry,
      endDate: dateOnly(contract.end_date) || '',
      monthlyValue: money(getContractMonthlyValue(contract, plansById)),
      renewalContractId: renewal?.id || null,
      situation: studentSituation(contract, renewal, today),
    };
  });

  const exits = monthly
    .flatMap(month => month.lists.exits)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const sum = key => monthly.reduce((total, month) => total + month[key], 0);
  const churnMonths = monthly.filter(month => month.baseStart > 0);
  const kpis = {
    active: current.baseEnd,
    monthlyRevenue: money(students.reduce((total, student) => total + student.monthlyValue, 0)),
    entries: sum('entries'),
    returns: sum('returns'),
    renewals: sum('renewals'),
    exits: sum('exits'),
    net: sum('entries') + sum('returns') - sum('exits'),
    averageChurn: churnMonths.length
      ? churnMonths.reduce((total, month) => total + month.churnRate, 0) / churnMonths.length
      : 0,
  };

  const byModality = [...students.reduce((groups, student) => {
    const key = student.modalityId || null;
    const group = groups.get(key) || { modalityId: key, students: 0, monthlyRevenue: 0 };
    group.students += 1;
    group.monthlyRevenue = money(group.monthlyRevenue + student.monthlyValue);
    groups.set(key, group);
    return groups;
  }, new Map()).values()].sort((a, b) => b.students - a.students);

  const prospects = contracts
    .filter(contract => contract.coach_id === coachId && isOpenProspect(contract))
    .map(contract => ({
      contractId: contract.id,
      customerId: contract.customer_id || null,
      stage: contract.prospect_stage,
      stageLabel: OPEN_PROSPECT_STAGE_LABELS[contract.prospect_stage],
      planName: planNameOf(contract, plansById),
      createdAt: contract.created_at || '',
    }))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  // Renovação do coach: a que fica com ele ou a do aluno dele que vai trocar de coach.
  const renewals = openRenewals
    .map(contract => ({ contract, parent: contractsById.get(contract.parent_contract_id) || null }))
    .filter(({ contract, parent }) => contract.coach_id === coachId || parent?.coach_id === coachId)
    .map(({ contract, parent }) => ({
      contractId: contract.id,
      parentContractId: contract.parent_contract_id,
      customerId: contract.customer_id || parent?.customer_id || null,
      stage: contract.renewal_stage,
      stageLabel: RENEWAL_STAGE_LABELS[contract.renewal_stage],
      planName: planNameOf(contract, plansById),
      endsOn: dateOnly(parent?.end_date) || '',
      coachChange: contract.coach_id === coachId
        ? (parent && parent.coach_id !== coachId ? 'arriving' : null)
        : 'leaving',
    }))
    .sort((a, b) => String(a.endsOn).localeCompare(String(b.endsOn)));

  const closingById = new Map(closings.map(closing => [closing.id, closing]));
  const payouts = [...statementItems.reduce((groups, item) => {
    const closing = closingById.get(item.closing_id);
    if (!closing) return groups;
    const group = groups.get(closing.id) || {
      closingId: closing.id,
      competence: String(closing.competence || '').slice(0, 10),
      status: closing.status,
      statusLabel: CLOSING_STATUS_LABELS[closing.status] || closing.status || '',
      total: 0,
      items: 0,
    };
    group.total = money(group.total + Number(item.amount || 0));
    group.items += 1;
    groups.set(closing.id, group);
    return groups;
  }, new Map()).values()].sort((a, b) => b.competence.localeCompare(a.competence));

  const pending = {
    count: pendingRepasse.length,
    total: money(pendingRepasse.reduce((total, row) => total + Number(row.amount || 0), 0)),
  };

  return { monthly, kpis, students, exits, byModality, prospects, renewals, payouts, pending };
}
