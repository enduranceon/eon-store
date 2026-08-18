-- Área de Eventos (Fase 1): banco + admin. Sem cobrança Asaas nem formulário
-- público ainda — essas são as Fases 2 e 3, decisão do usuário em 18/ago/2026.
--
-- Modelo: events -> event_registration_types (preço e formulário próprios por
-- tipo) -> event_registrations (a inscrição, com respostas do formulário e
-- pagamento). Um evento simples (ex: "Briefing") é só um evento com UM tipo de
-- inscrição; um evento com múltiplos tipos (ex: "Endurance Camp") tem vários
-- registration_types, cada um com seu preço e seus próprios campos de
-- formulário. Não há distinção estrutural entre "evento simples" e "evento
-- complexo" — evita duas implementações para a mesma coisa.
--
-- checked_in_at e max_quantity existem desde já (nulos por padrão) porque são
-- baratos de adicionar agora e caros de emendar depois — vieram de pesquisa em
-- plataformas de inscrição de evento (Sympla, Bizzabo): controle de presença e
-- limite de vagas por tipo são funcionalidades recorrentes.
--
-- asaas_charge_id/asaas_payment_link/asaas_pix_qrcode/asaas_pix_copy também
-- existem desde já, nulos, para a Fase 2 não exigir outra migration — mas
-- nenhuma função desta migration os preenche ainda; só pagamento manual.
--
-- Segurança: leitura direta pelo navegador via RLS restrita a admin (mesmo
-- padrão de stock_orders/stock_movements). Toda escrita passa por função no
-- banco chamada pela edge function — não há INSERT/UPDATE/DELETE direto do
-- navegador (herdado do REVOKE + ALTER DEFAULT PRIVILEGES de
-- 20260727235900_lock_all_browser_table_writes.sql, que já cobre tabelas
-- novas).

CREATE TABLE public.events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  event_date DATE NOT NULL,
  location TEXT,
  revenue_center_id UUID REFERENCES public.revenue_centers(id),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'open', 'closed', 'cancelled')),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.event_registration_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  -- Vagas para este tipo especificamente (ex: "trilha longa" pode ter limite
  -- diferente de "trilha curta" dentro do mesmo evento). NULL = sem limite.
  max_quantity INTEGER CHECK (max_quantity IS NULL OR max_quantity > 0),
  -- Lista de campos do formulário deste tipo: [{key, label, kind, required,
  -- options?}]. kind em ('text','textarea','boolean','select','number').
  -- Validado pela função create_event_registration, não por CHECK — a forma
  -- de cada campo é rica demais para uma constraint simples.
  form_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.event_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_number TEXT UNIQUE,
  event_id UUID NOT NULL REFERENCES public.events(id),
  registration_type_id UUID NOT NULL REFERENCES public.event_registration_types(id),
  -- Sempre vinculado a um cliente — nunca fica "sem cliente" como aconteceu
  -- com pedidos vindos do site (ver selo 'Sem cliente' em OrderCenter, 18/ago).
  -- A entrada manual pelo admin usa o mesmo picker de cliente da venda manual;
  -- a Fase 3 (formulário público) fará o mesmo casamento por telefone/CPF que
  -- o checkout público já faz.
  customer_id UUID NOT NULL REFERENCES public.presale_customers(id),
  form_answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  payment_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'awaiting_charge', 'charge_sent', 'paid', 'cancelled', 'refunded')),
  payment_method TEXT,
  payment_date DATE,
  due_date DATE,
  manual_payment BOOLEAN NOT NULL DEFAULT false,
  asaas_charge_id TEXT,
  asaas_payment_link TEXT,
  asaas_pix_qrcode TEXT,
  asaas_pix_copy TEXT,
  external_payment_link TEXT,
  payment_message_sent_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  checked_in_at TIMESTAMPTZ,
  internal_notes TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX event_registration_types_event_id_idx ON public.event_registration_types(event_id);
CREATE INDEX event_registrations_event_id_idx ON public.event_registrations(event_id);
CREATE INDEX event_registrations_registration_type_id_idx ON public.event_registrations(registration_type_id);
CREATE INDEX event_registrations_customer_id_idx ON public.event_registrations(customer_id);

-- Numeração EVT-000001, mesmo padrão de EST-/PED- (generate_stock_order_number).
CREATE SEQUENCE public.event_registration_number_seq START 1;

