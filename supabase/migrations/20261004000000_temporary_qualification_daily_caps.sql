-- Temporary qualification limit only. Never changes wallets, paid amounts or salaries.
begin;
create table if not exists public.qualification_cap_policy (
  id text primary key,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  daily_limit numeric not null check (daily_limit > 0)
);
insert into public.qualification_cap_policy values
 ('2026-10-10', now(), '2026-10-10 00:00:00+08', 10000)
on conflict (id) do nothing;
create table if not exists public.qualification_daily_usage (
  scope text not null, user_id text not null, activity_type text not null,
  local_date date not null, counted_amount numeric not null default 0,
  primary key(scope, user_id, activity_type, local_date),
  check (activity_type in ('spend','topup')),
  check (counted_amount >= 0)
);
create table if not exists public.qualification_cap_operations (
  scope text not null, user_id text not null, activity_type text not null,
  operation_key text not null, local_date date not null,
  original_amount numeric not null, counted_amount numeric not null,
  created_at timestamptz not null default now(),
  primary key(scope, user_id, activity_type, operation_key)
);
alter table public.qualification_cap_policy enable row level security;
alter table public.qualification_daily_usage enable row level security;
alter table public.qualification_cap_operations enable row level security;
revoke all on public.qualification_cap_policy, public.qualification_daily_usage,
 public.qualification_cap_operations from public, anon, authenticated;
grant select on public.qualification_cap_policy, public.qualification_daily_usage,
 public.qualification_cap_operations to service_role;

create or replace function public.qualification_cap_amount(
 p_scope text, p_user_id text, p_activity_type text,
 p_amount numeric, p_operation_key text default null
) returns numeric language plpgsql security definer set search_path = public as $cap$
declare
 policy public.qualification_cap_policy%rowtype;
 op public.qualification_cap_operations%rowtype;
 day_value date := (now() at time zone 'Asia/Taipei')::date;
 used_amount numeric;
 baseline numeric;
 allowed_amount numeric;
 refund_counted numeric;
 refund_rows integer;
 refund_platform text;
 key_value text := coalesce(nullif(p_operation_key,''), gen_random_uuid()::text);
begin
 -- A refund reverses only qualification actually awarded, never the excluded excess.
 -- Daily allowance is not reopened by refunds (prevents refund/recharge farming).
 if p_scope='alliance' and p_amount<0 and p_operation_key like 'jkopay-refund:%' then
   select count(*),coalesce(sum(qualifying_amount),0) into refund_rows,refund_counted
   from public.alliance_point_ledger where discord_user_id=p_user_id and point_kind='membership'
   and source_key=replace(p_operation_key,'jkopay-refund:','jkopay-topup:');
   if refund_rows>0 then return -least(abs(p_amount),greatest(0,refund_counted)); end if;
 elsif p_scope='alliance' and p_amount<0 and p_operation_key like 'jkopay-service-refund:%' then
   refund_platform := substring(p_operation_key from length('jkopay-service-refund:')+1);
   select count(*),coalesce(sum(l.qualifying_amount),0) into refund_rows,refund_counted
   from public.alliance_point_ledger l where l.discord_user_id=p_user_id and l.point_kind='membership'
   and (l.source_key in ('jkopay-service:' || refund_platform || ':tip',
       'jkopay-service:' || refund_platform || ':extension')
     or l.source_key in (select 'order:' || ids.id from public.jkopay_service_payments p
       cross join lateral jsonb_array_elements_text(case when jsonb_typeof(p.metadata->'orderIds')='array'
         then p.metadata->'orderIds' else jsonb_build_array(p.entity_key) end) ids(id)
       where p.platform_order_id=refund_platform and p.user_id=p_user_id));
   if refund_rows>0 then return -least(abs(p_amount),greatest(0,refund_counted)); end if;
 end if;
 if p_amount <= 0 or p_activity_type not in ('spend','topup') then return p_amount; end if;
 if p_scope not in ('alliance', 'vip:1206138511535898654', 'vip:1501098191813214312') then
   return p_amount;
 end if;
 -- Retry a partially credited operation with its original credit, even after expiry.
 select * into op from public.qualification_cap_operations
 where scope=p_scope and user_id=p_user_id and activity_type=p_activity_type
 and operation_key=key_value;
 if found then
   if op.original_amount <> p_amount then raise exception '累積工作編號與原始金額不一致'; end if;
   return op.counted_amount;
 end if;
 select * into policy from public.qualification_cap_policy where id='2026-10-10';
 if not found or now() < policy.starts_at or now() >= policy.ends_at then return p_amount; end if;
 -- Consistent lock order across both RPC and legacy writers: member row, then daily row.
 if p_scope like 'vip:%' then
   insert into public.user_vips(user_id,guild_id)
   values(p_user_id,substring(p_scope from 5)) on conflict(guild_id,user_id) do nothing;
   perform 1 from public.user_vips
   where user_id=p_user_id and guild_id=substring(p_scope from 5) for update;
 end if;
 -- Already-earned credits are not clawed back; they consume today's remaining allowance.
 select least(policy.daily_limit, coalesce(sum(greatest(0, qualifying_amount)),0)) into baseline
 from public.alliance_point_ledger
 where discord_user_id=p_user_id and point_kind='membership' and source_type=p_activity_type
 and source_guild_id in ('1206138511535898654','1501098191813214312')
 and (p_scope='alliance' or source_guild_id=substring(p_scope from 5))
 and created_at >= (day_value::timestamp at time zone 'Asia/Taipei')
 and created_at < policy.starts_at;
 insert into public.qualification_daily_usage(scope,user_id,activity_type,local_date,counted_amount)
 values(p_scope,p_user_id,p_activity_type,day_value,baseline) on conflict do nothing;
 select counted_amount into used_amount from public.qualification_daily_usage
 where scope=p_scope and user_id=p_user_id and activity_type=p_activity_type and local_date=day_value
 for update;
 -- A concurrent duplicate can have completed while waiting for the daily row lock.
 select * into op from public.qualification_cap_operations
 where scope=p_scope and user_id=p_user_id and activity_type=p_activity_type and operation_key=key_value;
 if found then
   if op.original_amount <> p_amount then raise exception '累積工作編號與原始金額不一致'; end if;
   return op.counted_amount;
 end if;
 allowed_amount := least(p_amount, greatest(0, policy.daily_limit-used_amount));
 update public.qualification_daily_usage set counted_amount=counted_amount+allowed_amount
 where scope=p_scope and user_id=p_user_id and activity_type=p_activity_type and local_date=day_value;
 insert into public.qualification_cap_operations
 (scope,user_id,activity_type,operation_key,local_date,original_amount,counted_amount)
 values(p_scope,p_user_id,p_activity_type,key_value,day_value,p_amount,allowed_amount);
 return allowed_amount;
