const {
  ActionRowBuilder,
  ButtonBuilder,
  ModalBuilder,
  TextInputBuilder,
  ButtonStyle,
  TextInputStyle,
  UserSelectMenuBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits
} = require('discord.js');
const fs = require('fs');

const config = require('../config/config');
const { replyError, replySuccess, getTodayDateString } = require('../utils/helpers');
const { isAdmin } = require('../utils/validation');

// ===== 全域變數 =====
let supabase;
let client;

const claimedDrops = new Set();

// ===== 設置 supabase 和 client =====
function setup(supabaseInstance, clientInstance) {
  supabase = supabaseInstance;
  client = clientInstance;
}

// ===== 安全延遲回覆 =====
async function safeDefer(interaction, options = {}) {
  try {
    if (interaction.replied || interaction.deferred) {
      return false;
    }
    await interaction.deferReply(options);
    return true;
  } catch (error) {
    console.error('[延遲回覆錯誤]', error);
    return false;
  }
}

// ===== 主事件處理 =====
async function setupInteractionEvent(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
      return;
    }

    if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
      return;
    }

    if (interaction.isUserSelectMenu()) {
      await handleUserSelectInteraction(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      await handleStringSelectInteraction(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
      return;
    }
  } catch (error) {
    console.error('[互動錯誤]', error);
    await handleError(interaction);
  }
}

