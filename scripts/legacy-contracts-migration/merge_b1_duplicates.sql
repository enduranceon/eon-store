-- Une os 8 cadastros duplicados criados pelo lote 1 da migração de contratos
-- legados (o lote 1 procurava o cliente só pelo CPF; os cadastros antigos não
-- tinham CPF). Para cada par: backup em eon_private.customer_merge_backups,
-- contrato migrado passa para o cadastro antigo, o antigo só ganha os campos
-- vazios (CPF, nascimento, gênero, CEP...) e o duplicado é apagado.
--
-- Transação única com travas: se algum par não bater (outra pessoa, outro CPF,
-- duplicado com outras referências, já executado), nada é gravado.
-- Depois de rodar, conferir com verify_sql.py na planilha do lote 1
-- (--exclude MIG-015): deve dar zero divergências.
BEGIN;
CREATE TABLE IF NOT EXISTS eon_private.customer_merge_backups (
  merge_key text PRIMARY KEY,
  captured_at timestamptz NOT NULL DEFAULT now(),
  snapshot jsonb NOT NULL
);
REVOKE ALL ON eon_private.customer_merge_backups FROM PUBLIC, anon, authenticated;
DO $merge$
DECLARE
  n int;
  v_problems text;
BEGIN
  CREATE TEMP TABLE merge_pairs ON COMMIT DROP AS
  SELECT v.contract_number, ac.id AS contract_id, nw.id AS new_id, od.id AS old_id
  FROM (VALUES
    ('ASS-000317', '285', '045'), ('ASS-000318', '286', '061'),
    ('ASS-000320', '287', '049'), ('ASS-000321', '288', '063'),
    ('ASS-000322', '289', '073'), ('ASS-000326', '290', '076'),
    ('ASS-000327', '291', '034'), ('ASS-000332', '296', '144')
  ) AS v(contract_number, new_code, old_code)
  JOIN public.assessment_contracts ac ON ac.contract_number = v.contract_number
  JOIN public.presale_customers nw ON nw.customer_code = v.new_code AND nw.id = ac.customer_id
  JOIN public.presale_customers od ON od.customer_code = v.old_code AND od.id <> nw.id
  JOIN public.assessment_contract_creation_operations aco
    ON (aco.result->'contract'->>'id')::uuid = ac.id
   AND aco.operation_key LIKE 'legacy-migration-mig-%';
  SELECT count(*) INTO n FROM merge_pairs;
  IF n <> 8 THEN
    RAISE EXCEPTION 'esperado 8 pares, encontrado %', n;
  END IF;

  -- mesma pessoa: mesmo e-mail ou mesmo WhatsApp; o cadastro mantido não pode ter outro CPF
  SELECT string_agg(p.contract_number, ', ') INTO v_problems
  FROM merge_pairs p
  JOIN public.presale_customers nw ON nw.id = p.new_id
  JOIN public.presale_customers od ON od.id = p.old_id
  WHERE NOT (
      (nullif(btrim(nw.email), '') IS NOT NULL AND lower(btrim(od.email)) = lower(btrim(nw.email)))
      OR (nullif(regexp_replace(coalesce(nw.whatsapp, ''), '\D', '', 'g'), '') IS NOT NULL
          AND right(regexp_replace(coalesce(od.whatsapp, ''), '\D', '', 'g'), 11)
            = right(regexp_replace(nw.whatsapp, '\D', '', 'g'), 11)))
     OR (nullif(regexp_replace(coalesce(od.cpf, ''), '\D', '', 'g'), '') IS NOT NULL
         AND regexp_replace(od.cpf, '\D', '', 'g') <> regexp_replace(coalesce(nw.cpf, ''), '\D', '', 'g'));
  IF v_problems IS NOT NULL THEN
    RAISE EXCEPTION 'par sem evidência de ser a mesma pessoa: %', v_problems;
  END IF;

  -- o duplicado só pode ter o contrato migrado
  SELECT string_agg(p.contract_number, ', ') INTO v_problems
  FROM merge_pairs p
  WHERE (SELECT count(*) FROM public.assessment_contracts t WHERE t.customer_id = p.new_id) <> 1
     OR EXISTS (SELECT 1 FROM public.presale_orders t WHERE t.customer_id = p.new_id)
     OR EXISTS (SELECT 1 FROM public.stock_orders t WHERE t.customer_id = p.new_id)
     OR EXISTS (SELECT 1 FROM public.assessment_prospect_submissions t WHERE t.customer_id = p.new_id)
     OR EXISTS (SELECT 1 FROM public.event_registrations t WHERE t.customer_id = p.new_id);
  IF v_problems IS NOT NULL THEN
    RAISE EXCEPTION 'duplicado com outras referências: %', v_problems;
  END IF;

  -- backup antes de qualquer alteração
  INSERT INTO eon_private.customer_merge_backups (merge_key, snapshot)
  SELECT 'legacy_contract_migration_b1_duplicates_20260929',
         jsonb_build_object(
           'motivo', 'Lote 1 da migração de contratos legados criou cadastros duplicados (busca só por CPF). O contrato passa para o cadastro antigo, que só ganha os campos vazios, e o duplicado é apagado.',
           'pares', jsonb_agg(jsonb_build_object(
             'contrato', p.contract_number,
             'contract_id', p.contract_id,
             'cadastro_duplicado_apagado', to_jsonb(nw),
             'cadastro_mantido_antes', to_jsonb(od)
           ) ORDER BY p.contract_number))
  FROM merge_pairs p
  JOIN public.presale_customers nw ON nw.id = p.new_id
  JOIN public.presale_customers od ON od.id = p.old_id;

  UPDATE public.assessment_contracts t SET customer_id = p.old_id
  FROM merge_pairs p WHERE t.customer_id = p.new_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 8 THEN
    RAISE EXCEPTION 'esperado mover 8 contratos, movidos %', n;
  END IF;

  CREATE TEMP TABLE merge_values ON COMMIT DROP AS
  SELECT p.old_id, nw.cpf, nw.email, nw.whatsapp, nw.birth_date, nw.gender, nw.address_zip
  FROM merge_pairs p JOIN public.presale_customers nw ON nw.id = p.new_id;

  DELETE FROM public.presale_customers c USING merge_pairs p WHERE c.id = p.new_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 8 THEN
    RAISE EXCEPTION 'esperado apagar 8 duplicados, apagados %', n;
  END IF;

  -- o cadastro mantido só ganha o que estava vazio
  UPDATE public.presale_customers c SET
    cpf = CASE WHEN nullif(btrim(c.cpf), '') IS NULL THEN v.cpf ELSE c.cpf END,
    email = CASE WHEN nullif(btrim(c.email), '') IS NULL THEN v.email ELSE c.email END,
    whatsapp = CASE WHEN nullif(btrim(c.whatsapp), '') IS NULL AND v.whatsapp ~ '^\d{10,11}$'
                    THEN '+55' || v.whatsapp ELSE c.whatsapp END,
    birth_date = coalesce(c.birth_date, v.birth_date),
    gender = CASE WHEN nullif(btrim(c.gender), '') IS NULL THEN v.gender ELSE c.gender END,
    address_zip = CASE WHEN nullif(btrim(c.address_zip), '') IS NULL THEN v.address_zip ELSE c.address_zip END
  FROM merge_values v WHERE c.id = v.old_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 8 THEN
    RAISE EXCEPTION 'esperado completar 8 cadastros, completados %', n;
  END IF;

  -- conferência: contrato no cadastro antigo, duplicado apagado, CPF único
  SELECT string_agg(p.contract_number, ', ') INTO v_problems
  FROM merge_pairs p
  JOIN public.assessment_contracts ac ON ac.id = p.contract_id
  JOIN public.presale_customers od ON od.id = p.old_id
  JOIN merge_values v ON v.old_id = p.old_id
  WHERE ac.customer_id <> p.old_id
     OR EXISTS (SELECT 1 FROM public.presale_customers x WHERE x.id = p.new_id)
     OR regexp_replace(coalesce(od.cpf, ''), '\D', '', 'g') <> v.cpf
     OR (SELECT count(*) FROM public.presale_customers x
         WHERE regexp_replace(coalesce(x.cpf, ''), '\D', '', 'g') = v.cpf) <> 1
     OR (SELECT count(*) FROM eon_private.customer_merge_backups b
         WHERE b.merge_key = 'legacy_contract_migration_b1_duplicates_20260929'
           AND jsonb_array_length(b.snapshot->'pares') = 8) <> 1;
  IF v_problems IS NOT NULL THEN
    RAISE EXCEPTION 'conferência pós-união falhou: %', v_problems;
  END IF;
END $merge$;
COMMIT;
