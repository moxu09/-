require('dotenv').config();
const fs = require('fs');
const {
  startDeepNightSalaryReportCron,
  sendDeepNightDailySalaryReports,
} = require("./events/deepNightSalaryReport");
process.on('uncaughtException', err => {
  console.error('[Uncaught Exception]', err);
});
process.on('unhandledRejection', err => {
  console.error('[Unhandled Rejection]', err);
});
const { createClient } = require('@supabase/supabase-js');
const { createAccountingLedger } = require('./utils/accounting');
const {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
  ChannelType
} = require('discord.js');
// ===== 初始化 =====
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { recordAccountingLedger } = createAccountingLedger(supabase, {
  appKey: process.env.ACCOUNTING_APP_KEY || 'deepnight'
});
const STAFF_TABLE =
  process.env.STAFF_TABLE || 'players';

const SALARY_ORDER_TABLE =
  process.env.SALARY_ORDER_TABLE || 'salary_orders';

const CURRENT_GUILD_ID =
  process.env.STAFF_GUILD_ID || process.env.GUILD_ID || null;
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});
function parseAllowedServices(value) {
  if (!value) return [];

  if (Array.isArray(value)) return value;

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {}

    return value
      .split(',')
      .map(v => v.trim())
      .filter(Boolean);
  }

  return [];
}

async function getStaffByDiscordId(discordId) {
  let query = supabase
    .from(STAFF_TABLE)
    .select('*')
    .eq('discord_id', discordId);

  if (CURRENT_GUILD_ID) {
    query = query.eq('guild_id', CURRENT_GUILD_ID);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    console.error('[深夜薪資] 讀取員工失敗', error);
    return null;
  }

  return data;
}

async function listActiveStaff() {
  const tableName = process.env.SALARY_STAFF_TABLE || 'players';

  let { data, error } = await supabase
    .from(tableName)
    .select('*')
    .not('discord_id', 'is', null);

  if (error) {
    console.error('[讀取員工清單失敗]', error);

    if (tableName !== 'players') {
      const fallback = await supabase
        .from('players')
        .select('*')
        .not('discord_id', 'is', null);

      if (fallback.error) {
        console.error('[讀取 players 備援員工清單失敗]', fallback.error);
        return [];
      }

      data = fallback.data || [];
    } else {
      return [];
    }
  }

  return (data || []).filter(staff => {
    if (!staff.discord_id) return false;
    if (staff.is_active === false) return false;
    if (staff.can_take_order === false) return false;

    return true;
  });
}

async function listStaffByService(serviceKey) {
  const staffList = await listActiveStaff();

  return staffList.filter(staff => {
    if (staff.is_active === false) return false;

    const services = parseAllowedServices(staff.allowed_services);

    if (!serviceKey) return true;

    return (
      services.includes(serviceKey) ||
      services.includes('all') ||
      services.includes('ALL')
    );
  });
}
// ===== 陪玩排單系統 =====
const dispatchSystem = require('./events/dispatchSystem');

dispatchSystem.setup(supabase, client, {
  payOrderByWallet,
  payOrderByMonthly,
  sendWalletLog,
  getUser,
  checkAndUpgradeVip,
  changeCoins,
  recordAccountingLedger,
  startTipFlowInChannel,
  countOrderVipSpentOnce
});
// ===== 轉帳冷卻 =====
const transferCooldown =
  new Map();
// ===== 訂單系統設定 =====
const ORDER_CHANNEL=
  process.env.ORDER_CHANNEL;
const STAFF_ROLE =
  process.env.STAFF_ROLE;
// ===== 全域狀態 =====
const claimedDrops = new Set();
const dropCooldown = new Map();
const orderPayments = new Map();
const pendingTips = new Map();
const pendingTopups = new Map();
const pendingChannelDeletes = new Map();
const TIP_GIFTS = [
  {
    key: 'tip_30',
    name: '薯條',
    price: 30,
    description: '30 ASD'
  },
  {
    key: 'tip_45',
    name: '雞米花',
    price: 45,
    description: '45 ASD'
  },
  {
    key: 'tip_50',
    name: '洋蔥圈',
    price: 50,
    description: '50 ASD'
  },
  {
    key: 'tip_100',
    name: '雞排',
    price: 100,
    description: '100 ASD'
  },
  {
    key: 'tip_250',
    name: '天婦羅套餐',
    price: 250,
    description: '250 ASD'
  },
  {
    key: 'tip_380',
    name: '咬你一口蛋糕',
    price: 380,
    description: '380 ASD'
  },
  {
    key: 'tip_520',
    name: '黑森林蛋糕',
    price: 520,
    description: '520 ASD'
  },
  {
    key: 'tip_666',
    name: '漂白洗刷套餐',
    price: 666,
    description: '666 ASD'
  },
  {
    key: 'tip_888',
    name: '水蜜桃禮盒',
    price: 888,
    description: '888 ASD'
  },
  {
    key: 'tip_1688',
    name: '滿滿的愛',
    price: 1688,
    description: '1688 ASD｜可全體廣播'
  },
  {
    key: 'tip_1999',
    name: '明燈千里',
    price: 1999,
    description: '1999 ASD｜可全體廣播，冠名三天，陪陪專屬語音感謝'
  },
  {
    key: 'tip_16888',
    name: '明燈三千盞',
    price: 16888,
    description: '16888 ASD｜詳情請詢問客服'
  }
];

function getTipGiftByKey(key) {
  return TIP_GIFTS.find(gift => gift.key === key);
}
function getTipStaffIds(tipData = {}) {
  const rawIds =
    Array.isArray(tipData.selectedStaffIds)
      ? tipData.selectedStaffIds
      : [tipData.selectedStaffId];

  return [
    ...new Set(
      rawIds
        .map(id => String(id || '').trim())
        .filter(Boolean)
    )
  ];
}
function formatTipStaffMentions(staffIds = []) {
  return staffIds
    .map(staffId => `<@${staffId}>`)
    .join('、');
}
function getTipTotalAmount(amount, staffIds = []) {
  return Number(amount || 0) * Math.max(staffIds.length, 1);
}
async function saveTipToPlayOrdersForStaff({
  guildId,
  tipperId,
  staffIds,
  item,
  amount,
  channelId,
  paid = true,
  countReason = null
}) {
  const orders = [];

  for (const staffId of staffIds) {
    const tipOrder =
      await saveTipToPlayOrders({
        guildId,
        tipperId,
        staffId,
        item,
        amount: Number(amount),
        channelId,
        paid
      });

    orders.push(tipOrder);

    if (countReason) {
      await countOrderVipSpentOnce(tipOrder, countReason);
    }
  }

  return orders;
}
function getTipStaffSelectionContent(tipData = {}) {
  const staffIds =
    getTipStaffIds(tipData);

  if (!staffIds.length) {
    return (
      '目前尚未選擇受賞陪陪。\n' +
      '可以從上方任一個選單選擇陪陪，選完請按「選好了，下一步」。'
    );
  }

  return (
    `目前已選擇：${formatTipStaffMentions(staffIds)}\n` +
    '可以繼續從上方其他選單加入陪陪，選完請按「選好了，下一步」。'
  );
}
function buildTipStaffSelectionRow(tipId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`tip_staff_done_${tipId}`)
        .setLabel('選好了，下一步')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`tip_staff_clear_${tipId}`)
        .setLabel('清空已選')
        .setStyle(ButtonStyle.Secondary)
    );
}
async function sendTipStaffSelectionStatus(channel, tipId, tipData) {
  const message =
    await channel.send({
      content: getTipStaffSelectionContent(tipData),
      components: [buildTipStaffSelectionRow(tipId)]
    });

  tipData.staffSelectionMessageId = message.id;
  pendingTips.set(tipId, tipData);
}
async function updateTipStaffSelectionStatus(channel, tipId, tipData) {
  const payload = {
    content: getTipStaffSelectionContent(tipData),
    components: [buildTipStaffSelectionRow(tipId)]
  };

  if (tipData.staffSelectionMessageId) {
    const message =
      await channel.messages
        .fetch(tipData.staffSelectionMessageId)
        .catch(() => null);

    if (message) {
      await message.edit(payload);
      return;
    }
  }

  await sendTipStaffSelectionStatus(channel, tipId, tipData);
}
function buildTipPaymentMenu(tipId) {
  return new StringSelectMenuBuilder()
    .setCustomId(`tip_payment_${tipId}`)
    .setPlaceholder('請選擇付款方式')
    .addOptions([
      {
        label: '匯款 / 轉帳',
        description: '顯示銀行帳號，付款後上傳截圖',
        value: '匯款'
      },
      {
        label: '無卡',
        description: '顯示無卡帳號，付款後上傳截圖',
        value: '無卡'
      },
      {
        label: '刷卡',
        description: '顯示刷卡付款連結，付款後上傳截圖',
        value: '刷卡'
      },
      {
        label: '儲值卡 / 錢包',
        description: '直接使用 ASD 餘額扣款',
        value: '儲值卡'
      },
      {
        label: '美金轉帳',
        description: '請等待客服提供帳號',
        value: '美金轉帳'
      },
      {
        label: '加密貨幣',
        description: '請等待客服提供錢包地址',
        value: '加密貨幣'
      }
    ]);
}
async function sendTipPaymentSelectPrompt(channel, tipId, selectedStaffText) {
  const row =
    new ActionRowBuilder()
      .addComponents(buildTipPaymentMenu(tipId));

  await channel.send({
    content:
      `✅ 已選擇受賞陪陪：${selectedStaffText}\n\n` +
      `請選擇付款方式：`,
    components: [row]
  });
}
function buildBulkDeleteChannelSelect(deleteId) {
  return new ActionRowBuilder()
    .addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`bulk_delete_channels_${deleteId}`)
        .setPlaceholder('選擇要刪除的頻道，可多選')
        .setMinValues(1)
        .setMaxValues(25)
        .setChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.GuildForum
        )
    );
}
function buildBulkDeleteConfirmRow(deleteId) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`bulk_delete_confirm_${deleteId}`)
        .setLabel('確認刪除')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`bulk_delete_cancel_${deleteId}`)
        .setLabel('取消')
        .setStyle(ButtonStyle.Secondary)
    );
}
async function formatBulkDeleteChannelList(guild, channelIds = []) {
  const lines = [];

  for (const channelId of channelIds) {
    const channel =
      await guild.channels
        .fetch(channelId)
        .catch(() => null);

    lines.push(
      channel
        ? `<#${channel.id}>｜${channel.name}`
        : `找不到頻道｜${channelId}`
    );
  }

  return lines.join('\n');
}
async function handleBulkDeleteChannelsCommand(interaction) {
  if (!isAdminOrStaff(interaction)) {
    return interaction.editReply({
      content: '❌ 只有客服或管理員可以使用這個指令'
    });
  }

  const deleteId =
    `${interaction.user.id}_${Date.now()}`;

  pendingChannelDeletes.set(deleteId, {
    createdBy: interaction.user.id,
    channelIds: [],
    createdAt: Date.now()
  });

  setTimeout(() => {
    pendingChannelDeletes.delete(deleteId);
  }, 10 * 60 * 1000);

  return interaction.editReply({
    content:
      '請選擇要刪除的頻道。\n' +
      '選完後會先顯示確認清單，不會直接刪除。',
    components: [
      buildBulkDeleteChannelSelect(deleteId),
      buildBulkDeleteConfirmRow(deleteId)
    ]
  });
}
async function handleBulkDeleteChannelSelect(interaction) {
  const deleteId =
    interaction.customId.replace('bulk_delete_channels_', '');
  const deleteData =
    pendingChannelDeletes.get(deleteId);

  if (!deleteData) {
    return interaction.reply({
      content: '❌ 這次批量刪除操作已過期，請重新使用指令。',
      flags: 64
    });
  }

  if (interaction.user.id !== deleteData.createdBy) {
    return interaction.reply({
      content: '❌ 只有建立這次操作的人可以選擇頻道。',
      flags: 64
    });
  }

  const channelIds =
    [
      ...new Set(
        interaction.values
          .map(id => String(id || '').trim())
          .filter(Boolean)
      )
    ];

  deleteData.channelIds = channelIds;
  pendingChannelDeletes.set(deleteId, deleteData);

  const listText =
    await formatBulkDeleteChannelList(interaction.guild, channelIds);

  return interaction.update({
    content:
      `已選擇 ${channelIds.length} 個頻道，確認後會刪除：\n\n` +
      `${listText}`,
    components: [
      buildBulkDeleteChannelSelect(deleteId),
      buildBulkDeleteConfirmRow(deleteId)
    ]
  });
}
async function handleBulkDeleteConfirm(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: 64 });
  }

  const deleteId =
    interaction.customId.replace('bulk_delete_confirm_', '');
  const deleteData =
    pendingChannelDeletes.get(deleteId);

  if (!deleteData) {
    return interaction.editReply({
      content: '❌ 這次批量刪除操作已過期，請重新使用指令。'
    });
  }

  if (interaction.user.id !== deleteData.createdBy) {
    return interaction.editReply({
      content: '❌ 只有建立這次操作的人可以確認刪除。'
    });
  }

  if (!isAdminOrStaff(interaction)) {
    return interaction.editReply({
      content: '❌ 只有客服或管理員可以確認刪除'
    });
  }

  const channelIds =
    [
      ...new Set(deleteData.channelIds || [])
    ];

  if (!channelIds.length) {
    return interaction.editReply({
      content: '❌ 尚未選擇任何頻道'
    });
  }

  await interaction.message.edit({
    components: []
  }).catch(() => {});

  const deleted = [];
  const failed = [];

  for (const channelId of channelIds) {
    const channel =
      await interaction.guild.channels
        .fetch(channelId)
        .catch(() => null);

    if (!channel) {
      failed.push(`找不到頻道｜${channelId}`);
      continue;
    }

    const label =
      `${channel.name}｜${channel.id}`;

    if (!channel.deletable) {
      failed.push(`${label}：機器人沒有權限刪除`);
      continue;
    }

    try {
      await channel.delete(
        `批量刪除頻道｜${interaction.user.tag} (${interaction.user.id})`
      );
      deleted.push(label);
    } catch (error) {
      failed.push(`${label}：${error.message || error}`);
    }
  }

  pendingChannelDeletes.delete(deleteId);

  const deletedText =
    deleted.length
      ? deleted.map(item => `✅ ${item}`).join('\n')
      : '無';
  const failedText =
    failed.length
      ? failed.map(item => `❌ ${item}`).join('\n')
      : '無';

  return interaction.editReply({
    content:
      `批量刪除完成。\n\n` +
      `成功刪除：${deleted.length}\n${deletedText}\n\n` +
      `刪除失敗：${failed.length}\n${failedText}`
  });
}
async function handleBulkDeleteCancel(interaction) {
  const deleteId =
    interaction.customId.replace('bulk_delete_cancel_', '');
  const deleteData =
    pendingChannelDeletes.get(deleteId);

  if (deleteData && interaction.user.id !== deleteData.createdBy) {
    return interaction.reply({
      content: '❌ 只有建立這次操作的人可以取消。',
      flags: 64
    });
  }

  pendingChannelDeletes.delete(deleteId);

  return interaction.update({
    content: '✅ 已取消批量刪除頻道',
    components: []
  });
}
async function sendTipGiftSelect(channel, tipId) {
  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(`tip_gift_${tipId}`)
      .setPlaceholder('請選擇要打賞的禮物')
      .addOptions(
        TIP_GIFTS.slice(0, 25).map(gift => ({
          label: `${gift.name}｜${gift.price} ASD`.slice(0, 100),
          description: gift.description.slice(0, 100),
          value: gift.key
        }))
      );

  const selectRow =
    new ActionRowBuilder()
      .addComponents(menu);

  const cancelRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('owner_cancel_ticket')
          .setLabel('我按錯了，關閉頻道')
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger)
      );

  await channel.send({
    content:
      `💝 請選擇要打賞的禮物：`,
    components: [selectRow, cancelRow]
  });
}
async function startTipFlowInChannel(channel, user) {
  const tipId =
    `${user.id}_${Date.now()}`;

  pendingTips.set(tipId, {
    createdBy: user.id,
    tipperId: user.id,
    channelId: channel.id
  });

  setTimeout(() => {
    const currentTip =
      pendingTips.get(tipId);
    if (currentTip?.keepForPayment) return;

    pendingTips.delete(tipId);
  }, 30 * 60 * 1000);

  await sendTipGiftSelect(channel, tipId);

  return tipId;
}
async function handleTipGiftSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }

  const tipId =
    interaction.customId.replace('tip_gift_', '');

  const tipData =
    pendingTips.get(tipId);

  if (!tipData) {
    return interaction.editReply({
      content: '❌ 這筆打賞流程已過期，請重新建立打賞頻道。'
    });
  }

  if (interaction.user.id !== tipData.createdBy) {
    return interaction.editReply({
      content: '❌ 只有建立這筆打賞的人可以操作。'
    });
  }

  const gift =
    getTipGiftByKey(interaction.values[0]);

  if (!gift) {
    return interaction.editReply({
      content: '❌ 找不到這個打賞禮物。'
    });
  }

  tipData.item = gift.name;
  tipData.amount = gift.price;
  pendingTips.set(tipId, tipData);

  const players = await listActiveStaff();

  const seenPlayerIds = new Set();
  const playerOptions =
    (players || [])
      .filter(player => player.discord_id)
      .filter(player => {
        const id = String(player.discord_id).trim();
        if (!id) return false;
        if (seenPlayerIds.has(id)) {
          return false;
        }
        seenPlayerIds.add(id);
        return true;
      })
      .map(player => {
        const statusText =
          player.status === 'available'
            ? '在線'
            : '離線 / 未接單';
        return {
          label: `${player.display_name || player.real_name || player.discord_name || player.name || player.discord_id}`.slice(0, 100),
          description: `${statusText}｜都可以打賞`.slice(0, 100),
          value: String(player.discord_id)
        };
      });
  if (!playerOptions.length) {
    return interaction.editReply({
      content: '❌ 目前沒有可選擇的陪陪資料。'
    });
  }
  const rows = [];
  for (let i = 0; i < playerOptions.length; i += 25) {
    const page =
      Math.floor(i / 25) + 1;
    const group =
      playerOptions.slice(i, i + 25);
    const menu =
      new StringSelectMenuBuilder()
        .setCustomId(`tip_staff_${tipId}_page_${page}`)
        .setPlaceholder(`請選擇要打賞的陪陪，可複選｜第 ${page} 頁`)
        .setMinValues(1)
        .setMaxValues(group.length)
        .addOptions(group);
    rows.push(
      new ActionRowBuilder()
        .addComponents(menu)
    );
  }
  await interaction.channel.send({
    content:
      `✅ 已選擇禮物：${gift.name}｜${gift.price} ASD\n\n` +
      `請選擇要打賞的陪陪：`,
    components: rows.slice(0, 5)
  });
  await sendTipStaffSelectionStatus(interaction.channel, tipId, tipData);
  return interaction.editReply({
    content: '✅ 已選擇打賞禮物'
  });
}
async function handleTipStaffSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }

  const rawTipId =
    interaction.customId.replace('tip_staff_', '');
  const tipId =
    rawTipId.includes('_page_')
      ? rawTipId.split('_page_')[0]
      : rawTipId;
  const tipData =
    pendingTips.get(tipId);

  if (!tipData) {
    return interaction.editReply({
      content: '❌ 這筆打賞流程已過期，請重新建立打賞頻道。'
    });
  }

  if (interaction.user.id !== tipData.createdBy) {
    return interaction.editReply({
      content: '❌ 只有建立這筆打賞的人可以操作。'
    });
  }

  if (tipData.staffSelectionCompleted) {
    return interaction.editReply({
      content: '✅ 已進入付款方式選擇，若要更換陪陪請重新建立打賞流程。'
    });
  }

  const incomingStaffIds =
    [
      ...new Set(
        interaction.values
          .map(id => String(id || '').trim())
          .filter(Boolean)
      )
    ];
  const selectedStaffIds =
    [
      ...new Set([
        ...getTipStaffIds(tipData),
        ...incomingStaffIds
      ])
    ];
  const selectedStaffText =
    formatTipStaffMentions(selectedStaffIds);

  tipData.selectedStaffId = selectedStaffIds[0];
  tipData.selectedStaffIds = selectedStaffIds;
  pendingTips.set(tipId, tipData);

  await updateTipStaffSelectionStatus(interaction.channel, tipId, tipData);

  return interaction.editReply({
    content:
      `✅ 已加入：${formatTipStaffMentions(incomingStaffIds)}\n` +
      `目前已選：${selectedStaffText}`
  });
}

async function handleTipStaffDone(interaction) {
  const tipId =
    interaction.customId.replace('tip_staff_done_', '');
  const tipData =
    pendingTips.get(tipId);

  if (!tipData) {
    return interaction.editReply({
      content: '❌ 這筆打賞流程已過期，請重新建立打賞頻道。'
    });
  }

  if (interaction.user.id !== tipData.createdBy) {
    return interaction.editReply({
      content: '❌ 只有建立這筆打賞的人可以操作。'
    });
  }

  const selectedStaffIds =
    getTipStaffIds(tipData);

  if (!selectedStaffIds.length) {
    return interaction.editReply({
      content: '❌ 請至少先選擇一位受賞陪陪。'
    });
  }

  const selectedStaffText =
    formatTipStaffMentions(selectedStaffIds);

  tipData.staffSelectionCompleted = true;
  pendingTips.set(tipId, tipData);

  await interaction.message.edit({
    content: `✅ 已選擇受賞陪陪：${selectedStaffText}`,
    components: []
  }).catch(() => {});

  await sendTipPaymentSelectPrompt(
    interaction.channel,
    tipId,
    selectedStaffText
  );

  return interaction.editReply({
    content: '✅ 已進入付款方式選擇'
  });
}

async function handleTipStaffClear(interaction) {
  const tipId =
    interaction.customId.replace('tip_staff_clear_', '');
  const tipData =
    pendingTips.get(tipId);

  if (!tipData) {
    return interaction.editReply({
      content: '❌ 這筆打賞流程已過期，請重新建立打賞頻道。'
    });
  }

  if (interaction.user.id !== tipData.createdBy) {
    return interaction.editReply({
      content: '❌ 只有建立這筆打賞的人可以操作。'
    });
  }

  if (tipData.staffSelectionCompleted) {
    return interaction.editReply({
      content: '✅ 已進入付款方式選擇，若要更換陪陪請重新建立打賞流程。'
    });
  }

  tipData.selectedStaffId = null;
  tipData.selectedStaffIds = [];
  pendingTips.set(tipId, tipData);

  await updateTipStaffSelectionStatus(
    interaction.channel,
    tipId,
    tipData
  );

  return interaction.editReply({
    content: '✅ 已清空受賞陪陪名單'
  });
}

async function handleTipPaymentSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }

  const tipId =
    interaction.customId.replace('tip_payment_', '');

  const tipData =
    pendingTips.get(tipId);

  if (!tipData) {
    return interaction.editReply({
      content: '❌ 這筆打賞流程已過期，請重新建立打賞頻道。'
    });
  }

  if (interaction.user.id !== tipData.createdBy) {
    return interaction.editReply({
      content: '❌ 只有建立這筆打賞的人可以操作。'
    });
  }

  const paymentMethod =
    interaction.values[0];

  const {
    tipperId,
    item,
    amount
  } = tipData;
  const selectedStaffIds =
    getTipStaffIds(tipData);
  const selectedStaffText =
    formatTipStaffMentions(selectedStaffIds);
  const totalAmount =
    getTipTotalAmount(amount, selectedStaffIds);

  if (!selectedStaffIds.length || !item || !amount) {
    return interaction.editReply({
      content: '❌ 打賞資料不完整，請重新建立打賞流程。'
    });
  }

  tipData.paymentMethod = paymentMethod;
  pendingTips.set(tipId, tipData);

  const walletPayment =
    paymentMethod.includes('儲值卡') ||
    paymentMethod.includes('儲值') ||
    paymentMethod.includes('錢包') ||
    paymentMethod.includes('餘額');

  tipData.keepForPayment = !walletPayment;
  pendingTips.set(tipId, tipData);

  if (walletPayment) {
    const row =
      new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`confirm_tip_wallet_${tipId}`)
            .setLabel('確認使用儲值卡付款')
            .setEmoji('💳')
            .setStyle(ButtonStyle.Success),

          new ButtonBuilder()
            .setCustomId(`cancel_tip_wallet_${tipId}`)
            .setLabel('取消此付款方式')
            .setStyle(ButtonStyle.Danger)
        );

    await interaction.channel.send({
      content: `<@${tipperId}>`,
      embeds: [
        new EmbedBuilder()
          .setColor('#ffd166')
          .setTitle('💳 確認打賞儲值卡付款')
          .setDescription(
            `請確認是否使用儲值卡 / 錢包完成打賞。\n\n` +
            `受賞陪陪：${selectedStaffText}\n` +
            `品項：${item}\n` +
            `每位金額：${Number(amount).toLocaleString('zh-TW')} ASD\n` +
            `總扣款金額：${Number(totalAmount).toLocaleString('zh-TW')} ASD\n\n` +
            `確認後會直接從你的 ASD 餘額扣款。`
          )
          .setTimestamp()
      ],
      components: [row]
    });

    return interaction.editReply({
      content: '✅ 已選擇儲值卡付款，請確認是否使用此付款方式。'
    });
  }

  const embed =
    new EmbedBuilder()
      .setColor('#ff99cc')
      .setTitle('💝 打賞需求')
      .addFields(
        {
          name: '打賞人',
          value: `<@${tipperId}>`,
          inline: true
        },
        {
          name: '受賞陪陪',
          value: selectedStaffText,
          inline: true
        },
        {
          name: '品項',
          value: item,
          inline: true
        },
        {
          name: '每位金額',
          value: `NT$${amount}`,
          inline: true
        },
        {
          name: '總金額',
          value: `NT$${totalAmount}`,
          inline: true
        },
        {
          name: '付款方式',
          value: paymentMethod,
          inline: true
        },
        {
          name: '付款狀態',
          value: '等待客服確認付款',
          inline: false
        }
      )
      .setTimestamp();

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `confirm_tip_paid_flow_${tipId}`
          )
          .setLabel('✅ 確認打賞付款')
          .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
          .setCustomId(
            `cancel_tip_flow_${tipId}`
          )
          .setLabel('❌ 取消打賞')
          .setStyle(ButtonStyle.Danger)
      );

  await interaction.channel.send({
    content:
      `<@&${process.env.STAFF_ROLE}> 有新的打賞等待確認付款。`,
    embeds: [embed],
    components: [row]
  });

  if (isCardPayment(paymentMethod)) {
    await sendCardPaymentInfo(interaction.channel);
  } else if (isNoCardPayment(paymentMethod)) {
    await sendNoCardPaymentInfo(interaction.channel);
  } else if (isBankTransfer(paymentMethod)) {
    await sendBankTransferInfo(interaction.channel);
  } else if (
    paymentMethod.includes('美金') ||
    paymentMethod.includes('加密貨幣')
  ) {
    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor('#ffaa00')
          .setTitle('💳 特殊付款方式')
          .setDescription(
            `<@${tipperId}> 你選擇了：${paymentMethod}\n\n` +
            `請等待客服提供付款帳號 / 錢包地址。\n` +
            `付款完成後請上傳付款截圖，等待客服確認。`
          )
          .setTimestamp()
      ]
    });
  }

  return interaction.editReply({
    content: `✅ 已建立打賞需求，付款方式：${paymentMethod}`
  });
}
// ===== Panel Message =====
async function getPanelMessage(panelName, guildId = process.env.GUILD_ID) {
  const { data, error } = await supabase
    .from('panel_messages')
    .select('*')
    .eq('guild_id', guildId)
    .eq('panel_name', panelName)
    .maybeSingle();

  if (error) {
    console.error('[Panel] 讀取失敗', error);
  }

  return data;
}
async function savePanelMessage(
  panelName,
  channelId,
  messageId,
  guildId = process.env.GUILD_ID
) {
  if (!channelId || !messageId) {
    console.warn('[Panel] skip save - missing data', {
      panelName,
      channelId,
      messageId,
      guildId
    });
    return;
  }

  const res = await supabase
    .from('panel_messages')
    .upsert(
      {
        guild_id: guildId,
        panel_name: panelName,
        channel_id: channelId,
        message_id: messageId
      },
      {
        onConflict: 'guild_id,panel_name'
      }
    );

  if (res.error) {
    console.error('[Panel] 儲存失敗', res.error);
  }
} 
// ===== 工具函數 =====
function getGuildId(interaction = null) {
  return interaction?.guildId || interaction?.guild?.id || process.env.GUILD_ID;
}
function getStaffGuildId() {
  return (
    process.env.STAFF_GUILD_ID ||
    process.env.GUILD_ID
  );
}
function getRarityEmoji(rarity) {
  switch (rarity) {
    case 'SSR':
      return '🌈';
    case 'SR':
      return '⭐';
    case 'R':
      return '🔹';
    default:
      return '📦';
  }
}
function getShopRoleId(itemName) {
  if (itemName.includes('小夜燈')) {
    return process.env.SMALL_LIGHT_VIP_ROLE_ID;
  }
  if (itemName.includes('星光燈')) {
    return process.env.STAR_LIGHT_VIP_ROLE_ID;
  }
  if (itemName.includes('永夜燈')) {
    return process.env.ETERNAL_LIGHT_VIP_ROLE_ID;
  }
  return null;
}
// ===== VIP 折扣 =====
async function getVipDiscount(interaction) {

  const member =
    await interaction.guild.members
      .fetch(interaction.user.id)
      .catch(() => null);

  if (!member) return 1;

  const roles =
    member.roles.cache;

  // ===== 9折 =====
  const has90 =
    roles.has(process.env.ETERNAL_LIGHT_VIP_ROLE_ID) ||
    roles.has(process.env.GROWTH_VVIP_ROLE_ID);

  if (has90) {
    return 0.9;
  }

  // ===== 95折 =====
  const has95 =
    roles.has(process.env.STAR_LIGHT_VIP_ROLE_ID) ||
    roles.has(process.env.GROWTH_VIP_ROLE_ID) ||
    roles.has(process.env.GROWTH_VIP_PLUS_ROLE_ID);

  if (has95) {
    return 0.95;
  }

  return 1;
}
async function giveShopRole(interaction, userId, itemName) {
  const roleId =
    getShopRoleId(itemName);
  if (!roleId) return;
  const member =
    await interaction.guild.members
      .fetch(userId)
      .catch(() => null);
  if (!member) return;
  await member.roles
    .add(roleId)
    .catch(err => {
      console.log('[商店身分組發放失敗]', err);
    });
}
async function giveMonthlyVip(
  interaction,
  userId,
  itemName
) {
  const roleId =
    getShopRoleId(itemName);
  if (!roleId) return;
  const member =
    await interaction.guild.members
      .fetch(userId)
      .catch(() => null);
  if (!member) return;
  await member.roles.add(roleId);
  const expiresAt =
    new Date(
      Date.now() +
      30 * 24 * 60 * 60 * 1000
    );
  await supabase
    .from('monthly_vips')
    .upsert({
      user_id: userId,
      role_id: roleId,
      vip_type: itemName,
      expires_at: expiresAt.toISOString()
    });
}
function getManualCommissionRate(tier) {
  if (tier === 'rate_80') return 80;
  if (tier === 'rate_85') return 85;
  if (tier === 'rate_90') return 90;
  if (tier === 'manager_95') return 95;

  return null;
}

function getTaipeiDate(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000);
}

function getTaipeiMonthText(date = new Date()) {
  const taipeiDate = getTaipeiDate(date);
  return taipeiDate.toISOString().slice(0, 7);
}

function getTaipeiYearText(date = new Date()) {
  const taipeiDate = getTaipeiDate(date);
  return taipeiDate.toISOString().slice(0, 4);
}

function getNextMonthTextFromIso(isoText) {
  const date = new Date(isoText);
  const taipeiDate = getTaipeiDate(date);

  const year = taipeiDate.getUTCFullYear();
  const month = taipeiDate.getUTCMonth();

  const next = new Date(Date.UTC(year, month + 1, 1));

  return next.toISOString().slice(0, 7);
}

async function getFirstReachOrderAmountDate(discordId, targetAmount) {
  const { data, error } = await supabase
    .from(SALARY_ORDER_TABLE)
    .select('order_amount, order_finished_at')
    .eq('discord_id', String(discordId))
    .or('is_deleted.eq.false,is_deleted.is.null')
    .order('order_finished_at', { ascending: true });

  if (error) {
    console.error('[抽成計算] 讀取累積接單金額失敗:', error);
    return null;
  }

  let total = 0;

  for (const order of data || []) {
    total += Number(order.order_amount || 0);

    if (total >= targetAmount) {
      return order.order_finished_at;
    }
  }

  return null;
}

async function getPreviousYearSalaryTotal(discordId, finishedAt) {
  const year = Number(getTaipeiYearText(new Date(finishedAt)));
  const previousYear = year - 1;

  const start = new Date(`${previousYear}-01-01T00:00:00+08:00`).toISOString();
  const end = new Date(`${previousYear}-12-31T23:59:59.999+08:00`).toISOString();

  const { data, error } = await supabase
    .from(SALARY_ORDER_TABLE)
    .select('staff_salary')
    .eq('discord_id', String(discordId))
    .or('is_deleted.eq.false,is_deleted.is.null')
    .gte('order_finished_at', start)
    .lte('order_finished_at', end);

  if (error) {
    console.error('[抽成計算] 讀取去年薪資失敗:', error);
    return 0;
  }

  return (data || []).reduce(
    (sum, order) => sum + Number(order.staff_salary || 0),
    0
  );
}

