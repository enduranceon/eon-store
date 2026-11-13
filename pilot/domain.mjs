import { createHash } from 'node:crypto';
import { ACTIVE_CONTRACT_STATUSES } from '../supabase/functions/_shared/assessment-metrics/assessment-contract-lifecycle.js';

const clone = value => structuredClone(value);
const fail = message => { throw new Error(`Invalid pilot snapshot: ${message}`); };
const indexed = (items, key, label) => {
  const map = new Map();
  for (const item of items ?? []) {
    const id = item[key];
    if (!id || map.has(id)) fail(`duplicate or missing ${label}: ${id}`);
    map.set(id, item);
  }
  return map;
};

// Labels are the existing src/pages/Customers.jsx labels. The optional Store
// projection is calculated at source with that page's lifecycle/due-date rules;
// no financial records are exported and no Hub field determines this status.
const STORE_CUSTOMER_LABELS = {
  active: 'Ativo', overdue: 'Inadimplente', on_leave: 'Em licença',
  scheduled: 'Agendado', inactive: 'Inativo', none: null,
};

/** Stable identities are namespaced by source ID; names never establish identity. */
export function personId(source, id) {
  const hex = createHash('sha256').update(`eon-local-pilot:v1:${source}:${id}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Pure projection only. No database, production, billing, authentication or date-dependent I/O. */
export function normalizeSnapshot(snapshot, manifest, storeOperationalSnapshot = null) {
  if (!snapshot || !manifest || !manifest.operations) fail('snapshot and manifest are required');
  const asOf = snapshot.as_of;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf ?? '') || manifest.input?.snapshot_reference_date !== asOf) {
    fail('reference dates differ or are missing');
  }
  const storeRows = indexed((snapshot.store ?? []).map(row => ({ ...row, id: row.store?.id })), 'id', 'Store customer');
  const hubRows = indexed(snapshot.hub, 'id', 'Hub athlete');
  let operationalCustomers = null;
  if (storeOperationalSnapshot) {
    if (storeOperationalSnapshot.asOf !== asOf || storeOperationalSnapshot.project !== 'bsiljrrodgtmtdilnuxr'
      || storeOperationalSnapshot.rule !== 'Customers.jsx:getAssessmentStatus'
      || !Array.isArray(storeOperationalSnapshot.customers)) {
      fail('Store operational source is incomplete, from another project or reference date');
    }
    operationalCustomers = indexed(storeOperationalSnapshot.customers, 'customerId', 'Store operational customer');
    if (operationalCustomers.size !== storeRows.size) fail('Store operational customer coverage differs');
    for (const [id, customer] of operationalCustomers) {
      if (!storeRows.has(id)) fail(`unscoped operational customer: ${id}`);
      if (!Object.hasOwn(STORE_CUSTOMER_LABELS, customer.status) || typeof customer.onLeave !== 'boolean'
        || typeof customer.countsAsActive !== 'boolean'
        || customer.countsAsActive !== ACTIVE_CONTRACT_STATUSES.has(customer.status)) {
        fail(`invalid Store operational customer projection: ${id}`);
      }
      if (customer.onLeave && !ACTIVE_CONTRACT_STATUSES.has(customer.status)) fail(`non-current Store leave: ${id}`);
    }
  }
  const ops = manifest.operations;
  const selected = indexed(ops.identity_link_proposals, 'store_customer_id', 'selected Store link');
  const creations = indexed(ops.new_athlete_proposals, 'store_customer_id', 'new athlete proposal');
  const benefits = indexed(ops.membership_benefit_assignments, 'hub_athlete_id', 'benefit');
  const statuses = indexed(ops.sporting_status_proposals, 'hub_athlete_id', 'sports change');
  const holds = indexed(manifest.historical_identity_hold_queue, 'store_customer_id', 'historical hold');
  const corrections = indexed(manifest.previously_applied_do_not_replay, 'store_id', 'recorded commercial correction');
  const participation = indexed(snapshot.participation_decisions, 'hub_id', 'participation decision');
  const benefitEvidence = indexed(snapshot.benefit_policy_decisions, 'hub_id', 'benefit evidence');
  const aliasByStore = indexed(ops.confirmed_historical_aliases_to_preserve, 'store_customer_id', 'historical alias group');
  const allDecisions = indexed(snapshot.decisions, 'decision_id', 'decision');
  const usedHub = new Set();
  const people = [];

  for (const creation of creations.values()) {
    const decision = allDecisions.get(creation.source_decision_id);
    if (decision?.action !== 'prepare_new_hub_athlete' || decision.store_id !== creation.store_customer_id
      || creation.create_auth_account !== false || creation.activate_portal !== false) {
      fail(`new athlete lacks safe explicit decision: ${creation.store_customer_id}`);
    }
  }
  for (const aliases of aliasByStore.values()) {
    const decision = allDecisions.get(aliases.source_decision_id);
    if (decision?.store_id !== aliases.store_customer_id || decision.hub_id !== aliases.principal_hub_id) {
      fail(`aliases lack explicit identity decision: ${aliases.store_customer_id}`);
    }
  }
  for (const change of statuses.values()) {
    const decision = allDecisions.get(change.source_decision_id);
    if (decision?.hub_id !== change.hub_athlete_id || decision.planned_hub_status !== change.proposed_status) {
      fail(`sports change lacks explicit decision: ${change.hub_athlete_id}`);
    }
  }

  for (const [storeId, row] of storeRows) {
    const link = selected.get(storeId);
    if ((row.match?.hub_id ?? null) !== (link?.hub_athlete_id ?? null)) fail(`selected identity drift: ${storeId}`);
    if (link && !hubRows.has(link.hub_athlete_id)) fail(`selected Hub athlete is missing: ${link.hub_athlete_id}`);
    const creation = creations.get(storeId);
    if (creation && link) fail(`new athlete already linked: ${storeId}`);
    const correction = corrections.get(storeId);
    if (correction && correction.production_applied !== true) fail(`unverified recorded correction: ${storeId}`);
    const commercialCurrent = correction?.lifecycle_active_after ?? row.store.lifecycle_active === true;
    if (link && link.commercial_current_after_recorded_corrections !== commercialCurrent) {
      fail(`commercial status drift: ${storeId}`);
    }
    if (creation && !commercialCurrent) fail(`new athlete is not a current customer: ${storeId}`);
    if (!link && !creation && !holds.has(storeId)) fail(`customer has no identity disposition: ${storeId}`);
    if (holds.has(storeId) && (link || creation || commercialCurrent)) fail(`historical hold overlaps active/link: ${storeId}`);
    const source = [{ system: 'store', kind: 'customer', id: storeId, relationship: 'primary', name: row.store.name }];
    const aliases = aliasByStore.get(storeId);
    if (aliases && aliases.principal_hub_id !== link?.hub_athlete_id) fail(`alias principal mismatch: ${storeId}`);
    const hub = link ? hubRows.get(link.hub_athlete_id) : null;
    if (hub) attachHub(source, hub, 'primary');
    for (const aliasId of aliases?.preserve_historical_hub_ids ?? []) {
      const alias = hubRows.get(aliasId);
      if (!alias || alias.status !== 'cancelled') fail(`historical alias missing or not cancelled: ${aliasId}`);
      attachHub(source, alias, 'alias');
    }
    people.push(makePerson(row, hub, source, commercialCurrent, creation, holds.get(storeId), correction, link));
  }
  for (const hub of hubRows.values()) {
    if (!usedHub.has(hub.id)) {
      const sources = [];
      attachHub(sources, hub, 'primary');
      people.push(makePerson(null, hub, sources, false, null, null, null, null));
    }
  }
  for (const [label, map, registry] of [
    ['selected link', selected, storeRows], ['new athlete', creations, storeRows],
    ['historical hold', holds, storeRows], ['alias group', aliasByStore, storeRows],
    ['recorded correction', corrections, storeRows], ['benefit', benefits, hubRows],
    ['sports change', statuses, hubRows],
  ]) for (const id of map.keys()) if (!registry.has(id)) fail(`${label} references missing source: ${id}`);
  people.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.id.localeCompare(b.id));
  const active = people.filter(p => p.inActiveStudents);
  const summary = {
    totalPeople: people.length,
    activeStudents: active.length,
    benefits: people.filter(p => ['team', 'partner'].includes(p.category)).length,
    team: people.filter(p => p.category === 'team').length,
    partners: people.filter(p => p.category === 'partner').length,
    storeOnLeave: active.filter(p => p.metadata.storeOnLeave).length,
    commercialOnLeave: active.filter(p => p.metadata.storeOnLeave).length,
    operationalPeople: people.filter(p => p.storeAuthority || ['team', 'partner'].includes(p.category)).length,
    newAthleteProfiles: people.filter(p => p.needsAthleteProfile).length,
    historicalReview: holds.size,
    sourceLinks: people.reduce((n, p) => n + p.sources.length, 0),
    identityLinks: selected.size,
    aliasLinks: people.reduce((n, p) => n + p.sources.filter(s => s.relationship === 'alias').length, 0),
    sportsActive: people.filter(p => p.sportsStatus === 'active').length,
    sportsOnLeave: people.filter(p => p.sportsStatus === 'on_leave').length,
    sportsChanges: statuses.size,
    decisions: allDecisions.size,
    isLiveCount: false,
    referenceDate: asOf,
    sportsHistoryImported: false,
    productionWrites: 0,
  };
  // Only compare fields actually asserted by the manifest; useful for small synthetic fixtures too.
  for (const [expectedKey, actualKey] of Object.entries({
    projected_commercial_current_including_leave: 'activeStudents',
    benefits_excluded_from_active_students_metric: 'benefits',
    planned_new_athletes: 'newAthleteProfiles',
    historical_customers_without_selected_identity: 'historicalReview',
    selected_identity_links_all_customers: 'identityLinks',
    projected_all_with_sporting_status_active: 'sportsActive',
  })) {
    if (manifest.summary?.[expectedKey] !== undefined && manifest.summary[expectedKey] !== summary[actualKey]) {
      fail(`cohort mismatch for ${actualKey}: expected ${manifest.summary[expectedKey]}, got ${summary[actualKey]}`);
    }
  }
  return { asOf, people, decisions: clone([...allDecisions.values()]), summary };

  function attachHub(sources, hub, relationship) {
    if (usedHub.has(hub.id)) fail(`Hub source assigned twice: ${hub.id}`);
    usedHub.add(hub.id);
    sources.push({ system: 'hub', kind: 'athlete', id: hub.id, relationship, name: hub.name });
  }

  function makePerson(row, hub, sources, commercialCurrent, creation, hold, correction, link) {
    const store = row?.store;
    const benefit = hub && benefits.get(hub.id);
    const evidence = hub && benefitEvidence.get(hub.id);
    const sportChange = hub && statuses.get(hub.id);
    const part = hub && participation.get(hub.id);
    if (sportChange && sportChange.expected_status !== hub.status) fail(`sports status drift: ${hub.id}`);
    if (sportChange && (sportChange.expected_portal_status ?? null) !== (hub.portal_status ?? null)) fail(`portal status drift: ${hub.id}`);
    if (benefit && (!evidence || benefit.source_decision_id !== evidence.decision_id || !evidence.exclude_active_student_count)) {
      fail(`benefit lacks explicit evidence: ${hub.id}`);
    }
    if (benefit && (!allDecisions.has(benefit.source_decision_id) || benefit.charge_amount !== 0
      || benefit.exclude_active_student_count !== true || evidence.planned_billing_required !== false
      || evidence.planned_charge_amount !== 0)) fail(`benefit lacks no-charge decision: ${hub.id}`);
    if (benefit && commercialCurrent) fail(`benefit overlaps current commercial membership: ${hub.id}`);
    if (benefit && !['equipe', 'parceiro'].includes(benefit.membership_category)) fail(`unknown benefit category: ${hub.id}`);
    if (benefit && benefit.membership_category !== evidence.membership_category) fail(`benefit category drift: ${hub.id}`);
    if (benefit && benefit.expected_sporting_status !== hub.status) fail(`benefit sports status drift: ${hub.id}`);
    if (benefit && (benefit.expected_portal_status ?? null) !== (hub.portal_status ?? null)) fail(`benefit portal status drift: ${hub.id}`);
    const sportsStatus = sportChange?.proposed_status ?? hub?.status ?? (creation ? 'active' : null);
    if (sportsStatus && !['active', 'on_leave', 'cancelled'].includes(sportsStatus)) fail(`unsupported sports status: ${sportsStatus}`);
    const category = benefit ? (benefit.membership_category === 'equipe' ? 'team' : 'partner')
      : commercialCurrent ? 'commercial' : hold ? 'review' : 'historical';
    const roles = [];
    if (commercialCurrent || benefit) roles.push('athlete');
    if ((evidence?.planned_is_coach ?? part?.planned_is_coach) === true) roles.push('coach');
    const ids = new Set(sources.map(s => s.id));
    if (part?.hub_coach_id) ids.add(part.hub_coach_id);
    if (part?.store_coach_id) ids.add(part.store_coach_id);
    const decisions = [...allDecisions.values()].filter(d => ids.has(d.store_id) || ids.has(d.hub_id));
    let contracts = clone(store?.active_contracts ?? []);
    const latest = store?.latest_contract ?? null;
    if (correction) {
      // Record the verified corrected reference; never replay the operation or invent its payment data.
      const contract = contracts.find(c => c.id === correction.contract_id);
      if (contract) Object.assign(contract, { start: correction.start_date, end: correction.end_date });
      else contracts.push({ id: correction.contract_id, number: correction.contract_number,
        start: correction.start_date, end: correction.end_date, status: latest?.status ?? null,
        coach: latest?.coach ?? null, modality: latest?.modality ?? null,
        provenance: 'previously_applied_verified_correction' });
    }
    const currentContract = [...contracts].sort((a, b) => String(b.start ?? '').localeCompare(String(a.start ?? '')))[0];
    const storeContract = commercialCurrent ? currentContract : latest;
    let customerStatus = { key: null, label: null, source: 'unresolved' };
    let operationalCoach = storeContract?.coach ?? null;
    let operationalModality = storeContract?.modality ?? null;
    let storeOnLeave = commercialCurrent && contracts.some(c => c.status === 'on_leave');
    if (store && operationalCustomers) {
      const customer = operationalCustomers.get(store.id);
      if (ACTIVE_CONTRACT_STATUSES.has(customer.status) !== commercialCurrent) fail(`Store operational cohort drift: ${store.id}`);
      customerStatus = { key: customer.status, label: STORE_CUSTOMER_LABELS[customer.status], source: 'store' };
      storeOnLeave = customer.onLeave;
      operationalCoach = customer.coach ?? null;
      operationalModality = customer.modality ?? null;
      contracts = customer.contractId ? [{ id: customer.contractId, number: customer.contractNumber,
        status: customer.contractStatus, start: customer.start, end: customer.end,
        coach: operationalCoach, modality: operationalModality,
        provenance: 'store_operational_projection' }] : [];
    }
    if (benefit && (!store || (operationalCustomers ? operationalCustomers.get(store.id).status === 'none' : store.contract_count === 0))) {
      customerStatus = { key: null, label: 'Sem contrato', source: 'confirmed_benefit' };
    }
    const memberships = [];
    if (store) memberships.push({ category: 'commercial', status: commercialCurrent ? 'current' : 'historical',
      inActiveStudents: commercialCurrent, source: 'store', sourceId: store.id,
      billingRequired: null, chargeAmount: null, contracts,
      financialStatus: 'not_imported', observedContractCount: store.contract_count ?? 0 });
    if (benefit) memberships.push({ category, status: 'current', inActiveStudents: false,
      source: 'user_decision', sourceId: benefit.source_decision_id, billingRequired: false, chargeAmount: 0,
      effectiveDate: null, financialStatus: 'confirmed_no_charge', contracts: [] });
    const knownHistory = (snapshot.duplicates ?? []).filter(d => ids.has(d.id)).map(d => ({
      hubId: d.id, tests: d.tests, activities: d.activities, workouts: d.workouts,
      raceResults: d.race_results, movements: d.movements,
    }));
    const birthCorrection = (ops.birth_date_correction_proposals ?? []).find(d => ids.has(d.store_id));
    return {
      id: personId(store ? 'store' : 'hub', store?.id ?? hub.id),
      name: store?.name ?? hub.name,
      storeAuthority: Boolean(store),
      customerStatus,
      // Technical audit compatibility only. Never expose sportsStatus as customer lifecycle.
      category, roles, sportsStatus,
      coach: operationalCoach,
      modality: operationalModality,
      inActiveStudents: commercialCurrent && !benefit,
      needsAthleteProfile: Boolean(creation),
      reviewReason: hold ? `Identidade histórica sem vínculo selecionado (${hold.reason}).` : null,
      sources, memberships, decisions: clone(decisions),
      metadata: {
        storeCustomerCode: store?.customer_code ?? null,
        hubAthleteCode: hub?.code ?? null,
        commercialStatus: commercialCurrent ? (contracts.some(c => c.status === 'on_leave') ? 'on_leave' : 'current')
          : store ? 'historical' : 'not_applicable',
        observedSportsStatus: hub?.status ?? null,
        observedPortalStatus: hub?.portal_status ?? null,
        hubProfiles: sources.filter(s => s.system === 'hub').map(s => ({
          relationship: s.relationship, observed: clone(hubRows.get(s.id)),
        })),
        operationalAuthority: 'store',
        storeOnLeave,
        storeOperationalObservedAt: storeOperationalSnapshot?.observedAt ?? null,
        sportsStatusOrigin: sportChange ? 'user_decision' : creation ? 'planned_new_profile' : hub ? 'hub_snapshot' : null,
        sportsProfilePresent: Boolean(hub),
        sportsProfilePlanned: Boolean(creation),
        sportsEffectiveDate: sportChange?.historical_effective_date ?? null,
        sportsHistoryImported: false,
        sportsHistoryReferences: sources.filter(s => s.system === 'hub').map(s => ({ hubId: s.id, relationship: s.relationship })),
        knownHistoryCounts: knownHistory,
        coachProfiles: part?.hub_coach_id || part?.store_coach_id ? [{
          hubCoachId: part.hub_coach_id ?? null, storeCoachId: part.store_coach_id ?? null,
          active: part.planned_is_coach === true, sourceDecisionId: part.decision_id,
        }] : [],
        identityEvidence: link?.evidence_level ?? (creation ? 'user_confirmed_new_athlete' : null),
        candidateHubIds: clone(hold?.candidate_hub_ids ?? []),
        birthDateCorrection: birthCorrection ? {
          value: birthCorrection.canonical_fields.birth_date,
          sourceDecisionId: birthCorrection.decision_id, status: 'pilot_projection_only',
        } : null,
        appliedCommercialCorrection: correction ? { decisionId: correction.decision_id,
          contractId: correction.contract_id, appliedAt: correction.applied_at, replay: false } : null,
        changesAuthOrPermissions: false,
        referenceDate: asOf,
      },
    };
  }
}
