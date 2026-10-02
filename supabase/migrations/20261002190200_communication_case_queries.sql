CREATE OR REPLACE FUNCTION public.get_communication_case(p_case_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_case public.communication_cases%ROWTYPE;
  v_context jsonb;
BEGIN
  SELECT * INTO v_case FROM public.communication_cases WHERE id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Acompanhamento não encontrado';
  END IF;
  v_context := eon_private.communication_source_context(v_case.source_type,v_case.source_id);
  RETURN jsonb_build_object(
    'case', eon_private.communication_case_projection(v_case),
    'suggestion', eon_private.communication_case_suggestion(v_case,v_context)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.list_communication_cases(
  p_state text DEFAULT NULL, p_purpose text DEFAULT NULL,
  p_source_type text DEFAULT NULL, p_source_id uuid DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL,
  p_query text DEFAULT NULL, p_cursor text DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_cursor jsonb;
  v_date date;
  v_id uuid;
  v_as_of timestamptz := now();
  v_result jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR (p_state IS NOT NULL AND p_state NOT IN ('to_do','following_up','scheduled','resolved','open'))
     OR (p_purpose IS NOT NULL AND p_purpose NOT IN ('billing','onboarding','renewal'))
     OR (p_source_type IS NOT NULL AND p_source_type NOT IN ('contract','presale','stock','event'))
     OR length(COALESCE(p_query,'')) > 120 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Filtro de acompanhamentos inválido';
  END IF;
  IF p_cursor IS NOT NULL THEN
    BEGIN
      v_cursor := convert_from(decode(p_cursor,'base64'),'UTF8')::jsonb;
      v_date := (v_cursor->>'date')::date;
      v_id := (v_cursor->>'id')::uuid;
      v_as_of := (v_cursor->>'as_of')::timestamptz;
      IF v_date IS NULL OR v_id IS NULL OR v_as_of IS NULL THEN
        RAISE EXCEPTION 'incomplete cursor';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Cursor inválido';
    END;
  END IF;
  WITH projected AS MATERIALIZED (
    SELECT c.id, c.created_at,
      eon_private.communication_case_projection(c) AS body
    FROM public.communication_cases c
    WHERE c.created_at <= v_as_of
      AND (p_purpose IS NULL OR c.purpose = p_purpose)
      AND (p_source_type IS NULL OR c.source_type = p_source_type)
      AND (p_source_id IS NULL OR c.source_id = p_source_id)
      AND (p_customer_id IS NULL OR
        eon_private.communication_source_context(c.source_type,c.source_id)->>'person_id'
          = p_customer_id::text)
  ), filtered AS MATERIALIZED (
    SELECT id, body,
      COALESCE((body->>'next_action_at')::date, '9999-12-31'::date) AS sort_date
    FROM projected
    WHERE (p_query IS NULL OR p_query = ''
      OR body->>'person_name' ILIKE '%' || p_query || '%'
      OR body->>'reference' ILIKE '%' || p_query || '%')
  ), page AS (
    SELECT id, body, sort_date FROM filtered
    WHERE (p_state IS NULL OR body->>'workflow_stage' = p_state
      OR (p_state='open' AND body->>'workflow_stage'<>'resolved'))
      AND (v_id IS NULL OR (sort_date,id) > (v_date,v_id))
    ORDER BY sort_date,id LIMIT p_limit + 1
  ), shown AS (
    SELECT * FROM page ORDER BY sort_date,id LIMIT p_limit
  )
  SELECT jsonb_build_object(
    'items', COALESCE((SELECT jsonb_agg(body ORDER BY sort_date,id) FROM shown),'[]'::jsonb),
    'counts', jsonb_build_object(
      'to_do', count(*) FILTER (WHERE body->>'workflow_stage'='to_do'),
      'following_up', count(*) FILTER (WHERE body->>'workflow_stage'='following_up'),
      'scheduled', count(*) FILTER (WHERE body->>'workflow_stage'='scheduled'),
      'resolved', count(*) FILTER (WHERE body->>'workflow_stage'='resolved'),
      'open', count(*) FILTER (WHERE body->>'workflow_stage'<>'resolved')
    ),
    'next_cursor', CASE WHEN (SELECT count(*) FROM page) > p_limit THEN
      (SELECT encode(convert_to(jsonb_build_object(
        'date', sort_date, 'id', id, 'as_of', v_as_of)::text,'UTF8'),'base64')
       FROM shown ORDER BY sort_date DESC,id DESC LIMIT 1)
      ELSE NULL END,
    'as_of', v_as_of,
    'rollout',jsonb_build_object('enabled',eon_private.communication_cases_rollout_enabled(),
      'missing_cases',NULL)
  ) INTO v_result FROM filtered;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_communication_case_events(
  p_case_id uuid, p_cursor text DEFAULT NULL, p_limit integer DEFAULT 30
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_cursor jsonb;
  v_at timestamptz;
  v_id uuid;
  v_result jsonb;
  v_case public.communication_cases%ROWTYPE;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Limite inválido';
  END IF;
  SELECT * INTO v_case FROM public.communication_cases WHERE id=p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Acompanhamento não encontrado';
  END IF;
  IF p_cursor IS NOT NULL THEN
    BEGIN
      v_cursor := convert_from(decode(p_cursor,'base64'),'UTF8')::jsonb;
      v_at := (v_cursor->>'at')::timestamptz;
      v_id := (v_cursor->>'id')::uuid;
      IF v_at IS NULL OR v_id IS NULL THEN RAISE EXCEPTION 'incomplete cursor'; END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Cursor inválido';
    END;
  END IF;
  WITH combined AS (
    SELECT e.id,e.created_at,
      to_jsonb(e) || jsonb_build_object('origin','case') AS body
    FROM public.communication_case_events e WHERE e.case_id=p_case_id
    UNION ALL
    SELECT e.id,e.created_at,
      jsonb_build_object('id',e.id,'case_id',p_case_id,'origin','contract_history',
        'event_type',e.event_type,'actor_id',e.created_by,'created_at',e.created_at,
        'message_text',e.payload->>'message','response_code',e.payload->>'response_code',
        'notes',e.notes,'payload',jsonb_build_object('action',e.payload->>'action',
          'stage_before',e.payload->>'stage_before','stage_after',e.payload->>'stage_after',
          'follow_up_at',e.payload->>'follow_up_at'))
    FROM public.assessment_contract_event e
    WHERE v_case.source_type='contract' AND e.contract_id=v_case.source_id
      AND e.payload->>'communication_case_id' IS DISTINCT FROM p_case_id::text
      AND NOT EXISTS(SELECT 1 FROM public.communication_case_events ce
        WHERE ce.case_id=p_case_id AND ce.action_key=e.payload->>'idempotency_key')
    UNION ALL
    SELECT e.id,e.created_at,
      jsonb_build_object('id',e.id,'case_id',p_case_id,'origin','sales_history',
        'event_type',COALESCE(e.metadata->>'action','sales_status_changed'),
        'actor_id',e.actor_id,'created_at',e.created_at,
        'message_text',e.metadata->>'message','notes',e.reason,
        'payload',jsonb_build_object('previous_status',e.previous_status,
          'new_status',e.new_status))
    FROM public.sales_status_events e
    WHERE v_case.source_type<>'contract' AND e.order_type=v_case.source_type
      AND e.order_id=v_case.source_id
      AND e.metadata->>'communication_case_id' IS DISTINCT FROM p_case_id::text
  ), page AS (
    SELECT * FROM combined
    WHERE v_id IS NULL OR (created_at,id)<(v_at,v_id)
    ORDER BY created_at DESC,id DESC LIMIT p_limit+1
  ), shown AS (
    SELECT * FROM page ORDER BY created_at DESC,id DESC LIMIT p_limit
  )
  SELECT jsonb_build_object(
    'items',COALESCE((SELECT jsonb_agg(body ORDER BY created_at DESC,id DESC)
      FROM shown),'[]'::jsonb),
    'next_cursor',CASE WHEN (SELECT count(*) FROM page)>p_limit THEN
      (SELECT encode(convert_to(jsonb_build_object('at',created_at,'id',id)::text,'UTF8'),'base64')
       FROM shown ORDER BY created_at,id LIMIT 1) ELSE NULL END
  ) INTO v_result;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION eon_private.lock_communication_source(
  p_source_type text,p_source_id uuid
)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_found uuid;v_customer_id uuid;
BEGIN
  IF p_source_type='contract' THEN
    SELECT id,customer_id INTO v_found,v_customer_id
      FROM public.assessment_contracts WHERE id=p_source_id FOR UPDATE;
  ELSIF p_source_type='presale' THEN
    SELECT id INTO v_found FROM public.presale_orders WHERE id=p_source_id FOR UPDATE;
  ELSIF p_source_type='stock' THEN
    SELECT id INTO v_found FROM public.stock_orders WHERE id=p_source_id FOR UPDATE;
  ELSIF p_source_type='event' THEN
    SELECT id,customer_id INTO v_found,v_customer_id
      FROM public.event_registrations WHERE id=p_source_id FOR UPDATE;
  ELSE
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Origem inválida';
  END IF;
  IF v_found IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Origem não encontrada';
  END IF;
  IF v_customer_id IS NOT NULL THEN
    -- Customer edits/merges cannot change the recipient between revalidation
    -- and the immutable contact event. NOWAIT fails fast instead of deadlocking
    -- with older customer-first operations.
    PERFORM 1 FROM public.presale_customers WHERE id=v_customer_id FOR SHARE NOWAIT;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_communication_case(
  p_source_type text,p_source_id uuid,p_purpose text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT eon_private.communication_cases_rollout_enabled() THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='Central de casos ainda não ativada';
  END IF;
  PERFORM eon_private.lock_communication_source(p_source_type,p_source_id);
  v_id := eon_private.ensure_communication_case(p_source_type,p_source_id,p_purpose);
  IF v_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='A origem não tem acompanhamento aberto nesta finalidade';
  END IF;
  RETURN public.get_communication_case(v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.get_communication_case(uuid),
  public.list_communication_cases(text,text,text,uuid,uuid,text,text,integer),
  public.list_communication_case_events(uuid,text,integer),
  public.prepare_communication_case(text,uuid,text),
  eon_private.lock_communication_source(text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_communication_case(uuid),
  public.list_communication_cases(text,text,text,uuid,uuid,text,text,integer),
  public.list_communication_case_events(uuid,text,integer),
  public.prepare_communication_case(text,uuid,text),
  eon_private.lock_communication_source(text,uuid)
  TO service_role;
