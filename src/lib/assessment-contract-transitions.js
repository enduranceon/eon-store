import { AssessmentContract } from '@/api/entities';
import { todayLocalStr } from '@/lib/utils';

const OPERATIONAL_STATUSES = new Set(['active', 'overdue', 'on_leave']);

function isNonRenewal(contract) {
  const reason = (contract?.cancellation_reason || '').toLowerCase();
  return reason.includes('não renovou') || reason.includes('nao renovou')
    || reason.includes('não vai renovar') || reason.includes('nao vai renovar');
}

async function updateRows(rows, status) {
  if (!rows.length) return;
  await Promise.allSettled(rows.map(row => AssessmentContract.update(row.id, { status })));
  rows.forEach(row => { row.status = status; });
}

export async function applyAssessmentContractTransitions(contracts = [], todayStr = todayLocalStr()) {
  const contractsById = Object.fromEntries(contracts.map(contract => [contract.id, contract]));

  const scheduledToStart = contracts.filter(contract =>
    contract.status === 'scheduled' &&
    contract.start_date &&
    contract.start_date <= todayStr
  );
  await updateRows(scheduledToStart, 'active');

  const startedRenewals = contracts.filter(contract =>
    contract.parent_contract_id &&
    contract.status === 'active' &&
    contract.start_date &&
    contract.start_date <= todayStr
  );
  const parentsToFinishById = new Map();
  startedRenewals.forEach(contract => {
    const parent = contractsById[contract.parent_contract_id];
    if (parent && OPERATIONAL_STATUSES.has(parent.status)) {
      parentsToFinishById.set(parent.id, parent);
    }
  });
  await updateRows([...parentsToFinishById.values()], 'finished');

  const expiredActive = contracts.filter(contract =>
    contract.status === 'active' &&
    contract.end_date &&
    contract.end_date < todayStr
  );
  await updateRows(expiredActive.filter(isNonRenewal), 'finished');
  await updateRows(expiredActive.filter(contract => !isNonRenewal(contract)), 'overdue');

  return contracts;
}
