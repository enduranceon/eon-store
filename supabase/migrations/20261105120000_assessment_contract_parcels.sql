-- Carnê de boleto/PIX parcelado do Asaas (fase 1).
--
-- Caso ASS-002179 (2026-11-04): o link de cobrança foi registrado como
-- "Cartão 3x", a pessoa escolheu boleto/PIX parcelado no Asaas e pagou assim.
-- O sistema só conhece cartão parcelado (um pagamento com a agenda de créditos)
-- e exigia o valor integral para marcar a venda como paga; cada parcela de um
-- carnê é uma cobrança própria, paga em dia diferente.
--
-- O parcelamento continua sendo criado à mão no Asaas. O sistema só LÊ as
-- parcelas (GET), guarda cada uma com o seu link e, quando o administrador
-- confirma, registra o pagamento da parcela como uma linha manual confirmada
-- em asaas_payments, igual ao cartão parcelado (uma linha por parcela, com o
-- vencimento e o crédito reais). Nenhuma chamada de escrita ao Asaas.
--
-- Regras desta fase:
--   - contrato com parcelas importadas fica "pago parcial" (partially_paid)
--     enquanto faltar parcela registrada e "pago" quando a última entrar;
--   - a renovação conta como "Renovou" na primeira parcela registrada (decisão
--     do responsável, 2026-11-05); o mesmo vale para a conversão de prospect;
--   - o repasse do coach continua exigindo contrato pago (payment_status =
--     paid): só sai com o carnê fechado até a regra da fase 3 ser decidida;
--   - "Receber" (pagamento manual integral), "Reabrir pagamento" e a troca ou
--     remoção da cobrança externa recusam contrato com carnê, porque apagariam
--     as linhas por parcela;
--   - cancelar contrato com parcela registrada mantém "pago parcial" (como o
--     "pago" é mantido), para não marcar como canceladas linhas de dinheiro já
--     recebido; o estorno do carnê fica para a fase 2.
--
-- Funções (só service_role, chamadas pela api-v1):
--   import_assessment_contract_parcels            importa as parcelas lidas do Asaas
--   sync_assessment_contract_parcels              atualiza situação/datas/links das parcelas
--   record_assessment_contract_parcel_payment     registra o pagamento de uma parcela
--   reopen_assessment_contract_parcel_payment     desfaz o registro de uma parcela
--   remove_assessment_contract_parcels            remove o carnê importado (sem parcela registrada)

-- 1. Parcelas ----------------------------------------------------------------

CREATE TABLE public.assessment_contract_parcels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL
    REFERENCES public.assessment_contracts(id) ON DELETE CASCADE,
  installment_number integer NOT NULL CHECK (installment_number BETWEEN 1 AND 24),
  total_installments integer NOT NULL CHECK (total_installments BETWEEN 2 AND 24),
  asaas_installment_id text NOT NULL
    CHECK (asaas_installment_id ~ '^[A-Za-z0-9_-]{6,80}$'),
  asaas_payment_id text NOT NULL UNIQUE
    CHECK (asaas_payment_id ~ '^pay_[A-Za-z0-9]{6,40}$'),
  billing_type text CHECK (billing_type IS NULL OR billing_type ~ '^[A-Z_]{3,30}$'),
  value numeric(12,2) NOT NULL CHECK (value > 0),
  due_date date NOT NULL,
  asaas_status text NOT NULL CHECK (asaas_status ~ '^[A-Z_]{3,40}$'),
  invoice_url text CHECK (
    invoice_url IS NULL
    OR (length(invoice_url) <= 2048 AND invoice_url ~ '^https://[^[:space:][:cntrl:]]+$')
  ),
  paid_date date,
  credit_date date,
  payment_row_id uuid REFERENCES public.asaas_payments(id) ON DELETE SET NULL,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, installment_number),
  CHECK (installment_number <= total_installments)
);

CREATE UNIQUE INDEX assessment_contract_parcels_payment_row_idx
  ON public.assessment_contract_parcels (payment_row_id)
  WHERE payment_row_id IS NOT NULL;
CREATE INDEX assessment_contract_parcels_installment_idx
  ON public.assessment_contract_parcels (asaas_installment_id);
CREATE INDEX assessment_contract_parcels_open_due_idx
  ON public.assessment_contract_parcels (due_date)
  WHERE payment_row_id IS NULL;

COMMENT ON TABLE public.assessment_contract_parcels IS
  'Parcelas de boleto/PIX parcelado (carnê) do Asaas ligadas a um contrato. Lidas do Asaas (só GET) e gravadas por import_assessment_contract_parcels; payment_row_id aponta a linha manual de asaas_payments criada quando o administrador registra o pagamento da parcela.';

ALTER TABLE public.assessment_contract_parcels ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_admin_only ON public.assessment_contract_parcels
  FOR ALL TO authenticated
  USING ((SELECT eon_private.is_app_admin()))
  WITH CHECK ((SELECT eon_private.is_app_admin()));
CREATE POLICY app_admin_read ON public.assessment_contract_parcels
  FOR SELECT TO authenticated
  USING ((SELECT eon_private.is_app_admin()));

REVOKE ALL ON public.assessment_contract_parcels FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.assessment_contract_parcels FROM authenticated;
GRANT SELECT ON public.assessment_contract_parcels TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assessment_contract_parcels TO service_role;

-- 2. Importar as parcelas ------------------------------------------------------

