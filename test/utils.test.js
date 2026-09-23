const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const gifts = require("../config/tipGifts");
const crownPackages = require("../config/crownPackages");
const {
  buildCrownOrderItem,
  getCrownPackageByKey,
} = require("../utils/crownOrders");
const {
  formatReviewCustomer,
  shouldPublishReview,
} = require("../utils/reviews");
const { parseAllowedServices } = require("../utils/services");
const { getManualCommissionRate, getOrderCommissionBase } = require("../utils/salaryCommission");
const {
  calculateSalaryDeductionState,
} = require("../utils/salaryDeduction");
const {
  buildTopupTopic,
  getNextTopupNumber,
  getTopupNumberFromTopic,
  normalizeTopupNumber,
} = require("../utils/topupNumbers");
const {
  hasCustomerServicePointRole,
  recordCustomerServicePoint,
} = require("../utils/customerServicePoints");
const {
  buildTipAllocations,
  formatTipStaffMentions,
  getTipAllocationTotal,
  getTipGiftByKey,
  getTipStaffIds,
  getTipTotalAmount,
  hasSelfTip,
  parseTipQuantityList,
} = require("../utils/tips");
const {
  buildJkopayRefundPayload,
  buildServicePlatformOrderId,
  normalizeJkopayServiceOrderId,
  signJkopayPayload,
} = require("../utils/jkopay");
const {
  TOPUP_PRESET_AMOUNTS,
  parseTopupPresetAmount,
} = require("../events/dispatchSystem");

test("購買星雨幣面板提供快捷金額並直接進入付款流程", () => {
  assert.deepEqual(TOPUP_PRESET_AMOUNTS, [100, 250, 500, 1000, 3000, 5000, 10000, 15000]);
  for (const amount of TOPUP_PRESET_AMOUNTS) {
    assert.equal(parseTopupPresetAmount(`order_start_topup_amount_${amount}`), amount);
  }
  assert.equal(parseTopupPresetAmount("order_start_topup_amount_999"), null);
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const dispatchSource = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  assert.match(indexSource, /\.setLabel\("建立訂單"\)/);
  assert.match(indexSource, /\[100, 250, 500, 1000\]/);
  assert.match(indexSource, /\[3000, 5000, 10000, 15000\]/);
  assert.match(indexSource, /\.setLabel\("快速金額"\)[\s\S]*?\.setDisabled\(true\)/);
  assert.match(indexSource, /components: \[row, quickAmountLabelRow, quickAmountRow, quickAmountFinalRow\]/);
  assert.match(dispatchSource, /const checkout = normalizedPreset[\s\S]*prepareTopupCheckout/);
  assert.doesNotMatch(`${indexSource}\n${dispatchSource}`, /儲值星雨幣|建立儲值單/);
});

test("歷史互動錯誤的防護仍保留", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const dispatchSource = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  assert.match(indexSource, /ensureCompletedOrderChannelAccess/);
  assert.match(indexSource, /guild\.members\.fetch\(customerId\)/);
  assert.match(dispatchSource, /interaction\.message\.flags\?\.has\(64\)/);
  assert.match(dispatchSource, /Number\(err\?\.code\) === 10008/);
  assert.match(dispatchSource, /if \(!\/\^\\d\{16,22\}\$\/\.test\(channelId\)\) return/);
});

test("深夜九月抽成最低 90% 且保留更高個人檔位", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(indexSource, /manualRate && manualRate > 90/);
  assert.match(indexSource, /2026-09-01T00:00:00\+08:00/);
  assert.match(indexSource, /2026-10-01T00:00:00\+08:00/);
  assert.match(indexSource, /九月活動最低 90%/);
});

test("深夜街口訂單、加時與打賞使用分流付款編號與 HMAC-SHA256", () => {
  assert.equal(buildServicePlatformOrderId("DEEPNIGHT", "order", "abc-123"), "DEEPNIGHT-ORD-ABC123");
  assert.equal(buildServicePlatformOrderId("DEEPNIGHT", "extension", "ext-9"), "DEEPNIGHT-EXT-EXT9");
  assert.equal(buildServicePlatformOrderId("DEEPNIGHT", "tip", "tip_456"), "DEEPNIGHT-TIP-TIP456");
  assert.equal(signJkopayPayload("payload", "secret").length, 64);
  assert.throws(() => buildServicePlatformOrderId("DEEPNIGHT", "unknown", "1"), /格式錯誤/);
  assert.equal(
    normalizeJkopayServiceOrderId(" deepnight-ord-abc123 "),
    "DEEPNIGHT-ORD-ABC123",
  );
  assert.deepEqual(
    buildJkopayRefundPayload("DEEPNIGHT-EXT-EXT9", 250),
    { platform_order_id: "DEEPNIGHT-EXT-EXT9", refund_amount: 250 },
  );
  assert.throws(() => normalizeJkopayServiceOrderId("DEEPNIGHT-BAD-1"), /格式錯誤/);
  assert.throws(() => buildJkopayRefundPayload("DEEPNIGHT-TIP-1", 0), /金額錯誤/);
});

test("深夜訂單、加時與打賞均顯示正式街口付款並保留可用性防護", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const dispatchSource = fs.readFileSync(path.join(__dirname, "..", "events", "dispatchSystem.js"), "utf8");
  const jkopaySource = fs.readFileSync(path.join(__dirname, "..", "utils", "jkopay.js"), "utf8");
  assert.match(indexSource, /kind: "tip"/);
  assert.match(indexSource, /打賞\$\{paymentLabel\}付款完成/);
  assert.match(dispatchSource, /kind: "order"/);
  assert.match(dispatchSource, /kind: "extension"/);
  assert.match(dispatchSource, /handleJkopayServicePaid/);
  assert.match(jkopaySource, /jkopay_service_payments/);
  assert.match(jkopaySource, /gateway\/service-entry/);
  assert.match(indexSource, /getCanonicalPaymentOptions/);
  assert.match(dispatchSource, /線上付款連結與街口掃碼整合於同一選項|getCanonicalPaymentOptions/);
  assert.match(dispatchSource, /attachment:\s*JKOPAY_QR_CODE_PATH/);
});

