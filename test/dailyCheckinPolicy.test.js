"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DAILY_CHECKIN_REWARD,
  claimDailyCheckinReward,
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
