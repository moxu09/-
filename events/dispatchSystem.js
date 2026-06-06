const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder
} = require('discord.js');

let supabase;
let client;
let paymentHelpers = {};

const pendingNewOrders = new Map();
const pendingTopups = new Map();
const pendingServiceOrders = new Map();

function createFlowId(userId) {
  return `${userId}_${Date.now()}`;
}

function getServiceName(serviceType) {
  if (serviceType === 'valorant') return '特戰英豪';
  if (serviceType === 'steam') return 'Steam';
  if (serviceType === 'delta') return '三角洲';
  if (serviceType === 'chat') return '陪聊';
  if (serviceType === 'emotion') return '出氣包';
  return '訂單';
}

function setup(supabaseInstance, clientInstance, helpers = {}) {
  supabase = supabaseInstance;
  client = clientInstance;
  paymentHelpers = helpers;
}
function isCardPayment(text = '') {
  return (
    text.includes('刷卡') ||
    text.includes('信用卡') ||
    text.includes('信用卡付款') ||
    text.includes('card')
  );
}
function isNoCardPayment(text = '') {
  return (
    text.includes('無卡') ||
    text.includes('無卡存款')
  );
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
      `匯款完成後，請在此頻道上傳匯款截圖，等待客服確認。\n\n` +
      `若有其他銀行之需求，請在下方告訴客服。`
    )
    .setFooter({
      text: '請確認金額正確後再匯款'
    })
    .setTimestamp();

  await channel.send({
    embeds: [embed]
  });
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
      `🔗 付款連結：https://pcpay.tw/aCU67\n\n` +
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
async function applyExtensionToPlayOrder(extension) {
  const amount = Number(extension.amount || 0);

  if (!amount || amount <= 0) {
    throw new Error('加時金額錯誤');
  }

  const { data: lockedExtension, error: lockError } =
    await supabase
      .from('order_extensions')
      .update({
        applied_to_salary: true,
        applied_at: new Date().toISOString()
      })
      .eq('id', extension.id)
      .eq('applied_to_salary', false)
      .select()
      .maybeSingle();

  if (lockError) {
    console.error('[加時進薪資網] 鎖定加時失敗', lockError);
    throw lockError;
  }

  if (!lockedExtension) {
    throw new Error('這筆加時已經寫入過薪資網，已阻止重複加錢');
  }

  const { data: order, error: orderError } =
    await supabase
      .from('play_orders')
      .select('*')
      .eq('id', extension.order_id)
      .maybeSingle();

  if (orderError || !order) {
    console.error('[加時進薪資網] 找不到原訂單', orderError);
    throw new Error('找不到原訂單');
  }

  const oldPrice =
    Number(order.final_price || order.price || 0);

  const newPrice =
    oldPrice + amount;

  const oldService =
    order.service || order.order_item || '陪玩訂單';

  const oldNote =
    order.note || '';

  const extensionText =
    extension.extension_text || '加時';

  const newNote =
    `${oldNote}\n[加時] ${extensionText}｜+NT$${amount}`.trim();

  const { error: updateOrderError } =
    await supabase
      .from('play_orders')
      .update({
        final_price: newPrice,
        price: newPrice,
        service: `${oldService}｜加時：${extensionText}`,
        note: newNote,
        updated_at: new Date().toISOString()
      })
      .eq('id', order.id);

  if (updateOrderError) {
    console.error('[加時進薪資網] 更新原訂單失敗', updateOrderError);
    throw updateOrderError;
  }

  return {
    order,
    oldPrice,
    newPrice,
    amount
  };
}
function formatAvailableTime(player) {
  const time = player.available_time || {};

  if (!time || Object.keys(time).length === 0) {
    return '未填寫可接時間';
  }

  if (time.mode === 'daily') {
    return `每天 ${time.daily || '未填寫'}`;
  }

  if (time.mode === 'weekday_holiday') {
    return `平日 ${time.weekday || '未填寫'}｜假日 ${time.holiday || '未填寫'}`;
  }

  if (time.mode === 'weekly') {
    const parts = [
      ['一', time.monday],
      ['二', time.tuesday],
      ['三', time.wednesday],
      ['四', time.thursday],
      ['五', time.friday],
      ['六', time.saturday],
      ['日', time.sunday],
    ]
      .filter(([, value]) => value)
      .map(([day, value]) => `週${day} ${value}`);

    return parts.length ? parts.join('｜') : '未填寫可接時間';
  }

  return '未填寫可接時間';
}
function normalizeAllowedServices(value) {
  if (Array.isArray(value)) {
    return value
      .map(item => String(item).trim())
      .filter(Boolean);
  }

  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function matchPlayerService(player, keyword) {
  const allowedServices =
    normalizeAllowedServices(player.allowed_services);

  // 沒設定服務，就先不讓他出現在選單，避免誤接技術單
  if (!allowedServices.length) return false;

  const target =
    String(keyword || '')
      .replace(/\s+/g, '')
      .trim();

  return allowedServices.some(service => {
    const serviceText =
      String(service || '')
        .replace(/\s+/g, '')
        .trim();

    return serviceText === target;
  });
}

function matchPlayerGender(player, genderPreference) {
  if (!genderPreference || genderPreference === '不指定' || genderPreference === '男女皆可') {
    return true;
  }

  const gender =
    String(player.gender || '').trim();

  if (genderPreference === '男陪') {
    return gender === '男' || gender.includes('男');
  }

  if (genderPreference === '女陪') {
    return gender === '女' || gender.includes('女');
  }

  return true;
}

async function getQualifiedPlayerOptions(pending) {
  const keyword =
    `${pending.game || ''}${pending.item || ''}`;

  const { data: players, error } =
    await supabase
      .from('players')
      .select('*')
      .order('status', { ascending: true });

  if (error) {
    console.error('[新下單] 讀取陪陪失敗', error);
    return [];
  }

  const filtered =
    (players || [])
      .filter(player => matchPlayerService(player, keyword))
      .filter(player => matchPlayerGender(player, pending.gender));

  const onlinePlayers =
    filtered.filter(player => player.status === 'available');

  const offlinePlayers =
    filtered.filter(player => player.status !== 'available');

  const options = [
    {
      label: '不指定陪陪',
      description: '由客服協助安排適合的陪陪',
      value: 'none'
    },

    ...onlinePlayers.map(player => ({
      label: `🟢 ${String(player.name || player.discord_id)}`.slice(0, 100),
      description: '目前在線，可直接安排'.slice(0, 100),
      value: `online_${player.discord_id}`
    })),

    ...offlinePlayers.map(player => ({
      label: `⚪ ${String(player.name || player.discord_id)}`.slice(0, 100),
      description: formatAvailableTime(player).slice(0, 100),
      value: `reserve_${player.discord_id}`
    }))
  ];

  return options.slice(0, 25);
}
async function getAvailablePlayerOptions(service) {
  const { data: players, error } =
    await supabase
      .from('players')
      .select('*')
      .eq('status', 'available');

  if (error) {
    console.error('[指定陪陪] 讀取可接單陪陪失敗', error);
    return [];
  }

  function cleanServiceKey(text = '') {
    return String(text || '')
      .replace(/\s+/g, '')
      .replace(/[｜|]/g, '')
      .replace(/　/g, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim();
  }

  const targetService =
    cleanServiceKey(service);

  return (players || [])
    .filter(player => {
      const allowedServices =
        Array.isArray(player.allowed_services)
          ? player.allowed_services
          : String(player.allowed_services || '')
              .split(',')
              .map(s => s.trim())
              .filter(Boolean);

      if (!allowedServices.length) return false;

      return allowedServices.some(s => {
        const serviceKey =
          cleanServiceKey(s);

        return (
          serviceKey === targetService ||
          serviceKey.includes(targetService) ||
          targetService.includes(serviceKey)
        );
      });
    })
    .slice(0, 24)
    .map(player => ({
      label: String(player.name || player.discord_id).slice(0, 100),
      description: formatAvailableTime(player).slice(0, 100),
      value: player.discord_id
    }));
}


// ===== 派單紀錄 =====
async function sendPlayLog({
  title,
  description,
  color = '#00ff99'
}) {

  try {

    const channel =
      await client.channels.fetch(
        process.env.PLAYER_LOG_CHANNEL
      );

    if (!channel) return;

    const embed =
      new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(description)
        .setTimestamp();

    await channel.send({
      embeds: [embed]
    });

  } catch (err) {

    console.log(
      '[派單紀錄失敗]',
      err
    );

  }

}
// 陪玩上班
async function playerOnline(interaction) {
  const { data: oldPlayer } =
    await supabase
      .from('players')
      .select('*')
      .eq('discord_id', interaction.user.id)
      .maybeSingle();

  await supabase
    .from('players')
    .upsert({
      discord_id: interaction.user.id,
      // 不覆蓋資料庫原本設定好的陪陪名稱
      name:
        oldPlayer?.name ||
        interaction.member?.displayName ||
        interaction.user.username,
      game: oldPlayer?.game || 'delta_force',
      allowed_services: oldPlayer?.allowed_services || [],
      report_channel_id: oldPlayer?.report_channel_id || null,
      status: 'available',
      online_started_at: new Date()
    }, {
      onConflict: 'discord_id'
    });
  await interaction.editReply({
    content: '🟢 你已開始接單',
  });
}

// 陪玩下班
async function playerOffline(interaction) {
  await supabase
    .from('players')
    .update({
      status: 'offline'
    })
    .eq('discord_id', interaction.user.id);

  await interaction.editReply({
    content: '🔴 你已停止接單'
  });
}
function getTodayRangeTW() {
  const now = new Date();

  const taiwanNow =
    new Date(now.getTime() + 8 * 60 * 60 * 1000);

  const dateText =
    taiwanNow.toISOString().slice(0, 10);

  const start =
    new Date(`${dateText}T00:00:00+08:00`);

  const end =
    new Date(`${dateText}T23:59:59+08:00`);

  return {
    dateText,
    start: start.toISOString(),
    end: end.toISOString()
  };
}

async function sendDailyPlayerSummary() {
  const {
    dateText,
    start,
    end
  } = getTodayRangeTW();

  const { data: players, error: playerError } =
    await supabase
      .from('players')
      .select('*');

  if (playerError) {
    console.log('[每日陪玩總結] 讀取陪玩失敗', playerError);
    return;
  }

  if (!players?.length) {
    return;
  }

  const { data: orders, error: orderError } =
    await supabase
      .from('play_orders')
      .select('*')
      .eq('status', 'completed')
      .gte('completed_at', start)
      .lte('completed_at', end);

  if (orderError) {
    console.log('[每日陪玩總結] 讀取訂單失敗', orderError);
    return;
  }

  for (const player of players) {
    const playerOrders =
      (orders || []).filter(order => {
        const assignedPlayers =
          String(order.assigned_player || '')
            .split(',')
            .map(id => id.trim())
            .filter(Boolean);

        return assignedPlayers.includes(player.discord_id);
      });

    const totalOrders =
      playerOrders.length;

    const totalPrice =
      playerOrders.reduce(
        (sum, order) =>
          sum + Number(order.final_price || order.price || 0),
        0
      );

    const orderList =
      playerOrders.length
        ? playerOrders
            .map((order, index) => {
              return (
                `${index + 1}. ${order.service || '未填寫'}\n` +
                `訂單編號：${order.order_no || order.id}\n` +
                `金額：NT$${order.final_price || order.price || 0}\n` +
                `內容：${order.note || '無'}`
              );
            })
            .join('\n\n')
        : '今日尚無完成訂單';

    const embed =
      new EmbedBuilder()
        .setColor('#66ccff')
        .setTitle('📊 陪玩每日總結')
        .setDescription(
          `日期：${dateText}\n` +
          `陪玩：<@${player.discord_id}>\n\n` +
          `完成訂單：${totalOrders}\n` +
          `總金額：NT$${totalPrice}\n\n` +
          `━━━━━━━━━━\n\n` +
          `${orderList}`
        )
        .setTimestamp();

    if (player.report_channel_id) {
      const reportChannel =
        await client.channels
          .fetch(player.report_channel_id)
          .catch(() => null);

      if (reportChannel) {
        await reportChannel.send({
          embeds: [embed]
        });
      }
    }
  }

  console.log(`[每日陪玩總結] 已送出 ${dateText}`);
}
// 查看狀態
async function playerStatus(interaction) {
  const { data } = await supabase
    .from('players')
    .select('*')
    .eq('discord_id', interaction.user.id)
    .single();

  if (!data) {
    return interaction.editReply({
      content: '你尚未登記陪玩，請先使用 /上班',
    });
  }

  await interaction.editReply({
    content:
      `📋 你的狀態：${data.status}\n` +
      `📦 完成單數：${data.total_orders}`,
  });
}
function buildPreferredPlayerText(preferredPlayerIds) {
  if (!preferredPlayerIds) return '不指定';

  const ids =
    String(preferredPlayerIds)
      .split(',')
      .map(id => id.trim())
      .filter(Boolean);

  if (!ids.length) return '不指定';

  return ids.map(id => `<@${id}>`).join('、');
}

async function sendOrderToStaffChannel(order) {
  const channel =
    await client.channels.fetch(process.env.PLAYER_ORDER_CHANNEL);

  const preferredText =
    buildPreferredPlayerText(order.preferred_player);

  const embed =
    new EmbedBuilder()
      .setColor('#00ff99')
      .setTitle('📦 已建立新陪玩訂單')
      .addFields(
        {
          name: '📌 訂單編號',
          value: order.order_no || '未知',
          inline: true
        },
        {
          name: '👤 客人',
          value: `<@${order.customer_id}>`,
          inline: true
        },
        {
          name: '🌟 指定陪陪',
          value: preferredText,
          inline: true
        },
        {
          name: '🎮 服務項目',
          value: order.service || '未填寫',
          inline: false
        },
        {
          name: '🏅 段位',
          value: order.rank_preference || '不指定',
          inline: true
        },
        {
          name: '👥 需要人數',
          value: `${Number(order.player_count || 1) || 1} 位`,
          inline: true
        },
        {
          name: '🕒 預約時間',
          value: order.reserved_time || order.duration_text || '未填寫',
          inline: true
        },
        {
          name: '💳 付款方式',
          value: order.payment_method || '未填寫',
          inline: true
        },
        {
          name: '💰 商品金額',
          value: `NT$${order.final_price || order.price || 0}`,
          inline: true
        },
        {
          name: '📝 備註需求',
          value: order.note || '無',
          inline: false
        }
      )
      .setFooter({
        text: '星雨派單系統'
      })
      .setTimestamp();

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`accept_play_order_${order.id}`)
          .setLabel('接單')
          .setStyle(ButtonStyle.Success)
      );

  const playerRoleMention =
    process.env.PLAYER_ROLE_ID
      ? `<@&${process.env.PLAYER_ROLE_ID}>`
      : '';
  await channel.send({
    content:
      order.dispatch_type === 'reserve'
        ? `${playerRoleMention} 🕒 預約派單：<@${order.reserved_player}>｜時間：${order.reserved_time}`
        : order.preferred_player
          ? `${playerRoleMention} 🌟 指定陪陪派單：${preferredText}`
          : `${playerRoleMention} 📢 開放接單`,
    embeds: [embed],
    components: [row]
  });
}
async function sendStaffOrderControlPanel(channel, order) {
  const row1 =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`staff_edit_order_${order.id}`)
          .setLabel('修改訂單')
          .setEmoji('🛠️')
          .setStyle(ButtonStyle.Primary),

        new ButtonBuilder()
          .setCustomId(`change_order_price_${order.id}`)
          .setLabel('修改金額')
          .setEmoji('💰')
          .setStyle(ButtonStyle.Secondary),

        new ButtonBuilder()
          .setCustomId(`extend_order_${order.id}`)
          .setLabel('訂單加時')
          .setEmoji('➕')
          .setStyle(ButtonStyle.Secondary)
      );

  const row2 =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('complete_order')
          .setLabel('完成訂單')
          .setEmoji('🏁')
          .setStyle(ButtonStyle.Success)
      );

  await channel.send({
    content:
      `<@&${process.env.STAFF_ROLE}> 訂單客服操作面板`,
    embeds: [
      new EmbedBuilder()
        .setColor('#66ccff')
        .setTitle('🛠️ 客服訂單管理')
        .setDescription(
          `訂單編號：${order.order_no || order.id}\n` +
          `闆闆：<@${order.customer_id}>\n` +
          `服務：${order.service || order.order_item || '未填寫'}\n` +
          `金額：NT$${order.final_price || order.price || 0}\n\n` +
          `可在這裡修改訂單、修改金額、建立加時，或在服務結束後完成訂單。`
        )
        .setTimestamp()
    ],
    components: [row1, row2]
  });
}
// ===== 陪玩控制面板 =====
async function sendPlayerPanel(channel) {

  const embed = new EmbedBuilder()
    .setColor('#00ff99')
    .setTitle('🎮 陪玩控制中心')
    .setDescription(
      '請使用下方按鈕控制接單狀態。'
    );

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('player_online')
        .setLabel('🟢 開始接單')
        .setStyle(ButtonStyle.Success),

      new ButtonBuilder()
        .setCustomId('player_offline')
        .setLabel('🔴 停止接單')
        .setStyle(ButtonStyle.Danger),

      new ButtonBuilder()
        .setCustomId('player_status')
        .setLabel('📋 我的狀態')
        .setStyle(ButtonStyle.Secondary)
    );

  const messages = await channel.messages.fetch({
    limit: 10
  });
  const oldPanel = messages.find(
    msg =>
      msg.author.id === client.user.id &&
      msg.embeds.length > 0 &&
      msg.embeds[0].title === '🎮 陪玩控制中心'
  );
  if (oldPanel) {
    await oldPanel.edit({
      embeds: [embed],
      components: [row]
    });
    return;
  }
  await channel.send({
    embeds: [embed],
    components: [row]
  });

}
function buildOrderBackRow(flowId, target) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`new_order_back_${target}_${flowId}`)
        .setLabel('⬅️ 上一步')
        .setStyle(ButtonStyle.Secondary)
    );
}
async function createTopupTicket(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }

  const guild = interaction.guild;

  const channel =
    await guild.channels.create({
      name: `儲值-${interaction.user.username}`.slice(0, 90),
      type: ChannelType.GuildText,
      parent: process.env.ORDER_CATEGORY || null,
      topic: `owner:${interaction.user.id}`,
      permissionOverwrites: [
        {
          id: guild.id,
          deny: ['ViewChannel']
        },
        {
          id: interaction.user.id,
          allow: [
            'ViewChannel',
            'SendMessages',
            'ReadMessageHistory',
            'AttachFiles'
          ]
        },
        {
          id: process.env.STAFF_ROLE,
          allow: [
            'ViewChannel',
            'SendMessages',
            'ReadMessageHistory',
            'AttachFiles',
            'ManageMessages'
          ]
        }
      ]
    });

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

  await channel.send({
    content: `<@${interaction.user.id}> <@&${process.env.STAFF_ROLE}>`,
    embeds: [
      new EmbedBuilder()
        .setColor('#ffd166')
        .setTitle('💳 儲值頻道')
        .setDescription('請點擊下方按鈕填寫儲值資料。')
    ],
    components: [row]
  });

  return interaction.editReply({
    content: `✅ 已建立儲值頻道：<#${channel.id}>`
  });
}
async function createTipTicket(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }

  const guild = interaction.guild;

  const channel =
    await guild.channels.create({
      name: `打賞-${interaction.user.username}`.slice(0, 90),
      type: ChannelType.GuildText,
      parent: process.env.ORDER_CATEGORY || null,
      topic: `owner:${interaction.user.id}`,
      permissionOverwrites: [
        {
          id: guild.id,
          deny: ['ViewChannel']
        },
        {
          id: interaction.user.id,
          allow: [
            'ViewChannel',
            'SendMessages',
            'ReadMessageHistory',
            'AttachFiles'
          ]
        },
        {
          id: process.env.STAFF_ROLE,
          allow: [
            'ViewChannel',
            'SendMessages',
            'ReadMessageHistory',
            'AttachFiles',
            'ManageMessages'
          ]
        }
      ]
    });

  await channel.send({
    content: `<@${interaction.user.id}> <@&${process.env.STAFF_ROLE}>`,
    embeds: [
      new EmbedBuilder()
        .setColor('#ff99cc')
        .setTitle('💝 打賞頻道')
        .setDescription('請依照下方選單選擇打賞禮物。')
    ],
    components: [
      new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('owner_cancel_ticket')
            .setLabel('我按錯了，關閉頻道')
            .setEmoji('🗑️')
            .setStyle(ButtonStyle.Danger)
        )
    ]
  });

  if (!paymentHelpers.startTipFlowInChannel) {
    await channel.send('❌ 打賞流程尚未接入 startTipFlowInChannel。');
  } else {
    await paymentHelpers.startTipFlowInChannel(
      channel,
      interaction.user
    );
  }

  return interaction.editReply({
    content: `✅ 已建立打賞頻道：<#${channel.id}>`
  });
}
async function createServiceTicket(interaction, serviceType) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }

  const guild = interaction.guild;
  const serviceName = getServiceName(serviceType);
  const flowId = createFlowId(interaction.user.id);

  const channel =
    await guild.channels.create({
      name: `${serviceName}-${interaction.user.username}`.slice(0, 90),
      type: ChannelType.GuildText,
      parent: process.env.ORDER_CATEGORY || null,
      topic: `owner:${interaction.user.id}`,
      permissionOverwrites: [
        {
          id: guild.id,
          deny: ['ViewChannel']
        },
        {
          id: interaction.user.id,
          allow: [
            'ViewChannel',
            'SendMessages',
            'ReadMessageHistory',
            'AttachFiles'
          ]
        },
        {
          id: process.env.STAFF_ROLE,
          allow: [
            'ViewChannel',
            'SendMessages',
            'ReadMessageHistory',
            'AttachFiles',
            'ManageMessages'
          ]
        }
      ]
    });

  pendingServiceOrders.set(flowId, {
    flowId,
    channelId: channel.id,
    customerId: interaction.user.id,
    customerUsername: interaction.user.username,
    category: serviceType,

    serviceType: null,
    playMode: null,
    rank: null,
    steamCategory: null,
    steamGameName: null,
    deltaMode: null,

    playerCount: null,
    genderPreference: null,
    assignMode: null,
    selectedPlayerIds: [],

    duration: null,
    rounds: null,
    note: '',
    quotedPrice: null,
    paymentMethod: null,
    timeSelectShown: false
  });

  setTimeout(() => {
    pendingServiceOrders.delete(flowId);
  }, 60 * 60 * 1000);

  await channel.send({
    content: `<@${interaction.user.id}> <@&${process.env.STAFF_ROLE}>`,
    embeds: [
      new EmbedBuilder()
        .setColor('#ffd166')
        .setTitle(`🌙 ${serviceName} 下單頻道`)
        .setDescription(
          `請依照下方選項填寫需求。\n\n` +
          `填寫完成後，客服會依照需求輸入正式報價。`
        )
        .setTimestamp()
    ],
    components: [
      new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('owner_cancel_ticket')
            .setLabel('我按錯了，關閉頻道')
            .setEmoji('🗑️')
            .setStyle(ButtonStyle.Danger)
        )
    ]
  });

  if (serviceType === 'valorant') {
    await showValorantStart(channel, flowId);
  }
  if (serviceType === 'steam') {
    await showSteamStart(channel, flowId);
  }
  if (serviceType === 'delta') {
    await showDeltaStart(channel, flowId);
  }
  if (serviceType === 'chat') {
    await showSimpleServiceStart(channel, flowId, 'chat');
  }
  if (serviceType === 'emotion') {
    await showSimpleServiceStart(channel, flowId, 'emotion');
  }
  return interaction.editReply({
    content: `✅ 已建立下單頻道：<#${channel.id}>`
  });
}
async function showValorantStart(channel, flowId) {
  const row1 =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`valorant_type_entertain_${flowId}`)
          .setLabel('娛樂')
          .setStyle(ButtonStyle.Primary),

        new ButtonBuilder()
          .setCustomId(`valorant_type_skill_${flowId}`)
          .setLabel('技術')
          .setStyle(ButtonStyle.Secondary)
      );

  const row2 =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`valorant_mode_rank_${flowId}`)
          .setLabel('排位')
          .setStyle(ButtonStyle.Primary),

        new ButtonBuilder()
          .setCustomId(`valorant_mode_normal_${flowId}`)
          .setLabel('一般')
          .setStyle(ButtonStyle.Secondary)
      );

  const rankMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`valorant_rank_${flowId}`)
      .setPlaceholder('請選擇段位')
      .addOptions([
        {
          label: '鐵牌',
          value: '鐵牌'
        },
        {
          label: '銅牌',
          value: '銅牌'
        },
        {
          label: '銀牌',
          value: '銀牌'
        },
        {
          label: '金牌',
          value: '金牌'
        },
        {
          label: '白金',
          value: '白金'
        },
        {
          label: '鑽石',
          value: '鑽石'
        },
        {
          label: '超凡',
          value: '超凡'
        },
        {
          label: '神話',
          value: '神話'
        },
        {
          label: '輻能',
          value: '輻能'
        },
        {
          label: '不指定 / 尚未確認',
          value: '不指定'
        }
      ]);

  const countMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`service_player_count_${flowId}`)
      .setPlaceholder('請選擇陪陪人數')
      .addOptions([
        {
          label: '1 位',
          value: '1'
        },
        {
          label: '2 位',
          value: '2'
        },
        {
          label: '3 位',
          value: '3'
        },
        {
          label: '4 位',
          value: '4'
        }
      ]);

  const genderMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`service_gender_${flowId}`)
      .setPlaceholder('請選擇陪陪性別偏好')
      .addOptions([
        {
          label: '不指定',
          value: '不指定'
        },
        {
          label: '男陪',
          value: '男陪'
        },
        {
          label: '女陪',
          value: '女陪'
        }
      ]);

  const assignMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`service_assign_${flowId}`)
      .setPlaceholder('是否指定陪陪')
      .addOptions([
        {
          label: '不指定陪陪',
          value: '不指定'
        },
        {
          label: '指定陪陪',
          value: '指定'
        },
        {
          label: '預約指定陪陪',
          value: '預約指定'
        }
      ]);
  const durationMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`service_duration_${flowId}`)
      .setPlaceholder('請選擇時長｜娛樂 / 金牌以下技術適用')
      .addOptions([
        {
          label: '1 小時',
          value: '1'
        },
        {
          label: '2 小時',
          value: '2'
        },
        {
          label: '3 小時',
          value: '3'
        },
        {
          label: '4 小時',
          value: '4'
        },
        {
          label: '自訂',
          value: 'custom'
        }
      ]);
  const roundsMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`service_rounds_${flowId}`)
      .setPlaceholder('請選擇局數｜技術金牌以上適用')
      .addOptions([
        {
          label: '1 局',
          value: '1'
        },
        {
          label: '3 局',
          value: '3'
        },
        {
          label: '5 局',
          value: '5'
        },
        {
          label: '自訂',
          value: 'custom'
        }
      ]);
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor('#ff6b6b')
        .setTitle('🎯 特戰英豪需求')
        .setDescription(
          `請依序選擇服務內容。\n\n` +
          `**客服價格參考**\n` +
          `娛樂陪玩：NT$250、250、260、270、310\n` +
          `技術陪玩：金牌以下以時長報價，金牌以上以局數報價\n\n` +
          `⚠️ 此價格僅供參考，正式金額仍以客服輸入為準。`
        )
    ],
    components: [
      row1,
      row2,
      new ActionRowBuilder().addComponents(rankMenu),
      new ActionRowBuilder().addComponents(countMenu),
      new ActionRowBuilder().addComponents(genderMenu)
    ]
  });

  await channel.send({
    content:
      `請繼續選擇指定方式與時間：\n\n` +
      `娛樂陪玩 / 金牌以下技術單 → 選「時長」\n` +
      `金牌以上技術單 → 選「局數」`,
    components: [
      new ActionRowBuilder().addComponents(assignMenu),
      new ActionRowBuilder().addComponents(durationMenu),
      new ActionRowBuilder().addComponents(roundsMenu)
    ]
  });
}
async function showSteamStart(channel, flowId) {
  const categoryMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`steam_category_${flowId}`)
      .setPlaceholder('請選擇 Steam 遊戲類型')
      .addOptions([
        {
          label: '恐怖遊戲',
          description: '價格參考：由客服依遊戲與時長報價',
          value: '恐怖遊戲'
        },
        {
          label: '生存遊戲',
          description: '價格參考：由客服依遊戲與時長報價',
          value: '生存遊戲'
        },
        {
          label: '肉鴿遊戲',
          description: '價格參考：由客服依遊戲與時長報價',
          value: '肉鴿遊戲'
        },
        {
          label: '派對遊戲',
          description: '價格參考：由客服依遊戲與時長報價',
          value: '派對遊戲'
        },
        {
          label: '其他',
          description: '請輸入遊戲名稱，由客服報價',
          value: '其他'
        }
      ]);

  const countMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`service_player_count_${flowId}`)
      .setPlaceholder('請選擇陪陪人數')
      .addOptions([
        { label: '1 位', value: '1' },
        { label: '2 位', value: '2' },
        { label: '3 位', value: '3' },
        { label: '4 位', value: '4' }
      ]);

  const genderMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`service_gender_${flowId}`)
      .setPlaceholder('請選擇陪陪性別偏好')
      .addOptions([
        { label: '不指定', value: '不指定' },
        { label: '男陪', value: '男陪' },
        { label: '女陪', value: '女陪' }
      ]);

  const assignMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`service_assign_${flowId}`)
      .setPlaceholder('是否指定陪陪')
      .addOptions([
        { label: '不指定陪陪', value: '不指定' },
        { label: '指定陪陪', value: '指定' },
        { label: '預約指定陪陪', value: '預約指定' }
      ]);

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`steam_game_name_${flowId}`)
          .setLabel('輸入遊戲名稱')
          .setStyle(ButtonStyle.Primary),

        new ButtonBuilder()
          .setCustomId(`order_add_note_${flowId}`)
          .setLabel('填寫備註 / 自訂需求')
          .setStyle(ButtonStyle.Secondary)
      );

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor('#5dade2')
        .setTitle('🎮 Steam 下單需求')
        .setDescription(
          `請選擇遊戲類型、人數、性別、指定方式與時長。\n\n` +
          `⚠️ 價格只提供客服參考，正式報價由客服輸入。`
        )
    ],
    components: [
      new ActionRowBuilder().addComponents(categoryMenu),
      new ActionRowBuilder().addComponents(countMenu),
      new ActionRowBuilder().addComponents(genderMenu),
      new ActionRowBuilder().addComponents(assignMenu),
      row
    ]
  });

  await showServiceDurationSelect(channel, flowId, 'hour');
}
async function showDeltaStart(channel, flowId) {
  const modeMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`delta_mode_${flowId}`)
      .setPlaceholder('請選擇三角洲玩法')
      .addOptions([
        { label: '基礎陪護', value: '基礎陪護' },
        { label: '機密雙護', value: '機密雙護' },
        { label: '機密雙護（保底）', value: '機密雙護（保底）' },
        { label: '猛攻護航', value: '猛攻護航' },
        { label: '猛攻護航（保底）', value: '猛攻護航（保底）' },
        { label: '一般陪玩', value: '一般陪玩' },
        { label: '其他玩法', value: '其他玩法' }
      ]);

  const countMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`service_player_count_${flowId}`)
      .setPlaceholder('請選擇陪陪人數')
      .addOptions([
        { label: '1 位', value: '1' },
        { label: '2 位', value: '2' },
        { label: '3 位', value: '3' },
        { label: '4 位', value: '4' }
      ]);

  const genderMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`service_gender_${flowId}`)
      .setPlaceholder('請選擇陪陪性別偏好')
      .addOptions([
        { label: '不指定', value: '不指定' },
        { label: '男陪', value: '男陪' },
        { label: '女陪', value: '女陪' }
      ]);

  const assignMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`service_assign_${flowId}`)
      .setPlaceholder('是否指定陪陪')
      .addOptions([
        { label: '不指定陪陪', value: '不指定' },
        { label: '指定陪陪', value: '指定' },
        { label: '預約指定陪陪', value: '預約指定' }
      ]);

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor('#95d5b2')
        .setTitle('🛡️ 三角洲下單需求')
        .setDescription(
          `請選擇玩法、人數、性別、指定方式與時間。\n\n` +
          `⚠️ 保底、雙護、護航等價格僅供客服參考，正式報價由客服輸入。`
        )
    ],
    components: [
      new ActionRowBuilder().addComponents(modeMenu),
      new ActionRowBuilder().addComponents(countMenu),
      new ActionRowBuilder().addComponents(genderMenu),
      new ActionRowBuilder().addComponents(assignMenu)
    ]
  });

  await showServiceDurationSelect(channel, flowId, 'hour');
}
async function showServiceDurationSelect(channel, flowId, unit = 'hour') {
  const options =
    unit === 'half'
      ? [
          { label: '30 分鐘', value: '0.5' },
          { label: '1 小時', value: '1' },
          { label: '1.5 小時', value: '1.5' },
          { label: '2 小時', value: '2' },
          { label: '自訂', value: 'custom' }
        ]
      : [
          { label: '1 小時', value: '1' },
          { label: '2 小時', value: '2' },
          { label: '3 小時', value: '3' },
          { label: '4 小時', value: '4' },
          { label: '自訂', value: 'custom' }
        ];

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(`service_duration_${flowId}`)
      .setPlaceholder('請選擇時間')
      .addOptions(options);

  await channel.send({
    content: '請選擇服務時間：',
    components: [
      new ActionRowBuilder().addComponents(menu)
    ]
  });
}

