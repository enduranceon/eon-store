import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCoachPanorama, coachOnDate, monthBounds, sortByStudentName } from './coach-statement-panorama.js';

const plans = [
  { id: 'run', modality_id: 'm-run', price_monthly: 300 },
  { id: 'tri', modality_id: 'm-tri', price_monthly: 400 },
];
const modalitiesById = { 'm-run': { name: 'Corrida' }, 'm-tri': { name: 'Triathlon' } };
const customersById = Object.fromEntries(
  ['Álvaro', 'bruna', 'Carlos', 'Débora', 'Eduardo', 'Fernanda'].map((name, index) => [`c${index + 1}`, { full_name: `${name} Fictício` }]),
);

function contract(overrides) {
  return {
    plan_id: 'run', coach_id: 'k1', status: 'active', payment_status: 'paid',
    start_date: '2026-01-05', end_date: '2027-01-05', created_at: '2026-01-05T12:00:00Z', ...overrides,
  };
}

test('ordem alfabética sem diferenciar acento e maiúscula', () => {
  const sorted = sortByStudentName([{ aluno: 'Carlos' }, { aluno: 'bruna' }, { aluno: 'Álvaro' }, { aluno: 'Ana 10' }, { aluno: 'Ana 9' }]);
  assert.deepEqual(sorted.map(item => item.aluno), ['Álvaro', 'Ana 9', 'Ana 10', 'bruna', 'Carlos']);
  assert.deepEqual(monthBounds('2026-09-01'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(monthBounds('2024-02-01T00:00:00Z'), { from: '2024-02-01', to: '2024-02-29' });
});

test('coach na data pelo histórico de troca', () => {
  const history = new Map([['x', [
    { contract_id: 'x', coach_id: 'k1', started_at: '2026-01-05', ended_at: '2026-10-14' },
    { contract_id: 'x', coach_id: 'k2', started_at: '2026-10-15', ended_at: null },
  ]]]);
  const row = { id: 'x', coach_id: 'k2' };
  assert.equal(coachOnDate(row, '2026-09-30', history), 'k1');
  assert.equal(coachOnDate(row, '2026-10-20', history), 'k2');
  assert.equal(coachOnDate({ id: 'y', coach_id: 'k3' }, '2026-09-30', history), 'k3');
});

test('panorama de setembro do coach: números, nomes em ordem e modalidades', () => {
  const contracts = [
    contract({ id: 'a', customer_id: 'c3', start_date: '2026-09-10', end_date: '2026-10-10' }),                     // entrada
    contract({ id: 'b', customer_id: 'c2', status: 'cancelled', cancellation_date: '2026-09-20' }),                 // saída
    contract({ id: 'c', customer_id: 'c1', plan_id: 'tri', start_date: '2026-09-02', end_date: '2026-12-02' }),     // entrada
    contract({ id: 'd', customer_id: 'c4' }),                                                                       // base
    contract({ id: 'e', customer_id: 'c5', coach_id: 'k2' }),                                                       // outro coach
    contract({ id: 'f', customer_id: 'c6', coach_id: 'k2' }),                                                       // trocou depois do mês
  ];
  const coachHistory = [
    { contract_id: 'f', coach_id: 'k1', started_at: '2026-01-05', ended_at: '2026-10-04' },
    { contract_id: 'f', coach_id: 'k2', started_at: '2026-10-05', ended_at: null },
  ];
  const panorama = buildCoachPanorama({
    contracts, plans, coachHistory, coachId: 'k1', competence: '2026-09-01', today: '2026-10-09',
    customersById, modalitiesById,
    repasseByModality: [{ modalidade: 'Corrida', total: 900, alunos: 3 }, { modalidade: 'Triathlon', total: 200, alunos: 1 }, { modalidade: 'Outros', total: 50, alunos: 0 }],
  });
  assert.equal(panorama.partial, false);
  assert.deepEqual(
    [panorama.kpis.baseStart, panorama.kpis.entries, panorama.kpis.exits, panorama.kpis.baseEnd],
    [3, 2, 1, 4],
  );
  assert.deepEqual(panorama.entradas.map(row => [row.aluno, row.modalidade, row.data]), [
    ['Álvaro Fictício', 'Triathlon', '2026-09-02'],
    ['Carlos Fictício', 'Corrida', '2026-09-10'],
  ]);
  assert.deepEqual(panorama.saidas.map(row => row.aluno), ['bruna Fictício']);
  assert.deepEqual(panorama.modalidades.map(row => [row.modalidade, row.baseStart, row.entries, row.exits, row.baseEnd, row.repasse]), [
    ['Corrida', 3, 1, 1, 3, 900],
    ['Triathlon', 0, 1, 0, 1, 200],
    ['Outros', 0, 0, 0, 0, 50],
  ]);
});

test('mês corrente fica marcado como parcial', () => {
  const panorama = buildCoachPanorama({ contracts: [], plans, coachId: 'k1', competence: '2026-10-01', today: '2026-10-09' });
  assert.equal(panorama.partial, true);
  assert.equal(panorama.to, '2026-10-09');
});
