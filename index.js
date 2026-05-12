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
} = require('discord.js');

// ===== 初始化 =====

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// ===== 全域狀態 =====

const claimedDrops = new Set();
const dropCooldown = new Map();

// ===== 工具函數 =====
function isAdmin(interaction) {
  return (
    interaction.guild.ownerId === interaction.user.id ||
    interaction.member.permissions.has('Administrator')
  );
}
// 讀取玩家資料
async function getUser(userId) {
  try {
    const { data, error } = await supabase.from('users').select('*').eq('user_id', userId).single();

    if (error && error.code !== 'PGRST116') {
      console.error('[DB] 讀取玩家資料失敗:', error.message);
    }

    if (!data) {
      const { error: insertError } = await supabase.from('users').insert([{ user_id: userId, coins: 0 }]);

      if (insertError) {
        console.error('[DB] 建立玩家失敗:', insertError.message);
      }

      return { user_id: userId, coins: 0, last_checkin: null };
    }

    return data;
  } catch (err) {
    console.error('[DB] getUser 異常:', err);
    return null;
  }
}

// 更新金額
async function updateCoins(userId, coins) {
  try {
    if (coins < 0) {
      throw new Error('金額不能為負數');
    }

    const { error } = await supabase.from('users').update({ coins }).eq('user_id', userId);

    if (error) {
      console.error('[DB] 更新金額失敗:', error.message);
      throw new Error('無法更新金額');
    }
  } catch (err) {
    console.error('[DB] updateCoins 異常:', err.message);
    throw err;
  }
}

// 更新簽到
async function updateCheckin(userId, date) {
  try {
    const { error } = await supabase.from('users').update({ last_checkin: date }).eq('user_id', userId);

    if (error) {
      console.error('[DB] 更新簽到失敗:', error.message);
      throw new Error('無法更新簽到');
    }
  } catch (err) {
    console.error('[DB] updateCheckin 異常:', err.message);
    throw err;
  }
}

// 新增交易紀錄
async function addTransferRecord(senderId, receiverId, amount) {
  try {
    const { error } = await supabase.from('transfers').insert([{ sender_id: senderId, receiver_id: receiverId, amount }]);

    if (error) {
      console.error('[DB] 記錄交易失敗:', error.message);
      throw new Error('無法記錄交易');
    }
  } catch (err) {
    console.error('[DB] addTransferRecord 異常:', err.message);
    throw err;
  }
}

// 錯誤回覆
async function replyError(interaction, message) {
  try {
    if (interaction.replied || interaction.deferred) {
      return await interaction.followUp({ content: `❌ ${message}`, flags: 64 }).catch(() => {});
    }

    return await interaction.reply({ content: `❌ ${message}`, flags: 64 }).catch(() => {});
  } catch (err) {
    console.error('[error] replyError 異常:', err.message);
  }
}

// 查詢玩家排名
async function getUserRank(userId) {
  try {
    const { data, error } = await supabase.from('users').select('*').order('coins', { ascending: false });

    if (error) {
      console.error('[DB] 查詢排名失敗:', error.message);
      return null;
    }

    if (!data || data.length === 0) {
      return null;
    }

    const rank = data.findIndex((user) => user.user_id === userId);
    return rank === -1 ? null : rank + 1;
  } catch (err) {
    console.error('[DB] getUserRank 異常:', err.message);
    return null;
  }
}

// 查詢交易紀錄
async function getTransferRecords(userId) {
  try {
    const { data, error } = await supabase
      .from('transfers')
      .select('*')
      .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) {
      console.error('[DB] 查詢交易紀錄失敗:', error.message);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error('[DB] getTransferRecords 異常:', err.message);
    return [];
  }
}

