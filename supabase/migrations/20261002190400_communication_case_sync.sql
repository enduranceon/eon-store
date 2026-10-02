-- Migration deliberately does not backfill legacy obligations. Administrators
-- inspect the read-only preview, then run bounded source-specific batches.
CREATE OR REPLACE FUNCTION public.preview_communication_case_sync(
  p_source_type text DEFAULT NULL,p_limit integer DEFAULT 20
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_result jsonb;
BEGIN
  IF (p_source_type IS NOT NULL AND p_source_type NOT IN ('contract','presale','stock','event'))
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Filtro de prévia inválido';
  END IF;
  WITH sources AS (
    SELECT 'contract'::text source_type,id source_id FROM public.assessment_contracts
      WHERE p_source_type IS NULL OR p_source_type='contract'
    UNION ALL SELECT 'presale',id FROM public.presale_orders
      WHERE p_source_type IS NULL OR p_source_type='presale'
    UNION ALL SELECT 'stock',id FROM public.stock_orders
      WHERE p_source_type IS NULL OR p_source_type='stock'
    UNION ALL SELECT 'event',id FROM public.event_registrations
      WHERE p_source_type IS NULL OR p_source_type='event'
  ), contexts AS (
    SELECT s.source_type,s.source_id,
      eon_private.communication_source_context(s.source_type,s.source_id) AS context
    FROM sources s
  ), candidates AS (
    SELECT c.source_type,c.source_id,p.purpose,
      CASE WHEN p.purpose='billing' THEN eon_private.communication_obligation_key(c.context)
        WHEN p.purpose='renewal' THEN 'renewal' ELSE 'welcome' END obligation_key
    FROM contexts c CROSS JOIN (VALUES('billing'),('renewal'),('onboarding')) p(purpose)
    WHERE (p.purpose='billing' AND c.context->>'payment_status' IN
      ('pending','awaiting_charge','charge_sent','overdue','partially_paid')
      AND (c.source_type<>'contract'
        OR c.context->>'parent_contract_id' IS NULL
        OR COALESCE(c.context->>'renewal_stage','') NOT IN
          ('contact_pending','waiting_response','charge_pending'))
      AND (c.context->>'balance' IS NULL OR (c.context->>'balance')::numeric>0))
      OR (p.purpose='renewal' AND c.source_type='contract'
        AND c.context->>'parent_contract_id' IS NOT NULL
        AND c.context->>'renewal_stage' IN ('contact_pending','waiting_response'))
      OR (p.purpose='onboarding' AND c.source_type='contract'
        AND c.context->>'parent_contract_id' IS NULL
        AND c.context->>'payment_status'='paid'
        AND c.context->>'source_status' IN ('active','scheduled','on_leave')
        AND NOT EXISTS(SELECT 1 FROM public.assessment_contract_event e
          WHERE e.contract_id=c.source_id AND e.event_type='onboarding_checkin_sent'))
  ), missing AS (
    SELECT a.* FROM candidates a LEFT JOIN public.communication_cases x
      ON x.source_type=a.source_type AND x.source_id=a.source_id
      AND x.purpose=a.purpose AND x.obligation_key=a.obligation_key
      AND x.status='open'
    WHERE x.id IS NULL
  )
  SELECT jsonb_build_object(
    'eligible', (SELECT count(*) FROM candidates),
    'missing', (SELECT count(*) FROM missing),
    'sample', COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM (
      SELECT source_type,source_id,purpose,obligation_key FROM missing
      ORDER BY source_type,source_id,purpose LIMIT p_limit
    ) s),'[]'::jsonb),
    'read_only',true,'as_of',now()
  ) INTO v_result;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_communication_cases(
  p_source_type text,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 100
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_row record;
  v_count integer:=0;
  v_last uuid;
  v_more boolean;
BEGIN
  IF p_source_type NOT IN ('contract','presale','stock','event')
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Lote de sincronização inválido';
  END IF;
  FOR v_row IN
    SELECT id FROM (
      SELECT id FROM public.assessment_contracts WHERE p_source_type='contract'
      UNION ALL SELECT id FROM public.presale_orders WHERE p_source_type='presale'
      UNION ALL SELECT id FROM public.stock_orders WHERE p_source_type='stock'
      UNION ALL SELECT id FROM public.event_registrations WHERE p_source_type='event'
    ) s WHERE p_after IS NULL OR id>p_after
    ORDER BY id LIMIT p_limit
  LOOP
    PERFORM eon_private.lock_communication_source(p_source_type,v_row.id);
    PERFORM eon_private.ensure_communication_case(p_source_type,v_row.id,'billing');
    IF p_source_type='contract' THEN
      PERFORM eon_private.ensure_communication_case(p_source_type,v_row.id,'renewal');
      PERFORM eon_private.ensure_communication_case(p_source_type,v_row.id,'onboarding');
    END IF;
    v_last:=v_row.id;
    v_count:=v_count+1;
  END LOOP;
  SELECT EXISTS(
    SELECT 1 FROM (
      SELECT id FROM public.assessment_contracts WHERE p_source_type='contract'
      UNION ALL SELECT id FROM public.presale_orders WHERE p_source_type='presale'
      UNION ALL SELECT id FROM public.stock_orders WHERE p_source_type='stock'
      UNION ALL SELECT id FROM public.event_registrations WHERE p_source_type='event'
    ) s WHERE v_last IS NOT NULL AND id>v_last
  ) INTO v_more;
  RETURN jsonb_build_object('source_type',p_source_type,'processed',v_count,
    'next_cursor',CASE WHEN v_more THEN v_last END,'as_of',now());
END;
$$;

REVOKE ALL ON FUNCTION public.preview_communication_case_sync(text,integer),
  public.sync_communication_cases(text,uuid,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.preview_communication_case_sync(text,integer),
  public.sync_communication_cases(text,uuid,integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.set_communication_cases_rollout(
  p_enabled boolean,p_actor_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_preview jsonb;
  v_result jsonb;
BEGIN
  IF p_enabled IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Ativação inválida';
  END IF;
  PERFORM 1 FROM public.communication_settings WHERE key='cases_rollout' FOR UPDATE;
  IF p_enabled THEN
    v_preview:=public.preview_communication_case_sync(NULL,1);
    IF (v_preview->>'missing')::bigint<>0 THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='Sincronize todos os casos antes de ativar';
    END IF;
  END IF;
  UPDATE public.communication_settings SET
    value=jsonb_build_object('enabled',p_enabled,
      'enabled_at',CASE WHEN p_enabled THEN now() END,
      'enabled_by',CASE WHEN p_enabled THEN p_actor_id END,
      'disabled_at',CASE WHEN NOT p_enabled THEN now() END,
      'disabled_by',CASE WHEN NOT p_enabled THEN p_actor_id END),
    updated_at=now()
  WHERE key='cases_rollout' RETURNING value INTO v_result;
  RETURN v_result || jsonb_build_object('missing_cases',COALESCE((v_preview->>'missing')::bigint,0));
END;
$$;
REVOKE ALL ON FUNCTION public.set_communication_cases_rollout(boolean,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_communication_cases_rollout(boolean,uuid)
  TO service_role;
