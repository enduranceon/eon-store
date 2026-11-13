import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normalizeSnapshot as normalizeDomain } from './domain.mjs';

const uuid = n => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
const fixture = () => ({
  snapshot: JSON.parse(readFileSync(new URL('./fixtures/synthetic-snapshot.json', import.meta.url))),
  manifest: JSON.parse(readFileSync(new URL('./fixtures/synthetic-manifest.json', import.meta.url))),
  operational: JSON.parse(readFileSync(new URL('./fixtures/synthetic-store.json', import.meta.url))),
});
const normalizeSnapshot = (snapshot, manifest, operational = fixture().operational) => normalizeDomain(snapshot, manifest, operational);
const bySource = (result, n) => result.people.find(p => p.sources.some(s => s.id === uuid(n)));

test('counts commercial membership independently of sports pause and benefits', () => {
  const { snapshot, manifest } = fixture();
  const result = normalizeSnapshot(snapshot, manifest);
  assert.equal(result.summary.activeStudents, 4);
  assert.equal(result.summary.benefits, 3);
  assert.equal(result.summary.commercialOnLeave, 1);
  assert.equal(result.summary.team, 2);
  assert.equal(result.summary.partners, 1);
  assert.equal(bySource(result, 1).sportsStatus, 'on_leave');
  assert.equal(bySource(result, 1).inActiveStudents, true);
  assert.equal(bySource(result, 105).sportsStatus, 'active');
  assert.equal(bySource(result, 104).inActiveStudents, false);
  assert.equal(bySource(result, 104).sportsStatus, 'active');
});

test('uses explicit roles, preserves access and unknown benefit dates', () => {
  const { snapshot, manifest } = fixture();
  const result = normalizeSnapshot(snapshot, manifest);
  assert.deepEqual(bySource(result, 107).roles, ['athlete', 'coach']);
  assert.deepEqual(bySource(result, 108).roles, ['athlete']);
  assert.equal(bySource(result, 107).metadata.observedPortalStatus, 'suspended');
  assert.equal(bySource(result, 107).memberships[0].effectiveDate, null);
  assert.equal(bySource(result, 107).memberships[0].billingRequired, false);
  assert.deepEqual(bySource(result, 109).roles, []);
  assert.equal(bySource(result, 109).metadata.coachProfiles[0].active, false);
  assert.equal(bySource(result, 109).metadata.sportsProfilePresent, true);
  assert.equal(bySource(result, 109).metadata.sportsEffectiveDate, null);
});

test('preserves confirmed cancelled aliases and history references on one person', () => {
  const { snapshot, manifest } = fixture();
  const result = normalizeSnapshot(snapshot, manifest);
  const person = bySource(result, 1);
  assert.equal(person, bySource(result, 102));
  assert.equal(person.sources.find(s => s.id === uuid(102)).relationship, 'alias');
  assert.equal(person.metadata.knownHistoryCounts[0].activities, 9);
  assert.equal(person.metadata.sportsHistoryImported, false);
  assert.equal(person.metadata.observedPortalStatus, 'suspended');
  assert.equal(result.summary.sourceLinks, snapshot.store.length + snapshot.hub.length);
});

test('departure never resolves ambiguous identities even for identical names', () => {
  const { snapshot, manifest } = fixture();
  const result = normalizeSnapshot(snapshot, manifest);
  assert.notEqual(bySource(result, 3).id, bySource(result, 103).id);
  assert.equal(bySource(result, 3).category, 'review');
  assert.equal(bySource(result, 103).sportsStatus, 'cancelled');
  assert.equal(bySource(result, 3).sources.length, 1);
  assert.equal(result.summary.historicalReview, 1);
});

test('new athletes remain planned profiles with no fabricated portal or auth', () => {
  const { snapshot, manifest } = fixture();
  const person = bySource(normalizeSnapshot(snapshot, manifest), 2);
  assert.equal(person.needsAthleteProfile, true);
  assert.equal(person.metadata.sportsProfilePresent, false);
  assert.equal(person.metadata.sportsStatusOrigin, 'planned_new_profile');
  assert.equal(person.metadata.observedPortalStatus, null);
  assert.equal(person.metadata.changesAuthOrPermissions, false);
  assert.equal(person.sources.length, 1);
});

test('verified historical correction updates projection without replay or payment invention', () => {
  const { snapshot, manifest } = fixture();
  const result = normalizeSnapshot(snapshot, manifest);
  const person = bySource(result, 6);
  assert.equal(person.inActiveStudents, true);
  assert.equal(person.memberships[0].contracts[0].start, '2026-10-23');
  assert.equal(person.memberships[0].financialStatus, 'not_imported');
  assert.equal(person.memberships[0].chargeAmount, null);
  assert.equal(person.metadata.appliedCommercialCorrection.replay, false);
  assert.equal(result.summary.productionWrites, 0);
});

