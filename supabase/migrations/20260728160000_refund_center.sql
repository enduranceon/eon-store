-- Central de Estornos.
--
-- Antes o estorno só existia como uma seção do Financeiro que listava o que
-- estava pendente e sumia para sempre depois da baixa: não havia histórico,
-- não havia comprovante e os estornos de contrato (manuais) viviam separados
-- dos de pedido (automáticos via Asaas). Aqui entram as três peças que
-- faltavam: uma visão que junta as duas origens, uma tabela de comprovantes e
-- um bucket privado para os arquivos.

-- ── Comprovantes ────────────────────────────────────────────────────────────
-- Server-only, como as tabelas *_operations: o navegador nunca escreve aqui.
-- O arquivo em si mora no Storage; esta tabela guarda só o ponteiro.
CREATE TABLE IF NOT EXISTS public.refund_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL CHECK (source_type IN ('assessment_contract', 'presale_order', 'stock_order')),
  source_id uuid NOT NULL,
  file_path text NOT NULL UNIQUE,
  file_name text NOT NULL,
  mime_type text,
  size_bytes bigint,
  uploaded_by uuid,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS refund_receipts_source_idx
  ON public.refund_receipts (source_type, source_id);

ALTER TABLE public.refund_receipts ENABLE ROW LEVEL SECURITY;

-- Leitura pelo painel segue o padrão das demais tabelas: restritiva para
-- admins + permissiva de SELECT. Escrita fica só com a API (sem grants).
DROP POLICY IF EXISTS app_admin_only ON public.refund_receipts;
CREATE POLICY app_admin_only ON public.refund_receipts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT eon_private.is_app_admin()))
  WITH CHECK ((SELECT eon_private.is_app_admin()));

DROP POLICY IF EXISTS app_admin_read ON public.refund_receipts;
CREATE POLICY app_admin_read ON public.refund_receipts
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((SELECT eon_private.is_app_admin()));

GRANT SELECT ON public.refund_receipts TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.refund_receipts FROM anon, authenticated;

-- ── Visão unificada ─────────────────────────────────────────────────────────
-- Contrato de assessoria: estorno MANUAL, nasce 'pending' e vira 'done' quando
-- alguém confirma que pagou. Pedido: estorno AUTOMÁTICO pelo Asaas, então já
-- entra como 'done' — não existe "a fazer" para ele.
CREATE OR REPLACE VIEW public.refunds_overview
WITH (security_invoker = true) AS
SELECT
  'assessment_contract'::text                       AS source_type,
  c.id                                              AS source_id,
  c.contract_number                                 AS reference,
  c.customer_id                                     AS customer_id,
  cu.full_name                                      AS customer_name,
  COALESCE(c.refund_amount, 0)::numeric             AS amount,
  c.refund_status                                   AS status,
  'manual'::text                                    AS kind,
  c.cancellation_date                               AS requested_on,
  c.refund_date                                     AS completed_on,
  c.refund_notes                                    AS notes,
  c.payment_method                                  AS payment_method,
  c.cancellation_reason                             AS reason,
  c.updated_at                                      AS updated_at
FROM public.assessment_contracts c
LEFT JOIN public.presale_customers cu ON cu.id = c.customer_id
WHERE c.refund_status IS NOT NULL AND COALESCE(c.refund_amount, 0) > 0

UNION ALL

SELECT
  'presale_order',
  o.id,
  o.order_number,
  o.customer_id,
  COALESCE(cu.full_name, o.customer_name),
  COALESCE(o.total_amount, o.total_value, 0)::numeric,
  'done',
  'automatic',
  o.status_changed_at::date,
  o.status_changed_at::date,
  NULL,
  o.payment_method,
  o.cancellation_reason,
  o.status_changed_at
FROM public.presale_orders o
LEFT JOIN public.presale_customers cu ON cu.id = o.customer_id
WHERE o.payment_status = 'refunded'

UNION ALL

SELECT
  'stock_order',
  s.id,
  s.order_number,
  s.customer_id,
  COALESCE(cu.full_name, s.customer_name),
  COALESCE(s.total_value, 0)::numeric,
  'done',
  'automatic',
  s.status_changed_at::date,
  s.status_changed_at::date,
  NULL,
  s.payment_method,
  s.cancellation_reason,
  s.status_changed_at
FROM public.stock_orders s
LEFT JOIN public.presale_customers cu ON cu.id = s.customer_id
WHERE s.payment_status = 'refunded';

REVOKE ALL ON public.refunds_overview FROM PUBLIC, anon;
GRANT SELECT ON public.refunds_overview TO authenticated, service_role;

-- ── Bucket privado dos comprovantes ─────────────────────────────────────────
-- Sem policies em storage.objects para este bucket: o navegador não sobe nem
-- baixa direto. A api-v1 assina URLs de upload e download com a service_role,
-- e a URL assinada é o único caminho.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'refund-receipts',
  'refund-receipts',
  false,
  10485760,
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ── Registro do comprovante ────────────────────────────────────────────────
-- Chamada depois que o upload assinado terminou. Valida que a origem existe de
-- verdade, para não acumular ponteiro órfão apontando para nada.
CREATE OR REPLACE FUNCTION public.register_refund_receipt(
  p_source_type text,
  p_source_id uuid,
  p_file_path text,
  p_file_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_exists boolean;
  v_row public.refund_receipts%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  IF p_source_type NOT IN ('assessment_contract', 'presale_order', 'stock_order') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Origem inválida';
  END IF;
  IF coalesce(btrim(p_file_path), '') = '' OR coalesce(btrim(p_file_name), '') = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Arquivo inválido';
  END IF;

  v_exists := CASE p_source_type
    WHEN 'assessment_contract' THEN EXISTS (SELECT 1 FROM public.assessment_contracts WHERE id = p_source_id)
    WHEN 'presale_order'       THEN EXISTS (SELECT 1 FROM public.presale_orders WHERE id = p_source_id)
    ELSE                            EXISTS (SELECT 1 FROM public.stock_orders WHERE id = p_source_id)
  END;
  IF NOT v_exists THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Registro de origem não encontrado';
  END IF;

  INSERT INTO public.refund_receipts (
    source_type, source_id, file_path, file_name, mime_type, size_bytes, uploaded_by
  ) VALUES (
    p_source_type, p_source_id, btrim(p_file_path), btrim(p_file_name),
    nullif(btrim(p_mime_type), ''), p_size_bytes, p_actor_id
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('receipt', to_jsonb(v_row));
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_refund_receipt(
  p_receipt_id uuid,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_row public.refund_receipts%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Operador inválido';
  END IF;
  DELETE FROM public.refund_receipts WHERE id = p_receipt_id RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Comprovante não encontrado';
  END IF;
  RETURN jsonb_build_object('receipt', to_jsonb(v_row));
END;
$$;

REVOKE ALL ON FUNCTION public.register_refund_receipt(text, uuid, text, text, text, bigint, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_refund_receipt(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.register_refund_receipt(text, uuid, text, text, text, bigint, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_refund_receipt(uuid, uuid)
  TO service_role;
