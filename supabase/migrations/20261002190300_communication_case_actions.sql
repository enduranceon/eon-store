-- Source row is locked before the case row, matching source-trigger order.
-- Every accepted action, domain mutation, case update, event and idempotency
-- result is in one database transaction.
CREATE OR REPLACE FUNCTION public.apply_communication_case_action(
  p_case_id uuid,p_request jsonb,p_idempotency_key text,p_actor_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
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
     OR v_action NOT IN ('message_sent','response_recorded','return_scheduled','review_requested','resolve_case')
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
    WHERE case_id=p_case_id AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_command.request_hash<>v_hash OR v_command.actor_id<>p_actor_id THEN
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
  v_context := eon_private.communication_source_context(v_case.source_type,v_case.source_id);
  IF v_context IS NULL OR eon_private.communication_source_fingerprint(v_context)
     IS DISTINCT FROM p_request->>'expected_source_fingerprint' THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='A origem mudou. Atualize a página.';
  END IF;
  IF v_case.purpose='billing' AND v_action<>'resolve_case'
     AND (v_context->>'payment_status' IN ('paid','cancelled','refunded')
       OR COALESCE(NULLIF(v_context->>'balance','')::numeric,0)<=0) THEN
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
       OR (v_suggestion->>'eligible_at')::date>v_today THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='Este contato não está elegível. Atualize a página.';
    END IF;
    IF EXISTS(SELECT 1 FROM public.communication_case_events
      WHERE case_id=p_case_id AND event_type='message_sent' AND contact_date=v_today) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='Já existe contato registrado hoje';
    END IF;
    IF v_case.purpose='billing' THEN
      IF v_case.source_type='contract' THEN
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
      VALUES(v_case.source_id,CASE WHEN v_suggestion->>'action_code'='onboarding_checkin'
        THEN 'onboarding_checkin_sent' ELSE 'onboarding_welcome_sent' END,
        jsonb_build_object('communication_case_id',p_case_id,'message',v_message,
          'source','communication_case','channel','whatsapp'),p_actor_id);
    END IF;
    v_event_type:='message_sent';
    v_payload := v_payload || jsonb_build_object('action_code',v_suggestion->>'action_code',
      'occurrence',v_suggestion->>'action_code');
    v_next := COALESCE(v_date,(v_suggestion->>'proposed_next_action_at')::date);
    IF v_date IS NOT NULL THEN v_hold:='explicit_schedule'; END IF;
    IF v_case.purpose='onboarding' AND v_suggestion->>'action_code'='onboarding_checkin' THEN
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
    v_hold := CASE WHEN v_date IS NOT NULL THEN 'contact_wait' ELSE 'none' END;
    IF v_code IN ('paid_claimed','dispute','needs_agent','change_plan_or_coach') THEN
      v_hold:='explicit_schedule'; v_next:=COALESCE(v_date,v_today);
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
       AND v_suggestion->>'action_code'='onboarding_checkin') THEN
    UPDATE public.communication_cases SET status='resolved',hold_kind='none',
      next_action_at=NULL,resolved_at=now(),resolution_reason=CASE
        WHEN v_action='resolve_case' THEN 'operator_verified' ELSE 'onboarding_completed' END,
      last_contact_at=CASE WHEN v_action='message_sent' THEN now() ELSE last_contact_at END,
      version=version+1,updated_at=now() WHERE id=p_case_id;
  ELSIF v_case.status='open' THEN
    UPDATE public.communication_cases SET hold_kind=v_hold,next_action_at=v_next,
      blocked_reason=CASE WHEN v_event_type='review_requested' THEN 'review_requested' ELSE NULL END,
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
  INSERT INTO public.communication_case_commands(case_id,idempotency_key,request_hash,result,actor_id)
    VALUES(p_case_id,p_idempotency_key,v_hash,v_result,p_actor_id);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_communication_case_action(uuid,jsonb,text,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_communication_case_action(uuid,jsonb,text,uuid)
  TO service_role;
