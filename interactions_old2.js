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

const orderService =
  require('../services/orderService');

const slashHandler =
  require('../handlers/slashHandler');

const {
  EmbedBuilder
} = require('discord.js');

let supabase;
let client;

// =========================
// 初始化
// =========================
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
    supabase,
    client
  );

  orderService.setup(
    supabase,
    client
  );

  console.log(
    '[INTERACTION] 初始化完成'
  );
}

// =========================
// Button Handlers
// =========================
const buttonHandlers = {

  // =========================
  // 扭蛋單抽
  // =========================
  'gacha:single': async (
    interaction
  ) => {

    await interaction.deferReply();

    try {

      const result =
        await gachaService
          .performGacha(
            interaction.user.id,
            interaction.guild.id,
            1
          );

      const reward =
        result.results[0];

      const embed =
        new EmbedBuilder()
          .setColor('#ff66cc')
          .setTitle(
            '🎰 單抽結果'
          )
          .setDescription(
            `🎉 恭喜獲得：${reward.name}\n✨ 稀有度：${reward.rarity}`
          );

      return interaction.editReply({
        embeds: [embed]
      });

    } catch (error) {

      console.error(
        '[單抽錯誤]',
        error
      );

      return interaction.editReply({
        content:
          '❌ 單抽失敗'
      });
    }
  },

  // =========================
  // 扭蛋十抽
  // =========================
  'gacha:ten': async (
    interaction
  ) => {

    await interaction.deferReply();

    try {

      const result =
        await gachaService
          .performGacha(
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

      const embed =
        new EmbedBuilder()
          .setColor('#ff66cc')
          .setTitle(
            '🎰 十抽結果'
          )
          .setDescription(
            text
          );

      return interaction.editReply({
        embeds: [embed]
      });

    } catch (error) {

      console.error(
        '[十抽錯誤]',
        error
      );

      return interaction.editReply({
        content:
          '❌ 十抽失敗'
      });
    }
  },

  // =========================
  // 查看獎池
  // =========================
  'gacha:view_pool': async (
    interaction
  ) => {

    try {

      return gachaService
        .showPools(
          interaction
        );

    } catch (error) {

      console.error(
        '[查看獎池錯誤]',
        error
      );

      return interaction.reply({
        content:
          '❌ 無法查看獎池',
        flags: 64
      });
    }
  },

  // =========================
  // ATM 查詢
  // =========================
  'wallet:check': async (
    interaction
  ) => {

    try {

      return walletService
        .checkBalance(
          interaction
        );

    } catch (error) {

      console.error(
        '[ATM錯誤]',
        error
      );

      return interaction.reply({
        content:
          '❌ 查詢失敗',
        flags: 64
      });
    }
  },

  // =========================
  // 每日簽到
  // =========================
  'wallet:checkin': async (
    interaction
  ) => {

    try {

      return walletService
        .dailyCheckin(
          interaction
        );

    } catch (error) {

      console.error(
        '[簽到錯誤]',
        error
      );

      return interaction.reply({
        content:
          '❌ 簽到失敗',
        flags: 64
      });
    }
  },

  // =========================
  // 開啟轉帳
  // =========================
  'transfer:menu': async (
    interaction
  ) => {

    try {

      return transferService
        .openTransferMenu(
          interaction
        );

    } catch (error) {

      console.error(
        '[轉帳選單錯誤]',
        error
      );

      return interaction.reply({
        content:
          '❌ 無法開啟轉帳',
        flags: 64
      });
    }
  },

  // =========================
  // 我的商品
  // =========================
  'inventory:view': async (
    interaction
  ) => {

    try {

      return inventoryService
        .showInventory(
          interaction
        );

    } catch (error) {

      console.error(
        '[背包錯誤]',
        error
      );

      return interaction.reply({
        content:
          '❌ 無法開啟背包',
        flags: 64
      });
    }
  }
};

// =========================
// Interaction 主事件
// =========================
async function setupInteractionEvent(
  interaction
) {

  try {

    // =========================
    // Slash Commands
    // =========================
    if (
      interaction.isChatInputCommand()
    ) {

      console.log(
        '[Slash]',
        interaction.commandName
      );

      return slashHandler
        .handleSlashCommand(
          interaction
        );
    }

    // =========================
    // Button
    // =========================
    if (
      interaction.isButton()
    ) {

      console.log(
        '[BUTTON]',
        interaction.customId
      );

      // =========================
      // 聊天掉落
      // =========================
      if (
        interaction.customId.startsWith(
          'wallet:claim:'
        )
      ) {

        const reward =
          parseInt(
            interaction.customId
              .split(':')[2]
          );

        const user =
          await walletService
            .getUser(
              interaction.user.id
            );

        const newCoins =
          user.coins + reward;

        await walletService
          .updateCoins(
            interaction.user.id,
            newCoins
          );

        await walletService
          .sendWalletLog(
            interaction.user.id,
            '聊天掉落',
            reward,
            newCoins,
            '☔ 聊天掉落獎勵'
          );

        return interaction.reply({
          content:
            `☔ ${interaction.user} 領取了 ${reward} 星雨幣！`
        });
      }

      // =========================
      // 一般按鈕
      // =========================
      const handler =
        buttonHandlers[
          interaction.customId
        ];

      if (handler) {

        return handler(
          interaction
        );
      }

      return interaction.reply({
        content:
          `❌ 未知按鈕：${interaction.customId}`,
        flags: 64
      });
    }

    // =========================
    // Select Menu
    // =========================
    if (
      interaction.isStringSelectMenu()
    ) {

      console.log(
        '[SELECT]',
        interaction.customId
      );

      // =========================
      // 商店購買
      // =========================
      if (
        interaction.customId ===
        'shop:select'
      ) {

        const itemId =
          parseInt(
            interaction.values[0]
          );

        return shopService.buyItem(
          interaction,
          itemId
        );
      }

      // =========================
      // 點單系統
      // =========================
      if (
        interaction.customId ===
        'order:select'
      ) {

        return orderService
          .handleOrderSelect(
            interaction
          );
      }

      // =========================
      // 轉帳選人
      // =========================
      if (
        interaction.customId ===
        'transfer:user_select'
      ) {

        return transferService
          .handleTransferUser(
            interaction
          );
      }
    }

    // =========================
    // Modal
    // =========================
    if (
      interaction.isModalSubmit()
    ) {

      console.log(
        '[MODAL]',
        interaction.customId
      );

      // =========================
      // 轉帳 Modal
      // =========================
      if (
        interaction.customId.startsWith(
          'transfer:modal:'
        )
      ) {

        return transferService
          .handleTransferSubmit(
            interaction
          );
      }
    }

  } catch (error) {

    console.error(
      '[interaction error]',
      error
    );

    try {

      if (
        interaction.replied ||
        interaction.deferred
      ) {

        return interaction
          .followUp({
            content:
              '❌ 系統發生錯誤',
            flags: 64
          })
          .catch(() => {});
      }

      return interaction
        .reply({
          content:
            '❌ 系統發生錯誤',
          flags: 64
        })
        .catch(() => {});

    } catch (err) {

      console.error(
        '[interaction reply error]',
        err
      );
    }
  }
}

module.exports = {
  setup,
  setupInteractionEvent
};