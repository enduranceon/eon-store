
CREATE TABLE IF NOT EXISTS order_returns (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id        uuid        NOT NULL,
  order_type      text        NOT NULL CHECK (order_type IN ('presale', 'stock')),
  order_number    text,
  customer_name   text,
  item_index      integer     NOT NULL,
  product_id      uuid,                          -- ref stock_products (só pedidos de loja)
  product_name    text        NOT NULL,
  variation       text,
  quantity        integer     NOT NULL DEFAULT 1,
  unit_price      numeric     NOT NULL DEFAULT 0,
  refund_value    numeric     NOT NULL DEFAULT 0,
  was_delivered   boolean     NOT NULL DEFAULT false,
  status          text        NOT NULL DEFAULT 'pending_return'
                              CHECK (status IN ('pending_return', 'received', 'completed')),
  notes           text,
  created_at      timestamptz DEFAULT now(),
  received_at     timestamptz,
  completed_at    timestamptz
);

ALTER TABLE order_returns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_full_access"
  ON order_returns FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
;
