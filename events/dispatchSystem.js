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

  const selectedValue =
    interaction.values[0];

  if (selectedValue === 'none') {
    pending.selectedPlayerType = 'none';
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pendingNewOrders.set(flowId, pending);

    return await showDurationSelect(interaction, flowId, pending);
  }

  if (selectedValue.startsWith('online_')) {
    const playerId =
      selectedValue.replace('online_', '');

    pending.selectedPlayerType = 'online';
    pending.selectedPlayerId = playerId;
    pending.selectedPlayerIds = [playerId];
    pendingNewOrders.set(flowId, pending);

    return await showDurationSelect(interaction, flowId, pending);
  }

  if (selectedValue.startsWith('reserve_')) {
    const playerId =
      selectedValue.replace('reserve_', '');

    pending.selectedPlayerType = 'reserve';
    pending.selectedPlayerId = playerId;
    pending.selectedPlayerIds = [playerId];
    pendingNewOrders.set(flowId, pending);

    const { data: player } =
      await supabase
        .from('players')
        .select('*')
        .eq('discord_id', playerId)
        .maybeSingle();

    const availableText =
      player
        ? formatAvailableTime(player)
        : '未填寫可接時間';

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

    reserveInput.setPlaceholder(
      `可接時間：${availableText}`.slice(0, 100)
    );
    return interaction.showModal(modal);
      }
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

  const playerText =
    pending.selectedPlayerType === 'none'
      ? '不指定陪陪'
      : `<@${pending.selectedPlayerId}>`;

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

  const playerText =
    pending.selectedPlayerType === 'none'
      ? '不指定陪陪'
      : `<@${pending.selectedPlayerId}>`;

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

  const preferredPlayer =
    pending.selectedPlayerId
      ? pending.selectedPlayerId
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
          value: preferredPlayer ? `<@${preferredPlayer}>` : '不指定',
          inline: true
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

  modal.addComponents(
    new ActionRowBuilder().addComponents(serviceInput),
    new ActionRowBuilder().addComponents(timeInput),
    new ActionRowBuilder().addComponents(noteInput)
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

  const updateData = {
    quote_status: 'fixed',
    status: 'quoted'
  };

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
    if (order.preferred_player) {
      const preferredPlayers =
        String(order.preferred_player)
          .split(',')
          .map(id => id.trim())
          .filter(Boolean);
      if (
        preferredPlayers.length &&
        !preferredPlayers.includes(interaction.user.id)
      ) {
        return interaction.editReply({
          content:
            `❌ 這張訂單只開放指定陪陪接單：` +
            preferredPlayers.map(id => `<@${id}>`).join('、')
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