test("街口支付合併為單一選項且加時保留月結付款", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const dispatchSource = fs.readFileSync(path.join(__dirname, "..", "events", "dispatchSystem.js"), "utf8");
  const paymentUtils = fs.readFileSync(path.join(__dirname, "..", "utils", "paymentMethodEmojis.js"), "utf8");
  assert.match(paymentUtils, /label: "街口支付"/);
  assert.doesNotMatch(`${indexSource}\n${dispatchSource}`, /label: "街口掃碼（可刷卡）"|label: "街口支付線上付款"/);
  assert.match(dispatchSource, /extension_payment_method_[\s\S]*?includeMonthly: true/);
  assert.match(dispatchSource, /deepnight_pay_extension_with_monthly/);
  assert.match(dispatchSource, /customer_extension_monthly/);
  assert.match(indexSource, /const jkopayPayment = paymentMethod === "街口支付"/);
  assert.doesNotMatch(`${indexSource}\n${dispatchSource}`, /label: "刷卡"|value: "刷卡"|pcpay\.tw/);
  assert.ok(fs.existsSync(path.join(__dirname, "..", "assets", "payments", "jkopay-deepnight.png")));
});

test("深夜所有匯款入口使用與秋奈相同的 LINE Bank 帳號", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const dispatchSource = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  const paymentSources = [indexSource, dispatchSource];

  for (const source of paymentSources) {
    assert.match(source, /銀行：824連線銀行/);
    assert.match(source, /分行：6880總行（非必填）/);
    assert.match(source, /帳號：312000002665/);
    assert.match(source, /戶名：深夜不關燈工作室/);
    assert.match(source, /備註：（麻煩空白即可）/);
    assert.doesNotMatch(source, /60108039566|902960949/);
  }

  assert.ok(
    fs.existsSync(
      path.join(__dirname, "..", "assets", "payments", "bank-transfer-line-bank.png"),
    ),
  );
});

test("tips cannot target the tipper", () => {
  assert.equal(hasSelfTip("100", ["200", "100"]), true);
  assert.equal(hasSelfTip("100", ["200", "300"]), false);
  assert.equal(hasSelfTip("", ["200"]), false);
});

test("manual commission overrides and coupon salary uses the original price", () => {
  assert.equal(getManualCommissionRate("manager_95"), 95);
  assert.equal(getOrderCommissionBase({ price: 500, final_price: 400, discount_amount: 100 }), 500);
  assert.equal(getOrderCommissionBase({ final_price: 400 }), 400);
});

test("salary deduction uses net commissioned salary and caps advances at 1000", () => {
  const enough = calculateSalaryDeductionState({
    walletEntries: [{ amount: 500 }],
    withdrawRequests: [{ amount: 100, status: "approved" }],
    pendingOrders: [{ staff_salary: 700, bonus_amount: 50 }],
    pendingAdjustments: [{ amount: -50 }],
    amount: 1000,
  });
  assert.equal(enough.availableBefore, 1100);
  assert.equal(enough.shortage, 0);
  assert.equal(enough.canUse, true);

  const advance = calculateSalaryDeductionState({
    pendingOrders: [{ staff_salary: 300 }],
    amount: 900,
  });
  assert.equal(advance.projectedAdvance, 600);
  assert.equal(advance.canUse, true);

  const overLimit = calculateSalaryDeductionState({
    pendingAdjustments: [{ amount: -300 }],
    amount: 800,
  });
  assert.equal(overLimit.projectedAdvance, 1100);
  assert.equal(overLimit.canUse, false);
});

test("deepnight salary deduction covers quote, service, extension, and tip payments", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );

  assert.match(source, /\.eq\("app_key", "deepnight"\)/);
  assert.match(source, /deepnight_pay_orders_with_salary/);
  assert.match(source, /salary_quote_confirm_/);
  assert.match(source, /salary_service_confirm_/);
  assert.match(source, /salary_extension_confirm_/);
  assert.match(source, /使用薪水續單/);
  const indexSource = fs.readFileSync(
    path.join(__dirname, "..", "index.js"),
    "utf8",
  );
  const paymentUtils = fs.readFileSync(
    path.join(__dirname, "..", "utils", "paymentMethodEmojis.js"),
    "utf8",
  );
  assert.match(paymentUtils, /label: "員工扣薪"/);
  assert.match(indexSource, /confirm_tip_salary_/);
  assert.match(indexSource, /deepnight_confirm_tip_payment/);
  assert.match(indexSource, /p_payment_method: "扣薪"/);
});

test("deepnight salary payment procedures keep UUID adjustment IDs", () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "supabase",
      "migrations",
      "20260913050000_deepnight_delivery_recovery.sql",
    ),
    "utf8",
  );
  const declarations = source.match(/v_adjustment_id uuid;/g) || [];

  assert.equal(declarations.length, 3);
  assert.doesNotMatch(source, /v_adjustment_id bigint;/);

  const repair = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "supabase",
      "migrations",
      "20260923010000_fix_salary_deduction_adjustment_uuid.sql",
    ),
    "utf8",
  );
  assert.match(repair, /deepnight_pay_orders_with_salary/);
  assert.match(repair, /deepnight_pay_extension_with_salary/);
  assert.match(repair, /deepnight_confirm_tip_payment/);
  assert.match(repair, /'v_adjustment_id bigint;',\s*'v_adjustment_id uuid;'/);
});

