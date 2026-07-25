"use strict";

async function claimDailyCheckinReward({
  readUser,
  compareAndSwap,
  userId,
  date,
  reward,
  maxAttempts = 5,
}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const userData = await readUser(userId);
    if (userData.last_checkin === date) {
      return {
        claimed: false,
        balance: Number(userData.coins || 0),
      };
    }

    const storedCoins = userData.coins;
    const currentCoins = Number(storedCoins || 0);
    const data = await compareAndSwap({
      userId,
      expectedCoins: storedCoins,
      expectedCheckin: userData.last_checkin,
      nextCoins: currentCoins + reward,
      nextCheckin: date,
    });

    if (data?.last_checkin === date) {
      return {
        claimed: true,
        balance: Number(data.coins || 0),
      };
    }
  }

  throw new Error("簽到資料正在更新，請稍後再試");
}

function createSupabaseDailyCheckinClaimer({ supabase, getUser }) {
  return async function claimWithSupabase(userId, date, reward) {
    return claimDailyCheckinReward({
      readUser: getUser,
      userId,
      date,
      reward,
      compareAndSwap: async ({
        expectedCoins,
        expectedCheckin,
        nextCoins,
        nextCheckin,
      }) => {
        let update = supabase
          .from("users")
          .update({
            last_checkin: nextCheckin,
            coins: nextCoins,
          })
          .eq("user_id", userId);

        update =
          expectedCoins == null
            ? update.is("coins", null)
            : update.eq("coins", expectedCoins);
        update =
          expectedCheckin == null
            ? update.is("last_checkin", null)
            : update.eq("last_checkin", expectedCheckin);

        const { data, error } = await update
          .select("coins, last_checkin")
          .maybeSingle();

        if (error) {
          console.error("[DB] 原子簽到失敗:", error);
          throw new Error("無法完成每日簽到");
        }

        return data;
      },
    });
  };
}

module.exports = {
  claimDailyCheckinReward,
  createSupabaseDailyCheckinClaimer,
};
