require('dotenv').config();
const fs = require('fs');
process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

const { createClient } = require('@supabase/supabase-js');
const { Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder, REST, Routes, PermissionFlagsBits, ChannelType } = require('discord.js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const transferCooldown = new Map();
const claimedDrops = new Set();
const dropCooldown = new Map();

// ===== 工具函數 =====
function getRarityEmoji(rarity) {
  const map = { 'SSR': '🌈', 'SR': '⭐', 'R': '🔹' };
  return map[rarity] || '📦';
}

function isAdmin(interaction) {
  return interaction.guild.ownerId === interaction.user.id || interaction.member.permissions.has('Administrator');
}

async function getUser(userId) {
  const { data, error } = await supabase.from('users').select('*').eq('user_id', userId).single();
  if (error && error.code !== 'PGRST116') console.error('[DB] 讀取玩家資料失敗:', error);
  if (!data) {
    await supabase.from('users').insert([{ user_id: userId, coins: 0 }]).catch(e => console.error('[DB] 建立玩家失敗:', e));
    return { user_id: userId, coins: 0, last_checkin: null };
  }
  return data;
}

async function updateCoins(userId, coins) {
  if (coins < 0) throw new Error('金額不能為負數');
  const { error } = await supabase.from('users').update({ coins }).eq('user_id', userId);
  if (error) { console.error('[DB] 更新金額失敗:', error); throw new Error('無法更新金額'); }
}

async function sendWalletLog(userId, type, amount, balance, note = '') {
  if (amount === 0 && type !== '十抽') return;
  try {
    const user = await client.users.fetch(userId);
    const embed = new EmbedBuilder().setColor('#ffd700').setTitle('💰 錢包異動通知').addFields({ name: '📌 類型', value: type, inline: true }, { name: '💵 異動金額', value: `${amount} 星雨幣`, inline: true }, { name: '💳 目前餘額', value: `${balance} 星雨幣`, inline: true }).setTimestamp();
    if (note) embed.setDescription(note);
    await user.send({ embeds: [embed] });
  } catch (err) {
    console.error('[錢包通知失敗]', err);
  }
}

async function updateCheckin(userId, date) {
  const { error } = await supabase.from('users').update({ last_checkin: date }).eq('user_id', userId);
  if (error) { console.error('[DB] 更新簽到失敗:', error); throw new Error('無法更新簽到'); }
}

async function getTransferRecords(userId) {
  const { data, error } = await supabase.from('transfers').select('*').or(`sender_id.eq.${userId},receiver_id.eq.${userId}`).order('created_at', { ascending: false }).limit(10);
  if (error) { console.error('[DB] 查詢交易紀錄失敗:', error); return []; }
  return data || [];
}

async function getUserRank(userId) {
  const { data, error } = await supabase.from('users').select('*').order('coins', { ascending: false });
  if (error) { console.error('[DB] 查詢排名失敗:', error); return null; }
  if (!data?.length) return null;
  const rank = data.findIndex((user) => user.user_id === userId);
  return rank === -1 ? null : rank + 1;
}

async function getShopItems() {
  const { data, error } = await supabase.from('shop_items').select('*').order('price', { ascending: true });
  if (error) { console.error('[DB] 商店讀取失敗:', error); return []; }
  return data || [];
}

async function addShopItem(itemName, price, description) {
  const { error } = await supabase.from('shop_items').insert([{ item_name: itemName, price, description }]);
  if (error) { console.error('[DB] 新增商品失敗:', error); throw new Error('新增商品失敗'); }
}

async function removeShopItem(itemName) {
  const { error } = await supabase.from('shop_items').delete().eq('item_name', itemName);
  if (error) { console.error('[DB] 刪除商品失敗:', error); throw new Error('刪除商品失敗'); }
}

async function addUserItem(userId, itemName, rarity = null, description = null, itemType = 'shop') {
  const { error } = await supabase.from('user_items').insert([{ user_id: userId, item_name: itemName, rarity, description, item_type: itemType }]);
  if (error) { console.error('[DB] 新增玩家商品失敗:', error); throw new Error('新增玩家商品失敗'); }
}

async function getUserItems(userId) {
  const { data, error } = await supabase.from('user_items').select('*').eq('user_id', userId).order('created_at', { ascending: false });
  if (error) { console.error('[DB] 讀取玩家商品失敗:', error); return []; }
  return data || [];
}

async function replyError(interaction, message) {
  if (interaction.replied || interaction.deferred) return await interaction.followUp({ content: `❌ ${message}`, flags: 64 }).catch(() => {});
  return await interaction.reply({ content: `❌ ${message}`, flags: 64 }).catch(() => {});
}

async function replySuccess(interaction, message) {
  if (interaction.replied || interaction.deferred) return await interaction.followUp({ content: `✅ ${message}`, flags: 64 }).catch(() => {});
  return await interaction.reply({ content: `✅ ${message}`, flags: 64 }).catch(() => {});
}

async function safeTransfer(senderId, receiverId, amount) {
  const now = Date.now();
  const cooldown = transferCooldown.get(senderId);
  if (cooldown && now - cooldown < 5000) throw new Error('轉帳太快，請 5 秒後再試');
  transferCooldown.set(senderId, now);
  if (isNaN(amount) || amount <= 0) throw new Error('金額無效');
  if (amount > 10000) throw new Error('單次轉帳不能超過 10000');
  if (senderId === receiverId) throw new Error('不能轉給自己');
  const { error } = await supabase.rpc('transfer_coins', { sender_id: senderId, receiver_id: receiverId, transfer_amount: amount });
  if (error) {
    console.error('[轉帳失敗]', error);
    if (error.message.includes('餘額不足')) throw new Error('星雨幣不足');
    throw new Error('轉帳失敗');
  }
  console.log(`[轉帳成功] ${senderId} -> ${receiverId} ${amount}枚`);
  const senderData = await getUser(senderId);
  const receiverData = await getUser(receiverId);
  await sendWalletLog(senderId, '轉帳支出', -amount, senderData.coins, `💸 轉帳給 <@${receiverId}>`);
  await sendWalletLog(receiverId, '轉帳收入', amount, receiverData.coins, `💰 收到 <@${senderId}> 的轉帳`);
  return { success: true };
}

function getTodayDateString() {
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return utc8.toISOString().split('T')[0];
}

async function refreshShop(client) {
  try {
    const shopChannel = await client.channels.fetch(process.env.SHOP_CHANNEL_ID);
    if (!shopChannel) return;
    const items = await getShopItems();
    const messages = await shopChannel.messages.fetch({ limit: 20 });
    const oldShop = messages.filter((msg) => msg.author.id === client.user.id && msg.embeds.length > 0 && msg.embeds[0].title === '🛒 星雨商店');
    for (const msg of oldShop.values()) await msg.delete().catch(() => {});
    let text = items.length === 0 ? '目前商店沒有商品' : items.map((item, index) => `${index + 1}. ${item.item_name}\n💰 ${item.price} 星雨幣\n📦 ${item.description}`).join('\n\n');
    const embed = new EmbedBuilder().setColor('#FEE75C').setTitle('🛒 星雨商店').setDescription(text);
    let components = [];
    if (items.length > 0) {
      const menu = new StringSelectMenuBuilder().setCustomId('shop_select').setPlaceholder('選擇要購買的商品').addOptions(items.map((item) => ({ label: item.item_name, description: `${item.price} 星雨幣`, value: String(item.id) })));
      components.push(new ActionRowBuilder().addComponents(menu));
    }
    await shopChannel.send({ embeds: [embed], components });
  } catch (error) {
    console.error('[刷新商店失敗]', error);
  }
}

async function sendOrderSystem(client) {
  try {
    const channel = await client.channels.fetch(process.env.ORDER_CHANNEL_ID);
    if (!channel) return;
    const messages = await channel.messages.fetch({ limit: 20 });
    const oldPanels = messages.filter(msg => msg.author.id === client.user.id && msg.embeds.length > 0 && msg.embeds[0].title === '📦 星雨訂單系統');
    for (const msg of oldPanels.values()) await msg.delete().catch(() => {});
    const menu = new StringSelectMenuBuilder().setCustomId('order_system_select').setPlaceholder('請選擇功能').addOptions([{ label: '🛒 點單', description: '建立點單頻道', value: 'order' }, { label: '💰 儲值', description: '建立儲值頻道', value: 'topup' }]);
    const row = new ActionRowBuilder().addComponents(menu);
    const embed = new EmbedBuilder().setColor('#ff66cc').setTitle('📦 星雨訂單系統').setDescription('請選擇功能\n\n🛒 點單\n💰 儲值');
    await channel.send({ embeds: [embed], components: [row] });
  } catch (error) {
    console.error('[發送訂單系統失敗]', error);
  }
}

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('測試機器人'),
  new SlashCommandBuilder().setName('我的排名').setDescription('查看自己的排名'),
  new SlashCommandBuilder().setName('交易紀錄').setDescription('查看最近交易'),
  new SlashCommandBuilder().setName('我的商品').setDescription('查看自己購買的商品'),
  new SlashCommandBuilder().setName('新增卡池').setDescription('新增扭蛋卡池').addStringOption(option => option.setName('名稱').setDescription('卡池名稱').setRequired(true)).addIntegerOption(option => option.setName('價格').setDescription('抽一次價格').setRequired(true)),
  new SlashCommandBuilder().setName('刪除扭蛋').setDescription('刪除扭蛋卡池').addStringOption(option => option.setName('名稱').setDescription('卡池名稱').setRequired(true)),
  new SlashCommandBuilder().setName('新增獎勵').setDescription('新增卡池獎勵').addIntegerOption(option => option.setName('卡池id').setDescription('卡池 ID').setRequired(true)).addStringOption(option => option.setName('名稱').setDescription('獎勵名稱').setRequired(true)).addStringOption(option => option.setName('介紹').setDescription('獎勵介紹').setRequired(true)).addStringOption(option => option.setName('稀有度').setDescription('SSR / SR / R').setRequired(true)).addNumberOption(option => option.setName('機率').setDescription('例如：0.5 / 1 / 10').setRequired(true)).addIntegerOption(option => option.setName('星雨幣').setDescription('中獎時給多少星雨幣').setRequired(false)),
  new SlashCommandBuilder().setName('刪除獎勵').setDescription('刪除卡池獎勵').addIntegerOption(option => option.setName('卡池id').setDescription('卡池 ID').setRequired(true)).addStringOption(option => option.setName('名稱').setDescription('獎勵名稱').setRequired(true)),
  new SlashCommandBuilder().setName('扭蛋列表').setDescription('查看目前所有扭蛋'),
  new SlashCommandBuilder().setName('單抽').setDescription('抽一次扭蛋'),
  new SlashCommandBuilder().setName('十抽').setDescription('抽十次扭蛋'),
  new SlashCommandBuilder().setName('發錢').setDescription('給予玩家星雨幣').addUserOption(option => option.setName('玩家').setDescription('選擇玩家').setRequired(true)).addIntegerOption(option => option.setName('金額').setDescription('輸入金額').setRequired(true)),
  new SlashCommandBuilder().setName('扣錢').setDescription('扣除玩家星雨幣').addUserOption(option => option.setName('玩家').setDescription('選擇玩家').setRequired(true)).addIntegerOption(option => option.setName('金額').setDescription('輸入金額').setRequired(true)),
  new SlashCommandBuilder().setName('新增商品').setDescription('新增商店商品').addStringOption(option => option.setName('名稱').setDescription('商品名稱').setRequired(true)).addIntegerOption(option => option.setName('價格').setDescription('商品價格').setRequired(true)).addStringOption(option => option.setName('介紹').setDescription('商品介紹').setRequired(true)),
  new SlashCommandBuilder().setName('刪除商品').setDescription('刪除商店商品').addStringOption(option => option.setName('名稱').setDescription('商品名稱').setRequired(true))
].map(command => command.toJSON());

