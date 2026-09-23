begin; -- 1/5: foundational payment and accept serialization

-- Pay the two rows produced by the VALORANT entertainment + skill split as
-- one transaction.  The existing per-order procedures do the actual wallet
-- or monthly-account mutation; keeping both calls in this procedure means a
-- failure on either row rolls the whole group back.
create or replace function public.deepnight_pay_service_group(
  p_group_id text,
  p_customer_id text,
  p_guild_id text,
  p_method text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_order public.play_orders%rowtype;
  v_order_ids uuid[] := '{}'::uuid[];
  v_order_id uuid;
  v_receipt jsonb;
  v_total numeric := 0;
  v_orders jsonb;
begin
  if coalesce(p_group_id, '') = '' then
    raise exception '分單識別碼不可為空';
  end if;
  if coalesce(p_customer_id, '') = '' or coalesce(p_guild_id, '') = '' then
    raise exception '付款人或伺服器資料不完整';
  end if;
  if p_method not in ('wallet', 'monthly') then
    raise exception '不支援的付款方式';
  end if;

  -- A row lock serializes repeated button presses before any money is moved.
  for v_order in
    select *
    from public.play_orders
    where order_group_id = p_group_id
      and guild_id = p_guild_id
    order by id
    for update
  loop
    if v_order.customer_id is distinct from p_customer_id
      or coalesce(v_order.paid, false)
      or coalesce(v_order.is_deleted, false)
      or v_order.status is null
      or v_order.status not in ('waiting_payment', 'quoted', 'waiting_confirm')
    then
      raise exception '訂單已付款或已結束，未重複扣款';
    end if;

    v_order_ids := array_append(v_order_ids, v_order.id);
  end loop;

  if cardinality(v_order_ids) <> 2 then
    raise exception '分單資料不完整，未扣款';
  end if;

  foreach v_order_id in array v_order_ids
  loop
    if p_method = 'wallet' then
      select to_jsonb(public.pay_play_order_with_wallet(v_order_id))
        into v_receipt;
    else
      select to_jsonb(public.pay_play_order_with_monthly(v_order_id))
        into v_receipt;
    end if;

    v_total := v_total + coalesce((v_receipt->>'amount')::numeric, 0);
  end loop;

  update public.play_orders
  set status = 'pending',
      quote_status = 'dispatched',
      updated_at = now()
  where id = any(v_order_ids);

  select jsonb_agg(to_jsonb(o) order by o.id)
    into v_orders
  from public.play_orders o
  where o.id = any(v_order_ids);

  return jsonb_build_object(
    'amount', v_total,
    'receipt', v_receipt,
    'orders', coalesce(v_orders, '[]'::jsonb)
  );
end;
$function$;

-- Serialize accept operations on the order row.  This is the authoritative
-- capacity check; the Discord-side read remains only an early UX check.
create or replace function public.deepnight_accept_play_order(
  p_order_id uuid,
  p_player_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_order public.play_orders%rowtype;
  v_player_ids text[] := '{}'::text[];
  v_need_count integer;
  v_is_full boolean;
  v_next_status text;
begin
  if coalesce(p_player_id, '') = '' then
    raise exception '找不到接單陪陪';
  end if;

  select *
    into v_order
  from public.play_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception '找不到訂單';
  end if;
  if v_order.status is null
    or v_order.status not in ('pending', 'accepted')
    or coalesce(v_order.is_deleted, false)
  then
    raise exception '這張訂單目前不能接單';
  end if;

  select coalesce(array_agg(btrim(part) order by ordinal), '{}'::text[])
    into v_player_ids
  from unnest(string_to_array(coalesce(v_order.assigned_player, ''), ','))
    with ordinality as existing(part, ordinal)
  where btrim(part) <> '';

  if p_player_id = any(v_player_ids) then
    raise exception '你已經接過這張訂單了';
  end if;

  v_need_count := greatest(1, coalesce(v_order.player_count, 1));
  if cardinality(v_player_ids) >= v_need_count then
    raise exception '這張訂單名額已滿';
  end if;

  v_player_ids := array_append(v_player_ids, p_player_id);
  v_is_full := cardinality(v_player_ids) >= v_need_count;
  v_next_status := case when v_is_full then 'accepted' else 'pending' end;

  update public.play_orders
  set assigned_player = array_to_string(v_player_ids, ','),
      status = v_next_status,
      accepted_at = case
        when v_is_full then coalesce(accepted_at, now())
        else accepted_at
      end,
      updated_at = now()
  where id = p_order_id
  returning * into v_order;

  return jsonb_build_object(
    'order', to_jsonb(v_order),
    'assigned_player_ids', to_jsonb(v_player_ids),
    'is_full', v_is_full,
    'need_count', v_need_count
  );
end;
$function$;

revoke all on function public.deepnight_pay_service_group(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.deepnight_pay_service_group(text, text, text, text)
  to service_role;

revoke all on function public.deepnight_accept_play_order(uuid, text)
  from public, anon, authenticated;
grant execute on function public.deepnight_accept_play_order(uuid, text)
  to service_role;

notify pgrst, 'reload schema';

commit;