test("admin money changes never count as spend, topup, or VIP progress", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "index.js"),
    "utf8",
  );
  const grantStart = source.indexOf('if (interaction.commandName === "發錢")');
  const grantEnd = source.indexOf("// 扣錢", grantStart);
  const grantFlow = source.slice(grantStart, grantEnd);
  const deductionStart = source.indexOf(
    'if (interaction.commandName === "扣錢")',
  );
  const deductionEnd = source.indexOf(
    'if (interaction.commandName === "給與身份組")',
    deductionStart,
  );
  const deductionFlow = source.slice(deductionStart, deductionEnd);

  assert.match(grantFlow, /"管理員發錢"/);
  assert.doesNotMatch(grantFlow, /allianceMembership\.applyActivity/);
  assert.doesNotMatch(grantFlow, /checkAndUpgradeVip/);
  assert.match(deductionFlow, /"管理員扣錢"/);
  assert.doesNotMatch(deductionFlow, /allianceMembership\.applyActivity/);
  assert.doesNotMatch(deductionFlow, /checkAndUpgradeVip/);
});

test("topup numbers use a validated ten-digit sequence", async () => {
  const topic = buildTopupTopic("123", "TOP-0000000001");
  assert.equal(topic, "owner:123;topup_no:TOP-0000000001");
  assert.equal(getTopupNumberFromTopic(topic), "TOP-0000000001");
  assert.equal(normalizeTopupNumber("top-10000000000"), "TOP-10000000000");
  assert.equal(normalizeTopupNumber("TOP-123"), null);
  assert.equal(
    await getNextTopupNumber({
      rpc: async (name) => ({
        data: name === "next_topup_number" ? "TOP-0000000002" : null,
        error: null,
      }),
    }),
    "TOP-0000000002",
  );
});

test("customer service points require the configured role and are idempotent per order", async () => {
  assert.equal(
    hasCustomerServicePointRole({ member: { roles: { cache: new Map([["1210642900355125288", {}]]) } } }),
    true,
  );
  assert.equal(
    hasCustomerServicePointRole({ member: { roles: { cache: new Map() } } }),
    false,
  );
  let upsertCall;
  const recorded = await recordCustomerServicePoint(
    { from: () => ({ upsert: async (row, options) => ((upsertCall = { row, options }), { error: null }) }) },
    { appKey: "deepnight", orderId: "ORD-0000000001", discordId: "staff-1", servedAt: "2026-08-22T00:00:00.000Z" },
  );
  assert.equal(recorded, true);
  assert.equal(upsertCall.row.points, 1);
  assert.deepEqual(upsertCall.options, { onConflict: "app_key,order_id", ignoreDuplicates: true });
});
const {
  buildRedPacketShares,
  normalizeRedPacketMode,
} = require("../utils/redPackets");
const {
  buildReportAmounts,
  buildSavedWorkReportSupplement,
  canCorrectFirstSegmentStart,
  calculateCrownEndAt,
  isStaffInteraction,
  matchStaffLookup,
  normalizeStaffLookup,
  parseTaipeiWorkTime,
  parseCrownDurationHours,
  parseDurationMinutes,
  parseMoney,
  splitStaffLookupInput,
} = require("../events/workReportSystem");

test("存單補時保留原時段且只在累積時長足夠時結單", () => {
  const meta = {
    expectedDurationMinutes: 120,
    segments: [{ startedAt: "2026-09-20T10:00:00.000Z", endedAt: "2026-09-20T11:00:00.000Z", minutes: 60 }],
  };
  const short = buildSavedWorkReportSupplement(meta, new Date("2026-09-21T10:00:00.000Z"), new Date("2026-09-21T10:30:00.000Z"), Date.parse("2026-09-21T11:00:00.000Z"));
  assert.equal(short.totalMinutes, 90);
  assert.equal(short.isComplete, false);
  const complete = buildSavedWorkReportSupplement(short.meta, new Date("2026-09-22T10:00:00.000Z"), new Date("2026-09-22T10:30:00.000Z"), Date.parse("2026-09-22T11:00:00.000Z"));
  assert.equal(complete.totalMinutes, 120);
  assert.equal(complete.isComplete, true);
  assert.equal(complete.meta.segments.length, 3);
  assert.throws(() => buildSavedWorkReportSupplement(meta, new Date("2026-09-20T10:30:00.000Z"), new Date("2026-09-20T11:30:00.000Z"), Date.parse("2026-09-21T11:00:00.000Z")), /重疊/);
});

test("冠名品項可解析時長並計算到期時間", () => {
  assert.equal(
    parseCrownDurationHours(
      "冠名單｜半日冠｜贈送還單 6hrs｜冠名時長 12hrs",
    ),
    12,
  );
  assert.equal(
    parseCrownDurationHours("冠名單｜月冠名｜冠名時長 720hrs"),
    720,
  );
  assert.equal(parseCrownDurationHours("普通打賞"), null);
  assert.equal(
    calculateCrownEndAt("2026-07-28T12:00:00.000Z", 12).toISOString(),
    "2026-07-29T00:00:00.000Z",
  );
});
const { ORDER_FLOW_TTL_MS } = require("../utils/orderFlow");
const {
  isCouponInventoryItem,
  parseVipCouponReward,
  qualifiesForVipLevel,
} = require("../utils/vipRewards");
const { resolveMembershipCardImage } = require("../utils/allianceMembership");
const {
  parseChatDropReward,
  shouldCreateChatDrop,
} = require("../utils/randomEvents");
const {
  createHealthState,
  createNonOverlappingTask,
  createTtlSet,
  scheduleMapExpiry,
  validateEnvironment,
} = require("../utils/runtime");
const { getTaipeiScheduleParts } = require("../utils/dailySelfCheck");

