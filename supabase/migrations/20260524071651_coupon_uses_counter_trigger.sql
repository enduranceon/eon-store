
-- Trigger SECURITY DEFINER pra incrementar/decrementar uses_count
-- com privilégios do owner (bypass RLS), evitando que anon precise de UPDATE

CREATE OR REPLACE FUNCTION sync_coupon_uses_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- INSERT: novo uso (não-cancelado) → incrementa
  IF TG_OP = 'INSERT' THEN
    IF NEW.coupon_id IS NOT NULL AND NEW.cancelled = false THEN
      UPDATE coupons
      SET uses_count = COALESCE(uses_count, 0) + 1
      WHERE id = NEW.coupon_id;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: cancelou um uso (cancelled false → true) → decrementa
  IF TG_OP = 'UPDATE' THEN
    IF OLD.cancelled = false AND NEW.cancelled = true AND NEW.coupon_id IS NOT NULL THEN
      UPDATE coupons
      SET uses_count = GREATEST(0, COALESCE(uses_count, 0) - 1)
      WHERE id = NEW.coupon_id;
    -- Re-ativou? (cancelled true → false) → incrementa
    ELSIF OLD.cancelled = true AND NEW.cancelled = false AND NEW.coupon_id IS NOT NULL THEN
      UPDATE coupons
      SET uses_count = COALESCE(uses_count, 0) + 1
      WHERE id = NEW.coupon_id;
    END IF;
    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS coupon_uses_sync_counter ON coupon_uses;

CREATE TRIGGER coupon_uses_sync_counter
AFTER INSERT OR UPDATE ON coupon_uses
FOR EACH ROW
EXECUTE FUNCTION sync_coupon_uses_count();

-- Reconcilia contadores existentes (caso já tenha sido testado antes do trigger)
UPDATE coupons c
SET uses_count = COALESCE((
  SELECT COUNT(*) FROM coupon_uses cu
  WHERE cu.coupon_id = c.id AND cu.cancelled = false
), 0);
;
