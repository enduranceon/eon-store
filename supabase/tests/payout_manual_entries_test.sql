BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SET LOCAL timezone = 'America/Sao_Paulo';

SELECT plan(14);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.payout_monthly_statement_items'::regclass
      AND conname = 'payout_statement_items_manual_entry_sign'
  ),
  'manual entries have the sign rule'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.payout_monthly_statement_items'::regclass
      AND tgname = 'trg_block_modifications_on_closed_items'
      AND NOT tgisinternal
      AND (tgtype & 4) = 4   -- INSERT
      AND (tgtype & 8) = 8   -- DELETE
      AND (tgtype & 16) = 16 -- UPDATE
  ),
  'the closing immutability trigger covers inserts, updates and deletes'
);

SELECT ok(
  position(
    'FOR UPDATE' IN upper(pg_get_functiondef('public.block_modifications_on_closed_closing()'::regprocedure))
  ) > 0,
  'item writes lock the closing row before checking its status'
);

-- Coach e fechamento em revisão de um mês encerrado, fictícios.
INSERT INTO public.assessment_coaches (id, name, email, role, modality_ids, active) VALUES
  ('85000000-0000-4000-a000-000000000001', 'Coach lançamento manual', 'lancamento-manual@example.test',
   'pleno', ARRAY[]::uuid[], true);
INSERT INTO public.payout_monthly_closings (id, competence, status, generated_at)
VALUES ('85000000-0000-4000-a000-0000000000c1',
        (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') - interval '2 months')::date,
        'pending_approval', now());

SELECT lives_ok(
  $$INSERT INTO public.payout_monthly_statement_items
      (closing_id, coach_id, source_type, amount, expense_category, adjustment_reason)
    VALUES ('85000000-0000-4000-a000-0000000000c1', '85000000-0000-4000-a000-000000000001',
            'manual_adjustment', 21.00, 'repasse_extra', 'Dias do plano anterior')$$,
  'an extra repasse is positive'
);
SELECT lives_ok(
  $$INSERT INTO public.payout_monthly_statement_items
      (closing_id, coach_id, source_type, amount, expense_category, adjustment_reason)
    VALUES ('85000000-0000-4000-a000-0000000000c1', '85000000-0000-4000-a000-000000000001',
            'manual_adjustment', -30.00, 'desconto', 'Aula não dada')$$,
  'a discount is negative'
);
SELECT lives_ok(
  $$INSERT INTO public.payout_monthly_statement_items
      (closing_id, coach_id, source_type, amount, expense_category, adjustment_reason)
    VALUES ('85000000-0000-4000-a000-0000000000c1', '85000000-0000-4000-a000-000000000001',
            'manual_adjustment', 62.11, 'insumos_treino', 'Insumos')$$,
  'an expense is positive'
);
SELECT throws_ok(
  $$INSERT INTO public.payout_monthly_statement_items
      (closing_id, coach_id, source_type, amount, expense_category, adjustment_reason)
    VALUES ('85000000-0000-4000-a000-0000000000c1', '85000000-0000-4000-a000-000000000001',
            'manual_adjustment', 30.00, 'desconto', 'Desconto com sinal trocado')$$,
  '23514', NULL,
  'a positive discount is refused'
);
SELECT throws_ok(
  $$INSERT INTO public.payout_monthly_statement_items
      (closing_id, coach_id, source_type, amount, expense_category, adjustment_reason)
    VALUES ('85000000-0000-4000-a000-0000000000c1', '85000000-0000-4000-a000-000000000001',
            'manual_adjustment', -21.00, 'repasse_extra', 'Repasse extra negativo')$$,
  '23514', NULL,
  'a negative extra repasse is refused'
);
SELECT throws_ok(
  $$INSERT INTO public.payout_monthly_statement_items
      (closing_id, coach_id, source_type, amount, expense_category, adjustment_reason)
    VALUES ('85000000-0000-4000-a000-0000000000c1', '85000000-0000-4000-a000-000000000001',
            'manual_adjustment', -62.11, 'reembolso_combustivel', 'Gasto negativo')$$,
  '23514', NULL,
  'a negative expense is refused (a deduction is a discount)'
);
SELECT throws_ok(
  $$INSERT INTO public.payout_monthly_statement_items
      (closing_id, coach_id, source_type, amount, expense_category, adjustment_reason)
    VALUES ('85000000-0000-4000-a000-0000000000c1', '85000000-0000-4000-a000-000000000001',
            'manual_adjustment', 0, 'outros', 'Lançamento zerado')$$,
  '23514', NULL,
  'a zero entry is refused'
);
SELECT is(
  (SELECT sum(amount) FROM public.payout_monthly_statement_items
   WHERE closing_id = '85000000-0000-4000-a000-0000000000c1'),
  53.11::numeric,
  'the closing total adds the extra repasse and the expense and takes the discount off'
);

UPDATE public.payout_monthly_closings
SET status = 'approved'
WHERE id = '85000000-0000-4000-a000-0000000000c1';

SELECT throws_ok(
  $$INSERT INTO public.payout_monthly_statement_items
      (closing_id, coach_id, source_type, amount, expense_category, adjustment_reason)
    VALUES ('85000000-0000-4000-a000-0000000000c1', '85000000-0000-4000-a000-000000000001',
            'manual_adjustment', 10.00, 'repasse_extra', 'Tardia')$$,
  'P0001', NULL,
  'an approved closing refuses a new item'
);

SELECT throws_ok(
  $$UPDATE public.payout_monthly_statement_items
    SET amount = 22.00
    WHERE closing_id = '85000000-0000-4000-a000-0000000000c1'
      AND expense_category = 'repasse_extra'$$,
  'P0001', NULL,
  'an approved closing refuses an item update'
);

SELECT throws_ok(
  $$DELETE FROM public.payout_monthly_statement_items
    WHERE closing_id = '85000000-0000-4000-a000-0000000000c1'
      AND expense_category = 'repasse_extra'$$,
  'P0001', NULL,
  'an approved closing refuses an item deletion'
);

SELECT * FROM finish();
ROLLBACK;
