-- Production repair for the critical audit completed on 2026-09-13.
-- Prerequisites:
--   1. 20260913010000_deepnight_critical_order_safety.sql
--   2. 20260913020000_deepnight_coupon_payment_safety.sql
--   3. 20260913030000_deepnight_coupon_refund_restore.sql
--   4. 20260913040000_deepnight_jkopay_recovery_refund.sql
--   5. 20260913050000_deepnight_delivery_recovery.sql
--
-- The script is transactional and idempotent.  It never deletes an original
-- customer order.  Duplicate source rows are hidden by the EIP canonical-row
-- filter; already deposited duplicate wallet credits are offset by immutable
-- deduction entries so that order history remains auditable.

begin;

-- Reject and lock the only pending payout affected by this repair before any
-- wallet correction is inserted.  The row lock prevents an approval update
-- from racing this transaction; unexpected state changes abort the whole run.
do $lock_affected_withdrawal$
declare
  v_status text;
begin
  select status
    into v_status
    from public.salary_withdraw_requests
   where id = '7560401b-f880-49a1-82c0-a23f5acd52a0'
     and app_key = 'deepnight'
     and discord_id = '877961173935484938'
   for update;

  if not found then
    raise exception '找不到受影響的提領 7560401b-f880-49a1-82c0-a23f5acd52a0';
  end if;

  if v_status = 'pending' then
    update public.salary_withdraw_requests
       set status = 'rejected',
           reject_reason = '重複入帳矯正後可用餘額不足，請重新申請',
           reviewed_by = '847840193859682304',
           reviewed_at = now(),
           updated_at = now()
     where id = '7560401b-f880-49a1-82c0-a23f5acd52a0'
       and app_key = 'deepnight'
       and discord_id = '877961173935484938'
       and status = 'pending';

    if not found then
      raise exception '受影響提領在鎖定後未能駁回，停止修復';
    end if;
  elsif v_status <> 'rejected' then
    raise exception '受影響提領狀態不是 pending/rejected，停止修復：%', v_status;
  end if;

  if not exists (
    select 1
      from public.salary_withdraw_requests
     where id = '7560401b-f880-49a1-82c0-a23f5acd52a0'
       and app_key = 'deepnight'
       and discord_id = '877961173935484938'
       and status = 'rejected'
  ) then
    raise exception '受影響提領最終狀態驗證失敗';
  end if;
end;
$lock_affected_withdrawal$;

create temporary table deepnight_duplicate_wallet_sources_20260913
on commit drop as
select
  source.id::text as source_id,
  source.discord_id,
  coalesce(source.staff_name, source.discord_id, '未知陪陪') as staff_name,
  original_ledger.amount as correction_amount,
  coalesce(original_ledger.period_key, 'historical-20260913') as period_key,
  coalesce(original_ledger.settlement_date, date '2026-09-13') as settlement_date,
  (
    select jsonb_agg(work_order.id::text order by work_order.id)
    from public.play_orders work_order
    where coalesce(work_order.is_deleted, false) = false
      and work_order.order_id like 'WORK-' || source.id::text || '-%'
      and exists (
        select 1
        from public.salary_wallet_entries work_entry
        where work_entry.app_key = 'deepnight'
          and work_entry.source_table = 'play_orders'
          and work_entry.source_id = work_order.id::text
          and work_entry.entry_type in ('order_salary', 'order_bonus')
      )
  ) as canonical_work_ids
from public.play_orders source
cross join lateral (
  select
    round(sum(entry.amount)::numeric, 2) as amount,
    max(entry.period_key) as period_key,
    max(entry.settlement_date) as settlement_date
  from public.salary_wallet_entries entry
  where entry.app_key = 'deepnight'
    and entry.source_table = 'play_orders'
    and entry.source_id = source.id::text
    and entry.entry_type in ('order_salary', 'order_bonus')
) original_ledger
where source.guild_id = '1501098191813214312'
  and coalesce(source.is_deleted, false) = false
  and original_ledger.amount <> 0
  and exists (
    select 1
    from public.play_orders work_order
    where coalesce(work_order.is_deleted, false) = false
      and work_order.order_id like 'WORK-' || source.id::text || '-%'
      and exists (
        select 1
        from public.salary_wallet_entries work_entry
        where work_entry.app_key = 'deepnight'
          and work_entry.source_table = 'play_orders'
          and work_entry.source_id = work_order.id::text
          and work_entry.entry_type in ('order_salary', 'order_bonus')
      )
  );

