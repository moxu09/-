const {
  EmbedBuilder,
  ActionRowBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

let supabase;
let client;

const transferCooldown = new Map();

function setup(supabaseInstance, clientInstance) {
  supabase = supabaseInstance;
  client = clientInstance;
}

// ===== 取得玩家 =====

async function getUser(userId) {

  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('user_id', userId)
    .single();

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

// ===== 更新金額 =====

async function updateCoins(userId, coins) {

  await supabase
    .from('users')
    .update({ coins })
    .eq('user_id', userId);
}

// ===== 新增交易紀錄 =====

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
        amount
      }
    ]);
}

// ===== 開啟轉帳選單 =====

async function openTransferMenu(interaction) {

  const menu =
    new UserSelectMenuBuilder()
      .setCustomId('transfer_user_select')
      .setPlaceholder('選擇轉帳對象');

  const row =
    new ActionRowBuilder()
      .addComponents(menu);

  return interaction.reply({
    content: '💸 請選擇轉帳對象',
    components: [row],
    flags: 64
  });
}

// ===== 選擇玩家後 =====

async function handleTransferUser(interaction) {

  const targetId =
    interaction.values[0];

  const modal =
    new ModalBuilder()
      .setCustomId(
        `transfer_modal_${targetId}`
      )
      .setTitle('星雨轉帳');

  const amountInput =
    new TextInputBuilder()
      .setCustomId('amount')
      .setLabel('輸入轉帳金額')
      .setStyle(
        TextInputStyle.Short
      )
      .setRequired(true);

  const row =
    new ActionRowBuilder()
      .addComponents(amountInput);

  modal.addComponents(row);

  return interaction.showModal(modal);
}

// ===== 處理轉帳 =====

async function handleTransferSubmit(
  interaction
) {

  const targetId =
    interaction.customId.split('_')[2];

  const amount =
    parseInt(
      interaction.fields.getTextInputValue('amount')
    );

  if (
    isNaN(amount) ||
    amount <= 0
  ) {
    return interaction.reply({
      content: '❌ 金額錯誤',
      flags: 64
    });
  }

  if (
    interaction.user.id === targetId
  ) {
    return interaction.reply({
      content: '❌ 不能轉給自己',
      flags: 64
    });
  }

  const cooldown =
    transferCooldown.get(
      interaction.user.id
    );

  if (
    cooldown &&
    Date.now() - cooldown < 5000
  ) {
    return interaction.reply({
      content: '❌ 請稍後再轉帳',
      flags: 64
    });
  }

  transferCooldown.set(
    interaction.user.id,
    Date.now()
  );

  const sender =
    await getUser(interaction.user.id);

  const receiver =
    await getUser(targetId);

  if (sender.coins < amount) {
    return interaction.reply({
      content: '❌ 星雨幣不足',
      flags: 64
    });
  }

  await updateCoins(
    sender.user_id,
    sender.coins - amount
  );

  await updateCoins(
    receiver.user_id,
    receiver.coins + amount
  );

  await addTransferRecord(
    sender.user_id,
    receiver.user_id,
    amount
  );

  return interaction.reply({
    content:
      `✅ 轉帳成功\n` +
      `💸 ${amount} 星雨幣`,
    flags: 64
  });
}

module.exports = {
  setup,
  openTransferMenu,
  handleTransferUser,
  handleTransferSubmit
};