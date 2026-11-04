-- Encerrar licença sem data de volta numa data passada.
--
-- Hoje a licença sem data só encerra "hoje": o gatilho handle_leave_change soma
-- ao fim do contrato os dias de licença até hoje. Quando a pessoa voltou antes
-- (caso ASS-000076, que voltou em 14/10) e o encerramento só foi registrado
-- dias depois, o contrato era prorrogado por dias em que ela já estava
-- treinando, e a equipe adiava o registro para não errar.
--
-- finish_assessment_contract_leave passa a aceitar a data de fim da licença
-- (p_end_date). O dia informado é o último dia de licença, como já era o
-- "hoje" do encerramento sem data: os dias somados ao fim são
-- (data de fim - início) + 1. Sem p_end_date, tudo continua como antes.
--
-- Regras da data:
--   - não pode ser antes do início da licença nem estar no futuro;
--   - não pode cair em repasse já fechado (aprovado ou pago): o dia seguinte
--     ao fim da licença precisa ser de um mês ainda aberto, a mesma regra da
--     troca de coach (eon_private.first_open_payout_day). O último dia de
--     licença pode ser o último dia do mês fechado;
--   - só vale para licença sem data de volta; a que já tem data de fim não
--     muda de data ao ser encerrada.
-- Quando existe fechamento em revisão que pega o mês da data, a resposta traz
-- regenerate_competence para a tela avisar que ele precisa ser gerado de novo.
--
-- A assinatura ganha um parâmetro com valor padrão; a antiga (4 argumentos)
-- sai, senão uma chamada com 4 argumentos ficaria ambígua. A API e a tela
-- atuais seguem funcionando sem enviar a data.

DROP FUNCTION IF EXISTS public.finish_assessment_contract_leave(uuid, uuid, timestamptz, uuid);

CREATE FUNCTION public.finish_assessment_contract_leave(
  p_contract_id uuid,
  p_leave_id uuid,
  p_expected_updated_at timestamptz,
  p_actor_id uuid,
  p_end_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_contract public.assessment_contracts%ROWTYPE;
  v_leave public.assessment_leaves%ROWTYPE;
  v_status text;
  v_end date;
  v_first_open date;
  v_regenerate date;
BEGIN
  SELECT * INTO v_contract FROM public.assessment_contracts
  WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  SELECT * INTO v_leave FROM public.assessment_leaves
  WHERE id = p_leave_id AND contract_id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Licença não encontrada';
  END IF;
  IF v_leave.status = 'finished' THEN
    RETURN jsonb_build_object('contract', to_jsonb(v_contract), 'leave', to_jsonb(v_leave), 'unchanged', true);
  END IF;
  IF v_contract.status <> 'on_leave' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato não está em licença';
  END IF;
  IF p_expected_updated_at IS NULL OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  IF v_leave.end_date IS NULL THEN
    v_end := coalesce(p_end_date, v_today);
    IF v_end < v_leave.start_date THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format(
          'A licença começou em %s; o último dia dela não pode ser antes disso',
          to_char(v_leave.start_date, 'DD/MM/YYYY')
        );
    END IF;
    IF v_end > v_today THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'O último dia da licença não pode estar no futuro';
    END IF;
    v_first_open := eon_private.first_open_payout_day();
    IF v_first_open IS NOT NULL AND v_end + 1 < v_first_open THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format(
          'O repasse até %s já foi fechado; o último dia da licença não pode ser antes de %s',
          to_char(v_first_open - 1, 'DD/MM/YYYY'),
          to_char(v_first_open - 1, 'DD/MM/YYYY')
        );
    END IF;
  ELSIF p_end_date IS NOT NULL AND p_end_date <> v_leave.end_date THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format(
        'Esta licença já tem data de fim (%s); a data não muda ao encerrar',
        to_char(v_leave.end_date, 'DD/MM/YYYY')
      );
  END IF;

  -- O gatilho handle_leave_change calcula os dias e soma ao fim do contrato.
  UPDATE public.assessment_leaves
  SET status = 'finished',
      end_date = CASE WHEN v_leave.end_date IS NULL THEN v_end ELSE end_date END,
      updated_at = now()
  WHERE id = p_leave_id
  RETURNING * INTO v_leave;

  -- O gatilho já somou os dias ao fim do contrato; v_contract ainda traz o fim
  -- de antes disso.
  SELECT * INTO v_contract FROM public.assessment_contracts WHERE id = p_contract_id;

  v_status := CASE
    WHEN v_contract.end_date < v_today THEN 'overdue'
    ELSE 'active'
  END;
  IF EXISTS (SELECT 1 FROM public.assessment_leaves WHERE contract_id = p_contract_id AND status = 'active') THEN
    v_status := 'on_leave';
  END IF;
  UPDATE public.assessment_contracts SET status = v_status, updated_at = now()
  WHERE id = p_contract_id RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(contract_id, event_type, payload, created_by)
  VALUES (p_contract_id, 'leave_ended', jsonb_build_object(
    'leave_id', v_leave.id,
    'days', v_leave.days,
    'new_status', v_status,
    'leave_start', v_leave.start_date,
    'leave_end', v_leave.end_date,
    'new_end_date', v_contract.end_date,
    'retroactive', v_leave.end_date < v_today
  ), p_actor_id);

  -- Fechamento ainda não aprovado que pega a data precisa ser gerado de novo.
  SELECT closing.competence INTO v_regenerate
  FROM public.payout_monthly_closings AS closing
  WHERE closing.status = 'pending_approval'
    AND closing.competence >= date_trunc('month', v_leave.end_date)::date
  ORDER BY closing.competence
  LIMIT 1;

  RETURN jsonb_build_object(
    'contract', to_jsonb(v_contract),
    'leave', to_jsonb(v_leave),
    'regenerate_competence', v_regenerate
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finish_assessment_contract_leave(uuid, uuid, timestamptz, uuid, date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_assessment_contract_leave(uuid, uuid, timestamptz, uuid, date)
  TO service_role;

COMMENT ON FUNCTION public.finish_assessment_contract_leave(uuid, uuid, timestamptz, uuid, date) IS
  'Encerra a licença. Sem p_end_date, o último dia é hoje; com ele, uma data passada (não antes do início, não em repasse fechado). Soma os dias de licença sem data ao fim do contrato.';
