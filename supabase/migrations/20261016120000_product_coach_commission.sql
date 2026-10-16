-- Comissão de produto para o coach do comprador.
--
-- Regra no cadastro do produto (tabela products): nenhuma, porcentagem sobre o
-- valor pago pelo item (com desconto, sem frete) ou valor fixo por unidade.
-- O pedido guarda o coach do comprador (contrato ativo quando o pedido nasce ou
-- quando o cliente é ligado a ele; editável no pedido). Quando o pedido passa a
-- pago, a regra de cada item fica registrada no pedido (commission_snapshot):
-- mudar o produto depois não muda vendas já pagas, e pedidos pagos antes desta
-- migração nunca geram comissão.
--
-- O livro product_commissions só recebe lançamentos novos: a primeira comissão
-- do item (competência = mês do pagamento) e, se o pedido mudar depois
-- (estorno, cancelamento, item cancelado, desconto, troca de coach), um ajuste
-- com a diferença na competência do mês em que mudou. O fechamento do repasse
-- leva os lançamentos em aberto até o mês fechado (source_type
-- product_commission) e marca closing_id. Comprador sem coach não gera comissão.

-- Regra no produto ---------------------------------------------------------------

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS commission_type text,
  ADD COLUMN IF NOT EXISTS commission_value numeric(12,2);

ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_commission_rule;
ALTER TABLE public.products
  ADD CONSTRAINT products_commission_rule CHECK (
    (commission_type IS NULL AND commission_value IS NULL)
    OR (commission_type = 'percent' AND commission_value IS NOT NULL
        AND commission_value > 0 AND commission_value <= 100)
    OR (commission_type = 'fixed' AND commission_value IS NOT NULL AND commission_value > 0)
  );

COMMENT ON COLUMN public.products.commission_type IS
  'Comissão do coach do comprador: percent (sobre o valor pago pelo item) ou fixed (R$ por unidade). Nulo = sem comissão.';
COMMENT ON COLUMN public.products.commission_value IS
  'Porcentagem (0-100] ou valor em reais por unidade, conforme commission_type.';

-- Coach e regra registrada no pedido -------------------------------------------

ALTER TABLE public.stock_orders
  ADD COLUMN IF NOT EXISTS coach_id uuid REFERENCES public.assessment_coaches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS commission_snapshot jsonb;
ALTER TABLE public.presale_orders
  ADD COLUMN IF NOT EXISTS commission_snapshot jsonb;

CREATE INDEX IF NOT EXISTS stock_orders_coach_id_idx ON public.stock_orders (coach_id);

COMMENT ON COLUMN public.stock_orders.coach_id IS
  'Coach do comprador para a comissão de produto. Vem do contrato ativo quando o pedido nasce; editável no pedido.';
COMMENT ON COLUMN public.stock_orders.commission_snapshot IS
  'Regras de comissão dos itens registradas quando o pedido passou a pago. Nulo = pedido nunca pago desde a comissão.';
COMMENT ON COLUMN public.presale_orders.commission_snapshot IS
  'Regras de comissão dos itens registradas quando o pedido passou a pago. Nulo = pedido nunca pago desde a comissão.';

