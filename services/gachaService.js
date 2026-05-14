const {
  EmbedBuilder
} = require('discord.js');

let supabase;

// ===== 初始化 =====
function setup(supabaseInstance) {
  supabase = supabaseInstance;
}

// ===== 新增卡池 =====
async function addPool(
  interaction,
  name,
  price
) {

  if (
    interaction.guild.ownerId !==
    interaction.user.id
  ) {
    return interaction.reply({
      content: '❌ 只有服主可以使用',
      flags: 64
    });
  }

  const {
    error
  } = await supabase
    .from('gacha_pools')
    .insert({
      guild_id: interaction.guild.id,
      name,
      price
    });

  if (error) {

    console.error(error);

    return interaction.reply({
      content: '❌ 新增卡池失敗',
      flags: 64
    });
  }

  return interaction.reply({
    content:
      `✅ 已新增卡池：${name}`,
    flags: 64
  });
}

// ===== 刪除卡池 =====
async function removePool(
  interaction,
  name
) {

  const {
    error
  } = await supabase
    .from('gacha_pools')
    .delete()
    .eq(
      'guild_id',
      interaction.guild.id
    )
    .eq('name', name);

  if (error) {

    console.error(error);

    return interaction.reply({
      content: '❌ 刪除失敗',
      flags: 64
    });
  }

  return interaction.reply({
    content:
      `✅ 已刪除卡池 ${name}`,
    flags: 64
  });
}

// ===== 新增獎勵 =====
async function addReward(
  interaction,
  poolId,
  name,
  description,
  rarity,
  chance,
  coins
) {

  const {
    error
  } = await supabase
    .from('gacha_rewards')
    .insert({
      pool_id: poolId,
      name,
      description,
      rarity,
      chance,
      coins: coins || 0
    });

  if (error) {

    console.error(error);

    return interaction.reply({
      content: '❌ 新增獎勵失敗',
      flags: 64
    });
  }

  return interaction.reply({
    content:
      `✅ 已新增獎勵 ${name}`,
    flags: 64
  });
}

// ===== 刪除獎勵 =====
async function removeReward(
  interaction,
  poolId,
  name
) {

  const {
    error
  } = await supabase
    .from('gacha_rewards')
    .delete()
    .eq('pool_id', poolId)
    .eq('name', name);

  if (error) {

    console.error(error);

    return interaction.reply({
      content: '❌ 刪除獎勵失敗',
      flags: 64
    });
  }

  return interaction.reply({
    content:
      `✅ 已刪除獎勵 ${name}`,
    flags: 64
  });
}

// ===== 查看卡池 =====
async function showPools(
  interaction
) {

  const {
    data,
    error
  } = await supabase
    .from('gacha_pools')
    .select('*')
    .eq(
      'guild_id',
      interaction.guild.id
    );

  if (error) {

    console.error(error);

    return interaction.reply({
      content: '❌ 讀取卡池失敗',
      flags: 64
    });
  }

  if (!data.length) {

    return interaction.reply({
      content: '❌ 沒有卡池',
      flags: 64
    });
  }

  const text = data
    .map(
      p =>
        `🎰 ID:${p.id}｜${p.name}｜${p.price} 星雨幣`
    )
    .join('\n');

  const embed =
    new EmbedBuilder()
      .setColor('#ff66cc')
      .setTitle('🎰 扭蛋列表')
      .setDescription(text);

  return interaction.reply({
    embeds: [embed],
    flags: 64
  });
}

// ===== 抽卡 =====
async function performGacha(
  userId,
  guildId,
  amount
) {

  if (!supabase) {
    throw new Error(
      'supabase 未初始化'
    );
  }

  // ===== 取得第一個卡池 =====
  const {
    data: pools,
    error: poolError
  } = await supabase
    .from('gacha_pools')
    .select('*')
    .eq('guild_id', guildId)
    .limit(1);

  if (poolError) {
    throw poolError;
  }

  if (
    !pools ||
    pools.length === 0
  ) {
    throw new Error(
      '沒有卡池'
    );
  }

  const pool = pools[0];

  // ===== 取得獎勵 =====
  const {
    data: rewards,
    error: rewardError
  } = await supabase
    .from('gacha_rewards')
    .select('*')
    .eq('pool_id', pool.id);

  if (rewardError) {
    throw rewardError;
  }

  if (
    !rewards ||
    rewards.length === 0
  ) {
    throw new Error(
      '卡池沒有獎勵'
    );
  }

  // ===== 扣錢 =====
  const {
    data: users,
    error: userError
  } = await supabase
    .from('users')
    .select('*')
    .eq('user_id', userId)
    .limit(1);

  if (userError) {
    throw userError;
  }

  let user = users[0];

  if (!user) {

    const {
      data: newUser
    } = await supabase
      .from('users')
      .insert({
        user_id: userId,
        coins: 0
      })
      .select()
      .single();

    user = newUser;
  }

  const totalCost =
    pool.price * amount;

  if (
    user.coins < totalCost
  ) {
    throw new Error(
      '星雨幣不足'
    );
  }

  await supabase
    .from('users')
    .update({
      coins:
        user.coins - totalCost
    })
    .eq('user_id', userId);

  // ===== 開始抽 =====
  const results = [];

  for (
    let i = 0;
    i < amount;
    i++
  ) {

    const random =
      Math.random() * 100;

    let current = 0;

    let selected =
      rewards[0];

    for (const reward of rewards) {

      current += reward.chance;

      if (random <= current) {

        selected = reward;

        break;
      }
    }

    results.push({
      id: selected.id,
      name: selected.name,
      rarity: selected.rarity,
      description:
        selected.description,
      coins:
        selected.coins || 0
    });

    // ===== 存入背包 =====
    await supabase
      .from('inventory')
      .insert({
        user_id: userId,
        item_name:
          selected.name,
        rarity:
          selected.rarity,
        description:
          selected.description
      });

    // ===== 給星雨幣 =====
    if (
      selected.coins &&
      selected.coins > 0
    ) {

      const {
        data: latestUser
      } = await supabase
        .from('users')
        .select('*')
        .eq(
          'user_id',
          userId
        )
        .single();

      await supabase
        .from('users')
        .update({
          coins:
            latestUser.coins +
            selected.coins
        })
        .eq(
          'user_id',
          userId
        );
    }
  }

  return {
    pool,
    results
  };
}

module.exports = {
  setup,
  addPool,
  removePool,
  addReward,
  removeReward,
  showPools,
  performGacha
};