(async () => {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    console.log('[BOT] 清除舊指令');
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: [] });
    console.log('[BOT] 重新註冊指令');
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    console.log('[BOT] Slash Commands 註冊成功');
  } catch (error) {
    console.error('[BOT] 指令註冊失敗:', error);
  }
})();

client.once(Events.ClientReady, async () => {
  console.log('[BOT] 機器人已上線');
  await sendOrderSystem(client);
  try {
    const atmChannel = await client.channels.fetch(process.env.CHANNEL_ID);
    if (atmChannel) {
      const atmMessages = await atmChannel.messages.fetch({ limit: 20 });
      const oldATM = atmMessages.filter((msg) => msg.author.id === client.user.id && msg.embeds.length > 0 && msg.embeds[0].title === '🏦 星雨銀行 ATM');
      for (const msg of oldATM.values()) await msg.delete().catch(() => {});
      const walletButton = new ButtonBuilder().setCustomId('check_coins').setLabel('💰 餘額查詢').setStyle(ButtonStyle.Success);
      const transferButton = new ButtonBuilder().setCustomId('transfer_menu').setLabel('💸 星雨轉帳').setStyle(ButtonStyle.Primary);
      const atmRow = new ActionRowBuilder().addComponents(walletButton, transferButton);
      const atmEmbed = new EmbedBuilder().setColor('#00ff99').setTitle('🏦 星雨銀行 ATM').setDescription('╔════════════╗\n💳 歡迎使用 星雨ATM\n╚════════════╝\n\n💰 查詢餘額\n💸 星雨轉帳\n🔒 安全交易系統\n\n請點擊下方按鈕操作\n\n🏧 狀態 ☔ 幣別 🔒 安全\n🟢 線上 星雨幣 已啟用').setFooter({ text: 'Rain Bank ATM System' });
      await atmChannel.send({ embeds: [atmEmbed], components: [atmRow] });
    }
    const checkinChannel = await client.channels.fetch(process.env.CHECKIN_CHANNEL_ID);
    if (checkinChannel) {
      const checkinMessages = await checkinChannel.messages.fetch({ limit: 20 });
      const oldCheckin = checkinMessages.filter((msg) => msg.author.id === client.user.id && msg.embeds.length > 0 && msg.embeds[0].title === '☔ 每日簽到');
      for (const msg of oldCheckin.values()) await msg.delete().catch(() => {});
      const checkinButton = new ButtonBuilder().setCustomId('daily_checkin').setLabel('☔ 每日簽到').setStyle(ButtonStyle.Primary);
      const checkinRow = new ActionRowBuilder().addComponents(checkinButton);
      const checkinEmbed = new EmbedBuilder().setColor('#5865F2').setTitle('☔ 每日簽到').setDescription('每天都可以來領一次 10 枚星雨幣 ✨');
      await checkinChannel.send({ embeds: [checkinEmbed], components: [checkinRow] });
    }
    await refreshShop(client);
    const gachaChannel = await client.channels.fetch(process.env.GACHA_CHANNEL_ID);
    if (gachaChannel) {
      const messages = await gachaChannel.messages.fetch({ limit: 20 });
      const oldPanel = messages.filter(msg => msg.author.id === client.user.id && msg.embeds.length > 0 && msg.embeds[0].title === '🎰 星雨扭蛋');
      for (const msg of oldPanel.values()) await msg.delete().catch(() => {});
      const singleButton = new ButtonBuilder().setCustomId('gacha_single').setLabel('🎰 單抽').setStyle(ButtonStyle.Primary);
      const tenButton = new ButtonBuilder().setCustomId('gacha_ten').setLabel('🎰 十抽').setStyle(ButtonStyle.Success);
      const poolButton = new ButtonBuilder().setCustomId('gacha_view_pool').setLabel('📦 查看獎池').setStyle(ButtonStyle.Secondary);
      const row = new ActionRowBuilder().addComponents(poolButton, singleButton, tenButton);
      const embed = new EmbedBuilder().setColor('#ff66cc').setTitle('🎰 星雨扭蛋').setDescription('✨ 歡迎來到星雨扭蛋機\n\n🎰 單抽\n🎰 十抽\n\n點擊下方按鈕開始抽卡');
      await gachaChannel.send({ embeds: [embed], components: [row] });
    }
  } catch (error) {
    console.error('[BOT] Ready 事件出錯:', error);
  }
});

const { setupInteractionEvent } = require('./events/interactions');
client.on(Events.InteractionCreate, async (interaction) => {
  await setupInteractionEvent(interaction);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const channelId = message.channel.id;
  if (dropCooldown.has(channelId)) return;
  const random = Math.floor(Math.random() * 100);
  if (message.content.length < 5 || random >= 5) return;
  const reward = Math.floor(Math.random() * 20) + 1;
  const button = new ButtonBuilder().setCustomId(`claim_${reward}`).setLabel('☔ 領取星雨幣').setStyle(ButtonStyle.Success);
  const row = new ActionRowBuilder().addComponents(button);
  const embed = new EmbedBuilder().setColor('#57F287').setTitle('☔ 星雨幣掉落').setDescription(`有人掉了 ${reward} 星雨幣！\n\n快點擊下方按鈕領取 ✨`);
  dropCooldown.set(channelId, true);
  await message.channel.send({ embeds: [embed], components: [row] });
  setTimeout(() => { dropCooldown.delete(channelId); }, 30000);
});

client.login(process.env.TOKEN);