-- Coach atual da pessoa: contrato ativo, em atraso ou em licença; o que já
-- começou vem antes de uma renovação futura.
CREATE OR REPLACE FUNCTION eon_private.customer_current_coach(p_customer_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.coach_id
  FROM public.assessment_contracts c
  WHERE c.customer_id = p_customer_id
    AND c.coach_id IS NOT NULL
    AND c.status IN ('active', 'overdue', 'on_leave')
  ORDER BY (c.start_date <= (now() AT TIME ZONE 'America/Sao_Paulo')::date) DESC,
           c.start_date DESC NULLS LAST,
           c.created_at DESC NULLS LAST
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION eon_private.customer_current_coach(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION eon_private.order_default_coach()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.coach_id IS NULL AND NEW.customer_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.customer_id IS DISTINCT FROM OLD.customer_id) THEN
    NEW.coach_id := eon_private.customer_current_coach(NEW.customer_id);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION eon_private.order_default_coach() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS order_default_coach ON public.stock_orders;
CREATE TRIGGER order_default_coach
  BEFORE INSERT OR UPDATE OF customer_id ON public.stock_orders
  FOR EACH ROW EXECUTE FUNCTION eon_private.order_default_coach();

DROP TRIGGER IF EXISTS order_default_coach ON public.presale_orders;
CREATE TRIGGER order_default_coach
  BEFORE INSERT OR UPDATE OF customer_id ON public.presale_orders
  FOR EACH ROW EXECUTE FUNCTION eon_private.order_default_coach();

-- Pedidos ainda em aberto ganham o coach atual de quem comprou. Pagos,
-- cancelados e estornados ficam como estão.
UPDATE public.stock_orders o
SET coach_id = eon_private.customer_current_coach(o.customer_id)
WHERE o.coach_id IS NULL
  AND o.customer_id IS NOT NULL
  AND COALESCE(o.payment_status, 'awaiting_charge') NOT IN ('paid', 'cancelled', 'refunded');

UPDATE public.presale_orders o
SET coach_id = eon_private.customer_current_coach(o.customer_id)
WHERE o.coach_id IS NULL
  AND o.customer_id IS NOT NULL
  AND COALESCE(o.payment_status, 'awaiting_charge') NOT IN ('paid', 'cancelled', 'refunded');

-- Regra de cada item no momento do pagamento. O item da loja aponta para o
-- produto de estoque; o da pré-venda, para o produto da campanha (ou direto
-- para o produto). A regra vem sempre do produto principal.
CREATE OR REPLACE FUNCTION eon_private.order_commission_rules(p_order_type text, p_items jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'item_index', item.ordinality - 1,
           'item_product_id', item.value->>'product_id',
           'product_id', product.id,
           'product_name', COALESCE(NULLIF(item.value->>'product_name', ''), product.name),
           'commission_type', product.commission_type,
           'commission_value', product.commission_value
         ) ORDER BY item.ordinality), '[]'::jsonb)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END)
       WITH ORDINALITY AS item(value, ordinality)
  LEFT JOIN public.stock_products stock_product
    ON p_order_type = 'stock' AND stock_product.id::text = item.value->>'product_id'
  LEFT JOIN public.presale_products presale_product
    ON p_order_type = 'presale' AND presale_product.id::text = item.value->>'product_id'
  JOIN public.products product
    ON product.id = COALESCE(
      stock_product.product_id,
      presale_product.product_id,
      CASE WHEN item.value->>'product_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (item.value->>'product_id')::uuid END
    )
  WHERE product.commission_type IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION eon_private.order_commission_rules(text, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION eon_private.order_commission_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.payment_status = 'paid' AND NEW.commission_snapshot IS NULL
     AND (TG_OP = 'INSERT' OR OLD.payment_status IS DISTINCT FROM 'paid') THEN
    NEW.commission_snapshot := jsonb_build_object(
      'taken_at', now(),
      'items', eon_private.order_commission_rules(
        CASE WHEN TG_TABLE_NAME = 'stock_orders' THEN 'stock' ELSE 'presale' END,
        NEW.items
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION eon_private.order_commission_snapshot() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS order_commission_snapshot ON public.stock_orders;
CREATE TRIGGER order_commission_snapshot
  BEFORE INSERT OR UPDATE OF payment_status ON public.stock_orders
  FOR EACH ROW EXECUTE FUNCTION eon_private.order_commission_snapshot();

DROP TRIGGER IF EXISTS order_commission_snapshot ON public.presale_orders;
CREATE TRIGGER order_commission_snapshot
  BEFORE INSERT OR UPDATE OF payment_status ON public.presale_orders
  FOR EACH ROW EXECUTE FUNCTION eon_private.order_commission_snapshot();

-- Livro das comissões ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.product_commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_type text NOT NULL CHECK (order_type IN ('stock', 'presale')),
  order_id uuid NOT NULL,
  order_number text,
  customer_name text,
  item_index integer NOT NULL CHECK (item_index >= 0),
  product_id uuid,
  product_name text NOT NULL,
  quantity integer NOT NULL,
  coach_id uuid NOT NULL REFERENCES public.assessment_coaches(id) ON DELETE RESTRICT,
  commission_type text NOT NULL CHECK (commission_type IN ('percent', 'fixed')),
  commission_value numeric(12,2) NOT NULL,
  base_value numeric(12,2) NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount <> 0),
  kind text NOT NULL CHECK (kind IN ('commission', 'adjustment')),
  competence date NOT NULL CHECK (competence = date_trunc('month', competence)::date),
  reason text NOT NULL,
  closing_id uuid REFERENCES public.payout_monthly_closings(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_commissions_order_idx
  ON public.product_commissions (order_type, order_id, item_index);
CREATE INDEX IF NOT EXISTS product_commissions_coach_idx
  ON public.product_commissions (coach_id, competence);
CREATE INDEX IF NOT EXISTS product_commissions_open_idx
  ON public.product_commissions (competence) WHERE closing_id IS NULL;
CREATE INDEX IF NOT EXISTS product_commissions_closing_idx
  ON public.product_commissions (closing_id);

COMMENT ON TABLE public.product_commissions IS
  'Comissões de produto do coach do comprador. Só recebe lançamentos novos (comissão e ajustes); closing_id marca o fechamento do repasse que levou o lançamento.';

-- Lançamento não se apaga nem se reescreve: só o fechamento muda closing_id, e
-- nunca o de um fechamento aprovado ou pago.
CREATE OR REPLACE FUNCTION eon_private.guard_product_commissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Lançamento de comissão não pode ser apagado; o ajuste entra como novo lançamento';
  END IF;
  IF (to_jsonb(NEW) - 'closing_id') IS DISTINCT FROM (to_jsonb(OLD) - 'closing_id') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Lançamento de comissão não pode ser alterado; o ajuste entra como novo lançamento';
  END IF;
  IF OLD.closing_id IS NOT NULL AND NEW.closing_id IS DISTINCT FROM OLD.closing_id THEN
    SELECT status INTO v_status FROM public.payout_monthly_closings WHERE id = OLD.closing_id;
    IF v_status IN ('approved', 'paid') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'Comissão já está em fechamento aprovado ou pago';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION eon_private.guard_product_commissions() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_product_commissions ON public.product_commissions;
CREATE TRIGGER guard_product_commissions
  BEFORE UPDATE OR DELETE ON public.product_commissions
  FOR EACH ROW EXECUTE FUNCTION eon_private.guard_product_commissions();

ALTER TABLE public.product_commissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_admin_only ON public.product_commissions;
CREATE POLICY app_admin_only ON public.product_commissions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT eon_private.is_app_admin()))
  WITH CHECK ((SELECT eon_private.is_app_admin()));
DROP POLICY IF EXISTS app_admin_read ON public.product_commissions;
CREATE POLICY app_admin_read ON public.product_commissions
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((SELECT eon_private.is_app_admin()));

REVOKE ALL ON public.product_commissions FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.product_commissions FROM authenticated;
GRANT SELECT ON public.product_commissions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.product_commissions TO service_role;

-- Reconciliação: compara o que o pedido deve hoje a cada coach, item a item,
-- com a soma já lançada, e lança só a diferença.
--   pago + coach + regra registrada -> percent: valor pago do item x %;
--                                      fixed: valor x quantidade
--   qualquer outra situação         -> zero (estorno, cancelamento, sem coach)
-- Valor pago do item = (preço + adicionais) x quantidade, reduzido na proporção
-- do desconto do pedido (total do pedido / soma dos itens ativos, no máximo 1).
CREATE OR REPLACE FUNCTION eon_private.reconcile_product_commissions(p_order_type text, p_order_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order_number text;
  v_customer_id uuid;
  v_customer_name text;
  v_items jsonb;
  v_total numeric;
  v_payment_status text;
  v_payment_date date;
  v_coach_id uuid;
  v_snapshot jsonb;
  v_lines numeric;
  v_ratio numeric;
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_inserted integer := 0;
  r record;
BEGIN
  IF p_order_type = 'stock' THEN
    SELECT order_number, customer_id, customer_name, items, total_value,
           payment_status, payment_date, coach_id, commission_snapshot
    INTO v_order_number, v_customer_id, v_customer_name, v_items, v_total,
         v_payment_status, v_payment_date, v_coach_id, v_snapshot
    FROM public.stock_orders WHERE id = p_order_id;
  ELSIF p_order_type = 'presale' THEN
    SELECT order_number, customer_id, COALESCE(customer_name, checkout_name), items, total_value,
           payment_status, payment_date, coach_id, commission_snapshot
    INTO v_order_number, v_customer_id, v_customer_name, v_items, v_total,
         v_payment_status, v_payment_date, v_coach_id, v_snapshot
    FROM public.presale_orders WHERE id = p_order_id;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Tipo de pedido inválido';
  END IF;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  IF v_snapshot IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.product_commissions
    WHERE order_type = p_order_type AND order_id = p_order_id
  ) THEN
    RETURN 0;
  END IF;

  IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
    v_items := '[]'::jsonb;
  END IF;

  v_customer_name := COALESCE(
    (SELECT full_name FROM public.presale_customers WHERE id = v_customer_id),
    v_customer_name
  );

  SELECT COALESCE(sum(
           (COALESCE(NULLIF(value->>'sale_price', '')::numeric, 0)
            + COALESCE(NULLIF(value->>'extras_total', '')::numeric, 0))
           * COALESCE(NULLIF(value->>'quantity', '')::numeric, 1)
         ), 0)
  INTO v_lines
  FROM jsonb_array_elements(v_items)
  WHERE COALESCE((value->>'cancelled')::boolean, false) = false;

  v_ratio := CASE
    WHEN v_lines > 0 THEN LEAST(1, GREATEST(0, COALESCE(v_total, 0)) / v_lines)
    ELSE 0
  END;

  FOR r IN
    WITH rules AS (
      SELECT rule.*
      FROM jsonb_to_recordset(COALESCE(v_snapshot->'items', '[]'::jsonb)) AS rule(
        item_index integer, item_product_id text, product_id uuid, product_name text,
        commission_type text, commission_value numeric
      )
    ),
    desired AS (
      SELECT rules.item_index,
             v_coach_id AS coach_id,
             rules.product_id,
             rules.product_name,
             rules.commission_type,
             rules.commission_value,
             COALESCE(NULLIF(item.value->>'quantity', '')::integer, 1) AS quantity,
             round(
               (COALESCE(NULLIF(item.value->>'sale_price', '')::numeric, 0)
                + COALESCE(NULLIF(item.value->>'extras_total', '')::numeric, 0))
               * COALESCE(NULLIF(item.value->>'quantity', '')::numeric, 1) * v_ratio,
               2
             ) AS base_value
      FROM rules
      JOIN LATERAL (
        SELECT v_items -> rules.item_index AS value
      ) item ON true
      WHERE v_payment_status = 'paid'
        AND v_coach_id IS NOT NULL
        AND item.value IS NOT NULL
        AND item.value->>'product_id' IS NOT DISTINCT FROM rules.item_product_id
        AND COALESCE((item.value->>'cancelled')::boolean, false) = false
    ),
    desired_amount AS (
      SELECT desired.*,
             CASE desired.commission_type
               WHEN 'percent' THEN round(desired.base_value * desired.commission_value / 100, 2)
               ELSE round(desired.commission_value * desired.quantity, 2)
             END AS amount
      FROM desired
    ),
    booked AS (
      SELECT DISTINCT ON (item_index, coach_id)
             item_index, coach_id, product_id, product_name, quantity,
             commission_type, commission_value,
             sum(amount) OVER (PARTITION BY item_index, coach_id) AS amount
      FROM public.product_commissions
      WHERE order_type = p_order_type AND order_id = p_order_id
      ORDER BY item_index, coach_id, created_at DESC, id DESC
    )
    SELECT COALESCE(d.item_index, b.item_index) AS item_index,
           COALESCE(d.coach_id, b.coach_id) AS coach_id,
           COALESCE(d.product_id, b.product_id) AS product_id,
           COALESCE(d.product_name, b.product_name) AS product_name,
           COALESCE(d.quantity, b.quantity) AS quantity,
           COALESCE(d.commission_type, b.commission_type) AS commission_type,
           COALESCE(d.commission_value, b.commission_value) AS commission_value,
           COALESCE(d.base_value, 0) AS base_value,
           COALESCE(d.amount, 0) - COALESCE(b.amount, 0) AS delta,
           b.item_index IS NULL AS first_entry,
           v_items -> COALESCE(d.item_index, b.item_index) AS item
    FROM desired_amount d
    FULL JOIN booked b ON b.item_index = d.item_index AND b.coach_id = d.coach_id
  LOOP
    CONTINUE WHEN round(r.delta, 2) = 0;
    INSERT INTO public.product_commissions (
      order_type, order_id, order_number, customer_name, item_index, product_id,
      product_name, quantity, coach_id, commission_type, commission_value,
      base_value, amount, kind, competence, reason
    ) VALUES (
      p_order_type, p_order_id, v_order_number, v_customer_name, r.item_index, r.product_id,
      COALESCE(r.product_name, 'Produto'), r.quantity, r.coach_id, r.commission_type,
      r.commission_value, r.base_value, round(r.delta, 2),
      CASE WHEN r.first_entry THEN 'commission' ELSE 'adjustment' END,
      date_trunc('month', CASE WHEN r.first_entry THEN COALESCE(v_payment_date, v_today) ELSE v_today END)::date,
      CASE
        WHEN r.first_entry THEN 'Pedido pago'
        WHEN v_payment_status = 'refunded' THEN 'Pedido estornado'
        WHEN v_payment_status = 'cancelled' THEN 'Pedido cancelado'
        WHEN v_payment_status IS DISTINCT FROM 'paid' THEN 'Pagamento do pedido desfeito'
        WHEN v_coach_id IS NULL THEN 'Coach removido do pedido'
        WHEN r.coach_id IS DISTINCT FROM v_coach_id THEN 'Coach do pedido trocado'
        WHEN COALESCE((r.item->>'cancelled')::boolean, false) THEN 'Item cancelado'
        ELSE 'Valor pago do pedido mudou'
      END
    );
    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION eon_private.reconcile_product_commissions(text, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION eon_private.reconcile_product_commissions_after_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM eon_private.reconcile_product_commissions(
    CASE WHEN TG_TABLE_NAME = 'stock_orders' THEN 'stock' ELSE 'presale' END,
    NEW.id
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION eon_private.reconcile_product_commissions_after_order() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS reconcile_product_commissions ON public.stock_orders;
CREATE TRIGGER reconcile_product_commissions
  AFTER INSERT OR UPDATE OF payment_status, payment_date, coach_id, items, total_value, commission_snapshot
  ON public.stock_orders
  FOR EACH ROW EXECUTE FUNCTION eon_private.reconcile_product_commissions_after_order();

DROP TRIGGER IF EXISTS reconcile_product_commissions ON public.presale_orders;
CREATE TRIGGER reconcile_product_commissions
  AFTER INSERT OR UPDATE OF payment_status, payment_date, coach_id, items, total_value, commission_snapshot
  ON public.presale_orders
  FOR EACH ROW EXECUTE FUNCTION eon_private.reconcile_product_commissions_after_order();

-- Coach do pedido pelo painel ----------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_order_coach(
  p_order_type text,
  p_order_id uuid,
  p_coach_id uuid,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_previous uuid;
  v_payment_status text;
  v_result jsonb;
BEGIN
  IF p_order_type NOT IN ('stock', 'presale') OR p_order_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Pedido inválido';
  END IF;
  IF p_coach_id IS NOT NULL THEN
    PERFORM 1 FROM public.assessment_coaches WHERE id = p_coach_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Coach não encontrado';
    END IF;
  END IF;

  IF p_order_type = 'stock' THEN
    SELECT coach_id, payment_status INTO v_previous, v_payment_status
    FROM public.stock_orders WHERE id = p_order_id FOR UPDATE;
  ELSE
    SELECT coach_id, payment_status INTO v_previous, v_payment_status
    FROM public.presale_orders WHERE id = p_order_id FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Pedido não encontrado';
  END IF;

  IF v_previous IS DISTINCT FROM p_coach_id THEN
    IF p_order_type = 'stock' THEN
      UPDATE public.stock_orders SET coach_id = p_coach_id, updated_date = now() WHERE id = p_order_id;
    ELSE
      UPDATE public.presale_orders SET coach_id = p_coach_id, updated_date = now() WHERE id = p_order_id;
    END IF;

    INSERT INTO public.sales_status_events (
      order_type, order_id, previous_status, new_status, reason, metadata, actor_id
    ) VALUES (
      p_order_type, p_order_id, v_payment_status, COALESCE(v_payment_status, 'pending'),
      'Coach do pedido alterado',
      jsonb_build_object('action', 'coach_changed', 'previous_coach_id', v_previous, 'coach_id', p_coach_id),
      p_actor_id
    );
  END IF;

  IF p_order_type = 'stock' THEN
    SELECT to_jsonb(o) INTO v_result FROM public.stock_orders o WHERE o.id = p_order_id;
  ELSE
    SELECT to_jsonb(o) INTO v_result FROM public.presale_orders o WHERE o.id = p_order_id;
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.update_order_coach(text, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_order_coach(text, uuid, uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.update_order_coach(text, uuid, uuid, uuid) IS
  'Troca (ou remove) o coach do pedido. Se o pedido já foi pago, a comissão muda por novos lançamentos (estorno de um coach, comissão do outro).';

-- Extrato do repasse -------------------------------------------------------------

ALTER TABLE public.payout_monthly_statement_items
  DROP CONSTRAINT IF EXISTS payout_monthly_statement_items_source_type_check;
ALTER TABLE public.payout_monthly_statement_items
  ADD CONSTRAINT payout_monthly_statement_items_source_type_check CHECK (
    source_type IN ('athlete_repasse', 'direct_leadership', 'co_leadership', 'manual_adjustment', 'product_commission')
  );

ALTER TABLE public.payout_monthly_statement_items
  ADD COLUMN IF NOT EXISTS product_commission_id uuid
    REFERENCES public.product_commissions(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS payout_statement_items_product_commission_key
  ON public.payout_monthly_statement_items (product_commission_id)
  WHERE product_commission_id IS NOT NULL;

COMMENT ON COLUMN public.payout_monthly_statement_items.product_commission_id IS
  'Lançamento de comissão de produto que este item leva ao repasse (source_type product_commission).';