do $assert_duplicate_scope$
declare
  v_count integer;
  v_total numeric;
begin
  select count(*), coalesce(sum(correction_amount), 0)
    into v_count, v_total
    from deepnight_duplicate_wallet_sources_20260913;

  if v_count <> 40 or v_total <> 11783 then
    raise exception
      '重複入帳修復範圍已變更，停止執行：預期 40 筆 / 11783，目前 % 筆 / %',
      v_count, v_total;
  end if;
end;
$assert_duplicate_scope$;

-- The first production correction was applied on 2026-09-08 using one
-- players_bonus deduction per employee.  Each row records one or more source
-- order ids in metadata.  Recognise that legacy batch so this newer per-order
-- repair cannot deduct the same NT$11,783 a second time.
create temporary table deepnight_legacy_duplicate_corrections_20260913
on commit drop as
select entry.*
from public.salary_wallet_entries entry
where entry.app_key = 'deepnight'
  and entry.entry_type = 'staff_bonus'
  and entry.source_table = 'players_bonus'
  and entry.source_label = '扣除｜重複入帳矯正'
  and entry.metadata ->> 'note' = '重複入帳矯正'
  and entry.metadata ? 'duplicate_source_ids';

do $assert_legacy_duplicate_correction$
declare
  v_entry_count integer;
  v_source_count integer;
  v_total numeric;
  v_missing integer;
  v_unexpected integer;
  v_new_count integer;
begin
  select count(*), coalesce(sum(amount), 0)
    into v_entry_count, v_total
    from deepnight_legacy_duplicate_corrections_20260913;

  select count(distinct legacy_source.source_id)
    into v_source_count
    from deepnight_legacy_duplicate_corrections_20260913 legacy
    cross join lateral jsonb_array_elements_text(
      legacy.metadata -> 'duplicate_source_ids'
    ) as legacy_source(source_id);

  select count(*)
    into v_missing
    from deepnight_duplicate_wallet_sources_20260913 expected
   where not exists (
     select 1
       from deepnight_legacy_duplicate_corrections_20260913 legacy
       cross join lateral jsonb_array_elements_text(
         legacy.metadata -> 'duplicate_source_ids'
       ) as legacy_source(source_id)
      where legacy_source.source_id = expected.source_id
   );

  select count(*)
    into v_unexpected
    from (
      select distinct legacy_source.source_id
        from deepnight_legacy_duplicate_corrections_20260913 legacy
        cross join lateral jsonb_array_elements_text(
          legacy.metadata -> 'duplicate_source_ids'
        ) as legacy_source(source_id)
      except
      select source_id from deepnight_duplicate_wallet_sources_20260913
    ) unexpected;

  select count(*)
    into v_new_count
    from public.salary_wallet_entries entry
   where entry.app_key = 'deepnight'
     and entry.source_table = 'deepnight_duplicate_salary_corrections'
     and entry.entry_type = 'staff_bonus'
     and entry.source_id in (
       select 'historical-20260913:' || source_id
       from deepnight_duplicate_wallet_sources_20260913
     );

  if v_entry_count = 0 then
    if v_source_count <> 0 or v_total <> 0 or v_new_count not in (0, 40) then
      raise exception '重複入帳矯正狀態不完整，停止修復';
    end if;
    return;
  end if;

  if v_entry_count <> 23
     or v_source_count <> 40
     or v_total <> -11783
     or v_missing <> 0
     or v_unexpected <> 0
     or v_new_count <> 0 then
    raise exception
      '既有重複入帳矯正不完整，停止執行：扣項 % 筆 / 來源 % 筆 / 合計 % / 缺少 % / 多出 % / 新格式 %',
      v_entry_count, v_source_count, v_total, v_missing, v_unexpected, v_new_count;
  end if;