// ===== 斜杠命令處理 =====
async function handleSlashCommand(interaction) {
  try {
    // ping
    if (interaction.commandName === 'ping') {
      return await interaction.reply('Pong!');
    }

    // 扭蛋列表
    if (interaction.commandName === '扭蛋列表') {
      const { data } = await supabase
        .from('gacha_pools')
        .select('*')
        .eq('guild_id', interaction.guild.id);

      if (!data || !data.length) {
        return await interaction.reply('目前沒有扭蛋');
      }

      const text = data
        .map((g) => `🆔 ID：${g.id}\n🎰 ${g.pool_name}\n💰 單抽價格：${g.price} 星雨幣`)
        .join('\n\n');

      return await interaction.reply({
        content: `📦 扭蛋列表\n\n${text}`,
        flags: 64
      });
    }

    // 新增卡池
    if (interaction.commandName === '新增卡池') {
      if (!isAdmin(interaction)) {
        return await replyError(interaction, '你沒有權限');
      }

      const name = interaction.options.getString('名稱');
      const price = interaction.options.getInteger('價格');

      const { error } = await supabase.from('gacha_pools').insert({
        guild_id: interaction.guild.id,
        pool_name: name,
        price
      });

      if (error) {
        console.error(error);
        return await replyError(interaction, '新增失敗');
      }

      return await interaction.reply({
        content: `✅ 已新增卡池：${name}`,
        flags: 64
      });
    }

    // 刪除扭蛋
    if (interaction.commandName === '刪除扭蛋') {
      if (!isAdmin(interaction)) {
        return await replyError(interaction, '你沒有權限');
      }

      const name = interaction.options.getString('名稱');
      const { data: pool } = await supabase
        .from('gacha_pools')
        .select('*')
        .eq('guild_id', interaction.guild.id)
        .eq('pool_name', name)
        .single();

      if (!pool) {
        return await replyError(interaction, '找不到卡池');
      }

      await supabase.from('gacha_rewards').delete().eq('pool_id', pool.id);
      await supabase.from('gacha_pools').delete().eq('id', pool.id);

      return await interaction.reply({
        content: `🗑️ 已刪除扭蛋：${name}`,
        flags: 64
      });
    }

    // 新增獎勵
    if (interaction.commandName === '新增獎勵') {
      if (!isAdmin(interaction)) {
        return await replyError(interaction, '你沒有權限');
      }

      const poolId = interaction.options.getInteger('卡池id');
      const rewardName = interaction.options.getString('名稱');
      const description = interaction.options.getString('介紹');
      const rarity = interaction.options.getString('稀有度');
      const chance = interaction.options.getNumber('機率');
      const rewardCoins = interaction.options.getInteger('星雨幣') || 0;

      if (isNaN(chance) || chance <= 0) {
        return await replyError(interaction, '機率必須大於 0');
      }

      const { error } = await supabase.from('gacha_rewards').insert({
        pool_id: poolId,
        reward_name: rewardName,
        reward_description: description,
        rarity,
        chance,
        reward_coins: rewardCoins
      });

      if (error) {
        console.error(error);
        return await replyError(interaction, '新增失敗');
      }

      return await interaction.reply({
        content: `✅ 已新增獎勵：${rewardName}`,
        flags: 64
      });
    }

    // 刪除獎勵
    if (interaction.commandName === '刪除獎勵') {
      if (!isAdmin(interaction)) {
        return await replyError(interaction, '你沒有權限');
      }

      const poolId = interaction.options.getInteger('卡池id');
      const rewardName = interaction.options.getString('名稱');

      const { error } = await supabase
        .from('gacha_rewards')
        .delete()
        .eq('pool_id', poolId)
        .eq('reward_name', rewardName);

      if (error) {
        console.error(error);
        return await replyError(interaction, '刪除失敗');
      }

      return await interaction.reply({
        content: `🗑️ 已刪除獎勵：${rewardName}`,
        flags: 64
      });
    }

    // 我的排名
    if (interaction.commandName === '我的排名') {
      const userData = await getUser(interaction.user.id);
      const rank = await getUserRank(interaction.user.id);

      return await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('🏆 星雨排名')
            .setDescription(`🥇 排名：第 ${rank} 名\n💰 星雨幣：${userData.coins}`)
        ],
        flags: 64
      });
    }

    // 交易紀錄
    if (interaction.commandName === '交易紀錄') {
      const records = await getTransferRecords(interaction.user.id);

      if (!records || !records.length) {
        return await interaction.reply({
          content: '目前沒有交易紀錄',
          flags: 64
        });
      }

      const text = records
        .map((r) => {
          const time = new Date(r.created_at).toLocaleString('zh-TW', { hour12: false });
          return `💸 <@${r.sender_id}> ➜ <@${r.receiver_id}>\n💰 ${r.amount} 星雨幣\n🕒 ${time}`;
        })
        .join('\n\n');

      return await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor('#00ffff')
            .setTitle('📜 最近交易紀錄')
            .setDescription(text)
        ],
        flags: 64
      });
    }

    // 發錢
    if (interaction.commandName === '發錢') {
      if (interaction.guild.ownerId !== interaction.user.id) {
        return await interaction.reply({
          content: '❌ 只有群主可以使用',
          flags: 64
        });
      }

      const target = interaction.options.getUser('玩家');
      const amount = interaction.options.getInteger('金額');

      if (isNaN(amount) || amount <= 0) {
        return await replyError(interaction, '金額錯誤');
      }

      const targetData = await getUser(target.id);
      const finalCoins = targetData.coins + amount;
      await updateCoins(target.id, finalCoins);
      await sendWalletLog(target.id, '儲值', amount, finalCoins, '💳 儲值成功');

      return await interaction.reply({
        content: `✅ 已給予 <@${target.id}> ${amount} 星雨幣`,
        flags: 64
      });
    }

    // 扣錢
    if (interaction.commandName === '扣錢') {
      if (interaction.guild.ownerId !== interaction.user.id) {
        return await interaction.reply({
          content: '❌ 只有群主可以使用',
          flags: 64
        });
      }

      const target = interaction.options.getUser('玩家');
      const amount = interaction.options.getInteger('金額');

      if (isNaN(amount) || amount <= 0) {
        return await replyError(interaction, '金額錯誤');
      }

      const targetData = await getUser(target.id);
      const finalCoins = Math.max(0, targetData.coins - amount);
      await updateCoins(target.id, finalCoins);

      return await interaction.reply({
        content: `❌ 已扣除 <@${target.id}> ${amount} 星雨幣`,
        flags: 64
      });
    }

    // 新增商品
    if (interaction.commandName === '新增商品') {
      if (!isAdmin(interaction)) {
        return await replyError(interaction, '你沒有權限');
      }

      const itemName = interaction.options.getString('名稱');
      const price = interaction.options.getInteger('價格');
      const description = interaction.options.getString('介紹');

      await addShopItem(itemName, price, description);
      await refreshShop(client);

      return await interaction.reply({
        content: `✅ 已新增商品：${itemName}`,
        flags: 64
      });
    }

    // 刪除商品
    if (interaction.commandName === '刪除商品') {
      if (!isAdmin(interaction)) {
        return await replyError(interaction, '你沒有權限');
      }

      const itemId = interaction.options.getInteger('商品id');
      await removeShopItem(itemId);
      await refreshShop(client);

      return await interaction.reply({
        content: `🗑️ 已刪除商品 ID: ${itemId}`,
        flags: 64
      });
    }

    // 我的商品
    if (interaction.commandName === '我的商品') {
      const items = await getUserItems(interaction.user.id);

      if (!items || !items.length) {
        return await interaction.reply({
          content: '📦 你目前沒有商品',
          flags: 64
        });
      }

      const rarityOrder = ['SSR', 'SR', 'R'];
      let text = '';

      for (const rarity of rarityOrder) {
        const filtered = items.filter((item) => item.rarity === rarity);
        if (filtered.length === 0) continue;

        text += `\n${getRarityEmoji(rarity)} ${rarity}\n`;
        for (const item of filtered) {
          text += `• ${item.item_name}`;
          if (item.description) {
            text += `\n└ 📦 ${item.description}`;
          }
          text += '\n';
        }
      }

      const normalItems = items.filter((item) => !item.rarity);
      if (normalItems.length > 0) {
        text += `\n🛒 一般商品\n`;
        for (const item of normalItems) {
          text += `• ${item.item_name}`;
          if (item.description) {
            text += `\n└ 📦 ${item.description}`;
          }
          if (item.item_type) {
            text += `\n└ 🏷️ 類型：${item.item_type}`;
          }
          if (item.created_at) {
            const date = new Date(item.created_at).toLocaleString('zh-TW');
            text += `\n└ 🕒 ${date}`;
          }
          text += '\n';
        }
      }

      return await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor('#ff66cc')
            .setTitle('🎒 分類背包')
            .setDescription(text)
        ],
        flags: 64
      });
    }
  } catch (error) {
    console.error('[斜杠命令錯誤]', error);
    await handleError(interaction);
  }
}