test("每日自動偵錯使用台北時間排程", () => {
  assert.deepEqual(getTaipeiScheduleParts(new Date("2026-08-06T20:10:00Z")), {
    date: "2026-08-07",
    hour: 4,
    minute: 10,
  });
});
const {
  commandDefinitionsMatch,
  syncApplicationCommands,
} = require("../runtime/commandRegistry");
const { runStartupGroup } = require("../runtime/startupOrchestrator");
const {
  GAMES,
  buildApplicationEmbed,
  buildApprovedEmploymentDmContent,
  buildEmploymentPdfBuffer,
  buildEmploymentResultNotice,
  buildExistingCompanionResultDm,
  createEmploymentSystem,
  getCompletedThreadDeleteDelay,
  getApplicationFields,
  hasActiveCompanionAtStore,
  hasPaidOrderAtStore,
  normalizeRoleName,
} = require("../events/employmentSystem");
const { formatComplaintSender } = require("../events/complaintSystem");

test("anonymous complaints never include the sender identity", () => {
  const user = { id: "123456789012345678", tag: "secret-user" };
  const anonymousText = formatComplaintSender(true, user);
  assert.equal(anonymousText, "匿名（未紀錄發送者）");
  assert.equal(anonymousText.includes(user.id), false);
  assert.equal(anonymousText.includes(user.tag), false);
  assert.match(formatComplaintSender(false, user), /123456789012345678/);
});
const {
  claimDailyCheckinReward,
} = require("../utils/dailyCheckin");

test("concurrent daily check-ins award exactly once", async () => {
  const state = {
    user_id: "123456789012345678",
    coins: 0,
    last_checkin: null,
  };
  const readUser = async () => ({ ...state });
  const compareAndSwap = async ({
    expectedCoins,
    expectedCheckin,
    nextCoins,
    nextCheckin,
  }) => {
    if (
      state.coins !== expectedCoins ||
      state.last_checkin !== expectedCheckin
    ) {
      return null;
    }

    state.coins = nextCoins;
    state.last_checkin = nextCheckin;
    return { coins: state.coins, last_checkin: state.last_checkin };
  };

  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      claimDailyCheckinReward({
        readUser,
        compareAndSwap,
        userId: state.user_id,
        date: "2026-07-26",
        reward: 10,
      }),
    ),
  );

  assert.equal(results.filter((result) => result.claimed).length, 1);
  assert.equal(results.filter((result) => !result.claimed).length, 19);
  assert.equal(state.coins, 10);
  assert.equal(state.last_checkin, "2026-07-26");
});

test("service settings support arrays, JSON, and comma-separated values", () => {
  assert.deepEqual(parseAllowedServices(["a", "b"]), ["a", "b"]);
  assert.deepEqual(parseAllowedServices('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseAllowedServices("a, b,, "), ["a", "b"]);
  assert.deepEqual(parseAllowedServices(null), []);
});

test("custom tips require customer service pricing", () => {
  assert.deepEqual(
    gifts.find((gift) => gift.key === "tip_custom"),
    {
      key: "tip_custom",
      name: "客製打賞",
      price: 0,
      description: "價格由客服填寫",
      customPrice: true,
    },
  );
});

test("crown packages keep gifted hours separate from crown duration", () => {
  assert.deepEqual(
    crownPackages.map(({ name, price, giftedHours, durationHours }) => [
      name,
      price,
      giftedHours,
      durationHours,
    ]),
    [
      ["半日冠", 1899, 6, 12],
      ["一日冠", 3999, 12, 24],
      ["三日冠", 12888, 36, 72],
      ["周冠名", 26666, 84, 168],
      ["月冠名", 188888, 336, 720],
      ["自定冠", null, null, null],
    ],
  );
  assert.equal(getCrownPackageByKey(crownPackages, "crown_week").name, "周冠名");
  assert.equal(
    buildCrownOrderItem({
      crownName: "半日冠",
      giftedHours: 6,
      durationHours: 12,
      changeSuffixes: true,
      customerSuffix: "♡小奈",
      staffSuffix: "♡闆闆",
    }),
    "冠名單｜半日冠｜贈送還單 6hrs｜冠名時長 12hrs｜雙方尾綴：闆闆「♡小奈」／陪陪「♡闆闆」",
  );
});

test("only four and five star reviews are published with privacy respected", () => {
  assert.equal(shouldPublishReview(5), true);
  assert.equal(shouldPublishReview(4), true);
  assert.equal(shouldPublishReview(3), false);
  assert.equal(shouldPublishReview(0), false);
  assert.equal(formatReviewCustomer("123456789", false), "<@123456789>");
  assert.equal(formatReviewCustomer("123456789", true), "匿名");
});

test("VIP upgrades accept cumulative spend or a single topup, never cumulative topup", () => {
  const level = {
    totalSpendRequired: 5000,
    singleTopupRequired: 3000,
  };

  assert.equal(qualifiesForVipLevel({ ...level, totalSpent: 5000 }), true);
  assert.equal(
    qualifiesForVipLevel({ ...level, highestSingleTopup: 3000 }),
    true,
  );
  assert.equal(
    qualifiesForVipLevel({ ...level, totalTopup: 999999 }),
    false,
  );
});

test("tip helpers preserve multi-staff behavior", () => {
  assert.deepEqual(getTipStaffIds({ selectedStaffIds: ["1", "2", "1", ""] }), [
    "1",
    "2",
  ]);
  assert.deepEqual(getTipStaffIds({ selectedStaffId: "1" }), ["1"]);
  assert.equal(formatTipStaffMentions(["1", "2"]), "<@1>、<@2>");
  assert.equal(getTipTotalAmount(50, ["1", "2"]), 100);
  assert.equal(getTipTotalAmount(50, []), 50);
  assert.equal(getTipGiftByKey(gifts, gifts[0].key), gifts[0]);
});

test("tip helpers calculate multi-gift and separate staff quantities", () => {
  assert.deepEqual(parseTipQuantityList("2, 3", 2), [2, 3]);
  assert.throws(() => parseTipQuantityList("2", 2), /2 個/);

  const tipData = {
    selectedStaffIds: ["1", "2"],
    gifts: [
      { key: "a", name: "禮物 A", price: 10 },
      { key: "b", name: "禮物 B", price: 20 },
    ],
    sharedQuantities: [1, 1],
    quantitiesByStaff: {
      1: [2, 1],
      2: [1, 3],
    },
  };
  assert.deepEqual(
    buildTipAllocations(tipData).map(({ staffId, item, amount }) => ({
      staffId,
      item,
      amount,
    })),
    [
      { staffId: "1", item: "禮物 A×2、禮物 B×1", amount: 40 },
      { staffId: "2", item: "禮物 A×1、禮物 B×3", amount: 70 },
    ],
  );
  assert.equal(getTipAllocationTotal(tipData), 110);
});

test("red packet shares preserve totals and stay near the average", () => {
  for (const mode of ["average", "random"]) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const shares = buildRedPacketShares(1000, 10, mode);
      assert.equal(shares.length, 10);
      assert.equal(
        shares.reduce((sum, amount) => sum + amount, 0),
        1000,
      );
      assert.ok(shares.every((amount) => amount >= 80 && amount <= 120));
    }
  }
  assert.equal(normalizeRedPacketMode("average"), "average");
  assert.equal(normalizeRedPacketMode("anything-else"), "random");
});

