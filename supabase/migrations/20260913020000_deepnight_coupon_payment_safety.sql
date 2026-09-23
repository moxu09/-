begin; -- 2/5: post-payment coupon consumption

alter table public.play_orders
  add column if not exists coupon_item_id bigint,
  add column if not exists coupon_consumed_at timestamptz;

-- play_orders.id is UUID.  The old bigint column rejected every order-linked
-- usage record, which is why the bot logged the coupon as used but could not
-- persist the audit row.
alter table public.used_coupons
  alter column order_id type text using order_id::text;

create index if not exists play_orders_coupon_item_idx
  on public.play_orders (coupon_item_id)
  where coupon_item_id is not null;

create index if not exists used_coupons_item_id_idx
  on public.used_coupons (item_id)
  where item_id is not null;

-- Consume an order coupon only after every supplied order is paid.  Locking
-- both the orders and the concrete inventory row makes delete + audit insert
-- atomic and makes retries safe after a downstream Discord failure.
create or replace function public.deepnight_consume_order_coupon(
  p_order_ids uuid[],
  p_customer_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_order public.play_orders%rowtype;
  v_item public.user_items%rowtype;
  v_used public.used_coupons%rowtype;
  v_coupon_id bigint;
  v_coupon_name text;
  v_first_order_id uuid;
  v_discount_amount integer := 0;
  v_order_count integer := 0;
begin
  if coalesce(cardinality(p_order_ids), 0) = 0 then
    raise exception '訂單資料不可為空';
  end if;
  if coalesce(p_customer_id, '') = '' then
    raise exception '找不到付款人';
  end if;

  for v_order in
    select *
    from public.play_orders
    where id = any(p_order_ids)
      and guild_id = '1501098191813214312'
    order by id
    for update
  loop
    v_order_count := v_order_count + 1;
    v_first_order_id := coalesce(v_first_order_id, v_order.id);

    if v_order.customer_id is distinct from p_customer_id then
      raise exception '訂單付款人不一致';
    end if;
    if not coalesce(v_order.paid, false) then
      raise exception '訂單尚未付款，優惠券未消耗';
    end if;

    if v_order.coupon_item_id is not null then
      if v_coupon_id is not null and v_coupon_id <> v_order.coupon_item_id then
        raise exception '同一付款群組不可使用多張優惠券';
      end if;
      v_coupon_id := v_order.coupon_item_id;
      v_coupon_name := coalesce(v_coupon_name, v_order.coupon_text, v_order.coupon_name);
      v_discount_amount := greatest(
        v_discount_amount,
        coalesce(v_order.discount_amount, 0)
      );
    end if;
  end loop;

  if v_order_count <> cardinality(p_order_ids) then
    raise exception '部分訂單不存在，優惠券未消耗';
  end if;
  if v_coupon_id is null then
    return jsonb_build_object('consumed', false, 'reason', 'no_coupon');
  end if;

  select *
    into v_item
  from public.user_items
  where id = v_coupon_id
    and user_id = p_customer_id
    and guild_id = '1501098191813214312'
  for update;

  if found then
    if not (
      v_item.item_type = 'coupon'
      or coalesce(v_item.item_name, '') like '%折券%'
      or coalesce(v_item.item_name, '') like '%優惠券%'
    ) then
      raise exception '指定的背包品項不是優惠券';
    end if;

    v_coupon_name := coalesce(v_item.item_name, v_coupon_name, '優惠券');

    insert into public.used_coupons (
      user_id,
      item_id,
      item_name,
      description,
      order_id
    ) values (
      p_customer_id,
      v_coupon_id,
      v_coupon_name,
      '付款成功後使用｜折抵 NT$' || v_discount_amount::text,
      v_first_order_id::text
    );

    delete from public.user_items
    where id = v_coupon_id
      and user_id = p_customer_id
      and guild_id = '1501098191813214312';
  else
    select *
      into v_used
    from public.used_coupons
    where item_id = v_coupon_id
      and user_id = p_customer_id
    order by id desc
    limit 1;

    if not found then
      raise exception '優惠券不存在或已被其他訂單使用';
    end if;

    -- A missing inventory row is considered an idempotent retry only for the
    -- same order, or for the sibling row in the same split-order group.  An
    -- old used_coupons row must never authorize reusing the coupon elsewhere.
    if not (v_used.order_id = any(p_order_ids::text[]))
      and not exists (
        select 1
        from public.play_orders current_order
        join public.play_orders used_order
          on used_order.id::text = v_used.order_id
        where current_order.id = v_first_order_id
          and current_order.guild_id = '1501098191813214312'
          and current_order.order_group_id is not null
          and used_order.order_group_id = current_order.order_group_id
          and used_order.customer_id = current_order.customer_id
      )
    then
      raise exception '優惠券已被其他訂單使用';
    end if;

    v_coupon_name := coalesce(v_used.item_name, v_coupon_name, '優惠券');
  end if;

  update public.play_orders
  set coupon_consumed_at = coalesce(coupon_consumed_at, now()),
      updated_at = now()
  where id = any(p_order_ids)
    and guild_id = '1501098191813214312'
    and coupon_item_id = v_coupon_id;

  return jsonb_build_object(
    'consumed', true,
    'coupon_item_id', v_coupon_id,
    'coupon_name', v_coupon_name,
    'order_id', v_first_order_id
  );
end;
$function$;

create or replace function public.deepnight_consume_coupon_after_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  perform public.deepnight_consume_order_coupon(array[new.id], new.customer_id);
  return new;
end;
$function$;

drop trigger if exists deepnight_consume_coupon_after_payment
  on public.play_orders;
create trigger deepnight_consume_coupon_after_payment
after update of paid on public.play_orders
for each row
when (
  new.guild_id = '1501098191813214312'
  and new.paid is true
  and old.paid is distinct from true
  and new.coupon_item_id is not null
)
execute function public.deepnight_consume_coupon_after_payment();

create or replace function public.deepnight_pay_play_order_with_wallet(
  p_order_id uuid,
  p_customer_id text,
  p_guild_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_order public.play_orders%rowtype;
  v_receipt jsonb;
begin
  if p_guild_id is distinct from '1501098191813214312' then
    raise exception '不是深夜不關燈伺服器';
  end if;
  select * into v_order
  from public.play_orders
  where id = p_order_id
    and guild_id = p_guild_id
  for update;

  if not found then raise exception '找不到訂單'; end if;
  if v_order.customer_id is distinct from p_customer_id then
    raise exception '訂單付款人不一致';
  end if;
  select to_jsonb(public.pay_play_order_with_wallet(p_order_id)) into v_receipt;
  perform public.deepnight_consume_order_coupon(array[p_order_id], p_customer_id);
  return v_receipt;
end;
$function$;

create or replace function public.deepnight_pay_play_order_with_monthly(
  p_order_id uuid,
  p_customer_id text,
  p_guild_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_order public.play_orders%rowtype;
  v_receipt jsonb;
begin
  if p_guild_id is distinct from '1501098191813214312' then
    raise exception '不是深夜不關燈伺服器';
  end if;
  select * into v_order
  from public.play_orders
  where id = p_order_id
    and guild_id = p_guild_id
  for update;

  if not found then raise exception '找不到訂單'; end if;
  if v_order.customer_id is distinct from p_customer_id then
    raise exception '訂單付款人不一致';
  end if;
  select to_jsonb(public.pay_play_order_with_monthly(p_order_id)) into v_receipt;
  perform public.deepnight_consume_order_coupon(array[p_order_id], p_customer_id);
  return v_receipt;
end;
$function$;

-- Replace the first migration's group procedure so coupon consumption is in
-- the same transaction as both deductions.
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
  if p_guild_id is distinct from '1501098191813214312' then
    raise exception '不是深夜不關燈伺服器';
  end if;
  if p_method not in ('wallet', 'monthly') then
    raise exception '不支援的付款方式';
  end if;

  for v_order in
    select * from public.play_orders
    where order_group_id = p_group_id and guild_id = p_guild_id
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
      select to_jsonb(public.deepnight_pay_play_order_with_wallet(
        v_order_id, p_customer_id, p_guild_id
      )) into v_receipt;
    else
      select to_jsonb(public.deepnight_pay_play_order_with_monthly(
        v_order_id, p_customer_id, p_guild_id
      )) into v_receipt;
    end if;
    v_total := v_total + coalesce((v_receipt->>'amount')::numeric, 0);
  end loop;

  update public.play_orders
  set status = 'pending', quote_status = 'dispatched', updated_at = now()
  where id = any(v_order_ids);

  select jsonb_agg(to_jsonb(o) order by o.id) into v_orders
  from public.play_orders o where o.id = any(v_order_ids);

  return jsonb_build_object(
    'amount', v_total,
    'receipt', v_receipt,
    'orders', coalesce(v_orders, '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.deepnight_consume_order_coupon(uuid[], text)
  from public, anon, authenticated;
grant execute on function public.deepnight_consume_order_coupon(uuid[], text)
  to service_role;

revoke all on function public.deepnight_consume_coupon_after_payment()
  from public, anon, authenticated;

revoke all on function public.deepnight_pay_play_order_with_wallet(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.deepnight_pay_play_order_with_wallet(uuid, text, text)
  to service_role;

revoke all on function public.deepnight_pay_play_order_with_monthly(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.deepnight_pay_play_order_with_monthly(uuid, text, text)
  to service_role;

revoke all on function public.deepnight_pay_service_group(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.deepnight_pay_service_group(text, text, text, text)
  to service_role;

notify pgrst, 'reload schema';

commit;
