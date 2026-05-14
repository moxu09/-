const {
  EmbedBuilder
} = require('discord.js');

let supabase;
let client;

// ===== 初始化 =====
function setup(
  supabaseInstance,
  clientInstance
) {
  supabase = supabaseInstance;
  client = clientInstance;
}

// ===== 取得玩家 =====
async function getUser(userId) {

  const { data, error } =
    await supabase
      .from('users')
      .select('*')
      .eq('user_id', userId)
      .single();

  if (
    error &&
    error.code !== 'PGRST116'
  ) {
    console.error(
      '[DB] 讀取玩家失敗:',
      error
    );
  }

  // 不存在就建立
  if (!data) {

    const {
      data: newUser,
      error: insertError
    } = await supabase
      .from('users')
      .insert([
        {
          user_id: userId,
          coins: 0
        }
      ])
      .select()
      .single();

    if (insertError) {

      console.error(
        '[DB] 建立玩家失敗:',
        insertError
      );

      throw insertError;
    }

    return newUser;
  }

  return data;
}

// ===== 更新金額 =====
async function updateCoins(
  userId,
  coins
) {

  if (coins < 0) {
    throw new Error(
      '金額不能小於 0'
    );
  }

  const { error } =
    await supabase
      .from('users')
      .update({
        coins
      })
      .eq('user_id', userId);

  if (error) {

    console.error(
      '[DB] 更新金額失敗:',
      error
    );

    throw error;
  }
}

// ===== 更新簽到 =====
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

    console.error(
      '[DB] 更新簽到失敗:',
      error
    );

    throw error;
  }
}

// ===== 每日簽到 =====
async function dailyCheckin(
  interaction
) {

  const user =
    await getUser(
      interaction.user.id
    );

  const now = new Date();

  const utc8 = new Date(
    now.getTime() +
    8 * 60 * 60 * 1000
  );

  const today =
    utc8
      .toISOString()
      .split('T')[0];

  if (
    user.last_checkin === today
  ) {
    return interaction.reply({
      content:
        '❌ 今天已經簽到過了',
      flags: 64
    });
  }

  const reward = 10;

  const newCoins =
    user.coins + reward;

  await updateCoins(
    interaction.user.id,
    newCoins
  );

  await updateCheckin(
    interaction.user.id,
    today
  );

  await sendWalletLog(
    interaction.user.id,
    '每日簽到',
    reward,
    newCoins,
    '☔ 每日簽到獎勵'
  );

  return interaction.reply({
    content:
      `☔ 簽到成功！\n獲得 ${reward} 星雨幣`
  });
}

// ===== 餘額 =====
async function checkBalance(
  interaction
) {

  const user =
    await getUser(
      interaction.user.id
    );

  return interaction.reply({
    content:
      `💰 目前餘額：${user.coins} 星雨幣`,
    flags: 64
  });
}

// ===== 排名 =====
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

    console.error(
      '[DB] 排名查詢失敗:',
      error
    );

    return null;
  }

  const rank =
    data.findIndex(
      user =>
        user.user_id === userId
    );

  return rank === -1
    ? null
    : rank + 1;
}

// ===== 顯示排名 =====
async function showRank(
  interaction
) {

  const rank =
    await getUserRank(
      interaction.user.id
    );

  if (!rank) {
    return interaction.reply({
      content:
        '❌ 查無排名',
      flags: 64
    });
  }

  return interaction.reply({
    content:
      `🏆 你的排名：#${rank}`,
    flags: 64
  });
}

// ===== 交易紀錄 =====
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

    console.error(
      '[DB] 交易紀錄查詢失敗:',
      error
    );

    return [];
  }

  return data || [];
}

