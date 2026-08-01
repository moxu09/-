const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const PANEL_TITLE = "📮 執行長專屬投訴表單";

function formatTaipeiDateTime(date = new Date()) {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function formatComplaintSender(anonymous, user) {
  if (anonymous) return "匿名（未紀錄發送者）";
  return `<@${user.id}>（${user.tag}｜${user.id}）`;
}

function createComplaintSystem(client, config) {
  let ceoUserId = String(config.ceoUserId || "").trim() || null;

  function buildPanelPayload() {
    const embed = new EmbedBuilder()
      .setColor("#7c3aed")
      .setTitle(PANEL_TITLE)
      .setDescription(
        "此表單的投訴內容只會傳送給執行長本人。\n" +
          "其他管理員、客服及陪陪都看不到投訴內容。\n\n" +
          "• 匿名投訴：不紀錄、不傳送投訴者帳號\n" +
          "• 實名投訴：會附上投訴者 Discord 帳號\n" +
          "• 兩種方式都會記錄送出時間\n\n" +
          "請選擇投訴方式後填寫主旨與詳細內容。",
      )
      .setFooter({ text: "投訴內容不會發布在任何伺服器頻道" });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("complaint_open_anonymous")
        .setLabel("匿名投訴")
        .setEmoji("🕶️")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("complaint_open_named")
        .setLabel("實名投訴")
        .setEmoji("👤")
        .setStyle(ButtonStyle.Primary),
    );
    return { embeds: [embed], components: [row] };
  }

  async function sendPanel() {
    const channel = await client.channels
      .fetch(config.panelChannelId)
      .catch(() => null);
    if (!channel?.isTextBased() || typeof channel.send !== "function") {
      return false;
    }
    if (process.env.GUILD_ID && channel.guildId !== process.env.GUILD_ID) {
      return false;
    }

    ceoUserId ||= channel.guild?.ownerId || null;
    if (!ceoUserId) throw new Error("找不到執行長 Discord ID");

    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    const existing = recent?.find(
      (message) =>
        message.author.id === client.user.id &&
        message.embeds.some((embed) => embed.title === PANEL_TITLE),
    );
    const payload = buildPanelPayload();
    if (existing) {
      await existing.edit(payload);
    } else {
      await channel.send(payload);
    }
    return true;
  }

  function openComplaintModal(interaction, anonymous) {
    const modal = new ModalBuilder()
      .setCustomId(
        anonymous ? "complaint_submit_anonymous" : "complaint_submit_named",
      )
      .setTitle(anonymous ? "匿名投訴" : "實名投訴")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("complaint_subject")
            .setLabel("投訴主旨")
            .setPlaceholder("請簡短說明投訴事項")
            .setMaxLength(100)
            .setRequired(true)
            .setStyle(TextInputStyle.Short),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("complaint_content")
            .setLabel("投訴內容")
            .setPlaceholder("請詳細說明事情經過與需要協助的內容")
            .setMaxLength(3500)
            .setRequired(true)
            .setStyle(TextInputStyle.Paragraph),
        ),
      );
    return interaction.showModal(modal);
  }

  async function submitComplaint(interaction, anonymous) {
    if (!ceoUserId) {
      const channel = await client.channels
        .fetch(config.panelChannelId)
        .catch(() => null);
      ceoUserId = String(config.ceoUserId || channel?.guild?.ownerId || "").trim();
    }
    if (!ceoUserId) {
      return interaction.reply({
        content: "❌ 目前無法確認執行長收件帳號，請稍後再試。",
        flags: 64,
      });
    }

    const subject = interaction.fields
      .getTextInputValue("complaint_subject")
      .trim();
    const content = interaction.fields
      .getTextInputValue("complaint_content")
      .trim();
    const submittedAt = formatTaipeiDateTime();
    const embed = new EmbedBuilder()
      .setColor(anonymous ? "#64748b" : "#2563eb")
      .setTitle(anonymous ? "🕶️ 收到匿名投訴" : "👤 收到實名投訴")
      .setDescription(content)
      .addFields(
        { name: "主旨", value: subject, inline: false },
        {
          name: "投訴者",
          value: formatComplaintSender(anonymous, interaction.user),
          inline: false,
        },
        { name: "送出時間", value: submittedAt, inline: true },
        { name: "處理狀態", value: "⏳ 尚未處理", inline: true },
      )
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("complaint_mark_handled")
        .setLabel("已處理")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("complaint_mark_rejected")
        .setLabel("不予處理")
        .setEmoji("⛔")
        .setStyle(ButtonStyle.Danger),
    );

    try {
      const ceo = await client.users.fetch(ceoUserId);
      await ceo.send({ embeds: [embed], components: [row] });
    } catch (error) {
      console.error("[投訴表單] 私訊執行長失敗", error?.message || error);
      return interaction.reply({
        content: "❌ 投訴傳送失敗，請稍後再試或直接聯繫執行長。",
        flags: 64,
      });
    }

    return interaction.reply({
      content: anonymous
        ? "✅ 匿名投訴已傳送給執行長；系統未紀錄你的帳號。"
        : "✅ 實名投訴已傳送給執行長。",
      flags: 64,
    });
  }

  async function markComplaint(interaction, handled) {
    if (!ceoUserId || interaction.user.id !== ceoUserId) {
      return interaction.reply({
        content: "❌ 只有執行長可以更新投訴處理狀態。",
        flags: 64,
      });
    }
    const oldEmbed = interaction.message.embeds[0];
    if (!oldEmbed) {
      return interaction.reply({ content: "❌ 找不到投訴內容。", flags: 64 });
    }
    const fields = oldEmbed.fields.filter(
      (field) => field.name !== "處理狀態" && field.name !== "處理時間",
    );
    const updatedEmbed = EmbedBuilder.from(oldEmbed)
      .setColor(handled ? "#16a34a" : "#dc2626")
      .setFields(...fields)
      .addFields(
        {
          name: "處理狀態",
          value: handled ? "✅ 已處理" : "⛔ 不予處理",
          inline: true,
        },
        {
          name: "處理時間",
          value: formatTaipeiDateTime(),
          inline: true,
        },
      );
    return interaction.update({ embeds: [updatedEmbed], components: [] });
  }

  async function handleInteraction(interaction) {
    if (interaction.isButton()) {
      if (interaction.customId === "complaint_open_anonymous") {
        await openComplaintModal(interaction, true);
        return true;
      }
      if (interaction.customId === "complaint_open_named") {
        await openComplaintModal(interaction, false);
        return true;
      }
      if (interaction.customId === "complaint_mark_handled") {
        await markComplaint(interaction, true);
        return true;
      }
      if (interaction.customId === "complaint_mark_rejected") {
        await markComplaint(interaction, false);
        return true;
      }
    }
    if (interaction.isModalSubmit()) {
      if (interaction.customId === "complaint_submit_anonymous") {
        await submitComplaint(interaction, true);
        return true;
      }
      if (interaction.customId === "complaint_submit_named") {
        await submitComplaint(interaction, false);
        return true;
      }
    }
    return false;
  }

  return { handleInteraction, sendPanel };
}

module.exports = {
  createComplaintSystem,
  formatComplaintSender,
  formatTaipeiDateTime,
};
