let supabase;
let client;

function setup(supabaseInstance, clientInstance) {
  supabase = supabaseInstance;
  client = clientInstance;
}

// ===== 查看我的商品 =====
async function showInventory(interaction) {

  try {

    const userId = interaction.user.id;

    const {
      data,
      error
    } = await supabase
      .from('inventory')
      .select('*')
      .eq('user_id', userId);

    if (error) {
      console.error(error);

      return interaction.reply({
        content: '❌ 讀取商品失敗',
        flags: 64
      });
    }

    if (!data || data.length === 0) {

      return interaction.reply({
        content: '📦 你目前沒有任何商品',
        flags: 64
      });
    }

    const text = data
      .map(item =>
        `🎁 ${item.item_name} × ${item.quantity || 1}`
      )
      .join('\n');

    return interaction.reply({
      content:
        `📦 你的商品列表\n\n${text}`,
      flags: 64
    });

  } catch (error) {

    console.error(
      '[showInventory error]',
      error
    );

    return interaction.reply({
      content: '❌ 系統錯誤',
      flags: 64
    }).catch(() => {});
  }
}

module.exports = {
  setup,
  showInventory
};