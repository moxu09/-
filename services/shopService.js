const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder
} = require('discord.js');

let supabase;
let client;

function setup(supabaseInstance, clientInstance) {
  supabase = supabaseInstance;
  client = clientInstance;
}

// ===== 商店商品 =====

async function getShopItems() {
  const { data, error } = await supabase
    .from('shop_items')
    .select('*')
    .order('price', { ascending: true });

  if (error) {
    console.error('[SHOP] 讀取商品失敗', error);
    return [];
  }

  return data || [];
}

// ===== 玩家資料 =====

async function getUser(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (!data) {
    await supabase
      .from('users')
      .insert([
        {
          user_id: userId,
          coins: 0
        }
      ]);

    return {
      user_id: userId,
      coins: 0
    };
  }

  return data;
}

// ===== 更新金額 =====

async function updateCoins(userId, coins) {
  const { error } = await supabase
    .from('users')
    .update({ coins })
    .eq('user_id', userId);

  if (error) {
    console.error('[SHOP] 更新金額失敗', error);
    throw new Error('更新金額失敗');
  }
}

// ===== 新增商品到背包 =====

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
    console.error('[SHOP] 新增玩家商品失敗', error);
    throw new Error('新增玩家商品失敗');
  }
}

// ===== 購買 =====

async function buyItem(interaction, itemId) {

  const items = await getShopItems();

  const item = items.find(
    i => i.id === parseInt(itemId)
  );

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

  const finalCoins = userData.coins - item.price;

  await updateCoins(
    interaction.user.id,
    finalCoins
  );

  await addUserItem(
    interaction.user.id,
    item.item_name,
    null,
    item.description,
    'shop'
  );

  return interaction.reply({
    content:
      `✅ 購買成功：${item.item_name}\n` +
      `💰 剩餘：${finalCoins} 星雨幣`,
    flags: 64
  });
}

// ===== 刷新商店 =====

async function refreshShop(client) {

  const channel = await client.channels.fetch(
    require('../config/config').channels.shop
  );

  if (!channel) return;

  const items = await getShopItems();

  const messages = await channel.messages.fetch({
    limit: 20
  });

  const oldShop = messages.filter(
    msg =>
      msg.author.id === client.user.id &&
      msg.embeds.length > 0 &&
      msg.embeds[0].title === '🛒 星雨商店'
  );

  for (const msg of oldShop.values()) {
    await msg.delete().catch(() => {});
  }

  let text = '目前商店沒有商品';

  if (items.length > 0) {
    text = items.map((item, index) =>
      `${index + 1}. ${item.item_name}\n` +
      `💰 ${item.price} 星雨幣\n` +
      `📦 ${item.description}`
    ).join('\n\n');
  }

  const embed = new EmbedBuilder()
    .setColor('#FEE75C')
    .setTitle('🛒 星雨商店')
    .setDescription(text);

  const components = [];

  if (items.length > 0) {

    const menu = new StringSelectMenuBuilder()
      .setCustomId('shop_select')
      .setPlaceholder('選擇要購買的商品')
      .addOptions(
        items.map(item => ({
          label: item.item_name,
          description: `${item.price} 星雨幣`,
          value: String(item.id)
        }))
      );

    const row = new ActionRowBuilder()
      .addComponents(menu);

    components.push(row);
  }

  await channel.send({
    embeds: [embed],
    components
  });
}

module.exports = {
  setup,
  refreshShop,
  buyItem,
  getShopItems
};