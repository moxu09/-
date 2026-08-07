const { createNonOverlappingTask } = require("./runtime");

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

function getTaipeiScheduleParts(now = new Date()) {
  const taipeiNow = new Date(now.getTime() + TAIPEI_OFFSET_MS);
  return {
    date: taipeiNow.toISOString().slice(0, 10),
    hour: taipeiNow.getUTCHours(),
    minute: taipeiNow.getUTCMinutes(),
  };
}

async function runDailySelfCheck({
  client,
  supabase,
  guildId,
  healthState,
  repairTasks = [],
}) {
  const failures = [];
  if (!client.isReady()) failures.push(new Error("Discord 尚未連線完成"));

  const guild = await client.guilds.fetch(guildId).catch((error) => {
    failures.push(new Error(`Discord 伺服器讀取失敗：${error.message}`));
    return null;
  });
  if (!guild) failures.push(new Error("找不到設定的 Discord 伺服器"));

  const { error: databaseError } = await supabase
    .from("play_orders")
    .select("id")
    .limit(1);
  if (databaseError) {
    failures.push(new Error(`Supabase 連線失敗：${databaseError.message}`));
  }

  let repaired = 0;
  for (const task of repairTasks) {
    try {
      await task.run();
      repaired += 1;
    } catch (error) {
      failures.push(new Error(`${task.name} 修復失敗：${error.message}`));
    }
  }

  for (const error of failures) healthState.addFailure("每日自動偵錯", error);
  if (failures.length) throw new AggregateError(failures, "每日自動偵錯失敗");

  console.log(`[每日自動偵錯] 健康檢查通過，已同步 ${repaired} 個必要面板`);
  return { repaired, failureCount: 0 };
}

function startDailySelfCheckScheduler(options) {
  let lastRunDate = null;
  const runCheck = createNonOverlappingTask("每日自動偵錯", async () => {
    const { date, hour, minute } = getTaipeiScheduleParts();
    if (hour !== 4 || minute !== 10 || lastRunDate === date) return;
    lastRunDate = date;
    await runDailySelfCheck(options);
  });
  const timer = setInterval(runCheck, 60 * 1000);
  timer.unref?.();
  return timer;
}

module.exports = {
  getTaipeiScheduleParts,
  runDailySelfCheck,
  startDailySelfCheckScheduler,
};