end;
$assert_legacy_duplicate_correction$;

insert into public.salary_wallet_entries (
  app_key,
  discord_id,
  staff_name,
  entry_type,
  amount,
  source_table,
  source_id,
  source_label,
  period_key,
  settlement_date,
  metadata
)
select
  'deepnight',
  duplicate.discord_id,
  duplicate.staff_name,
  'staff_bonus',
  -duplicate.correction_amount,
  'deepnight_duplicate_salary_corrections',
  'historical-20260913:' || duplicate.source_id,
  '重複入帳矯正',
  duplicate.period_key,
  date '2026-09-13',
  jsonb_build_object(
    'correction_type', 'duplicate_source_order_deposit',
    'repair_batch', 'deepnight-20260913-duplicate-source-orders',
    'target_order_id', duplicate.source_id,
    'canonical_work_ids', duplicate.canonical_work_ids,
    'original_duplicate_amount', duplicate.correction_amount
  )
from deepnight_duplicate_wallet_sources_20260913 duplicate
where not exists (
  select 1 from deepnight_legacy_duplicate_corrections_20260913
)
on conflict (app_key, source_table, source_id, entry_type) do nothing;

do $assert_duplicate_result$
declare
  v_count integer;
  v_total numeric;
  v_legacy_count integer;
  v_legacy_total numeric;
begin
  select count(*), coalesce(sum(entry.amount), 0)
    into v_count, v_total
    from public.salary_wallet_entries entry
   where entry.app_key = 'deepnight'
     and entry.source_table = 'deepnight_duplicate_salary_corrections'
     and entry.entry_type = 'staff_bonus'
     and entry.source_id in (
       select 'historical-20260913:' || source_id
       from deepnight_duplicate_wallet_sources_20260913
     );

  select count(*), coalesce(sum(entry.amount), 0)
    into v_legacy_count, v_legacy_total
    from deepnight_legacy_duplicate_corrections_20260913 entry;

  if v_legacy_count = 23 and v_legacy_total = -11783 then
    if v_count <> 0 or v_total <> 0 then
      raise exception '既有重複入帳矯正完成後仍出現新格式扣項，停止修復';
    end if;
    return;
  end if;

  if v_count <> 40 or v_total <> -11783 then
    raise exception
      '重複入帳扣項驗證失敗：預期 40 筆 / -11783，目前 % 筆 / %',
      v_count, v_total;
  end if;
end;
$assert_duplicate_result$;

-- September tips were incorrectly stored at 80%.  None of these rows had
-- entered the salary wallet during the audit, so correcting the source is safe.
create temporary table deepnight_bad_tips_20260913
on commit drop as
select
  id,
  round(coalesce(order_amount, final_price, price, 0)::numeric * 0.9) as correct_salary,
  round(
    round(coalesce(order_amount, final_price, price, 0)::numeric * 0.9)
      - coalesce(staff_salary, 0),
    2
  ) as salary_delta
from public.play_orders
where guild_id = '1501098191813214312'
  and coalesce(is_deleted, false) = false
  and wallet_settled_at is null
  and coalesce(salary_rate, 0) < 90
  and coalesce(order_finished_at, created_at) >= timestamptz '2026-08-31 16:00:00+00'
  and coalesce(order_finished_at, created_at) < timestamptz '2026-09-30 16:00:00+00'
  and (
    order_type = '打賞'
    or service_name like '%打賞%'
    or game = '打賞'
  );

-- Freeze every candidate until the rate update and its durable batch marker
-- have committed. Salary settlement updates the same source rows, so it cannot
-- race the repair after these locks are acquired.
do $lock_tip_sources$
declare
  v_expected integer;
  v_locked integer;
begin
  select count(*) into v_expected from deepnight_bad_tips_20260913;

  perform 1
    from public.play_orders tip
    join deepnight_bad_tips_20260913 target on target.id = tip.id
   order by tip.id
   for update of tip;
  get diagnostics v_locked = row_count;

  if v_locked <> v_expected then
    raise exception '九月打賞修復鎖定筆數不一致：預期 %，實際 %',
      v_expected, v_locked;
  end if;
