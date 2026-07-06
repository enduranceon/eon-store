-- Pendências de repasse (carry-forward): repasse devido mas ainda não pagável
-- porque o aluno não pagou. Ao pagar, vira item no fechamento do mês do pagamento.
create table if not exists public.payout_pending_repasse (
  id                     uuid primary key default gen_random_uuid(),
  contract_id            uuid not null references public.assessment_contracts(id) on delete cascade,
  coach_id               uuid not null references public.assessment_coaches(id) on delete cascade,
  source_type            text not null,
  reference_competence   date not null,
  description            text,
  amount                 numeric(12,2) not null default 0,
  valid_days             int,
  month_days             int,
  prorata_factor         numeric,
  rate_applied           numeric,
  tier_applied           jsonb,
  base_value             numeric,
  leadership_bonus       numeric,
  status                 text not null default 'open',
  detected_in_closing_id uuid references public.payout_monthly_closings(id) on delete set null,
  resolved_in_closing_id uuid references public.payout_monthly_closings(id) on delete set null,
  created_at             timestamptz not null default now(),
  resolved_at            timestamptz,
  constraint payout_pending_repasse_status_chk check (status in ('open','resolved','cancelled')),
  constraint payout_pending_repasse_uniq unique (contract_id, coach_id, source_type, reference_competence)
);

create index if not exists idx_pending_repasse_status   on public.payout_pending_repasse(status);
create index if not exists idx_pending_repasse_ref      on public.payout_pending_repasse(reference_competence);
create index if not exists idx_pending_repasse_contract on public.payout_pending_repasse(contract_id);

alter table public.payout_pending_repasse enable row level security;

create policy "auth_full" on public.payout_pending_repasse
  for all to authenticated using (true) with check (true);

create policy "app_admin_only" on public.payout_pending_repasse
  for all to authenticated using (eon_private.is_app_admin()) with check (eon_private.is_app_admin());

-- Competência de referência nos itens: distingue "deste mês" de "resgatado de mês anterior".
alter table public.payout_monthly_statement_items
  add column if not exists reference_competence date;