// ===== 按鈕交互處理 =====
async function handleButtonInteraction(interaction) {
  const customId = interaction.customId;

  try {
    // ===== 使用優惠券 =====
    if (customId === 'use_coupon') {
      const coupons = await getUserItems(interaction.user.id);
      const coupon = coupons.find((item) => item.item_type === 'coupon');

      if (!coupon) {
        return await replyError(interaction, '你沒有優惠券');
      }

      await removeUserItem(coupon.id);

      return await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor('#57F287')
            .setTitle('✅ 已使用優惠券')
            .setDescription(`${coupon.item_name}\n\n優惠券已扣除`)
        ]
      });
    }

    // ===== 不使用優惠券 =====
    if (customId === 'skip_coupon') {
      return await replySuccess(interaction, '已略過優惠券');
    }

    // ===== 完成訂單 =====
    if (customId === 'complete_order') {
      const isOwner = interaction.guild.ownerId === interaction.user.id;
      const isAdminUser = interaction.member.permissions.has('Administrator');
      const hasRole = interaction.member.roles.cache.has(config.roles.staff);

      if (!isOwner && !isAdminUser && !hasRole) {
        return await replyError(interaction, '只有客服人員能關閉');
      }

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('save_order_log')
            .setLabel('📁 儲存紀錄')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('delete_order_now')
            .setLabel('🗑️ 不儲存')
            .setStyle(ButtonStyle.Danger)
        );

      return await interaction.reply({
        content: '📦 是否儲存此訂單紀錄？',
        components: [row]
      });
    }

    // ===== 儲存訂單紀錄 =====
    if (customId === 'save_order_log') {
      await interaction.deferReply({ flags: 64 });

      try {
        const messages = await interaction.channel.messages.fetch({ limit: 100 });
        const sorted = [...messages.values()].sort(
          (a, b) => a.createdTimestamp - b.createdTimestamp
        );

        let html = `
        <html>
        <head>
          <meta charset="UTF-8">
          <style>
          body { background: #2b2d31; color: white; font-family: sans-serif; padding: 20px; }
          .message { background: #1e1f22; padding: 10px; border-radius: 10px; margin-bottom: 10px; }
          .user { color: #ff66cc; font-weight: bold; }
          .time { color: gray; font-size: 12px; margin-bottom: 5px; }
          </style>
        </head>
        <body>
        <h1>📦 ${interaction.channel.name}</h1>
        `;

        for (const msg of sorted) {
          html += `
          <div class="message">
            <div class="user">${msg.author.tag}</div>
            <div class="time">${new Date(msg.createdTimestamp).toLocaleString()}</div>
            <div>${msg.content || '(無內容)'}</div>
          </div>
          `;
        }

        html += `</body></html>`;

        const fileName = `order-${interaction.channel.id}.html`;
        fs.writeFileSync(`./${fileName}`, html);

        const logChannel = interaction.guild.channels.cache.get(config.channels.order);
        if (logChannel) {
          await logChannel.send({
            content: `📁 ${interaction.channel.name} 訂單紀錄`,
            files: [`./${fileName}`]
          });
        }

        fs.unlinkSync(`./${fileName}`);

        await interaction.editReply({
          content: '✅ 已儲存紀錄\n10 秒後刪除頻道'
        });

        setTimeout(async () => {
          await interaction.channel.delete().catch(() => {});
        }, 10000);
      } catch (error) {
        console.error('[儲存訂單紀錄錯誤]', error);
        await interaction.editReply({ content: '❌ 儲存失敗' });
      }
    }

    // ===== 不儲存訂單 =====
    if (customId === 'delete_order_now') {
      await interaction.reply({
        content: '🗑️ 此頻道將在 10 秒後刪除'
      });

      setTimeout(async () => {
        await interaction.channel.delete().catch(() => {});
      }, 10000);
    }

    // ===== 完成儲值 =====
    if (customId === 'complete_topup') {
      const isOwner = interaction.guild.ownerId === interaction.user.id;
      const isAdminUser = interaction.member.permissions.has('Administrator');
      const hasRole = interaction.member.roles.cache.has(config.roles.staff);

      if (!isOwner && !isAdminUser && !hasRole) {
        return await replyError(interaction, '只有客服人員能關閉');
      }

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('save_topup_log')
            .setLabel('📁 儲存紀錄')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('delete_topup_now')
            .setLabel('🗑️ 不儲存')
            .setStyle(ButtonStyle.Danger)
        );

      return await interaction.reply({
        content: '📦 是否儲存此儲值紀錄？',
        components: [row]
      });
    }

    // ===== 儲存儲值紀錄 =====
    if (customId === 'save_topup_log') {
      await interaction.deferReply({ flags: 64 });

      try {
        const messages = await interaction.channel.messages.fetch({ limit: 100 });
        const sorted = [...messages.values()].sort(
          (a, b) => a.createdTimestamp - b.createdTimestamp
        );

        let html = `
        <html>
        <head>
          <meta charset="UTF-8">
          <style>
          body { background: #2b2d31; color: white; font-family: sans-serif; padding: 20px; }
          </style>
        </head>
        <body>
        <h1>💳 ${interaction.channel.name}</h1>
        `;

        for (const msg of sorted) {
          html += `
          <div style="background:#1e1f22;padding:10px;border-radius:10px;margin-bottom:10px;">
            <div style="color:#00ccff;font-weight:bold;">${msg.author.tag}</div>
            <div style="color:gray;font-size:12px;margin-bottom:5px;">${new Date(msg.createdTimestamp).toLocaleString()}</div>
            <div>${msg.content || '(無內容)'}</div>
          </div>
          `;
        }

        html += `</body></html>`;

        const fileName = `topup-${interaction.channel.id}.html`;
        fs.writeFileSync(`./${fileName}`, html);

        const logChannel = interaction.guild.channels.cache.get(config.channels.order);
        if (logChannel) {
          await logChannel.send({
            content: `💳 ${interaction.channel.name} 儲值紀錄`,
            files: [`./${fileName}`]
          });
        }

        fs.unlinkSync(`./${fileName}`);

        await interaction.editReply({
          content: '✅ 已儲存儲值紀錄\n10 秒後刪除頻道'
        });

        setTimeout(async () => {
          await interaction.channel.delete().catch(() => {});
        }, 10000);
      } catch (error) {
        console.error('[儲存儲值紀錄錯誤]', error);
        await interaction.editReply({ content: '❌ 儲存失敗' });
      }
    }

    // ===== 不儲存儲值 =====
    if (customId === 'delete_topup_now') {
      await interaction.reply({
        content: '🗑️ 此頻道將在 10 秒後刪除'
      });

      setTimeout(async () => {
        await interaction.channel.delete().catch(() => {});
      }, 10000);
    }

    // ===== 單抽 =====
    if (customId === 'gacha_single') {
      const ok = await safeDefer(interaction, { flags: 64 });
      if (!ok) return;

      try {
        const { performGacha } = require('../services/gachaService');
        const result = await performGacha(interaction.user.id, interaction.guild.id, 1);

        const embed = new EmbedBuilder()
          .setColor('#ff66cc')
          .setTitle('🎰 單抽結果')
          .setDescription(
            `👤 玩家：${interaction.user}\n\n` +
            `🎉 獲得：${result.results[0].name}\n` +
            `✨ 稀有度：${result.results[0].rarity}\n\n` +
            `💰 星雨幣：${result.results[0].coins}\n\n` +
            `📦 ${result.results[0].description}`
          )
          .addFields(
            { name: '💰 花費', value: `${result.totalPrice} 星雨幣`, inline: true },
            { name: '💳 剩餘', value: `${result.finalCoins} 星雨幣`, inline: true }
          );

        return await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        console.error('[單抽錯誤]', error);
        return await interaction.editReply({ content: `❌ ${error.message}` });
      }
    }

    // ===== 十抽 =====
    if (customId === 'gacha_ten') {
      const ok = await safeDefer(interaction, { flags: 64 });
      if (!ok) return;

      try {
        const { performGacha } = require('../services/gachaService');
        const result = await performGacha(interaction.user.id, interaction.guild.id, 10);

        const resultsText = result.results
          .map((r) => `🎉 ${r.name}【${r.rarity}】\n💰 ${r.coins} 星雨幣`)
          .join('\n');

        const embed = new EmbedBuilder()
          .setColor('#ffcc00')
          .setTitle('🎰 十抽結果')
          .setDescription(`👤 玩家：${interaction.user}\n\n${resultsText}`)
          .addFields(
            { name: '💰 花費', value: `${result.totalPrice} 星雨幣`, inline: true },
            { name: '💳 剩餘', value: `${result.finalCoins} 星雨幣`, inline: true },
            { name: '🎁 總獲得', value: `${result.totalRewardCoins} 星雨幣`, inline: true }
          );

        return await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        console.error('[十抽錯誤]', error);
        return await interaction.editReply({ content: `❌ ${error.message}` });
      }
    }

    // ===== 查看獎池 =====
    if (customId === 'gacha_view_pool') {
      await interaction.deferReply({ flags: 64 });

      try {
        const { data: pools } = await supabase
          .from('gacha_pools')
          .select('*')
          .eq('guild_id', interaction.guild.id);

        if (!pools || pools.length === 0) {
          return await interaction.editReply({ content: '❌ 沒有卡池' });
        }

        const pool = pools[0];
        const { data: rewards } = await supabase
          .from('gacha_rewards')
          .select('*')
          .eq('pool_id', pool.id);

        if (!rewards || rewards.length === 0) {
          return await interaction.editReply({ content: '❌ 卡池沒有獎勵' });
        }

        const text = rewards
          .map(
            (r) =>
              `🎁 ${r.reward_name}\n✨ ${r.rarity}\n🍀 機率權重：${r.chance}\n📦 ${r.reward_description}`
          )
          .join('\n\n');

        return await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor('#ff99cc')
              .setTitle(`📦 ${pool.pool_name} 獎池`)
              .setDescription(`💰 單抽價格：${pool.price} 星雨幣\n\n${text}`)
          ]
        });
      } catch (error) {
        console.error('[查看獎池錯誤]', error);
        return await interaction.editReply({ content: `❌ ${error.message}` });
      }
    }

    // ===== 餘額查詢 =====
    if (customId === 'check_coins') {
      try {
        const userData = await getUser(interaction.user.id);
        return await interaction.reply({
          content: `💰 你目前有 ${userData.coins} 星雨幣`,
          flags: 64
        });
      } catch (error) {
        console.error('[餘額查詢錯誤]', error);
        return await replyError(interaction, error.message);
      }
    }

    // ===== 每日簽到 =====
    if (customId === 'daily_checkin') {
      try {
        const userId = interaction.user.id;
        const userData = await getUser(userId);
        const today = getTodayDateString();

        if (userData.last_checkin === today) {
          return await replyError(interaction, '今天已經簽到過了');
        }

        const reward = 10;
        const newCoins = userData.coins + reward;

        await updateCoins(userId, newCoins);
        await updateCheckin(userId, today);
        await sendWalletLog(userId, '每日簽到', reward, newCoins, '📅 每日簽到獎勵');

        return await replySuccess(interaction, `簽到成功！獲得 ${reward} 星雨幣`);
      } catch (error) {
        console.error('[簽到錯誤]', error);
        return await replyError(interaction, error.message);
      }
    }

    // ===== 開啟轉帳 =====
    if (customId === 'transfer_menu') {
      const menu = new UserSelectMenuBuilder()
        .setCustomId('select_transfer_user')
        .setPlaceholder('選擇要轉帳的玩家');

      const row = new ActionRowBuilder().addComponents(menu);

      return await interaction.reply({
        content: '💸 請選擇玩家',
        components: [row],
        flags: 64
      });
    }

    // ===== 掉落領取 =====
    if (customId.startsWith('claim_')) {
      try {
        if (claimedDrops.has(interaction.message.id)) {
          return await replyError(interaction, '已經被領走了');
        }

        claimedDrops.add(interaction.message.id);

        const reward = parseInt(customId.replace('claim_', ''));

        const userData = await getUser(interaction.user.id);
        await updateCoins(interaction.user.id, userData.coins + reward);

        const button = new ButtonBuilder()
          .setCustomId(customId)
          .setLabel('☔ 已被領取')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true);

        const row = new ActionRowBuilder().addComponents(button);

        await interaction.update({
          embeds: [
            new EmbedBuilder()
              .setColor('#808080')
              .setTitle('☔ 星雨幣已被領取')
              .setDescription(`${interaction.user} 搶到了 ${reward} 星雨幣`)
          ],
          components: [row]
        });

        setTimeout(() => {
          claimedDrops.delete(interaction.message.id);
        }, 24 * 60 * 60 * 1000);
      } catch (error) {
        console.error('[掉落領取錯誤]', error);
        claimedDrops.delete(interaction.message.id);
      }
    }
  } catch (error) {
    console.error('[按鈕交互錯誤]', error);
    if (error.code === 40060) return;
    await handleError(interaction);
  }
}

