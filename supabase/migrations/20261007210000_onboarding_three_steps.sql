-- Onboarding in three steps and without locks on the manual send.
--
-- The new-student flow gets a third message on day 20 after the welcome
-- (feedback: is it working, any doubts), after the check-in on day 5. The flow
-- is only completed when the feedback is sent; the welcome still opens up to 30
-- days after the payment and the later steps follow for up to 30 days after the
-- welcome. Onboardings whose check-in was registered by the previous panel
-- ended there and do not come back for the feedback.
--
-- Sending is manual (copy the text, send on WhatsApp, register it). For
-- onboarding, a missing phone, a missing community link, a reopened source or a
-- step that is not due yet no longer block the registration. Billing and
-- renewal keep their checks.

ALTER TABLE public.communication_rules
  DROP CONSTRAINT communication_rules_task_kind_check,
  ADD CONSTRAINT communication_rules_task_kind_check CHECK (task_kind IN (
    'charge_send','charge_overdue','onboarding_welcome','onboarding_checkin',
    'onboarding_feedback','renewal_reminder','reactivation'));

INSERT INTO public.communication_rules
  (slug,name,journey,trigger_event,task_kind,days_offset,channel,message_template,active,order_index)
VALUES ('onboarding-feedback-20d','Feedback de 20 dias','onboarding','onboarding_welcome_sent',
  'onboarding_feedback',20,'whatsapp',$tpl$Olá, {nome}! Tudo bem?

Já faz uns 20 dias que você começou com a gente e eu queria saber como está sendo.

Está conseguindo seguir os treinos? Ficou claro como funciona o dia a dia da assessoria e o contato com o seu coach?

Se tiver qualquer dúvida ou feedback, me manda por aqui. Sua opinião ajuda muito a gente a melhorar!$tpl$,
  true,45)
ON CONFLICT (slug) DO NOTHING;

