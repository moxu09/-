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
