-- Search communication history across open/resolved cases and legacy source
-- histories. This function only reads; no case is created by a history query.
CREATE INDEX communication_case_events_global_history_idx
  ON public.communication_case_events (created_at DESC, id DESC);
CREATE INDEX assessment_contract_event_global_history_idx
  ON public.assessment_contract_event (created_at DESC, id DESC);
CREATE INDEX sales_status_events_global_history_idx
  ON public.sales_status_events (created_at DESC, id DESC);

CREATE FUNCTION public.search_communication_history(
  p_customer_id uuid DEFAULT NULL,
  p_source_type text DEFAULT NULL,
  p_source_id uuid DEFAULT NULL,
  p_query text DEFAULT NULL,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_cursor text DEFAULT NULL,
  p_limit integer DEFAULT 30
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_query text := NULLIF(btrim(p_query), '');
  v_from timestamptz;
  v_until timestamptz;
  v_cursor jsonb;
  v_at timestamptz;
  v_identifier text;
  v_as_of timestamptz := now();
  v_scope text;
  v_result jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR length(COALESCE(v_query, '')) > 120
     OR (p_source_type IS NOT NULL AND p_source_type NOT IN ('contract','presale','stock','event'))
     OR (p_source_id IS NOT NULL AND p_source_type IS NULL)
     OR (p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Filtro de histórico inválido';
  END IF;
  -- Calendar dates are local to the EON operation, including DST boundaries.
  v_from := CASE WHEN p_from IS NULL THEN NULL
    ELSE p_from::timestamp AT TIME ZONE 'America/Sao_Paulo' END;
  v_until := CASE WHEN p_to IS NULL OR p_to = '9999-12-31'::date THEN NULL
    ELSE (p_to + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo' END;
  v_scope := md5(jsonb_build_object('customer_id',p_customer_id,
    'source_type',p_source_type,'source_id',p_source_id,
    'query',v_query,'from',p_from,'to',p_to)::text);
  IF p_cursor IS NOT NULL THEN
    BEGIN
      v_cursor := convert_from(decode(p_cursor,'base64'),'UTF8')::jsonb;
      v_at := (v_cursor->>'at')::timestamptz;
      v_identifier := v_cursor->>'identifier';
      v_as_of := (v_cursor->>'as_of')::timestamptz;
      IF v_at IS NULL OR v_identifier IS NULL OR v_as_of IS NULL
         OR v_cursor->>'scope' IS DISTINCT FROM v_scope
         OR v_identifier !~ '^(case|contract|sales):[0-9a-f-]{36}$' THEN
        RAISE EXCEPTION 'incomplete or mismatched cursor';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Cursor inválido';
    END;
  END IF;

  WITH raw AS MATERIALIZED (
    SELECT e.id, 'case:' || e.id::text AS event_identifier,
      'case'::text AS origin, e.case_id, c.source_type, c.source_id,
      e.event_type, e.created_at, e.actor_id, e.source_ui,
      e.message_text, e.response_code, e.notes, e.payload
    FROM public.communication_case_events e
    JOIN public.communication_cases c ON c.id=e.case_id
    WHERE e.created_at <= v_as_of
      AND (v_from IS NULL OR e.created_at >= v_from)
      AND (v_until IS NULL OR e.created_at < v_until)
      AND (p_source_type IS NULL OR c.source_type=p_source_type)
      AND (p_source_id IS NULL OR c.source_id=p_source_id)
    UNION ALL
    SELECT e.id, 'contract:' || e.id::text, 'contract_history',
      NULL::uuid, 'contract', e.contract_id, e.event_type, e.created_at,
      e.created_by, e.payload->>'source', e.payload->>'message',
      e.payload->>'response_code', e.notes,
      jsonb_strip_nulls(jsonb_build_object('action',e.payload->>'action',
        'stage_before',e.payload->>'stage_before',
        'stage_after',e.payload->>'stage_after',
        'follow_up_at',e.payload->>'follow_up_at'))
    FROM public.assessment_contract_event e
    WHERE e.event_type IN ('payment_message_sent','onboarding_welcome_sent',
      'onboarding_checkin_sent','renewal_message_sent','renewal_response_recorded',
      'renewal_follow_up_set','renewal_change_resolved','communication_task_ignored')
      AND e.created_at <= v_as_of
      AND (v_from IS NULL OR e.created_at >= v_from)
      AND (v_until IS NULL OR e.created_at < v_until)
      AND (p_source_type IS NULL OR p_source_type='contract')
      AND (p_source_id IS NULL OR e.contract_id=p_source_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.communication_case_events ce
        JOIN public.communication_cases cc ON cc.id=ce.case_id
        WHERE cc.source_type='contract' AND cc.source_id=e.contract_id
          AND ((e.payload->>'communication_case_id' IS NOT NULL
              AND ce.case_id::text=e.payload->>'communication_case_id')
            OR (e.payload->>'idempotency_key' IS NOT NULL
              AND ce.action_key=e.payload->>'idempotency_key'))
      )
    UNION ALL
    SELECT e.id, 'sales:' || e.id::text, 'sales_history',
      NULL::uuid, e.order_type, e.order_id,
      COALESCE(e.metadata->>'action','payment_message_sent'), e.created_at,
      e.actor_id, e.metadata->>'source', e.metadata->>'message',
      e.metadata->>'response_code', e.reason,
      jsonb_strip_nulls(jsonb_build_object('action',e.metadata->>'action',
        'previous_status',e.previous_status,'new_status',e.new_status))
    FROM public.sales_status_events e
    WHERE (e.metadata->>'action' IN ('charge_sent','charge_resent',
        'payment_message_sent','message_sent','communication_task_ignored')
      OR e.metadata->>'message' IS NOT NULL)
      AND e.created_at <= v_as_of
      AND (v_from IS NULL OR e.created_at >= v_from)
      AND (v_until IS NULL OR e.created_at < v_until)
      AND (p_source_type IS NULL OR e.order_type=p_source_type)
      AND (p_source_id IS NULL OR e.order_id=p_source_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.communication_case_events ce
        JOIN public.communication_cases cc ON cc.id=ce.case_id
        WHERE cc.source_type=e.order_type AND cc.source_id=e.order_id
          AND ((e.metadata->>'communication_case_id' IS NOT NULL
              AND ce.case_id::text=e.metadata->>'communication_case_id')
            OR (e.metadata->>'idempotency_key' IS NOT NULL
              AND ce.action_key=e.metadata->>'idempotency_key'))
      )
  ), enriched AS MATERIALIZED (
    SELECT raw.*, eon_private.communication_source_context(raw.source_type,raw.source_id) AS source_context
    FROM raw
    WHERE v_identifier IS NULL OR (raw.created_at,raw.event_identifier)<(v_at,v_identifier)
  ), filtered AS MATERIALIZED (
    SELECT id,event_identifier,origin,case_id,source_type,source_id,
      source_context->>'person_id' AS person_id, source_context->>'person_name' AS person_name,
      source_context->>'reference' AS reference, source_context->>'source_href' AS source_href,
      event_type,created_at,(created_at AT TIME ZONE 'America/Sao_Paulo')::date AS occurred_on,
      actor_id,source_ui,message_text,response_code,notes,payload
    FROM enriched
    WHERE (p_customer_id IS NULL OR source_context->>'person_id'=p_customer_id::text)
      AND (v_query IS NULL OR source_context->>'person_name' ILIKE '%' || v_query || '%'
        OR source_context->>'reference' ILIKE '%' || v_query || '%'
        OR message_text ILIKE '%' || v_query || '%'
        OR notes ILIKE '%' || v_query || '%')
  ), page AS (
    SELECT * FROM filtered ORDER BY created_at DESC,event_identifier DESC LIMIT p_limit+1
  ), shown AS (
    SELECT * FROM page ORDER BY created_at DESC,event_identifier DESC LIMIT p_limit
  )
  SELECT jsonb_build_object(
    'items',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.created_at DESC,s.event_identifier DESC)
      FROM shown s),'[]'::jsonb),
    'next_cursor',CASE WHEN (SELECT count(*) FROM page)>p_limit THEN
      (SELECT encode(convert_to(jsonb_build_object('at',created_at,
        'identifier',event_identifier,'as_of',v_as_of,'scope',v_scope)::text,
        'UTF8'),'base64') FROM shown
        ORDER BY created_at,event_identifier LIMIT 1) ELSE NULL END,
    'as_of',v_as_of
  ) INTO v_result;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.search_communication_history(
  uuid,text,uuid,text,date,date,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.search_communication_history(
  uuid,text,uuid,text,date,date,text,integer) TO service_role;
