-- Número da fatura da cobrança externa (Asaas no painel, Stone, etc.).
-- Opcional: registrado/exibido junto do link externo para conferência/conciliação.
alter table public.assessment_contracts
  add column if not exists external_invoice_number text;
