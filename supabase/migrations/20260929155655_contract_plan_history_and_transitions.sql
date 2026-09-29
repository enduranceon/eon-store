BEGIN;

-- Upgrade de plano no meio do ciclo, entrega 1: a base de dados.
--
-- 1. assessment_contract_plan_history guarda qual plano valeu em cada dia do
--    contrato. Cada linha vale de valid_from até o valid_from da linha
--    seguinte; a última vale até o fim do contrato. Todo contrato tem uma
--    linha 'original'. Enquanto ela for a única, acompanha o plano e o início
--    do contrato, porque "Trocar plano" corrige o plano desde o começo. As
--    trocas no meio do ciclo acrescentam linhas 'upgrade' ou 'lateral'.
-- 2. assessment_plan_transitions é a matriz de mudanças entre planos do mesmo
--    ciclo. O tipo começa pelo preço de hoje (mais caro = upgrade, mais barato
--    = downgrade, igual = lateral) e é ajustável na tela de configurações.
--    Plano novo, ou com o ciclo alterado, ganha os pares que faltam.
-- 3. O histórico de treinador passa a acompanhar o início do contrato enquanto
--    tiver uma linha só. As linhas únicas que ficaram com outra data são
--    corrigidas, com cópia do valor anterior em eon_private.
-- 4. Itens e pendências do fechamento de repasse guardam os trechos do
--    cálculo (um por taxa mensal aplicada no mês).

-- 1. Histórico de plano do contrato ------------------------------------------

CREATE TABLE public.assessment_contract_plan_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL
    REFERENCES public.assessment_contracts(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL
    REFERENCES public.assessment_plans(id) ON DELETE RESTRICT,
  plan_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_from date NOT NULL,
  change_type text NOT NULL DEFAULT 'original',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT assessment_contract_plan_history_change_type_check
    CHECK (change_type IN ('original', 'upgrade', 'lateral')),
  CONSTRAINT assessment_contract_plan_history_contract_day_key
    UNIQUE (contract_id, valid_from)
);

CREATE UNIQUE INDEX assessment_contract_plan_history_one_original_idx
  ON public.assessment_contract_plan_history (contract_id)
  WHERE change_type = 'original';

CREATE INDEX assessment_contract_plan_history_plan_idx
  ON public.assessment_contract_plan_history (plan_id);

COMMENT ON TABLE public.assessment_contract_plan_history IS
  'Plano vigente em cada dia do contrato. Cada linha vale de valid_from até o valid_from da linha seguinte; a última, até o fim do contrato.';
COMMENT ON COLUMN public.assessment_contract_plan_history.change_type IS
  'original = plano da venda (acompanha "Trocar plano"); upgrade/lateral = troca no meio do ciclo a partir de valid_from.';

INSERT INTO public.assessment_contract_plan_history (
  contract_id, plan_id, plan_snapshot, valid_from, change_type, created_at, created_by
)
SELECT
  contract.id,
  contract.plan_id,
  coalesce(contract.plan_snapshot, '{}'::jsonb),
  contract.start_date,
  'original',
  coalesce(contract.created_at, now()),
  contract.created_by
FROM public.assessment_contracts AS contract;

CREATE OR REPLACE FUNCTION eon_private.sync_contract_plan_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.assessment_contract_plan_history (
      contract_id, plan_id, plan_snapshot, valid_from, change_type, created_by
    ) VALUES (
      NEW.id,
      NEW.plan_id,
      coalesce(NEW.plan_snapshot, '{}'::jsonb),
      NEW.start_date,
      'original',
      NEW.created_by
    );
    RETURN NULL;
  END IF;

  -- Depois de uma troca no meio do ciclo, quem registrou a troca mantém o
  -- histórico; a linha original não acompanha mais o contrato.
  UPDATE public.assessment_contract_plan_history AS history
     SET plan_id = NEW.plan_id,
         plan_snapshot = coalesce(NEW.plan_snapshot, '{}'::jsonb),
         valid_from = NEW.start_date
   WHERE history.contract_id = NEW.id
     AND history.change_type = 'original'
     AND NOT EXISTS (
       SELECT 1
       FROM public.assessment_contract_plan_history AS change
       WHERE change.contract_id = NEW.id
         AND change.change_type <> 'original'
     );
  RETURN NULL;
END;
$$;

