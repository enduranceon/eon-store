import test from 'node:test';
import assert from 'node:assert/strict';
import {
  asaasCheckCandidates,
  classifyAsaasCheck,
  methodForAsaasPayment,
  registerAsaasPayments,
  summarizeAsaasCheck,
} from './asaas-payment-check.js';

const methods = [
  { id: 'm-pix', internal_code: 'pix', name: 'PIX (via Asaas)', installments: 1 },
  { id: 'm-boleto', internal_code: 'boleto', name: 'Boleto', installments: 1 },
  { id: 'm-card1', internal_code: 'credit_card', name: 'Cartão crédito 1x', installments: 1 },
  { id: 'm-card3', internal_code: 'card_3x', name: 'Cartão crédito 3x', installments: 3 },
  { id: 'm-pix-manual', internal_code: 'pix_manual', name: 'PIX manual', installments: 1 },
];
const TODAY = '2026-10-06';
const LINK = 'https://www.asaas.com/i/abc123def456ghi7';

const order = (overrides = {}) => ({
  id: 'order-1',
  type: 'contract',
  order_number: 'ASS-000001',
  customer: 'Cliente Fictício',
  total_value: 600,
  payment_status: 'charge_sent',
  external_payment_link: LINK,
  asaas_charge_id: null,
  ...overrides,
});
const fact = (overrides = {}) => ({
  status: 'RECEIVED',
  billing_type: 'PIX',
  value: 600,
  installment_number: null,
  due_date: '2026-10-05',
  client_payment_date: '2026-10-04',
  confirmed_date: '2026-10-04',
  payment_date: '2026-10-04',
  ...overrides,
});
const checked = (payment, installments = null) => ({ type: 'contract', id: 'order-1', result: 'checked', payment, installments });
const cardParcels = (statuses = ['CONFIRMED', 'CONFIRMED', 'CONFIRMED'], overrides = {}) => statuses.map((status, index) => fact({
  status,
  billing_type: 'CREDIT_CARD',
  value: 200,
  installment_number: index + 1,
  client_payment_date: null,
  confirmed_date: '2026-10-03',
  payment_date: null,
  ...overrides,
}));

test('only open sales with an Asaas invoice link are checked', () => {
  const candidates = asaasCheckCandidates([
    order({ id: 'ok' }),
    order({ id: 'paid', payment_status: 'paid' }),
    order({ id: 'cancelled', payment_status: 'cancelled' }),
    order({ id: 'api', asaas_charge_id: 'pay_x' }),
    order({ id: 'stone', external_payment_link: 'https://conta.stone.com.br/vendas/1' }),
    order({ id: 'old-link', external_payment_link: 'https://www.asaas.com/payment/123' }),
    order({ id: 'no-link', external_payment_link: null }),
    order({ id: 'zero', total_value: 0 }),
  ]);
  assert.deepEqual(candidates.map(item => item.id), ['ok']);
});

test('Asaas payment types map to the same payment methods as "Receber"', () => {
  assert.equal(methodForAsaasPayment(methods, 'PIX').id, 'm-pix');
  assert.equal(methodForAsaasPayment(methods, 'BOLETO').id, 'm-boleto');
  assert.equal(methodForAsaasPayment(methods, 'CREDIT_CARD', 1).id, 'm-card1');
  assert.equal(methodForAsaasPayment(methods, 'CREDIT_CARD', 3).id, 'm-card3');
  assert.equal(methodForAsaasPayment(methods, 'CREDIT_CARD', 5), null);
  assert.equal(methodForAsaasPayment(methods, 'DEBIT_CARD'), null);
  assert.equal(methodForAsaasPayment(methods, 'UNDEFINED'), null);
});

test('a PIX paid in Asaas is ready with the date the client paid', () => {
  const item = classifyAsaasCheck(order(), checked(fact()), methods, TODAY);
  assert.equal(item.kind, 'ready');
  assert.equal(item.method.id, 'm-pix');
  assert.equal(item.paymentDate, '2026-10-04');
  assert.equal(item.total, 600);
  assert.equal(item.installments, 1);
});

test('a card paid in 3 installments is ready as "Cartão 3x"', () => {
  const item = classifyAsaasCheck(order(), checked(cardParcels()[0], cardParcels()), methods, TODAY);
  assert.equal(item.kind, 'ready');
  assert.equal(item.method.id, 'm-card3');
  assert.equal(item.installments, 3);
  assert.equal(item.paymentDate, '2026-10-03', 'falls back to the confirmation date');
});

