-- Arquivo do Tecnofit: todos os clientes e recibos do sistema antigo (2020 a 2026).
--
-- É só consulta. Não gera contrato, cobrança, pagamento nem repasse, e nenhum
-- indicador lê estas tabelas. Os dados pessoais são carregados direto no banco
-- e não ficam no repositório.

CREATE TABLE public.tecnofit_archive_clients (
  tecnofit_code integer PRIMARY KEY CHECK (tecnofit_code > 0),
  full_name text NOT NULL CHECK (btrim(full_name) <> ''),
  tecnofit_status text NOT NULL
    CHECK (tecnofit_status IN ('Cancelado', 'Excluído', 'Em Licença', 'Sem Contrato', 'Bloqueado')),
  -- Pessoa da EON Store, quando é a mesma: recibo citado num contrato do
  -- histórico, nome completo idêntico ou conferência manual.
  customer_id uuid REFERENCES public.presale_customers(id) ON DELETE SET NULL,
  customer_link text CHECK (customer_link IN ('receipt', 'name', 'manual')),
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tecnofit_archive_clients_customer_idx
  ON public.tecnofit_archive_clients (customer_id)
  WHERE customer_id IS NOT NULL;

CREATE TABLE public.tecnofit_archive_receipts (
  tecnofit_code integer NOT NULL
    REFERENCES public.tecnofit_archive_clients(tecnofit_code) ON DELETE CASCADE,
  -- O Tecnofit repete o número em recibos de clientes diferentes.
  receipt_number integer NOT NULL CHECK (receipt_number > 0),
  kind text NOT NULL CHECK (kind IN ('plan', 'fee', 'event', 'store', 'service')),
  description text NOT NULL CHECK (btrim(description) <> ''),
  item_name text NOT NULL CHECK (btrim(item_name) <> ''),
  period_start date,
  period_end date,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  payment_method text NOT NULL DEFAULT '',
  issued_at timestamptz NOT NULL,
  origin text NOT NULL DEFAULT '',
  responsible text NOT NULL DEFAULT '',
  consultant text NOT NULL DEFAULT '',
  source_report text NOT NULL CHECK (source_report ~ '^relatorio_[0-9]+$'),
  PRIMARY KEY (tecnofit_code, receipt_number),
  CONSTRAINT tecnofit_archive_receipts_period_check CHECK (
    (period_start IS NULL) = (period_end IS NULL)
    AND (period_end IS NULL OR period_end >= period_start)
  ),
  CONSTRAINT tecnofit_archive_receipts_plan_period_check CHECK (
    (kind = 'plan') = (period_start IS NOT NULL)
  )
);

COMMENT ON TABLE public.tecnofit_archive_clients IS
  'Arquivo só de consulta: clientes do Tecnofit (sistema antigo). Não entra em indicadores, financeiro nem repasse.';
COMMENT ON TABLE public.tecnofit_archive_receipts IS
  'Arquivo só de consulta: recibos do Tecnofit de 2020 a 2026, como vieram dos relatórios.';

-- Uma linha por cliente, com o resumo dos recibos. "Tem contrato na EON Store"
-- é calculado na hora, então reflete quem voltou depois da carga.
CREATE VIEW public.tecnofit_archive_people
WITH (security_invoker = true) AS
SELECT
  client.tecnofit_code,
  client.full_name,
  client.tecnofit_status,
  client.customer_id,
  client.customer_link,
  EXISTS (
    SELECT 1
    FROM public.assessment_contracts AS eon
    WHERE eon.customer_id = client.customer_id
      AND eon.status NOT IN ('draft', 'voided')
  ) AS has_eon_contract,
  summary.receipts_count,
  summary.plans_count,
  summary.receipts_total,
  summary.first_plan_start,
  summary.last_plan_end,
  summary.last_plan_name,
  summary.first_receipt_at,
  summary.last_receipt_at
FROM public.tecnofit_archive_clients AS client
CROSS JOIN LATERAL (
  SELECT
    count(*)::integer AS receipts_count,
    (count(*) FILTER (WHERE receipt.kind = 'plan'))::integer AS plans_count,
    COALESCE(sum(receipt.amount), 0)::numeric(12,2) AS receipts_total,
    min(receipt.period_start) AS first_plan_start,
    max(receipt.period_end) AS last_plan_end,
    (array_agg(receipt.item_name ORDER BY receipt.period_end DESC, receipt.issued_at DESC)
      FILTER (WHERE receipt.kind = 'plan'))[1] AS last_plan_name,
    min(receipt.issued_at) AS first_receipt_at,
    max(receipt.issued_at) AS last_receipt_at
  FROM public.tecnofit_archive_receipts AS receipt
  WHERE receipt.tecnofit_code = client.tecnofit_code
) AS summary;

COMMENT ON VIEW public.tecnofit_archive_people IS
  'Resumo por cliente do arquivo do Tecnofit para a página Ex-alunos do Tecnofit.';

-- Acesso: o painel admin lê; ninguém escreve pela API ----------------------------

ALTER TABLE public.tecnofit_archive_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tecnofit_archive_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_admin_only ON public.tecnofit_archive_clients
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT eon_private.is_app_admin()))
  WITH CHECK ((SELECT eon_private.is_app_admin()));
CREATE POLICY app_admin_read ON public.tecnofit_archive_clients
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((SELECT eon_private.is_app_admin()));

CREATE POLICY app_admin_only ON public.tecnofit_archive_receipts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT eon_private.is_app_admin()))
  WITH CHECK ((SELECT eon_private.is_app_admin()));
CREATE POLICY app_admin_read ON public.tecnofit_archive_receipts
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((SELECT eon_private.is_app_admin()));

REVOKE ALL ON public.tecnofit_archive_clients, public.tecnofit_archive_receipts,
  public.tecnofit_archive_people
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.tecnofit_archive_clients, public.tecnofit_archive_receipts,
  public.tecnofit_archive_people
  TO authenticated, service_role;
