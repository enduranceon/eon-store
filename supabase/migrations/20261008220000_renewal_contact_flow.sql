BEGIN;
SET LOCAL lock_timeout = '5s';

-- Fluxo de renovação (docs/fluxos-de-mensagens.md, seção 4).
-- 1. Régua de contato: Pebinha 10 dias antes; sem resposta, lembrete 2 dias
--    depois, mensagem no último dia do plano e encerramento 5 dias depois do
--    fim, que leva a "Não renovou" com o motivo "Atleta não respondeu".
-- 2. "Ainda pensando": mensagem de combinado na hora e retorno em 2 dias.
-- 3. "Não vou renovar": despedida com pedido de feedback (só histórico).
-- 4. O Pebinha passa a dizer o plano e a data; a primeira cobrança da
--    renovação na Central usa o texto de "renovação confirmada".
-- O passo enviado fica no próprio contrato (renewal_contact_step), gravado só
-- pelas ações do quadro e da Central.

-- 1. Passo de contato no contrato de renovação -----------------------------------------
ALTER TABLE public.assessment_contracts
  ADD COLUMN IF NOT EXISTS renewal_contact_step text,
  ADD COLUMN IF NOT EXISTS renewal_contact_step_at timestamptz;
ALTER TABLE public.assessment_contracts
  DROP CONSTRAINT IF EXISTS assessment_contracts_renewal_contact_step_check;
ALTER TABLE public.assessment_contracts
  ADD CONSTRAINT assessment_contracts_renewal_contact_step_check CHECK (
    (renewal_contact_step IS NULL AND renewal_contact_step_at IS NULL)
    OR (parent_contract_id IS NOT NULL AND renewal_contact_step_at IS NOT NULL
      AND renewal_contact_step IN ('intent', 'reminder', 'last_day', 'closing',
        'thinking_ack', 'thinking_return')));
COMMENT ON COLUMN public.assessment_contracts.renewal_contact_step IS
  'Último passo da régua de contato da renovação que foi enviado: intent (Pebinha), reminder, last_day, closing, thinking_ack ou thinking_return.';