// ===== 用戶選擇菜單處理 =====
async function handleUserSelectInteraction(interaction) {
  try {
    if (interaction.customId === 'select_transfer_user') {
      const targetId = interaction.values[0];

      const modal = new ModalBuilder()
        .setCustomId(`transfer_modal_${targetId}`)
        .setTitle('星雨轉帳');

      const input = new TextInputBuilder()
        .setCustomId('transfer_amount')
        .setLabel('輸入金額')
        .setPlaceholder('例如：100')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const row = new ActionRowBuilder().addComponents(input);
      modal.addComponents(row);

      return await interaction.showModal(modal);
    }
  } catch (error) {
    console.error('[用戶選擇菜單錯誤]', error);
    await handleError(interaction);
  }
}

// ===== 字符串選擇菜單處理 =====
async function handleStringSelectInteraction(interaction) {
  try {
    // ===== 訂單系統 =====
    if (interaction.customId === 'order_system_select') {
      await interaction.deferReply({ flags: 64 });

      const value = interaction.values[0];
      const ticketNumber = Date.now();
      let channelName = '';

      if (value === 'order') {
        channelName = `訂單-${interaction.user.username}-${ticketNumber}`;
      } else if (value === 'topup') {
        channelName = `儲值-${interaction.user.username}-${ticketNumber}`;
      }

      const orderChannel = await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: config.categories.order,
        permissionOverwrites: [
          {
            id: interaction.guild.roles.everyone,
            deny: [PermissionFlagsBits.ViewChannel]
          },
          {
            id: interaction.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory
            ]
          },
          {
            id: config.roles.staff,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory
            ]
          }
        ]
      });

      // ===== 點單 =====
      if (value === 'order') {
        const couponButton = new ButtonBuilder()
          .setCustomId('use_coupon')
          .setLabel('✅ 使用優惠券')
          .setStyle(ButtonStyle.Success);

        const noCouponButton = new ButtonBuilder()
          .setCustomId('skip_coupon')
          .setLabel('❌ 不使用繼續')
          .setStyle(ButtonStyle.Secondary);

        const completeButton = new ButtonBuilder()
          .setCustomId('complete_order')
          .setLabel('✅ 完成訂單（由客服關）')
          .setStyle(ButtonStyle.Primary);

        const row1 = new ActionRowBuilder().addComponents(couponButton, noCouponButton);
        const row2 = new ActionRowBuilder().addComponents(completeButton);

        const embed = new EmbedBuilder()
          .setColor('#ff66cc')
          .setTitle('🛒 訂單建立成功')
          .setDescription(`• 請問需要什麼樣的服務？\n\n• 請問是否使用優惠券呢？`);

        const supportRoleId = config.roles.staff;
        await orderChannel.send({
          content: `<@&${supportRoleId}> ${interaction.user}\n🚀 客服人員正手刀衝刺過來啦！`,
          embeds: [embed],
          components: [row1, row2]
        });
      }

      // ===== 儲值 =====
      if (value === 'topup') {
        const completeTopupButton = new ButtonBuilder()
          .setCustomId('complete_topup')
          .setLabel('✅ 已完成儲值（由客服關）')
          .setStyle(ButtonStyle.Success);

        const row = new ActionRowBuilder().addComponents(completeTopupButton);

        const embed = new EmbedBuilder()
          .setColor('#00ffff')
          .setTitle('💰 儲值申請建立成功')
          .setDescription(`請提供以下資訊\n\n• 付款方式\n• 付款金額\n• 付款截圖`);

        const supportRoleId = config.roles.staff;
        await orderChannel.send({
          content: `<@&${supportRoleId}> ${interaction.user}\n🚀 客服人員正手刀衝刺過來啦！`,
          embeds: [embed],
          components: [row]
        });
      }

      return await interaction.editReply({
        content: `✅ 已建立頻道：${orderChannel}`
      });
    }

    // ===== 商店系統 =====
    if (interaction.customId === 'shop_select') {
      try {
        const itemId = interaction.values[0];
        const items = await getShopItems();
        const item = items.find((i) => i.id === parseInt(itemId));

        if (!item) {
          return await replyError(interaction, '商品不存在');
        }

        const userData = await getUser(interaction.user.id);

        if (userData.coins < item.price) {
          return await replyError(interaction, '星雨幣不足');
        }

        await updateCoins(interaction.user.id, userData.coins - item.price);
        await addUserItem(interaction.user.id, item.item_name, null, item.description, 'shop');

        return await replySuccess(interaction, `購買成功：${item.item_name}`);
      } catch (error) {
        console.error('[商店購買錯誤]', error);
        return await replyError(interaction, error.message);
      }
    }
  } catch (error) {
    console.error('[字符串選擇菜單錯誤]', error);
    await handleError(interaction);
  }
}