test('normalization is deterministic, independent of input ordering and does not mutate input', () => {
  const { snapshot, manifest } = fixture();
  const initial = structuredClone({ snapshot, manifest });
  const first = normalizeSnapshot(snapshot, manifest);
  assert.deepEqual({ snapshot, manifest }, initial);
  assert.deepEqual(normalizeSnapshot(snapshot, manifest), first);
  snapshot.store.reverse(); snapshot.hub.reverse();
  assert.deepEqual(normalizeSnapshot(snapshot, manifest), first);
  assert.equal(new Set(first.people.map(p => p.id)).size, first.people.length);
  assert.equal(first.decisions.length, snapshot.decisions.length);
});

test('refuses overlapping source assignments instead of silently merging', () => {
  const { snapshot, manifest } = fixture();
  snapshot.store.find(s => s.store.id === uuid(5)).match.hub_id = uuid(101);
  manifest.operations.identity_link_proposals.find(s => s.store_customer_id === uuid(5)).hub_athlete_id = uuid(101);
  assert.throws(() => normalizeSnapshot(snapshot, manifest), /assigned twice/);
});

test('fails on stale reference date, identity, sports, portal and summary expectations', () => {
  const mutations = [
    (s) => { s.as_of = '2026-11-13'; },
    (s) => { s.store[0].match.hub_id = uuid(108); },
    (s) => { s.hub[0].status = 'cancelled'; },
    (s) => { s.hub[0].portal_status = 'active'; },
    (_, m) => { m.summary.projected_commercial_current_including_leave = 99; },
  ];
  for (const mutate of mutations) {
    const { snapshot, manifest } = fixture(); mutate(snapshot, manifest);
    assert.throws(() => normalizeSnapshot(snapshot, manifest), /Invalid pilot snapshot/);
  }
});

test('refuses zero-price inference or benefit/category mismatch', () => {
  const { snapshot, manifest } = fixture();
  snapshot.benefit_policy_decisions[0].exclude_active_student_count = false;
  assert.throws(() => normalizeSnapshot(snapshot, manifest), /explicit evidence/);
  const other = fixture();
  other.manifest.operations.membership_benefit_assignments[0].membership_category = 'equipe';
  assert.throws(() => normalizeSnapshot(other.snapshot, other.manifest), /category drift/);
});

test('requires decision provenance and unchanged portal expectations for every planned action', () => {
  const mutations = [
    (_, m) => { m.operations.new_athlete_proposals[0].source_decision_id = 'missing'; },
    (_, m) => { m.operations.new_athlete_proposals[0].activate_portal = true; },
    (_, m) => { m.operations.confirmed_historical_aliases_to_preserve[0].source_decision_id = 'missing'; },
    (_, m) => { m.operations.sporting_status_proposals[0].source_decision_id = 'missing'; },
    (_, m) => { m.operations.sporting_status_proposals[0].proposed_status = 'cancelled'; },
    (s) => { s.hub.find(h => h.id === uuid(107)).portal_status = 'active'; },
    (_, m) => { m.operations.membership_benefit_assignments[0].charge_amount = 50; },
  ];
  for (const mutate of mutations) {
    const { snapshot, manifest } = fixture(); mutate(snapshot, manifest);
    assert.throws(() => normalizeSnapshot(snapshot, manifest), /Invalid pilot snapshot/);
  }
});

test('fails rather than dropping customers or reactivating an alleged historical alias', () => {
  const missing = fixture();
  missing.manifest.historical_identity_hold_queue = [];
  assert.throws(() => normalizeSnapshot(missing.snapshot, missing.manifest), /identity disposition/);
  const duplicate = fixture();
  duplicate.snapshot.hub.push(structuredClone(duplicate.snapshot.hub[0]));
  assert.throws(() => normalizeSnapshot(duplicate.snapshot, duplicate.manifest), /duplicate or missing Hub/);
  const alias = fixture();
  alias.snapshot.hub.find(h => h.id === uuid(102)).status = 'active';
  assert.throws(() => normalizeSnapshot(alias.snapshot, alias.manifest), /not cancelled/);
});

