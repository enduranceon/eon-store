import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normalizeSnapshot } from './domain.mjs';

const uuid = n => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
const fixture = () => ({
  snapshot: JSON.parse(readFileSync(new URL('./fixtures/synthetic-snapshot.json', import.meta.url))),
  manifest: JSON.parse(readFileSync(new URL('./fixtures/synthetic-manifest.json', import.meta.url))),
});
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
