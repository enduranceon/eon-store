-- Model editing is explicit: draft -> simulation -> publication. No backfill or
-- external message is executed by this migration.
CREATE TABLE public.communication_model_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL,
  rule_id uuid,
  base_version integer NOT NULL DEFAULT 0,
  base_policy_version integer,
  rule jsonb,
  policy jsonb,
  simulation jsonb,
  simulation_fingerprint text,
  simulated_at timestamptz,
  simulated_by uuid,
  published_at timestamptz,
  published_by uuid,
  publication_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (rule IS NOT NULL OR policy IS NOT NULL)
);
ALTER TABLE public.communication_model_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.communication_model_drafts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.communication_model_drafts TO service_role;
CREATE INDEX communication_drafts_unpublished_idx ON public.communication_model_drafts (created_at DESC, id)
  WHERE published_at IS NULL;
REVOKE INSERT, UPDATE, DELETE ON public.communication_rules FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.communication_rules TO service_role;
GRANT SELECT, UPDATE ON public.communication_cadence_policies TO service_role;

INSERT INTO public.communication_rules
  (slug,name,journey,trigger_event,task_kind,days_offset,message_template,active,order_index)
VALUES
  ('billing-charge-overdue-5d','Pagamento pendente · D+5','billing','charge_due_date','charge_overdue',5,
   E'Oi, {nome}! Passando para lembrar do saldo de {valor} referente a {numero}, com vencimento em {vencimento}.\n{link_bloco}\nSe você já pagou ou precisa conversar sobre o pagamento, me avise para conferirmos.',true,35),
  ('billing-charge-overdue-daily','Acompanhamento do saldo pendente','billing','charge_due_date','charge_overdue',8,
   E'Oi, {nome}! Ainda consta um saldo de {valor} referente a {numero}. Podemos confirmar como ficou o pagamento?\n{link_bloco}\nSe já pagou, envie a informação para a equipe conferir.',true,45),
  ('billing-pre-due-1d','Lembrete de pagamento · antes ou no vencimento','billing','charge_due_date','charge_send',-1,
   E'Oi, {nome}! Um lembrete do pagamento de {valor} referente a {numero}, que vence em {vencimento}.\n{link_bloco}\nQualquer dúvida, fale com a gente.',true,15),
  ('billing-pre-due-0d','Lembrete de pagamento · no vencimento','billing','charge_due_date','charge_send',0,
   E'Oi, {nome}! Um lembrete do pagamento de {valor} referente a {numero}, que vence hoje ({vencimento}).\n{link_bloco}\nQualquer dúvida, fale com a gente.',true,16)
ON CONFLICT (slug) DO NOTHING;

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
        OR COALESCE(rule_data->>'task_kind','') NOT IN ('charge_send','charge_overdue','onboarding_welcome','onboarding_checkin','renewal_reminder','reactivation')
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
        'onboarding_welcome_sent_at',CASE WHEN d.rule->>'task_kind'='onboarding_checkin' THEN (now()-interval '5 days')::text END,
        'plan_name','Plano trimestral de exemplo','period_months',3,'auto_renewal',false,'renewal_stage','contact_pending',
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
REVOKE ALL ON FUNCTION public.communication_model_command(text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.communication_model_command(text,uuid,jsonb) TO service_role;

-- Once published, the draft is an audit record with the actor and before/after.
CREATE TRIGGER communication_published_draft_immutable
  BEFORE UPDATE OR DELETE ON public.communication_model_drafts
  FOR EACH ROW WHEN (OLD.published_at IS NOT NULL)
  EXECUTE FUNCTION eon_private.reject_communication_history_change();