end;
$lock_tip_sources$;

do $assert_tip_scope$
declare
  v_count integer;
  v_delta numeric;
  v_current_count integer;
  v_current_delta numeric;
  v_marker_amount numeric;
  v_marker_result jsonb;
  v_mismatch text;
begin
  select count(*), coalesce(sum(salary_delta), 0)
    into v_count, v_delta
    from deepnight_bad_tips_20260913;

  select amount, result
    into v_marker_amount, v_marker_result
    from public.bot_financial_operations
   where organization_code = 'deepnight'
     and operation_key = 'historical-20260913:september-tip-rate-90';

  if found then
    if v_count <> 0 or v_delta <> 0 then
      raise exception
        '九月打賞修復已有完成標記，但仍有 % 筆 / +% 待修復',
        v_count, v_delta;
    end if;
    if v_marker_amount <> 194
       or coalesce((v_marker_result ->> 'row_count')::integer, 0) <> 25
       or coalesce((v_marker_result ->> 'salary_delta')::numeric, 0) <> 194 then
      raise exception '九月打賞修復完成標記內容不符 25 筆 / +194';
    end if;
    return;
  end if;

  if v_count <> 25 or v_delta <> 194 then
    raise exception
      '九月打賞修復範圍已變更且無完成標記，停止執行：預期 25 筆 / +194，目前 % 筆 / %',
      v_count, v_delta;
  end if;

  -- Re-read the locked rows instead of trusting the earlier candidate snapshot.
  select count(*), coalesce(sum(
    round(
      round(coalesce(tip.order_amount, tip.final_price, tip.price, 0)::numeric * 0.9)
        - coalesce(tip.staff_salary, 0),
      2
    )
  ), 0)
    into v_current_count, v_current_delta
    from public.play_orders tip
    join deepnight_bad_tips_20260913 target on target.id = tip.id
   where tip.guild_id = '1501098191813214312'
     and coalesce(tip.is_deleted, false) = false
     and tip.wallet_settled_at is null
     and coalesce(tip.salary_rate, 0) < 90
     and coalesce(tip.order_finished_at, tip.created_at)
       >= timestamptz '2026-08-31 16:00:00+00'
     and coalesce(tip.order_finished_at, tip.created_at)
       < timestamptz '2026-09-30 16:00:00+00'
     and (
       tip.order_type = '打賞'
       or tip.service_name like '%打賞%'
       or tip.game = '打賞'
     );

  if v_current_count <> 25 or v_current_delta <> 194 then
    raise exception
      '鎖定後九月打賞差額已變更，停止執行：目前 % 筆 / %',
      v_current_count, v_current_delta;
  end if;

  select string_agg(tip.id::text, ', ' order by tip.id)
    into v_mismatch
    from public.play_orders tip
    join deepnight_bad_tips_20260913 target on target.id = tip.id
   where target.correct_salary is distinct from round(
           coalesce(tip.order_amount, tip.final_price, tip.price, 0)::numeric * 0.9
         )
      or target.salary_delta is distinct from round(
           round(
             coalesce(tip.order_amount, tip.final_price, tip.price, 0)::numeric
               * 0.9
           ) - coalesce(tip.staff_salary, 0),
           2
         );

  if v_mismatch is not null then
    raise exception '鎖定後九月打賞單筆差額已變更：%', v_mismatch;
  end if;
end;
$assert_tip_scope$;

update public.play_orders tip
set salary_rate = 90,
    salary_level = '打賞固定 90%',
    staff_salary = target.correct_salary,
    platform_income = coalesce(tip.order_amount, tip.final_price, tip.price, 0),
    platform_expense = target.correct_salary + coalesce(tip.bonus_amount, 0),
    updated_at = now()
from deepnight_bad_tips_20260913 target
where tip.id = target.id;

do $record_tip_repair$
declare
  v_count integer;
  v_delta numeric;
  v_order_ids jsonb;
  v_inserted integer;