-- O passo de contato também só muda pelo servidor.
CREATE OR REPLACE FUNCTION eon_private.guard_assessment_renewal_stage_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.renewal_stage IS NOT NULL
       OR NEW.renewal_entered_at IS NOT NULL
       OR NEW.renewal_stage_updated_at IS NOT NULL
       OR NEW.renewal_response_code IS NOT NULL
       OR NEW.renewal_response_at IS NOT NULL
       OR NEW.renewal_follow_up_at IS NOT NULL
       OR NEW.renewal_last_contact_at IS NOT NULL
       OR NEW.renewal_resolved_at IS NOT NULL
       OR NEW.renewal_contact_step IS NOT NULL
       OR NEW.renewal_contact_step_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'A etapa da renovação só pode ser alterada pelas ações de Renovações';
    END IF;
  ELSIF (
    NEW.renewal_stage, NEW.renewal_entered_at, NEW.renewal_stage_updated_at,
    NEW.renewal_response_code, NEW.renewal_response_at, NEW.renewal_follow_up_at,
    NEW.renewal_last_contact_at, NEW.renewal_resolved_at,
    NEW.renewal_contact_step, NEW.renewal_contact_step_at
  ) IS DISTINCT FROM (
    OLD.renewal_stage, OLD.renewal_entered_at, OLD.renewal_stage_updated_at,
    OLD.renewal_response_code, OLD.renewal_response_at, OLD.renewal_follow_up_at,
    OLD.renewal_last_contact_at, OLD.renewal_resolved_at,
    OLD.renewal_contact_step, OLD.renewal_contact_step_at
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'A etapa da renovação só pode ser alterada pelas ações de Renovações';
  END IF;
  RETURN NEW;
END;
$$;

-- As renovações abertas que já receberam o Pebinha começam a régua por ele.
UPDATE public.assessment_contracts c
SET renewal_contact_step = 'intent',
    renewal_contact_step_at = last_message.at
FROM (
  SELECT e.contract_id, max(e.created_at) AS at
  FROM public.assessment_contract_event e
  WHERE e.event_type = 'renewal_message_sent'
  GROUP BY e.contract_id
) last_message
WHERE last_message.contract_id = c.id
  AND c.renewal_stage IN ('contact_pending', 'waiting_response')
  AND c.renewal_contact_step IS NULL;


-- 2. Régua de contato da renovação -----------------------------------------------------
-- Passos: intent (Pebinha), reminder (2 dias depois), last_day (último dia do
-- plano), closing (5 dias depois do fim, sem resposta) e close (encerrar como
-- "Não renovou"). "Ainda pensando" responde na hora (thinking_ack) e volta na
-- data combinada (thinking_return, padrão 2 dias); depois segue a régua.
CREATE OR REPLACE FUNCTION eon_private.assessment_renewal_contact_plan(
  p_step text, p_step_at timestamptz, p_response text, p_response_at timestamptz,
  p_follow_up date, p_end date, p_today date
)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  v_last date := (p_step_at AT TIME ZONE 'America/Sao_Paulo')::date;
  v_step text;
  v_at date;
BEGIN
  IF p_response IN ('will_renew', 'change_plan_or_coach', 'needs_agent', 'not_renewing')
     OR p_step = 'farewell' THEN
    RETURN jsonb_build_object('step', 'none', 'eligible_at', NULL);
  END IF;
  IF p_step = 'closing' THEN
    RETURN jsonb_build_object('step', 'close', 'eligible_at', v_last);
  END IF;
  IF p_response = 'thinking' AND (p_step_at IS NULL OR p_response_at > p_step_at
       OR p_step NOT IN ('thinking_ack', 'thinking_return')) THEN
    v_step := 'thinking_ack';
    v_at := (p_response_at AT TIME ZONE 'America/Sao_Paulo')::date;
  ELSIF p_step IS NULL THEN
    -- O Pebinha vale assim que a renovação entra no quadro (10 dias antes).
    v_step := 'intent';
    v_at := LEAST(COALESCE(p_end - 10, p_today), p_today);
  ELSIF p_step = 'thinking_ack' THEN
    v_step := 'thinking_return';
    v_at := COALESCE(p_follow_up, v_last + 2);
  ELSIF p_end IS NULL THEN
    RETURN jsonb_build_object('step', 'none', 'eligible_at', NULL);
  ELSIF p_step = 'intent' AND v_last + 2 < p_end THEN
    v_step := 'reminder';
    v_at := v_last + 2;
  ELSIF p_step IN ('intent', 'reminder', 'thinking_return') AND v_last < p_end THEN
    v_step := 'last_day';
    v_at := p_end;
  ELSE
    v_step := 'closing';
    v_at := GREATEST(p_end + 5, v_last + 1);
  END IF;
  -- Um follow-up marcado à mão segura o próximo passo até a data.
  IF p_follow_up IS NOT NULL AND v_step NOT IN ('thinking_ack', 'thinking_return') THEN
    v_at := GREATEST(v_at, p_follow_up);
  END IF;
  RETURN jsonb_build_object('step', v_step, 'eligible_at', v_at);
END;
$$;

-- A régua de um contrato de renovação, com a data do passo seguinte (se o
-- passo da vez for enviado hoje).
CREATE OR REPLACE FUNCTION eon_private.assessment_renewal_contact_plan_for(
  p_contract_id uuid, p_today date
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_end date;
  v_plan jsonb;
  v_next jsonb;
BEGIN
  SELECT * INTO v_contract FROM public.assessment_contracts WHERE id = p_contract_id;
  IF NOT FOUND OR v_contract.parent_contract_id IS NULL THEN
    RETURN jsonb_build_object('step', 'intent', 'eligible_at', p_today, 'next_at', NULL);
  END IF;
  SELECT end_date INTO v_end FROM public.assessment_contracts
  WHERE id = v_contract.parent_contract_id;
  v_end := COALESCE(v_end, v_contract.start_date - 1);
  v_plan := eon_private.assessment_renewal_contact_plan(
    v_contract.renewal_contact_step, v_contract.renewal_contact_step_at,
    v_contract.renewal_response_code, v_contract.renewal_response_at,
    v_contract.renewal_follow_up_at, v_end, p_today);
  IF v_plan->>'step' NOT IN ('none', 'close') THEN
    v_next := eon_private.assessment_renewal_contact_plan(
      v_plan->>'step', now(), v_contract.renewal_response_code, v_contract.renewal_response_at,
      CASE WHEN v_plan->>'step' = 'thinking_ack'
        THEN COALESCE(v_contract.renewal_follow_up_at, p_today + 2) END,
      v_end, p_today);
  END IF;
  RETURN v_plan || jsonb_build_object('end_date', v_end,
    'next_at', CASE WHEN v_next->>'step' IN ('none', 'close') THEN p_today
      ELSE (v_next->>'eligible_at')::date END);
END;
$$;

-- 3. Mensagens: {fim_plano} e o aviso do Pebinha com plano e data ------------------------
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
  v_name text := COALESCE(NULLIF(btrim(p_context->>'person_name'),''),'Cliente');
  v_item jsonb;
  v_items text := '';
  v_first_item text;
  v_item_name text;
  v_item_count integer:=0;
  v_quantity integer;
  v_ref text := NULLIF(p_context->>'reference', '');
  v_plan_end date;
  v_plan_name text := NULLIF(p_context->>'plan_name', '');
  v_overdue integer;
  v_about text;
BEGIN
  v_due := NULLIF(p_context->>'due_date', '')::date;
  v_end := NULLIF(p_context->>'end_date', '')::date;
  v_balance := NULLIF(p_context->>'balance', '')::numeric;
  -- Na renovação, o fim que importa é o do plano atual (contrato anterior).
  IF p_context->>'source_type' = 'contract'
     AND NULLIF(p_context->>'parent_contract_id', '') IS NOT NULL THEN
    SELECT parent.end_date INTO v_plan_end
    FROM public.assessment_contracts parent
    WHERE parent.id = (p_context->>'parent_contract_id')::uuid;
  END IF;
  v_plan_end := COALESCE(v_plan_end, v_end);
  v_type := CASE p_context->>'source_type'
    WHEN 'contract' THEN 'contrato' WHEN 'event' THEN 'inscricao'
    ELSE 'pedido' END;
  IF jsonb_typeof(p_context->'items')='array' THEN
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_context->'items') LOOP
      IF COALESCE(v_item->>'cancelled','false')='true' THEN CONTINUE; END IF;
      v_item_name:=COALESCE(NULLIF(v_item->>'product_name',''),
        NULLIF(v_item->>'name',''),NULLIF(v_item->>'description',''));
      IF v_item_name IS NULL THEN CONTINUE; END IF;
      v_item_count:=v_item_count+1;
      v_first_item:=COALESCE(v_first_item,v_item_name);
      v_quantity:=CASE WHEN COALESCE(v_item->>'quantity','') ~ '^[0-9]{1,4}$'
        THEN GREATEST(1,(v_item->>'quantity')::integer) ELSE 1 END;
      v_items:=v_items || CASE WHEN v_items='' THEN '' ELSE E'\n' END ||
        '- ' || v_item_name || ' x' || v_quantity;
    END LOOP;
  END IF;
  -- Cobrança vencida: há quantos dias e a que se refere.
  v_overdue := v_today - v_due;
  v_first_item := CASE WHEN v_item_count>1 THEN v_first_item||' +'||(v_item_count-1)
    ELSE v_first_item END;
  v_about := CASE p_context->>'source_type'
    WHEN 'contract' THEN CASE
      WHEN NULLIF(p_context->>'plan_name','') IS NOT NULL
        THEN 'referente ao seu plano ' || (p_context->>'plan_name')
          || COALESCE(' (' || v_ref || ')', '')
      ELSE 'referente ao seu contrato' || COALESCE(' ' || v_ref, '') END
    WHEN 'event' THEN 'referente à sua inscrição' || COALESCE(' ' || v_ref, '')
      || COALESCE(' (' || v_first_item || ')', '')
    ELSE 'referente ao seu pedido' || COALESCE(' ' || v_ref, '')
      || COALESCE(' (' || v_first_item || ')', '') END;
  RETURN jsonb_build_object(
    'nome', split_part(v_name,' ',1),
    'nome_completo', v_name,
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
      ELSE 'PIX Copia e Cola:' || E'\n' || v_pix || E'\n\n' END,
    'pix_copia_cola', COALESCE(v_pix,''),
    'link_bloco', CASE WHEN v_link IS NULL THEN ''
      ELSE 'Link de pagamento:' || E'\n' || v_link || E'\n\n' END,
    'link_pagamento', COALESCE(v_link,''),
    'item', COALESCE(v_first_item,''),
    'dias_atraso', CASE WHEN v_overdue IS NULL OR v_overdue <= 0 THEN ''
      WHEN v_overdue = 1 THEN '1 dia' ELSE v_overdue || ' dias' END,
    'referente', v_about,
    'itens', v_items,
    'itens_bloco', CASE WHEN v_items='' THEN ''
      ELSE 'Itens:' || E'\n' || v_items || E'\n\n' END,
    'plano', COALESCE(NULLIF(p_context->>'plan_name', ''), 'seu plano'),
    'data_fim', CASE WHEN v_end IS NULL THEN '' ELSE to_char(v_end, 'DD/MM/YYYY') END,
    'fim_plano', CASE WHEN v_plan_end IS NULL THEN '' ELSE to_char(v_plan_end, 'DD/MM') END,
    'dias', CASE WHEN v_end IS NULL THEN '' ELSE (v_end-v_today)::text END,
    'aviso_vencimento', CASE WHEN v_plan_end IS NULL
      THEN 'a data de vencimento do seu plano precisa ser confirmada'
      ELSE 'seu plano' || COALESCE(' ' || v_plan_name, '')
        || CASE WHEN v_plan_end >= v_today THEN ' vence em ' ELSE ' venceu em ' END
        || to_char(v_plan_end, 'DD/MM') END,
    'modalidade', COALESCE(NULLIF(p_context->>'modality_name',''),'a confirmar'),
    'coach', COALESCE(NULLIF(p_context->>'coach_name',''),'a definir'),
    'comunidade', COALESCE(NULLIF(p_context->>'community_link',''),
      '(link da comunidade não configurado)')
  );
END;
$$;

-- 4. Central: passos da renovação e "renovação confirmada" na primeira cobrança -------
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
  v_last_sent date;
  v_last_skipped date;
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
  v_renewal_plan jsonb;
  v_renewal_step text;
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
    -- "Desconsiderar mensagem" conta como o passo feito, sem envio.
    SELECT GREATEST(max(contact_date) FILTER (WHERE event_type = 'message_sent'),
        (NULLIF(p_context->>'payment_message_sent_at','')::timestamptz
          AT TIME ZONE 'America/Sao_Paulo')::date),
      max(contact_date) FILTER (WHERE event_type = 'message_skipped')
      INTO v_last_sent, v_last_skipped FROM public.communication_case_events
      WHERE case_id = p_case.id AND event_type IN ('message_sent', 'message_skipped');
    v_last := GREATEST(v_last_sent, v_last_skipped);
    IF NULLIF(p_context->>'balance', '') IS NULL THEN
      v_block := 'balance_review';
    ELSIF p_context->>'payment_status' IN ('paid', 'cancelled', 'refunded')
       OR (p_context->>'balance')::numeric <= 0 THEN
      v_block := 'source_resolved';
    ELSIF p_context->>'source_status' IN ('cancelled', 'voided') THEN
      v_block := 'source_closed_review';
    END IF;
    -- Depois do vencimento, a régua de atraso vale mesmo sem a primeira
    -- mensagem registrada (as de atraso também levam o link).
    IF v_last IS NULL AND p_context->>'payment_status'<>'partially_paid'
       AND (v_due IS NULL OR v_today <= v_due)
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
      -- Vencida: todo dia a partir do 3º dia, com o mesmo modelo.
      v_days := v_today - v_due;
      v_slug := 'billing-charge-overdue'; v_action := 'overdue_daily';
      v_next := GREATEST(v_due + 3, v_today) + 1;
      IF v_days < 3 THEN
        v_eligible := v_due + 3;
        IF v_policy.pre_due_enabled
           AND (p_context->>'period_months')::integer = ANY(v_policy.pre_due_months)
           AND COALESCE(p_context->>'auto_renewal', 'false') <> 'true'
           AND v_today <= v_due
           AND (v_last IS NULL OR v_last < v_due + v_policy.pre_due_offset) THEN
          v_slug := CASE v_policy.pre_due_offset
            WHEN 0 THEN 'billing-pre-due-0d' ELSE 'billing-pre-due-1d' END;
          v_action := 'pre_due';
          v_eligible := v_due + v_policy.pre_due_offset;
          v_next := v_due + 3;
        END IF;
      END IF;
    END IF;
    IF v_last = v_today THEN
      v_block := COALESCE(v_block, CASE
        WHEN v_last_sent IS DISTINCT FROM v_today THEN 'skipped_today'
        ELSE 'already_contacted_today' END);
      v_eligible := v_today + 1;
    END IF;
    IF NULLIF(p_context->>'payment_link', '') IS NULL
       AND NULLIF(p_context->>'pix_copy', '') IS NULL THEN
      v_block := COALESCE(v_block, 'missing_payment_link');
    END IF;
    IF v_due IS NULL THEN v_block := COALESCE(v_block, 'missing_due_date'); END IF;
  ELSIF p_case.purpose = 'renewal' THEN
    -- Régua da renovação (docs/fluxos-de-mensagens.md, seção 4).
    v_renewal_plan := eon_private.assessment_renewal_contact_plan_for(p_case.source_id, v_today);
    v_renewal_step := COALESCE(v_renewal_plan->>'step', 'intent');
    v_slug := 'renewal-reminder-14d'; v_action := 'renewal_' || v_renewal_step;
    v_eligible := COALESCE((v_renewal_plan->>'eligible_at')::date, v_today);
    v_next := (v_renewal_plan->>'next_at')::date;
    IF p_context->>'renewal_stage' NOT IN ('contact_pending', 'waiting_response') THEN
      v_block := 'renewal_stage_changed';
    ELSIF v_renewal_step = 'close' THEN
      v_block := 'renewal_close_pending';
    ELSIF v_renewal_step = 'none' THEN
      v_block := 'renewal_review';
    END IF;
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
    -- A primeira cobrança da renovação usa o texto de "renovação confirmada".
    v_rule_offset:=CASE v_action
      WHEN 'initial_charge' THEN CASE WHEN p_context->>'source_type'='contract'
        AND NULLIF(p_context->>'parent_contract_id','') IS NOT NULL THEN 1 ELSE 0 END
      WHEN 'pre_due' THEN v_policy.pre_due_offset
      ELSE 3 END;
  ELSIF p_case.purpose='renewal' THEN
    v_rule_journey:='renewal';v_rule_kind:='renewal_reminder';
    v_rule_trigger:=CASE WHEN v_renewal_step IN ('thinking_ack','thinking_return')
      THEN 'manual' ELSE 'contract_end_date' END;
    v_rule_offset:=CASE v_renewal_step
      WHEN 'reminder' THEN -8 WHEN 'last_day' THEN 0 WHEN 'closing' THEN 5
      WHEN 'thinking_ack' THEN 1 WHEN 'thinking_return' THEN 2 ELSE -10 END;
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
  -- Sem o modelo de "renovação confirmada", vale a cobrança comum.
  IF v_rule.id IS NULL AND v_action='initial_charge' AND v_rule_offset=1 THEN
    SELECT r.* INTO v_rule FROM public.communication_rules r
    WHERE r.journey='billing' AND r.trigger_event='charge_created'
      AND r.task_kind='charge_send' AND r.days_offset=0 AND r.active=true
    ORDER BY r.order_index,r.slug,r.id LIMIT 1;
  END IF;
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

CREATE OR REPLACE FUNCTION eon_private.ensure_communication_case(
  p_source_type text, p_source_id uuid, p_purpose text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_context jsonb;
  v_key text;
  v_case_id uuid;
  v_old record;
  v_eligible boolean := false;
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_due date;
  v_prior_reason text;
  v_prior_successor uuid;
  v_followup date;
  v_new_hold text;
  v_new_next date;
  v_new_block text;
  v_renewal_plan jsonb;
  v_plan_at date;
BEGIN
  v_context := eon_private.communication_source_context(p_source_type, p_source_id);
  IF v_context IS NULL THEN RETURN NULL; END IF;
  IF p_purpose = 'billing' THEN
    v_eligible := v_context->>'payment_status' IN
      ('pending', 'awaiting_charge', 'charge_sent', 'overdue', 'partially_paid');
    IF p_source_type='contract' AND v_context->>'parent_contract_id' IS NOT NULL
       AND v_context->>'renewal_stage' IN
         ('contact_pending','waiting_response','charge_pending') THEN
      v_eligible:=false;
    END IF;
    IF (v_context->>'balance') IS NOT NULL
       AND (v_context->>'balance')::numeric <= 0 THEN
      v_eligible := false;
    END IF;
    -- Prospect ainda em rascunho é cobrado pelo quadro de Prospects
    -- (lembrete e encerramento da proposta), não pela Central.
    IF p_source_type = 'contract' AND EXISTS (
      SELECT 1 FROM public.assessment_contracts
      WHERE id = p_source_id AND status = 'draft' AND prospect_stage IS NOT NULL
    ) THEN
      v_eligible := false;
    END IF;
    v_key := eon_private.communication_obligation_key(v_context);
  ELSIF p_purpose = 'renewal' THEN
    v_eligible := p_source_type = 'contract'
      AND v_context->>'parent_contract_id' IS NOT NULL
      AND v_context->>'renewal_stage' IN ('contact_pending', 'waiting_response');
    v_key := 'renewal';
  ELSIF p_purpose = 'onboarding' THEN
    v_eligible := p_source_type = 'contract'
      AND eon_private.communication_onboarding_eligible(p_source_id);
    v_key := 'welcome';
  ELSE
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Finalidade inválida';
  END IF;

  IF NOT v_eligible THEN
    FOR v_old IN
      UPDATE public.communication_cases
      SET status = 'resolved', hold_kind = 'none', next_action_at = NULL,
          resolved_at = now(), resolution_reason = 'source_resolved',
          version = version + 1, updated_at = now()
      WHERE source_type = p_source_type AND source_id = p_source_id
        AND purpose = p_purpose AND status = 'open'
      RETURNING id
    LOOP
      INSERT INTO public.communication_case_events
        (case_id, event_type, payload)
      VALUES (v_old.id, 'source_resolved', jsonb_build_object(
        'payment_status', v_context->>'payment_status',
        'source_status', v_context->>'source_status',
        'renewal_stage', v_context->>'renewal_stage'
      ));
    END LOOP;
    RETURN NULL;
  END IF;

  v_due := CASE WHEN COALESCE(v_context->>'due_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
    THEN (v_context->>'due_date')::date ELSE NULL END;
  INSERT INTO public.communication_cases
    (source_type, source_id, purpose, obligation_key, next_action_at)
  VALUES (
    p_source_type, p_source_id, p_purpose, v_key,
    CASE
      WHEN p_purpose = 'billing' AND v_due IS NOT NULL THEN
        CASE WHEN v_context->>'payment_message_sent_at' IS NULL
          THEN LEAST(v_due, v_today) ELSE v_due + 3 END
      ELSE v_today
    END
  )
  ON CONFLICT (source_type, source_id, purpose, obligation_key) DO NOTHING
  RETURNING id INTO v_case_id;

  IF v_case_id IS NOT NULL THEN
    INSERT INTO public.communication_case_events (case_id, event_type, payload)
    VALUES (v_case_id, 'case_opened', jsonb_build_object(
      'source_type', p_source_type, 'source_id', p_source_id,
      'purpose', p_purpose, 'obligation_key', v_key
    ));
  ELSE
    SELECT id INTO v_case_id FROM public.communication_cases
    WHERE source_type = p_source_type AND source_id = p_source_id
      AND purpose = p_purpose AND obligation_key = v_key;
    IF v_case_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Falha ao localizar o acompanhamento';
    END IF;
    SELECT resolution_reason,superseded_by_case_id
      INTO v_prior_reason,v_prior_successor
    FROM public.communication_cases WHERE id=v_case_id;
    UPDATE public.communication_cases
    SET status = 'open', resolved_at = NULL, resolution_reason = NULL,
        superseded_by_case_id = NULL,
        hold_kind = 'none', next_action_at = v_today,
        blocked_reason = 'source_reopened_review',
        version = version + 1, updated_at = now()
    WHERE id = v_case_id AND status = 'resolved'
      AND resolution_reason IN ('source_resolved','source_superseded','operator_verified');
    IF FOUND THEN
      INSERT INTO public.communication_case_events (case_id, event_type, payload)
      VALUES (v_case_id, 'case_reopened', jsonb_build_object(
        'payment_status', v_context->>'payment_status',
        'renewal_stage', v_context->>'renewal_stage',
        'previous_resolution_reason', v_prior_reason,
        'previous_successor_case_id', v_prior_successor
      ));
    END IF;
  END IF;

  IF p_purpose = 'billing' THEN
    FOR v_old IN
      UPDATE public.communication_cases
      SET status = 'resolved', hold_kind = 'none', next_action_at = NULL,
          resolved_at = now(), resolution_reason = 'source_superseded',
          superseded_by_case_id = v_case_id,
          version = version + 1, updated_at = now()
      WHERE source_type = p_source_type AND source_id = p_source_id
        AND purpose = 'billing' AND id <> v_case_id AND status = 'open'
      RETURNING id
    LOOP
      INSERT INTO public.communication_case_events (case_id, event_type, payload)
      VALUES (v_old.id, 'case_superseded', jsonb_build_object('successor_case_id', v_case_id));
    END LOOP;
  END IF;
  IF p_purpose = 'renewal' THEN
    SELECT * INTO v_old FROM public.communication_cases WHERE id=v_case_id;
    IF v_old.status='open' THEN
      v_followup:=NULLIF(v_context->>'renewal_follow_up_at','')::date;
      -- O caso volta à fila na data do próximo passo da régua da renovação.
      v_renewal_plan:=eon_private.assessment_renewal_contact_plan_for(p_source_id,v_today);
      v_plan_at:=(v_renewal_plan->>'eligible_at')::date;
      v_new_hold:=CASE
        WHEN v_old.blocked_reason IN ('review_requested','payment_review',
          'dispute','needs_agent','source_reopened_review')
          AND v_old.hold_kind='explicit_schedule' THEN 'explicit_schedule'
        WHEN v_plan_at>v_today AND (v_followup>v_today
          OR v_renewal_plan->>'step'='thinking_return') THEN 'explicit_schedule'
        WHEN v_plan_at>v_today THEN 'contact_wait'
        ELSE 'none' END;
      v_new_next:=CASE
        WHEN v_new_hold='explicit_schedule' AND v_plan_at IS NULL THEN v_old.next_action_at
        WHEN v_plan_at>v_today THEN v_plan_at
        ELSE v_today END;
      v_new_block:=CASE
        WHEN v_old.blocked_reason IN ('review_requested','payment_review',
          'dispute','needs_agent','source_reopened_review') THEN v_old.blocked_reason
        WHEN v_context->>'renewal_response_code' IN
          ('change_plan_or_coach','needs_agent')
          AND NOT EXISTS (SELECT 1 FROM public.communication_case_events review
            WHERE review.case_id=v_case_id AND review.event_type='review_completed'
              AND review.created_at>=NULLIF(v_context->>'renewal_response_at','')::timestamptz)
          THEN 'renewal_review'
        ELSE NULL END;
      UPDATE public.communication_cases
      SET hold_kind=v_new_hold,next_action_at=v_new_next,
        last_contact_at=COALESCE(NULLIF(v_context->>'renewal_last_contact_at','')::timestamptz,
          last_contact_at),blocked_reason=v_new_block,
        version=version+1,updated_at=now()
      WHERE id=v_case_id AND (hold_kind IS DISTINCT FROM v_new_hold
        OR next_action_at IS DISTINCT FROM v_new_next
        OR last_contact_at IS DISTINCT FROM COALESCE(
          NULLIF(v_context->>'renewal_last_contact_at','')::timestamptz,last_contact_at)
        OR blocked_reason IS DISTINCT FROM v_new_block);
    END IF;
  END IF;
  RETURN v_case_id;
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
     OR v_action NOT IN ('message_sent','message_skipped','response_recorded','return_scheduled',
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
  ELSIF v_action='message_skipped' THEN
    -- Cobrança: o passo da vez fica feito sem envio e a régua segue para o
    -- próximo. Não mexe na venda nem conta como contato com a pessoa.
    IF v_case.purpose<>'billing' THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Só a cobrança permite desconsiderar a mensagem';
    END IF;
    IF v_suggestion->>'blocked_reason' IS NOT NULL
       OR (v_suggestion->>'eligible_at')::date>v_today
       OR v_case.next_action_at>v_today THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='Esta mensagem não está na vez. Atualize a página.';
    END IF;
    v_event_type:='message_skipped';
    v_payload := v_payload || jsonb_build_object('action_code',v_suggestion->>'action_code',
      'occurrence',v_suggestion->>'action_code');
    v_next := (v_suggestion->>'proposed_next_action_at')::date;
    v_hold := 'contact_wait';
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
    -- Renovação "Ainda pensando": a mensagem de "combinado" sai na hora e o
    -- retorno fica na data marcada (padrão: 2 dias).
    IF v_case.purpose='renewal' AND v_code='thinking' THEN
      v_next := v_today; v_hold := 'none';
    END IF;
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
    CASE WHEN v_action IN ('message_sent','message_skipped') THEN v_today END,v_payload)
  RETURNING * INTO v_event;
  v_result := jsonb_build_object('case',(public.get_communication_case(p_case_id))->'case',
    'event',to_jsonb(v_event),'replayed',false);
  INSERT INTO public.communication_case_commands(case_id,idempotency_key,request_hash,request_payload,result,actor_id)
    VALUES(p_case_id,p_idempotency_key,v_hash,p_request,v_result,p_actor_id);
  RETURN v_result;
END;
$$;

-- 5. Quadro: passo enviado, "pensando" com retorno em 2 dias e despedida --------------
CREATE OR REPLACE FUNCTION public.transition_assessment_renewal_stage(
  p_contract_id uuid,
  p_action text,
  p_expected_updated_at timestamptz,
  p_idempotency_key text,
  p_actor_id uuid,
  p_response_code text DEFAULT NULL,
  p_follow_up_at date DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_operation public.order_operations%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_now timestamptz := now();
  v_notes text := NULLIF(btrim(p_notes), '');
  v_message text := NULLIF(btrim(p_message), '');
  v_stage_before text;
  v_stage_after text;
  v_event_type text;
  v_event_note text;
  v_result jsonb;
  v_plan jsonb;
  v_step text;
BEGIN
  IF p_contract_id IS NULL OR p_actor_id IS NULL OR p_expected_updated_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados da renovação são inválidos';
  END IF;
  IF p_action IS NULL OR p_action NOT IN (
    'message_sent', 'register_response', 'set_follow_up', 'change_resolved', 'farewell_sent'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Ação de renovação inválida';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,100}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Chave de idempotência inválida';
  END IF;
  IF v_notes IS NOT NULL AND char_length(v_notes) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A observação deve ter até 500 caracteres';
  END IF;
  IF v_message IS NOT NULL AND char_length(v_message) > 4000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A mensagem deve ter até 4000 caracteres';
  END IF;
  IF p_follow_up_at IS NOT NULL
     AND (p_follow_up_at < v_today OR p_follow_up_at > v_today + 365) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe um follow-up a partir de hoje';
  END IF;

  IF p_action = 'register_response' THEN
    IF p_response_code IS NULL OR p_response_code NOT IN (
      'will_renew', 'thinking', 'change_plan_or_coach', 'needs_agent', 'not_renewing'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resposta de renovação inválida';
    END IF;
    IF p_response_code = 'not_renewing' THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'Para "Não vou renovar", use o encerramento da renovação';
    END IF;
    IF p_response_code = 'will_renew' AND p_follow_up_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'O follow-up só vale enquanto o atleta decide';
    END IF;
  ELSIF p_response_code IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A resposta só vale ao registrar a resposta';
  END IF;
  IF p_action = 'change_resolved' AND p_follow_up_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'O follow-up só vale enquanto o atleta decide';
  END IF;
  IF p_action = 'farewell_sent' AND (v_message IS NULL OR p_follow_up_at IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe a mensagem de despedida';
  END IF;
  IF p_action NOT IN ('message_sent', 'farewell_sent') AND v_message IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'O texto da mensagem só vale ao registrar o envio';
  END IF;
  IF p_action IN ('message_sent', 'set_follow_up', 'farewell_sent') AND v_notes IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Observação não é aceita nesta ação';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Renovação não encontrada';
  END IF;
  IF v_contract.parent_contract_id IS NULL OR v_contract.renewal_stage IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este contrato não é uma renovação';
  END IF;

  SELECT * INTO v_operation
  FROM public.order_operations
  WHERE operation_type = 'renewal_stage'
    AND order_type = 'contract'
    AND order_id = p_contract_id
    AND operation_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_operation.payload->>'action' IS DISTINCT FROM p_action THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'A chave de idempotência já foi usada em outra ação';
    END IF;
    IF v_operation.status = 'completed' AND v_operation.result IS NOT NULL THEN
      RETURN v_operation.result || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Esta ação ainda está em processamento';
  END IF;

  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'A renovação foi alterada por outra ação. Atualize a página e tente novamente';
  END IF;

  v_stage_before := v_contract.renewal_stage;

  IF p_action = 'message_sent' THEN
    IF v_stage_before NOT IN ('contact_pending', 'waiting_response') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'A mensagem de renovação só pode ser registrada antes da decisão do atleta';
    END IF;
    -- O passo enviado é o que está na vez pela régua; fora dela (atendimento
    -- ou mudança pendente) a mensagem fica registrada sem mudar o passo.
    v_plan := eon_private.assessment_renewal_contact_plan_for(v_contract.id, v_today);
    v_step := CASE WHEN v_plan->>'step' IN ('none', 'close') THEN NULL ELSE v_plan->>'step' END;
    v_stage_after := 'waiting_response';
    UPDATE public.assessment_contracts
    SET renewal_stage = v_stage_after,
        renewal_stage_updated_at = CASE
          WHEN v_stage_before <> v_stage_after THEN v_now
          ELSE renewal_stage_updated_at
        END,
        renewal_last_contact_at = v_now,
        renewal_contact_step = COALESCE(v_step, renewal_contact_step),
        renewal_contact_step_at = CASE WHEN v_step IS NULL THEN renewal_contact_step_at ELSE v_now END,
        renewal_follow_up_at = CASE
          WHEN v_step = 'thinking_ack'
            THEN COALESCE(p_follow_up_at, renewal_follow_up_at, v_today + 2)
          ELSE p_follow_up_at
        END,
        updated_at = v_now
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    v_event_type := 'renewal_message_sent';
    v_event_note := CASE v_step
      WHEN 'intent' THEN 'Mensagem de intenção de renovação enviada.'
      WHEN 'reminder' THEN 'Lembrete da renovação enviado.'
      WHEN 'last_day' THEN 'Mensagem do último dia do plano enviada.'
      WHEN 'closing' THEN 'Mensagem de encerramento enviada (sem resposta).'
      WHEN 'thinking_ack' THEN 'Mensagem de "ainda pensando" enviada.'
      WHEN 'thinking_return' THEN 'Retorno do "ainda pensando" enviado.'
      ELSE 'Nova mensagem de renovação enviada.'
    END;
  ELSIF p_action = 'register_response' THEN
    IF v_stage_before NOT IN ('contact_pending', 'waiting_response') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'A resposta do atleta só pode ser registrada antes da cobrança';
    END IF;
    v_stage_after := CASE
      WHEN p_response_code = 'will_renew' THEN 'charge_pending'
      ELSE 'waiting_response'
    END;
    UPDATE public.assessment_contracts
    SET renewal_stage = v_stage_after,
        renewal_stage_updated_at = CASE
          WHEN v_stage_before <> v_stage_after THEN v_now
          ELSE renewal_stage_updated_at
        END,
        renewal_response_code = p_response_code,
        renewal_response_at = v_now,
        renewal_last_contact_at = v_now,
        renewal_follow_up_at = CASE
          WHEN v_stage_after <> 'waiting_response' THEN NULL
          WHEN p_response_code = 'thinking' THEN COALESCE(p_follow_up_at, v_today + 2)
          ELSE p_follow_up_at
        END,
        updated_at = v_now
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    v_event_type := 'renewal_response_recorded';
    v_event_note := 'Resposta registrada: ' || CASE p_response_code
      WHEN 'will_renew' THEN 'vai renovar.'
      WHEN 'thinking' THEN 'ainda está pensando.'
      WHEN 'change_plan_or_coach' THEN 'quer mudar de plano/treinador.'
      ELSE 'quer falar com um atendente.'
    END;
  ELSIF p_action = 'set_follow_up' THEN
    IF v_stage_before <> 'waiting_response' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'O follow-up só vale enquanto a renovação aguarda a decisão do atleta';
    END IF;
    v_stage_after := v_stage_before;
    UPDATE public.assessment_contracts
    SET renewal_follow_up_at = p_follow_up_at,
        updated_at = v_now
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    v_event_type := 'renewal_follow_up_set';
    v_event_note := CASE
      WHEN p_follow_up_at IS NULL THEN 'Follow-up removido.'
      ELSE 'Follow-up marcado para ' || to_char(p_follow_up_at, 'DD/MM/YYYY') || '.'
    END;
  ELSIF p_action = 'farewell_sent' THEN
    -- Despedida de quem decidiu não renovar: só fica no histórico do contrato.
    IF v_stage_before <> 'not_renewed' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'A despedida só vale depois de registrar que o atleta não vai renovar';
    END IF;
    v_stage_after := v_stage_before;
    v_step := 'farewell';
    v_event_type := 'renewal_farewell_sent';
    v_event_note := 'Mensagem de despedida enviada.';
  ELSE
    IF v_stage_before <> 'waiting_response'
       OR v_contract.renewal_response_code IS DISTINCT FROM 'change_plan_or_coach' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'Não há mudança de plano ou treinador pendente nesta renovação';
    END IF;
    v_stage_after := 'charge_pending';
    UPDATE public.assessment_contracts
    SET renewal_stage = v_stage_after,
        renewal_stage_updated_at = v_now,
        renewal_follow_up_at = NULL,
        updated_at = v_now
    WHERE id = v_contract.id
    RETURNING * INTO v_contract;
    v_event_type := 'renewal_change_resolved';
    v_event_note := 'Mudança de plano/treinador resolvida: renovação segue para cobrança.';
  END IF;

  INSERT INTO public.assessment_contract_event (
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    v_event_type,
    jsonb_build_object(
      'action', p_action,
      'source', 'renewal_pipeline',
      'stage_before', v_stage_before,
      'stage_after', v_stage_after,
      'response_code', p_response_code,
      'follow_up_at', p_follow_up_at,
      'notes', v_notes,
      'message', v_message,
      'step', v_step,
      'channel', CASE WHEN p_action IN ('message_sent', 'farewell_sent') THEN 'whatsapp' END,
      'idempotency_key', p_idempotency_key
    ),
    v_event_note,
    p_actor_id
  );

  v_result := jsonb_build_object(
    'status', 'completed',
    'action', p_action,
    'stage_before', v_stage_before,
    'stage_after', v_stage_after,
    'contract', to_jsonb(v_contract)
  );
  INSERT INTO public.order_operations (
    operation_type, operation_key, order_type, order_id, status,
    requested_by, reason, payload, result
  ) VALUES (
    'renewal_stage', p_idempotency_key, 'contract', v_contract.id, 'completed',
    p_actor_id, 'Etapa da renovação: ' || p_action,
    jsonb_build_object(
      'action', p_action,
      'expected_updated_at', p_expected_updated_at,
      'response_code', p_response_code,
      'follow_up_at', p_follow_up_at
    ),
    v_result
  );
  RETURN v_result;
END;
$$;

-- 6. Encerramento sem resposta: motivo próprio em "Não renovou" -------------------------
-- Mesma troca pontual já usada para "parent_cancelled": falha a migração se o
-- texto esperado mudar.
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
    $old$AND p_reason_code IS DISTINCT FROM 'customer_declined')$old$,
    $new$AND p_reason_code NOT IN ('customer_declined', 'no_response'))$new$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'validacao do motivo de nao renovacao nao encontrada';
  END IF;
  v_source := v_updated;

  v_updated := replace(
    v_source,
    $old$WHEN 'customer_declined' THEN 'Atleta decidiu não renovar'$old$,
    $new$WHEN 'customer_declined' THEN 'Atleta decidiu não renovar'
       WHEN 'no_response' THEN 'Atleta não respondeu à renovação'$new$
  );
  IF v_updated = v_source THEN
    RAISE EXCEPTION 'descricao do motivo de nao renovacao nao encontrada';
  END IF;
  EXECUTE v_updated;
END;
$migration$;

-- 7. Modelos novos ---------------------------------------------------------------------
UPDATE public.communication_rules
SET name = 'Renovação · Pebinha (10 dias antes)', updated_at = now()
WHERE slug = 'renewal-reminder-14d' AND name IS DISTINCT FROM 'Renovação · Pebinha (10 dias antes)';

INSERT INTO public.communication_rules
  (slug, name, journey, trigger_event, task_kind, days_offset, channel, message_template, active, order_index)
VALUES
  ('renewal-reminder-2d', 'Renovação · lembrete (2 dias depois do Pebinha)', 'renewal',
   'contract_end_date', 'renewal_reminder', -8, 'whatsapp', $tpl$Oi, {nome}! Passando de novo sobre a renovação: {aviso_vencimento}.

É só me responder com o número:
1. Sim, vou renovar.
2. Ainda estou pensando.
3. Gostaria de mudar de plano/treinador.
4. Gostaria de falar com um atendente.
5. Não vou renovar.$tpl$, true, 61),
  ('renewal-last-day', 'Renovação · último dia do plano', 'renewal',
   'contract_end_date', 'renewal_reminder', 0, 'whatsapp', $tpl$Oi, {nome}! Hoje é o último dia do seu plano {plano}.

Pra seus treinos seguirem sem pausa, me confirma se vamos renovar? Qualquer dúvida, me chama aqui.$tpl$, true, 62),
  ('renewal-closing-5d', 'Renovação · encerramento sem resposta (5 dias depois do fim)', 'renewal',
   'contract_end_date', 'renewal_reminder', 5, 'whatsapp', $tpl$Oi, {nome}! Como não tivemos retorno, estamos encerrando por aqui a renovação do seu plano.

Foi muito bom ter você treinando com a gente! Quando quiser voltar, é só chamar aqui que a gente retoma. 💙🧡$tpl$, true, 63),
  ('renewal-thinking-ack', 'Renovação · ainda pensando (na hora)', 'renewal',
   'manual', 'renewal_reminder', 1, 'whatsapp', $tpl$Combinado, {nome}! Em breve a gente retoma o contato.

Enquanto isso, posso te ajudar em alguma coisa? Se tiver qualquer dúvida sobre o plano ou os treinos, é só me chamar aqui.$tpl$, true, 64),
  ('renewal-thinking-return', 'Renovação · ainda pensando (retorno em 2 dias)', 'renewal',
   'manual', 'renewal_reminder', 2, 'whatsapp', $tpl$Oi, {nome}! Tudo bem?

Passando pra saber se você já decidiu sobre a renovação. Lembrando que {aviso_vencimento}.

É só me responder com o número:
1. Sim, vou renovar.
2. Ainda estou pensando.
3. Gostaria de mudar de plano/treinador.
4. Gostaria de falar com um atendente.
5. Não vou renovar.$tpl$, true, 65),
  ('renewal-farewell', 'Renovação · não vou renovar (despedida)', 'renewal',
   'manual', 'renewal_reminder', 3, 'whatsapp', $tpl$Oi, {nome}! Obrigado por ter treinado com a gente esse tempo todo, foi muito bom ter você na Endurance ON! 💙🧡

Se quiser, deixa um feedback sobre a sua experiência: o que foi bom e o que podemos melhorar. Isso ajuda muito a gente.

E quando quiser voltar, é só chamar aqui.$tpl$, true, 66),
  ('billing-renewal-confirmed', 'Renovação confirmada (primeira cobrança da renovação)', 'billing',
   'charge_created', 'charge_send', 1, 'whatsapp', $tpl$Olá, {nome}!

Sua renovação na *Assessoria Esportiva Endurance On* está confirmada! 💙🧡

🏃 Modalidade: *{modalidade}*
📅 Plano: *{plano}* até {data_fim}
👤 Coach: *{coach}*
💰 Total: *{valor}*
📆 Vencimento: *{vencimento}*

{pix_bloco}{link_bloco}Qualquer dúvida, estou à disposição!$tpl$, true, 11)
ON CONFLICT (slug) DO NOTHING;

REVOKE ALL ON FUNCTION eon_private.assessment_renewal_contact_plan(text,timestamptz,text,timestamptz,date,date,date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.assessment_renewal_contact_plan(text,timestamptz,text,timestamptz,date,date,date)
  TO service_role;
REVOKE ALL ON FUNCTION eon_private.assessment_renewal_contact_plan_for(uuid,date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.assessment_renewal_contact_plan_for(uuid,date)
  TO service_role;
REVOKE ALL ON FUNCTION eon_private.guard_assessment_renewal_stage_columns()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION eon_private.ensure_communication_case(text,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.ensure_communication_case(text,uuid,text)
  TO service_role;
REVOKE ALL ON FUNCTION eon_private.communication_template_context(jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION eon_private.communication_template_context(jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION eon_private.communication_case_suggestion(public.communication_cases,jsonb,jsonb,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION eon_private.communication_case_suggestion(public.communication_cases,jsonb,jsonb,jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public.apply_communication_case_action(uuid,jsonb,text,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_communication_case_action(uuid,jsonb,text,uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.transition_assessment_renewal_stage(
  uuid, text, timestamptz, text, uuid, text, date, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_assessment_renewal_stage(
  uuid, text, timestamptz, text, uuid, text, date, text, text
) TO service_role;

-- Os casos de renovação abertos voltam à fila na data do passo da régua.
SELECT eon_private.ensure_communication_case('contract', c.source_id, 'renewal')
FROM public.communication_cases c
WHERE c.purpose = 'renewal' AND c.status = 'open' AND c.source_type = 'contract';

COMMIT;
