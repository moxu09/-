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

const slashHandler =
  require('../handlers/slashHandler');

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

// ===== Interaction 處理 =====
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
    // Buttons
    // =========================
    if (
      interaction.isButton()
    ) {

      // ===== 單抽 =====
      if (
        interaction.customId ===
        'gacha_single'
      ) {
        try {
          console.log('開始單抽');
          await interaction.deferReply();
          const result =
            await gachaService
              .performGacha(
                interaction.user.id,
                interaction.guild.id,
                1
              );
          console.log(result);
          return interaction.editReply({
            content:
              `🎰 單抽結果\n\n` +
              `🎉 ${result.results[0].name}\n` +
              `✨ ${result.results[0].rarity}`
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
      }
      // ===== 十抽 =====
      if (
        interaction.customId ===
        'gacha_ten'
      ) {

        await interaction.deferReply();

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

        return interaction.editReply({
          content:
            `🎰 十抽結果\n\n${text}`
        });
      }

      // ===== 餘額查詢 =====
      if (
        interaction.customId ===
        'check_coins'
      ) {

        return walletService
          .checkBalance(
            interaction
          );
      }

      // ===== 每日簽到 =====
      if (
        interaction.customId ===
        'daily_checkin'
      ) {

        return walletService
          .dailyCheckin(
            interaction
          );
      }

      // ===== 轉帳 =====
      if (
        interaction.customId ===
        'transfer_menu'
      ) {

        return transferService
          .openTransferMenu(
            interaction
          );
      }

      // ===== 掉落領取 =====
      if (
        interaction.customId.startsWith(
          'claim_'
        )
      ) {

        const reward =
          parseInt(
            interaction.customId
              .split('_')[1]
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

      // ===== 查看獎池 =====
      if (
        interaction.customId ===
        'gacha_view_pool'
      ) {

        return gachaService
          .showPools(
            interaction
          );
      }
    }

    // =========================
    // Select Menu
    // =========================
    if (
      interaction.isStringSelectMenu()
    ) {

      // ===== 商店購買 =====
      if (
        interaction.customId ===
        'shop_select'
      ) {

        const itemId =
          interaction.values[0];

        return shopService.buyItem(
          interaction,
          parseInt(itemId)
        );
      }

      // ===== 訂單系統 =====
      if (
        interaction.customId ===
        'order_system_select'
      ) {

        const value =
          interaction.values[0];

        return interaction.reply({
          content:
            `📦 你選擇了：${value}`,
          flags: 64
        });
      }

      // ===== 轉帳選單 =====
      if (
        interaction.customId ===
        'transfer_user_select'
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

      // ===== 轉帳輸入 =====
      if (
        interaction.customId.startsWith(
          'transfer_modal_'
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
              '❌ 系統錯誤',
            flags: 64
          })
          .catch(() => {});
      }

      return interaction
        .reply({
          content:
            '❌ 系統錯誤',
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