begin
  select count(*), coalesce(sum(salary_delta), 0),
         jsonb_agg(id::text order by id)
    into v_count, v_delta, v_order_ids
    from deepnight_bad_tips_20260913;

  if v_count = 0 then
    return;
  end if;

  if v_count <> 25 or v_delta <> 194 then
    raise exception '九月打賞修復標記拒絕記錄非 25 筆 / +194';
  end if;

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
    'historical-20260913:september-tip-rate-90',
    'salary_tip_rate_correction',
    '2026-09-deepnight-tips',
    '847840193859682304',
    v_delta,
    jsonb_build_object(
      'repair_batch', 'deepnight-20260913-september-tips-plus-194',
      'row_count', v_count,
      'salary_delta', v_delta,
      'order_ids', v_order_ids
    )
  )
  on conflict (organization_code, operation_key) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted <> 1 then
    raise exception '九月打賞修復完成標記未能唯一寫入';
  end if;
end;
$record_tip_repair$;

do $assert_tip_result$
declare
  v_marker_amount numeric;
  v_marker_result jsonb;
  v_recorded_count integer;
  v_distinct_count integer;
  v_valid_count integer;
  v_remaining_count integer;
  v_remaining_delta numeric;
begin
  select amount, result
    into v_marker_amount, v_marker_result
    from public.bot_financial_operations
   where organization_code = 'deepnight'
     and operation_key = 'historical-20260913:september-tip-rate-90';

  if not found
     or v_marker_amount <> 194
     or coalesce((v_marker_result ->> 'row_count')::integer, 0) <> 25
     or coalesce((v_marker_result ->> 'salary_delta')::numeric, 0) <> 194 then
    raise exception '九月打賞修復完成標記驗證失敗';
  end if;

  with recorded_ids as (
    select value as order_id
    from jsonb_array_elements_text(v_marker_result -> 'order_ids')
  )
  select count(*), count(distinct order_id)
    into v_recorded_count, v_distinct_count
    from recorded_ids;

  if v_recorded_count <> 25 or v_distinct_count <> 25 then
    raise exception '九月打賞修復標記必須含 25 個唯一訂單 ID';
  end if;

  with recorded_ids as (
    select value as order_id
    from jsonb_array_elements_text(v_marker_result -> 'order_ids')
  )
  select count(*)
    into v_valid_count
    from recorded_ids
    join public.play_orders tip on tip.id::text = recorded_ids.order_id
   where tip.guild_id = '1501098191813214312'
     and coalesce(tip.is_deleted, false) = false
     and tip.salary_rate = 90
     and tip.staff_salary = round(
       coalesce(tip.order_amount, tip.final_price, tip.price, 0)::numeric * 0.9
     );

  if v_valid_count <> 25 then
    raise exception '九月打賞修復後的 25 筆來源結果驗證失敗';
  end if;

  select count(*), coalesce(sum(
    round(
      round(coalesce(order_amount, final_price, price, 0)::numeric * 0.9)
        - coalesce(staff_salary, 0),
      2
    )
  ), 0)
    into v_remaining_count, v_remaining_delta
    from public.play_orders
   where guild_id = '1501098191813214312'
     and coalesce(is_deleted, false) = false
     and wallet_settled_at is null
     and coalesce(salary_rate, 0) < 90
     and coalesce(order_finished_at, created_at)
       >= timestamptz '2026-08-31 16:00:00+00'
     and coalesce(order_finished_at, created_at)
       < timestamptz '2026-09-30 16:00:00+00'
     and (
       order_type = '打賞'
       or service_name like '%打賞%'
       or game = '打賞'
     );

  if v_remaining_count <> 0 or v_remaining_delta <> 0 then
    raise exception '九月打賞修復後仍有 % 筆 / % 差額',
      v_remaining_count, v_remaining_delta;
  end if;
end;
$assert_tip_result$;

