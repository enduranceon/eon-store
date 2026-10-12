BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Additive module: no writes/triggers/policies on existing operational tables.
-- Per-coach state serializes match actions without locking finance rows.
CREATE FUNCTION public.coach_match_answers_valid(p_answers jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE v_key text; v_allowed text[]; v_values jsonb;
BEGIN
  IF jsonb_typeof(p_answers) IS DISTINCT FROM 'object'
    OR octet_length(p_answers::text) > 4096 THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_answers)) <> 7
    OR NOT p_answers ?& ARRAY['version','focus_goals','focus_levels','service_formats',
      'communication_style','approach','experience']
    OR p_answers->'version' IS DISTINCT FROM '1'::jsonb THEN RETURN false; END IF;
  FOREACH v_key IN ARRAY ARRAY['focus_goals','focus_levels','service_formats'] LOOP
    v_values := p_answers->v_key;
    IF jsonb_typeof(v_values) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(v_values) NOT BETWEEN 1 AND 2 THEN RETURN false; END IF;
    v_allowed := CASE v_key
      WHEN 'focus_goals' THEN ARRAY['start','evolve','race','routine']
      WHEN 'focus_levels' THEN ARRAY['beginner','regular','experienced']
      ELSE ARRAY['florianopolis','online'] END;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_values) AS e(value)
      WHERE jsonb_typeof(value) <> 'string' OR NOT ((value #>> '{}') = ANY(v_allowed)))
      OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(v_values) AS e(value))
        <> jsonb_array_length(v_values) THEN RETURN false; END IF;
  END LOOP;
  RETURN COALESCE(
    jsonb_typeof(p_answers->'communication_style') = 'string'
    AND p_answers->>'communication_style' IN ('close','balanced','autonomy')
    AND jsonb_typeof(p_answers->'approach') = 'string'
    AND char_length(btrim(p_answers->>'approach')) BETWEEN 30 AND 320
    AND jsonb_typeof(p_answers->'experience') = 'string'
    AND char_length(p_answers->>'experience') <= 320
    AND (p_answers->>'approach') !~ '[[:cntrl:]]'
    AND (p_answers->>'experience') !~ '[[:cntrl:]]', false);
END;
$$;

CREATE TABLE public.assessment_coach_match_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL REFERENCES public.assessment_coaches(id) ON DELETE RESTRICT,
  revision bigint NOT NULL CHECK (revision > 0),
  answers jsonb NOT NULL CHECK (public.coach_match_answers_valid(answers)),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','superseded')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (coach_id, revision), UNIQUE (coach_id, id),
  CHECK ((status IN ('approved','rejected')) = (reviewed_at IS NOT NULL))
);
CREATE INDEX coach_match_submissions_rate_idx
  ON public.assessment_coach_match_submissions (coach_id, submitted_at DESC);
CREATE UNIQUE INDEX coach_match_one_pending_idx
  ON public.assessment_coach_match_submissions (coach_id) WHERE status = 'pending';

