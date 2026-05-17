const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

let supabase;
let client;

function setup(supabaseInstance, clientInstance) {
  supabase = supabaseInstance;
  client = clientInstance;
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
  await supabase
    .from('players')
    .upsert({
      discord_id: interaction.user.id,
      name: interaction.user.username,
      game: 'delta_force',
      status: 'available'
    }, {
      onConflict: 'discord_id'
    });

  await interaction.editReply({
    content: '🟢 你已開始接單：三角洲行動',
  });
}

// 陪玩下班
async function playerOffline(interaction) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { data: player } =
    await supabase
      .from('players')
      .select('*')
      .eq('discord_id', interaction.user.id)
      .single();

  const { data: orders } =
    await supabase
      .from('play_orders')
      .select('*')
      .eq('assigned_player', interaction.user.id)
      .eq('status', 'completed')
      .gte('completed_at', today.toISOString());

  await supabase
    .from('players')
    .update({ status: 'offline' })
    .eq('discord_id', interaction.user.id);

  const totalOrders = orders?.length || 0;

  const totalPrice =
    orders?.reduce(
      (sum, order) => sum + (order.price || 0),
      0
    ) || 0;

  const orderList = orders?.length
    ? orders
        .map((order, index) => {
          return (
            `${index + 1}. ${order.service}\n` +
            `訂單編號：${order.order_no}\n` +
            `金額：NT$${order.price}`+
            `內容：${order.note || '無'}`
          );
        })
        .join('\n\n')
    : '今日尚無完成訂單';

  const reportEmbed =
    new EmbedBuilder()
      .setColor('#ff4444')
      .setTitle('📊 陪玩下班統計')
      .setDescription(
        `陪玩：<@${interaction.user.id}>\n\n` +
        `完成訂單：${totalOrders}\n` +
        `總金額：NT$${totalPrice}\n\n` +
        `━━━━━━━━━━\n\n` +
        `${orderList}`
      )
      .setTimestamp();

  if (player?.report_channel_id) {
    const reportChannel =
      await client.channels
        .fetch(player.report_channel_id)
        .catch(() => null);

    if (reportChannel) {
      await reportChannel.send({
        embeds: [reportEmbed]
      });
    }
  }

  await interaction.editReply({
    content:
      `🔴 你已停止接單\n\n` +
      `📊 今日統計已送出`
  });
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
      `🎮 遊戲：三角洲行動\n` +
      `📦 完成單數：${data.total_orders}`,
  });
}

