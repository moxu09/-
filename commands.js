const {
  SlashCommandBuilder
} = require('discord.js');

module.exports = [

  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('測試機器人'),

  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('查看排名'),

  new SlashCommandBuilder()
    .setName('inventory')
    .setDescription('查看我的商品'),

  new SlashCommandBuilder()
    .setName('single')
    .setDescription('單抽'),

  new SlashCommandBuilder()
    .setName('ten')
    .setDescription('十抽'),

  new SlashCommandBuilder()
    .setName('gachalist')
    .setDescription('查看扭蛋列表'),

  new SlashCommandBuilder()
    .setName('addcoins')
    .setDescription('發送星雨幣')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('選擇玩家')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('amount')
        .setDescription('輸入金額')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('removecoins')
    .setDescription('扣除星雨幣')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('選擇玩家')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('amount')
        .setDescription('輸入金額')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('addshop')
    .setDescription('新增商品')
    .addStringOption(option =>
      option
        .setName('name')
        .setDescription('商品名稱')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('price')
        .setDescription('商品價格')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('description')
        .setDescription('商品介紹')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('使用優惠券')
    .setDescription('替客人手動使用一張持有的優惠券')
    .addUserOption(option =>
      option
        .setName('客人')
        .setDescription('選擇要使用優惠券的客人')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('優惠券')
        .setDescription('先選客人，再選擇客人持有的優惠券')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName('removeshop')
    .setDescription('刪除商品')
    .addIntegerOption(option =>
      option
        .setName('id')
        .setDescription('商品ID')
        .setRequired(true)
    )

].map(command => command.toJSON());