async function getDeepNightCommissionInfo(discordId, finishedAt = new Date().toISOString()) {
  const finishedDate = new Date(finishedAt);
  const openingEnd = new Date('2026-09-01T00:00:00+08:00');

  // 2026/9/1 前，全部固定 90%
  if (finishedDate < openingEnd) {
    return {
      rate: 90,
      level: '開幕期固定 90%'
    };
  }

  const staff = await getStaffByDiscordId(discordId);

  const manualRate =
    getManualCommissionRate(staff?.commission_tier);

  // 九月後，後台有手動設定就優先用手動設定
  if (manualRate) {
    return {
      rate: manualRate,
      level:
        manualRate === 95
          ? '主管津貼 95%'
          : `後台設定 ${manualRate}%`
    };
  }

  // 去年薪資滿 100,000，隔年整年 90%
  const previousYearSalary =
    await getPreviousYearSalaryTotal(discordId, finishedAt);

  if (previousYearSalary >= 100000) {
    return {
      rate: 90,
      level: '年度薪資達標｜隔年 90%'
    };
  }

  // 歷史接單金額滿 10,000，達標的下個月開始 85%
  const firstReach10kDate =
    await getFirstReachOrderAmountDate(discordId, 10000);

  if (firstReach10kDate) {
    const reachNextMonth =
      getNextMonthTextFromIso(firstReach10kDate);

    const orderMonth =
      getTaipeiMonthText(new Date(finishedAt));

    if (orderMonth >= reachNextMonth) {
      return {
        rate: 85,
        level: '累積接單滿 10,000｜85%'
      };
    }
  }

  return {
    rate: 80,
    level: '九月後預設 80%'
  };
}
async function saveTipToPlayOrders({
  guildId,
  tipperId,
  staffId,
  item,
  amount,
  channelId,
  paid = true
}) {
  const { data, error } = await supabase
    .from('play_orders')
    .insert({
      guild_id: guildId,
      customer_id: tipperId,
      customer_name: `<@${tipperId}>`,
      customer_username: `<@${tipperId}>`,
      assigned_player: staffId,
      order_type: '打賞',
      order_item: item,
      game: '打賞',
      service: `打賞：${item}`,
      note: '打賞',
      channel_id: channelId,
      source_channel_id: channelId,
      price: Number(amount),
      final_price: Number(amount),
      paid,
      paid_at: paid ? new Date().toISOString() : null,
      salary_paid: false,
      salary_paid_at: null,
      status: 'completed',
      completed_at: new Date().toISOString(),
      accepted_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    console.error('[打賞寫入薪資網失敗]', error);
    throw error;
  }
  await saveDeepNightSalaryOrder({
    orderId: data.id,
    orderNo: data.order_no || data.id,
    discordId: staffId,
    staffName: null,
    customerName: `<@${tipperId}>`,
    serviceName: `打賞：${item}`,
    orderAmount: Number(amount),
    bonusAmount: 0,
    finishedAt: new Date().toISOString()
  });
  return data;
}
function getManualCommissionRate(tier) {
  if (tier === 'rate_80') return 80;
  if (tier === 'rate_85') return 85;
  if (tier === 'rate_90') return 90;
  if (tier === 'manager_95') return 95;
  return null;
}

function getTaipeiMonthText(date = new Date()) {
  const taipeiDate =
    new Date(date.getTime() + 8 * 60 * 60 * 1000);

  return taipeiDate.toISOString().slice(0, 7);
}

function getTaipeiYearText(date = new Date()) {
  const taipeiDate =
    new Date(date.getTime() + 8 * 60 * 60 * 1000);

  return taipeiDate.toISOString().slice(0, 4);
}

function getNextMonthTextFromIso(isoText) {
  const date = new Date(isoText);
  const taipeiDate =
    new Date(date.getTime() + 8 * 60 * 60 * 1000);

  const year =
    taipeiDate.getUTCFullYear();

  const month =
    taipeiDate.getUTCMonth();

  const next =
    new Date(Date.UTC(year, month + 1, 1));

  return next.toISOString().slice(0, 7);
}

async function getFirstReachAmountDate(discordId, targetAmount) {
  const { data, error } = await supabase
    .from(SALARY_ORDER_TABLE)
    .select('*')
    .eq('discord_id', String(discordId))
    .eq('is_deleted', false)
    .order('order_finished_at', { ascending: true });

  if (error) {
    console.error('[抽成計算] 讀取歷史訂單失敗', error);
    return null;
  }

  let total = 0;

  for (const order of data || []) {
    total += Number(order.order_amount || 0);

    if (total >= targetAmount) {
      return order.order_finished_at;
    }
  }

  return null;
}

async function getPreviousYearSalaryTotal(discordId, finishedAt) {
  const year =
    Number(getTaipeiYearText(new Date(finishedAt)));

  const previousYear =
    year - 1;

  const start =
    new Date(`${previousYear}-01-01T00:00:00+08:00`).toISOString();

  const end =
    new Date(`${previousYear}-12-31T23:59:59.999+08:00`).toISOString();

  const { data, error } = await supabase
    .from(SALARY_ORDER_TABLE)
    .select('staff_salary')
    .eq('discord_id', String(discordId))
    .eq('is_deleted', false)
    .gte('order_finished_at', start)
    .lte('order_finished_at', end);

  if (error) {
    console.error('[抽成計算] 讀取去年薪資失敗', error);
    return 0;
  }

  return (data || []).reduce(
    (sum, order) => sum + Number(order.staff_salary || 0),
    0
  );
}

async function getDeepNightCommissionInfo(discordId, finishedAt = new Date().toISOString()) {
  const finishedDate =
    new Date(finishedAt);

  const openingEnd =
    new Date('2026-09-01T00:00:00+08:00');

  if (finishedDate < openingEnd) {
    return {
      rate: 90,
      level: '開幕期 90%'
    };
  }

  const staff =
    await getStaffByDiscordId(discordId);

  const manualRate =
    getManualCommissionRate(staff?.commission_tier);

  if (manualRate) {
    return {
      rate: manualRate,
      level:
        manualRate === 95
          ? '主管津貼 95%'
          : `手動檔位 ${manualRate}%`
    };
  }

  const previousYearSalary =
    await getPreviousYearSalaryTotal(discordId, finishedAt);

  if (previousYearSalary >= 100000) {
    return {
      rate: 90,
      level: '年度薪資達標｜隔年 90%'
    };
  }

  const firstReach10kDate =
    await getFirstReachAmountDate(discordId, 10000);

  if (firstReach10kDate) {
    const reachNextMonth =
      getNextMonthTextFromIso(firstReach10kDate);

    const orderMonth =
      getTaipeiMonthText(new Date(finishedAt));

    if (orderMonth >= reachNextMonth) {
      return {
        rate: 85,
        level: '累積接單滿 10,000｜85%'
      };
    }
  }

  return {
    rate: 80,
    level: '預設 80%'
  };
}
async function saveDeepNightSalaryOrder({
  orderId,
  orderNo,
  discordId,
  staffName,
  customerName,
  serviceName,
  orderAmount,
  staffSalary,
  bonusAmount = 0,
  finishedAt = new Date().toISOString()
}) {
  if (!discordId) return null;

  const commission =
    await getDeepNightCommissionInfo(discordId, finishedAt);

  const finalOrderAmount =
    Number(orderAmount || 0);

  const finalBonusAmount =
    Number(bonusAmount || 0);

  const finalStaffSalary =
    Math.round(finalOrderAmount * (commission.rate / 100));

  const staff =
    await getStaffByDiscordId(discordId);

  const finalStaffName =
    staffName ||
    staff?.display_name ||
    staff?.real_name ||
    staff?.discord_name ||
    staff?.name ||
    null;

  const { data, error } = await supabase
    .from(SALARY_ORDER_TABLE)
    .insert({
      order_id: String(orderNo || orderId || ''),
      discord_id: String(discordId),
      staff_name: finalStaffName,
      customer_name: customerName || null,
      service_name: serviceName || '陪玩訂單',
      order_amount: finalOrderAmount,
      staff_salary: finalStaffSalary,
      bonus_amount: finalBonusAmount,
      salary_rate: commission.rate,
      salary_level: commission.level,
      platform_income: finalOrderAmount,
      platform_expense: finalStaffSalary + finalBonusAmount,
      status: '未發薪',
      order_finished_at: finishedAt,
      is_deleted: false
    })
    .select()
    .single();

  if (error) {
    console.error('[深夜薪資網] 寫入薪資訂單失敗:', error);
    return null;
  }

  return data;
}
async function sendTipCloseButtons(channel) {
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('save_order_log')
        .setLabel('📁 儲存紀錄')
        .setStyle(ButtonStyle.Success),

      new ButtonBuilder()
        .setCustomId('delete_order_now')
        .setLabel('🗑️ 直接刪除')
        .setStyle(ButtonStyle.Danger)
    );

  await channel.send({
    content:
      `<@&${process.env.STAFF_ROLE}> 打賞已完成，請選擇是否儲存紀錄或關閉頻道。`,
    components: [row]
  });
}
async function sendOrderReviewPanel(channel, order, assignedPlayers = []) {
  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`order_review_5_${order.id}`)
          .setLabel('🌟🌟🌟🌟🌟 超級滿意')
          .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
          .setCustomId(`order_review_4_${order.id}`)
          .setLabel('🌟🌟🌟🌟 很滿意')
          .setStyle(ButtonStyle.Primary),

        new ButtonBuilder()
          .setCustomId(`order_review_3_${order.id}`)
          .setLabel('🌟🌟🌟 普通')
          .setStyle(ButtonStyle.Secondary)
      );

  const row2 =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`order_review_2_${order.id}`)
          .setLabel('🌟🌟 不太滿意')
          .setStyle(ButtonStyle.Secondary),

        new ButtonBuilder()
          .setCustomId(`order_review_1_${order.id}`)
          .setLabel('🌟 很不滿意')
          .setStyle(ButtonStyle.Danger)
      );

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor('#ffd166')
        .setTitle('💬 訂單評價')
        .setDescription(
          `<@${order.customer_id}> 感謝你的下單！\n\n` +
          `請幫這次服務留下一個評價，讓我們知道這次體驗如何。\n\n` +
          `訂單編號：${order.order_no || order.id}\n` +
          `陪陪：${
            assignedPlayers.length
              ? assignedPlayers.map(id => `<@${id}>`).join('、')
              : '未指定'
          }`
        )
        .setFooter({
          text: '評價送出後，會提供填寫文字心得的選項'
        })
        .setTimestamp()
    ],
    components: [row, row2]
  });
}
// ===== 安全回覆封裝 =====
async function safeReply(interaction, options) {
  try {
    const opts = { ...options };
    if (opts.ephemeral) {
      opts.flags = 64;
      delete opts.ephemeral;
    }
    if (
      interaction.deferred &&
      !interaction.replied
    ) {
      return await interaction.editReply(opts);
    }
    if (interaction.replied) {
      return await interaction.followUp(opts);
    }
    return await interaction.reply(opts);
  } catch (err) {
    console.error(
      '[safeReply 錯誤]',
      err
    );
  }
}
async function safeEditReply(interaction, options) {
  try {
    const opts = { ...options };
    if (opts.ephemeral) {
      opts.flags = 64; // ephemeral
      delete opts.ephemeral;
    }

    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(opts).catch(() => {});
    } else {
      await interaction.reply(opts).catch(() => {});
    }
  } catch (err) {
    console.error('[safeEditReply 錯誤]', err);
  }
}
function isAdmin(interaction) {
  return (
    interaction.guild.ownerId === interaction.user.id ||
    interaction.member.permissions.has(PermissionFlagsBits.Administrator)
  );
}
function isOwnerOrAdmin(interaction) {
  return (
    interaction.guild.ownerId === interaction.user.id ||
    interaction.member.permissions.has(PermissionFlagsBits.Administrator)
  );
}
async function handleGiveRoleCommand(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }

  const isAllowed =
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.permissions.has(PermissionFlagsBits.ManageRoles);

  if (!isAllowed) {
    return interaction.editReply({
      content: '❌ 你需要管理員權限或管理身分組權限才能使用這個指令。'
    });
  }

  const role =
    interaction.options.getRole('身份組');

  const mode =
    interaction.options.getString('發放對象');

  const note =
    interaction.options.getString('備註') || '無';

  if (!role) {
    return interaction.editReply({
      content: '❌ 找不到這個身份組。'
    });
  }

  if (role.id === interaction.guild.id) {
    return interaction.editReply({
      content: '❌ 不能發放 @everyone 身份組。'
    });
  }

  if (role.managed) {
    return interaction.editReply({
      content: '❌ 這是系統 / 機器人管理的身份組，不能手動發放。'
    });
  }

  const botMember =
    await interaction.guild.members.fetchMe();

  if (role.position >= botMember.roles.highest.position) {
    return interaction.editReply({
      content:
        `❌ 我無法發放 <@&${role.id}>。\n` +
        `請把機器人的身份組移到這個身份組上面。`
    });
  }

  if (
    role.position >= interaction.member.roles.highest.position &&
    interaction.guild.ownerId !== interaction.user.id
  ) {
    return interaction.editReply({
      content:
        `❌ 你不能發放高於或等於你最高身份組的身份組。\n` +
        `目標身份組：<@&${role.id}>`
    });
  }

  let targetUsers = [];

  if (mode === 'single' || mode === 'multiple') {
    for (let i = 1; i <= 10; i++) {
      const user =
        interaction.options.getUser(`成員${i}`);

      if (user && !targetUsers.some(item => item.id === user.id)) {
        targetUsers.push(user);
      }
    }

    if (!targetUsers.length) {
      return interaction.editReply({
        content: '❌ 請至少選擇一位成員。'
      });
    }
  }

  if (mode === 'all') {
    await interaction.editReply({
      content:
        `⏳ 開始發放身份組給所有成員。\n` +
        `身份組：<@&${role.id}>\n` +
        `這可能需要一點時間。`
    });

    const members =
      await interaction.guild.members.fetch();

    targetUsers =
      members
        .filter(member => !member.user.bot)
        .map(member => member.user);
  }

  let successCount = 0;
  let failCount = 0;
  const failedUsers = [];

  for (const user of targetUsers) {
    const member =
      await interaction.guild.members
        .fetch(user.id)
        .catch(() => null);

    if (!member) {
      failCount++;
      failedUsers.push(`<@${user.id}>：找不到成員`);
      continue;
    }

    if (member.roles.cache.has(role.id)) {
      successCount++;
      continue;
    }

    try {
      await member.roles.add(
        role,
        `由 ${interaction.user.tag} 使用 /給與身份組 發放｜備註：${note}`
      );

      successCount++;
    } catch (err) {
      failCount++;
      failedUsers.push(`<@${user.id}>：${err.message || '發放失敗'}`);
    }
  }

  const failedText =
    failedUsers.length
      ? `\n\n失敗名單：\n${failedUsers.slice(0, 10).join('\n')}`
      : '';

  return interaction.editReply({
    content:
      `✅ 身份組發放完成\n\n` +
      `身份組：<@&${role.id}>\n` +
      `發放對象：${mode === 'all' ? '所有人' : mode === 'multiple' ? '多人' : '單人'}\n` +
      `成功：${successCount} 人\n` +
      `失敗：${failCount} 人\n` +
      `備註：${note}` +
      failedText
  });
}
async function findOrderForExtend({ guildId, orderNo, channelId }) {
  // 1. 有訂單編號就先用訂單編號找
  if (orderNo) {
    const { data, error } = await supabase
      .from('play_orders')
      .select('*')
      .eq('guild_id', guildId)
      .eq('order_no', orderNo)
      .maybeSingle();

    if (!error && data) return data;
  }

  // 2. 找不到訂單編號，就用目前頻道 ID 找
  if (channelId) {
    const { data, error } = await supabase
      .from('play_orders')
      .select('*')
      .eq('guild_id', guildId)
      .eq('channel_id', channelId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!error && data) return data;
  }

  return null;
}
// 讀取玩家資料
async function getUser(userId) {
  const { data, error } = await supabase.from('users').select('*').eq('user_id', userId).single();

  if (error && error.code !== 'PGRST116') {
    console.error('[DB] 讀取玩家資料失敗:', error);
  }

  if (!data) {
    const { error: insertError } = await supabase.from('users').insert([{ user_id: userId, coins: 0 }]);

    if (insertError) {
      console.error('[DB] 建立玩家失敗:', insertError);
    }

    return { user_id: userId, coins: 0, last_checkin: null };
  }

  return data;
}

// 更新金額
async function updateCoins(userId, coins) {
  if (coins < 0) {
    throw new Error('金額不能為負數');
  }

  const { error } = await supabase.from('users').update({ coins }).eq('user_id', userId);

  if (error) {
    console.error('[DB] 更新金額失敗:', error);
    throw new Error('無法更新金額');
  }
}
async function changeCoins(userId, amount) {
  const { data, error } = await supabase.rpc(
    'change_user_coins',
    {
      p_user_id: userId,
      p_amount: amount
    }
  );

  if (error) {
    console.error('[DB] 原子更新金額失敗:', error);
    throw new Error(error.message || '無法更新金額');
  }

  return Number(data || 0);
}
async function sendWalletLog(
  userId,
  type,
  amount,
  balance,
  note = ''
) {
  if (amount === 0 && type !== '十抽') return;

  // ===== 寫入錢包明細資料庫 =====
  try {
    const { error: logError } =
      await supabase
        .from('wallet_logs')
        .insert({
          user_id: userId,
          type,
          amount,
          balance,
          note
        });

    if (logError) {
      console.error('[錢包明細寫入失敗]', logError);
    }
  } catch (err) {
    console.error('[錢包明細寫入錯誤]', err);
  }

  // ===== 私訊通知玩家 =====
  try {
    const user =
      await client.users.fetch(userId);

    const embed =
      new EmbedBuilder()
        .setColor('#ffd700')
        .setTitle('💰 錢包異動通知')
        .addFields(
          {
            name: '📌 類型',
            value: type,
            inline: true
          },
          {
            name: '💵 異動金額',
            value: `${amount} 星雨幣`,
            inline: true
          },
          {
            name: '💳 目前餘額',
            value: `${balance} 星雨幣`,
            inline: true
          }
        )
        .setTimestamp();

    if (note) {
      embed.setDescription(note);
    }

    await user.send({
      embeds: [embed]
    }).catch(err => {
      console.log('[錢包通知失敗]', err.code, err.message);
    });
  } catch (err) {
    console.error('[錢包通知失敗]', err);
  }
}
function isWalletPayment(text = '') {
  const value = String(text || '');

  return (
    value.includes('儲值卡') ||
    value.includes('錢包') ||
    value.includes('餘額')
  );
}

function isMonthlyPayment(text = '') {
  const value = String(text || '');

  return (
    value.includes('月結') ||
    value.includes('月結付款') ||
    value.includes('月結會員')
  );
}

function isNeedManualPaidPayment(text = '') {
  const value = String(text || '');

  return (
    value.includes('匯款') ||
    value.includes('轉帳') ||
    value.includes('無卡') ||
    value.includes('刷卡') ||
    value.includes('信用卡') ||
    value.includes('美金') ||
    value.includes('加密貨幣')
  );
}
function isCardPayment(text = '') {
  const value = String(text || '').toLowerCase();

  return (
    value.includes('刷卡') ||
    value.includes('信用卡') ||
    value.includes('信用卡付款') ||
    value.includes('card')
  );
}

function isNoCardPayment(text = '') {
  const value = String(text || '');

  return (
    value.includes('無卡') ||
    value.includes('無卡存款')
  );
}

function isBankTransfer(text = '') {
  const value = String(text || '');

  return (
    value.includes('匯款') ||
    value.includes('轉帳')
  );
}

async function sendNoCardPaymentInfo(channel) {
  const embed = new EmbedBuilder()
    .setColor('#ffd166')
    .setTitle('🏧 無卡付款資訊')
    .setDescription(
      `請依照以下資訊完成無卡付款：\n\n` +
      `銀行：中國信託\n` +
      `銀行代碼：822\n` +
      `帳號：901565426642\n` +
      `戶名：許O星\n\n` +
      `或是\n\n` +
      `銀行：國泰世華\n` +
      `銀行代碼：013\n` +
      `帳號：134500100962\n` +
      `戶名：許O星\n\n` +
      `付款完成後，請在此頻道上傳存款明細，等待客服確認。`
    )
    .setFooter({
      text: '請確認金額正確後再付款'
    })
    .setTimestamp();

  await channel.send({
    embeds: [embed]
  });
}

async function sendCardPaymentInfo(channel) {
  const embed = new EmbedBuilder()
    .setColor('#9b5cff')
    .setTitle('💳 刷卡付款資訊')
    .setDescription(
      `請點擊以下連結完成刷卡付款：\n\n` +
      `🔗 PChomePay 合法付款連結：https://pcpay.tw/aCU67\n\n` +
      `付款完成後，請在此頻道上傳付款成功截圖，等待客服確認。\n\n` +
      `截圖請包含：\n` +
      `1. 付款成功畫面\n` +
      `2. 付款金額\n` +
      `3. 交易時間或交易編號`
    )
    .setFooter({
      text: '請確認金額正確後再付款'
    })
    .setTimestamp();

  await channel.send({
    embeds: [embed]
  });
}
async function payOrderByWallet(order) {
  const userId = order.customer_id;

  const amount =
    Number(order.final_price || order.price || 0);

  if (!amount || amount <= 0) {
    throw new Error('訂單金額錯誤');
  }

  const userData =
    await getUser(userId);

  const currentCoins =
    Number(userData.coins || 0);

  if (currentCoins < amount) {
    throw new Error(
      `餘額不足，目前餘額 ${currentCoins} 星雨幣，需要 ${amount} 星雨幣`
    );
  }

  const finalCoins =
    await changeCoins(userId, -amount);

  await sendWalletLog(
    userId,
    '訂單扣款',
    -amount,
    finalCoins,
    `訂單 ${order.order_no || order.id}｜${order.service || '陪玩訂單'}`
  );

  const { data: paidOrder, error: paidOrderError } =
    await supabase
      .from('play_orders')
      .update({
        paid: true,
        paid_at: new Date().toISOString()
      })
      .eq('id', order.id)
      .select()
      .single();
  if (paidOrderError || !paidOrder) {
    console.error('[儲值卡付款] 更新付款狀態失敗', paidOrderError);
    throw new Error('更新付款狀態失敗');
  }
  // ===== 付款完成後才計入累積消費，並防止重複 =====
  await countOrderVipSpentOnce(
    paidOrder,
    '儲值卡 / 錢包付款完成'
  );

  await recordAccountingLedger({
    entry_type: 'customer_spend_wallet',
    entry_label: '客人消費',
    amount,
    revenue_amount: amount,
    liability_amount: -amount,
    payment_method: '儲值卡 / 錢包',
    customer_id: userId,
    customer_name: paidOrder.customer_name || paidOrder.customer_username || null,
    staff_id: paidOrder.discord_id || paidOrder.assigned_player || null,
    staff_name: paidOrder.staff_name || null,
    order_id: String(paidOrder.id),
    order_no: paidOrder.order_no || paidOrder.order_id || null,
    source_table: 'play_orders',
    source_id: String(paidOrder.id),
    dedupe_key: `play_orders:${paidOrder.id}:customer_spend_wallet`,
    note: paidOrder.service || paidOrder.service_name || '陪玩訂單'
  });
  return {
    amount,
    finalCoins
  };
}
async function payOrderByMonthly(order) {
  const userId = order.customer_id;
  const amount =
    Number(order.final_price || order.price || 0);
  if (!amount || amount <= 0) {
    throw new Error('訂單金額錯誤');
  }

  const { data: account, error: accountError } =
    await supabase
      .from('member_monthly_accounts')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

  if (accountError || !account) {
    throw new Error('尚未開通月結會員');
  }

  if (!account.enabled) {
    throw new Error('月結會員目前已停用');
  }

  const monthlyLimit =
    Number(account.monthly_limit || 0);

  const usedAmount =
    Number(account.used_amount || 0);

  const availableAmount =
    monthlyLimit - usedAmount;

  if (availableAmount < amount) {
    throw new Error(
      `月結額度不足，目前可用 NT$${availableAmount}`
    );
  }

  const billingMonth =
    getBillingMonth();

  const cashback =
    Math.floor(amount * 0.03);

  await supabase
    .from('member_monthly_accounts')
    .update({
      used_amount: usedAmount + amount,
      updated_at: new Date().toISOString()
    })
    .eq('user_id', userId);

  await supabase
    .from('member_monthly_transactions')
    .insert({
      user_id: userId,
      source_type: 'order',
      source_id: String(order.id),
      item_name: order.service || order.order_item || '陪玩訂單',
      benefit_type: order.game || '陪玩服務',
      amount,
      cashback,
      billing_month: billingMonth,
      status: 'unbilled'
    });

  const { data: paidOrder, error: paidOrderError } =
    await supabase
      .from('play_orders')
      .update({
        paid: true,
        paid_at: new Date().toISOString()
      })
      .eq('id', order.id)
      .select()
      .single();
  if (paidOrderError || !paidOrder) {
    console.error('[月結付款] 更新付款狀態失敗', paidOrderError);
    throw new Error('更新付款狀態失敗');
  }
  // ===== 月結付款完成後也計入累積消費，並防止重複 =====
  await countOrderVipSpentOnce(
    paidOrder,
    '月結付款完成'
  );

  await recordAccountingLedger({
    entry_type: 'customer_spend_monthly',
    entry_label: '客人消費',
    amount,
    revenue_amount: amount,
    receivable_amount: amount,
    payment_method: '月結',
    customer_id: userId,
    customer_name: paidOrder.customer_name || paidOrder.customer_username || null,
    staff_id: paidOrder.discord_id || paidOrder.assigned_player || null,
    staff_name: paidOrder.staff_name || null,
    order_id: String(paidOrder.id),
    order_no: paidOrder.order_no || paidOrder.order_id || null,
    source_table: 'play_orders',
    source_id: String(paidOrder.id),
    dedupe_key: `play_orders:${paidOrder.id}:customer_spend_monthly`,
    note: paidOrder.service || paidOrder.service_name || '陪玩訂單'
  });
  return {
    amount,
    cashback,
    usedAmount: usedAmount + amount,
    monthlyLimit,
    availableAmount: monthlyLimit - usedAmount - amount
  };
}
async function handleSlashExtendOrder(interaction) {
  const isStaff =
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.reply({
      content: '❌ 只有客服可以使用加時指令',
      flags: 64
    });
  }

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }

  const orderId =
    interaction.options.getInteger('訂單id');

  const orderNo =
    interaction.options.getString('訂單編號') || '';

  const extensionText =
    interaction.options.getString('內容');

  const amount =
    interaction.options.getInteger('金額');

  const note =
    interaction.options.getString('備註') || '';

  if (!amount || amount <= 0) {
    return interaction.editReply({
      content: '❌ 加時金額必須大於 0'
    });
  }

  let order = null;
  let orderError = null;
  // 1. 如果有填訂單 ID，先用訂單 ID 找
  if (orderId) {
    const result =
      await supabase
        .from('play_orders')
        .select('*')
        .eq('guild_id', getGuildId(interaction))
        .eq('id', orderId)
        .maybeSingle();
    order = result.data;
    orderError = result.error;
  }
  // 2. 訂單 ID 找不到，就用訂單編號 / 頻道 ID 找
  if (!order) {
    order = await findOrderForExtend({
      guildId: getGuildId(interaction),
      orderNo,
      channelId: interaction.channel.id
    });
  }
  if (!order) {
    console.error('[加時指令] 找不到原訂單', orderError);
    return interaction.editReply({
      content:
        '❌ 找不到這筆訂單。\n' +
        '你可以：\n' +
        '1. 在訂單臨時頻道直接使用加時指令\n' +
        '2. 或手動輸入訂單 ID\n' +
        '3. 或手動輸入訂單編號'
    });
  }
  const guildId = getGuildId(interaction);
  const { data: extension, error: insertError } =
    await supabase
      .from('order_extensions')
      .insert({
        guild_id: guildId,
        order_id: order.id,
        order_no: order.order_no || null,
        customer_id: order.customer_id,
        channel_id: interaction.channel.id,
        staff_id: interaction.user.id,
        extension_text: extensionText,
        amount,
        payment_method: '未選擇',
        paid: false,
        status: 'pending',
        note
      })
      .select()
      .single();

  if (insertError || !extension) {
    console.error(
      '[加時指令] 建立加時失敗完整錯誤',
      JSON.stringify(insertError, null, 2)
    );
    return interaction.editReply({
      content:
        '❌ 建立加時失敗\n' +
        `錯誤訊息：${insertError?.message || '未知錯誤'}\n` +
        `錯誤代碼：${insertError?.code || '無'}\n` +
        `詳細資訊：${insertError?.details || '無'}\n` +
        `提示：${insertError?.hint || '無'}`
    });
  }
  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(`extension_payment_method_${extension.id}`)
      .setPlaceholder('請選擇加時付款方式')
      .addOptions([
        {
          label: '匯款 / 轉帳',
          description: '顯示銀行帳號，付款後上傳截圖',
          value: '匯款'
        },
        {
          label: '無卡',
          description: '顯示無卡帳號，付款後上傳截圖',
          value: '無卡'
        },
        {
          label: '刷卡',
          description: '顯示刷卡付款連結，付款後上傳截圖',
          value: '刷卡'
        },
        {
          label: '儲值卡 / 錢包',
          description: '立即由 ASD 餘額扣款',
          value: '儲值卡'
        },
        {
          label: '美金轉帳',
          description: '請等待客服提供帳號',
          value: '美金轉帳'
        },
        {
          label: '加密貨幣',
          description: '請等待客服提供錢包地址',
          value: '加密貨幣'
        }
      ]);

  const row =
    new ActionRowBuilder()
      .addComponents(menu);

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor('#66ccff')
        .setTitle('➕ 加時付款')
        .setDescription(
          `<@${order.customer_id}> 請選擇加時付款方式。\n\n` +
          `原訂單：${order.order_no || order.id}\n` +
          `加時內容：${extensionText}\n` +
          `加時金額：NT$${amount.toLocaleString('zh-TW')}\n` +
          `建立客服：<@${interaction.user.id}>\n` +
          `備註：${note || '無'}`
        )
        .setTimestamp()
    ],
    components: [row]
  });

  return interaction.editReply({
    content:
      `✅ 已建立加時付款\n` +
      `原訂單：${order.order_no || order.id}\n` +
      `內容：${extensionText}\n` +
      `金額：NT$${amount.toLocaleString('zh-TW')}`
  });
}
// ===== VIP 成長制度 =====
function parseVipCouponReward(rewardCoupon = '') {
  const text = String(rewardCoupon || '').trim();

  if (!text) {
    return [];
  }

  const match =
    text.match(/(.+?)[*×xX]\s*(\d+)/);

  if (!match) {
    return [
      {
        name: text,
        count: 1
      }
    ];
  }

  return [
    {
      name: match[1].trim(),
      count: Number(match[2] || 1)
    }
  ];
}

async function giveVipRole(userId, roleId, guildId = process.env.GUILD_ID) {
  if (!roleId) return;

  const guild =
    client.guilds.cache.get(guildId) ||
    client.guilds.cache.first();

  if (!guild) return;

  const member =
    await guild.members.fetch(userId).catch(() => null);

  if (!member) return;

  const { data: levels, error } =
    await supabase
      .from('vip_levels')
      .select('role_id')
      .eq('guild_id', guildId)
      .not('role_id', 'is', null);

  if (error) {
    console.error('[VIP] 讀取全部 VIP 身分組失敗', error);
  }

  const allVipRoleIds =
    (levels || [])
      .map(level => String(level.role_id || '').trim())
      .filter(Boolean);

  const rolesToRemove =
    allVipRoleIds.filter(oldRoleId =>
      oldRoleId !== String(roleId) &&
      member.roles.cache.has(oldRoleId)
    );

  if (rolesToRemove.length) {
    await member.roles
      .remove(rolesToRemove)
      .catch(err => {
        console.log('[VIP 舊身分組移除失敗]', err.message);
      });
  }

  if (!member.roles.cache.has(roleId)) {
    await member.roles
      .add(roleId)
      .catch(err => {
        console.log('[VIP 新身分組發放失敗]', err.message);
      });
  }
}