test("work report permissions accept cached and raw Discord roles", () => {
  const roleId = "1501271090918326362";
  const base = {
    guild: { ownerId: "owner" },
    user: { id: "user" },
    memberPermissions: { has: () => false },
  };
  assert.equal(
    isStaffInteraction(
      { ...base, member: { roles: { cache: { has: (id) => id === roleId } } } },
      roleId,
    ),
    true,
  );
  assert.equal(
    isStaffInteraction({ ...base, member: { roles: [roleId] } }, roleId),
    true,
  );
  assert.equal(
    isStaffInteraction(
      { ...base, member: { roles: ["1502010574781943989"] } },
      `${roleId},1502010574781943989`,
    ),
    true,
  );
  assert.equal(
    isStaffInteraction({ ...base, member: { roles: [] } }, roleId),
    false,
  );
});

test("order flows remain active for 24 hours", () => {
  assert.equal(ORDER_FLOW_TTL_MS, 24 * 60 * 60 * 1000);
});

test("manual gifts keep the full amount for every selected staff member", () => {
  assert.deepEqual(buildReportAmounts(1000, 3, false), [334, 333, 333]);
  assert.deepEqual(buildReportAmounts(1000, 3, true), [1000, 1000, 1000]);
});

test("manual work reports find staff consistently across Discord clients", () => {
  const records = [
    {
      staff: {
        id: 42,
        discord_id: "123456789012345678",
        display_name: "小 雨",
        discord_name: "rain.staff",
      },
      member: {
        nickname: "深夜小雨",
        displayName: "深夜小雨",
        user: { username: "rain930", globalName: "Rain" },
      },
    },
  ];
  for (const input of [
    "深夜小雨",
    "rain930",
    "RAIN.STAFF",
    "42",
    "123456789012345678",
    "<@123456789012345678>",
  ]) {
    assert.equal(matchStaffLookup(records, input).length, 1, input);
  }
  assert.equal(normalizeStaffLookup("＠Test User"), "test user");
  assert.deepEqual(splitStaffLookupInput("小雨，42\n<@123456789012345678>"), [
    "小雨",
    "42",
    "<@123456789012345678>",
  ]);
});

test("缺少填單區時會自動補建、寫回 EIP 並再送出報單", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "workReportSystem.js"),
    "utf8",
  );
  assert.match(source, /function ensureStaffReportChannel/);
  assert.match(source, /自動補建 .* 的填單區/);
  assert.match(source, /channel = await ensureStaffReportChannel\(staff\)/);
  assert.doesNotMatch(source, /尚未填寫個人填單區／薪資頻道 ID/);
});

test("work report edits parse duration and formatted money", () => {
  assert.equal(parseDurationMinutes("2小時30分鐘"), 150);
  assert.equal(parseDurationMinutes("1.5"), 90);
  assert.equal(parseDurationMinutes("90分鐘"), 90);
  assert.equal(parseMoney("NT$ 12,500"), 12500);
  assert.equal(parseMoney("0"), null);
});

test("time-only work reports use the latest Taipei occurrence", () => {
  const justAfterMidnight = new Date("2026-07-14T16:30:00.000Z");
  assert.equal(
    parseTaipeiWorkTime("22:38", justAfterMidnight).toISOString(),
    "2026-07-14T14:38:00.000Z",
  );
  assert.equal(
    parseTaipeiWorkTime("00:20", justAfterMidnight).toISOString(),
    "2026-07-14T16:20:00.000Z",
  );
});