CREATE FUNCTION public.import_assessment_contract_parcels(
  p_contract_id uuid,
  p_parcels jsonb,
  p_expected_updated_at timestamptz,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_contract public.assessment_contracts%ROWTYPE;
  v_previous public.assessment_contracts%ROWTYPE;
  v_count integer;
  v_total numeric;
  v_sum numeric;
  v_installment_id text;
  v_other_number text;
  v_next_payment_status text;
  v_next_status text;
  v_first_due date;
  v_parcels jsonb;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF jsonb_typeof(p_parcels) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_parcels) NOT BETWEEN 2 AND 24 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe de 2 a 24 parcelas';
  END IF;
  v_count := jsonb_array_length(p_parcels);

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_parcels) AS item(value)
    WHERE jsonb_typeof(item.value) <> 'object'
       OR coalesce(item.value->>'installment_number', '') !~ '^[0-9]{1,2}$'
       OR coalesce(item.value->>'value', '') !~ '^[0-9]{1,9}(\.[0-9]{1,2})?$'
       OR coalesce(item.value->>'due_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       OR coalesce(item.value->>'asaas_payment_id', '') !~ '^pay_[A-Za-z0-9]{6,40}$'
       OR coalesce(item.value->>'asaas_installment_id', '') !~ '^[A-Za-z0-9_-]{6,80}$'
       OR coalesce(item.value->>'asaas_status', '') !~ '^[A-Z_]{3,40}$'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Parcela inválida';
  END IF;
  IF (SELECT count(DISTINCT (item.value->>'installment_number')::integer)
        FROM jsonb_array_elements(p_parcels) AS item(value)) <> v_count
     OR (SELECT min((item.value->>'installment_number')::integer)
           FROM jsonb_array_elements(p_parcels) AS item(value)) <> 1
     OR (SELECT max((item.value->>'installment_number')::integer)
           FROM jsonb_array_elements(p_parcels) AS item(value)) <> v_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'As parcelas precisam ser numeradas de 1 até o total, sem repetir';
  END IF;
  IF (SELECT count(DISTINCT item.value->>'asaas_installment_id')
        FROM jsonb_array_elements(p_parcels) AS item(value)) <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'As parcelas precisam ser do mesmo parcelamento';
  END IF;
  IF (SELECT count(DISTINCT item.value->>'asaas_payment_id')
        FROM jsonb_array_elements(p_parcels) AS item(value)) <> v_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Cobranças repetidas no parcelamento';
  END IF;
  v_installment_id := p_parcels->0->>'asaas_installment_id';

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF v_contract.status IN ('cancelled', 'voided', 'finished') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este contrato não aceita nova cobrança';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.assessment_contract_parcels WHERE contract_id = p_contract_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Este contrato já tem as parcelas importadas. Use "Atualizar parcelas".';
  END IF;
  IF v_contract.payment_status NOT IN ('pending', 'awaiting_charge', 'charge_sent', 'overdue') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'O pagamento deste contrato já foi iniciado ou concluído';
  END IF;
  IF nullif(v_contract.asaas_charge_id, '') IS NOT NULL
     OR nullif(v_contract.asaas_payment_link, '') IS NOT NULL
     OR nullif(v_contract.asaas_pix_copy, '') IS NOT NULL
     OR nullif(v_contract.asaas_pix_qrcode, '') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este contrato já possui cobrança Asaas';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.asaas_payments
    WHERE order_id = p_contract_id
      AND order_type = 'contract'
      AND status IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este contrato já tem pagamento registrado';
  END IF;

  SELECT contract.contract_number
  INTO v_other_number
  FROM public.assessment_contract_parcels AS parcel
  JOIN public.assessment_contracts AS contract ON contract.id = parcel.contract_id
  WHERE parcel.contract_id <> p_contract_id
    AND parcel.asaas_payment_id IN (
      SELECT item.value->>'asaas_payment_id' FROM jsonb_array_elements(p_parcels) AS item(value)
    )
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Estas parcelas já estão no contrato ' || v_other_number;
  END IF;

  IF p_expected_updated_at IS NULL
     OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  v_total := GREATEST(
    0,
    COALESCE(
      (v_contract.plan_snapshot->>'price_total')::numeric,
      (SELECT plan.price_total FROM public.assessment_plans AS plan WHERE plan.id = v_contract.plan_id),
      0
    )
    + COALESCE(v_contract.enrollment_fee, 0)
    - COALESCE(v_contract.manual_discount, 0)
    - COALESCE(v_contract.credit_balance, 0)
  );
  SELECT round(sum((item.value->>'value')::numeric), 2) INTO v_sum
  FROM jsonb_array_elements(p_parcels) AS item(value);
  IF abs(v_sum - round(v_total, 2)) > 0.05 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = format(
        'A soma das parcelas (R$ %s) é diferente do valor do contrato (R$ %s). Confira o valor do parcelamento no Asaas ou o desconto do contrato.',
        replace(to_char(v_sum, 'FM999999990.00'), '.', ','),
        replace(to_char(round(v_total, 2), 'FM999999990.00'), '.', ',')
      );
  END IF;

  INSERT INTO public.assessment_contract_parcels (
    contract_id, installment_number, total_installments, asaas_installment_id,
    asaas_payment_id, billing_type, value, due_date, asaas_status, invoice_url,
    paid_date, credit_date, last_synced_at
  )
  SELECT p_contract_id,
         (item.value->>'installment_number')::integer,
         v_count,
         v_installment_id,
         item.value->>'asaas_payment_id',
         nullif(item.value->>'billing_type', ''),
         round((item.value->>'value')::numeric, 2),
         (item.value->>'due_date')::date,
         item.value->>'asaas_status',
         nullif(item.value->>'invoice_url', ''),
         nullif(item.value->>'paid_date', '')::date,
         nullif(item.value->>'credit_date', '')::date,
         now()
  FROM jsonb_array_elements(p_parcels) AS item(value);

  SELECT min(parcel.due_date) INTO v_first_due
  FROM public.assessment_contract_parcels AS parcel
  WHERE parcel.contract_id = p_contract_id;

  v_previous := v_contract;
  v_next_payment_status := CASE
    WHEN v_contract.payment_status IN ('pending', 'awaiting_charge') THEN 'charge_sent'
    ELSE v_contract.payment_status
  END;
  v_next_status := CASE
    WHEN v_contract.status = 'draft' AND v_contract.start_date > v_today THEN 'scheduled'
    WHEN v_contract.status = 'draft' THEN 'active'
    ELSE v_contract.status
  END;

  UPDATE public.assessment_contracts
  SET payment_method = 'carne_boleto_pix',
      installments = v_count,
      due_date = v_first_due,
      payment_status = v_next_payment_status,
      status = v_next_status,
      updated_at = now()
  WHERE id = p_contract_id
  RETURNING * INTO v_contract;

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'installment_number', parcel.installment_number,
      'value', parcel.value,
      'due_date', parcel.due_date,
      'asaas_payment_id', parcel.asaas_payment_id,
      'asaas_status', parcel.asaas_status
    ) ORDER BY parcel.installment_number
  ), '[]'::jsonb)
  INTO v_parcels
  FROM public.assessment_contract_parcels AS parcel
  WHERE parcel.contract_id = p_contract_id;

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    p_contract_id,
    'parcels_imported',
    jsonb_build_object(
      'asaas_installment_id', v_installment_id,
      'total_installments', v_count,
      'total_value', v_sum,
      'parcels', v_parcels,
      'previous_payment_method', v_previous.payment_method,
      'previous_installments', v_previous.installments,
      'previous_due_date', v_previous.due_date,
      'payment_status_before', v_previous.payment_status,
      'payment_status_after', v_next_payment_status
    ),
    'Parcelas de boleto/PIX parcelado importadas do Asaas',
    p_actor_id
  );

  IF v_previous.status = 'draft' THEN
    INSERT INTO public.assessment_contract_event(
      contract_id, event_type, payload, created_by
    ) VALUES (
      p_contract_id,
      CASE
        WHEN v_previous.parent_contract_id IS NOT NULL
             AND v_next_status = 'scheduled' THEN 'renewal_scheduled'
        ELSE 'enrollment_activated'
      END,
      jsonb_build_object(
        'source', 'parcels_import',
        'status_after', v_next_status,
        'start_date', v_contract.start_date
      ),
      p_actor_id
    );
  END IF;

  RETURN jsonb_build_object(
    'contract', to_jsonb(v_contract),
    'parcels', (
      SELECT coalesce(jsonb_agg(to_jsonb(parcel) ORDER BY parcel.installment_number), '[]'::jsonb)
      FROM public.assessment_contract_parcels AS parcel
      WHERE parcel.contract_id = p_contract_id
    )
  );