// 建立陪玩訂單
async function createPlayOrder(interaction, service, price, note = '無') {
  const orderNo = `DF-${Date.now()}`;

  const { data: order, error } = await supabase
    .from('play_orders')
    .insert({
      order_no: orderNo,
      customer_id: interaction.user.id,
      service,
      price,
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

  const channel = await client.channels.fetch(process.env.PLAYER_ORDER_CHANNEL);

  const embed = new EmbedBuilder()
    .setColor('#00ff99')
    .setTitle('📦 三角洲新陪玩訂單')
    .setDescription(
      `訂單編號：${orderNo}\n` +
      `客人：<@${interaction.user.id}>\n` +
      `服務：${service}\n` +
      `價格：NT$${price}\n\n` +
      `請可接單的陪玩點擊下方按鈕。`
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`accept_play_order_${order.id}`)
      .setLabel('接單')
      .setStyle(ButtonStyle.Success)
  );

  await channel.send({ embeds: [embed], components: [row] });
  // ===== 派單紀錄 =====
  await sendPlayLog({
    title: '📦 新陪玩訂單',
    description:
      `訂單編號：${orderNo}\n` +
      `客人：<@${interaction.user.id}>\n` +
      `服務：${service}\n` +
      `金額：NT$${price}`
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
    .setTitle('陪玩需求');

  const serviceInput = new TextInputBuilder()
    .setCustomId('service')
    .setLabel('服務項目')
    .setPlaceholder('陪伴： 出氣包 / 遊戲包 \n 三角洲：機密護航 / 3×3安全箱')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const priceInput = new TextInputBuilder()
    .setCustomId('price')
    .setLabel('價格')
    .setPlaceholder('例如：499 / 6999 / 10999')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const noteInput = new TextInputBuilder()
    .setCustomId('note')
    .setLabel('需求備註')
    .setPlaceholder('例如：換頭像/遊戲名稱/急單/可語音/目前進度')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(serviceInput),
    new ActionRowBuilder().addComponents(priceInput),
    new ActionRowBuilder().addComponents(noteInput)
  );

  await interaction.showModal(modal);
}
async function submitPlayOrderForm(interaction) {
  await interaction.deferReply({ flags: 64 });

  const service =
    interaction.fields.getTextInputValue('service');

  const priceText =
    interaction.fields.getTextInputValue('price');

  let note = '無';

  try {
    note =
      interaction.fields.getTextInputValue('note') || '無';
  } catch {}

  const price =
    parseInt(priceText.replace(/[^\d]/g, ''), 10);

  if (!price || price <= 0) {
    return interaction.editReply({
      content: '❌ 價格格式錯誤，請輸入數字。'
    });
  }

  await createPlayOrder(
    interaction,
    `${service}\n備註：${note}`,
    price
  );
}
// 接單
async function acceptPlayOrder(interaction) {
  const orderId = interaction.customId.replace('accept_play_order_', '');

  const { data: player } = await supabase
    .from('players')
    .select('*')
    .eq('discord_id', interaction.user.id)
    .single();

  if (!player || player.status !== 'available') {
    return interaction.editReply({
      content: '❌ 你目前不是可接單狀態，請先使用 /上班',
    });
  }

  const { data: order } = await supabase
    .from('play_orders')
    .select('*')
    .eq('id', orderId)
    .single();

  if (!order || order.status !== 'pending') {
    return interaction.editReply({
      content: '❌ 這張訂單已經被接走了',
    });
  }

  const { data: updated } = await supabase
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

  if (!updated) {
    return interaction.editReply({
      content: '❌ 這張訂單已被其他人接走',
    });
  }

  await supabase
    .from('players')
    .update({ status: 'busy' })
    .eq('discord_id', interaction.user.id);

  const guild = interaction.guild;

  const orderChannel = await guild.channels.create({
    name: `三角洲-${order.order_no}`,
    type: ChannelType.GuildText,
    parent: process.env.PLAYER_CATEGORY,
    permissionOverwrites: [
      {
        id: guild.roles.everyone,
        deny: [PermissionFlagsBits.ViewChannel]
      },
      {
        id: order.customer_id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
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
        id: process.env.STAFF_ROLE_ID,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
      }
    ]
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
      `價格：NT$${order.price}`
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`complete_play_order_${orderId}`)
      .setLabel('完成訂單')
      .setStyle(ButtonStyle.Primary)
  );

  await orderChannel.send({
    content: `<@${order.customer_id}> <@${interaction.user.id}>`,
    embeds: [embed],
    components: [row]
  });

  await interaction.editReply({
    content: `✅ 接單成功！訂單頻道：${orderChannel}`,
  });
  await sendPlayLog({
    title: '✅ 訂單已接取',
    description:
      `訂單編號：${order.order_no}\n` +
      `陪玩：<@${interaction.user.id}>\n` +
      `服務：${order.service}\n` +
      `金額：NT$${order.price}`,
  });
}

// 完成訂單
async function completePlayOrder(interaction) {
  const orderId = interaction.customId.replace('complete_play_order_', '');

  const { data: order } = await supabase
    .from('play_orders')
    .select('*')
    .eq('id', orderId)
    .single();

  if (!order) {
    return interaction.editReply({
      content: '❌ 找不到訂單',
    });
  }

  await supabase
    .from('play_orders')
    .update({
      status: 'completed',
      completed_at: new Date()
    })
    .eq('id', orderId);

  await supabase
    .from('players')
    .update({ status: 'available' })
    .eq('discord_id', order.assigned_player);

  await interaction.editReply({
    content: '✅ 訂單已完成，陪玩狀態已恢復可接單'
  });
  await sendPlayLog({
    title: '🏁 訂單已完成',
    description:
      `訂單編號：${order.order_no}\n` +
      `陪玩：<@${order.assigned_player}>\n` +
      `服務：${order.service}\n` +
      `金額：NT$${order.price}`,
    color: '#ffcc00'
  });
}

async function handleDispatchInteraction(interaction) {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === '上班') {
      await playerOnline(interaction);
      return true;
    }
    if (interaction.commandName === '下班') {
      await playerOffine(interaction);
      return true;
    }
    if (interaction.commandName === '我的狀態') {
      await playerStatus(interaction);
      return true;
    }

  }

  if (interaction.isButton()) {
    // ===== 陪玩控制 =====
    if (interaction.customId === 'open_play_order_form') {
      await openPlayOrderModal(interaction);
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
    if (interaction.customId.startsWith('complete_play_order_')) {
      await completePlayOrder(interaction);
      return true;
    }
   }
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'submit_play_order_form') {
      await submitPlayOrderForm(interaction);
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
  sendPlayOrderFormButton
};