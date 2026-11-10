import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterRegistrations, formatPhone, groupRegistrations, groupSummaryOf, paymentInfo, splitEvents, whatsappLink,
} from './coach-events.js';

const ev = (id, event_date, end_date = null, name = id) => ({ id, name, event_date, end_date });

test('events split into upcoming (nearest first) and past (latest first)', () => {
  const { upcoming, past } = splitEvents([
    ev('a', '2026-12-10'), ev('b', '2026-11-20'), ev('c', '2026-10-01'), ev('d', '2026-09-01'),
  ], '2026-11-10');
  assert.deepEqual(upcoming.map(item => item.id), ['b', 'a']);
  assert.deepEqual(past.map(item => item.id), ['c', 'd']);
});

test('a multi-day event still happening is upcoming and today counts as not past', () => {
  const { upcoming, past } = splitEvents([ev('long', '2026-11-08', '2026-11-12'), ev('today', '2026-11-10'), ev('over', '2026-11-08', '2026-11-09')], '2026-11-10');
  assert.deepEqual(upcoming.map(item => item.id).sort(), ['long', 'today']);
  assert.deepEqual(past.map(item => item.id), ['over']);
});

test('registrations are grouped by payment', () => {
  const groups = groupRegistrations([{ payment: 'paid' }, { payment: 'not_paid' }, { payment: 'cancelled' }, { payment: 'paid' }]);
  assert.equal(groups.paid.length, 2);
  assert.equal(groups.notPaid.length, 1);
  assert.equal(groups.cancelled.length, 1);
});

test('the search ignores accents and case, and the filter keeps only paid people still to add', () => {
  const list = [
    { person_name: 'José da Silva', payment: 'paid', whatsapp_group_status: 'pending' },
    { person_name: 'Joana Souza', payment: 'paid', whatsapp_group_status: 'added' },
    { person_name: 'Jonas Lima', payment: 'not_paid', whatsapp_group_status: null },
    { person_name: 'Ana Jose', payment: 'paid', whatsapp_group_status: 'declined' },
  ];
  assert.deepEqual(filterRegistrations(list, { query: 'jose' }).map(item => item.person_name), ['José da Silva', 'Ana Jose']);
  assert.deepEqual(filterRegistrations(list, { query: '  JOÃ ' }).map(item => item.person_name), ['Joana Souza']);
  assert.deepEqual(filterRegistrations(list, { onlyMissingGroup: true }).map(item => item.person_name), ['José da Silva']);
  assert.equal(filterRegistrations(list, {}).length, 4);
});

test('the group summary only exists for events with a group', () => {
  assert.equal(groupSummaryOf({ group_added: null }), null);
  assert.equal(groupSummaryOf(null), null);
  assert.deepEqual(groupSummaryOf({ group_added: 2, group_missing: 3, group_declined: 1 }), { paid: 6, added: 2, pending: 3, declined: 1 });
});

test('the WhatsApp link adds the Brazil code when missing and refuses short numbers', () => {
  assert.equal(whatsappLink('11900009801'), 'https://wa.me/5511900009801');
  assert.equal(whatsappLink('5511900009801'), 'https://wa.me/5511900009801');
  assert.equal(whatsappLink('(11) 90000-9801'), 'https://wa.me/5511900009801');
  assert.equal(whatsappLink('1234'), null);
  assert.equal(whatsappLink(null), null);
});

test('phones are shown in a readable way', () => {
  assert.equal(formatPhone('5511900009801'), '(11) 90000-9801');
  assert.equal(formatPhone('11900009801'), '(11) 90000-9801');
  assert.equal(formatPhone('1133334444'), '(11) 3333-4444');
  assert.equal(formatPhone('abc'), 'abc');
  assert.equal(formatPhone(null), '');
});

test('an unknown payment falls back to not paid', () => {
  assert.equal(paymentInfo('paid').label, 'Pago');
  assert.equal(paymentInfo('cancelled').label, 'Cancelada');
  assert.equal(paymentInfo('whatever').label, 'Não pago');
});
