BEGIN;
SET LOCAL lock_timeout = '5s';

-- Quadro de Prospects (docs/fluxos-de-mensagens.md, seção 2):
-- 1. Os textos da proposta saem do código e viram modelos da jornada
--    "Propostas" em Modelos e regras: primeiro contato (cadastro novo e
--    ex-aluno), lembrete, encerramento sem link, envio do link (três aberturas),
--    lembrete de pagamento e encerramento com link. O marco só identifica o
--    texto; o relógio continua no quadro. Os textos iniciais são os de hoje.
-- 2. Um prospect arquivado como não convertido pode ser retomado: volta para
--    "Tirando dúvidas" com o relógio de hoje e o histórico preservado. O link
--    antigo (já cancelado no arquivamento) fica só no histórico.
-- Nada aqui cria, altera ou cancela cobranças.

ALTER TABLE public.communication_rules
  DROP CONSTRAINT communication_rules_journey_check,
  ADD CONSTRAINT communication_rules_journey_check CHECK (journey IN (
    'billing','onboarding','renewal','reactivation','proposal'));
ALTER TABLE public.communication_rules
  DROP CONSTRAINT communication_rules_task_kind_check,
  ADD CONSTRAINT communication_rules_task_kind_check CHECK (task_kind IN (
    'charge_send','charge_overdue','onboarding_welcome','onboarding_checkin',
    'onboarding_feedback','renewal_reminder','reactivation',
    'prospect_contact','prospect_proposal'));

INSERT INTO public.communication_rules
  (slug,name,journey,trigger_event,task_kind,days_offset,channel,message_template,active,order_index)