test("first work-report start time can be corrected exactly once", () => {
  const pending = {
    segments: [],
    pendingSegmentStart: "2026-07-27T12:00:00.000Z",
  };
  assert.equal(canCorrectFirstSegmentStart(pending), true);
  assert.equal(
    canCorrectFirstSegmentStart({ ...pending, startTimeEditCount: 1 }),
    false,
  );
  assert.equal(
    canCorrectFirstSegmentStart({
      ...pending,
      segments: [{ startedAt: pending.pendingSegmentStart, minutes: 60 }],
    }),
    false,
  );
  assert.equal(canCorrectFirstSegmentStart({ segments: [] }), false);
});

test("work-report time entry is not restricted to the assigned Discord user", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "workReportSystem.js"),
    "utf8",
  );
  const start = source.indexOf(
    '(interaction.customId.startsWith("work_report_start_") ||',
  );
  const handler = source.slice(start, source.indexOf("    return false;", start));
  assert.doesNotMatch(handler, /report\.discord_id !== interaction\.user\.id/);
  assert.doesNotMatch(handler, /\.eq\("discord_id", interaction\.user\.id\)/);
  assert.match(handler, /canEnterWorkReportTime\(current, \{ isEnd: !isStart \}\)/);
});

test("work-report correction button opens its modal before any defer", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const buttonRouter = source.slice(
    source.indexOf("// ===== 一般 Button ====="),
    source.indexOf("// ===== 派單 / 陪玩狀態按鈕"),
  );
  assert.match(
    buttonRouter,
    /interaction\.customId\.startsWith\("work_report_correct_start_"\)/,
  );
});

test("all work-report modal buttons are routed before the main interaction defer", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const modalRouter = source.slice(
    source.indexOf("// Modal 類按鈕不能 defer"),
    source.indexOf("// ===== 使用者按錯建立訂單", source.indexOf("// Modal 類按鈕不能 defer")),
  );
  for (const prefix of [
    "open_manual_work_report",
    "work_report_crown_start_",
    "work_report_add_",
    "work_report_edit_",
    "work_report_correct_start_",
    "work_report_start_",
    "work_report_end_",
  ]) {
    assert.match(modalRouter, new RegExp(prefix));
  }
  const dispatchSource = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  assert.equal(
    (dispatchSource.match(/async function handleServiceDurationSelect\(/g) || []).length,
    1,
  );
});

test("work-report time buttons show their modal before any database query", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "workReportSystem.js"),
    "utf8",
  );
  const buttonStart = source.indexOf(
    'interaction.customId.startsWith("work_report_start_") ||',
  );
  const submitStart = source.indexOf(
    'interaction.customId.startsWith("submit_work_report_start_")',
    buttonStart,
  );
  const buttonBlock = source.slice(buttonStart, submitStart);
  assert.ok(buttonStart >= 0 && submitStart > buttonStart);
  assert.match(buttonBlock, /await interaction\.showModal\(modal\)/);
  assert.doesNotMatch(buttonBlock, /\.from\(salaryTable\)/);
});

test("VIP rewards normalize suffix coupons and never auto-grant gift cards", () => {
  assert.deepEqual(
    parseVipCouponReward(
      "7折券*2,陪玩前綴一週券*2,陪玩冠名7日券*2,500元禮品卡*1",
    ),
    [
      { name: "7折券", count: 2 },
      { name: "陪玩後綴一週券", count: 2 },
      { name: "陪玩後綴7日券", count: 2 },
    ],
  );
  assert.deepEqual(parseVipCouponReward("陪玩心動值禮物加成雙倍*1"), [
    { name: "心動值禮物雙倍券", count: 1 },
  ]);
  assert.equal(isCouponInventoryItem({ item_name: "心動值禮物雙倍券" }), true);
});

test("exclusive membership cards follow the member's one-time variant", () => {
  const tier = { tier_key: "exclusive", card_image_url: "fallback" };
  assert.match(
    resolveMembershipCardImage(
      { discord_user_id: "123456789012345678", exclusive_card_variant: "white" },
      tier,
    ),
    /\/api\/membership\/card\/123456789012345678$/,
  );
  assert.match(
    resolveMembershipCardImage(
      { discord_user_id: "123456789012345678", exclusive_card_variant: "black" },
      tier,
    ),
    /\/api\/membership\/card\/123456789012345678$/,
  );
  assert.equal(resolveMembershipCardImage({}, tier), null);
});

test("chat drops use an exact 0.5% threshold and validate rewards", () => {
  assert.equal(shouldCreateChatDrop(0), true);
  assert.equal(shouldCreateChatDrop(0.004999), true);
  assert.equal(shouldCreateChatDrop(0.005), false);
  assert.equal(shouldCreateChatDrop(1), false);
  assert.equal(parseChatDropReward("claim_1"), 1);
  assert.equal(parseChatDropReward("claim_20"), 20);
  assert.equal(parseChatDropReward("claim_0"), null);
  assert.equal(parseChatDropReward("claim_999"), null);
  assert.equal(parseChatDropReward("claim_red_packet_1"), null);
});

test("runtime validation reports missing variable names without values", () => {
  assert.doesNotThrow(() => validateEnvironment({ TOKEN: "set" }, ["TOKEN"]));
  assert.throws(
    () => validateEnvironment({ TOKEN: "" }, ["TOKEN", "GUILD_ID"]),
    /TOKEN, GUILD_ID/,
  );
});

test("runtime health records degraded startup without exposing messages", () => {
  const health = createHealthState("test-bot");
  health.addFailure("optional panel", new Error("private detail"));
  health.markReady();
  assert.deepEqual(health.snapshot().startupFailures[0].name, "optional panel");
  assert.equal(health.snapshot().status, "degraded");
  assert.equal(JSON.stringify(health.snapshot()).includes("private detail"), false);
});

