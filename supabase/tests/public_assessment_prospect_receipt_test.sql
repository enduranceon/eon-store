BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.submit_public_assessment_prospect(uuid,text,text,text,text,uuid,uuid,text,text,text,text,text,text,text,text,timestamptz,text,jsonb,text,text,text)',
    'EXECUTE'
  ),
  'the Edge Function service role can submit a public prospect'
);
SELECT ok(
  has_table_privilege('service_role', 'public.assessment_prospect_submissions', 'SELECT')
  AND has_table_privilege('service_role', 'public.assessment_prospect_submissions', 'INSERT')
  AND NOT has_table_privilege('service_role', 'public.assessment_prospect_submissions', 'UPDATE')
  AND NOT has_table_privilege('service_role', 'public.assessment_prospect_submissions', 'DELETE'),
  'the service role can create and confirm receipts but cannot rewrite them'
);
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.submit_public_assessment_prospect(uuid,text,text,text,text,uuid,uuid,text,text,text,text,text,text,text,text,timestamptz,text,jsonb,text,text,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.submit_public_assessment_prospect(uuid,text,text,text,text,uuid,uuid,text,text,text,text,text,text,text,text,timestamptz,text,jsonb,text,text,text)',
    'EXECUTE'
  ),
  'browser roles cannot bypass the Edge Function'
);
SELECT ok(
  NOT prosecdef AND 'search_path=""' = ANY(proconfig),
  'the intake RPC uses caller privileges and an empty search path'
)
FROM pg_catalog.pg_proc
WHERE oid = to_regprocedure(
  'public.submit_public_assessment_prospect(uuid,text,text,text,text,uuid,uuid,text,text,text,text,text,text,text,text,timestamptz,text,jsonb,text,text,text)'
);

INSERT INTO public.assessment_modalities (id, name)
VALUES ('86000000-0000-4000-a000-000000000001', 'public-prospect-receipt-test');

INSERT INTO public.assessment_plans (
  id, name, modality_id, period, period_months, price_monthly, price_total,
  max_installments, enrollment_fee, active, available_online
) VALUES (
  '86000000-0000-4000-a000-000000000002',
  'Plano público fictício',
  '86000000-0000-4000-a000-000000000001',
  'mensal', 1, 240, 240, 1, 0, true, true
);

INSERT INTO public.assessment_coaches (
  id, name, email, role, active, public_visible, modality_ids
) VALUES
  (
    '86000000-0000-4000-a000-000000000003',
    'Coach público fictício',
    'public-prospect-coach@example.test',
    'senior', true, true,
    ARRAY['86000000-0000-4000-a000-000000000001'::uuid]
  ),
  (
    '86000000-0000-4000-a000-000000000004',
    'Coach oculto fictício',
    'hidden-prospect-coach@example.test',
    'senior', true, false,
    ARRAY['86000000-0000-4000-a000-000000000001'::uuid]
  );

CREATE FUNCTION pg_temp.submit_public_prospect(
  p_request_id uuid,
  p_name text,
  p_phone text,
  p_email text,
  p_cpf text,
  p_coach_id uuid DEFAULT '86000000-0000-4000-a000-000000000003',
  p_address_zip text DEFAULT '88095122',
  p_address_street text DEFAULT 'Rua Fictícia',
  p_address_number text DEFAULT '123',
  p_address_complement text DEFAULT NULL,
  p_address_neighborhood text DEFAULT 'Bairro Fictício',
  p_address_city text DEFAULT 'Florianópolis',
  p_address_state text DEFAULT 'SC'
)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT public.submit_public_assessment_prospect(
    p_request_id,
    p_name,
    p_phone,
    p_email,
    p_cpf,
    '86000000-0000-4000-a000-000000000002',
    p_coach_id,
    'florianopolis',
    p_address_zip,
    p_address_street,
    p_address_number,
    p_address_complement,
    p_address_neighborhood,
    p_address_city,
    p_address_state,
    now(),
    'https://www.enduranceon.com.br/pages/cadastro-unificado.html',
    '{}'::jsonb,
    'ip-hash-public-prospect-test-' || p_request_id::text,
    'phone-hash-public-prospect-test-' || p_phone,
    'pgTAP public prospect test'
  );
$$;

CREATE TEMPORARY TABLE public_prospect_results (
  scenario text PRIMARY KEY,
  result jsonb NOT NULL
);
GRANT SELECT, INSERT ON public_prospect_results TO service_role;

CREATE TEMPORARY TABLE public_prospect_financial_baseline AS
SELECT count(*) AS payment_count FROM public.asaas_payments;
GRANT SELECT ON public_prospect_financial_baseline TO service_role;

SET LOCAL ROLE service_role;

INSERT INTO public_prospect_results (scenario, result)
VALUES (
  'created',
  pg_temp.submit_public_prospect(
    '86000000-0000-4000-a000-000000000010',
    'Pessoa Pública Fictícia',
    '+5548999990010',
    'public-prospect@example.test',
    '52998224725'
  )
);

INSERT INTO public_prospect_results (scenario, result)
VALUES (
  'duplicate',
  pg_temp.submit_public_prospect(
    '86000000-0000-4000-a000-000000000010',
    'Pessoa Pública Fictícia',
    '+5548999990010',
    'public-prospect@example.test',
    '52998224725'
  )
);

