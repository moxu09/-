const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  UserSelectMenuBuilder,
  ChannelType,
} = require("discord.js");
const { getOrderCommissionBase } = require("../utils/salaryCommission");
const { ORDER_FLOW_TTL_MS } = require("../utils/orderFlow");

function parseUserIds(value) {
  return [...new Set(String(value || "").match(/\d{17,20}/g) || [])];
}

function parseChannelId(value) {
  return String(value || "").match(/\d{17,20}(?!.*\d)/)?.[0] || null;
}

function parseRoleIds(...values) {
  return [
    ...new Set(
      values.flatMap((value) => String(value || "").match(/\d{17,20}/g) || []),
    ),
  ];
}

function staffBelongsToGuild(staff, guildId) {
  if (!staff || !guildId) return true;
  if (staff.guild_id == null) return true;
  return String(staff.guild_id)
    .split(",")
    .map((value) => value.trim())
    .includes(String(guildId));
}

function normalizeStaffLookup(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/^@/, "")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("zh-TW");
}

function reportChannelToken(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-TW")
    .replace(/^填單專區[-_－—\s]*/u, "")
    .replace(/^𝓐𝓢[.．\s]*/u, "")
    .split(/[|｜]/u)
    .at(-1)
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function getStaffReportChannelName(staff) {
  const raw =
    staff?.display_name ||
    staff?.discord_name ||
    staff?.real_name ||
    staff?.name ||
    staff?.discord_id;
  const shortName = String(raw || "陪陪")
    .replace(/^𝓐𝓢[.．\s]*/u, "")
    .split(/[|｜]/u)
    .at(-1)
    .trim();
  return `填單專區-${shortName || staff?.discord_id || "陪陪"}`.slice(0, 100);
}

function splitStaffLookupInput(value) {
  return String(value || "")
    .split(/[\n,，、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getStaffLookupValues(staff, member) {
  return [
    staff?.id,
    staff?.discord_id,
    staff?.display_name,
    staff?.real_name,
    staff?.discord_name,
    staff?.name,
    member?.nickname,
    member?.displayName,
    member?.user?.globalName,
    member?.user?.username,
    member?.user?.tag,
  ]
    .map(normalizeStaffLookup)
    .filter(Boolean);
}

function matchStaffLookup(records, input) {
  const raw = String(input || "").trim();
  const discordId = parseUserIds(raw)[0];
  const keyword = normalizeStaffLookup(raw);
  const exactMatches = records.filter(({ staff, member }) => {
    if (discordId && String(staff?.discord_id || "") === discordId) return true;
    return getStaffLookupValues(staff, member).includes(keyword);
  });
  if (exactMatches.length) return exactMatches;
  if (keyword.length < 2) return [];
  return records.filter(({ staff, member }) =>
    getStaffLookupValues(staff, member).some((value) => value.includes(keyword)),
  );
}

function memberHasRole(member, roleId) {
  if (!member || !roleId) return false;
  if (member.roles?.cache?.has) return member.roles.cache.has(roleId);
  if (Array.isArray(member.roles)) return member.roles.includes(roleId);
  return false;
}

function isStaffInteraction(interaction, ...configuredRoleIds) {
  const roleIds = parseRoleIds(
    ...configuredRoleIds,
    process.env.STAFF_ROLE,
    process.env.STAFF_ROLE_ID,
    process.env.STAFF_ROLE_IDS,
    process.env.CUSTOMER_SERVICE_ROLE_ID,
    process.env.CUSTOMER_SERVICE_ROLE_IDS,
  );
  return (
    interaction.guild?.ownerId === interaction.user.id ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
    roleIds.some((roleId) => memberHasRole(interaction.member, roleId))
  );
}

function parseTaipeiDateTime(value) {
  const text = String(value || "")
    .trim()
    .replace(/\//g, "-");
  const matched = text.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/,
  );
  if (!matched) return null;
  const [, year, month, day, hour, minute] = matched;
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:00+08:00`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getTaipeiNowParts(nowDate = new Date()) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(nowDate)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function parseTaipeiWorkTime(value, nowDate = new Date()) {
  const text = String(value || "").trim();
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}$/.test(text)) {
    return parseTaipeiDateTime(text);
  }
  const matched = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!matched) return null;
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (hour > 23 || minute > 59) return null;
  const now = getTaipeiNowParts(nowDate);
  const parsed = parseTaipeiDateTime(
    `${now.year}-${now.month}-${now.day} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  );
  if (parsed && parsed.getTime() > nowDate.getTime() + 5 * 60 * 1000) {
    parsed.setUTCDate(parsed.getUTCDate() - 1);
  }
  return parsed;
}

function isGiftOrderType(value) {
  return /打賞|禮物|礼物|gift|tip/i.test(String(value || ""));
}

function parseCrownDurationHours(value) {
  const match = String(value || "").match(/冠名時長\s*(\d+)\s*hrs/i);
  const hours = Number(match?.[1] || 0);
  return Number.isSafeInteger(hours) && hours > 0 ? hours : null;
}

function calculateCrownEndAt(startAt, durationHours) {
  const start = new Date(startAt);
  const hours = Number(durationHours);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isSafeInteger(hours) ||
    hours <= 0
  ) {
    return null;
  }
  return new Date(start.getTime() + hours * 60 * 60 * 1000);
}

function buildReportAmounts(totalAmount, staffCount, isGift) {
  const count = Math.max(1, Number(staffCount || 0));
  const total = Number(totalAmount || 0);
  if (isGift) return Array(count).fill(total);
  const baseAmount = Math.floor(total / count);
  const remainder = Math.round(total - baseAmount * count);
  return Array.from(
    { length: count },
    (_, index) => baseAmount + (index < remainder ? 1 : 0),
  );
}

function formatTaipeiDateTime(value) {
  if (!value) return "尚未填寫";
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatTaipeiWorkTimeInput(value) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(value))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function canCorrectFirstSegmentStart(meta) {
  const segments = Array.isArray(meta?.segments) ? meta.segments : [];
  return (
    segments.length === 0 &&
    Boolean(meta?.pendingSegmentStart) &&
    Number(meta?.startTimeEditCount || 0) < 1
  );
}

const EDITABLE_WORK_REPORT_STATUSES = ["work_draft", "工時待填"];
const PENDING_REVIEW_WORK_REPORT_STATUSES = ["work_pending", "工時待審核"];

function parseWorkReportMeta(report) {
  try {
    return JSON.parse(report?.note || report?.admin_note || "{}");
  } catch {
    return {};
  }
}

function canEnterWorkReportTime(report, { isEnd = false } = {}) {
  if (!report) return false;
  if (EDITABLE_WORK_REPORT_STATUSES.includes(report.status)) return true;
  return Boolean(
    isEnd &&
      PENDING_REVIEW_WORK_REPORT_STATUSES.includes(report.status) &&
      parseWorkReportMeta(report).pendingSegmentStart,
  );
}

function buildSavedWorkReportSupplement(meta, startedAt, endedAt, now = Date.now()) {
  const start = startedAt?.getTime?.();
  const end = endedAt?.getTime?.();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error("補單結束時間必須晚於開始時間");
  }
  if (end > now + 5 * 60 * 1000) {
    throw new Error("補單結束時間不能晚於現在");
  }
  const segments = Array.isArray(meta?.segments) ? meta.segments : [];
  const latestEnd = Math.max(0, ...segments.map((segment) => Date.parse(segment.endedAt || "") || 0));
  if (latestEnd && start < latestEnd) {
    throw new Error("補單時間不能與先前的報時重疊");
  }
  const expectedMinutes = Number(meta?.expectedDurationMinutes || 0);
  if (!Number.isFinite(expectedMinutes) || expectedMinutes <= 0) {
    throw new Error("這筆存單沒有預定時長，請客服確認後再補單");
  }
  const nextSegments = [...segments, {
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    minutes: Math.round((end - start) / 60000),
  }];
  const totalMinutes = nextSegments.reduce((sum, segment) => sum + Number(segment.minutes || 0), 0);
  const isComplete = totalMinutes >= expectedMinutes;
  return {
    isComplete,
    totalMinutes,
    shortageMinutes: Math.max(0, expectedMinutes - totalMinutes),
    meta: {
      ...meta,
      segments: nextSegments,
      startedAt: nextSegments[0].startedAt,
      endedAt: endedAt.toISOString(),
      durationMinutes: totalMinutes,
      shortageMinutes: Math.max(0, expectedMinutes - totalMinutes),
      pendingSegmentStart: null,
      closedEarly: false,
    },
  };
}

function parseDurationMinutes(value) {
  const text = String(value || "")
    .trim()
    .toLowerCase();
  if (!text) return null;
  const hours = text.match(/([\d.]+)\s*(?:小時|小时|hr|hrs|h)/);
  const minutes = text.match(/([\d.]+)\s*(?:分鐘|分钟|min|mins|m)/);
  if (hours || minutes) {
    return Math.round(Number(hours?.[1] || 0) * 60 + Number(minutes?.[1] || 0));
  }
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric <= 24 ? numeric * 60 : numeric);
}

function durationText(minutes) {
  return `${Math.floor(Number(minutes || 0) / 60)} 小時 ${Number(minutes || 0) % 60} 分鐘`;
}