END;
$$;

-- 3. Atualizar as parcelas (só leitura do Asaas) --------------------------------

CREATE FUNCTION public.sync_assessment_contract_parcels(
  p_contract_id uuid,
  p_parcels jsonb,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_updated integer;
  v_unknown jsonb;
  v_missing jsonb;
  v_next_due date;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF jsonb_typeof(p_parcels) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_parcels) NOT BETWEEN 1 AND 24 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe de 1 a 24 parcelas';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_parcels) AS item(value)
    WHERE jsonb_typeof(item.value) <> 'object'
       OR coalesce(item.value->>'value', '') !~ '^[0-9]{1,9}(\.[0-9]{1,2})?$'
       OR coalesce(item.value->>'due_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       OR coalesce(item.value->>'asaas_payment_id', '') !~ '^pay_[A-Za-z0-9]{6,40}$'
       OR coalesce(item.value->>'asaas_status', '') !~ '^[A-Z_]{3,40}$'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Parcela inválida';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.assessment_contract_parcels WHERE contract_id = p_contract_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este contrato não tem parcelas importadas';
  END IF;

  -- Parcela já registrada guarda o que foi registrado; só a situação no Asaas
  -- e o link se atualizam.
  WITH incoming AS (
    SELECT item.value AS data FROM jsonb_array_elements(p_parcels) AS item(value)
  ), changed AS (
    UPDATE public.assessment_contract_parcels AS parcel
    SET asaas_status = incoming.data->>'asaas_status',
        billing_type = CASE
          WHEN parcel.payment_row_id IS NULL
            THEN coalesce(nullif(incoming.data->>'billing_type', ''), parcel.billing_type)
          ELSE parcel.billing_type END,
        value = CASE
          WHEN parcel.payment_row_id IS NULL
            THEN round((incoming.data->>'value')::numeric, 2)
          ELSE parcel.value END,
        due_date = CASE
          WHEN parcel.payment_row_id IS NULL
            THEN (incoming.data->>'due_date')::date
          ELSE parcel.due_date END,
        invoice_url = coalesce(nullif(incoming.data->>'invoice_url', ''), parcel.invoice_url),
        paid_date = CASE
          WHEN parcel.payment_row_id IS NULL
            THEN nullif(incoming.data->>'paid_date', '')::date
          ELSE parcel.paid_date END,
        credit_date = CASE
          WHEN parcel.payment_row_id IS NULL
            THEN nullif(incoming.data->>'credit_date', '')::date
          ELSE parcel.credit_date END,
        last_synced_at = now(),
        updated_at = now()
    FROM incoming
    WHERE parcel.contract_id = p_contract_id
      AND parcel.asaas_payment_id = incoming.data->>'asaas_payment_id'
    RETURNING parcel.asaas_payment_id
  )
  SELECT count(*) INTO v_updated FROM changed;

  SELECT coalesce(jsonb_agg(item.value->>'asaas_payment_id'), '[]'::jsonb)
  INTO v_unknown
  FROM jsonb_array_elements(p_parcels) AS item(value)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.assessment_contract_parcels AS parcel
    WHERE parcel.contract_id = p_contract_id
      AND parcel.asaas_payment_id = item.value->>'asaas_payment_id'
  );
  SELECT coalesce(jsonb_agg(parcel.asaas_payment_id ORDER BY parcel.installment_number), '[]'::jsonb)
  INTO v_missing
  FROM public.assessment_contract_parcels AS parcel
  WHERE parcel.contract_id = p_contract_id
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_parcels) AS item(value)
      WHERE item.value->>'asaas_payment_id' = parcel.asaas_payment_id
    );

  -- O vencimento do contrato acompanha a próxima parcela ainda não registrada.
  SELECT min(parcel.due_date) INTO v_next_due
  FROM public.assessment_contract_parcels AS parcel
  WHERE parcel.contract_id = p_contract_id
    AND parcel.payment_row_id IS NULL
    AND parcel.asaas_status NOT IN ('DELETED', 'REFUNDED');
  IF v_next_due IS NOT NULL AND v_contract.due_date IS DISTINCT FROM v_next_due THEN
    UPDATE public.assessment_contracts
    SET due_date = v_next_due, updated_at = now()
    WHERE id = p_contract_id
    RETURNING * INTO v_contract;
  END IF;

  RETURN jsonb_build_object(
    'contract', to_jsonb(v_contract),
    'updated', v_updated,
    'unknown_payment_ids', v_unknown,
    'missing_payment_ids', v_missing,
    'parcels', (
      SELECT coalesce(jsonb_agg(to_jsonb(parcel) ORDER BY parcel.installment_number), '[]'::jsonb)
      FROM public.assessment_contract_parcels AS parcel
      WHERE parcel.contract_id = p_contract_id
    )
  );