-- The 95%-coupon purchase succeeded in the wallet but the old VIP call failed
-- after it.  Apply the missing NT$10 once, recorded in the shared operation log.
do $repair_shop_vip$
declare
  v_inserted integer;
  v_updated integer;
  v_old_total numeric;
  v_new_total numeric;
  v_highest_topup numeric;
  v_old_level_sort integer;
  v_new_level_sort integer;
begin
  select
    coalesce(total_spent, 0),
    coalesce(highest_single_topup, 0)
    into v_old_total, v_highest_topup
    from public.user_vips
   where user_id = '1254431776932237364'
     and guild_id = '1501098191813214312'
   for update;

  if not found then
    raise exception 'VIP 累積消費修復找不到唯一會員列';
  end if;

  v_new_total := v_old_total + 10;

  select coalesce(max(sort_order), 0)
    into v_old_level_sort
    from public.vip_levels
   where guild_id = '1501098191813214312'
     and (
       (coalesce(total_spend_required, 0) > 0 and v_old_total >= total_spend_required)
       or
       (coalesce(single_topup_required, 0) > 0 and v_highest_topup >= single_topup_required)
     );

  select coalesce(max(sort_order), 0)
    into v_new_level_sort
    from public.vip_levels
   where guild_id = '1501098191813214312'
     and (
       (coalesce(total_spend_required, 0) > 0 and v_new_total >= total_spend_required)
       or
       (coalesce(single_topup_required, 0) > 0 and v_highest_topup >= single_topup_required)
     );

  -- SQL cannot safely grant Discord roles/DM rewards.  Abort instead of
  -- silently skipping a reward if live data changed across a VIP threshold.
  if v_old_level_sort <> v_new_level_sort then
    raise exception
      'VIP +10 會跨越等級門檻（% -> %），請改由 bot 補發獎勵後再執行',
      v_old_level_sort, v_new_level_sort;
  end if;

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
    'historical-20260913:wallet-log-13648-vip-spent',
    'vip_spent_correction',
    '13648',
    '847840193859682304',
    10,
    jsonb_build_object('wallet_log_id', 13648, 'reason', '商店購買後 VIP 累積呼叫失敗')
  )
  on conflict (organization_code, operation_key) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 1 then
    update public.user_vips
    set total_spent = v_new_total,
        updated_at = now()
    where user_id = '1254431776932237364'
      and guild_id = '1501098191813214312';
    get diagnostics v_updated = row_count;
    if v_updated <> 1 then
      raise exception 'VIP 累積消費修復找不到唯一會員列';
    end if;
  end if;
end;
$repair_shop_vip$;

-- Order ORD-0000000409 has two completed work reports, but the original row
-- retained only the first accepted player after a concurrent accept race.
do $repair_order_409$
declare
  v_assigned text;
  v_work_players text[];
begin
  select array_agg(work_order.discord_id order by work_order.discord_id)
    into v_work_players
    from public.play_orders work_order
   where work_order.order_id like 'WORK-6c60bbde-b05a-4a13-8642-311758d501c8-%'
     and work_order.guild_id = '1501098191813214312'
     and coalesce(work_order.is_deleted, false) = false
     and work_order.status = 'completed';

  if v_work_players is distinct from array[
    '856756715017338890'::text,
    '877961173935484938'::text
  ] then
    raise exception 'ORD-0000000409 的完成工單名單已出現其他變化：%', v_work_players;
  end if;

  select assigned_player
    into v_assigned
    from public.play_orders
   where id = '6c60bbde-b05a-4a13-8642-311758d501c8'
     and order_no = 'ORD-0000000409'
     and guild_id = '1501098191813214312'
   for update;

  if not found then
    raise exception '找不到 ORD-0000000409';
  end if;

  if v_assigned is null or v_assigned = '877961173935484938' then
    update public.play_orders
    set assigned_player = '877961173935484938,856756715017338890',
        status = 'accepted',
        updated_at = now()
    where id = '6c60bbde-b05a-4a13-8642-311758d501c8';
  elsif v_assigned is distinct from '877961173935484938,856756715017338890' then
    raise exception 'ORD-0000000409 接單名單已出現其他變化：%', v_assigned;
  end if;
end;
$repair_order_409$;

commit;
