-- Cobrança externa: o mesmo link não entra em dois contratos.
--
-- Um link de fatura do Asaas (www.asaas.com/i/<código>) é uma cobrança só. Em
-- 2026-10-08 o link já pago de setembro foi colado na renovação de outubro
-- (ASS-000249 e ASS-000364): a pessoa recebeu uma fatura quitada, não conseguiu
-- pagar o mês, e um pagamento manual indevido fechou a renovação. A busca da
-- fatura pela assinatura já recusa link usado por outro contrato
-- (apply_assessment_subscription_lookup, "invoice_in_use"), mas o cadastro
-- manual da cobrança externa não conferia nada.
--
-- Agora save_assessment_contract_external_charge recusa um link que outro
-- contrato (fora cancelado e anulado) já usa, dizendo qual é. Só vale quando o
-- link do contrato muda: salvar de novo o mesmo link, com outro vencimento ou
-- número da fatura, segue funcionando mesmo num contrato que já tenha um
-- repetido de antes. Hoje não há link repetido na base.
--
-- Método: parte da definição vigente (pg_get_functiondef), troca dois trechos
-- exatos e aborta se algum não casar, para nunca aplicar uma correção parcial.

DO $do$
DECLARE
  v_def text;
  v_new text;
  v_declare_anchor constant text :=
    E'  v_clean_invoice text := nullif(btrim(p_invoice_number), \'\');\nBEGIN\n';
  v_guard_anchor constant text :=
    E'  v_previous := v_contract;\n  v_event_type := CASE\n';
BEGIN
  SELECT pg_get_functiondef(
    'public.save_assessment_contract_external_charge(uuid,text,date,text,text,text,timestamptz,uuid)'::regprocedure
  ) INTO v_def;

  IF (length(v_def) - length(replace(v_def, v_declare_anchor, ''))) / length(v_declare_anchor) <> 1
     OR (length(v_def) - length(replace(v_def, v_guard_anchor, ''))) / length(v_guard_anchor) <> 1 THEN
    RAISE EXCEPTION 'save_assessment_contract_external_charge: trechos não encontrados uma única vez';
  END IF;

  v_new := replace(v_def, v_declare_anchor,
    E'  v_clean_invoice text := nullif(btrim(p_invoice_number), \'\');\n'
    || E'  v_other_number text;\n'
    || E'BEGIN\n');

  v_new := replace(v_new, v_guard_anchor,
    E'  -- O mesmo link não pode estar em outro contrato: a fatura de um é a do outro.\n'
    || E'  IF nullif(v_contract.external_payment_link, \'\') IS DISTINCT FROM p_external_link THEN\n'
    || E'    SELECT other.contract_number\n'
    || E'    INTO v_other_number\n'
    || E'    FROM public.assessment_contracts AS other\n'
    || E'    WHERE other.id <> p_contract_id\n'
    || E'      AND other.status NOT IN (\'cancelled\', \'voided\')\n'
    || E'      AND rtrim(other.external_payment_link, \'/\') = rtrim(p_external_link, \'/\')\n'
    || E'    ORDER BY other.start_date DESC, other.contract_number DESC\n'
    || E'    LIMIT 1;\n'
    || E'    IF FOUND THEN\n'
    || E'      RAISE EXCEPTION USING ERRCODE = \'P0001\',\n'
    || E'        MESSAGE = \'Este link de cobrança já está no contrato \' || v_other_number\n'
    || E'          || \'. Use o link da fatura deste contrato.\';\n'
    || E'    END IF;\n'
    || E'  END IF;\n'
    || E'\n'
    || v_guard_anchor);

  EXECUTE v_new;
END
$do$;
