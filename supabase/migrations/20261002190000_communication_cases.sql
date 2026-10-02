-- One contact case per source obligation and purpose. Financial balances,
-- payments and renewal stages remain owned by their existing tables.
CREATE TABLE public.communication_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL CHECK (source_type IN ('contract', 'presale', 'stock', 'event')),
  source_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('billing', 'onboarding', 'renewal')),
  obligation_key text NOT NULL CHECK (length(obligation_key) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  hold_kind text NOT NULL DEFAULT 'none' CHECK (hold_kind IN ('none', 'contact_wait', 'explicit_schedule')),
  next_action_at date,
  blocked_reason text,
  last_contact_at timestamptz,
  assignee_id uuid,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  resolved_at timestamptz,
  resolution_reason text,
  superseded_by_case_id uuid REFERENCES public.communication_cases(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, purpose, obligation_key),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CHECK (status = 'open' OR hold_kind = 'none')
);

CREATE INDEX communication_cases_queue_idx
  ON public.communication_cases (status, next_action_at, id);
CREATE INDEX communication_cases_source_idx
  ON public.communication_cases (source_type, source_id, purpose);

CREATE TABLE public.communication_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.communication_cases(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  action_key text,
  actor_id uuid,
  channel text,
  source_ui text,
  message_text text,
  response_code text,
  notes text,
  rule_slug text,
  rule_version integer,
  evidence_status text,
  contact_date date,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (channel IS NULL OR channel = 'whatsapp'),
  CHECK (evidence_status IS NULL OR evidence_status IN ('manual_recorded', 'external_unverified', 'provider_confirmed')),
  CHECK (message_text IS NULL OR length(message_text) <= 4000),
  CHECK (notes IS NULL OR length(notes) <= 1000)
);

CREATE INDEX communication_case_events_page_idx
  ON public.communication_case_events (case_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX communication_case_one_message_per_day_idx
  ON public.communication_case_events (case_id, contact_date)
  WHERE event_type = 'message_sent';

CREATE TABLE public.communication_case_commands (
  case_id uuid NOT NULL REFERENCES public.communication_cases(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,100}$'),
  request_hash text NOT NULL,
  request_payload jsonb NOT NULL,
  result jsonb NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, idempotency_key)
);

CREATE TABLE public.communication_rule_versions (
  rule_id uuid NOT NULL,
  rule_slug text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, version)
);

ALTER TABLE public.communication_rules
  ADD COLUMN IF NOT EXISTS template_version integer NOT NULL DEFAULT 1;

INSERT INTO public.communication_rule_versions (rule_id, rule_slug, version, snapshot, created_at)
SELECT id, slug, template_version, to_jsonb(r), updated_at
FROM public.communication_rules AS r
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION eon_private.version_communication_rule()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'updated_at' - 'template_version')
       IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'template_version') THEN
      NEW.template_version := OLD.template_version + 1;
    ELSE
      NEW.template_version := OLD.template_version;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION eon_private.log_communication_rule_version()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.communication_rule_versions (rule_id, rule_slug, version, snapshot)
    VALUES (NEW.id, NEW.slug, NEW.template_version, to_jsonb(NEW));
  ELSIF NEW.template_version IS DISTINCT FROM OLD.template_version THEN
    INSERT INTO public.communication_rule_versions (rule_id, rule_slug, version, snapshot)
    VALUES (NEW.id, NEW.slug, NEW.template_version, to_jsonb(NEW));
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER communication_rule_version_before
  BEFORE UPDATE ON public.communication_rules FOR EACH ROW
  EXECUTE FUNCTION eon_private.version_communication_rule();
CREATE TRIGGER communication_rule_version_after
  AFTER INSERT OR UPDATE ON public.communication_rules FOR EACH ROW
  EXECUTE FUNCTION eon_private.log_communication_rule_version();

CREATE TABLE public.communication_cadence_policies (
  slug text PRIMARY KEY,
  milestones integer[] NOT NULL,
  daily_after integer NOT NULL,
  recurrence_days integer NOT NULL,
  pre_due_enabled boolean NOT NULL DEFAULT false,
  pre_due_offset integer NOT NULL DEFAULT -1,
  pre_due_months integer[] NOT NULL DEFAULT ARRAY[3, 6],
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (slug = 'billing_overdue'),
  CHECK (milestones = ARRAY[3, 5, 7]),
  CHECK (daily_after = 7 AND recurrence_days = 1),
  CHECK (pre_due_offset IN (-1, 0))
);

