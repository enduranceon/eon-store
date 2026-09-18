-- Automates the internal contract lifecycle without creating or consulting any
-- charge in Asaas. Manual renewals keep the review flow; auto-renewals become
-- scheduled five days before the next term and open an internal receivable.

CREATE OR REPLACE FUNCTION public.process_internal_assessment_renewals(
  p_horizon_days integer,
  p_auto_horizon_days integer,
  p_contract_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_forced boolean := COALESCE(array_length(p_contract_ids, 1), 0) > 0;
  v_parent public.assessment_contracts%ROWTYPE;
  v_renewal public.assessment_contracts%ROWTYPE;
  v_plan public.assessment_plans%ROWTYPE;
  v_snapshot jsonb;
  v_months integer;
  v_start date;
  v_target_month date;
  v_end date;
  v_due_date date;
  v_new_status text;
  v_previous_parent_status text;
  v_is_auto boolean;
  v_discount_recurring boolean;
  v_created_count integer := 0;
  v_draft_count integer := 0;
  v_auto_scheduled_count integer := 0;
  v_auto_activated_count integer := 0;
  v_existing_auto_approved_count integer := 0;
  v_scheduled_activated_count integer := 0;
  v_results jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
BEGIN
  IF p_horizon_days IS NULL OR p_horizon_days < 1 OR p_horizon_days > 90 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'A janela de renovação deve ficar entre 1 e 90 dias';
  END IF;
  IF p_auto_horizon_days IS NULL OR p_auto_horizon_days < 1
     OR p_auto_horizon_days > 90 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'A janela automática deve ficar entre 1 e 90 dias';
  END IF;

  -- Scheduled renewals must become active without depending on an operator
  -- opening a page. The parent term ends in the same transaction.
  FOR v_renewal IN
    SELECT renewal.*
    FROM public.assessment_contracts AS renewal
    JOIN public.assessment_contracts AS parent
      ON parent.id = renewal.parent_contract_id
    WHERE renewal.parent_contract_id IS NOT NULL
      AND renewal.status = 'scheduled'
      AND renewal.start_date <= v_today
      AND parent.status IN ('active', 'overdue', 'on_leave', 'finished')
      AND parent.scheduled_cancellation_date IS NULL
      AND parent.cancellation_date IS NULL
      AND NULLIF(btrim(parent.cancellation_reason), '') IS NULL
      AND (NOT renewal.auto_renewal OR parent.auto_renewal)
    ORDER BY renewal.start_date, renewal.created_at
    FOR UPDATE OF renewal SKIP LOCKED
  LOOP
    SELECT * INTO v_parent
    FROM public.assessment_contracts
    WHERE id = v_renewal.parent_contract_id
    FOR UPDATE;

    IF v_parent.status NOT IN ('active', 'overdue', 'on_leave', 'finished')
       OR v_parent.scheduled_cancellation_date IS NOT NULL
       OR v_parent.cancellation_date IS NOT NULL
       OR NULLIF(btrim(v_parent.cancellation_reason), '') IS NOT NULL
       OR (v_renewal.auto_renewal AND NOT v_parent.auto_renewal) THEN
      CONTINUE;
    END IF;

    v_previous_parent_status := v_parent.status;

    UPDATE public.assessment_contracts
    SET status = 'active',
        updated_at = now()
    WHERE id = v_renewal.id
    RETURNING * INTO v_renewal;

    UPDATE public.assessment_contracts
    SET renewal_generated = true,
        status = CASE
          WHEN status IN ('active', 'overdue', 'on_leave') THEN 'finished'
          ELSE status
        END,
        updated_at = now()
    WHERE id = v_parent.id
    RETURNING * INTO v_parent;

    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes
    ) VALUES (
      v_renewal.id,
      'status_transitioned',
      jsonb_build_object(
        'status_before', 'scheduled',
        'status_after', 'active',
        'effective_date', v_today,
        'source', 'internal_renewal_job'
      ),
      'Renovação ativada automaticamente no início da vigência.'
    );

    IF v_parent.status IS DISTINCT FROM v_previous_parent_status THEN
      INSERT INTO public.assessment_contract_event(
        contract_id, event_type, payload, notes
      ) VALUES (
        v_parent.id,
        'status_transitioned',
        jsonb_build_object(
          'status_before', v_previous_parent_status,
          'status_after', v_parent.status,
          'effective_date', v_today,
          'reason', 'renewal_started',
          'renewal_contract_id', v_renewal.id,
          'source', 'internal_renewal_job'
        ),
        'Contrato concluído automaticamente pelo início da renovação.'
      );
    END IF;

    v_scheduled_activated_count := v_scheduled_activated_count + 1;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'action', 'scheduled_renewal_activated',
      'parent_id', v_parent.id,
      'parent_number', v_parent.contract_number,
      'renewal_id', v_renewal.id,
      'renewal_number', v_renewal.contract_number,
      'status', v_renewal.status,
      'payment_status', v_renewal.payment_status
    ));
  END LOOP;

  -- Drafts created by the previous implementation are approved only when both
  -- the parent and the draft still opt into automatic renewal.
  FOR v_renewal IN
    SELECT renewal.*
    FROM public.assessment_contracts AS renewal
    JOIN public.assessment_contracts AS parent
      ON parent.id = renewal.parent_contract_id
    WHERE renewal.status = 'draft'
      AND renewal.auto_renewal
      AND renewal.start_date <= v_today + p_auto_horizon_days
      AND renewal.payment_status IN ('pending', 'awaiting_charge')
      AND NOT COALESCE(renewal.manual_payment, false)
      AND renewal.payment_date IS NULL
      AND COALESCE(renewal.refund_amount, 0) = 0
      AND renewal.refund_status IS NULL
      AND NULLIF(renewal.asaas_charge_id, '') IS NULL
      AND NULLIF(renewal.asaas_payment_link, '') IS NULL
      AND NULLIF(renewal.asaas_pix_copy, '') IS NULL
      AND NULLIF(renewal.asaas_pix_qrcode, '') IS NULL
      AND NULLIF(renewal.external_payment_link, '') IS NULL
      AND parent.auto_renewal
      AND parent.status IN ('active', 'overdue', 'on_leave', 'finished')
      AND parent.scheduled_cancellation_date IS NULL
      AND parent.cancellation_date IS NULL
      AND NULLIF(btrim(parent.cancellation_reason), '') IS NULL
    ORDER BY renewal.start_date, renewal.created_at
    FOR UPDATE OF renewal SKIP LOCKED
  LOOP
    SELECT * INTO v_parent
    FROM public.assessment_contracts
    WHERE id = v_renewal.parent_contract_id
    FOR UPDATE;

    IF NOT v_parent.auto_renewal
       OR v_parent.scheduled_cancellation_date IS NOT NULL
       OR v_parent.cancellation_date IS NOT NULL
       OR NULLIF(btrim(v_parent.cancellation_reason), '') IS NOT NULL THEN
      CONTINUE;
    END IF;

    v_new_status := CASE
      WHEN v_renewal.start_date > v_today THEN 'scheduled'
      ELSE 'active'
    END;
    v_previous_parent_status := v_parent.status;

    UPDATE public.assessment_contracts
    SET status = v_new_status,
        due_date = GREATEST(start_date, v_today),
        updated_at = now()
    WHERE id = v_renewal.id
    RETURNING * INTO v_renewal;

    UPDATE public.assessment_contracts
    SET renewal_generated = true,
        status = CASE
          WHEN v_new_status = 'active'
            AND status IN ('active', 'overdue', 'on_leave') THEN 'finished'
          ELSE status
        END,
        updated_at = now()
    WHERE id = v_parent.id
    RETURNING * INTO v_parent;

    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes
    ) VALUES (
      v_renewal.id,
      CASE WHEN v_new_status = 'scheduled'
        THEN 'renewal_scheduled' ELSE 'renewal_activated' END,
      jsonb_build_object(
        'parent_contract_id', v_parent.id,
        'parent_contract_number', v_parent.contract_number,
        'status_after', v_new_status,
        'payment_status_after', v_renewal.payment_status,
        'start_date', v_renewal.start_date,
        'automatic', true,
        'source', 'internal_renewal_job'
      ),
      CASE WHEN v_new_status = 'scheduled'
        THEN 'Rascunho aprovado e agendado pela renovação automática interna.'
        ELSE 'Rascunho ativado pela renovação automática interna.' END
    ), (
      v_parent.id,
      'renewed',
      jsonb_build_object(
        'new_contract_id', v_renewal.id,
        'new_contract_number', v_renewal.contract_number,
        'new_start', v_renewal.start_date,
        'new_end', v_renewal.end_date,
        'new_status', v_new_status,
        'automatic', true,
        'source', 'internal_renewal_job'
      ),
      'Renovação automática interna confirmada.'
    );

    IF v_parent.status IS DISTINCT FROM v_previous_parent_status THEN
      INSERT INTO public.assessment_contract_event(
        contract_id, event_type, payload, notes
      ) VALUES (
        v_parent.id,
        'status_transitioned',
        jsonb_build_object(
          'status_before', v_previous_parent_status,
          'status_after', v_parent.status,
          'effective_date', v_today,
          'reason', 'renewal_started',
          'renewal_contract_id', v_renewal.id,
          'source', 'internal_renewal_job'
        ),
        'Contrato concluído automaticamente pelo início da renovação.'
      );
    END IF;

    v_existing_auto_approved_count := v_existing_auto_approved_count + 1;
    IF v_new_status = 'scheduled' THEN
      v_auto_scheduled_count := v_auto_scheduled_count + 1;
    ELSE
      v_auto_activated_count := v_auto_activated_count + 1;
    END IF;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'action', 'automatic_draft_approved',
      'parent_id', v_parent.id,
      'parent_number', v_parent.contract_number,
      'renewal_id', v_renewal.id,
      'renewal_number', v_renewal.contract_number,
      'status', v_renewal.status,
      'payment_status', v_renewal.payment_status,
      'new_start', v_renewal.start_date,
      'new_end', v_renewal.end_date
    ));
  END LOOP;

  FOR v_parent IN
    SELECT parent.*
    FROM public.assessment_contracts AS parent
    WHERE parent.status IN ('active', 'overdue', 'on_leave')
      AND NOT COALESCE(parent.renewal_generated, false)
      AND parent.scheduled_cancellation_date IS NULL
      AND parent.cancellation_date IS NULL
      AND NULLIF(btrim(parent.cancellation_reason), '') IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.assessment_contracts AS child
        WHERE child.parent_contract_id = parent.id
          AND child.status IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave')
      )
      AND (
        (v_forced AND parent.id = ANY(p_contract_ids))
        OR (
          NOT v_forced
          AND (
            (
              NOT parent.auto_renewal
              AND parent.end_date <= v_today + p_horizon_days
            )
            OR (
              parent.auto_renewal
              AND parent.end_date <= v_today + p_auto_horizon_days
            )
          )
        )
      )
    ORDER BY parent.end_date, parent.created_at
    FOR UPDATE OF parent SKIP LOCKED
  LOOP
    BEGIN
      SELECT * INTO v_plan
      FROM public.assessment_plans
      WHERE id = v_parent.plan_id;

      IF v_parent.plan_snapshot IS NULL AND NOT FOUND THEN
        RAISE EXCEPTION 'Plano do contrato não encontrado';
      END IF;

      v_months := COALESCE(
        CASE
          WHEN COALESCE(v_parent.plan_snapshot->>'period_months', '') ~ '^[0-9]+$'
            THEN (v_parent.plan_snapshot->>'period_months')::integer
          ELSE NULL
        END,
        v_plan.period_months,
        CASE COALESCE(v_parent.plan_snapshot->>'period', v_plan.period)
          WHEN 'mensal' THEN 1
          WHEN 'trimestral' THEN 3
          WHEN 'semestral' THEN 6
          WHEN 'anual' THEN 12
          ELSE 1
        END
      );
      IF v_months < 1 OR v_months > 120 THEN
        RAISE EXCEPTION 'Período do plano inválido';
      END IF;

      IF v_parent.plan_snapshot IS NOT NULL THEN
        v_snapshot := v_parent.plan_snapshot || jsonb_build_object(
          'snapshot_at', now(),
          'snapshot_source', 'renewal_parent_snapshot'
        );
      ELSE
        v_snapshot := jsonb_build_object(
          'plan_id', v_plan.id,
          'name', v_plan.name,
          'modality_id', v_plan.modality_id,
          'price_total', v_plan.price_total,
          'price_monthly', v_plan.price_monthly,
          'enrollment_fee', v_plan.enrollment_fee,
          'max_installments', v_plan.max_installments,
          'period_months', v_plan.period_months,
          'period', v_plan.period,
          'revenue_center_id', v_plan.revenue_center_id,
          'snapshot_at', now(),
          'snapshot_source', 'renewal_plan_fallback'
        );
      END IF;

      v_start := v_parent.end_date;
      v_target_month := (
        date_trunc('month', v_start)::date + make_interval(months => v_months)
      )::date;
      v_end := v_target_month + (
        LEAST(
          extract(day FROM v_start)::integer,
          extract(day FROM (v_target_month + interval '1 month - 1 day'))::integer
        ) - 1
      );
      v_due_date := GREATEST(v_start, v_today);
      v_is_auto := v_parent.auto_renewal;
      v_new_status := CASE
        WHEN NOT v_is_auto THEN 'draft'
        WHEN v_start > v_today THEN 'scheduled'
        ELSE 'active'
      END;
      v_discount_recurring := COALESCE(v_parent.discount_recurring, false)
        AND COALESCE(v_parent.manual_discount, 0) > 0;

      INSERT INTO public.assessment_contracts (
        customer_id, coach_id, plan_id, plan_snapshot, status,
        start_date, end_date, original_end_date, due_date, installments,
        enrollment_fee, manual_discount, discount_reason, discount_recurring,
        payment_status, payment_method, auto_renewal, parent_contract_id, notes
      ) VALUES (
        v_parent.customer_id,
        v_parent.coach_id,
        v_parent.plan_id,
        v_snapshot,
        v_new_status,
        v_start,
        v_end,
        v_end,
        v_due_date,
        COALESCE(v_parent.installments, 1),
        0,
        CASE WHEN v_discount_recurring THEN v_parent.manual_discount ELSE 0 END,
        CASE WHEN v_discount_recurring THEN v_parent.discount_reason ELSE NULL END,
        v_discount_recurring,
        'pending',
        v_parent.payment_method,
        v_parent.auto_renewal,
        v_parent.id,
        CASE WHEN v_is_auto
          THEN 'Renovação automática interna de ' || COALESCE(v_parent.contract_number, v_parent.id::text)
          ELSE 'Rascunho de renovação de ' || COALESCE(v_parent.contract_number, v_parent.id::text)
        END
      )
      RETURNING * INTO v_renewal;

      v_previous_parent_status := v_parent.status;
      UPDATE public.assessment_contracts
      SET renewal_generated = true,
          status = CASE
            WHEN v_new_status = 'active' THEN 'finished'
            ELSE status
          END,
          updated_at = now()
      WHERE id = v_parent.id
      RETURNING * INTO v_parent;

      INSERT INTO public.assessment_contract_event(
        contract_id, event_type, payload, notes
      ) VALUES (
        v_renewal.id,
        'created',
        jsonb_build_object(
          'via', CASE WHEN v_is_auto
            THEN 'automatic_renewal' ELSE 'renewal_draft' END,
          'parent_contract_id', v_parent.id,
          'parent_contract_num', v_parent.contract_number,
          'plan_id', v_parent.plan_id,
          'installments', v_parent.installments,
          'due_date', v_due_date,
          'status_after', v_new_status,
          'payment_status_after', v_renewal.payment_status,
          'automatic', v_is_auto
        ),
        CASE WHEN v_is_auto
          THEN 'Renovação automática interna criada.'
          ELSE 'Rascunho de renovação criado automaticamente.' END
      );

      IF v_is_auto THEN
        INSERT INTO public.assessment_contract_event(
          contract_id, event_type, payload, notes
        ) VALUES (
          v_renewal.id,
          CASE WHEN v_new_status = 'scheduled'
            THEN 'renewal_scheduled' ELSE 'renewal_activated' END,
          jsonb_build_object(
            'parent_contract_id', v_parent.id,
            'parent_contract_number', v_parent.contract_number,
            'status_after', v_new_status,
            'payment_status_after', v_renewal.payment_status,
            'start_date', v_start,
            'automatic', true,
            'source', 'internal_renewal_job'
          ),
          CASE WHEN v_new_status = 'scheduled'
            THEN 'Renovação automática interna agendada.'
            ELSE 'Renovação automática interna ativada.' END
        ), (
          v_parent.id,
          'renewed',
          jsonb_build_object(
            'new_contract_id', v_renewal.id,
            'new_contract_number', v_renewal.contract_number,
            'new_start', v_start,
            'new_end', v_end,
            'new_status', v_new_status,
            'payment_status', v_renewal.payment_status,
            'automatic', true,
            'source', 'internal_renewal_job'
          ),
          'Renovação automática interna registrada.'
        );
      ELSE
        INSERT INTO public.assessment_contract_event(
          contract_id, event_type, payload, notes
        ) VALUES (
          v_parent.id,
          'renewal_drafted',
          jsonb_build_object(
            'draft_contract_id', v_renewal.id,
            'draft_contract_number', v_renewal.contract_number,
            'draft_start', v_start,
            'draft_end', v_end,
            'draft_due_date', v_due_date,
            'auto_generated', true,
            'horizon_days', p_horizon_days
          ),
          'Rascunho de renovação gerado automaticamente. Aguardando revisão.'
        );
      END IF;

      IF v_parent.status IS DISTINCT FROM v_previous_parent_status THEN
        INSERT INTO public.assessment_contract_event(
          contract_id, event_type, payload, notes
        ) VALUES (
          v_parent.id,
          'status_transitioned',
          jsonb_build_object(
            'status_before', v_previous_parent_status,
            'status_after', v_parent.status,
            'effective_date', v_today,
            'reason', 'renewal_started',
            'renewal_contract_id', v_renewal.id,
            'source', 'internal_renewal_job'
          ),
          'Contrato concluído automaticamente pelo início da renovação.'
        );
      END IF;

      v_created_count := v_created_count + 1;
      IF NOT v_is_auto THEN
        v_draft_count := v_draft_count + 1;
      ELSIF v_new_status = 'scheduled' THEN
        v_auto_scheduled_count := v_auto_scheduled_count + 1;
      ELSE
        v_auto_activated_count := v_auto_activated_count + 1;
      END IF;

      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'action', CASE WHEN v_is_auto
          THEN 'automatic_renewal_created' ELSE 'renewal_draft_created' END,
        'parent_id', v_parent.id,
        'parent_number', v_parent.contract_number,
        'renewal_id', v_renewal.id,
        'renewal_number', v_renewal.contract_number,
        'status', v_renewal.status,
        'payment_status', v_renewal.payment_status,
        'new_start', v_start,
        'new_end', v_end,
        'due_date', v_due_date
      ));
    EXCEPTION
      WHEN unique_violation THEN
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'contract_id', v_parent.id,
          'contract_number', v_parent.contract_number,
          'error', 'Já existe uma renovação aberta para este contrato'
        ));
      WHEN OTHERS THEN
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'contract_id', v_parent.id,
          'contract_number', v_parent.contract_number,
          'error', SQLERRM
        ));
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'processed', v_created_count + v_existing_auto_approved_count
      + v_scheduled_activated_count,
    'contracts_created', v_created_count,
    'drafts_created', v_draft_count,
    'automatic_renewals_scheduled', v_auto_scheduled_count,
    'automatic_renewals_activated', v_auto_activated_count,
    'automatic_drafts_approved', v_existing_auto_approved_count,
    'scheduled_renewals_activated', v_scheduled_activated_count,
    'results', v_results,
    'errors', v_errors,
    'message', CASE
      WHEN v_created_count + v_existing_auto_approved_count
           + v_scheduled_activated_count = 0
        THEN 'Nenhum contrato dentro da janela de renovação.'
      ELSE NULL
    END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.process_internal_assessment_renewals(
  integer, integer, uuid[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_internal_assessment_renewals(
  integer, integer, uuid[]
) TO service_role;

COMMENT ON FUNCTION public.process_internal_assessment_renewals(
  integer, integer, uuid[]
) IS
  'Creates manual renewal drafts, schedules internal auto-renewals, opens their internal receivables, and activates due renewals without contacting Asaas.';

-- Page loads also invoke the existing transition engine. Keep that path from
-- activating a renewal whose parent was cancelled or had auto-renewal disabled
-- after the renewal was scheduled.
CREATE OR REPLACE FUNCTION public.apply_assessment_contract_transitions(
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_changed jsonb := '[]'::jsonb;
  v_next_status text;
  v_previous_status text;
  v_result jsonb;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;

  FOR v_contract IN
    SELECT contract.*
    FROM public.assessment_contracts AS contract
    WHERE contract.status = 'scheduled'
      AND contract.start_date <= v_today
      AND (
        contract.parent_contract_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.assessment_contracts AS parent
          WHERE parent.id = contract.parent_contract_id
            AND parent.status IN ('active', 'overdue', 'on_leave', 'finished')
            AND parent.scheduled_cancellation_date IS NULL
            AND parent.cancellation_date IS NULL
            AND NULLIF(btrim(parent.cancellation_reason), '') IS NULL
            AND (NOT contract.auto_renewal OR parent.auto_renewal)
        )
      )
    FOR UPDATE OF contract SKIP LOCKED
  LOOP
    UPDATE public.assessment_contracts
    SET status = 'active', updated_at = now()
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_contract.id, 'status_transitioned',
      jsonb_build_object(
        'status_before', 'scheduled',
        'status_after', 'active',
        'effective_date', v_today
      ),
      'Contrato ativado automaticamente no início da vigência', p_actor_id
    );
    v_changed := v_changed || jsonb_build_array(jsonb_build_object(
      'id', v_contract.id,
      'status', v_contract.status,
      'updated_at', v_contract.updated_at
    ));
  END LOOP;

  FOR v_contract IN
    SELECT * FROM public.assessment_contracts
    WHERE scheduled_cancellation_date IS NOT NULL
      AND scheduled_cancellation_date <= v_today
      AND status IN ('active', 'on_leave', 'overdue')
    FOR UPDATE SKIP LOCKED
  LOOP
    v_result := public.perform_assessment_contract_cancellation(
      v_contract,
      v_contract.scheduled_cancellation_date,
      coalesce(v_contract.scheduled_cancellation_fee_pct, 0),
      v_contract.scheduled_cancellation_reason,
      p_actor_id,
      'scheduled'
    );
    v_changed := v_changed || jsonb_build_array(jsonb_build_object(
      'id', v_contract.id,
      'status', 'cancelled',
      'updated_at', v_result->'contract'->>'updated_at'
    ));
  END LOOP;

  FOR v_contract IN
    SELECT parent.*
    FROM public.assessment_contracts parent
    WHERE parent.status IN ('active', 'overdue', 'on_leave')
      AND EXISTS (
        SELECT 1 FROM public.assessment_contracts renewal
        WHERE renewal.parent_contract_id = parent.id
          AND renewal.status = 'active'
          AND renewal.start_date <= v_today
      )
    FOR UPDATE SKIP LOCKED
  LOOP
    v_previous_status := v_contract.status;
    UPDATE public.assessment_contracts
    SET status = 'finished', updated_at = now()
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_contract.id, 'status_transitioned',
      jsonb_build_object(
        'status_before', v_previous_status,
        'status_after', 'finished',
        'effective_date', v_today,
        'reason', 'renewal_started'
      ),
      'Contrato concluído automaticamente pelo início da renovação', p_actor_id
    );
    v_changed := v_changed || jsonb_build_array(jsonb_build_object(
      'id', v_contract.id,
      'status', 'finished',
      'updated_at', v_contract.updated_at
    ));
  END LOOP;

  FOR v_contract IN
    SELECT * FROM public.assessment_contracts
    WHERE status = 'active' AND end_date < v_today
    FOR UPDATE SKIP LOCKED
  LOOP
    v_next_status := CASE
      WHEN lower(COALESCE(v_contract.cancellation_reason, '')) ~
        '(não renovou|nao renovou|não vai renovar|nao vai renovar)'
        THEN 'finished'
      ELSE 'overdue'
    END;
    UPDATE public.assessment_contracts
    SET status = v_next_status, updated_at = now()
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_contract.id, 'status_transitioned',
      jsonb_build_object(
        'status_before', 'active',
        'status_after', v_next_status,
        'effective_date', v_today,
        'reason', 'end_date_passed'
      ),
      'Status atualizado automaticamente após o fim da vigência', p_actor_id
    );
    v_changed := v_changed || jsonb_build_array(jsonb_build_object(
      'id', v_contract.id,
      'status', v_contract.status,
      'updated_at', v_contract.updated_at
    ));
  END LOOP;

  RETURN jsonb_build_object('changed', v_changed, 'effective_date', v_today);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_assessment_contract_transitions(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_assessment_contract_transitions(uuid)
  TO service_role;

COMMENT ON FUNCTION public.apply_assessment_contract_transitions(uuid) IS
  'Applies contract dates while preventing cancelled or disabled renewals from starting.';