async function grantVipLevelReward(
  userId,
  level,
  triggerType,
  triggerAmount,
  oldLevelKey = null,
  guildId = process.env.GUILD_ID
) {
  const rewardAsd =
    Number(level.reward_asd || 0);

  if (rewardAsd > 0) {
    const finalCoins =
      await changeCoins(userId, rewardAsd);

    await sendWalletLog(
      userId,
      'VIP升級獎勵',
      rewardAsd,
      finalCoins,
      `升級 ${level.level_name}｜獲得 ${rewardAsd} ASD`
    );
  }

  const coupons =
    parseVipCouponReward(level.reward_coupon);

  for (const coupon of coupons) {
    for (let i = 0; i < coupon.count; i++) {
      await addUserItem(
        userId,
        coupon.name,
        'VIP',
        `${level.level_name} 升級獎勵`,
        'coupon'
      );
    }
  }

  await giveVipRole(
    userId,
    level.role_id,
    guildId
  );

  await supabase
    .from('vip_upgrade_logs')
    .insert({
      guild_id: guildId,
      user_id: userId,
      old_level_key: oldLevelKey,
      new_level_key: level.level_key,
      trigger_type: triggerType,
      trigger_amount: triggerAmount,
      reward_asd: rewardAsd,
      reward_coupon: level.reward_coupon,
      reward_note: level.reward_note
    });

  const user =
    await client.users
      .fetch(userId)
      .catch(() => null);

  if (user) {
    await user.send({
      embeds: [
        new EmbedBuilder()
          .setColor('#ffd700')
          .setTitle('✨ VIP 等級提升')
          .setDescription(
            `恭喜你升級為 **${level.level_name}**！\n\n` +
            `🎁 ASD 獎勵：${rewardAsd || 0} ASD\n` +
            `🎟️ 優惠券：${level.reward_coupon || '無'}\n` +
            `💎 權益：${level.reward_note || '無'}`
          )
          .setTimestamp()
      ]
    }).catch(() => {});
  }
}
async function getUserVipRecord(userId, guildId = process.env.GUILD_ID) {
  if (!userId || !guildId) {
    return {
      data: null,
      error: null
    };
  }

  return supabase
    .from('user_vips')
    .select('*')
    .eq('guild_id', guildId)
    .eq('user_id', userId)
    .maybeSingle();
}
async function saveUserVipRecord(payload, existingVip = null) {
  const dataToSave = {
    ...payload,
    updated_at: payload.updated_at || new Date().toISOString()
  };

  if (existingVip?.id) {
    const updateByIdResult =
      await supabase
        .from('user_vips')
        .update(dataToSave)
        .eq('id', existingVip.id)
        .eq('guild_id', dataToSave.guild_id)
        .select()
        .maybeSingle();

    if (!updateByIdResult.error && updateByIdResult.data) {
      return updateByIdResult;
    }

    console.error('[VIP] 依 id 更新累積資料失敗', updateByIdResult.error);
  }

  if (existingVip) {
    const updateExistingResult =
      await supabase
        .from('user_vips')
        .update(dataToSave)
        .eq('guild_id', dataToSave.guild_id)
        .eq('user_id', dataToSave.user_id)
        .select()
        .maybeSingle();

    if (!updateExistingResult.error && updateExistingResult.data) {
      return updateExistingResult;
    }

    console.error('[VIP] 依 guild_id/user_id 更新累積資料失敗', updateExistingResult.error);
  }

  return supabase
    .from('user_vips')
    .upsert(
      dataToSave,
      {
        onConflict: 'guild_id,user_id'
      }
    )
    .select()
    .maybeSingle();
}
async function getLegacyUserVipCandidates(userId) {
  if (!userId) {
    return {
      data: [],
      error: null
    };
  }

  return supabase
    .from('user_vips')
    .select('id,guild_id,user_id,level_key,level_name,total_spent,total_topup,highest_single_topup,updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
}
async function explainUserVipSaveFailure(userId, guildId, error) {
  const { data: candidates, error: candidateError } =
    await getLegacyUserVipCandidates(userId);

  if (candidateError) {
    console.error('[VIP] 查詢可能衝突的累積資料失敗', candidateError);
    return;
  }

  const otherGuildRows =
    (candidates || [])
      .filter(row => row.guild_id !== guildId);

  if (otherGuildRows.length) {
    console.error(
      '[VIP] 儲存失敗，且同 user_id 在其他 guild 已有 VIP 資料。因兩個 bot 的 VIP/累積資料需分開，程式不會自動沿用另一個 guild 的資料。',
      {
        userId,
        guildId,
        otherGuildRows,
        originalError: error
      }
    );
  }
}
async function checkAndUpgradeVip(userId, triggerType, amount, guildId = process.env.GUILD_ID) {
  const triggerAmount =
    Number(amount || 0);

  if (!userId || !guildId) {
    return null;
  }

  const { data: currentVip, error: vipReadError } =
    await getUserVipRecord(userId, guildId);

  if (vipReadError) {
    console.error('[VIP] 讀取累積資料失敗', vipReadError);
    return null;
  }

  const oldTotalSpent =
    Number(currentVip?.total_spent || 0);

  const oldTotalTopup =
    Number(currentVip?.total_topup || 0);

  const oldHighestTopup =
    Number(currentVip?.highest_single_topup || 0);

  const newTotalSpent =
    triggerType === 'spend'
      ? oldTotalSpent + triggerAmount
      : oldTotalSpent;

  const newTotalTopup =
    triggerType === 'topup'
      ? oldTotalTopup + triggerAmount
      : oldTotalTopup;

  const newHighestTopup =
    triggerType === 'topup'
      ? Math.max(oldHighestTopup, triggerAmount)
      : oldHighestTopup;

  const { data: levels, error: levelError } =
    await supabase
      .from('vip_levels')
      .select('*')
      .eq('guild_id', guildId)
      .order('sort_order', { ascending: true });

  if (levelError || !levels?.length) {
    console.log('[VIP] 讀取等級失敗', levelError);
    return null;
  }

  const oldSortOrder =
    currentVip?.level_key
      ? Number(
          levels.find(level => level.level_key === currentVip.level_key)
            ?.sort_order || 0
        )
      : 0;

  const availableLevels =
    levels.filter(level => {
      const spendRequired =
        Number(level.total_spend_required || 0);

      const topupRequired =
        Number(level.single_topup_required || 0);

      return (
        newTotalSpent >= spendRequired ||
        newTotalTopup >= topupRequired ||
        newHighestTopup >= topupRequired
      );
    });

  if (!availableLevels.length) {
    const { error: saveError } =
      await saveUserVipRecord(
        {
          guild_id: guildId,
          user_id: userId,
          level_key: currentVip?.level_key || null,
          level_name: currentVip?.level_name || null,
          total_spent: newTotalSpent,
          total_topup: newTotalTopup,
          highest_single_topup: newHighestTopup,
          updated_at: new Date().toISOString()
        },
        currentVip
      );

    if (saveError) {
      console.error('[VIP] 更新累積資料失敗', saveError);
      await explainUserVipSaveFailure(userId, guildId, saveError);
    }

    return null;
  }

  const newLevel =
    availableLevels[availableLevels.length - 1];

  const newSortOrder =
    Number(newLevel.sort_order || 0);

  const { error: saveError } =
    await saveUserVipRecord(
      {
        guild_id: guildId,
        user_id: userId,
        level_key: newLevel.level_key,
        level_name: newLevel.level_name,
        total_spent: newTotalSpent,
        total_topup: newTotalTopup,
        highest_single_topup: newHighestTopup,
        updated_at: new Date().toISOString()
      },
      currentVip
    );

  if (saveError) {
    console.error('[VIP] 更新等級資料失敗', saveError);
    await explainUserVipSaveFailure(userId, guildId, saveError);
    return null;
  }

  if (newSortOrder <= oldSortOrder) {
    return null;
  }

  const rewardLevels =
    levels.filter(level =>
      Number(level.sort_order || 0) > oldSortOrder &&
      Number(level.sort_order || 0) <= newSortOrder
    );

  for (const level of rewardLevels) {
    await grantVipLevelReward(
      userId,
      level,
      triggerType,
      triggerAmount,
      currentVip?.level_key || null,
      guildId
    );
  }

  return newLevel;
}
// ===== 訂單付款完成後，計入累積消費，防止重複計算 =====
async function countOrderVipSpentOnce(order, reason = '付款完成') {
  if (!order) {
    throw new Error('找不到訂單資料');
  }

  if (order.vip_spent_counted) {
    console.log(
      '[VIP累積消費] 已計算過，略過',
      order.order_no || order.id
    );

    return {
      counted: false,
      amount: 0
    };
  }

  const userId =
    order.customer_id;

  const amount =
    Number(order.final_price || order.price || 0);

  if (!userId) {
    throw new Error('訂單缺少 customer_id');
  }

  if (!amount || amount <= 0) {
    throw new Error('訂單金額錯誤，無法計入累積消費');
  }

  // 先把訂單鎖住，避免同一張單被重複按兩次時重複加
  const { data: lockedOrder, error: lockError } =
    await supabase
      .from('play_orders')
      .update({
        vip_spent_counted: true,
        vip_spent_counted_at: new Date().toISOString()
      })
      .eq('id', order.id)
      .eq('vip_spent_counted', false)
      .select()
      .maybeSingle();

  if (lockError) {
    console.error('[VIP累積消費] 鎖定訂單失敗', lockError);
    throw new Error('累積消費鎖定失敗');
  }

  if (!lockedOrder) {
    console.log(
      '[VIP累積消費] 這張訂單已被其他流程計算過',
      order.order_no || order.id
    );

    return {
      counted: false,
      amount: 0
    };
  }

  const guildId =
    lockedOrder.guild_id || order.guild_id || process.env.GUILD_ID;
  await checkAndUpgradeVip(
    userId,
    'spend',
    amount,
    guildId
  );
  await applyVipOrderCashback(
    lockedOrder,
    guildId
  );

  console.log(
    '[VIP累積消費] 已計入',
    {
      order: order.order_no || order.id,
      userId,
      amount,
      reason
    }
  );

  return {
    counted: true,
    amount
  };
}
async function checkVvipMonthlyKeep(userId, billingMonth = getBillingMonth(), guildId = process.env.GUILD_ID) {
  const { data: vip, error: vipError } =
    await getUserVipRecord(userId, guildId);

  if (vipError) {
    console.error('[VVIP保級] 讀取會員累積資料失敗', vipError);
    return null;
  }

  if (!vip?.level_key) {
    return null;
  }

  const { data: level } =
    await supabase
      .from('vip_levels')
      .select('*')
      .eq('guild_id', guildId)
      .eq('level_key', vip.level_key)
      .maybeSingle();

  if (!level || !level.is_vvip) {
    return null;
  }

  const required =
    Number(level.monthly_keep_required || 0);

  if (!required) {
    return null;
  }

  const monthStart =
    new Date(`${billingMonth}-01T00:00:00+08:00`);

  const nextMonth =
    new Date(monthStart);

  nextMonth.setMonth(nextMonth.getMonth() + 1);

  const { data: orders, error } =
    await supabase
      .from('play_orders')
      .select('final_price, price')
      .eq('guild_id', guildId)
      .eq('customer_id', userId)
      .eq('paid', true)
      .gte('paid_at', monthStart.toISOString())
      .lt('paid_at', nextMonth.toISOString());

  if (error) {
    console.error('[VVIP保級] 讀取月消費失敗', error);
    return null;
  }

  const monthlySpent =
    (orders || []).reduce(
      (sum, order) =>
        sum + Number(order.final_price || order.price || 0),
      0
    );

  const isPassed =
    monthlySpent >= required;

  await supabase
    .from('vip_monthly_keep_logs')
    .upsert(
      {
        user_id: userId,
        guild_id: guildId,
        billing_month: billingMonth,
        level_key: vip.level_key,
        level_name: vip.level_name,
        monthly_required: required,
        monthly_spent: monthlySpent,
        is_passed: isPassed,
        checked_at: new Date().toISOString()
      },
      {
        onConflict: 'guild_id,user_id,billing_month'
      }
    );

  return {
    userId,
    billingMonth,
    levelKey: vip.level_key,
    levelName: vip.level_name,
    required,
    monthlySpent,
    isPassed
  };
}
async function applyVipOrderCashback(order, guildId = process.env.GUILD_ID) {
  if (!order) return;

  if (order.vip_cashback_given) {
    return;
  }

  const userId =
    order.customer_id;

  const amount =
    Number(order.final_price || order.price || 0);

  if (!userId || !amount || amount <= 0) {
    return;
  }

  const { data: vip, error: vipError } =
    await getUserVipRecord(userId, guildId);

  if (vipError) {
    console.error('[VIP消費回饋] 讀取會員累積資料失敗', vipError);
    return;
  }

  if (!vip?.level_key) {
    return;
  }

  const { data: level } =
    await supabase
      .from('vip_levels')
      .select('*')
      .eq('guild_id', guildId)
      .eq('level_key', vip.level_key)
      .maybeSingle();

  if (!level) {
    return;
  }

  const playerCount =
    Number(order.player_count || 1);

  let cashbackRate =
    Number(level.cashback_rate || 0);

  const multiMin =
    Number(level.multi_player_min_count || 0);

  const multiRate =
    Number(level.multi_player_cashback_rate || 0);

  if (
    multiMin > 0 &&
    playerCount >= multiMin &&
    multiRate > cashbackRate
  ) {
    cashbackRate = multiRate;
  }

  const cashback =
    Math.floor(amount * cashbackRate);

  if (cashback > 0) {
    const finalCoins =
      await changeCoins(userId, cashback);

    await sendWalletLog(
      userId,
      'VIP消費回饋',
      cashback,
      finalCoins,
      `${level.level_name}｜訂單 ${order.order_no || order.id}｜消費回饋 ${cashback} ASD`
    );
  }

  if (
    vip.level_key === 'vip10' &&
    playerCount >= 3
  ) {
    await addUserItem(
      userId,
      '9折優惠券',
      'VIP10',
      'VIP10 三陪以上消費獎勵',
      'coupon',
      guildId

    );
  }

  await supabase
    .from('play_orders')
    .update({
      vip_cashback_given: true,
      vip_cashback_amount: cashback,
      vip_cashback_at: new Date().toISOString()
    })
    .eq('id', order.id);
}
// 更新簽到
async function updateCheckin(userId, date) {
  const { error } = await supabase.from('users').update({ last_checkin: date }).eq('user_id', userId);

  if (error) {
    console.error('[DB] 更新簽到失敗:', error);
    throw new Error('無法更新簽到');
  }
}

// 新增交易紀錄
async function addTransferRecord(senderId, receiverId, amount) {
  const { error } = await supabase
    .from('transfers')
    .insert([{ sender_id: senderId, receiver_id: receiverId, amount }]);

  if (error) {
    console.error('[DB] 記錄交易失敗:', error);
    throw new Error('無法記錄交易');
  }
}

// 錯誤回覆 (自動判斷回覆或追蹤)
async function replyError(interaction, message) {
  if (interaction.replied || interaction.deferred) {
    return await interaction.followUp({ content: `❌ ${message}`, flags: 64 }).catch(() => {});
  }

  return await interaction.reply({ content: `❌ ${message}`, flags: 64 }).catch(() => {});
}

// 查詢玩家排名
async function getUserRank(userId) {
  const { data, error } = await supabase.from('users').select('*').order('coins', { ascending: false });
  if (error) {
    console.error('[DB] 查詢排名失敗:', error);
    return null;
  }
  if (!data || data.length === 0) {
    return null;
  }
  const rank = data.findIndex((user) => user.user_id === userId);
  return rank === -1 ? null : rank + 1;
}

// 查詢交易紀錄
async function getTransferRecords(userId) {
  const { data, error } = await supabase
    .from('transfers')
    .select('*')
    .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) {
    console.error('[DB] 查詢交易紀錄失敗:', error);
    return [];
  }
  return data || [];
}
async function getWalletLogs(userId) {
  const { data, error } =
    await supabase
      .from('wallet_logs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(15);

  if (error) {
    console.error('[錢包明細查詢失敗]', error);
    return [];
  }

  return data || [];
}
async function generateMonthlyBills() {
  const billingMonth = getBillingMonth();
  const dueDate = getNextMonthDueDate();

  const { data: transactions, error } =
    await supabase
      .from('member_monthly_transactions')
      .select('*')
      .eq('billing_month', billingMonth)
      .eq('status', 'unbilled');

  if (error) {
    console.error('[月結帳單] 讀取交易失敗', error);
    return;
  }

  if (!transactions || transactions.length === 0) {
    console.log('[月結帳單] 本月沒有未結帳交易');
    return;
  }

  const grouped = {};

  for (const tx of transactions) {
    if (!grouped[tx.user_id]) {
      grouped[tx.user_id] = [];
    }

    grouped[tx.user_id].push(tx);
  }

  for (const userId of Object.keys(grouped)) {
    const list = grouped[userId];

    const totalAmount =
      list.reduce(
        (sum, tx) => sum + Number(tx.amount || 0),
        0
      );

    const cashbackAmount =
      list.reduce(
        (sum, tx) => sum + Number(tx.cashback || 0),
        0
      );

    const { data: existingBill } =
      await supabase
        .from('member_monthly_bills')
        .select('*')
        .eq('user_id', userId)
        .eq('billing_month', billingMonth)
        .maybeSingle();

    if (existingBill) {
      console.log(`[月結帳單] ${userId} ${billingMonth} 已有帳單，略過`);
      continue;
    }

    const { data: bill, error: billError } =
      await supabase
        .from('member_monthly_bills')
        .insert({
          user_id: userId,
          billing_month: billingMonth,
          total_amount: totalAmount,
          cashback_amount: cashbackAmount,
          status: 'unpaid',
          due_date: dueDate
        })
        .select()
        .single();

    if (billError || !bill) {
      console.error('[月結帳單] 建立帳單失敗', billError);
      continue;
    }

    await supabase
      .from('member_monthly_transactions')
      .update({
        status: 'billed'
      })
      .in(
        'id',
        list.map(tx => tx.id)
      );

    const detailText =
      list.map((tx, index) => {
        return (
          `${index + 1}. ${tx.item_name || '未填寫項目'}\n` +
          `類型：${tx.source_type || '未填寫'}\n` +
          `金額：NT$${Number(tx.amount || 0).toLocaleString('zh-TW')}\n` +
          `待回饋：${Number(tx.cashback || 0).toLocaleString('zh-TW')} 星雨幣`
        );
      }).join('\n\n');

    const user =
      await client.users
        .fetch(userId)
        .catch(() => null);

    if (user) {
      await user.send({
        embeds: [
          new EmbedBuilder()
            .setColor('#ffd166')
            .setTitle('🌙 星雨月結帳單')
            .setDescription(
              `結帳月份：${billingMonth}\n` +
              `需繳金額：NT$${totalAmount.toLocaleString('zh-TW')}\n` +
              `待發回饋：${cashbackAmount.toLocaleString('zh-TW')} 星雨幣\n` +
              `繳款期限：${dueDate}\n\n` +
              `請於期限前完成繳款，並將付款截圖提供給客服確認。\n\n` +
              `━━━━━━━━━━━━━━\n` +
              `帳單細項：\n${detailText.slice(0, 3000)}`
            )
            .setFooter({
              text: '星雨月結會員｜逾期可能暫停月結資格'
            })
            .setTimestamp()
        ]
      }).catch(err => {
        console.log('[月結帳單] 私訊失敗', userId, err.message);
      });
    }
  }

  console.log(`[月結帳單] ${billingMonth} 已產生完成`);
}
// 讀取商店商品
async function getShopItems() {
  const { data, error } = await supabase.from('shop_items').select('*').order('price', { ascending: true });
  if (error) {
    console.error('[DB] 商店讀取失敗:', error);
    return [];
  }
  return data || [];
}
// 新增商品
async function addShopItem(itemName, price, description, itemType = 'shop') {
  const { error } = await supabase.from('shop_items').insert([{ item_name: itemName, price, description, item_type: itemType }]);

  if (error) {
    console.error('[DB] 新增商品失敗:', error);
    throw new Error('新增商品失敗');
  }
}
// 刪除商品
async function removeShopItem(itemName) {
  const { error } = await supabase.from('shop_items').delete().eq('item_name', itemName);

  if (error) {
    console.error('[DB] 刪除商品失敗:', error);
    throw new Error('刪除商品失敗');
  }
}
// 新增玩家商品
async function addUserItem(
  userId,
  itemName,
  rarity = null,
  description = null,
  itemType = 'shop'
) {
  const { error } = await supabase
    .from('user_items')
    .insert([
      {
        user_id: userId,
        item_name: itemName,
        rarity,
        description,
        item_type: itemType
      }
    ]);

  if (error) {
    console.error('[DB] 新增玩家商品失敗:');
    console.error(error);
    console.error(error.message);
    console.error(error.details);
    console.error(error.hint);
    console.error(error.code);
    throw new Error('新增玩家商品失敗');
  }
}
// 讀取玩家商品
async function getUserItems(userId) {
  const { data, error } = await supabase
    .from('user_items')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[DB] 讀取玩家商品失敗:', error);
    return [];
  }

  return data || [];
} 
// 刪除玩家商品
async function removeUserItem(itemId) {
  const { error } = await supabase
    .from('user_items')
    .delete()
    .eq('id', itemId);

  if (error) {
    console.error('[DB] 刪除玩家商品失敗:', error);
    throw new Error('刪除玩家商品失敗');
  }
}
function isCouponInventoryItem(item) {
  const itemName =
    String(item?.item_name || '');

  return (
    item?.item_type === 'coupon' ||
    itemName.includes('折券') ||
    itemName.includes('優惠券')
  );
}

function formatCouponChoiceName(coupon) {
  const itemName =
    String(coupon?.item_name || '未知優惠券');

  return `${itemName}｜#${coupon.id}`.slice(0, 100);
}

function findCouponFromSelection(items, couponValue) {
  const selectedId =
    Number(couponValue);

  if (Number.isInteger(selectedId)) {
    const byId =
      items.find(item =>
        Number(item.id) === selectedId &&
        isCouponInventoryItem(item)
      );

    if (byId) return byId;
  }

  const normalizedValue =
    String(couponValue || '')
      .replace(/\s+/g, '')
      .toLowerCase();

  return items.find(item => {
    const normalizedName =
      String(item.item_name || '')
        .replace(/\s+/g, '')
        .toLowerCase();

    return (
      isCouponInventoryItem(item) &&
      normalizedName === normalizedValue
    );
  });
}

async function handleUseCouponAutocomplete(interaction) {
  if (interaction.commandName !== '使用優惠券') return false;

  const focused =
    interaction.options.getFocused(true);

  if (focused.name !== '優惠券') {
    await interaction.respond([]);
    return true;
  }

  const customerId =
    String(
      interaction.options.get('客人')?.value || ''
    ).trim();

  if (!customerId) {
    await interaction.respond([
      {
        name: '請先選擇客人',
        value: '__no_customer__'
      }
    ]);
    return true;
  }

  const keyword =
    String(focused.value || '')
      .trim()
      .toLowerCase();

  const coupons =
    (await getUserItems(customerId))
      .filter(isCouponInventoryItem)
      .filter(coupon => {
        if (!keyword) return true;

        return String(coupon.item_name || '')
          .toLowerCase()
          .includes(keyword);
      })
      .slice(0, 25)
      .map(coupon => ({
        name: formatCouponChoiceName(coupon),
        value: String(coupon.id)
      }));

  if (coupons.length === 0) {
    await interaction.respond([
      {
        name: '這位客人目前沒有符合的優惠券',
        value: '__no_coupon__'
      }
    ]);
    return true;
  }

  await interaction.respond(coupons);
  return true;
}

async function handleUseCouponCommand(interaction) {
  if (!isAdminOrStaff(interaction)) {
    return interaction.editReply({
      content: '❌ 只有客服或管理員可以使用這個指令'
    });
  }

  const target =
    interaction.options.getUser('客人');
  const couponValue =
    interaction.options.getString('優惠券');

  if (!target) {
    return interaction.editReply({
      content: '❌ 找不到客人'
    });
  }

  if (target.bot) {
    return interaction.editReply({
      content: '❌ 不能對機器人使用優惠券'
    });
  }

  if (
    !couponValue ||
    couponValue === '__no_customer__' ||
    couponValue === '__no_coupon__'
  ) {
    return interaction.editReply({
      content: '❌ 請選擇客人持有的優惠券'
    });
  }

  const items =
    await getUserItems(target.id);
  const coupon =
    findCouponFromSelection(
      items,
      couponValue
    );

  if (!coupon) {
    const ownedCoupons =
      items
        .filter(isCouponInventoryItem)
        .slice(0, 10)
        .map(item => `- ${item.item_name}`)
        .join('\n');

    return interaction.editReply({
      content:
        `❌ <@${target.id}> 沒有這張優惠券。\n` +
        (
          ownedCoupons
            ? `目前持有：\n${ownedCoupons}`
            : '目前沒有任何優惠券。'
        )
    });
  }

  try {
    await removeUserItem(coupon.id);
  } catch (deleteError) {
    console.error('[手動使用優惠券] 刪除優惠券失敗', deleteError);
    return interaction.editReply({
      content: '❌ 使用優惠券失敗，無法從客人背包移除這張券'
    });
  }

  const { error: usedError } =
    await supabase
      .from('used_coupons')
      .insert({
        user_id: target.id,
        item_name: coupon.item_name,
        item_id: coupon.id
      });

  if (usedError) {
    console.error('[手動使用優惠券] 使用紀錄寫入失敗', usedError);
  }

  const user =
    await client.users.fetch(target.id).catch(() => null);

  if (user) {
    await user.send({
      embeds: [
        new EmbedBuilder()
          .setColor('#ffd166')
          .setTitle('🎟️ 優惠券已使用')
          .setDescription(
            `你的優惠券已由客服使用：**${coupon.item_name}**`
          )
          .setTimestamp()
      ]
    }).catch(() => {});
  }

  return interaction.editReply({
    content:
      `✅ 已使用優惠券\n\n` +
      `客人：<@${target.id}>\n` +
      `優惠券：${coupon.item_name}\n` +
      `操作人：<@${interaction.user.id}>` +
      (
        usedError
          ? '\n⚠️ 優惠券已移除，但使用紀錄寫入失敗，請稍後確認 used_coupons。'
          : ''
      )
  });
}
// 安全轉帳函數
async function safeTransfer(
  senderId,
  receiverId,
  amount
) {
    // ===== 轉帳冷卻 =====
    const now = Date.now();
    const cooldown =
    transferCooldown.get(
      senderId
    );
    if (
      cooldown &&
      now - cooldown < 5000
    ) {
      throw new Error(
        '轉帳太快，請 5 秒後再試'
      );
    }
    transferCooldown.set(
      senderId,
      now
    );
    setTimeout(() => {
      transferCooldown.delete(senderId);
    }, 5000);
  if (isNaN(amount) || amount <= 0) {
    throw new Error('金額無效');
  }
  if (amount > 10000) {
    throw new Error(
      '單次轉帳不能超過 10000'
    );
  }
  if (senderId === receiverId) {
    throw new Error('不能轉給自己');
  }
  const { error } =
    await supabase.rpc(
      'transfer_coins',
      {
        sender_id: senderId,
        receiver_id: receiverId,
        transfer_amount: amount,
      }
    );
  if (error) {
    console.error(
      '[轉帳失敗]',
      error
    );
    if (
      error.message.includes(
        '餘額不足'
      )
    ) {
      throw new Error(
        '星雨幣不足'
      );
    }
    throw new Error(
      '轉帳失敗'
    );
    }
  console.log(
  `[轉帳成功] ${senderId} -> ${receiverId} ${amount}枚`
  );
  // ===== 取得玩家名稱 =====
  const senderUser =
    await client.users.fetch(
      senderId
    );
  const receiverUser =
    await client.users.fetch(
      receiverId
    );
  // ===== 新增交易紀錄 =====
  await addTransferRecord(
    senderId,
    receiverId,
    amount
  );
  // ===== 重新取得餘額 =====
  const senderData =
    await getUser(senderId);
  const receiverData =
    await getUser(receiverId);
  // ===== 錢包通知 =====
  await sendWalletLog(
    senderId,
    '轉帳支出',
    -amount,
    senderData.coins,
    `💸 轉帳給 <@${receiverId}>`
  );
  await sendWalletLog(
    receiverId,
    '轉帳收入',
    amount,
    receiverData.coins,
    `💰 收到 <@${senderId}> 的轉帳`
  );
  return {
    success: true
  };
}

// 取得今日日期 (UTC+8)
function getTodayDateString() {
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return utc8.toISOString().split('T')[0];
}
function getTaiwanNow() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

function getBillingMonth(date = new Date()) {
  const taiwanDate =
    new Date(date.getTime() + 8 * 60 * 60 * 1000);

  return taiwanDate.toISOString().slice(0, 7);
}

function getNextMonthDueDate() {
  const taiwanNow = getTaiwanNow();

  const year = taiwanNow.getUTCFullYear();
  const month = taiwanNow.getUTCMonth();

  const dueDate =
    new Date(Date.UTC(year, month + 1, 16));

  return dueDate.toISOString().slice(0, 10);
}
// ===== SSR 連抽降權設定 =====
// 抽到第一個 SSR 後，後續 SSR 權重只剩 15%
const SSR_WEIGHT_AFTER_HIT = 0.15;

async function performGacha(userId, guildId, amount, poolId = null) {
  let pool;

  if (poolId) {
    const { data, error } =
      await supabase
        .from('gacha_pools')
        .select('*')
        .eq('id', poolId)
        .single();

    if (error || !data) {
      throw new Error('找不到指定卡池');
    }

    pool = data;
  } else {
    const { data: pools } =
      await supabase
        .from('gacha_pools')
        .select('*');

    if (!pools || pools.length === 0) {
      throw new Error('目前沒有卡池');
    }

    pool = pools[0];
  }

  const totalPrice =
    pool.price * amount;

  const userData =
    await getUser(userId);

  if (userData.coins < totalPrice) {
    throw new Error('星雨幣不足');
  }

  const { data: rewards } =
    await supabase
      .from('gacha_rewards')
      .select('*')
      .eq('pool_id', pool.id);

  if (!rewards || rewards.length === 0) {
    throw new Error('卡池沒有獎勵');
  }

  let results = [];
  let totalRewardCoins = 0;
  let insertItems = [];

  // ===== 本次抽取是否已經出過 SSR =====
  let hasHitSSR = false;

  for (let i = 0; i < amount; i++) {
    // ===== 動態權重 =====
    const weightedRewards =
      rewards.map(reward => {
        let weight =
          Number(reward.chance || 0);

        // 抽到第一個 SSR 後，後續 SSR 權重大幅下降
        if (
          hasHitSSR &&
          reward.rarity === 'SSR'
        ) {
          weight =
            weight * SSR_WEIGHT_AFTER_HIT;
        }

        return {
          ...reward,
          adjustedWeight: weight
        };
      }).filter(reward =>
        reward.adjustedWeight > 0
      );

    const totalWeight =
      weightedRewards.reduce(
        (sum, reward) =>
          sum + reward.adjustedWeight,
        0
      );

    if (totalWeight <= 0) {
      throw new Error('卡池權重設定錯誤');
    }

    let random =
      Math.random() * totalWeight;

    let selected =
      weightedRewards[0];

    for (const reward of weightedRewards) {
      random -= reward.adjustedWeight;

      if (random <= 0) {
        selected = reward;
        break;
      }
    }

    if (selected.rarity === 'SSR') {
      hasHitSSR = true;
    }

    const rewardCoins =
      selected.reward_coins || 0;

    totalRewardCoins += rewardCoins;

    const rewardName =
      String(selected.reward_name || '');
    const itemType =
      rewardName.includes('優惠券') ||
      rewardName.includes('折券') ||
      rewardName.includes('券')
        ? 'coupon'
        : 'gacha';

    const isCoinReward =
      selected.reward_name.includes('星雨幣') ||
      selected.reward_name.includes('金幣') ||
      selected.reward_name.includes('幣') ||
      String(selected.reward_description || '').includes('星雨幣');

    if (!isCoinReward) {
      insertItems.push({
        user_id: userId,
        item_name: selected.reward_name,
        rarity: selected.rarity,
        description: selected.reward_description,
        item_type: itemType
      });
    }

    results.push({
      name: selected.reward_name,
      rarity: selected.rarity,
      description: selected.reward_description,
      coins: rewardCoins,
      itemType,
      weight: selected.adjustedWeight
    });
  }

  const finalCoins =
    userData.coins -
    totalPrice +
    totalRewardCoins;

  const { error } =
    await supabase.rpc(
      'perform_gacha',
      {
        p_user_id: userId,
        p_cost: totalPrice,
        p_final_coins: finalCoins,
        p_rewards: insertItems
      }
    );

  if (error) {
    console.error(error);
    throw new Error('扭蛋失敗');
  }

  return {
    results,
    totalRewardCoins,
    finalCoins,
    cost: totalPrice
  };
}
// 刷新商店
async function refreshShop(client) {
  const shopChannel = await client.channels.fetch(process.env.SHOP_CHANNEL);
  if (!shopChannel) return;

  const items = await getShopItems();

  // 商品內容
  let text = '';
  if (items.length === 0) {
    text = '目前商店沒有商品';
  } else {
    text = items.map((item, index) => `${index + 1}. ${item.item_name}\n💰 ${item.price} 星雨幣\n📦 ${item.description}`).join('\n\n');
  }

  // Embed
  const embed =
    new EmbedBuilder()
      .setColor('#00ffcc')
      .setTitle('🛒 星雨商店')
      .setDescription(
        `✨ 歡迎來到星雨商店\n\n` +
        `你可以使用星雨幣購買各種商品與折券。\n\n` +
        `━━━━━━━━━━━━━━\n` +
        `🎟️ 折券｜訂單優惠使用\n` +
        `🎁 特殊道具｜活動使用\n` +
        `🌈 限定商品｜不定期上架`
      )
      .setThumbnail(client.user.displayAvatarURL())
      .setFooter({
        text: '星雨商店｜商品售出後恕不退換'
      })
      .setTimestamp()
  let components = [];
  if (items.length > 0) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('shop_select')
      .setPlaceholder('選擇要購買的商品')
      .addOptions(
        items.slice(0, 25).map(item => ({
          label: item.item_name.slice(0, 100),
          description:
            `💰 ${item.price} 星雨幣｜${item.description || '無介紹'}`
              .slice(0, 100),
          value: String(item.id)
        }))
      );
    const row = new ActionRowBuilder().addComponents(menu);
    components.push(row);
  }

    const panel =
      await getPanelMessage('shop');
    if (panel) {
      try {
        const msg =
          await shopChannel.messages.fetch(
            panel.message_id
          );
        await msg.edit({
          embeds: [embed],
          components
        });
      } catch {
        const newMsg =
          await shopChannel.send({
            embeds: [embed],
            components
          });
        await savePanelMessage(
          'shop',
          shopChannel.id,
          newMsg.id
        );
      }
    } else {
      const newMsg =
        await shopChannel.send({
          embeds: [embed],
          components
        });
      await savePanelMessage(
        'shop',
        shopChannel.id,
        newMsg.id
      );
    }
}
async function sendTopupPanel(client) {
  const channelId =
    process.env.TOPUP_ORDER_CHANNEL;

  if (!channelId) {
    console.log('[TOPUP PANEL] 沒有設定 TOPUP_ORDER_CHANNEL，略過');
    return;
  }

  const channel =
    await client.channels.fetch(channelId).catch(() => null);

  if (!channel) {
    console.log('[TOPUP PANEL] 找不到儲值頻道');
    return;
  }

  const embed =
    new EmbedBuilder()
      .setColor('#ffd166')
      .setTitle('💳 ASD 儲值區')
      .setDescription(
        `歡迎來到 ASD 儲值區。\n\n` +
        `點擊下方按鈕後，系統會建立專屬儲值臨時頻道。\n\n` +
        `匯率：1 元台幣 = 1 ASD\n` +
        `支援付款方式：匯款 / 無卡 / 刷卡 / 美金 / 加密貨幣`
      )
      .setFooter({
        text: '深夜不關燈｜We Are Still Here'
      })
      .setTimestamp();

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('order_start_topup')
          .setLabel('建立儲值單')
          .setEmoji('💳')
          .setStyle(ButtonStyle.Success)
      );

  const panel =
    await getPanelMessage('order_topup', process.env.GUILD_ID);

  if (panel) {
    try {
      const oldMessage =
        await channel.messages.fetch(panel.message_id);

      await oldMessage.edit({
        embeds: [embed],
        components: [row]
      });

      console.log('[TOPUP PANEL] 已更新');
      return;
    } catch (err) {
      console.log('[TOPUP PANEL] 舊面板不存在，重新建立');
    }
  }

  const newMessage =
    await channel.send({
      embeds: [embed],
      components: [row]
    });

  await savePanelMessage(
    'order_topup',
    channel.id,
    newMessage.id,
    process.env.GUILD_ID
  );

  console.log('[TOPUP PANEL] 已建立');
}
// ===== 發送訂單系統 =====
async function sendCheckinPanel(client) {

  const channel =
    await client.channels.fetch(
      process.env.CHECKIN_CHANNEL
    );

  if (!channel) return;

  const button =
    new ButtonBuilder()
      .setCustomId('daily_checkin')
      .setLabel('☔ 每日簽到')
      .setStyle(ButtonStyle.Success);

  const row =
    new ActionRowBuilder()
      .addComponents(button);

  const embed =
    new EmbedBuilder()
      .setColor('#ffd700')
      .setTitle('📅 星雨每日簽到')
      .setDescription(
        `✨ 每日簽到系統\n\n` +
        `每天都可以領取星雨幣獎勵！\n` +
        `連續簽到可能會有額外驚喜 🎁\n\n` +
        `━━━━━━━━━━━━━━\n` +
        `🪙 每日領取星雨幣\n` +
        `🔥 維持你的連續簽到紀錄\n` +
        `🎉 不定期簽到活動`
      )
      .setThumbnail(client.user.displayAvatarURL())
      .setFooter({
      text: '星雨簽到系統｜每天記得來簽到 ✨'
      })
      .setTimestamp()
  const panel =
    await getPanelMessage('checkin');

  if (panel) {
    try {
      const msg =
        await channel.messages.fetch(
          panel.message_id
        );

      await msg.edit({
        embeds: [embed],
        components: [row]
      });

      console.log('[CHECKIN] 已更新');
      return;

    } catch (err) {
      console.error(err);
    }
  }

  const newMsg =
    await channel.send({
      embeds: [embed],
      components: [row]
    });

  await savePanelMessage(
    'checkin',
    channel.id,
    newMsg.id
  );

  console.log('[CHECKIN] 已建立');
}
async function sendAtmPanel(client) {

  const channel =
    await client.channels.fetch(
      process.env.CHANNEL_ID
    );

  if (!channel) return;
  const balanceButton =
    new ButtonBuilder()
      .setCustomId('check_coins')
      .setLabel('💰 查看餘額')
      .setStyle(ButtonStyle.Primary);
  const transferButton =
    new ButtonBuilder()
      .setCustomId('transfer_menu')
      .setLabel('💸 玩家轉帳')
      .setStyle(ButtonStyle.Primary);
  const consumeButton =
    new ButtonBuilder()
      .setCustomId('consume_info')
      .setLabel('💠 消費資訊')
      .setStyle(ButtonStyle.Primary);
  const transferRecordButton =
    new ButtonBuilder()
      .setCustomId('transfer_records')
      .setLabel('📜 交易紀錄')
      .setStyle(ButtonStyle.Success);
  const bagButton =
    new ButtonBuilder()
      .setCustomId('my_bag')
      .setLabel('🎒 我的背包')
      .setStyle(ButtonStyle.Success);
  const switchBenefitButton =
    new ButtonBuilder()
      .setCustomId('switch_benefit')
      .setLabel('🔄 切換權益')
      .setStyle(ButtonStyle.Secondary);
  const monthlyInfoButton =
    new ButtonBuilder()
      .setCustomId('monthly_info')
      .setLabel('🌙 查詢月結')
      .setStyle(ButtonStyle.Secondary);
  const monthlyPayButton =
    new ButtonBuilder()
      .setCustomId('monthly_bill_pay')
      .setLabel('🌙 月結繳費')
      .setStyle(ButtonStyle.Secondary);
  const row =
    new ActionRowBuilder()
      .addComponents(
        balanceButton,
        transferButton,
        consumeButton,
        transferRecordButton,
        bagButton
      );
  const row2 =
    new ActionRowBuilder()
      .addComponents(
        switchBenefitButton,
        monthlyInfoButton,
        monthlyPayButton
      );
  const embed =
    new EmbedBuilder()
      .setColor('#00ffff')
      .setTitle('🏦 星雨 ATM')
      .setDescription(
        `💳 歡迎使用星雨銀行\n\n` +
        `你可以在這裡查看餘額或轉帳給其他玩家。\n\n` +
        `━━━━━━━━━━━━━━\n` +
        `💰 查看餘額｜確認目前星雨幣\n` +
        `💸 玩家轉帳｜轉帳給指定玩家\n` +
        `💠 消費資訊｜查看累積消費\n` +
        `📜 交易紀錄｜查看最近錢包明細\n` +
        `🔄 切換權益｜每日最多切換 2 次\n` +
        `🌙 查詢月結｜查看保證金與剩餘額度`
      )
      .setThumbnail(client.user.displayAvatarURL())
      .setFooter({
        text: '星雨銀行｜交易請確認對象與金額'
      })
      .setTimestamp()
  const panel =
    await getPanelMessage('atm');

  if (panel) {
    try {
      const msg =
        await channel.messages.fetch(
          panel.message_id
        );

      await msg.edit({
        embeds: [embed],
        components: [row, row2]
      });

      console.log('[ATM] 已更新');
      return;

    } catch (err) {
      console.error(err);
    }
  }

  const newMsg =
    await channel.send({
      embeds: [embed],
      components: [row, row2]
    });

  await savePanelMessage(
    'atm',
    channel.id,
    newMsg.id
  );

  console.log('[ATM] 已建立');
}
async function sendGachaPanel(client) {

  const channel =
    await client.channels.fetch(
      process.env.GACHA_CHANNEL
    );

  if (!channel) return;
  const viewButton =
    new ButtonBuilder()
      .setCustomId('gacha_view_pool')
      .setLabel('📦 查看獎池')
      .setStyle(ButtonStyle.Secondary);
  const row =
    new ActionRowBuilder()
      .addComponents(viewButton);
  const embed =
    new EmbedBuilder()
      .setColor('#ff66cc')
      .setTitle('🎰 星雨扭蛋機')
      .setDescription(
        `✨ 歡迎來到星雨扭蛋機\n\n` +
        `📦 請先查看目前獎池\n` +
        `🎯 選擇想抽的卡池後再進行抽取\n\n` +
        `━━━━━━━━━━━━━━\n` +
        `🌈 SSR｜超稀有獎勵\n` +
        `⭐ SR｜高級獎勵\n` +
        `🔹 R｜一般獎勵`
      )
      .setThumbnail(client.user.displayAvatarURL())
      .setFooter({
        text: '星雨系統｜祝你抽到大獎 ✨'
      })
      .setTimestamp()
  const panel =
    await getPanelMessage('gacha');

  if (panel) {
    try {
      const msg =
        await channel.messages.fetch(
          panel.message_id
        );

      await msg.edit({
        embeds: [embed],
        components: [row]
      });

      console.log('[GACHA] 已更新');
      return;

    } catch (err) {
      console.error(err);
    }
  }

  const newMsg =
    await channel.send({
      embeds: [embed],
      components: [row]
    });

  await savePanelMessage(
    'gacha',
    channel.id,
    newMsg.id
  );

  console.log('[GACHA] 已建立');
}
async function sendOrderSystem(client) {
  const channel =
    await client.channels.fetch(process.env.ORDER_CHANNEL);

  if (!channel) return;

  const embed =
    new EmbedBuilder()
      .setColor('#ff66cc')
      .setTitle('🌙 星雨訂單中心')
      .setDescription(
        `請選擇要建立的服務。\n\n` +
        `**下單區**\n` +
        `🎯 特戰英豪｜🎮 Steam｜🛡️ 三角洲｜💬 陪聊｜🧸 出氣包\n\n` +
        `**儲值區**\n` +
        `💳 儲值 ASD\n\n` +
        `**打賞區**\n` +
        `💝 打賞陪陪禮物`
      )
      .setFooter({
        text: '深夜不關燈｜We Are Still Here'
      })
      .setTimestamp()
      .setImage('https://cdn.discordapp.com/attachments/1501098193276895360/1505274858567762153/ChatGPT_Image_2026517_02_24_37.png?ex=6a0a07f4&is=6a08b674&hm=e3cf59696e54af40365cec86b215036e4ee34bc83ac941016808de3719010617&');
  const row1 =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('order_start_valorant')
          .setLabel('特戰英豪')
          .setEmoji('🎯')
          .setStyle(ButtonStyle.Primary),

        new ButtonBuilder()
          .setCustomId('order_start_steam')
          .setLabel('Steam')
          .setEmoji('🎮')
          .setStyle(ButtonStyle.Primary),

        new ButtonBuilder()
          .setCustomId('order_start_delta')
          .setLabel('三角洲行動')
          .setEmoji('🛡️')
          .setStyle(ButtonStyle.Primary)
      );

  const row2 =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('order_start_chat')
          .setLabel('陪聊服務')
          .setEmoji('💬')
          .setStyle(ButtonStyle.Secondary),

        new ButtonBuilder()
          .setCustomId('order_start_emotion')
          .setLabel('出氣服務')
          .setEmoji('🧸')
          .setStyle(ButtonStyle.Secondary)
      );

  const row3 =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('order_start_topup')
          .setLabel('儲值')
          .setEmoji('💳')
          .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
          .setCustomId('order_start_tip')
          .setLabel('打賞')
          .setEmoji('💝')
          .setStyle(ButtonStyle.Danger)
      );

  const messages =
    await channel.messages.fetch({
      limit: 10
    });

  const oldPanel =
    messages.find(
      msg =>
        msg.author.id === client.user.id &&
        msg.embeds.length > 0 &&
        msg.embeds[0].title === '🌙 星雨訂單中心'
    );

  if (oldPanel) {
    await oldPanel.edit({
      embeds: [embed],
      components: [row1, row2, row3]
    });
    return;
  }

  await channel.send({
    embeds: [embed],
    components: [row1, row2, row3]
  });
}
// ===== 私人臨時文字頻道面板 =====
async function sendPrivateRoomPanel(client) {
  const channel =
    await client.channels.fetch(
      process.env.PRIVATE_ROOM_PANEL_CHANNEL
    ).catch(() => null);

  if (!channel) {
    console.log('[PRIVATE ROOM] 找不到面板頻道');
    return;
  }

  const embed =
    new EmbedBuilder()
      .setColor('#66ccff')
      .setTitle('🔐 私人文字房間')
      .setDescription(
        '按下下方按鈕後，系統會建立一個只有你看得到的臨時文字頻道。\n\n' +
        '進入後你可以自行邀請想加入的人。'
      )
      .setTimestamp();

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('create_private_room')
          .setLabel('建立私人文字頻道')
          .setEmoji('🔐')
          .setStyle(ButtonStyle.Primary)
      );

  const panel =
    await getPanelMessage('private_room');

  if (panel) {
    try {
      const oldMessage =
        await channel.messages.fetch(
          panel.message_id
        );

      await oldMessage.edit({
        embeds: [embed],
        components: [row]
      });

      console.log('[PRIVATE ROOM] 已更新舊面板');
      return;

    } catch (err) {
      console.log('[PRIVATE ROOM] 舊面板不存在，重新建立');
    }
  }

  const newMessage =
    await channel.send({
      embeds: [embed],
      components: [row]
    });

  await savePanelMessage(
    'private_room',
    channel.id,
    newMessage.id
  );

  console.log('[PRIVATE ROOM] 已建立新面板');
}
// ===== 指令定義 =====

