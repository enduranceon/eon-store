import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agoLabel, attentionItems, avatarTone, contractProgress, dayNumber, daysBetween, daysLeftLabel, eventCountdown, filterCounts, filterStudents,
  greetingFor, initialsOf, longDateLabel, modalitiesOf, modalityShares, modalityTone, periodSentence, periodSummary,
  planLabel, registrationShares, relativeDays, shortDateLabel, sortStudents, studentAttention,
} from './coach-ui.js';

const TODAY = '2026-11-10';
const student = (name, ends_on, key = 'active', extra = {}) => ({
  name, modality: 'corrida', plan: 'Corrida - Mensal', started_on: '2026-08-10', ends_on,
  situation: { key, label: key }, ...extra,
});

test('day arithmetic ignores time zones and handles month and year changes', () => {
  assert.equal(daysBetween('2026-11-10', '2026-11-12'), 2);
  assert.equal(daysBetween('2026-11-10', '2026-11-09'), -1);
  assert.equal(daysBetween('2026-12-30', '2027-01-02'), 3);
  assert.equal(daysBetween('2026-02-27', '2026-03-01'), 2);
  assert.equal(daysBetween('', '2026-11-12'), null);
  assert.equal(daysBetween('2026-11-10', 'nada'), null);
  assert.equal(dayNumber('2026-11-10T22:30:00-03:00'), dayNumber('2026-11-10'));
});

test('greeting follows the hour of the day', () => {
  assert.equal(greetingFor(4), 'Boa noite');
  assert.equal(greetingFor(5), 'Bom dia');
  assert.equal(greetingFor(11), 'Bom dia');
  assert.equal(greetingFor(12), 'Boa tarde');
  assert.equal(greetingFor(17), 'Boa tarde');
  assert.equal(greetingFor(18), 'Boa noite');
  assert.equal(greetingFor(23), 'Boa noite');
});

test('dates are written in Portuguese without depending on the device time zone', () => {
  assert.equal(longDateLabel('2026-11-10'), 'terça-feira, 10 de novembro');
  assert.equal(longDateLabel('2026-12-01'), 'terça-feira, 1 de dezembro');
  assert.equal(longDateLabel(''), '');
  assert.equal(shortDateLabel('2026-11-08'), '08/11');
  assert.equal(shortDateLabel(null), '');
});

test('relative days read naturally', () => {
  assert.equal(relativeDays(0), 'hoje');
  assert.equal(relativeDays(1), 'amanhã');
  assert.equal(relativeDays(-1), 'ontem');
  assert.equal(relativeDays(5), 'em 5 dias');
  assert.equal(relativeDays(-3), 'há 3 dias');
  assert.equal(relativeDays(null), '');
});

test('contract progress is clamped between 0 and 100 and says how many days are left', () => {
  const half = contractProgress({ started_on: '2026-10-01', ends_on: '2026-12-01' }, '2026-10-31');
  assert.equal(half.percent, 49);
  assert.equal(half.daysLeft, 31);
  assert.equal(contractProgress({ started_on: '2026-10-01', ends_on: '2026-10-20' }, '2026-11-10').percent, 100);
  assert.equal(contractProgress({ started_on: '2026-12-01', ends_on: '2027-01-01' }, '2026-11-10').percent, 0);
  assert.equal(contractProgress({ started_on: '2026-10-01', ends_on: '' }, TODAY), null);
  assert.equal(contractProgress({ started_on: '2026-10-01', ends_on: '2026-10-01' }, TODAY), null);
});

test('attention: expired, ending soon, renewal in progress and leave; everyone else is fine', () => {
  assert.deepEqual(
    ['2026-11-07', '2026-11-10', '2026-11-17', '2026-11-25', '2026-12-10', '2026-12-11'].map(day => studentAttention(student('A', day), TODAY)?.label ?? null),
    ['Venceu há 3 dias', 'Vence hoje', 'Vence em 7 dias', 'Vence em 15 dias', 'Vence em 30 dias', null],
  );
  assert.equal(studentAttention(student('A', '2026-11-17'), TODAY).tone, 'danger');
  assert.equal(studentAttention(student('A', '2026-11-25'), TODAY).tone, 'warning');
  assert.equal(studentAttention(student('A', '2026-12-05'), TODAY).tone, 'info');
  assert.equal(studentAttention(student('A', '2026-11-12', 'renewal'), TODAY).key, 'renewal');
  assert.equal(studentAttention(student('A', '2026-11-12', 'leave'), TODAY).key, 'leave');
  assert.equal(studentAttention(student('A', ''), TODAY), null);
});

test('attention list goes from the most urgent to the least, with a stable tie-break', () => {
  const list = attentionItems([
    student('Zeca', '2026-11-20'), student('Ana', '2026-11-20'), student('Lia', '2026-11-12', 'leave'),
    student('Bia', '2026-11-12', 'renewal'), student('Caio', '2026-11-05'), student('Dani', '2027-03-01'), student('Edu', '2026-11-11'),
  ], TODAY);
  assert.deepEqual(list.map(item => item.student.name), ['Caio', 'Edu', 'Ana', 'Zeca', 'Bia', 'Lia']);
});