CREATE TRIGGER sync_contract_plan_history_insert
  AFTER INSERT ON public.assessment_contracts
  FOR EACH ROW
  EXECUTE FUNCTION eon_private.sync_contract_plan_history();

CREATE TRIGGER sync_contract_plan_history_update
  AFTER UPDATE OF plan_id, plan_snapshot, start_date ON public.assessment_contracts
  FOR EACH ROW
  WHEN (
    OLD.plan_id IS DISTINCT FROM NEW.plan_id
    OR OLD.plan_snapshot IS DISTINCT FROM NEW.plan_snapshot
    OR OLD.start_date IS DISTINCT FROM NEW.start_date
  )
  EXECUTE FUNCTION eon_private.sync_contract_plan_history();

REVOKE ALL ON FUNCTION eon_private.sync_contract_plan_history() FROM PUBLIC;

-- 2. Matriz de mudanças entre planos -----------------------------------------

CREATE TABLE public.assessment_plan_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_plan_id uuid NOT NULL
    REFERENCES public.assessment_plans(id) ON DELETE CASCADE,
  to_plan_id uuid NOT NULL
    REFERENCES public.assessment_plans(id) ON DELETE CASCADE,
  transition_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assessment_plan_transitions_type_check
    CHECK (transition_type IN ('upgrade', 'downgrade', 'lateral', 'not_allowed')),
  CONSTRAINT assessment_plan_transitions_distinct_plans_check
    CHECK (from_plan_id <> to_plan_id),
  CONSTRAINT assessment_plan_transitions_pair_key
    UNIQUE (from_plan_id, to_plan_id)
);

CREATE INDEX assessment_plan_transitions_to_plan_idx
  ON public.assessment_plan_transitions (to_plan_id);

COMMENT ON TABLE public.assessment_plan_transitions IS
  'Tipo de cada mudança entre planos do mesmo ciclo. O preço só calcula quanto cobrar; o tipo vem desta matriz.';

