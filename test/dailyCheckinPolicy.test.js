"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DAILY_CHECKIN_REWARD,
  claimDailyCheckinReward,
  createSupabaseDailyCheckinClaimer,
} = require("../utils/dailyCheckin");

test("秋奈與深夜每日簽到共用一次且固定獎勵 5 星雨幣", async () => {
  assert.equal(DAILY_CHECKIN_REWARD, 5);
  const state = { coins: 0, last_checkin: null };
  const claim = () => claimDailyCheckinReward({
    readUser: async () => ({ ...state }),
    compareAndSwap: async ({ expectedCoins, expectedCheckin, nextCoins, nextCheckin }) => {
      if (state.coins !== expectedCoins || state.last_checkin !== expectedCheckin) return null;
      state.coins = nextCoins;
      state.last_checkin = nextCheckin;
      return { ...state };
    },
    userId: "123456789012345678",
    date: "2026-09-13",
    reward: DAILY_CHECKIN_REWARD,
  });

  const results = await Promise.all([claim(), claim()]);
  assert.equal(results.filter((result) => result.claimed).length, 1);
  assert.equal(state.coins, 5);

  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(source, /const reward = DAILY_CHECKIN_REWARD/);
  assert.match(source, /兩間店共用每日簽到次數，一天只能簽到一次/);
});

test("linked account denial returns normally without retrying or awarding", async () => {
  let attempts = 0;
  const claim = createSupabaseDailyCheckinClaimer({
    getUser: async () => ({ coins: 23, last_checkin: null }),
    supabase: {
      from: () => ({
        update() { attempts += 1; return this; },
        eq() { return this; },
        is() { return this; },
        select() { return this; },
        maybeSingle: async () => ({ error: { code: "PDC01" } }),
      }),
    },
  });
  assert.deepEqual(await claim("123456789012345678", "2026-11-03", DAILY_CHECKIN_REWARD), {
    claimed: false, reason: "linked_account", balance: 23,
  });
  assert.equal(attempts, 1);
});
