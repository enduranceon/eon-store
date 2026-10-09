// Primeira página do extrato do coach: o mês dele em números (alunos no início
// e no fim, quem entrou, voltou, renovou e saiu, por modalidade) e a composição
// do repasse. As regras de entrada, retorno e saída são as da tela "Entradas e
// saídas" (assessment-movement.js); o coach de cada contrato é o que ele tinha
// no mês do fechamento, pelo histórico de troca de coach.
import { buildAssessmentMovement } from './assessment-movement.js';
import { addDays } from './assessment-yearly-indicators.js';

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

// Ordem alfabética pelo nome do aluno (sem diferenciar acento e maiúscula).
export function sortByStudentName(list = [], nameOf = item => item.aluno) {
  return list.slice().sort((a, b) => collator.compare(String(nameOf(a) || ''), String(nameOf(b) || '')));
}

function day(value) {
  return String(value || '').slice(0, 10);
}

export function monthBounds(competence) {
  const from = day(competence).slice(0, 7) + '-01';
  const [year, month] = from.split('-').map(Number);
  const to = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { from, to };
}

// Coach do contrato numa data, pelo histórico; sem histórico, o coach atual.
export function coachOnDate(contract, date, historyByContract = new Map()) {
  const rows = historyByContract.get(contract.id) || [];
  const match = rows
    .filter(row => day(row.started_at) <= date && (!row.ended_at || day(row.ended_at) >= date))
    .sort((a, b) => day(b.started_at).localeCompare(day(a.started_at)))[0];
  return match?.coach_id || contract.coach_id || null;
}

// Data em que vale o coach do contrato para o mês: o fim do mês ou, se o
// contrato acabou antes, o último dia dele.
function referenceDate(contract, monthEnd) {
  const ends = [day(contract.cancellation_date), day(contract.end_date)].filter(Boolean).sort();
  const end = ends[0];
  if (end && end <= monthEnd) return addDays(end, -1) || monthEnd;
  return monthEnd;
}

export function buildCoachPanorama({
  contracts = [],
  plans = [],
  coachHistory = [],
  coachId,
  competence,
  today,
  customersById = {},
  modalitiesById = {},
  repasseByModality = [],
}) {
  const { from, to } = monthBounds(competence);
  const historyByContract = new Map();
  coachHistory.forEach(row => {
    if (!historyByContract.has(row.contract_id)) historyByContract.set(row.contract_id, []);
    historyByContract.get(row.contract_id).push(row);
  });
  const attributed = contracts.map(contract => ({
    ...contract,
    coach_id: coachOnDate(contract, referenceDate(contract, to), historyByContract),
  }));
  const movement = buildAssessmentMovement(attributed, plans, { from, to, asOf: today, coachId });
  const modalityName = id => modalitiesById[id]?.name || 'Sem modalidade';
  const person = row => ({
    aluno: customersById[row.customerId]?.full_name || row.contractNumber || 'Aluno',
    modalidade: row.modalityId ? modalityName(row.modalityId) : '',
    data: row.date,
  });
  const people = rows => sortByStudentName(rows.map(person));

  const repasse = new Map(repasseByModality.map(item => [String(item.modalidade || '').toLowerCase(), item]));
  const modalidades = movement.byModality.map(row => {
    const nome = modalityName(row.key);
    const money = repasse.get(nome.toLowerCase());
    return {
      modalidade: nome,
      baseStart: row.baseStart,
      entries: row.entries,
      returns: row.returns,
      exits: row.exits,
      baseEnd: row.baseEnd,
      alunosRepasse: money?.alunos || 0,
      repasse: money?.total || 0,
    };
  });
  // Modalidade que só aparece no repasse (por exemplo, liderança).
  repasseByModality.forEach(item => {
    if (!modalidades.some(row => row.modalidade.toLowerCase() === String(item.modalidade || '').toLowerCase())) {
      modalidades.push({
        modalidade: item.modalidade || 'Outros',
        baseStart: 0, entries: 0, returns: 0, exits: 0, baseEnd: 0,
        alunosRepasse: item.alunos || 0,
        repasse: item.total || 0,
      });
    }
  });

  return {
    from,
    to: movement.to,
    partial: movement.to < to,
    kpis: movement.kpis,
    entradas: people(movement.lists.entries),
    retornos: people(movement.lists.returns),
    saidas: people(movement.lists.exits),
    modalidades: modalidades.sort((a, b) => b.baseEnd - a.baseEnd || b.repasse - a.repasse),
  };
}