END;
$$;

-- 4. Registrar o pagamento de uma parcela ----------------------------------------

CREATE FUNCTION public.record_assessment_contract_parcel_payment(
  p_contract_id uuid,
  p_parcel_id uuid,
  p_payment_date date,
  p_credit_date date,
  p_expected_updated_at timestamptz,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_contract public.assessment_contracts%ROWTYPE;
  v_parcel public.assessment_contract_parcels%ROWTYPE;
  v_credit date;
  v_row_id uuid := gen_random_uuid();
  v_recorded integer;
  v_total integer;
  v_previous_payment_status text;
  v_next_payment_status text;
  v_next_status text;
  v_next_due date;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF p_payment_date IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Data de pagamento obrigatória';
  END IF;
  IF p_payment_date > v_today THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A data do pagamento não pode estar no futuro';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  SELECT * INTO v_parcel
  FROM public.assessment_contract_parcels
  WHERE id = p_parcel_id AND contract_id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Parcela não encontrada';
  END IF;
  IF v_parcel.payment_row_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'contract', to_jsonb(v_contract),
      'parcel', to_jsonb(v_parcel),
      'unchanged', true
    );
  END IF;
  IF v_contract.payment_status IN ('cancelled', 'refunded', 'partially_refunded') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Não é possível registrar pagamento nesta venda';
  END IF;
  IF v_parcel.asaas_status NOT IN ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Esta parcela ainda não consta como paga no Asaas. Atualize as parcelas e tente de novo.';
  END IF;
  IF p_expected_updated_at IS NULL
     OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  v_credit := coalesce(p_credit_date, v_parcel.credit_date, p_payment_date);
  IF v_credit < p_payment_date THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'A data de crédito não pode ser antes da data do pagamento';
  END IF;

  INSERT INTO public.asaas_payments(
    id, asaas_payment_id, source, installment_group_id, installment_number,
    total_installments, billing_type, status, value, net_value, due_date,
    credit_date, payment_date, description, external_reference, order_id,
    order_type, raw, last_synced_at
  ) VALUES (
    v_row_id,
    'manual_' || p_contract_id::text || '_carne_' || v_parcel.installment_number
      || '_' || replace(gen_random_uuid()::text, '-', ''),
    'manual',
    v_parcel.asaas_installment_id,
    v_parcel.installment_number,
    v_parcel.total_installments,
    coalesce(v_parcel.billing_type, 'BOLETO'),
    'CONFIRMED',
    v_parcel.value,
    v_parcel.value,
    v_parcel.due_date,
    v_credit,
    p_payment_date,
    'Pagamento manual - Boleto/PIX parcelado (parcela '
      || v_parcel.installment_number || '/' || v_parcel.total_installments || ')',
    v_contract.contract_number,
    p_contract_id,
    'contract',
    jsonb_build_object(
      'asaas_payment_id', v_parcel.asaas_payment_id,
      'invoice_url', v_parcel.invoice_url,
      'recorded_by', 'assessment_contract_parcels'
    ),
    now()
  );

  UPDATE public.assessment_contract_parcels
  SET payment_row_id = v_row_id,
      paid_date = p_payment_date,
      credit_date = v_credit,
      updated_at = now()
  WHERE id = p_parcel_id
  RETURNING * INTO v_parcel;

  SELECT count(*) FILTER (WHERE parcel.payment_row_id IS NOT NULL)::integer,
         count(*)::integer
  INTO v_recorded, v_total
  FROM public.assessment_contract_parcels AS parcel
  WHERE parcel.contract_id = p_contract_id;

  v_previous_payment_status := v_contract.payment_status;
  v_next_payment_status := CASE WHEN v_recorded = v_total THEN 'paid' ELSE 'partially_paid' END;
  v_next_status := CASE
    WHEN v_contract.status = 'draft' AND v_contract.start_date > v_today THEN 'scheduled'
    WHEN v_contract.status = 'draft' THEN 'active'
    ELSE v_contract.status
  END;
  SELECT min(parcel.due_date) INTO v_next_due
  FROM public.assessment_contract_parcels AS parcel
  WHERE parcel.contract_id = p_contract_id
    AND parcel.payment_row_id IS NULL
    AND parcel.asaas_status NOT IN ('DELETED', 'REFUNDED');

  UPDATE public.assessment_contracts
  SET payment_status = v_next_payment_status,
      payment_date = LEAST(v_contract.payment_date, p_payment_date),
      payment_method = 'carne_boleto_pix',
      installments = v_total,
      manual_payment = true,
      manual_fee = NULL,
      due_date = coalesce(v_next_due, v_contract.due_date),
      status = v_next_status,
      updated_at = now()
  WHERE id = p_contract_id
  RETURNING * INTO v_contract;

  INSERT INTO public.sales_status_events(
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  ) VALUES (
    'contract',
    p_contract_id,
    v_previous_payment_status,
    v_next_payment_status,
    'installment_parcel_recorded',
    jsonb_build_object(
      'installment_number', v_parcel.installment_number,
      'total_installments', v_total,
      'value', v_parcel.value,
      'payment_date', p_payment_date,
      'credit_date', v_credit,
      'recorded_parcels', v_recorded,
      'asaas_payment_id', v_parcel.asaas_payment_id
    ),
    p_actor_id
  );

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, created_by
  ) VALUES (
    p_contract_id,
    'parcel_payment_recorded',
    jsonb_build_object(
      'installment_number', v_parcel.installment_number,
      'total_installments', v_total,
      'value', v_parcel.value,
      'payment_date', p_payment_date,
      'credit_date', v_credit,
      'recorded_parcels', v_recorded,
      'payment_status_after', v_next_payment_status,
      'asaas_payment_id', v_parcel.asaas_payment_id
    ),
    p_actor_id
  );

  RETURN jsonb_build_object(
    'contract', to_jsonb(v_contract),
    'parcel', to_jsonb(v_parcel),
    'recorded_parcels', v_recorded,
    'total_installments', v_total,
    'payment_status', v_next_payment_status
  );
