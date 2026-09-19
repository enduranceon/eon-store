BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

SELECT ok(has_function_privilege('service_role', 'public.process_asaas_store_webhook(jsonb,uuid[])', 'EXECUTE'), 'service role can receive events');
SELECT ok(NOT has_function_privilege('anon', 'public.process_asaas_store_webhook(jsonb,uuid[])', 'EXECUTE'), 'anonymous cannot receive events');
SELECT ok(NOT has_function_privilege('authenticated', 'public.process_asaas_store_webhook(jsonb,uuid[])', 'EXECUTE'), 'browser cannot receive events');
SELECT ok(NOT has_table_privilege('authenticated', 'public.asaas_store_webhook_events', 'SELECT'), 'browser cannot read webhook payloads');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.asaas_store_webhook_events'::regclass), 'inbox has RLS');
SELECT ok(NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.process_asaas_store_webhook(jsonb,uuid[])'::regprocedure), 'RPC does not elevate caller');

INSERT INTO public.stock_orders(id, order_number, customer_name, total_value, payment_status, asaas_charge_id, asaas_customer_id)
VALUES ('90000000-0000-4000-a000-000000000001', 'WEBHOOK-TEST', 'Fictitious webhook test', 100, 'charge_sent', 'pay_webhook_test', 'cus_webhook_test');
INSERT INTO public.asaas_payments(asaas_payment_id, asaas_customer_id, billing_type, status, value,
  net_value, due_date, external_reference, order_id, order_type, source, total_installments)
VALUES ('pay_webhook_test', 'cus_webhook_test', 'PIX', 'PENDING', 100, 99, '2026-09-18',
  'EONCHG-webhook-test', '90000000-0000-4000-a000-000000000001', 'stock', 'asaas', 1);

CREATE FUNCTION pg_temp.webhook_event(p_id text, p_type text DEFAULT 'PAYMENT_RECEIVED',
  p_status text DEFAULT 'RECEIVED', p_time text DEFAULT '2026-09-18 12:00:00', p_extra jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'event', p_type, 'dateCreated', p_time,
    'payment', jsonb_build_object('id', 'pay_webhook_test', 'customer', 'cus_webhook_test',
      'status', p_status, 'value', 100, 'netValue', 99, 'dueDate', '2026-09-18',
      'paymentDate', '2026-09-18', 'creditDate', '2026-09-18', 'billingType', 'PIX',
      'externalReference', 'EONCHG-webhook-test') || p_extra);
$$;
CREATE FUNCTION pg_temp.apply_webhook(p_event jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.process_asaas_store_webhook(p_event, ARRAY['90000000-0000-4000-a000-000000000001'::uuid]);
$$;

SET LOCAL ROLE service_role;
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_paid'))->>'status', 'processed', 'received payment processed');
RESET ROLE;
SELECT is((SELECT payment_status FROM public.stock_orders WHERE order_number = 'WEBHOOK-TEST'), 'paid', 'order becomes paid');
SELECT is((SELECT status FROM public.asaas_payments WHERE asaas_payment_id = 'pay_webhook_test'), 'RECEIVED', 'financial projection becomes received');
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_paid'))->>'duplicate', 'true', 'duplicate event is acknowledged');
SELECT is((SELECT count(*)::int FROM public.asaas_payments WHERE asaas_payment_id = 'pay_webhook_test'), 1, 'duplicate does not create another receipt');
SELECT is((SELECT count(*)::int FROM public.sales_status_events WHERE metadata->>'asaas_event_id' = 'evt_paid'), 1, 'duplicate does not repeat status effects');
SELECT throws_ok($$SELECT pg_temp.apply_webhook(pg_temp.webhook_event('evt_paid', 'PAYMENT_OVERDUE', 'OVERDUE'))$$,
  '22023', 'Conflicting Asaas event ID', 'same event ID cannot carry another payload');
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_older', 'PAYMENT_OVERDUE', 'OVERDUE', '2026-09-18 11:00:00'))->>'reason', 'older_event', 'older event cannot regress payment');
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_pending', 'PAYMENT_UPDATED', 'PENDING', '2026-09-18 13:00:00'))->>'reason', 'paid_payment_preserved', 'even newer pending snapshot cannot regress paid');
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_confirmed', 'PAYMENT_CONFIRMED', 'CONFIRMED', '2026-09-18 13:00:00'))->>'reason', 'received_payment_preserved', 'received never regresses to confirmed');
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_amount', p_extra => '{"value":1}'))->>'reason', 'payment_amount_mismatch', 'wrong amount requires reconciliation');
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_customer', p_extra => '{"customer":"cus_other"}'))->>'reason', 'payment_identity_mismatch', 'wrong customer never confirms order');
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_ref', p_extra => '{"externalReference":"another-order"}'))->>'reason', 'payment_identity_mismatch', 'wrong reference never confirms order');
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_subscription', p_extra => '{"subscription":"sub_test"}'))->>'reason', 'outside_store_payment_pilot', 'subscription is outside pilot');
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_installment', p_extra => '{"installment":"ins_test"}'))->>'reason', 'installment_group_mismatch', 'foreign installment is outside pilot');
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_date', p_time => 'invalid'))->>'reason', 'invalid_event_date', 'invalid date is retained for review');
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_no_paid_date', p_extra => '{"paymentDate":null}'))->>'reason', 'missing_payment_date', 'missing paid date does not invent today');

INSERT INTO public.asaas_payments(asaas_payment_id, status, value, order_id, order_type, source)
VALUES ('manual_webhook_test', 'RECEIVED', 100, '90000000-0000-4000-a000-000000000001', 'stock', 'manual');
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_manual'))->>'reason', 'manual_payment_preserved', 'mixed manual receipt requires review');
SELECT is((SELECT count(*)::int FROM public.asaas_payments WHERE asaas_payment_id = 'manual_webhook_test'), 1, 'manual receipt is not erased');
SELECT is((SELECT gross_amount FROM public.financial_movements WHERE source = 'manual'
  AND metadata->>'asaas_payment_id' = 'manual_webhook_test'), 100::numeric,
  'manual receipt remains visible in the canonical financial ledger');
DELETE FROM public.asaas_payments WHERE asaas_payment_id = 'manual_webhook_test';

SELECT is(public.process_asaas_store_webhook(pg_temp.webhook_event('evt_unlisted'), '{}'::uuid[])->>'status', 'ignored', 'non-allowlisted order is untouched');
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_foreign', p_extra => '{"id":"pay_foreign","externalReference":"foreign"}'))->>'status', 'ignored', 'unrelated existing charges are ignored');
SELECT is((SELECT count(*)::int FROM public.asaas_payments WHERE asaas_payment_id = 'pay_foreign'), 0, 'foreign charge does not pollute financial reports');
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_refund', 'PAYMENT_REFUNDED', 'REFUNDED', '2026-09-18 14:00:00'))->>'status', 'reconciliation_required', 'unmatched refund cannot infer stock return');
SELECT is((SELECT payment_status FROM public.stock_orders WHERE order_number = 'WEBHOOK-TEST'), 'paid', 'unmatched refund preserves local sale');

-- Simulate a webhook arriving before the charge completion transaction.
DELETE FROM public.asaas_payments WHERE asaas_payment_id = 'pay_webhook_test';
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_race'))->>'status', 'pending', 'missing cache must retry, not acknowledge');
INSERT INTO public.asaas_payments(asaas_payment_id, asaas_customer_id, billing_type, status, value,
  external_reference, order_id, order_type, source)
VALUES ('pay_webhook_test', 'cus_webhook_test', 'PIX', 'PENDING', 100,
  'EONCHG-webhook-test', '90000000-0000-4000-a000-000000000001', 'stock', 'asaas');
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_race'))->>'status', 'processed', 'same event succeeds after local link is ready');

INSERT INTO public.order_operations(id, operation_type, operation_key, order_type, order_id,
  status, requested_by, reason, payload)
VALUES ('90000000-0000-4000-a000-000000000002', 'create_charge', 'webhook-test', 'stock',
  '90000000-0000-4000-a000-000000000001', 'prepared',
  '90000000-0000-4000-a000-000000000003', 'Fictitious webhook race',
  '{"payment_external_reference":"EONCHG-webhook-test"}');
UPDATE public.stock_orders SET asaas_charge_id = NULL WHERE order_number = 'WEBHOOK-TEST';
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_early'))->>'status', 'pending', 'event before order link is retried using immutable operation reference');
UPDATE public.order_operations SET status = 'completed' WHERE id = '90000000-0000-4000-a000-000000000002';
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_stale_link'))->>'reason', 'charge_link_changed', 'cleared completed charge does not retry forever');
INSERT INTO public.order_operations(id, operation_type, operation_key, order_type, order_id,
  status, requested_by, reason, payload)
VALUES ('90000000-0000-4000-a000-000000000004', 'cancel_charge', 'webhook-test', 'stock',
  '90000000-0000-4000-a000-000000000001', 'completed',
  '90000000-0000-4000-a000-000000000003', 'Fictitious completed cancellation',
  '{"asaas_charge_id":"pay_webhook_test"}');
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_already_cancelled', 'PAYMENT_DELETED', 'PENDING'))->>'reason', 'terminal_already_completed', 'terminal callback after clearing charge reuses completed operation');
UPDATE public.stock_orders SET asaas_charge_id = 'pay_webhook_test' WHERE order_number = 'WEBHOOK-TEST';
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_early'))->>'status', 'processed', 'early event succeeds when local charge link becomes available');

INSERT INTO public.asaas_payments(asaas_payment_id, status, value, order_id, order_type, source)
VALUES ('pay_other_receipt_test', 'RECEIVED', 100, '90000000-0000-4000-a000-000000000001', 'stock', 'asaas');
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_other_receipt'))->>'reason', 'other_receipt_preserved', 'another receipt is never counted twice');
DELETE FROM public.asaas_payments WHERE asaas_payment_id = 'pay_other_receipt_test';
INSERT INTO public.stock_orders(id, order_number, asaas_charge_id)
VALUES ('90000000-0000-4000-a000-000000000005', 'WEBHOOK-AMBIGUOUS', 'pay_webhook_test');
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_ambiguous'))->>'reason', 'ambiguous_charge_link', 'shared provider charge cannot update an arbitrary order');
DELETE FROM public.stock_orders WHERE order_number = 'WEBHOOK-AMBIGUOUS';

-- A failure after cache update must roll back both cache and event journal.
CREATE FUNCTION pg_temp.fail_webhook_order_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'test write failure'; END;
$$;
CREATE TRIGGER test_fail_webhook_order_update BEFORE UPDATE ON public.stock_orders
FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_webhook_order_update();
SELECT throws_ok($$SELECT pg_temp.apply_webhook(pg_temp.webhook_event('evt_atomic', p_time => '2026-09-18 15:00:00', p_extra => '{"netValue":98}'))$$,
  'P0001', 'test write failure', 'database failure propagates for provider retry');
DROP TRIGGER test_fail_webhook_order_update ON public.stock_orders;
SELECT is((SELECT net_value FROM public.asaas_payments WHERE asaas_payment_id = 'pay_webhook_test'), 99::numeric, 'financial update rolls back');
SELECT is((SELECT count(*)::int FROM public.asaas_store_webhook_events WHERE event_id = 'evt_atomic'), 0, 'failed event is not marked delivered');
SELECT is(pg_temp.apply_webhook(pg_temp.webhook_event('evt_atomic', p_time => '2026-09-18 15:00:00', p_extra => '{"netValue":98}'))->>'status', 'processed', 'retry succeeds after database recovery');

INSERT INTO public.stock_orders(id, order_number, customer_name, total_value, payment_status,
  asaas_charge_id, asaas_customer_id, due_date)
VALUES ('91000000-0000-4000-a000-000000000001', 'CARD-WEBHOOK-TEST', 'Fictitious card test', 100,
  'charge_sent', 'pay_card_1', 'cus_card_test', '2026-09-18');
INSERT INTO public.asaas_payments(asaas_payment_id, asaas_customer_id, billing_type, status, value,
  net_value, due_date, external_reference, order_id, order_type, source, total_installments,
  installment_group_id, installment_number)
SELECT 'pay_card_' || n, 'cus_card_test', 'CREDIT_CARD', 'PENDING',
  CASE WHEN n = 3 THEN 33.34 ELSE 33.33 END, 32,
  ('2026-09-18'::date + make_interval(months => n-1))::date, 'EONCHG-card-test',
  '91000000-0000-4000-a000-000000000001'::uuid, 'stock', 'asaas', 3, 'ins_card_test', n
FROM generate_series(1,3) n;
CREATE FUNCTION pg_temp.card_event(p_id text, p_n int, p_status text DEFAULT 'CONFIRMED',
  p_time text DEFAULT '2026-09-18 12:00:00', p_extra jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'event', CASE WHEN p_status = 'RECEIVED'
    THEN 'PAYMENT_RECEIVED' ELSE 'PAYMENT_CONFIRMED' END, 'dateCreated', p_time,
    'payment', jsonb_build_object('id', 'pay_card_' || p_n, 'customer', 'cus_card_test',
      'status', p_status, 'value', CASE WHEN p_n=3 THEN 33.34 ELSE 33.33 END,
      'netValue', 32, 'dueDate', ('2026-09-18'::date + make_interval(months => p_n-1))::date,
      'confirmedDate', '2026-09-18', 'paymentDate', NULL,
      'estimatedCreditDate', ('2026-09-18'::date + make_interval(months => p_n))::date,
      'billingType', 'CREDIT_CARD', 'externalReference', 'EONCHG-card-test',
      'installment', 'ins_card_test', 'installmentNumber', p_n,
      'creditCard', jsonb_build_object('creditCardToken','test-secret-never-persist','ccv','123')) || p_extra);
$$;
CREATE FUNCTION pg_temp.apply_card(p_event jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.process_asaas_store_webhook(p_event, ARRAY['91000000-0000-4000-a000-000000000001'::uuid]);
$$;
SELECT is(pg_temp.apply_card(pg_temp.card_event('evt_card_2', 2))->>'status', 'processed', 'secondary installment can arrive first');
SELECT is((SELECT payment_status FROM public.stock_orders WHERE order_number='CARD-WEBHOOK-TEST'), 'charge_sent', 'one approved installment does not confirm entire order');
SELECT is(pg_temp.apply_card(pg_temp.card_event('evt_card_3', 3))->>'status', 'processed', 'third installment preserves exact cent rounding');
SELECT is((SELECT payment_status FROM public.stock_orders WHERE order_number='CARD-WEBHOOK-TEST'), 'charge_sent', 'missing first approval keeps order open');
SELECT is(pg_temp.apply_card(pg_temp.card_event('evt_card_1', 1))->>'status', 'processed', 'all installments become approved');
SELECT is((SELECT payment_status FROM public.stock_orders WHERE order_number='CARD-WEBHOOK-TEST'), 'paid', 'complete approval confirms order before future settlement dates');
SELECT is((SELECT payment_method FROM public.stock_orders WHERE order_number='CARD-WEBHOOK-TEST'), 'card_3x', 'order preserves card installment count');
SELECT is((SELECT due_date FROM public.stock_orders WHERE order_number='CARD-WEBHOOK-TEST'), '2026-09-18'::date, 'last installment event does not replace order due date');
SELECT is((SELECT payment_date FROM public.stock_orders WHERE order_number='CARD-WEBHOOK-TEST'), '2026-09-18'::date, 'confirmation uses provider date, not processing day');
SELECT is((SELECT sum(value) FROM public.asaas_payments WHERE installment_group_id='ins_card_test'), 100::numeric, 'three receivables sum to order total once');
SELECT is((SELECT credit_date FROM public.asaas_payments WHERE asaas_payment_id='pay_card_3'), '2026-12-18'::date, 'future settlement date is preserved');
SELECT is((SELECT count(*)::int FROM public.financial_movements
  WHERE order_id = '91000000-0000-4000-a000-000000000001' AND order_type = 'stock'),
  3, 'canonical ledger contains only the three installments, no legacy total receipt');
SELECT is((SELECT sum(gross_amount) FROM public.financial_movements
  WHERE order_id = '91000000-0000-4000-a000-000000000001' AND order_type = 'stock'),
  100::numeric, 'canonical financial gross total counts the purchase once');
SELECT is((SELECT sum(net_amount) FROM public.financial_movements
  WHERE order_id = '91000000-0000-4000-a000-000000000001' AND order_type = 'stock'),
  96::numeric, 'canonical financial net total preserves per-installment fees');
SELECT is((SELECT sum(fee_amount) FROM public.financial_movements
  WHERE order_id = '91000000-0000-4000-a000-000000000001' AND order_type = 'stock'),
  4::numeric, 'canonical financial fees are not multiplied by the purchase total');
SELECT is((SELECT scheduled_on FROM public.financial_movements
  WHERE metadata->>'asaas_payment_id' = 'pay_card_3'), '2026-12-18'::date,
  'canonical cash schedule preserves future card credit date');
SELECT is((SELECT recognition_on FROM public.financial_movements
  WHERE metadata->>'asaas_payment_id' = 'pay_card_3'), '2026-09-18'::date,
  'canonical recognition date remains separate from cash schedule');
SELECT ok((SELECT NOT payload->'payment' ? 'creditCard' FROM public.asaas_store_webhook_events WHERE event_id='evt_card_1'), 'inbox does not retain card credentials');
SELECT ok((SELECT NOT raw ? 'creditCard' FROM public.asaas_payments WHERE asaas_payment_id='pay_card_1'), 'financial projection does not retain card credentials');
SELECT is(pg_temp.apply_card(pg_temp.card_event('evt_card_1', 1))->>'duplicate', 'true', 'installment replay is idempotent');
SELECT is((SELECT count(*)::int FROM public.asaas_payments WHERE installment_group_id='ins_card_test'), 3, 'replay leaves exactly three installments');
SELECT is(pg_temp.apply_card(pg_temp.card_event('evt_card_settled', 2, 'RECEIVED', '2026-11-18 12:00:00', '{"creditDate":"2026-11-18","paymentDate":"2026-09-18"}'))->>'status', 'processed', 'later settlement updates only its installment');
SELECT is((SELECT sum(value) FROM public.asaas_payments WHERE installment_group_id='ins_card_test'), 100::numeric, 'settlement does not add another sale');
SELECT is(pg_temp.apply_card(pg_temp.card_event('evt_card_wrong_group', 2, p_extra => '{"installment":"ins_foreign"}'))->>'reason', 'installment_group_mismatch', 'foreign installment group is rejected');
SELECT is(pg_temp.apply_card(pg_temp.card_event('evt_card_wrong_number', 2, p_extra => '{"installmentNumber":1}'))->>'reason', 'installment_group_mismatch', 'wrong installment number is rejected');
UPDATE public.asaas_payments SET installment_number=2 WHERE asaas_payment_id='pay_card_3';
SELECT is(pg_temp.apply_card(pg_temp.card_event('evt_card_duplicate_number', 1))->>'reason', 'installment_group_mismatch', 'incomplete or duplicate group cannot update order');
UPDATE public.asaas_payments SET installment_number=3 WHERE asaas_payment_id='pay_card_3';
SELECT is(pg_temp.apply_card(jsonb_set(pg_temp.card_event('evt_card_refund',2), '{event}', '"PAYMENT_REFUNDED"'))->>'reason', 'installment_terminal_requires_reconciliation', 'one installment refund never implies a full-order refund');
SELECT is(pg_temp.apply_card(jsonb_set(pg_temp.card_event('evt_card_refused',1), '{event}', '"PAYMENT_CREDIT_CARD_CAPTURE_REFUSED"'))->>'reason', 'unsupported_event_or_status', 'card refusal is retained for review without confirming a new payment');
SELECT * FROM finish();
ROLLBACK;