VALUES
  ('proposal-first-contact', 'Proposta · primeiro contato (cadastro novo)', 'proposal', 'manual', 'prospect_contact', 0, 'whatsapp',
   $tpl$Olá, {nome}! Tudo bem?

Aqui é da Endurance ON! Recebemos seu interesse em treinar{modalidade_texto} com a gente{plano_texto}{coach_texto}. 🙌

Quer seguir com a contratação? Se preferir tirar alguma dúvida antes, sobre os treinos, o plano ou o dia a dia da assessoria, é só me falar que eu te ajudo!$tpl$,
   true, 70),
  ('proposal-first-contact-returning', 'Proposta · primeiro contato (ex-aluno)', 'proposal', 'manual', 'prospect_contact', 1, 'whatsapp',
   $tpl$Olá, {nome}! Tudo bem?

Aqui é da Endurance ON! Que bom ver você de volta! Recebemos seu interesse em voltar a treinar{modalidade_texto} com a gente{plano_texto}{coach_texto}. 🙌

Quer seguir com a contratação? Se preferir tirar alguma dúvida antes, sobre os treinos, o plano ou o dia a dia da assessoria, é só me falar que eu te ajudo!$tpl$,
   true, 71),
  ('proposal-follow-up', 'Proposta · lembrete do dia 2', 'proposal', 'manual', 'prospect_contact', 2, 'whatsapp',
   $tpl$Oi, {nome}! Tudo bem?

Se ajudar na decisão, posso te explicar como funcionam as primeiras semanas {com_coach} ou tirar qualquer dúvida por aqui, por áudio ou numa ligação rápida, como for melhor para você.

Quer seguir com a contratação?$tpl$,
   true, 72),
  ('proposal-closing', 'Proposta · encerramento sem link', 'proposal', 'manual', 'prospect_contact', 5, 'whatsapp',
   $tpl$Oi, {nome}! Tudo bem?

Como não consegui falar com você, imagino que agora não seja o melhor momento. Vou arquivar sua proposta por aqui para não ficar te mandando mensagem.

Se quiser treinar com a gente mais para frente, é só me chamar. Vai ser um prazer te receber na Endurance ON! 🙌$tpl$,
   true, 73),
  ('proposal-send-after-contact', 'Proposta · envio do link (depois da conversa)', 'proposal', 'manual', 'prospect_proposal', 10, 'whatsapp',
   $tpl$Olá, {nome}! 👋

Que bom que você quer seguir! Sua proposta está pronta:

{resumo_proposta}

Para confirmar sua vaga, faça o pagamento pelo link:
🔗 {link_pagamento}

Assim que o pagamento for confirmado, {o_coach} entrará em contato para iniciar seu atendimento. 🏆$tpl$,
   true, 74),
  ('proposal-send-new', 'Proposta · envio do link (cadastro sem conversa)', 'proposal', 'manual', 'prospect_proposal', 11, 'whatsapp',
   $tpl$Olá, {nome}! 👋

Recebemos seu cadastro para treinar com a *Endurance On*. Sua proposta está pronta:

{resumo_proposta}

Para confirmar sua vaga, faça o pagamento pelo link:
🔗 {link_pagamento}

Assim que o pagamento for confirmado, {o_coach} entrará em contato para iniciar seu atendimento. 🏆$tpl$,
   true, 75),
  ('proposal-send-returning', 'Proposta · envio do link (ex-aluno sem conversa)', 'proposal', 'manual', 'prospect_proposal', 12, 'whatsapp',
   $tpl$Olá, {nome}! 👋

Que bom ter você de volta à *Endurance On*! Sua nova proposta está pronta:

{resumo_proposta}

Para confirmar sua vaga, faça o pagamento pelo link:
🔗 {link_pagamento}

Assim que o pagamento for confirmado, {o_coach} entrará em contato para iniciar seu atendimento. 🏆$tpl$,
   true, 76),
  ('proposal-payment-reminder', 'Proposta · lembrete de pagamento', 'proposal', 'manual', 'prospect_proposal', 20, 'whatsapp',
   $tpl$Olá, {nome}! 👋

Passando só para lembrar que sua proposta para treinar com a *Endurance On* ficou reservada e o pagamento ainda está em aberto.

{resumo_proposta}

Para confirmar sua vaga, é só finalizar pelo link abaixo:
🔗 {link_pagamento}

Assim que o pagamento for confirmado, {o_coach} entra em contato para dar início ao atendimento. Se você já fez o pagamento, pode desconsiderar esta mensagem. Qualquer dúvida, me chama por aqui.$tpl$,
   true, 77),
  ('proposal-payment-closing', 'Proposta · encerramento com link', 'proposal', 'manual', 'prospect_proposal', 25, 'whatsapp',
   $tpl$Oi, {nome}! Tudo bem?

Como o pagamento da sua proposta ainda não foi concluído, imagino que agora não seja o melhor momento. Vou deixar o link ativo até {prazo_link}; depois disso, arquivo a proposta por aqui.

{link_bloco}Se você já fez o pagamento, pode desconsiderar esta mensagem. E se quiser retomar mais para frente, é só me chamar. 🙌$tpl$,
   true, 78)
ON CONFLICT (slug) DO NOTHING;