CREATE TABLE public.assessment_coach_match_state (
  coach_id uuid PRIMARY KEY REFERENCES public.assessment_coaches(id) ON DELETE RESTRICT,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  latest_submission_id uuid, published_submission_id uuid,
  FOREIGN KEY (coach_id, latest_submission_id)
    REFERENCES public.assessment_coach_match_submissions(coach_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (coach_id, published_submission_id)
    REFERENCES public.assessment_coach_match_submissions(coach_id, id) ON DELETE RESTRICT
);
CREATE TABLE public.assessment_coach_match_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL REFERENCES public.assessment_coaches(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL, revoked_at timestamptz, last_submitted_at timestamptz
);
CREATE INDEX coach_match_invites_coach_created_idx
  ON public.assessment_coach_match_invites (coach_id, created_at DESC);
CREATE UNIQUE INDEX coach_match_one_live_invite_idx
  ON public.assessment_coach_match_invites (coach_id) WHERE revoked_at IS NULL;
ALTER TABLE public.assessment_coach_match_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assessment_coach_match_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assessment_coach_match_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.assessment_coach_match_submissions,
  public.assessment_coach_match_state, public.assessment_coach_match_invites FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.assessment_coach_match_submissions,
  public.assessment_coach_match_state, public.assessment_coach_match_invites TO service_role;

CREATE FUNCTION public.get_assessment_coach_match_admin(p_coach_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'coach', jsonb_build_object('id', c.id, 'name', c.name, 'active', c.active,
      'public_visible', c.public_visible, 'modality_ids', c.modality_ids),
    'latest', to_jsonb(latest), 'published', to_jsonb(published),
    'invites', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.created_at DESC) FROM (
      SELECT id, created_at, expires_at, revoked_at, last_submitted_at
      FROM public.assessment_coach_match_invites WHERE coach_id = p_coach_id
      ORDER BY created_at DESC, id DESC LIMIT 10
    ) AS i), '[]'::jsonb), 'server_time', now()) INTO v_result
  FROM public.assessment_coaches AS c
  LEFT JOIN public.assessment_coach_match_state AS s ON s.coach_id = c.id
  LEFT JOIN public.assessment_coach_match_submissions AS latest ON latest.id = s.latest_submission_id
  LEFT JOIN public.assessment_coach_match_submissions AS published ON published.id = s.published_submission_id
  WHERE c.id = p_coach_id;
  IF v_result IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE = 'Coach não encontrado'; END IF;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.issue_assessment_coach_match_invite(
  p_coach_id uuid, p_token_hash text, p_expires_at timestamptz, p_created_by uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE v_id uuid; v_now timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.assessment_coaches WHERE id = p_coach_id AND active) THEN
    RAISE SQLSTATE 'PT404' USING MESSAGE = 'Coach indisponível'; END IF;
  IF p_created_by IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Link inválido'; END IF;
  INSERT INTO public.assessment_coach_match_state(coach_id) VALUES (p_coach_id)
    ON CONFLICT (coach_id) DO NOTHING;
  PERFORM 1 FROM public.assessment_coach_match_state WHERE coach_id = p_coach_id FOR UPDATE;
  v_now := clock_timestamp();
  IF p_expires_at IS NULL OR p_expires_at <= v_now OR p_expires_at > v_now + interval '31 days' THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Validade do link inválida'; END IF;
  UPDATE public.assessment_coach_match_invites SET revoked_at = v_now
    WHERE coach_id = p_coach_id AND revoked_at IS NULL;
  INSERT INTO public.assessment_coach_match_invites(coach_id, token_hash, created_at, expires_at, created_by)
    VALUES (p_coach_id, p_token_hash, v_now, p_expires_at, p_created_by) RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'expires_at', p_expires_at);
END;
$$;

