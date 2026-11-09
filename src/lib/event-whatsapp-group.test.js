import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canChangeWhatsappGroup, groupStatusOf, isMissingFromGroup, responsibleCoachIds, sameCoachSet,
  selectableCoaches, summarizeWhatsappGroup, summaryText, whatsappGroupLabel,
} from './event-whatsapp-group.js';

const reg = (payment_status, whatsapp_group_status) => ({ payment_status, whatsapp_group_status });

test('only a paid registration in an event with a group can be changed', () => {
  assert.equal(canChangeWhatsappGroup({ whatsapp_group_enabled: true }, reg('paid')), true);
  assert.equal(canChangeWhatsappGroup({ whatsapp_group_enabled: true }, reg('pending')), false);
  assert.equal(canChangeWhatsappGroup({ whatsapp_group_enabled: true }, reg('cancelled')), false);
  assert.equal(canChangeWhatsappGroup({ whatsapp_group_enabled: false }, reg('paid')), false);
  assert.equal(canChangeWhatsappGroup(null, reg('paid')), false);
});

test('the summary counts only paid registrations and treats a missing situation as not added', () => {
  const summary = summarizeWhatsappGroup([
    reg('paid', 'added'), reg('paid', 'added'), reg('paid', 'pending'), reg('paid'), reg('paid', 'declined'),
    reg('pending', 'pending'), reg('charge_sent'), reg('cancelled', 'added'), reg('refunded'),
  ]);
  assert.deepEqual(summary, { paid: 5, added: 2, pending: 2, declined: 1 });
});

test('the summary text reads naturally in singular and plural', () => {
  assert.equal(summaryText({ paid: 0, added: 0, pending: 0, declined: 0 }), 'Nenhuma inscrição paga ainda.');
  assert.equal(summaryText({ paid: 1, added: 1, pending: 0, declined: 0 }), '1 de 1 pago já está no grupo · ninguém falta adicionar');
  assert.equal(summaryText({ paid: 5, added: 2, pending: 2, declined: 1 }), '2 de 5 pagos já estão no grupo · 2 faltam adicionar · 1 não quer entrar');
  assert.equal(summaryText({ paid: 4, added: 1, pending: 1, declined: 2 }), '1 de 4 pagos já está no grupo · 1 falta adicionar · 2 não querem entrar');
});

test('who is missing from the group is the paid person still not added', () => {
  assert.equal(isMissingFromGroup(reg('paid', 'pending')), true);
  assert.equal(isMissingFromGroup(reg('paid')), true);
  assert.equal(isMissingFromGroup(reg('paid', 'added')), false);
  assert.equal(isMissingFromGroup(reg('paid', 'declined')), false);
  assert.equal(isMissingFromGroup(reg('pending', 'pending')), false);
});

test('situation labels fall back to not added for unknown values', () => {
  assert.equal(whatsappGroupLabel('added'), 'No grupo');
  assert.equal(whatsappGroupLabel('declined'), 'Não quer entrar');
  assert.equal(whatsappGroupLabel('whatever'), 'Falta adicionar');
  assert.equal(groupStatusOf({ whatsapp_group_status: 'whatever' }), 'pending');
});

test('responsible coaches of one event are listed in a stable order', () => {
  const links = [
    { event_id: 'e1', coach_id: 'c2' }, { event_id: 'e2', coach_id: 'c9' }, { event_id: 'e1', coach_id: 'c1' },
  ];
  assert.deepEqual(responsibleCoachIds(links, 'e1'), ['c1', 'c2']);
  assert.deepEqual(responsibleCoachIds(links, 'e3'), []);
});

test('two coach lists are the same set regardless of order and repetition', () => {
  assert.equal(sameCoachSet(['a', 'b'], ['b', 'a', 'a']), true);
  assert.equal(sameCoachSet(['a'], ['a', 'b']), false);
  assert.equal(sameCoachSet([], []), true);
});

test('inactive coaches only stay selectable when they are already responsible', () => {
  const coaches = [
    { id: 'z', name: 'Zélia', active: true }, { id: 'a', name: 'Ana', active: true }, { id: 'i', name: 'Inativo', active: false },
  ];
  assert.deepEqual(selectableCoaches(coaches, []).map(c => c.id), ['a', 'z']);
  assert.deepEqual(selectableCoaches(coaches, ['i']).map(c => c.id), ['a', 'i', 'z']);
});
