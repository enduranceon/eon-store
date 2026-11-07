import test from 'node:test';
import assert from 'node:assert/strict';
import {
  asaasCheckOrders,
  attachCarneToContracts,
  carneOpenParcels,
  carneParcelRows,
} from './carne-open-sales.js';

// Contrato fictício de R$ 600 em 3 parcelas, a 1ª já registrada.
const parcel = (number, extra = {}) => ({
  id: `p${number}`,
  contract_id: 'c1',
  installment_number: number,
  total_installments: 3,
  value: 200,
  due_date: `2026-1${number}-10`,
  asaas_status: 'PENDING',
  payment_row_id: null,
  invoice_url: `https://www.asaas.com/i/parcela${number}`,
  ...extra,
});
const contract = {
  id: 'c1', type: 'contract', order_number: 'ASS-9001', customer: 'Pessoa Teste',
  total_value: 600, payment_status: 'partially_paid', status: 'active', due_date: '2026-12-10',
  external_payment_link: 'https://www.asaas.com/i/parcela2',
};
const parcels = [parcel(1, { payment_row_id: 'row1', asaas_status: 'CONFIRMED' }), parcel(2), parcel(3)];

test('open parcels exclude the recorded ones and the ones removed or refunded in Asaas', () => {
  const open = carneOpenParcels([
    parcel(1, { payment_row_id: 'row1' }),
    parcel(2, { asaas_status: 'DELETED' }),
    parcel(3, { asaas_status: 'REFUNDED' }),
    parcel(4 - 1 + 1, { id: 'x', installment_number: 4 }),
  ]);
  assert.deepEqual(open.map(item => item.installment_number), [4]);
});

test('the carnê is attached only to the contract that has parcels', () => {
  const other = { id: 'c2', type: 'contract', order_number: 'ASS-9002' };
  const rows = attachCarneToContracts([contract, other], parcels);
  assert.equal(rows[0].carne.parcels.length, 3);
  assert.deepEqual(rows[0].carne.open.map(item => item.installment_number), [2, 3]);
  assert.equal(rows[1].carne, undefined);
});

test('each open parcel becomes a row with its own value, due date and link', () => {
  const [row] = attachCarneToContracts([contract], parcels);
  const rows = carneParcelRows(row);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].order_number, 'ASS-9001 · parcela 2/3');
  assert.equal(rows[0].total_value, 200);
  assert.equal(rows[0].due_date, '2026-12-10');
  assert.equal(rows[0].external_payment_link, 'https://www.asaas.com/i/parcela2');
  assert.equal(rows[0].id, 'c1', 'the row keeps the contract id for links and the Central');
  assert.equal(rows[0].is_carne_parcel, true);
  assert.equal(rows[0].carne, null, 'a parcel row is not a carnê contract row');
  assert.equal(rows[0].list_key, 'carne-parcel:p2');
  assert.equal(rows.reduce((sum, item) => sum + item.total_value, 0), 400, 'the rows add up to the balance');
});

test('a parcel paid in Asaas but not recorded is marked on its row', () => {
  const [row] = attachCarneToContracts([contract], [parcel(1), parcel(2, { asaas_status: 'RECEIVED' })]);
  const rows = carneParcelRows(row);
  assert.equal(rows[0].carne_parcel.paid_in_asaas, false);
  assert.equal(rows[1].carne_parcel.paid_in_asaas, true);
});

test('a contract without a carnê gives no parcel rows', () => {
  assert.deepEqual(carneParcelRows(contract), []);
});

test('the conference list has the usual open sales plus carnês with open parcels, once each', () => {
  const [carneRow] = attachCarneToContracts([contract], parcels);
  const parcelRows = carneParcelRows(carneRow);
  const presale = { id: 'o1', type: 'presale', order_number: 'PV-1' };
  const list = asaasCheckOrders([presale, ...parcelRows], [presale, carneRow, ...parcelRows]);
  assert.deepEqual(list.map(item => `${item.type}:${item.id}`), ['presale:o1', 'contract:c1']);
  assert.equal(list[1].carne.open.length, 2);
});
