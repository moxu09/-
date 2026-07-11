const cron = require("node-cron");

const BRAND_NAME = "深夜不關燈";
const BRAND_FOOTER = "深夜不關燈｜We Are Still Here";

// 這些表名可以用 .env 覆蓋，不設定就用預設
const STAFF_TABLE = process.env.SALARY_STAFF_TABLE || "players";

const ORDER_TABLE = process.env.SALARY_ORDER_TABLE || "play_orders";

const BONUS_TABLE = process.env.SALARY_BONUS_TABLE || "players_bonus";

const SETTINGS_TABLE = process.env.SALARY_SETTINGS_TABLE || "salary_settings";

function getTaipeiDayRange() {
  const now = new Date();

  const taipeiDateString = now.toLocaleDateString("en-CA", {
    timeZone: "Asia/Taipei",
  });

  const start = new Date(`${taipeiDateString}T00:00:00+08:00`);
  const end = new Date(`${taipeiDateString}T23:59:59.999+08:00`);

  return {
    dateText: taipeiDateString,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

function money(value) {
  return Number(value || 0).toLocaleString("zh-TW");
}

function getStaffName(staff) {
  return (
    staff.name ||
    staff.display_name ||
    staff.real_name ||
    staff.discord_name ||
    staff.discord_username ||
    staff.discord_id ||
    "未知員工"
  );
}

function getStaffDiscordId(staff) {
  return String(
    staff.discord_id || staff.player_id || staff.user_id || ""
  ).trim();
}

function getStaffReportChannelId(staff) {
  return (
    staff.salary_channel_id ||
    staff.report_channel_id ||
    staff.daily_report_channel_id ||
    null
  );
}

function getOrderStaffId(order) {
  return getOrderStaffIds(order)[0] || "";
}

function getOrderStaffIds(order) {
  const ids = [];
  const assignedPlayer = order.assigned_player;

  if (Array.isArray(assignedPlayer)) {
    ids.push(...assignedPlayer);
  } else if (assignedPlayer) {
    ids.push(...String(assignedPlayer).split(","));
  }

  ids.push(order.player_id, order.discord_id, order.staff_id);

  return [
    ...new Set(
      ids
        .map((id) =>
          String(id || "")
            .replace(/[<@!>]/g, "")
            .trim()
        )
        .filter(Boolean)
    ),
  ];
}

function getOrderStaffName(order) {
  return (
    order.staff_name ||
    order.player_name ||
    order.discord_name ||
    order.player_id ||
    order.discord_id ||
    "未知員工"
  );
}

function getOrderServiceName(order) {
  return (
    order.service || order.service_name || order.order_item || "未命名服務"
  );
}

function getOrderAmount(order) {
  return Number(
    order.total_amount ||
      order.order_amount ||
      order.final_price ||
      order.price ||
      0
  );
}

function getStaffSalary(order) {
  return Number(order.salary_amount || order.staff_salary || 0);
}

function getOrderBonus(order) {
  return Number(order.bonus_amount || 0);
}

function getOrderTimeColumn() {
  return process.env.SALARY_ORDER_TIME_COLUMN || "order_finished_at";
}

function getDeepNightGuildId() {
  return (
    process.env.SALARY_GUILD_ID ||
    process.env.STAFF_GUILD_ID ||
    process.env.GUILD_ID ||
    "1501098191813214312"
  );
}

function buildPersonalReport({ dateText, staff, orders, extraBonuses }) {
  const staffName = getStaffName(staff);

  const totalOrderAmount = orders.reduce(
    (sum, order) => sum + getOrderAmount(order),
    0
  );

  const totalSalary = orders.reduce(
    (sum, order) => sum + getStaffSalary(order),
    0
  );

  const orderBonus = orders.reduce(
    (sum, order) => sum + getOrderBonus(order),
    0
  );

  const extraBonusTotal = extraBonuses.reduce(
    (sum, bonus) => sum + Number(bonus.amount || 0),
    0
  );

  const totalBonus = orderBonus + extraBonusTotal;
  const finalTotal = totalSalary + totalBonus;

  const orderLines =
    orders.length === 0
      ? "今日沒有訂單"
      : orders
          .slice(0, 15)
          .map((order, index) => {
            const bonusText =
              getOrderBonus(order) > 0
                ? `｜獎金 $${money(getOrderBonus(order))}`
                : "";

            return `${index + 1}. ${getOrderServiceName(order)}｜訂單 $${money(
              getOrderAmount(order)
            )}｜薪資 $${money(getStaffSalary(order))}${bonusText}`;
          })
          .join("\n");

  const bonusLines =
    extraBonuses.length === 0
      ? ""
      : "\n\n額外獎金：\n" +
        extraBonuses
          .slice(0, 10)
          .map((bonus, index) => {
            return `${index + 1}. ${bonus.title || "額外獎金"}｜$${money(
              bonus.amount
            )}${bonus.note ? `｜${bonus.note}` : ""}`;
          })
          .join("\n");

  return {
    content:
      `${BRAND_NAME}｜個人每日薪資報告\n\n` +
      `日期：${dateText}\n` +
      `員工：${staffName}\n\n` +
      `今日訂單：${orders.length} 筆\n` +
      `今日訂單總額：$${money(totalOrderAmount)}\n` +
      `今日接單薪資：$${money(totalSalary)}\n` +
      `今日獎金：$${money(totalBonus)}\n` +
      `今日合計：$${money(finalTotal)}\n\n` +
      `訂單明細：\n${orderLines}` +
      bonusLines +
      `\n\n${BRAND_FOOTER}`,
    summary: {
      staffName,
      orderCount: orders.length,
      totalOrderAmount,
      totalSalary,
      totalBonus,
      finalTotal,
    },
  };
}

function buildAdminReport({ dateText, orders, extraBonuses }) {
  const totalIncome = orders.reduce(
    (sum, order) => sum + getOrderAmount(order),
    0
  );

  const totalSalary = orders.reduce(
    (sum, order) => sum + getStaffSalary(order),
    0
  );

  const orderBonus = orders.reduce(
    (sum, order) => sum + getOrderBonus(order),
    0
  );

  const extraBonusTotal = extraBonuses.reduce(
    (sum, bonus) => sum + Number(bonus.amount || 0),
    0
  );

  const totalBonus = orderBonus + extraBonusTotal;
  const totalExpense = totalSalary + totalBonus;
  const profit = totalIncome - totalExpense;

  const staffMap = new Map();

  for (const order of orders) {
    const key = getOrderStaffId(order);

    if (!key) continue;

    const old = staffMap.get(key) || {
      name: getOrderStaffName(order),
      orderCount: 0,
      income: 0,
      salary: 0,
      bonus: 0,
    };

    old.orderCount += 1;
    old.income += getOrderAmount(order);
    old.salary += getStaffSalary(order);
    old.bonus += getOrderBonus(order);

    staffMap.set(key, old);
  }

  for (const bonus of extraBonuses) {
    const key = String(
      bonus.discord_id || bonus.player_id || bonus.staff_id || ""
    ).trim();

    if (!key) continue;

    const old = staffMap.get(key) || {
      name:
        bonus.staff_name ||
        bonus.player_name ||
        bonus.discord_id ||
        bonus.player_id ||
        "未知員工",
      orderCount: 0,
      income: 0,
      salary: 0,
      bonus: 0,
    };

    old.bonus += Number(bonus.amount || 0);
    staffMap.set(key, old);
  }

  const staffLines =
    staffMap.size === 0
      ? "今日沒有員工薪資資料"
      : Array.from(staffMap.values())
          .sort((a, b) => b.salary + b.bonus - (a.salary + a.bonus))
          .map((item) => {
            return `${item.name}｜${item.orderCount} 單｜薪資 $${money(
              item.salary
            )}｜獎金 $${money(item.bonus)}｜合計 $${money(
              item.salary + item.bonus
            )}`;
          })
          .join("\n");

  return (
    `${BRAND_NAME}｜每日總報告\n\n` +
    `日期：${dateText}\n\n` +
    `今日訂單：${orders.length} 筆\n` +
    `今日總收入：$${money(totalIncome)}\n` +
    `今日總支出：$${money(totalExpense)}\n` +
    `今日預估利潤：$${money(profit)}\n` +
    `今日薪資：$${money(totalSalary)}\n` +
    `今日獎金：$${money(totalBonus)}\n\n` +
    `員工統計：\n${staffLines}\n\n` +
    `${BRAND_FOOTER}`
  );
}

async function safeSendToChannel(client, channelId, content) {
  if (!channelId) return false;

  try {
    const channel = await client.channels.fetch(channelId);

    if (!channel || !channel.isTextBased()) {
      console.warn(
        `[DEEP_NIGHT_REPORT] 頻道不可用或不是文字頻道：${channelId}`
      );
      return false;
    }

    const chunks = splitMessage(content, 1900);

    for (const chunk of chunks) {
      await channel.send(chunk);
    }

    return true;
  } catch (error) {
    console.error(`[DEEP_NIGHT_REPORT] 發送頻道失敗：${channelId}`, error);
    return false;
  }
}

function splitMessage(text, maxLength = 1900) {
  if (text.length <= maxLength) return [text];

  const lines = text.split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    if ((current + "\n" + line).length > maxLength) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }

  if (current) chunks.push(current);

  return chunks;
}

async function readStaffList(supabase) {
  const { data, error } = await supabase.from(STAFF_TABLE).select("*");

  if (error) {
    console.error(`[DEEP_NIGHT_REPORT] 讀取 ${STAFF_TABLE} 失敗`, error);
    return [];
  }

  return (data || []).filter((staff) => {
    const discordId = getStaffDiscordId(staff);
    if (!discordId) return false;

    if (typeof staff.is_active === "boolean") {
      return staff.is_active;
    }

    if (typeof staff.active === "boolean") {
      return staff.active;
    }

    return true;
  });
}

async function readTodaySalaryOrders(supabase, startIso, endIso) {
  const guildId = getDeepNightGuildId();
  const timeColumns = [
    getOrderTimeColumn(),
    "order_finished_at",
    "completed_at",
    "accepted_at",
    "created_at",
  ].filter((column, index, list) => column && list.indexOf(column) === index);
  const orderMap = new Map();

  for (const timeColumn of timeColumns) {
    let query = supabase
      .from(ORDER_TABLE)
      .select("*")
      .gte(timeColumn, startIso)
      .lte(timeColumn, endIso)
      .order(timeColumn, { ascending: true });

    if (guildId && ORDER_TABLE === "play_orders") {
      query = query.or(`guild_id.eq.${guildId},guild_id.is.null`);
    }

    const { data, error } = await query;

    if (error) {
      console.error(
        `[DEEP_NIGHT_REPORT] 讀取 ${ORDER_TABLE}.${timeColumn} 失敗`,
        error
      );
      continue;
    }

    for (const order of data || []) {
      const status = String(order.status || "").trim();

      if (order.is_deleted) continue;
      if (["cancelled", "canceled", "已取消", "取消"].includes(status))
        continue;

      orderMap.set(String(order.id), order);
    }
  }

  return Array.from(orderMap.values());
}

async function readTodayBonuses(supabase, startIso, endIso) {
  const bonusTimeColumn = process.env.SALARY_BONUS_TIME_COLUMN || "created_at";

  const { data, error } = await supabase
    .from(BONUS_TABLE)
    .select("*")
    .gte(bonusTimeColumn, startIso)
    .lte(bonusTimeColumn, endIso)
    .order(bonusTimeColumn, { ascending: true });

  if (error) {
    console.warn(
      `[DEEP_NIGHT_REPORT] 讀取 ${BONUS_TABLE} 失敗，若你沒有額外獎金表可忽略`,
      error.message || error
    );
    return [];
  }

  return data || [];
}

async function readAdminReportChannelId(supabase) {
  if (process.env.SALARY_REPORT_CHANNEL_ID) {
    return process.env.SALARY_REPORT_CHANNEL_ID;
  }

  if (process.env.REPORT_CHANNEL_ID) {
    return process.env.REPORT_CHANNEL_ID;
  }

  const { data, error } = await supabase
    .from(SETTINGS_TABLE)
    .select("*")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn(
      `[DEEP_NIGHT_REPORT] 讀取 ${SETTINGS_TABLE} 失敗，若你改用 SALARY_REPORT_CHANNEL_ID 可忽略`,
      error.message || error
    );
    return null;
  }

  return (
    data?.report_channel_id ||
    data?.salary_report_channel_id ||
    data?.daily_report_channel_id ||
    null
  );
}

