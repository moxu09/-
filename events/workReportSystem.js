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
} = require("discord.js");
const { ORDER_FLOW_TTL_MS } = require("../utils/orderFlow");

function parseUserIds(value) {
  return [...new Set(String(value || "").match(/\d{17,20}/g) || [])];
}

function parseRoleIds(...values) {
  return [
    ...new Set(
      values.flatMap((value) =>
        String(value || "").match(/\d{17,20}/g) || [],
      ),
    ),
  ];
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

function getTaipeiNowParts() {
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
      .formatToParts(new Date())
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function parseTaipeiWorkTime(value) {
  const text = String(value || "").trim();
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}$/.test(text)) {
    return parseTaipeiDateTime(text);
  }
  const matched = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!matched) return null;
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (hour > 23 || minute > 59) return null;
  const now = getTaipeiNowParts();
  return parseTaipeiDateTime(
    `${now.year}-${now.month}-${now.day} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  );
}

function isGiftOrderType(value) {
  return /打賞|禮物|礼物|gift|tip/i.test(String(value || ""));
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
  const baseFields = (embed.data.fields || []).filter(
    (field) =>
      !["預定時長", "累積時長", "報時紀錄", "不足時長"].includes(field.name),
  );
  return embed.setFields(...baseFields, ...timeFields);
}

function createWorkReportSystem({
  supabase,
  client,
  appKey,
  guildId,
  manualChannelId,
  staffTable,
  staffRoleId,
  customerServiceRoleId,
  salaryTable,
}) {
  const pendingManualReports = new Map();
  async function findStaff(discordId) {
    let query = supabase
      .from(staffTable)
      .select("*")
      .eq("discord_id", String(discordId))
      .limit(1);
    if (staffTable === "players") query = query.eq("guild_id", guildId);
    const { data, error } = await query;
    if (error) throw error;
    return data?.[0] || null;
  }

  async function sendReportCard(report, staff) {
    const channelId = staff?.report_channel_id || staff?.salary_channel_id;
    if (!channelId)
      throw new Error(`陪陪 <@${report.staff_id}> 尚未設定個人薪資頻道 ID`);
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased())
      throw new Error(`找不到陪陪 <@${report.staff_id}> 的填單頻道`);

    const isGift = isGiftOrderType(report.order_type);
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
      fields.push(
        {
          name: "預定時長",
          value: report.expected_duration_minutes
            ? durationText(report.expected_duration_minutes)
            : "未設定",
          inline: true,
        },
      );
    }
    const components = isGift
      ? []
      : [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`work_report_start_${report.id}`)
              .setLabel("輸入開始時間")
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(`work_report_end_${report.id}`)
              .setLabel("輸入結束時間")
              .setStyle(ButtonStyle.Success),
          ),
        ];
    await channel.send({
      content: isGift
        ? `<@${report.staff_id}> 你有一筆打賞紀錄，已直接送到薪資後台等待審核。`
        : `<@${report.staff_id}> 請填寫這筆服務的開始與結束時間。`,
      embeds: [
        new EmbedBuilder()
          .setColor(isGift ? "#f59e0b" : "#38bdf8")
          .setTitle(isGift ? "打賞申報" : "訂單工時申報")
          .addFields(...fields)
          .setDescription(
            isGift
              ? "打賞不需填寫時間，客服送出後已同步進入薪資後台審核。"
              : "填寫完成後會自動計算時長，並送到薪資後台等待審核。",
          ),
      ],
      components,
    });
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
        staff_id: String(staffId),
        customer_id: payload.customerId || null,
        customer_name: payload.customerName || null,
        order_type: payload.orderType || "訂單",
        service_name: payload.serviceName || "陪玩服務",
        order_amount: perStaffAmount,
        expected_duration_minutes: Number(payload.expectedDurationMinutes || 0),
      };
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
        orderAmount: order.final_price || order.price || order.order_amount,
        expectedDurationMinutes:
          Number(order.duration_minutes || 0) ||
          parseDurationMinutes(order.duration_text),
      },
      staffIds,
    );
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
          .setDescription(
            "請依類型選擇報單。訂單需填時長，打賞不需填時長。",
          ),
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
      modal.addComponents(
        ...fields.map(([id, label, style]) =>
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId(id)
              .setLabel(label)
              .setStyle(style)
              .setRequired(true),
          ),
        ),
      );
      await interaction.showModal(modal);
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
          content: "一般訂單需要填寫時長，可輸入 2小時、1.5 或 90分鐘；打賞可留空。",
          flags: 64,
        });
      if (durationValue && !expectedDurationMinutes)
        return interaction.reply({
          content: "時長格式不正確，可輸入 2小時、1.5 或 90分鐘。",
          flags: 64,
        });
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
      });
      setTimeout(() => pendingManualReports.delete(flowId), ORDER_FLOW_TTL_MS);
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
              duration_minutes: totalMinutes,
              note: JSON.stringify({
                ...meta,
                shortageMinutes,
                closedEarly: isClose,
              }),
            }
          : {
              status: isClose ? "工時待審核" : "工時已存單",
              admin_note: JSON.stringify({
                ...meta,
                shortageMinutes,
                closedEarly: isClose,
              }),
            };
      const { error } = await supabase
        .from(salaryTable)
        .update(updatePayload)
        .eq("id", reportId)
        .in("status", ["work_draft", "工時待填"]);
      if (error) {
        return interaction.reply({
          content: `操作失敗：${error.message}`,
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
        components: [],
      });
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
      const { data: report } = await supabase
        .from(salaryTable)
        .select("*")
        .eq("id", reportId)
        .maybeSingle();
      if (
        !report ||
        report.discord_id !== interaction.user.id ||
        !["work_draft", "工時待填"].includes(report.status)
      )
        return interaction.reply({
          content: "這筆申報無法填寫，可能已送出或不是你的訂單。",
          flags: 64,
        });
      const modal = new ModalBuilder()
        .setCustomId(
          `submit_work_report_${isStart ? "start" : "end"}_${reportId}`,
        )
        .setTitle(isStart ? "填寫開始時間" : "填寫結束時間");
      const now = getTaipeiNowParts();
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("work_time")
            .setLabel(`${isStart ? "開始" : "結束"}時間（台北當天 HH:mm）`)
            .setPlaceholder(isStart ? "20:30" : "22:00")
            .setValue(`${now.hour}:${now.minute}`)
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
          content: "時間格式不正確，請使用 HH:mm，例如 20:30。",
          flags: 64,
        });
      const { data: current } = await supabase
        .from(salaryTable)
        .select("*")
        .eq("id", reportId)
        .maybeSingle();
      let meta = {};
      try {
        meta = JSON.parse(current?.note || current?.admin_note || "{}");
      } catch {}
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
              note: JSON.stringify(nextMeta),
            }
          : {
              paid_at: nextMeta.startedAt,
              ...(segmentEnd
                ? { order_finished_at: segmentEnd.toISOString() }
                : {}),
              status: isComplete ? "工時待審核" : "工時待填",
              admin_note: JSON.stringify(nextMeta),
            };
      const { data, error } = await supabase
        .from(salaryTable)
        .update(updatePayload)
        .eq("id", reportId)
        .eq("discord_id", interaction.user.id)
        .in("status", ["work_draft", "工時待填"])
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
            ),
          ]
        : isComplete
          ? []
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

  return { handleInteraction, sendForAcceptedOrder, sendManualPanel };
}

module.exports = {
  buildReportAmounts,
  createWorkReportSystem,
  isStaffInteraction,
};
