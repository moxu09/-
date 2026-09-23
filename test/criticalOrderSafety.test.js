const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const indexSource = fs.readFileSync(path.join(root, "index.js"), "utf8");
const dispatchSource = fs.readFileSync(
  path.join(root, "events", "dispatchSystem.js"),
  "utf8",
);
const migrationSource = fs.readFileSync(
  path.join(
    root,
    "supabase",
    "migrations",
    "20260913010000_deepnight_critical_order_safety.sql",
  ),
  "utf8",
);
const couponMigrationSource = fs.readFileSync(
  path.join(
    root,
    "supabase",
    "migrations",
    "20260913020000_deepnight_coupon_payment_safety.sql",
  ),
  "utf8",
);
const jkopayMigrationSource = fs.readFileSync(
  path.join(
    root,
    "supabase",
    "migrations",
    "20260913040000_deepnight_jkopay_recovery_refund.sql",
  ),
  "utf8",
);
const couponRefundMigrationSource = fs.readFileSync(
  path.join(
    root,
    "supabase",
    "migrations",
    "20260913030000_deepnight_coupon_refund_restore.sql",
  ),
  "utf8",
);
const deliveryMigrationSource = fs.readFileSync(
  path.join(
    root,
    "supabase",
    "migrations",
    "20260913050000_deepnight_delivery_recovery.sql",
  ),
  "utf8",
);
const productionRepairSource = fs.readFileSync(
  path.join(
    root,
    "supabase",
    "repairs",
    "20260913_deepnight_production_corrections.sql",
  ),
  "utf8",
);
const jkopaySource = fs.readFileSync(
  path.join(root, "utils", "jkopay.js"),
  "utf8",
);
const workReportSource = fs.readFileSync(
  path.join(root, "events", "workReportSystem.js"),
  "utf8",
);
const accountingSource = fs.readFileSync(
  path.join(root, "utils", "accounting.js"),
  "utf8",
);

function sliceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  assert.notEqual(start, -1, `找不到 ${startText}`);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(end, -1, `找不到 ${endText}`);
  return source.slice(start, end);
}

test("打賞薪資由原子 RPC 寫回同一筆 play_orders 並固定至少 90%", () => {
  const tipCommissionBlock = sliceBetween(
    indexSource,
    "async function getDeepNightTipCommissionInfo(",
    "async function saveDeepNightSalaryOrder(",
  );
  const tipRpc = sliceBetween(
    deliveryMigrationSource,
    "create or replace function public.deepnight_confirm_tip_payment(",
    "-- Marking a JKOPay order paid",
  );

  assert.match(tipRpc, /insert into public\.play_orders/);
  assert.match(tipRpc, /round\(v_amount \* \(v_rate \/ 100\.0\)\)/);
  assert.match(tipRpc, /salary_rate, salary_level/);
  assert.match(tipRpc, /'order_financial_effects'/);
  assert.match(tipRpc, /'tip_work_report_panel'/);
  assert.match(tipCommissionBlock, /regularCommission\.rate > 90/);
  assert.match(tipCommissionBlock, /rate: 90, level: "打賞固定 90%"/);
});