test('filters count and select students by what needs attention, name and modality', () => {
  const list = [
    student('Ana Souza', '2026-11-12'),
    student('Bruno Lima', '2026-12-30', 'renewal', { modality: 'triathlon', plan: 'Triathlon - Anual' }),
    student('Carla Dias', '2026-11-01', 'leave'),
    student('Davi Rocha', '2027-02-01', 'active', { modality: 'natação' }),
    student('Eva Álvares', '2026-11-02'),
  ];
  assert.deepEqual(filterCounts(list, TODAY), { todos: 5, vencendo: 2, renovacao: 1, licenca: 1 });
  assert.deepEqual(filterStudents(list, { filter: 'vencendo' }, TODAY).map(item => item.name), ['Ana Souza', 'Eva Álvares']);
  assert.deepEqual(filterStudents(list, { filter: 'licenca' }, TODAY).map(item => item.name), ['Carla Dias']);
  assert.deepEqual(filterStudents(list, { query: 'ALVARES' }, TODAY).map(item => item.name), ['Eva Álvares']);
  assert.deepEqual(filterStudents(list, { modality: 'Natacao' }, TODAY).map(item => item.name), ['Davi Rocha']);
  assert.equal(filterStudents(list, { filter: 'renovacao', query: 'ana' }, TODAY).length, 0);
  assert.equal(filterStudents(list, {}, TODAY).length, 5);
});

test('sorting by name, due date and start date', () => {
  const list = [
    student('Carla', '2026-12-01', 'active', { started_on: '2026-05-01' }),
    student('Ana', '2027-01-01', 'active', { started_on: '2026-09-01' }),
    student('Bia', '', 'active', { started_on: '' }),
    student('Dani', '2026-11-20', 'active', { started_on: '2026-07-01' }),
  ];
  assert.deepEqual(sortStudents(list, 'nome').map(item => item.name), ['Ana', 'Bia', 'Carla', 'Dani']);
  assert.deepEqual(sortStudents(list, 'vencimento').map(item => item.name), ['Dani', 'Carla', 'Ana', 'Bia']);
  assert.deepEqual(sortStudents(list, 'novos').map(item => item.name), ['Ana', 'Dani', 'Carla', 'Bia']);
  assert.deepEqual(sortStudents(list, 'antigos').map(item => item.name), ['Carla', 'Dani', 'Ana', 'Bia']);
  assert.deepEqual(list.map(item => item.name), ['Carla', 'Ana', 'Bia', 'Dani'], 'does not reorder the original');
});

test('modalities are listed once, ignoring accents and case', () => {
  assert.deepEqual(modalitiesOf([{ modality: 'natação' }, { modality: 'Corrida' }, { modality: 'natacao' }, { modality: '' }, { modality: 'corrida' }]), ['Corrida', 'natação']);
});

test('the plan name does not repeat the modality', () => {
  assert.equal(planLabel({ modality: 'corrida', plan: 'Corrida - Semestral' }), 'Semestral');
  assert.equal(planLabel({ modality: 'natação', plan: 'Natação · Trimestral' }), 'Trimestral');
  assert.equal(planLabel({ modality: 'natação', plan: 'NATACAO Mensal' }), 'Mensal');
  assert.equal(planLabel({ modality: 'corrida', plan: 'Plano Anual' }), 'Plano Anual');
  assert.equal(planLabel({ modality: 'corrida', plan: 'Corrida' }), 'Corrida');
  assert.equal(planLabel({ modality: '', plan: 'Anual' }), 'Anual');
  assert.equal(planLabel({ modality: 'corrida', plan: '' }), '');
});

test('initials and colours are stable for the same name', () => {
  assert.equal(initialsOf('Ana Souza'), 'AS');
  assert.equal(initialsOf('joão pedro de Souza Cardoso'), 'JC');
  assert.equal(initialsOf('Madonna'), 'M');
  assert.equal(initialsOf(''), '?');
  assert.equal(avatarTone('Ana Souza'), avatarTone('ana souza'));
  assert.equal(modalityTone('Natação'), modalityTone('natacao'));
  assert.notEqual(modalityTone('corrida'), modalityTone('triathlon'));
  assert.equal(modalityTone('pilates'), modalityTone('pilates'));
});

test('modality shares add up to 100 and start with the largest', () => {
  const shares = modalityShares([{ modality: 'natação', students: 1 }, { modality: 'corrida', students: 1 }, { modality: 'triathlon', students: 1 }]);
  assert.equal(shares.reduce((sum, item) => sum + item.percent, 0), 100);
  assert.deepEqual(modalityShares([{ modality: 'a', students: 6 }, { modality: 'b', students: 2 }]).map(item => item.percent), [75, 25]);
  assert.deepEqual(modalityShares([]), []);
  assert.deepEqual(modalityShares([{ modality: 'a', students: 0 }]), []);
});