CREATE FUNCTION public.revoke_assessment_coach_match_invite(p_coach_id uuid, p_invite_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.assessment_coach_match_state WHERE coach_id = p_coach_id FOR UPDATE;
  UPDATE public.assessment_coach_match_invites SET revoked_at = COALESCE(revoked_at, clock_timestamp())
    WHERE id = p_invite_id AND coach_id = p_coach_id;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE = 'Link não encontrado'; END IF;
  RETURN jsonb_build_object('revoked', true);
END;
$$;

CREATE FUNCTION public.load_assessment_coach_match_form(p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE v_result jsonb;
BEGIN
  SELECT jsonb_build_object('coach', jsonb_build_object('name', c.name),
    'latest', CASE WHEN latest.id IS NULL THEN NULL ELSE jsonb_build_object(
      'answers', latest.answers, 'status', latest.status, 'submitted_at', latest.submitted_at) END,
    'expires_at', i.expires_at) INTO v_result
  FROM public.assessment_coach_match_invites AS i
  JOIN public.assessment_coaches AS c ON c.id = i.coach_id AND c.active
  JOIN public.assessment_coach_match_state AS s ON s.coach_id = i.coach_id
  LEFT JOIN public.assessment_coach_match_submissions AS latest ON latest.id = s.latest_submission_id
  WHERE i.token_hash = p_token_hash AND i.revoked_at IS NULL AND i.expires_at > clock_timestamp();
  IF v_result IS NULL THEN RAISE SQLSTATE 'PT410' USING MESSAGE = 'Link expirado ou revogado'; END IF;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.submit_assessment_coach_match_answers(p_token_hash text, p_answers jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE v_coach_id uuid; v_invite public.assessment_coach_match_invites%ROWTYPE;
  v_state public.assessment_coach_match_state%ROWTYPE;
  v_now timestamptz; v_id uuid; v_latest_time timestamptz;
BEGIN
  IF NOT public.coach_match_answers_valid(p_answers) THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Respostas inválidas'; END IF;
  SELECT coach_id INTO v_coach_id FROM public.assessment_coach_match_invites WHERE token_hash = p_token_hash;
  IF v_coach_id IS NULL THEN RAISE SQLSTATE 'PT410' USING MESSAGE = 'Link expirado ou revogado'; END IF;
  SELECT * INTO v_state FROM public.assessment_coach_match_state WHERE coach_id = v_coach_id FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT410' USING MESSAGE = 'Link expirado ou revogado'; END IF;
  -- Recheck time and link validity AFTER the lock, including waiting requests.
  v_now := clock_timestamp();
  SELECT * INTO v_invite FROM public.assessment_coach_match_invites
    WHERE token_hash = p_token_hash AND revoked_at IS NULL AND expires_at > v_now;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.assessment_coaches WHERE id = v_coach_id AND active) THEN
    RAISE SQLSTATE 'PT410' USING MESSAGE = 'Link expirado ou revogado'; END IF;
  SELECT submitted_at INTO v_latest_time FROM public.assessment_coach_match_submissions
    WHERE id = v_state.latest_submission_id;
  IF v_latest_time > v_now - interval '60 seconds'
    OR v_invite.last_submitted_at > v_now - interval '60 seconds'
    OR (SELECT count(*) FROM public.assessment_coach_match_submissions
        WHERE coach_id = v_coach_id AND submitted_at > v_now - interval '1 hour') >= 8 THEN
    RAISE SQLSTATE 'PT429' USING MESSAGE = 'Aguarde antes de enviar novamente'; END IF;
  UPDATE public.assessment_coach_match_submissions SET status = 'superseded'
    WHERE id = v_state.latest_submission_id AND status = 'pending';
  INSERT INTO public.assessment_coach_match_submissions(coach_id, revision, answers, submitted_at)
    VALUES (v_coach_id, v_state.revision + 1, p_answers, v_now) RETURNING id INTO v_id;
  UPDATE public.assessment_coach_match_state
    SET revision = revision + 1, latest_submission_id = v_id WHERE coach_id = v_coach_id;
  UPDATE public.assessment_coach_match_invites SET last_submitted_at = v_now WHERE id = v_invite.id;
  RETURN jsonb_build_object('received', true, 'id', v_id, 'submitted_at', v_now);
END;
$$;

CREATE FUNCTION public.review_assessment_coach_match_submission(
  p_coach_id uuid, p_submission_id uuid, p_decision text, p_reviewed_by uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE v_state public.assessment_coach_match_state%ROWTYPE;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('approved','rejected') OR p_reviewed_by IS NULL THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Revisão inválida'; END IF;
  SELECT * INTO v_state FROM public.assessment_coach_match_state WHERE coach_id = p_coach_id FOR UPDATE;
  IF NOT FOUND OR v_state.latest_submission_id IS DISTINCT FROM p_submission_id THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE = 'Esta não é a versão pendente mais recente'; END IF;
  UPDATE public.assessment_coach_match_submissions
    SET status = p_decision, reviewed_at = clock_timestamp(), reviewed_by = p_reviewed_by
    WHERE id = p_submission_id AND coach_id = p_coach_id AND status = 'pending';
  IF NOT FOUND THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'Respostas já revisadas'; END IF;
  IF p_decision = 'approved' THEN
    UPDATE public.assessment_coach_match_state SET published_submission_id = p_submission_id
      WHERE coach_id = p_coach_id;
  END IF;
  RETURN jsonb_build_object('id', p_submission_id, 'status', p_decision);
END;
$$;

CREATE FUNCTION public.list_public_coach_match_profiles()
RETURNS TABLE(coach_id uuid, answers jsonb, reviewed_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT c.id, p.answers, p.reviewed_at FROM public.assessment_coach_match_state AS s
  JOIN public.assessment_coaches AS c ON c.id = s.coach_id AND c.active AND c.public_visible
  JOIN public.assessment_coach_match_submissions AS p ON p.id = s.published_submission_id
    AND p.coach_id = c.id AND p.status = 'approved' ORDER BY c.id;
$$;

REVOKE ALL ON FUNCTION public.coach_match_answers_valid(jsonb),
  public.get_assessment_coach_match_admin(uuid),
  public.issue_assessment_coach_match_invite(uuid,text,timestamptz,uuid),
  public.revoke_assessment_coach_match_invite(uuid,uuid),
  public.load_assessment_coach_match_form(text),
  public.submit_assessment_coach_match_answers(text,jsonb),
  public.review_assessment_coach_match_submission(uuid,uuid,text,uuid),
  public.list_public_coach_match_profiles() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.coach_match_answers_valid(jsonb),
  public.get_assessment_coach_match_admin(uuid),
  public.issue_assessment_coach_match_invite(uuid,text,timestamptz,uuid),
  public.revoke_assessment_coach_match_invite(uuid,uuid),
  public.load_assessment_coach_match_form(text),
  public.submit_assessment_coach_match_answers(text,jsonb),
  public.review_assessment_coach_match_submission(uuid,uuid,text,uuid),
  public.list_public_coach_match_profiles() TO service_role;

COMMIT;
