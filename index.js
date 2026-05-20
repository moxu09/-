require('dotenv').config();
const fs = require('fs');
process.on('uncaughtException', err => {
  console.error('[Uncaught Exception]', err);
});
process.on('unhandledRejection', err => {
  console.error('[Unhandled Rejection]', err);
});
const { createClient } = require('@supabase/supabase-js');
const {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
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
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
// ===== 陪玩排單系統 =====
const dispatchSystem = require('./events/dispatchSystem');
dispatchSystem.setup(supabase, client);
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
// ===== Panel Message =====
async function getPanelMessage(panelName) {
  const { data, error } = await supabase
    .from('panel_messages')
    .select('*')
    .eq('panel_name', panelName)
    .single();
  if (error && error.code !== 'PGRST116') {
    console.error('[Panel] 讀取失敗', error);
  }
  return data;
}
async function savePanelMessage(panelName, channelId, messageId) {
  if (!channelId || !messageId) {
    console.warn('[Panel] skip save - missing data', {
      panelName,
      channelId,
      messageId
    });
    return;
  }
  const res = await supabase
    .from('panel_messages')
    .upsert(
      {
        panel_name: panelName,
        channel_id: channelId,
        message_id: messageId
      },
      {
        onConflict: 'panel_name'
      }
    );
  if (res.error) {
    console.error('[Panel] 儲存失敗', res.error);
  }
}
// ===== 工具函數 =====
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
async function sendWalletLog(
  userId,
  type,
  amount,
  balance,
  note = ''
) {
  if (amount === 0 && type !== '十抽') return;
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
      try {
        await user.send({ embeds: [embed] });
      } catch (err) {
        console.log('[錢包通知失敗]', err.code, err.message);
        // DM 失敗不要中斷主流程
        return false;
      }
    } catch (err) {
      console.error(
        '[錢包通知失敗]',
        err
      );
    }
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

async function performGacha(userId, guildId, amount, poolId = null) {
    let pool;
    if (poolId) {
      const { data, error } =
        await supabase
          .from('gacha_pools')
          .select('*')
          .eq('guild_id', guildId)
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
          .select('*')
          .eq('guild_id', guildId);
      if (!pools || pools.length === 0) {
        throw new Error('目前沒有卡池');
      }
      pool = pools[0];
    }
  const totalPrice = pool.price * amount;

  const userData = await getUser(userId);
  if (userData.coins < totalPrice) throw new Error('星雨幣不足');

  const { data: rewards } = await supabase
    .from('gacha_rewards')
    .select('*')
    .eq('pool_id', pool.id);

  if (!rewards || rewards.length === 0) throw new Error('卡池沒有獎勵');

  let results = [];
  let totalRewardCoins = 0;
  let insertItems = [];

  for (let i = 0; i < amount; i++) {
    const totalWeight =
      rewards.reduce(
        (sum, r) => sum + Number(r.chance || 0),
        0
      );
    let random = Math.random() * totalWeight;
    let selected = rewards[0];
    for (const reward of rewards) {
      random -= Number(reward.chance);
      if (random <= 0) {
        selected = reward;
        break;
      }
    }

    const rewardCoins = selected.reward_coins || 0;
    totalRewardCoins += rewardCoins;

    // 判斷是否是優惠券
    const itemType = selected.reward_name.includes('優惠券') ? 'coupon' : 'gacha';

    insertItems.push({
      user_id: userId,
      item_name: selected.reward_name,
      rarity: selected.rarity,
      description: selected.reward_description,
      item_type: itemType
    });
    results.push({
      name: selected.reward_name,
      rarity: selected.rarity,
      description: selected.reward_description,
      coins: rewardCoins,
      itemType
    });
  }

  const finalCoins =
    userData.coins - totalPrice + totalRewardCoins;
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
      .setImage('https://cdn.discordapp.com/attachments/1501098193276895360/1505278267391742253/7223dd02-5c3a-43d3-9acc-f3b618732607.png?ex=6a0a0b21&is=6a08b9a1&hm=66bcc7c8b5d5eec5e35640258ba7320834fef96a198228fbb0c0ccc233a9c88d&');
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
      .setImage('https://cdn.discordapp.com/attachments/1501098193276895360/1505277098409988317/3c6bb34b-65a5-4a90-b743-f3cc8acaed09.png?ex=6a0a0a0a&is=6a08b88a&hm=ddc66df8cbe55ceb98c0b5d1eb335bfd97707221d789fc6270cf7782088ed7f0&');
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
      .setStyle(ButtonStyle.Success);

  const consumeButton =
    new ButtonBuilder()
      .setCustomId('consume_info')
      .setLabel('💠 消費資訊')
      .setStyle(ButtonStyle.Secondary);

  const row =
    new ActionRowBuilder()
      .addComponents(
        balanceButton,
        transferButton,
        consumeButton
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
        `💠 消費資訊｜查看累積消費`
      )
      .setThumbnail(client.user.displayAvatarURL())
      .setFooter({
        text: '星雨銀行｜交易請確認對象與金額'
      })
      .setTimestamp()
      .setImage('https://cdn.discordapp.com/attachments/1501098193276895360/1505276094058729632/777d1c67-0ad2-4a58-be29-5d3b028211fa.png?ex=6a0a091b&is=6a08b79b&hm=ca2e66188d8c3be9cc6987423bbf34549f13fc4bf6c441e1a6b559b1342d3b3a&');
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
        components: [row]
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
      components: [row]
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
      .setImage(
        'https://cdn.discordapp.com/attachments/1501098193276895360/1505275402250354778/f930a8f2-ca2a-441d-8e92-31d9b074601d.png?ex=6a0a0876&is=6a08b6f6&hm=ceebc19dc6ce78f79f96906b11a0a2366841896808a35532bf2b9966e9d2bb8a&'
        );
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
  const channel = await client.channels.fetch(
    ORDER_CHANNEL
  );

  if (!channel) return;

  // 下拉選單
  const menu =
    new StringSelectMenuBuilder()
      .setCustomId('order_system_select')
      .setPlaceholder('請選擇功能')
      .addOptions([
        {
          label: '🛒 點單',
          description: '建立點單頻道',
          value: 'order'
        },
        {
          label: '💰 儲值',
          description: '建立儲值頻道',
          value: 'topup'
        }
      ]);

  const row =
    new ActionRowBuilder()
      .addComponents(menu);

  const embed =
    new EmbedBuilder()
      .setColor('#ff66cc')
      .setTitle('📦 星雨訂單中心')
      .setDescription(
        `歡迎使用星雨訂單系統 ✨\n\n` +
        `請從下方選單選擇你需要的服務。\n\n` +
        `━━━━━━━━━━━━━━\n` +
        `🛒 點單｜建立專屬訂單頻道\n` +
        `💰 儲值｜建立專屬儲值頻道\n\n` +
        `建立後只有你與客服可以看見。`
      )
      .setThumbnail(client.user.displayAvatarURL())
      .setFooter({
        text: '星雨客服｜欲立新單請重複建立頻道'
    })
    .setTimestamp()
    .setImage('https://cdn.discordapp.com/attachments/1501098193276895360/1505274858567762153/ChatGPT_Image_2026517_02_24_37.png?ex=6a0a07f4&is=6a08b674&hm=e3cf59696e54af40365cec86b215036e4ee34bc83ac941016808de3719010617&');
  // ===== 新版面板系統 =====
  const orderPanel =
    await getPanelMessage('order');
  if (orderPanel) {
    try {
      const oldMessage =
        await channel.messages.fetch(
          orderPanel.message_id
        );
      await oldMessage.edit({
        embeds: [embed],
        components: [row]
      });
      console.log(
        '[ORDER] 已更新舊面板'
      );
    } catch {
      const newMessage =
        await channel.send({
          embeds: [embed],
          components: [row]
        });
      await savePanelMessage(
        'order',
        channel.id,
        newMessage.id
      );
      console.log(
        '[ORDER] 已建立新面板'
      );
    }
  } else {
    const newMessage =
      await channel.send({
        embeds: [embed],
        components: [row]
      });
    await savePanelMessage(
      'order',
      channel.id,
      newMessage.id
    );
    console.log(
      '[ORDER] 已建立初始面板'
    );
  }
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
        .setDescription('例如：0.5 / 1 / 10')
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
await sendOrderSystem(client);
console.log('✅ 訂單系統已載入');
await refreshShop(client);
console.log('✅ 商店系統已載入');
await sendAtmPanel(client);
console.log('✅ ATM 系統已載入');
await sendCheckinPanel(client);
console.log('✅ 簽到系統已載入');
await sendGachaPanel(client);
console.log('✅ 扭蛋系統已載入');
console.log('🌧️ 星雨機器人已成功上線');
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
  const eightHoursAgo =
    new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  const { data: players, error } =
    await supabase
      .from('players')
      .select('*')
      .eq('status', 'available')
      .lt('online_started_at', eightHoursAgo);

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

// ===== Interaction Handler =====
client.on(Events.InteractionCreate, async interaction => {
  try {

    // ===== Modal 按鈕：不能 defer，直接交給 dispatchSystem =====
    if (
      interaction.isButton() &&
      (
        interaction.customId === 'open_topup_modal' ||
        interaction.customId === 'open_play_order_form'
      )
    ) {
      return await dispatchSystem.handleDispatchInteraction(interaction);
    }

    // ===== Modal Submit：交給 dispatchSystem =====
    if (interaction.isModalSubmit()) {
      const handled =
        await dispatchSystem.handleDispatchInteraction(interaction);

      if (handled) return;
      await handleModalSubmit(interaction);
      return;

    }

    // ===== Slash =====
    if (interaction.isChatInputCommand()) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: 64 });
      }
      const handled =
        await dispatchSystem.handleDispatchInteraction(interaction);

      if (handled) return;

      await handleSlashCommand(interaction);
      return;
    }

    // ===== 一般 Button =====
    if (interaction.isButton()) {
      const handled =
        await dispatchSystem.handleDispatchInteraction(interaction);
      if (handled) return;
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: 64 });
      }
      await handleButtonInteraction(interaction);
      return;
    }

    // ===== User Select：不能先 defer，因為會開轉帳 Modal =====
    if (interaction.isUserSelectMenu()) {
      await handleUserSelectSubmit(interaction);
      return;
    }

    // ===== String Select =====
    if (interaction.isStringSelectMenu()) {
      await interaction.deferReply({ flags: 64 });

      await handleStringSelectInteraction(interaction);
      return;
    }

  } catch (err) {
    console.error('[InteractionCreate 錯誤]', err);

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content: '❌ 系統錯誤'
      }).catch(() => {});
    } else {
      await interaction.reply({
        content: '❌ 系統錯誤',
        flags: 64
      }).catch(() => {});
    }
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
function isAdminOrStaff(interaction) {
  return (
    interaction.guild.ownerId === interaction.user.id ||
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE)
  );
}
async function handleSlashCommand(interaction) {
  // ping
  if (interaction.commandName === 'ping') {
    return interaction.editReply('Pong!');
  }
  // 扭蛋列表
  if (interaction.commandName === '扭蛋列表') {
    const { data, error } = await supabase
            .from('gacha_pools')
            .select('*')
            .eq('guild_id', interaction.guild.id);
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
          const { error } = await supabase
            .from('gacha_pools')
            .insert({
              guild_id: interaction.guild.id,
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
            return replyError(interaction, '機率必須大於 0');
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
          const records = await getTransferRecords(
            interaction.user.id
          );
          if (!records.length) {
            return interaction.editReply({
              content: '目前沒有交易紀錄',
            });
          }
          const text = records.map(r =>{
              const time =
                new Date(
                  r.created_at
                ).toLocaleString(
                  'zh-TW',
                  {
                    hour12: false
                  }
                );
              return (
                `💸 <@${r.sender_id}> ➜ <@${r.receiver_id}>\n💰 ${r.amount} 星雨幣\n🕒 ${time}`
              );
            }).join('\n\n');
          return interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setColor('#00ffff')
                .setTitle('📜 最近交易紀錄')
                .setDescription(text)
            ],
          });
        }
        // 儲值
        if (interaction.commandName === '發錢') {
          if (interaction.guild.ownerId !== interaction.user.id) {
            return interaction.editReply({
              content: '❌ 只有群主可以使用',
            });
          }
          const target = interaction.options.getUser('玩家');
          const amount = interaction.options.getInteger('金額');
          if (isNaN(amount) || amount <= 0) {
            return replyError(interaction, '金額錯誤');
          }
          const targetData = await getUser(target.id);
          await updateCoins(
            target.id,
            targetData.coins + amount
          );
          const finalCoins =
            targetData.coins + amount;
          await sendWalletLog(
            target.id,
            '儲值',
            amount,
            finalCoins,
            '💳 儲值成功'
          );
          return interaction.editReply({
            content:
              `✅ 已給予 <@${target.id}> ${amount} 星雨幣`,
          });
        }
        // 扣錢
        if (interaction.commandName === '扣錢') {
          if (interaction.guild.ownerId !== interaction.user.id) {
            return interaction.editReply({
              content: '❌ 只有群主可以使用',
            });
          }
          const target = interaction.options.getUser('玩家');
          const amount = interaction.options.getInteger('金額');
          if (isNaN(amount) || amount <= 0) {
            return replyError(interaction, '金額錯誤');
          }
          const targetData = await getUser(target.id);
          await updateCoins(
            target.id,
            Math.max(0, targetData.coins - amount)
          );
          return interaction.editReply({
            content:
              `❌ 已扣除 <@${target.id}> ${amount} 星雨幣`,
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
          const items = await getUserItems(
          interaction.user.id
          );
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
// ===== 完整按鈕交互處理 =====
async function handleButtonInteraction(interaction) {
  const customId = interaction.customId;

  try {
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

      await updateCoins(
        interaction.user.id,
        userData.coins + reward
      );

      await sendWalletLog(
        interaction.user.id,
        '每日簽到',
        reward,
        userData.coins + reward,
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
      // ===== ATM 消費資訊 =====
    if (customId === 'consume_info') {
      const userData = await getUser(interaction.user.id);
      const embed =
        new EmbedBuilder()
          .setColor('#00ffff')
          .setTitle(`${interaction.user.username}｜用戶消費資訊`)
          .setThumbnail(interaction.user.displayAvatarURL())
          .setDescription(
            `**錢包餘額**\n` +
            `${userData.coins || 0} 元\n\n` +
            `**累積消費金額**\n` +
            `${userData.total_spent || 0} 元\n\n` +
            `**月累積消費金額**\n` +
            `${userData.month_spent || 0} 元`
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

      await updateCoins(
        interaction.user.id,
        userData.coins + reward
      );

      await sendWalletLog(
        interaction.user.id,
        '聊天掉落',
        reward,
        userData.coins + reward,
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
          .eq('guild_id', interaction.guild.id);
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
      if (customId === 'complete_order') {
        const { data: playOrder } =
          await supabase
            .from('play_orders')
            .select('*')
            .eq('channel_id', interaction.channel.id)
            .eq('status', 'accepted')
            .maybeSingle();
        if (playOrder) {
          await supabase
            .from('play_orders')
            .update({
              status: 'completed',
              completed_at: new Date()
            })
            .eq('id', playOrder.id);
          await supabase
            .from('players')
            .update({
              status: 'available'
            })
            .eq('discord_id', playOrder.assigned_player);
          await interaction.channel.send({
            embeds: [
              new EmbedBuilder()
                .setColor('#ffcc00')
                .setTitle('🏁 訂單已完成')
                .setDescription(
                  `訂單編號：${playOrder.order_no}\n` +
                  `陪玩：<@${playOrder.assigned_player}>\n` +
                  `服務：${playOrder.service}\n` +
                 `商品金額：NT$${playOrder.price}`
                )
            ]
          });
          // ===== 發送到陪陪自己的頻道 =====
          const { data: player } =
            await supabase
              .from('players')
              .select('*')
              .eq('discord_id', playOrder.assigned_player)
              .single();
          if (player?.report_channel_id) {
            const playerChannel =
              await client.channels
                .fetch(player.report_channel_id)
                .catch(() => null);
            if (playerChannel) {
              await playerChannel.send({
                embeds: [
                  new EmbedBuilder()
                    .setColor('#ffcc00')
                    .setTitle('🏁 完成訂單紀錄')
                    .setDescription(
                      `訂單編號：${playOrder.order_no}\n` +
                      `客人：<@${playOrder.customer_id}>\n` +
                      `陪玩：<@${playOrder.assigned_player}>\n` +
                      `服務：${playOrder.service}\n` +
                      `商品金額：NT$${playOrder.price}`
                    )
                ]
              });
            }
          }
        }
      }
      if (!isAdminOrStaff(interaction)) {
        return await interaction.editReply({
          content: '❌ 只有客服可以操作'
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
        content: '📦 是否儲存訂單紀錄？',
        components: [row]
      });
    }
    // ===== 直接刪除訂單頻道 =====
    if (customId === 'delete_order_now') {
      if (!isAdminOrStaff(interaction)) {
        return await interaction.editReply({
          content: '❌ 只有客服可以操作'
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
    const customId = interaction.customId;
    const value = interaction.values[0];
    if (!value) {
      return await safeEditReply(interaction, {
        content: '❌ 選擇無效',
        ephemeral: true
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
        const channelName =
          value === 'order'
            ? `訂單-${safeName}-${ticketNumber}`
            : `儲值-${safeName}-${ticketNumber}`;
        const orderChannel =
          await interaction.guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: process.env.ORDER_CATEGORY,
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
          const row2 =
            new ActionRowBuilder()
              .addComponents(
                completeButton
              );
          const embed =
            new EmbedBuilder()
              .setColor('#ff66cc')
              .setTitle('🛒 訂單建立成功')
              .setDescription(
                '• 請幫我按下上方按鈕填寫？'
              );
          try {
            await dispatchSystem.sendPlayOrderFormButton(orderChannel);
          } catch (err) {
            console.error('[派單面板錯誤]', err);
          }
          await orderChannel.send({
            content:
              `<@&${process.env.STAFF_ROLE}> ${interaction.user}\n🚀 客服人員正手刀衝刺過來啦！`,
            embeds: [embed],
            components: [row2]
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
                  .setStyle(ButtonStyle.Primary)
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
        await supabase
          .from('users')
          .update({
            coins: userData.coins - item.price,
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
          userData.coins - item.price,
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
                await getUserItems(
                    interaction.user.id
                );
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
            const { data: used } =
                await supabase
                    .from('used_coupons')
                    .select('*')
                    .eq('user_id', interaction.user.id)
                    .eq('item_name', coupon.item_name)
                    .maybeSingle();
            if (used) {
                return await interaction.editReply({
                    content: '❌ 這張優惠券已使用過'
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

            await supabase
                .from('play_orders')
                .update({
                    coupon_name: coupon.item_name,
                    discount_amount: discountAmount,
                    final_price: finalPrice
                })
                .eq('id', order.id);
            // ===== 刪除優惠券 =====
            await removeUserItem(coupon.id);

            await supabase
                .from('used_coupons')
                .insert({
                    user_id: interaction.user.id,
                    item_name: coupon.item_name
                });
            // ===== 公開通知 =====
            await interaction.channel.send({
                content:
                    `🎟️ ${interaction.user} 使用了優惠券：${coupon.item_name}\n` +
                    `折扣金額：NT$${discountAmount}` +
                    (
                        finalPrice !== null
                            ? `\n實收金額：NT$${finalPrice}`
                            : ''
                    )
            });
            return await interaction.editReply({
                content:
                    `✅ 已使用優惠券：${coupon.item_name}`
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

      if (
        targetId ===
        interaction.user.id
      ) {

        return await interaction.update({
          content: '❌ 不能轉給自己',
          components: []
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
    if (interaction.customId.startsWith('transfer_modal_')) {
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
  const channelId = message.channel.id;
  if (dropCooldown.has(channelId)) return;
  const random = Math.floor(Math.random() * 100);
  // 訊息少於 5 字不掉落
  if (message.content.replace(/\s/g, '').length < 5) return;  // 5% 掉落機率
  if (random >= 5) return;
  const reward = Math.floor(Math.random() * 50) + 1;
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
  }, 3 * 60 * 1000);
});
// ===== Login =====
client.login(process.env.TOKEN);