END;
$$;

-- 5. Desfazer o registro de uma parcela ------------------------------------------

CREATE FUNCTION public.reopen_assessment_contract_parcel_payment(
  p_contract_id uuid,
  p_parcel_id uuid,
  p_expected_updated_at timestamptz,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_previous public.assessment_contracts%ROWTYPE;
  v_parcel public.assessment_contract_parcels%ROWTYPE;
  v_row_id uuid;
  v_recorded integer;
  v_total integer;
  v_next_payment_status text;
  v_next_due date;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  SELECT * INTO v_parcel
  FROM public.assessment_contract_parcels
  WHERE id = p_parcel_id AND contract_id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Parcela não encontrada';
  END IF;
  IF v_parcel.payment_row_id IS NULL THEN
    RETURN jsonb_build_object(
      'contract', to_jsonb(v_contract),
      'parcel', to_jsonb(v_parcel),
      'unchanged', true
    );
  END IF;
  IF v_contract.payment_status IN ('cancelled', 'refunded', 'partially_refunded') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'O pagamento desta venda não pode ser desfeito';
  END IF;
  IF p_expected_updated_at IS NULL
     OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  v_row_id := v_parcel.payment_row_id;
  UPDATE public.assessment_contract_parcels
  SET payment_row_id = NULL, updated_at = now()
  WHERE id = p_parcel_id
  RETURNING * INTO v_parcel;
  DELETE FROM public.asaas_payments
  WHERE id = v_row_id
    AND order_id = p_contract_id
    AND order_type = 'contract'
    AND source = 'manual';

  SELECT count(*) FILTER (WHERE parcel.payment_row_id IS NOT NULL)::integer,
         count(*)::integer
  INTO v_recorded, v_total
  FROM public.assessment_contract_parcels AS parcel
  WHERE parcel.contract_id = p_contract_id;
  v_next_payment_status := CASE WHEN v_recorded = 0 THEN 'charge_sent' ELSE 'partially_paid' END;
  SELECT min(parcel.due_date) INTO v_next_due
  FROM public.assessment_contract_parcels AS parcel
  WHERE parcel.contract_id = p_contract_id
    AND parcel.payment_row_id IS NULL
    AND parcel.asaas_status NOT IN ('DELETED', 'REFUNDED');

  v_previous := v_contract;
  UPDATE public.assessment_contracts
  SET payment_status = v_next_payment_status,
      payment_date = CASE WHEN v_recorded = 0 THEN NULL ELSE v_contract.payment_date END,
      manual_payment = v_recorded > 0,
      manual_fee = NULL,
      due_date = coalesce(v_next_due, v_contract.due_date),
      updated_at = now()
  WHERE id = p_contract_id
  RETURNING * INTO v_contract;

  INSERT INTO public.sales_status_events(
    order_type, order_id, previous_status, new_status, reason, metadata, actor_id
  ) VALUES (
    'contract',
    p_contract_id,
    v_previous.payment_status,
    v_next_payment_status,
    'installment_parcel_reopened',
    jsonb_build_object(
      'installment_number', v_parcel.installment_number,
      'total_installments', v_total,
      'value', v_parcel.value,
      'recorded_parcels', v_recorded,
      'asaas_payment_id', v_parcel.asaas_payment_id
    ),
    p_actor_id
  );

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    p_contract_id,
    'parcel_payment_reverted',
    jsonb_build_object(
      'installment_number', v_parcel.installment_number,
      'total_installments', v_total,
      'value', v_parcel.value,
      'recorded_parcels', v_recorded,
      'payment_status_before', v_previous.payment_status,
      'payment_status_after', v_next_payment_status,
      'asaas_payment_id', v_parcel.asaas_payment_id
    ),
    'Registro de pagamento da parcela desfeito',
    p_actor_id
  );

  RETURN jsonb_build_object(
    'contract', to_jsonb(v_contract),
    'parcel', to_jsonb(v_parcel),
    'recorded_parcels', v_recorded,
    'total_installments', v_total,
    'payment_status', v_next_payment_status
  );
END;
$$;

-- 6. Remover o carnê importado ----------------------------------------------------