INSERT INTO public.communication_cadence_policies
  (slug, milestones, daily_after, recurrence_days, pre_due_enabled, pre_due_offset, pre_due_months)
VALUES ('billing_overdue', ARRAY[3, 5, 7], 7, 1, false, -1, ARRAY[3, 6]);

-- Cases may be prepared by source triggers while the new queue is disabled.
-- Legacy contact entrypoints remain authoritative until explicit activation.
INSERT INTO public.communication_settings(key,value)
VALUES('cases_rollout',jsonb_build_object('enabled',false,'enabled_at',NULL,'enabled_by',NULL))
ON CONFLICT (key) DO NOTHING;
REVOKE INSERT,UPDATE,DELETE ON public.communication_settings FROM authenticated,anon;
GRANT SELECT ON public.communication_settings TO service_role;

CREATE OR REPLACE FUNCTION eon_private.protect_communication_cases_rollout()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  IF (CASE WHEN TG_OP='INSERT' THEN NEW.key='cases_rollout'
       WHEN TG_OP='DELETE' THEN OLD.key='cases_rollout'
       ELSE OLD.key='cases_rollout' OR NEW.key='cases_rollout' END)
     AND current_user NOT IN ('postgres','service_role') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Ativação dos casos exige operação administrativa';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER protect_communication_cases_rollout
  BEFORE INSERT OR UPDATE OR DELETE ON public.communication_settings
  FOR EACH ROW EXECUTE FUNCTION eon_private.protect_communication_cases_rollout();
REVOKE ALL ON FUNCTION eon_private.protect_communication_cases_rollout()
  FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION eon_private.communication_cases_rollout_enabled()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE((value->>'enabled')::boolean,false)
  FROM public.communication_settings WHERE key='cases_rollout';
$$;
REVOKE ALL ON FUNCTION eon_private.communication_cases_rollout_enabled()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION eon_private.communication_cases_rollout_enabled()
  TO service_role;

-- New contact history is append-only. The old domain histories are retained.
CREATE OR REPLACE FUNCTION eon_private.reject_communication_history_change()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'O histórico de comunicação é imutável';
END;
$$;
CREATE TRIGGER communication_case_events_immutable
  BEFORE UPDATE OR DELETE ON public.communication_case_events FOR EACH ROW
  EXECUTE FUNCTION eon_private.reject_communication_history_change();
CREATE TRIGGER communication_rule_versions_immutable
  BEFORE UPDATE OR DELETE ON public.communication_rule_versions FOR EACH ROW
  EXECUTE FUNCTION eon_private.reject_communication_history_change();

ALTER TABLE public.communication_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.communication_case_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.communication_case_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.communication_rule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.communication_cadence_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.communication_cases, public.communication_case_events,
  public.communication_case_commands, public.communication_rule_versions,
  public.communication_cadence_policies FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.communication_cases TO service_role;
GRANT SELECT, INSERT ON public.communication_case_events TO service_role;
GRANT SELECT, INSERT ON public.communication_case_commands TO service_role;
GRANT SELECT, INSERT ON public.communication_rule_versions TO service_role;
GRANT SELECT ON public.communication_cadence_policies TO service_role;

REVOKE ALL ON FUNCTION eon_private.version_communication_rule(),
  eon_private.log_communication_rule_version(),
  eon_private.reject_communication_history_change()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION eon_private.communication_open_balance(
  p_source_type text, p_source_id uuid, p_payment_status text, p_gross numeric
)
RETURNS numeric LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_unpaid numeric;
BEGIN
  IF p_payment_status IN ('paid', 'cancelled', 'refunded') THEN
    RETURN 0;
  END IF;
  IF p_payment_status IN ('partially_paid', 'partially_refunded') THEN
    SELECT sum(value) INTO v_unpaid
    FROM public.asaas_payments
    WHERE order_type = p_source_type AND order_id = p_source_id
      AND status IN ('PENDING', 'OVERDUE', 'DUNNING_REQUESTED');
    -- An unknown partial balance must be reviewed, never messaged as the full
    -- contract price.
    RETURN v_unpaid;
  END IF;
  RETURN p_gross;