test("runtime guards duplicate events and overlapping scheduler runs", async () => {
  const dedupe = createTtlSet(1000);
  assert.equal(dedupe.add("interaction-1"), true);
  assert.equal(dedupe.add("interaction-1"), false);
  assert.equal(dedupe.delete("interaction-1"), true);
  assert.equal(dedupe.add("interaction-1"), true);

  let release;
  let runs = 0;
  const firstRun = new Promise((resolve) => {
    release = resolve;
  });
  const task = createNonOverlappingTask("test", async () => {
    runs += 1;
    await firstRun;
  });
  const pending = task();
  await task();
  assert.equal(runs, 1);
  release();
  await pending;
});

test("runtime map expiry only removes the value it scheduled", async () => {
  const map = new Map();
  const first = { value: 1 };
  const replacement = { value: 2 };
  map.set("flow", first);
  scheduleMapExpiry(map, "flow", first, 5);
  map.set("flow", replacement);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(map.get("flow"), replacement);
});

test("command registry skips unchanged Discord definitions and syncs changes", async () => {
  const local = [{ name: "ping", description: "測試", options: [] }];
  const remote = [
    {
      id: "server-id",
      application_id: "app-id",
      version: "1",
      type: 1,
      name: "ping",
      description: "測試",
      options: [],
    },
  ];
  assert.equal(commandDefinitionsMatch(remote, local), true);
  assert.equal(
    commandDefinitionsMatch(
      [{ ...remote[0], description: "已變更" }],
      local,
    ),
    false,
  );

  const calls = [];
  const rest = {
    async get() {
      calls.push("get");
      return remote;
    },
    async put() {
      calls.push("put");
    },
  };
  const logger = { log() {}, warn() {} };
  const unchanged = await syncApplicationCommands({
    token: "test",
    applicationId: "app",
    commands: local,
    rest,
    logger,
  });
  assert.deepEqual(unchanged, { changed: false, count: 1 });
  assert.deepEqual(calls, ["get"]);
});

test("startup orchestrator limits concurrency and preserves every task result", async () => {
  let active = 0;
  let maxActive = 0;
  const completed = [];
  const tasks = Array.from({ length: 6 }, (_, index) => ({
    name: `task-${index}`,
    run: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed.push(index);
      active -= 1;
    },
  }));

  const summary = await runStartupGroup(tasks, {
    concurrency: 2,
    runner: async (name, run) => {
      await run();
      return name !== "task-5";
    },
  });

  assert.equal(maxActive, 2);
  assert.equal(completed.length, 6);
  assert.equal(summary.total, 6);
  assert.equal(summary.succeeded, 5);
  assert.equal(summary.failed, 1);
});

test("employment applications expose ten games and complete field schemas", () => {
  assert.equal(GAMES.length, 10);
  assert.equal(getApplicationFields("valorant").length, 14);
  assert.equal(getApplicationFields("delta").length, 14);
  assert.equal(getApplicationFields("naraka").length, 7);
  assert.equal(getApplicationFields("cs2").length, 13);
  assert.equal(getApplicationFields("honor_of_kings").length, 9);
  assert.equal(getApplicationFields("other").length, 9);
  assert.equal(normalizeRoleName("｜｜・遊戲審核官"), "遊戲審核官");
});

test("employment submission rejects stale or incomplete flow state before Discord send", () => {
  assert.throws(
    () =>
      buildApplicationEmbed({
        userId: "123456789012345678",
        username: "test-user",
        displayName: "測試申請人",
        track: "technical",
        answers: {},
      }),
    /缺少遊戲項目/,
  );

  assert.throws(
    () =>
      buildApplicationEmbed({
        userId: "123456789012345678",
        username: "test-user",
        displayName: "測試申請人",
        gameKey: "valorant",
        track: "technical",
        answers: {},
      }),
    /申請資料尚未填完/,
  );

  const answers = Object.fromEntries(
    getApplicationFields("valorant").map((definition) => [
      definition.key,
      definition.required ? "測試答案" : "",
    ]),
  );
  const embed = buildApplicationEmbed({
    userId: "123456789012345678",
    username: "test-user",
    displayName: "測試申請人",
    gameKey: "valorant",
    track: "technical",
    consentRules: true,
    consentConflict: true,
    answers,
  }).toJSON();
  assert.equal(embed.fields[2].name, "遊戲項目");
  assert.equal(embed.fields[2].value, "Valorant");
});

test("employment applications block only customers with paid orders in the same store", async () => {
  const filters = [];
  const supabase = {
    from(table) {
      assert.equal(table, "play_orders");
      return {
        select() { return this; },
        eq(column, value) { filters.push([column, value]); return this; },
        async limit() { return { data: [{ id: "paid-order" }], error: null }; },
      };
    },
  };

  assert.equal(await hasPaidOrderAtStore({
    supabase,
    discordUserId: "123456789012345678",
    guildId: "deepnight-guild",
  }), true);
  assert.deepEqual(filters, [
    ["guild_id", "deepnight-guild"],
    ["customer_id", "123456789012345678"],
    ["paid", true],
  ]);
});

test("paid customers receive the owner restriction when starting an application", async () => {
  const replies = [];
  const supabase = {
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        async limit() {
          return {
            data: table === "play_orders" ? [{ id: "paid-order" }] : [],
            error: null,
          };
        },
      };
    },
  };
  const system = createEmploymentSystem(
    {},
    { brandName: "深夜不關燈", organization: "deepnight" },
    supabase,
  );
  const handled = await system.handleInteraction({
    customId: "employment_start",
    guildId: "deepnight-guild",
    user: { id: "123456789012345678" },
    async deferReply(payload) { replies.push(["defer", payload]); },
    async editReply(payload) { replies.push(["edit", payload]); },
  });

  assert.equal(handled, true);
  assert.equal(replies[0][1].flags, 64);
  assert.equal(
    replies[1][1].content,
    "老闆身分不給予申請陪陪，別間店消費則不受影響",
  );
});

