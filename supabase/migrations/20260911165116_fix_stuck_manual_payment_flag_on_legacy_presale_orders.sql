-- Corrige 10 pedidos de pre-venda presos por um bug da migration de
-- 2026-06-09 (20260609002302_secure_public_checkout_and_sale_state.sql):
-- o backfill daquela migration mudou payment_status de pedidos legados
-- para 'awaiting_charge' sem resetar a flag manual_payment nos casos em
-- que ela ja estava true, deixando esses pedidos numa combinacao
-- impossivel (manual_payment=true + status != 'paid' + sem metodo/data
-- de pagamento) que bloqueia tanto "reabrir" quanto "cadastrar cobranca
-- externa". Nenhum desses pedidos esta de fato pago (payment_method e
-- payment_date ja sao NULL), entao so desmarca a flag, sem tocar em
-- valores, status de entrega ou qualquer outro dado.
UPDATE public.presale_orders
SET manual_payment = false, updated_date = now()
WHERE manual_payment = true
  AND payment_status <> 'paid'
  AND payment_method IS NULL
  AND payment_date IS NULL;
