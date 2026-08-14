-- Every operational assessment contract with no payment or charge must be
-- represented as an open sale. Draft prospects and renewal drafts remain
-- outside the financial queue until they are approved.

CREATE OR REPLACE FUNCTION public.normalize_assessment_contract_open_sale_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status IN ('scheduled', 'active', 'overdue', 'on_leave')
     AND NEW.payment_status = 'pending'
     AND NOT COALESCE(NEW.manual_payment, false)
     AND NEW.payment_date IS NULL
     AND COALESCE(NEW.refund_amount, 0) = 0
     AND NEW.refund_status IS NULL
     AND NULLIF(NEW.asaas_charge_id, '') IS NULL
     AND NULLIF(NEW.asaas_payment_link, '') IS NULL
     AND NULLIF(NEW.asaas_pix_copy, '') IS NULL
     AND NULLIF(NEW.asaas_pix_qrcode, '') IS NULL
     AND NULLIF(NEW.external_payment_link, '') IS NULL THEN
    NEW.payment_status := 'awaiting_charge';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_assessment_contract_open_sale()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_previous_status text;
  v_actor_id uuid;
BEGIN
  IF NEW.status NOT IN ('scheduled', 'active', 'overdue', 'on_leave')
     OR NEW.payment_status <> 'awaiting_charge'
     OR COALESCE(NEW.manual_payment, false)
     OR NEW.payment_date IS NOT NULL
     OR COALESCE(NEW.refund_amount, 0) <> 0
     OR NEW.refund_status IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_previous_status := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.payment_status END;
  IF TG_OP = 'UPDATE' AND v_previous_status = NEW.payment_status THEN
    RETURN NEW;
  END IF;

  v_actor_id := COALESCE(auth.uid(), NEW.created_by);

  INSERT INTO public.sales_status_events (
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  ) VALUES (
    'contract',
    NEW.id,
    v_previous_status,
    NEW.payment_status,
    CASE
      WHEN NEW.parent_contract_id IS NOT NULL THEN 'Venda aberta de renovação registrada'
      ELSE 'Venda aberta de contrato registrada'
    END,
    jsonb_build_object(
      'action', 'assessment_contract_open_sale_registered',
      'contract_status', NEW.status,
      'is_renewal', NEW.parent_contract_id IS NOT NULL,
      'requires_charge', true
    ),
    v_actor_id
  );

  INSERT INTO public.assessment_contract_event (
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    NEW.id,
    'open_sale_registered',
    jsonb_build_object(
      'payment_status_before', v_previous_status,
      'payment_status_after', NEW.payment_status,
      'contract_status', NEW.status,
      'is_renewal', NEW.parent_contract_id IS NOT NULL
    ),
    CASE
      WHEN NEW.parent_contract_id IS NOT NULL
        THEN 'Venda em aberto da renovação registrada; aguardando geração da cobrança.'
      ELSE 'Venda em aberto do contrato registrada; aguardando geração da cobrança.'
    END,
    v_actor_id
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assessment_contract_normalize_open_sale_status
  ON public.assessment_contracts;
CREATE TRIGGER assessment_contract_normalize_open_sale_status
BEFORE INSERT OR UPDATE OF status, payment_status, manual_payment, payment_date,
  refund_amount, refund_status, asaas_charge_id, asaas_payment_link,
  asaas_pix_copy, asaas_pix_qrcode, external_payment_link
ON public.assessment_contracts
FOR EACH ROW
EXECUTE FUNCTION public.normalize_assessment_contract_open_sale_status();

DROP TRIGGER IF EXISTS assessment_contract_record_open_sale
  ON public.assessment_contracts;
CREATE TRIGGER assessment_contract_record_open_sale
AFTER INSERT OR UPDATE OF status, payment_status
ON public.assessment_contracts
FOR EACH ROW
EXECUTE FUNCTION public.record_assessment_contract_open_sale();

-- Reclassifies the existing operational contracts that have no payment and no
-- charge evidence. The current production set contains Brenda's renewal.
UPDATE public.assessment_contracts
SET payment_status = 'awaiting_charge',
    updated_at = now()
WHERE status IN ('scheduled', 'active', 'overdue', 'on_leave')
  AND payment_status = 'pending'
  AND NOT COALESCE(manual_payment, false)
  AND payment_date IS NULL
  AND COALESCE(refund_amount, 0) = 0
  AND refund_status IS NULL
  AND NULLIF(asaas_charge_id, '') IS NULL
  AND NULLIF(asaas_payment_link, '') IS NULL
  AND NULLIF(asaas_pix_copy, '') IS NULL
  AND NULLIF(asaas_pix_qrcode, '') IS NULL
  AND NULLIF(external_payment_link, '') IS NULL;

REVOKE ALL ON FUNCTION public.normalize_assessment_contract_open_sale_status()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_assessment_contract_open_sale()
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.normalize_assessment_contract_open_sale_status() IS
  'Normalizes operational unpaid assessment contracts to awaiting_charge.';
COMMENT ON FUNCTION public.record_assessment_contract_open_sale() IS
  'Audits every assessment contract that becomes an open sale awaiting charge.';
