import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSitePlans, periodLabel, sitePlanForm, sitePlanKey, sitePlanOptions } from './coach-site-plans.js';

const plans = [
  { id: 'run-1', modality_id: 'run', period_months: 1, price_monthly: 240, active: true },
  { id: 'run-1e', modality_id: 'run', period_months: 1, price_monthly: 210, active: true },
  { id: 'run-3', modality_id: 'run', period_months: 3, price_monthly: 220, active: true },
  { id: 'run-6-old', modality_id: 'run', period_months: 6, price_monthly: 150, active: false },
  { id: 'tri-1', modality_id: 'tri', period_months: 1, price_monthly: 350, active: true },
];

test('durações da modalidade com os planos ativos, do mais barato ao mais caro', () => {
  const options = sitePlanOptions(plans, 'run');
  assert.deepEqual(options.map(option => [option.label, option.plans.map(plan => plan.id)]), [
    ['Mensal', ['run-1e', 'run-1']],
    ['Trimestral', ['run-3']],
  ]);
  assert.equal(periodLabel(6), 'Semestral');
  assert.equal(periodLabel(24), '24 meses');
});

test('o formulário vira criações, trocas e remoções', () => {
  const rows = [
    { id: 'r1', coach_id: 'k1', modality_id: 'run', period_months: 1, plan_id: 'run-1' },
    { id: 'r2', coach_id: 'k1', modality_id: 'run', period_months: 3, plan_id: 'run-3' },
    { id: 'r3', coach_id: 'k1', modality_id: 'tri', period_months: 1, plan_id: 'tri-1' },
    { id: 'r4', coach_id: 'k2', modality_id: 'run', period_months: 1, plan_id: 'run-1' },
  ];
  assert.deepEqual(sitePlanForm(rows, 'k1'), { 'run:1': 'run-1', 'run:3': 'run-3', 'tri:1': 'tri-1' });
  const selection = {
    [sitePlanKey('run', 1)]: 'run-1e', // troca
    [sitePlanKey('run', 3)]: '',       // volta para os planos gerais
    [sitePlanKey('run', 6)]: 'run-6',  // nova
    [sitePlanKey('tri', 1)]: 'tri-1',  // modalidade desmarcada
  };
  assert.deepEqual(diffSitePlans(rows, 'k1', selection, ['run']), {
    creates: [{ coach_id: 'k1', modality_id: 'run', period_months: 6, plan_id: 'run-6' }],
    updates: [{ id: 'r1', plan_id: 'run-1e' }],
    deletes: ['r2', 'r3'],
  });
  assert.deepEqual(diffSitePlans(rows, 'k1', sitePlanForm(rows, 'k1'), ['run', 'tri']), { creates: [], updates: [], deletes: [] });
});