test("paid active companions can still start an employment assessment", async () => {
  const replies = [];
  const supabase = {
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        async limit() {
          return {
            data:
              table === "play_orders"
                ? [{ id: "paid-order" }]
                : [{ discord_id: "123456789012345678" }],
            error: null,
          };
        },
      };
    },
  };
  assert.equal(
    await hasActiveCompanionAtStore({
      supabase,
      discordUserId: "123456789012345678",
      guildId: "deepnight-guild",
      organization: "deepnight",
    }),
    true,
  );
  const system = createEmploymentSystem(
    {},
    { brandName: "深夜不關燈", organization: "deepnight" },
    supabase,
  );
  await system.handleInteraction({
    customId: "employment_start",
    guildId: "deepnight-guild",
    user: { id: "123456789012345678" },
    async deferReply(payload) { replies.push(["defer", payload]); },
    async editReply(payload) { replies.push(["edit", payload]); },
  });
  assert.match(replies[1][1].content, /是否同意陪玩共同守則/);
});

test("completed employment threads delete after 24 hours of inactivity", () => {
  const hour = 60 * 60 * 1000;
  assert.equal(getCompletedThreadDeleteDelay(0, 23 * hour), hour);
  assert.equal(getCompletedThreadDeleteDelay(0, 24 * hour), 0);
  assert.equal(getCompletedThreadDeleteDelay(10 * hour, 25 * hour), 9 * hour);
});

test("employment result notice does not reveal pass or fail", () => {
  const notice = buildEmploymentResultNotice("幽語", "123456789012345678");
  assert.equal(
    notice,
    "已發送面試結果\n" +
      "審核官：幽語（<@123456789012345678>）\n" +
      "通過面試者會額外收到入職相關資訊，若未收到面試結果請於此通知審核官。此討論串閒置 24 小時後會自動刪除。",
  );
  assert.doesNotMatch(notice, /結果：通過|結果：不通過/);
});

test("existing companions taking a new assessment only receive the result", () => {
  const passed = buildExistingCompanionResultDm("通過", "Apex");
  const rejected = buildExistingCompanionResultDm("不通過", "英雄聯盟");
  assert.equal(passed, "你申請的「Apex」加考結果：通過。");
  assert.equal(rejected, "你申請的「英雄聯盟」加考結果：不通過。");
  assert.doesNotMatch(`${passed}\n${rejected}`, /工作群|新人|簽署|入職/);
});

test("approved employment DM includes deadlines and online signing link", () => {
  const content = buildApprovedEmploymentDmContent(
    {
      brandName: "深夜不關燈",
      workGuildInvite: "https://discord.gg/example",
      newcomerChannelId: "123456789012345678",
    },
    "https://salary.example/employment-sign/test-token",
  );
  assert.match(content, /48小時內入群報到/);
  assert.match(content, /新人入職必看頻道/);
  assert.match(content, /線上入職契約/);
  assert.match(content, /salary\.example\/employment-sign\/test-token/);
  assert.match(content, /第一次登入 EIP 才會正式啟用/);
  const contract = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "assets",
      "employment",
      "陪陪承攬合作契約書_v1.1.pdf",
    ),
  );
  assert.equal(contract.subarray(0, 4).toString(), "%PDF");
  assert.ok(contract.length > 300_000);
});

test("既有員工與跨店已簽署人員不會收到重複簽署連結", () => {
  const config = {
    brandName: "深夜不關燈",
    workGuildInvite: "https://discord.gg/example",
    newcomerChannelId: "123456789012345678",
  };
  const crossStore = buildApprovedEmploymentDmContent(config, {
    required: false,
    reason: "already_signed",
  });
  const legacy = buildApprovedEmploymentDmContent(config, {
    required: false,
    reason: "legacy_staff",
  });
  assert.match(crossStore, /任一店完成入職文件簽署/);
  assert.match(legacy, /2026 年 9 月 1 日前已有公司員工資料/);
  assert.doesNotMatch(`${crossStore}\n${legacy}`, /employment-sign\//);
});

test("深夜自助下單選人可延長五分鐘或手動棄單", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "dispatchSystem.js"),
    "utf8",
  );
  assert.match(source, /NEW_ORDER_SELECTION_TIMEOUT_MS = 15 \* 60 \* 1000/);
  assert.match(source, /NEW_ORDER_SELECTION_EXTENSION_MS = 5 \* 60 \* 1000/);
  assert.match(source, /\.setLabel\("加長選人時間（\+5 分鐘）"\)/);
  assert.match(source, /\.setLabel\("棄單"\)/);
  assert.match(source, /process\.env\.PLAYER_ORDER_CHANNEL/);
  assert.match(source, /這次自助下單在選人期限內沒有完成選擇，已自動棄單/);
  assert.match(source, /只有下單者可以延長選人時間/);
  assert.match(source, /只有下單者可以棄單/);
});

test("employment PDF generation returns a valid Chinese PDF", async () => {
  const buffer = await buildEmploymentPdfBuffer({
    brandName: "深夜不關燈",
    applicantId: "123456789012345678",
    gameKey: "valorant",
    track: "technical",
    fields: [
      { name: "填寫日期", value: "2026/07/26 21:00:00" },
      { name: "填寫人", value: "測試申請人" },
      { name: "是否同意陪玩共同守則", value: "同意" },
    ],
    result: "通過",
    reviewer: "測試審核官",
    reviewedAt: "2026/07/26 21:10:00",
  });

  assert.equal(buffer.subarray(0, 4).toString(), "%PDF");
  assert.ok(buffer.length > 20_000);
});