const month = (label, entries, returns, renewals, exits, base_start, churn_rate = 0) => ({
  label, entries, returns, renewals, exits, base_start, base_end: base_start + entries + returns - exits, net: entries + returns - exits, churn_rate,
});

test('period summary adds the last months and points out the best and hardest months', () => {
  const monthly = [
    month('jun/26', 1, 0, 2, 0, 10), month('jul/26', 3, 1, 1, 1, 11, 9.1), month('ago/26', 0, 0, 2, 2, 14, 14.3), month('set/26', 2, 0, 1, 0, 12),
  ];
  const all = periodSummary(monthly, 12);
  assert.deepEqual([all.entries, all.returns, all.renewals, all.exits, all.net], [6, 1, 6, 3, 4]);
  assert.equal(all.best.label, 'jul/26');
  assert.equal(all.worst.label, 'ago/26');
  assert.equal(all.startBase, 10);
  assert.equal(all.endBase, 14);
  const lastTwo = periodSummary(monthly, 2);
  assert.deepEqual([lastTwo.entries, lastTwo.exits, lastTwo.net, lastTwo.firstLabel, lastTwo.lastLabel], [2, 2, 0, 'ago/26', 'set/26']);
  assert.equal(lastTwo.best.label, 'set/26');
  assert.equal(periodSummary(monthly.slice(2, 3), 1).best, null, 'no month with positive balance');
  assert.equal(periodSummary([], 6).entries, 0);
  const withEmptyStart = [month('mai/26', 1, 0, 0, 0, 0, 0), month('jun/26', 0, 0, 0, 1, 1, 100), month('jul/26', 1, 0, 0, 0, 0, 0), month('ago/26', 0, 0, 0, 1, 4, 25)];
  assert.equal(periodSummary(withEmptyStart, 4).averageChurn, 62.5, 'months that started empty do not count in the average');
});

test('period sentence is plain Portuguese and handles singular, zero and negative balance', () => {
  assert.equal(periodSentence({ entries: 5, returns: 1, exits: 2, net: 4 }, 12), 'Nos últimos 12 meses: 6 alunos entraram, 2 saíram e o saldo de +4.');
  assert.equal(periodSentence({ entries: 1, returns: 0, exits: 1, net: 0 }, 6), 'Nos últimos 6 meses: 1 aluno entrou, 1 saiu e o saldo zerado.');
  assert.equal(periodSentence({ entries: 0, returns: 0, exits: 3, net: -3 }, 6), 'Nos últimos 6 meses: 0 alunos entraram, 3 saíram e o saldo de −3.');
  assert.equal(periodSentence({ entries: 2, returns: 0, exits: 0, net: 2 }, 12), 'Nos últimos 12 meses: 2 alunos entraram, ninguém saiu e o saldo de +2.');
});

test('event countdown: today, tomorrow, soon, far, ongoing and past', () => {
  const at = (event_date, end_date = null) => eventCountdown({ event_date, end_date }, TODAY);
  assert.equal(at('2026-11-10').label, 'É hoje');
  assert.equal(at('2026-11-11').label, 'É amanhã');
  assert.deepEqual([at('2026-11-16').label, at('2026-11-16').tone, at('2026-11-16').soon], ['Em 6 dias', 'warning', true]);
  assert.deepEqual([at('2026-12-05').label, at('2026-12-05').tone, at('2026-12-05').soon], ['Em 25 dias', 'info', false]);
  assert.equal(at('2026-11-08', '2026-11-12').label, 'Acontecendo agora');
  assert.deepEqual([at('2026-10-18').label, at('2026-10-18').past], ['Foi há 23 dias', true]);
  assert.equal(at('2026-11-09').label, 'Foi ontem');
  assert.equal(at(null).label, 'Data a definir');
});

test('registration shares split the bar by status', () => {
  const shares = registrationShares({ paid: 6, not_paid: 3, cancelled: 1 });
  assert.equal(shares.total, 10);
  assert.deepEqual([shares.paid, shares.notPaid, shares.cancelled], [60, 30, 10]);
  assert.equal(registrationShares({}).total, 0);
});

test('days left and time ago are written in plain Portuguese', () => {
  assert.deepEqual([12, 1, 0, -3, null].map(daysLeftLabel), ['faltam 12 dias', 'faltam 1 dia', 'termina hoje', 'venceu há 3 dias', '']);
  assert.deepEqual([0, -1, -12, -59, -60, -200, -364, -365, -800, null].map(agoLabel), ['hoje', 'ontem', 'há 12 dias', 'há 59 dias', 'há 2 meses', 'há 6 meses', 'há 12 meses', 'há 1 ano', 'há 2 anos', '']);
});
