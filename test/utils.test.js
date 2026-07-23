const assert = require("node:assert/strict");
const test = require("node:test");

const gifts = require("../config/tipGifts");
const { parseAllowedServices } = require("../utils/services");
const {
  formatTipStaffMentions,
  getTipGiftByKey,
  getTipStaffIds,
  getTipTotalAmount,
} = require("../utils/tips");
const {
  buildRedPacketShares,
  normalizeRedPacketMode,
} = require("../utils/redPackets");
const {
  buildReportAmounts,
  isStaffInteraction,
  matchStaffLookup,
  normalizeStaffLookup,
  parseTaipeiWorkTime,
  parseDurationMinutes,
  parseMoney,
  splitStaffLookupInput,
} = require("../events/workReportSystem");
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
const {
  commandDefinitionsMatch,
  syncApplicationCommands,
} = require("../runtime/commandRegistry");
const { runStartupGroup } = require("../runtime/startupOrchestrator");

test("service settings support arrays, JSON, and comma-separated values", () => {
  assert.deepEqual(parseAllowedServices(["a", "b"]), ["a", "b"]);
  assert.deepEqual(parseAllowedServices('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseAllowedServices("a, b,, "), ["a", "b"]);
  assert.deepEqual(parseAllowedServices(null), []);
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
