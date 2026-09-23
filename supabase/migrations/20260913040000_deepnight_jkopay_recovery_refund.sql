begin; -- 4/5: JKOPay fulfillment and local reversal

-- A confirmed gateway payment is durable even when Discord/accounting work
-- fails.  Fulfilment is tracked independently so callbacks can safely retry
-- without creating another payment or changing the gateway truth to pending.
alter table public.jkopay_service_payments
  add column if not exists fulfillment_status text,
  add column if not exists fulfillment_error text,
  add column if not exists fulfillment_updated_at timestamptz,
  add column if not exists fulfillment_attempts integer default 0,
  add column if not exists fulfillment_claimed_at timestamptz,
  add column if not exists completion_message_id text;

alter table public.jkopay_service_payments
  alter column fulfillment_status set default 'pending',
  alter column fulfillment_attempts set default 0;

-- This migration belongs to DeepNight.  Never infer or overwrite fulfilment
-- state for another organization that happens to share this table.  Existing
-- Historical paid rows predate the message checkpoints below.  Mark them
-- completed instead of blindly replaying old Discord effects; a known incident
-- can be queued explicitly with the administrator recovery command.
update public.jkopay_service_payments
set fulfillment_status = 'completed',
    fulfillment_error = null,
    fulfillment_updated_at = coalesce(fulfillment_updated_at, updated_at, now()),
    fulfillment_attempts = 0,
    fulfillment_claimed_at = null
where organization_code = 'deepnight'
  and status = 'paid'
  and fulfillment_status is null
  and fulfillment_updated_at is null;

update public.jkopay_service_payments
set fulfillment_status = coalesce(
      fulfillment_status,
      case when status = 'paid' then 'completed' else 'pending' end
    ),
    fulfillment_updated_at = coalesce(fulfillment_updated_at, updated_at, now()),
    fulfillment_attempts = coalesce(fulfillment_attempts, 0)
where organization_code = 'deepnight'
  and (
    fulfillment_status is null
    or fulfillment_updated_at is null
    or fulfillment_attempts is null
  );

alter table public.jkopay_service_payments
  drop constraint if exists jkopay_service_payments_fulfillment_status_check;
alter table public.jkopay_service_payments
  add constraint jkopay_service_payments_fulfillment_status_check
  check (fulfillment_status in ('pending', 'processing', 'failed', 'completed'));

alter table public.jkopay_service_payments
  drop constraint if exists jkopay_service_payments_fulfillment_attempts_check;
alter table public.jkopay_service_payments
  add constraint jkopay_service_payments_fulfillment_attempts_check
  check (fulfillment_attempts is null or fulfillment_attempts >= 0);

alter table public.jkopay_service_payments
  drop constraint if exists jkopay_service_payments_status_check;
alter table public.jkopay_service_payments
  add constraint jkopay_service_payments_status_check
  check (status in (
    'pending',
    'processing',
    'paid',
    'failed',
    'refunding',
    'refund_reversal_pending',
    'refunded'
  ));

create index if not exists jkopay_service_fulfillment_recovery_idx
  on public.jkopay_service_payments (
    organization_code,
    status,
    fulfillment_status,
    fulfillment_claimed_at,
    fulfillment_updated_at
  )
  where status = 'paid' and fulfillment_status in ('pending', 'processing', 'failed');

-- Claiming increments an attempt token under a row lock.  Completion and
-- failure must present the same token, so a timed-out worker can never
-- overwrite the result of the newer recovery attempt that replaced it.
create or replace function public.deepnight_claim_jkopay_fulfillment(
  p_payment_id uuid,
  p_stale_after_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_payment public.jkopay_service_payments%rowtype;
  v_attempt integer;
  v_stale_before timestamptz;
begin
  select * into v_payment
  from public.jkopay_service_payments
  where id = p_payment_id
    and organization_code = 'deepnight'
  for update;

  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'not_found');
  end if;
  if v_payment.status <> 'paid' then
    return jsonb_build_object('claimed', false, 'reason', 'not_paid');
  end if;
  if v_payment.fulfillment_status = 'completed' then
    return jsonb_build_object('claimed', false, 'reason', 'completed');
  end if;

  v_stale_before := now() - make_interval(
    secs => greatest(30, least(coalesce(p_stale_after_seconds, 120), 3600))
  );
  if v_payment.fulfillment_status = 'processing'
    and coalesce(
      v_payment.fulfillment_claimed_at,
      v_payment.fulfillment_updated_at,
      v_payment.updated_at,
      now()
    ) > v_stale_before
  then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'active_attempt',
      'attempt', coalesce(v_payment.fulfillment_attempts, 0)
    );
  end if;

  v_attempt := coalesce(v_payment.fulfillment_attempts, 0) + 1;
  update public.jkopay_service_payments
  set fulfillment_status = 'processing',
      fulfillment_error = null,
      fulfillment_attempts = v_attempt,
      fulfillment_claimed_at = now(),
      fulfillment_updated_at = now(),
      updated_at = now()
  where id = v_payment.id
  returning * into v_payment;

  return to_jsonb(v_payment) || jsonb_build_object(
    'claimed', true,
    'attempt', v_attempt
  );
end;
$function$;

