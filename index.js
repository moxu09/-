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
// ===== Supabase =====

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ===== Discord Client =====

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// ===== 全域狀態 =====

const claimedDrops = new Set();
const transferCooldown = new Map();
const dropCooldown = new Map();

// ===== 工具函數 =====

// 讀取玩家資料
async function getUser(userId) {
  const { data, error } = await supabase.from('users').select('*').eq('user_id', userId).single();

  if (error && error.code !== 'PGRST116') {
    console.error('[DB] 讀取玩家資料失敗:', error);
  }

  // 玩家不存在，建立新玩家
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

// 錯誤回覆
async function replyError(interaction, message) {

  if (interaction.replied || interaction.deferred) {

    return await interaction.followUp({
      content: `❌ ${message}`,
      flags: 64,
    }).catch(() => {});

  }

  return await interaction.reply({
    content: `❌ ${message}`,
    flags: 64,
  }).catch(() => {});
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

  // 如果找不到用戶，回傳 null
  if (rank === -1) {
    return null;
  }

  return rank + 1;
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
  const { data, error } =
    await supabase
      .from('shop_items')
      .select('*')
      .order('price', {
        ascending: true
      });
  if (error) {
    console.error(
      '[DB] 商店讀取失敗:',
      error
    );

    return [];
  }
  return data || [];
}
// 新增商品
async function addShopItem(
  itemName,
  price,
  description
) {

  const { error } =
    await supabase
      .from('shop_items')
      .insert([
        {
          item_name: itemName,
          price,
          description
        }
      ]);

  if (error) {

    console.error(
      '[DB] 新增商品失敗:',
      error
    );

    throw new Error(
      '新增商品失敗'
    );
  }
}

// 刪除商品
async function removeShopItem(
itemName
) {
const { error } =
await supabase
.from('shop_items')
.delete()
.eq('item_name', itemName);
if (error) {
console.error(
  '[DB] 刪除商品失敗:',
  error
);
throw new Error(
  '刪除商品失敗'
);
}
}

// 安全轉帳函數
async function safeTransfer(
  senderId,
  receiverId,
  amount
) {
  // 檢查金額
  if (
    isNaN(amount) ||
    amount <= 0
  ) {
    throw new Error('金額無效');
  }
  // 限制最大轉帳
  if (amount > 10000) {
    throw new Error('單次轉帳不能超過10000');
  }
  // 禁止轉給自己
  if (senderId === receiverId) {
    throw new Error('不能轉給自己');
  }
  // 呼叫 Supabase SQL Function
  const { error } =
    await supabase.rpc(
      'transfer_coins',
      {
        sender_id: senderId,
        receiver_id: receiverId,
        transfer_amount: amount
      }
    );
  // 錯誤處理
  if (error) {
    console.error(
      '[轉帳失敗]',
      error
    );
    // 餘額不足
    if (
      error.message.includes('餘額不足')
    ) {
      throw new Error('星雨幣不足');
    }
    // 其它錯誤
    throw new Error('轉帳失敗');
  }
  // 成功 log
  console.log(
    `[轉帳成功] ${senderId} -> ${receiverId} ${amount}枚`
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


// 刷新商店
async function refreshShop(client) {
  const shopChannel =
    await client.channels.fetch(
      process.env.SHOP_CHANNEL_ID
    );
  if (!shopChannel) return;
  // 讀取商品
  const items =
    await getShopItems();
  // 刪除舊商店
  const messages =
    await shopChannel.messages.fetch({
      limit: 20
    });
  const oldShop =
    messages.filter(
      (msg) =>
        msg.author.id === client.user.id &&
        msg.embeds.length > 0 &&
        msg.embeds[0].title === '🛒 星雨商店'
    );
  for (const msg of oldShop.values()) {
    await msg.delete().catch(() => {});
  }
  // 商品內容
  let text = '';
  if (items.length === 0) {
    text = '目前商店沒有商品';
  } else {
    text =
      items.map(
        (item, index) =>
`${index + 1}. ${item.item_name}
💰 ${item.price} 星雨幣
📦 ${item.description}`
      ).join('\n\n');
  }
  // Embed
  const embed =
    new EmbedBuilder()
      .setColor('#FEE75C')
      .setTitle('🛒 星雨商店')
      .setDescription(text);
  let components = [];

  if (items.length > 0) {

    const menu =
      new StringSelectMenuBuilder()
        .setCustomId('shop_select')
        .setPlaceholder('選擇要購買的商品')
        .addOptions(
          items.map(item => ({
            label: item.item_name,
            description:
              `${item.price} 星雨幣`,
            value: String(item.id)
          }))
        );

    const row =
      new ActionRowBuilder()
        .addComponents(menu);

    components.push(row);
  }

  await shopChannel.send({
    embeds: [embed],
    components
  });
}


// ===== 指令註冊 =====
const commands = [

new SlashCommandBuilder()
.setName('刪除商品')
.setDescription('刪除商店商品')
.addStringOption(option =>
option
.setName('名稱')
.setDescription('商品名稱')
.setRequired(true)
),

new SlashCommandBuilder()
.setName('ping')
.setDescription('測試機器人'),

new SlashCommandBuilder()
.setName('我的排名')
.setDescription('查看自己的排名'),

new SlashCommandBuilder()
.setName('發錢')
.setDescription('給予玩家星雨幣')
.addUserOption(option =>
option
.setName('玩家')
.setDescription('選擇玩家')
.setRequired(true)
)
.addIntegerOption(option =>
option
.setName('金額')
.setDescription('輸入金額')
.setRequired(true)
),

new SlashCommandBuilder()
.setName('扣錢')
.setDescription('扣除玩家星雨幣')
.addUserOption(option =>
option
.setName('玩家')
.setDescription('選擇玩家')
.setRequired(true)
)
.addIntegerOption(option =>
option
.setName('金額')
.setDescription('輸入金額')
.setRequired(true)
),

new SlashCommandBuilder()
.setName('交易紀錄')
.setDescription('查看最近交易'),

new SlashCommandBuilder()
.setName('新增商品')
.setDescription('新增商店商品')
.addStringOption(option =>
option
.setName('名稱')
.setDescription('商品名稱')
.setRequired(true)
)
.addIntegerOption(option =>
option
.setName('價格')
.setDescription('商品價格')
.setRequired(true)
)
.addStringOption(option =>
option
.setName('介紹')
.setDescription('商品介紹')
.setRequired(true)
)

].map(command => command.toJSON());

const rest =
new REST({ version: '10' })
.setToken(process.env.TOKEN);
(async () => {
try {

console.log('[BOT] 清除 Global Commands');
await rest.put(
Routes.applicationCommands(
process.env.CLIENT_ID
),
{ body: [] }
);
console.log('[BOT] 清除舊指令');
await rest.put(
  Routes.applicationGuildCommands(
    process.env.CLIENT_ID,
    process.env.GUILD_ID
  ),
  { body: [] }
);
console.log('[BOT] 重新註冊指令');
await rest.put(
  Routes.applicationGuildCommands(
    process.env.CLIENT_ID,
    process.env.GUILD_ID
  ),
  { body: commands }
);
console.log('[BOT] Slash Commands 註冊成功');
} catch (error) {
console.error(
  '[BOT] 指令註冊失敗:',
  error
);
}
})();


// ===== Bot Ready =====

client.once(Events.ClientReady, async () => {
  console.log('[BOT] 機器人已上線');

  try {
    // ===== ATM 頻道 =====

    const atmChannel = await client.channels.fetch(process.env.CHANNEL_ID);
    if (!atmChannel) {
      console.log('[BOT] 找不到 ATM 頻道');
      return;
    }
    // 刪除舊訊息
    const atmMessages = await atmChannel.messages.fetch({ limit: 20 });
    const oldATM = atmMessages.filter(
      (msg) =>
        msg.author.id === client.user.id &&
        msg.embeds.length > 0 &&
        msg.embeds[0].title === '🏦 星雨銀行 ATM'
    );

    for (const msg of oldATM.values()) {
      await msg.delete().catch(() => {});
    }

    // ATM 按鈕
    const walletButton = new ButtonBuilder()
      .setCustomId('check_coins')
      .setLabel('💰 餘額查詢')
      .setStyle(ButtonStyle.Success);

    const transferButton = new ButtonBuilder()
      .setCustomId('transfer_menu')
      .setLabel('💸 星雨轉帳')
      .setStyle(ButtonStyle.Primary);

    const atmRow = new ActionRowBuilder().addComponents(walletButton, transferButton);

    // ATM Embed
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

    // ===== 簽到頻道 =====

    const checkinChannel = await client.channels.fetch(process.env.CHECKIN_CHANNEL_ID);
    if (!checkinChannel) {
      console.log('[BOT] 找不到簽到頻道');
      return;
    }
    // 刪除舊訊息
    const checkinMessages = await checkinChannel.messages.fetch({ limit: 20 });
    const oldCheckin = checkinMessages.filter(
      (msg) =>
        msg.author.id === client.user.id &&
        msg.embeds.length > 0 &&
        msg.embeds[0].title === '☔ 每日簽到'
    );

    for (const msg of oldCheckin.values()) {
      await msg.delete().catch(() => {});
    }

    // 簽到按鈕
    const checkinButton = new ButtonBuilder()
      .setCustomId('daily_checkin')
      .setLabel('☔ 每日簽到')
      .setStyle(ButtonStyle.Primary);

    const checkinRow = new ActionRowBuilder().addComponents(checkinButton);

    // 簽到 Embed
    const checkinEmbed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('☔ 每日簽到')
      .setDescription('每天都可以來領一次 10 枚星雨幣 ✨');

    await checkinChannel.send({ embeds: [checkinEmbed], components: [checkinRow] });
    // ===== 商店 =====
    await refreshShop(client);
  } catch (error) {
    console.error('[BOT] Ready 事件出錯:', error);
  }
});


// ===== Interaction Handler =====

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ===== Button =====

    if (interaction.isButton()) {
      // 餘額查詢
      if (interaction.customId === 'check_coins') {
        const userData = await getUser(interaction.user.id);
        return await interaction.reply({
          content: `💰 你目前有 ${userData.coins} 星雨幣`,
          flags: 64,
        });
      }

      // 每日簽到
      if (interaction.customId === 'daily_checkin') {
        const userId = interaction.user.id;
        const userData = await getUser(userId);
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
      }

      // 開啟轉帳
      if (interaction.customId === 'transfer_menu') {
        const menu = new UserSelectMenuBuilder()
          .setCustomId('select_transfer_user')
          .setPlaceholder('選擇要轉帳的玩家');

        const row = new ActionRowBuilder().addComponents(menu);

        return interaction.reply({
          content: '💸 請選擇要轉帳的玩家',
          components: [row],
          flags: 64,
        });
      }

      // 領取掉落
      if (interaction.customId.startsWith('claim_')) {
        if (claimedDrops.has(interaction.message.id)) {
          return replyError(interaction, '這個掉落已經被搶走了');
        }

        claimedDrops.add(interaction.message.id);

        const reward = parseInt(interaction.customId.replace('claim_', ''));
        const userId = interaction.user.id;
        const userData = await getUser(userId);
        const newCoins = userData.coins + reward;

        await updateCoins(userId, newCoins);

        // 禁用按鈕
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
      }
    }

// ===== User Select =====

if (interaction.isUserSelectMenu()) {

  if (interaction.customId === 'select_transfer_user') {

    const modalTargetId =
      interaction.values[0];

    const modal =
      new ModalBuilder()
        .setCustomId(
          `transfer_modal_${modalTargetId}`
        )
        .setTitle('星雨轉帳');

    const amountInput =
      new TextInputBuilder()
        .setCustomId('transfer_amount')
        .setLabel('輸入轉帳金額')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('例如：100')
        .setRequired(true);

    const row =
      new ActionRowBuilder()
        .addComponents(amountInput);

    modal.addComponents(row);

    await interaction.showModal(modal);

    return;
  }
}

// ===== 商店選單 =====

if (interaction.isStringSelectMenu()) {

  if (interaction.customId === 'shop_select') {

    const itemId =
      interaction.values[0];

    // 讀取商品
    const { data: item } =
      await supabase
        .from('shop_items')
        .select('*')
        .eq('id', itemId)
        .single();

    if (!item) {

      return replyError(
        interaction,
        '商品不存在'
      );
    }

    // 玩家資料
    const userData =
      await getUser(
        interaction.user.id
      );

    // 餘額不足
    if (
      userData.coins <
      item.price
    ) {

      return replyError(
        interaction,
        '星雨幣不足'
      );
    }

    // 扣款
    await updateCoins(
      interaction.user.id,
      userData.coins - item.price
    );

    // 成功訊息
    return interaction.reply({

      embeds: [
        new EmbedBuilder()
          .setColor('#57F287')
          .setTitle('🛒 購買成功')
          .setDescription(

`你購買了：

📦 ${item.item_name}
💰 ${item.price} 星雨幣`
)
],
      flags: 64

    });
  }
}
    // ===== Modal =====

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('transfer_modal_')) {
        const modalTargetId = interaction.customId.replace('transfer_modal_', '');
        const amount = parseInt(interaction.fields.getTextInputValue('transfer_amount'));
        const userId = interaction.user.id;

        // 冷卻檢查
        const cooldownTime = transferCooldown.get(userId);
        if (
          cooldownTime &&
          cooldownTime > Date.now()
        ) { 
         const remainingTime = Math.ceil((cooldownTime - Date.now()) / 1000);

          return replyError(interaction, `轉帳太快了，請在 ${remainingTime} 秒後再試`);
        }

        try {
          // 執行安全轉帳
          await safeTransfer(userId, modalTargetId, amount);
	  // 寫入交易紀錄
	  await addTransferRecord(userId, modalTargetId, amount);
	  // 設置冷卻
	  transferCooldown.set(userId, Date.now() + 15000);
	  setTimeout(() => {
 	    transferCooldown.delete(userId);
	  }, 15000);
	  return interaction.reply({
  	    content: `✅ 成功轉帳 ${amount} 星雨幣給 <@${modalTargetId}>`,
	    flags: 64,
	  });
        } catch (transferError) {
          console.error('[轉帳] 使用者互動失敗:', transferError.message);
          return replyError(interaction, transferError.message);
        }
      }
    }

    // ===== Slash Command =====

    if (interaction.isChatInputCommand()) {
      // /ping
      if (interaction.commandName === 'ping') {
        return interaction.reply('Pong!');
      }

      // /我的排名
      if (interaction.commandName === '我的排名') {
        const userId = interaction.user.id;
        const userData = await getUser(userId);
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
      }

      // /發錢
      if (interaction.commandName === '發錢') {
        if (interaction.guild.ownerId !== interaction.user.id) {
          return replyError(interaction, '只有群主可以使用');
        }

        const target = interaction.options.getUser('玩家');
        const amount = interaction.options.getInteger('金額');

        if (isNaN(amount) || amount <= 0) {
          return replyError(interaction, '金額錯誤');
        }

        const targetData = await getUser(target.id);
        await updateCoins(target.id, targetData.coins + amount);

        return interaction.reply({
          content: `✅ 已給予 <@${target.id}> ${amount} 星雨幣`,
          flags: 64,
        });
      }

      // /扣錢
      if (interaction.commandName === '扣錢') {
        if (interaction.guild.ownerId !== interaction.user.id) {
          return replyError(interaction, '只有群主可以使用');
        }

        const target = interaction.options.getUser('玩家');
        const amount = interaction.options.getInteger('金額');

        if (isNaN(amount) || amount <= 0) {
          return replyError(interaction, '金額錯誤');
        }

        const targetData = await getUser(target.id);
        const newCoins = Math.max(0, targetData.coins - amount);

        await updateCoins(target.id, newCoins);

        return interaction.reply({
          content: `❌ 已扣除 <@${target.id}> ${amount} 星雨幣`,
          flags: 64,
        });
      }

      // /交易紀錄
      if (interaction.commandName === '交易紀錄') {
        const records = await getTransferRecords(interaction.user.id);

        if (records.length === 0) {
          return interaction.reply({
            content: '目前沒有交易紀錄',
            flags: 64,
          });
        }

        const text = records
          .map(
            (record) =>
              `💸 <@${record.sender_id}>\n➡️ <@${record.receiver_id}>\n💰 ${record.amount} 星雨幣`
          )
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
      }

      // /新增商品
      if (
	interaction.commandName === '新增商品'	
      ) {
	// 只有群主可用
	if (
    	  interaction.guild.ownerId !==
    	  interaction.user.id
  	) {
  	  return replyError(
     	    interaction,
      	    '只有群主可以使用'
   	  );
 	 }

 	 const itemName =
     	   interaction.options.getString('名稱');
 	 const price =
    	   interaction.options.getInteger('價格');
	 const description =
    	   interaction.options.getString('介紹');
	 // 新增商品
  	 await addShopItem(
   	   itemName,
   	   price,
   	   description
  	 );

  	// 刷新商店
  	await refreshShop(client);
 	return interaction.reply({
    	  content:
      	    `✅ 已新增商品：${itemName}`,
  	  flags: 64,
  	});
      }
  // /刪除商品
  if (
    interaction.commandName === '刪除商品'
  ) {
    // 只有群主可用
    if (
      interaction.guild.ownerId !==
      interaction.user.id
    ) {
      return replyError(
        interaction,
        '只有群主可以使用'
      );
    }
    const itemName =
      interaction.options.getString('名稱');
// 檢查商品是否存在
const { data: existingItem } =
  await supabase
    .from('shop_items')
    .select('*')
    .eq('item_name', itemName)
    .single();
if (!existingItem) {
  return replyError(
    interaction,
    '找不到這個商品'
  );
}
// 刪除商品
await removeShopItem(
  itemName
);
    // 刷新商店
    await refreshShop(client);
    return interaction.reply({
      content:
        `🗑️ 已刪除商品：${itemName}`,

      flags: 64,

    });
  }
    }
  } catch (err) {
    console.error('[互動] 錯誤:', err);

    if (interaction.isRepliable()) {
      const message =
        err instanceof Error && err.message ? err.message : '系統發生錯誤';

      if (interaction.replied || interaction.deferred) {
        await interaction
          .followUp({
            content: `❌ ${message}`,
            flags: 64,
          })
          .catch(() => {});
      } else {
        await interaction
          .reply({
            content: `❌ ${message}`,
            flags: 64,
          })
          .catch(() => {});
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
    await message.channel.send({
      embeds: [embed],
      components: [row]
    });
    setTimeout(() => {
      dropCooldown.delete(channelId);
    }, 30000);
  }
});

// ===== Login =====

client.login(process.env.TOKEN);