test('installment rounding cents do not block a card payment', () => {
  const sevenTimes = cardParcels(Array(7).fill('CONFIRMED'), { value: 85.71 });
  const methodsWith7x = [...methods, { id: 'm-card7', internal_code: 'card_7x', name: 'Cartão crédito 7x', installments: 7 }];
  const item = classifyAsaasCheck(order(), checked(sevenTimes[0], sevenTimes), methodsWith7x, TODAY);
  assert.equal(item.kind, 'ready', 'R$ 599,97 em 7x confere com R$ 600,00');
  assert.equal(item.method.id, 'm-card7');
  const single = classifyAsaasCheck(order(), checked(fact({ value: 599.97 })), methods, TODAY);
  assert.equal(single.kind, 'review', 'à vista a diferença de centavos não passa');
});

test('a card installment group not yet approved stays open', () => {
  const parcels = cardParcels(['PENDING', 'PENDING', 'PENDING']);
  const item = classifyAsaasCheck(order(), checked(parcels[0], parcels), methods, TODAY);
  assert.equal(item.kind, 'open');
  assert.equal(item.label, 'Aguardando pagamento');
});

test('open charges keep their Asaas situation', () => {
  const pending = classifyAsaasCheck(order(), checked(fact({ status: 'PENDING' })), methods, TODAY);
  assert.equal(pending.kind, 'open');
  const overdue = classifyAsaasCheck(order(), checked(fact({ status: 'OVERDUE' })), methods, TODAY);
  assert.equal(overdue.kind, 'open');
  assert.equal(overdue.label, 'Vencida no Asaas');
});

test('anything that is not a clean full payment goes to review', () => {
  const cases = [
    [checked(fact({ value: 550 })), /Valor no Asaas R\$\s?550,00; no sistema R\$\s?600,00/],
    [checked(cardParcels(['CONFIRMED', 'PENDING', 'PENDING'])[0], cardParcels(['CONFIRMED', 'PENDING', 'PENDING'])), /1 de 3 parcelas pagas/],
    [checked(fact({ status: 'REFUNDED' })), /Estornada no Asaas/],
    [checked(fact({ status: 'RECEIVED_IN_CASH' })), /recebida em dinheiro/],
    [checked(fact({ status: 'DELETED' })), /removida no Asaas/],
    [checked(fact({ billing_type: 'DEBIT_CARD' })), /cartão de débito/],
    [checked(fact({ billing_type: 'BOLETO', value: 300 }), [fact({ billing_type: 'BOLETO', value: 300 }), fact({ billing_type: 'BOLETO', value: 300 })]), /Boleto parcelado/],
    [checked(fact({ client_payment_date: null, confirmed_date: null, payment_date: null })), /não informou a data/],
    [checked(fact({ client_payment_date: '2026-10-07' })), /no futuro/],
    [checked(fact(), []), /Parcelas não encontradas/],
    [{ result: 'asaas_error', message: 'Instabilidade' }, /Erro ao consultar o Asaas: Instabilidade/],
    [{ result: 'asaas_not_found' }, /não encontrada no Asaas/],
    [undefined, /Sem resposta/],
  ];
  for (const [check, reason] of cases) {
    const item = classifyAsaasCheck(order(), check, methods, TODAY);
    assert.equal(item.kind, 'review', `review for ${reason}`);
    assert.match(item.reason, reason);
  }

  const fiveTimes = cardParcels(Array(5).fill('CONFIRMED'), { value: 120 });
  const missingMethod = classifyAsaasCheck(order(), checked(fiveTimes[0], fiveTimes), methods, TODAY);
  assert.equal(missingMethod.kind, 'review');
  assert.match(missingMethod.reason, /Cartão 5x/);
});

test('a sale already closed in the system is skipped', () => {
  const item = classifyAsaasCheck(order(), { result: 'closed', local_status: 'paid' }, methods, TODAY);
  assert.equal(item.kind, 'skip');
});

test('summary groups every checked sale', () => {
  const orders = [order({ id: 'a' }), order({ id: 'b' }), order({ id: 'c' })];
  const results = [
    { type: 'contract', id: 'a', result: 'checked', payment: fact(), installments: null },
    { type: 'contract', id: 'b', result: 'checked', payment: fact({ status: 'PENDING' }), installments: null },
  ];
  const groups = summarizeAsaasCheck(orders, results, methods, TODAY);
  assert.deepEqual(groups.ready.map(item => item.order.id), ['a']);
  assert.deepEqual(groups.open.map(item => item.order.id), ['b']);
  assert.deepEqual(groups.review.map(item => item.order.id), ['c']);
});

test('one failed registration does not stop the others', async () => {
  const items = [{ key: 'x' }, { key: 'y' }, { key: 'z' }];
  const seen = [];
  const results = await registerAsaasPayments(items, async item => {
    seen.push(item.key);
    if (item.key === 'y') throw new Error('A venda já foi paga por outro fluxo');
  });
  assert.deepEqual(seen, ['x', 'y', 'z']);
  assert.deepEqual(results, [
    { key: 'x', ok: true },
    { key: 'y', ok: false, message: 'A venda já foi paga por outro fluxo' },
    { key: 'z', ok: true },
  ]);
});