create or replace function public.deepnight_complete_jkopay_fulfillment(
  p_payment_id uuid,
  p_attempt integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $function$
begin
  update public.jkopay_service_payments
  set fulfillment_status = 'completed',
      fulfillment_error = null,
      fulfillment_claimed_at = null,
      fulfillment_updated_at = now(),
      updated_at = now()
  where id = p_payment_id
    and organization_code = 'deepnight'
    and status = 'paid'
    and fulfillment_status = 'processing'
    and coalesce(fulfillment_attempts, 0) = p_attempt;
  return found;
end;
$function$;

create or replace function public.deepnight_fail_jkopay_fulfillment(
  p_payment_id uuid,
  p_attempt integer,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $function$
begin
  update public.jkopay_service_payments
  set fulfillment_status = 'failed',
      fulfillment_error = left(coalesce(p_error, 'unknown'), 2000),
      fulfillment_claimed_at = null,
      fulfillment_updated_at = now(),
      updated_at = now()
  where id = p_payment_id
    and organization_code = 'deepnight'
    and status = 'paid'
    and fulfillment_status = 'processing'
    and coalesce(fulfillment_attempts, 0) = p_attempt;
  return found;
end;
$function$;

revoke all on function public.deepnight_claim_jkopay_fulfillment(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.deepnight_claim_jkopay_fulfillment(uuid, integer)
  to service_role;
revoke all on function public.deepnight_complete_jkopay_fulfillment(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.deepnight_complete_jkopay_fulfillment(uuid, integer)
  to service_role;
revoke all on function public.deepnight_fail_jkopay_fulfillment(uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.deepnight_fail_jkopay_fulfillment(uuid, integer, text)
  to service_role;

-- Message ids make a retry return/reuse the already-sent Discord message
-- instead of duplicating the dispatch or confirmation panel.
alter table public.play_orders
  add column if not exists dispatch_message_id text,
  add column if not exists dispatch_control_message_id text,
  add column if not exists customer_confirm_message_id text;

-- Refund/apply RPCs below scope every extension through its DeepNight source
-- order. Add and safely backfill the shared-table discriminator before those
-- functions are created (the delivery migration repeats this idempotently).
alter table public.order_extensions
  add column if not exists guild_id text;

update public.order_extensions extension_row
set guild_id = '1501098191813214312'
from public.play_orders order_row
where extension_row.guild_id is null
  and extension_row.order_id::text = order_row.id::text
  and order_row.guild_id = '1501098191813214312';

create index if not exists order_extensions_guild_order_idx
  on public.order_extensions(guild_id, order_id);

-- Shared idempotency ledger.  organization_code keeps DeepNight operations
-- isolated even when Qiunai uses the same Supabase project.
create table if not exists public.bot_financial_operations (
  organization_code text not null,
  operation_key text not null,
  operation_type text not null,
  entity_id text,
  actor_id text,
  amount numeric not null default 0,
  status text not null default 'completed',
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_code, operation_key),
  check (status in ('processing', 'completed', 'failed'))
);
alter table public.bot_financial_operations enable row level security;
revoke all on public.bot_financial_operations from public, anon, authenticated;
grant all on public.bot_financial_operations to service_role;

-- Reserve every mutable local asset before calling the irreversible gateway
-- refund.  Source/report rows are made ineligible for salary processing and a
-- VIP reward coupon is removed from inventory in this transaction.  A clear
-- gateway rejection calls the matching cancel RPC; an uncertain response stays
-- reserved for reconciliation and must never be retried blindly.
create or replace function public.deepnight_prepare_jkopay_service_refund(
  p_platform_order_id text,
  p_requested_by text,
  p_refund_state jsonb
)
returns jsonb
language plpgsql security definer set search_path = public
as $function$
declare
  v_payment public.jkopay_service_payments%rowtype;
  v_order public.play_orders%rowtype;
  v_report public.play_orders%rowtype;
  v_extension public.order_extensions%rowtype;
  v_item public.user_items%rowtype;
  v_operation public.bot_financial_operations%rowtype;
  v_order_ids uuid[] := '{}'::uuid[];
  v_source_ids text[] := '{}'::text[];
  v_source_count integer := 0;
  v_total numeric := 0;
  v_extension_id bigint;
  v_source_snapshots jsonb := '[]'::jsonb;
  v_report_snapshots jsonb := '[]'::jsonb;
  v_extension_snapshot jsonb := null;
  v_reserved_coupons jsonb := '[]'::jsonb;
  v_prepare_key text := 'jkopay-service-refund:' || p_platform_order_id || ':prepare';
begin
  select * into v_payment from public.jkopay_service_payments
  where organization_code = 'deepnight'
    and platform_order_id = p_platform_order_id
  for update;
  if not found then raise exception '找不到深夜街口服務付款'; end if;
  if v_payment.status = 'refunding' then
    select * into v_operation from public.bot_financial_operations
    where organization_code = 'deepnight' and operation_key = v_prepare_key
      and status = 'completed';
    if found then return to_jsonb(v_payment) || jsonb_build_object('already_prepared', true); end if;
  end if;
  if v_payment.status <> 'paid' then raise exception '只有已付款訂單可以退款'; end if;

  if v_payment.payment_kind = 'order' then
    select coalesce(array_agg(value::uuid), '{}'::uuid[]) into v_order_ids
    from jsonb_array_elements_text(
      case when jsonb_typeof(v_payment.metadata->'orderIds') = 'array'
        then v_payment.metadata->'orderIds'
        else jsonb_build_array(v_payment.entity_key) end
    );
    for v_order in select * from public.play_orders
      where id = any(v_order_ids) and guild_id = '1501098191813214312'
      order by id for update
    loop
      v_source_count := v_source_count + 1;
      if v_order.customer_id is distinct from v_payment.user_id
        or v_order.wallet_settled_at is not null
        or coalesce(v_order.salary_paid, false)
        or v_order.salary_paid_at is not null
        or coalesce(v_order.status, '') in ('已入帳', '已發薪', 'refunded')
      then raise exception '訂單付款人不符或薪資已結算，不能退款'; end if;
      -- The live order price may already include paid extensions.  Validate
      -- the gateway payment against the immutable amount captured by the
      -- base-order VIP operation whenever it exists.
      v_operation := null;
      select * into v_operation
      from public.bot_financial_operations vip_operation
      where vip_operation.organization_code = 'deepnight'
        and vip_operation.operation_key =
          'play-order:' || v_order.id::text || ':vip-spend'
        and vip_operation.status = 'completed'
      for update;
      if found then
        if v_operation.entity_id is distinct from v_order.id::text
          or v_operation.actor_id is distinct from v_payment.user_id
          or coalesce(v_operation.result->>'guild_id', '') <>
            '1501098191813214312'
        then
          raise exception '訂單 VIP 累積紀錄與深夜退款資料不一致';
        end if;
        v_total := v_total + coalesce(v_operation.amount, 0);
      else
        v_total := v_total + coalesce(v_order.final_price, v_order.price, 0);
      end if;
      v_source_ids := array_append(v_source_ids, v_order.id::text);
      v_source_snapshots := v_source_snapshots || jsonb_build_array(
        jsonb_build_object('id', v_order.id, 'status', v_order.status,
          'is_deleted', coalesce(v_order.is_deleted, false))
      );
    end loop;
    if v_source_count <> cardinality(v_order_ids) or v_total <> v_payment.amount then
      raise exception '街口付款對應訂單不完整或金額不一致'; end if;
    if v_payment.entity_key like 'group-%' then
      if nullif(v_payment.metadata->>'orderGroupId', '') is null
        or v_payment.entity_key <> 'group-' || (v_payment.metadata->>'orderGroupId')
        or exists (select 1 from public.play_orders source_order
          where source_order.id = any(v_order_ids)
            and source_order.guild_id = '1501098191813214312'
            and source_order.order_group_id is distinct from
              (v_payment.metadata->>'orderGroupId'))
      then raise exception '街口付款與深夜訂單群組不一致'; end if;
    elsif cardinality(v_order_ids) <> 1
      or v_order_ids[1]::text is distinct from v_payment.entity_key
    then raise exception '街口付款與深夜訂單編號不一致'; end if;
  elsif v_payment.payment_kind = 'extension' then
    v_extension_id := coalesce(
      nullif(v_payment.metadata->>'extensionId', '')::bigint,
      v_payment.entity_key::bigint
    );
    if v_extension_id::text is distinct from v_payment.entity_key then
      raise exception '街口付款與深夜加時單不一致'; end if;
    select * into v_extension from public.order_extensions
    where id = v_extension_id and guild_id = '1501098191813214312'
    for update;
    if not found or v_extension.customer_id is distinct from v_payment.user_id
      or coalesce(v_extension.amount, 0) <> v_payment.amount
    then raise exception '找不到相符的深夜加時付款'; end if;
    select * into v_order from public.play_orders
    where id::text = v_extension.order_id::text
      and guild_id = '1501098191813214312' for update;
    if not found or v_order.customer_id is distinct from v_payment.user_id then
      raise exception '加時原訂單不屬於深夜付款人'; end if;
    v_source_ids := array_append(v_source_ids, 'EXT-' || v_extension_id::text);
    v_extension_snapshot := jsonb_build_object(
      'id', v_extension.id, 'status', v_extension.status
    );
  elsif v_payment.payment_kind = 'tip' then
    for v_order in select * from public.play_orders
      where note like '打賞｜街口:' || p_platform_order_id || ':%'
        and guild_id = '1501098191813214312'
      order by id for update
    loop
      v_source_count := v_source_count + 1;
      if v_order.customer_id is distinct from v_payment.user_id
        or v_order.wallet_settled_at is not null
        or coalesce(v_order.salary_paid, false)
        or v_order.salary_paid_at is not null
        or coalesce(v_order.status, '') in ('已入帳', '已發薪', 'paid', 'refunded')
      then raise exception '打賞付款人不符或薪資已結算，不能退款'; end if;
      v_operation := null;
      select * into v_operation
      from public.bot_financial_operations vip_operation
      where vip_operation.organization_code = 'deepnight'
        and vip_operation.operation_key =
          'play-order:' || v_order.id::text || ':vip-spend'
        and vip_operation.status = 'completed'
      for update;
      if found then
        if v_operation.entity_id is distinct from v_order.id::text
          or v_operation.actor_id is distinct from v_payment.user_id
          or coalesce(v_operation.result->>'guild_id', '') <>
            '1501098191813214312'
        then
          raise exception '打賞 VIP 累積紀錄與深夜退款資料不一致';
        end if;
        v_total := v_total + coalesce(v_operation.amount, 0);
      else
        v_total := v_total + coalesce(v_order.final_price, v_order.price, 0);
      end if;
      v_source_ids := array_append(v_source_ids, v_order.id::text);
      v_source_snapshots := v_source_snapshots || jsonb_build_array(
        jsonb_build_object('id', v_order.id, 'status', v_order.status,
          'is_deleted', coalesce(v_order.is_deleted, false))
      );
    end loop;
    if v_source_count = 0 or v_total <> v_payment.amount then
      raise exception '街口打賞訂單不完整或金額不一致'; end if;
  else
    raise exception '不支援的街口服務退款類型';
  end if;

  for v_report in select * from public.play_orders report
    where report.guild_id = '1501098191813214312'
      and exists (select 1 from unnest(v_source_ids) source_id
        where report.order_id like 'WORK-' || source_id || '-%')
    order by report.id for update
  loop
    if v_report.wallet_settled_at is not null
      or coalesce(v_report.salary_paid, false)
      or v_report.salary_paid_at is not null
      or coalesce(v_report.status, '') in ('已入帳', '已發薪', 'paid')
    then raise exception '訂單薪資已入帳或發放，不能退款'; end if;
    v_report_snapshots := v_report_snapshots || jsonb_build_array(
      jsonb_build_object('id', v_report.id, 'status', v_report.status,
        'is_deleted', coalesce(v_report.is_deleted, false))
    );
  end loop;

  if v_payment.payment_kind in ('order', 'tip') then
    for v_operation in select * from public.bot_financial_operations op
      where op.organization_code = 'deepnight'
        and op.operation_key = any(
          select 'play-order:' || source_id || ':vip-benefit'
          from unnest(v_source_ids) source_id
        )
        and op.status = 'completed'
      order by op.operation_key for update
    loop
      if nullif(v_operation.result->>'coupon_item_id', '') is not null then
        select * into v_item from public.user_items
        where id = (v_operation.result->>'coupon_item_id')::bigint
          and user_id = v_payment.user_id
          and guild_id = '1501098191813214312' for update;
        if not found then
          raise exception '退款訂單發放的 VIP 優惠券已使用，不能自動退款';
        end if;
        v_reserved_coupons := v_reserved_coupons || jsonb_build_array(
          jsonb_build_object('benefit_operation_key', v_operation.operation_key,
            'old_id', v_item.id, 'user_id', v_item.user_id,
            'guild_id', v_item.guild_id, 'item_name', v_item.item_name,
            'rarity', v_item.rarity, 'description', v_item.description,
            'item_type', v_item.item_type)
        );
        delete from public.user_items where id = v_item.id;
      end if;
    end loop;
  end if;

  update public.play_orders set status = 'refund_pending', is_deleted = true,
      updated_at = now()
  where id::text = any(v_source_ids)
    and guild_id = '1501098191813214312';
  update public.play_orders report set status = 'refund_pending', is_deleted = true,
      updated_at = now()
  where report.guild_id = '1501098191813214312'
    and exists (select 1 from unnest(v_source_ids) source_id
      where report.order_id like 'WORK-' || source_id || '-%');
  if v_extension_id is not null then
    update public.order_extensions set status = 'refund_pending', updated_at = now()
    where id = v_extension_id and guild_id = '1501098191813214312';
  end if;

  insert into public.bot_financial_operations(
    organization_code, operation_key, operation_type, entity_id,
    actor_id, amount, status, result
  ) values (
    'deepnight', v_prepare_key, 'jkopay_refund_prepare', p_platform_order_id,
    p_requested_by, v_payment.amount, 'completed', jsonb_build_object(
      'source_snapshots', v_source_snapshots,
      'report_snapshots', v_report_snapshots,
      'extension_snapshot', v_extension_snapshot,
      'reserved_coupons', v_reserved_coupons
    )
  ) on conflict (organization_code, operation_key) do update
    set actor_id = excluded.actor_id, amount = excluded.amount,
        status = 'completed', result = excluded.result, updated_at = now();
  update public.jkopay_service_payments
  set status = 'refunding',
      raw_result = coalesce(raw_result, '{}'::jsonb) ||
        jsonb_build_object('refund', coalesce(p_refund_state, '{}'::jsonb)),
      updated_at = now()
  where id = v_payment.id returning * into v_payment;
  return to_jsonb(v_payment) || jsonb_build_object('already_prepared', false);
end;
$function$;

create or replace function public.deepnight_cancel_jkopay_service_refund(
  p_platform_order_id text,
  p_refund_state jsonb
)
returns jsonb
language plpgsql security definer set search_path = public
as $function$
declare
  v_payment public.jkopay_service_payments%rowtype;
  v_prepare public.bot_financial_operations%rowtype;
  v_snapshot jsonb;
  v_coupon jsonb;
  v_new_coupon_id bigint;
  v_prepare_key text := 'jkopay-service-refund:' || p_platform_order_id || ':prepare';
begin
  select * into v_payment from public.jkopay_service_payments
  where organization_code = 'deepnight' and platform_order_id = p_platform_order_id
  for update;
  if not found then raise exception '找不到深夜街口服務付款'; end if;
  if v_payment.status <> 'refunding' then raise exception '退款目前不是可取消狀態'; end if;
  select * into v_prepare from public.bot_financial_operations
  where organization_code = 'deepnight' and operation_key = v_prepare_key
  for update;
  if not found or v_prepare.status <> 'completed' then
    raise exception '找不到退款預留紀錄'; end if;

  for v_snapshot in select value from jsonb_array_elements(
    coalesce(v_prepare.result->'source_snapshots', '[]'::jsonb)
  ) loop
    update public.play_orders set status = v_snapshot->>'status',
        is_deleted = coalesce((v_snapshot->>'is_deleted')::boolean, false),
        updated_at = now()
    where id = (v_snapshot->>'id')::uuid
      and guild_id = '1501098191813214312' and status = 'refund_pending';
  end loop;
  for v_snapshot in select value from jsonb_array_elements(
    coalesce(v_prepare.result->'report_snapshots', '[]'::jsonb)
  ) loop
    update public.play_orders set status = v_snapshot->>'status',
        is_deleted = coalesce((v_snapshot->>'is_deleted')::boolean, false),
        updated_at = now()
    where id = (v_snapshot->>'id')::uuid
      and guild_id = '1501098191813214312' and status = 'refund_pending';
  end loop;
  if v_prepare.result->'extension_snapshot' is not null
    and jsonb_typeof(v_prepare.result->'extension_snapshot') = 'object'
  then
    update public.order_extensions
    set status = v_prepare.result->'extension_snapshot'->>'status', updated_at = now()
    where id = (v_prepare.result->'extension_snapshot'->>'id')::bigint
      and guild_id = '1501098191813214312' and status = 'refund_pending';
  end if;
  for v_coupon in select value from jsonb_array_elements(
    coalesce(v_prepare.result->'reserved_coupons', '[]'::jsonb)
  ) loop
    insert into public.user_items(
      user_id, guild_id, item_name, rarity, description, item_type
    ) values (
      v_coupon->>'user_id', '1501098191813214312', v_coupon->>'item_name',
      nullif(v_coupon->>'rarity', ''), v_coupon->>'description',
      coalesce(nullif(v_coupon->>'item_type', ''), 'coupon')
    ) returning id into v_new_coupon_id;
    update public.bot_financial_operations
    set result = result || jsonb_build_object(
      'coupon_item_id', v_new_coupon_id, 'refund_reservation_cancelled_at', now()
    ), updated_at = now()
    where organization_code = 'deepnight'
      and operation_key = v_coupon->>'benefit_operation_key';
  end loop;
  update public.bot_financial_operations
  set status = 'failed', result = result || jsonb_build_object('cancelled_at', now()),
      updated_at = now()
  where organization_code = 'deepnight' and operation_key = v_prepare_key;
  update public.jkopay_service_payments
  set status = 'paid', raw_result = coalesce(raw_result, '{}'::jsonb) ||
      jsonb_build_object('refund', coalesce(p_refund_state, '{}'::jsonb)),
      updated_at = now()
  where id = v_payment.id returning * into v_payment;
  return to_jsonb(v_payment);
end;
$function$;

revoke all on function public.deepnight_prepare_jkopay_service_refund(text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.deepnight_prepare_jkopay_service_refund(text, text, jsonb)
  to service_role;
revoke all on function public.deepnight_cancel_jkopay_service_refund(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.deepnight_cancel_jkopay_service_refund(text, jsonb)
  to service_role;

-- Reverse the local order/extension/tip state after JKOPay has confirmed the
-- refund.  The operation key makes this safe to repeat when the first attempt
-- stopped after the gateway refund but before all local work completed.
create or replace function public.deepnight_reverse_jkopay_service(
  p_platform_order_id text,
  p_requested_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_payment public.jkopay_service_payments%rowtype;
  v_extension public.order_extensions%rowtype;
  v_order public.play_orders%rowtype;
  v_operation_key text := 'jkopay-service-refund:' || p_platform_order_id || ':local';
  v_result jsonb;
  v_order_ids uuid[] := '{}'::uuid[];
  v_source_ids text[] := '{}'::text[];
  v_extension_id bigint;
  v_old_price numeric;
  v_new_price numeric;
  v_legacy_vip_amount numeric := 0;
  v_vip_total_spent numeric;
  v_source_count integer := 0;
  v_source_id text;
  v_benefit_result jsonb;
  v_benefit_coupon_id bigint;
  v_benefit_restored_item_id bigint;
  v_revoked_benefit_coupon_ids bigint[] := '{}'::bigint[];
  v_vip_operation public.bot_financial_operations%rowtype;
  v_vip_operation_keys text[] := '{}'::text[];
  v_prepare_result jsonb := '{}'::jsonb;
  v_coupon_restore jsonb := jsonb_build_object(
    'restored', false,
    'reason', 'not_applicable'
  );
begin
  select * into v_payment
  from public.jkopay_service_payments
  where organization_code = 'deepnight'
    and platform_order_id = p_platform_order_id
  for update;

  if not found then raise exception '找不到深夜街口服務付款'; end if;
  if v_payment.status not in ('refund_reversal_pending', 'refunded') then
    raise exception '街口退款尚未成功，不能回沖本地帳務';
  end if;

  select result into v_result
  from public.bot_financial_operations
  where organization_code = 'deepnight'
    and operation_key = v_operation_key;
  if found then
    return v_result || jsonb_build_object('already_processed', true);
  end if;
  select coalesce(result, '{}'::jsonb) into v_prepare_result
  from public.bot_financial_operations
  where organization_code = 'deepnight'
    and operation_key =
      'jkopay-service-refund:' || p_platform_order_id || ':prepare'
    and status = 'completed'
  for update;

  if v_payment.payment_kind = 'order' then
    select coalesce(array_agg(value::uuid), '{}'::uuid[])
      into v_order_ids
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(v_payment.metadata->'orderIds') = 'array'
          then v_payment.metadata->'orderIds'
        else jsonb_build_array(v_payment.entity_key)
      end
    );

    for v_order in
      select * from public.play_orders
      where id = any(v_order_ids)
        and guild_id = '1501098191813214312'
      order by id
      for update
    loop
      v_source_count := v_source_count + 1;
      if v_order.customer_id is distinct from v_payment.user_id then
        raise exception '退款訂單付款人不一致';
      end if;
      if v_order.wallet_settled_at is not null
        or coalesce(v_order.salary_paid, false)
        or v_order.salary_paid_at is not null
        or coalesce(v_order.status, '') in ('已入帳', '已發薪')
      then
        raise exception '訂單薪資已入帳或發放，不能自動退款';
      end if;
      v_vip_operation := null;
      select * into v_vip_operation
      from public.bot_financial_operations vip_operation
      where vip_operation.organization_code = 'deepnight'
        and vip_operation.operation_key =
          'play-order:' || v_order.id::text || ':vip-spend'
        and vip_operation.status = 'completed'
      for update;
      if found then
        if v_vip_operation.entity_id is distinct from v_order.id::text
          or v_vip_operation.actor_id is distinct from v_payment.user_id
          or coalesce(v_vip_operation.result->>'guild_id', '') <>
            '1501098191813214312'
        then
          raise exception '訂單 VIP 累積紀錄與深夜退款資料不一致';
        end if;
        v_legacy_vip_amount := v_legacy_vip_amount
          + coalesce(v_vip_operation.amount, 0);
        v_vip_operation_keys := array_append(
          v_vip_operation_keys,
          v_vip_operation.operation_key
        );
      elsif coalesce(v_order.vip_spent_counted, false) then
        v_legacy_vip_amount := v_legacy_vip_amount
          + coalesce(v_order.final_price, v_order.price, 0);
      end if;
      v_source_ids := array_append(v_source_ids, v_order.id::text);
    end loop;

    if v_source_count <> cardinality(v_order_ids) or v_source_count = 0 then
      raise exception '找不到完整的街口原始訂單';
    end if;

    -- metadata only locates candidate rows.  Independently match the durable
    -- entity key and the DeepNight source rows before mutating shared tables.
    if v_payment.entity_key like 'group-%' then
      if nullif(v_payment.metadata->>'orderGroupId', '') is null
        or v_payment.entity_key <> 'group-' || (v_payment.metadata->>'orderGroupId')
        or exists (
          select 1
          from public.play_orders source_order
          where source_order.id = any(v_order_ids)
            and source_order.guild_id = '1501098191813214312'
            and source_order.order_group_id is distinct from
              (v_payment.metadata->>'orderGroupId')
        )
      then
        raise exception '街口付款與深夜訂單群組不一致';
      end if;
    elsif cardinality(v_order_ids) <> 1
      or v_order_ids[1]::text is distinct from v_payment.entity_key
    then
      raise exception '街口付款與深夜原始訂單不一致';
    end if;

    if exists (
      select 1 from public.play_orders report
      where exists (
        select 1
        from unnest(v_source_ids) source_id
        where report.order_id like 'WORK-' || source_id || '-%'
      )
        and report.guild_id = '1501098191813214312'
        and (
          report.wallet_settled_at is not null
          or coalesce(report.salary_paid, false)
          or report.salary_paid_at is not null
          or coalesce(report.status, '') in ('已入帳', '已發薪', 'paid')
        )
    ) then
      raise exception '訂單報單薪資已入帳或發放，不能自動退款';
    end if;

    -- The gateway refund has already succeeded.  Coupon recreation belongs to
    -- this same local reversal transaction; if it fails, the payment remains
    -- refund_reversal_pending and only this local step is retried.
    select public.deepnight_restore_order_coupon(
      v_order_ids,
      v_payment.user_id,
      v_operation_key
    ) into v_coupon_restore;

    update public.play_orders
    set paid = false,
        payment_method = '街口支付（已退款）',
        status = 'cancelled',
        quote_status = 'cancelled',
        vip_spent_counted = false,
        vip_spent_counted_at = null,
        updated_at = now()
    where id = any(v_order_ids)
      and guild_id = '1501098191813214312';

    update public.play_orders report
    set is_deleted = true,
        status = 'refunded',
        paid = false,
        salary_paid = false,
        salary_paid_at = null,
        updated_at = now()
    where exists (
      select 1
      from unnest(v_source_ids) source_id
      where report.order_id like 'WORK-' || source_id || '-%'
    )
      and report.guild_id = '1501098191813214312'
      and report.wallet_settled_at is null;

  elsif v_payment.payment_kind = 'extension' then
    v_extension_id := coalesce(
      nullif(v_payment.metadata->>'extensionId', '')::bigint,
      v_payment.entity_key::bigint
    );
    if v_extension_id::text is distinct from v_payment.entity_key then
      raise exception '街口付款與深夜加時單不一致';
    end if;
    select * into v_extension
    from public.order_extensions
    where id = v_extension_id
      and guild_id = '1501098191813214312'
    for update;
    if not found then raise exception '找不到街口退款對應加時單'; end if;
    if v_extension.customer_id is distinct from v_payment.user_id then
      raise exception '加時單付款人不一致';
    end if;

    -- The shared extension row must point to a real DeepNight source order;
    -- matching an extension id supplied in metadata is not sufficient.
    select * into v_order
    from public.play_orders
    where id::text = v_extension.order_id
      and guild_id = '1501098191813214312'
    for update;
    if not found then raise exception '找不到街口加時原訂單'; end if;
    if v_order.customer_id is distinct from v_payment.user_id then
      raise exception '加時原訂單付款人不一致';
    end if;

    if exists (
      select 1 from public.play_orders report
      where report.order_id like 'WORK-EXT-' || v_extension_id::text || '-%'
        and report.guild_id = '1501098191813214312'
        and (
          report.wallet_settled_at is not null
          or coalesce(report.salary_paid, false)
          or report.salary_paid_at is not null
          or coalesce(report.status, '') in ('已入帳', '已發薪', 'paid')
        )
    ) then
      raise exception '加時報單薪資已入帳或發放，不能自動退款';
    end if;

    v_vip_operation := null;
    select * into v_vip_operation
    from public.bot_financial_operations vip_operation
    where vip_operation.organization_code = 'deepnight'
      and vip_operation.operation_key =
        'vip-activity:extension:' || v_extension_id::text
      and vip_operation.status = 'completed'
    for update;
    if found then
      if v_vip_operation.entity_id is distinct from
          'extension:' || v_extension_id::text
        or v_vip_operation.actor_id is distinct from v_payment.user_id
        or coalesce(v_vip_operation.result->>'guild_id', '') <>
          '1501098191813214312'
      then
        raise exception '加時 VIP 累積紀錄與深夜退款資料不一致';
      end if;
      v_legacy_vip_amount := v_legacy_vip_amount
        + coalesce(v_vip_operation.amount, 0);
      v_vip_operation_keys := array_append(
        v_vip_operation_keys,
        v_vip_operation.operation_key
      );
    end if;

    if coalesce(v_extension.applied_to_salary, false) then
      v_old_price := coalesce(v_order.final_price, v_order.price, 0);
      v_new_price := greatest(0, v_old_price - coalesce(v_extension.amount, 0));
      update public.play_orders
      set price = v_new_price,
          final_price = v_new_price,
          note = trim(coalesce(v_order.note, '') || E'\n[街口退款] 加時 ' ||
            coalesce(v_extension.extension_text, v_extension.id::text) ||
            '｜-NT$' || coalesce(v_extension.amount, 0)::text),
          updated_at = now()
      where id = v_order.id
        and guild_id = '1501098191813214312';
    end if;

    update public.order_extensions
    set paid = false,
        payment_method = '街口支付（已退款）',
        status = 'refunded',
        applied_to_salary = false,
        applied_at = null,
        updated_at = now()
    where id = v_extension.id
      and guild_id = '1501098191813214312';

    update public.play_orders
    set is_deleted = true,
        status = 'refunded',
        paid = false,
        salary_paid = false,
        salary_paid_at = null,
        updated_at = now()
    where order_id like 'WORK-EXT-' || v_extension_id::text || '-%'
      and guild_id = '1501098191813214312'
      and wallet_settled_at is null;

    v_source_ids := array_append(v_source_ids, 'EXT-' || v_extension_id::text);

  elsif v_payment.payment_kind = 'tip' then
    for v_order in
      select * from public.play_orders
      where note like '打賞｜街口:' || p_platform_order_id || ':%'
        and guild_id = '1501098191813214312'
      order by id
      for update
    loop
      v_source_count := v_source_count + 1;
      if v_order.customer_id is distinct from v_payment.user_id then
        raise exception '打賞單付款人不一致';
      end if;
      if v_order.wallet_settled_at is not null
        or coalesce(v_order.salary_paid, false)
        or v_order.salary_paid_at is not null
        or coalesce(v_order.status, '') in ('已入帳', '已發薪', 'paid')
      then
        raise exception '打賞薪資已入帳或發放，不能自動退款';
      end if;
      v_vip_operation := null;
      select * into v_vip_operation
      from public.bot_financial_operations vip_operation
      where vip_operation.organization_code = 'deepnight'
        and vip_operation.operation_key =
          'play-order:' || v_order.id::text || ':vip-spend'
        and vip_operation.status = 'completed'
      for update;
      if found then
        if v_vip_operation.entity_id is distinct from v_order.id::text
          or v_vip_operation.actor_id is distinct from v_payment.user_id
          or coalesce(v_vip_operation.result->>'guild_id', '') <>
            '1501098191813214312'
        then
          raise exception '打賞 VIP 累積紀錄與深夜退款資料不一致';
        end if;
        v_legacy_vip_amount := v_legacy_vip_amount
          + coalesce(v_vip_operation.amount, 0);
        v_vip_operation_keys := array_append(
          v_vip_operation_keys,
          v_vip_operation.operation_key
        );
      elsif coalesce(v_order.vip_spent_counted, false) then
        v_legacy_vip_amount := v_legacy_vip_amount
          + coalesce(v_order.final_price, v_order.price, 0);
      end if;
      v_source_ids := array_append(v_source_ids, v_order.id::text);
    end loop;
    if v_source_count = 0 then raise exception '找不到街口退款對應打賞單'; end if;

    if exists (
      select 1 from public.play_orders report
      where exists (
        select 1
        from unnest(v_source_ids) source_id
        where report.order_id like 'WORK-' || source_id || '-%'
      )
        and report.guild_id = '1501098191813214312'
        and (
          report.wallet_settled_at is not null
          or coalesce(report.salary_paid, false)
          or report.salary_paid_at is not null
          or coalesce(report.status, '') in ('已入帳', '已發薪', 'paid')
        )
    ) then
      raise exception '打賞報單薪資已入帳或發放，不能自動退款';
    end if;

    update public.play_orders
    set paid = false,
        payment_method = '街口支付（已退款）',
        status = 'cancelled',
        salary_paid = false,
        salary_paid_at = null,
        vip_spent_counted = false,
        vip_spent_counted_at = null,
        is_deleted = true,
        updated_at = now()
    where id::text = any(v_source_ids)
      and guild_id = '1501098191813214312';

    update public.play_orders report
    set is_deleted = true,
        status = 'refunded',
        paid = false,
        salary_paid = false,
        salary_paid_at = null,
        updated_at = now()
    where exists (
      select 1
      from unnest(v_source_ids) source_id
      where report.order_id like 'WORK-' || source_id || '-%'
    )
      and report.guild_id = '1501098191813214312'
      and report.wallet_settled_at is null;
  else
    raise exception '不支援的街口服務退款類型';
  end if;

  -- A VIP10 coupon granted by a refunded order must not remain spendable.
  -- New grants record the concrete inventory id in the per-order durable
  -- operation.  If it has already been consumed (or a restored replacement is
  -- no longer present), stop before committing the local reversal so staff can
  -- resolve the economic value manually instead of silently creating credit.
  if v_payment.payment_kind in ('order', 'tip') then
    foreach v_source_id in array v_source_ids loop
      v_benefit_result := null;
      v_benefit_coupon_id := null;
      v_benefit_restored_item_id := null;

      select benefit_operation.result
      into v_benefit_result
      from public.bot_financial_operations benefit_operation
      where benefit_operation.organization_code = 'deepnight'
        and benefit_operation.operation_key =
          'play-order:' || v_source_id || ':vip-benefit'
        and benefit_operation.status = 'completed'
      for update;

      if found then
        v_benefit_coupon_id := nullif(
          v_benefit_result->>'coupon_item_id', ''
        )::bigint;
      end if;

      if v_benefit_coupon_id is not null then
        delete from public.user_items
        where id = v_benefit_coupon_id
          and user_id = v_payment.user_id
          and guild_id = '1501098191813214312';

        if found then
          v_revoked_benefit_coupon_ids := array_append(
            v_revoked_benefit_coupon_ids,
            v_benefit_coupon_id
          );
        elsif exists (
          select 1
          from jsonb_array_elements(
            coalesce(v_prepare_result->'reserved_coupons', '[]'::jsonb)
          ) reserved
          where (reserved->>'old_id')::bigint = v_benefit_coupon_id
            and reserved->>'benefit_operation_key' =
              'play-order:' || v_source_id || ':vip-benefit'
        ) then
          v_revoked_benefit_coupon_ids := array_append(
            v_revoked_benefit_coupon_ids,
            v_benefit_coupon_id
          );
        else
          select restored_item_id
          into v_benefit_restored_item_id
          from public.used_coupons
          where item_id = v_benefit_coupon_id
            and user_id = v_payment.user_id
          order by id desc
          limit 1
          for update;

          if not found or v_benefit_restored_item_id is null then
            raise exception
              '退款訂單發放的 VIP 優惠券已使用，請改由人工核對退款';
          end if;

          delete from public.user_items
          where id = v_benefit_restored_item_id
            and user_id = v_payment.user_id
            and guild_id = '1501098191813214312';
          if not found then
            raise exception
              '退款訂單發放的 VIP 優惠券已再次使用，請改由人工核對退款';
          end if;

          v_revoked_benefit_coupon_ids := array_append(
            v_revoked_benefit_coupon_ids,
            v_benefit_restored_item_id
          );
        end if;

        update public.bot_financial_operations
        set result = result || jsonb_build_object(
              'revoked_by_refund', true,
              'revoked_at', now(),
              'refund_platform_order_id', p_platform_order_id
            ),
            updated_at = now()
        where organization_code = 'deepnight'
          and operation_key = 'play-order:' || v_source_id || ':vip-benefit';
      end if;

      update public.play_orders
      set vip_cashback_given = false,
          vip_cashback_amount = 0,
          vip_cashback_at = null,
          updated_at = now()
      where id::text = v_source_id
        and guild_id = '1501098191813214312';
    end loop;
  end if;

  -- Reverse the DeepNight-local VIP cumulative total under the same payment
  -- row lock and transaction.  The local reversal operation is inserted only
  -- after this succeeds, so a retry can never subtract twice.
  v_legacy_vip_amount := least(
    greatest(0, v_legacy_vip_amount),
    greatest(0, coalesce(v_payment.amount, 0))
  );
  if v_legacy_vip_amount > 0 then
    select coalesce(total_spent, 0)
    into v_vip_total_spent
    from public.user_vips
    where guild_id = '1501098191813214312'
      and user_id = v_payment.user_id
    for update;
    if not found then
      raise exception '找不到深夜 VIP 累積資料，已停止本地退款回沖';
    end if;

    update public.user_vips
    set total_spent = greatest(0, coalesce(total_spent, 0) - v_legacy_vip_amount),
        updated_at = now()
    where guild_id = '1501098191813214312'
      and user_id = v_payment.user_id
    returning total_spent into v_vip_total_spent;

    update public.bot_financial_operations
    set result = result || jsonb_build_object(
          'reversed_by_refund', true,
          'reversed_at', now(),
          'refund_platform_order_id', p_platform_order_id
        ),
        updated_at = now()
    where organization_code = 'deepnight'
      and operation_key = any(v_vip_operation_keys);
  else
    select coalesce(total_spent, 0)
    into v_vip_total_spent
    from public.user_vips
    where guild_id = '1501098191813214312'
      and user_id = v_payment.user_id;
  end if;

  v_result := jsonb_build_object(
    'already_processed', false,
    'payment_kind', v_payment.payment_kind,
    'amount', v_payment.amount,
    'source_ids', to_jsonb(v_source_ids),
    'legacy_vip_reverse_amount', v_legacy_vip_amount,
    'vip_total_spent', coalesce(v_vip_total_spent, 0),
    'revoked_benefit_coupon_ids', to_jsonb(v_revoked_benefit_coupon_ids),
    'coupon_restore', v_coupon_restore,
    'old_price', v_old_price,
    'new_price', v_new_price
  );

  insert into public.bot_financial_operations (
    organization_code,
    operation_key,
    operation_type,
    entity_id,
    actor_id,
    amount,
    result
  ) values (
    'deepnight',
    v_operation_key,
    'jkopay_service_reversal',
    p_platform_order_id,
    p_requested_by,
    v_payment.amount,
    v_result
  );

  update public.bot_financial_operations
  set result = result || jsonb_build_object(
        'finalized_at', now(),
        'local_reversal_key', v_operation_key
      ),
      updated_at = now()
  where organization_code = 'deepnight'
    and operation_key =
      'jkopay-service-refund:' || p_platform_order_id || ':prepare';

  return v_result;
end;
$function$;

revoke all on function public.deepnight_reverse_jkopay_service(text, text)
  from public, anon, authenticated;
grant execute on function public.deepnight_reverse_jkopay_service(text, text)
  to service_role;

notify pgrst, 'reload schema';

commit;
