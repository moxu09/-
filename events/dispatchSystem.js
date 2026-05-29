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
const pendingPlayOrders = new Map();

function setup(supabaseInstance, clientInstance) {
  supabase = supabaseInstance;
  client = clientInstance;
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
      `🔗 付款連結：https://pcpay.tw/aUPZY\n\n` +
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

  return (players || [])
    .filter(player => {
      const allowedServices =
        Array.isArray(player.allowed_services)
          ? player.allowed_services
          : String(player.allowed_services || '')
              .split(',')
              .map(s => s.trim())
              .filter(Boolean);

      if (!allowedServices.length) return true;

      return allowedServices.some(s =>
        service.includes(s)
      );
    })
    .slice(0, 24)
    .map(player => ({
      label: String(player.name || player.discord_id).slice(0, 100),
      description: formatAvailableTime(player).slice(0, 100),
      value: player.discord_id
    }));
}
async function getOfflinePlayerOptions(service) {
  const { data: players, error } =
    await supabase
      .from('players')
      .select('*')
      .neq('status', 'available');

  if (error) {
    console.error('[預約陪陪] 讀取未上線陪陪失敗', error);
    return [];
  }

  return (players || [])
    .filter(player => {
      const allowedServices =
        Array.isArray(player.allowed_services)
          ? player.allowed_services
          : String(player.allowed_services || '')
              .split(',')
              .map(s => s.trim())
              .filter(Boolean);

      if (!allowedServices.length) return true;

      return allowedServices.some(s =>
        String(service || '').includes(s)
      );
    })
    .slice(0, 24)
    .map(player => ({
      label: String(player.name || player.discord_id).slice(0, 90),
      description: formatAvailableTime(player).slice(0, 100),
      value: player.discord_id
    }));
}
async function getCustomerPreferredPlayerOptions(service) {
  const onlineOptions =
    await getAvailablePlayerOptions(service);

  const offlineOptions =
    await getOfflinePlayerOptions(service);

  const options = [
    {
      label: '不指定陪陪',
      description: '讓可接單陪陪自由接單',
      value: 'no_preference'
    },

    ...onlineOptions.map(option => ({
      label: `🟢 ${option.label}`.slice(0, 100),
      description: String(option.description || '未填寫可接時間').slice(0, 100),
      value: `online_${option.value}`
    })),

    ...offlineOptions.map(option => ({
      label: `⚪ ${option.label}`.slice(0, 100),
      description: String(option.description || '未填寫可接時間').slice(0, 100),
      value: `reserve_${option.value}`
    }))
  ];

  return options.slice(0, 25);
}
// ===== 更改訂單金額權限 =====
function canEditOrderPrice(interaction) {
  const roleId =
    process.env.PRICE_EDIT_ROLE ||
    process.env.STAFF_ROLE;

  return (
    interaction.guild.ownerId === interaction.user.id ||
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(roleId)
  );
}
function canChangePreferredPlayer(interaction, order) {
  const roleId =
    process.env.PRICE_EDIT_ROLE ||
    process.env.STAFF_ROLE;

  const isStaff =
    interaction.guild.ownerId === interaction.user.id ||
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(roleId);

  const isCustomer =
    order.customer_id === interaction.user.id;

  return isStaff || isCustomer;
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
          name: '🕒 預約時間',
          value: order.reserved_time || order.play_time || order.time || '未填寫',
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

  await channel.send({
    content:
      order.dispatch_type === 'reserve'
        ? `🕒 預約派單：<@${order.reserved_player}>｜時間：${order.reserved_time}`
        : order.preferred_player
          ? `🌟 指定陪陪派單：${preferredText}`
          : '📢 開放接單',
    embeds: [embed],
    components: [row]
  });
}

