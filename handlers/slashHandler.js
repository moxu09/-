const walletService =
  require('../services/walletService');

const inventoryService =
  require('../services/inventoryService');

const shopService =
  require('../services/shopService');

const transferService =
  require('../services/transferService');

const gachaService =
  require('../services/gachaService');

let supabase;
let client;

// ===== 初始化 =====
function setup(
  supabaseInstance,
  clientInstance
) {

  supabase = supabaseInstance;

  client = clientInstance;

  walletService.setup(
    supabase,
    client
  );

  inventoryService.setup(
    supabase,
    client
  );

  shopService.setup(
    supabase,
    client
  );

  transferService.setup(
    supabase,
    client
  );

  gachaService.setup(
    supabase
  );
}

// ===== Slash Commands =====
async function handleSlashCommand(
  interaction
) {

  // ===== ping =====
  if (
    interaction.commandName ===
    'ping'
  ) {

    return interaction.reply({
      content: 'Pong!'
    });
  }

  // ===== 排名 =====
  if (
    interaction.commandName ===
    'rank'
  ) {

    return walletService.showRank(
      interaction
    );
  }

  // ===== 交易紀錄 =====
  if (
    interaction.commandName ===
    'records'
  ) {

    return walletService.showTransfers(
      interaction
    );
  }

  // ===== 我的商品 =====
  if (
    interaction.commandName ===
    'inventory'
  ) {

    return inventoryService.showInventory(
      interaction
    );
  }

  // ===== 新增卡池 =====
  if (
    interaction.commandName ===
    'addpool'
  ) {

    const name =
      interaction.options.getString(
        '名稱'
      );

    const price =
      interaction.options.getInteger(
        '價格'
      );

    return gachaService.addPool(
      interaction,
      name,
      price
    );
  }

  // ===== 刪除卡池 =====
  if (
    interaction.commandName ===
    'removepool'
  ) {

    const name =
      interaction.options.getString(
        '名稱'
      );

    return gachaService.removePool(
      interaction,
      name
    );
  }

  // ===== 新增獎勵 =====
  if (
    interaction.commandName ===
    'addreward'
  ) {

    const poolId =
      interaction.options.getInteger(
        '卡池id'
      );

    const name =
      interaction.options.getString(
        '名稱'
      );

    const description =
      interaction.options.getString(
        '介紹'
      );

    const rarity =
      interaction.options.getString(
        '稀有度'
      );

    const chance =
      interaction.options.getNumber(
        '機率'
      );

    const coins =
      interaction.options.getInteger(
        '星雨幣'
      );

    return gachaService.addReward(
      interaction,
      poolId,
      name,
      description,
      rarity,
      chance,
      coins
    );
  }

  // ===== 刪除獎勵 =====
  if (
    interaction.commandName ===
    'removereward'
  ) {

    const poolId =
      interaction.options.getInteger(
        '卡池id'
      );

    const name =
      interaction.options.getString(
        '名稱'
      );

    return gachaService.removeReward(
      interaction,
      poolId,
      name
    );
  }

  // ===== 扭蛋列表 =====
  if (
    interaction.commandName ===
    'gachalist'
  ) {

    return gachaService.showPools(
      interaction
    );
  }

  // ===== 單抽 =====
  if (
    interaction.commandName ===
    'single'
  ) {

    await interaction.deferReply();

    const result =
      await gachaService.performGacha(
        interaction.user.id,
        interaction.guild.id,
        1
      );

    return interaction.editReply({
      content:
        `🎰 單抽結果\n\n` +
        `🎉 ${result.results[0].name}\n` +
        `✨ ${result.results[0].rarity}`
    });
  }

  // ===== 十抽 =====
  if (
    interaction.commandName ===
    'ten'
  ) {

    await interaction.deferReply();

    const result =
      await gachaService.performGacha(
        interaction.user.id,
        interaction.guild.id,
        10
      );

    const text =
      result.results
        .map(
          r =>
            `🎉 ${r.name}【${r.rarity}】`
        )
        .join('\n');

    return interaction.editReply({
      content:
        `🎰 十抽結果\n\n${text}`
    });
  }

  // ===== 發錢 =====
  if (
    interaction.commandName ===
    'addcoins'
  ) {

    const user =
      interaction.options.getUser(
        '玩家'
      );

    const amount =
      interaction.options.getInteger(
        '金額'
      );

    return walletService.giveCoins(
      interaction,
      user,
      amount
    );
  }

  // ===== 扣錢 =====
  if (
    interaction.commandName ===
    'removecoins'
  ) {

    const user =
      interaction.options.getUser(
        '玩家'
      );

    const amount =
      interaction.options.getInteger(
        '金額'
      );

    return walletService.removeCoins(
      interaction,
      user,
      amount
    );
  }

  // ===== 新增商品 =====
  if (
    interaction.commandName ===
    'addshop'
  ) {

    const name =
      interaction.options.getString(
        '名稱'
      );

    const price =
      interaction.options.getInteger(
        '價格'
      );

    const description =
      interaction.options.getString(
        '介紹'
      );

    return shopService.addItem(
      interaction,
      name,
      price,
      description
    );
  }

  // ===== 刪除商品 =====
  if (
    interaction.commandName ===
    'removeshop'
  ) {

    const id =
      interaction.options.getInteger(
        '商品id'
      );

    return shopService.removeItem(
      interaction,
      id
    );
  }
}

module.exports = {
  setup,
  handleSlashCommand
};