// ===== 模態表單提交處理 =====
async function handleModalSubmit(interaction) {
  try {
    if (interaction.customId.startsWith('transfer_modal_')) {
      const targetId = interaction.customId.replace('transfer_modal_', '');
      const amount = parseInt(
        interaction.fields.getTextInputValue('transfer_amount')
      );

      if (isNaN(amount) || amount <= 0) {
        return await replyError(interaction, '請輸入正確金額');
      }

      try {
        await safeTransfer(interaction.user.id, targetId, amount);
        return await replySuccess(interaction, `成功轉帳 ${amount} 星雨幣`);
      } catch (error) {
        return await replyError(interaction, error.message);
      }
    }
  } catch (error) {
    console.error('[模態表單提交錯誤]', error);
    return await replyError(interaction, error.message);
  }
}

// ===== 通用錯誤處理 =====
async function handleError(interaction) {
  try {
    if (interaction.isRepliable()) {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: '❌ 系統錯誤',
          flags: 64
        }).catch(() => {});
      } else {
        await interaction.reply({
          content: '❌ 系統錯誤',
          flags: 64
        }).catch(() => {});
      }
    }
  } catch (error) {
    console.error('[錯誤處理失敗]', error);
  }
}

// ===== 輔助函數 =====
function getRarityEmoji(rarity) {
  const emojiMap = { 'SSR': '🌈', 'SR': '⭐', 'R': '🔹' };
  return emojiMap[rarity] || '📦';
}