const commands = [

  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('測試機器人'),
  new SlashCommandBuilder()
    .setName('我的排名')
    .setDescription('查看自己的排名'),
  new SlashCommandBuilder()
    .setName('餘額')
    .setDescription('公開查看自己的 ASD 餘額，管理員可指定玩家')
    .addUserOption(option =>
      option
        .setName('玩家')
        .setDescription('管理員可指定要查詢餘額的玩家')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('隱藏餘額')
    .setDescription('切換是否隱藏自己的錢包餘額'),
  new SlashCommandBuilder()
    .setName('批量刪除頻道')
    .setDescription('一次選擇多個文字頻道並刪除'),
  new SlashCommandBuilder()
    .setName('交易紀錄')
    .setDescription('查看最近交易'),
  new SlashCommandBuilder()
    .setName('我的商品')
    .setDescription('查看自己購買的商品'),
  new SlashCommandBuilder()
    .setName('刪除商品')
    .setDescription('刪除商店商品')
    .addStringOption(option =>
      option
        .setName('名稱')
        .setDescription('商品名稱')
        .setRequired(true)
    ),

  // ===== 扭蛋 =====

  new SlashCommandBuilder()
    .setName('新增卡池')
    .setDescription('新增扭蛋卡池')
    .addStringOption(option =>
      option
        .setName('名稱')
        .setDescription('卡池名稱')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('價格')
        .setDescription('抽一次價格')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('刪除扭蛋')
    .setDescription('刪除扭蛋卡池')
    .addStringOption(option =>
      option
        .setName('名稱')
        .setDescription('卡池名稱')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('新增獎勵')
    .setDescription('新增卡池獎勵')
    .addIntegerOption(option =>
      option.setName('卡池id')
        .setDescription('卡池 ID')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('名稱')
        .setDescription('獎勵名稱')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('介紹')
        .setDescription('獎勵介紹')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('稀有度')
        .setDescription('SSR / SR / R')
        .setRequired(true)
    )
    .addNumberOption(option =>
      option
        .setName('機率')
        .setDescription('權重數值，數字越大越容易抽到，例如：SSR=1、SR=20、R=79')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('星雨幣')
        .setDescription('中獎時給多少星雨幣')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('刪除獎勵')
    .setDescription('刪除卡池獎勵')
    .addIntegerOption(option =>
      option
        .setName('卡池id')
        .setDescription('卡池 ID')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('名稱')
        .setDescription('獎勵名稱')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('扭蛋列表')
    .setDescription('查看目前所有扭蛋'),

  new SlashCommandBuilder()
    .setName('單抽')
    .setDescription('抽一次扭蛋'),

  new SlashCommandBuilder()
    .setName('十抽')
    .setDescription('抽十次扭蛋'),

  // ===== 金錢 =====
  new SlashCommandBuilder()
    .setName('發紅包')
    .setDescription('發送星雨幣紅包')
    .addIntegerOption(option =>
      option
        .setName('金額')
        .setDescription('紅包總金額')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('數量')
        .setDescription('可領取人數')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('發錢')
    .setDescription('給予玩家星雨幣')
    .addUserOption(option =>
      option.setName('玩家')
        .setDescription('選擇玩家')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('金額')
        .setDescription('輸入金額')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('扣錢')
    .setDescription('扣除玩家星雨幣')
    .addUserOption(option =>
      option.setName('玩家')
        .setDescription('選擇玩家')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('金額')
        .setDescription('輸入金額')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('發送優惠券')
    .setDescription('發送優惠券給指定玩家')
    .addUserOption(option =>
      option
        .setName('玩家')
        .setDescription('選擇要發送優惠券的玩家')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('優惠券')
        .setDescription('選擇要發送的優惠券')
        .setRequired(true)
        .addChoices(
          {
            name: '95折券',
            value: '95折券'
          },
          {
            name: '9折券',
            value: '9折券'
          },
          {
            name: '8折折價券',
            value: '8折折價券'
          },
          {
            name: '7折折價券',
            value: '7折折價券'
          },
          {
            name: '6折折價券',
            value: '6折折價券'
          }
        )
    )
    .addIntegerOption(option =>
      option
        .setName('數量')
        .setDescription('要發送幾張')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(20)
    )
    .addStringOption(option =>
      option
        .setName('備註')
        .setDescription('可不填，例如：活動補發、VIP福利、客服補償')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('使用優惠券')
    .setDescription('替客人手動使用一張持有的優惠券')
    .addUserOption(option =>
      option
        .setName('客人')
        .setDescription('選擇要使用優惠券的客人')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('優惠券')
        .setDescription('先選客人，再選擇客人持有的優惠券')
        .setRequired(true)
        .setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName('給與身份組')
    .setDescription('給指定成員、多位成員或所有人發放身份組')
    .addRoleOption(option =>
      option
        .setName('身份組')
        .setDescription('選擇要發放的身份組')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('發放對象')
        .setDescription('選擇要發給誰')
        .setRequired(true)
        .addChoices(
          {
            name: '單人',
            value: 'single'
          },
          {
            name: '多人',
            value: 'multiple'
          },
          {
            name: '所有人',
            value: 'all'
          }
        )
    )
    .addUserOption(option =>
      option
        .setName('成員1')
        .setDescription('要發放的成員')
        .setRequired(false)
    )
    .addUserOption(option =>
      option
        .setName('成員2')
        .setDescription('多人發放用')
        .setRequired(false)
    )
    .addUserOption(option =>
      option
        .setName('成員3')
        .setDescription('多人發放用')
        .setRequired(false)
    )
    .addUserOption(option =>
      option
        .setName('成員4')
        .setDescription('多人發放用')
        .setRequired(false)
    )
    .addUserOption(option =>
      option
        .setName('成員5')
        .setDescription('多人發放用')
        .setRequired(false)
    )
    .addUserOption(option =>
      option
        .setName('成員6')
        .setDescription('多人發放用')
        .setRequired(false)
    )
    .addUserOption(option =>
      option
        .setName('成員7')
        .setDescription('多人發放用')
        .setRequired(false)
    )
    .addUserOption(option =>
      option
        .setName('成員8')
        .setDescription('多人發放用')
        .setRequired(false)
    )
    .addUserOption(option =>
      option
        .setName('成員9')
        .setDescription('多人發放用')
        .setRequired(false)
    )
    .addUserOption(option =>
      option
        .setName('成員10')
        .setDescription('多人發放用')
        .setRequired(false)
    )
    .addStringOption(option =>
      option
        .setName('備註')
        .setDescription('可不填，例如：活動身分組、補發、管理員發放')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('加時')
    .setDescription('替訂單建立加時 / 續單付款')
    .addStringOption(option =>
      option
        .setName('時長')
        .setDescription('例如：30分鐘、1局、續聊1小時')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('金額')
        .setDescription('加時金額')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('訂單id')
        .setDescription('訂單資料庫 ID，可空白，空白時會用目前頻道尋找')
        .setRequired(false)
    )
    .addStringOption(option =>
      option
        .setName('訂單編號')
        .setDescription('訂單編號，可空白')
        .setRequired(false)
    )
    .addStringOption(option =>
      option
        .setName('備註')
        .setDescription('可不填，例如：客人要求延長，陪陪同意')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('調整累積消費')
    .setDescription('手動調整會員累積消費金額')
    .addUserOption(option =>
      option
        .setName('玩家')
        .setDescription('選擇要調整的會員')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('金額')
        .setDescription('要調整的金額，例如 500 或 -500')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('模式')
        .setDescription('增加、扣除或直接設定')
        .setRequired(true)
        .addChoices(
          { name: '增加', value: 'add' },
          { name: '扣除', value: 'subtract' },
          { name: '直接設定', value: 'set' }
        )
    )
    .addStringOption(option =>
      option
        .setName('備註')
        .setDescription('例如：補登消費、修正重複累積')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('查詢累積')
    .setDescription('公開查詢會員累積儲值與累積消費')
    .addUserOption(option =>
      option
        .setName('玩家')
        .setDescription('要查詢的會員，不填則查詢自己')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('調整累積儲值')
    .setDescription('手動調整會員累積儲值金額')
    .addUserOption(option =>
      option
        .setName('玩家')
        .setDescription('選擇要調整的會員')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('金額')
        .setDescription('要調整的儲值金額，例如 500')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('模式')
        .setDescription('增加、扣除或直接設定')
        .setRequired(true)
        .addChoices(
          { name: '增加', value: 'add' },
          { name: '扣除', value: 'subtract' },
          { name: '直接設定', value: 'set' }
        )
    )
    .addStringOption(option =>
      option
        .setName('備註')
        .setDescription('例如：補登儲值、修正重複累積')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('設定月結')
    .setDescription('設定會員月結保證金與額度')
    .addUserOption(option =>
     option
        .setName('玩家')
        .setDescription('選擇會員')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('保證金')
        .setDescription('輸入保證金金額，月結額度會等於保證金')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('月結餘額扣款')
    .setDescription('手動扣除會員月結可用額度')
    .addUserOption(option =>
      option
        .setName('玩家')
        .setDescription('選擇要扣除月結額度的會員')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('金額')
        .setDescription('要扣除的月結額度金額')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('備註')
        .setDescription('例如：補登月結消費、人工扣款原因')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('標記月結已繳')
    .setDescription('標記會員月結帳單已繳款，並發放回饋')
    .addUserOption(option =>
      option
        .setName('玩家')
        .setDescription('選擇會員')
        .setRequired(true)
    ) 
    .addStringOption(option =>
      option
        .setName('月份')
        .setDescription('帳單月份，例如 2026-06')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('保證金抵扣')
    .setDescription('從會員保證金抵扣逾期月結帳單')
    .addUserOption(option =>
      option
        .setName('玩家')
        .setDescription('選擇會員')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('月份')
        .setDescription('帳單月份，例如 2026-06')
        .setRequired(true)
    ),
  // ===== 商店 =====
  new SlashCommandBuilder()
    .setName('新增商品')
    .setDescription('新增商店商品')
    .addStringOption(option =>
      option.setName('名稱')
        .setDescription('商品名稱')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('價格')
        .setDescription('商品價格')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('介紹')
        .setDescription('商品介紹')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('類型')
        .setDescription('選擇商品類型：一般商品 / 折券')
        .setRequired(true)
        .addChoices(
          { name: '一般商品', value: 'shop' },
          { name: '折券', value: 'coupon' }
        )
    )
].map(command => command.toJSON());
let lastDailySummaryDate = null;

function startDailySummaryScheduler() {
  const runCheck = async () => {
    try {
      const now = new Date();
      const taiwanNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
      const hour = taiwanNow.getUTCHours();
      const minute = taiwanNow.getUTCMinutes();
      const dateText = taiwanNow.toISOString().slice(0, 10);
      if (
        hour === 23 &&
        minute === 59 &&
        lastDailySummaryDate !== dateText
      ) {
        lastDailySummaryDate = dateText;
        await dispatchSystem.sendDailyPlayerSummary();
        console.log(`[每日陪玩總結] 已送出 ${dateText}`);
      }
    } catch (err) {
      console.log('[每日陪玩總結排程錯誤]', err);
    }
  };
  setInterval(runCheck, 60 * 1000);
}
let lastMonthlyBillDate = null;

function startMonthlyBillScheduler() {
  const runCheck = async () => {
    try {
      const taiwanNow = getTaiwanNow();

      const dateText =
        taiwanNow.toISOString().slice(0, 10);

      const day =
        taiwanNow.getUTCDate();

      const hour =
        taiwanNow.getUTCHours();

      const minute =
        taiwanNow.getUTCMinutes();

      if (
        day === 25 &&
        hour === 12 &&
        minute === 0 &&
        lastMonthlyBillDate !== dateText
      ) {
        lastMonthlyBillDate = dateText;

        await generateMonthlyBills();

        console.log(`[月結帳單] 已執行 ${dateText}`);
      }
    } catch (err) {
      console.log('[月結帳單排程錯誤]', err);
    }
  };

  setInterval(runCheck, 60 * 1000);
}
client.once(Events.ClientReady, async () => {
try {
console.log('🚀 星雨系統啟動中...');
// ===== 陪玩控制面板 =====
const playerChannel =
  await client.channels.fetch(
    process.env.PLAYER_CONTROL_CHANNEL
  );
await dispatchSystem.sendPlayerPanel(
  playerChannel
);
// ===== 註冊 Slash Commands =====
const rest = new REST({
  version: '10'
}).setToken(process.env.TOKEN);
await rest.put(
  Routes.applicationCommands(
    client.user.id
  ),
  { body: commands }
);
console.log('✅ Slash Commands 已註冊');
// ===== 初始化系統 =====
await dispatchSystem.sendGameOrderPanels();
console.log('✅ 分區下單系統已載入');
await refreshShop(client);
console.log('✅ 商店系統已載入');
await sendTopupPanel(client);
console.log('✅ 儲值系統已載入');
await sendAtmPanel(client);
console.log('✅ ATM 系統已載入');
await sendCheckinPanel(client);
console.log('✅ 簽到系統已載入');
await sendGachaPanel(client);
console.log('✅ 扭蛋系統已載入');
await sendPrivateRoomPanel(client);
console.log('✅ 私人房間系統已載入');
console.log('🌧️ 星雨機器人已成功上線');
startDailySummaryScheduler();
startMonthlyBillScheduler();
// ===== 深夜薪資每日報告 =====
startDeepNightSalaryReportCron(client, supabase);
setInterval(async () => {
  try {
    const now =
      new Date().toISOString();
    const { data: expired } =
      await supabase
        .from('monthly_vips')
        .select('*')
        .lte('expires_at', now);
    if (!expired?.length) return;
    for (const vip of expired) {
      const guild =
        client.guilds.cache.first();
      const member =
        await guild.members
          .fetch(vip.user_id)
          .catch(() => null);
      if (member) {
        await member.roles
          .remove(vip.role_id)
          .catch(() => {});
      }
      await supabase
        .from('monthly_vips')
        .delete()
        .eq('id', vip.id);
    }
  } catch (err) {
    console.log(
      '[月卡VIP檢查錯誤]',
      err
    );
  }
}, 60 * 60 * 1000);
setInterval(async () => {
  const twelveHoursAgo =
    new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

  const { data: players, error } =
    await supabase
      .from('players')
      .select('*')
      .eq('status', 'available')
      .lt('online_started_at', twelveHoursAgo);

  if (error || !players?.length) return;

  for (const player of players) {
    const { data: activeOrder } =
      await supabase
        .from('play_orders')
        .select('*')
        .eq('assigned_player', player.discord_id)
        .in('status', ['accepted'])
        .maybeSingle();

    if (activeOrder) continue;

    await supabase
      .from('players')
      .update({
        status: 'offline',
        online_started_at: null
      })
      .eq('discord_id', player.discord_id);
  }
}, 60 * 1000);
} catch (error) {
console.error(
  '[BOT] Ready 事件出錯:',
  error
);
}
});
async function getStaffOptionsFromRole(guild) {
  const staffRoleId = process.env.STAFF_ROLE_ID;

  if (!staffRoleId) {
    throw new Error("沒有設定 STAFF_ROLE_ID");
  }

  await guild.members.fetch();

  const role = guild.roles.cache.get(staffRoleId);

  if (!role) {
    throw new Error("找不到 STAFF_ROLE_ID 對應的身分組");
  }

  const members = role.members.filter((member) => !member.user.bot);

  if (members.size === 0) {
    return [];
  }

  return members.map((member) => ({
    label: member.displayName.slice(0, 100),
    description: member.user.username.slice(0, 100),
    value: member.id,
  }));
}

function isMonthlyEligibleItem(text = '') {
  const value = String(text || '');

  return (
    value.includes('特戰英豪') ||
    value.includes('三角洲') ||
    value.includes('PUBG') ||
    value.includes('STEAM') ||
    value.includes('陪聊') ||
    value.includes('陪伴') ||
    value.includes('聊天') ||
    value.includes('打賞') ||
    value.includes('禮物')
  );
}

async function getUserBenefitType(userId) {
  const { data } =
    await supabase
      .from('user_benefits')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

  return data?.benefit_type || '陪聊服務';
}

function isBenefitMatched(itemName, benefitType) {
  const item = String(itemName || '');

  if (benefitType === '特戰英豪') {
    return item.includes('特戰英豪') || item.includes('VALORANT');
  }

  if (benefitType === '三角洲行動') {
    return item.includes('三角洲');
  }

  if (benefitType === 'PUBG') {
    return item.includes('PUBG') || item.includes('絕地求生');
  }

  if (benefitType === 'STEAM') {
    return item.includes('STEAM') || item.includes('Steam');
  }

  if (benefitType === '陪聊服務') {
    return (
      item.includes('陪聊') ||
      item.includes('陪伴') ||
      item.includes('聊天')
    );
  }

  if (benefitType === '打賞禮物') {
    return (
      item.includes('打賞') ||
      item.includes('禮物')
    );
  }

  return false;
}
async function createMonthlyTransaction({
  userId,
  sourceType,
  sourceId = null,
  itemName = '',
  amount
}) {
  const payAmount = Number(amount || 0);

  if (!payAmount || payAmount <= 0) {
    throw new Error('月結金額錯誤');
  }

  if (!isMonthlyEligibleItem(itemName)) {
    throw new Error('此項目不適用月結付款');
  }

  const { data: account, error: accountError } =
    await supabase
      .from('member_monthly_accounts')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

  if (accountError || !account) {
    throw new Error('尚未開通月結會員');
  }

  if (!account.enabled) {
    throw new Error('月結會員目前已停用');
  }

  const monthlyLimit =
    Number(account.monthly_limit || 0);

  const usedAmount =
    Number(account.used_amount || 0);

  const availableAmount =
    Math.max(0, monthlyLimit - usedAmount);

  if (availableAmount < payAmount) {
    throw new Error(
      `月結額度不足，目前可用 NT$${availableAmount}`
    );
  }

  const benefitType =
    await getUserBenefitType(userId);

  const matchedBenefit =
    isBenefitMatched(itemName, benefitType);

  const billingMonth =
    getBillingMonth();

  const rawCashback =
    matchedBenefit
      ? Math.floor(payAmount * 0.03)
      : 0;

  // 每月回饋上限 30000
  const { data: monthTransactions } =
    await supabase
      .from('member_monthly_transactions')
      .select('cashback')
      .eq('user_id', userId)
      .eq('billing_month', billingMonth);

  const currentMonthCashback =
    (monthTransactions || []).reduce(
      (sum, tx) => sum + Number(tx.cashback || 0),
      0
    );

  const cashback =
    Math.min(
      rawCashback,
      Math.max(0, 30000 - currentMonthCashback)
    );

  const newUsedAmount =
    usedAmount + payAmount;

  const { error: updateError } =
    await supabase
      .from('member_monthly_accounts')
      .update({
        used_amount: newUsedAmount,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

  if (updateError) {
    console.error('[月結] 更新已使用額度失敗', updateError);
    throw new Error('更新月結額度失敗');
  }

  const { error: txError } =
    await supabase
      .from('member_monthly_transactions')
      .insert({
        user_id: userId,
        source_type: sourceType,
        source_id: sourceId,
        item_name: itemName,
        benefit_type: benefitType,
        amount: payAmount,
        cashback,
        billing_month: billingMonth,
        status: 'unbilled'
      });

  if (txError) {
    console.error('[月結] 建立交易失敗', txError);
    throw new Error('建立月結交易失敗');
  }

  return {
    amount: payAmount,
    benefitType,
    matchedBenefit,
    cashback,
    usedAmount: newUsedAmount,
    monthlyLimit,
    availableAmount: Math.max(0, monthlyLimit - newUsedAmount)
  };
}
function isCardPayment(text = '') {
  const value =
    String(text || '').toLowerCase();

  return (
    value.includes('刷卡') ||
    value.includes('信用卡') ||
    value.includes('信用卡付款') ||
    value.includes('card')
  );
}
function isNoCardPayment(text = '') {
  return text.includes('無卡');
}
function isBankTransfer(text = '') {
  return (
    text.includes('匯款') ||
    text.includes('轉帳')
  );
}

async function sendBankTransferInfo(channel) {
  const embed = new EmbedBuilder()
    .setColor('#ffd166')
    .setTitle('🏦 匯款資訊')
    .setDescription(
      `請依照以下資訊完成匯款：\n\n` +
      `銀行：將來銀行\n` +
      `銀行代碼：823\n` +
      `帳號：88620979281818\n` +
      `戶名：許O星\n\n` +
      `也可以掃描下方 QR Code 付款。\n\n` +
      `匯款完成後，請在此頻道上傳匯款截圖，等待客服確認。\n\n` +
      `若有其他銀行之需求，請在下方告訴客服。`

    )
    .setImage('https://cdn.discordapp.com/attachments/1501098193276895360/1517290256385310782/2026-06-19_6.09.01.png?ex=6a35be2b&is=6a346cab&hm=18a672e233a7e5984ada0e257932966853a7ba2977e3323d93578be4abaf6094&')
    .setFooter({
      text: '請確認金額正確後再匯款'
    })
    .setTimestamp();

  await channel.send({
    embeds: [embed]
  });
}
async function getAvailablePlayerOptions(service, guildId = process.env.GUILD_ID) {
  const players = await listActiveStaff();

  const targetService = cleanServiceKey(service);

  return (players || [])
    .filter(player => {
      if (!player.discord_id) return false;

      const isAvailable =
        player.status === 'available' ||
        player.is_online === true;

      if (!isAvailable) return false;

      const allowedServices =
        Array.isArray(player.allowed_services)
          ? player.allowed_services
          : String(player.allowed_services || '')
              .split(',')
              .map(s => s.trim())
              .filter(Boolean);

      if (!allowedServices.length) return false;

      return allowedServices.some(s => {
        const serviceKey = cleanServiceKey(s);

        return (
          serviceKey === targetService ||
          serviceKey.includes(targetService) ||
          targetService.includes(serviceKey)
        );
      });
    })
    .slice(0, 24)
    .map(player => ({
      label: String(
        player.display_name ||
        player.real_name ||
        player.discord_name ||
        player.name ||
        player.discord_id
      ).slice(0, 100),
      description: formatAvailableTime(player).slice(0, 100),
      value: String(player.discord_id)
    }));
}
// ===== Interaction Handler =====
client.on(Events.InteractionCreate, async interaction => {
  try {

    // ===== Autocomplete =====
    if (interaction.isAutocomplete()) {
      const handled =
        await handleUseCouponAutocomplete(interaction);

      if (handled) return;

      await interaction.respond([]);
      return;
    }

    // ===== Modal Submit：交給 dispatchSystem =====
    if (interaction.isModalSubmit()) {
      // ===== 月結繳費金額輸入 =====
      if (interaction.customId === 'submit_monthly_bill_pay_amount') {
        await interaction.deferReply({
          flags: 64
        });
        const amountText =
          interaction.fields.getTextInputValue('amount');
        const payAmount =
          Number(String(amountText || '').replace(/[^\d]/g, ''));
        if (!payAmount || payAmount <= 0) {
          return await interaction.editReply({
            content: '❌ 金額格式錯誤，請輸入大於 0 的數字'
          });
        }
        const { data: account, error: accountError } =
          await supabase
            .from('member_monthly_accounts')
            .select('*')
            .eq('user_id', interaction.user.id)
            .maybeSingle();
        if (accountError || !account) {
          return await interaction.editReply({
            content: '❌ 找不到你的月結帳戶'
          });
        }
        const usedAmount =
          Number(account.used_amount || 0);
        if (usedAmount <= 0) {
          return await interaction.editReply({
            content: '✅ 目前沒有需要繳費的月結金額'
          });
        }
        if (payAmount > usedAmount) {
          return await interaction.editReply({
            content:
              `❌ 繳費金額不能超過目前應繳金額。\n` +
              `目前應繳：NT$${usedAmount.toLocaleString('zh-TW')}`
          });
        }
        const billingMonth =
          getBillingMonth();
        const cashbackAmount =
          Math.floor(payAmount * 0.03);
        const { data: bill, error: billError } =
          await supabase
            .from('member_monthly_bills')
            .insert({
              user_id: interaction.user.id,
              billing_month: billingMonth,
              total_amount: payAmount,
              cashback_amount: cashbackAmount,
              status: 'unpaid',
              due_date: getNextMonthDueDate()
            })
            .select()
            .single();
        if (billError || !bill) {
          console.error('[月結繳費] 建立自訂金額帳單失敗', billError);
          return await interaction.editReply({
            content:
              `❌ 建立月結繳費單失敗\n` +
              `錯誤：${billError?.message || '未知錯誤'}`
          });
        }
        const menu =
          new StringSelectMenuBuilder()
            .setCustomId(`monthly_bill_payment_method_${bill.id}`)
            .setPlaceholder('請選擇月結繳費方式')
            .addOptions([
              {
                label: '儲值卡 / 錢包',
                description: '直接扣 ASD 餘額並恢復月結額度',
                value: 'wallet'
              },
              {
                label: '其他繳費方式',
                description: '建立臨時頻道後再選匯款 / 刷卡 / 無卡 / 虛擬貨幣',
                value: 'manual'
              } 
            ]);
        const row =
          new ActionRowBuilder()
            .addComponents(menu);
        return await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor('#ffd166')
              .setTitle('🌙 月結繳費')
              .setDescription(
                `<@${interaction.user.id}> 請選擇本次月結繳費方式。\n\n` +
                `目前應繳：NT$${usedAmount.toLocaleString('zh-TW')}\n` +
                `本次繳費：NT$${payAmount.toLocaleString('zh-TW')}\n` +
                `繳後剩餘應繳：NT$${Math.max(0, usedAmount - payAmount).toLocaleString('zh-TW')}\n` +
                `本次回饋：${cashbackAmount.toLocaleString('zh-TW')} ASD`
              )
              .setTimestamp()
          ],
          components: [row]
        });
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith('submit_order_review_')) {
        const parts = interaction.customId.split('_');
        const rating = Number(parts[3]);
        const orderId = parts[4];
        const comment =
          interaction.fields.getTextInputValue('comment') || '';
        const { data: order, error } =
          await supabase
            .from('play_orders')
            .select('*')
            .eq('id', orderId)
            .maybeSingle();
        if (error || !order) {
          return await interaction.reply({
            content: '❌ 找不到這張訂單',
            flags: 64
          });
        }
        if (interaction.user.id !== order.customer_id) {
          return await interaction.reply({
            content: '❌ 只有下單的闆闆可以送出評價',
            flags: 64
          });
        }
        const assignedPlayers =
          String(order.assigned_player || '')
            .split(',')
            .map(id => id.trim())
            .filter(Boolean);
        const { data: oldReview } =
          await supabase
            .from('order_reviews')
            .select('*')
            .eq('order_id', order.id)
            .eq('customer_id', interaction.user.id)
            .maybeSingle();
        if (oldReview) {
          return await interaction.reply({
            content: '❌ 這張訂單已經評價過了',
            flags: 64
          });
        }
        const { error: insertError } =
          await supabase
            .from('order_reviews')
            .insert({
              order_id: String(order.id),
              order_no: order.order_no || null,
              customer_id: interaction.user.id,
              staff_ids: assignedPlayers.join(','),
              rating,
              comment,
              channel_id: interaction.channel.id
            });
        if (insertError) {
          console.error('[訂單評價寫入失敗]', insertError);
          return await interaction.reply({
            content: '❌ 評價送出失敗，請稍後再試',
            flags: 64
          });
        }
        await interaction.reply({
          content:
            `✅ 感謝你的評價！\n` +
            `你給了 ${'🌟'.repeat(rating)}${rating < 5 ? `（${rating} 星）` : ''}`,
          flags: 64
        });
        await interaction.channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor('#ffd166')
              .setTitle('💬 已收到訂單評價')
              .setDescription(
                `訂單編號：${order.order_no || order.id}\n` +
                `闆闆：<@${interaction.user.id}>\n` +
                `評分：${'🌟'.repeat(rating)} ${rating}/5\n` +
                `心得：${comment || '未填寫'}`
              )
            .setTimestamp()
          ]
        });
        return;
      }
      if (interaction.customId.startsWith('submit_staff_edit_order_')) {
        return await dispatchSystem.handleDispatchInteraction(interaction);
      }
      const handled =
        await dispatchSystem.handleDispatchInteraction(interaction);

      if (handled) return;
      await handleModalSubmit(interaction);
      return;

    }

    // ===== Slash =====
    if (interaction.isChatInputCommand()) {
      if (!interaction.deferred && !interaction.replied) {
        if (
          interaction.commandName === '餘額'
        ) {
          const target =
            interaction.options.getUser('玩家');
          const selfLookup =
            !target || target.id === interaction.user.id;
          await interaction.deferReply(
            selfLookup ? undefined : { flags: 64 }
          );
        } else if (
          interaction.commandName === '查詢累積'
        ) {
          await interaction.deferReply(); // 公開，頻道都看得到
        } else {
          await interaction.deferReply({ flags: 64 }); // 其他指令維持只有自己看得到
        }
      }
      const handled =
        await dispatchSystem.handleDispatchInteraction(interaction);

      if (handled) return;
      if (interaction.commandName === '加時') {
        await handleSlashExtendOrder(interaction);
        return;
      }
      await handleSlashCommand(interaction);
      return;

    }
  

    // ===== 一般 Button =====
    if (interaction.isButton()) {
      // ===== 派單 / 陪玩狀態按鈕：先處理，避免 interaction 過期 =====
      if (
        interaction.customId === 'player_online' ||
        interaction.customId === 'player_offline' ||
        interaction.customId === 'player_status' ||
        interaction.customId.startsWith('accept_play_order_')
      ) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({
            flags: 64
          });
        }
        return await dispatchSystem.handleDispatchInteraction(interaction);
      }
      const customId = interaction.customId;
      if (
        customId.startsWith('bulk_delete_confirm_') ||
        customId.startsWith('bulk_delete_cancel_')
      ) {
        if (customId.startsWith('bulk_delete_confirm_')) {
          return await handleBulkDeleteConfirm(interaction);
        }

        return await handleBulkDeleteCancel(interaction);
      }
      // ===== 訂單評價按鈕：會開 Modal，不能先 defer =====
      if (customId.startsWith('order_review_')) {
        await handleButtonInteraction(interaction);
        return;
      }
      // ===== ATM 月結繳費：會開 Modal，不能先 defer =====
      if (customId === 'monthly_bill_pay') {
        await handleButtonInteraction(interaction);
        return;
      }
      if (
        customId.startsWith('tip_staff_done_') ||
        customId.startsWith('tip_staff_clear_')
      ) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({ flags: 64 });
        }

        if (customId.startsWith('tip_staff_done_')) {
          return await handleTipStaffDone(interaction);
        }

        return await handleTipStaffClear(interaction);
      }
      // ===== 填寫打賞需求 =====
      if (interaction.customId === "fill_tip_need") {
        try {
          const staffOptions = await getStaffOptionsFromRole(interaction.guild);
          if (staffOptions.length === 0) {
            return interaction.reply({
              content: "目前這個員工身分組裡沒有可以選擇的員工。",
              flags: 64,
            });
          }
          const staffSelect = new StringSelectMenuBuilder()
            .setCustomId("select_tip_staff")
            .setPlaceholder("請選擇受賞的員工，可複選")
            .setMinValues(1)
            .setMaxValues(Math.min(staffOptions.length, 25))
            .addOptions(staffOptions.slice(0, 25));
          const row = new ActionRowBuilder().addComponents(staffSelect);
          return interaction.reply({
            content: "請先選擇受賞的員工，可以一次選擇多位：",
            components: [row],
            flags: 64,
          });
        } catch (error) {
          console.error("取得員工身分組失敗：", error);
          return interaction.reply({
            content: "取得員工名單失敗，請確認 STAFF_ROLE_ID 是否正確，或機器人權限是否足夠。",
            flags: 64,
          });
        }
      }
      // ===== 建立私人文字頻道 =====
      if (interaction.customId === 'create_private_room') {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({ flags: 64 });
        }
        await createPrivateRoom(interaction);
        return;
      }
      if (
        interaction.customId === 'order_start_valorant' ||
        interaction.customId === 'order_start_steam' ||
        interaction.customId === 'order_start_delta' ||
        interaction.customId === 'order_start_chat' ||
        interaction.customId === 'order_start_emotion' ||
        interaction.customId === 'order_start_topup' ||
        interaction.customId === 'order_start_tip'
      ) {
        return await dispatchSystem.handleDispatchInteraction(interaction);
      }
      // ===== 關閉私人文字頻道 =====
      if (interaction.customId.startsWith('private_room_close_')) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({ flags: 64 });
        }
        const ownerId =
          interaction.customId.replace(
            'private_room_close_',
            ''
          );
        const isStaff =
          interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
          interaction.member.roles.cache.has(process.env.STAFF_ROLE);
        if (
          interaction.user.id !== ownerId &&
          !isStaff
        ) {
          return interaction.editReply({
            content: '❌ 只有房間建立者或客服可以關閉'
          });
        }
        await interaction.editReply({
          content: '🗑️ 私人頻道將在 3 秒後刪除'
        });
        setTimeout(async () => {
          await interaction.channel.delete().catch(() => {});
        }, 3000);
        return;
      }
      if (interaction.customId.startsWith('confirm_topup_')) {
        return await dispatchSystem.handleDispatchInteraction(interaction);
      }
      if (interaction.customId.startsWith('staff_edit_order_')) {
        return await dispatchSystem.handleDispatchInteraction(interaction);
      }
      if (interaction.customId.startsWith('new_order_back_')) {
        return await dispatchSystem.handleDispatchInteraction(interaction);
      } 
      if (
        interaction.customId.startsWith('valorant_type_') ||
        interaction.customId.startsWith('valorant_mode_') ||
        interaction.customId.startsWith('steam_game_name_') ||
        interaction.customId.startsWith('order_add_note_') ||
        interaction.customId.startsWith('order_finish_need_') ||

        interaction.customId.startsWith('confirm_extension_wallet_') ||
        interaction.customId.startsWith('cancel_extension_wallet_') ||

        interaction.customId.startsWith('service_confirm_wallet_group_') ||
        interaction.customId.startsWith('service_confirm_monthly_group_') ||
        interaction.customId.startsWith('service_confirm_wallet_') ||
        interaction.customId.startsWith('service_confirm_monthly_') ||
        interaction.customId.startsWith('service_cancel_wallet_group_') ||
        interaction.customId.startsWith('service_cancel_monthly_group_') ||
        interaction.customId.startsWith('service_cancel_wallet_') ||
        interaction.customId.startsWith('service_cancel_monthly_') ||
        interaction.customId.startsWith('service_confirm_paid_group_') ||
        interaction.customId.startsWith('service_cancel_order_group_') ||
        interaction.customId.startsWith('service_confirm_paid_') ||
        interaction.customId.startsWith('service_cancel_order_')
      ) {
        return await dispatchSystem.handleDispatchInteraction(interaction);
      }
      // Modal 類按鈕不能 defer
      if (
        interaction.customId === 'open_topup_modal' ||
        interaction.customId === 'open_play_order_form' ||
        interaction.customId.startsWith('new_order_note_yes_') ||
        interaction.customId.startsWith('service_quote_price_') ||
        interaction.customId.startsWith('staff_quote_price_') ||
        interaction.customId.startsWith('change_order_price_') ||
        interaction.customId.startsWith('save_order_note_') ||
        interaction.customId.startsWith('staff_edit_order_') ||
        interaction.customId.startsWith('new_order_back_') ||
        interaction.customId.startsWith('extend_order_')
      ) {
        return await dispatchSystem.handleDispatchInteraction(interaction);
      }
      // ===== 使用者按錯建立訂單 / 儲值頻道，自行關閉 =====
      if (interaction.customId === 'owner_cancel_ticket') {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({ flags: 64 });
        }
        const topic =
          interaction.channel?.topic || '';
        const ownerId =
          topic.startsWith('owner:')
            ? topic.replace('owner:', '').trim()
            : null;
        const isStaff =
          interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
          interaction.member.roles.cache.has(process.env.STAFF_ROLE);
        if (
          interaction.user.id !== ownerId &&
          !isStaff
        ) {
          return interaction.editReply({
            content: '❌ 只有建立這個頻道的人或客服可以關閉。'
          });
        }
        await interaction.editReply({
          content: '🗑️ 已收到，這個臨時頻道將在 3 秒後刪除。'
        });
        setTimeout(async () => {
          await interaction.channel.delete().catch(() => {});
        }, 3000);
        return;
      }
      if (interaction.customId.startsWith('change_preferred_player_')) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({ flags: 64 });
        }
        return await dispatchSystem.handleDispatchInteraction(interaction);
      }
      // ===== 訂單評價按鈕：會開 Modal，不能先 defer =====
      if (interaction.customId.startsWith('order_review_')) {
        await handleButtonInteraction(interaction);
        return;
      } 
      // ===== 其他普通按鈕都要先 defer =====
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: 64 });
      }
      const handled =
        await dispatchSystem.handleDispatchInteraction(interaction);
      if (handled) return;
      await handleButtonInteraction(interaction);
      return;
    }
    if (interaction.isChannelSelectMenu()) {
      if (interaction.customId.startsWith('bulk_delete_channels_')) {
        return await handleBulkDeleteChannelSelect(interaction);
      }
    }
    // ===== String Select =====
    if (interaction.isStringSelectMenu()) {
      // ===== 新版下單流程：不能先 defer，因為 dispatchSystem 會用 interaction.update() =====
      if (
        interaction.customId.startsWith('new_order_game_') ||
        interaction.customId.startsWith('new_order_item_') ||
        interaction.customId.startsWith('new_order_rank_') ||
        interaction.customId.startsWith('new_order_count_') ||
        interaction.customId.startsWith('new_order_gender_') ||
        interaction.customId.startsWith('new_order_player_') ||
        interaction.customId.startsWith('new_order_duration_') ||

	        // ===== 新版服務下單流程 =====
	        interaction.customId.startsWith('valorant_type_select_') ||
	        interaction.customId.startsWith('valorant_rank_') ||
	        interaction.customId.startsWith('apex_rank_') ||
	        interaction.customId.startsWith('lol_rank_') ||
	        interaction.customId.startsWith('service_player_count_') ||
	        interaction.customId.startsWith('service_gender_') ||
	        interaction.customId.startsWith('service_assign_') ||
	        interaction.customId.startsWith('service_selected_players_') ||
	        interaction.customId.startsWith('service_duration_') ||
	        interaction.customId.startsWith('service_rounds_') ||
	        interaction.customId.startsWith('steam_category_') ||
	        interaction.customId.startsWith('delta_mode_') ||
	        interaction.customId.startsWith('service_select_coupon_') ||
	        interaction.customId.startsWith('service_payment_method_') ||
	        interaction.customId.startsWith('game_order_select_') ||
        interaction.customId.startsWith('lol_style_select_') ||

        interaction.customId.startsWith('quote_select_coupon_') ||
        interaction.customId.startsWith('quote_payment_method_') ||
        interaction.customId.startsWith('topup_payment_method_') ||
        interaction.customId.startsWith('extension_payment_method_')
      ) {
        return await dispatchSystem.handleDispatchInteraction(interaction);
      }
      // ===== 選擇受賞員工後，跳出打賞表單 =====
      if (interaction.customId === "select_tip_staff") {
        const selectedStaffIds =
          [
            ...new Set(
              interaction.values
                .map(id => String(id || '').trim())
                .filter(Boolean)
            )
          ];
        const tipDraftId =
          `manual_${interaction.user.id}_${Date.now()}`;

        pendingTips.set(tipDraftId, {
          channelId: interaction.channel.id,
          guildId: interaction.guild.id,
          selectedStaffId: selectedStaffIds[0],
          selectedStaffIds,
          createdBy: interaction.user.id,
          createdAt: Date.now()
        });
        setTimeout(() => {
          pendingTips.delete(tipDraftId);
        }, 30 * 60 * 1000);

        const modal = new ModalBuilder()
          .setCustomId(`tip_modal_${tipDraftId}`)
          .setTitle("填寫打賞需求");
        const itemInput = new TextInputBuilder()
          .setCustomId("item")
          .setLabel("品項")
          .setPlaceholder("例如：明燈三千、明燈千里、雞米花")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        const amountInput = new TextInputBuilder()
          .setCustomId("amount")
          .setLabel("每位金額")
          .setPlaceholder("請輸入每位打賞金額，例如：999")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        const tipPaymentInput = new TextInputBuilder()
          .setCustomId("tip_payment_method")
          .setLabel("付款方式")
          .setPlaceholder("轉帳 / 無卡 / 儲值卡 / 錢包 / 餘額")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(
          new ActionRowBuilder().addComponents(itemInput),
          new ActionRowBuilder().addComponents(amountInput),
          new ActionRowBuilder().addComponents(tipPaymentInput)
        );
        return interaction.showModal(modal);
      }
      // ===== 客人下單選陪陪：可能會開預約時間 Modal，不能先 defer =====
      if (
        interaction.customId.startsWith('new_order_game_') ||
        interaction.customId.startsWith('new_order_item_') ||
        interaction.customId.startsWith('new_order_count_') ||
        interaction.customId.startsWith('new_order_gender_') ||
	        interaction.customId.startsWith('new_order_player_') ||
	        interaction.customId.startsWith('new_order_duration_') ||
	        interaction.customId.startsWith('service_select_coupon_') ||
	        interaction.customId.startsWith('quote_select_coupon_') ||
        interaction.customId.startsWith('quote_payment_method_') ||
        interaction.customId.startsWith('submit_dispatch_players_') ||
        interaction.customId.startsWith('extension_payment_method_')
      ) {

        return await dispatchSystem.handleDispatchInteraction(interaction);
      }
      // ===== 更改指定陪陪 =====
      if (interaction.customId.startsWith('submit_change_preferred_player_')) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({
            flags: 64
          });
        }
        const handled =
          await dispatchSystem.handleDispatchInteraction(interaction);
        if (handled) return;
      }
      // ===== 其他下拉選單 =====
      try {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({
            flags: 64
          });
        }
      } catch (err) {
        console.error('[StringSelect defer 失敗]', err);
        return;
      }
      const handled =
        await dispatchSystem.handleDispatchInteraction(interaction);
      if (handled) return;
      await handleStringSelectInteraction(interaction);
      return;
    }
    // ===== User Select =====
    if (interaction.isUserSelectMenu()) {
      // ===== ATM 玩家轉帳選人 =====
      // 這個後面要 showModal，所以不能先 deferReply
      if (interaction.customId === 'transfer_user_select') {
        return await handleUserSelectSubmit(interaction);
      }
      // ===== 私人房間邀請成員 =====
      if (interaction.customId.startsWith('private_room_invite_')) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({ flags: 64 });
        }
        const ownerId =
          interaction.customId.replace(
            'private_room_invite_',
            ''
          );
        if (interaction.user.id !== ownerId) {
          return interaction.editReply({
            content: '❌ 只有房間建立者可以邀請成員'
          });
        }
        const selectedUsers =
          interaction.values;
        for (const userId of selectedUsers) {
          await interaction.channel.permissionOverwrites.edit(userId, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            AttachFiles: true,
            EmbedLinks: true
          });
        }
        await interaction.channel.send({
          content:
            `✅ 已邀請：${selectedUsers.map(id => `<@${id}>`).join('、')}`
        });
        return interaction.editReply({
          content: '✅ 已完成邀請'
        });
      }
    }
  } catch (err) {
    console.error('[InteractionCreate 錯誤]', err);
    const payload = {
      content: '❌ 系統錯誤，請稍後再試。',
      components: []
    };
    if (!interaction.isRepliable()) {
      return;
    }
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(async () => {
        await interaction.followUp({
          ...payload,
          flags: 64
        }).catch(() => {});
      });
      return;
    }
    await interaction.reply({
      ...payload,
      flags: 64
    }).catch(() => {});
  }
});
async function replySuccess(interaction, message) {
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp({
      content: `✅ ${message}`,
      flags: 64
    }).catch(() => {});
  }
  return interaction.reply({
    content: `✅ ${message}`, 
    flags: 64
  }).catch(() => {});
}
function parseRoleIdList(value) {
  return String(value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function isAdminOrStaff(interaction) {
  const member = interaction.member;

  if (!interaction.guild || !member) return false;

  if (interaction.guild.ownerId === interaction.user.id) return true;

  if (member.permissions?.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  const roleIds = [
    process.env.STAFF_ROLE,
    process.env.ADMIN_ROLE,
    process.env.ADMIN_ROLE_ID,
    ...parseRoleIdList(process.env.STAFF_ROLE_IDS),
    ...parseRoleIdList(process.env.ADMIN_ROLE_IDS),
  ].filter(Boolean);

  return roleIds.some(roleId => member.roles.cache.has(roleId));
}
async function handleSlashCommand(interaction) {
  // ping
  if (interaction.commandName === 'ping') {
    return interaction.editReply('Pong!');
  }
  if (interaction.commandName === '批量刪除頻道') {
    return await handleBulkDeleteChannelsCommand(interaction);
  }
  if (interaction.commandName === '隱藏餘額') {
    const userData =
      await getUser(interaction.user.id);
    const currentHidden =
      Boolean(userData.balance_hidden);
    const newHidden =
      !currentHidden;
    const { error } =
      await supabase
        .from('users')
        .update({
          balance_hidden: newHidden
        })
        .eq('user_id', interaction.user.id);
    if (error) {
      console.error('[隱藏餘額] 更新失敗', error);
      return replyError(interaction, '更新隱藏餘額狀態失敗');
    }
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(newHidden ? '#ffcc66' : '#57F287')
          .setTitle(newHidden ? '🔒 已隱藏餘額' : '🔓 已公開餘額')
          .setDescription(
            newHidden
              ? `<@${interaction.user.id}> 的錢包餘額已設為隱藏。\n之後公開查詢時會顯示「已隱藏」。`
              : `<@${interaction.user.id}> 的錢包餘額已改為公開。`
          )
          .setTimestamp()
      ]
    });
  }
  if (interaction.commandName === '餘額') {
    const target =
      interaction.options.getUser('玩家') || interaction.user;
    const isSelf =
      target.id === interaction.user.id;

    if (!isSelf && !isAdmin(interaction)) {
      return interaction.editReply({
        content: '❌ 只有管理員可以查看其他人的餘額'
      });
    }

    const userData =
      await getUser(target.id);
    const balanceHidden =
      Boolean(userData.balance_hidden);
    const canSeeHiddenBalance =
      !isSelf && isAdmin(interaction);
    const balanceText =
      balanceHidden && !canSeeHiddenBalance
        ? '已隱藏'
        : `${Number(userData.coins || 0).toLocaleString('zh-TW')} ASD`;
    const guildId = getGuildId(interaction);
    const { data: monthlyAccount, error: monthlyError } =
      await supabase
        .from('member_monthly_accounts')
        .select('*')
        .eq('user_id', target.id)
        .maybeSingle();
    if (monthlyError) {
      console.error('[餘額查詢] 查詢月結資料失敗', monthlyError);
    }
    const hasMonthly =
      !!monthlyAccount;
    const monthlyLimit =
      Number(monthlyAccount?.monthly_limit || 0);
    const monthlyUsed =
      Number(monthlyAccount?.used_amount || 0);
    const monthlyAvailable =
      hasMonthly
        ? Math.max(0, monthlyLimit - monthlyUsed)
        : 0;
    const monthlyStatus =
      hasMonthly
        ? monthlyAccount.enabled
          ? '✅ 已啟用'
          : '⛔ 已停用'
        : '尚未開通';
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor('#57F287')
          .setTitle('💰 ASD 餘額查詢')
          .setDescription(
            `<@${target.id}> 的錢包與月結資訊\n` +
            `${!isSelf ? `查詢者：<@${interaction.user.id}>\n` : ''}\n` +
            `💰 **錢包餘額**\n` +
            `${balanceText}\n\n` +
            `🌙 **月結狀態**\n` +
            `${monthlyStatus}\n\n` +
            `📌 **月結總額度**\n` +
            `NT$${monthlyLimit.toLocaleString('zh-TW')}\n\n` +
            `🧾 **已使用額度**\n` +
            `NT$${monthlyUsed.toLocaleString('zh-TW')}\n\n` +
            `✅ **剩餘可用額度**\n` +
            `NT$${monthlyAvailable.toLocaleString('zh-TW')}`
          )
          .setFooter({
            text: '深夜不關燈｜公開餘額查詢'
          })
          .setTimestamp()
      ]
    });
  }
  if (interaction.commandName === '發紅包') {
    const totalAmount =
      interaction.options.getInteger('金額');

    const totalCount =
      interaction.options.getInteger('數量');

    return await createRedPacket(
      interaction,
      totalAmount,
      totalCount
    );
  }
  // 扭蛋列表
  if (interaction.commandName === '扭蛋列表') {
    const { data, error } = await supabase
            .from('gacha_pools')
            .select('*');
          if (error) {
            console.error('[扭蛋列表] 讀取失敗', error);
            return replyError(interaction, '讀取扭蛋列表失敗');
          }
          if (!data.length) {
            return interaction.editReply('目前沒有扭蛋');
          }
          const text = data.map(g =>
            `🆔 ID：${g.id}\n🎰 ${g.pool_name}\n💰 單抽價格：${g.price} 星雨幣`
          ).join('\n\n');
          return interaction.editReply({
            content: `📦 扭蛋列表\n\n${text}`,
          });
        }
        // 新增扭蛋
        if (interaction.commandName === '新增卡池') {
          if (!isAdmin(interaction)) {
            return replyError(interaction, '你沒有權限');
          }
          const name =
            interaction.options.getString('名稱');
          const price =
            interaction.options.getInteger('價格');
          const { error } = 
          await supabase
            .from('gacha_pools')
            .insert({
              pool_name: name,
              price
            });
          if (error) {
            console.error(error);
            return replyError(interaction, '新增失敗');
          } 
          return interaction.editReply({
            content: `✅ 已新增卡池：${name}`,
          });
        }
        if (interaction.commandName === '新增獎勵') {
          if (!isAdmin(interaction)) {
            return replyError(interaction, '你沒有權限');
          }
          const poolId =
            interaction.options.getInteger('卡池id');
          const rewardName =
            interaction.options.getString('名稱');
          const description =
            interaction.options.getString('介紹');
          const rarity =
            interaction.options.getString('稀有度');
          const chance =
            interaction.options.getNumber('機率');
          const rewardCoins =
            interaction.options.getInteger('星雨幣') || 0;
          if (isNaN(chance) || chance <= 0) {
            return replyError(interaction, '權重必須大於 0');
          }
          const { error } = await supabase
            .from('gacha_rewards')
            .insert({
              pool_id: poolId,
              reward_name: rewardName,
              reward_description: description,
              rarity,
              chance,
              reward_coins: rewardCoins
            });
          if (error) {
            console.error(error);
            return replyError(interaction, '新增失敗');
          }
          return interaction.editReply({
            content:
              `✅ 已新增獎勵：${rewardName}`,
          });
        } 
        // 刪除獎勵
        if (interaction.commandName === '刪除獎勵') {
          if (!isAdmin(interaction)) {
            return replyError(interaction, '你沒有權限');
          }
          const poolId =
            interaction.options.getInteger('卡池id');
          const rewardName =
            interaction.options.getString('名稱');
          const { error } = await supabase
            .from('gacha_rewards')
            .delete()
            .eq('pool_id', poolId)
            .eq('reward_name', rewardName);
          if (error) {
            console.error(error);
            return replyError(interaction, '刪除失敗');
          }
          return interaction.editReply({
            content: `🗑️ 已刪除獎勵：${rewardName}`,
          });
        }
        // 我的排名
        if (interaction.commandName === '我的排名') {
          const userData = await getUser(interaction.user.id);
          const rank = await getUserRank(interaction.user.id);
          return interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setColor('#FFD700')
                .setTitle('🏆 星雨排名')
                .setDescription(
                  `🥇 排名：第 ${rank} 名\n💰 星雨幣：${userData.coins}`
                )
            ],
          });
        }
        // 交易紀錄
        if (interaction.commandName === '交易紀錄') {
          const records = await getWalletLogs(
            interaction.user.id
          );
          if (!records.length) {
            return interaction.editReply({
              content: '目前沒有錢包明細',
            });
          }
          const text = records.map(record => {
              const time =
                new Date(
                  record.created_at
                ).toLocaleString(
                  'zh-TW',
                  {
                    hour12: false
                  }
                );
                const amountText =
                  Number(record.amount) > 0
                    ? `+${record.amount}`
                    : `${record.amount}`;
                return (
                  `📌 ${record.type}\n` +
                  `💰 異動：${amountText} 星雨幣\n` +
                  `💳 餘額：${record.balance} 星雨幣\n` +
                  `🕒 ${time}` +
                  `${record.note ? `\n📝 ${record.note}` : ''}`
                );
              }).join('\n\n');
            return interaction.editReply({
              embeds: [
                new EmbedBuilder()
                  .setColor('#00ffff')
                  .setTitle('📜 錢包明細')
                  .setDescription(text.slice(0, 3800))
              ],
            });
          }
        // 儲值
        if (interaction.commandName === '發錢') {
          if (!isOwnerOrAdmin(interaction)) {
            return interaction.editReply({
              content: '❌ 只有群主或管理員可以使用',
            });
          }
          const target = interaction.options.getUser('玩家');
          const amount = interaction.options.getInteger('金額');
          if (isNaN(amount) || amount <= 0) {
            return replyError(interaction, '金額錯誤');
          }
        
          const finalCoins =
            await changeCoins(target.id, amount);
          await sendWalletLog(
            target.id,
            '儲值',
            amount,
            finalCoins,
            '💳 儲值成功'
          );
          await checkAndUpgradeVip(
            target.id,
            'topup',
            amount,
            getGuildId(interaction)
          );
          return interaction.editReply({
            content:
              `✅ 已給予 <@${target.id}> ${amount} 星雨幣`,
          });
        }
        // 扣錢
        if (interaction.commandName === '扣錢') {
          if (!isOwnerOrAdmin(interaction)) {
            return interaction.editReply({
              content: '❌ 只有群主或管理員可以使用',
            });
          }
          const target = interaction.options.getUser('玩家');
          const amount = interaction.options.getInteger('金額');
          if (isNaN(amount) || amount <= 0) {
            return replyError(interaction, '金額錯誤');
          }
          const userData =
            await getUser(target.id);
          const currentCoins =
            Number(userData.coins || 0);
          if (currentCoins < amount) {
            return replyError(
              interaction,
              `餘額不足，目前餘額 ${currentCoins.toLocaleString('zh-TW')} 星雨幣，需要 ${amount.toLocaleString('zh-TW')} 星雨幣`
            );
          }
          const finalCoins =
            await changeCoins(target.id, -amount);
          await sendWalletLog(
            target.id,
            '扣款',
            -amount,
            finalCoins,
            '後台扣款'
          );
          return interaction.editReply({
            content:
              `❌ 已扣除 <@${target.id}> ${amount} 星雨幣，目前餘額 ${finalCoins} 星雨幣`,
          });
        }
        if (interaction.commandName === '給與身份組') {
          await handleGiveRoleCommand(interaction);
          return;
        }
        if (interaction.commandName === '使用優惠券') {
          await handleUseCouponCommand(interaction);
          return;
        }
        if (interaction.commandName === '發送優惠券') {
          if (!isAdmin(interaction)) {
            return interaction.editReply({
              content: '❌ 只有管理員可以使用這個指令'
            });
          }
          const target =
            interaction.options.getUser('玩家');
          const couponName =
            interaction.options.getString('優惠券');
          const count =
            interaction.options.getInteger('數量');
          const note =
            interaction.options.getString('備註') || '客服發送優惠券';
          if (!target) {
            return interaction.editReply({
              content: '❌ 找不到玩家'
            });
          }
          if (!couponName) {
            return interaction.editReply({
              content: '❌ 請選擇優惠券'
            });
          }
          if (!count || count <= 0) {
            return interaction.editReply({
              content: '❌ 數量必須大於 0'
            });
          }
          if (count > 20) {
            return interaction.editReply({
              content: '❌ 一次最多發送 20 張優惠券'
            });
          }
          for (let i = 0; i < count; i++) {
            await addUserItem(
              target.id,
              couponName,
              '客服發送',
              note,
              'coupon'
            );
          }
          await interaction.editReply({
            content:
              `✅ 已發送優惠券\n\n` +
              `玩家：<@${target.id}>\n` +
              `優惠券：${couponName}\n` +
              `數量：${count} 張\n` +
              `備註：${note}`
          });
          const user =
            await client.users.fetch(target.id).catch(() => null);
          if (user) {
            await user.send({
              embeds: [
                new EmbedBuilder()
                  .setColor('#ffd166')
                  .setTitle('🎟️ 你收到優惠券')
                  .setDescription(
                    `你收到優惠券：**${couponName}**\n` +
                    `數量：${count} 張\n\n` +
                    `備註：${note}`
                  )
                  .setFooter({
                    text: '優惠券可於下單時使用'
                  })
                  .setTimestamp()
              ]
            }).catch(() => {});
          }
          return;
        }
        if (interaction.commandName === '調整累積消費') {
          if (!isAdminOrStaff(interaction)) {
            return replyError(interaction, '你沒有權限');
          }
          const guildId = getGuildId(interaction);
          const target =
            interaction.options.getUser('玩家');
          const amount =
            interaction.options.getInteger('金額');
          const mode =
            interaction.options.getString('模式');
          const note =
            interaction.options.getString('備註') || '手動調整累積消費';
          if (!guildId) {
            return replyError(interaction, '找不到群組 ID，無法調整累積消費');
          }
          if (!target) {
            return replyError(interaction, '找不到玩家');
          }
          if (!Number.isFinite(amount)) {
            return replyError(interaction, '金額格式錯誤');
          }
          const { data: oldVip, error: readError } =
            await getUserVipRecord(target.id, guildId);
          if (readError) {
            console.error('[調整累積消費] 讀取失敗', readError);
            return replyError(interaction, '讀取會員累積資料失敗');
          }
          const oldTotalSpent =
            Number(oldVip?.total_spent || 0);
          let newTotalSpent =
            oldTotalSpent;
          if (mode === 'add') {
            if (amount <= 0) {
              return replyError(interaction, '增加金額必須大於 0');
            }
            newTotalSpent =
              oldTotalSpent + amount;
          }
          if (mode === 'subtract') {
            if (amount <= 0) {
              return replyError(interaction, '扣除金額必須大於 0');
            }
            newTotalSpent =
              Math.max(0, oldTotalSpent - amount);
          }
          if (mode === 'set') {
            if (amount < 0) {
              return replyError(interaction, '直接設定金額不能小於 0');
            }
            newTotalSpent =
              amount;
          }
          const payload = {
            guild_id: guildId,
            user_id: target.id,
            level_key: oldVip?.level_key || null,
            level_name: oldVip?.level_name || null,
            total_spent: newTotalSpent,
            total_topup: Number(oldVip?.total_topup || 0),
            highest_single_topup: Number(oldVip?.highest_single_topup || 0),
            updated_at: new Date().toISOString()
          };
          const { data: updatedVip, error: saveError } =
            await saveUserVipRecord(payload, oldVip);
          if (saveError || !updatedVip) {
            console.error('[調整累積消費] 更新失敗', saveError);
            if (saveError) {
              await explainUserVipSaveFailure(target.id, guildId, saveError);
            }
            return replyError(
              interaction,
              `更新累積消費失敗：${saveError?.message || '未知錯誤'}`
            );
          }
          try {
            await checkAndUpgradeVip(
              target.id,
              'spend',
              0,
              guildId
            );
          } catch (vipError) {
            console.error('[調整累積消費] VIP 重新檢查失敗', vipError);
          }
          return interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setColor('#ffd166')
                .setTitle('✅ 已調整累積消費')
                .setDescription(
                  `會員：<@${target.id}>\n` +
                  `模式：${
                    mode === 'add'
                      ? '增加'
                      : mode === 'subtract'
                        ? '扣除'
                        : '直接設定'
                  }\n` +
                  `調整金額：NT$${amount.toLocaleString('zh-TW')}\n\n` +
                  `原本累積消費：NT$${oldTotalSpent.toLocaleString('zh-TW')}\n` +
                  `現在累積消費：NT$${newTotalSpent.toLocaleString('zh-TW')}\n\n` +
                  `備註：${note}`
                )
                .setFooter({
                  text: `操作人員：${interaction.user.tag}`
                })
                .setTimestamp()
            ]
          });
        }
        if (interaction.commandName === '調整累積儲值') {
          if (!isAdminOrStaff(interaction)) {
            return replyError(interaction, '你沒有權限');
          }
          const guildId = getGuildId(interaction);
          const target =
            interaction.options.getUser('玩家');

          const amount =
            interaction.options.getInteger('金額');

          const mode =
            interaction.options.getString('模式');

          const note =
            interaction.options.getString('備註') || '手動調整累積儲值';

          if (!guildId) {
            return replyError(interaction, '找不到群組 ID，無法調整累積儲值');
          }

          if (!target) {
            return replyError(interaction, '找不到玩家');
          }

          if (!Number.isFinite(amount)) {
            return replyError(interaction, '金額格式錯誤');
          }

          const { data: oldVip, error: readError } =
            await getUserVipRecord(target.id, guildId);

          if (readError) {
            console.error('[調整累積儲值] 讀取失敗', readError);
            return replyError(interaction, '讀取會員累積資料失敗');
          }

          const oldTotalTopup =
            Number(oldVip?.total_topup || 0);

          let newTotalTopup =
            oldTotalTopup;

          if (mode === 'add') {
            if (amount <= 0) {
              return replyError(interaction, '增加金額必須大於 0');
            }

            newTotalTopup =
              oldTotalTopup + amount;
          }

          if (mode === 'subtract') {
            if (amount <= 0) {
              return replyError(interaction, '扣除金額必須大於 0');
            }

            newTotalTopup =
              Math.max(0, oldTotalTopup - amount);
          }

          if (mode === 'set') {
            if (amount < 0) {
              return replyError(interaction, '直接設定金額不能小於 0');
            }

            newTotalTopup =
              amount;
          }

          const oldHighestSingleTopup =
            Number(oldVip?.highest_single_topup || 0);

          const newHighestSingleTopup =
            mode === 'add'
              ? Math.max(oldHighestSingleTopup, amount)
              : oldHighestSingleTopup;

          const payload = {
            guild_id: guildId,
            user_id: target.id,
            level_key: oldVip?.level_key || null,
            level_name: oldVip?.level_name || null,
            total_spent: Number(oldVip?.total_spent || 0),
            total_topup: newTotalTopup,
            highest_single_topup: newHighestSingleTopup,
            updated_at: new Date().toISOString()
          };
          const { data: updatedVip, error: saveError } =
            await saveUserVipRecord(payload, oldVip);
          if (saveError || !updatedVip) {
            console.error('[調整累積儲值] 更新失敗', saveError);
            if (saveError) {
              await explainUserVipSaveFailure(target.id, guildId, saveError);
            }
            return replyError(interaction, '更新累積儲值失敗');
          }
          // 重新檢查 VIP 升級：失敗不要擋掉累積儲值調整
          try {
            await checkAndUpgradeVip(
              target.id,
              'topup',
              0,
              guildId
            );
          } catch (vipError) {
            console.error('[調整累積儲值] VIP 重新檢查失敗', vipError);
          }

          return interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setColor('#66ccff')
                .setTitle('✅ 已調整累積儲值')
                .setDescription(
                  `會員：<@${target.id}>\n` +
                  `模式：${mode === 'add' ? '增加' : mode === 'subtract' ? '扣除' : '直接設定'}\n` +
                  `調整金額：NT$${amount.toLocaleString('zh-TW')}\n\n` +
                  `原本累積儲值：NT$${oldTotalTopup.toLocaleString('zh-TW')}\n` +
                  `現在累積儲值：NT$${newTotalTopup.toLocaleString('zh-TW')}\n` +
                  `最高單筆儲值：NT$${newHighestSingleTopup.toLocaleString('zh-TW')}\n\n` +
                  `備註：${note}`
                )
                .setFooter({
                  text: `操作人員：${interaction.user.tag}`
                })
                .setTimestamp()
            ]
          });
        }
        if (interaction.commandName === '設定月結') {
          if (!isAdminOrStaff(interaction)) {
            return replyError(interaction, '你沒有權限');
          }
          const target =
            interaction.options.getUser('玩家');
          const guarantee =
            interaction.options.getInteger('保證金');
          if (!guarantee || guarantee <= 0) {
            return replyError(interaction, '保證金必須大於 0');
          }
          const { data: oldAccount } =
            await supabase
              .from('member_monthly_accounts')
              .select('*')
              .eq('user_id', target.id)
              .maybeSingle();
          const beforeAmount =
            Number(oldAccount?.guarantee_amount || 0);
          const { error } =
            await supabase
              .from('member_monthly_accounts')
              .upsert({
                user_id: target.id,
                guarantee_amount: guarantee,
                monthly_limit: guarantee,
                used_amount: Number(oldAccount?.used_amount || 0),
                enabled: true,
                updated_at: new Date().toISOString()
              }, {
                onConflict: 'user_id'
              });
          if (error) {
            console.error('[設定月結失敗]', error);
            return replyError(interaction, '設定月結失敗');
          }
          await supabase
            .from('member_guarantee_logs')
            .insert({
              user_id: target.id,
              type: oldAccount ? '調整保證金' : '設定保證金',
              amount: guarantee - beforeAmount,
              before_amount: beforeAmount,
              after_amount: guarantee,
              note: `客服 ${interaction.user.id} 設定`
            });
          return interaction.editReply({
            content:
              `✅ 已設定 <@${target.id}> 月結會員\n` +
              `保證金：NT$${guarantee}\n` +
              `月結額度：NT$${guarantee}\n` +
              `目前已使用：NT$${Number(oldAccount?.used_amount || 0)}`
          });
        }
        if (interaction.commandName === '月結餘額扣款') {
          if (!isAdminOrStaff(interaction)) {
            return replyError(interaction, '你沒有權限');
          }

          const target =
            interaction.options.getUser('玩家');
          const amount =
            interaction.options.getInteger('金額');
          const rawNote =
            interaction.options.getString('備註');
          const note =
            (
              rawNote && rawNote.trim()
                ? rawNote.trim()
                : '客服手動扣除月結額度'
            ).slice(0, 180);

          if (!target) {
            return replyError(interaction, '找不到玩家');
          }

          if (!amount || amount <= 0) {
            return replyError(interaction, '扣款金額必須大於 0');
          }

          const { data: account, error: accountError } =
            await supabase
              .from('member_monthly_accounts')
              .select('*')
              .eq('user_id', target.id)
              .maybeSingle();

          if (accountError) {
            console.error('[月結餘額扣款] 查詢帳戶失敗', accountError);
            return replyError(interaction, '查詢月結帳戶失敗');
          }

          if (!account) {
            return replyError(interaction, '找不到會員月結帳戶');
          }

          if (!account.enabled) {
            return replyError(interaction, '月結會員目前已停用');
          }

          const monthlyLimit =
            Number(account.monthly_limit || 0);
          const oldUsedAmount =
            Number(account.used_amount || 0);
          const oldAvailableAmount =
            Math.max(0, monthlyLimit - oldUsedAmount);

          if (oldAvailableAmount < amount) {
            return replyError(
              interaction,
              `月結可用額度不足，目前可用 NT$${oldAvailableAmount.toLocaleString('zh-TW')}`
            );
          }

          const newUsedAmount =
            oldUsedAmount + amount;
          const newAvailableAmount =
            Math.max(0, monthlyLimit - newUsedAmount);
          const billingMonth =
            getBillingMonth();

          const { error: updateError } =
            await supabase
              .from('member_monthly_accounts')
              .update({
                used_amount: newUsedAmount,
                updated_at: new Date().toISOString()
              })
              .eq('user_id', target.id);

          if (updateError) {
            console.error('[月結餘額扣款] 更新帳戶失敗', updateError);
            return replyError(interaction, '扣除月結額度失敗');
          }

          const { data: monthlyTx, error: txError } =
            await supabase
              .from('member_monthly_transactions')
              .insert({
                user_id: target.id,
                source_type: 'manual_monthly_deduct',
                source_id: interaction.id,
                item_name: note,
                benefit_type: '月結餘額扣款',
                amount,
                cashback: 0,
                billing_month: billingMonth,
                status: 'unbilled'
              })
              .select()
              .single();

          if (txError) {
            console.error('[月結餘額扣款] 建立交易失敗', txError);
            await supabase
              .from('member_monthly_accounts')
              .update({
                used_amount: oldUsedAmount,
                updated_at: new Date().toISOString()
              })
              .eq('user_id', target.id);

            return replyError(interaction, '建立月結扣款紀錄失敗，已嘗試回復額度');
          }

          await recordAccountingLedger({
            entry_type: 'manual_monthly_charge',
            entry_label: '月結應收',
            amount,
            revenue_amount: amount,
            receivable_amount: amount,
            payment_method: '月結',
            customer_id: target.id,
            source_table: 'member_monthly_transactions',
            source_id: String(monthlyTx?.id || interaction.id),
            dedupe_key: `member_monthly_transactions:${monthlyTx?.id || interaction.id}:manual_monthly_charge`,
            note,
            created_by: interaction.user.id
          });

          const targetUser =
            await client.users
              .fetch(target.id)
              .catch(() => null);

          if (targetUser) {
            await targetUser.send({
              embeds: [
                new EmbedBuilder()
                  .setColor('#ffd166')
                  .setTitle('🌙 月結額度已扣除')
                  .setDescription(
                    `扣除金額：NT$${amount.toLocaleString('zh-TW')}\n` +
                    `目前已使用：NT$${newUsedAmount.toLocaleString('zh-TW')}\n` +
                    `剩餘可用額度：NT$${newAvailableAmount.toLocaleString('zh-TW')}\n\n` +
                    `備註：${note}\n\n` +
                    `繳費確認後，月結可用額度才會恢復。`
                  )
                  .setTimestamp()
              ]
            }).catch(() => {});
          }

          return interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setColor('#57F287')
                .setTitle('✅ 已扣除月結可用額度')
                .setDescription(
                  `會員：<@${target.id}>\n` +
                  `扣除金額：NT$${amount.toLocaleString('zh-TW')}\n` +
                  `帳單月份：${billingMonth}\n\n` +
                  `已使用額度：NT$${oldUsedAmount.toLocaleString('zh-TW')} → NT$${newUsedAmount.toLocaleString('zh-TW')}\n` +
                  `剩餘可用額度：NT$${oldAvailableAmount.toLocaleString('zh-TW')} → NT$${newAvailableAmount.toLocaleString('zh-TW')}\n\n` +
                  `備註：${note}\n` +
                  `這筆額度會等到月結繳費確認後才恢復。`
                )
                .setFooter({
                  text: `操作人員：${interaction.user.tag}`
                })
                .setTimestamp()
            ]
          });
        }
        if (interaction.commandName === '查詢累積') {
          const guildId = getGuildId(interaction);
          const target =
            interaction.options.getUser('玩家') ||
            interaction.user;

          const { data: vipData, error: vipError } =
            await getUserVipRecord(target.id, guildId);

          if (vipError) {
            console.error('[查詢累積] 讀取 user_vips 失敗', vipError);
            return replyError(interaction, '查詢累積資料失敗');
          }

          const totalSpent =
            Number(vipData?.total_spent || 0);

          const totalTopup =
            Number(vipData?.total_topup || 0);

          const highestSingleTopup =
            Number(vipData?.highest_single_topup || 0);

          const vipName =
            vipData?.level_name ||
            vipData?.level_key ||
            '尚未達成 VIP';
          return interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setColor('#66ccff')
                .setTitle('📊 會員累積資訊')
                .setThumbnail(target.displayAvatarURL())
                .setDescription(
                  `會員：<@${target.id}>\n\n` +
                  `💰 **累積消費**\n` +
                  `NT$${totalSpent.toLocaleString('zh-TW')}\n\n` +
                  `💳 **累積儲值**\n` +
                  `NT$${totalTopup.toLocaleString('zh-TW')}\n\n` +
                  `🏦 **最高單筆儲值**\n` +
                  `NT$${highestSingleTopup.toLocaleString('zh-TW')}\n\n` +
                  `🌙 **目前 VIP 等級**\n` +
                  `${vipName}`
                )
                .setFooter({
                  text: `查詢人：${interaction.user.tag}`
                })
                .setTimestamp()
            ]
          });
        }
        if (interaction.commandName === '標記月結已繳') {
          if (!isAdminOrStaff(interaction)) {
            return replyError(interaction, '你沒有權限');
          }
          const target =
            interaction.options.getUser('玩家');
          const billingMonth =
              interaction.options.getString('月份');
          if (!/^\d{4}-\d{2}$/.test(billingMonth)) {
            return replyError(interaction, '月份格式錯誤，請輸入例如 2026-06');
          }
          const { data: bill, error: billError } =
            await supabase
              .from('member_monthly_bills')
              .select('*')
              .eq('user_id', target.id)
              .eq('billing_month', billingMonth)
              .maybeSingle();
            if (billError) {
            console.error('[月結已繳] 查詢帳單失敗', billError);
            return replyError(interaction, '查詢帳單失敗');
          }
          if (!bill) {
            return replyError(interaction, '找不到這個月份的月結帳單');
          }
          if (bill.status === 'paid') {
            return interaction.editReply({
              content: '✅ 這張帳單已經是已繳狀態'
            });
          }
          if (bill.status === 'deducted') {
            return replyError(interaction, '這張帳單已經由保證金抵扣，不能再標記已繳');
          }
          const { data: account, error: accountError } =
            await supabase
              .from('member_monthly_accounts')
              .select('*')
              .eq('user_id', target.id)
              .maybeSingle();
          if (accountError || !account) {
            console.error('[月結已繳] 查詢帳戶失敗', accountError);
            return replyError(interaction, '找不到會員月結帳戶');
          }
          const totalAmount =
            Number(bill.total_amount || 0);
          const cashbackAmount =
            Number(bill.cashback_amount || 0);
          const oldUsedAmount =
            Number(account.used_amount || 0);
          const newUsedAmount =
            Math.max(0, oldUsedAmount - totalAmount);
          // ===== 更新帳單狀態 =====
          const { error: updateBillError } =
            await supabase
              .from('member_monthly_bills')
              .update({
                status: 'paid',
                paid_at: new Date().toISOString(),
                paid_by: interaction.user.id,
                payment_method: '客服標記已繳'
              })
              .eq('id', bill.id);
          if (updateBillError) {
            console.error('[月結已繳] 更新帳單失敗', updateBillError);
            return replyError(interaction, '更新帳單失敗');
          }
          // ===== 釋放已使用額度 =====
          const { error: updateAccountError } =
            await supabase
              .from('member_monthly_accounts')
              .update({
                used_amount: newUsedAmount,
                updated_at: new Date().toISOString()
                })
              .eq('user_id', target.id);
          if (updateAccountError) {
            console.error('[月結已繳] 更新月結額度失敗', updateAccountError);
            return replyError(interaction, '帳單已標記，但更新額度失敗');
          }
          // ===== 更新交易狀態 =====
          await supabase
            .from('member_monthly_transactions')
            .update({
              status: 'paid'
            })
            .eq('user_id', target.id)
            .eq('billing_month', billingMonth)
            .in('status', ['billed', 'unbilled']);
          // ===== 發放回饋 =====
          if (cashbackAmount > 0) {
            const finalCoins =
              await changeCoins(target.id, cashbackAmount);
            await sendWalletLog(
              target.id,
              '月結回饋',
              cashbackAmount,
              finalCoins,
              `🌙 ${billingMonth} 月結帳單已繳清，發放 3% 回饋`
            );
          }
          const targetUser =
            await client.users
              .fetch(target.id)
              .catch(() => null);
          if (targetUser) {
            await targetUser.send({
              embeds: [
                new EmbedBuilder()
                  .setColor('#57F287')
                  .setTitle('✅ 月結帳單已確認繳款')
                  .setDescription(
                    `結帳月份：${billingMonth}\n` +
                    `已繳金額：NT$${totalAmount.toLocaleString('zh-TW')}\n` +
                    `發放回饋：${cashbackAmount.toLocaleString('zh-TW')} 星雨幣\n\n` +
                    `你的月結可用額度已恢復。`
                  )
                  .setTimestamp()
              ]
            }).catch(() => {});
          }
          return interaction.editReply({
            content:
              `✅ 已標記月結已繳\n` +
              `會員：<@${target.id}>\n` +
              `月份：${billingMonth}\n` +
              `金額：NT$${totalAmount.toLocaleString('zh-TW')}\n` +
              `已恢復額度，並發放 ${cashbackAmount.toLocaleString('zh-TW')} ASD 回饋`
          });
        }
        if (interaction.commandName === '保證金抵扣') {
          if (!isAdminOrStaff(interaction)) {
            return replyError(interaction, '你沒有權限');
          }
          const target =
            interaction.options.getUser('玩家');
          const billingMonth =
            interaction.options.getString('月份');
          if (!/^\d{4}-\d{2}$/.test(billingMonth)) {
            return replyError(interaction, '月份格式錯誤，請輸入例如 2026-06');
          }
          const { data: bill, error: billError } =
            await supabase
              .from('member_monthly_bills')
              .select('*')
              .eq('user_id', target.id)
              .eq('billing_month', billingMonth)
              .maybeSingle();
          if (billError) {
            console.error('[保證金抵扣] 查詢帳單失敗', billError);
            return replyError(interaction, '查詢帳單失敗');
          }
          if (!bill) {
            return replyError(interaction, '找不到這個月份的月結帳單');
          }
          if (bill.status === 'paid') {
            return replyError(interaction, '這張帳單已經繳款，不能抵扣');
          }
          if (bill.status === 'deducted') {
            return interaction.editReply({
              content: '✅ 這張帳單已經由保證金抵扣'
            });
          }
          const { data: account, error: accountError } =
            await supabase
              .from('member_monthly_accounts')
              .select('*')
              .eq('user_id', target.id)
              .maybeSingle();
          if (accountError || !account) {
            console.error('[保證金抵扣] 查詢月結帳戶失敗', accountError);
            return replyError(interaction, '找不到會員月結帳戶');
          }
          const totalAmount =
            Number(bill.total_amount || 0);
          const oldGuarantee =
            Number(account.guarantee_amount || 0);
          const oldUsedAmount =
            Number(account.used_amount || 0);
          if (oldGuarantee < totalAmount) {
            return replyError(
              interaction,
              `保證金不足，帳單 NT$${totalAmount.toLocaleString('zh-TW')}，目前保證金 NT$${oldGuarantee.toLocaleString('zh-TW')}`
            );
          }
          const newGuarantee =
            oldGuarantee - totalAmount;
          const newMonthlyLimit =
            newGuarantee;
          const newUsedAmount =
            Math.max(0, oldUsedAmount - totalAmount);
          // ===== 更新帳單狀態 =====
          const { error: updateBillError } =
            await supabase
              .from('member_monthly_bills')
              .update({
                status: 'deducted',
                paid_at: new Date().toISOString()
              })
              .eq('id', bill.id);
          if (updateBillError) {
            console.error('[保證金抵扣] 更新帳單失敗', updateBillError);
            return replyError(interaction, '更新帳單失敗');
          }
          // ===== 更新月結帳戶 =====
          const { error: updateAccountError } =
            await supabase
              .from('member_monthly_accounts')
              .update({
                guarantee_amount: newGuarantee,
                monthly_limit: newMonthlyLimit,
                used_amount: newUsedAmount,
                enabled: false,
                updated_at: new Date().toISOString()
              })
              .eq('user_id', target.id);
          if (updateAccountError) {
            console.error('[保證金抵扣] 更新帳戶失敗', updateAccountError);
            return replyError(interaction, '帳單已抵扣，但更新月結帳戶失敗');
          }
          // ===== 更新交易狀態 =====
          await supabase
            .from('member_monthly_transactions')
            .update({
              status: 'deducted'
            })
            .eq('user_id', target.id)
            .eq('billing_month', billingMonth)
            .in('status', ['billed', 'unbilled']);
          // ===== 寫入保證金紀錄 =====
          await supabase
            .from('member_guarantee_logs')
            .insert({
              user_id: target.id,
              type: '帳單抵扣',
              amount: -totalAmount,
              before_amount: oldGuarantee,
              after_amount: newGuarantee,
              note: `${billingMonth} 月結帳單逾期，由客服 ${interaction.user.id} 抵扣`
            });
          const targetUser =
            await client.users
              .fetch(target.id)
              .catch(() => null);
          if (targetUser) {
            await targetUser.send({
              embeds: [
                new EmbedBuilder()
                  .setColor('#ff9966')
                  .setTitle('⚠️ 月結帳單已由保證金抵扣')
                  .setDescription(
                    `帳單月份：${billingMonth}\n` +
                    `抵扣金額：NT$${totalAmount.toLocaleString('zh-TW')}\n\n` +
                    `原保證金：NT$${oldGuarantee.toLocaleString('zh-TW')}\n` +
                    `剩餘保證金：NT$${newGuarantee.toLocaleString('zh-TW')}\n` +
                    `剩餘月結額度：NT$${newMonthlyLimit.toLocaleString('zh-TW')}\n\n` +
                    `你的月結資格已暫停，如需恢復請聯繫客服。`
                  )
                  .setTimestamp()
              ]
            }).catch(() => {});
          }
          return interaction.editReply({
            content:
              `✅ 已從 <@${target.id}> 保證金抵扣 ${billingMonth} 月結帳單\n` +
              `抵扣金額：NT$${totalAmount.toLocaleString('zh-TW')}\n` +
              `保證金：NT$${oldGuarantee.toLocaleString('zh-TW')} → NT$${newGuarantee.toLocaleString('zh-TW')}\n` +
              `已使用額度：NT$${oldUsedAmount.toLocaleString('zh-TW')} → NT$${newUsedAmount.toLocaleString('zh-TW')}\n` +
              `月結狀態：已暫停`
          });
        }
        // 新增商品
        if (interaction.commandName === '新增商品') {
          if (!isAdminOrStaff(interaction)) {
            return replyError(interaction, '你沒有權限');
          }
          const itemName =
            interaction.options.getString('名稱');
          const price =
            interaction.options.getInteger('價格');
          const description =
            interaction.options.getString('介紹');
          const itemType =
            interaction.options.getString('類型');
          await addShopItem(
            itemName,
            price,
            description,
            itemType
          );
          await refreshShop(client);
          return interaction.editReply({
            content: `✅ 已新增商品：${itemName}`,
          });
        }
        // 刪除商品
        if (interaction.commandName === '刪除商品') {
          if (!isAdminOrStaff(interaction)) {
            return replyError(interaction, '你沒有權限');
          }
          const itemName =
            interaction.options.getString('名稱');
          await removeShopItem(itemName);
          await refreshShop(client);
          return interaction.editReply({
            content: `🗑️ 已刪除商品：${itemName}`,
          });
        }
        if (interaction.commandName === '刪除扭蛋') {
          if (!isAdmin(interaction)) {
          return replyError(interaction, '你沒有權限');
          }
          const name =
            interaction.options.getString('名稱');
          const { data: pool } = await supabase
            .from('gacha_pools')
            .select('*')
            .eq('guild_id', interaction.guild.id)
            .eq('pool_name', name)
            .single();
          if (!pool) {
            return replyError(interaction, '找不到卡池');
          }
          // 先刪獎勵
          await supabase
            .from('gacha_rewards')
            .delete()
            .eq('pool_id', pool.id);
          // 再刪卡池
          await supabase
            .from('gacha_pools')
            .delete()
            .eq('id', pool.id);
          return interaction.editReply({
            content: `🗑️ 已刪除扭蛋：${name}`,
          });
        }
        // 我的商品
        if (interaction.commandName === '我的商品') {
          const rawItems =
            await getUserItems(interaction.user.id)
          const items = rawItems.filter(item => {
            const name =
              String(item.item_name || '');
            const desc =
              String(item.description || '');
            return !(
              name.includes('星雨幣') ||
              name.includes('金幣') ||
              name.includes('幣') ||
              desc.includes('星雨幣') ||
              desc.includes('金幣')
            );
          });
          if (!items.length) {
            return interaction.editReply({
              content: '📦 你目前沒有商品',
            });
          }
          const rarityOrder = ['SSR', 'SR', 'R'];
          let text = '';
          // 稀有商品
          for (const rarity of rarityOrder) {
            const filtered = items.filter(
              item => item.rarity === rarity
            );
            if (filtered.length === 0) continue;
            text += `\n${getRarityEmoji(rarity)} ${rarity}\n`;
            for (const item of filtered) {
              text += `• ${item.item_name}`;
              if (item.description) {
              text += `\n└ 📦 ${item.description}`;
            }
            text += '\n';
            }
          }
          // 一般商品
          const normalItems = items.filter(
            item =>
              !item.rarity &&
              item.item_type !== 'coupon'
          );
          const couponItems = items.filter(
            item => item.item_type === 'coupon'
          );
          if (normalItems.length > 0) {
            text += `\n🛒 一般商品\n`;
            for (const item of normalItems) {
              text += `• ${item.item_name}\n`;
              if (item.description) {
                text += `\n└ 📦 ${item.description}`;
              }
              if (item.item_type) {
                text += `\n└ 🏷️ 類型：${item.item_type}`;
              }
              if (item.created_at) {
                const date = new Date(item.created_at)
                  .toLocaleString('zh-TW');
                text += `\n└ 🕒 ${date}`;
              }
              text += '\n\n';
            }
          }
          if (couponItems.length > 0) {
            text += `\n🎟️ 優惠券\n`;
            for (const item of couponItems) {
              text += `• ${item.item_name}\n`;
              if (item.description) {
                text += `└ 📦 ${item.description}\n`;
              }
              if (item.created_at) {
                const date = new Date(item.created_at)
                  .toLocaleString('zh-TW');
                text += `└ 🕒 ${date}\n`;
              }
              text += '\n';
            }
          }
          return interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setColor('#ff66cc')
                .setTitle('🎒 分類背包')
                .setDescription(text.slice(0, 3800))
            ],
          });
        }
}
async function createRedPacket(interaction, totalAmount, totalCount) {
  if (!Number.isInteger(totalAmount) || totalAmount <= 0) {
    return interaction.editReply({
      content: '❌ 紅包金額必須大於 0'
    });
  }

  if (!Number.isInteger(totalCount) || totalCount <= 0) {
    return interaction.editReply({
      content: '❌ 紅包數量必須大於 0'
    });
  }

  if (totalCount > 50) {
    return interaction.editReply({
      content: '❌ 一包紅包最多 50 人領取'
    });
  }

  if (totalAmount < totalCount) {
    return interaction.editReply({
      content: '❌ 紅包金額不能小於數量，至少每人 1 星雨幣'
    });
  }

  const senderData = await getUser(interaction.user.id);

  if ((senderData.coins || 0) < totalAmount) {
    return interaction.editReply({
      content: '❌ 你的星雨幣不足，無法發紅包'
    });
  }

  const finalCoins =
    await changeCoins(interaction.user.id, -totalAmount);

  await sendWalletLog(
    interaction.user.id,
    '發紅包',
    -totalAmount,
    finalCoins,
    `🧧 發出紅包，共 ${totalAmount} 星雨幣 / ${totalCount} 份`
  );

  const packetNo = `RP-${Date.now()}`;

  const { data: packet, error } =
    await supabase
      .from('red_packets')
      .insert({
        packet_no: packetNo,
        sender_id: interaction.user.id,
        total_amount: totalAmount,
        remaining_amount: totalAmount,
        total_count: totalCount,
        remaining_count: totalCount,
        status: 'active',
        channel_id: interaction.channel.id
      })
      .select()
      .single();

  if (error || !packet) {
    console.error('[紅包建立失敗]', error);

    await changeCoins(interaction.user.id, totalAmount);

    return interaction.editReply({
      content: '❌ 紅包建立失敗，已退回星雨幣'
    });
  }

  const embed =
    new EmbedBuilder()
      .setColor('#ff4d4d')
      .setTitle('🧧 星雨紅包')
      .setDescription(
        `<@${interaction.user.id}> 發了一包紅包！\n\n` +
        `💰 總金額：${totalAmount} 星雨幣\n` +
        `👥 數量：${totalCount} 份\n\n` +
        `快點下方按鈕搶紅包！`
      )
      .setFooter({
        text: `紅包編號：${packetNo}`
      })
      .setTimestamp();

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`claim_red_packet_${packet.id}`)
          .setLabel('搶紅包')
          .setEmoji('🧧')
          .setStyle(ButtonStyle.Danger)
      );

  const msg =
    await interaction.channel.send({
      embeds: [embed],
      components: [row]
    });

  await supabase
    .from('red_packets')
    .update({
      message_id: msg.id
    })
    .eq('id', packet.id);

  return interaction.editReply({
    content: `✅ 已發出紅包：${totalAmount} 星雨幣 / ${totalCount} 份`
  });
}
async function claimRedPacket(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }

  const packetId =
    interaction.customId.replace(
      'claim_red_packet_',
      ''
    );

  const { data, error } =
    await supabase.rpc(
      'claim_red_packet_safe',
      {
        p_packet_id: Number(packetId),
        p_user_id: interaction.user.id
      }
    );

  if (error) {
    console.error('[安全搶紅包失敗]', error);

    return interaction.editReply({
      content:
        '❌ 搶紅包失敗，請稍後再試。\n' +
        `錯誤：${error.message || '未知錯誤'}`
    });
  }

  const result =
    Array.isArray(data)
      ? data[0]
      : data;

  if (!result || !result.success) {
    return interaction.editReply({
      content: `❌ ${result?.message || '搶紅包失敗'}`
    });
  }

  if (result.left_count <= 0 || result.left_amount <= 0) {
    const finishedEmbed =
      EmbedBuilder.from(interaction.message.embeds[0])
        .setColor('#999999')
        .setTitle('🧧 星雨紅包｜已搶完')
        .addFields({
          name: '狀態',
          value: '紅包已被搶完',
          inline: false
        });

    const disabledRow =
      new ActionRowBuilder()
        .addComponents(
          ButtonBuilder.from(
            interaction.message.components[0].components[0]
          )
            .setDisabled(true)
            .setLabel('已搶完')
        );

    await interaction.message.edit({
      embeds: [finishedEmbed],
      components: [disabledRow]
    }).catch(() => {});
  }

  return interaction.editReply({
    content:
      `🧧 恭喜你搶到 ${Number(result.claim_amount || 0).toLocaleString('zh-TW')} 星雨幣！\n` +
      `💰 目前餘額：${Number(result.new_balance || 0).toLocaleString('zh-TW')} 星雨幣\n` +
      `📦 紅包剩餘：${Number(result.left_amount || 0).toLocaleString('zh-TW')} 星雨幣 / ${Number(result.left_count || 0).toLocaleString('zh-TW')} 份`
  });
}