CREATE OR REPLACE FUNCTION eon_private.communication_onboarding_eligible(
  p_contract_id uuid
)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_welcome date;
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  SELECT * INTO v_contract FROM public.assessment_contracts WHERE id=p_contract_id;
  IF NOT FOUND OR v_contract.parent_contract_id IS NOT NULL
     OR v_contract.customer_id IS NULL OR v_contract.start_date IS NULL
     OR v_contract.created_at IS NULL
     OR v_contract.payment_status<>'paid'
     OR v_contract.status NOT IN ('active','scheduled','on_leave')
     OR v_contract.prospect_customer_relationship='active_student'
     -- Completed: the day-20 feedback, or a check-in registered by the
     -- previous panel, whose onboarding ended at the check-in.
     OR EXISTS (SELECT 1 FROM public.assessment_contract_event e
       WHERE e.contract_id=p_contract_id
         AND (e.event_type='onboarding_feedback_sent'
           OR (e.event_type='onboarding_checkin_sent'
             AND COALESCE(e.payload->>'source','') <> 'communication_case'))) THEN
    RETURN false;
  END IF;

  -- The welcome opens up to 30 days after the payment; after it, the check-in
  -- and the day-20 feedback follow for up to 30 days from the welcome.
  SELECT (max(e.created_at) AT TIME ZONE 'America/Sao_Paulo')::date INTO v_welcome
    FROM public.assessment_contract_event e
    WHERE e.contract_id=p_contract_id AND e.event_type='onboarding_welcome_sent';
  IF (v_welcome IS NULL
      AND COALESCE(v_contract.payment_date, v_contract.start_date) < v_today - 30)
     OR v_welcome < v_today - 30 THEN
    RETURN false;
  END IF;

  -- end_date is exclusive and a cancellation date still counts as an active
  -- day, so coverage ends on cancellation_date + 1 for cancelled contracts.
  RETURN NOT EXISTS (
    SELECT 1 FROM public.assessment_contracts old
    WHERE old.customer_id=v_contract.customer_id AND old.id<>v_contract.id
      AND (
        old.start_date<v_contract.start_date
        OR old.id=v_contract.prospect_previous_contract_id
        OR (old.start_date=v_contract.start_date AND (
          old.created_at<v_contract.created_at
          OR (old.created_at=v_contract.created_at
            AND CASE
              WHEN old.contract_number ~ '^ASS-[0-9]+$'
                AND v_contract.contract_number ~ '^ASS-[0-9]+$'
              THEN substring(old.contract_number FROM 5)::numeric
                < substring(v_contract.contract_number FROM 5)::numeric
              ELSE false END)))
      )
      AND (
        old.status IN ('active','overdue','on_leave','finished')
        OR (old.status IN ('cancelled','scheduled') AND (
          old.payment_status='paid' OR old.payment_date IS NOT NULL
          OR COALESCE(old.manual_payment,false)))
      )
      AND (
        CASE
          WHEN old.status='cancelled' AND old.cancellation_date IS NOT NULL
            THEN old.cancellation_date + 1
          ELSE old.end_date
        END >= v_contract.start_date - 30
      ) IS NOT FALSE
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
  v_rendered text := '';
  v_pay_link text := NULLIF(p_context->>'payment_link','');
  v_pix_copy text := NULLIF(p_context->>'pix_copy','');
  v_welcome timestamptz;
  v_checkin timestamptz;
  v_feedback timestamptz;
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
    ELSIF p_context->>'source_status' IN ('cancelled', 'voided') THEN
      v_block := 'source_closed_review';
    END IF;
    IF v_last IS NULL AND p_context->>'payment_status'<>'partially_paid'
       AND NOT (p_context->>'source_type'='contract'
         AND p_context->>'parent_contract_id' IS NOT NULL
         AND COALESCE(p_context->>'auto_renewal','false')='true') THEN
      v_slug := 'billing-charge-send'; v_action := 'initial_charge';
      v_next := CASE WHEN v_due IS NULL THEN NULL
        ELSE GREATEST(v_due+3,v_today+1) END;
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
           max(created_at) FILTER (WHERE event_type = 'onboarding_checkin_sent'),
           max(created_at) FILTER (WHERE event_type = 'onboarding_feedback_sent')
      INTO v_welcome, v_checkin, v_feedback FROM public.assessment_contract_event
      WHERE contract_id = p_case.source_id;
    v_welcome:=COALESCE(NULLIF(p_context->>'onboarding_welcome_sent_at','')::timestamptz,v_welcome);
    v_checkin:=COALESCE(NULLIF(p_context->>'onboarding_checkin_sent_at','')::timestamptz,v_checkin);
    -- Three steps counted from the welcome: welcome, check-in on day 5 and
    -- feedback on day 20 (at least a week after the check-in).
    IF v_feedback IS NOT NULL THEN
      v_slug := 'onboarding-feedback-20d'; v_action := 'completed';
      v_block := 'already_completed';
    ELSIF v_checkin IS NOT NULL THEN
      v_slug := 'onboarding-feedback-20d'; v_action := 'onboarding_feedback';
      v_eligible := GREATEST(
        COALESCE((v_welcome AT TIME ZONE 'America/Sao_Paulo')::date + 20, v_today),
        (v_checkin AT TIME ZONE 'America/Sao_Paulo')::date + 7);
    ELSIF v_welcome IS NOT NULL THEN
      v_slug := 'onboarding-checkin-5d'; v_action := 'onboarding_checkin';
      v_eligible := (v_welcome AT TIME ZONE 'America/Sao_Paulo')::date + 5;
      v_next := (v_welcome AT TIME ZONE 'America/Sao_Paulo')::date + 20;
    ELSE
      v_slug := 'onboarding-welcome'; v_action := 'onboarding_welcome';
      v_next := v_today + 5;
    END IF;
    IF p_context->>'payment_status' <> 'paid' THEN
      v_block := 'payment_changed';
    END IF;
    IF EXISTS (SELECT 1 FROM public.assessment_contracts
      WHERE id=p_case.source_id)
      AND NOT eon_private.communication_onboarding_eligible(p_case.source_id) THEN
      v_block := COALESCE(v_block,'onboarding_not_eligible');
    END IF;
  END IF;

  -- Onboarding is sent by hand: a missing or odd phone only disables the
  -- WhatsApp shortcut in the panel, it does not lock the step.
  IF p_case.purpose<>'onboarding'
     AND length(regexp_replace(COALESCE(p_context->>'contact_phone',''),'[^0-9]','','g'))
       NOT BETWEEN 10 AND 13 THEN
    v_block := COALESCE(v_block, 'missing_contact_phone');
  END IF;
  IF p_case.purpose='billing' AND NULLIF(p_context->>'payment_link','') IS NOT NULL
     AND (length(p_context->>'payment_link')>2048 OR
       p_context->>'payment_link' !~* '^https?://[^[:space:][:cntrl:]]+$') THEN
    v_block := COALESCE(v_block,'invalid_payment_link');
  END IF;
  IF p_case.blocked_reason IS NOT NULL
     AND NOT (p_case.purpose='onboarding'
       AND p_case.blocked_reason='source_reopened_review') THEN
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
  -- An onboarding step may be sent before its date; the date only orders the queue.
  IF v_block IS NULL AND p_case.purpose<>'onboarding'
     AND (v_eligible>v_today OR p_case.next_action_at>v_today) THEN
    v_block:='not_due_yet';
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
    v_rule_kind:=CASE v_action WHEN 'onboarding_welcome' THEN 'onboarding_welcome'
      WHEN 'onboarding_checkin' THEN 'onboarding_checkin' ELSE 'onboarding_feedback' END;
    v_rule_offset:=CASE v_action WHEN 'onboarding_welcome' THEN 0
      WHEN 'onboarding_checkin' THEN 5 ELSE 20 END;
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
  ELSE
    v_rendered:=public.render_communication_template(v_rule.message_template,
      eon_private.communication_template_context(p_context));
    -- Published models may omit a payment placeholder. Keep the proposed
    -- billing message actionable when the source has a valid method.
    IF p_case.purpose='billing' AND v_pay_link IS NOT NULL
       AND strpos(v_rendered,v_pay_link)=0
       AND (v_pix_copy IS NULL OR strpos(v_rendered,v_pix_copy)=0) THEN
      v_rendered:=rtrim(v_rendered) || E'\n\nLink de pagamento:\n' || v_pay_link;
    ELSIF p_case.purpose='billing' AND v_pay_link IS NULL
       AND v_pix_copy IS NOT NULL AND strpos(v_rendered,v_pix_copy)=0 THEN
      v_rendered:=rtrim(v_rendered) || E'\n\nPIX Copia e Cola:\n' || v_pix_copy;
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'message', v_rendered,
    'template_id', v_rule.id, 'rule_slug', COALESCE(v_rule.slug,v_slug),
    'rule_version', v_rule.template_version, 'action_code', v_action,
    'eligible_at', v_eligible, 'blocked_reason', v_block,
    'proposed_next_action_at', v_next,
    'source_fingerprint', eon_private.communication_source_fingerprint(p_context)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_communication_case_action(
  p_case_id uuid,p_request jsonb,p_idempotency_key text,p_actor_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_case public.communication_cases%ROWTYPE;
  v_command public.communication_case_commands%ROWTYPE;
  v_context jsonb;
  v_suggestion jsonb;
  v_event public.communication_case_events%ROWTYPE;
  v_action text := p_request->>'action';
  v_message text := NULLIF(btrim(p_request->>'message'),'');
  v_note text := NULLIF(btrim(COALESCE(p_request->>'note',p_request->>'reason')),'');
  v_code text := NULLIF(p_request->>'response_code','');
  v_date date;
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_hash text;
  v_result jsonb;
  v_next date;
  v_hold text := 'none';
  v_case_block text;
  v_payload jsonb;
  v_event_type text;
  v_source_ui text := NULLIF(p_request->>'source_ui','');
BEGIN
  IF NOT eon_private.communication_cases_rollout_enabled() THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='Central de casos ainda não ativada';
  END IF;
  IF p_case_id IS NULL OR p_actor_id IS NULL
     OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,100}$'
     OR p_request IS NULL OR jsonb_typeof(p_request)<>'object'
     OR pg_column_size(p_request)>8192
     OR v_action IS NULL
     OR v_action NOT IN ('message_sent','response_recorded','return_scheduled',
       'review_requested','review_completed','resolve_case')
     OR v_source_ui IS NULL OR length(v_source_ui)>80
     OR p_request->>'expected_version' IS NULL
     OR (p_request->>'expected_version') !~ '^[0-9]{1,18}$'
     OR p_request->>'expected_source_fingerprint' IS NULL
     OR (p_request->>'expected_source_fingerprint') !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Ação de comunicação inválida';
  END IF;
  v_hash := md5(p_request::text || p_actor_id::text);
  IF COALESCE(p_request->>'next_action_at',p_request->>'follow_up_at') IS NOT NULL THEN
    BEGIN v_date := COALESCE(p_request->>'next_action_at',p_request->>'follow_up_at')::date;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Data de retorno inválida';
    END;
    IF v_date < v_today OR v_date > v_today+365 THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Data de retorno fora do período permitido';
    END IF;
  END IF;
  IF v_note IS NOT NULL AND length(v_note)>1000 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Observação muito longa';
  END IF;
  IF v_message IS NOT NULL AND length(v_message)>4000 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Mensagem muito longa';
  END IF;

  SELECT * INTO v_case FROM public.communication_cases WHERE id=p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Acompanhamento não encontrado';
  END IF;
  PERFORM eon_private.lock_communication_source(v_case.source_type,v_case.source_id);
  SELECT * INTO v_case FROM public.communication_cases WHERE id=p_case_id FOR UPDATE;
  SELECT * INTO v_command FROM public.communication_case_commands
    WHERE case_id=p_case_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_command.request_payload IS DISTINCT FROM p_request
       OR v_command.actor_id<>p_actor_id THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='Chave de idempotência reutilizada com dados diferentes';
    END IF;
    RETURN v_command.result || jsonb_build_object('replayed',true);
  END IF;
  IF v_case.version<>(p_request->>'expected_version')::bigint THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='Acompanhamento alterado. Atualize a página.';
  END IF;
  IF v_case.status<>'open' THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='Acompanhamento encerrado';
  END IF;
  v_case_block := v_case.blocked_reason;
  v_context := eon_private.communication_source_context(v_case.source_type,v_case.source_id);
  IF v_context IS NULL OR eon_private.communication_source_fingerprint(v_context)
     IS DISTINCT FROM p_request->>'expected_source_fingerprint' THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='A origem mudou. Atualize a página.';
  END IF;
  IF v_case.purpose='onboarding'
     AND NOT eon_private.communication_onboarding_eligible(v_case.source_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',
      MESSAGE='Esta adesão não está elegível para onboarding. Atualize a página.';
  END IF;
  IF v_case.purpose='billing' AND v_action='message_sent'
     AND (v_context->>'payment_status' IN ('paid','cancelled','refunded')
       OR NULLIF(v_context->>'balance','') IS NULL
       OR (v_context->>'balance')::numeric<=0) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='Pagamento ou saldo mudou. Atualize a página.';
  END IF;
  v_suggestion := eon_private.communication_case_suggestion(v_case,v_context);
  v_payload := jsonb_build_object('source_ui',v_source_ui,'source_fingerprint',
    p_request->>'expected_source_fingerprint');

  IF v_action='message_sent' THEN
    IF v_message IS NULL OR p_request->>'channel' IS DISTINCT FROM 'whatsapp'
       OR p_request->>'confirmed_external_send' IS DISTINCT FROM 'true'
       OR p_request->>'expected_rule_version' IS NULL
       OR (p_request->>'expected_rule_version') !~ '^[0-9]{1,8}$'
       OR (p_request->>'expected_rule_version')::integer
          IS DISTINCT FROM (v_suggestion->>'rule_version')::integer THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Confirme o envio e a versão do modelo';
    END IF;
    IF v_suggestion->>'blocked_reason' IS NOT NULL
       OR (v_case.purpose<>'onboarding' AND ((v_suggestion->>'eligible_at')::date>v_today
         OR v_case.next_action_at>v_today)) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='Este contato não está elegível. Atualize a página.';
    END IF;
    IF EXISTS(SELECT 1 FROM public.communication_case_events
      WHERE case_id=p_case_id AND event_type='message_sent' AND contact_date=v_today) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='Já existe contato registrado hoje';
    END IF;
    IF v_case.purpose='billing' THEN
      IF v_case.source_type='contract' AND v_context->>'source_status'='finished' THEN
        -- A finished term can still have an open balance. Its original
        -- contract state remains authoritative while contact is recorded.
        INSERT INTO public.assessment_contract_event(contract_id,event_type,payload,notes,created_by)
        VALUES(v_case.source_id,'payment_message_sent',
          jsonb_build_object('communication_case_id',p_case_id,'message',v_message,
            'source','communication_center','via','whatsapp','status','finished'),
          'Cobrança de saldo remanescente após fim da vigência',p_actor_id);
      ELSIF v_case.source_type='contract' THEN
        PERFORM public.mark_assessment_contract_payment_message_sent(
          v_case.source_id,'communication_center',NULL,
          NULLIF(v_context->>'due_date','')::date,
          jsonb_build_object('communication_case_id',p_case_id,'message',v_message),
          (v_context->>'source_updated_at')::timestamptz,p_actor_id);
      ELSIF v_case.source_type='event' AND v_context->>'payment_status'='partially_paid' THEN
        INSERT INTO public.sales_status_events(order_type,order_id,previous_status,new_status,reason,metadata,actor_id)
        VALUES('event',v_case.source_id,'partially_paid','partially_paid','Acompanhamento de saldo parcial',
          jsonb_build_object('communication_case_id',p_case_id,'message',v_message,'channel','whatsapp'),p_actor_id);
      ELSIF v_case.source_type='event' THEN
        PERFORM public.mark_event_payment_message_sent_with_metadata(
          v_case.source_id,NULL,NULLIF(v_context->>'due_date','')::date,
          jsonb_build_object('communication_case_id',p_case_id,'message',v_message),p_actor_id);
      ELSIF v_context->>'payment_status'='partially_paid' THEN
        INSERT INTO public.sales_status_events(order_type,order_id,previous_status,new_status,reason,metadata,actor_id)
        VALUES(v_case.source_type,v_case.source_id,'partially_paid','partially_paid','Acompanhamento de saldo parcial',
          jsonb_build_object('communication_case_id',p_case_id,'message',v_message,'channel','whatsapp'),p_actor_id);
      ELSE
        PERFORM public.mark_order_payment_message_sent_with_metadata(
          v_case.source_type,v_case.source_id,NULL,NULLIF(v_context->>'due_date','')::date,
          jsonb_build_object('communication_case_id',p_case_id,'message',v_message),p_actor_id);
      END IF;
    ELSIF v_case.purpose='renewal' THEN
      PERFORM public.transition_assessment_renewal_stage(
        v_case.source_id,'message_sent',(v_context->>'source_updated_at')::timestamptz,
        p_idempotency_key,p_actor_id,NULL,v_date,NULL,v_message);
    ELSE
      INSERT INTO public.assessment_contract_event(contract_id,event_type,payload,created_by)
      VALUES(v_case.source_id,CASE v_suggestion->>'action_code'
        WHEN 'onboarding_checkin' THEN 'onboarding_checkin_sent'
        WHEN 'onboarding_feedback' THEN 'onboarding_feedback_sent'
        ELSE 'onboarding_welcome_sent' END,
        jsonb_build_object('communication_case_id',p_case_id,'message',v_message,
          'source','communication_case','channel','whatsapp'),p_actor_id);
    END IF;
    v_event_type:='message_sent';
    v_payload := v_payload || jsonb_build_object('action_code',v_suggestion->>'action_code',
      'occurrence',v_suggestion->>'action_code');
    v_next := COALESCE(v_date,(v_suggestion->>'proposed_next_action_at')::date);
    v_hold := CASE WHEN v_date IS NOT NULL THEN 'explicit_schedule'
      ELSE 'contact_wait' END;
    IF v_case.purpose='onboarding' AND v_suggestion->>'action_code'='onboarding_feedback' THEN
      v_next := NULL;
    END IF;
  ELSIF v_action='response_recorded' THEN
    IF v_case.purpose='renewal' THEN
      IF v_code IS NULL OR v_code NOT IN ('thinking','will_renew','change_plan_or_coach','needs_agent') THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Resposta de renovação inválida';
      END IF;
      PERFORM public.transition_assessment_renewal_stage(
        v_case.source_id,'register_response',(v_context->>'source_updated_at')::timestamptz,
        p_idempotency_key,p_actor_id,v_code,v_date,v_note,NULL);
    ELSIF v_case.purpose='billing' THEN
      IF v_code IS NULL OR v_code NOT IN ('will_pay','paid_claimed','dispute','needs_agent') THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Resposta de cobrança inválida';
      END IF;
    ELSE
      IF v_code IS NULL OR v_code NOT IN ('needs_agent','thinking') THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Resposta inválida';
      END IF;
    END IF;
    v_event_type:='response_recorded';
    v_payload := v_payload || jsonb_build_object('response_code',v_code);
    v_next := v_date;
    v_hold := CASE WHEN v_date IS NOT NULL THEN 'explicit_schedule' ELSE 'contact_wait' END;
    IF v_code IN ('paid_claimed','dispute','needs_agent','change_plan_or_coach') THEN
      v_hold:='explicit_schedule'; v_next:=COALESCE(v_date,v_today);
      v_case_block:=CASE v_code WHEN 'paid_claimed' THEN 'payment_review'
        WHEN 'dispute' THEN 'dispute' ELSE 'needs_agent' END;
    END IF;
  ELSIF v_action='return_scheduled' THEN
    IF v_date IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Informe a data de retorno';
    END IF;
    IF v_case.purpose='renewal' THEN
      PERFORM public.transition_assessment_renewal_stage(
        v_case.source_id,'set_follow_up',(v_context->>'source_updated_at')::timestamptz,
        p_idempotency_key,p_actor_id,NULL,v_date,NULL,NULL);
    END IF;
    v_event_type:='return_scheduled'; v_next:=v_date; v_hold:='explicit_schedule';
  ELSIF v_action='review_requested' THEN
    IF v_note IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Informe o motivo da revisão';
    END IF;
    v_event_type:='review_requested'; v_next:=COALESCE(v_date,v_today);
    v_hold:='explicit_schedule';
    v_case_block:='review_requested';
  ELSIF v_action='review_completed' THEN
    IF v_note IS NULL OR v_case.blocked_reason IS NULL OR v_case.blocked_reason NOT IN
      ('review_requested','payment_review','dispute','needs_agent',
       'renewal_review','source_reopened_review') THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Revisão e observação obrigatórias';
    END IF;
    v_event_type:='review_completed';v_next:=v_today;v_hold:='none';
    v_case_block:=NULL;
  ELSE
    IF v_context->>'payment_status' NOT IN ('paid','cancelled','refunded')
       AND NOT (v_case.purpose='renewal' AND
         v_context->>'renewal_stage' NOT IN ('contact_pending','waiting_response'))
       AND NOT (v_case.purpose='onboarding' AND v_suggestion->>'action_code'='completed') THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='A origem ainda está aberta';
    END IF;
    v_event_type:='case_resolved_manually'; v_next:=NULL; v_hold:='none';
  END IF;

  -- A domain trigger may have resolved or updated the case in this transaction.
  SELECT * INTO v_case FROM public.communication_cases WHERE id=p_case_id FOR UPDATE;
  IF v_action='resolve_case' OR
     (v_action='message_sent' AND v_case.purpose='onboarding'
       AND v_suggestion->>'action_code'='onboarding_feedback') THEN
    UPDATE public.communication_cases SET status='resolved',hold_kind='none',
      next_action_at=NULL,resolved_at=now(),resolution_reason=CASE
        WHEN v_action='resolve_case' THEN 'operator_verified' ELSE 'onboarding_completed' END,
      last_contact_at=CASE WHEN v_action='message_sent' THEN now() ELSE last_contact_at END,
      version=version+1,updated_at=now() WHERE id=p_case_id;
  ELSIF v_case.status='open' THEN
    UPDATE public.communication_cases SET hold_kind=v_hold,next_action_at=v_next,
      blocked_reason=v_case_block,
      last_contact_at=CASE WHEN v_action IN ('message_sent','response_recorded') THEN now()
        ELSE last_contact_at END,
      version=version+1,updated_at=now() WHERE id=p_case_id;
  END IF;
  INSERT INTO public.communication_case_events(case_id,event_type,action_key,actor_id,
    channel,source_ui,message_text,response_code,notes,rule_slug,rule_version,
    evidence_status,contact_date,payload)
  VALUES(p_case_id,v_event_type,p_idempotency_key,p_actor_id,
    CASE WHEN v_action='message_sent' THEN 'whatsapp' END,v_source_ui,v_message,v_code,v_note,
    v_suggestion->>'rule_slug',(v_suggestion->>'rule_version')::integer,
    CASE WHEN v_action='message_sent' THEN 'external_unverified' END,
    CASE WHEN v_action='message_sent' THEN v_today END,v_payload)
  RETURNING * INTO v_event;
  v_result := jsonb_build_object('case',(public.get_communication_case(p_case_id))->'case',
    'event',to_jsonb(v_event),'replayed',false);
  INSERT INTO public.communication_case_commands(case_id,idempotency_key,request_hash,request_payload,result,actor_id)
    VALUES(p_case_id,p_idempotency_key,v_hash,p_request,v_result,p_actor_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.communication_model_command(p_action text,p_actor_id uuid,p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  d public.communication_model_drafts%ROWTYPE;
  r public.communication_rules%ROWTYPE;
  policy_row public.communication_cadence_policies%ROWTYPE;
  rule_data jsonb;
  policy_data jsonb;
  result jsonb;
  examples jsonb := '[]'::jsonb;
  sample jsonb;
  sample_context jsonb;
  message text;
  warnings jsonb := '[]'::jsonb;
  affected bigint;
  rule_purpose text;
  draft_id uuid;
  fingerprint text;
  draft_valid boolean := true;
  preview_case public.communication_cases%ROWTYPE;
  preview_rule jsonb;
  suggestion jsonb;
  policy_before jsonb;
  rule_before jsonb;
  sample_due date;
  today_date date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  IF p_actor_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Operador obrigatório'; END IF;
  IF p_action = 'get_config' THEN
    RETURN jsonb_build_object(
      'rules',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.order_index,x.slug) FROM public.communication_rules x),'[]'::jsonb),
      'policy',(SELECT to_jsonb(x) FROM public.communication_cadence_policies x WHERE slug='billing_overdue'),
      'drafts',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM (
        SELECT * FROM public.communication_model_drafts WHERE published_at IS NULL ORDER BY created_at DESC LIMIT 50
      ) x),'[]'::jsonb)
    );
  END IF;
  IF p_action = 'save_draft' THEN
    rule_data := NULLIF(p_payload->'rule','null'::jsonb);
    policy_data := NULLIF(p_payload->'policy','null'::jsonb);
    IF rule_data IS NULL AND policy_data IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Informe modelo ou política';
    END IF;
    IF rule_data IS NOT NULL THEN
      IF jsonb_typeof(rule_data) <> 'object' OR length(COALESCE(rule_data->>'name','')) NOT BETWEEN 1 AND 200
        OR length(COALESCE(rule_data->>'message_template','')) NOT BETWEEN 1 AND 4000
        OR COALESCE(rule_data->>'journey','') NOT IN ('billing','onboarding','renewal','reactivation')
        OR COALESCE(rule_data->>'task_kind','') NOT IN ('charge_send','charge_overdue','onboarding_welcome','onboarding_checkin','onboarding_feedback','renewal_reminder','reactivation')
        OR COALESCE(rule_data->>'trigger_event','') NOT IN ('charge_created','charge_due_date','payment_confirmed','onboarding_welcome_sent','contract_end_date','manual')
        OR COALESCE(rule_data->>'slug','') !~ '^[a-z0-9][a-z0-9-]{1,119}$'
        OR jsonb_typeof(rule_data->'active') IS DISTINCT FROM 'boolean'
        OR COALESCE(rule_data->>'channel','whatsapp') <> 'whatsapp'
        OR COALESCE(rule_data->>'days_offset','0') !~ '^-?[0-9]{1,4}$'
        OR COALESCE(rule_data->>'order_index','0') !~ '^-?[0-9]{1,6}$' THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Modelo inválido';
      END IF;
      IF NULLIF(p_payload->>'rule_id','') IS NOT NULL THEN
        SELECT * INTO r FROM public.communication_rules WHERE id=(p_payload->>'rule_id')::uuid;
        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Modelo não encontrado'; END IF;
        IF r.template_version IS DISTINCT FROM (p_payload->>'base_version')::integer THEN
          RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='O modelo mudou. Atualize antes de editar.';
        END IF;
        IF rule_data->>'slug' IS DISTINCT FROM r.slug OR rule_data->>'journey' IS DISTINCT FROM r.journey
          OR rule_data->>'task_kind' IS DISTINCT FROM r.task_kind OR rule_data->>'trigger_event' IS DISTINCT FROM r.trigger_event THEN
          RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='A finalidade de um modelo existente não pode ser alterada';
        END IF;
      ELSIF COALESCE((p_payload->>'base_version')::integer,0) <> 0 THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Versão inicial inválida';
      END IF;
    END IF;
    IF policy_data IS NOT NULL THEN
      IF jsonb_typeof(policy_data) <> 'object'
        OR jsonb_typeof(policy_data->'pre_due_enabled') IS DISTINCT FROM 'boolean'
        OR COALESCE(policy_data->>'pre_due_offset','') NOT IN ('-1','0')
        OR EXISTS (SELECT 1 FROM jsonb_object_keys(policy_data) k WHERE k NOT IN ('pre_due_enabled','pre_due_offset')) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Política pré-vencimento inválida';
      END IF;
      SELECT * INTO policy_row FROM public.communication_cadence_policies WHERE slug='billing_overdue';
      IF policy_row.version IS DISTINCT FROM (p_payload->>'base_policy_version')::integer THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='A política mudou. Atualize antes de editar.';
      END IF;
    END IF;
    INSERT INTO public.communication_model_drafts(actor_id,rule_id,base_version,base_policy_version,rule,policy)
    VALUES(p_actor_id,r.id,COALESCE(r.template_version,0),(p_payload->>'base_policy_version')::integer,rule_data,policy_data)
    RETURNING * INTO d;
    RETURN to_jsonb(d);
  END IF;

  draft_id := (p_payload->>'draft_id')::uuid;
  SELECT * INTO d FROM public.communication_model_drafts WHERE id=draft_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Rascunho não encontrado'; END IF;
  IF p_action='simulate' THEN
    IF d.published_at IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='Rascunho já publicado'; END IF;
    rule_purpose := CASE WHEN d.rule IS NULL THEN 'billing' WHEN d.rule->>'journey'='billing' THEN 'billing' WHEN d.rule->>'journey'='renewal' THEN 'renewal' ELSE 'onboarding' END;
    SELECT count(*) INTO affected FROM public.communication_cases WHERE status='open' AND purpose=COALESCE(rule_purpose,'billing');
    preview_rule := CASE WHEN d.rule IS NOT NULL THEN d.rule || jsonb_build_object(
      'id',COALESCE(d.rule_id,d.id),'template_version',d.base_version+1) END;
    preview_case.id:=d.id; preview_case.source_id:=d.id; preview_case.source_type:='contract';
    preview_case.status:='open'; preview_case.purpose:=CASE WHEN d.rule IS NULL THEN 'billing' ELSE rule_purpose END;
    sample_due:=today_date-CASE WHEN d.rule->>'task_kind'='charge_overdue'
      THEN (d.rule->>'days_offset')::integer
      WHEN d.rule->>'trigger_event'='charge_due_date' THEN (d.rule->>'days_offset')::integer
      WHEN d.policy IS NOT NULL THEN (d.policy->>'pre_due_offset')::integer ELSE 3 END;
    FOR sample IN SELECT value FROM jsonb_array_elements('[
      {"label":"Contexto elegível · pessoa fictícia","balance":450,"payment_status":"pending","scenario":"eligible"},
      {"label":"Saldo parcialmente pago · pessoa fictícia","balance":120,"payment_status":"partially_paid","scenario":"partial"},
      {"label":"Pagamento confirmado · pessoa fictícia","balance":0,"payment_status":"paid","scenario":"paid"},
      {"label":"Retorno combinado para amanhã","balance":450,"payment_status":"pending","scenario":"scheduled"},
      {"label":"Telefone inválido","balance":450,"payment_status":"pending","scenario":"invalid_phone"},
      {"label":"Cobrança sem link nem Pix","balance":450,"payment_status":"pending","scenario":"missing_link"}
    ]'::jsonb) LOOP
      preview_case.hold_kind:=CASE WHEN sample->>'scenario'='scheduled' THEN 'explicit_schedule' ELSE 'none' END;
      preview_case.next_action_at:=CASE WHEN sample->>'scenario'='scheduled' THEN today_date+1 ELSE today_date END;
      sample_context:=jsonb_build_object('person_name','Marina Exemplo','reference','DEMO-0001','source_type','contract',
        'balance',sample->'balance','payment_status',CASE WHEN preview_case.purpose='onboarding' AND sample->>'scenario'<>'partial' THEN 'paid' ELSE sample->>'payment_status' END,
        'source_status','active','due_date',sample_due,'end_date',today_date+10,
        'onboarding_welcome_sent_at',CASE d.rule->>'task_kind'
          WHEN 'onboarding_checkin' THEN (now()-interval '5 days')::text
          WHEN 'onboarding_feedback' THEN (now()-interval '20 days')::text END,
        'onboarding_checkin_sent_at',CASE WHEN d.rule->>'task_kind'='onboarding_feedback'
          THEN (now()-interval '15 days')::text END,
        'plan_name','Plano trimestral de exemplo','period_months',3,'auto_renewal',false,'renewal_stage','contact_pending',
        'community_link','https://example.invalid/comunidade','coach_name','Treinador Exemplo','modality','Corrida',
        'payment_message_sent_at',CASE WHEN d.rule->>'trigger_event'='charge_created' THEN NULL ELSE (now()-interval '10 days')::text END,
        'payment_link',CASE WHEN sample->>'scenario'='missing_link' THEN NULL ELSE 'https://example.invalid/pagamento' END,
        'pix_copy',NULL,'contact_phone',CASE WHEN sample->>'scenario'='invalid_phone' THEN '123' ELSE '5511999990000' END);
      suggestion:=eon_private.communication_case_suggestion(preview_case,sample_context,preview_rule,d.policy);
      message:=public.render_communication_template(COALESCE(d.rule->>'message_template',''),eon_private.communication_template_context(sample_context));
      IF message ~ '\{[^{}]+\}' THEN
        draft_valid:=false;
        warnings:=warnings || jsonb_build_array('O texto contém variável desconhecida ou não resolvida. Corrija antes de publicar.');
      END IF;
      examples:=examples || jsonb_build_array(jsonb_build_object(
        'label',sample->>'label','scenario',sample->>'scenario',
        'message',CASE WHEN suggestion->>'blocked_reason' IS NULL THEN suggestion->>'message' ELSE '' END,
        'expected_action',CASE WHEN suggestion->>'blocked_reason' IS NOT NULL THEN 'Contato bloqueado: ' || (suggestion->>'blocked_reason')
          WHEN (suggestion->>'eligible_at')::date>today_date THEN 'Aguardar até ' || (suggestion->>'eligible_at') ELSE 'Mensagem disponível para revisão manual' END,
        'blocked_reason',suggestion->'blocked_reason','eligible_at',suggestion->'eligible_at',
        'selected_rule_slug',suggestion->'rule_slug','draft_selected',(suggestion->>'template_id')=COALESCE(d.rule_id,d.id)::text));
    END LOOP;
    IF d.rule IS NOT NULL THEN
      IF d.rule->>'journey'='reactivation' THEN
        warnings:=warnings || jsonb_build_array('Reativação é manual e não cria casos automaticamente.');
      END IF;
      IF d.rule_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.communication_rules old_rule
        WHERE old_rule.id=d.rule_id AND (old_rule.days_offset IS DISTINCT FROM (d.rule->>'days_offset')::integer OR (d.rule->>'active')::boolean=false)
        AND NOT EXISTS(SELECT 1 FROM public.communication_rules alternative WHERE alternative.active AND alternative.id<>old_rule.id
          AND alternative.journey=old_rule.journey AND alternative.task_kind=old_rule.task_kind AND alternative.trigger_event=old_rule.trigger_event AND alternative.days_offset=old_rule.days_offset)) THEN
        warnings:=warnings || jsonb_build_array('Esta mudança deixa a etapa anterior sem modelo ativo. Os acompanhamentos continuam visíveis, mas o envio dessa etapa ficará bloqueado.');
      END IF;
      IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(examples) x WHERE (x->>'draft_selected')::boolean) THEN
        warnings:=warnings || jsonb_build_array('Este rascunho não foi selecionado nos cenários. Confira a etapa, se está ativo e a prioridade entre os modelos.');
      END IF;
    END IF;
    fingerprint := md5(d.id::text || COALESCE(d.rule::text,'') || COALESCE(d.policy::text,'') || clock_timestamp()::text);
    result := jsonb_build_object('draft_id',d.id,'can_publish',draft_valid,'scenarios',examples,
      'affected_open_cases',affected,'warnings',warnings,'simulation_fingerprint',fingerprint,
      'scope_note','Casos abertos dessa finalidade. O número não representa mensagens que serão enviadas.');
    UPDATE public.communication_model_drafts SET simulation=result,simulation_fingerprint=fingerprint,
      simulated_at=now(),simulated_by=p_actor_id WHERE id=d.id;
    RETURN result;
  END IF;
  IF p_action='publish' THEN
    IF d.simulation_fingerprint IS NULL OR d.simulation_fingerprint IS DISTINCT FROM p_payload->>'simulation_fingerprint'
      OR d.updated_at IS DISTINCT FROM (p_payload->>'expected_updated_at')::timestamptz
      OR COALESCE((d.simulation->>'can_publish')::boolean,false)=false THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='Simule o rascunho atual antes de publicar';
    END IF;
    IF d.published_at IS NOT NULL THEN RETURN d.publication_result; END IF;
    IF d.rule IS NOT NULL THEN
      IF d.rule_id IS NOT NULL THEN
        SELECT * INTO r FROM public.communication_rules WHERE id=d.rule_id FOR UPDATE;
        IF NOT FOUND OR r.template_version<>d.base_version THEN
          RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='O modelo mudou após a simulação. Atualize e revise um novo rascunho.';
        END IF;
        rule_before:=to_jsonb(r);
        UPDATE public.communication_rules SET name=d.rule->>'name',message_template=d.rule->>'message_template',
          active=(d.rule->>'active')::boolean,days_offset=COALESCE((d.rule->>'days_offset')::integer,0),
          order_index=COALESCE((d.rule->>'order_index')::integer,0),updated_at=now()
        WHERE id=r.id RETURNING * INTO r;
      ELSE
        INSERT INTO public.communication_rules(slug,name,journey,trigger_event,task_kind,days_offset,message_template,active,order_index)
        VALUES(d.rule->>'slug',d.rule->>'name',d.rule->>'journey',d.rule->>'trigger_event',d.rule->>'task_kind',
          COALESCE((d.rule->>'days_offset')::integer,0),d.rule->>'message_template',(d.rule->>'active')::boolean,
          COALESCE((d.rule->>'order_index')::integer,0)) RETURNING * INTO r;
      END IF;
    END IF;
    IF d.policy IS NOT NULL THEN
      SELECT * INTO policy_row FROM public.communication_cadence_policies WHERE slug='billing_overdue' FOR UPDATE;
      IF policy_row.version<>d.base_policy_version THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='A política mudou após a simulação. Atualize e revise um novo rascunho.';
      END IF;
      policy_before:=to_jsonb(policy_row);
      UPDATE public.communication_cadence_policies SET pre_due_enabled=(d.policy->>'pre_due_enabled')::boolean,
        pre_due_offset=(d.policy->>'pre_due_offset')::integer,version=version+1,updated_at=now()
      WHERE slug='billing_overdue' RETURNING * INTO policy_row;
    END IF;
    result := jsonb_build_object('rule',CASE WHEN r.id IS NOT NULL THEN to_jsonb(r) END,
      'policy',CASE WHEN policy_row.slug IS NOT NULL THEN to_jsonb(policy_row) END,
      'rule_before',rule_before,'policy_before',policy_before,'published_by',p_actor_id,'published_at',now());
    UPDATE public.communication_model_drafts SET published_at=now(),published_by=p_actor_id,rule_id=COALESCE(r.id,d.rule_id),publication_result=result WHERE id=d.id;
    RETURN result;
  END IF;
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Ação de modelo inválida';
END;
$$;

REVOKE ALL ON FUNCTION eon_private.communication_onboarding_eligible(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION eon_private.communication_onboarding_eligible(uuid)
  TO service_role;
REVOKE ALL ON FUNCTION eon_private.communication_case_suggestion(public.communication_cases,jsonb,jsonb,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION eon_private.communication_case_suggestion(public.communication_cases,jsonb,jsonb,jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.apply_communication_case_action(uuid,jsonb,text,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_communication_case_action(uuid,jsonb,text,uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.communication_model_command(text,uuid,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.communication_model_command(text,uuid,jsonb)
  TO service_role;