CREATE FUNCTION public.remove_assessment_contract_parcels(
  p_contract_id uuid,
  p_expected_updated_at timestamptz,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_contract public.assessment_contracts%ROWTYPE;
  v_import public.assessment_contract_event%ROWTYPE;
  v_removed integer;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;

  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Contrato não encontrado';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.assessment_contract_parcels WHERE contract_id = p_contract_id
  ) THEN
    RETURN jsonb_build_object('contract', to_jsonb(v_contract), 'unchanged', true);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.assessment_contract_parcels
    WHERE contract_id = p_contract_id AND payment_row_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Há parcela com pagamento registrado. Desfaça o registro das parcelas antes de remover o carnê.';
  END IF;
  IF p_expected_updated_at IS NULL
     OR v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'O contrato foi alterado por outra ação. Atualize a página e tente novamente';
  END IF;

  -- A importação guardou a forma de pagamento, as parcelas e o vencimento de antes.
  SELECT event.* INTO v_import
  FROM public.assessment_contract_event AS event
  WHERE event.contract_id = p_contract_id
    AND event.event_type = 'parcels_imported'
  ORDER BY event.created_at DESC
  LIMIT 1;

  DELETE FROM public.assessment_contract_parcels WHERE contract_id = p_contract_id;
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  UPDATE public.assessment_contracts
  SET payment_method = coalesce(v_import.payload->>'previous_payment_method', payment_method),
      installments = coalesce((v_import.payload->>'previous_installments')::integer, installments),
      due_date = coalesce((v_import.payload->>'previous_due_date')::date, due_date),
      updated_at = now()
  WHERE id = p_contract_id
  RETURNING * INTO v_contract;

  INSERT INTO public.assessment_contract_event(
    contract_id, event_type, payload, notes, created_by
  ) VALUES (
    p_contract_id,
    'parcels_removed',
    jsonb_build_object(
      'parcels_removed', v_removed,
      'payment_method_after', v_contract.payment_method,
      'due_date_after', v_contract.due_date
    ),
    'Parcelas importadas do Asaas removidas do contrato',
    p_actor_id
  );

  RETURN jsonb_build_object('contract', to_jsonb(v_contract), 'parcels_removed', v_removed);
END;
$$;

