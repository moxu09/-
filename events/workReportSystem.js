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

function parseUserIds(value) {
  return [...new Set(String(value || "").match(/\d{17,20}/g) || [])];
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

function createWorkReportSystem({
  supabase,
  client,
  appKey,
  guildId,
  manualChannelId,
  staffTable,
  staffRoleId,
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

    await channel.send({
      content: `<@${report.staff_id}> 請填寫這筆服務的開始與結束時間。`,
      embeds: [
        new EmbedBuilder()
          .setColor("#38bdf8")
          .setTitle("訂單工時申報")
          .addFields(
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
          )
          .setDescription("填寫完成後會自動計算時長，並送到薪資後台等待審核。"),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`work_report_time_${report.id}`)
            .setLabel("填寫開始／結束時間")
            .setStyle(ButtonStyle.Primary),
        ),
      ],
    });
  }

  async function createReports(payload, staffIds) {
    const reports = [];
    for (const staffId of staffIds) {
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
      };
      const basePayload = {
        order_id: reportKey,
        discord_id: String(staffId),
        staff_name: staffName,
        customer_name: payload.customerName || payload.customerId || "手動報單",
        service_name: payload.serviceName || "陪玩服務",
        order_amount: Number(payload.orderAmount || 0),
        staff_salary: 0,
        bonus_amount: 0,
        salary_rate: 0,
        platform_income: Number(payload.orderAmount || 0),
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
              price: Number(payload.orderAmount || 0),
              final_price: Number(payload.orderAmount || 0),
              order_type: payload.orderType || "訂單",
              status: "work_draft",
              quote_status: "work_report",
              note: JSON.stringify(reportMeta),
              guild_id: guildId,
            }
          : {
              ...basePayload,
              status: "工時待填",
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
        order_amount: Number(payload.orderAmount || 0),
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
    if (
      recent?.some(
        (message) =>
          message.author.id === client.user.id &&
          message.components.some((row) =>
            row.components.some(
              (item) => item.customId === "open_manual_work_report",
            ),
          ),
      )
    )
      return;
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#f59e0b")
          .setTitle("客服人工報單")
          .setDescription(
            "人工派單請由客服按下方按鈕，填寫訂單資料後送給陪陪申報工時。",
          ),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("open_manual_work_report")
            .setLabel("報單")
            .setStyle(ButtonStyle.Success),
        ),
      ],
    });
  }

  function isStaff(interaction) {
    return (
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
      (staffRoleId && interaction.member?.roles?.cache?.has(staffRoleId))
    );
  }

  async function handleInteraction(interaction) {
    if (
      interaction.isButton() &&
      interaction.customId === "open_manual_work_report"
    ) {
      if (!isStaff(interaction))
        return interaction.reply({
          content: "只有客服或管理員可以報單。",
          flags: 64,
        });
      const modal = new ModalBuilder()
        .setCustomId("submit_manual_work_report")
        .setTitle("客服人工報單");
      const fields = [
        [
          "manual_customer",
          "老闆（@使用者或 Discord ID）",
          TextInputStyle.Short,
        ],
        ["manual_type", "類型（訂單／打賞）", TextInputStyle.Short],
        ["manual_service", "項目", TextInputStyle.Short],
        ["manual_amount", "金額", TextInputStyle.Short],
      ];
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
      interaction.customId === "submit_manual_work_report"
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
      if (!Number.isFinite(amount) || amount <= 0)
        return interaction.reply({
          content: "金額格式不正確。",
          flags: 64,
        });
      const flowId = `${interaction.user.id}_${Date.now()}`;
      pendingManualReports.set(flowId, {
        creatorId: interaction.user.id,
        sourceKind: "manual",
        sourceOrderId: `MANUAL-${Date.now()}`,
        customerId,
        customerName: customerId ? null : customerText,
        orderType: interaction.fields.getTextInputValue("manual_type"),
        serviceName: interaction.fields.getTextInputValue("manual_service"),
        orderAmount: amount,
      });
      setTimeout(() => pendingManualReports.delete(flowId), 15 * 60 * 1000);
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
      if (!pending || pending.creatorId !== interaction.user.id) {
        return interaction.reply({
          content: "這份報單已逾時，請重新填寫。",
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
          content: `已送出 ${pending.selectedStaffIds.length} 位陪陪的填單面板。`,
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
      interaction.customId.startsWith("work_report_time_")
    ) {
      const reportId = interaction.customId.replace("work_report_time_", "");
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
        .setCustomId(`submit_work_report_time_${reportId}`)
        .setTitle("填寫服務時間");
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("work_started_at")
            .setLabel("開始時間（YYYY-MM-DD HH:mm）")
            .setPlaceholder("2026-07-12 20:30")
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("work_ended_at")
            .setLabel("結束時間（YYYY-MM-DD HH:mm）")
            .setPlaceholder("2026-07-12 22:00")
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
      );
      await interaction.showModal(modal);
      return true;
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("submit_work_report_time_")
    ) {
      const reportId = interaction.customId.replace(
        "submit_work_report_time_",
        "",
      );
      const started = parseTaipeiDateTime(
        interaction.fields.getTextInputValue("work_started_at"),
      );
      const ended = parseTaipeiDateTime(
        interaction.fields.getTextInputValue("work_ended_at"),
      );
      if (!started || !ended || ended <= started)
        return interaction.reply({
          content: "時間格式不正確，或結束時間早於開始時間。",
          flags: 64,
        });
      const minutes = Math.round((ended - started) / 60000);
      const { data: current } = await supabase
        .from(salaryTable)
        .select("*")
        .eq("id", reportId)
        .maybeSingle();
      let meta = {};
      try {
        meta = JSON.parse(current?.note || current?.admin_note || "{}");
      } catch {}
      const updatePayload =
        appKey === "deepnight"
          ? {
              accepted_at: started.toISOString(),
              completed_at: ended.toISOString(),
              order_finished_at: ended.toISOString(),
              duration_minutes: minutes,
              status: "work_pending",
              note: JSON.stringify({
                ...meta,
                startedAt: started.toISOString(),
                endedAt: ended.toISOString(),
                durationMinutes: minutes,
              }),
            }
          : {
              paid_at: started.toISOString(),
              order_finished_at: ended.toISOString(),
              status: "工時待審核",
              admin_note: JSON.stringify({
                ...meta,
                startedAt: started.toISOString(),
                endedAt: ended.toISOString(),
                durationMinutes: minutes,
              }),
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
        content: `申報已送到薪資後台等待審核。服務時長：${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分鐘。`,
        flags: 64,
      });
      await interaction.message.edit({ components: [] }).catch(() => {});
      return true;
    }
    return false;
  }

  return { handleInteraction, sendForAcceptedOrder, sendManualPanel };
}

module.exports = { createWorkReportSystem };