// 讀取商店商品
async function getShopItems() {
  try {
    const { data, error } = await supabase.from('shop_items').select('*').order('price', { ascending: true });

    if (error) {
      console.error('[DB] 商店讀取失敗:', error.message);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error('[DB] getShopItems 異常:', err.message);
    return [];
  }
}

// 新增商品
async function addShopItem(itemName, price, description) {
  try {
    const { error } = await supabase.from('shop_items').insert([{ item_name: itemName, price, description }]);

    if (error) {
      console.error('[DB] 新增商品失敗:', error.message);
      throw new Error('新增商品失敗');
    }
  } catch (err) {
    console.error('[DB] addShopItem 異常:', err.message);
    throw err;
  }
}

// 刪除商品
async function removeShopItem(itemName) {
  try {
    const { error } = await supabase.from('shop_items').delete().eq('item_name', itemName);

    if (error) {
      console.error('[DB] 刪除商品失敗:', error.message);
      throw new Error('刪除商品失敗');
    }
  } catch (err) {
    console.error('[DB] removeShopItem 異常:', err.message);
    throw err;
  }
}

<<<<<<< HEAD
// 新增玩家商品
async function addUserItem(userId, itemName) {

  const { error } = await supabase
    .from('user_items')
    .insert([
      {
        user_id: userId,
        item_name: itemName
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
=======
// 安全轉帳
>>>>>>> 3d68eba4f6f2ab2c61ba51fd4f60dc77dc919288
async function safeTransfer(senderId, receiverId, amount) {
  try {
    if (isNaN(amount) || amount <= 0) {
      throw new Error('金額無效');
    }

    if (amount > 10000) {
      throw new Error('單次轉帳不能超過 10000');
    }

    if (senderId === receiverId) {
      throw new Error('不能轉給自己');
    }

    const senderData = await getUser(senderId);
    if (!senderData) {
      throw new Error('發送者不存在');
    }

    const receiverData = await getUser(receiverId);
    if (!receiverData) {
      throw new Error('接收者不存在');
    }

    if (senderData.coins < amount) {
      throw new Error('星雨幣不足');
    }

    const newSenderCoins = senderData.coins - amount;
    const newReceiverCoins = receiverData.coins + amount;

    await updateCoins(senderId, newSenderCoins);
    await updateCoins(receiverId, newReceiverCoins);
    await addTransferRecord(senderId, receiverId, amount);

    console.log(`[轉帳成功] ${senderId} -> ${receiverId} ${amount}枚`);
    return { success: true };
  } catch (err) {
    console.error('[轉帳] 異常:', err.message);
    throw err;
  }
}

// 取得今日日期 (UTC+8)
function getTodayDateString() {
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return utc8.toISOString().split('T')[0];
}

// 刷新商店
async function refreshShop(client) {
  try {
    const shopChannel = await client.channels.fetch(process.env.SHOP_CHANNEL_ID);
    if (!shopChannel) {
      console.log('[BOT] 商店頻道未設定');
      return;
    }

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
        .addOptions(
          items.map((item) => ({
            label: item.item_name.substring(0, 25),
            description: `${item.price} 星雨幣`,
            value: String(item.id),
          }))
        );

      const row = new ActionRowBuilder().addComponents(menu);
      components.push(row);
    }

    await shopChannel.send({ embeds: [embed], components });
    console.log('[BOT] 商店已刷新');
  } catch (err) {
    console.error('[BOT] refreshShop 異常:', err.message);
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
    .addIntegerOption(option =>
      option.setName('機率')
        .setDescription('權重')
        .setRequired(true)
    ),  
  new SlashCommandBuilder()
    .setName('刪除扭蛋')
    .setDescription('刪除一個扭蛋')
    .addStringOption(option =>
      option.setName('名稱')
        .setDescription('扭蛋名稱')
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
    console.log('[BOT] 開始重新註冊指令...');
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    console.log('[BOT] Slash Commands 註冊成功');
  } catch (error) {
    console.error('[BOT] 指令註冊失敗:', error.message);
  }
})();

// ===== Bot Ready =====

client.once(Events.ClientReady, async () => {
  console.log('[BOT] 機器人已上線');

  try {
    // ATM 頻道
    const atmChannel = await client.channels.fetch(process.env.CHANNEL_ID).catch(() => null);
    if (!atmChannel) {
      console.error('[BOT] ATM 頻道設定錯誤');
    } else {
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
    }

    // 簽到頻道
    const checkinChannel = await client.channels.fetch(process.env.CHECKIN_CHANNEL_ID).catch(() => null);
    if (!checkinChannel) {
      console.error('[BOT] 簽到頻道設定錯誤');
    } else {
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
    }

    // 商店
<<<<<<< HEAD
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
      const row = new ActionRowBuilder()
        .addComponents(singleButton, tenButton);
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
=======
    if (process.env.SHOP_CHANNEL_ID) {
      await refreshShop(client);
>>>>>>> 3d68eba4f6f2ab2c61ba51fd4f60dc77dc919288
    }
  } catch (error) {
    console.error('[BOT] Ready 事件出錯:', error.message);
  }
});

// ===== Interaction Handler =====

client.on(Events.InteractionCreate, async (interaction) => {
  try {

    // ===== BUTTON =====

    if (interaction.isButton()) {

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
<<<<<<< HEAD

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
          selected.reward_name
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
=======
        if (!userData) {
          return replyError(interaction, '讀取使用者資料失敗');
        }

        return await interaction.reply({
          content: `💰 你目前有 ${userData.coins} 星雨幣`,
          flags: 64,
>>>>>>> 3d68eba4f6f2ab2c61ba51fd4f60dc77dc919288
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
            selected.reward_name
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
<<<<<<< HEAD

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

=======
        try {
          const userId = interaction.user.id;
          const userData = await getUser(userId);
          if (!userData) {
            return replyError(interaction, '讀取使用者資料失敗');
          }

          const today = getTodayDateString();

          if (userData.last_checkin === today) {
            return replyError(interaction, '今天已經簽到過了');
          }

          const newCoins = userData.coins + 10;
          await updateCoins(userId, newCoins);
          await updateCheckin(userId, today);

          return interaction.reply({
            content: `☔ 簽到成功！\n\n獲得 10 星雨幣`,
            flags: 64,
          });
        } catch (err) {
          return replyError(interaction, err.message);
        }
>>>>>>> 3d68eba4f6f2ab2c61ba51fd4f60dc77dc919288
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
<<<<<<< HEAD

        if (claimedDrops.has(interaction.message.id)) {

          return interaction.reply({
            content: '❌ 已經被領走了',
            flags: 64
          });

        }
=======
        try {
          if (claimedDrops.has(interaction.message.id)) {
            return replyError(interaction, '這個掉落已經被搶走了');
          }
>>>>>>> 3d68eba4f6f2ab2c61ba51fd4f60dc77dc919288

          claimedDrops.add(interaction.message.id);

<<<<<<< HEAD
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
=======
          const reward = parseInt(interaction.customId.replace('claim_', ''));
          const userId = interaction.user.id;
          const userData = await getUser(userId);
          if (!userData) {
            claimedDrops.delete(interaction.message.id);
            return replyError(interaction, '讀取使用者資料失敗');
          }

          const newCoins = userData.coins + reward;

          await updateCoins(userId, newCoins);

          const disabledButton = new ButtonBuilder()
            .setCustomId(interaction.customId)
            .setLabel('☔ 已被領取')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true);

          const disabledRow = new ActionRowBuilder().addComponents(disabledButton);

          await interaction.update({
            embeds: [
              new EmbedBuilder()
                .setColor('#808080')
                .setTitle('☔ 星雨幣已被領取')
                .setDescription(`${interaction.user} 搶到了 ${reward} 星雨幣！`),
            ],
            components: [disabledRow],
          });

          // 清理 Set (24 小時後自動移除)
          setTimeout(() => {
            claimedDrops.delete(interaction.message.id);
          }, 24 * 60 * 60 * 1000);

          return;
        } catch (err) {
          claimedDrops.delete(interaction.message.id);
          return replyError(interaction, err.message);
        }
      }
    }
>>>>>>> 3d68eba4f6f2ab2c61ba51fd4f60dc77dc919288

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

      if (interaction.customId === 'shop_select') {
<<<<<<< HEAD

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
          item.item_name
        );

        return interaction.reply({
          content: `🛒 購買成功：${item.item_name}`,
          flags: 64
        });

=======
        try {
          const itemId = interaction.values[0];

          const { data: item, error: itemError } = await supabase.from('shop_items').select('*').eq('id', itemId).single();

          if (itemError || !item) {
            return replyError(interaction, '商品不存在');
          }

          const userData = await getUser(interaction.user.id);
          if (!userData) {
            return replyError(interaction, '讀取使用者資料失敗');
          }

          if (userData.coins < item.price) {
            return replyError(interaction, '星雨幣不足');
          }

          await updateCoins(interaction.user.id, userData.coins - item.price);

          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor('#57F287')
                .setTitle('🛒 購買成功')
                .setDescription(`你購買了：\n\n📦 ${item.item_name}\n💰 ${item.price} 星雨幣`),
            ],
            flags: 64,
          });
        } catch (err) {
          return replyError(interaction, err.message);
        }
>>>>>>> 3d68eba4f6f2ab2c61ba51fd4f60dc77dc919288
      }

    }

    // ===== MODAL =====

    if (interaction.isModalSubmit()) {
<<<<<<< HEAD

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
=======
      if (interaction.customId.startsWith('transfer_modal_')) {
        try {
          const modalTargetId = interaction.customId.replace('transfer_modal_', '');
          const amount = parseInt(interaction.fields.getTextInputValue('transfer_amount'));
          const userId = interaction.user.id;

          // 冷卻檢查
          const cooldownTime = transferCooldown.get(userId);
          if (cooldownTime && cooldownTime > Date.now()) {
            const remainingTime = Math.ceil((cooldownTime - Date.now()) / 1000);
            return replyError(interaction, `轉帳太快了，請在 ${remainingTime} 秒後再試`);
          }

          await safeTransfer(userId, modalTargetId, amount);

          // 設置冷卻
          transferCooldown.set(userId, Date.now() + 15000);
          setTimeout(() => {
            transferCooldown.delete(userId);
          }, 15000);

>>>>>>> 3d68eba4f6f2ab2c61ba51fd4f60dc77dc919288
          return interaction.reply({
            content: `✅ 成功轉帳 ${amount} 星雨幣`,
            flags: 64
          });
        } catch (error) {
           return interaction.reply({
            content: `❌ ${error.message}`,
            flags: 64
          });
<<<<<<< HEAD
=======
        } catch (transferError) {
          return replyError(interaction, transferError.message);
>>>>>>> 3d68eba4f6f2ab2c61ba51fd4f60dc77dc919288
        }
      }
    }

    // ===== SLASH COMMAND =====
    if (interaction.isChatInputCommand()) {

      // ping
      if (interaction.commandName === 'ping') {

        return interaction.reply('Pong!');

      }

<<<<<<< HEAD
      // 扭蛋列表
      if (interaction.commandName === '扭蛋列表') {
        const { data, error } = await supabase
          .from('gacha_pools')
          .select('*')
          .eq('guild_id', interaction.guild.id);
        if (error) {
          console.error(error);
          return interaction.reply({
            content: '❌ 讀取扭蛋失敗',
            flags: 64
          });
        }
        if (!data || data.length === 0) {
          return interaction.reply({
            content: '目前沒有扭蛋',
            flags: 64
          });
        }
        const text = data.map(g =>
          `🎰 ${g.pool_name}｜💰 ${g.price}`
        ).join('\n');
        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor('#ff66cc')
              .setTitle('🎰 扭蛋列表')
              .setDescription(text)
            ],
          flags: 64
        });
      }
        if (!data.length) {

          return interaction.reply('目前沒有扭蛋');

        }

        const text = data.map(g =>
          `🎰 ${g.name}｜💰 ${g.price}｜🎁 ${g.reward}｜🍀 權重 ${g.chance}`
        ).join('\n');

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
          interaction.options.getInteger('機率');
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

