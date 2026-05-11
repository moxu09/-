require('dotenv').config();

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
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  REST,
  Routes
} = require('discord.js');


// ===== Supabase =====

const supabase =
  createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );


// ===== Discord Client =====

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ===== 掉落鎖定 =====

const claimedDrops =
  new Set();

// ===== 轉帳冷卻 =====

const transferCooldown =
  new Map();

// ===== Function 區 =====

// 讀取玩家資料
async function getUser(userId) {

  const { data, error } =
    await supabase
      .from('users')
      .select('*')
      .eq('user_id', userId)
      .single();

  if (error && error.code !== 'PGRST116') {
    console.error(error);
  }

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
      coins: 0,
      last_checkin: null
    };

  }

  return data;

}


// 更新金額
async function updateCoins(
  userId,
  coins
) {

  const { error } = 
    await supabase
      .from('users')
      .update({
        coins: coins
      })
      .eq('user_id', userId);

  if (error) {
    console.error('更新金額失敗:', error);
    throw new Error('無法更新金額');
  }

}


// 更新簽到
async function updateCheckin(
  userId,
  date
) {

  const { error } = 
    await supabase
      .from('users')
      .update({
        last_checkin: date
      })
      .eq('user_id', userId);

  if (error) {
    console.error('更新簽到失敗:', error);
    throw new Error('無法更新簽到');
  }

}


// 新增交易紀錄
async function addTransferRecord(
  senderId,
  receiverId,
  amount
) {

  const { error } = 
    await supabase
      .from('transfers')
      .insert([
        {
          sender_id: senderId,
          receiver_id: receiverId,
          amount: amount
        }
      ]);

  if (error) {
    console.error('新增交易紀錄失敗:', error);
    throw new Error('無法記錄交易');
  }

}


// 錯誤回覆
async function replyError(
  interaction,
  message
) {

  return await interaction.reply({
    content: `❌ ${message}`,
    flags: 64
  });

}

// 查詢玩家排名
async function getUserRank(
  userId
) {

  const { data, error } =
    await supabase
      .from('users')
      .select('*')
      .order('coins', {
        ascending: false
      });

  if (error) {

    console.error(error);

    return null;

  }

  const rank =
    data.findIndex(

      user =>

        user.user_id ===
        userId

    ) + 1;

  return rank;

}


// 查詢交易紀錄
async function getTransferRecords(
  userId
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

    console.error(error);

    return [];

  }

  return data;

}

// ===== 安全轉帳函數 (完整驗證) =====

async function safeTransfer(
  senderId,
  receiverId,
  amount
) {

  try {
    // 1. 驗證金額
    if (isNaN(amount) || amount <= 0) {
      throw new Error('金額無效');
    }

    if (amount > 10000) {
      throw new Error('單次轉帳不能超過 10000');
    }

    // 2. 確認不是轉給自己
    if (senderId === receiverId) {
      throw new Error('不能轉給自己');
    }

    // 3. 獲取發送者資料
    const senderData = await getUser(senderId);
    if (!senderData) {
      throw new Error('發送者不存在');
    }

    // 4. 驗證餘額
    if (senderData.coins < amount) {
      throw new Error('星雨幣不足');
    }

    // 5. 獲取接收者資料
    const receiverData = await getUser(receiverId);
    if (!receiverData) {
      throw new Error('接收者不存在');
    }

    // 6. 計算新金額 (先驗證計算無誤)
    const newSenderCoins = senderData.coins - amount;
    const newReceiverCoins = receiverData.coins + amount;

    if (newSenderCoins < 0) {
      throw new Error('計算錯誤：發送者金額無效');
    }

    // 7. 執行扣款
    console.log(`[轉帳] 扣款：${senderId} -${amount}`);
    await updateCoins(senderId, newSenderCoins);

    // 8. 執行加款
    console.log(`[轉帳] 加款：${receiverId} +${amount}`);
    await updateCoins(receiverId, newReceiverCoins);

    // 9. 記錄交易
    console.log(`[轉帳] 記錄：${senderId} -> ${receiverId} ${amount}`);
    await addTransferRecord(senderId, receiverId, amount);

    console.log(`[轉帳] 成功：${senderId} -> ${receiverId} ${amount}星雨幣`);

    return {
      success: true,
      senderNewCoins: newSenderCoins,
      receiverNewCoins: newReceiverCoins
    };

  } catch (error) {
    console.error('[轉帳] 失敗:', error.message);
    throw error;
  }

}

