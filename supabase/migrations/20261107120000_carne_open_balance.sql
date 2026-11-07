-- Central de comunicação: o saldo de um carnê é a soma das parcelas ainda não
-- registradas.
--
-- eon_private.communication_open_balance calcula o saldo de uma venda
-- parcialmente paga somando as linhas PENDING/OVERDUE de asaas_payments. O
-- carnê de boleto/PIX parcelado (assessment_contract_parcels) guarda as parcelas
-- em aberto na própria tabela de parcelas, sem linha em asaas_payments; o saldo
-- ficava desconhecido e a Central mandava o contrato para "revisar saldo" em vez
-- de cobrar a próxima parcela (a vencida, com o link dela).
--
-- Para contrato "pago parcial" com parcelas importadas, o saldo passa a ser a
-- soma das parcelas sem pagamento registrado (fora as removidas ou estornadas
-- no Asaas). Nada muda para os outros casos.
--
-- Método: parte da definição vigente (pg_get_functiondef), troca um trecho
-- exato e aborta se ele não aparecer uma única vez.

DO $do$
DECLARE
  v_def text;
  v_new text;
  v_anchor constant text :=
    E'  IF p_payment_status IN (\'partially_paid\', \'partially_refunded\') THEN\n';
BEGIN
  SELECT pg_get_functiondef(
    'eon_private.communication_open_balance(text,uuid,text,numeric)'::regprocedure
  ) INTO v_def;

  IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'communication_open_balance: trecho não encontrado uma única vez';
  END IF;

  v_new := replace(v_def, v_anchor,
    E'  IF p_source_type = \'contract\' AND p_payment_status = \'partially_paid\'\n'
    || E'     AND EXISTS (\n'
    || E'       SELECT 1 FROM public.assessment_contract_parcels AS parcel\n'
    || E'       WHERE parcel.contract_id = p_source_id\n'
    || E'     ) THEN\n'
    || E'    SELECT coalesce(sum(parcel.value), 0) INTO v_unpaid\n'
    || E'    FROM public.assessment_contract_parcels AS parcel\n'
    || E'    WHERE parcel.contract_id = p_source_id\n'
    || E'      AND parcel.payment_row_id IS NULL\n'
    || E'      AND parcel.asaas_status NOT IN (\'DELETED\', \'REFUNDED\');\n'
    || E'    RETURN v_unpaid;\n'
    || E'  END IF;\n'
    || v_anchor);

  EXECUTE v_new;
END
$do$;