async function createPrivateRoom(interaction) {
  const safeName =
    interaction.user.username
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5-_]/g, '')
      .slice(0, 10);

  const roomChannel =
    await interaction.guild.channels.create({
      name: `私人-${safeName}-${Date.now()}`,
      type: ChannelType.GuildText,
      parent: process.env.PRIVATE_ROOM_CATEGORY,
      permissionOverwrites: [
        {
          id: interaction.guild.roles.everyone,
          deny: [
            PermissionFlagsBits.ViewChannel
          ]
        },
        {
          id: interaction.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks
          ]
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels
          ]
        }
      ]
    });

  const inviteMenu =
    new UserSelectMenuBuilder()
      .setCustomId(`private_room_invite_${interaction.user.id}`)
      .setPlaceholder('選擇要邀請進來的人')
      .setMinValues(1)
      .setMaxValues(10);

  const closeButton =
    new ButtonBuilder()
      .setCustomId(`private_room_close_${interaction.user.id}`)
      .setLabel('關閉私人頻道')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger);

  const row1 =
    new ActionRowBuilder()
      .addComponents(inviteMenu);

  const row2 =
    new ActionRowBuilder()
      .addComponents(closeButton);

  await roomChannel.send({
    content: `<@${interaction.user.id}> 你的私人文字頻道已建立。`,
    embeds: [
      new EmbedBuilder()
        .setColor('#66ccff')
        .setTitle('🔐 私人文字房間')
        .setDescription(
          '這個頻道目前只有你看得到。\n\n' +
          '你可以用下方選單邀請其他人進來。'
        )
        .setTimestamp()
    ],
    components: [row1, row2]
  });

  return interaction.editReply({
    content: `✅ 已建立私人頻道：<#${roomChannel.id}>`
  });
}
async function getOrCreateMonthlyPayableBill(userId) {
  const { data: account, error: accountError } =
    await supabase
      .from('member_monthly_accounts')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

  if (accountError || !account) {
    console.error('[月結繳費] 找不到月結帳戶', accountError);
    throw new Error('你目前尚未開通月結會員');
  }

  if (!account.enabled) {
    throw new Error('你的月結會員目前已停用');
  }

  const usedAmount =
    Number(account.used_amount || 0);

  if (usedAmount <= 0) {
    return null;
  }

  const billingMonth =
    getBillingMonth();

  const cashbackAmount =
    Math.floor(usedAmount * 0.03);

  const { data: existingBill, error: existingError } =
    await supabase
      .from('member_monthly_bills')
      .select('*')
      .eq('user_id', userId)
      .in('status', ['unpaid', 'pending', 'manual_pending'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

  if (existingError) {
    console.error('[月結繳費] 查詢未繳帳單失敗', existingError);
    throw new Error('查詢月結帳單失敗');
  }

  if (existingBill) {
    const { data: updatedBill, error: updateError } =
      await supabase
        .from('member_monthly_bills')
        .update({
          total_amount: usedAmount,
          cashback_amount: cashbackAmount,
          billing_month: billingMonth,
          status: 'unpaid'
        })
        .eq('id', existingBill.id)
        .select()
        .single();

    if (updateError || !updatedBill) {
      console.error('[月結繳費] 更新即時帳單失敗', updateError);
      throw new Error('更新月結帳單失敗');
    }

    return updatedBill;
  }

  const { data: bill, error: billError } =
    await supabase
      .from('member_monthly_bills')
      .insert({
        user_id: userId,
        billing_month: billingMonth,
        total_amount: usedAmount,
        cashback_amount: cashbackAmount,
        status: 'unpaid',
        due_date: getNextMonthDueDate()
      })
      .select()
      .single();

  if (billError || !bill) {
    console.error('[月結繳費] 建立即時帳單失敗', billError);
    throw new Error('建立月結帳單失敗');
  }

  return bill;
}
async function markMonthlyBillPaidByBillId({
  billId,
  paidBy,
  method = '客服確認'
}) {
  const { data: bill, error: billError } =
    await supabase
      .from('member_monthly_bills')
      .select('*')
      .eq('id', billId)
      .maybeSingle();

  if (billError || !bill) {
    console.error('[月結繳費] 找不到帳單', billError);
    throw new Error('找不到月結帳單');
  }

  if (bill.status === 'paid') {
    throw new Error('這張帳單已經是已繳狀態');
  }

  if (bill.status === 'deducted') {
    throw new Error('這張帳單已由保證金抵扣，不能再標記已繳');
  }

  const { data: account, error: accountError } =
    await supabase
      .from('member_monthly_accounts')
      .select('*')
      .eq('user_id', bill.user_id)
      .maybeSingle();

  if (accountError || !account) {
    console.error('[月結繳費] 找不到月結帳戶', accountError);
    throw new Error('找不到會員月結帳戶');
  }

  const totalAmount =
    Number(bill.total_amount || 0);

  const cashbackAmount =
    Number(bill.cashback_amount || 0);

  const oldUsedAmount =
    Number(account.used_amount || 0);

  const newUsedAmount =
    Math.max(0, oldUsedAmount - totalAmount);

  const { error: updateBillError } =
    await supabase
      .from('member_monthly_bills')
      .update({
        status: 'paid',
        paid_at: new Date().toISOString()
      })
      .eq('id', bill.id);

  if (updateBillError) {
    console.error('[月結繳費] 更新帳單失敗', updateBillError);
    throw new Error('更新帳單失敗');
  }

  const { error: updateAccountError } =
    await supabase
      .from('member_monthly_accounts')
      .update({
        used_amount: newUsedAmount,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', bill.user_id);

  if (updateAccountError) {
    console.error('[月結繳費] 更新額度失敗', updateAccountError);
    throw new Error('帳單已標記，但更新額度失敗');
  }

  await supabase
    .from('member_monthly_transactions')
    .update({
      status: 'paid'
    })
    .eq('user_id', bill.user_id)
    .eq('billing_month', bill.billing_month)
    .in('status', ['billed', 'unbilled']);

  const monthlyWalletPayment = isWalletPayment(method);

  await recordAccountingLedger({
    entry_type: 'monthly_payment',
    entry_label: '月結收款',
    amount: totalAmount,
    cash_amount: monthlyWalletPayment ? 0 : totalAmount,
    liability_amount: monthlyWalletPayment ? -totalAmount : 0,
    receivable_amount: -totalAmount,
    payment_method: method,
    customer_id: bill.user_id,
    source_table: 'member_monthly_bills',
    source_id: String(bill.id),
    dedupe_key: `member_monthly_bills:${bill.id}:monthly_payment`,
    note: `${bill.billing_month} 月結帳單已繳清`,
    created_by: paidBy || null
  });

  if (cashbackAmount > 0) {
    const finalCoins =
      await changeCoins(bill.user_id, cashbackAmount);

    await sendWalletLog(
      bill.user_id,
      '月結回饋',
      cashbackAmount,
      finalCoins,
      `🌙 ${bill.billing_month} 月結帳單已繳清，發放 3% 回饋`
    );
  }

  const targetUser =
    await client.users
      .fetch(bill.user_id)
      .catch(() => null);

  if (targetUser) {
    await targetUser.send({
      embeds: [
        new EmbedBuilder()
          .setColor('#57F287')
          .setTitle('✅ 月結帳單已確認繳款')
          .setDescription(
            `結帳月份：${bill.billing_month}\n` +
            `已繳金額：NT$${totalAmount.toLocaleString('zh-TW')}\n` +
            `付款方式：${method}\n` +
            `發放回饋：${cashbackAmount.toLocaleString('zh-TW')} ASD\n\n` +
            `你的月結可用額度已恢復。`
          )
          .setTimestamp()
      ]
    }).catch(() => {});
  }

  return {
    bill,
    totalAmount,
    cashbackAmount,
    oldUsedAmount,
    newUsedAmount,
    paidBy,
    method
  };
}

async function payMonthlyBillByWallet(interaction, billId) {
  const { data: bill, error: billError } =
    await supabase
      .from('member_monthly_bills')
      .select('*')
      .eq('id', billId)
      .maybeSingle();

  if (billError || !bill) {
    throw new Error('找不到月結帳單');
  }

  if (bill.user_id !== interaction.user.id) {
    throw new Error('只有帳單本人可以繳費');
  }

  if (bill.status === 'paid') {
    throw new Error('這張帳單已經繳清');
  }

  if (bill.status === 'deducted') {
    throw new Error('這張帳單已由保證金抵扣');
  }

  const amount =
    Number(bill.total_amount || 0);

  if (!amount || amount <= 0) {
    throw new Error('帳單金額錯誤');
  }

  const userData =
    await getUser(interaction.user.id);

  const currentCoins =
    Number(userData.coins || 0);

  if (currentCoins < amount) {
    throw new Error(
      `ASD 餘額不足，目前餘額 ${currentCoins} ASD，需要 ${amount} ASD`
    );
  }

  const finalCoins =
    await changeCoins(interaction.user.id, -amount);

  await sendWalletLog(
    interaction.user.id,
    '月結繳費',
    -amount,
    finalCoins,
    `🌙 ${bill.billing_month} 月結帳單繳費`
  );

  const result =
    await markMonthlyBillPaidByBillId({
      billId: bill.id,
      paidBy: interaction.user.id,
      method: '儲值卡 / 錢包'
    });

  return {
    ...result,
    finalCoins
  };
}

async function createMonthlyBillPaymentChannel(interaction, bill) {
  const ticketNumber = Date.now();

  const safeName =
    interaction.user.username
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5-_]/g, '')
      .slice(0, 10);

  const channelName =
    `月結繳費-${safeName}-${ticketNumber}`;

  const payChannel =
    await interaction.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: process.env.ORDER_CATEGORY,
      topic: `monthly_bill:${bill.id};owner:${interaction.user.id}`,
      permissionOverwrites: [
        {
          id: interaction.guild.roles.everyone,
          deny: [PermissionFlagsBits.ViewChannel]
        },
        {
          id: interaction.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks
          ]
        },
        {
          id: process.env.STAFF_ROLE,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks
          ]
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks
          ]
        }
      ]
    });

  const methodMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`monthly_bill_manual_method_${bill.id}`)
      .setPlaceholder('請選擇月結繳費方式')
      .addOptions([
        {
          label: '匯款 / 轉帳',
          description: '顯示銀行帳號，付款後上傳明細',
          value: '匯款'
        },
        {
          label: '刷卡',
          description: '顯示刷卡連結，付款後上傳截圖',
          value: '刷卡'
        },
        {
          label: '無卡',
          description: '顯示無卡帳號，付款後上傳明細',
          value: '無卡'
        },
        {
          label: '虛擬貨幣',
          description: '請等待客服提供錢包地址',
          value: '虛擬貨幣'
        }
      ]);

  const row =
    new ActionRowBuilder()
      .addComponents(methodMenu);

  const closeRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('owner_cancel_ticket')
          .setLabel('我按錯了，關閉頻道')
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger)
      );

  await payChannel.send({
    content:
      `<@&${process.env.STAFF_ROLE}> <@${interaction.user.id}> 建立了月結繳費頻道。`,
    embeds: [
      new EmbedBuilder()
        .setColor('#ffd166')
        .setTitle('🌙 月結繳費')
        .setDescription(
          `請選擇付款方式，付款完成後請上傳明細，等待客服確認。\n\n` +
          `會員：<@${bill.user_id}>\n` +
          `結帳月份：${bill.billing_month}\n` +
          `帳單金額：NT$${Number(bill.total_amount || 0).toLocaleString('zh-TW')}\n` +
          `待發回饋：${Number(bill.cashback_amount || 0).toLocaleString('zh-TW')} ASD\n` +
          `帳單狀態：${bill.status || 'unpaid'}`
        )
        .setTimestamp()
    ],
    components: [row, closeRow]
  });

  return payChannel;
}
// ===== 完整按鈕交互處理 =====
async function handleButtonInteraction(interaction) {
  const customId = interaction.customId;
  // ===== 訂單評價按鈕：不能 defer，showModal 必須是第一個回應 =====
  if (customId.startsWith('order_review_')) {
    const parts = customId.split('_');
    const rating = Number(parts[2]);
    const orderId = parts[3];
    const { data: order, error } =
      await supabase
        .from('play_orders')
        .select('*')
        .eq('id', orderId)
        .maybeSingle();
    if (error || !order) {
      return await interaction.reply({
        content: '❌ 找不到這張訂單',
        flags: 64
      });
    }
    if (interaction.user.id !== order.customer_id) {
      return await interaction.reply({
        content: '❌ 只有下單的闆闆可以給予評價',
        flags: 64
      });
    }
    const { data: oldReview } =
      await supabase
        .from('order_reviews')
        .select('*')
        .eq('order_id', order.id)
        .eq('customer_id', interaction.user.id)
        .maybeSingle();
    if (oldReview) {
      return await interaction.reply({
        content: '❌ 這張訂單已經評價過了，不能重複評價',
        flags: 64
      });
    }
    const modal =
      new ModalBuilder()
        .setCustomId(`submit_order_review_${rating}_${order.id}`)
        .setTitle('填寫訂單評價');
    const commentInput =
      new TextInputBuilder()
        .setCustomId('comment')
        .setLabel('想給這次服務什麼回饋？')
        .setPlaceholder('例如：陪陪很親切、體驗很好、希望下次可以...')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);
    modal.addComponents(
      new ActionRowBuilder().addComponents(commentInput)
    );
    return await interaction.showModal(modal);
  }
  try {
    // ===== 搶紅包 =====
    if (customId.startsWith('claim_red_packet_')) {
      return await claimRedPacket(interaction);
    }
    // ===== 每日簽到 =====
    if (customId === 'daily_checkin') {
      const today = getTodayDateString();
      const userData = await getUser(interaction.user.id);

      if (userData.last_checkin === today) {
        return await interaction.editReply({
          content: '❌ 今天已經簽到過了'
        });
      }

      const reward = 10;

      const finalCoins =
        await changeCoins(interaction.user.id, reward);

      await sendWalletLog(
        interaction.user.id,
        '每日簽到',
        reward,
        finalCoins,
        '☔ 每日簽到獎勵'
      );

      await updateCheckin(
        interaction.user.id,
        today
      );

      return await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor('#57F287')
            .setTitle('☔ 每日簽到成功')
            .setDescription(`獲得 ${reward} 星雨幣`)
        ]
      });
    }

    // ===== ATM 餘額 =====
    if (customId === 'check_coins') {
      const userData = await getUser(interaction.user.id);

      return await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor('#57F287')
            .setTitle('💰 星雨銀行')
            .setDescription(`目前餘額：${userData.coins} 星雨幣`)
        ]
      });
    }
    
    // ===== ATM 月結繳費：先輸入金額 =====
    if (customId === 'monthly_bill_pay') {
      const { data: account, error: accountError } =
        await supabase
          .from('member_monthly_accounts')
          .select('*')
          .eq('user_id', interaction.user.id)
          .maybeSingle();
      if (accountError || !account) {
        return await interaction.editReply({
          content: '❌ 你目前尚未開通月結會員'
        });
      }
      if (!account.enabled) {
        return await interaction.editReply({
          content: '❌ 你的月結會員目前已停用'
        });
      }
      const usedAmount =
        Number(account.used_amount || 0);
      if (usedAmount <= 0) {
        return await interaction.editReply({
          content: '✅ 目前沒有需要繳費的月結金額。'
        });
      }
      const modal =
        new ModalBuilder()
          .setCustomId('submit_monthly_bill_pay_amount')
          .setTitle('月結繳費金額');
      const amountInput =
        new TextInputBuilder()
          .setCustomId('amount')
          .setLabel(`請輸入繳費金額，目前應繳 NT$${usedAmount}`)
          .setPlaceholder(`最多可輸入 ${usedAmount}`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
      modal.addComponents(
        new ActionRowBuilder().addComponents(amountInput)
      );
      return await interaction.showModal(modal);
    }
    // ===== 月結儲值卡繳費確認 =====
    if (customId.startsWith('monthly_bill_wallet_confirm_')) {
      const billId =
        customId.replace('monthly_bill_wallet_confirm_', '');
      try {
        const result =
          await payMonthlyBillByWallet(interaction, billId);
        return await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor('#57F287')
              .setTitle('✅ 月結繳費完成')
              .setDescription(
                `已使用儲值卡 / 錢包完成月結繳費。\n\n` +
                `結帳月份：${result.bill.billing_month}\n` +
                `繳費金額：NT$${result.totalAmount.toLocaleString('zh-TW')}\n` +
                `扣款後餘額：${result.finalCoins.toLocaleString('zh-TW')} ASD\n` +
                `發放回饋：${result.cashbackAmount.toLocaleString('zh-TW')} ASD\n` +
                `已使用額度：NT$${result.oldUsedAmount.toLocaleString('zh-TW')} → NT$${result.newUsedAmount.toLocaleString('zh-TW')}`
              )
              .setTimestamp()
          ],
          components: []
        });
      } catch (err) {
        return await interaction.editReply({
          content: `❌ 月結繳費失敗：${err.message || err}`,
          components: []
        });
      }
    }
    if (customId.startsWith('monthly_bill_wallet_cancel_')) {
      return await interaction.editReply({
        content: '已取消月結儲值卡繳費。',
        components: []
      });
    }
    // ===== 客服確認月結已繳費 =====
    if (customId.startsWith('monthly_bill_confirm_paid_')) {
      const isStaff =
        interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
        interaction.member.roles.cache.has(process.env.STAFF_ROLE);
      if (!isStaff) {
        return await interaction.editReply({
          content: '❌ 只有客服可以確認月結繳費'
        });
      }
      const billId =
        customId.replace('monthly_bill_confirm_paid_', '');
      try {
        const result =
          await markMonthlyBillPaidByBillId({
            billId,
            paidBy: interaction.user.id,
            method: '客服確認繳費'
          });
        await interaction.channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor('#57F287')
              .setTitle('✅ 月結帳單已確認繳費')
              .setDescription(
                `會員：<@${result.bill.user_id}>\n` +
                `結帳月份：${result.bill.billing_month}\n` +
                `繳款金額：NT$${result.totalAmount.toLocaleString('zh-TW')}\n` +
                `發放回饋：${result.cashbackAmount.toLocaleString('zh-TW')} ASD\n` +
                `已使用額度：NT$${result.oldUsedAmount.toLocaleString('zh-TW')} → NT$${result.newUsedAmount.toLocaleString('zh-TW')}\n\n` +
                `客服：<@${interaction.user.id}>`
              )
              .setTimestamp()
          ]
        });
        const closeRow =
          new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder()
                .setCustomId('save_order_log')
                .setLabel('📁 儲存紀錄')
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId('delete_order_now')
                .setLabel('🗑️ 關閉頻道')
                .setStyle(ButtonStyle.Danger)
            );
        await interaction.channel.send({
          content:
            `<@&${process.env.STAFF_ROLE}> 月結繳費已完成，請選擇是否儲存紀錄或關閉頻道。`,
          components: [closeRow]
        });
        return await interaction.editReply({
          content: '✅ 已確認月結繳費，月結額度已恢復'
        });
      } catch (err) {
        return await interaction.editReply({
          content: `❌ 月結確認失敗：${err.message || err}`
        });
      }
    }
    // ===== ATM 消費資訊 =====
    if (customId === 'consume_info') {
      const userData = await getUser(interaction.user.id);
      const guildId = getGuildId(interaction);
      const { data: vipData, error: vipError } =
        await getUserVipRecord(interaction.user.id, guildId);
      if (vipError) {
        console.error('[ATM 消費資訊] 查詢 VIP 累積資料失敗', vipError);
      }
      const now = new Date();
      const taiwanNow =
        new Date(now.getTime() + 8 * 60 * 60 * 1000);
      const year =
        taiwanNow.getUTCFullYear();
      const month =
        String(taiwanNow.getUTCMonth() + 1).padStart(2, '0');
      const monthStart =
        new Date(`${year}-${month}-01T00:00:00+08:00`);
      const nextMonthStart =
        new Date(monthStart);
      nextMonthStart.setMonth(nextMonthStart.getMonth() + 1);
      const { data: topupLogs, error: topupError } =
        await supabase
          .from('wallet_logs')
          .select('amount, created_at')
          .eq('user_id', interaction.user.id)
          .eq('type', '儲值');
      if (topupError) {
        console.error('[ATM 消費資訊] 查詢儲值紀錄失敗', topupError);
      }
      const logs =
        topupLogs || [];
      // 總累積儲值改讀 user_vips，這樣 /調整累積儲值 才會同步顯示
      const totalTopup =
        Number(vipData?.total_topup || 0);
      // 本月累積儲值仍然用 wallet_logs 計算
      const monthTopup =
        logs
          .filter(log => {
            const createdAt =
              new Date(log.created_at);
            return (
              createdAt >= monthStart &&
              createdAt < nextMonthStart
            );
          })
          .reduce(
            (sum, log) => sum + Number(log.amount || 0),
            0
          );
      const { data: monthSpendLogs, error: monthSpendError } =
        await supabase
          .from('wallet_logs')
          .select('type, amount, created_at')
          .eq('user_id', interaction.user.id)
          .lt('amount', 0)
          .gte('created_at', monthStart.toISOString())
          .lt('created_at', nextMonthStart.toISOString());
      if (monthSpendError) {
        console.error('[ATM 消費資訊] 查詢月消費失敗', monthSpendError);
      }
      const monthSpent =
        (monthSpendLogs || [])
          .filter(log =>
            [
              '訂單扣款',
              '商店購買',
              '打賞消費',
              '加時扣款'
            ].includes(log.type)
          )
          .reduce(
            (sum, log) => sum + Math.abs(Number(log.amount || 0)),
            0
          );
      const embed =
        new EmbedBuilder()
          .setColor('#00ffff')
          .setTitle(`${interaction.user.username}｜用戶消費資訊`)
          .setThumbnail(interaction.user.displayAvatarURL())
          .setDescription(
            `**錢包餘額**\n` +
            `${Number(userData.coins || 0).toLocaleString('zh-TW')} ASD\n\n` +
            `**累積消費金額**\n` +
            `${Number(vipData?.total_spent || 0).toLocaleString('zh-TW')} 元\n\n` +
            `**月累積消費金額**\n` +
            `${Number(monthSpent || 0).toLocaleString('zh-TW')} ASD\n\n` +            
            `**累積儲值金額**\n` +
            `${Number(totalTopup || 0).toLocaleString('zh-TW')} ASD\n\n` +
            `**本月累積儲值金額**\n` +
            `${Number(monthTopup || 0).toLocaleString('zh-TW')} ASD`
          );
      return await interaction.editReply({
        embeds: [embed]
      });
    }
    // ===== ATM 轉帳 =====
    if (customId === 'transfer_menu') {
      const menu =
        new UserSelectMenuBuilder()
          .setCustomId('transfer_user_select')
          .setPlaceholder('選擇要轉帳的玩家');

      const row =
        new ActionRowBuilder()
          .addComponents(menu);

      return await interaction.editReply({
        content: '💸 請選擇轉帳對象',
        components: [row]
      });
    }
    if (customId === 'transfer_records') {
      const records =
        await getWalletLogs(interaction.user.id);
      if (!records.length) {
        return await interaction.editReply({
          content: '📜 目前沒有錢包明細'
        });
      }
      const text =
        records.map(record => {
          const time =
            new Date(record.created_at)
              .toLocaleString('zh-TW', {
                hour12: false
              });
          const amountText =
            Number(record.amount) > 0
              ? `+${record.amount}`
              : `${record.amount}`;
          return (
            `📌 ${record.type}\n` +
            `💰 異動：${amountText} 星雨幣\n` +
            `💳 餘額：${record.balance} 星雨幣\n` +
            `🕒 ${time}` +
            `${record.note ? `\n📝 ${record.note}` : ''}`
          );
        }).join('\n\n');
      return await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor('#00ffff')
            .setTitle('📜 錢包明細')
            .setDescription(text.slice(0, 3800))
        ]
      });
    }
    if (customId === 'switch_benefit') {
      const menu =
        new StringSelectMenuBuilder()
          .setCustomId('select_benefit_type')
          .setPlaceholder('請選擇要切換的權益')
          .addOptions([
            {
              label: '特戰英豪',
              description: '切換為特戰英豪相關權益',
              value: '特戰英豪'
            },
            {
              label: '三角洲行動',
              description: '切換為三角洲行動相關權益',
              value: '三角洲行動'
            },
            {
              label: 'PUBG',
              description: '切換為 PUBG 相關權益',
              value: 'PUBG'
            },
            {
              label: 'STEAM',
              description: '切換為 STEAM 遊戲相關權益',
              value: 'STEAM'
            },
            {
              label: '陪聊服務',
              description: '切換為陪聊 / 陪伴服務權益',
              value: '陪聊服務'
            },
            {
              label: '打賞禮物',
              description: '切換為打賞禮物相關權益',
              value: '打賞禮物'
            }
          ]);
      const row =
        new ActionRowBuilder()
          .addComponents(menu);
      return interaction.editReply({
        content:
          '🔄 請選擇你要切換的權益：\n\n' +
          '每日最多可以切換 2 次。',
        components: [row]
      });
    }
    if (customId === 'monthly_info') {
      const { data: account, error } =
        await supabase
          .from('member_monthly_accounts')
          .select('*')
          .eq('user_id', interaction.user.id)
          .maybeSingle();
      if (error) {
        console.error('[查詢月結失敗]', error);
        return interaction.editReply({
          content: '❌ 查詢月結資料失敗，請稍後再試。'
        });
      }
      if (!account) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor('#999999')
              .setTitle('🌙 星雨月結會員')
              .setDescription(
                `你目前尚未開通月結會員。\n\n` +
                `如需開通，請聯繫客服設定保證金與月結額度。`
              )
          ]
        });
      }
      const guaranteeAmount =
        Number(account.guarantee_amount || 0);
      const monthlyLimit =
        Number(account.monthly_limit || 0);
      const usedAmount =
        Number(account.used_amount || 0);
      const availableAmount =
        Math.max(0, monthlyLimit - usedAmount);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(account.enabled ? '#66ccff' : '#999999')
            .setTitle('🌙 星雨月結會員')
            .addFields(
              {
                name: '狀態',
                value: account.enabled ? '✅ 已啟用' : '⛔ 已停用',
                inline: true
              },
              {
                name: '保證金',
                value: `NT$${guaranteeAmount.toLocaleString('zh-TW')}`,
                inline: true
              },
              {
                name: '月結額度',
                value: `NT$${monthlyLimit.toLocaleString('zh-TW')}`,
                inline: true
              },
              {
                name: '已使用',
                value: `NT$${usedAmount.toLocaleString('zh-TW')}`,
                inline: true
              },
              {
                name: '剩餘可用',
                value: `NT$${availableAmount.toLocaleString('zh-TW')}`,
                inline: true
              }
            )
            .setDescription(
              `每月 25 日結帳，繳款期限為次月 16 日。\n` +
              `月結額度僅限平台指定服務使用，不可提領、不可轉讓、不可兌現。`
            )
            .setTimestamp()
        ]
      });
    }
    if (customId === 'my_bag') {
      const rawItems =
        await getUserItems(interaction.user.id);
      const items =
        rawItems.filter(item => {
          const name =
            String(item.item_name || '');
          const desc =
            String(item.description || '');
          return !(
            name.includes('星雨幣') ||
            name.includes('金幣') ||
            name.includes('幣') ||
            desc.includes('星雨幣') ||
            desc.includes('金幣')
          );
        });
      if (!items.length) {
        return await interaction.editReply({
          content: '🎒 你的背包目前是空的'
        });
      }
      function groupItems(list) {
        const map = new Map();
        for (const item of list) {
          const key = [
            item.item_name || '',
            item.rarity || '',
            item.description || '',
            item.item_type || ''
          ].join('||');
          if (!map.has(key)) {
            const newItem =
              Object.assign({}, item, {
                count: 1
              });
            map.set(key, newItem);
          } else {
            const old =
              map.get(key);
            old.count =
              Number(old.count || 1) + 1;
            map.set(key, old);
          }
        }
        return Array.from(map.values());
      }
      const groupedItems =
        groupItems(items);
      const rarityOrder =
        ['SSR', 'SR', 'R'];
      let text = '';
      for (const rarity of rarityOrder) {
        const filtered =
          groupedItems.filter(item => item.rarity === rarity);
        if (!filtered.length) continue;
        text += `\n${getRarityEmoji(rarity)} ${rarity}\n`;
        for (const item of filtered) {
          text += `• ${item.item_name}`;
          if (item.count > 1) {
            text += ` × ${item.count}`;
          }
          text += `\n`;
          if (item.description) {
            text += `└ 📦 ${item.description}\n`;
          }
          if (item.item_type) {
            text += `└ 🏷️ 類型：${item.item_type}\n`;
          }
          text += '\n';
        }
      }
      const couponItems =
        groupedItems.filter(item =>
          item.item_type === 'coupon' ||
          String(item.item_name || '').includes('折券') ||
          String(item.item_name || '').includes('優惠券')
        );
      const normalItems =
        groupedItems.filter(item =>
          !item.rarity &&
          item.item_type !== 'coupon' &&
          !String(item.item_name || '').includes('折券') &&
          !String(item.item_name || '').includes('優惠券')
        );
      if (couponItems.length > 0) {
        text += `\n🎟️ 優惠券\n`;
        for (const item of couponItems) {
          text += `• ${item.item_name}`;
          if (item.count > 1) {
            text += ` × ${item.count}`;
          }
          text += `\n`;
          if (item.description) {
            text += `└ 📦 ${item.description}\n`;
          }
          text += '\n';
        }
      }
      if (normalItems.length > 0) {
        text += `\n🛒 一般商品\n`;
        for (const item of normalItems) {
          text += `• ${item.item_name}`;
          if (item.count > 1) {
            text += ` × ${item.count}`;
          }
          text += `\n`;
          if (item.description) {
            text += `└ 📦 ${item.description}\n`;
          }
          if (item.item_type) {
            text += `└ 🏷️ 類型：${item.item_type}\n`;
          }
          text += '\n';
        }
      }
      return await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor('#ff66cc')
            .setTitle('🎒 我的背包')
            .setDescription(text.slice(0, 3800))
            .setFooter({
              text: '深夜不關燈｜背包查詢'
            })
            .setTimestamp()
        ]
      });
    }
    // ===== 掉落領取 =====
    if (customId.startsWith('claim_')) {
      const reward = parseInt(customId.split('_')[1]);

      if (claimedDrops.has(interaction.message.id)) {
        return await interaction.editReply({
          content: '❌ 已經被領取了'
        });
      }

      claimedDrops.add(interaction.message.id);

      setTimeout(() => {
        claimedDrops.delete(interaction.message.id);
      }, 60000);

      const userData = await getUser(interaction.user.id);

      const finalCoins =
        await changeCoins(interaction.user.id, reward);

      await sendWalletLog(
        interaction.user.id,
        '聊天掉落',
        reward,
        finalCoins,
        '☔ 領取聊天掉落獎勵'
      );

      await interaction.message.edit({
        components: []
      }).catch(() => {});

      return await interaction.editReply({
        content: `☔ 成功領取 ${reward} 星雨幣`
      });
    }

    // ===== 單抽 =====
    if (customId.startsWith('gacha_single_')) {
      const poolId = Number(customId.replace('gacha_single_', ''));
      try {
        const result =
          await performGacha(
            interaction.user.id,
            interaction.guild.id,
            1,
            poolId
          );
        const item = result.results[0];
        await sendWalletLog(
          interaction.user.id,
          '單抽',
          -result.cost + result.totalRewardCoins,
          result.finalCoins,
          `🎰 單抽完成`
        );
        return await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor('#ff66cc')
              .setTitle('🎰 單抽結果')
              .setDescription(
                `${getRarityEmoji(item.rarity)} ${item.rarity}\n` +
                `📦 ${item.name}\n\n` +
                `${item.description || '無介紹'}` +
                `💰 代幣變動：${-result.cost + result.totalRewardCoins}\n` +
                `💳 目前餘額：${result.finalCoins}`
              )
          ]
        });
      } catch (err) {
        return await interaction.editReply({
          content: `❌ ${err.message}`
        });
      }
    }

    // ===== 十抽 =====
    if (customId.startsWith('gacha_ten_')) {
      const poolId = Number(customId.replace('gacha_ten_', ''));
      try {
        const result =
          await performGacha(
            interaction.user.id,
            interaction.guild.id,
            10,
            poolId
          );
        const text =
          result.results
            .slice(0, 10)
            .map(item => `${getRarityEmoji(item.rarity)} ${item.name}`)
            .join('\n');
        await sendWalletLog(
          interaction.user.id,
          '十抽',
          -result.cost + result.totalRewardCoins,
          result.finalCoins,
          `🎰 十抽完成`
        );
        return await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor('#ff66cc')
              .setTitle('🎰 十抽結果')
              .setDescription(
                (
                  text +
                  `\n\n💰 代幣變動：${-result.cost + result.totalRewardCoins}` +
                  `\n💳 目前餘額：${result.finalCoins}`
                ).slice(0, 3800)
              )
          ]
        });
      } catch (err) {
        return await interaction.editReply({
          content: `❌ ${err.message}`
        });
      }
    }

    // ===== 查看獎池 =====
    if (customId === 'gacha_view_pool') {
      const { data: pools, error } =
        await supabase
          .from('gacha_pools')
          .select('*')
      if (error || !pools || pools.length === 0) {
        return await interaction.editReply({
          content: '❌ 目前沒有卡池'
        });
      }
      const menu =
        new StringSelectMenuBuilder()
          .setCustomId('select_gacha_pool')
          .setPlaceholder('請選擇要查看 / 抽取的獎池')
          .addOptions(
            pools.slice(0, 25).map(pool => ({
              label: pool.pool_name.slice(0, 100),
              description: `單抽價格：${pool.price} 星雨幣`,
              value: String(pool.id)
            }))
          );
      const row =
        new ActionRowBuilder()
          .addComponents(menu);
      await sendGachaPanel(client);
      return await interaction.editReply({
        content: '🎰 請選擇獎池',
        components: [row]
      });
    }
    // ===== 使用優惠券 =====
    if (
      customId === 'use_coupon' ||
      customId.startsWith('use_coupon_')
    ) {
      const channelOwnerId =
        interaction.channel.permissionOverwrites.cache
          .find(
            p =>
              p.type === 1 &&
              p.allow.has(
                PermissionFlagsBits.ViewChannel
              )
          )?.id;
      if (interaction.user.id !== channelOwnerId) {
        return await interaction.editReply({
          content: '❌ 只有下單者可以使用優惠券'
        });
      }
      const coupons =
        (await getUserItems(interaction.user.id))
          .filter(item =>
            item.item_type === 'coupon' ||
            item.item_name.includes('折券')
          );
      if (coupons.length === 0) {
        return await interaction.editReply({
          content: '❌ 你沒有優惠券'
        });
      }
      const menu =
        new StringSelectMenuBuilder()
          .setCustomId(`coupon_select_${interaction.channel.id}`)
          .setPlaceholder('請選擇要使用的優惠券')
          .addOptions(
            coupons
              .slice(0, 25)
              .map(c => ({
                label: c.item_name.slice(0, 100),
                description:
                  c.description?.slice(0, 100) ||
                  '使用這張優惠券',
                value: String(c.id)
              }))
          );
      const row =
        new ActionRowBuilder()
          .addComponents(menu);
      return await interaction.editReply({
        content: '🎟️ 請選擇你要使用的優惠券',
        components: [row]
      });
    }
    // ===== 略過優惠券 =====
    if (customId === 'skip_coupon') {
      const channelOwnerId =
        interaction.channel.permissionOverwrites.cache
          .find(
            p =>
              p.type === 1 &&
              p.allow.has(
                PermissionFlagsBits.ViewChannel
              )
          )?.id;
      if (interaction.user.id !== channelOwnerId) {
        return await interaction.editReply({
          content: '❌ 只有下單者可以操作'
        });
      }
      await interaction.channel.send({
        content:
          `❌ ${interaction.user} 選擇不使用優惠券`
      });
      const oldRows =
        interaction.message.components;
      const keepRows =
        oldRows.slice(1);
      await interaction.message.edit({
        components: keepRows
      }).catch(() => {});
      return await interaction.editReply({
        content:
          '✅ 已公開通知：不使用優惠券'
      });
    }
    // ===== 客人確認送出打賞 =====
    if (customId.startsWith('confirm_tip_submit_')) {
      const tipConfirmId = customId.replace('confirm_tip_submit_', '');
      const tipData = pendingTips.get(tipConfirmId);
      if (!tipData) {
        return await interaction.editReply({
          content: '❌ 這筆打賞確認已失效，請重新填寫',
          components: []
        });
      }
      if (interaction.user.id !== tipData.createdBy) {
        return await interaction.editReply({
          content: '❌ 只有填寫這筆打賞的人可以確認送出'
        });
      }
      const {
        tipperId,
        item,
        amount,
        paymentMethod
      } = tipData;
      const selectedStaffIds =
        getTipStaffIds(tipData);
      const selectedStaffText =
        formatTipStaffMentions(selectedStaffIds);
      const totalAmount =
        getTipTotalAmount(amount, selectedStaffIds);

      if (!selectedStaffIds.length) {
        return await interaction.editReply({
          content: '❌ 打賞資料不完整，請重新填寫',
          components: []
        });
      }

      const isWalletPayment =
        paymentMethod.includes("儲值卡") ||
        paymentMethod.includes("儲值") ||
        paymentMethod.includes("錢包") ||
        paymentMethod.includes("餘額");
      const needManualConfirm = !isWalletPayment;
      let deductText = needManualConfirm
        ? "待客服確認付款"
        : "未自動扣款";
      if (isWalletPayment) {
        const { data: userData, error: userError } =
          await supabase
            .from("users")
            .select("*")
            .eq("user_id", tipperId)
            .maybeSingle();
        if (userError) {
          console.error("[打賞扣款讀取使用者失敗]", userError);
          return await interaction.editReply({
            content: "❌ 讀取打賞人錢包失敗"
          });
        }
        if (!userData) {
          return await interaction.editReply({
            content: "❌ 找不到打賞人的錢包資料"
          });
        }
        if ((userData.coins || 0) < totalAmount) {
          return await interaction.editReply({
            content:
              `❌ 打賞人餘額不足\n\n` +
              `需要：${totalAmount} 星雨幣\n` +
              `目前：${userData.coins || 0} 星雨幣`
          });
        }
        const finalCoins =
          await changeCoins(tipperId, -totalAmount);
        await sendWalletLog(
          tipperId,
          "打賞消費",
          -totalAmount,
          finalCoins,
          `💝 打賞給 ${selectedStaffText}｜${item}`
        );
        deductText = `已從 <@${tipperId}> 餘額扣除 ${totalAmount} 星雨幣`;
      }
      const embed = new EmbedBuilder()
        .setColor("#ff99cc")
        .setTitle("💝 打賞需求")
        .addFields(
          {
            name: "打賞人",
            value: `<@${tipperId}>`,
            inline: true,
          },  
          {
            name: "受賞員工",
            value: selectedStaffText,
            inline: true,
          },
          {
            name: "品項",
            value: item,
            inline: true,
          },
          {
            name: "每位金額",
            value: `NT$${amount}`,
            inline: true,
          },
          {
            name: "總金額",
            value: `NT$${totalAmount}`,
            inline: true,
          },
          {
            name: "付款方式",
            value: paymentMethod,
            inline: true,
          },
          {
            name: "扣款狀態",
            value: deductText,
            inline: false,
          }
        )
        .setTimestamp();
      const components = [];
      if (needManualConfirm) {
        const confirmTipButton =
          new ButtonBuilder()
            .setCustomId(`confirm_tip_paid_flow_${tipConfirmId}`)
            .setLabel('✅ 確認打賞付款')
            .setStyle(ButtonStyle.Success);
        const cancelTipButton =
          new ButtonBuilder()
            .setCustomId(`cancel_tip_flow_${tipConfirmId}`)
            .setLabel('❌ 取消打賞')
            .setStyle(ButtonStyle.Danger);
        const row =
          new ActionRowBuilder()
            .addComponents(
              confirmTipButton,
              cancelTipButton
            );
        components.push(row);
      }
      await interaction.channel.send({
        embeds: [embed],
        components
      });
      if (isNoCardPayment(paymentMethod)) {
        await sendNoCardPaymentInfo(interaction.channel);
      } else if (isBankTransfer(paymentMethod)) {
        await sendBankTransferInfo(interaction.channel);
      } else if (isCardPayment(paymentMethod)) {
        await sendCardPaymentInfo(interaction.channel);
      }
      if (isWalletPayment) {
        pendingTips.delete(tipConfirmId);
      }
      if (isWalletPayment) {
        try {
          await saveTipToPlayOrdersForStaff({
              guildId: getGuildId(interaction),
              tipperId,
              staffIds: selectedStaffIds,
              item,
              amount: Number(amount),
              channelId: interaction.channel.id,
              paid: true,
              countReason: '儲值卡打賞付款完成'
            });
          await interaction.channel.send({
            content:
              `✅ 儲值卡打賞已完成，並已寫入薪資網\n` +
              `打賞人：<@${tipperId}>\n` +
              `受賞陪陪：${selectedStaffText}\n` +
              `品項：${item}\n` +
              `每位金額：NT$${amount}\n` +
              `總金額：NT$${totalAmount}`
          });
          await sendTipCloseButtons(interaction.channel);
        } catch (error) {
          console.error('[儲值卡打賞寫入薪資網失敗]', error);
          await interaction.channel.send({
            content:
              `⚠️ 儲值卡已扣款，但寫入薪資網失敗。\n` +
              `錯誤：${error.message || error}`
          });
        }
      }
      return await interaction.editReply({
        content: isWalletPayment
          ? "✅ 已確認打賞，並已完成餘額扣款"
          : "✅ 已確認打賞，已送出給客服確認付款",
        components: []
      });
    }
    // ===== 客人取消送出打賞 ===== 
    if (customId.startsWith('cancel_tip_submit_')) {
      const tipConfirmId = customId.replace('cancel_tip_submit_', '');
      const tipData = pendingTips.get(tipConfirmId);
      if (!tipData) {
        return await interaction.editReply({
          content: '❌ 這筆打賞確認已失效',
          components: []
        });
      } 
      if (interaction.user.id !== tipData.createdBy) {
        return await interaction.editReply({
          content: '❌ 只有填寫這筆打賞的人可以取消'
        });
      }
      pendingTips.delete(tipConfirmId);
      return await interaction.editReply({
        content: '❌ 已取消送出打賞',
        components: []
      });
    }
    if (customId.startsWith('confirm_tip_wallet_')) {
      const tipId =
        customId.replace('confirm_tip_wallet_', '');
      const tipData =
        pendingTips.get(tipId);
      if (!tipData) {
        return await interaction.editReply({
          content: '❌ 這筆打賞流程已過期，請重新建立打賞頻道。'
        });
      }
      if (interaction.user.id !== tipData.tipperId) {
        return await interaction.editReply({
          content: '❌ 只有打賞人可以確認儲值卡付款'
        });
      }
      const {
        tipperId,
        item,
        amount
      } = tipData;
      const selectedStaffIds =
        getTipStaffIds(tipData);
      const selectedStaffText =
        formatTipStaffMentions(selectedStaffIds);
      const totalAmount =
        getTipTotalAmount(amount, selectedStaffIds);

      if (!selectedStaffIds.length) {
        return await interaction.editReply({
          content: '❌ 打賞資料不完整，請重新建立打賞流程。'
        });
      }

      const userData =
        await getUser(tipperId);
      const currentCoins =
        Number(userData.coins || 0);
      if (currentCoins < totalAmount) {
        return await interaction.editReply({
          content:
            `❌ ASD 餘額不足。\n` +
            `目前餘額：${currentCoins} ASD\n` +
            `需要金額：${totalAmount} ASD`
        });
      }
      const finalCoins =
        await changeCoins(tipperId, -totalAmount);
      await sendWalletLog(
        tipperId,
        '打賞消費',
        -totalAmount,
        finalCoins,
        `💝 打賞給 ${selectedStaffText}｜${item}`
      );
      await interaction.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor('#57F287')
            .setTitle('✅ 打賞已使用儲值卡付款')
            .addFields(
              {
                name: '打賞人',
                value: `<@${tipperId}>`,
                inline: true
              },
              {
                name: '受賞陪陪',
                value: selectedStaffText,
                inline: true
              },  
              {
                name: '品項',
                value: item,
                inline: true
              },
              {
                name: '每位金額',
                value: `NT$${amount}`,
                inline: true
              },
              {
                name: '總金額',
                value: `NT$${totalAmount}`,
                inline: true
              },
              {
                name: '扣款後餘額',
                value: `${finalCoins} ASD`,
                inline: true
              }
            )
            .setTimestamp()
        ]
      });
      try {
        await saveTipToPlayOrdersForStaff({
            guildId: getGuildId(interaction),
            tipperId,
            staffIds: selectedStaffIds,
            item,
            amount: Number(amount),
            channelId: interaction.channel.id,
            paid: true,
            countReason: '儲值卡打賞付款完成'
          });
        await interaction.channel.send({
          content:
            `✅ 儲值卡打賞已完成，並已寫入薪資網\n` +
            `打賞人：<@${tipperId}>\n` +
            `受賞陪陪：${selectedStaffText}\n` +
            `品項：${item}\n` +
            `每位金額：NT$${amount}\n` +
            `總金額：NT$${totalAmount}`
        });
      } catch (error) {
        console.error('[儲值卡打賞寫入薪資網失敗]', error);
        await interaction.channel.send({
          content:
            `⚠️ 儲值卡已扣款，但寫入薪資網失敗。\n` +
            `錯誤：${error.message || error}`
        });
      }
      await sendTipCloseButtons(interaction.channel);
      pendingTips.delete(tipId);
      return await interaction.editReply({
        content: '✅ 已確認使用儲值卡完成打賞付款'
      });
    }
    if (customId.startsWith('cancel_tip_wallet_')) {
      const tipId =
        customId.replace('cancel_tip_wallet_', '');
      return await interaction.editReply({
        content: '已取消儲值卡付款，請重新選擇付款方式或聯繫客服。',
        components: []
      });
    }
    // ===== 確認打賞付款 =====
    if (customId.startsWith('confirm_tip_paid_')) {
      if (!isAdminOrStaff(interaction)) {
        return await interaction.editReply({
          content: '❌ 只有客服可以確認打賞付款'
        });
      }

      const flowTipId =
        customId.startsWith('confirm_tip_paid_flow_')
          ? customId.replace('confirm_tip_paid_flow_', '')
          : null;
      const flowTipData =
        flowTipId
          ? pendingTips.get(flowTipId)
          : null;

      if (flowTipId && !flowTipData) {
        return await interaction.editReply({
          content: '❌ 這筆打賞資料已失效，請重新建立打賞流程。'
        });
      }

      let tipperId;
      let staffIds;
      let item;
      let amount;

      if (flowTipData) {
        tipperId = flowTipData.tipperId;
        staffIds = getTipStaffIds(flowTipData);
        item = flowTipData.item;
        amount = flowTipData.amount;
      } else {
        const parts = customId.split('_');
        tipperId = parts[3];
        staffIds = [parts[4]].filter(Boolean);
        item = '打賞';
        amount = parts[5];

        await supabase
          .from('play_orders')
          .update({
            paid: true,
            paid_at: new Date().toISOString(),
            status: 'completed',
            completed_at: new Date().toISOString()
          })
          .eq('customer_id', tipperId)
          .eq('final_price', Number(amount))
          .eq('note', '打賞')
          .order('created_at', { ascending: false })
          .limit(1);
      }

      const staffText =
        formatTipStaffMentions(staffIds);
      const totalAmount =
        getTipTotalAmount(amount, staffIds);

      if (!tipperId || !staffIds.length || !amount) {
        return await interaction.editReply({
          content: '❌ 打賞資料不完整，無法確認付款'
        });
      }

      const oldEmbed = interaction.message.embeds[0];

      const embed =
        EmbedBuilder.from(oldEmbed)
          .setColor('#57F287')
          .setTitle('✅ 打賞已付款');

      const fields =
        oldEmbed.fields
          .filter(field =>
            field.name !== '扣款狀態' &&
            field.name !== '打賞狀態'
          );

      embed.setFields(fields);

      embed.addFields({
        name: '打賞狀態',
        value:
          `✅ 已由 <@${interaction.user.id}> 確認付款\n` +
          `打賞人：<@${tipperId}>\n` +
          `受賞員工：${staffText}\n` +
          `品項：${item}\n` +
          `每位金額：NT$${amount}\n` +
          `總金額：NT$${totalAmount}`,
        inline: false
      });

      await interaction.message.edit({
        embeds: [embed],
        components: []
      });
      // ===== 寫入薪資網 / play_orders =====
      try {
        await saveTipToPlayOrdersForStaff({
            guildId: getGuildId(interaction),
            tipperId,
            staffIds,
            item,
            amount: Number(amount),
            channelId: interaction.channel.id,
            paid: true,
            countReason: '客服確認打賞付款完成'
          });
        await interaction.channel.send({
          content:
            `打賞人：<@${tipperId}>\n` +
            `受賞陪陪：${staffText}\n` +
            `品項：${item}\n` +
            `每位金額：NT$${amount}\n` +
            `總金額：NT$${totalAmount}`
        });
      } catch (error) {
        console.error('[打賞薪資寫入失敗]', error);
        await interaction.channel.send({
          content:
            `⚠️ 打賞已確認付款，但寫入薪資網失敗。\n` +
            `請管理員查看 Railway Logs。\n` +
            `錯誤：${error.message || error}`
        });
      }
      if (flowTipId) {
        pendingTips.delete(flowTipId);
      }
      // ===== 送出關閉頻道 / 儲存紀錄按鈕 =====
      await sendTipCloseButtons(interaction.channel);
      return await interaction.editReply({
        content: '✅ 已確認打賞付款，並已送出關閉頻道選項'
      });
    }

    // ===== 取消打賞 =====
    if (customId.startsWith('cancel_tip_')) {
      if (!isAdminOrStaff(interaction)) {
        return await interaction.editReply({
          content: '❌ 只有客服可以取消打賞'
        });
      }

      const flowTipId =
        customId.startsWith('cancel_tip_flow_')
          ? customId.replace('cancel_tip_flow_', '')
          : null;

      const oldEmbed = interaction.message.embeds[0];

      const embed =
        EmbedBuilder.from(oldEmbed)
          .setColor('#ff4444')
          .setTitle('❌ 打賞已取消');

      const fields =
        oldEmbed.fields
          .filter(field =>
            field.name !== '扣款狀態' &&
            field.name !== '打賞狀態'
          );

      embed.setFields(fields);

      embed.addFields({
        name: '打賞狀態',
        value: `❌ 已由 <@${interaction.user.id}> 取消`,
        inline: false
      });

      await interaction.message.edit({
        embeds: [embed],
        components: []
      });

      if (flowTipId) {
        pendingTips.delete(flowTipId);
      }

      return await interaction.editReply({
        content: '✅ 已取消打賞需求'
      });
    }

    // ===== 客人確認關閉訂單 =====
    if (customId === 'customer_confirm_close_order') {
      const { data: order, error: orderError } =
        await supabase
          .from('play_orders')
          .select('*')
          .eq('channel_id', interaction.channel.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
      if (orderError || !order) {
        console.error('[確認關閉訂單] 找不到訂單', orderError);
        return await interaction.editReply({
          content: '❌ 找不到此頻道對應的訂單'
        });
      }
      const customerId = String(order.customer_id || '').trim();
      if (!customerId) {
        return await interaction.editReply({
          content: '❌ 找不到此訂單的客人'
        });
      }
      const isCustomer =
        interaction.user.id === customerId;
      const isStaff =
        interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
        interaction.member.roles.cache.has(process.env.STAFF_ROLE) ||
        (
          process.env.CUSTOMER_SERVICE_ROLE_ID &&
          interaction.member.roles.cache.has(process.env.CUSTOMER_SERVICE_ROLE_ID)
        );
      if (!isCustomer && !isStaff) {
        return await interaction.editReply({
          content: '❌ 只有建立此訂單的客人或客服可以確認關閉'
        });
      }
      await interaction.message.edit({
        content: `✅ <@${customerId}> 已確認可以關閉訂單。`,
        components: []
      }).catch(() => {});
      const saveButton =
        new ButtonBuilder()
          .setCustomId('save_order_log')
          .setLabel('📁 儲存紀錄')
          .setStyle(ButtonStyle.Success);
      const deleteButton =
        new ButtonBuilder()
          .setCustomId('delete_order_now')
          .setLabel('🗑️ 直接刪除')
          .setStyle(ButtonStyle.Danger);
      const row =
        new ActionRowBuilder()
          .addComponents(saveButton, deleteButton);
      await interaction.channel.send({
        content:
          `<@&${process.env.STAFF_ROLE}> 客人已確認關閉訂單，請選擇是否儲存紀錄。`,
        components: [row]
      });
      return await interaction.editReply({
        content: '✅ 已通知客服處理關閉流程'
      });
    }
    // ===== 客人暫不關閉訂單 =====
    if (customId === 'customer_cancel_close_order') {
      const { data: order, error: orderError } =
        await supabase
          .from('play_orders')
          .select('*')
          .eq('channel_id', interaction.channel.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
      if (orderError || !order) {
        console.error('[暫不關閉訂單] 找不到訂單', orderError);
        return await interaction.editReply({
          content: '❌ 找不到此頻道對應的訂單'
        });
      }
      const customerId = String(order.customer_id || '').trim();
      if (!customerId) {
        return await interaction.editReply({
          content: '❌ 找不到此訂單的客人'
        });
      }
      const isCustomer =
        interaction.user.id === customerId;
      const isStaff =
        interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
        interaction.member.roles.cache.has(process.env.STAFF_ROLE) ||
        (
          process.env.CUSTOMER_SERVICE_ROLE_ID &&
          interaction.member.roles.cache.has(process.env.CUSTOMER_SERVICE_ROLE_ID)
        );
      if (!isCustomer && !isStaff) {
        return await interaction.editReply({
          content: '❌ 只有建立此訂單的客人或客服可以操作'
        });
      }
      await interaction.message.edit({
        content: `❌ <@${customerId}> 選擇暫不關閉訂單。`,
        components: []
      }).catch(() => {});
      await interaction.channel.send({
        content:
          `<@&${process.env.STAFF_ROLE}> 客人選擇暫不關閉訂單，請先不要刪除頻道。`
      });
      return await interaction.editReply({
        content: '✅ 已通知客服暫不關閉'
      });
    }
    // ===== 關閉儲值單 =====
    if (customId === 'close_ticket') {
      if (!isAdminOrStaff(interaction)) {
        return await interaction.editReply({
          content: '❌ 只有客服可以關閉單子'
        });
      }
      const saveButton =
        new ButtonBuilder()
          .setCustomId('save_order_log')
          .setLabel('📁 儲存紀錄')
          .setStyle(ButtonStyle.Success);
      const deleteButton =
        new ButtonBuilder()
          .setCustomId('delete_order_now')
          .setLabel('🗑️ 直接刪除')
          .setStyle(ButtonStyle.Danger);
      const row =
        new ActionRowBuilder()
          .addComponents(saveButton, deleteButton);
      return await interaction.editReply({
        content: '💰 是否儲存儲值紀錄？',
        components: [row]
      });
    }

    // ===== 完成訂單 =====
    if (
      customId === 'complete_order' ||
      customId === 'complete_topup'
    ) {
      if (!isAdminOrStaff(interaction)) {
        return await safeReply(interaction, {
          content: '❌ 只有客服可以操作',
          ephemeral: true
        });
      }
      // ===== 如果是陪玩訂單 =====
      if (customId === 'complete_order') {
        const { data: order } =
          await supabase
            .from('play_orders')
            .select('*')
            .eq(
              'channel_id',
              interaction.channel.id
            )
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (!order) {
          return await safeReply(interaction, {
            content:
              '❌ 找不到這個頻道對應的訂單。\n' +
              '請確認客人是否已完成下單流程，並且訂單有寫入 play_orders。',
            ephemeral: true
          });
        }
        const assignedPlayers =
          String(order.assigned_player || '')
            .split(',')
            .map(id => id.trim())
            .filter(Boolean);
        if (!assignedPlayers.length) {
          return await safeReply(interaction, {
            content:
              '❌ 這張訂單目前還沒有陪玩接單，不能完成訂單。\n' +
              '請先讓陪玩到員工接單區按「接單」。',
            ephemeral: true
          });
        }
        // ===== 完成訂單前付款檢查 =====
        if (!order.paid) {
          return await safeReply(interaction, {
            content:
              '❌ 這張訂單尚未確認付款，不能完成訂單。\n' +
              '請先讓客服按「客服確認已付款」，或確認儲值卡 / 月結是否已成功扣款。',
            ephemeral: true
          });
        }
        // ===== 標記訂單完成 =====
        await supabase
          .from('play_orders')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString()
          })
          .eq('id', order.id);
        // ===== 多位陪陪薪資平分 =====
        const playerCount =
          assignedPlayers.length || 1;
        const totalPrice =
          Number(order.final_price || order.price || 0);
        const splitAmount =
          Math.floor(totalPrice / playerCount);
    // ===== 寫入薪資紀錄：多位陪陪平分 =====
    if (assignedPlayers.length > 0 && totalPrice > 0) {
      const finishedAt =
        new Date().toISOString();
      for (const playerId of assignedPlayers) {
        const player =
          await getStaffByDiscordId(playerId);
        const commission =
          await getDeepNightCommissionInfo(playerId, finishedAt);
        const salaryAmount =
          Math.round(splitAmount * (commission.rate / 100));
        // 舊 salary_orders 若你還有其他地方用，這裡也同步寫正確抽成
        await supabase
          .from('salary_orders')
          .insert({
            order_id: order.id,
            order_no: order.order_no,
            player_id: playerId,
            customer_id: order.customer_id,
            service: order.service || order.order_item || '陪玩訂單',
            total_amount: splitAmount,
            salary_amount: salaryAmount,
            status: 'unpaid'
          });
        await saveDeepNightSalaryOrder({
          orderId: order.id,
          orderNo: order.order_no,
          discordId: playerId,
          staffName:
            player?.display_name ||
            player?.real_name ||
            player?.discord_name ||
            player?.name ||
            null,
          customerName:
            order.customer_name ||
            order.customer_username ||
            `<@${order.customer_id}>`,
          serviceName:
            order.service ||
            order.order_item ||
            '陪玩訂單',
          orderAmount: splitAmount,
          bonusAmount: 0,
          finishedAt
        });
      }
    }
      await interaction.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor('#ffcc00')
            .setTitle('🏁 訂單已完成')
            .setDescription(
              `訂單編號：${order.order_no || order.id}\n` +
              `陪玩：${assignedPlayers.map(id => `<@${id}>`).join('、') || '未指定'}\n` +
              `服務：${order.service || order.order_item || '未填寫'}\n` +
              `商品金額：NT$${totalPrice.toLocaleString('zh-TW')}\n` +
              `每位分攤金額：NT$${splitAmount.toLocaleString('zh-TW')}`
            )
            .setTimestamp()
        ]
      });
      await sendOrderReviewPanel(
        interaction.channel,
        order,
        assignedPlayers
      );
      // ===== 完成訂單後，先詢問客人是否關閉 =====
      const confirmCloseButton =
        new ButtonBuilder()
          .setCustomId('customer_confirm_close_order')
          .setLabel('✅ 確認關閉訂單')
          .setStyle(ButtonStyle.Success);
      const cancelCloseButton =
        new ButtonBuilder()
          .setCustomId('customer_cancel_close_order')
          .setLabel('❌ 暫不關閉')
          .setStyle(ButtonStyle.Secondary);
      const row =
        new ActionRowBuilder()
          .addComponents(
            confirmCloseButton,
            cancelCloseButton
          );
      let closeTargetId = null;
      // 如果是陪玩訂單，從 play_orders 找客人
      if (customId === 'complete_order') {
        const { data: closeOrder } =
          await supabase
            .from('play_orders')
            .select('customer_id')
            .eq('channel_id', interaction.channel.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        closeTargetId = closeOrder?.customer_id || null;
      }
      // 如果找不到，從頻道權限找客人
      if (!closeTargetId) {
        const ownerOverwrite =
          interaction.channel.permissionOverwrites.cache.find(p =>
            p.id !== interaction.guild.id &&
            p.id !== process.env.STAFF_ROLE &&
            p.id !== client.user.id &&
            !interaction.guild.roles.cache.has(p.id) &&
            p.allow.has(PermissionFlagsBits.ViewChannel)
          );
        closeTargetId = ownerOverwrite?.id || null;
      }
      await interaction.channel.send({
        content:
         closeTargetId
            ? `📦 <@${closeTargetId}> 訂單已完成，請確認是否可以關閉此訂單頻道。`
            : `📦 訂單已完成，請客人確認是否可以關閉此訂單頻道。`,
        components: [row]
      });
      return await safeReply(interaction, {
        content: '✅ 已送出關閉確認給客人',
        ephemeral: true
      });
     }
    }
    // ===== 直接刪除訂單頻道 =====
    if (customId === 'delete_order_now') {
      if (!isAdminOrStaff(interaction)) {
        return await interaction.editReply({
          content: '❌ 只有客服或管理員可以刪除紀錄'
        });
      }
      await interaction.editReply({
        content: '🗑️ 頻道將在 3 秒後刪除'
      });
      setTimeout(async () => {
        try {
          await interaction.channel.delete();
        } catch (err) {
          console.error('[直接刪除頻道失敗]', err);
        }
      }, 3000);
      return;
    }
    // ===== 儲存訂單紀錄 =====
    if (customId === 'save_order_log') {
      if (!isAdminOrStaff(interaction)) {
        return await interaction.editReply({
          content: '❌ 只有客服或管理員可以儲存紀錄'
        });
      }
      try {
        const messages =
          await interaction.channel.messages.fetch({
            limit: 100
          });

        const sorted =
          [...messages.values()]
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        let html = `
<html>
<head>
<meta charset="UTF-8">
<style>
body{
  background:#2b2d31;
  color:white;
  font-family:sans-serif;
  padding:20px;
}
.message{
  background:#1e1f22;
  padding:10px;
  border-radius:10px;
  margin-bottom:10px;
}
</style>
</head>
<body>
`;

        for (const msg of sorted) {
          const content =
            (msg.content || '(無內容)')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;');

          html += `
<div class="message">
<b>${msg.author.tag}</b><br>
${content || '(無內容)'}
</div>
`;
        }

        html += '</body></html>';

        const fileName =
          `order-${interaction.channel.id}-${Date.now()}.html`;

        fs.writeFileSync(`./${fileName}`, html);

        const isTopup =
          interaction.channel.name.includes('儲值-');

        const logChannelId =
          isTopup
            ? process.env.TOPUP_LOG_CHANNEL
            : process.env.ORDER_LOG_CHANNEL;

        const logChannel =
          interaction.guild.channels.cache.get(logChannelId);

        if (!logChannel) {
          return await interaction.editReply({
            content: '❌ 找不到紀錄頻道'
          });
        }

        await logChannel.send({
          content: `📁 ${interaction.channel.name} 訂單紀錄`,
          files: [`./${fileName}`]
        });

        fs.unlinkSync(`./${fileName}`);

        await interaction.editReply({
          content: '✅ 已儲存紀錄\n10 秒後刪除頻道'
        });

        setTimeout(async () => {
          try {
            await interaction.channel.delete();
          } catch (err) {
            console.error('[刪除頻道失敗]', err);
          }
        }, 10000);

        return;
      } catch (err) {
        console.error(err);

        return await interaction.editReply({
          content: '❌ 儲存失敗'
        });
      }
    }

  } catch (error) {
    console.error('[按鈕錯誤]', error);

    return await interaction.editReply({
      content: '❌ 按鈕執行失敗'
    }).catch(() => {});
  }
}
// ===== 完整字符串選單交互處理 =====
async function handleStringSelectInteraction(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({
        flags: 64
      });
    }
    const customId = interaction.customId;
    const value = interaction.values[0];
    // ===== 月結繳費方式選擇 =====
    if (customId.startsWith('monthly_bill_payment_method_')) {
      const billId =
        customId.replace('monthly_bill_payment_method_', '');
      const { data: bill, error } =
        await supabase
          .from('member_monthly_bills')
          .select('*')
          .eq('id', billId)
          .maybeSingle();
      if (error || !bill) {
        return interaction.editReply({
          content: '❌ 找不到月結帳單',
          components: []
        });
      }
      if (bill.user_id !== interaction.user.id) {
        return interaction.editReply({
          content: '❌ 只有帳單本人可以操作這張月結帳單',
          components: []
        });
      }
      if (bill.status === 'paid') {
        return interaction.editReply({
          content: '✅ 這張帳單已經繳清',
          components: []
        });
      }
      if (value === 'wallet') {
        const confirmRow =
          new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder()
                .setCustomId(`monthly_bill_wallet_confirm_${bill.id}`)
                .setLabel('✅ 確認使用儲值卡繳費')
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(`monthly_bill_wallet_cancel_${bill.id}`)
                .setLabel('取消')
                .setStyle(ButtonStyle.Secondary)
            );
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor('#57F287')
              .setTitle('🌙 確認月結儲值卡繳費')
              .setDescription(
                `結帳月份：${bill.billing_month}\n` +
                `扣款金額：NT$${Number(bill.total_amount || 0).toLocaleString('zh-TW')}\n` +
                `待發回饋：${Number(bill.cashback_amount || 0).toLocaleString('zh-TW')} ASD\n\n` +
                `確認後會直接扣除你的 ASD 餘額，並恢復月結額度。`
              )
              .setTimestamp()
          ],
          components: [confirmRow]
        });
      }
      if (value === 'manual') {
        const payChannel =
          await createMonthlyBillPaymentChannel(interaction, bill);
        return interaction.editReply({
          content:
            `✅ 已建立月結繳費頻道：<#${payChannel.id}>\n` +
            `請到該頻道選擇付款方式並上傳付款明細。`,
          components: []
        });
      }
    }
    // ===== 月結臨時頻道付款方式 =====
    if (customId.startsWith('monthly_bill_manual_method_')) {
      const billId =
        customId.replace('monthly_bill_manual_method_', '');
      const { data: bill, error } =
        await supabase  
          .from('member_monthly_bills')
          .select('*')
          .eq('id', billId)
          .maybeSingle();
      if (error || !bill) {
        return interaction.editReply({
          content: '❌ 找不到月結帳單'
        });
      }
      if (bill.user_id !== interaction.user.id) {
        return interaction.editReply({
          content: '❌ 只有帳單本人可以選擇付款方式'
        });
      }
      const paymentMethod =
        value;
      await interaction.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor('#ffd166')
            .setTitle('🌙 月結付款方式已選擇')
            .setDescription(
              `會員：<@${bill.user_id}>\n` +
              `結帳月份：${bill.billing_month}\n` +
              `帳單金額：NT$${Number(bill.total_amount || 0).toLocaleString('zh-TW')}\n` +
              `付款方式：${paymentMethod}\n\n` +
              `請完成付款後，在此頻道上傳付款明細 / 截圖，等待客服確認。`
            )
            .setTimestamp()
        ]
      });
      if (isCardPayment(paymentMethod)) {
        await sendCardPaymentInfo(interaction.channel);
      } else if (isNoCardPayment(paymentMethod)) {
        await sendNoCardPaymentInfo(interaction.channel);
      } else if (isBankTransfer(paymentMethod)) {
        await sendBankTransferInfo(interaction.channel);
      } else if (
        paymentMethod.includes('虛擬貨幣') ||
        paymentMethod.includes('加密貨幣')
      ) {
        await interaction.channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor('#ffaa00')
              .setTitle('💳 虛擬貨幣付款')
              .setDescription(
                `<@${bill.user_id}> 你選擇了：${paymentMethod}\n\n` +
                `請等待客服提供錢包地址。\n` +
                `付款完成後請上傳轉帳明細，等待客服確認。`
              )
              .setTimestamp()
         ]
        });
      }
      const confirmRow =
        new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId(`monthly_bill_confirm_paid_${bill.id}`)
              .setLabel('✅ 客服確認已繳費')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId('delete_order_now')
              .setLabel('🗑️ 關閉頻道')
              .setStyle(ButtonStyle.Danger)
          );
      await interaction.channel.send({
        content:
          `<@&${process.env.STAFF_ROLE}> 請確認付款明細無誤後，按下「客服確認已繳費」。`,
        components: [confirmRow]
      });
      return interaction.editReply({
        content: `✅ 已選擇月結付款方式：${paymentMethod}`
      });
    }
    if (customId.startsWith('tip_gift_')) {
      await handleTipGiftSelect(interaction);
      return;
    }
    if (customId.startsWith('tip_staff_')) {
      await handleTipStaffSelect(interaction);
      return;
    }
    if (customId.startsWith('tip_payment_')) {
      await handleTipPaymentSelect(interaction);
      return;
    }
    if (!value) {
      return await safeEditReply(interaction, {
        content: '❌ 選擇無效',
        ephemeral: true
      });
    }
    if (customId === 'select_benefit_type') {
      const today = getTodayDateString();
      const { data: oldBenefit, error: oldError } =
        await supabase
          .from('user_benefits')
          .select('*')
          .eq('user_id', interaction.user.id)
          .maybeSingle();
      if (oldError) {
        console.error('[切換權益] 查詢失敗', oldError);
        return interaction.editReply({
          content: '❌ 查詢權益資料失敗，請稍後再試。',
          components: []
        });
      }
      let switchCount = 0;
      if (oldBenefit?.switch_date === today) {
        switchCount = Number(oldBenefit.switch_count || 0);
      }
      if (switchCount >= 2) {
        return interaction.editReply({
          content:
            '❌ 你今天已經切換 2 次權益了。\n' +
            '請明天再切換。',
          components: []
        });
      }
      const { error } =
        await supabase
          .from('user_benefits')
          .upsert({
            user_id: interaction.user.id,
            benefit_type: value,
            switch_date: today,
            switch_count: switchCount + 1,
            updated_at: new Date().toISOString()
          }, {
            onConflict: 'user_id'
          });
      if (error) {
        console.error('[切換權益] 儲存失敗', error);
        return interaction.editReply({
          content: '❌ 切換權益失敗，請稍後再試。',
          components: []
        });
      }
      return interaction.editReply({
        content:
          `✅ 已切換權益為：${value}\n` +
          `今日剩餘切換次數：${2 - (switchCount + 1)} 次`,
        components: []
      });
    }
    // ===== 訂單系統 =====
    if (customId === 'order_system_select') {
      try {
        console.log('[ORDER CONFIG]', {
          ORDER_CATEGORY:
            process.env.ORDER_CATEGORY,
          STAFF_ROLE:
            process.env.STAFF_ROLE
        });
        const ticketNumber = Date.now();
        const safeName =
          interaction.user.username
            .replace(/[^a-zA-Z0-9\u4e00-\u9fa5-_]/g, '')
            .slice(0, 10);
        const channelPrefix =
          value === 'topup'
            ? '儲值'
            : value === 'tip'
              ? '打賞'
              : '訂單';
        const channelName =
          `${channelPrefix}-${safeName}-${ticketNumber}`;
        const orderChannel =
          await interaction.guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: process.env.ORDER_CATEGORY,
            topic: `owner:${interaction.user.id}`,
            permissionOverwrites: [
              {
                id: interaction.guild.roles.everyone,
                deny: [PermissionFlagsBits.ViewChannel]
              },
              {
                id: interaction.user.id,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ReadMessageHistory
                ]
              },
              {
                id: process.env.STAFF_ROLE,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ReadMessageHistory
                ]
              },
              {
                id: client.user.id,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ReadMessageHistory,
                  PermissionFlagsBits.ManageChannels
                ]
              }
            ]
          });
        // ===== 點單 =====
        if (value === 'order') {
          const completeButton =
            new ButtonBuilder()
              .setCustomId('complete_order')
              .setLabel('✅ 完成訂單（由客服關）')
              .setStyle(ButtonStyle.Primary);
          const cancelButton =
            new ButtonBuilder()
              .setCustomId('owner_cancel_ticket')
              .setLabel('我按錯了，關閉頻道')
              .setEmoji('🗑️')
              .setStyle(ButtonStyle.Danger);
          const row2 =
            new ActionRowBuilder()
              .addComponents(
                completeButton,
                cancelButton
              );
          const embed =
            new EmbedBuilder()
              .setColor('#ff66cc')
              .setTitle('🛒 訂單建立成功')
              .setDescription(
                '請依照上方選單一步一步完成需求填寫。\n' +
                '填寫完成後，客服會協助報價。'
              );
          try {
            await dispatchSystem.startNewOrderFlow(
              orderChannel,
              interaction.user
            );
          } catch (err) {
            console.error('[新下單流程錯誤]', err);
          }
          await orderChannel.send({
            content:
              `<@&${process.env.STAFF_ROLE}> ${interaction.user}\n🚀 客服人員正手刀衝刺過來啦！`,
            embeds: [embed],
            components: [row2]
          });
        }
        if (value === 'tip') {
          const tipId =
            `${interaction.user.id}_${Date.now()}`;
          pendingTips.set(tipId, {
            createdBy: interaction.user.id,
            tipperId: interaction.user.id,
            channelId: orderChannel.id
          });
          setTimeout(() => {
            const currentTip =
              pendingTips.get(tipId);
            if (currentTip?.keepForPayment) return;

            pendingTips.delete(tipId);
          }, 30 * 60 * 1000);
          await sendTipGiftSelect(orderChannel, tipId);
          return await interaction.editReply({
            content:
              `✅ 已建立打賞臨時頻道：<#${orderChannel.id}>\n` +
              `請到頻道內選擇要打賞的禮物。`
          });
        }
        // ===== 儲值 =====
        if (value === 'topup') {
          const embed =
            new EmbedBuilder()
              .setColor('#ffd166')
              .setTitle('💰 儲值系統')
              .setDescription(
                '請點擊下方按鈕填寫儲值資料'
              );
          const row =
            new ActionRowBuilder()
              .addComponents(
                new ButtonBuilder()
                  .setCustomId('open_topup_modal')
                  .setLabel('填寫儲值資料')
                  .setEmoji('💳')
                  .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                  .setCustomId('owner_cancel_ticket')
                  .setLabel('我按錯了，關閉頻道')
                  .setEmoji('🗑️')
                  .setStyle(ButtonStyle.Danger)
              );
          await orderChannel.send({
            content:
              `<@&${process.env.STAFF_ROLE}> ${interaction.user}`,
            embeds: [embed],
            components: [row]
          });
        }
        await sendOrderSystem(client);
        return await interaction.editReply({
          content:
            `✅ 已建立臨時頻道：<#${orderChannel.id}>\n請點擊進入完成下單。`,
        });
      } catch (err) {
        console.error(
          '[訂單系統選單錯誤]',
          err
        );
        if (
          interaction.deferred ||
          interaction.replied
        ) {
          await interaction.editReply({
            content:
              '❌ 建立訂單/儲值頻道失敗'
          }).catch(() => {});
        } else {
          await interaction.reply({
            content:
              '❌ 建立訂單/儲值頻道失敗',
            flags: 64
          }).catch(() => {});
        }
      }
      return;
    }
    // ===== 商店選單 =====
    if (customId === 'shop_select') {
      try {
        const itemId =
          Number(interaction.values[0]);
        const items =
          await getShopItems() || [];
        const item =
          items.find(
            i => Number(i.id) === itemId
          );
        if (!item) {
          return await interaction.editReply({
            content: '❌ 商品不存在',
          });
        }
        const userData =
          await getUser(interaction.user.id);
        if (userData.coins < item.price) {
          return await interaction.editReply({
            content: '❌ 星雨幣不足',
          });
        }
        const itemType =
          item.item_type === 'coupon'
            ? 'coupon'
            : 'shop';
        await addUserItem(
          interaction.user.id,
          item.item_name,
          null,
          item.description,
          itemType
        );
        const finalCoins =
          await changeCoins(interaction.user.id, -item.price);
        await supabase
          .from('users')
          .update({
            total_spent: (userData.total_spent || 0) + item.price,
            month_spent: (userData.month_spent || 0) + item.price
          })
          .eq('user_id', interaction.user.id);
        await giveMonthlyVip(
          interaction,
          interaction.user.id,
          item.item_name
        );
        await sendWalletLog(
          interaction.user.id,
          '商店購買',
          -item.price,
          finalCoins,
          `🛒 購買商品：${item.item_name}`
        );
        await refreshShop(client);
        return await interaction.editReply({
          content:
            `✅ 購買成功：${item.item_name} (${itemType})`,
        });
      } catch (err) {
        console.error(
          '[商店購買錯誤]',
          err
        );
        return await interaction.editReply({
          content: '❌ 購買失敗',
        });
      }
    }
    if (customId === 'select_gacha_pool') {
      const poolId = Number(interaction.values[0]);
      const { data: pool, error } =
        await supabase
          .from('gacha_pools')
          .select('*')
          .eq('id', poolId)
          .single();
      if (error || !pool) {
        return await interaction.editReply({
          content: '❌ 找不到這個獎池'
        });
      }
      const { data: rewards } =
        await supabase
          .from('gacha_rewards')
          .select('*')
          .eq('pool_id', poolId);
      let text = '';
      if (!rewards || rewards.length === 0) {
        text = '❌ 這個獎池目前沒有獎勵';
      } else {
        text =
          rewards
            .map(r =>
              `${getRarityEmoji(r.rarity)} ${r.rarity}｜${r.reward_name}｜機率 ${r.chance}`
            )
            .join('\n');
      }
      const singleButton =
        new ButtonBuilder()
          .setCustomId(`gacha_single_${poolId}`)
          .setLabel('🎰 單抽')
          .setStyle(ButtonStyle.Primary);
      const tenButton =
        new ButtonBuilder()
          .setCustomId(`gacha_ten_${poolId}`)
          .setLabel('🎰 十抽')
          .setStyle(ButtonStyle.Success);
      const row =
        new ActionRowBuilder()
          .addComponents(singleButton, tenButton);
      return await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor('#ff66cc')
            .setTitle(`🎰 ${pool.pool_name}`)
            .setDescription(
              `💰 單抽價格：${pool.price} 星雨幣\n\n${text}`.slice(0, 3800)
            )
        ],
        components: [row]
      });
    }
    // ===== 使用優惠券 =====
    if (customId.startsWith('coupon_select_')) {
        try {
            
            const itemId =
                Number(interaction.values[0]);
            const orderChannelId =
                interaction.customId.replace(
                    'coupon_select_',
                    ''
                );
            const items =
              await getUserItems(interaction.user.id)
            const coupon =
                items.find(
                    item =>
                        item.id === itemId &&
                        (
                            item.item_type === 'coupon' ||
                            item.item_name.includes('折券')
                        )
                );
            if (!coupon) {
                return await interaction.editReply({
                    content: '❌ 找不到優惠券'
                });
            }
            const { data: order } =
                await supabase
                    .from('play_orders')
                    .select('*')
                    .eq('channel_id', orderChannelId)
                    .single();

            if (!order) {
                return await interaction.editReply({
                    content: '❌ 找不到對應訂單'
                });
            }

            let discountAmount = 0;
            let finalPrice = order.price;

            if (coupon.item_name.includes('95折')) {
                if (order.price > 500) {
                    return await interaction.editReply({
                        content: '❌ 這張優惠券只能用於 500 元內商品'
                    });
                }

                finalPrice = Math.floor(order.price * 0.95);
                discountAmount = order.price - finalPrice;
            }

            else if (coupon.item_name.includes('9折')) {
                if (order.price > 800) {
                    return await interaction.editReply({
                        content: '❌ 這張優惠券只能用於 800 元內商品'
                    });
                }

                finalPrice = Math.floor(order.price * 0.9);
                discountAmount = order.price - finalPrice;
            }

            else if (
                coupon.item_name.includes('8折券∞') ||
                coupon.item_name.includes('8折券 ∞')
            ) {
                finalPrice = Math.floor(order.price * 0.8);
                discountAmount = order.price - finalPrice;
            }

            else if (coupon.item_name.includes('8折')) {
                if (order.price > 3000) {
                    return await interaction.editReply({
                        content: '❌ 這張優惠券只能用於 3000 元內商品'
                    });
                }

                finalPrice = Math.floor(order.price * 0.8);
                discountAmount = order.price - finalPrice;
            }
            const { error: updateError } =
              await supabase
                .from('play_orders')
                .update({
                  coupon_name: coupon.item_name,
                  discount_amount: discountAmount,
                  final_price: finalPrice
                })
                .eq('id', order.id);
            if (updateError) {
              console.error('[優惠券更新訂單失敗]', updateError);
              return await interaction.editReply({
                content:
                  `❌ 優惠券更新訂單失敗\n` +
                  `錯誤：${updateError.message}`
              });
            }
            // ===== 嘗試寫入優惠券使用紀錄，但失敗不阻擋流程 =====
            const { error: usedError } =
              await supabase
                .from('used_coupons')
                .insert({
                  user_id: interaction.user.id,
                  item_name: coupon.item_name,
                  item_id: coupon.id,
                  order_id: order.id
                });
            if (usedError) {
              console.error('[優惠券紀錄寫入失敗，但不阻擋使用]', usedError);
            }
            // ===== 只刪除一次優惠券 =====
            try {
              await removeUserItem(coupon.id);
            } catch (deleteError) {
              console.error('[優惠券刪除失敗]', deleteError);
              return await interaction.editReply({
                content:
                  `❌ 優惠券折扣已套用，但刪除失敗\n` +
                  `請通知客服手動處理`
              });
            }
// ===== 公開通知 =====
await interaction.channel.send({
  content:
    `🎟️ ${interaction.user} 使用了優惠券：${coupon.item_name}\n` +
    `折扣金額：NT$${discountAmount}\n` +
    `實收金額：NT$${finalPrice}`
});

return await interaction.editReply({
  content:
    `✅ 已成功使用優惠券：${coupon.item_name}\n` +
    `折扣金額：NT$${discountAmount}\n` +
    `實收金額：NT$${finalPrice}`
});
        } catch (err) {
            console.error(
                '[優惠券使用錯誤]',
                err
            );
            return await safeEditReply(interaction, {
                content: '❌ 使用優惠券失敗',
                ephemeral: true
            });
        }
    }
  } catch (err) {
    console.error(
      '[字符串選擇菜單錯誤]',
      err
    );
    await handleError(interaction);
  }
}
// ===== User Select =====
async function handleUserSelectSubmit(interaction) {

  try {

    if (
      interaction.customId ===
      'transfer_user_select'
    ) {

      const targetId =
        interaction.values[0];

      // ⚠️ UserSelect 不要 reply
      // 因為等等要 showModal

      if (targetId === interaction.user.id) {
        return await interaction.reply({
          content: '❌ 不能轉給自己',
          flags: 64
        });
      }

      const modal =
        new ModalBuilder()
          .setCustomId(
            `transfer_modal_${targetId}`
          )
          .setTitle('💸 玩家轉帳');

      const amountInput =
        new TextInputBuilder()
          .setCustomId('transfer_amount')
          .setLabel('輸入轉帳金額')
          .setStyle(
            TextInputStyle.Short
          )
          .setRequired(true)
          .setPlaceholder('例如：100');

      const row =
        new ActionRowBuilder()
          .addComponents(amountInput);

      modal.addComponents(row);

      // ⚠️ showModal 前不能 defer/reply
      return await interaction.showModal(modal);
    }

  } catch (err) {

    console.error(
      '[User Select 錯誤]',
      err
    );

    try {

      if (
        interaction.replied ||
        interaction.deferred
      ) {

        await interaction.editReply({
          content: '❌ 系統錯誤'
        });

      } else {

        await interaction.reply({
          content: '❌ 系統錯誤',
          flags: 64
        });
      }

    } catch {}
  }
}