async function getUser(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('[DB] 讀取玩家資料失敗:', error);
  }

  if (!data) {
    const { error: insertError } = await supabase
      .from('users')
      .insert([{ user_id: userId, coins: 0 }]);

    if (insertError) {
      console.error('[DB] 建立玩家失敗:', insertError);
    }

    return { user_id: userId, coins: 0, last_checkin: null };
  }

  return data;
}

async function updateCoins(userId, coins) {
  if (coins < 0) throw new Error('金額不能為負數');

  const { error } = await supabase
    .from('users')
    .update({ coins })
    .eq('user_id', userId);

  if (error) {
    console.error('[DB] 更新金額失敗:', error);
    throw new Error('無法更新金額');
  }
}

async function updateCheckin(userId, date) {
  const { error } = await supabase
    .from('users')
    .update({ last_checkin: date })
    .eq('user_id', userId);

  if (error) {
    console.error('[DB] 更新簽到失敗:', error);
    throw new Error('無法更新簽到');
  }
}

async function getUserRank(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .order('coins', { ascending: false });

  if (error) {
    console.error('[DB] 查詢排名失敗:', error);
    return null;
  }

  if (!data || data.length === 0) return null;

  const rank = data.findIndex((user) => user.user_id === userId);
  return rank === -1 ? null : rank + 1;
}

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

