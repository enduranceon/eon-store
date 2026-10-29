import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyFamilyForm,
  groupPlansByFamily,
  planLinkUrl,
  prepareFamilyPlans,
} from './plan-families.js';
import { emptyPlanLinkForm, installmentText, preparePlanLinkSubmission, regionFromLink } from './plan-link-form.js';

const families = [
  { id: 'f1', modality_id: 'run', name: 'Corrida - Essencial', active: true },
  { id: 'f2', modality_id: 'run', name: 'Corrida - Antigo', active: false },
];
const plans = [
  { id: 's', modality_id: 'run', family_id: 'f1', period_months: 6, active: true, name: 'Semestral' },
  { id: 'm', modality_id: 'run', family_id: 'f1', period_months: 1, active: true, name: 'Mensal' },
  { id: 'm-old', modality_id: 'run', family_id: 'f1', period_months: 1, active: false, name: 'Mensal antigo' },
  { id: 'loose', modality_id: 'run', family_id: null, period_months: 1, active: true, name: 'Avulso' },
  { id: 'gone', modality_id: 'run', family_id: null, period_months: 1, active: false, name: 'Sistema antigo' },
  { id: 'tri', modality_id: 'tri', family_id: null, period_months: 3, active: true, name: 'Triathlon' },
];

test('plans are shown inside their group, in order of duration', () => {
  const grouped = groupPlansByFamily(plans, families);
  const run = grouped.get('run');
  assert.deepEqual(run.families.map(item => item.family.id), ['f1']);
  assert.deepEqual(run.families[0].plans.map(plan => plan.id), ['m', 's']);
  assert.deepEqual(run.loose.map(plan => plan.id), ['loose']);
  assert.deepEqual(grouped.get('tri').loose.map(plan => plan.id), ['tri']);
  const all = groupPlansByFamily(plans, families, { showInactive: true }).get('run');
  assert.deepEqual(all.families.map(item => item.family.id), ['f1', 'f2']);
  assert.deepEqual(all.families[0].plans.map(plan => plan.id), ['m', 'm-old', 's']);
});

test('the WhatsApp link can carry the coach', () => {
  assert.equal(planLinkUrl('https://eon-store.netlify.app/', 'abc123abc123abc123ab'), 'https://eon-store.netlify.app/plano/abc123abc123abc123ab');
  assert.equal(planLinkUrl('https://x.test', 'tok', { coach: 'coach-1' }), 'https://x.test/plano/tok?coach=coach-1');
  assert.equal(planLinkUrl('https://x.test', 'tok', { region: 'online' }), 'https://x.test/plano/tok?regiao=online');
  assert.equal(planLinkUrl('https://x.test', 'tok', { coach: 'coach-1', region: 'florianopolis' }), 'https://x.test/plano/tok?coach=coach-1&regiao=florianopolis');
});

test('only a known region from the link is used', () => {
  assert.equal(regionFromLink('online'), 'online');
  assert.equal(regionFromLink(' Florianopolis '), 'florianopolis');
  assert.equal(regionFromLink('constructor'), '');
  assert.equal(regionFromLink('sao-paulo'), '');
  assert.equal(regionFromLink(null), '');
});

test('a new plan creates every duration at once', () => {
  const form = emptyFamilyForm('run', 'center');
  form.name = '  Corrida   Birobiro ';
  form.durations[1].total = '210';
  form.durations[3].total = '585';
  form.durations[6].total = '1110';
  const { family, plans: created } = prepareFamilyPlans(form);
  assert.deepEqual(family, { modality_id: 'run', name: 'Corrida Birobiro' });
  assert.deepEqual(created.map(plan => [plan.name, plan.period, plan.price_monthly, plan.price_total, plan.max_installments]), [
    ['Corrida Birobiro - Mensal', 'mensal', 210, 210, 1],
    ['Corrida Birobiro - Trimestral', 'trimestral', 195, 585, 3],
    ['Corrida Birobiro - Semestral', 'semestral', 185, 1110, 6],
  ]);
  form.durations[1].enabled = false;
  assert.equal(prepareFamilyPlans(form).plans.length, 2);
  form.durations[3].total = '';
  assert.equal(prepareFamilyPlans(form).error, 'Informe o valor total do trimestral');
  assert.equal(prepareFamilyPlans({ ...form, name: '' }).error, 'Dê um nome ao plano');
});

test('the link form needs the choice, the person and the address', () => {
  const form = {
    ...emptyPlanLinkForm(),
    plan_id: 'p', coach_id: 'c', full_name: ' pessoa  link ', whatsapp: '(48) 99999-0601', email: 'A@B.test',
    cpf: '529.982.247-25', birth_date: '25/03/1990', address_zip: '88000-000', address_street: 'Rua', address_number: '10',
    address_neighborhood: 'Centro', address_city: 'Florianópolis', address_state: 'sc', confirmed: true,
  };
  const { body } = preparePlanLinkSubmission(form, { token: 'tok', requestId: 'req' });
  assert.equal(body.full_name, 'pessoa link');
  assert.equal(body.whatsapp, '+5548999990601');
  assert.equal(body.cpf, '52998224725');
  assert.equal(body.birth_date, '1990-03-25');
  assert.equal(body.gender, '');
  assert.equal(body.address_state, 'SC');
  assert.equal(body.region, null);
  assert.equal(preparePlanLinkSubmission({ ...form, full_name: 'Pessoa' }, {}).error, 'Informe o nome completo');
  assert.equal(preparePlanLinkSubmission({ ...form, cpf: '111.111.111-11' }, {}).error, 'Informe um CPF válido');
  assert.equal(preparePlanLinkSubmission({ ...form, birth_date: '' }, {}).error, 'Informe a data de nascimento');
  assert.equal(preparePlanLinkSubmission({ ...form, confirmed: false }, {}).error, 'Confirme que os dados estão corretos');
  assert.equal(preparePlanLinkSubmission({ ...form, plan_id: '' }, {}).error, 'Escolha a duração do plano');
  assert.deepEqual(installmentText({ price_total: 1110, max_installments: 6 }), { parts: 6, value: 185 });
});