async function showServiceRoundSelect(channel, flowId) {
  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(`service_rounds_${flowId}`)
      .setPlaceholder('請選擇局數')
      .addOptions([
        { label: '1 局', value: '1' },
        { label: '3 局', value: '3' },
        { label: '5 局', value: '5' },
        { label: '自訂', value: 'custom' }
      ]);

  await channel.send({
    content: '請選擇局數：',
    components: [
      new ActionRowBuilder().addComponents(menu)
    ]
  });
}

function isValorantGoldOrBelow(rank) {
  return ['鐵牌', '銅牌', '銀牌', '金牌', '金牌含以下', '不指定'].includes(
    String(rank || '')
  );
}
async function showValorantTimeOrRoundOnce(channel, flowId, pending) {
  if (pending.timeSelectShown) {
    return;
  }

  if (!pending.serviceType) {
    return;
  }

  if (pending.serviceType === '娛樂') {
    pending.timeSelectShown = true;
    pendingServiceOrders.set(flowId, pending);
    await showServiceDurationSelect(channel, flowId, 'hour');
    return;
  }

  if (pending.serviceType === '技術') {
    if (!pending.rank) {
      await channel.send('請先選擇段位，系統會依段位顯示時長或局數。');
      return;
    }

    pending.timeSelectShown = true;
    pendingServiceOrders.set(flowId, pending);

    if (isValorantGoldOrBelow(pending.rank)) {
      await showServiceDurationSelect(channel, flowId, 'hour');
    } else {
      await showServiceRoundSelect(channel, flowId);
    }
  }
}
async function showSimpleServiceStart(channel, flowId, serviceType) {
  const isChat =
    serviceType === 'chat';

  const title =
    isChat
      ? '💬 陪聊需求'
      : '🧸 出氣包需求';

  const description =
    isChat
      ? '陪聊以半小時為一單位，正式價格由客服輸入。'
      : '出氣包以半小時為一單位，正式價格由客服輸入。';

  const countMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`service_player_count_${flowId}`)
      .setPlaceholder('請選擇陪陪人數')
      .addOptions([
        {
          label: '1 位',
          value: '1'
        },
        {
          label: '2 位',
          value: '2'
        },
        {
          label: '3 位',
          value: '3'
        },
        {
          label: '4 位',
          value: '4'
        }
      ]);

  const genderMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`service_gender_${flowId}`)
      .setPlaceholder('請選擇陪陪性別偏好')
      .addOptions([
        {
          label: '不指定',
          value: '不指定'
        },
        {
          label: '男陪',
          value: '男陪'
        },
        {
          label: '女陪',
          value: '女陪'
        }
      ]);

  const assignMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`service_assign_${flowId}`)
      .setPlaceholder('是否指定陪陪')
      .addOptions([
        {
          label: '不指定陪陪',
          value: '不指定'
        },
        {
          label: '指定陪陪',
          value: '指定'
        },
        {
          label: '預約指定陪陪',
          value: '預約指定'
        }
      ]);

  const durationMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`service_duration_${flowId}`)
      .setPlaceholder('請選擇時間')
      .addOptions([
        {
          label: '30 分鐘',
          value: '0.5'
        },
        {
          label: '1 小時',
          value: '1'
        },
        {
          label: '1.5 小時',
          value: '1.5'
        },
        {
          label: '2 小時',
          value: '2'
        },
        {
          label: '自訂',
          value: 'custom'
        }
      ]);

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor('#cdb4db')
        .setTitle(title)
        .setDescription(
          `${description}\n\n` +
          `請依序選擇人數、性別、指定方式與時間。\n\n` +
          `⚠️ 價格僅供參考，正式報價由客服輸入。`
        )
        .setTimestamp()
    ],
    components: [
      new ActionRowBuilder().addComponents(countMenu),
      new ActionRowBuilder().addComponents(genderMenu),
      new ActionRowBuilder().addComponents(assignMenu),
      new ActionRowBuilder().addComponents(durationMenu)
    ]
  });
}
async function openPlayOrderModal(interaction) {
  const flowId = `${interaction.user.id}_${Date.now()}`;

  pendingNewOrders.set(flowId, {
    userId: interaction.user.id,
    channelId: interaction.channel.id,
    game: '',
    item: '',
    rank: '',
    playerCount: 1,
    gender: '不指定',
    selectedPlayerType: 'none',
    selectedPlayerId: null,
    selectedPlayerIds: [],
    duration: '',
    durationMinutes: 0,
    reservedTime: '',
    note: '無'
  });

  setTimeout(() => {
    pendingNewOrders.delete(flowId);
  }, 30 * 60 * 1000);

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(`new_order_game_${flowId}`)
      .setPlaceholder('請選擇遊戲 / 服務類型')
      .addOptions([
        {
          label: '特戰英豪',
          description: 'VALORANT 陪玩 / 技術單',
          value: '特戰英豪'
        },
        {
          label: '三角洲行動',
          description: '三角洲護航 / 保底 / 娛樂',
          value: '三角洲行動'
        },
        {
          label: 'PUBG',
          description: 'PUBG 陪玩',
          value: 'PUBG'
        },
        {
          label: 'STEAM',
          description: 'Steam 遊戲陪玩',
          value: 'STEAM'
        },
        {
          label: '陪聊服務',
          description: '聊天 / 陪伴 / 出氣',
          value: '陪聊服務'
        },
        {
          label: '打賞禮物',
          description: '打賞 / 禮物單',
          value: '打賞禮物'
        }
      ]);

  const row =
    new ActionRowBuilder()
      .addComponents(menu);

  return interaction.reply({
    content: '🎮 請先選擇你要下單的遊戲 / 服務：',
    components: [row],
    flags: 64
  });
}
function getOrderItemOptions(game) {
  if (game === '特戰英豪') {
    return [
      {
        label: '娛樂陪玩',
        value: '娛樂陪玩',
        description: '一般娛樂陪玩'
      },
      {
        label: '技術陪玩',
        value: '技術陪玩',
        description: '技術陪 / 強度單'
      }
    ];
  }

  if (game === '三角洲行動') {
    return [
      {
        label: '機密雙護',
        value: '機密雙護',
        description: '三角洲機密雙護'
      },
      {
        label: '猛攻護航',
        value: '猛攻護航',
        description: '三角洲猛攻護航'
      },
      {
        label: '娛樂陪玩',
        value: '娛樂陪玩',
        description: '一般娛樂陪玩'
      }
    ];
  }

  if (game === 'PUBG') {
    return [
      {
        label: '娛樂單陪',
        value: '娛樂單陪',
        description: 'PUBG 單陪'
      },
      {
        label: '娛樂雙陪',
        value: '娛樂雙陪',
        description: 'PUBG 雙陪'
      }
    ];
  }

  if (game === 'STEAM') {
    return [
      {
        label: '恐怖遊戲陪玩',
        value: '恐怖遊戲陪玩',
        description: 'Steam 恐怖遊戲'
      },
      {
        label: '一般遊戲陪玩',
        value: '一般遊戲陪玩',
        description: 'Steam 一般遊戲'
      }
    ];
  }

  if (game === '陪聊服務') {
    return [
      {
        label: '聊天陪伴',
        value: '聊天陪伴',
        description: '一般聊天陪伴'
      },
      {
        label: '出氣服務',
        value: '出氣服務',
        description: '陪聊 / 出氣'
      }
    ];
  }
  return [
    {
      label: '一般項目',
      value: '一般項目',
      description: '一般服務'
    }
  ];
}
async function handleNewOrderGameSelect(interaction) {
  const flowId =
    interaction.customId.replace('new_order_game_', '');

  const pending =
    pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: '❌ 這筆下單流程已過期，請重新填寫。',
      components: []
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: '❌ 只有下單者可以操作這個選單。',
      flags: 64
    });
  }

  const game =
    interaction.values[0];

  pending.game = game;
  pendingNewOrders.set(flowId, pending);
  if (game === '打賞禮物') {
    pendingNewOrders.delete(flowId);
    if (!paymentHelpers.startTipFlowInChannel) {
      return interaction.update({
        content:
          '❌ 打賞流程尚未接入，請確認 index.js 的 dispatchSystem.setup 有傳 startTipFlowInChannel。',
        components: []
      });
    }
    await paymentHelpers.startTipFlowInChannel(
      interaction.channel,
      interaction.user
    );
    return interaction.update({
      content:
        '💝 已切換為打賞流程，請在下方選擇要打賞的禮物。',
      components: []
    });
  }
  const options =
    getOrderItemOptions(game)
      .slice(0, 25)
      .map(item => ({
        label: item.label.slice(0, 100),
        description: item.description.slice(0, 100),
        value: item.value
      }));

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(`new_order_item_${flowId}`)
      .setPlaceholder('請選擇項目')
      .addOptions(options);

  const row =
    new ActionRowBuilder()
      .addComponents(menu);

  return interaction.update({
    content:
      `🎮 已選擇：${game}\n\n` +
      `請選擇你要的項目：`,
    components: [
      row,
      buildOrderBackRow(flowId, 'game')
    ] 
  });
}
function getValorantRankOptions() {
  return [
    {
      label: '金牌含以下',
      value: '金牌含以下',
      description: 'Gold and below'
    },
    {
      label: '白金',
      value: '白金',
      description: 'Platinum'
    },
    {
      label: '鑽石',
      value: '鑽石',
      description: 'Diamond'
    },
    {
      label: '超凡入聖',
      value: '超凡入聖',
      description: 'Ascendant'
    },
    {
      label: '神話',
      value: '神話',
      description: 'Immortal'
    },
    {
      label: '輻能戰魂',
      value: '輻能戰魂',
      description: 'Radiant'
    },
    {
      label: '不指定 / 尚未確認',
      value: '不指定',
      description: '由客服協助確認'
    }
  ];
}
function isValorantRankGameBased(rank) {
  const value = String(rank || '');

  return (
    value.includes('白金') ||
    value.includes('鑽石') ||
    value.includes('超凡') ||
    value.includes('神話') ||
    value.includes('輻能')
  );
}
async function handleNewOrderItemSelect(interaction) {
  const flowId =
    interaction.customId.replace('new_order_item_', '');

  const pending =
    pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: '❌ 這筆下單流程已過期，請重新填寫。',
      components: []
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: '❌ 只有下單者可以操作這個選單。',
      flags: 64
    });
  }

  pending.item = interaction.values[0];
  pendingNewOrders.set(flowId, pending);
  if (pending.game === '特戰英豪') {
    const menu =
      new StringSelectMenuBuilder()
        .setCustomId(`new_order_rank_${flowId}`)
        .setPlaceholder('請選擇要打的段位')
        .addOptions(getValorantRankOptions());
    const row =
      new ActionRowBuilder()
        .addComponents(menu);
    return interaction.update({
      content:
        `🎮 遊戲：${pending.game}\n` +
        `📌 項目：${pending.item}\n\n` +
        `請選擇這次要打的段位：`,
      components: [
        row,
        buildOrderBackRow(flowId, 'item')
      ]
    });
  }
  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(`new_order_count_${flowId}`)
      .setPlaceholder('請選擇需要幾位陪陪')
      .addOptions([
        {
          label: '1 位陪陪',
          value: '1',
          description: '單陪'
        },
        {
          label: '2 位陪陪',
          value: '2',
          description: '雙陪'
        },
        {
          label: '3 位陪陪',
          value: '3',
          description: '三陪'
        },
        {
          label: '自訂',
          value: 'custom',
          description: '由客服協助確認人數'
        }
      ]);

  const row =
    new ActionRowBuilder()
      .addComponents(menu);

  return interaction.update({
    content:
      `🎮 遊戲：${pending.game}\n` +
      `📌 項目：${pending.item}\n\n` +
      `請選擇需要幾位陪陪：`,
    components: [
      row,
      buildOrderBackRow(flowId, 'item')
    ]
  });
}
async function handleNewOrderRankSelect(interaction) {
  const flowId =
    interaction.customId.replace('new_order_rank_', '');

  const pending =
    pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: '❌ 這筆下單流程已過期，請重新填寫。',
      components: []
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: '❌ 只有下單者可以操作這個選單。',
      flags: 64
    });
  }

  pending.rank = interaction.values[0];
  pendingNewOrders.set(flowId, pending);

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(`new_order_count_${flowId}`)
      .setPlaceholder('請選擇需要幾位陪陪')
      .addOptions([
        {
          label: '1 位陪陪',
          value: '1',
          description: '單陪'
        },
        {
          label: '2 位陪陪',
          value: '2',
          description: '雙陪'
        },
        {
          label: '3 位陪陪',
          value: '3',
          description: '三陪'
        },
        {
          label: '自訂',
          value: 'custom',
          description: '由客服協助確認人數'
        }
      ]);

  const row =
    new ActionRowBuilder()
      .addComponents(menu);

  return interaction.update({
    content:
      `🎮 遊戲：${pending.game}\n` +
      `📌 項目：${pending.item}\n` +
      `🏅 段位：${pending.rank || '未填寫'}\n\n` +
      `請選擇需要幾位陪陪：`,
    components: [
      row,
      buildOrderBackRow(flowId, 'rank')
    ]
  });
}
async function handleNewOrderCountSelect(interaction) {
  const flowId =
    interaction.customId.replace('new_order_count_', '');

  const pending =
    pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: '❌ 這筆下單流程已過期，請重新填寫。',
      components: []
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: '❌ 只有下單者可以操作這個選單。',
      flags: 64
    });
  }

  pending.playerCount =
    interaction.values[0] === 'custom'
      ? 0
      : Number(interaction.values[0]);

  pendingNewOrders.set(flowId, pending);

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(`new_order_gender_${flowId}`)
      .setPlaceholder('請選擇陪陪性別偏好')
      .addOptions([
        {
          label: '男陪',
          value: '男陪',
          description: '只看男陪'
        },
        {
          label: '女陪',
          value: '女陪',
          description: '只看女陪'
        },
        {
          label: '男女皆可',
          value: '男女皆可',
          description: '男陪女陪都可以'
        },
        {
          label: '不指定',
          value: '不指定',
          description: '不限制性別'
        }
      ]);

  const row =
    new ActionRowBuilder()
      .addComponents(menu);

  return interaction.update({
    content:
      `🎮 遊戲：${pending.game}\n` +
      `📌 項目：${pending.item}\n` +
      (
        pending.game === '特戰英豪'
          ? `🏅 段位：${pending.rank || '未填寫'}\n`
          : ''
      ) +
      `👥 人數：${pending.playerCount || '自訂'}\n\n` +
      `請選擇陪陪性別偏好：`,
    components: [
      row,
      buildOrderBackRow(flowId, 'count')
    ]
  });
}
async function handleNewOrderGenderSelect(interaction) {
  const flowId =
    interaction.customId.replace('new_order_gender_', '');

  const pending =
    pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: '❌ 這筆下單流程已過期，請重新填寫。',
      components: []
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: '❌ 只有下單者可以操作這個選單。',
      flags: 64
    });
  }

  pending.gender = interaction.values[0];
  pendingNewOrders.set(flowId, pending);

  const playerOptions =
    await getQualifiedPlayerOptions(pending);

  if (!playerOptions.length) {
    return interaction.update({
      content:
        `🎮 遊戲：${pending.game}\n` +
        `📌 項目：${pending.item}\n` +
        (
          pending.game === '特戰英豪'
            ? `🏅 段位：${pending.rank || '未填寫'}\n`
            : ''
        ) +
        `👥 人數：${pending.playerCount || '自訂'}\n` +
        `🚻 性別偏好：${pending.gender}\n\n` +
        `❌ 目前沒有符合資格的陪陪，請聯繫客服協助安排。`,
      components: []
    });
  }

  const maxPlayerCount =
    Math.max(1, Number(pending.playerCount || 1));
  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(`new_order_player_${flowId}`)
      .setPlaceholder(
        maxPlayerCount > 1
          ? `可選 0～${maxPlayerCount} 位指定陪陪`
          : '請選擇陪陪'
      )
      .setMinValues(1)
      .setMaxValues(
        Math.min(
          maxPlayerCount,
          playerOptions.length
        )
      )
      .addOptions(playerOptions);

  const row =
    new ActionRowBuilder()
      .addComponents(menu);

  return interaction.update({
    content:
      `🎮 遊戲：${pending.game}\n` +
       `📌 項目：${pending.item}\n` +
        (
          pending.game === '特戰英豪'
            ? `🏅 段位：${pending.rank || '未填寫'}\n`
            : ''
        ) +
      `👥 人數：${pending.playerCount || '自訂'}\n` +
      `🚻 性別偏好：${pending.gender}\n\n` +
      `請選擇陪陪：\n` +
      `🟢 在線：可直接安排\n` +
      `⚪ 不在線：可查看可接單時間並預約`,
    components: [
      row,
      buildOrderBackRow(flowId, 'gender')
    ]
  });
}
async function handleNewOrderPlayerSelect(interaction) {
  const flowId =
    interaction.customId.replace('new_order_player_', '');

  const pending =
    pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: '❌ 這筆下單流程已過期，請重新填寫。',
      components: []
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: '❌ 只有下單者可以操作這個選單。',
      flags: 64
    });
  }

  const selectedValues =
    interaction.values || [];
  if (selectedValues.includes('none')) {
    pending.selectedPlayerType = 'none';
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pendingNewOrders.set(flowId, pending);
    return await showDurationSelect(interaction, flowId, pending);
  } 
  const onlineIds =
    selectedValues
      .filter(value => value.startsWith('online_'))
      .map(value => value.replace('online_', ''));
  const reserveIds =
    selectedValues
      .filter(value => value.startsWith('reserve_'))
      .map(value => value.replace('reserve_', ''));
  const selectedIds =
    [...onlineIds, ...reserveIds]
      .map(id => String(id).trim())
      .filter(Boolean);
  if (!selectedIds.length) {
    pending.selectedPlayerType = 'none';
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pendingNewOrders.set(flowId, pending);
    return await showDurationSelect(interaction, flowId, pending);
  }
  pending.selectedPlayerIds = selectedIds;
  pending.selectedPlayerId = selectedIds[0];
  if (reserveIds.length > 0) {
    pending.selectedPlayerType = 'reserve';
    pendingNewOrders.set(flowId, pending);
    const { data: players } =
      await supabase
        .from('players')
        .select('*')
        .in('discord_id', reserveIds);
    const availableText =
      (players || [])
        .map(player => {
          return `<@${player.discord_id}>：${formatAvailableTime(player)}`;
        })
        .join('\n') || '未填寫可接時間';
    const modal =
      new ModalBuilder()
        .setCustomId(`submit_new_order_reserve_time_${flowId}`)
        .setTitle('填寫預約時間');
    const reserveInput =
      new TextInputBuilder()
        .setCustomId('reserve_time')
        .setLabel('請輸入想預約的時間')
        .setPlaceholder('例如：今晚 20:00、明天 21:30、週六晚上')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(reserveInput)
    );
    return await interaction.showModal(modal);
  } 
  pending.selectedPlayerType = 'online';
  pendingNewOrders.set(flowId, pending);
  return await showDurationSelect(interaction, flowId, pending);
}
async function showDurationSelect(interaction, flowId, pending) {
  const isValorantTech =
    pending.game === '特戰英豪' &&
    pending.item === '技術陪玩';
  const isValorantGameBased =
    isValorantTech &&
    isValorantRankGameBased(pending.rank);
  const options =
    isValorantGameBased
      ? [
          {
            label: '1 局',
            value: 'game_1',
            description: '以局數計算'
          },
          {
            label: '3 局',
            value: 'game_3',
            description: '以局數計算'
          },
          {
            label: '5 局',
            value: 'game_5',
            description: '以局數計算'
          },
          {
            label: '自訂局數',
            value: 'game_custom',
            description: '由客服協助確認局數'
          }
        ]
      : [
          {
            label: '30 分鐘',
            value: '30',
            description: '半小時'
          },
          {
            label: '60 分鐘',
            value: '60',
            description: '一小時'
          },
          {
            label: '90 分鐘',
            value: '90',
            description: '一小時半'
          },
          {
            label: '120 分鐘',
            value: '120',
            description: '兩小時'
          },
          {
            label: '自訂',
            value: 'custom',
            description: '由客服協助確認時間'
          }
        ];

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(`new_order_duration_${flowId}`)
      .setPlaceholder(
        isValorantGameBased
          ? '請選擇局數'
          : '請選擇時間段'
      )
      .addOptions(options);

  const row =
    new ActionRowBuilder()
      .addComponents(menu);

  const selectedPlayerIds =
    Array.isArray(pending.selectedPlayerIds)
      ? pending.selectedPlayerIds
          .map(id => String(id).trim())
          .filter(Boolean)
      : [];
  const playerText =
    pending.selectedPlayerType === 'none' || !selectedPlayerIds.length
      ? '不指定陪陪'
      : selectedPlayerIds.map(id => `<@${id}>`).join('、');
  return interaction.update({
    content:
      `🎮 遊戲：${pending.game}\n` +
       `📌 項目：${pending.item}\n` +
        (
          pending.game === '特戰英豪'
            ? `🏅 段位：${pending.rank || '未填寫'}\n`
            : ''
        ) +
      `👥 人數：${pending.playerCount || '自訂'}\n` +
      `🚻 性別偏好：${pending.gender}\n` +
      `🌟 指定陪陪：${playerText}\n\n` +
      (
        isValorantGameBased
          ? `請選擇需要的局數：`
          : `請選擇需要的時間段：`
      ),
    components: [
      row,
      buildOrderBackRow(flowId, 'player')
    ]
  });
}
async function handleNewOrderDurationSelect(interaction) {
  const flowId =
    interaction.customId.replace('new_order_duration_', '');

  const pending =
    pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: '❌ 這筆下單流程已過期，請重新填寫。',
      components: []
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: '❌ 只有下單者可以操作這個選單。',
      flags: 64
    });
  }

  const value =
    interaction.values[0];
  const isValorantTech =
    pending.game === '特戰英豪' &&
    pending.item === '技術陪玩';
  const isValorantGameBased =
    isValorantTech &&
    isValorantRankGameBased(pending.rank);
  if (isValorantGameBased) {
    if (value === 'game_custom') {
      pending.duration = '自訂局數';
      pending.durationMinutes = 0;
      pending.gameCount = 0;
    } else {
      const count =
        Number(value.replace('game_', ''));
      pending.duration = `${count} 局`;
      pending.durationMinutes = 0;
      pending.gameCount = count;
    }
  } else {
    if (value === 'custom') {
      pending.duration = '自訂';
      pending.durationMinutes = 0;
    } else {
      pending.duration = `${value} 分鐘`;
      pending.durationMinutes = Number(value);
    }
    pending.gameCount = 0;
  }
  pendingNewOrders.set(flowId, pending);
  return await askNewOrderNoteChoice(interaction, flowId, pending);
}
async function submitNewOrderReserveTime(interaction) {
  const flowId =
    interaction.customId.replace('submit_new_order_reserve_time_', '');

  const pending =
    pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.reply({
      content: '❌ 這筆下單流程已過期，請重新填寫。',
      flags: 64
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: '❌ 只有下單者可以操作這個表單。',
      flags: 64
    });
  }

  const reserveTime =
    interaction.fields.getTextInputValue('reserve_time');

  pending.reservedTime = reserveTime;
  pending.duration = '預約';
  pending.durationMinutes = 0;
  pendingNewOrders.set(flowId, pending);

  return await askNewOrderNoteChoice(interaction, flowId, pending);
}
async function askNewOrderNoteChoice(interaction, flowId, pending) {
  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`new_order_note_yes_${flowId}`)
          .setLabel('我要填備註')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`new_order_note_no_${flowId}`)
          .setLabel('不填備註')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`new_order_back_duration_${flowId}`)
          .setLabel('⬅️ 上一步')
          .setStyle(ButtonStyle.Secondary)
      );

  const selectedPlayerIds =
    Array.isArray(pending.selectedPlayerIds)
      ? pending.selectedPlayerIds
          .map(id => String(id).trim())
          .filter(Boolean)
      : [];
  const playerText =
    pending.selectedPlayerType === 'none' || !selectedPlayerIds.length
      ? '不指定陪陪'
      : selectedPlayerIds.map(id => `<@${id}>`).join('、');
  const timeText =
    pending.selectedPlayerType === 'reserve'
      ? pending.reservedTime
      : pending.duration;

  const payload = {
    content:
      `📝 需求即將送出，是否要填寫備註？\n\n` +
      `🎮 遊戲：${pending.game}\n` +
       `📌 項目：${pending.item}\n` +
        (
          pending.game === '特戰英豪'
            ? `🏅 段位：${pending.rank || '未填寫'}\n`
            : ''
        ) +
      `👥 人數：${pending.playerCount || '自訂'}\n` +
      `🚻 性別偏好：${pending.gender}\n` +
      `🌟 指定陪陪：${playerText}\n` +
      `🕒 時間：${timeText || '未填寫'}\n\n` +
      `不填則預設為：無`,
    components: [row]
  };

  if (interaction.isModalSubmit()) {
    return interaction.reply({
      ...payload,
      flags: 64
    });
  }

  return interaction.update(payload);
}
async function handleNewOrderBack(interaction) {
  const raw =
    interaction.customId.replace('new_order_back_', '');

  const firstUnderscore =
    raw.indexOf('_');

  const target =
    raw.slice(0, firstUnderscore);

  const flowId =
    raw.slice(firstUnderscore + 1);

  const pending =
    pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: '❌ 這筆下單流程已過期，請重新填寫。',
      components: []
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: '❌ 只有下單者可以操作這個按鈕。',
      flags: 64
    });
  }

  if (target === 'game') {
    pending.game = '';
    pending.item = '';
    pending.playerCount = 1;
    pending.gender = '不指定';
    pending.selectedPlayerType = 'none';
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pending.duration = '';
    pending.durationMinutes = 0;
    pending.reservedTime = '';
    pending.note = '無';
    pendingNewOrders.set(flowId, pending);

    const menu =
      new StringSelectMenuBuilder()
        .setCustomId(`new_order_game_${flowId}`)
        .setPlaceholder('請選擇遊戲 / 服務類型')
        .addOptions([
          {
            label: '特戰英豪',
            description: 'VALORANT 陪玩 / 技術單',
            value: '特戰英豪'
          },
          {
            label: '三角洲行動',
            description: '三角洲護航 / 保底 / 娛樂',
            value: '三角洲行動'
          },
          {
            label: 'PUBG',
            description: 'PUBG 陪玩',
            value: 'PUBG'
          },
          {
            label: 'STEAM',
            description: 'Steam 遊戲陪玩',
            value: 'STEAM'
          },
          {
            label: '陪聊服務',
            description: '聊天 / 陪伴 / 出氣',
            value: '陪聊服務'
          },
          {
            label: '打賞禮物',
            description: '打賞 / 禮物單',
            value: '打賞禮物'
          }
        ]);

    const row =
      new ActionRowBuilder()
        .addComponents(menu);

    return interaction.update({
      content: '🎮 請重新選擇你要下單的遊戲 / 服務：',
      components: [row]
    });
  }

  if (target === 'item') {
    pending.item = '';
    pending.playerCount = 1;
    pending.gender = '不指定';
    pending.selectedPlayerType = 'none';
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pending.duration = '';
    pending.durationMinutes = 0;
    pending.reservedTime = '';
    pending.note = '無';
    pendingNewOrders.set(flowId, pending);

    const options =
      getOrderItemOptions(pending.game)
        .slice(0, 25)
        .map(item => ({
          label: item.label.slice(0, 100),
          description: item.description.slice(0, 100),
          value: item.value
        }));

    const menu =
      new StringSelectMenuBuilder()
        .setCustomId(`new_order_item_${flowId}`)
        .setPlaceholder('請選擇項目')
        .addOptions(options);

    const row =
      new ActionRowBuilder()
        .addComponents(menu);

    return interaction.update({
      content:
        `🎮 遊戲：${pending.game}\n\n` +
        `請重新選擇你要的項目：`,
      components: [
        row,
        buildOrderBackRow(flowId, 'game')
      ]
    });
  }
  if (target === 'rank') {
    pending.rank = '';
    pending.playerCount = 1;
    pending.gender = '不指定';
    pending.selectedPlayerType = 'none';
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pending.duration = '';
    pending.durationMinutes = 0;
    pending.reservedTime = '';
    pending.note = '無';
    pendingNewOrders.set(flowId, pending);
    const menu =
      new StringSelectMenuBuilder()
        .setCustomId(`new_order_rank_${flowId}`)
        .setPlaceholder('請選擇要打的段位')
        .addOptions(getValorantRankOptions());
    const row =
      new ActionRowBuilder()
        .addComponents(menu);
    return interaction.update({
      content:
        `🎮 遊戲：${pending.game}\n` +
        `📌 項目：${pending.item}\n\n` +
        `請重新選擇這次要打的段位：`,
      components: [
        row,
        buildOrderBackRow(flowId, 'item')
      ]
    });
  }
  if (target === 'count') {
    pending.playerCount = 1;
    pending.gender = '不指定';
    pending.selectedPlayerType = 'none';
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pending.duration = '';
    pending.durationMinutes = 0;
    pending.reservedTime = '';
    pending.note = '無';
    pendingNewOrders.set(flowId, pending);

    const menu =
      new StringSelectMenuBuilder()
        .setCustomId(`new_order_count_${flowId}`)
        .setPlaceholder('請選擇需要幾位陪陪')
        .addOptions([
          {
            label: '1 位陪陪',
            value: '1',
            description: '單陪'
          },
          {
            label: '2 位陪陪',
            value: '2',
            description: '雙陪'
          },
          {
            label: '3 位陪陪',
            value: '3',
            description: '三陪'
          },
          {
            label: '自訂',
            value: 'custom',
            description: '由客服協助確認人數'
          }
        ]);

    const row =
      new ActionRowBuilder()
        .addComponents(menu);

    return interaction.update({
      content:
        `🎮 遊戲：${pending.game}\n` +
        `📌 項目：${pending.item}\n` +
        (
          pending.game === '特戰英豪'
            ? `🏅 段位：${pending.rank || '未填寫'}\n`
            : ''
        ) +
        `請重新選擇需要幾位陪陪：`,
      components: [
        row,
        buildOrderBackRow(
          flowId,
          pending.game === '特戰英豪' ? 'rank' : 'item'
        )
      ]
    });
  }

  if (target === 'gender') {
    pending.gender = '不指定';
    pending.selectedPlayerType = 'none';
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pending.duration = '';
    pending.durationMinutes = 0;
    pending.reservedTime = '';
    pending.note = '無';
    pendingNewOrders.set(flowId, pending);

    const menu =
      new StringSelectMenuBuilder()
        .setCustomId(`new_order_gender_${flowId}`)
        .setPlaceholder('請選擇陪陪性別偏好')
        .addOptions([
          {
            label: '男陪',
            value: '男陪',
            description: '只看男陪'
          },
          {
            label: '女陪',
            value: '女陪',
            description: '只看女陪'
          },
          {
            label: '男女皆可',
            value: '男女皆可',
            description: '男陪女陪都可以'
          },
          {
            label: '不指定',
            value: '不指定',
            description: '不限制性別'
          }
        ]);

    const row =
      new ActionRowBuilder()
        .addComponents(menu);

    return interaction.update({
      content:
        `🎮 遊戲：${pending.game}\n` +
        `📌 項目：${pending.item}\n` +
        `👥 人數：${pending.playerCount || '自訂'}\n\n` +
        `請重新選擇陪陪性別偏好：`,
      components: [
        row,
        buildOrderBackRow(flowId, 'count')
      ]
    });
  }

  if (target === 'player') {
    pending.selectedPlayerType = 'none';
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pending.duration = '';
    pending.durationMinutes = 0;
    pending.reservedTime = '';
    pending.note = '無';
    pendingNewOrders.set(flowId, pending);

    const playerOptions =
      await getQualifiedPlayerOptions(pending);

    if (!playerOptions.length) {
      return interaction.update({
        content:
          `🎮 遊戲：${pending.game}\n` +
          `📌 項目：${pending.item}\n` +
          `👥 人數：${pending.playerCount || '自訂'}\n` +
          `🚻 性別偏好：${pending.gender}\n\n` +
          `❌ 目前沒有符合資格的陪陪，請聯繫客服協助安排。`,
        components: [
          buildOrderBackRow(flowId, 'gender')
        ]
      });
    }

    const menu =
      new StringSelectMenuBuilder()
        .setCustomId(`new_order_player_${flowId}`)
        .setPlaceholder('請選擇陪陪，或選擇不指定')
        .addOptions(playerOptions);

    const row =
      new ActionRowBuilder()
        .addComponents(menu);

    return interaction.update({
      content:
        `🎮 遊戲：${pending.game}\n` +
        `📌 項目：${pending.item}\n` +
        `👥 人數：${pending.playerCount || '自訂'}\n` +
        `🚻 性別偏好：${pending.gender}\n\n` +
        `請重新選擇陪陪：`,
      components: [
        row,
        buildOrderBackRow(flowId, 'gender')
      ]
    });
  }

  if (target === 'duration') {
    pending.duration = '';
    pending.durationMinutes = 0;
    pending.reservedTime = '';
    pending.note = '無';
    pendingNewOrders.set(flowId, pending);

    return await showDurationSelect(
      interaction,
      flowId,
      pending
    );
  }

  return interaction.reply({
    content: '❌ 找不到上一個步驟',
    flags: 64
  });
}
async function openNewOrderNoteModal(interaction) {
  const flowId =
    interaction.customId.replace('new_order_note_yes_', '');

  const pending =
    pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.reply({
      content: '❌ 這筆下單流程已過期，請重新填寫。',
      flags: 64
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: '❌ 只有下單者可以操作這個按鈕。',
      flags: 64
    });
  }

  const modal =
    new ModalBuilder()
      .setCustomId(`submit_new_order_note_${flowId}`)
      .setTitle('填寫需求備註');

  const noteInput =
    new TextInputBuilder()
      .setCustomId('note')
      .setLabel('請輸入備註')
      .setPlaceholder('例如：希望語音、不要太吵、指定風格、特殊需求')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(noteInput)
  );

  return interaction.showModal(modal);
}
async function handleNewOrderNoNote(interaction) {
  const flowId =
    interaction.customId.replace('new_order_note_no_', '');

  const pending =
    pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: '❌ 這筆下單流程已過期，請重新填寫。',
      components: []
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.editReply({
      content: '❌ 只有下單者可以操作這個按鈕。',
      components: []
    });
  }

  pending.note = '無';
  pendingNewOrders.set(flowId, pending);

  return await createWaitingQuoteOrder(
    interaction,
    flowId,
    pending
  );
}
async function submitNewOrderNote(interaction) {
  const flowId =
    interaction.customId.replace('submit_new_order_note_', '');

  const pending =
    pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.reply({
      content: '❌ 這筆下單流程已過期，請重新填寫。',
      flags: 64
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: '❌ 只有下單者可以操作這個表單。',
      flags: 64
    });
  }

  const note =
    interaction.fields.getTextInputValue('note') || '無';

  pending.note = note;
  pendingNewOrders.set(flowId, pending);

  return await createWaitingQuoteOrder(interaction, flowId, pending);
}
async function createWaitingQuoteOrder(interaction, flowId, pending) {
  const orderNo =
    `DQ-${Date.now()}`;

  const service =
    `${pending.game}｜${pending.item}`;

  const timeText =
    pending.selectedPlayerType === 'reserve'
      ? pending.reservedTime
      : pending.duration;

  const selectedPlayerIds =
  Array.isArray(pending.selectedPlayerIds)
    ? pending.selectedPlayerIds
        .map(id => String(id).trim())
        .filter(Boolean)
    : [];
  const preferredPlayer =
    selectedPlayerIds.length
      ? selectedPlayerIds.join(',')
      : null;

  const { data: order, error } =
    await supabase
      .from('play_orders')
      .insert({
        order_no: orderNo,
        customer_id: pending.userId,
        customer_username: pending.username || interaction.user.username,
        channel_id: pending.channelId || interaction.channel.id,

        game: pending.game,
        order_item: pending.item,
        rank_preference: pending.rank || null,
        player_count: pending.playerCount || 0,
        gender_preference: pending.gender,
        preferred_player_type: pending.selectedPlayerType,

        service,
        preferred_player: preferredPlayer,
        reserved_player:
          pending.selectedPlayerType === 'reserve'
            ? preferredPlayer
            : null,
        reserved_time:
          pending.selectedPlayerType === 'reserve'
            ? pending.reservedTime
            : null,

        duration_minutes: pending.durationMinutes || 0,
        duration_text: timeText || '未填寫',

        note: pending.note || '無',
        price: 0,
        final_price: 0,
        original_price: 0,
        discount_rate: 1,
        discount_amount: 0,
        payment_method: '未選擇',
        paid: false,

        status: 'waiting_quote',
        quote_status: 'waiting_quote',
        confirmed_by_customer: false
      })
      .select()
      .single();

  if (error || !order) {
    console.error('[新下單] 建立待報價訂單失敗', error);
    const payload = {
      content:
        '❌ 建立訂單失敗，請檢查 Supabase play_orders 欄位是否完整。\n' +
        `錯誤：${error?.message || '未知錯誤'}`,
      components: []
    };
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply(payload).catch(async () => {
        return interaction.followUp({
          ...payload,
          flags: 64
        }).catch(() => {});
      });
    }
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      return interaction.update(payload).catch(async () => {
        return interaction.reply({
          ...payload,
          flags: 64
        }).catch(() => {});
      });
    }
    return interaction.reply({
      ...payload,
      flags: 64
    }).catch(() => {});
  }
  pendingNewOrders.delete(flowId);

  const embed =
    new EmbedBuilder()
      .setColor('#ffd166')
      .setTitle('🧾 已送出需求｜等待客服報價')
      .addFields(
        {
          name: '📌 訂單編號',
          value: order.order_no,
          inline: true
        },
        {
          name: '🎮 遊戲 / 服務',
          value: pending.game,
          inline: true
        },
        {
          name: '📦 項目',
          value: pending.item,
          inline: true
        },
        {
          name: '🏅 段位',
          value: pending.rank || '不指定',
          inline: true
        },
        {
          name: '👥 陪陪人數',
          value: String(pending.playerCount || '自訂'),
          inline: true
        },
        {
          name: '🚻 性別偏好',
          value: pending.gender || '不指定',
          inline: true
        },
        {
          name: '🌟 陪陪',
          value: selectedPlayerIds.length
            ? selectedPlayerIds.map(id => `<@${id}>`).join('、')
            : '不指定',
        },
        {
          name: '🕒 時間',
          value: timeText || '未填寫',
          inline: true
        },
        {
          name: '📝 備註',
          value: pending.note || '無',
          inline: false
        }
      )
      .setDescription(
        `需求已送出，請等待客服報價。\n` +
        `客服填寫金額後，系統會讓你選擇優惠券與付款方式。`
      )
      .setTimestamp();

  const payload = {
    content: `<@${pending.userId}> 你的需求已送出，請等待客服報價。`,
    embeds: [embed],
    components: []
  };

  if (interaction.isModalSubmit()) {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(async () => {
        await interaction.followUp({
          ...payload,
          flags: 64
        }).catch(() => {});
      });
    } else {
      await interaction.reply({
        ...payload,
        flags: 64
      }).catch(() => {});
    }
  } else {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(async () => {
        await interaction.followUp({
          ...payload,
          flags: 64
        }).catch(() => {});
      });
    } else {
      await interaction.update(payload).catch(async () => {
        await interaction.reply({
          ...payload,
          flags: 64
        }).catch(() => {});
      });
    }
  }
  await sendStaffQuotePanel(order);
  return true;
}
async function sendStaffQuotePanel(order) {
  const channel =
    await client.channels
      .fetch(order.channel_id)
      .catch(() => null);

  if (!channel) {
    console.error('[新下單] 找不到訂單頻道，無法送客服報價面板');
    return;
  }

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`staff_quote_price_${order.id}`)
          .setLabel('客服填寫金額')
          .setEmoji('💰')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`dispatch_assign_players_${order.id}`)
          .setLabel('客服選擇陪陪')
          .setEmoji('🌟')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`staff_edit_order_${order.id}`)
          .setLabel('修改訂單內容')
          .setEmoji('🛠️')
          .setStyle(ButtonStyle.Secondary)
      );
  await channel.send({
    content:
      `<@&${process.env.STAFF_ROLE}> 有新的需求等待報價。\n` +
      `請客服確認陪陪與金額後，再讓闆闆選擇付款方式。`,
    embeds: [
      new EmbedBuilder()
        .setColor('#66ccff')
        .setTitle('🧾 客服報價區')
        .addFields(
          {
            name: '📌 訂單編號',
            value: order.order_no || String(order.id),
            inline: true
          },
          {
            name: '👤 客人',
            value: `<@${order.customer_id}>`,
            inline: true
          },
          {
            name: '🎮 服務',
            value: order.service || '未填寫',
            inline: false
          },
          {
            name: '🏅 段位',
            value: order.rank_preference || '不指定',
            inline: true
          },
          {
            name: '👥 人數',
            value: String(order.player_count || '自訂'),
            inline: true
          },
          {
            name: '🚻 性別偏好',
            value: order.gender_preference || '不指定',
            inline: true
          },
          {
            name: '🕒 時間',
            value: order.reserved_time || order.duration_text || '未填寫',
            inline: true
          },
          {
            name: '📝 備註',
            value: order.note || '無',
            inline: false
          }
        )
        .setDescription(
          `這則訊息是客服操作用。\n` +
          `目前客人尚未付款，也尚未正式派單。`
        )
        .setTimestamp()
    ],
    components: [row]
  });
}
async function openStaffQuotePriceModal(interaction) {
  if (
    !interaction.member.roles.cache.has(process.env.STAFF_ROLE) &&
    !interaction.member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return interaction.reply({
      content: '❌ 只有客服可以填寫報價',
      flags: 64
    });
  }

  const orderId =
    interaction.customId.replace('staff_quote_price_', '');

  const modal =
    new ModalBuilder()
      .setCustomId(`submit_staff_quote_price_${orderId}`)
      .setTitle('客服填寫訂單金額');

  const priceInput =
    new TextInputBuilder()
      .setCustomId('price')
      .setLabel('請輸入原價金額')
      .setPlaceholder('例如：499')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(priceInput)
  );

  return interaction.showModal(modal);
}
async function submitStaffQuotePrice(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  if (
    !interaction.member.roles.cache.has(process.env.STAFF_ROLE) &&
    !interaction.member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return interaction.editReply({
      content: '❌ 只有客服可以填寫報價'
    });
  }

  const orderId =
    interaction.customId.replace('submit_staff_quote_price_', '');

  const priceText =
    interaction.fields.getTextInputValue('price');

  const price =
    Number(priceText.replace(/[^\d]/g, ''));

  if (!price || price <= 0) {
    return interaction.editReply({
      content: '❌ 金額格式錯誤，請輸入大於 0 的數字'
    });
  }

  const { data: order, error } =
    await supabase
      .from('play_orders')
      .update({
        price,
        final_price: price,
        original_price: price,
        quoted_by: interaction.user.id,
        quote_status: 'quoted',
        status: 'quoted'
      })
      .eq('id', orderId)
      .select()
      .single();

  if (error || !order) {
    console.error('[客服報價] 更新金額失敗', error);
    return interaction.editReply({
      content: '❌ 更新報價失敗'
    });
  }

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor('#ffd166')
        .setTitle('💰 客服已完成報價')
        .setDescription(
          `訂單編號：${order.order_no || order.id}\n` +
          `報價金額：NT$${price.toLocaleString('zh-TW')}\n` +
          `報價客服：<@${interaction.user.id}>\n\n` +
          `<@${order.customer_id}> 請選擇是否使用優惠券。`
        )
        .setTimestamp()
    ],
    components: [
      new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`quote_use_coupon_${order.id}`)
            .setLabel('使用優惠券')
            .setEmoji('🎟️')
            .setStyle(ButtonStyle.Success),

          new ButtonBuilder()
            .setCustomId(`quote_no_coupon_${order.id}`)
            .setLabel('不使用優惠券')
            .setStyle(ButtonStyle.Secondary)
        )
    ]
  });

  return interaction.editReply({
    content: `✅ 已填寫報價 NT$${price.toLocaleString('zh-TW')}`
  });
}
async function handleQuoteNoCoupon(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }
  const orderId =
    interaction.customId.replace('quote_no_coupon_', '');

  const { data: order, error: orderError } =
    await supabase
      .from('play_orders')
      .select('*')
      .eq('id', orderId)
      .single();

  if (orderError || !order) {
    console.error('[報價流程] 讀取訂單失敗', orderError);
    return interaction.editReply({
      content: '❌ 找不到訂單'
    });
  }

  if (order.customer_id !== interaction.user.id) {
    return interaction.editReply({
      content: '❌ 只有下單的闆闆可以選擇優惠券'
    });
  }

  const { data: updatedOrder, error: updateError } =
    await supabase
      .from('play_orders')
      .update({
        coupon_text: '未使用優惠券',
        discount_rate: 1,
        discount_amount: 0
      })
      .eq('id', orderId)
      .eq('customer_id', interaction.user.id)
      .select()
      .single();

  if (updateError || !updatedOrder) {
    console.error('[報價流程] 不使用優惠券失敗', updateError);
    return interaction.editReply({
      content: '❌ 設定優惠券失敗'
    });
  }

  await sendPaymentMethodSelect(interaction.channel, updatedOrder);

  return interaction.editReply({
    content: '✅ 已選擇不使用優惠券'
  });
}
function getCouponDiscount(itemName = '') {
  const name = String(itemName || '');

  if (name.includes('95折')) {
    return {
      rate: 0.95,
      label: '95折券'
    };
  }

  if (name.includes('9折')) {
    return {
      rate: 0.9,
      label: '9折券'
    };
  }

  if (name.includes('8折')) {
    return {
      rate: 0.8,
      label: '8折券'
    };
  }

  return {
    rate: 1,
    label: name || '未知優惠券'
  };
}

