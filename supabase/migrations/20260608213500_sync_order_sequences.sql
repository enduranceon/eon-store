-- Imported/legacy orders can leave sequences behind the greatest persisted
-- number, causing the next checkout to collide with an existing order.
SELECT setval(
  'public.presale_order_seq',
  GREATEST(
    COALESCE((
      SELECT MAX(NULLIF(regexp_replace(order_number, '\D', '', 'g'), '')::bigint)
      FROM public.presale_orders
    ), 0),
    1
  ),
  true
);

SELECT setval(
  'public.stock_order_number_seq',
  GREATEST(
    COALESCE((
      SELECT MAX(NULLIF(regexp_replace(order_number, '\D', '', 'g'), '')::bigint)
      FROM public.stock_orders
    ), 0),
    1
  ),
  EXISTS (SELECT 1 FROM public.stock_orders)
);
