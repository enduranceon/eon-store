-- Login do coach (etapa 2 dos eventos), pedido do usuário em 2026-11-09.
--
-- O coach entra com uma conta do Supabase Auth ligada ao seu cadastro
-- (assessment_coaches.auth_user_id) e vê SÓ os eventos em que é responsável
-- (event_coaches), só para olhar, e marca "no grupo do WhatsApp" nas inscrições pagas
-- desses eventos. Não vê valores, ganhos, despesas, cobranças nem observações internas.
--
-- Segurança: o navegador do coach NÃO lê nenhuma tabela. Todas as tabelas seguem
-- fechadas por RLS restrita a administrador (um usuário logado que não é administrador
-- não enxerga linha nenhuma, e não pode gravar). O coach só chega aos dados pelas
-- funções abaixo, chamadas pela edge function coach-api com a identidade validada
-- no servidor. Cada função confere o coach pela conta e devolve uma lista FIXA de
-- campos: não existe `to_jsonb(linha)`. Todas executam só como service_role.

-- Uma conta de login pertence a um único coach.
CREATE UNIQUE INDEX IF NOT EXISTS assessment_coaches_auth_user_id_key
  ON public.assessment_coaches (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

-- Coach ATIVO ligado a esta conta (NULL se não houver). Coach inativo perde o acesso.
CREATE OR REPLACE FUNCTION public.coach_id_for_user(p_user_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT c.id
  FROM public.assessment_coaches c
  WHERE c.auth_user_id = p_user_id AND c.active
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.require_coach_for_user(p_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_coach UUID;
BEGIN
  v_coach := public.coach_id_for_user(p_user_id);
  IF v_coach IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Esta conta não tem acesso de coach';
  END IF;
  RETURN v_coach;
END;
$$;

CREATE OR REPLACE FUNCTION public.coach_me(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_coach UUID;
  v_name TEXT;
BEGIN
  v_coach := public.require_coach_for_user(p_user_id);
  SELECT c.name INTO v_name FROM public.assessment_coaches c WHERE c.id = v_coach;
  RETURN jsonb_build_object('coach_id', v_coach, 'name', v_name);
END;
$$;

-- Eventos em que o coach é responsável, com contagens. Sem valores.
CREATE OR REPLACE FUNCTION public.coach_list_events(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_coach UUID;
BEGIN
  v_coach := public.require_coach_for_user(p_user_id);

  RETURN COALESCE((
    SELECT jsonb_agg(q.item ORDER BY q.event_date DESC, q.name)
    FROM (
      SELECT
        e.event_date,
        e.name,
        jsonb_build_object(
          'id', e.id,
          'name', e.name,
          'event_date', e.event_date,
          'end_date', e.end_date,
          'start_time', e.start_time,
          'end_time', e.end_time,
          'location', e.location,
          'status', e.status,
          'whatsapp_group_enabled', e.whatsapp_group_enabled,
          'registered', COALESCE(s.registered, 0),
          'paid', COALESCE(s.paid, 0),
          'not_paid', COALESCE(s.registered, 0) - COALESCE(s.paid, 0),
          'group_added', CASE WHEN e.whatsapp_group_enabled THEN COALESCE(s.group_added, 0) END,
          'group_missing', CASE WHEN e.whatsapp_group_enabled THEN COALESCE(s.group_missing, 0) END,
          'group_declined', CASE WHEN e.whatsapp_group_enabled THEN COALESCE(s.group_declined, 0) END
        ) AS item
      FROM public.events e
      JOIN public.event_coaches ec ON ec.event_id = e.id AND ec.coach_id = v_coach
      LEFT JOIN LATERAL (
        SELECT
          count(*) FILTER (WHERE r.payment_status NOT IN ('cancelled', 'refunded')) AS registered,
          count(*) FILTER (WHERE r.payment_status = 'paid') AS paid,
          count(*) FILTER (WHERE r.payment_status = 'paid' AND r.whatsapp_group_status = 'added') AS group_added,
          count(*) FILTER (WHERE r.payment_status = 'paid' AND r.whatsapp_group_status = 'pending') AS group_missing,
          count(*) FILTER (WHERE r.payment_status = 'paid' AND r.whatsapp_group_status = 'declined') AS group_declined
        FROM public.event_registrations r
        WHERE r.event_id = e.id
      ) s ON true
    ) q
  ), '[]'::JSONB);
END;
$$;

-- Um evento do coach com os inscritos. Evento que não é dele e evento inexistente
-- dão a mesma resposta ("não encontrado"), para não revelar o que existe.
-- Campos de cada inscrito: número, nome, tipo, situação do pagamento (paid, not_paid ou
-- cancelled) e, SÓ para inscrição paga em evento com grupo, a situação do grupo e o
-- WhatsApp (necessário para adicionar a pessoa ao grupo). Nunca preço, valor, taxa,
-- cobrança, CPF, e-mail, respostas do formulário nem observações internas.
CREATE OR REPLACE FUNCTION public.coach_get_event(p_user_id UUID, p_event_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_coach UUID;
  v_event public.events%ROWTYPE;
BEGIN
  v_coach := public.require_coach_for_user(p_user_id);

  SELECT e.* INTO v_event
  FROM public.events e
  WHERE e.id = p_event_id
    AND EXISTS (
      SELECT 1 FROM public.event_coaches ec
      WHERE ec.event_id = e.id AND ec.coach_id = v_coach
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Evento não encontrado';
  END IF;

  RETURN jsonb_build_object(
    'event', jsonb_build_object(
      'id', v_event.id,
      'name', v_event.name,
      'description', v_event.description,
      'event_date', v_event.event_date,
      'end_date', v_event.end_date,
      'start_time', v_event.start_time,
      'end_time', v_event.end_time,
      'location', v_event.location,
      'address', v_event.address,
      'map_url', v_event.map_url,
      'public_notes', v_event.public_notes,
      'status', v_event.status,
      'whatsapp_group_enabled', v_event.whatsapp_group_enabled
    ),
    'summary', (
      SELECT jsonb_build_object(
        'registered', count(*) FILTER (WHERE r.payment_status NOT IN ('cancelled', 'refunded')),
        'paid', count(*) FILTER (WHERE r.payment_status = 'paid'),
        'not_paid', count(*) FILTER (WHERE r.payment_status NOT IN ('paid', 'cancelled', 'refunded')),
        'cancelled', count(*) FILTER (WHERE r.payment_status IN ('cancelled', 'refunded')),
        'group_added', CASE WHEN v_event.whatsapp_group_enabled
          THEN count(*) FILTER (WHERE r.payment_status = 'paid' AND r.whatsapp_group_status = 'added') END,
        'group_missing', CASE WHEN v_event.whatsapp_group_enabled
          THEN count(*) FILTER (WHERE r.payment_status = 'paid' AND r.whatsapp_group_status = 'pending') END,
        'group_declined', CASE WHEN v_event.whatsapp_group_enabled
          THEN count(*) FILTER (WHERE r.payment_status = 'paid' AND r.whatsapp_group_status = 'declined') END
      )
      FROM public.event_registrations r
      WHERE r.event_id = v_event.id
    ),
    'registrations', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', r.id,
          'registration_number', r.registration_number,
          'person_name', COALESCE(cu.full_name, '—'),
          'type_name', t.name,
          'payment', CASE
            WHEN r.payment_status = 'paid' THEN 'paid'
            WHEN r.payment_status IN ('cancelled', 'refunded') THEN 'cancelled'
            ELSE 'not_paid'
          END,
          'whatsapp_group_status', CASE
            WHEN v_event.whatsapp_group_enabled AND r.payment_status = 'paid' THEN r.whatsapp_group_status
          END,
          'whatsapp', CASE
            WHEN v_event.whatsapp_group_enabled AND r.payment_status = 'paid' THEN cu.whatsapp
          END
        )
        ORDER BY COALESCE(cu.full_name, '—'), r.registration_number
      )
      FROM public.event_registrations r
      JOIN public.event_registration_types t ON t.id = r.registration_type_id
      LEFT JOIN public.presale_customers cu ON cu.id = r.customer_id
      WHERE r.event_id = v_event.id
    ), '[]'::JSONB)
  );
END;
$$;

-- O coach marca a situação do grupo de uma inscrição de um evento seu. As regras
-- (evento com grupo, inscrição paga, não cancelada) ficam em
-- set_event_registration_whatsapp_group; aqui só se confere que o evento é do coach.
CREATE OR REPLACE FUNCTION public.coach_set_registration_whatsapp_group(
  p_user_id UUID,
  p_registration_id UUID,
  p_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_coach UUID;
  v_event UUID;
BEGIN
  v_coach := public.require_coach_for_user(p_user_id);

  SELECT r.event_id INTO v_event
  FROM public.event_registrations r
  WHERE r.id = p_registration_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.event_coaches ec
    WHERE ec.event_id = v_event AND ec.coach_id = v_coach
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Inscrição não encontrada';
  END IF;

  RETURN public.set_event_registration_whatsapp_group(p_registration_id, p_status, p_user_id);
END;
$$;

-- Dados mínimos do coach para a equipe criar o acesso (e-mail do login, se está ativo,
-- se já tem conta). Só a edge function de administração chama.
CREATE OR REPLACE FUNCTION public.coach_access_target(p_coach_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_coach public.assessment_coaches%ROWTYPE;
BEGIN
  SELECT * INTO v_coach FROM public.assessment_coaches WHERE id = p_coach_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Coach não encontrado';
  END IF;
  RETURN jsonb_build_object(
    'coach_id', v_coach.id,
    'name', v_coach.name,
    'email', v_coach.email,
    'active', v_coach.active,
    'auth_user_id', v_coach.auth_user_id
  );
END;
$$;

-- Liga uma conta de login a um coach (a conta é criada pela edge function com a
-- chave de serviço). Recusa conta de administrador: coach e administrador não se misturam.
CREATE OR REPLACE FUNCTION public.link_coach_auth_user(
  p_coach_id UUID,
  p_auth_user_id UUID,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_coach public.assessment_coaches%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL OR p_auth_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador e conta são obrigatórios';
  END IF;

  SELECT * INTO v_coach FROM public.assessment_coaches WHERE id = p_coach_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Coach não encontrado';
  END IF;
  IF NOT v_coach.active THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Coach inativo não pode ter acesso';
  END IF;
  IF v_coach.auth_user_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este coach já tem acesso';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_admins a WHERE a.user_id = p_auth_user_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Conta de administrador não pode ser conta de coach';
  END IF;

  UPDATE public.assessment_coaches SET auth_user_id = p_auth_user_id WHERE id = p_coach_id;

  RETURN jsonb_build_object('coach_id', p_coach_id, 'auth_user_id', p_auth_user_id);
END;
$$;

-- Tira o acesso: desfaz a ligação e devolve a conta que estava ligada (NULL se não havia),
-- para a edge function apagá-la.
CREATE OR REPLACE FUNCTION public.unlink_coach_auth_user(
  p_coach_id UUID,
  p_actor_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_previous UUID;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;

  SELECT auth_user_id INTO v_previous
  FROM public.assessment_coaches WHERE id = p_coach_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Coach não encontrado';
  END IF;

  UPDATE public.assessment_coaches SET auth_user_id = NULL WHERE id = p_coach_id;
  RETURN v_previous;
END;
$$;

REVOKE ALL ON FUNCTION public.coach_id_for_user(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.require_coach_for_user(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.coach_me(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.coach_list_events(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.coach_get_event(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.coach_set_registration_whatsapp_group(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.coach_access_target(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.link_coach_auth_user(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unlink_coach_auth_user(UUID, UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.coach_id_for_user(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.require_coach_for_user(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.coach_me(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.coach_list_events(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.coach_get_event(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.coach_set_registration_whatsapp_group(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.coach_access_target(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.link_coach_auth_user(UUID, UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.unlink_coach_auth_user(UUID, UUID) TO service_role;
