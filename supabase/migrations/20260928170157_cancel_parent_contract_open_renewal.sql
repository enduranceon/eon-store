BEGIN;

-- Cancelling a current contract must not leave a clean renewal draft open.
-- Only drafts with no financial footprint are voided automatically. Anything
-- with a charge, payment, refund, payout or in-flight operation remains for
-- explicit reconciliation through the renewal-resolution workflow.
CREATE OR REPLACE FUNCTION public.perform_assessment_contract_cancellation(
  p_contract public.assessment_contracts,
  p_cancellation_date date,
  p_cancellation_fee_pct numeric,
  p_reason text,
  p_actor_id uuid,
  p_source text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE := p_contract;
  v_renewal public.assessment_contracts%ROWTYPE;
  v_price_total numeric;
  v_total_days integer;
  v_remaining_days integer;
  v_remaining numeric;
  v_fee numeric;
  v_refund numeric;
  v_payment_status_before text := p_contract.payment_status;
  v_term_completed boolean;
  v_next_status text;
  v_parent_renewal_generated boolean;
  v_voided_renewal_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  SELECT coalesce(
    CASE WHEN jsonb_typeof(v_contract.plan_snapshot->'price_total') IN ('number', 'string')
      THEN nullif(v_contract.plan_snapshot->>'price_total', '')::numeric END,
    plan.price_total,
    0
  ) INTO v_price_total
  FROM public.assessment_plans plan
  WHERE plan.id = v_contract.plan_id;
  v_price_total := coalesce(v_price_total, 0);

  v_total_days := greatest(1, (v_contract.end_date - v_contract.start_date) + 1);
  v_remaining_days := greatest(0, (v_contract.end_date - p_cancellation_date) + 1);
  v_remaining := round(v_price_total * v_remaining_days / v_total_days, 2);
  v_fee := round(v_remaining * p_cancellation_fee_pct / 100, 2);
  v_refund := greatest(0, round(v_remaining - v_fee, 2));

  -- end_date is exclusive: the last active day is end_date - 1.
  v_term_completed := v_contract.end_date IS NOT NULL
                      AND p_cancellation_date >= v_contract.end_date;
  v_next_status := CASE WHEN v_term_completed THEN 'finished' ELSE 'cancelled' END;

  -- SKIP LOCKED prevents a deadlock with the renewal-resolution workflow,
  -- whose canonical lock order is child -> parent. A concurrently handled
  -- child is left for that workflow, which also accepts a cancelled parent
  -- through the parent_cancelled discard reason added below.
  FOR v_renewal IN
    SELECT renewal.*
    FROM public.assessment_contracts renewal
    WHERE renewal.parent_contract_id = v_contract.id
      AND renewal.status = 'draft'
      AND renewal.payment_status = 'pending'
      AND NOT coalesce(renewal.manual_payment, false)
      AND renewal.payment_date IS NULL
      AND coalesce(renewal.refund_amount, 0) = 0
      AND renewal.refund_status IS NULL
      AND renewal.refund_date IS NULL
      AND nullif(trim(renewal.refund_notes), '') IS NULL
      AND nullif(renewal.asaas_charge_id, '') IS NULL
      AND nullif(renewal.asaas_payment_link, '') IS NULL
      AND nullif(renewal.asaas_pix_copy, '') IS NULL
      AND nullif(renewal.asaas_pix_qrcode, '') IS NULL
      AND nullif(renewal.external_payment_link, '') IS NULL
      AND nullif(renewal.external_invoice_number, '') IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.asaas_payments payment
        WHERE payment.order_type = 'contract'
          AND payment.order_id = renewal.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.payout_monthly_statement_items statement_item
        WHERE statement_item.contract_id = renewal.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.payout_pending_repasse pending_repasse
        WHERE pending_repasse.contract_id = renewal.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.order_operations operation
        WHERE operation.order_type = 'contract'
          AND operation.order_id = renewal.id
          AND operation.status IN ('prepared', 'reconciliation_required')
      )
    ORDER BY renewal.id
    FOR UPDATE OF renewal SKIP LOCKED
  LOOP
    UPDATE public.assessment_contracts
    SET status = 'voided',
        payment_status = 'cancelled',
        payment_method = NULL,
        payment_date = NULL,
        due_date = NULL,
        manual_payment = false,
        manual_fee = NULL,
        asaas_charge_id = NULL,
        asaas_payment_link = NULL,
        asaas_pix_qrcode = NULL,
        asaas_pix_copy = NULL,
        external_payment_link = NULL,
        external_invoice_number = NULL,
        payment_message_sent_at = NULL,
        cancellation_date = NULL,
        cancellation_fee = 0,
        cancellation_reason = 'Contrato anterior cancelado',
        refund_status = NULL,
        refund_amount = NULL,
        refund_date = NULL,
        refund_notes = NULL,
        updated_at = now()
    WHERE id = v_renewal.id;

    INSERT INTO public.sales_status_events (
      order_type, order_id, previous_status, new_status, reason, metadata, actor_id
    ) VALUES (
      'contract', v_renewal.id, v_renewal.payment_status, 'cancelled',
      'Contrato anterior cancelado',
      jsonb_build_object(
        'action', 'renewal_resolved',
        'resolution', 'discard',
        'reason_code', 'parent_cancelled',
        'parent_contract_id', v_contract.id,
        'automatic', true
      ),
      p_actor_id
    );

    INSERT INTO public.assessment_contract_event (
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_renewal.id,
      'sale_voided',
      jsonb_build_object(
        'resolution', 'discard',
        'reason_code', 'parent_cancelled',
        'parent_contract_id', v_contract.id,
        'previous_status', v_renewal.status,
        'previous_payment_status', v_renewal.payment_status,
        'automatic', true,
        'no_financial_penalty', true
      ),
      'Contrato anterior cancelado',
      p_actor_id
    );

    INSERT INTO public.assessment_contract_event (
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_contract.id,
      'renewal_discarded',
      jsonb_build_object(
        'discarded_contract_id', v_renewal.id,
        'discarded_contract_number', v_renewal.contract_number,
        'resolution', 'discard',
        'reason_code', 'parent_cancelled',
        'automatic', true,
        'no_financial_penalty', true
      ),
      'Rascunho descartado automaticamente pelo cancelamento do contrato anterior',
      p_actor_id
    );

    v_voided_renewal_ids := array_append(v_voided_renewal_ids, v_renewal.id);
  END LOOP;

  SELECT EXISTS (
    SELECT 1
    FROM public.assessment_contracts other
    WHERE other.parent_contract_id = v_contract.id
      AND other.status IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave')
  ) INTO v_parent_renewal_generated;

  UPDATE public.assessment_contracts
  SET status = v_next_status,
      cancellation_date = p_cancellation_date,
      cancellation_fee = v_fee,
      cancellation_reason = nullif(btrim(p_reason), ''),
      refund_status = CASE WHEN v_refund > 0 THEN 'pending' ELSE NULL END,
      refund_amount = CASE WHEN v_refund > 0 THEN v_refund ELSE NULL END,
      renewal_generated = v_parent_renewal_generated,
      scheduled_cancellation_date = NULL,
      scheduled_cancellation_fee_pct = NULL,
      scheduled_cancellation_reason = NULL,
      scheduled_cancellation_at = NULL,
      scheduled_cancellation_by = NULL,
      updated_at = now()
  WHERE id = v_contract.id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(contract_id, event_type, payload, notes, created_by)
  VALUES (v_contract.id, 'cancelled', jsonb_build_object(
    'remaining_days', v_remaining_days,
    'remaining_value', v_remaining,
    'cancellation_fee', v_fee,
    'cancellation_fee_pct', p_cancellation_fee_pct,
    'refund_amount', v_refund,
    'cancellation_reason', nullif(btrim(p_reason), ''),
    'cancellation_date', p_cancellation_date,
    'payment_status_before', v_payment_status_before,
    'term_completed', v_term_completed,
    'status_after', v_next_status,
    'source', p_source,
    'voided_renewal_ids', to_jsonb(v_voided_renewal_ids)
  ), nullif(btrim(p_reason), ''), p_actor_id);

  RETURN jsonb_build_object(
    'contract', to_jsonb(v_contract),
    'remaining_days', v_remaining_days,
    'remaining', v_remaining,
    'cancellation_fee', v_fee,
    'refund_amount', v_refund,
    'term_completed', v_term_completed,
    'status', v_next_status,
    'voided_renewal_ids', to_jsonb(v_voided_renewal_ids)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.perform_assessment_contract_cancellation(
  public.assessment_contracts, date, numeric, text, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.perform_assessment_contract_cancellation(
  public.assessment_contracts, date, numeric, text, uuid, text
) TO service_role;

-- A clean local install does not inherit the hosted project's broad
-- service_role table grants. Keep the helper as SECURITY INVOKER and grant
-- only the two additional reads required to prove there is no payout before
-- discarding a renewal draft.
GRANT SELECT ON TABLE public.payout_monthly_statement_items TO service_role;
GRANT SELECT ON TABLE public.payout_pending_repasse TO service_role;

-- Extend the existing audited resolution protocol with one precise discard
-- reason. Dynamic replacement keeps the mature provider-cancellation protocol
-- intact while failing the migration if its expected source ever drifts.
DO $migration$
DECLARE
  v_source text;
  v_updated text;
BEGIN
  SELECT pg_get_functiondef(procedure.oid)
  INTO v_source
  FROM pg_catalog.pg_proc procedure
  JOIN pg_catalog.pg_namespace namespace
    ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'public'
    AND procedure.proname = 'prepare_assessment_renewal_resolution';

  IF v_source IS NULL THEN
    RAISE EXCEPTION 'prepare_assessment_renewal_resolution nao encontrada';
  END IF;

  v_updated := replace(
    v_source,
    $old$AND p_reason_code NOT IN ('duplicate', 'created_in_error')$old$,
    $new$AND p_reason_code NOT IN ('duplicate', 'created_in_error', 'parent_cancelled')$new$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'validacao de reason_code da resolucao nao encontrada';
  END IF;
  v_source := v_updated;

  v_updated := replace(
    v_source,
    $old$WHEN 'created_in_error' THEN 'Renovação criada por engano'$old$,
    $new$WHEN 'created_in_error' THEN 'Renovação criada por engano'
       WHEN 'parent_cancelled' THEN 'Contrato anterior foi cancelado'$new$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'descricao canonica da resolucao nao encontrada';
  END IF;
  v_source := v_updated;

  v_updated := replace(
    v_source,
    $old$IF v_parent.status NOT IN ('active', 'overdue', 'on_leave', 'finished') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato anterior não permite esta resolução';
  END IF;$old$,
    $new$IF v_parent.status NOT IN ('active', 'overdue', 'on_leave', 'finished')
     AND NOT (
       p_resolution = 'discard'
       AND p_reason_code = 'parent_cancelled'
       AND v_parent.status = 'cancelled'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato anterior não permite esta resolução';
  END IF;$new$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'validacao de status do contrato anterior nao encontrada';
  END IF;

  EXECUTE v_updated;
END
$migration$;

DO $migration$
DECLARE
  v_source text;
  v_updated text;
BEGIN
  SELECT pg_get_functiondef(procedure.oid)
  INTO v_source
  FROM pg_catalog.pg_proc procedure
  JOIN pg_catalog.pg_namespace namespace
    ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'public'
    AND procedure.proname = 'complete_assessment_renewal_resolution';

  IF v_source IS NULL THEN
    RAISE EXCEPTION 'complete_assessment_renewal_resolution nao encontrada';
  END IF;

  v_updated := replace(
    v_source,
    $old$OR v_parent.status NOT IN ('active', 'overdue', 'on_leave', 'finished')$old$,
    $new$OR (
         v_parent.status NOT IN ('active', 'overdue', 'on_leave', 'finished')
         AND NOT (
           v_resolution = 'discard'
           AND v_reason_code = 'parent_cancelled'
           AND v_parent.status = 'cancelled'
         )
       )$new$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'validacao final do status do contrato anterior nao encontrada';
  END IF;
  v_source := v_updated;

  v_updated := replace(
    v_source,
    $old$WHEN 'created_in_error' THEN 'Venda criada por engano'
        ELSE 'Renovação não concretizada (cliente não renovou)'$old$,
    $new$WHEN 'created_in_error' THEN 'Venda criada por engano'
        WHEN 'parent_cancelled' THEN 'Contrato anterior cancelado'
        ELSE 'Renovação não concretizada (cliente não renovou)'$new$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'motivo final do descarte nao encontrado';
  END IF;

  EXECUTE v_updated;
END
$migration$;

REVOKE ALL ON FUNCTION public.prepare_assessment_renewal_resolution(
  uuid, text, text, text, timestamptz, text, text, boolean, text,
  boolean, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_assessment_renewal_resolution(
  uuid, text, text, text, timestamptz, text, text, boolean, text,
  boolean, text, uuid
) TO service_role;

REVOKE ALL ON FUNCTION public.complete_assessment_renewal_resolution(
  uuid, uuid, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_assessment_renewal_resolution(
  uuid, uuid, jsonb
) TO service_role;

COMMIT;