async function getShopItems() {
  const { data, error } = await supabase
    .from('shop_items')
    .select('*')
    .order('price', { ascending: true });

  if (error) {
    console.error('[DB] 商店讀取失敗:', error);
    return [];
  }

  return data || [];
}

async function addShopItem(itemName, price, description) {
  const { error } = await supabase
    .from('shop_items')
    .insert([{ item_name: itemName, price, description }]);

  if (error) {
    console.error('[DB] 新增商品失敗:', error);
    throw new Error('新增商品失敗');
  }
}

async function removeShopItem(itemId) {
  const { error } = await supabase
    .from('shop_items')
    .delete()
    .eq('id', itemId);

  if (error) {
    console.error('[DB] 刪除商品失敗:', error);
    throw new Error('刪除商品失敗');
  }
}

async function addUserItem(userId, itemName, rarity = null, description = null, itemType = 'shop') {
  const { error } = await supabase
    .from('user_items')
    .insert([{ user_id: userId, item_name: itemName, rarity, description, item_type: itemType }]);

  if (error) {
    console.error('[DB] 新增玩家商品失敗:', error);
    throw new Error('新增玩家商品失敗');
  }
}

async function getUserItems(userId) {
  const { data, error } = await supabase
    .from('user_items')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[DB] 讀取玩家商品失敗:', error);
    return [];
  }

  return data || [];
}