-- Acrescenta os pares que faltam entre planos do mesmo ciclo, com o tipo
-- sugerido pelo preço de hoje. Nunca altera um par que já existe, para não
-- desfazer um ajuste feito na tela. p_plan_id nulo = todos os planos.
CREATE OR REPLACE FUNCTION eon_private.add_missing_plan_transitions(p_plan_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inserted integer;
BEGIN
  INSERT INTO public.assessment_plan_transitions (
    from_plan_id, to_plan_id, transition_type
  )
  SELECT
    origin.id,
    target.id,
    CASE
      WHEN target.price_total > origin.price_total THEN 'upgrade'
      WHEN target.price_total < origin.price_total THEN 'downgrade'
      ELSE 'lateral'
    END
  FROM public.assessment_plans AS origin
  JOIN public.assessment_plans AS target
    ON target.period_months = origin.period_months
   AND target.id <> origin.id
  WHERE p_plan_id IS NULL
     OR p_plan_id IN (origin.id, target.id)
  ON CONFLICT (from_plan_id, to_plan_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION eon_private.add_plan_transitions_for_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM eon_private.add_missing_plan_transitions(NEW.id);
  RETURN NULL;
END;
$$;

CREATE TRIGGER add_plan_transitions_for_plan
  AFTER INSERT OR UPDATE OF period_months ON public.assessment_plans
  FOR EACH ROW
  EXECUTE FUNCTION eon_private.add_plan_transitions_for_plan();

REVOKE ALL ON FUNCTION eon_private.add_missing_plan_transitions(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eon_private.add_plan_transitions_for_plan() FROM PUBLIC;

SELECT eon_private.add_missing_plan_transitions(NULL);

-- 3. Histórico de treinador acompanha o início do contrato -------------------

CREATE OR REPLACE FUNCTION eon_private.sync_coach_history_start()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Com troca de treinador registrada, as datas das linhas contam a troca e
  -- ficam como estão.
  UPDATE public.assessment_contract_coach_history AS history
     SET started_at = NEW.start_date
   WHERE history.contract_id = NEW.id
     AND history.started_at IS DISTINCT FROM NEW.start_date
     AND NOT EXISTS (
       SELECT 1
       FROM public.assessment_contract_coach_history AS other
       WHERE other.contract_id = NEW.id
         AND other.id <> history.id
     );
  RETURN NULL;
END;
$$;

CREATE TRIGGER sync_coach_history_start
  AFTER UPDATE OF start_date ON public.assessment_contracts
  FOR EACH ROW
  WHEN (OLD.start_date IS DISTINCT FROM NEW.start_date)
  EXECUTE FUNCTION eon_private.sync_coach_history_start();

REVOKE ALL ON FUNCTION eon_private.sync_coach_history_start() FROM PUBLIC;

CREATE TABLE IF NOT EXISTS eon_private.coach_history_start_correction_backups (
  correction_key text PRIMARY KEY,
  captured_at timestamptz NOT NULL DEFAULT now(),
  snapshot jsonb NOT NULL
);

REVOKE ALL ON TABLE eon_private.coach_history_start_correction_backups
  FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO eon_private.coach_history_start_correction_backups (correction_key, snapshot)
SELECT
  'coach_history:' || history.id::text,
  jsonb_build_object(
    'history', to_jsonb(history),
    'contract_start_date', contract.start_date
  )
FROM public.assessment_contract_coach_history AS history
JOIN public.assessment_contracts AS contract
  ON contract.id = history.contract_id
WHERE history.started_at <> contract.start_date
  AND NOT EXISTS (
    SELECT 1
    FROM public.assessment_contract_coach_history AS other
    WHERE other.contract_id = history.contract_id
      AND other.id <> history.id
  )
ON CONFLICT (correction_key) DO NOTHING;

UPDATE public.assessment_contract_coach_history AS history
   SET started_at = contract.start_date
  FROM public.assessment_contracts AS contract
 WHERE contract.id = history.contract_id
   AND history.started_at <> contract.start_date
   AND NOT EXISTS (
     SELECT 1
     FROM public.assessment_contract_coach_history AS other
     WHERE other.contract_id = history.contract_id
       AND other.id <> history.id
   );

-- 4. Trechos do cálculo no fechamento ----------------------------------------

ALTER TABLE public.payout_monthly_statement_items
  ADD COLUMN IF NOT EXISTS segments jsonb;
ALTER TABLE public.payout_pending_repasse
  ADD COLUMN IF NOT EXISTS segments jsonb;

COMMENT ON COLUMN public.payout_monthly_statement_items.segments IS
  'Trechos do cálculo automático: taxa mensal, dias válidos, valor arredondado e modalidades de cada trecho. amount é a soma dos trechos.';
COMMENT ON COLUMN public.payout_pending_repasse.segments IS
  'Trechos do cálculo automático, no mesmo formato de payout_monthly_statement_items.segments.';

-- Acesso: painel admin lê; escrita só pelo backend -----------------------------

ALTER TABLE public.assessment_contract_plan_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assessment_plan_transitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_admin_only ON public.assessment_contract_plan_history
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT eon_private.is_app_admin()))
  WITH CHECK ((SELECT eon_private.is_app_admin()));
CREATE POLICY app_admin_read ON public.assessment_contract_plan_history
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((SELECT eon_private.is_app_admin()));

CREATE POLICY app_admin_only ON public.assessment_plan_transitions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT eon_private.is_app_admin()))
  WITH CHECK ((SELECT eon_private.is_app_admin()));
CREATE POLICY app_admin_read ON public.assessment_plan_transitions
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((SELECT eon_private.is_app_admin()));

REVOKE ALL ON public.assessment_contract_plan_history FROM PUBLIC, anon;
REVOKE ALL ON public.assessment_plan_transitions FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON public.assessment_contract_plan_history, public.assessment_plan_transitions
  FROM authenticated;
GRANT SELECT
  ON public.assessment_contract_plan_history, public.assessment_plan_transitions
  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.assessment_contract_plan_history, public.assessment_plan_transitions
  TO service_role;

-- Conferência da carga inicial --------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.assessment_contracts AS contract
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.assessment_contract_plan_history AS history
      WHERE history.contract_id = contract.id
        AND history.change_type = 'original'
        AND history.plan_id = contract.plan_id
        AND history.valid_from = contract.start_date
    )
  ) THEN
    RAISE EXCEPTION 'Contrato sem linha original no histórico de plano';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.assessment_plans AS origin
    JOIN public.assessment_plans AS target
      ON target.period_months = origin.period_months
     AND target.id <> origin.id
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.assessment_plan_transitions AS transition
      WHERE transition.from_plan_id = origin.id
        AND transition.to_plan_id = target.id
    )
  ) THEN
    RAISE EXCEPTION 'Par de planos do mesmo ciclo fora da matriz';
  END IF;
END;
$$;

COMMIT;