function getCouponMaxDiscountPrice(itemName = '') {
  const name = String(itemName || '');

  if (name.includes('95折')) {
    return 500;
  }

  if (name.includes('9折')) {
    return 800;
  }

  // 8折券目前先不限制金額
  return null;
}
async function handleQuoteUseCoupon(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }

  const orderId =
    interaction.customId.replace('quote_use_coupon_', '');

  const { data: order, error } =
    await supabase
      .from('play_orders')
      .select('*')
      .eq('id', orderId)
      .single();

  if (error || !order) {
    return interaction.editReply({
      content: '❌ 找不到訂單'
    });
  }

  if (order.customer_id !== interaction.user.id) {
    return interaction.editReply({
      content: '❌ 只有下單的闆闆可以選擇優惠券'
    });
  }

  const { data: coupons, error: couponError } =
    await supabase
      .from('user_items')
      .select('*')
      .eq('user_id', interaction.user.id)
      .or(
        'item_type.eq.coupon,item_name.ilike.%折券%,item_name.ilike.%優惠券%'
      )
      .order('created_at', { ascending: false });

  if (couponError) {
    console.error('[報價優惠券] 讀取優惠券失敗', couponError);
    return interaction.editReply({
      content: '❌ 讀取優惠券失敗，請稍後再試'
    });
  }

  if (!coupons || coupons.length === 0) {
    return interaction.editReply({
      content:
        '❌ 你目前沒有可使用的優惠券。\n' +
        '請改選「不使用優惠券」。',
      components: []
    });
  }

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(`quote_select_coupon_${order.id}`)
      .setPlaceholder('請選擇要使用的優惠券')
      .addOptions(
        coupons.slice(0, 25).map(coupon => {
          const discount =
            getCouponDiscount(coupon.item_name);

          return {
            label: String(coupon.item_name).slice(0, 100),
            description:
              `${discount.label}｜${coupon.description || '優惠券'}`
                .slice(0, 100),
            value: String(coupon.id)
          };
        })
      );

  const row =
    new ActionRowBuilder()
      .addComponents(menu);

  return interaction.editReply({
    content:
      `🎟️ 請選擇要使用的優惠券：\n\n` +
      `訂單金額：NT$${Number(order.final_price || order.price || 0).toLocaleString('zh-TW')}`,
    components: [row]
  });
}
async function handleQuoteSelectCoupon(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }

  const orderId =
    interaction.customId.replace('quote_select_coupon_', '');

  const couponId =
    interaction.values[0];

  const { data: order, error: orderError } =
    await supabase
      .from('play_orders')
      .select('*')
      .eq('id', orderId)
      .single();

  if (orderError || !order) {
    return interaction.editReply({
      content: '❌ 找不到訂單'
    });
  }

  if (order.customer_id !== interaction.user.id) {
    return interaction.editReply({
      content: '❌ 只有下單的闆闆可以使用優惠券'
    });
  }

  const { data: coupon, error: couponError } =
    await supabase
      .from('user_items')
      .select('*')
      .eq('id', Number(couponId))
      .eq('user_id', interaction.user.id)
      .maybeSingle();
  if (
    couponError ||
    !coupon ||
    !(
      coupon.item_type === 'coupon' ||
      String(coupon.item_name || '').includes('折券') ||
      String(coupon.item_name || '').includes('優惠券')
    )
  ) {
    return interaction.editReply({
      content: '❌ 找不到這張優惠券，可能已經被使用'
    });
  }

  const originalPrice =
    Number(order.original_price || order.price || order.final_price || 0);

  if (!originalPrice || originalPrice <= 0) {
    return interaction.editReply({
      content: '❌ 訂單金額錯誤，請聯繫客服重新報價'
    });
  }

  const maxPrice =
    getCouponMaxDiscountPrice(coupon.item_name);

  if (maxPrice && originalPrice > maxPrice) {
    return interaction.editReply({
      content:
        `❌ 這張優惠券只限 NT$${maxPrice} 內訂單使用。\n` +
        `目前訂單金額：NT$${originalPrice.toLocaleString('zh-TW')}`
    });
  }

  const discount =
    getCouponDiscount(coupon.item_name);

  const finalPrice =
    Math.floor(originalPrice * discount.rate);

  const discountAmount =
    originalPrice - finalPrice;

  const { data: updatedOrder, error: updateError } =
    await supabase
      .from('play_orders')
      .update({
        discount_rate: discount.rate,
        discount_amount: discountAmount,
        final_price: finalPrice,
        coupon_text: coupon.item_name
      })
      .eq('id', order.id)
      .select()
      .single();

  if (updateError || !updatedOrder) {
    console.error('[報價優惠券] 更新訂單失敗', updateError);
    return interaction.editReply({
      content: '❌ 套用優惠券失敗'
    });
  }

  // 刪除已使用優惠券
  await supabase
    .from('user_items')
    .delete()
    .eq('id', coupon.id);

  // 寫入 used_coupons，如果沒有這張表會失敗但不影響主流程
  const { error: usedCouponError } =
    await supabase
      .from('used_coupons')
      .insert({
        user_id: interaction.user.id,
        item_id: coupon.id,
        item_name: coupon.item_name,
        order_id: order.id,
        discount_rate: discount.rate,
        discount_amount: discountAmount
      });
  if (usedCouponError) {
    console.log('[優惠券使用紀錄失敗]', usedCouponError.message);
  } 
  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor('#57F287')
        .setTitle('🎟️ 優惠券已套用')
        .setDescription(
          `<@${interaction.user.id}> 已使用：${coupon.item_name}\n\n` +
          `原價：NT$${originalPrice.toLocaleString('zh-TW')}\n` +
          `折扣：NT$${discountAmount.toLocaleString('zh-TW')}\n` +
          `折後金額：NT$${finalPrice.toLocaleString('zh-TW')}`
        )
        .setTimestamp()
    ]
  });

  await sendPaymentMethodSelect(interaction.channel, updatedOrder);

  return interaction.editReply({
    content: '✅ 優惠券已套用，請繼續選擇付款方式',
    components: []
  });
}
async function sendPaymentMethodSelect(channel, order) {
  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(`quote_payment_method_${order.id}`)
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
          description: '選擇後立即由餘額扣款',
          value: '儲值卡'
        },
        {
          label: '月結',
          description: '選擇後立即扣除月結額度',
          value: '月結'
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

  await channel.send({
    content:
      `<@${order.customer_id}> 請選擇付款方式：`,
    components: [row]
  });
}
async function handleQuotePaymentMethodSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }

  const orderId =
    interaction.customId.replace('quote_payment_method_', '');

  const paymentMethod =
    interaction.values[0];

  const { data: order, error } =
    await supabase
      .from('play_orders')
      .select('*')
      .eq('id', orderId)
      .single();

  if (error || !order) {
    return interaction.editReply({
      content: '❌ 找不到訂單'
    });
  }

  if (order.customer_id !== interaction.user.id) {
    return interaction.editReply({
      content: '❌ 只有下單的闆闆可以選擇付款方式'
    });
  }
  if (order.paid) {
    return interaction.editReply({
      content:
        `❌ 這張訂單已經完成付款，不能重複選擇付款方式。\n` +
        `目前付款方式：${order.payment_method || '已付款'}`
    });
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
  let paidNow = false;
  let paidAt = null;
  if (isWalletPayment(paymentMethod)) {
    try {
      if (!paymentHelpers.payOrderByWallet) {
        throw new Error('錢包付款函式尚未接入 dispatchSystem');
      }
      const result = await paymentHelpers.payOrderByWallet(order);
      paidNow = true;
      paidAt = new Date().toISOString();
      await interaction.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor('#66ccff')
            .setTitle('💳 儲值卡 / 錢包付款完成')
            .setDescription(
              `<@${order.customer_id}> 已使用儲值卡 / 錢包付款。\n\n` +
              `扣款金額：${result.amount} 星雨幣\n` +
              `剩餘餘額：${result.finalCoins} 星雨幣`
            )
            .setTimestamp()
        ]
      });
    
    } catch (err) {
      return interaction.editReply({
        content: `❌ 儲值卡付款失敗：${err.message}`
      });
    }
  } else if (isMonthlyPayment(paymentMethod)) {
    try {
      if (!paymentHelpers.payOrderByMonthly) {
        throw new Error('月結付款函式尚未接入 dispatchSystem');
      }
      const result = await paymentHelpers.payOrderByMonthly(order);
      paidNow = true;
      paidAt = new Date().toISOString();
      await interaction.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor('#66ccff')
            .setTitle('🌙 月結付款完成')
            .setDescription(
              `<@${order.customer_id}> 已使用月結付款。\n\n` +
              `本筆金額：NT$${result.amount}\n` +
              `本筆回饋：${result.cashback} 星雨幣\n` +
              `剩餘月結額度：NT$${result.availableAmount}`
            )
            .setTimestamp()
        ]
      });
    } catch (err) {
      return interaction.editReply({
        content: `❌ 月結付款失敗：${err.message}`
      });
    }
  }
  const { data: updatedOrder, error: updateError } =
    await supabase
      .from('play_orders')
      .update({
        payment_method: paymentMethod,
        status: paidNow ? 'waiting_confirm' : 'waiting_payment',
        paid: paidNow ? true : order.paid,
        paid_at: paidNow ? paidAt : order.paid_at
      })
      .eq('id', order.id)
      .select()
      .single();
  if (updateError || !updatedOrder) {
    console.error('[報價流程] 更新付款方式失敗', updateError);
    return interaction.editReply({
      content: '❌ 更新付款方式失敗'
    });
  }

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
            `<@${order.customer_id}> 你選擇了：${paymentMethod}\n\n` +
            `請等待客服提供付款帳號 / 錢包地址。\n` +
            `付款完成後請上傳付款截圖，等待客服確認。`
          )
          .setTimestamp()
      ]
    });
  }
  await sendCustomerFinalConfirm(interaction.channel, updatedOrder);
  if (!paidNow) {
    await interaction.channel.send({
      content: `<@&${process.env.STAFF_ROLE}> 請客服確認此訂單是否已付款`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`staff_confirm_order_paid_${order.id}`)
            .setLabel('客服確認已付款')
            .setStyle(ButtonStyle.Success)
        )
      ]
    });
  }
  return interaction.editReply({
    content: `✅ 已選擇付款方式：${paymentMethod}`
  });
}
async function sendCustomerFinalConfirm(channel, order) {
  const preferredText =
    buildPreferredPlayerText(order.preferred_player);

  const embed =
    new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('📋 請確認訂單資訊')
      .setDescription(
        `<@${order.customer_id}> 請確認以下訂單資訊是否正確。\n\n` +
        `確認後，系統才會正式發送派單資訊。`
      )
      .addFields(
        {
          name: '📌 訂單編號',
          value: order.order_no || String(order.id),
          inline: true
        },
        {
          name: '🎮 遊戲 / 服務',
          value: order.game || order.service || '未填寫',
          inline: true
        },
        {
          name: '📦 項目',
          value: order.order_item || '未填寫',
          inline: true
        },
        {
          name: '👥 人數',
          value: String(order.player_count || '自訂'),
          inline: true
        },
        {
          name: '🚻 性別偏好',
          value: order.gender_preference || '不指定',
          inline: true
        },
        {
          name: '🌟 陪陪',
          value: preferredText,
          inline: true
        },
        {
          name: '🕒 時間',
          value: order.reserved_time || order.duration_text || '未填寫',
          inline: true
        },
        {
          name: '💰 金額',
          value: `NT$${Number(order.final_price || order.price || 0).toLocaleString('zh-TW')}`,
          inline: true
        },
        {
          name: '🎟️ 優惠券',
          value: order.coupon_text || '未使用優惠券',
          inline: true
        },
        {
          name: '💳 付款方式',
          value: order.payment_method || '未選擇',
          inline: true
        },
        {
          name: '📝 備註',
          value: order.note || '無',
          inline: false
        }
      )
      .setTimestamp();

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`customer_confirm_order_${order.id}`)
          .setLabel('確認正確')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`customer_order_wrong_${order.id}`)
          .setLabel('內容有誤')
          .setEmoji('✏️')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`extend_order_${order.id}`)
          .setLabel('➕ 加時 / 續單')
          .setStyle(ButtonStyle.Primary)
      );

  await channel.send({
    embeds: [embed],
    components: [row]
  });
}
async function handleStaffConfirmOrderPaid(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }

  if (
    !interaction.member.roles.cache.has(process.env.STAFF_ROLE) &&
    !interaction.member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return interaction.editReply({
      content: '❌ 只有客服可以確認付款'
    });
  }

  const orderId =
    interaction.customId.replace('staff_confirm_order_paid_', '');

  const { data: order, error } =
    await supabase
      .from('play_orders')
      .update({
        paid: true,
        paid_at: new Date().toISOString(),
        status: 'waiting_confirm'
      })
      .eq('id', orderId)
      .select()
      .single();

  if (error || !order) {
    console.error('[客服確認付款] 失敗', error);

    return interaction.editReply({
      content: '❌ 確認付款失敗，請查看後台紀錄'
    });
  }

  await interaction.channel.send({
    content:
      `✅ 已由 <@${interaction.user.id}> 確認付款。\n` +
      `<@${order.customer_id}> 現在可以按「確認正確」送出派單。`
  });

  return interaction.editReply({
    content: '✅ 已標記為已付款'
  });
}
async function handleCustomerConfirmOrder(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }

  const orderId =
    interaction.customId.replace('customer_confirm_order_', '');

  const { data: order, error } =
    await supabase
      .from('play_orders')
      .select('*')
      .eq('id', orderId)
      .single();

  if (error || !order) {
    console.error('[闆闆確認訂單] 找不到訂單', error);
    return interaction.editReply({
      content: '❌ 找不到這張訂單'
    });
  }

  if (order.customer_id !== interaction.user.id) {
    return interaction.editReply({
      content: '❌ 只有下單的闆闆可以確認訂單'
    });
  }

  if (!Number(order.final_price || order.price || 0)) {
    return interaction.editReply({
      content: '❌ 這張訂單尚未填寫金額，請等待客服報價'
    });
  }

  if (!order.payment_method || order.payment_method === '未選擇') {
    return interaction.editReply({
      content: '❌ 這張訂單尚未選擇付款方式'
    });
  }
  if (!order.paid) {
    return interaction.editReply({
      content: '❌ 尚未由客服確認付款，請付款後等待客服確認。'
    });
  }

  const { data: updatedOrder, error: updateError } =
    await supabase
      .from('play_orders')
      .update({
        status: 'pending',
        quote_status: 'dispatched',
        confirmed_by_customer: true
      })
      .eq('id', order.id)
      .select()
      .single();

  if (updateError || !updatedOrder) {
    console.error('[闆闆確認訂單] 更新失敗', updateError);
    return interaction.editReply({
      content: '❌ 確認訂單失敗，請稍後再試'
    });
  }

  await sendOrderToStaffChannel(updatedOrder);

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor('#57F287')
        .setTitle('✅ 訂單已確認，已送出派單')
        .setDescription(
          `訂單編號：${updatedOrder.order_no || updatedOrder.id}\n` +
          `闆闆：<@${updatedOrder.customer_id}>\n\n` +
          `系統已將此單送到員工接單區，請等待陪陪接單。`
        )
        .setTimestamp()
    ]
  });

  await sendPlayLog({
    title: '✅ 訂單已確認並派單',
    description:
      `訂單編號：${updatedOrder.order_no || updatedOrder.id}\n` +
      `闆闆：<@${updatedOrder.customer_id}>\n` +
      `服務：${updatedOrder.service || '未填寫'}\n` +
      `金額：NT$${updatedOrder.final_price || updatedOrder.price || 0}`,
    color: '#57F287'
  });

  return interaction.editReply({
    content: '✅ 訂單已確認，已正式派單'
  });
}
async function handleCustomerOrderWrong(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }
  const orderId =
    interaction.customId.replace('customer_order_wrong_', '');

  const { data: order, error } =
    await supabase
      .from('play_orders')
      .select('*')
      .eq('id', orderId)
      .single();

  if (error || !order) {
    return interaction.editReply({
      content: '❌ 找不到這張訂單'
    });
  }

  if (order.customer_id !== interaction.user.id) {
    return interaction.editReply({
      content: '❌ 只有下單的闆闆可以回報內容有誤'
    });
  }

  await supabase
    .from('play_orders')
    .update({
      quote_status: 'need_fix',
      status: 'quoted'
    })
    .eq('id', order.id);

  const staffFixRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`staff_edit_order_${order.id}`)
          .setLabel('客服修改訂單內容')
          .setEmoji('🛠️')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`change_order_price_${order.id}`)
          .setLabel('修改金額')
          .setEmoji('💰')
          .setStyle(ButtonStyle.Secondary)
      );
  await interaction.channel.send({
    content:
      `<@&${process.env.STAFF_ROLE}> 闆闆回報訂單內容有誤，請客服協助修改。\n` +
      `訂單編號：${order.order_no || order.id}`,
    components: [staffFixRow]
  });
  return interaction.editReply({
    content: '✅ 已通知客服協助修改訂單內容'
  });
}
async function openStaffEditOrderModal(interaction) {
  const orderId =
    interaction.customId.replace('staff_edit_order_', '');

  const isStaff =
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.reply({
      content: '❌ 只有客服可以修改訂單',
      flags: 64
    });
  }

  const modal =
    new ModalBuilder()
      .setCustomId(`submit_staff_edit_order_${orderId}`)
      .setTitle('客服修改訂單內容');

  const serviceInput =
    new TextInputBuilder()
      .setCustomId('service')
      .setLabel('服務項目')
      .setPlaceholder('例如：特戰英豪 技術陪玩')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

  const timeInput =
    new TextInputBuilder()
      .setCustomId('time')
      .setLabel('時間 / 局數')
      .setPlaceholder('例如：3局、60分鐘、今晚22:00')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

  const noteInput =
    new TextInputBuilder()
      .setCustomId('note')
      .setLabel('備註 / 需求')
      .setPlaceholder('要修改的備註內容')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false);
  const playerCountInput =
    new TextInputBuilder()
      .setCustomId('player_count')
      .setLabel('陪陪數量')
      .setPlaceholder('例如：1、2、3；不改就留空')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
  const preferredPlayerInput =
    new TextInputBuilder()
      .setCustomId('preferred_player')
      .setLabel('指定陪陪 / 不指定')
      .setPlaceholder('輸入 不指定，或貼上陪陪 Discord ID / @陪陪')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
  modal.addComponents(
    new ActionRowBuilder().addComponents(serviceInput),
    new ActionRowBuilder().addComponents(timeInput),
    new ActionRowBuilder().addComponents(noteInput),
    new ActionRowBuilder().addComponents(preferredPlayerInput),
    new ActionRowBuilder().addComponents(playerCountInput)
  );

  return interaction.showModal(modal);
}
async function submitStaffEditOrder(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const orderId =
    interaction.customId.replace('submit_staff_edit_order_', '');

  const isStaff =
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.editReply({
      content: '❌ 只有客服可以修改訂單'
    });
  }

  const service =
    interaction.fields.getTextInputValue('service') || '';

  const time =
    interaction.fields.getTextInputValue('time') || '';

  const note =
    interaction.fields.getTextInputValue('note') || '';

  const preferredPlayerRaw =
    interaction.fields.getTextInputValue('preferred_player') || '';
  const playerCountRaw =
    interaction.fields.getTextInputValue('player_count') || '';
  const updateData = {
    quote_status: 'fixed',
    status: 'quoted'
  };
  if (playerCountRaw.trim()) {
    const playerCount =
      Number(playerCountRaw.replace(/[^\d]/g, ''));
    if (!playerCount || playerCount <= 0) {
      return interaction.editReply({
        content: '❌ 陪陪數量格式錯誤，請輸入 1、2、3 這種數字'
      });
    }
    updateData.player_count = playerCount;
  }
  if (preferredPlayerRaw.trim()) {
    const raw =
      preferredPlayerRaw.trim();
    if (
      raw === '不指定' ||
      raw === '無' ||
      raw.toLowerCase() === 'none'
    ) {
      updateData.preferred_player = null;
      updateData.preferred_player_type = 'none';
      updateData.reserved_player = null;
      updateData.dispatch_type = null;
    } else {
      const playerIds =
        raw
          .split(/[\s,，、]+/)
          .map(text =>
            text
              .replace(/[<@!>]/g, '')
              .replace(/[^0-9]/g, '')
              .trim()
          )
          .filter(Boolean);
      if (playerIds.length) {
        updateData.preferred_player = playerIds.join(',');
        updateData.preferred_player_type = 'online';
        updateData.reserved_player = null;
        updateData.dispatch_type = 'preferred';
        if (
          !updateData.player_count ||
          Number(updateData.player_count) < playerIds.length
        ) {
          updateData.player_count = playerIds.length;
        }
      }
    }
  }
  if (service.trim()) {
    updateData.service = service.trim();
  }

  if (time.trim()) {
    updateData.reserved_time = time.trim();
    updateData.duration_text = time.trim();
  }

  if (note.trim()) {
    updateData.note = note.trim();
  }

  const { data: updatedOrder, error } =
    await supabase
      .from('play_orders')
      .update(updateData)
      .eq('id', orderId)
      .select()
      .single();

  if (error || !updatedOrder) {
    console.error('[客服修改訂單失敗]', error);
    return interaction.editReply({
      content: '❌ 修改訂單失敗，請查看後台 Logs'
    });
  }

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`customer_confirm_order_${updatedOrder.id}`)
          .setLabel('確認訂單')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
          .setCustomId(`customer_order_wrong_${updatedOrder.id}`)
          .setLabel('內容有誤')
          .setEmoji('⚠️')
          .setStyle(ButtonStyle.Danger)
      );

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor('#66ccff')
        .setTitle('🛠️ 訂單內容已由客服修改')
        .setDescription(
          `訂單編號：${updatedOrder.order_no || updatedOrder.id}\n` +
          `闆闆：<@${updatedOrder.customer_id}>\n\n` +
          `🎮 服務：${updatedOrder.service || '未填寫'}\n` +
          `🌟 指定陪陪：${
            updatedOrder.preferred_player
              ? buildPreferredPlayerText(updatedOrder.preferred_player)
              : '不指定'
          }\n` +
          `🕒 時間 / 局數：${updatedOrder.reserved_time || updatedOrder.duration_text || '未填寫'}\n` +
          `💰 金額：NT$${updatedOrder.final_price || updatedOrder.price || 0}\n` +
          `💳 付款方式：${updatedOrder.payment_method || '未選擇'}\n` +
          `📝 備註：${updatedOrder.note || '無'}\n\n` +
          `請闆闆重新確認訂單內容。`
        )
        .setTimestamp()
    ],
    components: [row]
  });

  return interaction.editReply({
    content: '✅ 已修改訂單，並重新送出給闆闆確認'
  });
}
async function openExtendOrderModal(interaction) {
  const isStaff =
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.reply({
      content: '❌ 只有客服可以建立加時',
      flags: 64
    });
  }

  const orderId =
    interaction.customId.replace('extend_order_', '');

  const modal =
    new ModalBuilder()
      .setCustomId(`submit_extend_order_${orderId}`)
      .setTitle('建立加時 / 續單');

  const textInput =
    new TextInputBuilder()
      .setCustomId('extension_text')
      .setLabel('加時內容')
      .setPlaceholder('例如：30分鐘、1局、3局、續聊1小時')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

  const amountInput =
    new TextInputBuilder()
      .setCustomId('amount')
      .setLabel('加時金額')
      .setPlaceholder('例如：150')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

  const noteInput =
    new TextInputBuilder()
      .setCustomId('note')
      .setLabel('備註')
      .setPlaceholder('例如：客人要求延長，陪陪同意')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(textInput),
    new ActionRowBuilder().addComponents(amountInput),
    new ActionRowBuilder().addComponents(noteInput)
  );

  return interaction.showModal(modal);
}
async function submitExtendOrder(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const isStaff =
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.editReply({
      content: '❌ 只有客服可以建立加時'
    });
  }

  const orderId =
    interaction.customId.replace('submit_extend_order_', '');

  const extensionText =
    interaction.fields.getTextInputValue('extension_text');

  const amountText =
    interaction.fields.getTextInputValue('amount');

  const note =
    interaction.fields.getTextInputValue('note') || '';

  const amount =
    Number(amountText.replace(/[^\d]/g, ''));

  if (!amount || amount <= 0) {
    return interaction.editReply({
      content: '❌ 加時金額格式錯誤，請輸入大於 0 的數字'
    });
  }

  const { data: order, error: orderError } =
    await supabase
      .from('play_orders')
      .select('*')
      .eq('id', orderId)
      .single();

  if (orderError || !order) {
    console.error('[加時] 找不到原訂單', orderError);
    return interaction.editReply({
      content: '❌ 找不到原訂單'
    });
  }

  const { data: extension, error: insertError } =
    await supabase
      .from('order_extensions')
      .insert({
        order_id: order.id,
        order_no: order.order_no || null,
        customer_id: order.customer_id,
        channel_id: order.channel_id || interaction.channel.id,
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
      '[加時] 建立加時失敗完整錯誤',
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

  await sendExtensionPaymentMethodSelect(interaction.channel, extension);

  return interaction.editReply({
    content:
      `✅ 已建立加時：${extensionText}\n` +
      `金額：NT$${amount.toLocaleString('zh-TW')}`
  });
}async function sendExtensionPaymentMethodSelect(channel, extension) {
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

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor('#66ccff')
        .setTitle('➕ 加時付款')
        .setDescription(
          `<@${extension.customer_id}> 請選擇加時付款方式。\n\n` +
          `原訂單：${extension.order_no || extension.order_id}\n` +
          `加時內容：${extension.extension_text}\n` +
          `加時金額：NT$${Number(extension.amount || 0).toLocaleString('zh-TW')}`
        )
        .setTimestamp()
    ],
    components: [row]
  });
}
async function handleExtensionPaymentMethodSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }

  const extensionId =
    interaction.customId.replace('extension_payment_method_', '');

  const paymentMethod =
    interaction.values[0];

  const { data: extension, error } =
    await supabase
      .from('order_extensions')
      .select('*')
      .eq('id', extensionId)
      .single();

  if (error || !extension) {
    return interaction.editReply({
      content: '❌ 找不到加時資料'
    });
  }

  if (extension.customer_id !== interaction.user.id) {
    return interaction.editReply({
      content: '❌ 只有這筆訂單的闆闆可以選擇付款方式'
    });
  }

  const amount =
    Number(extension.amount || 0);

  // 儲值卡直接扣款
  if (paymentMethod.includes('儲值卡')) {
    const { data: userData, error: userError } =
      await supabase
        .from('users')
        .select('*')
        .eq('user_id', extension.customer_id)
        .maybeSingle();

    if (userError || !userData) {
      return interaction.editReply({
        content: '❌ 找不到錢包資料'
      });
    }

    const currentCoins =
      Number(userData.coins || 0);

    if (currentCoins < amount) {
      return interaction.editReply({
        content:
          `❌ ASD 餘額不足。\n` +
          `目前餘額：${currentCoins} ASD\n` +
          `需要金額：${amount} ASD`
      });
    }

    if (!paymentHelpers.changeCoins) {
      return interaction.editReply({
        content: '❌ changeCoins 尚未接入，請確認 index.js 的 dispatchSystem.setup'
      });
    }
    let finalCoins = 0;
    try {
      finalCoins = await paymentHelpers.changeCoins(
        extension.customer_id,
        -amount
      );
    } catch (error) {
      console.error('[加時] 扣款失敗', error);
      return interaction.editReply({
        content: '❌ 扣款失敗，請查看 Railway Logs'
      });
    }

    await paymentHelpers.sendWalletLog?.(
      extension.customer_id,
      '加時扣款',
      -amount,
      finalCoins,
      `加時 ${extension.extension_text}｜原訂單 ${extension.order_no || extension.order_id}`
    );

    await supabase
      .from('order_extensions')
      .update({
        payment_method: paymentMethod,
        paid: true,
        status: 'paid',
        paid_at: new Date().toISOString()
      })
      .eq('id', extension.id);
    let salaryResult = null;
    try {
      salaryResult = await applyExtensionToPlayOrder(extension);
    } catch (error) {
      console.error('[加時] 寫入薪資網失敗', error);
      await interaction.channel.send({
        content:
          `⚠️ 加時已付款，但寫入薪資網失敗。\n` +
          `錯誤：${error.message || error}`
      });
    }
    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor('#57F287')
          .setTitle('✅ 加時已付款')
          .setDescription(
              `原訂單：${extension.order_no || extension.order_id}\n` +
              `闆闆：<@${extension.customer_id}>\n` +
              `加時內容：${extension.extension_text}\n` +
              `加時金額：NT$${amount.toLocaleString('zh-TW')}\n` +
              `付款方式：${paymentMethod}\n` +
              (
                salaryResult
                  ? `\n已更新薪資網金額：NT$${salaryResult.oldPrice.toLocaleString('zh-TW')} → NT$${salaryResult.newPrice.toLocaleString('zh-TW')}`
                  : `\n⚠️ 薪資網尚未更新，請查看 Railway Logs`
              )
            )
          .setTimestamp()
      ]
    });

    return interaction.editReply({
      content: '✅ 加時已用儲值卡 / 錢包付款完成'
    });
  }

  const { data: updatedExtension, error: updateError } =
    await supabase
      .from('order_extensions')
      .update({
        payment_method: paymentMethod,
        status: 'waiting_payment'
      })
      .eq('id', extension.id)
      .select()
      .single();

  if (updateError || !updatedExtension) {
    console.error('[加時] 更新付款方式失敗', updateError);
    return interaction.editReply({
      content: '❌ 更新加時付款方式失敗'
    });
  }

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
            `<@${extension.customer_id}> 你選擇了：${paymentMethod}\n\n` +
            `請等待客服提供付款帳號 / 錢包地址。\n` +
            `付款完成後請上傳付款截圖，等待客服確認。`
          )
          .setTimestamp()
      ]
    });
  }

  await interaction.channel.send({
    content:
      `<@&${process.env.STAFF_ROLE}> 請客服確認這筆加時是否已付款`,
    components: [
      new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`staff_confirm_extension_paid_${extension.id}`)
            .setLabel('客服確認加時已付款')
            .setStyle(ButtonStyle.Success)
        )
    ]
  });

  return interaction.editReply({
    content: `✅ 已選擇加時付款方式：${paymentMethod}`
  });
}
async function handleStaffConfirmExtensionPaid(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }

  const isStaff =
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.editReply({
      content: '❌ 只有客服可以確認加時付款'
    });
  }

  const extensionId =
    interaction.customId.replace('staff_confirm_extension_paid_', '');

  const { data: extension, error } =
    await supabase
      .from('order_extensions')
      .select('*')
      .eq('id', extensionId)
      .single();

  if (error || !extension) {
    return interaction.editReply({
      content: '❌ 找不到加時資料'
    });
  }

  if (extension.paid) {
    return interaction.editReply({
      content: '⚠️ 這筆加時已經確認付款過了'
    });
  }

  const { error: updateError } =
    await supabase
      .from('order_extensions')
      .update({
        paid: true,
        status: 'paid',
        paid_at: new Date().toISOString()
      })
      .eq('id', extension.id);
  let salaryResult = null;
  try {
    salaryResult = await applyExtensionToPlayOrder(extension);
  } catch (error) {
    console.error('[加時] 寫入薪資網失敗', error);
    await interaction.channel.send({
      content:
        `⚠️ 加時已確認付款，但寫入薪資網失敗。\n` +
        `錯誤：${error.message || error}`
    });
  }
  if (updateError) {
    console.error('[加時] 確認付款失敗', updateError);
    return interaction.editReply({
      content: '❌ 確認加時付款失敗'
    });
  }

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor('#57F287')
        .setTitle('✅ 加時付款已確認')
        .setDescription(
          `原訂單：${extension.order_no || extension.order_id}\n` +
          `闆闆：<@${extension.customer_id}>\n` +
          `加時內容：${extension.extension_text}\n` +
          `加時金額：NT$${Number(extension.amount || 0).toLocaleString('zh-TW')}\n` +
          `確認客服：<@${interaction.user.id}>`
        )
        .setTimestamp()
    ]
  });

  return interaction.editReply({
    content: '✅ 已確認加時付款'
  });
}
async function startNewOrderFlow(channel, user) {
  const flowId = `${user.id}_${Date.now()}`;

  pendingNewOrders.set(flowId, {
    userId: user.id,
    username: user.username,
    channelId: channel.id,

    game: '',
    item: '',
    playerCount: 1,
    gender: '不指定',

    selectedPlayerType: 'none',
    selectedPlayerId: null,
    selectedPlayerName: '',
    selectedPlayerStatus: '',

    duration: '',
    reservedTime: '',
    note: '無'
  });

  setTimeout(() => {
    pendingNewOrders.delete(flowId);
  }, 30 * 60 * 1000);

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(`new_order_game_${flowId}`)
      .setPlaceholder('請選擇遊戲 / 服務')
      .addOptions([
        {
          label: '特戰英豪',
          description: 'VALORANT 陪玩 / 技術單',
          value: '特戰英豪'
        },
        {
          label: '三角洲行動',
          description: '三角洲護航 / 保底 / 娛樂',
          value: '三角洲行動'
        },
        {
          label: 'PUBG',
          description: 'PUBG 陪玩',
          value: 'PUBG'
        },
        {
          label: 'STEAM',
          description: 'Steam 遊戲陪玩',
          value: 'STEAM'
        },
        {
          label: '陪聊服務',
          description: '聊天 / 陪伴 / 出氣',
          value: '陪聊服務'
        },
        {
          label: '打賞禮物',
          description: '打賞 / 禮物單',
          value: '打賞禮物'
        }
      ]);

  const row =
    new ActionRowBuilder()
      .addComponents(menu);

  await channel.send({
    content:
      `<@${user.id}> 歡迎使用深夜不關燈點單系統。\n\n` +
      `請先選擇你要下單的遊戲 / 服務：`,
    components: [row]
  });
}
async function openTopupModal(interaction) {
  const modal =
    new ModalBuilder()
      .setCustomId('submit_topup_form')
      .setTitle('💰 儲值申請');

  const amountInput =
    new TextInputBuilder()
      .setCustomId('amount')
      .setLabel('儲值金額')
      .setPlaceholder('例如：1000')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

  const noteInput =
    new TextInputBuilder()
      .setCustomId('note')
      .setLabel('備註')
      .setPlaceholder('沒有可填無')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(amountInput),
    new ActionRowBuilder().addComponents(noteInput)
  );

  await interaction.showModal(modal);
}
function canEditOrderPrice(interaction) {
  return (
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE) ||
    (
      process.env.CUSTOMER_SERVICE_ROLE_ID &&
      interaction.member.roles.cache.has(process.env.CUSTOMER_SERVICE_ROLE_ID)
    )
  );
}
// ===== 開啟更改訂單金額視窗 =====
async function openChangeOrderPriceModal(interaction) {
  if (!canEditOrderPrice(interaction)) {
    return interaction.reply({
      content: '❌ 你沒有權限更改訂單金額',
      flags: 64
    });
  }

  const orderId =
    interaction.customId.replace(
      'change_order_price_',
      ''
    );

  const modal =
    new ModalBuilder()
      .setCustomId(`submit_change_order_price_${orderId}`)
      .setTitle('更改訂單金額');

  const priceInput =
    new TextInputBuilder()
      .setCustomId('new_price')
      .setLabel('請輸入新的訂單金額')
      .setPlaceholder('例如：499')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(priceInput)
  );

  await interaction.showModal(modal);
}
async function openSaveOrderNoteModal(interaction) {
  const orderId =
    interaction.customId.replace(
      'save_order_note_',
      ''
    );

  const modal =
    new ModalBuilder()
      .setCustomId(`submit_save_order_note_${orderId}`)
      .setTitle('📝 存單內容');

  const noteInput =
    new TextInputBuilder()
      .setCustomId('saved_order_text')
      .setLabel('請輸入要存單的內容')
      .setPlaceholder('例如：闆闆要存單的內容')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder()
      .addComponents(noteInput)
  );

  await interaction.showModal(modal);
}

