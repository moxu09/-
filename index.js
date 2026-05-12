require('dotenv').config();

process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

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

// ===== 訂單系統設定 =====

const ORDER_CHANNEL_ID =
  process.env.ORDER_CHANNEL_ID;

const STAFF_ROLE_ID =
  process.env.STAFF_ROLE_ID;
// ===== 全域狀態 =====

const claimedDrops = new Set();
const dropCooldown = new Map();

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
function isAdmin(interaction) {
  return (
    interaction.guild.ownerId === interaction.user.id ||
    interaction.member.permissions.has('Administrator')
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
async function addShopItem(itemName, price, description) {
  const { error } = await supabase.from('shop_items').insert([{ item_name: itemName, price, description }]);

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
    console.error('[DB] 新增玩家商品失敗:', error);
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

// 安全轉帳函數
async function safeTransfer(senderId, receiverId, amount) {
  if (isNaN(amount) || amount <= 0) {
    throw new Error('金額無效');
  }

  if (amount > 10000) {
    throw new Error('單次轉帳不能超過 10000');
  }

  if (senderId === receiverId) {
    throw new Error('不能轉給自己');
  }

  const { error } = await supabase.rpc('transfer_coins', {
    sender_id: senderId,
    receiver_id: receiverId,
    transfer_amount: amount,
  });

  if (error) {
    console.error('[轉帳失敗]', error);

    if (error.message.includes('餘額不足')) {
      throw new Error('星雨幣不足');
    }

    throw new Error('轉帳失敗');
  }

  console.log(`[轉帳成功] ${senderId} -> ${receiverId} ${amount}枚`);
  await addTransferRecord(senderId, receiverId, amount);

  return { success: true };
}

// 取得今日日期 (UTC+8)
function getTodayDateString() {
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return utc8.toISOString().split('T')[0];
}

// 刷新商店
async function refreshShop(client) {
  const shopChannel = await client.channels.fetch(process.env.SHOP_CHANNEL_ID);
  if (!shopChannel) return;

  const items = await getShopItems();

  // 刪除舊商店
  const messages = await shopChannel.messages.fetch({ limit: 20 });
  const oldShop = messages.filter(
    (msg) =>
      msg.author.id === client.user.id && msg.embeds.length > 0 && msg.embeds[0].title === '🛒 星雨商店'
  );

  for (const msg of oldShop.values()) {
    await msg.delete().catch(() => {});
  }

  // 商品內容
  let text = '';
  if (items.length === 0) {
    text = '目前商店沒有商品';
  } else {
    text = items.map((item, index) => `${index + 1}. ${item.item_name}\n💰 ${item.price} 星雨幣\n📦 ${item.description}`).join('\n\n');
  }

  // Embed
  const embed = new EmbedBuilder().setColor('#FEE75C').setTitle('🛒 星雨商店').setDescription(text);

  let components = [];
  if (items.length > 0) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('shop_select')
      .setPlaceholder('選擇要購買的商品')
      .addOptions(items.map((item) => ({ label: item.item_name, description: `${item.price} 星雨幣`, value: String(item.id) })));

    const row = new ActionRowBuilder().addComponents(menu);
    components.push(row);
  }

  await shopChannel.send({ embeds: [embed], components });
}

// ===== 發送訂單系統 =====

async function sendOrderSystem(client) {

  const channel = await client.channels.fetch(
    ORDER_CHANNEL_ID
  );

  if (!channel) return;

  // 刪除舊面板
  const messages = await channel.messages.fetch({
    limit: 20
  });

  const oldPanels = messages.filter(
    msg =>
      msg.author.id === client.user.id &&
      msg.embeds.length > 0 &&
      msg.embeds[0].title === '📦 星雨訂單系統'
  );

  for (const msg of oldPanels.values()) {
    await msg.delete().catch(() => {});
  }

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
      .setTitle('📦 星雨訂單系統')
      .setDescription(
        `請選擇功能\n\n` +
        `🛒 點單\n` +
        `💰 儲值`
      );

  await channel.send({
    embeds: [embed],
    components: [row]
  });

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
    ),

  new SlashCommandBuilder()
    .setName('刪除商品')
    .setDescription('刪除商店商品')
    .addStringOption(option =>
      option.setName('名稱')
        .setDescription('商品名稱')
        .setRequired(true)
    )

].map(command => command.toJSON());
const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
  try {
    console.log('[BOT] 清除 Global Commands');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });

    console.log('[BOT] 清除舊指令');
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: [] });

    console.log('[BOT] 重新註冊指令');
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });

    console.log('[BOT] Slash Commands 註冊成功');
  } catch (error) {
    console.error('[BOT] 指令註冊失敗:', error);
  }
})();