end;
$cap$;
revoke all on function public.qualification_cap_amount(text,text,text,numeric,text) from public, anon, authenticated;
grant execute on function public.qualification_cap_amount(text,text,text,numeric,text) to service_role;

-- Apply qualification limits inside the existing locked/deduplicated RPCs.
-- Assert source anchors so a divergent production definition aborts the whole migration.
do $patch$
declare definition text; modified text; marker text;
begin
 definition := pg_get_functiondef('public.alliance_apply_activity(text,text,text,numeric,text,text)'::regprocedure);
 if position('qualification_cap_amount' in definition)=0 then
   modified := replace(definition, 'v_reward_delta bigint := 0;',
     'v_reward_delta bigint := 0; v_actual_amount numeric := p_amount;');
   marker := '  if p_activity_type in (''spend'', ''refund'') then';
   if position(marker in modified)=0 then raise exception 'alliance definition changed'; end if;
   modified := replace(modified, marker, $inject$
  if p_source_key is not null and exists (
    select 1 from public.alliance_point_ledger where dedupe_key='membership:' || p_source_key
  ) then return v_member; end if;
  if p_guild_id in ('1206138511535898654','1501098191813214312') then
    p_amount := public.qualification_cap_amount('alliance',p_discord_user_id,p_activity_type,p_amount,p_source_key);
  end if;
  if p_activity_type in ('spend', 'refund') then$inject$);
   -- Reward points are not cumulative qualification; retain rewards on the full spend.
   modified := replace(modified,'trunc(p_amount * v_settings.reward_points_per_asd)',
     'trunc(v_actual_amount * v_settings.reward_points_per_asd)');
   if modified=definition or position('v_actual_amount numeric' in modified)=0 then
     raise exception 'alliance patch failed';
   end if;
   execute modified;
 end if;

 definition := pg_get_functiondef('public.qiunai_apply_vip_effect(text,text,text,text,numeric)'::regprocedure);
 if position('qualification_cap_amount' in definition)=0 then
   modified := replace(definition,'amount_value integer;', 'amount_value integer; counted_value numeric;');
   modified := replace(modified,'  if inserted_count > 0 then', $inject$
  if inserted_count > 0 then
    counted_value := public.qualification_cap_amount('vip:' || normalized_guild,
      normalized_user,p_trigger_type,amount_value,'effect:' || normalized_key);$inject$);
   modified := replace(modified,'+ amount_value)', '+ counted_value)');
   if position('counted_value := public.qualification_cap_amount' in modified)=0 or modified=definition then
     raise exception 'qiunai VIP definition changed';
   end if;
   execute modified;
 end if;

 definition := pg_get_functiondef('public.deepnight_apply_vip_activity_once(text,text,text,text,numeric)'::regprocedure);
 if position('qualification_cap_amount' in definition)=0 then
   modified := replace(definition,'  v_inserted integer := 0;', '  v_inserted integer := 0; v_counted numeric;');
   marker := '  insert into public.user_vips(';
   if position(marker in modified)=0 then raise exception 'deepnight activity definition changed'; end if;
   modified := replace(modified,marker, $inject$
  v_counted := public.qualification_cap_amount('vip:' || p_guild_id,
    p_user_id,p_trigger_type,v_amount,'activity:' || p_operation_key);
  insert into public.user_vips($inject$);
   modified := replace(modified,'case when p_trigger_type = ''spend'' then v_amount else 0 end',
     'case when p_trigger_type = ''spend'' then v_counted else 0 end');
   modified := replace(modified,'case when p_trigger_type = ''topup'' then v_amount else 0 end,',
     'case when p_trigger_type = ''topup'' then v_counted else 0 end,');
   -- The single-topup record is not a cumulative field; keep the real amount.
   modified := replace(modified,
     'case when p_trigger_type = ''topup'' then v_counted else 0 end,' || chr(10) || '    now()',
     'case when p_trigger_type = ''topup'' then v_amount else 0 end,' || chr(10) || '    now()');
   if position('v_counted := public.qualification_cap_amount' in modified)=0 then
     raise exception 'deepnight activity patch failed';
   end if;
   execute modified;
 end if;

 definition := pg_get_functiondef('public.deepnight_apply_order_vip_spend_once(uuid,text,numeric)'::regprocedure);
 if position('qualification_cap_amount' in definition)=0 then
   modified := replace(definition,'  v_amount numeric;', '  v_amount numeric; v_counted numeric;');
   modified := replace(modified,'  if v_inserted = 1 then', $inject$
  if v_inserted = 1 then
    v_counted := public.qualification_cap_amount('vip:' || p_guild_id,
      v_order.customer_id,'spend',v_amount,'order:' || p_order_id::text);$inject$);
   modified := replace(modified,'      v_amount, 0, 0, now()', '      v_counted, 0, 0, now()');
   if position('v_counted := public.qualification_cap_amount' in modified)=0 then
     raise exception 'deepnight order definition changed';
   end if;
   execute modified;
 end if;
end;
$patch$;

create or replace function public.apply_temporary_legacy_vip_credit(
 p_user_id text,p_guild_id text,p_trigger_type text,p_amount numeric
) returns jsonb language plpgsql security definer set search_path=public as $legacy$
declare v_counted numeric; v_row public.user_vips%rowtype;
begin
 if p_guild_id not in ('1206138511535898654','1501098191813214312')
 or p_trigger_type not in ('spend','topup') or p_amount <= 0 then
   return jsonb_build_object('applied',false);
 end if;
 if not exists(select 1 from public.qualification_cap_policy where id='2026-10-10'
   and now()>=starts_at and now()<ends_at) then return jsonb_build_object('applied',false); end if;
 insert into public.user_vips(user_id,guild_id) values(p_user_id,p_guild_id) on conflict(guild_id,user_id) do nothing;
 select * into v_row from public.user_vips where user_id=p_user_id and guild_id=p_guild_id for update;
 v_counted := public.qualification_cap_amount('vip:' || p_guild_id,p_user_id,p_trigger_type,p_amount,null);
 update public.user_vips set
   total_spent=coalesce(total_spent,0)+case when p_trigger_type='spend' then v_counted else 0 end,
   total_topup=coalesce(total_topup,0)+case when p_trigger_type='topup' then v_counted else 0 end,
   highest_single_topup=greatest(coalesce(highest_single_topup,0),case when p_trigger_type='topup' then p_amount else 0 end),
   updated_at=now()
 where id=v_row.id returning * into v_row;
 return jsonb_build_object('applied',true,'counted_amount',v_counted,
   'total_spent',v_row.total_spent,'total_topup',v_row.total_topup);
end;
$legacy$;
revoke all on function public.apply_temporary_legacy_vip_credit(text,text,text,numeric) from public,anon,authenticated;
grant execute on function public.apply_temporary_legacy_vip_credit(text,text,text,numeric) to service_role;
notify pgrst,'reload schema';
commit;
