BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Coach match v2 is deliberately isolated from contracts, charges, payments,
-- prospects and every other operational/financial table. It reuses only the
-- existing coach-match tables and keeps the complete v1 read/write path as a
-- rollback option.

-- Keep the original contract explicit before widening the table CHECK to v2.
CREATE FUNCTION public.coach_match_answers_valid_v1(p_answers jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text;
  v_allowed text[];
  v_values jsonb;
BEGIN
  IF jsonb_typeof(p_answers) IS DISTINCT FROM 'object'
     OR octet_length(p_answers::text) > 4096 THEN
    RETURN false;
  END IF;

  IF (SELECT count(*) FROM jsonb_object_keys(p_answers)) <> 7
     OR NOT p_answers ?& ARRAY[
       'version',
       'focus_goals',
       'focus_levels',
       'service_formats',
       'communication_style',
       'approach',
       'experience'
     ]
     OR p_answers->'version' IS DISTINCT FROM '1'::jsonb THEN
    RETURN false;
  END IF;

  FOREACH v_key IN ARRAY ARRAY['focus_goals', 'focus_levels', 'service_formats'] LOOP
    v_values := p_answers->v_key;
    IF jsonb_typeof(v_values) IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_values) NOT BETWEEN 1 AND 2 THEN
      RETURN false;
    END IF;

    v_allowed := CASE v_key
      WHEN 'focus_goals' THEN ARRAY['start', 'evolve', 'race', 'routine']
      WHEN 'focus_levels' THEN ARRAY['beginner', 'regular', 'experienced']
      ELSE ARRAY['florianopolis', 'online']
    END;

    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_values) AS item(value)
      WHERE jsonb_typeof(value) <> 'string'
         OR NOT ((value #>> '{}') = ANY(v_allowed))
    )
    OR (
      SELECT count(DISTINCT value)
      FROM jsonb_array_elements(v_values) AS item(value)
    ) <> jsonb_array_length(v_values) THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN COALESCE(
    jsonb_typeof(p_answers->'communication_style') = 'string'
    AND p_answers->>'communication_style' IN ('close', 'balanced', 'autonomy')
    AND jsonb_typeof(p_answers->'approach') = 'string'
    AND char_length(btrim(p_answers->>'approach')) BETWEEN 30 AND 320
    AND jsonb_typeof(p_answers->'experience') = 'string'
    AND char_length(p_answers->>'experience') <= 320
    AND (p_answers->>'approach') !~ '[[:cntrl:]]'
    AND (p_answers->>'experience') !~ '[[:cntrl:]]',
    false
  );
END;
$$;

-- v2 has no free-text field. Each affinity criterion has one required primary
-- choice and an optional secondary choice. "no_preference" is an exclusive
-- primary choice for age and gender, so its secondary value must be JSON null.
CREATE FUNCTION public.coach_match_answers_valid_v2(p_answers jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text;
  v_allowed text[];
  v_priority jsonb;
  v_primary text;
  v_secondary text;
BEGIN
  IF jsonb_typeof(p_answers) IS DISTINCT FROM 'object'
     OR octet_length(p_answers::text) > 4096 THEN
    RETURN false;
  END IF;

  IF (SELECT count(*) FROM jsonb_object_keys(p_answers)) <> 7
     OR NOT p_answers ?& ARRAY[
       'version',
       'service_formats',
       'focus_goals',
       'focus_levels',
       'communication_style',
       'age_groups',
       'gender_preference'
     ]
     OR p_answers->'version' IS DISTINCT FROM '2'::jsonb THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(p_answers->'service_formats') IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;

  IF jsonb_array_length(p_answers->'service_formats') NOT BETWEEN 1 AND 2
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(p_answers->'service_formats') AS item(value)
       WHERE jsonb_typeof(value) <> 'string'
          OR (value #>> '{}') NOT IN ('florianopolis', 'online')
     )
     OR (
       SELECT count(DISTINCT value)
       FROM jsonb_array_elements(p_answers->'service_formats') AS item(value)
     ) <> jsonb_array_length(p_answers->'service_formats') THEN
    RETURN false;
  END IF;

  FOREACH v_key IN ARRAY ARRAY[
    'focus_goals',
    'focus_levels',
    'communication_style',
    'age_groups',
    'gender_preference'
  ] LOOP
    v_priority := p_answers->v_key;

    IF jsonb_typeof(v_priority) IS DISTINCT FROM 'object' THEN
      RETURN false;
    END IF;

    IF (SELECT count(*) FROM jsonb_object_keys(v_priority)) <> 2
       OR NOT v_priority ?& ARRAY['primary', 'secondary']
       OR jsonb_typeof(v_priority->'primary') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_priority->'secondary') NOT IN ('string', 'null') THEN
      RETURN false;
    END IF;

    v_allowed := CASE v_key
      WHEN 'focus_goals' THEN ARRAY[
        'health', 'start', 'performance', 'return', 'high_performance'
      ]
      WHEN 'focus_levels' THEN ARRAY['beginner', 'intermediate', 'advanced']
      WHEN 'communication_style' THEN ARRAY['close', 'balanced', 'autonomy']
      WHEN 'age_groups' THEN ARRAY[
        'up_to_30', 'age_31_50', 'age_51_plus', 'no_preference'
      ]
      ELSE ARRAY['female', 'male', 'no_preference']
    END;

    v_primary := v_priority->>'primary';
    v_secondary := CASE
      WHEN jsonb_typeof(v_priority->'secondary') = 'string'
        THEN v_priority->>'secondary'
      ELSE NULL
    END;

    IF NOT (v_primary = ANY(v_allowed))
       OR (v_secondary IS NOT NULL AND NOT (v_secondary = ANY(v_allowed)))
       OR v_secondary IS NOT DISTINCT FROM v_primary
       OR (v_secondary = 'no_preference')
       OR (v_primary = 'no_preference' AND v_secondary IS NOT NULL) THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;

-- The existing table CHECK calls this function. Dispatch by the explicit
-- version so v1 rows and rollback RPCs remain valid while v2 is introduced.
CREATE OR REPLACE FUNCTION public.coach_match_answers_valid(p_answers jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF jsonb_typeof(p_answers) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;

  CASE p_answers->'version'
    WHEN '1'::jsonb THEN
      RETURN public.coach_match_answers_valid_v1(p_answers);
    WHEN '2'::jsonb THEN
      RETURN public.coach_match_answers_valid_v2(p_answers);
    ELSE
      RETURN false;
  END CASE;
END;
$$;

-- Keep every legacy entry point pinned to v1. The shared table validator accepts
-- both versions, but the rollback RPCs must never move a v2 payload into the v1
-- latest/published pointers or into the legacy public catalog.
CREATE OR REPLACE FUNCTION public.submit_assessment_coach_match_answers(
  p_token_hash text,
  p_answers jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_coach_id uuid;
  v_invite public.assessment_coach_match_invites%ROWTYPE;
  v_state public.assessment_coach_match_state%ROWTYPE;
  v_now timestamptz;
  v_id uuid;
  v_latest_time timestamptz;
BEGIN
  IF NOT public.coach_match_answers_valid_v1(p_answers) THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Respostas inválidas';
  END IF;

  SELECT coach_id
  INTO v_coach_id
  FROM public.assessment_coach_match_invites
  WHERE token_hash = p_token_hash;

  IF v_coach_id IS NULL THEN
    RAISE SQLSTATE 'PT410' USING MESSAGE = 'Link expirado ou revogado';
  END IF;

  SELECT *
  INTO v_state
  FROM public.assessment_coach_match_state
  WHERE coach_id = v_coach_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE SQLSTATE 'PT410' USING MESSAGE = 'Link expirado ou revogado';
  END IF;

  v_now := clock_timestamp();
  SELECT *
  INTO v_invite
  FROM public.assessment_coach_match_invites
  WHERE token_hash = p_token_hash
    AND coach_id = v_coach_id
    AND revoked_at IS NULL
    AND expires_at > v_now;

  IF NOT FOUND OR NOT EXISTS (
    SELECT 1
    FROM public.assessment_coaches
    WHERE id = v_coach_id
      AND active IS TRUE
  ) THEN
    RAISE SQLSTATE 'PT410' USING MESSAGE = 'Link expirado ou revogado';
  END IF;

  SELECT submitted_at
  INTO v_latest_time
  FROM public.assessment_coach_match_submissions
  WHERE id = v_state.latest_submission_id
    AND coach_id = v_coach_id;

  IF v_latest_time > v_now - interval '60 seconds'
     OR v_invite.last_submitted_at > v_now - interval '60 seconds'
     OR (
       SELECT count(*)
       FROM public.assessment_coach_match_submissions
       WHERE coach_id = v_coach_id
         AND submitted_at > v_now - interval '1 hour'
     ) >= 8 THEN
    RAISE SQLSTATE 'PT429' USING MESSAGE = 'Aguarde antes de enviar novamente';
  END IF;

  UPDATE public.assessment_coach_match_submissions
  SET status = 'superseded'
  WHERE id = v_state.latest_submission_id
    AND coach_id = v_coach_id
    AND answers->'version' = '1'::jsonb
    AND status = 'pending';

  INSERT INTO public.assessment_coach_match_submissions (
    coach_id,
    revision,
    answers,
    submitted_at
  ) VALUES (
    v_coach_id,
    v_state.revision + 1,
    p_answers,
    v_now
  )
  RETURNING id INTO v_id;

  UPDATE public.assessment_coach_match_state
  SET revision = revision + 1,
      latest_submission_id = v_id
  WHERE coach_id = v_coach_id;

  UPDATE public.assessment_coach_match_invites
  SET last_submitted_at = v_now
  WHERE id = v_invite.id;

  RETURN jsonb_build_object(
    'received', true,
    'id', v_id,
    'submitted_at', v_now
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.review_assessment_coach_match_submission(
  p_coach_id uuid,
  p_submission_id uuid,
  p_decision text,
  p_reviewed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_state public.assessment_coach_match_state%ROWTYPE;
BEGIN
  IF p_decision IS NULL
     OR p_decision NOT IN ('approved', 'rejected')
     OR p_reviewed_by IS NULL THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Revisão inválida';
  END IF;

  SELECT *
  INTO v_state
  FROM public.assessment_coach_match_state
  WHERE coach_id = p_coach_id
  FOR UPDATE;

  IF NOT FOUND OR v_state.latest_submission_id IS DISTINCT FROM p_submission_id THEN
    RAISE SQLSTATE 'PT409'
      USING MESSAGE = 'Esta não é a versão pendente mais recente';
  END IF;

  UPDATE public.assessment_coach_match_submissions
  SET status = p_decision,
      reviewed_at = clock_timestamp(),
      reviewed_by = p_reviewed_by
  WHERE id = p_submission_id
    AND coach_id = p_coach_id
    AND answers->'version' = '1'::jsonb
    AND status = 'pending';

  IF NOT FOUND THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE = 'Respostas já revisadas';
  END IF;

  IF p_decision = 'approved' THEN
    UPDATE public.assessment_coach_match_state
    SET published_submission_id = p_submission_id
    WHERE coach_id = p_coach_id;
  END IF;

  RETURN jsonb_build_object('id', p_submission_id, 'status', p_decision);
END;
$$;

CREATE OR REPLACE FUNCTION public.list_public_coach_match_profiles()
RETURNS TABLE(coach_id uuid, answers jsonb, reviewed_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT coach.id, published.answers, published.reviewed_at
  FROM public.assessment_coach_match_state AS state
  JOIN public.assessment_coaches AS coach
    ON coach.id = state.coach_id
   AND coach.active IS TRUE
   AND coach.public_visible IS TRUE
  JOIN public.assessment_coach_match_submissions AS published
    ON published.id = state.published_submission_id
   AND published.coach_id = coach.id
   AND published.status = 'approved'
   AND published.answers->'version' = '1'::jsonb
  ORDER BY coach.id;
$$;

-- Separate pointers prevent a v2 submission/review from changing the v1
-- latest or published profile. Existing rows and invitation tokens survive.
ALTER TABLE public.assessment_coach_match_state
  ADD COLUMN latest_v2_submission_id uuid,
  ADD COLUMN published_v2_submission_id uuid,
  ADD CONSTRAINT assessment_coach_match_state_latest_v2_fk
    FOREIGN KEY (coach_id, latest_v2_submission_id)
    REFERENCES public.assessment_coach_match_submissions(coach_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT assessment_coach_match_state_published_v2_fk
    FOREIGN KEY (coach_id, published_v2_submission_id)
    REFERENCES public.assessment_coach_match_submissions(coach_id, id)
    ON DELETE RESTRICT;

-- v1 and v2 may each have one pending revision during a reversible rollout.
-- Within one version the original single-pending invariant remains intact.
DROP INDEX public.coach_match_one_pending_idx;
CREATE UNIQUE INDEX coach_match_one_pending_version_idx
  ON public.assessment_coach_match_submissions (
    coach_id,
    ((answers->>'version')::integer)
  )
  WHERE status = 'pending';

-- The v2 admin/form snapshots resolve the coach's canonical modality names.
-- Keep the RPCs as SECURITY INVOKER and grant only the read privilege needed
-- by the server-only service role; browser roles remain unchanged.
GRANT SELECT ON TABLE public.assessment_modalities TO service_role;

CREATE FUNCTION public.get_assessment_coach_match_admin_v2(p_coach_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'coach', jsonb_build_object(
      'id', coach.id,
      'name', coach.name,
      'active', coach.active,
      'public_visible', coach.public_visible,
      'modality_ids', coach.modality_ids,
      'modalities', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object('id', modality.id, 'name', modality.name)
          ORDER BY modality.name, modality.id
        )
        FROM public.assessment_modalities AS modality
        WHERE modality.active IS TRUE
          AND modality.id = ANY(coach.modality_ids)
      ), '[]'::jsonb)
    ),
    'latest', to_jsonb(latest),
    'published', to_jsonb(published),
    'invites', COALESCE((
      SELECT jsonb_agg(to_jsonb(invite) ORDER BY invite.created_at DESC)
      FROM (
        SELECT id, created_at, expires_at, revoked_at, last_submitted_at
        FROM public.assessment_coach_match_invites
        WHERE coach_id = p_coach_id
        ORDER BY created_at DESC, id DESC
        LIMIT 10
      ) AS invite
    ), '[]'::jsonb),
    'server_time', now()
  )
  INTO v_result
  FROM public.assessment_coaches AS coach
  LEFT JOIN public.assessment_coach_match_state AS state
    ON state.coach_id = coach.id
  LEFT JOIN public.assessment_coach_match_submissions AS latest
    ON latest.id = state.latest_v2_submission_id
   AND latest.coach_id = coach.id
  LEFT JOIN public.assessment_coach_match_submissions AS published
    ON published.id = state.published_v2_submission_id
   AND published.coach_id = coach.id
  WHERE coach.id = p_coach_id;

  IF v_result IS NULL THEN
    RAISE SQLSTATE 'PT404' USING MESSAGE = 'Coach não encontrado';
  END IF;

  RETURN v_result;
END;
$$;

CREATE FUNCTION public.load_assessment_coach_match_form_v2(p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'coach', jsonb_build_object(
      'name', coach.name,
      'modalities', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object('id', modality.id, 'name', modality.name)
          ORDER BY modality.name, modality.id
        )
        FROM public.assessment_modalities AS modality
        WHERE modality.active IS TRUE
          AND modality.id = ANY(coach.modality_ids)
      ), '[]'::jsonb)
    ),
    'latest', CASE
      WHEN latest.id IS NULL THEN NULL
      ELSE jsonb_build_object(
        'answers', latest.answers,
        'status', latest.status,
        'submitted_at', latest.submitted_at
      )
    END,
    'expires_at', invite.expires_at
  )
  INTO v_result
  FROM public.assessment_coach_match_invites AS invite
  JOIN public.assessment_coaches AS coach
    ON coach.id = invite.coach_id
   AND coach.active IS TRUE
  JOIN public.assessment_coach_match_state AS state
    ON state.coach_id = invite.coach_id
  LEFT JOIN public.assessment_coach_match_submissions AS latest
    ON latest.id = state.latest_v2_submission_id
   AND latest.coach_id = invite.coach_id
  WHERE invite.token_hash = p_token_hash
    AND invite.revoked_at IS NULL
    AND invite.expires_at > clock_timestamp();

  IF v_result IS NULL THEN
    RAISE SQLSTATE 'PT410' USING MESSAGE = 'Link expirado ou revogado';
  END IF;

  RETURN v_result;
END;
$$;

CREATE FUNCTION public.submit_assessment_coach_match_answers_v2(
  p_token_hash text,
  p_answers jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_coach_id uuid;
  v_invite public.assessment_coach_match_invites%ROWTYPE;
  v_state public.assessment_coach_match_state%ROWTYPE;
  v_now timestamptz;
  v_id uuid;
  v_latest_time timestamptz;
BEGIN
  IF NOT public.coach_match_answers_valid_v2(p_answers) THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Respostas inválidas';
  END IF;

  SELECT coach_id
  INTO v_coach_id
  FROM public.assessment_coach_match_invites
  WHERE token_hash = p_token_hash;

  IF v_coach_id IS NULL THEN
    RAISE SQLSTATE 'PT410' USING MESSAGE = 'Link expirado ou revogado';
  END IF;

  SELECT *
  INTO v_state
  FROM public.assessment_coach_match_state
  WHERE coach_id = v_coach_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE SQLSTATE 'PT410' USING MESSAGE = 'Link expirado ou revogado';
  END IF;

  -- Recheck link/coach validity after acquiring the per-coach lock. This also
  -- protects against two requests that were valid before waiting on the lock.
  v_now := clock_timestamp();
  SELECT *
  INTO v_invite
  FROM public.assessment_coach_match_invites
  WHERE token_hash = p_token_hash
    AND coach_id = v_coach_id
    AND revoked_at IS NULL
    AND expires_at > v_now;

  IF NOT FOUND OR NOT EXISTS (
    SELECT 1
    FROM public.assessment_coaches
    WHERE id = v_coach_id
      AND active IS TRUE
  ) THEN
    RAISE SQLSTATE 'PT410' USING MESSAGE = 'Link expirado ou revogado';
  END IF;

  SELECT submitted_at
  INTO v_latest_time
  FROM public.assessment_coach_match_submissions
  WHERE id = v_state.latest_v2_submission_id
    AND coach_id = v_coach_id;

  IF v_latest_time > v_now - interval '60 seconds'
     OR v_invite.last_submitted_at > v_now - interval '60 seconds'
     OR (
       SELECT count(*)
       FROM public.assessment_coach_match_submissions
       WHERE coach_id = v_coach_id
         AND submitted_at > v_now - interval '1 hour'
     ) >= 8 THEN
    RAISE SQLSTATE 'PT429' USING MESSAGE = 'Aguarde antes de enviar novamente';
  END IF;

  UPDATE public.assessment_coach_match_submissions
  SET status = 'superseded'
  WHERE id = v_state.latest_v2_submission_id
    AND coach_id = v_coach_id
    AND answers->'version' = '2'::jsonb
    AND status = 'pending';

  INSERT INTO public.assessment_coach_match_submissions (
    coach_id,
    revision,
    answers,
    submitted_at
  ) VALUES (
    v_coach_id,
    v_state.revision + 1,
    p_answers,
    v_now
  )
  RETURNING id INTO v_id;

  UPDATE public.assessment_coach_match_state
  SET revision = revision + 1,
      latest_v2_submission_id = v_id
  WHERE coach_id = v_coach_id;

  UPDATE public.assessment_coach_match_invites
  SET last_submitted_at = v_now
  WHERE id = v_invite.id;

  RETURN jsonb_build_object(
    'received', true,
    'id', v_id,
    'submitted_at', v_now
  );
END;
$$;

CREATE FUNCTION public.review_assessment_coach_match_submission_v2(
  p_coach_id uuid,
  p_submission_id uuid,
  p_decision text,
  p_reviewed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_state public.assessment_coach_match_state%ROWTYPE;
BEGIN
  IF p_decision IS NULL
     OR p_decision NOT IN ('approved', 'rejected')
     OR p_reviewed_by IS NULL THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Revisão inválida';
  END IF;

  SELECT *
  INTO v_state
  FROM public.assessment_coach_match_state
  WHERE coach_id = p_coach_id
  FOR UPDATE;

  IF NOT FOUND OR v_state.latest_v2_submission_id IS DISTINCT FROM p_submission_id THEN
    RAISE SQLSTATE 'PT409'
      USING MESSAGE = 'Esta não é a versão pendente mais recente';
  END IF;

  UPDATE public.assessment_coach_match_submissions
  SET status = p_decision,
      reviewed_at = clock_timestamp(),
      reviewed_by = p_reviewed_by
  WHERE id = p_submission_id
    AND coach_id = p_coach_id
    AND answers->'version' = '2'::jsonb
    AND status = 'pending';

  IF NOT FOUND THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE = 'Respostas já revisadas';
  END IF;

  IF p_decision = 'approved' THEN
    UPDATE public.assessment_coach_match_state
    SET published_v2_submission_id = p_submission_id
    WHERE coach_id = p_coach_id;
  END IF;

  RETURN jsonb_build_object('id', p_submission_id, 'status', p_decision);
END;
$$;

-- Internal server-side input for the future scoring endpoint. The raw v2
-- answers include age/gender preferences and MUST NOT be returned by a public
-- GET endpoint. This function is executable only by service_role.
CREATE FUNCTION public.list_approved_coach_match_profiles_v2()
RETURNS TABLE(coach_id uuid, answers jsonb, reviewed_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT coach.id, published.answers, published.reviewed_at
  FROM public.assessment_coach_match_state AS state
  JOIN public.assessment_coaches AS coach
    ON coach.id = state.coach_id
   AND coach.active IS TRUE
   AND coach.public_visible IS TRUE
  JOIN public.assessment_coach_match_submissions AS published
    ON published.id = state.published_v2_submission_id
   AND published.coach_id = coach.id
   AND published.status = 'approved'
   AND published.answers->'version' = '2'::jsonb
  ORDER BY coach.id;
$$;

COMMENT ON FUNCTION public.list_approved_coach_match_profiles_v2() IS
  'Internal raw coach-match v2 profiles for server-side scoring. Never expose through a public GET endpoint.';

-- PostgreSQL grants EXECUTE to PUBLIC on new functions by default. Remove it
-- explicitly: Edge Functions call these RPCs with the server-only service role.
REVOKE ALL ON FUNCTION public.coach_match_answers_valid_v1(jsonb),
  public.coach_match_answers_valid_v2(jsonb),
  public.coach_match_answers_valid(jsonb),
  public.get_assessment_coach_match_admin_v2(uuid),
  public.load_assessment_coach_match_form_v2(text),
  public.submit_assessment_coach_match_answers_v2(text, jsonb),
  public.review_assessment_coach_match_submission_v2(uuid, uuid, text, uuid),
  public.list_approved_coach_match_profiles_v2()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.coach_match_answers_valid_v1(jsonb),
  public.coach_match_answers_valid_v2(jsonb),
  public.coach_match_answers_valid(jsonb),
  public.get_assessment_coach_match_admin_v2(uuid),
  public.load_assessment_coach_match_form_v2(text),
  public.submit_assessment_coach_match_answers_v2(text, jsonb),
  public.review_assessment_coach_match_submission_v2(uuid, uuid, text, uuid),
  public.list_approved_coach_match_profiles_v2()
TO service_role;

COMMIT;