function parseMoney(value) {
  const amount = Number(String(value || "").replace(/[,，$NT\s]/gi, ""));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function buildUpdatedReportEmbed(message, meta) {
  const embed = EmbedBuilder.from(message.embeds[0]);
  const segments = meta.segments || [];
  const totalMinutes = segments.reduce(
    (sum, segment) => sum + Number(segment.minutes || 0),
    0,
  );
  const expectedMinutes = Number(meta.expectedDurationMinutes || 0);
  const segmentLines = segments.map(
    (segment, index) =>
      `第 ${index + 1} 段｜${formatTaipeiDateTime(segment.startedAt)} ～ ${formatTaipeiDateTime(segment.endedAt)}｜${durationText(segment.minutes)}`,
  );
  if (meta.pendingSegmentStart) {
    segmentLines.push(
      `第 ${segments.length + 1} 段｜${formatTaipeiDateTime(meta.pendingSegmentStart)} ～ 尚未結束`,
    );
  }
  const timeFields = [
    {
      name: "預定時長",
      value: expectedMinutes ? durationText(expectedMinutes) : "未設定",
      inline: true,
    },
    {
      name: "累積時長",
      value: durationText(totalMinutes),
      inline: true,
    },
    {
      name: "報時紀錄",
      value: segmentLines.join("\n") || "尚未輸入",
      inline: false,
    },
  ];
  if (expectedMinutes > totalMinutes) {
    timeFields.push({
      name: "不足時長",
      value: durationText(expectedMinutes - totalMinutes),
      inline: true,
    });
  }
  const baseFields = (embed.data.fields || [])
    .filter(
      (field) =>
        !["預定時長", "累積時長", "報時紀錄", "不足時長"].includes(field.name),
    )
    .map((field) =>
      field.name === "金額" && Number(meta.orderAmount) > 0
        ? {
            ...field,
            value: `NT$${Number(meta.orderAmount).toLocaleString("zh-TW")}`,
          }
        : field,
    );
  return embed.setFields(...baseFields, ...timeFields);
}

function createWorkReportSystem({
  supabase,
  client,
  appKey,
  guildId,
  reportGuildId,
  manualChannelId,
  staffTable,
  staffRoleId,
  customerServiceRoleId,
  salaryTable,
}) {
  const pendingManualReports = new Map();
  const reportChannelProvisionByStaffId = new Map();
  let crownReminderTimer = null;

  async function provisionStaffReportChannel(staff) {
    const staffId = String(staff?.discord_id || "").trim();
    if (!staffId) throw new Error("員工資料缺少 Discord ID");

    const targetReportGuild =
      client.guilds.cache.get(String(reportGuildId || "")) ||
      (await client.guilds.fetch(String(reportGuildId || "")).catch(() => null));
    if (!targetReportGuild) {
      throw new Error(`找不到員工群 ${reportGuildId || "未設定"}`);
    }
    await targetReportGuild.channels.fetch();
    let channel = client.channels.cache.get(
      parseChannelId(staff.report_channel_id || staff.salary_channel_id),
    );
    if (
      channel?.type !== ChannelType.GuildText ||
      String(channel.guildId) !== String(reportGuildId)
    ) {
      channel = null;
    }
    const staffTokens = [
      staff.display_name,
      staff.discord_name,
      staff.real_name,
      staff.name,
    ]
      .map(reportChannelToken)
      .filter(Boolean);
    const reportChannels = targetReportGuild.channels.cache.filter(
      (channel) =>
        channel.type === ChannelType.GuildText &&
        String(channel.guildId) === String(reportGuildId) &&
        String(channel.name || "").startsWith("填單專區-"),
    );
    if (!channel) {
      // 員工改過暱稱後頻道名稱可能不再相同；權限覆寫才是最可靠的歸屬依據。
      channel = reportChannels.find((candidate) =>
        candidate.permissionOverwrites.cache.has(staffId),
      );
    }
    if (!channel) {
      // 若上次建立頻道後、寫回 EIP 前失敗，沿用同名頻道並補上權限，
      // 不再因重試而建立第二個頻道。
      channel = reportChannels.find((candidate) =>
        staffTokens.includes(reportChannelToken(candidate.name)),
      );
    }

    if (!channel) {
      const { data: unfilteredStaffRows, error } = await supabase
        .from(staffTable)
        .select("*");
      if (error) throw error;
      const staffRows =
        staffTable === "players"
          ? (unfilteredStaffRows || []).filter((row) =>
              staffBelongsToGuild(row, guildId),
            )
          : unfilteredStaffRows || [];
      const knownChannels = (staffRows || [])
        .map((row) => ({
          row,
          channel: client.channels.cache.get(
            parseChannelId(row.report_channel_id || row.salary_channel_id),
          ),
        }))
        .filter(
          ({ channel: item }) =>
            item?.type === ChannelType.GuildText &&
            String(item.guildId) === String(reportGuildId),
        );
      const genderText = String(staff.gender || "");
      let genderKey = genderText.includes("女") ? "女陪" : genderText.includes("男") ? "男陪" : "";
      const targetGuild = targetReportGuild;
      if (!genderKey) {
        const member = await targetGuild.members.fetch(staffId).catch(() => null);
        const roleNames = member?.roles.cache.map((role) => role.name).join(" ") || "";
        genderKey = roleNames.includes("女陪") ? "女陪" : roleNames.includes("男陪") ? "男陪" : "";
      }
      const reportCategoryIds = new Set(
        knownChannels.map(({ channel: item }) => item.parentId).filter(Boolean),
      );
      const categories = targetGuild.channels.cache
        .filter(
          (item) =>
            item.type === ChannelType.GuildCategory &&
            reportCategoryIds.has(item.id) &&
            (!genderKey || String(item.name || "").includes(genderKey)) &&
            item.children.cache.size < 50,
        )
        .sort((a, b) => a.children.cache.size - b.children.cache.size);
      const category = categories.first();
      if (!category) throw new Error(`找不到可建立陪陪 <@${staffId}> 填單區的分類`);
      const template = knownChannels.find(
        ({ channel: item }) => item.parentId === category.id,
      );
      if (!template) throw new Error(`找不到填單區權限範本：${category.name}`);
      const permissionOverwrites = template.channel.permissionOverwrites.cache
        // 範本只複製仍存在的身分組權限。舊員工/member overwrite 可能已離群，
        // 直接複製會讓 Discord 回 Unknown Overwrite，接著觸發重複補建。
        .filter(
          (overwrite) =>
            Number(overwrite.type) === 0 &&
            targetGuild.roles.cache.has(String(overwrite.id)),
        )
        .map((overwrite) => ({
          id: overwrite.id,
          type: overwrite.type,
          allow: overwrite.allow.bitfield,
          deny: overwrite.deny.bitfield,
        }));
      permissionOverwrites.push({
        id: staffId,
        type: 1,
        allow: PermissionFlagsBits.ViewChannel,
        deny: 0n,
      });
      channel = await targetGuild.channels.create({
        name: getStaffReportChannelName(staff),
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites,
        reason: `自動補建 ${staffId} 的填單區`,
      });
    }

    if (!channel.permissionOverwrites.cache.has(staffId)) {
      await channel.permissionOverwrites.edit(
        staffId,
        { ViewChannel: true },
        { reason: `自動補上 ${staffId} 的填單區權限` },
      );
    }

    const updatePayload =
      staffTable === "qiunai_staff"
        ? { salary_channel_id: channel.id }
        : { report_channel_id: channel.id, salary_channel_id: channel.id };
    let updatedRows = [];
    // 入職流程會先建頻道、再新增 EIP 員工資料；此時 staff.id 合理地尚未存在。
    // 禁止用 undefined 查 UUID，否則頻道建成後仍被當成失敗並反覆重建。
    if (staff.id) {
      const updateQuery = supabase
        .from(staffTable)
        .update(updatePayload)
        .eq("id", staff.id);
      const { data, error: updateError } = await updateQuery.select("id");
      if (updateError) throw updateError;
      updatedRows = data || [];
    }
    Object.assign(staff, updatePayload);
    if (updatedRows?.length) {
      console.log(`[報單自動修復] ${staffId} 已綁定填單區 ${channel.id}`);
    } else {
      console.log(
        `[報單自動修復] ${staffId} 填單區 ${channel.id} 已就緒，等待建立員工資料`,
      );
    }
    return channel;
  }

  function ensureStaffReportChannel(staff) {
    const staffId = String(staff?.discord_id || "").trim();
    if (!staffId) return Promise.reject(new Error("員工資料缺少 Discord ID"));

    const existing = reportChannelProvisionByStaffId.get(staffId);
    if (existing) return existing;

    let task;
    try {
      task = Promise.resolve(provisionStaffReportChannel(staff));
    } catch (error) {
      task = Promise.reject(error);
    }
    const trackedTask = task.finally(() => {
      if (reportChannelProvisionByStaffId.get(staffId) === trackedTask) {
        reportChannelProvisionByStaffId.delete(staffId);
      }
    });
    reportChannelProvisionByStaffId.set(staffId, trackedTask);
    return trackedTask;
  }

  function readCrownMeta(order) {
    try {
      const parsed = JSON.parse(order?.note || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  async function checkCrownReminders() {
    const { data: orders, error } = await supabase
      .from("play_orders")
      .select("id, assigned_player, order_item, service, note")
      .ilike("service", "%冠名單%")
      .eq("status", "completed")
      .not("note", "is", null)
      .order("created_at", { ascending: false })
      .limit(1000);
    if (error) throw error;

    const now = Date.now();
    for (const order of orders || []) {
      const meta = readCrownMeta(order);
      const endAt = new Date(meta.crownReminderEndAt || 0);
      if (
        !meta.crownReminderChannelId ||
        meta.crownReminderSent ||
        !Number.isFinite(endAt.getTime()) ||
        endAt.getTime() > now
      ) {
        continue;
      }
      const staffId =
        String(meta.crownReminderStaffId || order.assigned_player || "")
          .split(",")[0]
          .trim();
      const channel = await client.channels
        .fetch(meta.crownReminderChannelId)
        .catch(() => null);
      if (!channel?.isTextBased() || !staffId) continue;
      try {
        await channel.send({
          content:
            `<@${staffId}> 👑 冠名時間已到！\n` +
            `冠名品項：${order.order_item || order.service || "冠名單"}\n` +
            `到期時間：${formatTaipeiDateTime(endAt)}\n` +
            "請依冠名單內容處理雙方尾綴，並與客服確認後續。",
          allowedMentions: { users: [staffId] },
        });
        meta.crownReminderSent = true;
        meta.crownReminderSentAt = new Date().toISOString();
        const { error: updateError } = await supabase
          .from("play_orders")
          .update({ note: JSON.stringify(meta) })
          .eq("id", order.id);
        if (updateError) throw updateError;
      } catch (sendError) {
        console.error("[冠名到期提醒失敗]", order.id, sendError);
      }
    }
  }

  async function startCrownReminderScheduler() {
    if (crownReminderTimer) return;
    await checkCrownReminders();
    crownReminderTimer = setInterval(() => {
      checkCrownReminders().catch((error) =>
        console.error("[冠名到期排程錯誤]", error),
      );
    }, 60 * 1000);
    crownReminderTimer.unref?.();
  }
  async function findStaff(discordId) {
    const normalizedId = String(discordId || "").trim();
    const { data, error } = await supabase
      .from(staffTable)
      .select("*")
      .eq("discord_id", normalizedId);
    if (error) throw error;
    if (staffTable !== "players") return data?.[0] || null;
    return (
      (data || []).find(
        (row) => String(row.guild_id || "").trim() === String(guildId),
      ) ||
      (data || []).find((row) => staffBelongsToGuild(row, guildId)) ||
      null
    );
  }

  async function resolveManualStaffInput(interaction, input) {
    const lookups = splitStaffLookupInput(input);
    if (!lookups.length) throw new Error("請輸入至少一位陪陪。");

    const { data: staffRows, error } = await supabase
      .from(staffTable)
      .select("*")
      .not("discord_id", "is", null);
    if (error) throw error;

    const members = await interaction.guild.members.fetch().catch(() => null);
    const records = (staffRows || []).map((staff) => ({
      staff,
      member: members?.get(String(staff.discord_id || "").trim()) || null,
    }));
    const selectedIds = [];
    const unresolved = [];
    const ambiguous = [];

    for (const lookup of lookups) {
      const matches = matchStaffLookup(records, lookup);
      const uniqueMatches = [
        ...new Map(
          matches.map((record) => [String(record.staff.discord_id), record]),
        ).values(),
      ];
      if (uniqueMatches.length === 0) {
        unresolved.push(lookup);
        continue;
      }
      if (uniqueMatches.length > 1) {
        ambiguous.push(lookup);
        continue;
      }
      const staff = uniqueMatches[0].staff;
      const staffId = String(staff.discord_id || "").trim();
      selectedIds.push(staffId);
    }

    if (unresolved.length) {
      throw new Error(
        `找不到以下陪陪：${unresolved.join("、")}。可輸入暱稱、帳號名稱、@提及、Discord 數字 ID 或薪資網員工 ID。`,
      );
    }
    if (ambiguous.length) {
      throw new Error(
        `以下名稱對應到多位員工：${ambiguous.join("、")}。請改用 @提及、Discord 數字 ID 或薪資網員工 ID。`,
      );
    }
    return [...new Set(selectedIds)];
  }

  async function sendReportCard(
    report,
    staff,
    { completed = false } = {},
  ) {
    const channelId = parseChannelId(
      staff?.report_channel_id || staff?.salary_channel_id,
    );
    let channelWasRepaired = false;
    let channel = channelId
      ? await client.channels.fetch(channelId).catch(() => null)
      : null;
    if (!channel?.isTextBased()) {
      console.warn(`[報單自動修復] 陪陪 ${report.staff_id} 缺少有效填單區，開始修復`);
      try {
        channel = await ensureStaffReportChannel(staff);
        channelWasRepaired = true;
      } catch (error) {
        throw new Error(
          `陪陪 <@${report.staff_id}> 缺少有效填單區，且自動補建失敗：${error?.message || error}`,
          { cause: error },
        );
      }
    }

    if (report.work_report_message_id) {
      const storedMessage = await channel.messages
        .fetch(String(report.work_report_message_id))
        .catch(() => null);
      if (storedMessage) return storedMessage;
    }

    // A Discord send can succeed immediately before the database checkpoint
    // fails.  Recover that message by its report-specific component/footer so
    // the next attempt stores the id instead of posting a duplicate panel.
    const recentMessages = await channel.messages
      .fetch({ limit: 100 })
      .catch(() => null);
    const existingMessage = recentMessages?.find?.((message) => {
      if (message.author?.id !== client.user?.id) return false;
      const hasReportComponent = message.components?.some?.((row) =>
        row.components?.some?.((component) =>
          String(component.customId || component.custom_id || "").endsWith(
            `_${report.id}`,
          ),
        ),
      );
      const hasReportFooter = message.embeds?.some?.(
        (embed) => embed.footer?.text === `報單識別碼 ${report.id}`,
      );
      return Boolean(hasReportComponent || hasReportFooter);
    });
    if (existingMessage) {
      const { error: checkpointError } = await supabase
        .from(salaryTable)
        .update({
          work_report_message_id: existingMessage.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", report.id);
      if (checkpointError) {
        throw new Error(`保存既有工時面板編號失敗：${checkpointError.message}`);
      }
      report.work_report_message_id = existingMessage.id;
      return existingMessage;
    }

    const isGift = isGiftOrderType(report.order_type);
    const isCrown = String(report.service_name || "").includes("冠名單｜");
    const fields = [
      {
        name: "老闆",
        value: report.customer_id
          ? `<@${report.customer_id}>`
          : report.customer_name || "未填寫",
        inline: true,
      },
      { name: "類型", value: report.order_type || "訂單", inline: true },
      {
        name: "項目",
        value: report.service_name || "陪玩服務",
        inline: true,
      },
      {
        name: "金額",
        value: `NT$${Number(report.order_amount || 0).toLocaleString("zh-TW")}`,
        inline: true,
      },
    ];
    if (!isGift) {
      fields.push({
        name: "預定時長",
        value: report.expected_duration_minutes
          ? durationText(report.expected_duration_minutes)
          : "未設定",
        inline: true,
      });
    }
    const editButton = new ButtonBuilder()
      .setCustomId(`work_report_edit_${report.id}`)
      .setLabel("改時長及金額")
      .setStyle(ButtonStyle.Secondary);
    const initialButtons = isCrown
      ? [
          new ButtonBuilder()
            .setCustomId(`work_report_crown_start_${report.id}`)
            .setLabel("設定冠名開始時間")
            .setStyle(ButtonStyle.Primary),
        ]
      : isGift
        ? []
      : completed
        ? [editButton]
      : [
          new ButtonBuilder()
            .setCustomId(`work_report_start_${report.id}`)
            .setLabel("輸入開始時間")
            .setStyle(ButtonStyle.Primary),
        ];
    const components = initialButtons.length
      ? [new ActionRowBuilder().addComponents(...initialButtons)]
      : [];
    const message = await channel.send({
      content: isGift
        ? isCrown
          ? `<@${report.staff_id}> 你有一筆冠名單，請設定實際開始冠名及修改尾綴的時間。`
          : `<@${report.staff_id}> 你有一筆打賞紀錄，已直接送到薪資後台等待審核。`
        : completed
          ? `<@${report.staff_id}> 新增的時長及金額已建立為一筆新報單，並送到薪資後台等待審核。`
        : `<@${report.staff_id}> 請填寫這筆服務的開始與結束時間。`,
      embeds: [
        new EmbedBuilder()
          .setColor(isGift ? "#f59e0b" : "#38bdf8")
          .setTitle(isGift ? "打賞申報" : "訂單工時申報")
          .addFields(...fields)
          .setDescription(
            isGift
              ? isCrown
                ? "請輸入實際開始冠名及修改尾綴的時間，系統會計算到期時間並在本填單區提醒。"
                : "打賞不需填寫時間，客服送出後已同步進入薪資後台審核。"
              : completed
                ? "這是結束時間後追加的新報單，不會覆蓋原本的報單。"
              : "填寫完成後會自動計算時長，並送到薪資後台等待審核。",
          )
          .setFooter({ text: `報單識別碼 ${report.id}` }),
      ],
      components,
    }).catch((error) => {
      throw new Error(
        `陪陪 <@${report.staff_id}> 的報單${channelWasRepaired ? "重新" : ""}發送失敗：${error?.message || error}`,
        { cause: error },
      );
    });

    const { error: checkpointError } = await supabase
      .from(salaryTable)
      .update({
        work_report_message_id: message.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", report.id);
    if (checkpointError) {
      throw new Error(`保存工時面板編號失敗：${checkpointError.message}`);
    }
    report.work_report_message_id = message.id;
    return message;
  }

  async function createReports(payload, staffIds) {
    const reports = [];
    const totalAmount = Number(payload.orderAmount || 0);
    const isGift = isGiftOrderType(payload.orderType);
    const reportAmounts = buildReportAmounts(
      totalAmount,
      staffIds.length,
      isGift,
    );

    // 深夜的原始訂單只負責付款與訂單生命週期；陪陪薪資一律以 WORK 單為準。
    // 先移除原始訂單上的薪資歸屬，避免原始單與工時單同時顯示、同時入帳。
    if (
      appKey === "deepnight" &&
      payload.sourceKind === "bot_order" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        String(payload.sourceOrderId || ""),
      )
    ) {
      const { error: sourceSalaryError } = await supabase
        .from(salaryTable)
        .update({
          discord_id: null,
          staff_name: null,
          staff_salary: 0,
          bonus_amount: 0,
          salary_rate: null,
          salary_level: null,
          platform_expense: 0,
        })
        .eq("id", payload.sourceOrderId);
      if (sourceSalaryError) {
        throw new Error(
          `清除原始訂單的重複薪資資料失敗：${sourceSalaryError.message}`,
          { cause: sourceSalaryError },
        );
      }
    }

    for (const [staffIndex, staffId] of staffIds.entries()) {
      const perStaffAmount = reportAmounts[staffIndex];
      const staff = await findStaff(staffId);
      if (!staff) throw new Error(`找不到陪陪 <@${staffId}> 的員工資料`);
      const staffName =
        staff.display_name ||
        staff.real_name ||
        staff.discord_name ||
        staff.name ||
        staffId;
      const reportKey = `WORK-${payload.sourceOrderId}-${staffId}`;
      const reportMeta = {
        sourceKind: payload.sourceKind,
        customerId: payload.customerId || null,
        customerName: payload.customerName || null,
        orderType: payload.orderType || "訂單",
        serviceName: payload.serviceName || "陪玩服務",
        expectedDurationMinutes: Number(payload.expectedDurationMinutes || 0),
        segments: [],
      };
      const basePayload = {
        order_id: reportKey,
        discord_id: String(staffId),
        staff_name: staffName,
        customer_name: payload.customerName || payload.customerId || "手動報單",
        service_name: payload.serviceName || "陪玩服務",
        order_amount: perStaffAmount,
        staff_salary: 0,
        bonus_amount: 0,
        salary_rate: 0,
        platform_income: perStaffAmount,
        platform_expense: 0,
        is_deleted: true,
      };
      const insertPayload =
        appKey === "deepnight"
          ? {
              ...basePayload,
              order_no: reportKey,
              customer_id: payload.customerId || "manual",
              service: payload.serviceName || "陪玩服務",
              assigned_player: String(staffId),
              price: perStaffAmount,
              final_price: perStaffAmount,
              order_type: payload.orderType || "訂單",
              status: isGift ? "work_pending" : "work_draft",
              quote_status: "work_report",
              note: JSON.stringify(reportMeta),
              guild_id: guildId,
            }
          : {
              ...basePayload,
              status: isGift ? "工時待審核" : "工時待填",
              admin_note: JSON.stringify(reportMeta),
            };
      const { data: existing } = await supabase
        .from(salaryTable)
        .select("*")
        .eq("order_id", reportKey)
        .maybeSingle();
      const { data, error } = existing
        ? { data: existing, error: null }
        : await supabase
            .from(salaryTable)
            .insert(insertPayload)
            .select()
            .single();
      if (error) throw error;
      const report = {
        id: data.id,
        work_report_message_id: data.work_report_message_id || null,
        staff_id: String(staffId),
        customer_id: payload.customerId || null,
        customer_name: payload.customerName || null,
        order_type: payload.orderType || "訂單",
        service_name: payload.serviceName || "陪玩服務",
        order_amount: perStaffAmount,
        expected_duration_minutes: Number(payload.expectedDurationMinutes || 0),
      };
      // The row may already exist because the first Discord send failed after
      // insertion.  sendReportCard now checkpoints/fetches its message id, so
      // retrying existing rows is both necessary and idempotent.
      await sendReportCard(report, staff);
      reports.push(report);
    }
    return reports;
  }

  async function sendForAcceptedOrder(order, staffIds) {
    return createReports(
      {
        sourceKind: "bot_order",
        sourceOrderId: order.id,
        customerId: order.customer_id,
        customerName: order.customer_name || order.customer_username,
        orderType: order.order_type || "訂單",
        serviceName: order.service || order.service_name || order.order_item,
        orderAmount: getOrderCommissionBase(order),
        expectedDurationMinutes:
          Number(order.duration_minutes || 0) ||
          parseDurationMinutes(order.duration_text),
      },
      staffIds,
    );
  }

  async function syncAcceptedOrder(order) {
    const staffIds = String(order.assigned_player || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (!staffIds.length) return [];

    const totalAmount = getOrderCommissionBase(order);
    const amounts = buildReportAmounts(totalAmount, staffIds.length, false);
    const expectedDurationMinutes =
      Number(order.duration_minutes || 0) ||
      parseDurationMinutes(order.duration_text || order.reserved_time);
    const synced = [];

    for (const [index, staffId] of staffIds.entries()) {
      const reportKey = `WORK-${order.id}-${staffId}`;
      const { data: current, error: readError } = await supabase
        .from(salaryTable)
        .select("*")
        .eq("order_id", reportKey)
        .maybeSingle();
      if (readError) throw readError;
      if (!current) continue;

      let meta = {};
      try {
        meta = JSON.parse(current.note || current.admin_note || "{}");
      } catch {}
      const amount = amounts[index];
      const nextMeta = {
        ...meta,
        serviceName: order.service || order.service_name || order.order_item,
        orderAmount: amount,
        expectedDurationMinutes,
        sourceOrderUpdatedAt: new Date().toISOString(),
      };
      const common = {
        service_name:
          order.service || order.service_name || order.order_item || "陪玩服務",
        order_amount: amount,
        platform_income: amount,
      };
      const updatePayload =
        appKey === "deepnight"
          ? {
              ...common,
              service:
                order.service ||
                order.service_name ||
                order.order_item ||
                "陪玩服務",
              price: amount,
              final_price: amount,
              note: JSON.stringify(nextMeta),
            }
          : { ...common, admin_note: JSON.stringify(nextMeta) };
      const { data: updated, error: updateError } = await supabase
        .from(salaryTable)
        .update(updatePayload)
        .eq("id", current.id)
        .in("status", ["work_draft", "work_pending", "工時待填", "工時待審核"])
        .select()
        .maybeSingle();
      if (updateError) throw updateError;
      if (updated) synced.push(updated);
    }
    return synced;
  }

  async function sendForPaidExtension(extension, order) {
    const staffIds = String(order.assigned_player || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (!staffIds.length) throw new Error("原訂單尚未有陪陪接單");

    return createReports(
      {
        sourceKind: "order_extension",
        sourceOrderId: `EXT-${extension.id}`,
        customerId: order.customer_id,
        customerName: order.customer_name || order.customer_username,
        orderType: "訂單加時",
        serviceName: `${order.service || order.order_item || "陪玩訂單"}｜加時：${
          extension.extension_text || "加時"
        }`,
        orderAmount: Number(extension.amount || 0),
        expectedDurationMinutes: parseDurationMinutes(extension.extension_text),
      },
      staffIds,
    );
  }

  async function sendForCompletedTipOrders(orders, payload = {}) {
    const reports = [];
    for (const order of (orders || []).filter(Boolean)) {
      const staffId = String(order.discord_id || order.assigned_player || "");
      if (!staffId) continue;
      const staff = await findStaff(staffId);
      if (!staff) throw new Error(`找不到陪陪 <@${staffId}> 的員工資料`);
      const report = {
        id: order.id,
        work_report_message_id: order.work_report_message_id || null,
        staff_id: staffId,
        customer_id: payload.customerId || order.customer_id || null,
        customer_name: payload.customerName || order.customer_name || null,
        order_type: "打賞",
        service_name:
          payload.serviceName || order.service_name || order.service || "打賞",
        order_amount: Number(
          payload.amount || order.order_amount || order.final_price || 0,
        ),
        expected_duration_minutes: 0,
      };
      await sendReportCard(report, staff);
      reports.push(report);
    }
    return reports;
  }

  async function createAdditionalReport(current, meta, durationMinutes, amount, actorId) {
    const createdAt = new Date().toISOString();
    const staffId = String(current.discord_id || current.assigned_player || "");
    if (!staffId) throw new Error("原始報單缺少陪陪資料");
    const reportKey = `WORK-ADD-${current.id}-${Date.now()}`;
    const nextMeta = {
      sourceKind: "additional_work_report",
      sourceOrderId: current.order_id || current.order_no || current.id,
      parentReportId: current.id,
      customerId: meta.customerId || current.customer_id || null,
      customerName: meta.customerName || current.customer_name || null,
      orderType: meta.orderType || current.order_type || "訂單追加",
      serviceName:
        meta.serviceName || current.service_name || current.service || "追加服務",
      expectedDurationMinutes: durationMinutes,
      durationMinutes,
      segments: [],
      createdBy: actorId,
      createdAt,
    };
    const basePayload = {
      order_id: reportKey,
      discord_id: staffId,
      staff_name: current.staff_name || staffId,
      customer_name:
        nextMeta.customerName || nextMeta.customerId || "追加報單",
      service_name: nextMeta.serviceName,
      order_amount: amount,
      staff_salary: 0,
      bonus_amount: 0,
      salary_rate: 0,
      platform_income: amount,
      platform_expense: 0,
      order_finished_at: createdAt,
      is_deleted: true,
    };
    const insertPayload =
      appKey === "deepnight"
        ? {
            ...basePayload,
            order_no: reportKey,
            customer_id: nextMeta.customerId || "manual",
            service: nextMeta.serviceName,
            assigned_player: staffId,
            price: amount,
            final_price: amount,
            order_type: "訂單追加",
            status: "work_pending",
            quote_status: "work_report",
            duration_minutes: durationMinutes,
            completed_at: createdAt,
            guild_id: guildId,
            note: JSON.stringify(nextMeta),
          }
        : {
            ...basePayload,
            status: "工時待審核",
            admin_note: JSON.stringify(nextMeta),
          };
    const { data, error } = await supabase
      .from(salaryTable)
      .insert(insertPayload)
      .select()
      .single();
    if (error) throw error;
    const staff = await findStaff(staffId);
    if (!staff) throw new Error(`找不到陪陪 <@${staffId}> 的員工資料`);
    const report = {
      id: data.id,
      staff_id: staffId,
      customer_id: nextMeta.customerId,
      customer_name: nextMeta.customerName,
      order_type: "訂單追加",
      service_name: nextMeta.serviceName,
      order_amount: amount,
      expected_duration_minutes: durationMinutes,
    };
    try {
      await sendReportCard(report, staff, { completed: true });
    } catch (sendError) {
      try {
        await supabase.from(salaryTable).delete().eq("id", data.id);
      } catch {}
      throw sendError;
    }
    return report;
  }

  async function sendManualPanel() {
    const channel = await client.channels
      .fetch(manualChannelId)
      .catch(() => null);
    if (!channel?.isTextBased()) return;
    const recent = await channel.messages
      .fetch({ limit: 20 })
      .catch(() => null);
    const panelPayload = {
      embeds: [
        new EmbedBuilder()
          .setColor("#f59e0b")
          .setTitle("客服人工報單")
          .setDescription("請依類型選擇報單。訂單需填時長，打賞不需填時長。"),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("open_manual_work_report_order")
            .setLabel("訂單報單")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId("open_manual_work_report_gift")
            .setLabel("打賞報單")
            .setStyle(ButtonStyle.Success),
        ),
      ],
    };
    const existingPanel = recent?.find(
      (message) =>
        message.author.id === client.user.id &&
        message.components.some((row) =>
          row.components.some((item) =>
            [
              "open_manual_work_report",
              "open_manual_work_report_order",
              "open_manual_work_report_gift",
            ].includes(item.customId),
          ),
        ),
    );
    if (existingPanel) {
      await existingPanel.edit(panelPayload);
      return;
    }
    await channel.send(panelPayload);
  }

  function isStaff(interaction) {
    return isStaffInteraction(interaction, staffRoleId, customerServiceRoleId);
  }

  async function notifyCustomerAboutSavedOrder(
    meta,
    shortageMinutes,
    fallbackChannel,
  ) {
    const content = `${meta.customerId ? `<@${meta.customerId}> ` : `${meta.customerName || "客戶"} `}本次服務尚差 ${durationText(shortageMinutes)}，訂單已存單，請聯繫客服安排後續時間。`;
    let sent = false;
    if (meta.sourceKind === "bot_order" && meta.sourceOrderId) {
      const { data: sourceOrder } = await supabase
        .from("play_orders")
        .select("channel_id")
        .eq("id", meta.sourceOrderId)
        .maybeSingle();
      if (sourceOrder?.channel_id) {
        const orderChannel = await client.channels
          .fetch(sourceOrder.channel_id)
          .catch(() => null);
        if (orderChannel?.isTextBased()) {
          await orderChannel.send(content).catch(() => {});
          sent = true;
        }
      }
    }
    if (!sent && meta.customerId) {
      const customer = await client.users
        .fetch(meta.customerId)
        .catch(() => null);
      if (customer) {
        await customer
          .send(content.replace(`<@${meta.customerId}> `, ""))
          .catch(() => {});
        sent = true;
      }
    }
    if (!sent && fallbackChannel?.isTextBased()) {
      await fallbackChannel.send(content).catch(() => {});
    }
  }

  async function handleInteraction(interaction) {
    if (
      interaction.isButton() &&
      interaction.customId.startsWith("work_report_crown_start_")
    ) {
      const orderId = interaction.customId.replace(
        "work_report_crown_start_",
        "",
      );
      const { data: order } = await supabase
        .from("play_orders")
        .select("*")
        .eq("id", orderId)
        .maybeSingle();
      const staffId = String(order?.assigned_player || "").split(",")[0].trim();
      if (!order || (interaction.user.id !== staffId && !isStaff(interaction))) {
        return interaction.reply({
          content: "只有這筆冠名單的陪陪或客服可以設定開始時間。",
          flags: 64,
        });
      }
      const durationHours = parseCrownDurationHours(
        order.order_item || order.service,
      );
      if (!durationHours) {
        return interaction.reply({
          content: "找不到冠名時長，請聯繫客服確認冠名單內容。",
          flags: 64,
        });
      }
      const modal = new ModalBuilder()
        .setCustomId(
          `submit_work_report_crown_start_${orderId}_${interaction.message.id}`,
        )
        .setTitle("設定冠名開始時間")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("crown_start_time")
              .setLabel("開始冠名及修改尾綴時間（台北時間）")
              .setPlaceholder("2026-07-28 20:30，或只輸入 20:30")
              .setValue(formatTaipeiWorkTimeInput(new Date()))
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
        );
      await interaction.showModal(modal);
      return true;
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("submit_work_report_crown_start_")
    ) {
      const raw = interaction.customId.replace(
        "submit_work_report_crown_start_",
        "",
      );
      const [orderId, messageId] = raw.split("_");
      const { data: order } = await supabase
        .from("play_orders")
        .select("*")
        .eq("id", orderId)
        .maybeSingle();
      const staffId = String(order?.assigned_player || "").split(",")[0].trim();
      if (!order || (interaction.user.id !== staffId && !isStaff(interaction))) {
        return interaction.reply({
          content: "只有這筆冠名單的陪陪或客服可以設定開始時間。",
          flags: 64,
        });
      }
      const durationHours = parseCrownDurationHours(
        order.order_item || order.service,
      );
      const startAt = parseTaipeiWorkTime(
        interaction.fields.getTextInputValue("crown_start_time"),
      );
      const endAt = calculateCrownEndAt(startAt, durationHours);
      if (!startAt || !endAt) {
        return interaction.reply({
          content:
            "時間格式不正確，請使用 YYYY-MM-DD HH:mm，例如 2026-07-28 20:30；也可只輸入 HH:mm。",
          flags: 64,
        });
      }
      const oldMeta = readCrownMeta(order);
      const meta = {
        ...oldMeta,
        originalNote: oldMeta.originalNote || order.note || "打賞",
        crownReminderChannelId: interaction.channel.id,
        crownReminderStaffId: staffId,
        crownReminderStartAt: startAt.toISOString(),
        crownReminderEndAt: endAt.toISOString(),
        crownReminderDurationHours: durationHours,
        crownReminderSent: false,
        crownReminderSetBy: interaction.user.id,
        crownReminderSetAt: new Date().toISOString(),
      };
      const { error } = await supabase
        .from("play_orders")
        .update({ note: JSON.stringify(meta) })
        .eq("id", order.id);
      if (error) {
        return interaction.reply({
          content: `設定冠名時間失敗：${error.message}`,
          flags: 64,
        });
      }
      const message = await interaction.channel.messages
        .fetch(messageId)
        .catch(() => null);
      if (message?.embeds[0]) {
        const embed = EmbedBuilder.from(message.embeds[0]).addFields(
          {
            name: "冠名開始時間",
            value: formatTaipeiDateTime(startAt),
            inline: true,
          },
          {
            name: "冠名到期時間",
            value: formatTaipeiDateTime(endAt),
            inline: true,
          },
        );
        await message.edit({ embeds: [embed], components: [] }).catch(() => {});
      }
      await checkCrownReminders();
      return interaction.reply({
        content:
          `✅ 冠名時間已設定\n` +
          `開始：${formatTaipeiDateTime(startAt)}\n` +
          `到期：${formatTaipeiDateTime(endAt)}\n` +
          "時間到時會在這個填單區標註提醒你。",
        flags: 64,
      });
    }

    if (
      interaction.isButton() &&
      [
        "open_manual_work_report",
        "open_manual_work_report_order",
        "open_manual_work_report_gift",
      ].includes(interaction.customId)
    ) {
      if (!isStaff(interaction))
        return interaction.reply({
          content: "只有客服或管理員可以報單。",
          flags: 64,
        });
      const reportKind = interaction.customId.endsWith("_gift")
        ? "gift"
        : "order";
      const modal = new ModalBuilder()
        .setCustomId(`submit_manual_work_report_${reportKind}`)
        .setTitle(reportKind === "gift" ? "打賞報單" : "訂單報單");
      const fields = [
        [
          "manual_customer",
          "老闆（@使用者或 Discord ID）",
          TextInputStyle.Short,
        ],
        ["manual_service", "項目", TextInputStyle.Short],
        ["manual_amount", "金額", TextInputStyle.Short],
      ];
      if (reportKind === "order") {
        fields.push([
          "manual_duration",
          "時長（例如 2小時或90分鐘）",
          TextInputStyle.Short,
        ]);
      }
      fields.push([
        "manual_staff",
        "陪陪（暱稱、帳號名稱或數字 ID）",
        TextInputStyle.Short,
        "多人請用逗號分隔，也可貼上 @提及",
      ]);
      modal.addComponents(
        ...fields.map(([id, label, style, placeholder]) => {
          const input = new TextInputBuilder()
              .setCustomId(id)
              .setLabel(label)
              .setStyle(style)
              .setRequired(true);
          if (placeholder) input.setPlaceholder(placeholder);
          return new ActionRowBuilder().addComponents(input);
        }),
      );
      await interaction.showModal(modal);
      return true;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("work_report_add_")
    ) {
      if (!isStaff(interaction)) {
        return interaction.reply({
          content: "只有客服或管理員可以新增追加報單。",
          flags: 64,
        });
      }
      const reportId = interaction.customId.replace("work_report_add_", "");
      const { data: report, error } = await supabase
        .from(salaryTable)
        .select("*")
        .eq("id", reportId)
        .maybeSingle();
      if (error || !report) {
        return interaction.reply({ content: "找不到原始報單。", flags: 64 });
      }
      const modal = new ModalBuilder()
        .setCustomId(`submit_work_report_add_${reportId}`)
        .setTitle("新增時長及金額")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("add_duration")
              .setLabel("新增時長（例如 1小時或30分鐘）")
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("add_amount")
              .setLabel("新增金額")
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
        );
      await interaction.showModal(modal);
      return true;
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("submit_work_report_add_")
    ) {
      if (!isStaff(interaction)) {
        return interaction.reply({
          content: "只有客服或管理員可以新增追加報單。",
          flags: 64,
        });
      }
      const reportId = interaction.customId.replace(
        "submit_work_report_add_",
        "",
      );
      const durationMinutes = parseDurationMinutes(
        interaction.fields.getTextInputValue("add_duration"),
      );
      const amount = parseMoney(
        interaction.fields.getTextInputValue("add_amount"),
      );
      if (!durationMinutes || !amount) {
        return interaction.reply({
          content: "新增時長或金額格式不正確，請輸入大於 0 的內容。",
          flags: 64,
        });
      }
      const { data: current, error } = await supabase
        .from(salaryTable)
        .select("*")
        .eq("id", reportId)
        .maybeSingle();
      if (error || !current) {
        return interaction.reply({ content: "找不到原始報單。", flags: 64 });
      }
      let meta = {};
      try {
        meta = JSON.parse(current.note || current.admin_note || "{}");
      } catch {}
      try {
        await createAdditionalReport(
          current,
          meta,
          durationMinutes,
          amount,
          interaction.user.id,
        );
      } catch (createError) {
        return interaction.reply({
          content: `新增報單失敗：${createError.message || createError}`,
          flags: 64,
        });
      }
      await interaction.reply({
        content: `已新增 ${durationText(durationMinutes)}、NT$${amount.toLocaleString("zh-TW")} 的新報單，並自動發送到陪陪的報單頻道。`,
        flags: 64,
      });
      return true;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("work_report_edit_")
    ) {
      if (!isStaff(interaction)) {
        return interaction.reply({
          content: "只有客服或管理員可以修改送審單據。",
          flags: 64,
        });
      }
      const reportId = interaction.customId.replace("work_report_edit_", "");
      const { data: report, error } = await supabase
        .from(salaryTable)
        .select("*")
        .eq("id", reportId)
        .maybeSingle();
      if (error || !report) {
        return interaction.reply({
          content: "找不到這筆申報。",
          flags: 64,
        });
      }
      if (
        !["work_pending", "工時待審核", "work_draft", "工時待填"].includes(
          report.status,
        )
      ) {
        return interaction.reply({
          content: "這筆申報尚未送到後台待審核，暫時不能修改。",
          flags: 64,
        });
      }
      let meta = {};
      try {
        meta = JSON.parse(report.note || report.admin_note || "{}");
      } catch {}
      const isGift = isGiftOrderType(meta.orderType || report.order_type);
      const currentDuration = Number(
        meta.durationMinutes || report.duration_minutes || 0,
      );
      const modal = new ModalBuilder()
        .setCustomId(`submit_work_report_edit_${reportId}`)
        .setTitle(isGift ? "修改打賞金額" : "修改時長及金額");
      if (!isGift) {
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("edit_duration")
              .setLabel("實際時長（例如 2小時或90分鐘）")
              .setValue(currentDuration ? String(currentDuration) : "")
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
        );
      }
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("edit_amount")
            .setLabel("金額")
            .setValue(String(report.order_amount || 0))
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
      );
      await interaction.showModal(modal);
      return true;
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("submit_work_report_edit_")
    ) {
      if (!isStaff(interaction)) {
        return interaction.reply({
          content: "只有客服或管理員可以修改送審單據。",
          flags: 64,
        });
      }
      const reportId = interaction.customId.replace(
        "submit_work_report_edit_",
        "",
      );
      const { data: current, error: fetchError } = await supabase
        .from(salaryTable)
        .select("*")
        .eq("id", reportId)
        .maybeSingle();
      if (
        fetchError ||
        !current ||
        !["work_pending", "工時待審核", "work_draft", "工時待填"].includes(
          current.status,
        )
      ) {
        return interaction.reply({
          content: "這筆申報已不在待審核狀態，無法修改。",
          flags: 64,
        });
      }
      let meta = {};
      try {
        meta = JSON.parse(current.note || current.admin_note || "{}");
      } catch {}
      const isGift = isGiftOrderType(meta.orderType || current.order_type);
      const amount = parseMoney(
        interaction.fields.getTextInputValue("edit_amount"),
      );
      const durationMinutes = isGift
        ? Number(meta.durationMinutes || current.duration_minutes || 0)
        : parseDurationMinutes(
            interaction.fields.getTextInputValue("edit_duration"),
          );
      if (!amount) {
        return interaction.reply({
          content: "金額格式不正確，請輸入大於 0 的數字。",
          flags: 64,
        });
      }
      if (!isGift && !durationMinutes) {
        return interaction.reply({
          content: "時長格式不正確，可輸入 2小時、1.5 或 90分鐘。",
          flags: 64,
        });
      }
      const nextMeta = {
        ...meta,
        orderAmount: amount,
        ...(!isGift
          ? {
              durationMinutes,
              expectedDurationMinutes: durationMinutes,
            }
          : {}),
        lastEditedBy: interaction.user.id,
        lastEditedAt: new Date().toISOString(),
      };
      const updatePayload =
        appKey === "deepnight"
          ? {
              order_amount: amount,
              price: amount,
              final_price: amount,
              platform_income: amount,
              ...(!isGift ? { duration_minutes: durationMinutes } : {}),
              note: JSON.stringify(nextMeta),
            }
          : {
              order_amount: amount,
              platform_income: amount,
              admin_note: JSON.stringify(nextMeta),
            };
      const { data: updated, error: updateError } = await supabase
        .from(salaryTable)
        .update(updatePayload)
        .eq("id", reportId)
        .in("status", ["work_pending", "工時待審核", "work_draft", "工時待填"])
        .select()
        .maybeSingle();
      if (updateError || !updated) {
        return interaction.reply({
          content: `修改失敗：${updateError?.message || "單據狀態已變更"}`,
          flags: 64,
        });
      }
      await interaction.reply({
        content: isGift
          ? `打賞金額已更新為 NT$${amount.toLocaleString("zh-TW")}，後台審核單已同步。`
          : `已更新為 ${durationText(durationMinutes)}、NT$${amount.toLocaleString("zh-TW")}，後台審核單已同步。`,
        flags: 64,
      });
      if (interaction.message) {
        await interaction.message
          .edit({
            embeds: [buildUpdatedReportEmbed(interaction.message, nextMeta)],
          })
          .catch(() => {});
      }
      return true;
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("submit_manual_work_report")
    ) {
      if (!isStaff(interaction))
        return interaction.reply({
          content: "只有客服或管理員可以報單。",
          flags: 64,
        });
      const customerText =
        interaction.fields.getTextInputValue("manual_customer");
      const customerId = parseUserIds(customerText)[0] || null;
      const amount = Number(
        interaction.fields.getTextInputValue("manual_amount").replace(/,/g, ""),
      );
      const isLegacy = interaction.customId === "submit_manual_work_report";
      const reportKind = interaction.customId.endsWith("_gift")
        ? "gift"
        : "order";
      const orderType = isLegacy
        ? interaction.fields.getTextInputValue("manual_type").trim()
        : reportKind === "gift"
          ? "打賞"
          : "訂單";
      const durationValue =
        isLegacy || reportKind === "order"
          ? interaction.fields.getTextInputValue("manual_duration").trim()
          : "";
      const expectedDurationMinutes = parseDurationMinutes(durationValue) || 0;
      if (!Number.isFinite(amount) || amount <= 0)
        return interaction.reply({
          content: "金額格式不正確，請輸入大於 0 的數字。",
          flags: 64,
        });
      if (!isGiftOrderType(orderType) && !expectedDurationMinutes)
        return interaction.reply({
          content:
            "一般訂單需要填寫時長，可輸入 2小時、1.5 或 90分鐘；打賞可留空。",
          flags: 64,
        });
      if (durationValue && !expectedDurationMinutes)
        return interaction.reply({
          content: "時長格式不正確，可輸入 2小時、1.5 或 90分鐘。",
          flags: 64,
        });
      const staffInput =
        interaction.fields.fields.get("manual_staff")?.value || "";
      let selectedStaffIds = null;
      if (staffInput) {
        try {
          selectedStaffIds = await resolveManualStaffInput(
            interaction,
            staffInput,
          );
        } catch (error) {
          return interaction.reply({
            content: `陪陪搜尋失敗：${error.message}`,
            flags: 64,
          });
        }
      }
      const flowId = `${interaction.user.id}_${Date.now()}`;
      pendingManualReports.set(flowId, {
        creatorId: interaction.user.id,
        sourceKind: "manual",
        sourceOrderId: `MANUAL-${Date.now()}`,
        customerId,
        customerName: customerId ? null : customerText,
        orderType,
        serviceName: interaction.fields.getTextInputValue("manual_service"),
        orderAmount: amount,
        expectedDurationMinutes,
        selectedStaffIds,
      });
      setTimeout(() => pendingManualReports.delete(flowId), ORDER_FLOW_TTL_MS);
      if (selectedStaffIds?.length) {
        await interaction.reply({
          content: `已找到 ${selectedStaffIds.length} 位陪陪：${selectedStaffIds.map((id) => `<@${id}>`).join("、")}\n確認名單後請按「確定送出」。`,
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`manual_work_confirm_${flowId}`)
                .setLabel("確定送出")
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(`manual_work_cancel_${flowId}`)
                .setLabel("取消")
                .setStyle(ButtonStyle.Secondary),
            ),
          ],
          flags: 64,
        });
        return true;
      }

      // 相容部署前已開啟、尚未送出的舊版表單。
      const menu = new UserSelectMenuBuilder()
        .setCustomId(`manual_work_staff_${flowId}`)
        .setPlaceholder("搜尋並選擇陪陪（可複選）")
        .setMinValues(1)
        .setMaxValues(25);
      await interaction.reply({
        content: "請選擇這筆訂單的陪陪，可直接輸入名稱搜尋並一次選取多人。",
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: 64,
      });
      return true;
    }

    if (
      interaction.isUserSelectMenu() &&
      interaction.customId.startsWith("manual_work_staff_")
    ) {
      const flowId = interaction.customId.replace("manual_work_staff_", "");
      const pending = pendingManualReports.get(flowId);
      if (!pending || pending.creatorId !== interaction.user.id) {
        return interaction.reply({
          content: "這份報單已逾時，請重新填寫。",
          flags: 64,
        });
      }
      await interaction.deferUpdate();
      try {
        const invalidIds = [];
        for (const staffId of interaction.values) {
          if (!(await findStaff(staffId))) invalidIds.push(staffId);
        }
        if (invalidIds.length) {
          return interaction.editReply({
            content: `以下使用者不是薪資網陪陪，請重新選擇：${invalidIds.map((id) => `<@${id}>`).join("、")}`,
            components: interaction.message.components,
          });
        }
        pending.selectedStaffIds = [...interaction.values];
        pendingManualReports.set(flowId, pending);
        await interaction.editReply({
          content: `已選擇 ${interaction.values.length} 位陪陪：${interaction.values.map((id) => `<@${id}>`).join("、")}\n確認名單後請按「確定送出」。`,
          components: [
            interaction.message.components[0],
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`manual_work_confirm_${flowId}`)
                .setLabel("確定送出")
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(`manual_work_cancel_${flowId}`)
                .setLabel("取消")
                .setStyle(ButtonStyle.Secondary),
            ),
          ],
        });
      } catch (error) {
        await interaction.editReply({
          content: `報單失敗：${error.message}`,
          components: [],
        });
      }
      return true;
    }

    if (
      interaction.isButton() &&
      (interaction.customId.startsWith("manual_work_confirm_") ||
        interaction.customId.startsWith("manual_work_cancel_"))
    ) {
      const isConfirm = interaction.customId.startsWith("manual_work_confirm_");
      const flowId = interaction.customId.replace(
        isConfirm ? "manual_work_confirm_" : "manual_work_cancel_",
        "",
      );
      const pending = pendingManualReports.get(flowId);
      if (
        !pending ||
        (pending.creatorId !== interaction.user.id &&
          (!isConfirm || !isStaff(interaction)))
      ) {
        return interaction.reply({
          content: "這份報單已逾時，或你沒有代為送出的權限。",
          flags: 64,
        });
      }
      if (!isConfirm) {
        pendingManualReports.delete(flowId);
        return interaction.update({
          content: "已取消這份人工報單。",
          components: [],
        });
      }
      if (!pending.selectedStaffIds?.length) {
        return interaction.reply({
          content: "請先選擇至少一位陪陪。",
          flags: 64,
        });
      }
      await interaction.deferUpdate();
      try {
        await createReports(pending, pending.selectedStaffIds);
        pendingManualReports.delete(flowId);
        await interaction.editReply({
          content: isGiftOrderType(pending.orderType)
            ? `已送出 ${pending.selectedStaffIds.length} 位陪陪的完整打賞紀錄，每位金額 NT$${Number(pending.orderAmount).toLocaleString("zh-TW")}，並直接送到後台審核。`
            : `已送出 ${pending.selectedStaffIds.length} 位陪陪的填單面板。`,
          components: [],
        });
      } catch (error) {
        await interaction.editReply({
          content: `報單失敗：${error.message}`,
          components: interaction.message.components,
        });
      }
      return true;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("work_report_supplement_")
    ) {
      const reportId = interaction.customId.replace("work_report_supplement_", "");
      const modal = new ModalBuilder()
        .setCustomId(`submit_work_report_supplement_${reportId}_${interaction.message.id}`)
        .setTitle("補登存單時間")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("supplement_start")
              .setLabel("後續服務開始時間（台北）")
              .setPlaceholder("2026-09-23 20:00")
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("supplement_end")
              .setLabel("後續服務結束時間（台北）")
              .setPlaceholder("2026-09-23 21:00")
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
        );
      await interaction.showModal(modal);
      return true;
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("submit_work_report_supplement_")
    ) {
      const [reportId, messageId] = interaction.customId
        .replace("submit_work_report_supplement_", "").split("_");
      await interaction.deferReply({ flags: 64 });
      const { data: current, error: readError } = await supabase
        .from(salaryTable).select("*").eq("id", reportId).maybeSingle();
      if (readError || !current || current.status !== "work_saved") {
        return interaction.editReply({ content: "這筆存單已結束或找不到，請重新查看報單。" });
      }
      const canSupplement = current.discord_id === interaction.user.id ||
        interaction.guild?.ownerId === interaction.user.id ||
        interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
        interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
        parseRoleIds(customerServiceRoleId).some((roleId) => memberHasRole(interaction.member, roleId));
      if (!canSupplement) {
        return interaction.editReply({ content: "只有這筆訂單的陪陪或客服可以補單。" });
      }
      const startedAt = parseTaipeiWorkTime(interaction.fields.getTextInputValue("supplement_start"));
      const endedAt = parseTaipeiWorkTime(interaction.fields.getTextInputValue("supplement_end"));
      let supplement;
      try {
        supplement = buildSavedWorkReportSupplement(parseWorkReportMeta(current), startedAt, endedAt);
      } catch (error) {
        return interaction.editReply({ content: `補單失敗：${error.message}` });
      }
      const { data: updated, error: updateError } = await supabase
        .from(salaryTable)
        .update({
          accepted_at: supplement.meta.startedAt,
          completed_at: endedAt.toISOString(),
          order_finished_at: endedAt.toISOString(),
          duration_minutes: supplement.totalMinutes,
          status: supplement.isComplete ? "work_pending" : "work_saved",
          is_deleted: !supplement.isComplete,
          note: JSON.stringify(supplement.meta),
        })
        .eq("id", reportId)
        .eq("discord_id", current.discord_id)
        .eq("status", "work_saved")
        .eq("note", current.note)
        .select()
        .maybeSingle();
      if (updateError || !updated) {
        return interaction.editReply({ content: "補單狀態已更新，請重新查看後再試，避免重複登錄。" });
      }
      const panelMessage = interaction.message || await interaction.channel?.messages
        ?.fetch(messageId).catch(() => null);
      const panelPayload = {
        content: supplement.isComplete
          ? `✅ 補單後累積 ${durationText(supplement.totalMinutes)}，已完成訂單並送後台審核。`
          : `📝 已補登 ${durationText(supplement.totalMinutes)}，尚差 ${durationText(supplement.shortageMinutes)}，訂單繼續存單。`,
        ...(panelMessage?.embeds?.[0]
          ? { embeds: [buildUpdatedReportEmbed(panelMessage, supplement.meta)] }
          : {}),
        components: supplement.isComplete ? [] : [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`work_report_supplement_${reportId}`)
              .setLabel("補單").setStyle(ButtonStyle.Primary),
          ),
        ],
      };
      if (panelMessage) {
        await panelMessage.edit(panelPayload).catch((error) =>
          console.error("[工時補單] 更新訊息失敗", error),
        );
      } else if (!supplement.isComplete) {
        await interaction.channel?.send(panelPayload).catch((error) =>
          console.error("[工時補單] 重建補單按鈕失敗", error),
        );
      }
      return interaction.editReply({
        content: supplement.isComplete
          ? `✅ 已補足 ${durationText(supplement.totalMinutes)}，訂單已進入完成與薪資審核流程。`
          : `✅ 已補登時間，累積 ${durationText(supplement.totalMinutes)}；尚差 ${durationText(supplement.shortageMinutes)}。`,
      });
    }

    if (
      interaction.isButton() &&
      (interaction.customId.startsWith("work_report_save_") ||
        interaction.customId.startsWith("work_report_close_"))
    ) {
      const isClose = interaction.customId.startsWith("work_report_close_");
      const reportId = interaction.customId.replace(
        isClose ? "work_report_close_" : "work_report_save_",
        "",
      );
      if (isClose && !isStaff(interaction)) {
        return interaction.reply({
          content: "只有管理員或客服可以在時長不足時直接結單。",
          flags: 64,
        });
      }
      const { data: current } = await supabase
        .from(salaryTable)
        .select("*")
        .eq("id", reportId)
        .maybeSingle();
      if (
        !current ||
        (!isClose && current.discord_id !== interaction.user.id)
      ) {
        return interaction.reply({
          content: "這筆工時申報無法操作。",
          flags: 64,
        });
      }
      let meta = {};
      try {
        meta = JSON.parse(current.note || current.admin_note || "{}");
      } catch {}
      const totalMinutes = (meta.segments || []).reduce(
        (sum, segment) => sum + Number(segment.minutes || 0),
        0,
      );
      const expectedMinutes = Number(meta.expectedDurationMinutes || 0);
      const shortageMinutes = Math.max(0, expectedMinutes - totalMinutes);
      const updatePayload =
        appKey === "deepnight"
          ? {
              status: isClose ? "work_pending" : "work_saved",
              is_deleted: !isClose,
              duration_minutes: totalMinutes,
              note: JSON.stringify({
                ...meta,
                shortageMinutes,
                closedEarly: isClose,
              }),
            }
          : {
              status: isClose ? "工時待審核" : "工時已存單",
              is_deleted: !isClose,
              admin_note: JSON.stringify({
                ...meta,
                shortageMinutes,
                closedEarly: isClose,
              }),
            };
      const { data: savedReport, error } = await supabase
        .from(salaryTable)
        .update(updatePayload)
        .eq("id", reportId)
        .in("status", ["work_draft", "工時待填"])
        .select("id")
        .maybeSingle();
      if (error || !savedReport) {
        return interaction.reply({
          content: `操作失敗：${error?.message || "單據狀態已變更，請重新查看"}`,
          flags: 64,
        });
      }
      if (!isClose) {
        await notifyCustomerAboutSavedOrder(
          meta,
          shortageMinutes,
          interaction.channel,
        );
      }
      await interaction.update({
        content: isClose
          ? `已由客服結單，實際工時 ${durationText(totalMinutes)}，已送後台審核。`
          : `已存單，尚差 ${durationText(shortageMinutes)}，系統已通知客戶。`,
        embeds: [buildUpdatedReportEmbed(interaction.message, meta)],
        components: isClose ? [] : [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`work_report_supplement_${reportId}`)
              .setLabel("補單").setStyle(ButtonStyle.Primary),
          ),
        ],
      });
      return true;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("work_report_correct_start_")
    ) {
      const reportId = interaction.customId.replace(
        "work_report_correct_start_",
        "",
      ).split(":")[0];
      const encodedStart = interaction.customId.split(":")[1];
      const now = getTaipeiNowParts();
      const encodedDate = new Date(Number(encodedStart || 0));
      const defaultDateTime =
        encodedStart && Number.isFinite(encodedDate.getTime())
        ? formatTaipeiWorkTimeInput(encodedDate)
        : `${now.year}-${now.month}-${now.day} ${now.hour}:${now.minute}`;
      const modal = new ModalBuilder()
        .setCustomId(`submit_work_report_correct_start_${reportId}`)
        .setTitle("修改第一段開始時間");
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("work_time")
            .setLabel("開始日期時間（台北，限修改一次）")
            .setPlaceholder("2026-07-19 20:30")
            .setValue(defaultDateTime)
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
      );
      await interaction.showModal(modal);
      return true;
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("submit_work_report_correct_start_")
    ) {
      const reportId = interaction.customId.replace(
        "submit_work_report_correct_start_",
        "",
      );
      await interaction.deferReply({ flags: 64 });
      const enteredTime = parseTaipeiWorkTime(
        interaction.fields.getTextInputValue("work_time"),
      );
      if (!enteredTime) {
        return interaction.editReply({
          content:
            "時間格式不正確，請使用 YYYY-MM-DD HH:mm，例如 2026-07-19 20:30；也可只輸入 HH:mm。",
        });
      }
      const { data: current, error: readError } = await supabase
        .from(salaryTable)
        .select("*")
        .eq("id", reportId)
        .maybeSingle();
      if (
        readError ||
        !current ||
        current.discord_id !== interaction.user.id ||
        !["work_draft", "工時待填"].includes(current.status)
      ) {
        return interaction.editReply({
          content: "這筆申報無法修改，可能已送出或不是你的訂單。",
        });
      }
      let meta = {};
      try {
        meta = JSON.parse(current.note || current.admin_note || "{}");
      } catch {}
      if (!canCorrectFirstSegmentStart(meta)) {
        return interaction.editReply({
          content: "第一段開始時間的修改機會已使用，或本段已經結束。",
        });
      }
      const nextMeta = {
        ...meta,
        pendingSegmentStart: enteredTime.toISOString(),
        startedAt: enteredTime.toISOString(),
        startTimeEditCount: 1,
        startTimeEditedBy: interaction.user.id,
        startTimeEditedAt: new Date().toISOString(),
      };
      const updatePayload =
        appKey === "deepnight"
          ? {
              accepted_at: enteredTime.toISOString(),
              note: JSON.stringify(nextMeta),
            }
          : {
              paid_at: enteredTime.toISOString(),
              admin_note: JSON.stringify(nextMeta),
            };
      const { data: updated, error } = await supabase
        .from(salaryTable)
        .update(updatePayload)
        .eq("id", reportId)
        .eq("discord_id", interaction.user.id)
        .in("status", ["work_draft", "工時待填"])
        .select()
        .maybeSingle();
      if (error || !updated) {
        console.error("[工時申報] 修改第一段開始時間失敗", error);
        return interaction.editReply({
          content: `修改開始時間失敗：${error?.message || "單據狀態已變更，請重新整理後再試"}`,
        });
      }
      await interaction.editReply({
        content: `第一段開始時間已修改為 ${formatTaipeiDateTime(enteredTime)}，本次修改機會已使用。`,
      });
      await interaction.message
        ?.edit({
          embeds: [buildUpdatedReportEmbed(interaction.message, nextMeta)],
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`work_report_end_${reportId}`)
                .setLabel("輸入第 1 段結束時間")
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(`work_report_edit_${reportId}`)
                .setLabel("改時長及金額")
                .setStyle(ButtonStyle.Secondary),
            ),
          ],
        })
        .catch(() => {});
      return true;
    }

    if (
      interaction.isButton() &&
      (interaction.customId.startsWith("work_report_start_") ||
        interaction.customId.startsWith("work_report_end_"))
    ) {
      const isStart = interaction.customId.startsWith("work_report_start_");
      const reportId = interaction.customId.replace(
        isStart ? "work_report_start_" : "work_report_end_",
        "",
      );
      // 先回應 Discord 並立即開啟 Modal；報單存在性與狀態在送出時驗證。
      // 避免 Supabase 偶發延遲超過互動期限，造成使用者看到「互動失敗」。
      const modal = new ModalBuilder()
        .setCustomId(
          `submit_work_report_${isStart ? "start" : "end"}_${reportId}`,
        )
        .setTitle(isStart ? "填寫開始時間" : "填寫結束時間");
      const now = getTaipeiNowParts();
      const defaultDateTime = `${now.year}-${now.month}-${now.day} ${now.hour}:${now.minute}`;
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("work_time")
            .setLabel(`${isStart ? "開始" : "結束"}日期時間（台北）`)
            .setPlaceholder(isStart ? "2026-07-19 20:30" : "2026-07-19 22:00")
            .setValue(defaultDateTime)
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
      );
      await interaction.showModal(modal);
      return true;
    }

    if (
      interaction.isModalSubmit() &&
      (interaction.customId.startsWith("submit_work_report_start_") ||
        interaction.customId.startsWith("submit_work_report_end_"))
    ) {
      const isStart = interaction.customId.startsWith(
        "submit_work_report_start_",
      );
      const reportId = interaction.customId.replace(
        isStart ? "submit_work_report_start_" : "submit_work_report_end_",
        "",
      );
      const enteredTime = parseTaipeiWorkTime(
        interaction.fields.getTextInputValue("work_time"),
      );
      if (!enteredTime)
        return interaction.reply({
          content:
            "時間格式不正確，請使用 YYYY-MM-DD HH:mm，例如 2026-07-19 20:30；也可只輸入 HH:mm。",
          flags: 64,
        });
      const { data: current, error: readError } = await supabase
        .from(salaryTable)
        .select("*")
        .eq("id", reportId)
        .maybeSingle();
      if (readError || !current) {
        return interaction.reply({
          content: "讀取工時申報失敗，請稍後再試。",
          flags: 64,
        });
      }
      if (!canEnterWorkReportTime(current, { isEnd: !isStart })) {
        return interaction.reply({
          content: "這筆工時申報已送出或目前不能再填寫時間。",
          flags: 64,
        });
      }
      const meta = parseWorkReportMeta(current);
      const segments = Array.isArray(meta.segments) ? [...meta.segments] : [];
      const segmentStart = isStart
        ? enteredTime
        : new Date(meta.pendingSegmentStart || 0);
      const segmentEnd = isStart ? null : enteredTime;
      if (!isStart && (!segmentStart.getTime() || segmentEnd <= segmentStart)) {
        return interaction.reply({
          content: "請先輸入開始時間，且結束時間必須晚於開始時間。",
          flags: 64,
        });
      }
      if (segmentEnd) {
        segments.push({
          startedAt: segmentStart.toISOString(),
          endedAt: segmentEnd.toISOString(),
          minutes: Math.round((segmentEnd - segmentStart) / 60000),
        });
      }
      const totalMinutes = segments.reduce(
        (sum, segment) => sum + Number(segment.minutes || 0),
        0,
      );
      const expectedMinutes = Number(meta.expectedDurationMinutes || 0);
      const isComplete =
        Boolean(segmentEnd) &&
        (!expectedMinutes || totalMinutes >= expectedMinutes);
      const nextMeta = {
        ...meta,
        segments,
        pendingSegmentStart: isStart ? segmentStart.toISOString() : null,
        startedAt: segments[0]?.startedAt || segmentStart.toISOString(),
        endedAt: segmentEnd?.toISOString() || null,
        durationMinutes: totalMinutes,
      };
      const updatePayload =
        appKey === "deepnight"
          ? {
              accepted_at: nextMeta.startedAt,
              ...(segmentEnd
                ? {
                    completed_at: segmentEnd.toISOString(),
                    order_finished_at: segmentEnd.toISOString(),
                  }
                : {}),
              duration_minutes: totalMinutes || null,
              status: isComplete ? "work_pending" : "work_draft",
              is_deleted: !isComplete,
              note: JSON.stringify(nextMeta),
            }
          : {
              paid_at: nextMeta.startedAt,
              ...(segmentEnd
                ? { order_finished_at: segmentEnd.toISOString() }
                : {}),
              status: isComplete ? "工時待審核" : "工時待填",
              is_deleted: !isComplete,
              admin_note: JSON.stringify(nextMeta),
            };
      const { data, error } = await supabase
        .from(salaryTable)
        .update(updatePayload)
        .eq("id", reportId)
        .eq("status", current.status)
        .select()
        .maybeSingle();
      if (error || !data)
        return interaction.reply({
          content: "申報送出失敗，請稍後再試。",
          flags: 64,
        });
      await interaction.reply({
        content: !segmentEnd
          ? `第 ${segments.length + 1} 段開始時間已儲存，完成後請輸入結束時間。`
          : isComplete
            ? `本段時間已儲存，累積 ${durationText(totalMinutes)}，已送到薪資後台等待審核。`
            : `本段時間已儲存，目前累積 ${durationText(totalMinutes)}，尚不足 ${durationText(expectedMinutes - totalMinutes)}。請選擇繼續報時、存單或由客服結單。`,
        flags: 64,
      });
      const nextComponents = !segmentEnd
        ? [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`work_report_end_${reportId}`)
                .setLabel(`輸入第 ${segments.length + 1} 段結束時間`)
                .setStyle(ButtonStyle.Success),
              ...(canCorrectFirstSegmentStart(nextMeta)
                ? [
                    new ButtonBuilder()
                      .setCustomId(
                        `work_report_correct_start_${reportId}:${new Date(nextMeta.pendingSegmentStart).getTime()}`,
                      )
                      .setLabel("修改開始時間（限 1 次）")
                      .setStyle(ButtonStyle.Primary),
                  ]
                : []),
              new ButtonBuilder()
                .setCustomId(`work_report_edit_${reportId}`)
                .setLabel("改時長及金額")
                .setStyle(ButtonStyle.Secondary),
            ),
          ]
        : isComplete
          ? [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`work_report_add_${reportId}`)
                  .setLabel("新增時長及金額")
                  .setStyle(ButtonStyle.Secondary),
              ),
            ]
          : [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`work_report_start_${reportId}`)
                  .setLabel(`第 ${segments.length + 1} 段報時`)
                  .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                  .setCustomId(`work_report_save_${reportId}`)
                  .setLabel("存單")
                  .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                  .setCustomId(`work_report_close_${reportId}`)
                  .setLabel("結單（客服）")
                  .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                  .setCustomId(`work_report_add_${reportId}`)
                  .setLabel("新增時長及金額")
                  .setStyle(ButtonStyle.Secondary),
              ),
            ];
      await interaction.message
        .edit({
          embeds: [buildUpdatedReportEmbed(interaction.message, nextMeta)],
          components: nextComponents,
        })
        .catch(() => {});
      return true;
    }
    return false;
  }

  return {
    handleInteraction,
    ensureStaffReportChannel,
    startCrownReminderScheduler,
    sendForAcceptedOrder,
    sendForPaidExtension,
    sendForCompletedTipOrders,
    sendManualPanel,
    syncAcceptedOrder,
  };
}

module.exports = {
  buildReportAmounts,
  canCorrectFirstSegmentStart,
  canEnterWorkReportTime,
  buildSavedWorkReportSupplement,
  calculateCrownEndAt,
  createWorkReportSystem,
  isStaffInteraction,
  matchStaffLookup,
  normalizeStaffLookup,
  parseTaipeiWorkTime,
  parseDurationMinutes,
  parseCrownDurationHours,
  parseMoney,
  splitStaffLookupInput,
};