-- Dados fictícios da simulação dos textos da proposta (as mesmas variáveis do
-- quadro, src/lib/prospect-messages.js).
CREATE OR REPLACE FUNCTION eon_private.prospect_message_sample_context(p_scenario text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_due date := (now() AT TIME ZONE 'America/Sao_Paulo')::date + 1;
  v_deadline date := (now() AT TIME ZONE 'America/Sao_Paulo')::date + 2;
  v_bare boolean := p_scenario = 'no_coach';
  v_split boolean := p_scenario = 'installments';
  v_modality text := CASE WHEN p_scenario = 'no_coach' THEN '' ELSE 'Corrida' END;
  v_coach text := CASE WHEN p_scenario = 'no_coach' THEN '' ELSE 'Treinador Exemplo' END;
  v_plan text := 'Plano trimestral de exemplo';
  v_total numeric := CASE WHEN p_scenario = 'installments' THEN 900 ELSE 450 END;
  v_count integer := CASE WHEN p_scenario = 'installments' THEN 3 ELSE 1 END;
  v_fee numeric := CASE WHEN p_scenario = 'installments' THEN 100 ELSE 0 END;
  v_link text := 'https://example.invalid/pagamento';
  v_weekdays text[] := ARRAY['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
BEGIN
  RETURN jsonb_build_object(
    'nome', 'Marina',
    'modalidade', v_modality,
    'plano', v_plan,
    'coach', v_coach,
    'modalidade_texto', CASE WHEN v_bare THEN '' ELSE ' *' || v_modality || '*' END,
    'plano_texto', ', no plano *' || v_plan || '*',
    'coach_texto', CASE WHEN v_bare THEN '' ELSE ', com acompanhamento de *' || v_coach || '*' END,
    'com_coach', CASE WHEN v_bare THEN 'na assessoria' ELSE 'com *' || v_coach || '*' END,
    'o_coach', CASE WHEN v_bare THEN 'o coach escolhido' ELSE 'o coach *' || v_coach || '*' END,
    'resumo_proposta', concat_ws(E'\n',
      CASE WHEN v_bare THEN NULL ELSE '🏃 Modalidade: *' || v_modality || '*' END,
      '📅 Plano: *' || v_plan || '* (3 meses)',
      CASE WHEN v_bare THEN NULL ELSE '👤 Coach: *' || v_coach || '*' END,
      '💰 Total: *' || eon_private.prospect_message_money(v_total) || '*'
        || CASE WHEN v_split THEN ' em *' || v_count || 'x de ' || eon_private.prospect_message_money(v_total / v_count) || '*' ELSE '' END,
      CASE WHEN v_fee > 0 THEN '📌 Matrícula: ' || eon_private.prospect_message_money(v_fee) END,
      '⏰ Vencimento: *' || to_char(v_due, 'DD/MM/YYYY') || '*'),
    'valor', eon_private.prospect_message_money(v_total),
    'parcelas', v_count || 'x de ' || eon_private.prospect_message_money(v_total / v_count),
    'vencimento', to_char(v_due, 'DD/MM/YYYY'),
    'link_pagamento', v_link,
    'link_bloco', '🔗 ' || v_link || E'\n\n',
    'prazo_link', v_weekdays[extract(dow FROM v_deadline)::integer + 1] || ', ' || to_char(v_deadline, 'DD/MM')
  );
END;
$$;

CREATE OR REPLACE FUNCTION eon_private.prospect_message_money(p_value numeric)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT 'R$ ' || translate(to_char(round(COALESCE(p_value, 0), 2), 'FM999,999,990.00'), ',.', '.,');
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
        OR COALESCE(rule_data->>'journey','') NOT IN ('billing','onboarding','renewal','reactivation','proposal')
        OR COALESCE(rule_data->>'task_kind','') NOT IN ('charge_send','charge_overdue','onboarding_welcome','onboarding_checkin','onboarding_feedback','renewal_reminder','reactivation','prospect_contact','prospect_proposal')
        OR COALESCE(rule_data->>'trigger_event','') NOT IN ('charge_created','charge_due_date','payment_confirmed','onboarding_welcome_sent','contract_end_date','manual')
        OR COALESCE(rule_data->>'slug','') !~ '^[a-z0-9][a-z0-9-]{1,119}$'
        OR jsonb_typeof(rule_data->'active') IS DISTINCT FROM 'boolean'
        OR COALESCE(rule_data->>'channel','whatsapp') <> 'whatsapp'
        OR COALESCE(rule_data->>'days_offset','0') !~ '^-?[0-9]{1,4}$'
        OR COALESCE(rule_data->>'order_index','0') !~ '^-?[0-9]{1,6}$' THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Modelo inválido';
      END IF;
      -- Textos da proposta só existem na jornada Propostas, e ela só tem esses.
      IF (rule_data->>'journey'='proposal') IS DISTINCT FROM (rule_data->>'task_kind' IN ('prospect_contact','prospect_proposal'))
        OR (rule_data->>'journey'='proposal' AND rule_data->>'trigger_event'<>'manual') THEN
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
    -- Propostas: o texto é copiado no quadro de Prospects; não há caso nem
    -- régua. A simulação só mostra o texto com dados fictícios e bloqueia
    -- variável que o quadro não conhece.
    IF d.rule->>'journey'='proposal' THEN
      SELECT count(*) INTO affected FROM public.assessment_contracts c
      WHERE c.status='draft' AND c.parent_contract_id IS NULL
        AND c.prospect_stage IN ('new','awaiting_reply','clarifying','proposal_ready','payment_link_sent');
      FOR sample IN SELECT value FROM jsonb_array_elements('[
        {"label":"Prospect com modalidade, plano e coach · pessoa fictícia","scenario":"complete"},
        {"label":"Sem modalidade e sem coach definidos","scenario":"no_coach"},
        {"label":"Parcelado e com matrícula","scenario":"installments"}
      ]'::jsonb) LOOP
        message:=public.render_communication_template(COALESCE(d.rule->>'message_template',''),
          eon_private.prospect_message_sample_context(sample->>'scenario'));
        IF message ~ '\{[^{}]+\}' THEN draft_valid:=false; END IF;
        examples:=examples || jsonb_build_array(jsonb_build_object(
          'label',sample->>'label','scenario',sample->>'scenario','message',btrim(message),
          'expected_action','Texto disponível no quadro de Prospects para copiar',
          'blocked_reason',NULL,'eligible_at',NULL,
          'selected_rule_slug',d.rule->>'slug','draft_selected',true));
      END LOOP;
      IF NOT draft_valid THEN
        warnings:=warnings || jsonb_build_array('O texto contém variável desconhecida ou não resolvida. Corrija antes de publicar.');
      END IF;
      IF d.rule_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.communication_rules old_rule
        WHERE old_rule.id=d.rule_id AND (old_rule.days_offset IS DISTINCT FROM (d.rule->>'days_offset')::integer OR (d.rule->>'active')::boolean=false)
        AND NOT EXISTS(SELECT 1 FROM public.communication_rules alternative WHERE alternative.active AND alternative.id<>old_rule.id
          AND alternative.journey=old_rule.journey AND alternative.task_kind=old_rule.task_kind AND alternative.trigger_event=old_rule.trigger_event AND alternative.days_offset=old_rule.days_offset)) THEN
        warnings:=warnings || jsonb_build_array('Sem outro modelo ativo neste passo, o quadro de Prospects volta a usar o texto padrão.');
      END IF;
      fingerprint := md5(d.id::text || COALESCE(d.rule::text,'') || clock_timestamp()::text);
      result := jsonb_build_object('draft_id',d.id,'can_publish',draft_valid,'scenarios',examples,
        'affected_open_cases',affected,'affected_label','Prospects em negociação','warnings',warnings,
        'simulation_fingerprint',fingerprint,
        'scope_note','O texto vale para as próximas mensagens copiadas no quadro de Prospects. Nada é enviado sozinho.');
      UPDATE public.communication_model_drafts SET simulation=result,simulation_fingerprint=fingerprint,
        simulated_at=now(),simulated_by=p_actor_id WHERE id=d.id;
      RETURN result;
    END IF;
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

REVOKE ALL ON FUNCTION public.communication_model_command(text,uuid,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.communication_model_command(text,uuid,jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION eon_private.prospect_message_sample_context(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION eon_private.prospect_message_money(numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.prospect_message_sample_context(text) TO service_role;
GRANT EXECUTE ON FUNCTION eon_private.prospect_message_money(numeric) TO service_role;

-- Retomar um prospect arquivado -----------------------------------------------

ALTER TABLE public.assessment_contracts
  ADD COLUMN IF NOT EXISTS prospect_reopened_at timestamptz;
COMMENT ON COLUMN public.assessment_contracts.prospect_reopened_at IS
  'Última vez que o prospect arquivado como não convertido foi retomado no quadro.';

CREATE OR REPLACE FUNCTION public.reopen_assessment_prospect(
  p_contract_id uuid,
  p_expected_updated_at timestamptz,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_other public.assessment_contracts%ROWTYPE;
  v_now timestamptz := now();
  v_history jsonb;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Operador obrigatório';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Prospect não encontrado';
  END IF;
  IF v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O prospect foi alterado. Atualize a página e tente novamente';
  END IF;
  IF v_contract.parent_contract_id IS NOT NULL
     OR v_contract.prospect_stage IS DISTINCT FROM 'lost'
     OR v_contract.status <> 'voided'
     OR v_contract.customer_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Só um prospect arquivado como não convertido pode ser retomado';
  END IF;
  IF v_contract.payment_status IS DISTINCT FROM 'cancelled'
     OR coalesce(v_contract.manual_payment, false)
     OR v_contract.payment_date IS NOT NULL
     OR nullif(v_contract.asaas_charge_id, '') IS NOT NULL
     OR nullif(v_contract.asaas_payment_link, '') IS NOT NULL
     OR nullif(v_contract.asaas_pix_copy, '') IS NOT NULL
     OR coalesce(v_contract.refund_amount, 0) <> 0
     OR v_contract.refund_status IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este prospect tem movimentação financeira e não pode ser retomado aqui';
  END IF;

  -- Mesmo bloqueio do cadastro manual e do formulário: uma negociação aberta
  -- por pessoa.
  PERFORM 1 FROM public.presale_customers WHERE id = v_contract.customer_id FOR UPDATE;
  SELECT * INTO v_other
  FROM public.assessment_contracts
  WHERE customer_id = v_contract.customer_id
    AND id <> v_contract.id
    AND parent_contract_id IS NULL
    AND status = 'draft'
  ORDER BY created_at DESC
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = format(
      'Esta pessoa já tem outra proposta aberta (%s). Continue por ela.',
      coalesce(v_other.contract_number, 'sem número'));
  END IF;
  SELECT * INTO v_other
  FROM public.assessment_contracts
  WHERE customer_id = v_contract.customer_id
    AND id <> v_contract.id
    AND created_at > v_contract.created_at
    AND status IN ('active', 'scheduled', 'overdue', 'on_leave')
  ORDER BY created_at DESC
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = format(
      'Esta pessoa já virou aluna depois desta proposta (%s).',
      coalesce(v_other.contract_number, 'sem número'));
  END IF;

  v_history := jsonb_build_object(
    'stage_before', 'lost',
    'stage_after', 'clarifying',
    'lost_at', v_contract.prospect_lost_at,
    'loss_reason_code', v_contract.prospect_loss_reason_code,
    'loss_notes', v_contract.prospect_loss_notes,
    'previous_external_payment_link', nullif(v_contract.external_payment_link, ''),
    'previous_due_date', v_contract.due_date,
    'reopened_at', v_now
  );

  UPDATE public.assessment_contracts
  SET status = 'draft',
      payment_status = 'pending',
      prospect_stage = 'clarifying',
      prospect_last_contact_at = v_now,
      prospect_followup_sent_at = NULL,
      prospect_lost_at = NULL,
      prospect_loss_reason_code = NULL,
      prospect_loss_notes = NULL,
      prospect_proposal_ready_at = NULL,
      prospect_message_sent_at = NULL,
      payment_message_sent_at = NULL,
      prospect_payment_reminder_sent_at = NULL,
      prospect_closing_sent_at = NULL,
      prospect_close_deadline = NULL,
      external_payment_link = NULL,
      prospect_reopened_at = v_now,
      updated_at = v_now
  WHERE id = v_contract.id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    v_contract.id,
    'prospect_reopened',
    v_history,
    'Prospect retomado depois do arquivamento',
    p_actor_id
  );

  RETURN jsonb_build_object('contract', to_jsonb(v_contract));
END;
$$;

REVOKE ALL ON FUNCTION public.reopen_assessment_prospect(uuid, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_assessment_prospect(uuid, timestamptz, uuid)
  TO service_role;
COMMENT ON FUNCTION public.reopen_assessment_prospect(uuid, timestamptz, uuid) IS
  'Devolve ao quadro (em Tirando dúvidas) um prospect arquivado como não convertido, sem movimentação financeira. Não cria nem cancela cobranças.';

COMMIT;