async function removeUserItem(itemId) {
  const { error } = await supabase
    .from('user_items')
    .delete()
    .eq('id', itemId);

  if (error) {
    console.error('[DB] 刪除玩家商品失敗:', error);
    throw new Error('刪除商品失敗');
  }
}

async function safeTransfer(senderId, receiverId, amount) {
  if (isNaN(amount) || amount <= 0) throw new Error('金額無效');
  if (amount > 10000) throw new Error('單次轉帳不能超過 10000');
  if (senderId === receiverId) throw new Error('不能轉給自己');

  const { error } = await supabase.rpc('transfer_coins', {
    sender_id: senderId,
    receiver_id: receiverId,
    transfer_amount: amount
  });

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

async function sendWalletLog(userId, type, amount, balance, note = '') {
  if (amount === 0 && type !== '十抽') return;

  try {
    const user = await client.users.fetch(userId);
    const embed = new EmbedBuilder()
      .setColor('#ffd700')
      .setTitle('💰 錢包異動通知')
      .addFields(
        { name: '📌 類型', value: type, inline: true },
        { name: '💵 異動金額', value: `${amount} 星雨幣`, inline: true },
        { name: '💳 目前餘額', value: `${balance} 星雨幣`, inline: true }
      )
      .setTimestamp();

    if (note) embed.setDescription(note);

    await user.send({ embeds: [embed] });
  } catch (err) {
    console.error('[錢包通知失敗]', err);
  }
}

async function refreshShop(clientInstance) {
  try {
    const shopChannel = await clientInstance.channels.fetch(config.channels.shop);
    if (!shopChannel) return;

    const items = await getShopItems();

    const messages = await shopChannel.messages.fetch({ limit: 20 });
    const oldShop = messages.filter(
      (msg) =>
        msg.author.id === clientInstance.user.id &&
        msg.embeds.length > 0 &&
        msg.embeds[0].title === '🛒 星雨商店'
    );

    for (const msg of oldShop.values()) {
      await msg.delete().catch(() => {});
    }

    let text = items.length === 0
      ? '目前商店沒有商品'
      : items.map((item, index) => `${index + 1}. ${item.item_name}\n💰 ${item.price} 星雨幣\n📦 ${item.description}`).join('\n\n');

    const embed = new EmbedBuilder()
      .setColor('#FEE75C')
      .setTitle('🛒 星雨商店')
      .setDescription(text);

    let components = [];
    if (items.length > 0) {
      const menu = new StringSelectMenuBuilder()
        .setCustomId('shop_select')
        .setPlaceholder('選擇要購買的商品')
        .addOptions(items.map((item) => ({
          label: item.item_name,
          description: `${item.price} 星雨幣`,
          value: String(item.id)
        })));

      components.push(new ActionRowBuilder().addComponents(menu));
    }

    await shopChannel.send({ embeds: [embed], components });
  } catch (error) {
    console.error('[刷新商店失敗]', error);
  }
}

module.exports = {
  setupInteractionEvent,
  setup
};