async function sendDeepNightDailySalaryReports(client, supabase) {
  const { dateText, startIso, endIso } = getTaipeiDayRange();

  console.log(
    `[DEEP_NIGHT_REPORT] 開始發送${BRAND_NAME}每日薪資報告：${dateText}`
  );

  const staffs = await readStaffList(supabase);

  const staffDiscordIds = new Set(
    staffs.map((staff) => getStaffDiscordId(staff)).filter(Boolean)
  );

  const todayOrders = await readTodaySalaryOrders(supabase, startIso, endIso);

  const todayBonuses = await readTodayBonuses(supabase, startIso, endIso);

  const orders = (todayOrders || []).filter((order) =>
    getOrderStaffIds(order).some((staffId) => staffDiscordIds.has(staffId))
  );

  const bonuses = (todayBonuses || []).filter((bonus) => {
    const bonusStaffId = String(
      bonus.discord_id || bonus.player_id || bonus.staff_id || ""
    ).trim();

    return staffDiscordIds.has(bonusStaffId);
  });

  let successCount = 0;
  let failCount = 0;

  for (const staff of staffs) {
    const staffId = getStaffDiscordId(staff);

    const personalOrders = orders.filter((order) =>
      getOrderStaffIds(order).includes(staffId)
    );

    const personalBonuses = bonuses.filter((bonus) => {
      const bonusStaffId = String(
        bonus.discord_id || bonus.player_id || bonus.staff_id || ""
      ).trim();

      return bonusStaffId === staffId;
    });

    if (personalOrders.length === 0) {
      continue;
    }

    const report = buildPersonalReport({
      dateText,
      staff,
      orders: personalOrders,
      extraBonuses: personalBonuses,
    });

    const personalReportChannelId = getStaffReportChannelId(staff);
    if (!personalReportChannelId) {
      continue;
    }

    const ok = await safeSendToChannel(
      client,
      personalReportChannelId,
      report.content
    );

    if (ok) successCount += 1;
    else failCount += 1;
  }

  const reportChannelId = await readAdminReportChannelId(supabase);

  if (reportChannelId) {
    const adminReport = buildAdminReport({
      dateText,
      orders,
      extraBonuses: bonuses,
    });

    await safeSendToChannel(client, reportChannelId, adminReport);
  } else {
    console.warn(
      "[DEEP_NIGHT_REPORT] 沒有設定管理總報表頻道，請設定 SALARY_REPORT_CHANNEL_ID"
    );
  }

  console.log(
    `[DEEP_NIGHT_REPORT] 發送完成，成功 ${successCount}，失敗 ${failCount}`
  );
}

function startDeepNightSalaryReportCron(client, supabase) {
  const timezone =
    process.env.SALARY_TIMEZONE ||
    process.env.DEEP_NIGHT_TIMEZONE ||
    "Asia/Taipei";

  cron.schedule(
    "59 23 * * *",
    async () => {
      try {
        await sendDeepNightDailySalaryReports(client, supabase);
      } catch (error) {
        console.error("[DEEP_NIGHT_REPORT] 排程執行失敗", error);
      }
    },
    {
      timezone,
    }
  );

  console.log(
    `[DEEP_NIGHT_REPORT] 已啟動每日 23:59 ${BRAND_NAME}薪資報告排程｜${timezone}`
  );
}

module.exports = {
  startDeepNightSalaryReportCron,
  sendDeepNightDailySalaryReports,
};
