begin;

-- Funcoes internas e de trigger nao devem ser invocadas diretamente pelo
-- navegador. A API usa service_role para as operacoes administrativas.
revoke execute on function public.assign_presale_customer_code()
  from public, anon, authenticated;
revoke execute on function public.find_customer_id_by_cpf(text)
  from public, anon, authenticated;
revoke execute on function public.generate_assessment_contract_number()
  from public, anon, authenticated;
revoke execute on function public.record_manual_payment(text, uuid, uuid, date, numeric, jsonb)
  from public, anon, authenticated;
revoke execute on function public.sync_coach_history()
  from public, anon, authenticated;

grant execute on function public.assign_presale_customer_code()
  to service_role;
grant execute on function public.find_customer_id_by_cpf(text)
  to service_role;
grant execute on function public.generate_assessment_contract_number()
  to service_role;
grant execute on function public.record_manual_payment(text, uuid, uuid, date, numeric, jsonb)
  to service_role;
grant execute on function public.sync_coach_history()
  to service_role;

-- Evita que objetos com nomes conflitantes sejam resolvidos por um schema
-- controlado pelo chamador.
alter function public.br_easter_date(integer)
  set search_path = pg_catalog, public, pg_temp;
alter function public.br_is_holiday(date)
  set search_path = pg_catalog, public, pg_temp;
alter function public.br_next_business_day(date)
  set search_path = pg_catalog, public, pg_temp;
alter function public.normalize_phone_br_e164(text)
  set search_path = pg_catalog, public, pg_temp;

commit;
