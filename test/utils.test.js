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
} = require("../events/workReportSystem");
const { ORDER_FLOW_TTL_MS } = require("../utils/orderFlow");
const {
  isCouponInventoryItem,
  parseVipCouponReward,
} = require("../utils/vipRewards");

test("service settings support arrays, JSON, and comma-separated values", () => {
  assert.deepEqual(parseAllowedServices(["a", "b"]), ["a", "b"]);
  assert.deepEqual(parseAllowedServices('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseAllowedServices("a, b,, "), ["a", "b"]);
  assert.deepEqual(parseAllowedServices(null), []);
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
        1000
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
  assert.equal(
    isCouponInventoryItem({ item_name: "心動值禮物雙倍券" }),
    true,
  );
});
