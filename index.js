require('dotenv').config();

const { createClient } =
  require('@supabase/supabase-js');

const supabase =
  createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

const {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  UserSelectMenuBuilder
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});


// ===== function 區 =====

// 讀取玩家資料
async function getUser(userId) {

  const { data } =
    await supabase
      .from('users')
      .select('*')
      .eq('user_id', userId)
      .single();

  // 玩家不存在
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

// 更新金額
async function updateCoins(userId, coins) {

  await supabase
    .from('users')
    .update({
      coins: coins
    })
    .eq('user_id', userId);

}

// 更新簽到
async function updateCheckin(userId, date) {

  await supabase
    .from('users')
    .update({
      last_checkin: date
    })
    .eq('user_id', userId);

}

// 新增交易紀錄
async function addTransferRecord(
  senderId,
  receiverId,
  amount
) {

  await supabase
    .from('transfers')
    .insert([
      {
        sender_id: senderId,
        receiver_id: receiverId,
        amount: amount
      }
    ]);

}

// ===== Bot 上線 =====

client.once(
  Events.ClientReady,
  async () => {

    console.log('Bot 已上線');

    // ===== ATM 頻道 =====

    const atmChannel =
      await client.channels.fetch(
        process.env.CHANNEL_ID
      );

    const walletButton =
      new ButtonBuilder()
        .setCustomId('check_coins')
        .setLabel('💰 餘額查詢')
        .setStyle(ButtonStyle.Success);

    const transferButton =
      new ButtonBuilder()
        .setCustomId('transfer_menu')
        .setLabel('💸 星雨轉帳')
        .setStyle(ButtonStyle.Primary);

    const atmRow =
      new ActionRowBuilder()
        .addComponents(
          walletButton,
          transferButton
        );

    const atmEmbed =
      new EmbedBuilder()
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
🟢 線上  星雨幣  已啟用`
)

        .setImage(
'https://cdn.discordapp.com/attachments/1501098193276895360/1503008880513253406/ChatGPT_Image_2026510_08_19_56.png?ex=6a01c999&is=6a007819&hm=6c10e8db7f2f31aa3991255cf8270280d58aa3ec5da616a7adb649e8d7aeae7c&'
        )

        .setFooter({
          text:
            'Rain Bank ATM System'
        });

    await atmChannel.send({
      embeds: [atmEmbed],
      components: [atmRow]
    });

    // ===== 簽到頻道 =====

    const checkinChannel =
      await client.channels.fetch(
        process.env.CHECKIN_CHANNEL_ID
      );

    const checkinButton =
      new ButtonBuilder()
        .setCustomId('daily_checkin')
        .setLabel('☔ 每日簽到')
        .setStyle(ButtonStyle.Primary);

    const checkinRow =
      new ActionRowBuilder()
        .addComponents(
          checkinButton
        );

    const checkinEmbed =
      new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('☔ 每日簽到')
        .setDescription(
`每天都可以來領一次10枚星雨幣 ✨`
        );

    await checkinChannel.send({
      embeds: [checkinEmbed],
      components: [checkinRow]
    });

  }
);

// ===== 所有互動 =====

client.on(
  Events.InteractionCreate,
  async interaction => {

    // ===== Button =====
    if (interaction.isButton()) {

      // 餘額查詢
      if (
        interaction.customId ===
        'check_coins'
      ) {

        const userData =
          await getUser(
            interaction.user.id
          );

        return interaction.reply({
          content:
`💰 你目前有 ${userData.coins} 星雨幣`,
          flags: 64
        });

      }

      // 每日簽到
      if (
        interaction.customId ===
        'daily_checkin'
      ) {

        const userId =
          interaction.user.id;

        const userData =
          await getUser(userId);

        const today =
          new Date().toDateString();

        if (
          userData.last_checkin === today
        ) {

          return interaction.reply({
            content:
              '❌ 今天已經簽到過了',
            flags: 64
          });

        }

        const newCoins =
          userData.coins + 10;

        await updateCoins(
          userId,
          newCoins
        );

        await updateCheckin(
          userId,
          today
        );

        return interaction.reply({
          content:
`☔ 簽到成功！

獲得 10 星雨幣`,
          flags: 64
        });

      }

      // 開啟轉帳選單
      if (
        interaction.customId ===
        'transfer_menu'
      ) {

        const menu =
          new UserSelectMenuBuilder()
            .setCustomId(
              'select_transfer_user'
            )
            .setPlaceholder(
              '選擇要轉帳的玩家'
            );

        const row =
          new ActionRowBuilder()
            .addComponents(menu);

        return interaction.reply({
          content:
            '💸 請選擇要轉帳的玩家',
          components: [row],
          flags: 64
        });

      }

      // 確認轉帳
      if (
        interaction.customId.startsWith(
          'confirm_transfer_'
        )
      ) {

        const targetId =
          interaction.customId.replace(
            'confirm_transfer_',
            ''
          );

        const amount = 100;

        const userId =
          interaction.user.id;

        if (targetId === userId) {

          return interaction.reply({
            content:
              '❌ 不能轉給自己哦！',
            flags: 64
          });

        }

        const senderData =
          await getUser(userId);

        if (senderData.coins < amount) {

          return interaction.reply({
            content:
              '❌ 星雨幣不足，快去存錢吧！',
            flags: 64
          });

        }

        const targetData =
          await getUser(targetId);

        await updateCoins(
          userId,
          senderData.coins - amount
        );

        await updateCoins(
          targetId,
          targetData.coins + amount
        );

        await addTransferRecord(
          userId,
          targetId,
          amount
        );

        return interaction.reply({
          content:
`✅ 已轉帳 100 星雨幣給 <@${targetId}>`,
          flags: 64
        });

      }

      // 取消轉帳
      if (
        interaction.customId ===
        'cancel_transfer'
      ) {

        return interaction.reply({
          content:
            '❌ 您已取消轉帳',
          flags: 64
        });

      }

      // 領取掉落
      if (
        interaction.customId.startsWith(
          'claim_'
        )
      ) {

        const reward =
          parseInt(
            interaction.customId.replace(
              'claim_',
              ''
            )
          );

        const userId =
          interaction.user.id;

        const userData =
          await getUser(userId);

        const newCoins =
          userData.coins + reward;

        await updateCoins(
          userId,
          newCoins
        );

        return interaction.reply({
          content:
`☔ 你領取了 ${reward} 星雨幣！`,
          flags: 64
        });

      }

    }

    // ===== User Select =====
    if (interaction.isUserSelectMenu()) {

      if (
        interaction.customId ===
        'select_transfer_user'
      ) {

        const targetId =
          interaction.values[0];

        const confirmButton =
          new ButtonBuilder()
            .setCustomId(
              `confirm_transfer_${targetId}`
            )
            .setLabel('✅ 確認轉帳 100')
            .setStyle(ButtonStyle.Success);

        const cancelButton =
          new ButtonBuilder()
            .setCustomId(
              'cancel_transfer'
            )
            .setLabel('❌ 取消')
            .setStyle(ButtonStyle.Danger);

        const row =
          new ActionRowBuilder()
            .addComponents(
              confirmButton,
              cancelButton
            );

        return interaction.reply({
          content:
`💸 確定轉帳 100 星雨幣給 <@${targetId}>？`,
          components: [row],
          flags: 64
        });

      }

    }

    // ===== Slash 指令 =====
    if (interaction.isChatInputCommand()) {

      const userId =
        interaction.user.id;

      // /ping
      if (
        interaction.commandName === 'ping'
      ) {

        return interaction.reply(
          'Pong!'
        );

      }

      // /錢包
      if (
        interaction.commandName === '錢包'
      ) {

        const userData =
          await getUser(userId);

        return interaction.reply({
          content:
`💰 你目前有 ${userData.coins} 星雨幣`,
          flags: 64
        });

      }


      // /簽到
      if (
        interaction.commandName === '簽到'
      ) {

        const userData =
        await getUser(userId);

        const today =
          new Date().toDateString();

        // 已簽到
        if (
          userData.last_checkin === today
        ) {

          return interaction.reply({
            content:
              '❌ 今天已經簽到過了',
            flags: 64
          });

       }

        const newCoins =
          userData.coins + 10;

        await updateCoins(
          userId,
          newCoins
        );

        await updateCheckin(
          userId,
          today
        );

        return interaction.reply({
          content:
      `☔ 簽到成功！

      獲得 100 星雨幣`,
          flags: 64
        });

        }

      // /排行榜
      if (
        interaction.commandName === '排行榜'
      ) {

        const { data, error } =
         await supabase
            .from('users')
            .select('*')
            .order('coins', {
              ascending: false
            });

        if (error) {

          console.log(error);

          return interaction.reply({
            content:
              '❌ 排行榜讀取失敗',
            flags: 64
          });

        }

        if (!data || data.length === 0) {

          return interaction.reply({
           content:
              '目前還沒有排行榜資料',
            flags: 64
          });

        }

        let text =
       `🏆 星雨排行榜

       `;

        data
          .slice(0, 10)
          .forEach((user, index) => {

            text +=
      `${index + 1}. <@${user.user_id}>
      💰 ${user.coins} 星雨幣

      `;

          });

      return interaction.reply({
        content: text
      });

      }

    // /轉帳 
    if (
      interaction.commandName === '轉帳'
    ) {

      const target =
        interaction.options.getUser('玩家');

      const amount =
        interaction.options.getInteger('金額');

      // 不能轉自己
      if (target.id === userId) {

        return interaction.reply({
          content:
            '❌ 不能轉帳給自己',
          flags: 64
        });

      }

      // 金額錯誤
      if (amount <= 0) {

        return interaction.reply({
          content:
            '❌ 金額錯誤',
          flags: 64
        });

      }

      const senderData =
        await getUser(userId);

      // 餘額不足
      if (senderData.coins < amount) {

        return interaction.reply({
          content:
            '❌ 星雨幣不足',
          flags: 64
        });

      }

      const targetData =
        await getUser(target.id);

      // 扣款
      await updateCoins(
        userId,
        senderData.coins - amount
      );

      // 加款
      await updateCoins(
        target.id,
        targetData.coins + amount
      );

      // 紀錄交易
       await addTransferRecord(
         userId,
         target.id,
         amount
       );


       return interaction.reply({
         content:
       `💸 轉帳成功！

       給了 <@${target.id}>
       ${amount} 星雨幣`,
         flags: 64
       });

      }

    // /交易紀錄
    if (
      interaction.commandName === '交易紀錄'
    ) {

      const { data, error } =
        await supabase
          .from('transfers')
          .select('*')
          .or(
    `sender_id.eq.${userId},receiver_id.eq.${userId}`
          )
          .order('created_at', {
            ascending: false
          })
          .limit(10);

      if (error) {

        console.log(error);

        return interaction.reply({
          content:
            '❌ 讀取失敗',
          flags: 64
        });

      }

      if (!data || data.length === 0) {

        return interaction.reply({
          content:
            '目前沒有交易紀錄',
          flags: 64
        });

      }

      let text =
    `📜 最近交易紀錄

    `;

      data.forEach(record => {

        const type =
          record.sender_id === userId
            ? '📤 匯出'
            : '📥 收入';

        const target =
          record.sender_id === userId
            ? record.receiver_id
            : record.sender_id;

        text +=
    `${type} 
    對象：<@${target}>
    金額：${record.amount} 星雨幣

    `;

      });

      return interaction.reply({
        content: text,
        flags: 64
      });

      }

    // /給予
    if (
      interaction.commandName === '給予'
    ) {

      // 只有群主可用
      if (
        interaction.guild.ownerId !==
        interaction.user.id
      ) {

        return interaction.reply({
      content:
            '❌ 只有群組擁有者可以使用',
          flags: 64
        });

      }

  const target =
    interaction.options.getUser('玩家');

  const amount =
    interaction.options.getInteger('金額');

  // 金額錯誤
  if (amount <= 0) {

    return interaction.reply({
      content:
        '❌ 金額錯誤',
      flags: 64
    });

  }

  const targetData =
    await getUser(target.id);

  const newCoins =
    targetData.coins + amount;

  await updateCoins(
    target.id,
    newCoins
  );

  return interaction.reply({
    content:
`✅ 已給予 <@${target.id}>

${amount} 星雨幣`,
    flags: 64
  });

  }

// /扣除
if (
  interaction.commandName === '扣除'
) {

  // 只有群主可用
  if (
    interaction.guild.ownerId !==
    interaction.user.id
  ) {

    return interaction.reply({
      content:
        '❌ 只有群組擁有者可以使用',
      flags: 64
    });

  }

  const target =
    interaction.options.getUser('玩家');

  const amount =
    interaction.options.getInteger('金額');

  // 金額錯誤
  if (amount <= 0) {

    return interaction.reply({
      content:
        '❌ 金額錯誤',
      flags: 64
    });

  }

  const targetData =
    await getUser(target.id);

  let newCoins =
    targetData.coins - amount;

  // 不可負數
  if (newCoins < 0) {

    newCoins = 0;

  }

  await updateCoins(
    target.id,
    newCoins
  );

  return interaction.reply({
    content:
`❌ 已扣除 <@${target.id}>

${amount} 星雨幣`,
    flags: 64
  });

  }

 }
 
});


// ===== 聊天掉落星雨幣 =====

client.on(
  'messageCreate',
  async message => {

    // Bot 不觸發
    if (message.author.bot) return;

    // 隨機機率
    const random =
      Math.floor(
        Math.random() * 100
      );

    // 5% 機率掉落
    if (random < 5) {

      const reward =
        Math.floor(
          Math.random() * 50
        ) + 1;

      const button =
        new ButtonBuilder()
          .setCustomId(
            `claim_${reward}`
          )
          .setLabel('☔ 領取星雨幣')
          .setStyle(
            ButtonStyle.Success
          );

      const row =
        new ActionRowBuilder()
          .addComponents(button);

      await message.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor('#57F287')
            .setTitle('☔ 星雨幣掉落')
            .setDescription(
`有人掉了 ${reward} 星雨幣！

快點擊下方按鈕領取 ✨`
            )
        ],
        components: [row]
      });

    }

  }

);

client.login(process.env.TOKEN);
