-- Renovação mensal automática = assinatura no Asaas.
--
-- O aluno do plano mensal com renovação automática paga por uma assinatura do
-- Asaas, que gera uma fatura nova por mês e avisa a pessoa por lá. Até aqui o
-- link de cada fatura era colado à mão no contrato da renovação. Agora o
-- backend (prepare-renewals, todo dia, e o botão "Buscar link no Asaas")
-- descobre a assinatura pelo link da fatura de um contrato anterior, consulta
-- as faturas dela (só leitura) e grava aqui o link do mês. Nada é criado,
-- alterado ou cancelado no Asaas; o pagamento continua sendo registrado pela
-- conferência manual de sempre.

ALTER TABLE public.assessment_contracts
  ADD COLUMN IF NOT EXISTS asaas_subscription_id text,
  ADD COLUMN IF NOT EXISTS subscription_link_status text,
  ADD COLUMN IF NOT EXISTS subscription_link_note text,
  ADD COLUMN IF NOT EXISTS subscription_link_checked_at timestamptz;

ALTER TABLE public.assessment_contracts
  ADD CONSTRAINT assessment_contracts_asaas_subscription_id_check
    CHECK (asaas_subscription_id IS NULL OR asaas_subscription_id ~ '^sub_[A-Za-z0-9]{4,40}$'),
  ADD CONSTRAINT assessment_contracts_subscription_link_status_check
    CHECK (subscription_link_status IS NULL OR subscription_link_status IN (
      'attached', 'value_mismatch', 'waiting_invoice', 'no_subscription',
      'customer_mismatch', 'asaas_error'
    )),
  ADD CONSTRAINT assessment_contracts_subscription_link_note_check
    CHECK (subscription_link_note IS NULL OR char_length(subscription_link_note) <= 300);

COMMENT ON COLUMN public.assessment_contracts.asaas_subscription_id IS
  'Assinatura do Asaas (sub_...) da renovação mensal automática, descoberta pela fatura de um contrato anterior.';
COMMENT ON COLUMN public.assessment_contracts.subscription_link_status IS
  'Última busca do link da fatura na assinatura: attached, value_mismatch (gravado com aviso), waiting_invoice, no_subscription, customer_mismatch ou asaas_error.';

-- A gravação do link segue a mesma regra da cobrança externa colada à mão,
-- com a origem asaas_subscription no histórico do contrato.
DO $do$
DECLARE
  v_def text;
  v_source_anchor constant text := $a$  IF p_source NOT IN ('contract_detail', 'renewals_page') THEN$a$;
  v_notes_anchor constant text := $a$CASE WHEN p_source = 'renewals_page'$a$;
