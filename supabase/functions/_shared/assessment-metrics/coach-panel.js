// Painel do coach: alunos de hoje, entradas e saídas mês a mês e saídas com motivo.
//
// A conta é a MESMA do perfil do coach no painel da equipe (coach-profile.js): quem é
// entrada, retorno, renovação ou saída depende de TODOS os contratos (um aluno que veio
// de outro coach, por exemplo), por isso ela roda no servidor com todos os contratos e
// só o resultado do coach logado sai daqui. O navegador do coach nunca recebe contrato
// de outra pessoa.
//
// O que NÃO sai (decisão do usuário, 2026-11-10): mensalidade, valor do plano, "carteira
// por mês", pagamento atrasado do aluno, contato (WhatsApp/e-mail/CPF), ids internos.
// Só nome, modalidade, plano, datas, situação (ativo, em licença, renovação em andamento)
// e, nas saídas, o motivo registrado.
//
// Duas etapas para a função poder buscar só os nomes dos alunos do coach:
//   computeCoachPanel  -> resultado com ids (uso interno do servidor);
//   presentCoachPanel  -> o que vai para o navegador (lista fixa de campos, sem ids).

import { buildCoachProfile } from './coach-profile.js';

const SITUATION_LABELS = {
  active: 'Ativo',
  leave: 'Em licença',
  renewal: 'Renovação em andamento',
};

const MAX_REASON_LENGTH = 280;
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

function modalityKeyOf(id) {
  return id || null;
}

// today (YYYY-MM-DD de Brasília) é obrigatório: nada aqui pode depender do relógio ou do
// fuso da máquina (o servidor roda em UTC).
/**
 * @param {{ coachId: string, contracts?: any[], plans?: any[], today: string, months?: number }} input
 */
export function computeCoachPanel({ coachId, contracts = [], plans = [], today, months = 12 } = {}) {
  if (!coachId) throw new Error('coachId é obrigatório');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) throw new Error('today (YYYY-MM-DD) é obrigatório');

  const profile = buildCoachProfile({ coachId, contracts, plans, today, months });
  return {
    today,
    kpis: {
      active: profile.kpis.active,
      entries: profile.kpis.entries,
      returns: profile.kpis.returns,
      renewals: profile.kpis.renewals,
      exits: profile.kpis.exits,
      net: profile.kpis.net,
      averageChurn: profile.kpis.averageChurn,
      renewalsInProgress: profile.renewals.length,
    },
    students: profile.students.map(student => ({
      customerId: student.customerId,
      modalityId: modalityKeyOf(student.modalityId),
      planName: student.planName || '',
      startedOn: student.date || '',
      endsOn: student.endDate || '',
      // Atraso de pagamento é situação financeira do aluno: para o coach, segue "Ativo".
      situationKey: student.situation?.key === 'overdue' ? 'active' : (student.situation?.key || 'active'),
    })),
    exits: profile.exits.map(exit => ({
      customerId: exit.customerId,
      modalityId: modalityKeyOf(exit.modalityId),
      planName: exit.planName || '',
      date: exit.date || '',
      reason: String(exit.reason || '').trim().slice(0, MAX_REASON_LENGTH),
    })),
    monthly: profile.monthly.map(month => ({
      month: month.month,
      label: month.label,
      baseStart: month.baseStart,
      entries: month.entries,
      returns: month.returns,
      renewals: month.renewals,
      exits: month.exits,
      baseEnd: month.baseEnd,
      net: month.net,
      churnRate: month.churnRate,
    })),
    byModality: profile.byModality.map(group => ({
      modalityId: modalityKeyOf(group.modalityId),
      students: group.students,
    })),
  };
}

// Ids de pessoas que o navegador vai ver (para buscar só esses nomes).
export function customerIdsOf(panel) {
  return [...new Set([...panel.students, ...panel.exits].map(item => item.customerId).filter(Boolean))];
}

// O que sai para o navegador. Cada objeto tem lista fixa de campos, escrita campo a campo:
// nunca um spread nem a linha do contrato.
export function presentCoachPanel(panel, { customerNames = new Map(), modalityNames = new Map() } = {}) {
  const nameOf = id => customerNames.get(id) || '—';
  const modalityOf = id => (id ? modalityNames.get(id) || 'Modalidade' : 'Sem modalidade');
  const round1 = value => Math.round((Number(value) || 0) * 10) / 10;

  return {
    today: panel.today,
    kpis: {
      active: panel.kpis.active,
      entries: panel.kpis.entries,
      returns: panel.kpis.returns,
      renewals: panel.kpis.renewals,
      exits: panel.kpis.exits,
      net: panel.kpis.net,
      average_churn: round1(panel.kpis.averageChurn),
      renewals_in_progress: panel.kpis.renewalsInProgress,
    },
    students: panel.students
      .map(student => ({
        name: nameOf(student.customerId),
        modality: modalityOf(student.modalityId),
        plan: student.planName,
        started_on: student.startedOn,
        ends_on: student.endsOn,
        situation: { key: student.situationKey, label: SITUATION_LABELS[student.situationKey] || SITUATION_LABELS.active },
      }))
      .sort((a, b) => collator.compare(a.name, b.name)),
    exits: panel.exits.map(exit => ({
      name: nameOf(exit.customerId),
      date: exit.date,
      modality: modalityOf(exit.modalityId),
      plan: exit.planName,
      reason: exit.reason,
    })),
    monthly: panel.monthly.map(month => ({
      month: month.month,
      label: month.label,
      base_start: month.baseStart,
      entries: month.entries,
      returns: month.returns,
      renewals: month.renewals,
      exits: month.exits,
      base_end: month.baseEnd,
      net: month.net,
      churn_rate: round1(month.churnRate),
    })),
    by_modality: panel.byModality.map(group => ({
      modality: modalityOf(group.modalityId),
      students: group.students,
    })),
  };
}