// ===== Bot Ready =====

client.once(Events.ClientReady, async () => {
  console.log({
    CHANNEL_ID: process.env.CHANNEL_ID,
    CHECKIN_CHANNEL_ID: process.env.CHECKIN_CHANNEL_ID,
    SHOP_CHANNEL_ID: process.env.SHOP_CHANNEL_ID,
    GACHA_CHANNEL_ID: process.env.GACHA_CHANNEL_ID
  });
  console.log('[BOT] 機器人已上線');
  
  // 發送訂單系統
  await sendOrderSystem(client);

  try {
    // ATM 頻道
    const atmChannel = await client.channels.fetch(process.env.CHANNEL_ID);
    if (!atmChannel) {
      console.log('[BOT] 找不到 ATM 頻道');
      return;
    }

    const atmMessages = await atmChannel.messages.fetch({ limit: 20 });
    const oldATM = atmMessages.filter(
      (msg) => msg.author.id === client.user.id && msg.embeds.length > 0 && msg.embeds[0].title === '🏦 星雨銀行 ATM'
    );

    for (const msg of oldATM.values()) {
      await msg.delete().catch(() => {});
    }

    const walletButton = new ButtonBuilder()
      .setCustomId('check_coins')
      .setLabel('💰 餘額查詢')
      .setStyle(ButtonStyle.Success);

    const transferButton = new ButtonBuilder()
      .setCustomId('transfer_menu')
      .setLabel('💸 星雨轉帳')
      .setStyle(ButtonStyle.Primary);

    const atmRow = new ActionRowBuilder().addComponents(walletButton, transferButton);

    const atmEmbed = new EmbedBuilder()
      .setColor('#00ff99')
      .setTitle('🏦 星雨銀行 ATM')
      .setDescription(
        `╔════════════╗
💳 歡迎使用 星雨ATM
╚════════════╝

💰 查詢餘額
💸 星雨轉帳
🔒 安全交易系統

請點擊下方按鈕操作

🏧 狀態 ☔ 幣別 🔒 安全
🟢 線上 星雨幣 已啟用`
      )
      .setFooter({ text: 'Rain Bank ATM System' });

    await atmChannel.send({ embeds: [atmEmbed], components: [atmRow] });

    // 簽到頻道
    const checkinChannel = await client.channels.fetch(process.env.CHECKIN_CHANNEL_ID);
    if (!checkinChannel) {
      console.log('[BOT] 找不到簽到頻道');
      return;
    }

    const checkinMessages = await checkinChannel.messages.fetch({ limit: 20 });
    const oldCheckin = checkinMessages.filter(
      (msg) => msg.author.id === client.user.id && msg.embeds.length > 0 && msg.embeds[0].title === '☔ 每日簽到'
    );

    for (const msg of oldCheckin.values()) {
      await msg.delete().catch(() => {});
    }

    const checkinButton = new ButtonBuilder()
      .setCustomId('daily_checkin')
      .setLabel('☔ 每日簽到')
      .setStyle(ButtonStyle.Primary);

    const checkinRow = new ActionRowBuilder().addComponents(checkinButton);

    const checkinEmbed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('☔ 每日簽到')
      .setDescription('每天都可以來領一次 10 枚星雨幣 ✨');

    await checkinChannel.send({ embeds: [checkinEmbed], components: [checkinRow] });

    // 商店
    await refreshShop(client);

    // ===== 扭蛋頻道 =====
    const gachaChannel = await client.channels.fetch(
      process.env.GACHA_CHANNEL_ID
    );
    if (gachaChannel) {
      const messages = await gachaChannel.messages.fetch({
        limit: 20
      });
      const oldPanel = messages.filter(
        msg =>
          msg.author.id === client.user.id &&
          msg.embeds.length > 0 &&
          msg.embeds[0].title === '🎰 星雨扭蛋'
      );
      for (const msg of oldPanel.values()) {
        await msg.delete().catch(() => {});
      }
      const singleButton = new ButtonBuilder()
        .setCustomId('gacha_single')
        .setLabel('🎰 單抽')
        .setStyle(ButtonStyle.Primary);
      const tenButton = new ButtonBuilder()
        .setCustomId('gacha_ten')
        .setLabel('🎰 十抽')
        .setStyle(ButtonStyle.Success);
      const poolButton = new ButtonBuilder()
        .setCustomId('gacha_view_pool')
        .setLabel('📦 查看獎池')
        .setStyle(ButtonStyle.Secondary);
      const row = new ActionRowBuilder()
        .addComponents(poolButton, singleButton, tenButton);
      const embed = new EmbedBuilder()
        .setColor('#ff66cc')
        .setTitle('🎰 星雨扭蛋')
        .setDescription(
          `✨ 歡迎來到星雨扭蛋機\n\n` +
          `🎰 單抽\n` +
          `🎰 十抽\n\n` +
          `點擊下方按鈕開始抽卡`
        );
      await gachaChannel.send({
        embeds: [embed],
        components: [row]
      });
    }
  } catch (error) {
    console.error('[BOT] Ready 事件出錯:', error);
  }
});

