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
      name: interaction.user.username,
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
            `商品金額（折前）：NT$${order.price}`+
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
      `📦 完成單數：${data.total_orders}`,
  });
}

// 建立陪玩訂單
async function createPlayOrder(interaction, service, time, price, note = '無', paymentMethod = '未填寫') {
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
      channel_id: interaction.channel.id,
      service,
      price,
      final_price: finalPrice,
      discount_rate: discountRate,
      payment_method: paymentMethod,
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

  const channel = await client.channels.fetch(process.env.PLAYER_ORDER_CHANNEL);

  const embed = new EmbedBuilder()
    .setColor('#00ff99')
    .setTitle('📦 已建立新陪玩訂單')
    .setThumbnail(interaction.user.displayAvatarURL())
    .addFields(
      {
        name: '📌 訂單編號',
        value: orderNo,
        inline: true
      },
      {
        name: '👤 客人',
        value: `<@${interaction.user.id}>`,
        inline: true
      },
      {
        name: '🎮 服務項目',
        value: service,
        inline: false
      },
      {
        name: '🕒 預約時間',
        value: time,
        inline: true
      },
      {
        name: '💳 付款方式',
        value: paymentMethod,
        inline: true
      },
      {
        name: '💰 商品金額',
        value:
          `原價：NT$${price}\n` +
          `VIP折扣：${discountText}\n` +
          `實收：NT$${finalPrice}`,
        inline: false
      },
      {
        name: '📝 備註需求',
        value: note || '無',
        inline: false
      }
    )
    .setFooter({
      text: '星雨派單系統'
    })
    .setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`accept_play_order_${order.id}`)
      .setLabel('接單')
      .setStyle(ButtonStyle.Success)
  );
  await channel.send({ embeds: [embed], components: [row] });
  const priceEditRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`change_order_price_${order.id}`)
          .setLabel('💰 更改金額')
          .setStyle(ButtonStyle.Secondary)
      );

  await interaction.channel.send({
    content: '📋 你的陪玩需求已送出，以下是目前訂單內容：',
    embeds: [embed],
    components: [priceEditRow]
  });
  if (isBankTransfer(paymentMethod)) {
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
    .setPlaceholder('轉帳 / 無卡 / 儲值卡 / 加密貨幣')
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
      .setPlaceholder('匯款/無卡/加密貨幣/美金轉帳')
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
async function submitPlayOrderForm(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64
    });
  }
  const service =
    interaction.fields.getTextInputValue(
      'service'
    );
  const time =
    interaction.fields.getTextInputValue(
      'time'
    );
  const priceText =
    interaction.fields.getTextInputValue(
      'price'
    );
  // ===== 付款方式 =====
  let paymentMethod = '未填寫';
  try {
    paymentMethod =
      interaction.fields.getTextInputValue(
        'payment_method'
      ) || '未填寫';
  } catch {}
  // ===== 備註 =====
  let note = '無';
  try {
    note =
      interaction.fields.getTextInputValue(
        'note'
      ) || '無';
  } catch {}
  // ===== 價格 =====
  const price =
    parseInt(
      priceText.replace(/[^\d]/g, ''),
      10
    );
  if (!price || price <= 0) {
    return interaction.editReply({
      content:
        '❌ 價格格式錯誤，請輸入數字。'
    });
  }
  await createPlayOrder(
    interaction,
    service,
    time,
    price,
    note,
    paymentMethod
  );
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
  if (isBankTransfer(method)) {
    await sendBankTransferInfo(interaction.channel);
  }
  await interaction.editReply({
    content:
      '✅ 已送出儲值申請'
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

  const newPrice =
    parseInt(
      priceText.replace(/[^\d]/g, ''),
      10
    );

  if (!newPrice || newPrice <= 0) {
    return interaction.editReply({
      content: '❌ 金額格式錯誤，請輸入數字'
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
    if (interaction.customId === 'submit_topup_form') {
      await submitTopupForm(interaction);
      return true;
    }
    if (interaction.customId.startsWith('submit_change_order_price_')) {
      await submitChangeOrderPrice(interaction);
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
  submitTopupForm,
  submitPlayOrderForm,
  openTopupModal,
  openPlayOrderModal,
  openChangeOrderPriceModal,
  submitChangeOrderPrice
};