async function openDispatchPlayerMenu(interaction) {
  const orderId =
    interaction.customId.replace(
      'dispatch_assign_players_',
      ''
    );

  if (
    !interaction.member.roles.cache.has(process.env.STAFF_ROLE) &&
    !interaction.member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return interaction.editReply({
      content: '❌ 只有客服可以派單'
    });
  }

  const { data: order, error } =
    await supabase
      .from('play_orders')
      .select('*')
      .eq('id', orderId)
      .single();

  if (error || !order) {
    return interaction.editReply({
      content: '❌ 找不到這張訂單'
    });
  }

  if (
    !['waiting_quote', 'quoted', 'waiting_payment', 'pending'].includes(order.status)
  ) {
    return interaction.editReply({
      content: '❌ 這張訂單目前狀態不能再選擇陪陪'
    });
  }
  const playerOptions =
    await getAvailablePlayerOptions(order.service || '');

  if (!playerOptions.length) {
    return interaction.editReply({
      content: '❌ 目前沒有可接單陪陪'
    });
  }

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(`submit_dispatch_players_${order.id}`)
      .setPlaceholder('可多選指定陪陪')
      .setMinValues(1)
      .setMaxValues(Math.min(playerOptions.length, 10))
      .addOptions(playerOptions.slice(0, 25));

  const row =
    new ActionRowBuilder()
      .addComponents(menu);

  return interaction.editReply({
    content: '🌟 請選擇要指定派單的陪陪，可多選：',
    components: [row]
  });
}