// ===== Interaction Handler =====

client.on(Events.InteractionCreate, async (interaction) => {

  try {

    // ===== BUTTON =====

    if (interaction.isButton()) {

      // ===== 使用優惠券 =====

      if (
        interaction.customId ===
        'use_coupon'
      ) {

        const { data: coupons } =
          await supabase
            .from('user_items')
            .select('*')
            .eq(
              'user_id',
              interaction.user.id
            )
            .eq(
              'item_type',
              'coupon'
            );

        if (
          !coupons ||
          coupons.length === 0
        ) {

          return interaction.reply({
            content:
              '❌ 你沒有優惠券',
            flags: 64
          });

        }

        const coupon =
          coupons[0];

        // 刪除優惠券
        await supabase
          .from('user_items')
          .delete()
          .eq('id', coupon.id);

        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor('#57F287')
              .setTitle(
                '✅ 已使用優惠券'
              )
              .setDescription(
                `${coupon.item_name}\n\n` +
                `優惠券已扣除`
              )
          ]
        });

      }

      // ===== 不使用優惠券 =====

      if (
        interaction.customId ===
        'skip_coupon'
      ) {

        return interaction.reply({
          content:
            '✅ 已略過優惠券'
        });

      }

      // ===== 完成訂單 =====

      if (
        interaction.customId ===
        'complete_order'
      ) {

        await interaction.reply({
          content:
            '✅ 訂單完成\n此頻道將在 10 秒後刪除'
        });

        setTimeout(async () => {

          await interaction.channel
            .delete()
            .catch(() => {});

        }, 10000);

      }

      // ===== 完成儲值 =====

      if (
        interaction.customId ===
        'complete_topup'
      ) {

        await interaction.reply({
          content:
            '✅ 儲值完成\n此頻道將在 10 秒後刪除'
        });

        setTimeout(async () => {

          await interaction.channel
            .delete()
            .catch(() => {});

        }, 10000);

      }

      // ===== 單抽 =====

      if (interaction.customId === 'gacha_single') {

        const { data: pools } = await supabase
          .from('gacha_pools')
          .select('*')
          .eq('guild_id', interaction.guild.id);

        if (!pools || pools.length === 0) {

          return interaction.reply({
            content: '❌ 沒有卡池',
            flags: 64
          });

        }

        const pool = pools[0];

        const { data: rewards } = await supabase
          .from('gacha_rewards')
          .select('*')
          .eq('pool_id', pool.id);

        if (!rewards || rewards.length === 0) {

          return interaction.reply({
            content: '❌ 卡池沒有獎勵',
            flags: 64
          });

        }

        const userData = await getUser(interaction.user.id);

        if (userData.coins < pool.price) {

          return interaction.reply({
            content: `❌ 星雨幣不足，需要 ${pool.price}`,
            flags: 64
          });

        }

        // 扣錢
        await updateCoins(
          interaction.user.id,
          userData.coins - pool.price
        );

        // 權重總和
        const totalChance = rewards.reduce(
          (sum, r) => sum + r.chance,
          0
        );

        // 隨機
        const random = Math.random() * totalChance;

        let current = 0;
        let selected = null;

        for (const reward of rewards) {

          current += reward.chance;

          if (random <= current) {

            selected = reward;
            break;

          }

        }

        // 防呆
        if (!selected) {
          selected = rewards[0];
        }

        // 加進玩家背包
        await addUserItem(
          interaction.user.id,
          selected.reward_name,
          selected.rarity,
          selected.reward_description,
          'gacha'
        );

        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor('#ff66cc')
              .setTitle('🎰 單抽結果')
              .setDescription(
                `👤 玩家：${interaction.user}\n\n` +
                `🎉 獲得：${selected.reward_name}\n` +
                `✨ 稀有度：${selected.rarity}\n\n` +
                `📦 ${selected.reward_description}`
              )
              .addFields(
                {
                  name: '💰 花費',
                  value: `${pool.price} 星雨幣`,
                  inline: true
                },
                {
                  name: '💳 剩餘',
                  value: `${userData.coins - pool.price} 星雨幣`,
                  inline: true
                }
              )
          ]
        });

      }

      // ===== 十抽 =====

      if (interaction.customId === 'gacha_ten') {

        const { data: pools } = await supabase
          .from('gacha_pools')
          .select('*')
          .eq('guild_id', interaction.guild.id);

        if (!pools || pools.length === 0) {

          return interaction.reply({
            content: '❌ 沒有卡池',
            flags: 64
          });

        }

        const pool = pools[0];

        const { data: rewards } = await supabase
          .from('gacha_rewards')
          .select('*')
          .eq('pool_id', pool.id);

        if (!rewards || rewards.length === 0) {

          return interaction.reply({
            content: '❌ 卡池沒有獎勵',
            flags: 64
          });

        }

        const totalPrice = pool.price * 10;

        const userData = await getUser(interaction.user.id);

        if (userData.coins < totalPrice) {

          return interaction.reply({
            content: `❌ 星雨幣不足，需要 ${totalPrice}`,
            flags: 64
          });

        }

        // 扣錢
        await updateCoins(
          interaction.user.id,
          userData.coins - totalPrice
        );

        // 權重總和
        const totalChance = rewards.reduce(
          (sum, r) => sum + r.chance,
          0
        );

        const results = [];

        for (let i = 0; i < 10; i++) {

          const random = Math.random() * totalChance;

          let current = 0;
          let selected = null;

          for (const reward of rewards) {

            current += reward.chance;

            if (random <= current) {

              selected = reward;
              break;

            }

          }

          // 防呆
          if (!selected) {
            selected = rewards[0];
          }

          // 加進背包
          await addUserItem(
            interaction.user.id,
            selected.reward_name,
            selected.rarity,
            selected.reward_description,
            'gacha'
          );

          results.push(
            `🎉 ${selected.reward_name}【${selected.rarity}】`
          );

        }

        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor('#ffcc00')
              .setTitle('🎰 十抽結果')
              .setDescription(
                `👤 玩家：${interaction.user}\n\n` +
                results.join('\n')
              )
              .addFields(
                {
                  name: '💰 花費',
                  value: `${totalPrice} 星雨幣`,
                  inline: true
                },
                {
                  name: '💳 剩餘',
                  value: `${userData.coins - totalPrice} 星雨幣`,
                  inline: true
                }
              )
          ]
        });

      }
      // ===== 查看獎池 =====
      if (interaction.customId === 'gacha_view_pool') {
        await interaction.deferReply({ flags: 64 });
        const { data: pools } = await supabase
          .from('gacha_pools')
          .select('*')
          .eq('guild_id', interaction.guild.id);
        if (!pools || pools.length === 0) {
          return interaction.editReply({
            content: '❌ 沒有卡池'
          });
        }
        const pool = pools[0];
        const { data: rewards } = await supabase
          .from('gacha_rewards')
          .select('*')
          .eq('pool_id', pool.id);
        if (!rewards || rewards.length === 0) {
          return interaction.editReply({
            content: '❌ 卡池沒有獎勵'
          });
        }
        const text = rewards.map(r =>
          `🎁 ${r.reward_name}\n✨ ${r.rarity}\n🍀 機率權重：${r.chance}\n📦 ${r.reward_description}`
        ).join('\n\n');
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor('#ff99cc')
              .setTitle(`📦 ${pool.pool_name} 獎池`)
              .setDescription(
                `💰 單抽價格：${pool.price} 星雨幣\n\n${text}`
              )
          ]
        });
      }
      // ===== 餘額查詢 =====

      if (interaction.customId === 'check_coins') {

        const userData = await getUser(interaction.user.id);

        return interaction.reply({
          content: `💰 你目前有 ${userData.coins} 星雨幣`,
          flags: 64
        });

      }

      // ===== 每日簽到 =====

      if (interaction.customId === 'daily_checkin') {

        const userId = interaction.user.id;
        const userData = await getUser(userId);
        const today = getTodayDateString();

        if (userData.last_checkin === today) {

          return interaction.reply({
            content: '❌ 今天已經簽到過了',
            flags: 64
          });

        }

        await updateCoins(userId, userData.coins + 10);
        await updateCheckin(userId, today);

        return interaction.reply({
          content: '☔ 簽到成功！獲得 10 星雨幣',
          flags: 64
        });

      }

      // ===== 開啟轉帳 =====

      if (interaction.customId === 'transfer_menu') {

        const menu = new UserSelectMenuBuilder()
          .setCustomId('select_transfer_user')
          .setPlaceholder('選擇要轉帳的玩家');

        const row = new ActionRowBuilder()
          .addComponents(menu);

        return interaction.reply({
          content: '💸 請選擇玩家',
          components: [row],
          flags: 64
        });

      }

      // ===== 掉落 =====

      if (interaction.customId.startsWith('claim_')) {

        if (claimedDrops.has(interaction.message.id)) {

          return interaction.reply({
            content: '❌ 已經被領走了',
            flags: 64
          });

        }

        claimedDrops.add(interaction.message.id);

        const reward = parseInt(
          interaction.customId.replace('claim_', '')
        );

        const userData = await getUser(interaction.user.id);

        await updateCoins(
          interaction.user.id,
          userData.coins + reward
        );

        const button = new ButtonBuilder()
          .setCustomId(interaction.customId)
          .setLabel('☔ 已被領取')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true);

        const row = new ActionRowBuilder()
          .addComponents(button);

        await interaction.update({
          embeds: [
            new EmbedBuilder()
              .setColor('#808080')
              .setTitle('☔ 星雨幣已被領取')
              .setDescription(
                `${interaction.user} 搶到了 ${reward} 星雨幣`
              )
          ],
          components: [row]
        });

        setTimeout(() => {
          claimedDrops.delete(interaction.message.id);
        }, 24 * 60 * 60 * 1000);

        return;

      }

    }
    // ===== USER SELECT =====

    if (interaction.isUserSelectMenu()) {

      if (interaction.customId === 'select_transfer_user') {

        const targetId = interaction.values[0];

        const modal = new ModalBuilder()
          .setCustomId(`transfer_modal_${targetId}`)
          .setTitle('星雨轉帳');

        const input = new TextInputBuilder()
          .setCustomId('transfer_amount')
          .setLabel('輸入金額')
          .setPlaceholder('例如：100')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const row = new ActionRowBuilder()
          .addComponents(input);

        modal.addComponents(row);

        return interaction.showModal(modal);

      }

    }
  
    // ===== STRING SELECT =====

    if (interaction.isStringSelectMenu()) {
    // ===== 訂單系統 =====
    if (
      interaction.customId ===
      'order_system_select'
    ) {
      const value =
        interaction.values[0];
      // ===== 頻道名稱 =====
      const random =
        Math.floor(
          Math.random() * 9999
        );
      let channelName = '';
      if (value === 'order') {
        channelName =
          `order-${interaction.user.username}-${random}`;
      }
      if (value === 'topup') {
        channelName =
          `topup-${interaction.user.username}-${random}`;
      }
      // ===== 建立頻道 =====
      const orderChannel =
        await interaction.guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          permissionOverwrites: [
            // everyone
            {
              id:
                interaction.guild.roles.everyone,
              deny: [PermissionFlagsBits.ViewChannel]
            },
            // 使用者
            {
              id: interaction.user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory
              ]
            },
            // 店員
            {
              id: STAFF_ROLE_ID,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory
              ]
            }
          ]
        });
      // ===== 點單 =====
      if (value === 'order') {
        const couponButton =
          new ButtonBuilder()
            .setCustomId(
              'use_coupon'
            )
            .setLabel(
              '✅ 使用優惠券'
            )
            .setStyle(
              ButtonStyle.Success
            );
        const noCouponButton =
          new ButtonBuilder()
            .setCustomId(
              'skip_coupon'
            )
            .setLabel(
              '❌ 不使用優惠券'
            )
            .setStyle(
              ButtonStyle.Secondary
            );
        const completeButton =
          new ButtonBuilder()
            .setCustomId(
              'complete_order'
            )
            .setLabel(
              '✅ 完成訂單'
            )
            .setStyle(
              ButtonStyle.Primary
            );
        const row1 =
          new ActionRowBuilder()
            .addComponents(
              couponButton,
              noCouponButton
            );
        const row2 =
          new ActionRowBuilder()
            .addComponents(
              completeButton
            );
        const embed =
          new EmbedBuilder()
            .setColor('#ff66cc')
            .setTitle(
              '🛒 訂單建立成功'
            )
            .setDescription(
              `請問是否使用優惠券？`
            );
        await orderChannel.send({
          content:
            `${interaction.user}`,
          embeds: [embed],
          components: [
            row1,
            row2
          ]
        });
      }
      // ===== 儲值 =====
      if (value === 'topup') {
        const completeTopupButton =
          new ButtonBuilder()
            .setCustomId(
              'complete_topup'
            )
            .setLabel(
              '✅ 已完成儲值'
            )
            .setStyle(
              ButtonStyle.Success
            );
        const row =
          new ActionRowBuilder()
            .addComponents(
              completeTopupButton
            );
        const embed =
          new EmbedBuilder()
            .setColor('#00ffff')
            .setTitle(
              '💰 儲值申請建立成功'
            )
            .setDescription(
              `請提供以下資訊\n\n` +
              `• 付款方式\n` +
              `• 付款金額\n` +
              `• 付款截圖`
            );
        await orderChannel.send({
          content:
            `${interaction.user}`,
          embeds: [embed],
          components: [row]
        });
      }
      return interaction.reply({
        content:
          `✅ 已建立頻道：${orderChannel}`,
        flags: 64
      });
    }
    // ===== 原本商店系統 =====
    if (interaction.customId === 'shop_select') {
      const itemId = interaction.values[0];
      const { data: item } = await supabase
        .from('shop_items')
        .select('*')
        .eq('id', itemId)
        .single();
      if (!item) {
        return interaction.reply({
          content: '❌ 商品不存在',
          flags: 64
        });
      }
      const userData = await getUser(interaction.user.id);
      if (userData.coins < item.price) {
        return interaction.reply({
          content: '❌ 星雨幣不足',
          flags: 64
        });
      }
      await updateCoins(
        interaction.user.id,
        userData.coins - item.price
      );
      await addUserItem(
        interaction.user.id,
        item.item_name,
        null,
        item.description,
        'shop'
      );
      return interaction.reply({
        content: `🛒 購買成功：${item.item_name}`,
        flags: 64
      });
    }
  }  
      // ===== MODAL =====
      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('transfer_modal_')) {
          const targetId = interaction.customId.replace(
            'transfer_modal_',
            ''
          );
          const amount = parseInt(
            interaction.fields.getTextInputValue(
              'transfer_amount'
            )
          );
          if (isNaN(amount) || amount <= 0) {
            return interaction.reply({
              content: '❌ 請輸入正確金額',
              flags: 64
            });
          }
          try {
            await safeTransfer(
              interaction.user.id,
              targetId,
              amount
            );
            return interaction.reply({
              content: `✅ 成功轉帳 ${amount} 星雨幣`,
              flags: 64
            });
          } catch (error) {
             return interaction.reply({
              content: `❌ ${error.message}`,
              flags: 64
            });
          }
        }
      }
      // ===== SLASH COMMAND =====
      if (interaction.isChatInputCommand()) {
        // ping
        if (interaction.commandName === 'ping') {
          return interaction.reply('Pong!');
        }
        // 扭蛋列表
        if (interaction.commandName === '扭蛋列表') {
          const { data } = await supabase
            .from('gacha_pools')
            .select('*')
            .eq('guild_id', interaction.guild.id);
          if (!data.length) {
            return interaction.reply('目前沒有扭蛋');
          }
          const text = data.map(g =>
            `🆔 ID：${g.id}\n🎰 ${g.pool_name}\n💰 單抽價格：${g.price} 星雨幣`
          ).join('\n\n');
          return interaction.reply({
            content: `📦 扭蛋列表\n\n${text}`
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
          return interaction.reply({
           content: `✅ 已新增卡池：${name}`
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
              chance
            });
          if (error) {
            console.error(error);
            return replyError(interaction, '新增失敗');
          }
          return interaction.reply({
            content:
              `✅ 已新增獎勵：${rewardName}`
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
          return interaction.reply({
            content: `🗑️ 已刪除獎勵：${rewardName}`
          });
        }
        // 我的排名
        if (interaction.commandName === '我的排名') {
          const userData = await getUser(interaction.user.id);
          const rank = await getUserRank(interaction.user.id);
          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor('#FFD700')
                .setTitle('🏆 星雨排名')
                .setDescription(
                  `🥇 排名：第 ${rank} 名\n💰 星雨幣：${userData.coins}`
                )
            ],
            flags: 64
          });
        }
        // 交易紀錄
        if (interaction.commandName === '交易紀錄') {
          const records = await getTransferRecords(
            interaction.user.id
          );
          if (!records.length) {
            return interaction.reply({
              content: '目前沒有交易紀錄',
              flags: 64
            });
          }
          const text = records.map(r =>
            `💸 <@${r.sender_id}> ➜ <@${r.receiver_id}>\n💰 ${r.amount} 星雨幣`
          ).join('\n\n');
          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor('#00ffff')
                .setTitle('📜 最近交易紀錄')
                .setDescription(text)
            ],
            flags: 64
          });
        }
        // 發錢
        if (interaction.commandName === '發錢') {
          if (interaction.guild.ownerId !== interaction.user.id) {
            return interaction.reply({
              content: '❌ 只有群主可以使用',
              flags: 64
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
          return interaction.reply({
            content:
              `✅ 已給予 <@${target.id}> ${amount} 星雨幣`
          });
        }
        // 扣錢
        if (interaction.commandName === '扣錢') {
          if (interaction.guild.ownerId !== interaction.user.id) {
            return interaction.reply({
              content: '❌ 只有群主可以使用',
              flags: 64
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
          return interaction.reply({
            content:
              `❌ 已扣除 <@${target.id}> ${amount} 星雨幣`
          });
        }
        // 新增商品
        if (interaction.commandName === '新增商品') {
          const itemName =
            interaction.options.getString('名稱');
          const price =
            interaction.options.getInteger('價格');
          const description =
            interaction.options.getString('介紹');
          await addShopItem(
            itemName,
            price,
            description
          );
          await refreshShop(client);
          return interaction.reply({
            content: `✅ 已新增商品：${itemName}`
          });
        }
        // 刪除商品
        if (interaction.commandName === '刪除商品') {
          const itemName =
            interaction.options.getString('名稱');
          await removeShopItem(itemName);
          await refreshShop(client);
          return interaction.reply({
            content: `🗑️ 已刪除商品：${itemName}`
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
          return interaction.reply({
            content: `🗑️ 已刪除扭蛋：${name}`
          });
        }
        // 我的商品
        if (interaction.commandName === '我的商品') {
          const items = await getUserItems(
          interaction.user.id
          );
          if (!items.length) {
            return interaction.reply({
              content: '📦 你目前沒有商品',
              flags: 64
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
            item => !item.rarity
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
          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor('#ff66cc')
                .setTitle('🎒 分類背包')
                .setDescription(text)
            ],
            flags: 64
          });
        }
      }
    } catch (err) {
      console.error('[互動錯誤]', err);
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
    }
  });
// ===== 聊天掉落 =====

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const channelId = message.channel.id;

  if (dropCooldown.has(channelId)) return;

  const random = Math.floor(Math.random() * 100);

  // 訊息少於 5 字不掉落
  if (message.content.length < 5) return;

  // 5% 掉落機率
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

  dropCooldown.set(channelId, true);

  await message.channel.send({
    embeds: [embed],
    components: [row]
  });

  setTimeout(() => {
    dropCooldown.delete(channelId);
  }, 30000);
});

// ===== Login =====

client.login(process.env.TOKEN);