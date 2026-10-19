-- Cartão de débito com código interno, como as outras formas.
--
-- A forma "Cartão de Débito" foi criada sem internal_code. Sem ele, a
-- conferência das faturas do Asaas não consegue ligar o débito do Asaas à
-- forma do "Receber" e manda registrar à mão; e o pagamento manual gravava na
-- venda o tipo genérico ("other"). Com o código debit_card, a conferência
-- registra o débito como faz com PIX, boleto e crédito, e a venda mostra
-- "Cartão de débito".

UPDATE public.payment_methods
SET internal_code = 'debit_card',
    updated_at = now()
WHERE id = (
  SELECT id FROM public.payment_methods
  WHERE internal_code IS NULL
    AND lower(name) IN ('cartão de débito', 'cartao de debito')
  ORDER BY created_at, id
  LIMIT 1
)
AND NOT EXISTS (
  SELECT 1 FROM public.payment_methods WHERE internal_code = 'debit_card'
);

-- Vendas já pagas no débito ficaram com "other": passam a mostrar a forma certa.
UPDATE public.assessment_contracts contract
SET payment_method = 'debit_card'
WHERE contract.payment_method = 'other'
  AND EXISTS (
    SELECT 1
    FROM public.asaas_payments payment
    JOIN public.payment_methods method ON method.id = payment.payment_method_id
    WHERE payment.order_type = 'contract'
      AND payment.order_id = contract.id
      AND payment.source = 'manual'
      AND method.internal_code = 'debit_card'
  );

UPDATE public.stock_orders sale
SET payment_method = 'debit_card'
WHERE sale.payment_method = 'other'
  AND EXISTS (
    SELECT 1
    FROM public.asaas_payments payment
    JOIN public.payment_methods method ON method.id = payment.payment_method_id
    WHERE payment.order_type = 'stock'
      AND payment.order_id = sale.id
      AND payment.source = 'manual'
      AND method.internal_code = 'debit_card'
  );

UPDATE public.presale_orders sale
SET payment_method = 'debit_card'
WHERE sale.payment_method = 'other'
  AND EXISTS (
    SELECT 1
    FROM public.asaas_payments payment
    JOIN public.payment_methods method ON method.id = payment.payment_method_id
    WHERE payment.order_type = 'presale'
      AND payment.order_id = sale.id
      AND payment.source = 'manual'
      AND method.internal_code = 'debit_card'
  );
