-- Checkout preference and settled payment method represent different facts.
-- Orders without any charge evidence must not retain the preference as if it
-- were the method actually used.
UPDATE public.presale_orders
SET payment_method = NULL,
    updated_date = now()
WHERE payment_status = 'awaiting_charge'
  AND payment_preference IS NOT NULL
  AND asaas_charge_id IS NULL
  AND asaas_payment_link IS NULL
  AND asaas_pix_copy IS NULL
  AND external_payment_link IS NULL
  AND payment_message_sent_at IS NULL;

UPDATE public.stock_orders
SET payment_method = NULL,
    updated_date = now()
WHERE payment_status = 'awaiting_charge'
  AND payment_preference IS NOT NULL
  AND asaas_charge_id IS NULL
  AND asaas_payment_link IS NULL
  AND asaas_pix_copy IS NULL
  AND external_payment_link IS NULL
  AND payment_message_sent_at IS NULL;
