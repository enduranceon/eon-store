-- Pendência de repasse de contrato pago e depois cancelado continua devida.
--
-- O gatilho payout_pending_repasse_guard_inactive_contract cancela a pendência
-- que fica aberta num contrato cancelado, descartado ou em rascunho. Só que o
-- fechamento paga os dias de um contrato pago até a data do cancelamento, e ao
-- recalcular um fechamento as pendências que ele tinha resgatado voltam a ficar
-- abertas. O gatilho cancelava então as de um contrato pago e depois cancelado,
-- e os dias dos meses anteriores sumiam do repasse.
--
-- Agora a pendência de contrato cancelado só é cancelada quando não vai mais
-- ser paga, pela mesma regra com que o fechamento a libera: o contrato não foi
-- pago ou, na diferença de uma mudança de plano, a diferença não foi paga.
-- Contrato descartado ou em rascunho continua cancelando a pendência.

CREATE OR REPLACE FUNCTION public.guard_open_payout_for_inactive_contract()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_contract_status TEXT;
  v_payment_status TEXT;
  v_payable BOOLEAN;
BEGIN
  IF NEW.status IS DISTINCT FROM 'open' THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT contract.status, contract.payment_status
    INTO v_contract_status, v_payment_status
    FROM public.assessment_contracts contract
    WHERE contract.id = NEW.contract_id
    FOR SHARE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    -- payout rows are locked before BEFORE UPDATE triggers run, while renewal
    -- completion locks the contract first. Never wait in the reverse order or
    -- persist a false cancelled row that would occupy the payout unique key.
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'O contrato está sendo atualizado; refaça o fechamento mensal';
  END;

  IF NOT FOUND OR v_contract_status IS NULL
     OR v_contract_status NOT IN ('voided', 'cancelled', 'draft') THEN
    RETURN NEW;
  END IF;

  -- Contrato cancelado depois de pago: a pendência continua devida, como o
  -- fechamento a libera (contrato pago; ou diferença paga ou sem cobrança).
  IF v_contract_status = 'cancelled' THEN
    IF NEW.plan_change_id IS NULL THEN
      v_payable := v_payment_status = 'paid';
    ELSE
      SELECT change.payment_status IN ('paid', 'not_required')
      INTO v_payable
      FROM public.assessment_contract_plan_changes change
      WHERE change.id = NEW.plan_change_id;
    END IF;
    IF v_payable THEN
      RETURN NEW;
    END IF;
  END IF;

  NEW.status := 'cancelled';
  NEW.resolved_at := COALESCE(NEW.resolved_at, now());
  NEW.resolved_in_closing_id := NULL;
  RETURN NEW;
END;
$$;

-- As duas pendências de agosto do ASS-000178 que o recálculo de setembro feito
-- em 01/10/2026 cancelou por esse motivo voltam a ficar abertas; o próximo
-- recálculo de setembro as paga. Só mudam se ainda estiverem como o recálculo
-- deixou. Em outro banco, nada muda.
UPDATE public.payout_pending_repasse AS pending
SET status = 'open',
    resolved_at = NULL,
    resolved_in_closing_id = NULL
FROM public.assessment_contracts AS contract
WHERE pending.id IN (
    '23d5f2b8-83cb-4a6d-a2ba-50c1531443c8',
    '367ab26a-527a-435f-964a-7d19f03f2717'
  )
  AND pending.status = 'cancelled'
  AND pending.resolved_in_closing_id IS NULL
  AND pending.plan_change_id IS NULL
  AND contract.id = pending.contract_id
  AND contract.status = 'cancelled'
  AND contract.payment_status = 'paid';