CREATE OR REPLACE FUNCTION public.generate_event_registration_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  NEW.registration_number := 'EVT-' || LPAD(nextval('public.event_registration_number_seq')::text, 6, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_event_registration_number
  BEFORE INSERT ON public.event_registrations
  FOR EACH ROW WHEN (NEW.registration_number IS NULL)
  EXECUTE FUNCTION public.generate_event_registration_number();

CREATE OR REPLACE FUNCTION public.touch_events_domain_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER touch_events_updated_at BEFORE UPDATE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.touch_events_domain_updated_at();
CREATE TRIGGER touch_event_registration_types_updated_at BEFORE UPDATE ON public.event_registration_types
  FOR EACH ROW EXECUTE FUNCTION public.touch_events_domain_updated_at();
CREATE TRIGGER touch_event_registrations_updated_at BEFORE UPDATE ON public.event_registrations
  FOR EACH ROW EXECUTE FUNCTION public.touch_events_domain_updated_at();

-- RLS: mesmo padrao de stock_orders/stock_movements. Leitura permissiva
-- restrita a admin + restritiva ALL redundante como defesa em profundidade.
-- Escrita direta do navegador ja bloqueada por GRANT (default privileges).
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_registration_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_registrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY events_admin_read ON public.events
  FOR SELECT TO authenticated USING (eon_private.is_app_admin());
CREATE POLICY events_admin_only ON public.events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (eon_private.is_app_admin()) WITH CHECK (eon_private.is_app_admin());

CREATE POLICY event_registration_types_admin_read ON public.event_registration_types
  FOR SELECT TO authenticated USING (eon_private.is_app_admin());
CREATE POLICY event_registration_types_admin_only ON public.event_registration_types
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (eon_private.is_app_admin()) WITH CHECK (eon_private.is_app_admin());

CREATE POLICY event_registrations_admin_read ON public.event_registrations
  FOR SELECT TO authenticated USING (eon_private.is_app_admin());
CREATE POLICY event_registrations_admin_only ON public.event_registrations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (eon_private.is_app_admin()) WITH CHECK (eon_private.is_app_admin());

GRANT SELECT ON public.events, public.event_registration_types, public.event_registrations
  TO authenticated, anon;
GRANT ALL ON public.events, public.event_registration_types, public.event_registrations
  TO service_role;
GRANT USAGE ON SEQUENCE public.event_registration_number_seq TO service_role;

-- sales_status_events guarda a auditoria de mudança de status também para
-- pedidos e contratos; amplia para aceitar 'event'. Não reaproveitamos
-- order_operations (o padrão prepare/complete de duas fases) porque essa
-- fase não tem chamada externa (Asaas) a coordenar — pagamento manual é uma
-- única transação atômica, sem necessidade de idempotência entre etapas.
ALTER TABLE public.sales_status_events DROP CONSTRAINT sales_status_events_order_type_check;
ALTER TABLE public.sales_status_events ADD CONSTRAINT sales_status_events_order_type_check
  CHECK (order_type = ANY (ARRAY['presale'::text, 'stock'::text, 'contract'::text, 'event'::text]));

-- Cria a inscrição, validando capacidade do tipo e os campos obrigatórios do
-- formulário. Segue o mesmo estilo de validação de payload que
-- normalizeStockProductPayload faz no lado TypeScript, mas aqui em SQL porque
-- a criação também precisa do lock de capacidade (FOR UPDATE), que só faz
-- sentido dentro da transação do banco.
CREATE OR REPLACE FUNCTION public.create_event_registration(
  p_event_id UUID,
  p_registration_type_id UUID,
  p_customer_id UUID,
  p_form_answers JSONB,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_type public.event_registration_types%ROWTYPE;
  v_event_status TEXT;
  v_active_count INTEGER;
  v_field JSONB;
  v_key TEXT;
  v_answer JSONB;
  v_registration public.event_registrations%ROWTYPE;
BEGIN
  IF p_customer_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Cliente e operador são obrigatórios';
  END IF;

  SELECT status INTO v_event_status FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Evento não encontrado';
  END IF;
  IF v_event_status NOT IN ('draft', 'open') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este evento não está aceitando inscrições';
  END IF;

  SELECT * INTO v_type
  FROM public.event_registration_types
  WHERE id = p_registration_type_id AND event_id = p_event_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Tipo de inscrição não encontrado para este evento';
  END IF;
  IF NOT v_type.active THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Este tipo de inscrição não está mais disponível';
  END IF;

  IF v_type.max_quantity IS NOT NULL THEN
    SELECT count(*) INTO v_active_count
    FROM public.event_registrations
    WHERE registration_type_id = p_registration_type_id
      AND payment_status <> 'cancelled';
    IF v_active_count >= v_type.max_quantity THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Vagas esgotadas para este tipo de inscrição';
    END IF;
  END IF;

  IF NOT jsonb_typeof(COALESCE(p_form_answers, '{}'::jsonb)) = 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Respostas do formulário inválidas';
  END IF;

  -- Valida que todo campo obrigatório do tipo tem resposta não vazia.
  FOR v_field IN SELECT * FROM jsonb_array_elements(COALESCE(v_type.form_fields, '[]'::jsonb))
  LOOP
    IF COALESCE((v_field->>'required')::boolean, false) THEN
      v_key := v_field->>'key';
      v_answer := p_form_answers -> v_key;
      IF v_answer IS NULL
         OR jsonb_typeof(v_answer) = 'null'
         OR (jsonb_typeof(v_answer) = 'string' AND trim(v_answer #>> '{}') = '') THEN
        RAISE EXCEPTION USING
          ERRCODE = '22023',
          MESSAGE = 'Campo obrigatório não preenchido: ' || COALESCE(v_field->>'label', v_key);
      END IF;
    END IF;
  END LOOP;

  INSERT INTO public.event_registrations (
    event_id, registration_type_id, customer_id, form_answers,
    due_date, created_by
  ) VALUES (
    p_event_id, p_registration_type_id, p_customer_id, COALESCE(p_form_answers, '{}'::jsonb),
    CASE WHEN v_type.price > 0 THEN current_date ELSE NULL END,
    p_actor_id
  )
  RETURNING * INTO v_registration;

  RETURN to_jsonb(v_registration);
END;
$$;

-- Marca a inscrição como paga manualmente (Fase 1: sem Asaas). Espelha
-- record_manual_payment/api_record_manual_payment em formato, mas dedicada —
-- mesma decisão de contratos, que também não reaproveitam a função de pedidos.
CREATE OR REPLACE FUNCTION public.record_event_registration_manual_payment(
  p_registration_id UUID,
  p_payment_method TEXT,
  p_payment_date DATE,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_previous_status TEXT;
  v_registration public.event_registrations%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF NULLIF(trim(COALESCE(p_payment_method, '')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe a forma de pagamento';
  END IF;

  SELECT payment_status INTO v_previous_status
  FROM public.event_registrations WHERE id = p_registration_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Inscrição não encontrada';
  END IF;
  IF v_previous_status IN ('paid', 'cancelled', 'refunded') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Esta inscrição não pode receber pagamento neste status';
  END IF;

  UPDATE public.event_registrations
  SET payment_status = 'paid',
      manual_payment = true,
      payment_method = trim(p_payment_method),
      payment_date = COALESCE(p_payment_date, current_date)
  WHERE id = p_registration_id
  RETURNING * INTO v_registration;

  INSERT INTO public.sales_status_events (order_type, order_id, previous_status, new_status, reason, metadata, actor_id)
  VALUES ('event', p_registration_id, v_previous_status, 'paid', 'Pagamento manual registrado',
    jsonb_build_object('action', 'event_registration_paid', 'payment_method', trim(p_payment_method)),
    p_actor_id);

  RETURN to_jsonb(v_registration);
END;
$$;

-- Cancela a inscrição. Sem devolução de estoque (eventos não reservam
-- produto) e sem cancelamento de cobrança externa nesta fase (não há Asaas
-- ainda). Libera a vaga para outro inscrito, já que a contagem de capacidade
-- em create_event_registration ignora registros cancelados.
CREATE OR REPLACE FUNCTION public.cancel_event_registration(
  p_registration_id UUID,
  p_reason TEXT,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_previous_status TEXT;
  v_registration public.event_registrations%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Informe o motivo do cancelamento';
  END IF;

  SELECT payment_status INTO v_previous_status
  FROM public.event_registrations WHERE id = p_registration_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Inscrição não encontrada';
  END IF;
  IF v_previous_status = 'cancelled' THEN
    RETURN to_jsonb((SELECT r FROM public.event_registrations r WHERE r.id = p_registration_id));
  END IF;

  UPDATE public.event_registrations
  SET payment_status = 'cancelled', cancellation_reason = trim(p_reason)
  WHERE id = p_registration_id
  RETURNING * INTO v_registration;

  INSERT INTO public.sales_status_events (order_type, order_id, previous_status, new_status, reason, metadata, actor_id)
  VALUES ('event', p_registration_id, v_previous_status, 'cancelled', trim(p_reason),
    jsonb_build_object('action', 'event_registration_cancelled'), p_actor_id);

  RETURN to_jsonb(v_registration);
END;
$$;

REVOKE ALL ON FUNCTION public.create_event_registration(UUID, UUID, UUID, JSONB, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_event_registration_manual_payment(UUID, TEXT, DATE, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_event_registration(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_event_registration(UUID, UUID, UUID, JSONB, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_event_registration_manual_payment(UUID, TEXT, DATE, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_event_registration(UUID, TEXT, UUID) TO service_role;

-- Semeia o primeiro evento real do usuário para validar o modelo com uso de
-- verdade. "Eventos · Clínicas" já existia em revenue_centers antes desta
-- migration, criado em antecipação a esta área.
INSERT INTO public.events (name, slug, description, event_date, status, revenue_center_id)
SELECT
  'Briefing Maratona Internacional de Florianópolis',
  'briefing-maratona-internacional-de-florianopolis',
  NULL,
  CURRENT_DATE + INTERVAL '30 days',
  'draft',
  (SELECT id FROM public.revenue_centers WHERE type = 'eventos' LIMIT 1);

DO $$
DECLARE
  v_event_id UUID;
BEGIN
  SELECT id INTO v_event_id FROM public.events WHERE slug = 'briefing-maratona-internacional-de-florianopolis';
  INSERT INTO public.event_registration_types (event_id, name, price, form_fields, sort_order)
  VALUES (
    v_event_id,
    'Inscrição',
    15.00,
    '[]'::jsonb,
    0
  );
END;
$$;
