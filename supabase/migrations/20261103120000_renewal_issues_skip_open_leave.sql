-- Conferência do quadro de Renovações: contrato em licença sem data de volta
-- não é "renovação que deveria estar no quadro" nem "contrato que venceu sem
-- renovação".
--
-- Desde 2026-10-17 a rotina diária não cria renovação para contrato em licença
-- aberta: o fim real só existe quando a licença acaba, porque os dias parados
-- são somados ao fim nessa hora (handle_leave_change). A conferência não
-- conhecia essa regra e apontava esses contratos assim que o fim original
-- chegava perto (e depois dele, como vencidos sem renovação). Agora usa o mesmo
-- critério da rotina. Quando a licença é encerrada, o fim é recalculado e, se a
-- renovação ainda não existir perto do novo fim, a conferência volta a apontar.
--
-- Só muda o filtro do ramo "renewal_not_created / expired_without_renewal"; as
-- colunas, os outros ramos e as permissões ficam como estavam.

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
  AND child.payment_status = 'paid'
UNION ALL
SELECT child.id, child.contract_number, child.customer_id, child.parent_contract_id,
       'renewed_without_payment',
       'Renovação marcada como Renovou sem pagamento confirmado',
       jsonb_build_object('payment_status', child.payment_status, 'status', child.status)
FROM contracts AS child
WHERE child.parent_contract_id IS NOT NULL
  AND child.renewal_stage = 'renewed'
  AND child.payment_status NOT IN ('paid', 'refunded', 'partially_refunded')
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
  'Renovações que precisam de conferência (etapa x pagamento, renovação que não entrou no quadro, automática em plano não mensal). Contrato em licença sem data de volta fica fora da checagem de renovação. Respeita o RLS de admin.';