async function submitDispatchPlayers(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }

  const orderId =
    interaction.customId.replace(
      'submit_dispatch_players_',
      ''
    );

  if (
    !interaction.member.roles.cache.has(process.env.STAFF_ROLE) &&
    !interaction.member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return interaction.editReply({
      content: '❌ 只有客服可以派單',
      components: []
    });
  }

  const selectedPlayerIds =
    interaction.values;

  const preferredPlayerValue =
    selectedPlayerIds.join(',');

  const { data: order, error } =
    await supabase
      .from('play_orders')
      .update({
        preferred_player: preferredPlayerValue
      })
      .eq('id', orderId)
      .select()
      .single();

  if (error || !order) {
    console.log('[指定派單失敗]', error);
    return interaction.editReply({
      content: '❌ 指定派單失敗',
      components: []
    });
  }

  return interaction.editReply({
    content:
      `✅ 已選擇陪陪：${selectedPlayerIds.map(id => `<@${id}>`).join('、')}\n` +
      `請繼續完成報價、優惠券與付款方式流程，等闆闆確認後才會正式派單。`,
    components: []
  });
}
async function submitTopupForm(interaction) {
  await interaction.deferReply({
    flags: 64
  });
  const amountText =
    interaction.fields.getTextInputValue(
      'amount'
    );
  let note = '無';
  try {
    note =
      interaction.fields.getTextInputValue(
        'note'
      ) || '無';
  } catch {}
  // ===== 金額處理 =====
  const amount =
    parseInt(
      amountText.replace(/[^\d]/g, ''),
      10
    );
  if (!amount || amount <= 0) {
    return interaction.editReply({
      content: '❌ 金額格式錯誤'
    });
  }
  const topupId =
    `${interaction.user.id}_${Date.now()}`;

  pendingTopups.set(topupId, {
    userId: interaction.user.id,
    amount,
    note
  });

  setTimeout(() => {
    pendingTopups.delete(topupId);
  }, 30 * 60 * 1000);

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(`topup_payment_method_${topupId}`)
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
          description: '顯示刷卡付款連結',
          value: '刷卡'
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

  return interaction.editReply({
    content:
      `✅ 已填寫儲值金額：NT$${amount}\n` +
      `📝 備註：${note}\n\n` +
      `請繼續選擇付款方式：`,
    components: [row]
  });
}
async function handleTopupPaymentMethodSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }

  const topupId =
    interaction.customId.replace('topup_payment_method_', '');

  const pending =
    pendingTopups.get(topupId);

  if (!pending) {
    return interaction.editReply({
      content: '❌ 這筆儲值申請已過期，請重新填寫。',
      components: []
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.editReply({
      content: '❌ 只有建立儲值申請的人可以選擇付款方式。',
      components: []
    });
  }

  const method =
    interaction.values[0];

  const { amount, note } = pending;

  pendingTopups.delete(topupId);

  const embed =
    new EmbedBuilder()
      .setColor('#ffd166')
      .setTitle('💰 儲值申請')
      .setDescription(
        `👤 會員：${interaction.user}\n\n` +
        `💵 儲值金額：NT$${amount}\n` +
        `💳 付款方式：${method}\n` +
        `📝 備註：${note}`
      );

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `confirm_topup_${interaction.user.id}_${amount}`
          )
          .setLabel('確認儲值')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
          .setCustomId('close_ticket')
          .setLabel('關閉單子')
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger)
      );

  await interaction.channel.send({
    embeds: [embed],
    components: [row]
  });

  if (isCardPayment(method)) {
    await sendCardPaymentInfo(interaction.channel);
  } else if (isNoCardPayment(method)) {
    await sendNoCardPaymentInfo(interaction.channel);
  } else if (isBankTransfer(method)) {
    await sendBankTransferInfo(interaction.channel);
  } else if (
    method.includes('美金') ||
    method.includes('加密貨幣')
  ) {
    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor('#ffaa00')
          .setTitle('💳 特殊付款方式')
          .setDescription(
            `<@${interaction.user.id}> 你選擇了：${method}\n\n` +
            `請等待客服提供付款帳號 / 錢包地址。\n` +
            `付款完成後請上傳付款截圖，等待客服確認。`
          )
          .setTimestamp()
      ]
    });
  }

  return interaction.editReply({
    content: `✅ 已選擇付款方式：${method}`,
    components: []
  });
}
async function confirmTopup(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }

  const isStaff =
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.editReply({
      content: '❌ 只有客服可以確認儲值'
    });
  }

  const parts =
    interaction.customId.split('_');

  // confirm_topup_userId_amount
  const userId =
    parts[2];

  const amount =
    Number(parts[3]);

  if (!userId || !amount || amount <= 0) {
    return interaction.editReply({
      content: '❌ 儲值資料錯誤'
    });
  }

  if (
    !paymentHelpers.sendWalletLog ||
    !paymentHelpers.checkAndUpgradeVip
  ) {
    return interaction.editReply({
      content:
        '❌ 儲值函式尚未完整接入，請確認 index.js 的 dispatchSystem.setup 有傳 sendWalletLog 和 checkAndUpgradeVip'
    });
  }

  const { data: userData, error: userError } =
    await supabase
      .from('users')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

  if (userError) {
    console.error('[確認儲值] 讀取使用者失敗', userError);

    return interaction.editReply({
      content: '❌ 讀取會員資料失敗'
    });
  }

  if (!paymentHelpers.changeCoins) {
    return interaction.editReply({
      content: '❌ changeCoins 尚未接入，請確認 index.js 的 dispatchSystem.setup'
    });
  }
  let finalCoins = 0;
  try {
    finalCoins = await paymentHelpers.changeCoins(userId, amount);
  } catch (error) {
    console.error('[確認儲值] 更新餘額失敗', error);
    return interaction.editReply({
      content: '❌ 儲值失敗，請查看後台 Logs'
    });
  }
  await paymentHelpers.sendWalletLog(
    userId,
    '儲值',
    amount,
    finalCoins,
    '💳 自動儲值成功'
  );

  await paymentHelpers.checkAndUpgradeVip(
    userId,
    'topup',
    amount
  );

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor('#57F287')
        .setTitle('✅ 儲值已完成')
        .setDescription(
          `<@${userId}> 已成功儲值。\n\n` +
          `儲值金額：${amount} ASD\n` +
          `目前餘額：${finalCoins} ASD\n` +
          `確認客服：<@${interaction.user.id}>`
        )
        .setTimestamp()
    ]
  });

  return interaction.editReply({
    content: `✅ 已幫 <@${userId}> 儲值 ${amount} ASD`
  });
}
async function submitSaveOrderNote(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const orderId =
    interaction.customId.replace(
      'submit_save_order_note_',
      ''
    );

  const savedText =
    interaction.fields.getTextInputValue(
      'saved_order_text'
    );

  const { data: order, error } =
    await supabase
      .from('play_orders')
      .select('*')
      .eq('id', orderId)
      .single();

  if (error || !order) {
    console.log('[存單讀取訂單失敗]', error);
    return interaction.editReply({
      content: '❌ 找不到這張訂單'
    });
  }

  const saveChannel =
    await client.channels
      .fetch(process.env.SAVED_ORDER_CHANNEL)
      .catch(() => null);

  if (!saveChannel) {
    return interaction.editReply({
      content: '❌ 找不到存單指定頻道，請檢查 SAVED_ORDER_CHANNEL'
    });
  }

  const endButton =
    new ButtonBuilder()
      .setCustomId(`saved_order_end_${order.id}`)
      .setLabel('已結束')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Danger);

  const row =
    new ActionRowBuilder()
      .addComponents(endButton);

  const embed =
    new EmbedBuilder()
      .setColor('#66ccff')
      .setTitle('📝 訂單存單')
      .addFields(
        {
          name: '📌 訂單編號',
          value: order.order_no || '未知',
          inline: true
        },
        {
          name: '👤 客人',
          value: `<@${order.customer_id}>`,
          inline: true
        },
        {
          name: '🎮 服務項目',
          value: order.service || '未填寫',
          inline: false
        },
        {
          name: '💰 金額',
          value: `NT$${order.final_price || order.price || 0}`,
          inline: true
        },
        {
          name: '💳 付款方式',
          value: order.payment_method || '未填寫',
          inline: true
        },
        {
          name: '📝 存單內容',
          value: savedText.slice(0, 1000),
          inline: false
        }
      )
      .setFooter({
        text: `存單人：${interaction.user.username}`
      })
      .setTimestamp();

  await saveChannel.send({
    embeds: [embed],
    components: [row]
  });

  await interaction.channel.send({
    content:
      `✅ <@${interaction.user.id}> 已完成存單，內容已送到指定頻道。`
  });

  return interaction.editReply({
    content: '✅ 存單已送出'
  });
}
async function handleSavedOrderEnd(interaction) {
  const roleId =
    process.env.STAFF_ROLE;

  const isStaff =
    interaction.guild.ownerId === interaction.user.id ||
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(roleId);

  if (!isStaff) {
    return interaction.editReply({
      content: '❌ 只有客服可以按已結束'
    });
  }

  const oldEmbed =
    interaction.message.embeds[0];

  const newEmbed =
    EmbedBuilder.from(oldEmbed)
      .setColor('#999999')
      .setTitle('✅ 訂單存單｜已結束')
      .addFields({
        name: '🔒 結束人',
        value: `<@${interaction.user.id}>`,
        inline: true
      });

  const disabledRow =
    new ActionRowBuilder()
      .addComponents(
        ButtonBuilder.from(
          interaction.message.components[0].components[0]
        )
          .setDisabled(true)
          .setLabel('已結束')
      );

  await interaction.message.edit({
    embeds: [newEmbed],
    components: [disabledRow]
  });

  return interaction.editReply({
    content: '✅ 已標記為結束'
  });
}
// ===== 送出更改訂單金額 =====
async function submitChangeOrderPrice(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  if (!canEditOrderPrice(interaction)) {
    return interaction.editReply({
      content: '❌ 你沒有權限更改訂單金額'
    });
  }

  const orderId =
    interaction.customId.replace(
      'submit_change_order_price_',
      ''
    );

  const priceText =
    interaction.fields.getTextInputValue('new_price');
  const cleanPriceText =
    priceText.replace(/[^\d]/g, '');
  if (cleanPriceText === '') {
    return interaction.editReply({
      content: '❌ 請輸入金額'
    });
  }
  const newPrice =
    Number(cleanPriceText);
  if (
    Number.isNaN(newPrice) ||
    newPrice < 0
  ) {
    return interaction.editReply({
      content: '❌ 金額不能小於 0'
    });
  }
  const { data: order, error } =
    await supabase
      .from('play_orders')
      .select('*')
      .eq('id', orderId)
      .single();

  if (error || !order) {
    console.log('[更改金額讀取訂單失敗]', error);
    return interaction.editReply({
      content: '❌ 找不到這張訂單'
    });
  }

  const { data: updated, error: updateError } =
    await supabase
      .from('play_orders')
      .update({
        price: newPrice,
        final_price: newPrice
      })
      .eq('id', orderId)
      .select()
      .single();

  if (updateError || !updated) {
    console.log('[更改金額失敗]', updateError);
    return interaction.editReply({
      content: '❌ 更改金額失敗'
    });
  }

  const orderChannel =
    await client.channels
      .fetch(order.channel_id)
      .catch(() => null);

  if (!orderChannel) {
    return interaction.editReply({
      content: '❌ 找不到訂單臨時頻道'
    });
  }

  const embed =
    new EmbedBuilder()
      .setColor('#ffaa00')
      .setTitle('💰 訂單金額已更新')
      .addFields(
        {
          name: '📌 訂單編號',
          value: order.order_no || '未知',
          inline: true
        },
        {
          name: '👤 客人',
          value: `<@${order.customer_id}>`,
          inline: true
        },
        {
          name: '🎮 服務項目',
          value: order.service || '未填寫',
          inline: false
        },
        {
          name: '💰 原金額',
          value: `NT$${order.price || 0}`,
          inline: true
        },
        {
          name: '💵 新金額',
          value: `NT$${newPrice}`,
          inline: true
        },
        {
          name: '💳 付款方式',
          value: order.payment_method || '未填寫',
          inline: true
        },
        {
          name: '📝 備註需求',
          value: order.note || '無',
          inline: false
        }
      )
      .setFooter({
        text: `由 ${interaction.user.username} 更改`
      })
      .setTimestamp();

  await orderChannel.send({
    content:
      `<@${order.customer_id}> 訂單金額已更新，請確認新的金額。`,
    embeds: [embed]
  });

  await sendPlayLog({
    title: '💰 訂單金額已更新',
    description:
      `訂單編號：${order.order_no}\n` +
      `修改人：<@${interaction.user.id}>\n` +
      `原金額：NT$${order.price || 0}\n` +
      `新金額：NT$${newPrice}`,
    color: '#ffaa00'
  });

  return interaction.editReply({
    content: `✅ 已將訂單金額改為 NT$${newPrice}`
  });
}
// 接單
async function acceptPlayOrder(interaction) {
  try {
    const orderId =
      interaction.customId.replace('accept_play_order_', '');

    const { data: player, error: playerError } =
      await supabase
        .from('players')
        .select('*')
        .eq('discord_id', interaction.user.id)
        .single();

    if (playerError) {
      console.log('[接單錯誤 players]', playerError);
    }

    if (!player || player.status !== 'available') {
      return interaction.editReply({
        content: '❌ 你目前不是可接單狀態，請先按「開始接單」',
      });
    }
    const { data: order, error: orderError } =
      await supabase
        .from('play_orders')
        .select('*')
        .eq('id', orderId)
        .single();

    if (orderError) {
      console.log('[接單錯誤 play_orders]', orderError);
    }

    if (!order || order.status !== 'pending') {
      return interaction.editReply({
        content: '❌ 這張訂單已經被接走了',
      });
    }
    // ===== 指定陪陪限制 =====
    // 如果指定人數已經等於需求人數：只有指定名單可以接。
    // 如果指定人數小於需求人數：指定的人可以接，剩下名額開放符合服務的陪陪補位。
    if (order.preferred_player) {
      const preferredPlayers =
        String(order.preferred_player)
          .split(',')
          .map(id => id.trim())
          .filter(Boolean);
      const needCount =
        Number(order.player_count || 1) || 1;
      const assignedPlayerIdsNow =
        String(order.assigned_player || '')
          .split(',')
          .map(id => id.trim())
          .filter(Boolean);
      const preferredFull =
        preferredPlayers.length >= needCount;
      const isPreferredPlayer =
        preferredPlayers.includes(interaction.user.id);
      const alreadyAssignedPreferredCount =
        assignedPlayerIdsNow
          .filter(id => preferredPlayers.includes(id))
          .length;
      const stillWaitingPreferred =
        preferredPlayers.length > alreadyAssignedPreferredCount;
      if (preferredFull && !isPreferredPlayer) {
        return interaction.editReply({
          content:
            `❌ 這張訂單只開放指定陪陪接單：` +
            preferredPlayers.map(id => `<@${id}>`).join('、')
        });
      }
      if (
        !preferredFull &&
        !isPreferredPlayer &&
        stillWaitingPreferred
      ) {
        return interaction.editReply({
          content:
            `❌ 這張訂單還有指定陪陪尚未接單，請先等待：` +
            preferredPlayers.map(id => `<@${id}>`).join('、') +
            `\n如果指定陪陪無法接，請客服將指定改為不指定或調整名單。`
        });
      }
    }
    // ===== 服務限制 =====
    const allowedServices =
      Array.isArray(player.allowed_services)
        ? player.allowed_services
        : String(player.allowed_services || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);

    function cleanServiceKey(text = '') {
      return String(text || '')
        .replace(/\s+/g, '')
        .replace(/[｜|]/g, '')
        .replace(/　/g, '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .trim();
    }
    const orderServiceKey =
      cleanServiceKey(
        order.service ||
        `${order.game || ''}${order.order_item || ''}`
      );
    const canAccept =
      allowedServices.some(service => {
        const serviceKey =
          cleanServiceKey(service);
        return (
          serviceKey === orderServiceKey ||
          serviceKey.includes(orderServiceKey) ||
          orderServiceKey.includes(serviceKey)
        );
      });

    if (!canAccept) {
      return interaction.editReply({
        content:
          `❌ 你沒有權限接這個項目\n` +
          `此訂單服務：${order.service || '未填寫'}\n` +
          `比對用服務：${orderServiceKey}\n` +
          `你的可接項目：${allowedServices.join('、') || '未設定'}\n\n` +
          `如果畫面看起來一樣，通常是服務名稱內有隱藏空白或客服修改後欄位沒有同步。`
      });
    }
    // ===== 多人接單邏輯 =====
    const needCount =
      Number(order.player_count || 1) || 1;
    let assignedPlayerIds =
      String(order.assigned_player || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);
    // 避免同一個人重複接
    if (assignedPlayerIds.includes(interaction.user.id)) {
      return interaction.editReply({
        content: '❌ 你已經接過這張訂單了'
      });
    }
    // 加入這次按接單的人
    assignedPlayerIds.push(interaction.user.id);
    // 如果超過需求人數，擋掉
    if (assignedPlayerIds.length > needCount) {
      return interaction.editReply({
        content:
          `❌ 這張訂單需要 ${needCount} 位陪玩，目前名額已滿。`
      });
    }
    const assignedPlayerValue =
      assignedPlayerIds.join(',');
    const isFull =
      assignedPlayerIds.length >= needCount;
    const nextStatus =
      isFull ? 'accepted' : 'pending';
    const updatePayload = {
      status: nextStatus,
      assigned_player: assignedPlayerValue
    };
    if (isFull) {
      updatePayload.accepted_at = new Date();
    }
    const { data: updated, error: updateError } =
      await supabase
        .from('play_orders')
        .update(updatePayload)
        .eq('id', orderId)
        .in('status', ['pending', 'accepted'])
        .select()
        .single();
    if (updateError) {
      console.log('[接單更新錯誤]', updateError);
      return interaction.editReply({
        content: '❌ 接單更新失敗，請查看 Railway Logs',
      });
    }
    if (!updated) {
      return interaction.editReply({
        content: '❌ 這張訂單目前無法接單，可能已被接滿或狀態已變更',
      });
    } 
    if (isFull) {
      for (const playerId of assignedPlayerIds) {
        await supabase
          .from('players')
          .update({ status: 'busy' })
          .eq('discord_id', playerId);
      }
    } 
    const orderChannel =
      await client.channels.fetch(
        order.channel_id
      );
    if (!orderChannel) {
      return interaction.editReply({
        content: '❌ 找不到客人訂單頻道'
      });
    }
    for (const playerId of assignedPlayerIds) {
      await orderChannel.permissionOverwrites.edit(playerId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true
      });
    }
    await supabase
      .from('play_orders')
      .update({ channel_id: orderChannel.id })
      .eq('id', orderId);
    const embed = new EmbedBuilder()
      .setColor(isFull ? '#00ff99' : '#ffd166')
      .setTitle(
        isFull
          ? '✅ 陪玩訂單已接單'
          : '⏳ 陪玩接單中'
      )
      .setDescription(
        `訂單編號：${order.order_no}\n` +
        `客人：<@${order.customer_id}>\n` +
        `目前陪玩：${assignedPlayerIds.map(id => `<@${id}>`).join('、')}\n` +
        `需要人數：${needCount} 位\n` +
        `目前人數：${assignedPlayerIds.length} 位\n` +
        `服務：${order.service}\n` +
        `商品金額（折前）：NT$${order.price}`
    );
    await orderChannel.send({
      content: isFull
        ? `<@${order.customer_id}> ${assignedPlayerIds.map(id => `<@${id}>`).join(' ')}`
        : `${assignedPlayerIds.map(id => `<@${id}>`).join(' ')} 已接單，目前還差 ${needCount - assignedPlayerIds.length} 位陪玩。`,
      embeds: [embed],
    });
    await sendPlayLog({
      title: '✅ 訂單已接取',
      description:
        `訂單編號：${order.order_no}\n` +
        `陪玩：${assignedPlayerIds.map(id => `<@${id}>`).join('、')}\n` +
        `服務：${order.service}\n` +
        `商品金額（折前）：NT$${order.price}`,
    });

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor('#57F287')
          .setTitle('✅ 接單成功')
          .setDescription(
            `📂 點擊前往訂單頻道\n${orderChannel}`
          )
      ]
    });
  } catch (err) {
    console.log('[接單系統錯誤]', err);

    await interaction.editReply({
      content:
        `❌ 接單失敗：${err.message || '未知錯誤'}`
    }).catch(() => {});
  }
}
function getGrowthVipLevel(totalTopup, singleTopup = 0) {
  if (singleTopup >= 50000 || totalTopup >= 75000) {
    return 'vvip';
  }
  if (singleTopup >= 30000 || totalTopup >= 50000) {
    return 'vip_plus';
  }
  if (singleTopup >= 10000 || totalTopup >= 18000) {
    return 'vip';
  }
  return 'none';
}
function getTopupBonus(amount) {
  if (amount >= 75000) {
    return 8000;
  }
  if (amount >= 50000) {
    return 5000;
  }
  if (amount >= 30000) {
  return 3000;
  }
  if (amount >= 18000) {
    return 1800;
  }
  if (amount >= 8000) {
    return 700;
  }
  if (amount >= 5000) {
    return 300;
  }
  return 0;
}

