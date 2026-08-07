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

test("tips cannot target the tipper", () => {
  assert.equal(hasSelfTip("100", ["200", "100"]), true);
  assert.equal(hasSelfTip("100", ["200", "300"]), false);
  assert.equal(hasSelfTip("", ["200"]), false);
});
const {
  buildRedPacketShares,
  normalizeRedPacketMode,
} = require("../utils/redPackets");
const {
  buildReportAmounts,
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
  EMPLOYMENT_CONTRACT_RETURN_NOTE,
  GAMES,
  buildApprovedEmploymentDmContent,
  buildEmploymentPdfBuffer,
  getApplicationFields,
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

test("approved employment DM includes deadlines and bundled contract", () => {
  const content = buildApprovedEmploymentDmContent({
    brandName: "深夜不關燈",
    workGuildInvite: "https://discord.gg/example",
    newcomerChannelId: "123456789012345678",
  });
  assert.match(content, /48小時內入群報到/);
  assert.match(content, /新人入職必看頻道/);
  assert.equal(
    EMPLOYMENT_CONTRACT_RETURN_NOTE,
    "備註：請填寫並簽署後於入群後三天內發送到個人填單區以完成入職手續（無論電子簽署或紙本簽署掃描上傳皆可）",
  );
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