async function sendDispatchChoicePanel(interaction, order) {
  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`dispatch_assign_players_${order.id}`)
          .setLabel('指定陪陪派單')
          .setEmoji('🌟')
          .setStyle(ButtonStyle.Primary),

        new ButtonBuilder()
          .setCustomId(`dispatch_open_order_${order.id}`)
          .setLabel('開放自己接單')
          .setEmoji('📢')
          .setStyle(ButtonStyle.Success)
      );

  await interaction.channel.send({
    content:
      `<@&${process.env.STAFF_ROLE}> 請選擇這張訂單要怎麼派單。`,
    embeds: [
      new EmbedBuilder()
        .setColor('#66ccff')
        .setTitle('📌 訂單派單選擇')
        .setDescription(
          `訂單編號：${order.order_no || order.id}\n\n` +
          `你可以指定一位或多位陪陪，也可以開放給所有可接單陪陪自己接。`
        )
        .addFields(
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
          }
        )
        .setTimestamp()
    ],
    components: [row]
  });
}
// 建立陪玩訂單
async function createPlayOrder(
  interaction,
  service,
  time,
  price,
  note = '無',
  paymentMethod = '未填寫',
  preferredPlayerId = null,
  reservedTime = null,
  dispatchType = null
) {
  const orderNo = `DF-${Date.now()}`;
  const discountRate = 1;
  const finalPrice =
    Math.floor(price * discountRate);
  const discountText =
   '無折扣';
  const { data: order, error } = await supabase
    .from('play_orders')
    .insert({
      order_no: orderNo,
      customer_id: interaction.user.id,
      customer_username: interaction.user.username,
      channel_id: interaction.channel.id,
      service,
      price,
      final_price: finalPrice,
      discount_rate: discountRate,
      payment_method: paymentMethod,
      preferred_player: preferredPlayerId,
      reserved_player:
        dispatchType === 'reserve'
          ? preferredPlayerId
          : null,
      reserved_time: reservedTime,
      dispatch_type: dispatchType,
      paid: false,
      note,
      status: 'pending'
    })
    .select()
    .single();

  if (error) {
    console.log(error);
    return interaction.editReply({
      content: '❌ 建立訂單失敗',
    });
  }
  // ===== 有指定陪陪就直接發到員工接單區 =====
  // 不管是上線指定，還是預約未上線指定，都直接送出
  if (preferredPlayerId) {
  await sendOrderToStaffChannel(order);
  } else {
    await sendDispatchChoicePanel(interaction, order);
  }
  const preferredText =
  preferredPlayerId
    ? `<@${preferredPlayerId}>`
    : '不指定';

const orderTypeText =
  dispatchType === 'reserve'
    ? '預約未上線陪陪'
    : preferredPlayerId
      ? '指定陪陪'
      : '不指定陪陪';

const embed =
  new EmbedBuilder()
    .setColor('#00ff99')
    .setTitle('📋 陪玩訂單內容')
    .addFields(
      {
        name: '📌 訂單編號',
        value: order.order_no || orderNo,
        inline: true
      },
      {
        name: '👤 客人',
        value: `<@${interaction.user.id}>`,
        inline: true
      },
      {
        name: '🎮 服務項目',
        value: service || '未填寫',
        inline: false
      },
      {
        name: '🕒 需求時間',
        value: time || '未填寫',
        inline: true
      },
      {
        name: '📌 指定方式',
        value: orderTypeText,
        inline: true
      },
      {
        name: '🌟 陪陪',
        value: preferredText,
        inline: true
      },
      {
        name: '🕒 預約時間',
        value: reservedTime || '無',
        inline: true
      },
      {
        name: '💰 商品金額',
        value: `NT$${finalPrice}`,
        inline: true
      },
      {
        name: '💳 付款方式',
        value: paymentMethod || '未填寫',
        inline: true
      },
      {
        name: '📝 備註需求',
        value: note || '無',
        inline: false
      }
    )
    .setTimestamp();
  const priceEditRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`change_order_price_${order.id}`)
          .setLabel('💰 更改金額')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`dispatch_assign_players_${order.id}`)
          .setLabel('🌟 指定陪陪派單')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`save_order_note_${order.id}`)
          .setLabel('📝 存單')
          .setStyle(ButtonStyle.Success)
      );

  await interaction.channel.send({
    content: '📋 你的陪玩需求已送出，以下是目前訂單內容：',
    embeds: [embed],
    components: [priceEditRow]
  });
  if (isCardPayment(paymentMethod)) {
    await sendCardPaymentInfo(interaction.channel);
  } else if (isNoCardPayment(paymentMethod)) {
    await sendNoCardPaymentInfo(interaction.channel);
  } else if (isBankTransfer(paymentMethod)) {
    await sendBankTransferInfo(interaction.channel);
  }
  // ===== 派單紀錄 =====
  await sendPlayLog({
    title: '📦 新陪玩訂單',
    description:
      `訂單編號：${orderNo}\n` +
      `客人：<@${interaction.user.id}>\n` +
      `服務：${service}\n` +
      `商品金額（折前）：NT$${price}`
  });
  await interaction.editReply({
    content: '✅ 已送出陪玩訂單，請等待陪玩接單',
  });
}
async function sendPlayOrderFormButton(channel) {
  const embed = new EmbedBuilder()
    .setColor('#00ff99')
    .setTitle('📦 發派陪玩訂單')
    .setDescription(
      '請點擊下方按鈕填寫陪玩需求，送出後會自動發派到陪玩接單區。'
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('open_play_order_form')
      .setLabel('填寫陪玩需求')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("fill_tip_need")
      .setLabel("填寫打賞需求")
      .setStyle(ButtonStyle.Success)
  );
  await channel.send({
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
async function openPlayOrderModal(interaction) {

  const modal = new ModalBuilder()
    .setCustomId('submit_play_order_form')
    .setTitle('陪玩/陪伴需求');

  const serviceInput = new TextInputBuilder()
    .setCustomId('service')
    .setLabel('服務項目')
    .setPlaceholder('例如：三角洲：護航 / 陪伴：聊天')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const timeInput = new TextInputBuilder()
    .setCustomId('time')
    .setLabel('預約時間')
    .setPlaceholder('例如：今晚 8 點')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const priceInput = new TextInputBuilder()
    .setCustomId('price')
    .setLabel('商品金額（原價）')
    .setPlaceholder('例如：499')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const paymentInput = new TextInputBuilder()
    .setCustomId('payment_method')
    .setLabel('付款方式')
    .setPlaceholder('轉帳 / 無卡 / 信用卡 / 儲值卡 / 加密貨幣')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const noteInput = new TextInputBuilder()
    .setCustomId('note')
    .setLabel('需求備註')
    .setPlaceholder('例如：指定陪陪、可語音、急單')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(serviceInput),
    new ActionRowBuilder().addComponents(timeInput),
    new ActionRowBuilder().addComponents(priceInput),
    new ActionRowBuilder().addComponents(paymentInput),
    new ActionRowBuilder().addComponents(noteInput)
  );

  await interaction.showModal(modal);
}
async function openTopupModal(interaction) {

  const modal =
    new ModalBuilder()
      .setCustomId('submit_topup_form')
      .setTitle('💰 儲值申請');

  // ===== 金額 =====

  const amountInput =
    new TextInputBuilder()
      .setCustomId('amount')
      .setLabel('儲值金額')
      .setPlaceholder('例如：1000')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

  // ===== 付款方式 =====

  const methodInput =
    new TextInputBuilder()
      .setCustomId('method')
      .setLabel('付款方式')
      .setPlaceholder('匯款/無卡/信用卡/加密貨幣/美金轉帳')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

  // ===== 備註 =====

  const noteInput =
    new TextInputBuilder()
      .setCustomId('note')
      .setLabel('備註')
      .setPlaceholder('沒有可填無')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false);

  modal.addComponents(

    new ActionRowBuilder()
      .addComponents(amountInput),

    new ActionRowBuilder()
      .addComponents(methodInput),

    new ActionRowBuilder()
      .addComponents(noteInput)

  );

  await interaction.showModal(modal);

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
async function submitPlayOrderForm(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }

  const service =
    interaction.fields.getTextInputValue('service');

  const time =
    interaction.fields.getTextInputValue('time');

  const priceText =
    interaction.fields.getTextInputValue('price');

  let paymentMethod = '未填寫';
  try {
    paymentMethod =
      interaction.fields.getTextInputValue('payment_method') || '未填寫';
  } catch {}

  let note = '無';
  try {
    note =
      interaction.fields.getTextInputValue('note') || '無';
  } catch {}

  const price =
    parseInt(
      priceText.replace(/[^\d]/g, ''),
      10
    );

  if (!price || price <= 0) {
    return interaction.editReply({
      content: '❌ 價格格式錯誤，請輸入數字。'
    });
  }

  const selectId =
    `${interaction.user.id}_${Date.now()}`;

  pendingPlayOrders.set(selectId, {
    userId: interaction.user.id,
    service,
    time,
    price,
    note,
    paymentMethod
  });

  setTimeout(() => {
    pendingPlayOrders.delete(selectId);
  }, 10 * 60 * 1000);

  const onlineOptions =
    await getAvailablePlayerOptions(service);
  const offlineOptions =
    await getOfflinePlayerOptions(service);
  const onlineMenu =
    new StringSelectMenuBuilder()
      .setCustomId(`select_preferred_player_${selectId}`)
      .setPlaceholder('選擇不指定，或指定目前上線陪陪')
      .addOptions([
        {
          label: '不指定陪陪',
          description: '讓可接單陪陪自由接單',
          value: 'no_preference'
        },
        ...onlineOptions.slice(0, 24).map(option => ({
          label: `🟢 ${option.label}`.slice(0, 100),
          description: String(option.description || '未填寫可接時間').slice(0, 100),
          value: `online_${option.value}`
        }))
      ]);
  const rows = [
    new ActionRowBuilder().addComponents(onlineMenu)
  ];
  if (offlineOptions.length > 0) {
    const reserveMenu =
      new StringSelectMenuBuilder()
        .setCustomId(`select_reserve_player_${selectId}`)
        .setPlaceholder('預約未上線陪陪')
        .addOptions(
          offlineOptions.slice(0, 25).map(option => ({
            label: `⚪ ${option.label}`.slice(0, 100),
            description: String(option.description || '未填寫可接時間').slice(0, 100),
            value: `reserve_${option.value}`
          }))
        );
    rows.push(
      new ActionRowBuilder().addComponents(reserveMenu)
    );
  }
  return interaction.editReply({
    content:
      '✅ 需求已填寫完成\n\n' +
      '請選擇陪陪：\n' +
      '🟢 上線陪陪可直接指定\n' +
      '⚪ 未上線陪陪會使用你剛剛填的預約時間',
    components: rows
  });
}
async function handlePreferredPlayerSelect(interaction) {
  const selectId =
    interaction.customId.startsWith('select_reserve_player_')
      ? interaction.customId.replace('select_reserve_player_', '')
      : interaction.customId.replace('select_preferred_player_', '');

  const pending =
    pendingPlayOrders.get(selectId);

  if (!pending) {
    return interaction.reply({
      content: '❌ 這筆需求已過期，請重新填寫',
      flags: 64
    });
  }

  if (interaction.user.id !== pending.userId) {
    return interaction.reply({
      content: '❌ 只有填寫需求的人可以選擇陪陪',
      flags: 64
    });
  }

  const selectedValue =
    interaction.values[0];

  // ===== 不指定陪陪 =====
  if (selectedValue === 'no_preference') {
    await interaction.deferReply({
      flags: 64
    });

    pendingPlayOrders.delete(selectId);

    await createPlayOrder(
      interaction,
      pending.service,
      pending.time,
      pending.price,
      pending.note,
      pending.paymentMethod,
      null,
      null,
      'open'
    );

    return interaction.editReply({
      content: '✅ 已選擇不指定陪陪，訂單已送出',
      components: []
    });
  }

  // ===== 指定目前上線陪陪 =====
  if (selectedValue.startsWith('online_')) {
    await interaction.deferReply({
      flags: 64
    });

    const playerId =
      selectedValue.replace('online_', '');

    pendingPlayOrders.delete(selectId);

    await createPlayOrder(
      interaction,
      pending.service,
      pending.time,
      pending.price,
      pending.note,
      pending.paymentMethod,
      playerId,
      null,
      'assign'
    );

    return interaction.editReply({
      content: `✅ 已指定陪陪：<@${playerId}>，訂單已送出`,
      components: []
    });
  }

  // ===== 預約未上線陪陪：直接用需求單的預約時間 =====
  if (selectedValue.startsWith('reserve_')) {
    await interaction.deferReply({
      flags: 64
    });
    const playerId =
      selectedValue.replace('reserve_', '');
    pendingPlayOrders.delete(selectId);
    await createPlayOrder(
      interaction,
      pending.service,
      pending.time,
      pending.price,
      pending.note,
      pending.paymentMethod,
      playerId,
      pending.time,
      'reserve'
    );
    return interaction.editReply({
      content:
        `✅ 已預約陪陪：<@${playerId}>\n` +
        `🕒 預約時間：${pending.time}\n` +
        `訂單已送出`,
      components: []
    });
  }
  return interaction.reply({
    content: '❌ 選擇格式錯誤，請重新填寫',
    flags: 64
  });
}
async function submitCustomerReserveTime(interaction) {
  await interaction.deferReply({
    flags: 64
  });

  const raw =
    interaction.customId.replace(
      'submit_customer_reserve_time_',
      ''
    );

  const parts =
    raw.split('_');

  const selectId =
    `${parts[0]}_${parts[1]}`;

  const playerId =
    parts.slice(2).join('_');

  const pending =
    pendingPlayOrders.get(selectId);

  if (!pending) {
    return interaction.editReply({
      content: '❌ 這筆需求已過期，請重新填寫'
    });
  }

  if (interaction.user.id !== pending.userId) {
    return interaction.editReply({
      content: '❌ 只有填寫需求的人可以預約陪陪'
    });
  }

  const reservedTime =
    interaction.fields.getTextInputValue('reserved_time');

  pendingPlayOrders.delete(selectId);

  await createPlayOrder(
    interaction,
    pending.service,
    pending.time,
    pending.price,
    pending.note,
    pending.paymentMethod,
    playerId,
    reservedTime,
    'reserve'
  );

  return interaction.editReply({
    content:
      `✅ 已預約陪陪：<@${playerId}>\n` +
      `🕒 預約時間：${reservedTime}\n` +
      `訂單已送出`,
    components: []
  });
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

  if (order.status !== 'pending') {
    return interaction.editReply({
      content: '❌ 這張訂單已經被接單，不能再派單'
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

async function dispatchOpenOrder(interaction) {
  const orderId =
    interaction.customId.replace(
      'dispatch_open_order_',
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

  if (order.status !== 'pending') {
    return interaction.editReply({
      content: '❌ 這張訂單已經被接單，不能再派單'
    });
  }

  const { data: updatedOrder, error: updateError } =
    await supabase
      .from('play_orders')
      .update({
        preferred_player: null
      })
      .eq('id', order.id)
      .select()
      .single();

  if (updateError) {
    console.log('[開放派單失敗]', updateError);
    return interaction.editReply({
      content: '❌ 開放派單失敗'
    });
  }

  await sendOrderToStaffChannel(updatedOrder);

  return interaction.editReply({
    content: '✅ 已開放給所有可接單陪陪接單',
    components: []
  });
}

async function submitDispatchPlayers(interaction) {
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

  await sendOrderToStaffChannel(order);

  return interaction.editReply({
    content:
      `✅ 已指定派單給：${selectedPlayerIds.map(id => `<@${id}>`).join('、')}`,
    components: []
  });
}
async function openChangePreferredPlayerMenu(interaction) {
  const orderId =
    interaction.customId.replace(
      'change_preferred_player_',
      ''
    );

  const { data: order, error } =
    await supabase
      .from('play_orders')
      .select('*')
      .eq('id', orderId)
      .single();

  if (error || !order) {
    console.log('[更改指定陪陪讀取訂單失敗]', error);
    return interaction.editReply({
      content: '❌ 找不到這張訂單'
    });
  }

  if (!canChangePreferredPlayer(interaction, order)) {
    return interaction.editReply({
      content: '❌ 只有下單者或客服可以更改指定陪陪'
    });
  }

  if (order.status !== 'pending') {
    return interaction.editReply({
      content: '❌ 這張訂單已被接單，不能再更改指定陪陪'
    });
  }

  const playerOptions =
    await getCustomerPreferredPlayerOptions(order.service || '');

  const options = playerOptions;

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(`submit_change_preferred_player_${orderId}`)
      .setPlaceholder('請選擇新的指定陪陪')
      .addOptions(options.slice(0, 25));

  const row =
    new ActionRowBuilder()
      .addComponents(menu);

  return interaction.editReply({
    content: '🌟 請選擇新的指定陪陪：',
    components: [row]
  });
}
async function submitChangePreferredPlayer(interaction) {
  const orderId =
    interaction.customId.replace(
      'submit_change_preferred_player_',
      ''
    );

  const selectedValue =
    interaction.values[0];

  let preferredPlayerId = null;
  let reservedTime = null;
  let dispatchType = 'open';
  if (selectedValue === 'no_preference') {
    preferredPlayerId = null;
    dispatchType = 'open';
  }
  if (selectedValue.startsWith('online_')) {
    preferredPlayerId = selectedValue.replace('online_', '');
    dispatchType = 'assign';
  }
  if (selectedValue.startsWith('reserve_')) {
    preferredPlayerId = selectedValue.replace('reserve_', '');
    dispatchType = 'reserve';
  }
  const { data: order, error } =
    await supabase
      .from('play_orders')
      .select('*')
      .eq('id', orderId)
      .single();

  if (error || !order) {
    console.log('[更改指定陪陪讀取訂單失敗]', error);
    return interaction.editReply({
      content: '❌ 找不到這張訂單',
      components: []
    });
  }

  if (!canChangePreferredPlayer(interaction, order)) {
    return interaction.editReply({
      content: '❌ 只有下單者或客服可以更改指定陪陪',
      components: []
    });
  }

  if (order.status !== 'pending') {
    return interaction.editReply({
      content: '❌ 這張訂單已被接單，不能再更改指定陪陪',
      components: []
    });
  }

  const { error: updateError } =
    await supabase
      .from('play_orders')
      .update({
        preferred_player: preferredPlayerId,
        reserved_player:
          dispatchType === 'reserve'
            ? preferredPlayerId
            : null, 
        reserved_time: reservedTime,
        dispatch_type: dispatchType
      })
      .eq('id', orderId);

  if (updateError) {
    console.log('[更改指定陪陪失敗]', updateError);
    return interaction.editReply({
      content: '❌ 更改指定陪陪失敗',
      components: []
    });
  }
  // ===== 重新發送到員工接單區 =====
  const staffOrderChannel =
    await client.channels
      .fetch(process.env.PLAYER_ORDER_CHANNEL)
      .catch(() => null);
  if (staffOrderChannel) {
    const resendEmbed =
      new EmbedBuilder()
        .setColor('#66ccff')
        .setTitle('🌟 陪玩指定已更新｜重新派單')
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
            name: '🌟 新指定陪陪',
            value: preferredPlayerId
              ? `<@${preferredPlayerId}>`
              : '不指定',
            inline: true
          },
          {
            name: '🎮 服務項目',
            value: order.service || '未填寫',
            inline: false
          },
          {
            name: '💰 商品金額',
            value: `NT$${order.final_price || order.price || 0}`,
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
          text: `由 ${interaction.user.username} 更改指定陪陪`
        })
        .setTimestamp();
    const acceptRow =
      new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`accept_play_order_${order.id}`)
            .setLabel('接單')
            .setStyle(ButtonStyle.Success)
        );
    await staffOrderChannel.send({
      content: preferredPlayerId
        ? `🌟 訂單已更改指定陪陪：<@${preferredPlayerId}>`
        : '🌟 訂單已更改為不指定陪陪，開放可接單員工接單',
      embeds: [resendEmbed],
      components: [acceptRow]
    });
  }
  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor('#66ccff')
        .setTitle('🌟 指定陪陪已更新')
        .setDescription(
          `訂單編號：${order.order_no || '未知'}\n` +
          `新的指定陪陪：${
            preferredPlayerId
              ? `<@${preferredPlayerId}>`
              : '不指定'
          }\n\n` +
          `更改人：<@${interaction.user.id}>`
        )
        .setTimestamp()
    ]
  });

  await sendPlayLog({
    title: '🌟 指定陪陪已更新',
    description:
      `訂單編號：${order.order_no || '未知'}\n` +
      `更改人：<@${interaction.user.id}>\n` +
      `新的指定陪陪：${
        preferredPlayerId
          ? `<@${preferredPlayerId}>`
          : '不指定'
      }`,
    color: '#66ccff'
  });

  return interaction.editReply({
    content:
      preferredPlayerId
        ? `✅ 已改成指定陪陪：<@${preferredPlayerId}>`
        : '✅ 已改成不指定陪陪',
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

  const method =
    interaction.fields.getTextInputValue(
      'method'
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

  // ===== Embed =====

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

  // ===== 按鈕 =====

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
  }
  await interaction.editReply({
    content:
      '✅ 已送出儲值申請'
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

    const canAccept =
      allowedServices.some(service =>
        order.service.includes(service)
      );

    if (!canAccept) {
      return interaction.editReply({
        content:
          `❌ 你沒有權限接這個項目\n` +
          `此訂單服務：${order.service}\n` +
          `你的可接項目：${allowedServices.join('、') || '未設定'}`
      });
    }
    const { data: updated, error: updateError } =
      await supabase
        .from('play_orders')
        .update({
          status: 'accepted',
          assigned_player: interaction.user.id,
          accepted_at: new Date()
        })
        .eq('id', orderId)
        .eq('status', 'pending')
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
        content: '❌ 這張訂單已被其他人接走',
      });
    }

    await supabase
      .from('players')
      .update({ status: 'busy' })
      .eq('discord_id', interaction.user.id);

    const orderChannel =
      await client.channels.fetch(
        order.channel_id
      );
    if (!orderChannel) {
      return interaction.editReply({
        content: '❌ 找不到客人訂單頻道'
      });
    }
    await orderChannel.permissionOverwrites.edit(interaction.user.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    });
    await supabase
      .from('play_orders')
      .update({ channel_id: orderChannel.id })
      .eq('id', orderId);
    const embed = new EmbedBuilder()
      .setColor('#00ff99')
      .setTitle('✅ 陪玩訂單已接單')
      .setDescription(
        `訂單編號：${order.order_no}\n` +
        `客人：<@${order.customer_id}>\n` +
        `陪玩：<@${interaction.user.id}>\n` +
        `服務：${order.service}\n` +
        `商品金額（折前）：NT$${order.price}`
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`use_coupon_${orderChannel.id}`)
        .setLabel('使用優惠券')
        .setStyle(ButtonStyle.Success)
    );

    await orderChannel.send({
      content: `<@${order.customer_id}> <@${interaction.user.id}>`,
      embeds: [embed],
      components: [row]
    });

    await sendPlayLog({
      title: '✅ 訂單已接取',
      description:
        `訂單編號：${order.order_no}\n` +
        `陪玩：<@${interaction.user.id}>\n` +
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
async function confirmTopup(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: 64 });
  }
  const [, , userId, amountText] =
    interaction.customId.split('_');
  const amount =
    Number(amountText);
  const bonus =
    getTopupBonus(amount);
  const finalAmount =
    amount + bonus;
  // ===== 讀玩家 =====

  const { data: user } =
    await supabase
      .from('users')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

  // ===== 新玩家 =====

  if (!user) {

    await supabase
      .from('users')
      .insert({

        user_id:
          userId,

        coins:
          finalAmount,

        total_topup:
          amount,

        total_spent:
          0,

        vip_level:
          'none',

        growth_vip:
          'none'

      });

  }

  // ===== 舊玩家 =====

  else {

    await supabase
      .from('users')
      .update({

        coins:
          (user.coins || 0) + finalAmount,

        total_topup:
          (user.total_topup || 0) + amount

      })
      .eq('user_id', userId);

  }

  // ===== VIP 檢查 =====

  await checkGrowthVip(
    client,
    interaction.guild.id,
    userId,
    amount
  );
  // ===== 儲值通知 =====
  const newBalance =
    !user
      ? finalAmount
      : (user.coins || 0) + finalAmount;
  const targetUser =
    await client.users
      .fetch(userId)
      .catch(() => null);
  if (targetUser) {
    const embed =
      new EmbedBuilder()
        .setColor('#57F287')
        .setTitle('💰 儲值成功')
        .setDescription(
          `已成功儲值 NT$${amount}\n` +
          (
            bonus > 0
              ? `🎁 儲值贈送：${bonus} 星雨幣\n\n` 
              : '\n'
          ) +
          `💳 目前餘額：${newBalance} 星雨幣\n\n` +
          `星雨幣已發放至你的帳戶 ✨`
        )
        .setTimestamp();
    await targetUser.send({
      embeds: [embed]
    }).catch(() => {});
  }
  // ===== 發送儲值結果到臨時頻道 =====
  const resultEmbed =
    new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('✅ 儲值完成')
      .setDescription(
        `👤 會員：<@${userId}>\n\n` +
        `💰 儲值金額：NT$${amount}\n` +
        (
          bonus > 0
            ? `🎁 儲值贈送：${bonus} 星雨幣\n`
            : ''
        ) +
        `💳 實際入帳：${finalAmount} 星雨幣\n` +
        `🏦 目前餘額：${newBalance} 星雨幣`
      )
      .setTimestamp();
  await interaction.channel.send({
    embeds: [resultEmbed]
  });
  const closeRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('close_ticket')
          .setLabel('關閉單子')
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger)
      );
  await interaction.message.edit({
    components: [closeRow]
  }).catch(() => {});
  await interaction.editReply({
    content:
      `✅ 已完成儲值 NT$${amount}`
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
    if (interaction.customId.startsWith('change_preferred_player_')) {
      await openChangePreferredPlayerMenu(interaction);
      return true;
    }
    if (interaction.customId.startsWith('dispatch_assign_players_')) {
      await openDispatchPlayerMenu(interaction);
      return true;
    }
    if (interaction.customId.startsWith('dispatch_open_order_')) {
      await dispatchOpenOrder(interaction);
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
    // ===== 接單 =====
    if (interaction.customId.startsWith('accept_play_order_')) {
      await acceptPlayOrder(interaction);
      return true;
    }
   }
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'submit_play_order_form') {
      await submitPlayOrderForm(interaction);
      return true;
    }
    if (interaction.customId.startsWith('submit_customer_reserve_time_')) {
      await submitCustomerReserveTime(interaction);
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
  }
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId.startsWith('submit_dispatch_players_')) {
      await submitDispatchPlayers(interaction);
      return true;
    }
    if (
      interaction.customId.startsWith('select_preferred_player_') ||
      interaction.customId.startsWith('select_reserve_player_')
    ) {
      await handlePreferredPlayerSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith('submit_change_preferred_player_')) {
      await submitChangePreferredPlayer(interaction);
      return true;
    }
  }
  return false;
}

module.exports = {
  setup,
  handleDispatchInteraction,
  createPlayOrder,
  sendPlayerPanel,
  sendPlayOrderFormButton,
  sendDailyPlayerSummary,
  submitTopupForm,
  submitPlayOrderForm,
  submitCustomerReserveTime,
  getCustomerPreferredPlayerOptions,
  getOfflinePlayerOptions,
  openTopupModal,
  openPlayOrderModal,
  openChangeOrderPriceModal,
  submitChangeOrderPrice,
  openChangePreferredPlayerMenu,
  submitChangePreferredPlayer,
  openSaveOrderNoteModal,
  submitSaveOrderNote,
  sendOrderToStaffChannel,
  sendDispatchChoicePanel,
  openDispatchPlayerMenu,
  dispatchOpenOrder,
  submitDispatchPlayers,
  handleSavedOrderEnd
};