async function handleModalSubmit(interaction) {
  try {
    if (interaction.customId.startsWith("tip_modal_")) {
      const tipDraftId = interaction.customId.replace("tip_modal_", "");
      const tipDraftData =
        pendingTips.get(tipDraftId);
      const selectedStaffIds =
        tipDraftData
          ? getTipStaffIds(tipDraftData)
          : [tipDraftId].filter(Boolean);
      const selectedStaffText =
        formatTipStaffMentions(selectedStaffIds);

      if (!selectedStaffIds.length) {
        return interaction.reply({
          content: "❌ 找不到受賞員工，請重新選擇。",
          flags: 64,
        });
      }

      const item = interaction.fields.getTextInputValue("item");
      const amountText = interaction.fields.getTextInputValue("amount");
      const paymentMethod = interaction.fields.getTextInputValue("tip_payment_method");
      const amount = parseInt(
        amountText.replace(/[^\d]/g, ""),
        10
      );
      if (!amount || amount <= 0) {
        return interaction.reply({
          content: "❌ 金額格式錯誤，請輸入數字。",
          flags: 64,
        });
      }
      const { data: orderData, error: orderError } =
        await supabase
          .from("play_orders")
          .select("customer_id")
          .eq("channel_id", interaction.channel.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
      if (orderError) {
        console.error("[打賞讀取訂單客人失敗]", orderError);
        return interaction.reply({
          content: "❌ 讀取訂單客人失敗，無法判斷打賞人。",
          flags: 64,
        });
      }
      let tipperId = orderData?.customer_id;
      // ===== 優先從頻道 topic 找建立者 =====
      if (!tipperId && interaction.channel.topic) {
        const match =
          interaction.channel.topic.match(/owner:(\d+)/);
        if (match) {
          tipperId = match[1];
        }
      }
      // ===== 舊頻道沒有 topic，才從權限覆蓋找 =====
      if (!tipperId) {
        const ownerOverwrite =
          interaction.channel.permissionOverwrites.cache.find(p => {
            const isRole =
              interaction.guild.roles.cache.has(p.id);
            const isBot =
              p.id === client.user.id;
            const isStaff =
              p.id === process.env.STAFF_ROLE;
            const canView =
              p.allow.has(PermissionFlagsBits.ViewChannel);
            return !isRole && !isBot && !isStaff && canView;
          });
        tipperId = ownerOverwrite?.id;
      }
      if (!tipperId) {
        return interaction.reply({
          content:
            "❌ 找不到這個臨時頻道的建立者，請重新開單後再填寫打賞。",
          flags: 64,
        });
      }
      const tipConfirmId = `${Date.now()}_${interaction.user.id}`;
      pendingTips.set(tipConfirmId, {
        channelId: interaction.channel.id,
        guildId: interaction.guild.id,
        tipperId,
        selectedStaffId: selectedStaffIds[0],
        selectedStaffIds,
        item,
        amount,
        paymentMethod,
        createdBy: interaction.user.id,
        createdAt: Date.now()
      });
      if (tipDraftData) {
        pendingTips.delete(tipDraftId);
      }
      const confirmButton =
        new ButtonBuilder()
          .setCustomId(`confirm_tip_submit_${tipConfirmId}`)
          .setLabel("✅ 確認打賞")
          .setStyle(ButtonStyle.Success);
      const cancelButton =
        new ButtonBuilder()
          .setCustomId(`cancel_tip_submit_${tipConfirmId}`)
          .setLabel("❌ 取消")
          .setStyle(ButtonStyle.Danger);
      const row =
        new ActionRowBuilder()
          .addComponents(confirmButton, cancelButton);
      const totalAmount =
        getTipTotalAmount(amount, selectedStaffIds);
      return interaction.reply({
        content:
          `請確認是否送出這筆打賞：\n\n` +
          `打賞人：<@${tipperId}>\n` +
          `受賞員工：${selectedStaffText}\n` +
          `品項：${item}\n` +
          `每位金額：NT$${amount}\n` +
          `總金額：NT$${totalAmount}\n` +
          `付款方式：${paymentMethod}`,
        components: [row],
        flags: 64
      });
    }
    if (interaction.customId.startsWith('transfer_modal_')) {
      await interaction.deferReply({ flags: 64 });
      const targetId =
        interaction.customId.replace(
          'transfer_modal_',
          ''
        );

      const raw =
        interaction.fields.getTextInputValue(
          'transfer_amount'
        );

      if (!/^\d+$/.test(raw)) {
        return await interaction.editReply({
          content: '❌ 請輸入正確金額'
        });
      }

      const amount = Number(raw);
      if (
        isNaN(amount) ||
        amount <= 0 ||
        amount > 10000
      ) {
        return await interaction.editReply({
          content: '❌ 金額錯誤'
        });
      }

      try {
        await safeTransfer(
          interaction.user.id,
          targetId,
          amount
        );

        return await interaction.editReply({
          content: `✅ 成功轉帳 ${amount} 星雨幣`
        });
      } catch (error) {
        return await interaction.editReply({
          content: `❌ ${error.message}`
        });
      }
    }
  } catch (error) {
    console.error('[模態表單提交錯誤]', error);
    return await replyError(interaction, error.message);
  }
}
// ===== 通用錯誤處理 =====
async function handleError(interaction) {
  try {
    if (interaction.isRepliable()) {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: '❌ 系統錯誤',
          flags: 64
        }).catch(() => {});
      } else {
        await interaction.reply({
          content: '❌ 系統錯誤',
          flags: 64
        }).catch(() => {});
      }
    }
  } catch (error) {
    console.error('[錯誤處理失敗]', error);
  }
}
// ===== 聊天掉落 =====
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  // ===== 深夜薪資報告測試 =====
  if (message.content === "!深夜薪資報告測試") {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      await message.reply("❌ 你沒有權限使用這個測試指令。");
      return;
    }
    await message.reply("⏳ 正在發送深夜每日薪資報告測試...");
    await sendDeepNightDailySalaryReports(client, supabase);
    await message.reply("✅ 深夜每日薪資報告測試完成。");
    return;
  }
  const channelId = message.channel.id;
  if (dropCooldown.has(channelId)) return;
  const random = Math.floor(Math.random() * 100);
  // 訊息少於 5 字不掉落
  if (message.content.replace(/\s/g, '').length < 5) return;  
  // 0.5% 掉落機率
  if (random >= 0.5) return;
  const reward = Math.floor(Math.random() * 20) + 1;
  const button = new ButtonBuilder()
    .setCustomId(`claim_${reward}`)
    .setLabel('☔ 領取星雨幣')
    .setStyle(ButtonStyle.Success);
  const row = new ActionRowBuilder().addComponents(button);
  const embed = new EmbedBuilder()
    .setColor('#57F287')
    .setTitle('☔ 星雨幣掉落')
    .setDescription(
      `有人掉了 ${reward} 星雨幣！\n\n快點擊下方按鈕領取 ✨`
    );
  await message.channel.send({
    embeds: [embed],
    components: [row]
  });
  // ===== 開始冷卻 =====
  dropCooldown.set(channelId, true);

  setTimeout(() => {
    dropCooldown.delete(channelId);
  }, 8 * 60 * 1000);
});
// ===== Login =====
client.login(process.env.TOKEN);