test('customer status, coach, modality and counts come solely from Store', () => {
  const { snapshot, manifest, operational } = fixture();
  const store = snapshot.store.find(r => r.store.id === uuid(1)).store;
  store.active_contracts[0].coach = 'Coach da Store';
  store.active_contracts[0].modality = 'triathlon';
  Object.assign(operational.customers[0], {coach: 'Coach da Store', modality: 'triathlon'});
  const result = normalizeSnapshot(snapshot, manifest, operational);
  const person = bySource(result, 1);
  assert.deepEqual(person.customerStatus, { key: 'on_leave', label: 'Em licença', source: 'store' });
  assert.equal(person.coach, 'Coach da Store');
  assert.equal(person.modality, 'triathlon');
  assert.equal(person.storeAuthority, true);
  assert.equal(result.summary.storeOnLeave, 1);
  assert.equal(person.metadata.hubProfiles[0].observed.coach, 'Coach Exemplo');
  assert.equal(person.metadata.hubProfiles[0].observed.modality, 'corrida');
  assert.deepEqual(bySource(result, 3).customerStatus, { key: 'inactive', label: 'Inativo', source: 'store' });
});

test('missing Store fields stay unknown even when Hub has a populated profile', () => {
  const { snapshot, manifest, operational } = fixture();
  const contract = snapshot.store.find(r => r.store.id === uuid(5)).store.active_contracts[0];
  delete contract.coach; delete contract.modality;
  Object.assign(operational.customers.find(c => c.customerId === uuid(5)), {coach: null, modality: null});
  const person = bySource(normalizeSnapshot(snapshot, manifest, operational), 5);
  assert.equal(person.coach, null);
  assert.equal(person.modality, null);
  assert.equal(person.metadata.hubProfiles[0].observed.modality, 'corrida');
});

test('benefits do not invent a lifecycle, and Hub archives do not create active customers', () => {
  const { snapshot, manifest } = fixture();
  const result = normalizeSnapshot(snapshot, manifest);
  assert.deepEqual(bySource(result, 107).customerStatus, {
    key: null, label: 'Sem contrato', source: 'confirmed_benefit',
  });
  assert.equal(bySource(result, 107).storeAuthority, false);
  assert.equal(bySource(result, 103).storeAuthority, false);
  assert.deepEqual(bySource(result, 103).customerStatus, { key: null, label: null, source: 'unresolved' });
  assert.equal(bySource(result, 103).category, 'historical');
  assert.equal(result.summary.operationalPeople, snapshot.store.length + 2);
});

test('Hub status cannot override a Store customer role or membership', () => {
  const { snapshot, manifest } = fixture();
  snapshot.hub.find(h => h.id === uuid(106)).status = 'cancelled';
  delete manifest.summary.projected_all_with_sporting_status_active;
  const person = bySource(normalizeSnapshot(snapshot, manifest), 6);
  assert.equal(person.inActiveStudents, true);
  assert.deepEqual(person.roles, ['athlete']);
  assert.equal(person.customerStatus.key, 'active');
  assert.equal(person.metadata.observedSportsStatus, 'cancelled');
});

test('Store payment status takes label priority while a current license still counts as a license', () => {
  const { snapshot, manifest, operational } = fixture();
  operational.customers[0].status = 'overdue';
  const result = normalizeSnapshot(snapshot, manifest, operational);
  assert.deepEqual(bySource(result, 1).customerStatus, { key: 'overdue', label: 'Inadimplente', source: 'store' });
  assert.equal(result.summary.storeOnLeave, 1);
  assert.equal(result.summary.activeStudents, 4);
});

test('raw contract status never substitutes the canonical customer status', () => {
  const { snapshot, manifest, operational } = fixture();
  operational.customers.find(c => c.customerId === uuid(3)).contractStatus = 'voided';
  const person = bySource(normalizeSnapshot(snapshot, manifest, operational), 3);
  assert.deepEqual(person.customerStatus, { key: 'inactive', label: 'Inativo', source: 'store' });
  assert.equal(person.memberships[0].contracts[0].status, 'voided');
});

test('requires complete scoped Store projection with matching reference and current cohort', () => {
  const changes = [
    op => { op.project = 'different-project'; },
    op => { op.asOf = '2026-11-13'; },
    op => { op.rule = 'unverified-custom-rule'; },
    op => { op.customers.pop(); },
    op => { op.customers.push(structuredClone(op.customers[0])); },
    op => { op.customers[0].countsAsActive = false; },
    op => { Object.assign(op.customers[0], { status: 'inactive', countsAsActive: false, onLeave: false }); },
  ];
  for (const change of changes) {
    const { snapshot, manifest, operational } = fixture(); change(operational);
    assert.throws(() => normalizeSnapshot(snapshot, manifest, operational), /Invalid pilot snapshot/);
  }
});

test('missing operational projection leaves customer status unknown instead of inventing it', () => {
  const { snapshot, manifest } = fixture();
  const person = bySource(normalizeDomain(snapshot, manifest), 1);
  assert.deepEqual(person.customerStatus, { key: null, label: null, source: 'unresolved' });
  assert.equal(person.inActiveStudents, true);
  assert.equal(person.metadata.observedSportsStatus, 'active');
});