function getGrowthVipRoleId(level) {
  const roles = {
    vip: process.env.GROWTH_VIP_ROLE_ID,
    vip_plus: process.env.GROWTH_VIP_PLUS_ROLE_ID
    // vvip 不發身分組
  };

  return roles[level] || null;
}

async function checkGrowthVip(client, guildId, userId, singleTopup = 0) {
  const { data: user, error } =
    await supabase
      .from('users')
      .select('*')
      .eq('user_id', userId)
      .single();

  if (error || !user) {
    console.log('[VIP] 找不到使用者', error);
    return;
  }

  const totalTopup = user.total_topup || 0;

  const newLevel =
    getGrowthVipLevel(totalTopup, singleTopup);

  if (newLevel === user.growth_vip) {
    return;
  }

  await supabase
    .from('users')
    .update({
      growth_vip: newLevel
    })
    .eq('user_id', userId);

  const guild =
    await client.guilds.fetch(guildId);

  const member =
    await guild.members
      .fetch(userId)
      .catch(() => null);

  if (!member) return;

  const growthRoles = [
    process.env.GROWTH_VIP_ROLE_ID,
    process.env.GROWTH_VIP_PLUS_ROLE_ID
  ].filter(Boolean);

  await member.roles
    .remove(growthRoles)
    .catch(() => {});

  const roleId =
    getGrowthVipRoleId(newLevel);

  if (roleId) {
    await member.roles
      .add(roleId)
      .catch(() => {});
  }

  const levelName = {
    vip: '💎 VIP',
    vip_plus: '🌟 VIP+',
    vvip: '👑 VVIP',
    none: '無'
  };

  await member.send({
    content:
      `🎉 恭喜你已升級為 ${levelName[newLevel]}！`
  }).catch(() => {});
}
function getFlowIdFromCustomId(customId, prefix = '') {
  return String(customId || '').replace(prefix, '');
}