END;
$$;

CREATE OR REPLACE FUNCTION eon_private.communication_source_context(
  p_source_type text, p_source_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_source_type = 'presale' THEN
    SELECT jsonb_build_object(
      'source_type', p_source_type, 'source_id', o.id,
      'person_id', o.customer_id,
      'person_name', COALESCE(NULLIF(o.checkout_name, ''), NULLIF(o.customer_name, ''), 'Cliente'),
      'contact_phone', COALESCE(NULLIF(o.checkout_whatsapp, ''), o.customer_whatsapp),
      'reference', o.order_number, 'source_href', '/pedidos/' || o.id::text,
      'payment_status', o.payment_status, 'source_status', o.status,
      'due_date', o.due_date, 'payment_message_sent_at', o.payment_message_sent_at,
      'source_updated_at', o.updated_date, 'payment_link', COALESCE(NULLIF(o.asaas_payment_link, ''), NULLIF(o.external_payment_link, '')),
      'pix_copy', NULLIF(o.asaas_pix_copy, ''), 'charge_id', NULLIF(o.asaas_charge_id, ''),
      'external_invoice_number', NULLIF(o.external_invoice_number, ''),
      'items', o.items,
      'balance', eon_private.communication_open_balance('presale', o.id, o.payment_status, COALESCE(o.total_value, o.total_amount, 0))
    ) INTO v_result
    FROM public.presale_orders o WHERE o.id = p_source_id;
  ELSIF p_source_type = 'stock' THEN
    SELECT jsonb_build_object(
      'source_type', p_source_type, 'source_id', o.id,
      'person_id', o.customer_id,
      'person_name', COALESCE(NULLIF(o.customer_name, ''), 'Cliente'),
      'contact_phone', o.customer_whatsapp,
      'reference', o.order_number, 'source_href', '/estoque/pedidos/' || o.id::text,
      'payment_status', o.payment_status, 'source_status', o.delivery_status,
      'due_date', o.due_date, 'payment_message_sent_at', o.payment_message_sent_at,
      'source_updated_at', o.updated_date, 'payment_link', COALESCE(NULLIF(o.asaas_payment_link, ''), NULLIF(o.external_payment_link, '')),
      'pix_copy', NULLIF(o.asaas_pix_copy, ''), 'charge_id', NULLIF(o.asaas_charge_id, ''),
      'external_invoice_number', NULLIF(o.external_invoice_number, ''),
      'items', o.items,
      'balance', eon_private.communication_open_balance('stock', o.id, o.payment_status, COALESCE(o.total_value, 0))
    ) INTO v_result
    FROM public.stock_orders o WHERE o.id = p_source_id;
  ELSIF p_source_type = 'contract' THEN
    SELECT jsonb_build_object(
      'source_type', p_source_type, 'source_id', c.id,
      'person_id', c.customer_id,
      'person_name', COALESCE(NULLIF(customer.full_name, ''), 'Aluno'),
      'contact_phone', customer.whatsapp,
      'reference', c.contract_number, 'source_href', '/assessoria/contratos/' || c.id::text,
      'payment_status', c.payment_status, 'source_status', c.status,
      'due_date', c.due_date, 'payment_message_sent_at', c.payment_message_sent_at,
      'source_updated_at', c.updated_at, 'payment_link', COALESCE(NULLIF(c.asaas_payment_link, ''), NULLIF(c.external_payment_link, '')),
      'pix_copy', NULLIF(c.asaas_pix_copy, ''), 'charge_id', NULLIF(c.asaas_charge_id, ''),
      'external_invoice_number', NULLIF(c.external_invoice_number, ''),
      'renewal_stage', c.renewal_stage, 'parent_contract_id', c.parent_contract_id,
      'auto_renewal', c.auto_renewal,
      'renewal_follow_up_at', c.renewal_follow_up_at,
      'renewal_last_contact_at', c.renewal_last_contact_at,
      'renewal_response_code', c.renewal_response_code,
      'renewal_response_at', c.renewal_response_at,
      'onboarding_welcome_sent_at', onboarding.welcome_at,
      'onboarding_checkin_sent_at', onboarding.checkin_at,
      'period_months', eon_private.assessment_contract_period_months(c.plan_id, c.plan_snapshot),
      'plan_name', COALESCE(NULLIF(c.plan_snapshot->>'name', ''), plan.name),
      'modality_name', modality.name,
      'coach_name', coach.name,
      'community_link', (SELECT NULLIF(value->>'url','') FROM public.communication_settings
        WHERE key='community_link'),
      'end_date', c.end_date,
      'balance', eon_private.communication_open_balance(
        'contract', c.id, c.payment_status,
        GREATEST(0::numeric,
          COALESCE(
            CASE WHEN COALESCE(c.plan_snapshot->>'price_total', '') ~ '^-?[0-9]+([.][0-9]+)?$'
              THEN (c.plan_snapshot->>'price_total')::numeric END,
            plan.price_total, 0
          ) + COALESCE(c.enrollment_fee, 0) - COALESCE(c.manual_discount, 0) - COALESCE(c.credit_balance, 0)
        )
      )
    ) INTO v_result
    FROM public.assessment_contracts c
    LEFT JOIN public.presale_customers customer ON customer.id = c.customer_id
    LEFT JOIN public.assessment_plans plan ON plan.id = c.plan_id
    LEFT JOIN public.assessment_modalities modality ON modality.id = plan.modality_id
    LEFT JOIN public.assessment_coaches coach ON coach.id = c.coach_id
    LEFT JOIN LATERAL (
      SELECT max(e.created_at) FILTER(WHERE e.event_type='onboarding_welcome_sent') AS welcome_at,
        max(e.created_at) FILTER(WHERE e.event_type='onboarding_checkin_sent') AS checkin_at
      FROM public.assessment_contract_event e WHERE e.contract_id=c.id
    ) onboarding ON true
    WHERE c.id = p_source_id;
  ELSIF p_source_type = 'event' THEN
    SELECT jsonb_build_object(
      'source_type', p_source_type, 'source_id', r.id,
      'person_id', r.customer_id,
      'person_name', COALESCE(NULLIF(customer.full_name, ''), 'Participante'),
      'contact_phone', customer.whatsapp,
      'reference', r.registration_number, 'source_href', '/eventos/' || r.event_id::text,
      'payment_status', r.payment_status, 'source_status', ev.status,
      'due_date', r.due_date, 'payment_message_sent_at', r.payment_message_sent_at,
      'source_updated_at', r.updated_at, 'payment_link', COALESCE(NULLIF(r.asaas_payment_link, ''), NULLIF(r.external_payment_link, '')),
      'pix_copy', NULLIF(r.asaas_pix_copy, ''), 'charge_id', NULLIF(r.asaas_charge_id, ''),
      'external_invoice_number', NULLIF(r.external_invoice_number, ''),
      'items', jsonb_build_array(jsonb_build_object('name',t.name,'quantity',1,'price',t.price)),
      'balance', eon_private.communication_open_balance('event', r.id, r.payment_status, COALESCE(t.price, 0))
    ) INTO v_result
    FROM public.event_registrations r
    JOIN public.events ev ON ev.id=r.event_id
    JOIN public.event_registration_types t ON t.id = r.registration_type_id
    LEFT JOIN public.presale_customers customer ON customer.id = r.customer_id
    WHERE r.id = p_source_id;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Origem de comunicação inválida';
  END IF;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION eon_private.communication_obligation_key(p_context jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT CASE
    WHEN NULLIF(p_context->>'charge_id', '') IS NOT NULL
      THEN 'charge:' || md5(p_context->>'charge_id')
    WHEN NULLIF(p_context->>'external_invoice_number', '') IS NOT NULL
      THEN 'invoice:' || md5(p_context->>'external_invoice_number')
    ELSE 'source'
  END;
$$;

REVOKE ALL ON FUNCTION eon_private.communication_open_balance(text,uuid,text,numeric),
  eon_private.communication_source_context(text,uuid),
  eon_private.communication_obligation_key(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.communication_open_balance(text,uuid,text,numeric),
  eon_private.communication_source_context(text,uuid),
  eon_private.communication_obligation_key(jsonb)
  TO service_role;

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
    v_key := eon_private.communication_obligation_key(v_context);
  ELSIF p_purpose = 'renewal' THEN
    v_eligible := p_source_type = 'contract'
      AND v_context->>'parent_contract_id' IS NOT NULL
      AND v_context->>'renewal_stage' IN ('contact_pending', 'waiting_response');
    v_key := 'renewal';
  ELSIF p_purpose = 'onboarding' THEN
    v_eligible := p_source_type = 'contract'
      AND v_context->>'parent_contract_id' IS NULL
      AND v_context->>'payment_status' = 'paid'
      AND v_context->>'source_status' IN ('active', 'scheduled', 'on_leave')
      AND NOT EXISTS (SELECT 1 FROM public.assessment_contract_event
        WHERE contract_id=p_source_id AND event_type='onboarding_checkin_sent');
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
      v_new_hold:=CASE
        WHEN v_followup>v_today THEN 'explicit_schedule'
        WHEN v_old.blocked_reason IN ('review_requested','payment_review',
          'dispute','needs_agent','source_reopened_review')
          AND v_old.hold_kind='explicit_schedule' THEN 'explicit_schedule'
        WHEN v_old.hold_kind='contact_wait' THEN 'contact_wait'
        ELSE 'none' END;
      v_new_next:=CASE
        WHEN v_followup>v_today THEN v_followup
        WHEN v_new_hold IN ('explicit_schedule','contact_wait') THEN v_old.next_action_at
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

-- A new eligible obligation receives a case at its source transaction. GETs
-- never write. Existing rows are handled by an explicit preview and sync.
CREATE OR REPLACE FUNCTION eon_private.sync_communication_case_after_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_type text;
BEGIN
  v_type := CASE TG_TABLE_NAME
    WHEN 'assessment_contracts' THEN 'contract'
    WHEN 'presale_orders' THEN 'presale'
    WHEN 'stock_orders' THEN 'stock'
    WHEN 'event_registrations' THEN 'event'
    ELSE NULL END;
  IF v_type IS NULL THEN RETURN NEW; END IF;
  PERFORM eon_private.ensure_communication_case(v_type, NEW.id, 'billing');
  IF v_type = 'contract' THEN
    PERFORM eon_private.ensure_communication_case(v_type, NEW.id, 'renewal');
    PERFORM eon_private.ensure_communication_case(v_type, NEW.id, 'onboarding');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER communication_contract_source
  AFTER INSERT OR UPDATE OF status, payment_status, renewal_stage,
    renewal_follow_up_at, renewal_last_contact_at, renewal_response_code,
    asaas_charge_id, external_invoice_number, due_date, payment_message_sent_at
    ON public.assessment_contracts
  FOR EACH ROW EXECUTE FUNCTION eon_private.sync_communication_case_after_source();
CREATE TRIGGER communication_presale_source
  AFTER INSERT OR UPDATE OF payment_status, asaas_charge_id,
    external_invoice_number ON public.presale_orders
  FOR EACH ROW EXECUTE FUNCTION eon_private.sync_communication_case_after_source();
CREATE TRIGGER communication_stock_source
  AFTER INSERT OR UPDATE OF payment_status, asaas_charge_id,
    external_invoice_number ON public.stock_orders
  FOR EACH ROW EXECUTE FUNCTION eon_private.sync_communication_case_after_source();
CREATE TRIGGER communication_event_source
  AFTER INSERT OR UPDATE OF payment_status, asaas_charge_id,
    external_invoice_number ON public.event_registrations
  FOR EACH ROW EXECUTE FUNCTION eon_private.sync_communication_case_after_source();

CREATE OR REPLACE FUNCTION eon_private.sync_communication_case_after_onboarding_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.event_type IN ('onboarding_welcome_sent','onboarding_checkin_sent') THEN
    PERFORM eon_private.ensure_communication_case('contract',NEW.contract_id,'onboarding');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER communication_onboarding_event
  AFTER INSERT ON public.assessment_contract_event
  FOR EACH ROW EXECUTE FUNCTION eon_private.sync_communication_case_after_onboarding_event();
REVOKE ALL ON FUNCTION eon_private.sync_communication_case_after_onboarding_event()
  FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION eon_private.ensure_communication_case(text,uuid,text),
  eon_private.sync_communication_case_after_source()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION eon_private.ensure_communication_case(text,uuid,text)
  TO service_role;