BEGIN
  v_def := pg_get_functiondef(
    'public.save_assessment_contract_external_charge(uuid,text,date,text,text,text,timestamptz,uuid)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, v_source_anchor, ''))) / length(v_source_anchor) <> 1
     OR (length(v_def) - length(replace(v_def, v_notes_anchor, ''))) / length(v_notes_anchor) <> 1 THEN
    RAISE EXCEPTION 'save_assessment_contract_external_charge: trecho da origem não encontrado uma única vez';
  END IF;
  v_def := replace(v_def, v_source_anchor,
    $a$  IF p_source NOT IN ('contract_detail', 'renewals_page', 'asaas_subscription') THEN$a$);
  v_def := replace(v_def, v_notes_anchor,
    $a$CASE WHEN p_source = 'asaas_subscription'
      THEN 'Link da fatura buscado na assinatura do Asaas'
      WHEN p_source = 'renewals_page'$a$);
  EXECUTE v_def;
END
$do$;

-- Resultado de uma busca na assinatura. Com fatura (attached ou
-- value_mismatch), grava o link como cobrança externa; nos outros casos só
-- guarda o que aconteceu, para o card mostrar. Contrato que já tem link ou já
-- foi pago não é tocado.
CREATE OR REPLACE FUNCTION public.apply_assessment_subscription_lookup(
  p_contract_id uuid,
  p_subscription_id text,
  p_status text,
  p_note text,
  p_invoice jsonb,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_link text;
  v_due date;
  v_method text;
  v_invoice_number text;
  v_saved jsonb;
BEGIN
  IF p_status IS NULL OR p_status NOT IN (
    'attached', 'value_mismatch', 'waiting_invoice', 'no_subscription',
    'customer_mismatch', 'asaas_error'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado da busca inválido';
  END IF;
  IF p_subscription_id IS NOT NULL AND p_subscription_id !~ '^sub_[A-Za-z0-9]{4,40}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Assinatura do Asaas inválida';
  END IF;
  IF p_status IN ('attached', 'value_mismatch') THEN
    IF p_subscription_id IS NULL OR p_invoice IS NULL OR jsonb_typeof(p_invoice) <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Fatura da assinatura não informada';
    END IF;
    v_link := p_invoice->>'link';
    v_method := p_invoice->>'payment_method';
    v_invoice_number := NULLIF(btrim(p_invoice->>'invoice_number'), '');
    BEGIN
      v_due := (p_invoice->>'due_date')::date;
    EXCEPTION WHEN others THEN
      v_due := NULL;
    END;
    IF v_link IS NULL OR v_link !~ '^https://www\.asaas\.com/i/[A-Za-z0-9]{6,40}$' OR v_due IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Fatura da assinatura inválida';
    END IF;
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;

  -- Só a renovação mensal automática ainda sem cobrança entra aqui.
  IF NOT v_contract.auto_renewal
     OR v_contract.parent_contract_id IS NULL
     OR v_contract.status NOT IN ('draft', 'scheduled', 'active', 'overdue')
     OR v_contract.payment_status NOT IN ('pending', 'awaiting_charge')
     OR NULLIF(v_contract.external_payment_link, '') IS NOT NULL
     OR NULLIF(v_contract.asaas_charge_id, '') IS NOT NULL
     OR NULLIF(v_contract.asaas_payment_link, '') IS NOT NULL
     OR NULLIF(v_contract.asaas_pix_copy, '') IS NOT NULL THEN
    RETURN jsonb_build_object('contract_id', p_contract_id, 'skipped', true, 'reason', 'not_eligible');
  END IF;

  -- A mesma fatura não pode ir para dois contratos.
  IF v_link IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.assessment_contracts other
    WHERE other.id <> p_contract_id
      AND rtrim(other.external_payment_link, '/') = v_link
  ) THEN
    RETURN jsonb_build_object('contract_id', p_contract_id, 'skipped', true, 'reason', 'invoice_in_use');
  END IF;

  UPDATE public.assessment_contracts
  SET asaas_subscription_id = COALESCE(p_subscription_id, asaas_subscription_id),
      subscription_link_status = p_status,
      subscription_link_note = left(NULLIF(btrim(p_note), ''), 300),
      subscription_link_checked_at = now(),
      updated_at = now()
  WHERE id = p_contract_id
  RETURNING * INTO v_contract;

  IF p_status IN ('attached', 'value_mismatch') THEN
    v_saved := public.save_assessment_contract_external_charge(
      p_contract_id,
      v_link,
      v_due,
      CASE WHEN v_method ~ '^(pix|boleto|card_([1-9]|1[0-2])x)$' THEN v_method ELSE 'pix' END,
      v_invoice_number,
      'asaas_subscription',
      v_contract.updated_at,
      p_actor_id
    );
    RETURN jsonb_build_object('contract_id', p_contract_id, 'status', p_status, 'attached', true,
                              'contract', v_saved->'contract');
  END IF;

  RETURN jsonb_build_object('contract_id', p_contract_id, 'status', p_status, 'attached', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_assessment_subscription_lookup(uuid, text, text, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_assessment_subscription_lookup(uuid, text, text, text, jsonb, uuid) TO service_role;

COMMENT ON FUNCTION public.apply_assessment_subscription_lookup(uuid, text, text, text, jsonb, uuid) IS
  'Grava o resultado da busca da fatura na assinatura do Asaas (renovação mensal automática). Só o backend chama.';
