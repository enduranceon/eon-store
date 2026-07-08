-- Categoria do gasto/reembolso em itens de ajuste manual do fechamento
-- (reembolso combustível, insumos de treino, escala/evento, etc.).
alter table public.payout_monthly_statement_items
  add column if not exists expense_category text;