// ===== Slash Commands =====

const commands = [

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
    .setDescription('查看最近交易')

].map(command => command.toJSON());

const rest =
  new REST({ version: '10' })
    .setToken(process.env.TOKEN);

(async () => {

  try {

    console.log('開始註冊 Slash Commands');

    await rest.put(

      Routes.applicationCommands(
        process.env.CLIENT_ID
      ),

      { body: commands }

    );

    console.log('Slash Commands 註冊成功');

  } catch (error) {

    console.error(error);

  }

})();

// ===== Bot Ready =====

client.once(
  Events.ClientReady,
  async () => {

    console.log('Bot 已上線');

    // ===== ATM 頻道 =====

    const atmChannel =
      await client.channels.fetch(
        process.env.CHANNEL_ID
      );

    // 刪除舊 ATM 訊息
    const oldMessages =
      await atmChannel.messages.fetch({
        limit: 20
      });

    const oldATM =
      oldMessages.filter(
        msg =>
          msg.author.id === client.user.id &&
          msg.embeds.length > 0 &&
          msg.embeds[0].title ===
            '🏦 星雨銀行 ATM'
      );

    for (const msg of oldATM.values()) {
      await msg.delete().catch(() => {});
    }

    // ATM 按鈕
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

    // ATM Embed
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
🟢 線上 星雨幣 已啟用`
        )

        .setImage(
'https://cdn.discordapp.com/attachments/1501098193276895360/1503008880513253406/ChatGPT_Image_2026510_08_19_56.png?ex=6a01c999&is=6a007819&hm=6c10e8db7f2f31aa3991255cf8270280d58aa3ec5da616a7adb64[...]
        )

        .setFooter({
          text: 'Rain Bank ATM System'
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

    // 刪除舊簽到訊息
    const oldCheckinMessages =
      await checkinChannel.messages.fetch({
        limit: 20
      });

    const oldCheckin =
      oldCheckinMessages.filter(
        msg =>
          msg.author.id === client.user.id &&
          msg.embeds.length > 0 &&
          msg.embeds[0].title ===
            '☔ 每日簽到'
      );

    for (const msg of oldCheckin.values()) {
      await msg.delete().catch(() => {});
    }

    // 簽到按鈕
    const checkinButton =
      new ButtonBuilder()
        .setCustomId('daily_checkin')
        .setLabel('☔ 每日簽到')
        .setStyle(ButtonStyle.Primary);

    const checkinRow =
      new ActionRowBuilder()
        .addComponents(checkinButton);

    // 簽到 Embed
    const checkinEmbed =
      new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('☔ 每日簽到')
        .setDescription(
`每天都可以來領一次 10 枚星雨幣 ✨`
        );

    await checkinChannel.send({
      embeds: [checkinEmbed],
      components: [checkinRow]
    });

  }

);


// ===== Interaction =====

client.on(
  Events.InteractionCreate,
  async interaction => {

    try {

      // ===== Button =====

      if (interaction.isButton()) {

        // ===== 餘額查詢 =====

        if (
          interaction.customId ===
          'check_coins'
        ) {

          const userData =
            await getUser(
              interaction.user.id
            );

          return await interaction.reply({
            content:
`💰 你目前有 ${userData.coins} 星雨幣`,
            flags: 64
          });

        }


        // ===== 每日簽到 =====

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

          // 今天已簽到
          if (
            userData.last_checkin === today
          ) {

            return replyError(
              interaction,
              '今天已經簽到過了'
            );

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


        // ===== 開啟轉帳 =====

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


        // ===== 領取掉落 =====

        if (
          interaction.customId.startsWith(
            'claim_'
          )
        ) {

          // 已被領取
          if (
            claimedDrops.has(
              interaction.message.id
            )
          ) {

            return replyError(
              interaction,
              '這個掉落已經被搶走了'
            );

          }

          // 鎖定掉落
          claimedDrops.add(
            interaction.message.id
          );

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

          // 更新金額
          await updateCoins(
            userId,
            newCoins
          );

          // 禁用按鈕
          const disabledButton =
            new ButtonBuilder()
              .setCustomId(
                interaction.customId
              )
              .setLabel(
                '☔ 已被領取'
              )
              .setStyle(
                ButtonStyle.Secondary
              )
              .setDisabled(true);

          const disabledRow =
            new ActionRowBuilder()
              .addComponents(
                disabledButton
              );

          // 修改原訊息
          await interaction.update({

            embeds: [
              new EmbedBuilder()
                .setColor('#808080')
                .setTitle(
                  '☔ 星雨幣已被領取'
                )
                .setDescription(
`${interaction.user} 搶到了 ${reward} 星雨幣！`
                )
            ],

            components: [
              disabledRow
            ]

          });

          return;

        }

      }


      // ===== User Select =====

      if (
        interaction.isUserSelectMenu()
      ) {

        if (
          interaction.customId ===
          'select_transfer_user'
        ) {

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
              .setCustomId(
                'transfer_amount'
              )
              .setLabel(
                '輸入轉帳金額'
              )
              .setStyle(
                TextInputStyle.Short
              )
              .setPlaceholder(
                '例如：100'
              )
              .setRequired(true);

          const row =
            new ActionRowBuilder()
              .addComponents(
                amountInput
              );

          modal.addComponents(row);

          await interaction.showModal(
            modal
          );

          return;

        }

      }


      // ===== Modal =====

      if (
        interaction.isModalSubmit()
      ) {

        if (
          interaction.customId.startsWith(
            'transfer_modal_'
          )
        ) {

          const modalTargetId =
            interaction.customId.replace(
              'transfer_modal_',
              ''
            );

          const amount =
            parseInt(
              interaction.fields.getTextInputValue(
                'transfer_amount'
              )
            );

          const userId =
            interaction.user.id;

          // 轉帳冷卻 - 修復版本
          if (transferCooldown.has(userId)) {
            const cooldownTime = transferCooldown.get(userId);
            const remainingTime = Math.ceil((cooldownTime - Date.now()) / 1000);
            
            return replyError(
              interaction,
              `轉帳太快了，請在 ${remainingTime} 秒後再試`
            );
          }

          try {
            // 使用安全轉帳函數 (完整驗證 + 錯誤檢查)
            const result = await safeTransfer(
              userId,
              modalTargetId,
              amount
            );

            // 轉帳成功才設置冷卻
            transferCooldown.set(userId, Date.now() + 15000);
            
            // 15 秒後移除冷卻
            setTimeout(() => {
              transferCooldown.delete(userId);
            }, 15000);

            return interaction.reply({
              content:
`✅ 成功轉帳 ${amount} 星雨幣給 <@${modalTargetId}>`,
              flags: 64
            });

          } catch (transferError) {
            console.error('[轉帳] 使用者互動失敗:', transferError.message);
            return replyError(
              interaction,
              transferError.message
            );
          }

        }

      }


      // ===== Slash Command =====

      if (
        interaction.isChatInputCommand()
      ) {

        // ===== /ping =====

        if (
          interaction.commandName ===
          'ping'
        ) {

          return interaction.reply(
            'Pong!'
          );

        }
        

        
        // ===== /排名 =====

        if (
          interaction.commandName ===
          '我的排名'
        ) {

          const userId =
            interaction.user.id;

          const userData =
            await getUser(userId);

          const rank =
            await getUserRank(userId);

          return interaction.reply({

            embeds: [

              new EmbedBuilder()
                .setColor('#FFD700')
                .setTitle('🏆 星雨排名')
                .setDescription(

`你的目前排名：

🥇 第 ${rank} 名
💰 ${userData.coins} 星雨幣`

                )

            ],

            flags: 64

          });

        }

        // ===== /給予 =====

        if (
          interaction.commandName ===
          '發錢'
        ) {

          // 限群主
          if (
            interaction.guild.ownerId !==
            interaction.user.id
          ) {

            return replyError(
              interaction,
              '只有群主可以使用'
            );

          }

          const target =
            interaction.options.getUser(
              '玩家'
            );

          const amount =
            interaction.options.getInteger(
              '金額'
            );

          if (
            isNaN(amount) ||
            amount <= 0
          ) {

            return replyError(
              interaction,
              '金額錯誤'
            );

          }

          const targetData =
            await getUser(target.id);

          await updateCoins(
            target.id,
            targetData.coins + amount
          );

          return interaction.reply({
            content:
`✅ 已給予 <@${target.id}> ${amount} 星雨幣`,
            flags: 64
          });

        }


        // ===== /扣除 =====

        if (
          interaction.commandName ===
          '扣錢'
        ) {

          // 限群主
          if (
            interaction.guild.ownerId !==
            interaction.user.id
          ) {

            return replyError(
              interaction,
              '只有群主可以使用'
            );

          }

          const target =
            interaction.options.getUser(
              '玩家'
            );

          const amount =
            interaction.options.getInteger(
              '金額'
            );

          if (
            isNaN(amount) ||
            amount <= 0
          ) {

            return replyError(
              interaction,
              '金額錯誤'
            );

          }

          const targetData =
            await getUser(target.id);

          let newCoins =
            targetData.coins - amount;

          if (newCoins < 0) {
            newCoins = 0;
          }

          await updateCoins(
            target.id,
            newCoins
          );

          return interaction.reply({
            content:
`❌ 已扣除 <@${target.id}> ${amount} 星雨幣`,
            flags: 64
          });

        }


        // ===== /交易紀錄 =====

        if (
          interaction.commandName ===
          '交易紀錄'
        ) {

          const records =
            await getTransferRecords(
              interaction.user.id
            );

          if (
            records.length === 0
          ) {

            return interaction.reply({

              content:
                '目前沒有交易紀錄',

              flags: 64

            });

          }

          const text =
            records.map(record => {

              return`💸 <@${record.sender_id}>
➡️ <@${record.receiver_id}>
💰 ${record.amount} 星雨幣`;

            }).join('\n\n');

          return interaction.reply({

            embeds: [

              new EmbedBuilder()
                .setColor('#00ffff')
                .setTitle(
                  '📜 最近交易紀錄'
                )
                .setDescription(text)

            ],

            flags: 64

          });

        }

      }

    } catch (err) {

      console.error(err);

      if (
        interaction.isRepliable()
      ) {

        if (
          interaction.replied ||
          interaction.deferred
        ) {

          await interaction.followUp({

            content:
              '❌ 系統發生錯誤',

            flags: 64

          }).catch(() => {});

        } else {

          await interaction.reply({

            content:
              '❌ 系統發生錯誤',

            flags: 64

          }).catch(() => {});

        }

      }

    }

  }

);


// ===== 聊天掉落 =====

client.on(
  'messageCreate',
  async message => {

    // Bot 不觸發
    if (message.author.bot) return;

    // 5% 機率
    const random =
      Math.floor(
        Math.random() * 100
      );

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
          .setLabel(
            '☔ 領取星雨幣'
          )
          .setStyle(
            ButtonStyle.Success
          );

      const row =
        new ActionRowBuilder()
          .addComponents(button);

      const embed =
        new EmbedBuilder()
          .setColor('#57F287')
          .setTitle('☔ 星雨幣掉落')
          .setDescription(
`有人掉了 ${reward} 星雨幣！

快點擊下方按鈕領取 ✨`
          );

      await message.channel.send({
        embeds: [embed],
        components: [row]
      });

    }

  }

);


// ===== Login =====

client.login(process.env.TOKEN);
