-- Sensitive order/customer data is exposed through validated Edge Functions,
-- not through direct anonymous table access.
REVOKE SELECT, REFERENCES, TRIGGER
  ON TABLE
    public.presale_customers,
    public.presale_orders,
    public.stock_orders,
    public.coupons
  FROM anon;
