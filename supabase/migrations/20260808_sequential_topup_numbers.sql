begin;

create sequence if not exists public.topup_number_seq
  as bigint
  start with 1
  increment by 1
  minvalue 1
  no maxvalue
  cache 1;

create or replace function public.next_topup_number()
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  sequence_value bigint;
begin
  sequence_value := nextval('public.topup_number_seq'::regclass);
  return 'TOP-' || lpad(
    sequence_value::text,
    greatest(10, length(sequence_value::text)),
    '0'
  );
end;
$$;

revoke all on function public.next_topup_number()
  from public, anon, authenticated;
grant execute on function public.next_topup_number() to service_role;

commit;
