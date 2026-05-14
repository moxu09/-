require('dotenv').config();
console.log(process.env.SUPABASE_URL);
process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);
const { createClient } =
  require('@supabase/supabase-js');

const {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes
} = require('discord.js');

// ===== 配置 =====
const config =
  require('./config/config');
console.log(config);
const supabase =
  createClient(
    config.supabaseUrl,
    config.supabaseKey
  );

// ===== Services =====
const shopService =
  require('./services/shopService');

const interactionModule =
  require('./events/interactions');

const gachaService =
  require('./services/gachaService');

// ===== Client =====
const client =
  new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

const dropCooldown =
  new Map();

// ===== Slash Commands =====
const commands = [

  // ping
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('測試機器人'),

  // 排名
  new SlashCommandBuilder()
    .setName('rank')
    .setNameLocalizations({
      'zh-TW': '排名'
    })
    .setDescription('查看排名'),

  // 交易紀錄
  new SlashCommandBuilder()
    .setName('records')
    .setNameLocalizations({
      'zh-TW': '交易紀錄'
    })
    .setDescription('查看交易紀錄'),

  // 我的商品
  new SlashCommandBuilder()
    .setName('inventory')
    .setNameLocalizations({
      'zh-TW': '我的商品'
    })
    .setDescription('查看我的商品'),

  // 新增卡池
  new SlashCommandBuilder()
    .setName('addpool')
    .setNameLocalizations({
      'zh-TW': '新增卡池'
    })
    .setDescription('新增扭蛋卡池')
    .addStringOption(option =>
      option
        .setName('名稱')
        .setDescription('卡池名稱')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('價格')
        .setDescription('抽卡價格')
        .setRequired(true)
    ),

  // 刪除卡池
  new SlashCommandBuilder()
    .setName('removepool')
    .setNameLocalizations({
      'zh-TW': '刪除扭蛋'
    })
    .setDescription('刪除扭蛋卡池')
    .addStringOption(option =>
      option
        .setName('名稱')
        .setDescription('卡池名稱')
        .setRequired(true)
    ),

  // 新增獎勵
  new SlashCommandBuilder()
    .setName('addreward')
    .setNameLocalizations({
      'zh-TW': '新增獎勵'
    })
    .setDescription('新增獎勵')
    .addIntegerOption(option =>
      option
        .setName('卡池id')
        .setDescription('卡池ID')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('名稱')
        .setDescription('獎勵名稱')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('介紹')
        .setDescription('獎勵介紹')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('稀有度')
        .setDescription('SSR / SR / R')
        .setRequired(true)
    )
    .addNumberOption(option =>
      option
        .setName('機率')
        .setDescription('中獎機率')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('星雨幣')
        .setDescription('給予星雨幣')
        .setRequired(false)
    ),

  // 刪除獎勵
  new SlashCommandBuilder()
    .setName('removereward')
    .setNameLocalizations({
      'zh-TW': '刪除獎勵'
    })
    .setDescription('刪除獎勵')
    .addIntegerOption(option =>
      option
        .setName('卡池id')
        .setDescription('卡池ID')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('名稱')
        .setDescription('獎勵名稱')
        .setRequired(true)
    ),

  // 扭蛋列表
  new SlashCommandBuilder()
    .setName('gachalist')
    .setNameLocalizations({
      'zh-TW': '扭蛋列表'
    })
    .setDescription('查看扭蛋列表'),

  // 單抽
  new SlashCommandBuilder()
    .setName('single')
    .setNameLocalizations({
      'zh-TW': '單抽'
    })
    .setDescription('單抽'),

  // 十抽
  new SlashCommandBuilder()
    .setName('ten')
    .setNameLocalizations({
      'zh-TW': '十抽'
    })
    .setDescription('十抽'),

  // 發錢
  new SlashCommandBuilder()
    .setName('addcoins')
    .setNameLocalizations({
      'zh-TW': '發錢'
    })
    .setDescription('發送星雨幣')
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

  // 扣錢
  new SlashCommandBuilder()
    .setName('removecoins')
    .setNameLocalizations({
      'zh-TW': '扣錢'
    })
    .setDescription('扣除星雨幣')
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

  // 新增商品
  new SlashCommandBuilder()
    .setName('addshop')
    .setNameLocalizations({
      'zh-TW': '新增商品'
    })
    .setDescription('新增商品')
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
    ),

  // 刪除商品
  new SlashCommandBuilder()
    .setName('removeshop')
    .setNameLocalizations({
      'zh-TW': '刪除商品'
    })
    .setDescription('刪除商品')
    .addIntegerOption(option =>
      option
        .setName('商品id')
        .setDescription('商品ID')
        .setRequired(true)
    )

].map(command =>
  command.toJSON()
);