async function handleValorantTypeButton(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const flowId =
    getFlowIdFromCustomId(
      interaction.customId,
      interaction.customId.includes('valorant_type_entertain_')
        ? 'valorant_type_entertain_'
        : 'valorant_type_skill_'
    );
  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: '❌ 這筆訂單流程已過期，請重新下單。'
    });
  }

  pending.serviceType =
    interaction.customId.includes('_entertain_')
      ? '娛樂'
      : '技術';

  pending.timeSelectShown = false;
  pendingServiceOrders.set(flowId, pending);
  return interaction.editReply({
    content: `✅ 已選擇特戰服務：${pending.serviceType}`
  });
}

async function handleValorantModeButton(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const flowId =
    getFlowIdFromCustomId(
      interaction.customId,
      interaction.customId.includes('valorant_mode_rank_')
        ? 'valorant_mode_rank_'
        : 'valorant_mode_normal_'
    );
  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: '❌ 這筆訂單流程已過期，請重新下單。'
    });
  }

  pending.playMode =
    interaction.customId.includes('_rank_')
      ? '排位'
      : '一般';

  pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content: `✅ 已選擇模式：${pending.playMode}`
  });
}

async function handleValorantRankSelect(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const flowId =
    interaction.customId.replace('valorant_rank_', '');

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: '❌ 這筆訂單流程已過期，請重新下單。'
    });
  }
  pending.rank = interaction.values[0];
  pending.timeSelectShown = false;
  pendingServiceOrders.set(flowId, pending);
  return interaction.editReply({
    content: `✅ 已選擇段位：${pending.rank}`
  });
}

async function handleServicePlayerCountSelect(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const flowId =
    interaction.customId.replace('service_player_count_', '');

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: '❌ 這筆訂單流程已過期。'
    });
  }

  pending.playerCount = Number(interaction.values[0]);

  pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content: `✅ 已選擇陪陪人數：${pending.playerCount} 位`
  });
}

async function handleServiceGenderSelect(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const flowId =
    interaction.customId.replace('service_gender_', '');

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: '❌ 這筆訂單流程已過期。'
    });
  }

  pending.genderPreference = interaction.values[0];

  pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content: `✅ 已選擇性別偏好：${pending.genderPreference}`
  });
}
function getServiceKeywordFromPending(pending) {
  if (pending.category === 'valorant') {
    return [
      '特戰英豪',
      pending.serviceType
        ? `${pending.serviceType}陪玩`
        : ''
    ].filter(Boolean).join('');
  }

  if (pending.category === 'steam') {
    return 'Steam';
  }

  if (pending.category === 'delta') {
    return [
      '三角洲',
      pending.deltaMode || ''
    ].filter(Boolean).join('');
  }

  if (pending.category === 'chat') {
    return '陪聊';
  }

  if (pending.category === 'emotion') {
    return '出氣包';
  }

  return getServiceName(pending.category);
}

async function showServicePlayerSelect(channel, flowId, pending) {
  const { data: players, error } =
    await supabase
      .from('players')
      .select('*')
      .order('status', { ascending: true });

  if (error) {
    console.error('[新版指定陪陪] 讀取陪陪失敗', error);
    return channel.send('❌ 讀取陪陪資料失敗，請聯繫客服。');
  }

  const serviceKeyword =
    getServiceKeywordFromPending(pending);

  const matchedPlayers =
    (players || [])
      .filter(player => player.discord_id)
      .filter(player => matchPlayerGender(player, pending.genderPreference))
      .filter(player => {
        const allowedServices =
          normalizeAllowedServices(player.allowed_services);

        // 沒填 allowed_services 的先顯示，避免陪陪資料沒補完整時完全沒人可選
        if (!allowedServices.length) return true;

        const clean = text =>
          String(text || '')
            .replace(/\s+/g, '')
            .replace(/[｜|]/g, '')
            .replace(/　/g, '')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .trim();

        const target =
          clean(serviceKeyword);

        return allowedServices.some(service => {
          const serviceText =
            clean(service);

          return (
            serviceText === target ||
            serviceText.includes(target) ||
            target.includes(serviceText)
          );
        });
      });

  const onlinePlayers =
    matchedPlayers.filter(player => player.status === 'available');

  const offlinePlayers =
    matchedPlayers.filter(player => player.status !== 'available');

  const options = [
    ...onlinePlayers.map(player => ({
      label: `🟢 ${String(player.name || player.discord_id)}`.slice(0, 100),
      description: '目前在線，可直接安排'.slice(0, 100),
      value: `online_${player.discord_id}`
    })),

    ...offlinePlayers.map(player => ({
      label: `⚪ ${String(player.name || player.discord_id)}`.slice(0, 100),
      description: formatAvailableTime(player).slice(0, 100),
      value: `reserve_${player.discord_id}`
    }))
  ].slice(0, 25);

  if (!options.length) {
    return channel.send(
      `❌ 目前沒有符合條件的陪陪。\n` +
      `性別偏好：${pending.genderPreference || '不指定'}\n` +
      `服務：${serviceKeyword || '未填寫'}`
    );
  }

  const maxValues =
    Math.min(
      Number(pending.playerCount || 1),
      options.length
    );

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(`service_selected_players_${flowId}`)
      .setPlaceholder(`請選擇指定陪陪，最多 ${maxValues} 位`)
      .setMinValues(1)
      .setMaxValues(maxValues)
      .addOptions(options);

  await channel.send({
    content:
      `請選擇指定陪陪：\n` +
      `🟢 在線：可直接安排\n` +
      `⚪ 不在線：可查看可接單時間並預約`,
    components: [
      new ActionRowBuilder().addComponents(menu)
    ]
  });
}
async function handleServiceAssignSelect(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const flowId =
    interaction.customId.replace('service_assign_', '');

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: '❌ 這筆訂單流程已過期。'
    });
  }

  pending.assignMode = interaction.values[0];
  pendingServiceOrders.set(flowId, pending);
  if (pending.assignMode === '不指定') {
    return interaction.editReply({
      content: '✅ 已選擇指定方式：不指定陪陪'
    });
  }
  await showServicePlayerSelect(
    interaction.channel,
    flowId,
    pending
  );
  return interaction.editReply({
    content:
      `✅ 已選擇指定方式：${pending.assignMode}\n` +
      `請在頻道內選擇陪陪。`
  });
}
async function handleServiceSelectedPlayersSelect(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const flowId =
    interaction.customId.replace('service_selected_players_', '');

  const pending =
    pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: '❌ 這筆訂單流程已過期。'
    });
  }

  const selectedValues =
    interaction.values || [];

  const playerIds =
    selectedValues
      .map(value =>
        String(value)
          .replace('online_', '')
          .replace('reserve_', '')
      )
      .filter(Boolean);

  const reserveIds =
    selectedValues
      .filter(value => String(value).startsWith('reserve_'))
      .map(value => String(value).replace('reserve_', ''));

  pending.selectedPlayerIds = playerIds;
  pending.selectedPlayerType =
    reserveIds.length > 0
      ? 'reserve'
      : 'online';

  if (reserveIds.length > 0) {
    pending.assignMode = '預約指定';
  }

  pendingServiceOrders.set(flowId, pending);

  if (reserveIds.length > 0) {
    const { data: players } =
      await supabase
        .from('players')
        .select('*')
        .in('discord_id', reserveIds);

    const availableText =
      (players || [])
        .map(player => {
          return `<@${player.discord_id}>：${formatAvailableTime(player)}`;
        })
        .join('\n') || '未填寫可接時間';

    await interaction.channel.send({
      content:
        `⚪ 你選擇了不在線 / 可預約的陪陪：\n` +
        `${availableText}\n\n` +
        `請在備註或頻道內告訴客服想預約的時間。`
    });
  }

  await showFinishNeedButtons(interaction.channel, flowId);
  return interaction.editReply({
    content:
      `✅ 已選擇陪陪：${playerIds.map(id => `<@${id}>`).join('、')}\n` +
      `請確認需求無誤後，按下方「送出訂單」。`
  });
}
async function handleServiceDurationSelect(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const flowId =
    interaction.customId.replace('service_duration_', '');

  const pending =
    pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: '❌ 這筆訂單流程已過期。'
    });
  }

  pending.duration = interaction.values[0];

  pendingServiceOrders.set(flowId, pending);

  await showFinishNeedButtons(interaction.channel, flowId);

  return interaction.editReply({
    content:
      pending.duration === 'custom'
        ? '✅ 已選擇自訂時間，請在頻道內告訴客服想要的時間。'
        : `✅ 已選擇時間：${pending.duration} 小時`
  });
}

async function handleServiceRoundsSelect(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const flowId =
    interaction.customId.replace('service_rounds_', '');

  const pending =
    pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: '❌ 這筆訂單流程已過期。'
    });
  }

  pending.rounds = interaction.values[0];

  pendingServiceOrders.set(flowId, pending);

  await showFinishNeedButtons(interaction.channel, flowId);

  return interaction.editReply({
    content:
      pending.rounds === 'custom'
        ? '✅ 已選擇自訂局數，請在頻道內告訴客服想要的局數。'
        : `✅ 已選擇局數：${pending.rounds} 局`
  });
}

async function handleSteamCategorySelect(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const flowId =
    interaction.customId.replace('steam_category_', '');

  const pending =
    pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: '❌ 這筆訂單流程已過期。'
    });
  }

  pending.steamCategory = interaction.values[0];

  pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content: `✅ 已選擇 Steam 類型：${pending.steamCategory}`
  });
}

async function handleDeltaModeSelect(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const flowId =
    interaction.customId.replace('delta_mode_', '');

  const pending =
    pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: '❌ 這筆訂單流程已過期。'
    });
  }

  pending.deltaMode = interaction.values[0];

  pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content: `✅ 已選擇三角洲玩法：${pending.deltaMode}`
  });
}
async function showFinishNeedButtons(channel, flowId) {
  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`order_add_note_${flowId}`)
          .setLabel('填寫備註')
          .setStyle(ButtonStyle.Secondary),

        new ButtonBuilder()
          .setCustomId(`order_finish_need_${flowId}`)
          .setLabel('送出訂單')
          .setEmoji('📨')
          .setStyle(ButtonStyle.Success)
      );

  await channel.send({
    content: '需求填寫完成後，請按「送出訂單」。',
    components: [row]
  });
}
async function finishServiceNeed(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const flowId =
    interaction.customId.replace('order_finish_need_', '');

  const pending =
    pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: '❌ 這筆訂單流程已過期。'
    });
  }

  const embed =
    new EmbedBuilder()
      .setColor('#ffd166')
      .setTitle('📋 待客服報價訂單')
      .addFields(
        {
          name: '客人',
          value: `<@${pending.customerId}>`,
          inline: true
        },
        {
          name: '服務類型',
          value: getServiceName(pending.category),
          inline: true
        },
        {
          name: '服務內容',
          value:
            pending.steamGameName ||
            pending.serviceType ||
            pending.steamCategory ||
            pending.deltaMode ||
            '未填寫',
          inline: true
        },
        {
          name: '模式 / 段位',
          value:
            `${pending.playMode || '無'} / ${pending.rank || '無'}`,
          inline: true
        },
        {
          name: '陪陪人數',
          value: `${pending.playerCount || 1} 位`,
          inline: true
        },
        {
          name: '性別偏好',
          value: pending.genderPreference || '不指定',
          inline: true
        },
        {
          name: '指定方式',
          value: pending.assignMode || '不指定',
          inline: true
        },
        {
          name: '時間 / 局數',
          value:
            pending.duration
              ? `${pending.duration} 小時`
              : pending.rounds
                ? `${pending.rounds} 局`
                : '未填寫',
          inline: true
        },
        {
          name: '備註',
          value: pending.note || '無',
          inline: false
        }
      )
      .setFooter({
        text: '正式價格請由客服輸入'
      })
      .setTimestamp();

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`service_quote_price_${flowId}`)
          .setLabel('輸入價格')
          .setEmoji('💰')
          .setStyle(ButtonStyle.Success)
      );
  await interaction.channel.send({
    content: `<@&${process.env.STAFF_ROLE}> 有新的訂單需求等待報價。`,
    embeds: [embed],
    components: [row]
  });
  return interaction.editReply({
    content: '✅ 已送出需求，請等待客服報價。'
  });
}
async function openServiceQuotePriceModal(interaction) {
  if (
    !interaction.member.roles.cache.has(process.env.STAFF_ROLE) &&
    !interaction.member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return interaction.reply({
      content: '❌ 只有客服可以填寫報價',
      flags: 64
    });
  }

  const flowId =
    interaction.customId.replace('service_quote_price_', '');

  const pending =
    pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.reply({
      content: '❌ 這筆訂單流程已過期，請重新下單。',
      flags: 64
    });
  }

  const modal =
    new ModalBuilder()
      .setCustomId(`submit_service_quote_price_${flowId}`)
      .setTitle('客服輸入正式報價');

  const priceInput =
    new TextInputBuilder()
      .setCustomId('price')
      .setLabel('請輸入正式報價金額')
      .setPlaceholder('例如：560')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(priceInput)
  );

  return interaction.showModal(modal);
}
async function submitServiceQuotePrice(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  if (
    !interaction.member.roles.cache.has(process.env.STAFF_ROLE) &&
    !interaction.member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return interaction.editReply({
      content: '❌ 只有客服可以填寫報價'
    });
  }

  const flowId =
    interaction.customId.replace('submit_service_quote_price_', '');

  const pending =
    pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: '❌ 這筆訂單流程已過期，請重新下單。'
    });
  }

  const priceText =
    interaction.fields.getTextInputValue('price');

  const price =
    Number(String(priceText || '').replace(/[^\d]/g, ''));

  if (!price || price <= 0) {
    return interaction.editReply({
      content: '❌ 金額格式錯誤，請輸入大於 0 的數字'
    });
  }

  pending.quotedPrice = price;
  pendingServiceOrders.set(flowId, pending);

  const paymentMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`service_payment_method_${flowId}`)
      .setPlaceholder('請選擇付款方式')
      .addOptions([
        {
          label: '儲值卡 / 錢包',
          value: '儲值卡'
        },
        {
          label: '月結付款',
          value: '月結'
        },
        {
          label: '匯款 / 轉帳',
          value: '匯款'
        },
        {
          label: '刷卡',
          value: '刷卡'
        },
        {
          label: '無卡',
          value: '無卡'
        },
        {
          label: '虛擬貨幣',
          value: '虛擬貨幣'
        }
      ]);

  await interaction.channel.send({
    content:
      `<@${pending.customerId}> 客服已完成報價，請選擇付款方式。`,
    embeds: [
      new EmbedBuilder()
        .setColor('#57F287')
        .setTitle('💰 正式報價單')
        .setDescription(
          `服務：${getServiceName(pending.category)}\n` +
          `金額：NT$${price.toLocaleString('zh-TW')}\n\n` +
          `請選擇付款方式，付款完成後請上傳付款證明。`
        )
        .setTimestamp()
    ],
    components: [
      new ActionRowBuilder().addComponents(paymentMenu)
    ]
  });

  return interaction.editReply({
    content: `✅ 已送出正式報價：NT$${price.toLocaleString('zh-TW')}`
  });
}
async function openServiceOrderNoteModal(interaction) {
  const flowId =
    interaction.customId.replace('order_add_note_', '');

  const pending =
    pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.reply({
      content: '❌ 這筆訂單流程已過期，請重新下單。',
      flags: 64
    });
  }

  const modal =
    new ModalBuilder()
      .setCustomId(`submit_service_order_note_${flowId}`)
      .setTitle('填寫訂單備註');

  const noteInput =
    new TextInputBuilder()
      .setCustomId('note')
      .setLabel('請輸入備註 / 自訂需求')
      .setPlaceholder('例如：指定時間、遊戲名稱、希望氣氛、特殊需求等')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(noteInput)
  );

  return interaction.showModal(modal);
}

