-- All screens and template simulation call this renderer. It intentionally
-- replaces only named tokens from a server-computed context.
CREATE OR REPLACE FUNCTION public.render_communication_template(
  p_template text, p_context jsonb
)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_text text := COALESCE(p_template, '');
  v_token record;
BEGIN
  IF p_context IS NOT NULL AND jsonb_typeof(p_context) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Contexto do modelo inválido';
  END IF;
  FOR v_token IN SELECT key, value FROM jsonb_each_text(COALESCE(p_context, '{}'::jsonb)) LOOP
    v_text := replace(v_text, '{' || v_token.key || '}', COALESCE(v_token.value, ''));
  END LOOP;
  RETURN v_text;
END;
$$;
REVOKE ALL ON FUNCTION public.render_communication_template(text,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.render_communication_template(text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION eon_private.communication_source_fingerprint(p_context jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT md5(jsonb_build_object(
    'payment_status', p_context->'payment_status',
    'source_status', p_context->'source_status',
    'renewal_stage', p_context->'renewal_stage',
    'balance', p_context->'balance',
    'due_date', p_context->'due_date',
    'end_date', p_context->'end_date',
    'contact_phone', p_context->'contact_phone',
    'payment_link', p_context->'payment_link',
    'pix_copy', p_context->'pix_copy',
    'person_name', p_context->'person_name',
    'plan_name', p_context->'plan_name',
    'reference', p_context->'reference',
    'onboarding_welcome_sent_at', p_context->'onboarding_welcome_sent_at',
    'onboarding_checkin_sent_at', p_context->'onboarding_checkin_sent_at',
    'charge_id', p_context->'charge_id',
    'external_invoice_number', p_context->'external_invoice_number',
    'source_updated_at', p_context->'source_updated_at',
    'payment_message_sent_at', p_context->'payment_message_sent_at',
    'renewal_follow_up_at', p_context->'renewal_follow_up_at'
    ,'renewal_last_contact_at', p_context->'renewal_last_contact_at'
    ,'renewal_response_code', p_context->'renewal_response_code'
    ,'auto_renewal', p_context->'auto_renewal'
    ,'period_months', p_context->'period_months'
  )::text);
$$;

CREATE OR REPLACE FUNCTION eon_private.communication_template_context(p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_due date;
  v_end date;
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_type text;
  v_balance numeric;
  v_link text := NULLIF(p_context->>'payment_link', '');
  v_pix text := NULLIF(p_context->>'pix_copy', '');
BEGIN
  v_due := NULLIF(p_context->>'due_date', '')::date;
  v_end := NULLIF(p_context->>'end_date', '')::date;
  v_balance := NULLIF(p_context->>'balance', '')::numeric;
  v_type := CASE p_context->>'source_type'
    WHEN 'contract' THEN 'contrato' WHEN 'event' THEN 'inscricao'
    ELSE 'pedido' END;
  RETURN jsonb_build_object(
    'nome', COALESCE(NULLIF(p_context->>'person_name', ''), 'Cliente'),
    'tipo', v_type,
    'numero', COALESCE(NULLIF(p_context->>'reference', ''), 'sem numero'),
    'valor', CASE WHEN v_balance IS NULL THEN 'saldo a conferir'
      ELSE 'R$ ' || replace(to_char(v_balance, 'FM999999999990.00'), '.', ',') END,
    'vencimento_texto', CASE WHEN v_due IS NULL THEN ''
      ELSE ', com vencimento em *' || to_char(v_due, 'DD/MM/YYYY') || '*' END,
    'vencimento', CASE WHEN v_due IS NULL THEN '' ELSE to_char(v_due, 'DD/MM/YYYY') END,
    'vencimento_atraso', CASE WHEN v_due IS NULL THEN ''
      ELSE ' em ' || to_char(v_due, 'DD/MM/YYYY') END,
    'pix_bloco', CASE WHEN v_pix IS NULL THEN ''
      ELSE 'Pix copia e cola: ' || v_pix || E'\n\n' END,
    'link_bloco', CASE WHEN v_link IS NULL THEN ''
      ELSE 'Link para pagamento: ' || v_link || E'\n\n' END,
    'itens_bloco', '',
    'plano', COALESCE(NULLIF(p_context->>'plan_name', ''), 'seu plano'),
    'data_fim', CASE WHEN v_end IS NULL THEN '' ELSE to_char(v_end, 'DD/MM/YYYY') END,
    'modalidade', '', 'coach', '', 'comunidade', ''
  );
END;
$$;

CREATE OR REPLACE FUNCTION eon_private.communication_case_suggestion(
  p_case public.communication_cases, p_context jsonb,
  p_rule_override jsonb DEFAULT NULL, p_policy_override jsonb DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_due date := NULLIF(p_context->>'due_date', '')::date;
  v_days integer;
  v_slug text;
  v_action text;
  v_eligible date := v_today;
  v_next date;
  v_block text;
  v_last date;
  v_rule public.communication_rules%ROWTYPE;
  v_rule_journey text;
  v_rule_trigger text;
  v_rule_kind text;
  v_rule_offset integer;
  v_welcome timestamptz;
  v_checkin timestamptz;
  v_policy public.communication_cadence_policies%ROWTYPE;
BEGIN
  IF (p_rule_override IS NOT NULL AND jsonb_typeof(p_rule_override)<>'object')
     OR (p_policy_override IS NOT NULL AND jsonb_typeof(p_policy_override)<>'object') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Prévia de modelo inválida';
  END IF;
  IF p_case.status = 'resolved' THEN
    v_block := 'case_resolved';
  END IF;
  IF p_context IS NULL THEN
    RETURN jsonb_build_object('message', '', 'blocked_reason', 'source_missing',
      'eligible_at', NULL, 'proposed_next_action_at', NULL,
      'source_fingerprint', NULL);
  END IF;

  IF p_case.purpose = 'billing' THEN
    SELECT * INTO v_policy FROM public.communication_cadence_policies
      WHERE slug = 'billing_overdue';
    IF p_policy_override IS NOT NULL THEN
      v_policy:=jsonb_populate_record(v_policy,p_policy_override);
    END IF;
    SELECT GREATEST(max(contact_date),
      (NULLIF(p_context->>'payment_message_sent_at','')::timestamptz
        AT TIME ZONE 'America/Sao_Paulo')::date)
      INTO v_last FROM public.communication_case_events
      WHERE case_id = p_case.id AND event_type = 'message_sent';
    IF NULLIF(p_context->>'balance', '') IS NULL THEN
      v_block := 'balance_review';
    ELSIF p_context->>'payment_status' IN ('paid', 'cancelled', 'refunded')
       OR (p_context->>'balance')::numeric <= 0 THEN
      v_block := 'source_resolved';
    ELSIF p_context->>'source_status' IN ('cancelled', 'voided', 'finished') THEN
      v_block := 'source_closed_review';
    END IF;
    IF v_last IS NULL AND p_context->>'payment_status'<>'partially_paid' THEN
      v_slug := 'billing-charge-send'; v_action := 'initial_charge';
      v_next := CASE WHEN v_due IS NULL THEN NULL ELSE v_due + 3 END;
    ELSIF v_due IS NULL THEN
      v_slug := 'billing-charge-overdue'; v_action := 'overdue';
      v_block := COALESCE(v_block, 'missing_due_date');
    ELSE
      v_days := v_today - v_due;
      IF v_days < 3 THEN
        v_slug := 'billing-charge-overdue'; v_action := 'overdue_d3';
        v_eligible := v_due + 3; v_next := v_due + 5;
        IF v_policy.pre_due_enabled
           AND (p_context->>'period_months')::integer = ANY(v_policy.pre_due_months)
           AND COALESCE(p_context->>'auto_renewal', 'false') <> 'true'
           AND v_today <= v_due THEN
          v_slug := CASE v_policy.pre_due_offset
            WHEN 0 THEN 'billing-pre-due-0d' ELSE 'billing-pre-due-1d' END;
          v_action := 'pre_due';
          v_eligible := v_due + v_policy.pre_due_offset;
          v_next := v_due + 3;
        END IF;
      ELSIF v_days < 5 THEN
        v_slug := 'billing-charge-overdue'; v_action := 'overdue_d3';
        v_next := v_due + 5;
      ELSIF v_days < 7 THEN
        v_slug := 'billing-charge-overdue-5d'; v_action := 'overdue_d5';
        v_next := v_due + 7;
      ELSIF v_days = 7 THEN
        v_slug := 'billing-charge-overdue-7d'; v_action := 'overdue_d7';
        v_next := v_due + 8;
      ELSE
        v_slug := 'billing-charge-overdue-daily'; v_action := 'overdue_daily';
        v_next := v_today + 1;
      END IF;
    END IF;
    IF v_last = v_today THEN
      v_block := COALESCE(v_block, 'already_contacted_today');
      v_eligible := v_today + 1;
    ELSIF v_last IS NOT NULL AND v_due IS NOT NULL THEN
      IF v_last >= v_due + 7 THEN
        v_eligible := GREATEST(v_eligible, v_last + 1);
      ELSIF v_last >= v_due + 5 THEN
        v_eligible := GREATEST(v_eligible, v_due + 7);
      ELSIF v_last >= v_due + 3 THEN
        v_eligible := GREATEST(v_eligible, v_due + 5);
      END IF;
    END IF;
    IF NULLIF(p_context->>'payment_link', '') IS NULL
       AND NULLIF(p_context->>'pix_copy', '') IS NULL THEN
      v_block := COALESCE(v_block, 'missing_payment_link');
    END IF;
    IF v_due IS NULL THEN v_block := COALESCE(v_block, 'missing_due_date'); END IF;
  ELSIF p_case.purpose = 'renewal' THEN
    v_slug := 'renewal-reminder-14d'; v_action := 'renewal_contact';
    v_eligible := COALESCE(NULLIF(p_context->>'renewal_follow_up_at', '')::date,
      p_case.next_action_at, v_today);
    IF p_context->>'renewal_stage' NOT IN ('contact_pending', 'waiting_response') THEN
      v_block := 'renewal_stage_changed';
    END IF;
    v_next := NULL;
  ELSE
    SELECT max(created_at) FILTER (WHERE event_type = 'onboarding_welcome_sent'),
           max(created_at) FILTER (WHERE event_type = 'onboarding_checkin_sent')
      INTO v_welcome, v_checkin FROM public.assessment_contract_event
      WHERE contract_id = p_case.source_id;
    v_welcome:=COALESCE(NULLIF(p_context->>'onboarding_welcome_sent_at','')::timestamptz,v_welcome);
    v_checkin:=COALESCE(NULLIF(p_context->>'onboarding_checkin_sent_at','')::timestamptz,v_checkin);
    IF v_checkin IS NOT NULL THEN
      v_slug := 'onboarding-checkin-5d'; v_action := 'completed';
      v_block := 'already_completed';
    ELSIF v_welcome IS NOT NULL THEN
      v_slug := 'onboarding-checkin-5d'; v_action := 'onboarding_checkin';
      v_eligible := (v_welcome AT TIME ZONE 'America/Sao_Paulo')::date + 5;
    ELSE
      v_slug := 'onboarding-welcome'; v_action := 'onboarding_welcome';
      v_next := v_today + 5;
    END IF;
    IF p_context->>'payment_status' <> 'paid' THEN
      v_block := 'payment_changed';
    END IF;
  END IF;

  IF length(regexp_replace(COALESCE(p_context->>'contact_phone',''),'[^0-9]','','g'))
       NOT BETWEEN 10 AND 13 THEN
    v_block := COALESCE(v_block, 'missing_contact_phone');
  END IF;
  IF p_case.purpose='billing' AND NULLIF(p_context->>'payment_link','') IS NOT NULL
     AND (length(p_context->>'payment_link')>2048 OR
       p_context->>'payment_link' !~* '^https?://[^[:space:][:cntrl:]]+$') THEN
    v_block := COALESCE(v_block,'invalid_payment_link');
  END IF;
  IF p_case.blocked_reason IS NOT NULL THEN
    v_block := p_case.blocked_reason;
  END IF;
  IF p_case.hold_kind = 'explicit_schedule'
     AND p_case.next_action_at IS NOT NULL AND p_case.next_action_at > v_today THEN
    v_eligible := GREATEST(v_eligible, p_case.next_action_at);
  END IF;
  IF p_case.hold_kind = 'contact_wait'
     AND p_case.next_action_at IS NOT NULL AND p_case.next_action_at > v_today THEN
    v_eligible := GREATEST(v_eligible, p_case.next_action_at);
  END IF;
  IF p_case.purpose='billing' THEN
    v_rule_journey:='billing';
    v_rule_trigger:=CASE WHEN v_action='initial_charge' THEN 'charge_created'
      ELSE 'charge_due_date' END;
    v_rule_kind:=CASE WHEN v_action IN ('initial_charge','pre_due') THEN 'charge_send'
      ELSE 'charge_overdue' END;
    v_rule_offset:=CASE v_action
      WHEN 'initial_charge' THEN 0 WHEN 'pre_due' THEN v_policy.pre_due_offset
      WHEN 'overdue_d3' THEN 3 WHEN 'overdue_d5' THEN 5
      WHEN 'overdue_d7' THEN 7 ELSE 8 END;
  ELSIF p_case.purpose='renewal' THEN
    v_rule_journey:='renewal';v_rule_trigger:='contract_end_date';
    v_rule_kind:='renewal_reminder';v_rule_offset:=-10;
  ELSE
    v_rule_journey:='onboarding';
    v_rule_trigger:=CASE WHEN v_action='onboarding_welcome'
      THEN 'payment_confirmed' ELSE 'onboarding_welcome_sent' END;
    v_rule_kind:=CASE WHEN v_action='onboarding_welcome'
      THEN 'onboarding_welcome' ELSE 'onboarding_checkin' END;
    v_rule_offset:=CASE WHEN v_action='onboarding_welcome' THEN 0 ELSE 5 END;
  END IF;
  SELECT * INTO v_rule FROM (
    SELECT r.* FROM public.communication_rules r
    WHERE p_rule_override IS NULL OR r.id IS DISTINCT FROM
      NULLIF(p_rule_override->>'id','')::uuid
    UNION ALL
    SELECT x.* FROM jsonb_populate_record(
      NULL::public.communication_rules,p_rule_override) x
    WHERE p_rule_override IS NOT NULL
  ) candidates
  WHERE journey=v_rule_journey AND trigger_event=v_rule_trigger
    AND task_kind=v_rule_kind AND days_offset=v_rule_offset AND active=true
  ORDER BY order_index,slug,id LIMIT 1;
  IF v_rule.id IS NULL THEN
    v_block := COALESCE(v_block, 'rule_unavailable');
  END IF;
  RETURN jsonb_build_object(
    'message', CASE WHEN v_rule.id IS NOT NULL THEN
      public.render_communication_template(v_rule.message_template,
        eon_private.communication_template_context(p_context)) ELSE '' END,
    'template_id', v_rule.id, 'rule_slug', COALESCE(v_rule.slug,v_slug),
    'rule_version', v_rule.template_version, 'action_code', v_action,
    'eligible_at', v_eligible, 'blocked_reason', v_block,
    'proposed_next_action_at', v_next,
    'source_fingerprint', eon_private.communication_source_fingerprint(p_context)
  );
END;
$$;

CREATE OR REPLACE FUNCTION eon_private.communication_case_projection(
  p_case public.communication_cases
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_context jsonb := eon_private.communication_source_context(p_case.source_type,p_case.source_id);
  v_suggestion jsonb := eon_private.communication_case_suggestion(p_case,v_context);
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_stage text;
  v_next date;
BEGIN
  v_next := GREATEST(p_case.next_action_at, (v_suggestion->>'eligible_at')::date);
  v_stage := CASE
    WHEN p_case.status = 'resolved' THEN 'resolved'
    WHEN p_case.hold_kind = 'explicit_schedule' AND p_case.next_action_at > v_today THEN 'scheduled'
    WHEN p_case.hold_kind = 'contact_wait' THEN 'following_up'
    WHEN v_next > v_today THEN 'scheduled'
    ELSE 'to_do' END;
  RETURN jsonb_build_object(
    'id', p_case.id, 'case_id', p_case.id,
    'source_type', p_case.source_type, 'source_id', p_case.source_id,
    'purpose', p_case.purpose, 'obligation_key', p_case.obligation_key,
    'status', p_case.status, 'workflow_stage', v_stage,
    'next_action_at', v_next, 'blocked_reason', COALESCE(v_suggestion->>'blocked_reason',p_case.blocked_reason),
    'last_contact_at', p_case.last_contact_at, 'assignee_id', p_case.assignee_id,
    'version', p_case.version, 'created_at', p_case.created_at,
    'updated_at', p_case.updated_at, 'resolved_at', p_case.resolved_at,
    'person_name', v_context->>'person_name', 'contact_phone', v_context->>'contact_phone',
    'person_id', v_context->>'person_id',
    'reference', v_context->>'reference', 'balance', v_context->'balance',
    'payment_link', v_context->>'payment_link',
    'can_send_without_link', p_case.purpose <> 'billing'
      OR NULLIF(v_context->>'pix_copy','') IS NOT NULL,
    'source_href', v_context->>'source_href',
    'source_fingerprint', v_suggestion->>'source_fingerprint',
    'suggested_message', v_suggestion->>'message',
    'rule_version', v_suggestion->'rule_version'
  );
END;
$$;

REVOKE ALL ON FUNCTION eon_private.communication_source_fingerprint(jsonb),
  eon_private.communication_template_context(jsonb),
  eon_private.communication_case_suggestion(public.communication_cases,jsonb,jsonb,jsonb),
  eon_private.communication_case_projection(public.communication_cases)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.communication_source_fingerprint(jsonb),
  eon_private.communication_template_context(jsonb),
  eon_private.communication_case_suggestion(public.communication_cases,jsonb,jsonb,jsonb),
  eon_private.communication_case_projection(public.communication_cases)
  TO service_role;
