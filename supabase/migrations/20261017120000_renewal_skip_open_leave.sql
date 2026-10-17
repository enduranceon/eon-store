-- Renovação não nasce de contrato em licença sem data de volta.
--
-- Enquanto a licença está aberta, o fim do contrato continua o original: os
-- dias parados só são somados quando a licença é encerrada (handle_leave_change).
-- A rotina diária via esse fim, entrava 10 dias antes e abria um rascunho de
-- renovação para quem ainda nem voltou (caso de 2026-10-16). Agora o contrato
-- com licença aberta fica fora da criação automática; ao encerrar a licença, o
-- fim é recalculado e a renovação nasce 10 dias antes do novo fim. A geração
-- pedida para um contrato específico (p_contract_ids) continua liberada.
--
-- Rascunhos já abertos nessa situação, sem nenhum rastro financeiro, são
-- anulados como no cancelamento do contrato anterior, com cópia em
-- eon_private.renewal_open_leave_backup_20261017.
--
-- Método: parte da definição vigente (pg_get_functiondef), troca um trecho
-- exato e aborta se ele não casar, para nunca aplicar uma correção parcial.

DO $do$
DECLARE
  v_def text;
  v_new text;
  v_anchor constant text := E'          NOT v_forced\n          AND (\n';
BEGIN
  SELECT pg_get_functiondef(
    'eon_private.process_internal_assessment_renewals(integer,integer,uuid[])'::regprocedure
  ) INTO v_def;

  IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'process_internal_assessment_renewals: trecho da janela automática não encontrado uma única vez';
  END IF;

  v_new := replace(v_def, v_anchor, E'          NOT v_forced\n'
    || E'          -- Licença sem data de volta: o fim real ainda não existe.\n'
    || E'          AND NOT EXISTS (\n'
    || E'            SELECT 1\n'
    || E'            FROM public.assessment_leaves AS open_leave\n'
    || E'            WHERE open_leave.contract_id = parent.id\n'
    || E'              AND open_leave.status = ''active''\n'
    || E'              AND open_leave.end_date IS NULL\n'
    || E'          )\n'
    || E'          AND (\n');

  EXECUTE v_new;
END
$do$;

-- Anula rascunhos de renovação limpos cujo contrato anterior está em licença
-- aberta. Mesmos critérios de "limpo" do cancelamento do contrato anterior.
CREATE OR REPLACE FUNCTION eon_private.void_renewal_drafts_of_open_leaves()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_renewal public.assessment_contracts%ROWTYPE;
  v_count integer := 0;
  v_reason constant text := 'Contrato anterior em licença sem data de volta';