REVOKE ALL ON FUNCTION public.import_assessment_contract_parcels(uuid, jsonb, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_assessment_contract_parcels(uuid, jsonb, timestamptz, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.sync_assessment_contract_parcels(uuid, jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_assessment_contract_parcels(uuid, jsonb, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.record_assessment_contract_parcel_payment(uuid, uuid, date, date, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_assessment_contract_parcel_payment(uuid, uuid, date, date, timestamptz, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.reopen_assessment_contract_parcel_payment(uuid, uuid, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_assessment_contract_parcel_payment(uuid, uuid, timestamptz, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.remove_assessment_contract_parcels(uuid, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_assessment_contract_parcels(uuid, timestamptz, uuid)
  TO service_role;

COMMENT ON FUNCTION public.import_assessment_contract_parcels(uuid, jsonb, timestamptz, uuid) IS
  'Importa as parcelas de um boleto/PIX parcelado lidas do Asaas. A soma precisa fechar com o valor do contrato; não muda o pagamento.';
COMMENT ON FUNCTION public.sync_assessment_contract_parcels(uuid, jsonb, uuid) IS
  'Atualiza situação, valor, vencimento e link das parcelas importadas (dados lidos do Asaas). Parcela já registrada só atualiza a situação e o link.';
COMMENT ON FUNCTION public.record_assessment_contract_parcel_payment(uuid, uuid, date, date, timestamptz, uuid) IS
  'Registra o pagamento de uma parcela paga no Asaas como linha manual confirmada; contrato fica pago parcial até a última parcela.';
COMMENT ON FUNCTION public.reopen_assessment_contract_parcel_payment(uuid, uuid, timestamptz, uuid) IS
  'Desfaz o registro do pagamento de uma parcela (apaga a linha manual e volta o status do contrato).';
COMMENT ON FUNCTION public.remove_assessment_contract_parcels(uuid, timestamptz, uuid) IS
  'Remove o carnê importado de um contrato sem parcela registrada e devolve forma de pagamento, parcelas e vencimento de antes da importação.';

-- 7. Ajustes nas regras que já existem --------------------------------------------
--
-- Método: parte da definição vigente (pg_get_functiondef), troca um trecho exato
-- por vez e aborta se o trecho não aparecer uma única vez, para nunca aplicar
-- uma correção parcial.

DO $do$
DECLARE
  v_patch record;
  v_def text;
  v_hits integer;
BEGIN
  FOR v_patch IN
    SELECT patch.fn, patch.anchor, patch.replacement
    FROM (VALUES
      ('public.api_record_manual_payment(text,uuid,uuid,date,numeric,jsonb,uuid)'::regprocedure,
  E'  IF v_previous_status IN (\'cancelled\', \'refunded\') THEN\n',
  E'  IF p_order_type = \'contract\'\n'
  || E'     AND EXISTS (SELECT 1 FROM public.assessment_contract_parcels WHERE contract_id = p_order_id) THEN\n'
  || E'    RAISE EXCEPTION USING ERRCODE = \'P0001\',\n'
  || E'      MESSAGE = \'Este contrato tem parcelas do Asaas (carnê). Registre o pagamento de cada parcela no card de parcelas.\';\n'
  || E'  END IF;\n'
  || E'  IF v_previous_status IN (\'cancelled\', \'refunded\') THEN\n'),
      ('public.api_reopen_manual_payment(text,uuid,uuid)'::regprocedure,
  E'  IF v_payment_status = v_target_status AND NOT COALESCE(v_manual_payment, false) THEN\n',
  E'  IF p_order_type = \'contract\'\n'
  || E'     AND EXISTS (SELECT 1 FROM public.assessment_contract_parcels WHERE contract_id = p_order_id) THEN\n'
  || E'    RAISE EXCEPTION USING ERRCODE = \'P0001\',\n'
  || E'      MESSAGE = \'Este contrato tem parcelas do Asaas (carnê). Desfaça o registro da parcela no card de parcelas.\';\n'
  || E'  END IF;\n'
  || E'  IF v_payment_status = v_target_status AND NOT COALESCE(v_manual_payment, false) THEN\n'),
      ('public.save_assessment_contract_external_charge(uuid,text,date,text,text,text,timestamptz,uuid)'::regprocedure,
  E'    RAISE EXCEPTION USING ERRCODE = \'P0001\', MESSAGE = \'Este contrato não aceita nova cobrança\';\n  END IF;\n',
  E'    RAISE EXCEPTION USING ERRCODE = \'P0001\', MESSAGE = \'Este contrato não aceita nova cobrança\';\n  END IF;\n'
  || E'  IF EXISTS (SELECT 1 FROM public.assessment_contract_parcels WHERE contract_id = p_contract_id) THEN\n'
  || E'    RAISE EXCEPTION USING ERRCODE = \'P0001\',\n'
  || E'      MESSAGE = \'Este contrato tem parcelas importadas do Asaas. Remova o carnê no card de parcelas antes de trocar a cobrança.\';\n'
  || E'  END IF;\n'),
      ('public.remove_assessment_contract_external_charge(uuid,timestamptz,uuid)'::regprocedure,
  E'  IF nullif(v_contract.external_payment_link, \'\') IS NULL\n     AND nullif(v_contract.external_invoice_number, \'\') IS NULL THEN\n',
  E'  IF EXISTS (SELECT 1 FROM public.assessment_contract_parcels WHERE contract_id = p_contract_id) THEN\n'
  || E'    RAISE EXCEPTION USING ERRCODE = \'P0001\',\n'
  || E'      MESSAGE = \'Este contrato tem parcelas importadas do Asaas. Remova o carnê no card de parcelas antes de remover a cobrança.\';\n'
  || E'  END IF;\n'
  || E'  IF nullif(v_contract.external_payment_link, \'\') IS NULL\n     AND nullif(v_contract.external_invoice_number, \'\') IS NULL THEN\n'),
      ('eon_private.sync_assessment_renewal_stage()'::regprocedure,
  E'    IF NEW.payment_status = \'paid\'\n       AND OLD.payment_status IS DISTINCT FROM \'paid\' THEN\n',
  E'    IF (NEW.payment_status = \'paid\'\n        AND OLD.payment_status IS DISTINCT FROM \'paid\')\n'
  || E'       OR (NEW.payment_status = \'partially_paid\'\n'
  || E'           AND OLD.payment_status IS DISTINCT FROM \'partially_paid\'\n'
  || E'           AND EXISTS (\n'
  || E'             SELECT 1 FROM public.assessment_contract_parcels AS parcel\n'
  || E'             WHERE parcel.contract_id = NEW.id AND parcel.payment_row_id IS NOT NULL\n'
  || E'           )) THEN\n'),
      ('eon_private.sync_assessment_renewal_stage()'::regprocedure,
  E'        AND OLD.payment_status = \'paid\'\n        AND NEW.payment_status IN (\n          \'pending\', \'awaiting_charge\', \'charge_sent\', \'overdue\', \'partially_paid\'\n        )\n',
  E'        AND OLD.payment_status IN (\'paid\', \'partially_paid\')\n'
  || E'        AND NEW.payment_status IN (\n          \'pending\', \'awaiting_charge\', \'charge_sent\', \'overdue\', \'partially_paid\'\n        )\n'
  || E'        AND NOT (\n'
  || E'          NEW.payment_status = \'partially_paid\'\n'
  || E'          AND EXISTS (\n'
  || E'            SELECT 1 FROM public.assessment_contract_parcels AS parcel\n'
  || E'            WHERE parcel.contract_id = NEW.id AND parcel.payment_row_id IS NOT NULL\n'
  || E'          )\n'
  || E'        )\n'),
      ('public.sync_assessment_prospect_conversion()'::regprocedure,
  E'     AND NEW.payment_status = \'paid\'\n     AND OLD.payment_status IS DISTINCT FROM NEW.payment_status THEN\n',
  E'     AND (\n'
  || E'       NEW.payment_status = \'paid\'\n'
  || E'       OR (\n'
  || E'         NEW.payment_status = \'partially_paid\'\n'
  || E'         AND EXISTS (\n'
  || E'           SELECT 1 FROM public.assessment_contract_parcels AS parcel\n'
  || E'           WHERE parcel.contract_id = NEW.id AND parcel.payment_row_id IS NOT NULL\n'
  || E'         )\n'
  || E'       )\n'
  || E'     )\n'
  || E'     AND OLD.payment_status IS DISTINCT FROM NEW.payment_status THEN\n'),
      ('public.normalize_contract_on_cancel()'::regprocedure,
  E'    IF NEW.payment_status IN (\'pending\',\'awaiting_charge\',\'message_sent\',\'charge_sent\',\'partially_paid\',\'overdue\') THEN\n',
  E'    IF NEW.payment_status IN (\'pending\',\'awaiting_charge\',\'message_sent\',\'charge_sent\',\'partially_paid\',\'overdue\')\n'
  || E'       AND NOT (\n'
  || E'         NEW.payment_status = \'partially_paid\'\n'
  || E'         AND EXISTS (\n'
  || E'           SELECT 1 FROM public.assessment_contract_parcels AS parcel\n'
  || E'           WHERE parcel.contract_id = NEW.id AND parcel.payment_row_id IS NOT NULL\n'
  || E'         )\n'
  || E'       ) THEN\n')
    ) AS patch(fn, anchor, replacement)
  LOOP
    v_def := pg_get_functiondef(v_patch.fn);
    v_hits := (length(v_def) - length(replace(v_def, v_patch.anchor, '')))
      / length(v_patch.anchor);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'patch %: trecho encontrado % vez(es), esperado 1: %',
        v_patch.fn, v_hits, left(v_patch.anchor, 80);
    END IF;
    EXECUTE replace(v_def, v_patch.anchor, v_patch.replacement);
  END LOOP;
END
$do$;

-- 8. Conferência do quadro: "Renovou" com carnê parcialmente pago é normal --------

CREATE OR REPLACE VIEW public.assessment_renewal_pipeline_issues
WITH (security_invoker = true)
AS
WITH params AS (
  SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS today
),
contracts AS (
  SELECT contract.*,
    COALESCE(
      CASE
        WHEN COALESCE(contract.plan_snapshot->>'period_months', '') ~ '^[0-9]+$'
          THEN (contract.plan_snapshot->>'period_months')::integer
      END,
      plan.period_months,
      CASE COALESCE(contract.plan_snapshot->>'period', plan.period)
        WHEN 'mensal' THEN 1
        WHEN 'trimestral' THEN 3
        WHEN 'semestral' THEN 6
        WHEN 'anual' THEN 12
      END,
      1
    ) AS period_months
  FROM public.assessment_contracts AS contract
  LEFT JOIN public.assessment_plans AS plan ON plan.id = contract.plan_id
)
SELECT child.id AS contract_id, child.contract_number, child.customer_id,
       child.parent_contract_id, 'paid_but_open_stage'::text AS issue_code,
       'Pagamento confirmado, mas a renovação não está em Renovou'::text AS issue_label,
       jsonb_build_object('renewal_stage', child.renewal_stage, 'payment_status', child.payment_status) AS details
FROM contracts AS child
WHERE child.parent_contract_id IS NOT NULL
  AND child.renewal_stage IN ('contact_pending', 'waiting_response', 'charge_pending', 'waiting_payment')
  AND (
    child.payment_status = 'paid'
    OR (child.payment_status = 'partially_paid'
        AND EXISTS (SELECT 1 FROM public.assessment_contract_parcels AS parcel WHERE parcel.contract_id = child.id AND parcel.payment_row_id IS NOT NULL))
  )
UNION ALL
SELECT child.id, child.contract_number, child.customer_id, child.parent_contract_id,
       'renewed_without_payment',
       'Renovação marcada como Renovou sem pagamento confirmado',
       jsonb_build_object('payment_status', child.payment_status, 'status', child.status)
FROM contracts AS child
WHERE child.parent_contract_id IS NOT NULL
  AND child.renewal_stage = 'renewed'
  AND child.payment_status NOT IN ('paid', 'refunded', 'partially_refunded')
  AND NOT (child.payment_status = 'partially_paid'
           AND EXISTS (SELECT 1 FROM public.assessment_contract_parcels AS parcel WHERE parcel.contract_id = child.id AND parcel.payment_row_id IS NOT NULL))
UNION ALL
SELECT child.id, child.contract_number, child.customer_id, child.parent_contract_id,
       'stage_behind_open_sale',
       'Venda já aberta no Financeiro, mas a renovação está antes da cobrança',
       jsonb_build_object('renewal_stage', child.renewal_stage, 'status', child.status)
FROM contracts AS child
WHERE child.parent_contract_id IS NOT NULL
  AND child.renewal_stage IN ('contact_pending', 'waiting_response', 'charge_pending')
  AND child.status NOT IN ('draft', 'voided', 'cancelled')
UNION ALL
SELECT child.id, child.contract_number, child.customer_id, child.parent_contract_id,
       'waiting_payment_without_open_sale',
       'Aguardando pagamento, mas a venda ainda é rascunho',
       jsonb_build_object('status', child.status)
FROM contracts AS child
WHERE child.parent_contract_id IS NOT NULL
  AND child.renewal_stage = 'waiting_payment'
  AND child.status = 'draft'
UNION ALL
SELECT child.id, child.contract_number, child.customer_id, child.parent_contract_id,
       'mixed_charge',
       'Renovação com cobrança Asaas e cobrança externa ao mesmo tempo',
       jsonb_build_object('renewal_stage', child.renewal_stage)
FROM contracts AS child
WHERE child.parent_contract_id IS NOT NULL
  AND child.renewal_stage IN ('contact_pending', 'waiting_response', 'charge_pending', 'waiting_payment')
  AND NULLIF(child.asaas_charge_id, '') IS NOT NULL
  AND (NULLIF(child.external_payment_link, '') IS NOT NULL
       OR NULLIF(child.external_invoice_number, '') IS NOT NULL)
UNION ALL
SELECT parent.id, parent.contract_number, parent.customer_id, NULL::uuid,
       CASE WHEN parent.end_date < params.today
         THEN 'expired_without_renewal' ELSE 'renewal_not_created' END,
       CASE WHEN parent.end_date < params.today
         THEN 'Contrato venceu sem renovação no quadro'
         ELSE 'Renovação deveria estar no quadro e ainda não foi criada' END,
       jsonb_build_object(
         'end_date', parent.end_date,
         'auto_renewal', parent.auto_renewal AND parent.period_months = 1
       )
FROM contracts AS parent
CROSS JOIN params
WHERE parent.status IN ('active', 'overdue', 'on_leave')
  AND NOT COALESCE(parent.renewal_generated, false)
  AND parent.scheduled_cancellation_date IS NULL
  AND parent.cancellation_date IS NULL
  AND NULLIF(btrim(parent.cancellation_reason), '') IS NULL
  -- Licença sem data de volta: o fim real ainda não existe e a rotina diária não
  -- cria renovação para ela (mesma regra de process_internal_assessment_renewals).
  AND NOT EXISTS (
    SELECT 1 FROM public.assessment_leaves AS open_leave
    WHERE open_leave.contract_id = parent.id
      AND open_leave.status = 'active'
      AND open_leave.end_date IS NULL
  )
  AND parent.end_date <= params.today + CASE
    WHEN parent.auto_renewal AND parent.period_months = 1 THEN 4
    ELSE 9
  END
  AND NOT EXISTS (
    SELECT 1 FROM public.assessment_contracts AS child
    WHERE child.parent_contract_id = parent.id
      AND child.status IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave')
  )
UNION ALL
SELECT contract.id, contract.contract_number, contract.customer_id, contract.parent_contract_id,
       'non_monthly_auto_renewal',
       'Renovação automática ligada em plano que não é mensal',
       jsonb_build_object('period_months', contract.period_months)
FROM contracts AS contract
WHERE contract.auto_renewal
  AND contract.period_months <> 1
  AND contract.status IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave');

REVOKE ALL ON public.assessment_renewal_pipeline_issues FROM PUBLIC, anon;
GRANT SELECT ON public.assessment_renewal_pipeline_issues TO authenticated, service_role;

COMMENT ON VIEW public.assessment_renewal_pipeline_issues IS
  'Renovações que precisam de conferência (etapa x pagamento, renovação que não entrou no quadro, automática em plano não mensal). Contrato em licença sem data de volta fica fora da checagem de renovação; carnê com parcela registrada conta como pago para a etapa Renovou. Respeita o RLS de admin.';
