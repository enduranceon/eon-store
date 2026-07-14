alter table public.presale_customers
  add column if not exists customer_code text,
  add column if not exists address_zip text,
  add column if not exists address_street text,
  add column if not exists address_number text,
  add column if not exists address_complement text,
  add column if not exists address_neighborhood text,
  add column if not exists address_city text,
  add column if not exists address_state text;

create sequence if not exists public.presale_customer_code_seq;

with numbered as (
  select
    id,
    row_number() over (
      order by created_date nulls last, full_name, id
    ) as seq
  from public.presale_customers
  where customer_code is null or btrim(customer_code) = ''
)
update public.presale_customers c
set customer_code = lpad(numbered.seq::text, 3, '0')
from numbered
where c.id = numbered.id;

select setval(
  'public.presale_customer_code_seq',
  greatest(
    (
      select coalesce(max(customer_code::integer), 1)
      from public.presale_customers
      where customer_code ~ '^[0-9]+$'
    ),
    1
  ),
  true
);

create unique index if not exists presale_customers_customer_code_key
  on public.presale_customers (customer_code)
  where customer_code is not null;

create or replace function public.assign_presale_customer_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.customer_code is null or btrim(new.customer_code) = '' then
    new.customer_code := lpad(nextval('public.presale_customer_code_seq')::text, 3, '0');
  end if;
  return new;
end;
$$;

revoke all on function public.assign_presale_customer_code() from public;

drop trigger if exists set_presale_customer_code on public.presale_customers;

create trigger set_presale_customer_code
before insert on public.presale_customers
for each row
execute function public.assign_presale_customer_code();
