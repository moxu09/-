begin; -- 3/5: refund-safe coupon snapshots and restoration

alter table public.used_coupons
  add column if not exists coupon_snapshot jsonb,
  add column if not exists restored_at timestamptz,
  add column if not exists restored_item_id bigint,
  add column if not exists restore_key text;

alter table public.play_orders
  add column if not exists coupon_refunded_at timestamptz,
  add column if not exists coupon_restored_item_id bigint;

create unique index if not exists used_coupons_restore_key_uidx
  on public.used_coupons (restore_key)
  where restore_key is not null;

-- The payment consumer inserts used_coupons immediately before deleting the
-- concrete inventory row.  Capture that row on delete so a later refund can
-- recreate the exact coupon instead of guessing from its display name.
create or replace function public.deepnight_snapshot_consumed_coupon()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  update public.used_coupons
  set coupon_snapshot = jsonb_strip_nulls(jsonb_build_object(
    'id', old.id,
    'user_id', old.user_id,
    'guild_id', old.guild_id,
    'item_name', old.item_name,
    'rarity', old.rarity,
    'description', old.description,
    'item_type', old.item_type
  ))
  where item_id = old.id
    and user_id = old.user_id
    and coupon_snapshot is null;
  return old;
end;
$function$;

drop trigger if exists deepnight_snapshot_consumed_coupon
  on public.user_items;
create trigger deepnight_snapshot_consumed_coupon
before delete on public.user_items
for each row
when (
  old.guild_id = '1501098191813214312'
  and (
    old.item_type = 'coupon'
    or coalesce(old.item_name, '') like '%折券%'
    or coalesce(old.item_name, '') like '%優惠券%'
  )
)
execute function public.deepnight_snapshot_consumed_coupon();

-- Older usage records predate the snapshot trigger.  Their audit fields still
-- contain enough information to restore an equivalent coupon.
update public.used_coupons
set coupon_snapshot = jsonb_strip_nulls(jsonb_build_object(
  'id', item_id,
  'user_id', user_id,
  'guild_id', '1501098191813214312',
  'item_name', item_name,
  'description', description,
  'item_type', 'coupon'
))
where coupon_snapshot is null
  and item_id is not null
  and exists (
    select 1
    from public.play_orders source_order
    where source_order.id::text = used_coupons.order_id
      and source_order.guild_id = '1501098191813214312'
  );

-- Exactly-once coupon restoration for an order or two-row split order.  The
-- used_coupons row is locked and retained as an immutable consume/restore
-- audit record; retries return the original restored inventory id.
create or replace function public.deepnight_restore_order_coupon(
  p_order_ids uuid[],
  p_customer_id text,
  p_refund_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_order public.play_orders%rowtype;
  v_used public.used_coupons%rowtype;
  v_coupon_id bigint;
  v_first_order_id uuid;
  v_order_count integer := 0;
  v_snapshot jsonb;
  v_restored_item_id bigint;
begin
  if coalesce(cardinality(p_order_ids), 0) = 0 then
    raise exception '退款訂單不可為空';
  end if;
  if coalesce(p_customer_id, '') = '' or coalesce(p_refund_key, '') = '' then
    raise exception '退款優惠券參數不完整';
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
      raise exception '退款訂單付款人不一致';
    end if;
    if v_order.coupon_item_id is not null then
      if v_coupon_id is not null and v_coupon_id <> v_order.coupon_item_id then
        raise exception '退款訂單包含多張優惠券';
      end if;
      v_coupon_id := v_order.coupon_item_id;
    end if;
  end loop;

  if v_order_count <> cardinality(p_order_ids) then
    raise exception '部分退款訂單不存在或不屬於深夜';
  end if;
  if v_coupon_id is null then
    return jsonb_build_object('restored', false, 'reason', 'no_coupon');
  end if;

  select * into v_used
  from public.used_coupons
  where item_id = v_coupon_id
    and user_id = p_customer_id
    and (
      order_id = any(p_order_ids::text[])
      or exists (
        select 1
        from public.play_orders current_order
        join public.play_orders used_order
          on used_order.id::text = used_coupons.order_id
        where current_order.id = v_first_order_id
          and current_order.guild_id = '1501098191813214312'
          and current_order.order_group_id is not null
          and used_order.order_group_id = current_order.order_group_id
          and used_order.customer_id = current_order.customer_id
      )
    )
  order by id desc
  limit 1
  for update;

  if not found then
    raise exception '找不到可恢復的優惠券使用紀錄';
  end if;
  if v_used.restored_at is not null then
    return jsonb_build_object(
      'restored', true,
      'already_processed', true,
      'restored_item_id', v_used.restored_item_id,
      'refund_key', v_used.restore_key
    );
  end if;

  v_snapshot := coalesce(v_used.coupon_snapshot, '{}'::jsonb);
  insert into public.user_items (
    user_id,
    guild_id,
    item_name,
    rarity,
    description,
    item_type
  ) values (
    p_customer_id,
    '1501098191813214312',
    coalesce(v_snapshot->>'item_name', v_used.item_name, '優惠券'),
    nullif(v_snapshot->>'rarity', ''),
    coalesce(v_snapshot->>'description', v_used.description),
    coalesce(nullif(v_snapshot->>'item_type', ''), 'coupon')
  ) returning id into v_restored_item_id;

  update public.used_coupons
  set restored_at = now(),
      restored_item_id = v_restored_item_id,
      restore_key = p_refund_key
  where id = v_used.id
    and restored_at is null;
  if not found then
    raise exception '優惠券恢復發生並發衝突，未完成退款回沖';
  end if;

  update public.play_orders
  set coupon_consumed_at = null,
      coupon_refunded_at = coalesce(coupon_refunded_at, now()),
      coupon_restored_item_id = coalesce(coupon_restored_item_id, v_restored_item_id),
      updated_at = now()
  where id = any(p_order_ids)
    and guild_id = '1501098191813214312'
    and coupon_item_id = v_coupon_id;

  return jsonb_build_object(
    'restored', true,
    'already_processed', false,
    'coupon_item_id', v_coupon_id,
    'restored_item_id', v_restored_item_id,
    'refund_key', p_refund_key
  );
end;
$function$;

revoke all on function public.deepnight_snapshot_consumed_coupon()
  from public, anon, authenticated;
revoke all on function public.deepnight_restore_order_coupon(uuid[], text, text)
  from public, anon, authenticated;
grant execute on function public.deepnight_restore_order_coupon(uuid[], text, text)
  to service_role;

notify pgrst, 'reload schema';

commit;