test("商店購買使用單一原子 RPC 並以持久工作補發 VIP 權益", () => {
  const shopBlock = sliceBetween(
    indexSource,
    'if (customId === "shop_select")',
    'if (customId === "select_gacha_pool")',
  );
  assert.match(shopBlock, /deepnight_purchase_shop_item_atomic/);
  assert.match(shopBlock, /processRecoveryJobNow\(interaction\.id, "shop_financial_effects"\)/);
  assert.doesNotMatch(shopBlock, /changeCoins\(/);
  assert.match(deliveryMigrationSource, /'purchased_at', now\(\)/);
  assert.match(indexSource, /async function givePurchasedShopBenefit\(/);
  assert.match(indexSource, /purchasedAt\.getTime\(\) \+ 30 \* 24 \* 60 \* 60 \* 1000/);
});

test("特戰分單錢包與月結都只走同一個原子 RPC", () => {
  const walletBlock = sliceBetween(
    dispatchSource,
    "async function handleServiceConfirmWalletGroup(",
    "async function handleServiceConfirmMonthlyGroup(",
  );
  const monthlyBlock = sliceBetween(
    dispatchSource,
    "async function handleServiceConfirmMonthlyGroup(",
    "async function handleServiceConfirmPaidGroup(",
  );

  for (const block of [walletBlock, monthlyBlock]) {
    assert.match(block, /supabase\.rpc\(\s*"deepnight_pay_service_group"/);
  }
  assert.doesNotMatch(walletBlock, /paymentHelpers\.changeCoins/);
  assert.doesNotMatch(monthlyBlock, /\.from\("member_monthly_accounts"\)/);
  assert.doesNotMatch(monthlyBlock, /\.from\("member_monthly_transactions"\)/);

  assert.match(
    migrationSource,
    /create or replace function public\.deepnight_pay_service_group/,
  );
  assert.match(migrationSource, /order by id\s+for update/);
  assert.match(migrationSource, /cardinality\(v_order_ids\) <> 2/);
  assert.match(migrationSource, /pay_play_order_with_wallet\(v_order_id\)/);
  assert.match(migrationSource, /pay_play_order_with_monthly\(v_order_id\)/);
  assert.match(
    migrationSource,
    /revoke all on function public\.deepnight_pay_service_group[\s\S]*?from public, anon, authenticated/,
  );
});

test("多人同時接單由資料庫列鎖序列化並在鎖內檢查名額", () => {
  const acceptBlock = sliceBetween(
    dispatchSource,
    "async function acceptPlayOrder(",
    "function getGrowthVipLevel(",
  );
  const acceptSql = sliceBetween(
    migrationSource,
    "create or replace function public.deepnight_accept_play_order(",
    "revoke all on function public.deepnight_pay_service_group",
  );

  assert.match(acceptBlock, /supabase\.rpc\(\s*"deepnight_accept_play_order"/);
  assert.doesNotMatch(acceptBlock, /\.update\(updatePayload\)/);
  assert.match(acceptSql, /where id = p_order_id\s+for update/);
  assert.match(
    acceptSql,
    /cardinality\(v_player_ids\) >= v_need_count[\s\S]*?raise exception '這張訂單名額已滿'/,
  );
  assert.match(acceptSql, /v_player_ids := array_append\(v_player_ids, p_player_id\)/);
  assert.match(
    migrationSource,
    /revoke all on function public\.deepnight_accept_play_order[\s\S]*?from public, anon, authenticated/,
  );
});

test("優惠券只在付款成功後由資料庫原子消耗", () => {
  const legacyCouponBlock = sliceBetween(
    indexSource,
    'if (customId.startsWith("coupon_select_"))',
    '\n  } catch (err) {\n    console.error("[字符串選擇菜單錯誤]"',
  );
  const serviceCouponBlock = sliceBetween(
    dispatchSource,
    "async function handleServiceSelectCoupon(",
    "async function openServiceOrderNoteModal(",
  );

  assert.match(legacyCouponBlock, /coupon_item_id/);
  assert.match(serviceCouponBlock, /usedCouponItemId/);
  for (const block of [legacyCouponBlock, serviceCouponBlock]) {
    assert.doesNotMatch(block, /removeUserItem\(/);
    assert.doesNotMatch(block, /\.from\("used_coupons"\)\.insert/);
  }
  assert.match(
    couponMigrationSource,
    /alter column order_id type text using order_id::text/,
  );
  assert.match(
    couponMigrationSource,
    /if not coalesce\(v_order\.paid, false\)[\s\S]*?優惠券未消耗/,
  );
  assert.match(couponMigrationSource, /for update/);
  assert.match(couponMigrationSource, /insert into public\.used_coupons/);
  assert.match(couponMigrationSource, /delete from public\.user_items/);
  assert.match(
    couponMigrationSource,
    /create trigger deepnight_consume_coupon_after_payment/,
  );
});

test("街口確認付款先持久化 paid，再透過共用 attempt fencing 執行下游", () => {
  const callbackBlock = sliceBetween(
    jkopaySource,
    "async function handleServiceResultCallback(",
    "async function refundServicePayment(",
  );
  const processBlock = sliceBetween(
    jkopaySource,
    "async function processPaidFulfillment(",
    "async function recoverPaidFulfillments(",
  );
  const paidUpdateAt = callbackBlock.indexOf('status: "paid"');
  const downstreamAt = callbackBlock.indexOf("await processPaidFulfillment(");

  assert.ok(paidUpdateAt >= 0, "callback 沒有先保存 paid");
  assert.ok(downstreamAt > paidUpdateAt, "下游處理發生在 paid 保存之前");
  assert.match(callbackBlock, /fulfillment_status: "pending"/);
  assert.match(processBlock, /claimPaidFulfillment/);
  assert.match(processBlock, /failPaidFulfillment/);
  assert.match(processBlock, /completePaidFulfillment/);
  assert.match(jkopaySource, /deepnight_claim_jkopay_fulfillment/);
  assert.match(jkopaySource, /deepnight_fail_jkopay_fulfillment/);
  assert.match(jkopaySource, /deepnight_complete_jkopay_fulfillment/);
  assert.match(processBlock, /await onServicePaid/);
  assert.doesNotMatch(
    callbackBlock,
    /catch \(serviceError\)[\s\S]{0,600}status: "pending"/,
  );
  assert.match(jkopayMigrationSource, /fulfillment_status text/);
  assert.match(jkopayMigrationSource, /fulfillment_attempts integer default 0/);
  assert.match(jkopayMigrationSource, /fulfillment_claimed_at timestamptz/);
  assert.match(
    jkopayMigrationSource,
    /status = 'paid' and fulfillment_status in \('pending', 'processing', 'failed'\)/,
  );
});

test("街口 attempt 完成與失敗均由資料庫 fencing 阻止舊 worker 覆寫", () => {
  const completeSql = sliceBetween(
    jkopayMigrationSource,
    "create or replace function public.deepnight_complete_jkopay_fulfillment(",
    "create or replace function public.deepnight_fail_jkopay_fulfillment(",
  );
  const failSql = sliceBetween(
    jkopayMigrationSource,
    "create or replace function public.deepnight_fail_jkopay_fulfillment(",
    "-- Message ids make a retry",
  );

  assert.match(jkopayMigrationSource, /for update/);
  assert.match(
    jkopayMigrationSource,
    /v_attempt := coalesce\(v_payment\.fulfillment_attempts, 0\) \+ 1/,
  );
  for (const block of [completeSql, failSql]) {
    assert.match(block, /organization_code = 'deepnight'/);
    assert.match(block, /fulfillment_status = 'processing'/);
    assert.match(block, /coalesce\(fulfillment_attempts, 0\) = p_attempt/);
    assert.match(block, /return found/);
  }
});

test("街口 recovery 只掃描 DeepNight 待處理、失敗與逾時 processing", () => {
  const recoveryBlock = sliceBetween(
    jkopaySource,
    "async function recoverPaidFulfillments(",
    "async function handleServiceResultCallback(",
  );
  const backfillBlock = sliceBetween(
    jkopayMigrationSource,
    "-- This migration belongs to DeepNight.",
    "alter table public.jkopay_service_payments\n  drop constraint if exists jkopay_service_payments_fulfillment_status_check",
  );
  const backfillUpdates = backfillBlock.match(
    /update public\.jkopay_service_payments[\s\S]*?;/g,
  );

  assert.equal(backfillUpdates?.length, 2);
  for (const statement of backfillUpdates) {
    assert.match(statement, /where organization_code = 'deepnight'/);
  }
  assert.match(backfillBlock, /fulfillment_status = 'completed'[\s\S]*?status = 'paid'/);
  assert.match(backfillBlock, /when status = 'paid' then 'completed'/);
  assert.match(recoveryBlock, /\.eq\("organization_code", DEEPNIGHT_ORGANIZATION_CODE\)/);
  assert.match(recoveryBlock, /\.eq\("status", "paid"\)/);
  assert.match(recoveryBlock, /\.in\("fulfillment_status", \["pending", "failed"\]\)/);
  assert.match(recoveryBlock, /\.eq\("fulfillment_status", "processing"\)/);
  assert.match(recoveryBlock, /claimedAt <= staleBefore/);
  assert.match(recoveryBlock, /await processPaidFulfillment\(payment/);
  assert.match(indexSource, /startJkopayFulfillmentRecoveryScheduler/);
  assert.match(indexSource, /setInterval\(scheduledRecovery, 60 \* 1000\)/);
  assert.match(indexSource, /name: "街口付款後續補償排程"/);
});

test("錢包與月結付款同交易建立 DeepNight 派單補償且拒絕終止訂單", () => {
  for (const functionName of [
    "deepnight_pay_play_order_with_wallet",
    "deepnight_pay_play_order_with_monthly",
  ]) {
    const block = sliceBetween(
      deliveryMigrationSource,
      `create or replace function public.${functionName}(`,
      functionName.endsWith("wallet")
        ? "create or replace function public.deepnight_pay_play_order_with_monthly("
        : "-- Two-row VALORANT payment",
    );
    assert.match(block, /p_guild_id is distinct from '1501098191813214312'/);
    assert.match(block, /where id = p_order_id and guild_id = p_guild_id for update/);
    assert.match(block, /status not in \('waiting_payment', 'quoted', 'waiting_confirm'\)/);
    assert.match(block, /deepnight_enqueue_delivery_recovery/);
    assert.match(block, /customer_confirmation/);
  }
});

test("派單補償 scanner 以 organization/guild 隔離並使用 attempt fencing", () => {
  const scannerBlock = sliceBetween(
    dispatchSource,
    "async function recoverPendingDeliveries(",
    "async function retryOrderDelivery(",
  );
  assert.match(scannerBlock, /\.eq\("organization_code", DEEPNIGHT_ORGANIZATION_CODE\)/);
  assert.match(scannerBlock, /\.eq\("guild_id", DEEPNIGHT_GUILD_ID\)/);
  assert.match(scannerBlock, /\.in\("status", \["pending", "failed"\]\)/);
  assert.match(scannerBlock, /\.eq\("status", "processing"\)/);
  assert.match(scannerBlock, /\.lt\("claimed_at", staleBefore\)/);
  assert.match(deliveryMigrationSource, /deepnight_claim_delivery_recovery/);
  assert.match(deliveryMigrationSource, /attempts = v_attempt/);
  assert.match(
    deliveryMigrationSource,
    /status = 'processing' and coalesce\(attempts, 0\) = p_attempt/,
  );
  assert.doesNotMatch(
    deliveryMigrationSource,
    /insert into public\.bot_delivery_recovery_jobs[\s\S]*?select 'deepnight'/,
  );
  assert.match(indexSource, /startDeepNightDeliveryRecoveryScheduler/);
  assert.match(indexSource, /name: "深夜派單與工時面板補償排程"/);
});

test("接單 CAS 驗證已付款與可接單員工並原子建立工時補償", () => {
  const acceptSql = sliceBetween(
    deliveryMigrationSource,
    "create or replace function public.deepnight_accept_play_order(",
    "-- Customer confirmation is another state boundary",
  );
  assert.match(acceptSql, /not coalesce\(v_order\.paid, false\)/);
  assert.match(acceptSql, /from public\.players player/);
  assert.match(acceptSql, /player\.guild_id is null/);
  assert.match(acceptSql, /p_guild_id = any\([\s\S]*?regexp_split_to_array/);
  assert.match(acceptSql, /player\.status = 'available'/);
  assert.match(acceptSql, /'work_report_panel'/);
  assert.match(dispatchSource, /p_guild_id: DEEPNIGHT_GUILD_ID/);
  assert.match(dispatchSource, /processOrderDeliveryNow\(updated\.id, "work_report_panel"\)/);
});

test("已存在工時資料仍會補送遺失面板且 Discord 訊息有持久 checkpoint", () => {
  const cardBlock = sliceBetween(
    workReportSource,
    "async function sendReportCard(",
    "async function createReports(",
  );
  const createBlock = sliceBetween(
    workReportSource,
    "async function createReports(",
    "async function sendForAcceptedOrder(",
  );
  assert.match(cardBlock, /work_report_message_id/);
  assert.match(cardBlock, /\.fetch\(\{ limit: 100 \}\)/);
  assert.match(cardBlock, /報單識別碼/);
  assert.match(cardBlock, /保存工時面板編號失敗/);
  assert.match(createBlock, /await sendReportCard\(report, staff\)/);
  assert.doesNotMatch(createBlock, /if \(!existing\)[\s\S]*?sendReportCard/);
});

test("退款在本地回沖交易內 exactly-once 恢復優惠券", () => {
  assert.match(couponRefundMigrationSource, /coupon_snapshot jsonb/);
  assert.match(couponRefundMigrationSource, /old\.guild_id = '1501098191813214312'/);
  assert.match(couponRefundMigrationSource, /for update/);
  assert.match(couponRefundMigrationSource, /restored_at is not null/);
  assert.match(couponRefundMigrationSource, /returning id into v_restored_item_id/);
  assert.match(couponRefundMigrationSource, /coupon_consumed_at = null/);
  assert.match(
    jkopayMigrationSource,
    /select public\.deepnight_restore_order_coupon\([\s\S]*?v_operation_key/,
  );
  assert.match(jkopayMigrationSource, /'coupon_restore', v_coupon_restore/);
});

test("街口 durable handler 對會計與打賞面板使用持久 checkpoint", () => {
  assert.match(accountingSource, /const strict = entry\.strict === true/);
  assert.match(accountingSource, /if \(strict\) throw new Error/);
  const tipBlock = sliceBetween(
    indexSource,
    "async function handleJkopayServicePaid(",
    "function isWalletPayment(",
  );
  assert.match(tipBlock, /deepnight_fulfill_jkopay_tip/);
  assert.match(tipBlock, /processTipPaymentJobs\(tipOrders\)/);
  const paidBlock = sliceBetween(
    dispatchSource,
    "async function handleJkopayServicePaid(",
    "module.exports = {",
  );
  assert.match(paidBlock, /processOrderDeliveryNow\(order\.id, "order_dispatch"\)/);
  assert.match(paidBlock, /processOrderDeliveryNow\(order\.id, "order_financial_effects"\)/);
  assert.match(dispatchSource, /recordAccountingLedger\(\{[\s\S]*?strict: true/);
});

test("街口服務退款鎖定一次且退款成功後只重試本地回沖", () => {
  const refundBlock = sliceBetween(
    jkopaySource,
    "async function refundServicePayment(",
    "async function handleHttpRequest(",
  );

  assert.match(refundBlock, /\.eq\("status", "paid"\)/);
  assert.match(refundBlock, /status: "refunding"/);
  assert.match(refundBlock, /status: "refund_reversal_pending"/);
  assert.match(refundBlock, /status: "refunded"/);
  assert.match(refundBlock, /gateway\/service-refund/);
  assert.match(refundBlock, /await onValidateServiceRefund/);
  assert.match(refundBlock, /await onServiceRefunded/);
  assert.match(
    jkopayMigrationSource,
    /create or replace function public\.deepnight_reverse_jkopay_service/,
  );
  assert.match(
    jkopayMigrationSource,
    /operation_key = v_operation_key[\s\S]*?already_processed/,
  );
  assert.match(
    jkopayMigrationSource,
    /wallet_settled_at is not null[\s\S]*?不能自動退款/,
  );
});

test("街口本地回沖逐類型拒絕跨店同 ID 且不單獨信任 metadata", () => {
  const reversalSql = sliceBetween(
    jkopayMigrationSource,
    "create or replace function public.deepnight_reverse_jkopay_service(",
    "revoke all on function public.deepnight_reverse_jkopay_service(text, text)",
  );
  const orderBlock = sliceBetween(
    reversalSql,
    "if v_payment.payment_kind = 'order' then",
    "elsif v_payment.payment_kind = 'extension' then",
  );
  const extensionBlock = sliceBetween(
    reversalSql,
    "elsif v_payment.payment_kind = 'extension' then",
    "elsif v_payment.payment_kind = 'tip' then",
  );
  const tipBlock = sliceBetween(
    reversalSql,
    "elsif v_payment.payment_kind = 'tip' then",
    "else\n    raise exception '不支援的街口服務退款類型'",
  );

  assert.match(orderBlock, /where id = any\(v_order_ids\)[\s\S]*?guild_id = '1501098191813214312'/);
  assert.match(orderBlock, /v_payment\.entity_key like 'group-%'/);
  assert.match(orderBlock, /source_order\.order_group_id is distinct from/);
  assert.match(orderBlock, /v_order_ids\[1\]::text is distinct from v_payment\.entity_key/);
  assert.match(orderBlock, /report\.guild_id = '1501098191813214312'/);

  assert.match(extensionBlock, /v_extension_id::text is distinct from v_payment\.entity_key/);
  assert.match(extensionBlock, /from public\.order_extensions[\s\S]*?guild_id = '1501098191813214312'/);
  assert.match(extensionBlock, /from public\.play_orders[\s\S]*?id::text = v_extension\.order_id[\s\S]*?guild_id = '1501098191813214312'/);
  assert.match(extensionBlock, /v_extension\.customer_id is distinct from v_payment\.user_id/);
  assert.match(extensionBlock, /v_order\.customer_id is distinct from v_payment\.user_id/);
  assert.match(extensionBlock, /report\.guild_id = '1501098191813214312'/);
  assert.match(extensionBlock, /where id = v_extension\.id[\s\S]*?guild_id = '1501098191813214312'/);

  assert.match(tipBlock, /note like '打賞｜街口:' \|\| p_platform_order_id \|\| ':%'[\s\S]*?guild_id = '1501098191813214312'/);
  assert.match(tipBlock, /v_order\.customer_id is distinct from v_payment\.user_id/);
  assert.match(tipBlock, /report\.guild_id = '1501098191813214312'/);
  assert.match(tipBlock, /where id::text = any\(v_source_ids\)[\s\S]*?guild_id = '1501098191813214312'/);
});

test("街口付款重試透過原子 RPC 重讀付款資料且復用 Discord 訊息", () => {
  const paidBlock = sliceBetween(
    dispatchSource,
    "async function handleJkopayServicePaid(",
    "module.exports = {",
  );
  assert.match(paidBlock, /deepnight_mark_jkopay_orders_paid/);
  assert.match(paidBlock, /deepnight_mark_jkopay_extension_paid/);
  assert.match(paidBlock, /processOrderDeliveryNow\(order\.id, "order_financial_effects"\)/);
  assert.doesNotMatch(paidBlock, /\.from\("play_orders"\)[\s\S]*?\.update\(\{[\s\S]*?paid: true/);
  assert.match(dispatchSource, /dispatch_message_id/);
  assert.match(dispatchSource, /dispatch_control_message_id/);
  assert.match(dispatchSource, /customer_confirm_message_id/);
  assert.match(dispatchSource, /completion_message_id/);
});

test("歷史打賞 25 筆 +194 修復有列鎖、完成標記與結果驗證", () => {
  assert.match(productionRepairSource, /for update of tip/);
  assert.match(
    productionRepairSource,
    /historical-20260913:september-tip-rate-90/,
  );
  assert.match(
    productionRepairSource,
    /範圍已變更且無完成標記[ -￿]*?預期 25 筆 \/ \+194/,
  );
  assert.match(productionRepairSource, /v_marker_amount <> 194/);
  assert.match(
    productionRepairSource,
    /target\.correct_salary is distinct from round/,
  );
  assert.match(productionRepairSource, /v_recorded_count <> 25/);
  assert.match(productionRepairSource, /v_valid_count <> 25/);
  assert.match(productionRepairSource, /v_remaining_count <> 0/);
});
