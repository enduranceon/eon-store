import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCarneItem } from './carne-register.js';

// Contrato fictício; as chamadas à API são simuladas e anotadas.
const parcelRows = [1, 2, 3].map(number => ({ id: `parcel-${number}`, installment_number: number }));

function fakeApi({ failOn = null } = {}) {
  const calls = [];
  let counter = 0;
  const nextVersion = () => `v${(counter += 1)}`;
  return {
    calls,
    importContractParcels(contractId, options) {
      calls.push(['import', contractId, options.expectedUpdatedAt]);
      return Promise.resolve({ contract: { updated_at: nextVersion() }, parcels: parcelRows });
    },
    recordContractParcelPayment(contractId, parcelId, version) {
      calls.push(['record', contractId, parcelId, version]);
      if (parcelId === failOn) return Promise.reject(new Error('O contrato foi alterado por outra ação'));
      return Promise.resolve({ contract: { updated_at: nextVersion() } });
    },
  };
}

const toRecord = numbers => numbers.map(number => ({ number, value: 200, paymentDate: '2026-11-05', creditDate: '2026-11-06' }));

test('a carnê not yet imported is imported and then its paid parcels are registered, threading the version', async () => {
  const api = fakeApi();
  const item = { imported: false, toRecord: toRecord([1, 2]), order: { id: 'c1', updated_at: 'v0' } };
  const result = await registerCarneItem(item, api);
  assert.deepEqual(api.calls, [
    ['import', 'c1', 'v0'],
    ['record', 'c1', 'parcel-1', 'v1'],
    ['record', 'c1', 'parcel-2', 'v2'],
  ]);
  assert.deepEqual(result, { imported: true, recorded: [1, 2] });
});

test('an imported carnê only registers, using the parcel ids stored on the contract', async () => {
  const api = fakeApi();
  const item = {
    imported: true,
    toRecord: toRecord([2]),
    order: { id: 'c1', updated_at: 'v0', carne: { parcels: parcelRows } },
  };
  const result = await registerCarneItem(item, api);
  assert.deepEqual(api.calls, [['record', 'c1', 'parcel-2', 'v0']]);
  assert.deepEqual(result, { imported: false, recorded: [2] });
});

test('a failure in the middle says how far it got', async () => {
  const api = fakeApi({ failOn: 'parcel-2' });
  const item = { imported: false, toRecord: toRecord([1, 2, 3]), order: { id: 'c1', updated_at: 'v0' } };
  await assert.rejects(
    () => registerCarneItem(item, api),
    error => {
      assert.match(error.message, /parcela 2/);
      assert.match(error.message, /alterado por outra ação/);
      assert.match(error.message, /as parcelas foram importadas; parcela 1 registrada/);
      return true;
    },
  );
  assert.equal(api.calls.filter(call => call[0] === 'record').length, 2, 'stops after the failure');
});

test('a parcel missing from the contract is reported, not skipped', async () => {
  const api = fakeApi();
  const item = { imported: true, toRecord: toRecord([4]), order: { id: 'c1', updated_at: 'v0', carne: { parcels: parcelRows } } };
  await assert.rejects(() => registerCarneItem(item, api), /parcela 4.*não encontrada/);
});
