-- players_bonus.id is UUID. The original DeepNight salary-payment routines
-- declared their returned adjustment ID as bigint, which rolled back every
-- salary payment after the players_bonus insert attempted to return its ID.
do $migration$
declare
  v_signature text;
  v_function regprocedure;
  v_definition text;
  v_fixed_definition text;
begin
  for v_signature in
    select unnest(array[
      'public.deepnight_pay_orders_with_salary(uuid[],text,text,text,text,text)',
      'public.deepnight_pay_extension_with_salary(bigint,text,text,text)',
      'public.deepnight_confirm_tip_payment(text,text,text,text,text,text,jsonb)'
    ]::text[])
  loop
    v_function := to_regprocedure(v_signature);
    if v_function is null then
      raise exception '找不到待修正的扣薪程序：%', v_signature;
    end if;

    v_definition := pg_get_functiondef(v_function);
    v_fixed_definition := replace(
      v_definition,
      'v_adjustment_id bigint;',
      'v_adjustment_id uuid;'
    );

    if v_fixed_definition = v_definition then
      if position('v_adjustment_id uuid;' in v_definition) > 0 then
        continue;
      end if;
      raise exception '扣薪程序的 adjustment ID 宣告不符合預期：%', v_signature;
    end if;

    execute v_fixed_definition;
  end loop;
end;
$migration$;

do $verification$
declare
  v_invalid_functions text[];
begin
  select array_agg(p.proname order by p.proname)
  into v_invalid_functions
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'deepnight_pay_orders_with_salary',
      'deepnight_pay_extension_with_salary',
      'deepnight_confirm_tip_payment'
    )
    and (
      position('v_adjustment_id uuid;' in pg_get_functiondef(p.oid)) = 0
      or position('v_adjustment_id bigint;' in pg_get_functiondef(p.oid)) > 0
    );

  if cardinality(v_invalid_functions) > 0 then
    raise exception '仍有扣薪程序使用錯誤的 adjustment ID 型別：%', v_invalid_functions;
  end if;
end;
$verification$;