=======
      // /我的排名
      if (interaction.commandName === '我的排名') {
        try {
          const userId = interaction.user.id;
          const userData = await getUser(userId);
          if (!userData) {
            return replyError(interaction, '讀取使用者資料失敗');
          }

          const rank = await getUserRank(userId);

          if (!rank) {
            return replyError(interaction, '無法查詢排名');
          }

          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor('#FFD700')
                .setTitle('🏆 星雨排名')
                .setDescription(`你的目前排名：\n\n🥇 第 ${rank} 名\n💰 ${userData.coins} 星雨幣`),
            ],
            flags: 64,
          });
        } catch (err) {
          return replyError(interaction, err.message);
        }
      }

      // /發錢
      if (interaction.commandName === '發錢') {
        try {
          if (interaction.guild.ownerId !== interaction.user.id) {
            return replyError(interaction, '只有群主可以使用');
          }

          const target = interaction.options.getUser('玩家');
          const amount = interaction.options.getInteger('金額');

          if (isNaN(amount) || amount <= 0) {
            return replyError(interaction, '金額錯誤');
          }

          const targetData = await getUser(target.id);
          if (!targetData) {
            return replyError(interaction, '玩家不存在');
          }

          await updateCoins(target.id, targetData.coins + amount);

          return interaction.reply({
            content: `✅ 已給予 <@${target.id}> ${amount} 星雨幣`,
            flags: 64,
          });
        } catch (err) {
          return replyError(interaction, err.message);
        }
      }

      // /扣錢
      if (interaction.commandName === '扣錢') {
        try {
          if (interaction.guild.ownerId !== interaction.user.id) {
            return replyError(interaction, '只有群主可以使用');
          }

          const target = interaction.options.getUser('玩家');
          const amount = interaction.options.getInteger('金額');

          if (isNaN(amount) || amount <= 0) {
            return replyError(interaction, '金額錯誤');
          }

          const targetData = await getUser(target.id);
          if (!targetData) {
            return replyError(interaction, '玩家不存在');
          }

          const newCoins = Math.max(0, targetData.coins - amount);
          await updateCoins(target.id, newCoins);

          return interaction.reply({
            content: `❌ 已扣除 <@${target.id}> ${amount} 星雨幣`,
            flags: 64,
          });
        } catch (err) {
          return replyError(interaction, err.message);
        }
      }

      // /交易紀錄
      if (interaction.commandName === '交易紀錄') {
        try {
          const records = await getTransferRecords(interaction.user.id);

          if (records.length === 0) {
            return interaction.reply({
              content: '目前沒有交易紀錄',
              flags: 64,
            });
          }

          const text = records
            .map((record) => `💸 <@${record.sender_id}>\n➡️ <@${record.receiver_id}>\n💰 ${record.amount} 星雨幣`)
            .join('\n\n');

          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor('#00ffff')
                .setTitle('📜 最近交易紀錄')
                .setDescription(text),
            ],
            flags: 64,
          });
        } catch (err) {
          return replyError(interaction, err.message);
        }
      }

      // /新增商品
      if (interaction.commandName === '新增商品') {
        try {
          if (interaction.guild.ownerId !== interaction.user.id) {
            return replyError(interaction, '只有群主可以使用');
          }

          const itemName = interaction.options.getString('名稱');
          const price = interaction.options.getInteger('價格');
          const description = interaction.options.getString('介紹');

          if (price <= 0) {
            return replyError(interaction, '價格必須大於 0');
          }

          await addShopItem(itemName, price, description);
          await refreshShop(client);

          return interaction.reply({
            content: `✅ 已新增商品：${itemName} (${price} 星雨幣)`,
            flags: 64,
          });
        } catch (err) {
          return replyError(interaction, err.message);
        }
>>>>>>> 3d68eba4f6f2ab2c61ba51fd4f60dc77dc919288
      }

      // 刪除商品
      if (interaction.commandName === '刪除商品') {
<<<<<<< HEAD

        const itemName =
          interaction.options.getString('名稱');

        await removeShopItem(itemName);

        await refreshShop(client);

        return interaction.reply({
          content: `🗑️ 已刪除商品：${itemName}`
        });

      }

      // 刪除扭蛋
      if (interaction.commandName === '刪除扭蛋') {

        const name =
          interaction.options.getString('名稱');

        await supabase
          .from('gacha_pools')
          .delete()
          .eq('guild_id', interaction.guild.id)
          .eq('pool_name', name);

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
        const text = items.map((item, index) =>
          `${index + 1}. 🎁 ${item.item_name}`
        ).join('\n');
        return interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor('#ff66cc')
              .setTitle('📦 我的商品')
              .setDescription(text)
         ],
          flags: 64
        });
      }
    }
  } catch (err) {
    console.error('[互動錯誤]', err);
=======
        try {
          if (interaction.guild.ownerId !== interaction.user.id) {
            return replyError(interaction, '只有群主可以使用');
          }

          const itemName = interaction.options.getString('名稱');

          const { data: existingItem, error: queryError } = await supabase
            .from('shop_items')
            .select('*')
            .eq('item_name', itemName)
            .single();

          if (queryError || !existingItem) {
            return replyError(interaction, '找不到這個商品');
          }

          await removeShopItem(itemName);
          await refreshShop(client);

          return interaction.reply({
            content: `🗑️ 已刪除商品：${itemName}`,
            flags: 64,
          });
        } catch (err) {
          return replyError(interaction, err.message);
        }
      }
    }
  } catch (err) {
    console.error('[互動] 未知錯誤:', err);

>>>>>>> 3d68eba4f6f2ab2c61ba51fd4f60dc77dc919288
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
  try {
    if (message.author.bot) return;

    const channelId = message.channel.id;

    if (dropCooldown.has(channelId)) return;

    const random = Math.floor(Math.random() * 100);

<<<<<<< HEAD
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
=======
    if (random < 5) {
      const reward = Math.floor(Math.random() * 50) + 1;

      const button = new ButtonBuilder()
        .setCustomId(`claim_${reward}`)
        .setLabel('☔ 領取星雨幣')
        .setStyle(ButtonStyle.Success);

      const row = new ActionRowBuilder().addComponents(button);

      const embed = new EmbedBuilder()
        .setColor('#57F287')
        .setTitle('☔ 星雨幣掉落')
        .setDescription(`有人掉了 ${reward} 星雨幣！\n\n快點擊下方按鈕領取 ✨`);

      dropCooldown.set(channelId, true);
      await message.channel.send({ embeds: [embed], components: [row] });

      setTimeout(() => {
        dropCooldown.delete(channelId);
      }, 30000);
    }
  } catch (err) {
    console.error('[掉落] 異常:', err.message);
  }
>>>>>>> 3d68eba4f6f2ab2c61ba51fd4f60dc77dc919288
});

// ===== Login =====

client.login(process.env.TOKEN);