// ===== 顯示交易紀錄 =====
async function showTransfers(
  interaction
) {

  const records =
    await getTransferRecords(
      interaction.user.id
    );

  if (!records.length) {
    return interaction.reply({
      content:
        '📭 沒有交易紀錄',
      flags: 64
    });
  }

  const text =
    records
      .map(record => {

        const isSender =
          record.sender_id ===
          interaction.user.id;

        return isSender
          ? `💸 -${record.amount}`
          : `💰 +${record.amount}`;
      })
      .join('\n');

  return interaction.reply({
    content:
      `📜 最近交易紀錄\n\n${text}`,
    flags: 64
  });
}

// ===== 安全轉帳 =====
async function safeTransfer(
  senderId,
  receiverId,
  amount
) {

  if (
    isNaN(amount) ||
    amount <= 0
  ) {
    throw new Error(
      '金額無效'
    );
  }

  if (senderId === receiverId) {
    throw new Error(
      '不能轉給自己'
    );
  }

  const sender =
    await getUser(senderId);

  if (sender.coins < amount) {
    throw new Error(
      '星雨幣不足'
    );
  }

  const receiver =
    await getUser(receiverId);

  await updateCoins(
    senderId,
    sender.coins - amount
  );

  await updateCoins(
    receiverId,
    receiver.coins + amount
  );

  const { error } =
    await supabase
      .from('transfers')
      .insert([
        {
          sender_id: senderId,
          receiver_id: receiverId,
          amount
        }
      ]);

  if (error) {

    console.error(
      '[DB] 新增交易紀錄失敗:',
      error
    );
  }

  await sendWalletLog(
    senderId,
    '轉帳支出',
    -amount,
    sender.coins - amount,
    `💸 轉帳給 <@${receiverId}>`
  );

  await sendWalletLog(
    receiverId,
    '轉帳收入',
    amount,
    receiver.coins + amount,
    `💰 收到 <@${senderId}> 的轉帳`
  );
}

// ===== 發錢 =====
async function giveCoins(
  interaction,
  user,
  amount
) {

  const target =
    await getUser(user.id);

  const newCoins =
    target.coins + amount;

  await updateCoins(
    user.id,
    newCoins
  );

  await sendWalletLog(
    user.id,
    '管理員發錢',
    amount,
    newCoins
  );

  return interaction.reply({
    content:
      `✅ 已給予 ${user} ${amount} 星雨幣`
  });
}

// ===== 扣錢 =====
async function removeCoins(
  interaction,
  user,
  amount
) {

  const target =
    await getUser(user.id);

  if (target.coins < amount) {
    return interaction.reply({
      content:
        '❌ 玩家餘額不足',
      flags: 64
    });
  }

  const newCoins =
    target.coins - amount;

  await updateCoins(
    user.id,
    newCoins
  );

  await sendWalletLog(
    user.id,
    '管理員扣款',
    -amount,
    newCoins
  );

  return interaction.reply({
    content:
      `✅ 已扣除 ${user} ${amount} 星雨幣`
  });
}

// ===== 錢包通知 =====
async function sendWalletLog(
  userId,
  type,
  amount,
  balance,
  note = ''
) {

  try {

    const user =
      await client.users.fetch(
        userId
      );

    const embed =
      new EmbedBuilder()
        .setColor('#ffd700')
        .setTitle('💰 錢包異動通知')
        .addFields(
          {
            name: '📌 類型',
            value: type,
            inline: true
          },
          {
            name: '💵 異動金額',
            value:
              `${amount} 星雨幣`,
            inline: true
          },
          {
            name: '💳 目前餘額',
            value:
              `${balance} 星雨幣`,
            inline: true
          }
        )
        .setTimestamp();

    if (note) {
      embed.setDescription(note);
    }

    await user.send({
      embeds: [embed]
    });

  } catch (error) {

    console.error(
      '[錢包通知失敗]',
      error
    );
  }
}

module.exports = {
  setup,
  getUser,
  updateCoins,
  updateCheckin,
  dailyCheckin,
  checkBalance,
  getUserRank,
  showRank,
  getTransferRecords,
  showTransfers,
  safeTransfer,
  giveCoins,
  removeCoins,
  sendWalletLog
};