async function submitServiceOrderNote(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const flowId =
    interaction.customId.replace('submit_service_order_note_', '');

  const pending =
    pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: '❌ 這筆訂單流程已過期，請重新下單。'
    });
  }

  const note =
    interaction.fields.getTextInputValue('note') || '';

  pending.note = note || '無';
  pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content: '✅ 已儲存備註'
  });
}
async function openSteamGameNameModal(interaction) {
  const flowId =
    interaction.customId.replace('steam_game_name_', '');

  const pending =
    pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.reply({
      content: '❌ 這筆訂單流程已過期',
      flags: 64
    });
  }

  const modal =
    new ModalBuilder()
      .setCustomId(`submit_steam_game_name_${flowId}`)
      .setTitle('Steam 遊戲名稱');

  const gameInput =
    new TextInputBuilder()
      .setCustomId('game_name')
      .setLabel('請輸入遊戲名稱')
      .setPlaceholder('例如：Lethal Company')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(gameInput)
  );

  return interaction.showModal(modal);
}

async function submitSteamGameName(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const flowId =
    interaction.customId.replace(
      'submit_steam_game_name_',
      ''
    );

  const pending =
    pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: '❌ 這筆訂單流程已過期'
    });
  }

  pending.steamGameName =
    interaction.fields.getTextInputValue('game_name');

  pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content:
      `✅ 已設定遊戲名稱：${pending.steamGameName}`
  });
}
function buildServiceTextFromPending(pending) {
  if (pending.category === 'valorant') {
    return [
      '特戰英豪',
      pending.serviceType,
      pending.playMode,
      pending.rank,
      pending.duration ? `${pending.duration}小時` : '',
      pending.rounds ? `${pending.rounds}局` : ''
    ].filter(Boolean).join('｜');
  }

  if (pending.category === 'steam') {
    return [
      'Steam',
      pending.steamCategory,
      pending.steamGameName,
      pending.duration ? `${pending.duration}小時` : ''
    ].filter(Boolean).join('｜');
  }

  if (pending.category === 'delta') {
    return [
      '三角洲',
      pending.deltaMode,
      pending.duration ? `${pending.duration}小時` : '',
      pending.rounds ? `${pending.rounds}局` : ''
    ].filter(Boolean).join('｜');
  }

  if (pending.category === 'chat') {
    return [
      '陪聊',
      pending.duration ? `${pending.duration}小時` : ''
    ].filter(Boolean).join('｜');
  }

  if (pending.category === 'emotion') {
    return [
      '出氣包',
      pending.duration ? `${pending.duration}小時` : ''
    ].filter(Boolean).join('｜');
  }

  return '陪玩訂單';
}

async function createPlayOrderFromServicePending(pending, channelId) {
  const amount =
    Number(pending.quotedPrice || 0);

  if (!amount || amount <= 0) {
    throw new Error('尚未報價，不能建立訂單');
  }

  const serviceText =
    buildServiceTextFromPending(pending);

  const preferredPlayer =
    pending.selectedPlayerIds?.length
      ? pending.selectedPlayerIds.join(',')
      : null;

  const { data, error } =
    await supabase
      .from('play_orders')
      .insert({
        order_no: `ORD-${Date.now()}`,

        customer_id: pending.customerId,
        customer_username: pending.customerUsername || `<@${pending.customerId}>`,
        customer_name: `<@${pending.customerId}>`,

        channel_id: channelId,
        source_channel_id: channelId,

        game: getServiceName(pending.category),
        service: serviceText,
        order_type: '訂單',
        order_item: serviceText,

        rank_preference: pending.rank || null,
        player_count: Number(pending.playerCount || 1),
        gender_preference: pending.genderPreference || '不指定',

        preferred_player: preferredPlayer,
        reserved_player:
          pending.assignMode === '預約指定'
            ? preferredPlayer
            : null,
        dispatch_type:
          pending.selectedPlayerType === 'reserve'
            ? 'reserve'
            : null,
        assigned_player: null,

        duration_text:
          pending.duration
            ? `${pending.duration} 小時`
            : pending.rounds
              ? `${pending.rounds} 局`
              : null,

        note: pending.note || '',

        price: amount,
        final_price: amount,
        payment_method: pending.paymentMethod || null,

        paid: false,
        paid_at: null,

        salary_paid: false,
        salary_paid_at: null,

        status: 'waiting_payment'
      })
      .select()
      .single();

  if (error || !data) {
    console.error('[新版下單] 建立 play_orders 失敗', error);
    throw new Error(error?.message || '建立訂單失敗');
  }

  return data;
}
async function handleServicePaymentMethodSelect(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const flowId =
    interaction.customId.replace('service_payment_method_', '');

  const pending =
    pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: '❌ 這筆訂單流程已過期，請重新下單。'
    });
  }

  if (interaction.user.id !== pending.customerId) {
    return interaction.editReply({
      content: '❌ 只有下單的闆闆可以選擇付款方式。'
    });
  }

  const paymentMethod =
    interaction.values[0];

  pending.paymentMethod = paymentMethod;
  pendingServiceOrders.set(flowId, pending);

  let order;

  try {
    order =
      await createPlayOrderFromServicePending(
        pending,
        interaction.channel.id
      );
  } catch (err) {
    console.error('[新版下單] 建立訂單失敗', err);
    return interaction.editReply({
      content: `❌ 建立訂單失敗：${err.message || err}`
    });
  }

  if (paymentMethod === '儲值卡') {
    try {
      if (!paymentHelpers.payOrderByWallet) {
        throw new Error('儲值卡付款函式尚未接入');
      }

      const result =
        await paymentHelpers.payOrderByWallet(order);
      await supabase
        .from('play_orders')
        .update({
          status: 'pending',
          quote_status: 'dispatched',
          updated_at: new Date().toISOString()
        })
        .eq('id', order.id);
      const { data: paidOrder } =
        await supabase
          .from('play_orders')
          .select('*')
          .eq('id', order.id)
          .single();

      await interaction.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor('#57F287')
            .setTitle('✅ 儲值卡付款完成')
            .setDescription(
              `<@${order.customer_id}> 已使用儲值卡 / 錢包完成付款。\n\n` +
              `扣款金額：${result.amount} ASD\n` +
              `剩餘餘額：${result.finalCoins} ASD\n\n` +
              `系統已自動派單。`
            )
            .setTimestamp()
        ]
      });

      await sendOrderToStaffChannel(paidOrder || order);
      await sendStaffOrderControlPanel(
        interaction.channel,
        paidOrder || order
      );
      pendingServiceOrders.delete(flowId);

      return interaction.editReply({
        content: '✅ 已使用儲值卡付款，並已派單。'
      });
    } catch (err) {
      console.error('[新版下單] 儲值卡付款失敗', err);
      return interaction.editReply({
        content: `❌ 儲值卡付款失敗：${err.message || err}`
      });
    }
  }

  if (paymentMethod === '月結') {
    try {
      if (!paymentHelpers.payOrderByMonthly) {
        throw new Error('月結付款函式尚未接入');
      }

      const result =
        await paymentHelpers.payOrderByMonthly(order);
      await supabase
        .from('play_orders')
        .update({
          status: 'pending',
          quote_status: 'dispatched',
          updated_at: new Date().toISOString()
        })
        .eq('id', order.id);
      const { data: paidOrder } =
        await supabase
          .from('play_orders')
          .select('*')
          .eq('id', order.id)
          .single();

      await interaction.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor('#57F287')
            .setTitle('✅ 月結付款完成')
            .setDescription(
              `<@${order.customer_id}> 已使用月結付款。\n\n` +
              `本次扣額：NT$${result.amount}\n` +
              `回饋：${result.cashback} ASD\n` +
              `剩餘月結額度：NT$${result.availableAmount}\n\n` +
              `系統已自動派單。`
            )
            .setTimestamp()
        ]
      });

      await sendOrderToStaffChannel(paidOrder || order);
      await sendStaffOrderControlPanel(
        interaction.channel,
        paidOrder || order
      );
      pendingServiceOrders.delete(flowId);
      return interaction.editReply({
        content: '✅ 已使用月結付款，並已派單。'
      });
    } catch (err) {
      console.error('[新版下單] 月結付款失敗', err);
      return interaction.editReply({
        content: `❌ 月結付款失敗：${err.message || err}`
      });
    }
  }

  if (paymentMethod === '匯款') {
    await sendBankTransferInfo(interaction.channel);
  }

  if (paymentMethod === '刷卡') {
    await sendCardPaymentInfo(interaction.channel);
  }

  if (paymentMethod === '無卡') {
    await sendNoCardPaymentInfo(interaction.channel);
  }

  if (paymentMethod === '虛擬貨幣') {
    await interaction.channel.send({
      content:
        `<@${pending.customerId}> 你選擇了虛擬貨幣付款。\n` +
        `請等待客服提供錢包地址，付款後請上傳付款證明。`
    });
  }

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`service_confirm_paid_${order.id}`)
          .setLabel('客服確認付款，派單')
          .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
          .setCustomId(`service_cancel_order_${order.id}`)
          .setLabel('取消訂單')
          .setStyle(ButtonStyle.Danger)
      );

  await interaction.channel.send({
    content:
      `<@&${process.env.STAFF_ROLE}> 客人已選擇付款方式：${paymentMethod}\n` +
      `付款完成並確認明細後，請按「客服確認付款，派單」。`,
    components: [row]
  });

  pendingServiceOrders.delete(flowId);

  return interaction.editReply({
    content: `✅ 已選擇付款方式：${paymentMethod}，請依照頻道內資訊完成付款。`
  });
}
async function handleServiceConfirmPaid(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const isStaff =
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.editReply({
      content: '❌ 只有客服可以確認付款'
    });
  }

  const orderId =
    interaction.customId.replace('service_confirm_paid_', '');

  const { data: order, error } =
    await supabase
      .from('play_orders')
      .update({
        paid: true,
        paid_at: new Date().toISOString(),
        status: 'pending',
        quote_status: 'dispatched',
        updated_at: new Date().toISOString()
      })
      .eq('id', orderId)
      .select()
      .single();

  if (error || !order) {
    console.error('[新版下單] 客服確認付款失敗', error);
    return interaction.editReply({
      content: '❌ 確認付款失敗'
    });
  }

  if (paymentHelpers.countOrderVipSpentOnce) {
    await paymentHelpers.countOrderVipSpentOnce(
      order,
      '客服確認新版訂單付款完成'
    );
  }
  await sendOrderToStaffChannel(order);
  await sendStaffOrderControlPanel(
    interaction.channel,
    order
  );
  return interaction.editReply({
    content: '✅ 已確認付款，並已派單，客服操作面板也已送出。'
  });
}
async function handleServiceCancelOrder(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const isStaff =
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.editReply({
      content: '❌ 只有客服可以取消訂單'
    });
  }

  const orderId =
    interaction.customId.replace('service_cancel_order_', '');

  const { error } =
    await supabase
      .from('play_orders')
      .update({
        status: 'cancelled',
        updated_at: new Date().toISOString()
      })
      .eq('id', orderId);

  if (error) {
    console.error('[新版下單] 取消訂單失敗', error);
    return interaction.editReply({
      content: '❌ 取消訂單失敗'
    });
  }

  return interaction.editReply({
    content: '✅ 已取消訂單'
  });
}
async function handleServiceDurationSelect(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const flowId =
    interaction.customId.replace('service_duration_', '');

  const pending =
    pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: '❌ 這筆訂單流程已過期。'
    });
  }

  pending.duration = interaction.values[0];

  pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content:
      pending.duration === 'custom'
        ? '✅ 已選擇自訂時間，請在頻道內告訴客服想要的時間。'
        : `✅ 已選擇時間：${pending.duration} 小時`
  });
}
async function handleDispatchInteraction(interaction) {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === '上班') {
      await playerOnline(interaction);
      return true;
    }
    if (interaction.commandName === '下班') {
      await playerOffline(interaction);
      return true;
    }
    if (interaction.commandName === '我的狀態') {
      await playerStatus(interaction);
      return true;
    }

  }

  if (interaction.isButton()) {
    // ===== 陪玩控制 =====
    if (interaction.customId ==='open_topup_modal') {
      await openTopupModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith('confirm_topup_')) {
      if (
        !interaction.member.roles.cache.has(
          process.env.STAFF_ROLE
        )
      ) {
        return interaction.editReply({
          content: '❌ 只有客服可以確認儲值',
        });
      }
      await confirmTopup(interaction);
      return true;
    }
    if (interaction.customId === 'order_start_valorant') {
      await createServiceTicket(interaction, 'valorant');
      return true;
    }

    if (interaction.customId === 'order_start_steam') {
      await createServiceTicket(interaction, 'steam');
      return true;
    }

    if (interaction.customId === 'order_start_delta') {
      await createServiceTicket(interaction, 'delta');
      return true;
    }

    if (interaction.customId === 'order_start_chat') {
      await createServiceTicket(interaction, 'chat');
      return true;
    }

    if (interaction.customId === 'order_start_emotion') {
      await createServiceTicket(interaction, 'emotion');
      return true;
    }

    if (interaction.customId === 'order_start_topup') {
      await createTopupTicket(interaction);
      return true;
    }

    if (interaction.customId === 'order_start_tip') {
      await createTipTicket(interaction);
      return true;
    }
    if (interaction.customId.startsWith('valorant_type_')) {
      await handleValorantTypeButton(interaction);
      return true;
    }

    if (interaction.customId.startsWith('valorant_mode_')) {
      await handleValorantModeButton(interaction);
      return true;
    }
    if (interaction.customId.startsWith('order_add_note_')) {
      await openServiceOrderNoteModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith('steam_game_name_')) {
      await openSteamGameNameModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith('order_finish_need_')) {
      await finishServiceNeed(interaction);
      return true;
    }
    if (interaction.customId.startsWith('service_quote_price_')) {
      await openServiceQuotePriceModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith('service_confirm_paid_')) {
      await handleServiceConfirmPaid(interaction);
      return true;
    }
    if (interaction.customId.startsWith('service_cancel_order_')) {
      await handleServiceCancelOrder(interaction);
      return true;
    }
    if (interaction.customId === 'open_play_order_form') {
      await openPlayOrderModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith('change_order_price_')) {
      await openChangeOrderPriceModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith('save_order_note_')) {
      await openSaveOrderNoteModal(interaction);
      return true;
    } 
    if (interaction.customId.startsWith('saved_order_end_')) {
      await handleSavedOrderEnd(interaction);
      return true;
    }
    if (interaction.customId.startsWith('dispatch_assign_players_')) {
      await openDispatchPlayerMenu(interaction);
      return true;
    }
    if (interaction.customId === 'player_online') {
      await playerOnline(interaction);
      return true; 
    }
    if (interaction.customId === 'player_offline') {
      await playerOffline(interaction);
      return true;
    }
    if (interaction.customId === 'player_status') {
      await playerStatus(interaction);
      return true;
    }
    if (interaction.customId.startsWith('new_order_note_yes_')) {
      await openNewOrderNoteModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith('new_order_back_')) {
      await handleNewOrderBack(interaction);
      return true;
    }
    if (interaction.customId.startsWith('new_order_note_no_')) {
      await handleNewOrderNoNote(interaction);
      return true;
    }
    if (interaction.customId.startsWith('staff_quote_price_')) {
      await openStaffQuotePriceModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith('dispatch_assign_players_')) {
      await openDispatchPlayerMenu(interaction);
      return true;
    }
    if (interaction.customId.startsWith('staff_confirm_order_paid_')) {
      await handleStaffConfirmOrderPaid(interaction);
      return true;
    }
    if (interaction.customId.startsWith('quote_no_coupon_')) {
      await handleQuoteNoCoupon(interaction);
      return true;
    }
    if (interaction.customId.startsWith('quote_use_coupon_')) {
      await handleQuoteUseCoupon(interaction);
      return true;
    }
    if (interaction.customId.startsWith('customer_confirm_order_')) {
      await handleCustomerConfirmOrder(interaction);
      return true;
    }
    if (interaction.customId.startsWith('customer_order_wrong_')) {
      await handleCustomerOrderWrong(interaction);
      return true;
    }
    if (interaction.customId.startsWith('staff_edit_order_')) {
      await openStaffEditOrderModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith('new_order_back_')) {
      await handleNewOrderBack(interaction);
      return true;
    }
    if (interaction.customId.startsWith('extend_order_')) {
      await openExtendOrderModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith('staff_confirm_extension_paid_')) {
      await handleStaffConfirmExtensionPaid(interaction);
      return true;
    }
    //  ==== 接單 =====
    if (interaction.customId.startsWith('accept_play_order_')) {
      await acceptPlayOrder(interaction);
      return true;
    }
   }
  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('submit_staff_edit_order_')) {
      await submitStaffEditOrder(interaction);
      return true;
    }
    if (interaction.customId.startsWith('submit_staff_quote_price_')) {
      await submitStaffQuotePrice(interaction);
      return true;
    }
    if (interaction.customId.startsWith('submit_service_quote_price_')) {
      await submitServiceQuotePrice(interaction);
      return true;
    }
    if (interaction.customId.startsWith('submit_service_order_note_')) {
      await submitServiceOrderNote(interaction);
      return true;
    }
    if (interaction.customId.startsWith('submit_steam_game_name_')) {
      await submitSteamGameName(interaction);
      return true;
    }
    if (interaction.customId.startsWith('submit_new_order_note_')) {
      await submitNewOrderNote(interaction);
      return true;
    }
    if (interaction.customId.startsWith('submit_new_order_reserve_time_')) {
      await submitNewOrderReserveTime(interaction);
      return true;
    }
    if (interaction.customId === 'submit_topup_form') {
      await submitTopupForm(interaction);
      return true;
    }
    if (interaction.customId.startsWith('submit_change_order_price_')) {
      await submitChangeOrderPrice(interaction);
      return true;
    }
    if (interaction.customId.startsWith('submit_save_order_note_')) {
      await submitSaveOrderNote(interaction);
      return true;
    }
    if (interaction.customId.startsWith('submit_extend_order_')) {
      await submitExtendOrder(interaction);
      return true;
    }
  }
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId.startsWith('quote_select_coupon_')) {
      await handleQuoteSelectCoupon(interaction);
      return true;
    }
    if (interaction.customId.startsWith('quote_payment_method_')) {
      await handleQuotePaymentMethodSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith('valorant_rank_')) {
      await handleValorantRankSelect(interaction);
      return true;
    }

    if (interaction.customId.startsWith('service_player_count_')) {
      await handleServicePlayerCountSelect(interaction);
      return true;
    }

    if (interaction.customId.startsWith('service_gender_')) {
      await handleServiceGenderSelect(interaction);
      return true;
    }

    if (interaction.customId.startsWith('service_assign_')) {
      await handleServiceAssignSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith('service_selected_players_')) {
      await handleServiceSelectedPlayersSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith('service_duration_')) {
      await handleServiceDurationSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith('service_rounds_')) {
      await handleServiceRoundsSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith('steam_category_')) {
      await handleSteamCategorySelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith('delta_mode_')) {
      await handleDeltaModeSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith('service_payment_method_')) {
      await handleServicePaymentMethodSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith('new_order_game_')) {
      await handleNewOrderGameSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith('new_order_item_')) {
      await handleNewOrderItemSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith('new_order_rank_')) {
      await handleNewOrderRankSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith('new_order_count_')) {
      await handleNewOrderCountSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith('new_order_gender_')) {
      await handleNewOrderGenderSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith('new_order_player_')) {
      await handleNewOrderPlayerSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith('new_order_duration_')) {
      await handleNewOrderDurationSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith('submit_dispatch_players_')) {
      await submitDispatchPlayers(interaction);
      return true;
    }
    if (interaction.customId.startsWith('topup_payment_method_')) {
      await handleTopupPaymentMethodSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith('extension_payment_method_')) {
      await handleExtensionPaymentMethodSelect(interaction);
      return true;
    }
  }
  return false;
}

module.exports = {
  setup,
  handleDispatchInteraction,
  sendPlayerPanel,
  startNewOrderFlow,
  sendDailyPlayerSummary,
  submitTopupForm,
  openTopupModal,
  openPlayOrderModal,
  openChangeOrderPriceModal,
  submitChangeOrderPrice,
  openSaveOrderNoteModal,
  submitSaveOrderNote,
  sendOrderToStaffChannel,
  openDispatchPlayerMenu,
  submitDispatchPlayers,
  handleSavedOrderEnd
};