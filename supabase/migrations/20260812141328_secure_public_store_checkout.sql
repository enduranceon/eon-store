-- The public store must not write directly through a browser-callable RPC.
-- Its checkout is now mediated by the public-store-checkout Edge Function,
-- which rate-limits abusive requests before this transaction reserves stock.

CREATE TABLE eon_private.public_store_checkout_rate_limits (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ip_hash text NOT NULL,
  phone_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX public_store_checkout_rate_limits_ip_idx
  ON eon_private.public_store_checkout_rate_limits (ip_hash, created_at DESC);

CREATE INDEX public_store_checkout_rate_limits_phone_idx
  ON eon_private.public_store_checkout_rate_limits (phone_hash, created_at DESC);

ALTER TABLE eon_private.public_store_checkout_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE eon_private.public_store_checkout_rate_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE eon_private.public_store_checkout_rate_limits TO service_role;
GRANT USAGE, SELECT ON SEQUENCE eon_private.public_store_checkout_rate_limits_id_seq TO service_role;

CREATE OR REPLACE FUNCTION eon_private.create_rate_limited_public_stock_order(
  p_payload jsonb,
  p_ip_hash text,
  p_phone_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ip_hash text := nullif(trim(p_ip_hash), '');
  v_phone_hash text := nullif(trim(p_phone_hash), '');
BEGIN
  IF v_ip_hash IS NULL OR v_phone_hash IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Não foi possível validar a origem do pedido';
  END IF;

  -- Serialize each IP and phone bucket so parallel requests cannot bypass limits.
  PERFORM pg_advisory_xact_lock(hashtextextended('public-store-ip:' || v_ip_hash, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('public-store-phone:' || v_phone_hash, 0));

  DELETE FROM eon_private.public_store_checkout_rate_limits
  WHERE created_at < now() - interval '2 days';

  IF (
    SELECT count(*)
    FROM eon_private.public_store_checkout_rate_limits
    WHERE ip_hash = v_ip_hash
      AND created_at >= now() - interval '1 hour'
  ) >= 5 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Muitas tentativas de pedido. Aguarde alguns minutos e tente novamente';
  END IF;

  IF (
    SELECT count(*)
    FROM eon_private.public_store_checkout_rate_limits
    WHERE phone_hash = v_phone_hash
      AND created_at >= now() - interval '1 day'
  ) >= 3 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este telefone já enviou vários pedidos hoje. Entre em contato com a equipe';
  END IF;

  INSERT INTO eon_private.public_store_checkout_rate_limits (ip_hash, phone_hash)
  VALUES (v_ip_hash, v_phone_hash);

  -- This call shares the transaction: failed order creation also rolls back the rate record.
  RETURN eon_private.create_public_stock_order(p_payload);
END;
$$;

COMMENT ON FUNCTION eon_private.create_rate_limited_public_stock_order(jsonb, text, text) IS
  'Creates a public store order only after atomic IP and phone rate limiting.';;
