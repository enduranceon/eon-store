-- Eventos: coaches responsáveis e grupo do WhatsApp (pedido do usuário, 2026-11-09).
--
-- 1) Um evento pode ter vários coaches responsáveis (event_coaches). É a base do
--    futuro login do coach: o coach só enxergará os eventos em que é responsável.
--    Esta migration não dá acesso a ninguém: a tabela continua só para administrador.
-- 2) O evento marca se tem grupo no WhatsApp (events.whatsapp_group_enabled). Quando
--    tem, cada inscrição PAGA ganha a situação do grupo (event_registrations.
--    whatsapp_group_status): pending (falta adicionar), added (já está no grupo) ou
--    declined (não quer entrar). Só inscrição paga sai de "pending".
--
-- Toda escrita passa por função chamada pela edge function (service_role), como no
-- resto da área de eventos; o navegador só lê, via RLS restrita a administrador.

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS whatsapp_group_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.event_registrations
  ADD COLUMN IF NOT EXISTS whatsapp_group_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (whatsapp_group_status IN ('pending', 'added', 'declined')),
  ADD COLUMN IF NOT EXISTS whatsapp_group_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS whatsapp_group_updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.event_coaches (
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  coach_id UUID NOT NULL REFERENCES public.assessment_coaches(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (event_id, coach_id)
);

CREATE INDEX IF NOT EXISTS event_coaches_coach_id_idx ON public.event_coaches(coach_id);

ALTER TABLE public.event_coaches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS event_coaches_admin_read ON public.event_coaches;
CREATE POLICY event_coaches_admin_read ON public.event_coaches
  FOR SELECT TO authenticated USING (eon_private.is_app_admin());
DROP POLICY IF EXISTS event_coaches_admin_only ON public.event_coaches;
CREATE POLICY event_coaches_admin_only ON public.event_coaches
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (eon_private.is_app_admin()) WITH CHECK (eon_private.is_app_admin());

GRANT SELECT ON public.event_coaches TO authenticated;
GRANT ALL ON public.event_coaches TO service_role;

-- Troca TODOS os responsáveis do evento de uma vez (lista vazia tira todos).
-- Coach inativo só pode ser mantido se já era responsável; novo responsável precisa
-- estar ativo.
CREATE OR REPLACE FUNCTION public.set_event_coaches(
  p_event_id UUID,
  p_coach_ids UUID[],
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_ids UUID[];
  v_unknown INTEGER;
  v_inactive INTEGER;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;

  PERFORM 1 FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Evento não encontrado';
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(COALESCE(p_coach_ids, '{}'::UUID[])) AS x(coach_id) WHERE x.coach_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Coach inválido';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x.coach_id), '{}'::UUID[]) INTO v_ids
  FROM unnest(COALESCE(p_coach_ids, '{}'::UUID[])) AS x(coach_id);

  SELECT count(*) INTO v_unknown
  FROM unnest(v_ids) AS x(coach_id)
  WHERE NOT EXISTS (SELECT 1 FROM public.assessment_coaches c WHERE c.id = x.coach_id);
  IF v_unknown > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Coach não encontrado';
  END IF;

  SELECT count(*) INTO v_inactive
  FROM unnest(v_ids) AS x(coach_id)
  JOIN public.assessment_coaches c ON c.id = x.coach_id
  WHERE NOT c.active
    AND NOT EXISTS (
      SELECT 1 FROM public.event_coaches ec
      WHERE ec.event_id = p_event_id AND ec.coach_id = x.coach_id
    );
  IF v_inactive > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Coach inativo não pode ser responsável por evento';
  END IF;

  DELETE FROM public.event_coaches
  WHERE event_id = p_event_id AND NOT (coach_id = ANY (v_ids));

  INSERT INTO public.event_coaches (event_id, coach_id, created_by)
  SELECT p_event_id, x.coach_id, p_actor_id FROM unnest(v_ids) AS x(coach_id)
  ON CONFLICT (event_id, coach_id) DO NOTHING;

  UPDATE public.events SET updated_at = now() WHERE id = p_event_id;

  RETURN jsonb_build_object(
    'event_id', p_event_id,
    'coach_ids', (
      SELECT COALESCE(jsonb_agg(ec.coach_id ORDER BY ec.coach_id), '[]'::JSONB)
      FROM public.event_coaches ec WHERE ec.event_id = p_event_id
    )
  );
END;
$$;

-- Situação da pessoa no grupo do WhatsApp do evento. Só vale em evento com grupo e
-- fora de inscrição cancelada/reembolsada; sair de "pending" exige inscrição paga.
CREATE OR REPLACE FUNCTION public.set_event_registration_whatsapp_group(
  p_registration_id UUID,
  p_status TEXT,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_registration public.event_registrations%ROWTYPE;
  v_enabled BOOLEAN;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('pending', 'added', 'declined') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Situação do grupo inválida';
  END IF;

  SELECT * INTO v_registration
  FROM public.event_registrations WHERE id = p_registration_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Inscrição não encontrada';
  END IF;

  SELECT e.whatsapp_group_enabled INTO v_enabled
  FROM public.events e WHERE e.id = v_registration.event_id;
  IF NOT COALESCE(v_enabled, false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este evento não tem grupo no WhatsApp';
  END IF;
  IF v_registration.payment_status IN ('cancelled', 'refunded') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Inscrição cancelada ou reembolsada não entra no grupo';
  END IF;
  IF p_status <> 'pending' AND v_registration.payment_status <> 'paid' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Só inscrição paga entra no controle do grupo';
  END IF;

  IF v_registration.whatsapp_group_status <> p_status THEN
    UPDATE public.event_registrations
    SET whatsapp_group_status = p_status,
        whatsapp_group_updated_at = now(),
        whatsapp_group_updated_by = p_actor_id
    WHERE id = p_registration_id
    RETURNING * INTO v_registration;
  END IF;

  RETURN jsonb_build_object(
    'id', v_registration.id,
    'event_id', v_registration.event_id,
    'whatsapp_group_status', v_registration.whatsapp_group_status,
    'whatsapp_group_updated_at', v_registration.whatsapp_group_updated_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_event_coaches(UUID, UUID[], UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_event_registration_whatsapp_group(UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_event_coaches(UUID, UUID[], UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_event_registration_whatsapp_group(UUID, TEXT, UUID) TO service_role;