// ===== 註冊 Slash =====
(async () => {

  try {

    const rest =
      new REST({
        version: '10'
      }).setToken(
        config.token
      );

    console.log(
      '[BOT] 清除舊指令'
    );

    await rest.put(
      Routes.applicationGuildCommands(
        config.clientId,
        config.guildId
      ),
      {
        body: []
      }
    );

    console.log(
      '[BOT] 開始註冊指令'
    );

    await rest.put(
      Routes.applicationGuildCommands(
        config.clientId,
        config.guildId
      ),
      {
        body: commands
      }
    );

    console.log(
      '[BOT] Slash Commands 註冊成功'
    );

  } catch (error) {

    console.error(
      '[BOT] 指令註冊失敗'
    );

    console.error(error);
  }

})();

// ===== Ready =====
client.once(
  Events.ClientReady,
  async () => {

    console.log(
      `[BOT] ${client.user.tag} 已上線`
    );

    try {

      // 初始化
      interactionModule.setup(
        supabase,
        client
      );

      gachaService.setup(
        supabase
      );

      // ===== 商店刷新 =====
      await shopService.refreshShop(
        client
      );

      // ===== 扭蛋面板 =====
      const gachaChannel =
        await client.channels.fetch(
          config.channels.gacha
        );

      if (gachaChannel) {

        const messages =
          await gachaChannel
            .messages.fetch({
              limit: 20
            });

        const oldPanels =
          messages.filter(
            msg =>
              msg.author.id ===
                client.user.id &&
              msg.embeds.length > 0 &&
              msg.embeds[0].title ===
                '🎰 星雨扭蛋'
          );

        for (
          const msg of oldPanels.values()
        ) {

          await msg.delete()
            .catch(() => {});
        }

        const singleButton =
          new ButtonBuilder()
            .setCustomId(
              'gacha_single'
            )
            .setLabel(
              '🎰 單抽'
            )
            .setStyle(
              ButtonStyle.Primary
            );

        const tenButton =
          new ButtonBuilder()
            .setCustomId(
              'gacha_ten'
            )
            .setLabel(
              '🎰 十抽'
            )
            .setStyle(
              ButtonStyle.Success
            );

        const poolButton =
          new ButtonBuilder()
            .setCustomId(
              'gacha_view_pool'
            )
            .setLabel(
              '📦 查看獎池'
            )
            .setStyle(
              ButtonStyle.Secondary
            );

        const row =
          new ActionRowBuilder()
            .addComponents(
              poolButton,
              singleButton,
              tenButton
            );

        const embed =
          new EmbedBuilder()
            .setColor('#ff66cc')
            .setTitle(
              '🎰 星雨扭蛋'
            )
            .setDescription(
              '✨ 歡迎來到星雨扭蛋機\n\n點擊下方按鈕開始抽卡'
            );

        await gachaChannel.send({
          embeds: [embed],
          components: [row]
        });
      }

      console.log(
        '[BOT] 初始化完成'
      );

    } catch (error) {

      console.error(
        '[BOT] Ready 錯誤',
        error
      );
    }
  }
);

// ===== 聊天掉落 =====
client.on(
  'messageCreate',
  async (message) => {

    if (message.author.bot)
      return;

    if (
      message.content.length < 5
    ) return;

    const channelId =
      message.channel.id;

    if (
      dropCooldown.has(
        channelId
      )
    ) {
      return;
    }

    const random =
      Math.floor(
        Math.random() * 100
      );

    if (random >= 5)
      return;

    const reward =
      Math.floor(
        Math.random() * 50
      ) + 1;

    const button =
      new ButtonBuilder()
        .setCustomId(
          `claim_${reward}`
        )
        .setLabel(
          '☔ 領取星雨幣'
        )
        .setStyle(
          ButtonStyle.Success
        );

    const row =
      new ActionRowBuilder()
        .addComponents(
          button
        );

    const embed =
      new EmbedBuilder()
        .setColor('#57F287')
        .setTitle(
          '☔ 星雨幣掉落'
        )
        .setDescription(
          `有人掉了 ${reward} 星雨幣！`
        );

    dropCooldown.set(
      channelId,
      true
    );

    await message.channel.send({
      embeds: [embed],
      components: [row]
    });

    setTimeout(() => {

      dropCooldown.delete(
        channelId
      );

    }, 30000);
  }
);

// ===== Interaction =====
client.on(
  'interactionCreate',
  async (interaction) => {

    console.log(
      '收到 interaction',
      interaction.type,
      interaction.customId
    );

    await interactionModule
      .setupInteractionEvent(
        interaction
      );
  }
);
// ===== Login =====
client.login(
  config.token
);