-- Encerrar licença: o status do contrato (ativo ou vencido) é decidido com o
-- fim já somado aos dias da licença.
--
-- Ao encerrar uma licença sem data de volta, o gatilho handle_leave_change soma
-- os dias parados ao fim do contrato. finish_assessment_contract_leave lia o
-- contrato antes disso e decidia o status pelo fim antigo: se a pessoa voltava
-- depois do fim original, o contrato ficava "Vencido" mesmo com o fim novo no
-- futuro (caso ASS-000092, em 2026-10-30, corrigido à mão com o motivo
-- leave_end_stale_end_date). Agora o contrato é lido de novo depois do
-- encerramento da licença e antes de decidir o status.
--
-- A regra de somar os dias da licença ao fim não muda. Vencido continua
-- valendo quando, mesmo com os dias somados, o fim já passou.
--
-- Método: parte da definição vigente (pg_get_functiondef), troca um trecho
-- exato e aborta se ele não casar, para nunca aplicar uma correção parcial.

DO $do$
DECLARE
  v_def text;
  v_new text;
  v_anchor constant text :=
    E'  v_status := CASE\n    WHEN v_contract.end_date < (now() AT TIME ZONE ''America/Sao_Paulo'')::date THEN ''overdue''\n';
BEGIN
  SELECT pg_get_functiondef(
    'public.finish_assessment_contract_leave(uuid,uuid,timestamptz,uuid)'::regprocedure
  ) INTO v_def;

  IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'finish_assessment_contract_leave: trecho do status não encontrado uma única vez';
  END IF;

  v_new := replace(v_def, v_anchor,
    E'  -- O gatilho handle_leave_change já somou os dias parados ao fim do contrato;\n'
    || E'  -- v_contract ainda traz o fim de antes disso.\n'
    || E'  SELECT * INTO v_contract FROM public.assessment_contracts WHERE id = p_contract_id;\n'
    || E'\n'
    || v_anchor);

  EXECUTE v_new;
END
$do$;
