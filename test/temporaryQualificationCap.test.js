const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { applyTemporaryLegacyVipCredit, END_AT } = require("../utils/temporaryQualificationCap");
const { createAllianceMembership } = require("../utils/allianceMembership");

test("10/10 台灣零時準時解除，其他品牌、退款及零金額不受限制", async () => {
  const calls = [];
  const db = { rpc: async (name, args) => { calls.push([name,args]); return { data: { applied: true }, error: null }; } };
  const input = { userId: "u", guildId: "1206138511535898654", triggerType: "spend", amount: 15000 };
  assert.equal(await applyTemporaryLegacyVipCredit(db, { ...input, now: END_AT-1 }), true);
  assert.equal(calls[0][1].p_amount, 15000); // Real payment amount is never clipped in JS.
  assert.equal(await applyTemporaryLegacyVipCredit(db, { ...input, now: END_AT }), false);
  assert.equal(await applyTemporaryLegacyVipCredit(db, { ...input, now: END_AT-1, guildId: "another-brand" }), false);
  assert.equal(await applyTemporaryLegacyVipCredit(db, { ...input, now: END_AT-1, amount: -500 }), false);
  assert.equal(await applyTemporaryLegacyVipCredit(db, { ...input, now: END_AT-1, amount: 0 }), false);
  assert.equal(calls.length, 1);
});
test("上限服務失敗不得靜默改用不受限制累積", async () => {
  await assert.rejects(applyTemporaryLegacyVipCredit({
    rpc: async () => ({ data: null, error: { message: "db failed" } }),
  }, { userId: "u", guildId: "1501098191813214312", triggerType: "topup", amount: 15000,
    now: Date.parse("2026-10-05T12:00:00+08:00") }), /每日累積上限套用失敗/);
});
test("手動調整顯示實際計入數字，不把被排除超額寫回 VIP", async () => {
  const db = {
    from(table) {
      return {
        select() { return this; }, eq() { return this; },
        maybeSingle: async () => ({ data: { qualifying_spend: 8000 }, error: null }),
        order: async () => ({ data: [], error: null }),
      };
    },
    rpc: async () => ({ data: { qualifying_spend: 10000 }, error: null }),
  };
  const result = await createAllianceMembership(db, "1206138511535898654").adjustCumulative({
    discordUserId: "u", activityType: "spend", mode: "add", amount: 5000, sourceKey: "adjust",
  });
  assert.deepEqual(result, { oldTotal: 8000, newTotal: 10000 });
});
test("資料庫日額度分離、鎖定、去重與自動失效，沒有碰實際錢包", () => {
  const sql = fs.readFileSync(require.resolve("../supabase/migrations/20261004000000_temporary_qualification_daily_caps.sql"), "utf8");
  assert.ok(sql.includes("2026-10-10 00:00:00+08"));
  assert.ok(sql.includes("now() >= policy.ends_at"));
  assert.ok(sql.includes("primary key(scope, user_id, activity_type, local_date)"));
  assert.ok(sql.includes("for update;"));
  assert.ok(sql.includes("allowed_amount := least(p_amount, greatest(0, policy.daily_limit-used_amount))"));
  assert.ok(sql.includes("op.original_amount <> p_amount"));
  assert.ok(!/update public\.(?:users|wallets|salary_wallet_entries)/.test(sql));
});
