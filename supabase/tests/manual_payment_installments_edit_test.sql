BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT plan(10);
SELECT ok(NOT has_function_privilege('authenticated','public.api_edit_manual_payment_installments(text,uuid,jsonb,jsonb,uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','public.api_edit_manual_payment_installments(text,uuid,jsonb,jsonb,uuid)','EXECUTE')
 AND has_function_privilege('service_role','public.api_edit_manual_payment_installments(text,uuid,jsonb,jsonb,uuid)','EXECUTE'), 'edits require backend authorization');
INSERT INTO public.stock_orders(id,order_number,total_value,payment_status,manual_payment)
VALUES('81000000-0000-4000-a000-000000000001','EDIT-INSTALLMENTS-TEST',300,'paid',true);
INSERT INTO public.asaas_payments(id,asaas_payment_id,order_id,order_type,source,status,value,net_value,due_date,credit_date,installment_number,total_installments)
VALUES
('81000000-0000-4000-a000-000000000011','manual_edit_test_1','81000000-0000-4000-a000-000000000001','stock','manual','CONFIRMED',150,150,'2026-10-01','2026-10-01',1,2),
('81000000-0000-4000-a000-000000000012','manual_edit_test_2','81000000-0000-4000-a000-000000000001','stock','manual','CONFIRMED',150,150,'2026-11-01','2026-11-01',2,2);
CREATE FUNCTION pg_temp.snapshot() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_agg(jsonb_build_object('id',id,'value',value,'due_date',due_date,'credit_date',credit_date) ORDER BY id)
 FROM public.asaas_payments WHERE order_id='81000000-0000-4000-a000-000000000001';
$$;
CREATE TEMP TABLE edit_snapshot AS SELECT pg_temp.snapshot() AS value;
CREATE FUNCTION pg_temp.edit(rows jsonb, expected jsonb DEFAULT pg_temp.snapshot()) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.api_edit_manual_payment_installments('stock','81000000-0000-4000-a000-000000000001',rows,expected,'81000000-0000-4000-a000-000000000099');
$$;
SELECT lives_ok($$ SELECT pg_temp.edit('[{"id":"81000000-0000-4000-a000-000000000011","value":100,"due_date":"2026-10-05","credit_date":"2026-10-05"},{"id":"81000000-0000-4000-a000-000000000012","value":200,"due_date":"2026-11-07","credit_date":"2026-11-07"}]') $$,'dates and unequal amounts can be edited');
SELECT is((SELECT sum(value) FROM public.asaas_payments WHERE order_id='81000000-0000-4000-a000-000000000001'),300::numeric,'gross total preserved');
SELECT is((SELECT sum(net_value) FROM public.asaas_payments WHERE order_id='81000000-0000-4000-a000-000000000001'),300::numeric,'net values follow edited amounts');
SELECT is((SELECT count(*) FROM public.sales_status_events WHERE order_id='81000000-0000-4000-a000-000000000001' AND reason='manual_payment_installments_edited'),1::bigint,'audit event recorded');
SELECT throws_ok($$ SELECT pg_temp.edit(pg_temp.snapshot(),(SELECT value FROM edit_snapshot)) $$,'P0001','As parcelas foram alteradas. Atualize a página e tente novamente','stale snapshot rejected');
SELECT throws_ok($$ SELECT pg_temp.edit(jsonb_set(pg_temp.snapshot(),'{0,value}','101')) $$,'22023','A soma das parcelas precisa ser igual ao valor total','changed total rejected');
SELECT is((SELECT value FROM public.asaas_payments WHERE id='81000000-0000-4000-a000-000000000011'),100::numeric,'invalid transaction rolled back');
SELECT throws_ok($$ SELECT pg_temp.edit(jsonb_set(pg_temp.snapshot(),'{0,id}','"81000000-0000-4000-a000-000000000088"')) $$,'22023','Parcela não pertence a este pagamento','foreign installment rejected');
UPDATE public.stock_orders SET payment_status='refunded' WHERE id='81000000-0000-4000-a000-000000000001';
SELECT throws_ok($$ SELECT pg_temp.edit(pg_temp.snapshot()) $$,'P0001','Somente pagamentos manuais pagos podem ter parcelas editadas','refunded payment rejected');
SELECT * FROM finish();
ROLLBACK;