BEGIN
  FOR v_renewal IN
    SELECT renewal.*
    FROM public.assessment_contracts renewal
    JOIN public.assessment_contracts parent ON parent.id = renewal.parent_contract_id
    WHERE renewal.status = 'draft'
      AND renewal.payment_status = 'pending'
      AND EXISTS (
        SELECT 1 FROM public.assessment_leaves open_leave
        WHERE open_leave.contract_id = parent.id
          AND open_leave.status = 'active'
          AND open_leave.end_date IS NULL
      )
      AND NOT coalesce(renewal.manual_payment, false)
      AND renewal.payment_date IS NULL
      AND coalesce(renewal.refund_amount, 0) = 0
      AND renewal.refund_status IS NULL
      AND renewal.refund_date IS NULL
      AND nullif(trim(renewal.refund_notes), '') IS NULL
      AND nullif(renewal.asaas_charge_id, '') IS NULL
      AND nullif(renewal.asaas_payment_link, '') IS NULL
      AND nullif(renewal.asaas_pix_copy, '') IS NULL
      AND nullif(renewal.asaas_pix_qrcode, '') IS NULL
      AND nullif(renewal.external_payment_link, '') IS NULL
      AND nullif(renewal.external_invoice_number, '') IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.asaas_payments payment
        WHERE payment.order_type = 'contract' AND payment.order_id = renewal.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.payout_monthly_statement_items statement_item
        WHERE statement_item.contract_id = renewal.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.payout_pending_repasse pending_repasse
        WHERE pending_repasse.contract_id = renewal.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.order_operations operation
        WHERE operation.order_type = 'contract'
          AND operation.order_id = renewal.id
          AND operation.status IN ('prepared', 'reconciliation_required')
      )
    ORDER BY renewal.id
    FOR UPDATE OF renewal SKIP LOCKED
  LOOP
    UPDATE public.assessment_contracts
    SET status = 'voided',
        payment_status = 'cancelled',
        payment_method = NULL,
        payment_date = NULL,
        due_date = NULL,
        manual_payment = false,
        manual_fee = NULL,
        payment_message_sent_at = NULL,
        cancellation_date = NULL,
        cancellation_fee = 0,
        cancellation_reason = v_reason,
        updated_at = now()
    WHERE id = v_renewal.id;

    INSERT INTO public.sales_status_events (
      order_type, order_id, previous_status, new_status, reason, metadata, actor_id
    ) VALUES (
      'contract', v_renewal.id, v_renewal.payment_status, 'cancelled', v_reason,
      jsonb_build_object(
        'action', 'renewal_resolved',
        'resolution', 'discard',
        'reason_code', 'parent_on_open_leave',
        'parent_contract_id', v_renewal.parent_contract_id,
        'automatic', true
      ),
      NULL
    );

    INSERT INTO public.assessment_contract_event (
      contract_id, event_type, payload, notes, created_by
    ) VALUES (
      v_renewal.id,
      'sale_voided',
      jsonb_build_object(
        'resolution', 'discard',
        'reason_code', 'parent_on_open_leave',
        'parent_contract_id', v_renewal.parent_contract_id,
        'previous_status', v_renewal.status,
        'previous_payment_status', v_renewal.payment_status,
        'automatic', true,
        'no_financial_penalty', true
      ),
      v_reason,
      NULL
    ), (
      v_renewal.parent_contract_id,
      'renewal_discarded',
      jsonb_build_object(
        'discarded_contract_id', v_renewal.id,
        'discarded_contract_number', v_renewal.contract_number,
        'resolution', 'discard',
        'reason_code', 'parent_on_open_leave',
        'automatic', true,
        'no_financial_penalty', true
      ),
      'Rascunho anulado: o contrato está em licença sem data de volta. A renovação nasce de novo 10 dias antes do fim recalculado.',
      NULL
    );

    -- Sem outra renovação aberta, o contrato volta a poder renovar.
    UPDATE public.assessment_contracts parent
    SET renewal_generated = EXISTS (
          SELECT 1 FROM public.assessment_contracts other
          WHERE other.parent_contract_id = parent.id
            AND other.status IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave')
        ),
        updated_at = now()
    WHERE parent.id = v_renewal.parent_contract_id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION eon_private.void_renewal_drafts_of_open_leaves() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION eon_private.void_renewal_drafts_of_open_leaves() IS
  'Anula rascunhos de renovação limpos de contratos em licença sem data de volta e libera o contrato para renovar depois da licença.';

-- Cópia antes de anular (rascunho e contrato anterior, como estavam).
CREATE TABLE IF NOT EXISTS eon_private.renewal_open_leave_backup_20261017 AS
SELECT now() AS backed_up_at, contract.*
FROM public.assessment_contracts contract
WHERE false;

INSERT INTO eon_private.renewal_open_leave_backup_20261017
SELECT now(), contract.*
FROM public.assessment_contracts contract
WHERE contract.id IN (
  SELECT renewal.id
  FROM public.assessment_contracts renewal
  WHERE renewal.status = 'draft'
    AND EXISTS (
      SELECT 1 FROM public.assessment_leaves open_leave
      WHERE open_leave.contract_id = renewal.parent_contract_id
        AND open_leave.status = 'active'
        AND open_leave.end_date IS NULL
    )
  UNION
  SELECT renewal.parent_contract_id
  FROM public.assessment_contracts renewal
  WHERE renewal.status = 'draft'
    AND EXISTS (
      SELECT 1 FROM public.assessment_leaves open_leave
      WHERE open_leave.contract_id = renewal.parent_contract_id
        AND open_leave.status = 'active'
        AND open_leave.end_date IS NULL
    )
);

REVOKE ALL ON eon_private.renewal_open_leave_backup_20261017 FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  PERFORM eon_private.void_renewal_drafts_of_open_leaves();
END
$$;