SELECT is(
  (SELECT result->>'status' FROM public_prospect_results WHERE scenario = 'created'),
  'created',
  'a first submission is created'
);
SELECT ok(
  (SELECT result ?& ARRAY[
    'submission_id', 'request_id', 'submitted_at', 'customer_id',
    'contract_id', 'contract_number'
  ] FROM public_prospect_results WHERE scenario = 'created'),
  'the created response contains a durable receipt and contract reference'
);
SELECT is(
  (SELECT result->>'status' FROM public_prospect_results WHERE scenario = 'duplicate'),
  'duplicate',
  'a same-key retry is idempotent'
);
SELECT is(
  (SELECT result->>'submission_id' FROM public_prospect_results WHERE scenario = 'created'),
  (SELECT result->>'submission_id' FROM public_prospect_results WHERE scenario = 'duplicate'),
  'a retry returns the original receipt'
);
SELECT is(
  (SELECT count(*)::integer
   FROM public.assessment_prospect_submissions
   WHERE request_id = '86000000-0000-4000-a000-000000000010'),
  1,
  'a retry does not duplicate the submission'
);
SELECT is(
  (SELECT count(*)::integer
   FROM eon_private.public_form_rate_limits
   WHERE ip_hash = 'ip-hash-public-prospect-test-86000000-0000-4000-a000-000000000010'),
  1,
  'a retry does not consume a second rate-limit slot'
);
SELECT throws_ok(
  $$SELECT pg_temp.submit_public_prospect(
    '86000000-0000-4000-a000-000000000010',
    'Outro Nome Fictício',
    '+5548999990010',
    'public-prospect@example.test',
    '52998224725'
  )$$,
  'P0001',
  'Esta chave de envio já foi usada com outros dados',
  'the same idempotency key cannot confirm a different identity'
);
SELECT throws_ok(
  format(
    $sql$SELECT pg_temp.submit_public_prospect(
      '86000000-0000-4000-a000-000000000010',
      'Pessoa Pública Fictícia',
      '+5548999990010',
      'public-prospect@example.test',
      '52998224725',
      %I => %L
    )$sql$,
    parameter_name,
    changed_value
  ),
  'P0001',
  'Esta chave de envio já foi usada com outros dados',
  'a retry cannot change ' || parameter_name
)
FROM (VALUES
  ('p_address_zip', '88095123'),
  ('p_address_street', 'Outra Rua Fictícia'),
  ('p_address_number', '456'),
  ('p_address_complement', 'Casa 2'),
  ('p_address_neighborhood', 'Outro Bairro Fictício'),
  ('p_address_city', 'São José'),
  ('p_address_state', 'RS')
) AS changed_address(parameter_name, changed_value);

SELECT throws_ok(
  $$SELECT pg_temp.submit_public_prospect(
    '86000000-0000-4000-a000-000000000011',
    'Pessoa com Coach Oculto',
    '+5548999990011',
    'hidden-coach@example.test',
    '11144477735',
    '86000000-0000-4000-a000-000000000004'
  )$$,
  'P0002',
  'Treinador indisponível para este plano no site',
  'a hidden coach cannot receive a public prospect'
);

RESET ROLE;

INSERT INTO public.presale_customers (
  id, full_name, whatsapp, email, cpf, coach_id
) VALUES (
  '86000000-0000-4000-a000-000000000020',
  'Cliente Canônico Protegido',
  '+5548999990020',
  'canonical@example.test',
  '39053344705',
  '86000000-0000-4000-a000-000000000003'
);

SET LOCAL ROLE service_role;

INSERT INTO public_prospect_results (scenario, result)
VALUES (
  'existing_customer',
  pg_temp.submit_public_prospect(
    '86000000-0000-4000-a000-000000000021',
    'Nome Enviado Diferente',
    '+5548999990021',
    'submitted@example.test',
    '39053344705'
  )
);

SELECT is(
  (SELECT full_name || '|' || whatsapp || '|' || email
   FROM public.presale_customers
   WHERE id = '86000000-0000-4000-a000-000000000020'),
  'Cliente Canônico Protegido|+5548999990020|canonical@example.test',
  'a public submission cannot overwrite an existing customer identity'
);
SELECT is(
  (SELECT submitted_full_name || '|' || submitted_whatsapp || '|' || submitted_email
   FROM public.assessment_prospect_submissions
   WHERE request_id = '86000000-0000-4000-a000-000000000021'),
  'Nome Enviado Diferente|+5548999990021|submitted@example.test',
  'the submitted identity remains available for administrative review'
);
SELECT is(
  (SELECT concat_ws('|',
      submitted_address_zip,
      submitted_address_street,
      submitted_address_number,
      coalesce(submitted_address_complement, ''),
      submitted_address_neighborhood,
      submitted_address_city,
      submitted_address_state
    )
   FROM public.assessment_prospect_submissions
   WHERE request_id = '86000000-0000-4000-a000-000000000021'),
  '88095122|Rua Fictícia|123||Bairro Fictício|Florianópolis|SC',
  'the submitted address remains auditable without overwriting the customer'
);
SELECT is(
  (SELECT count(*) FROM public.asaas_payments),
  (SELECT payment_count FROM public_prospect_financial_baseline),
  'public prospect intake never creates a charge'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
