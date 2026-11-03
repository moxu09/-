const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits,
  SlashCommandBuilder, StringSelectMenuBuilder,
} = require('discord.js');

const QIUNAI_GUILD = '1206138511535898654';
const DEEPNIGHT_GUILD = '1501098191813214312';
const PAGE_SIZE = 25;
const PREFIX = 'pzr:';

function buildRedeemPrizeCommand() {
  return new SlashCommandBuilder()
    .setName('兌換獎品')
    .setDescription('替指定成員核銷已抽到、尚未兌換的獎品')
    .addUserOption(o => o.setName('指定的人').setDescription('獎品持有人').setRequired(true));
}

function isGachaPrize(item) {
  return item.item_type === 'gacha' ||
    (item.item_type === 'coupon' && String(item.item_name || '').includes('禮券') &&
      ['R', 'SR', 'SSR', 'SP'].includes(item.rarity));
}

function isIchibanPrize(draw) {
  return !/^[a-f]-asd-[0-9]+$/.test(draw.prize_id) || draw.is_last_one === true;
}

function checked(result, action) {
  if (result.error) throw new Error(`${action}失敗：${result.error.message}`);
  return result.data;
}

function createPrizeRedemption({ db, guildId, organization, customerServiceRoleIds = [] }) {
  if (!db || ![QIUNAI_GUILD, DEEPNIGHT_GUILD].includes(guildId)) throw new Error('獎品兌換設定錯誤');
  const roleIds = new Set(customerServiceRoleIds.filter(id => /^\d{17,20}$/.test(id)));

  async function authorized(interaction) {
    if (interaction.guildId !== guildId || !interaction.guild) return false;
    if (interaction.guild.ownerId === interaction.user.id ||
        interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
    const roles = interaction.member?.roles;
    if ([...roleIds].some(id => roles?.cache?.has(id) || (Array.isArray(roles) && roles.includes(id)))) return true;
    const assignment = checked(await db.from('erp_role_assignments').select('role,is_active')
      .eq('organization_code', organization).eq('discord_id', interaction.user.id).maybeSingle(), '檢查操作權限');
    return assignment?.is_active === true &&
      ['super_admin', 'store_manager', 'customer_service'].includes(assignment.role);
  }

  async function eligible(userId) {
    const items = checked(await db.from('user_items').select('id,item_name,item_type,rarity,created_at')
      .eq('guild_id', guildId).eq('user_id', userId)
      .order('created_at', { ascending: false }).limit(1000), '讀取扭蛋背包');
    const choices = (items || []).filter(isGachaPrize).map(item => ({
      sourceType: 'gacha_item', sourceId: String(item.id),
      name: item.item_name, label: `扭蛋｜${item.item_name} #${item.id}`,
      description: `${item.rarity || '獎品'}｜背包編號 ${item.id}`, createdAt: item.created_at,
    }));
    if (guildId === QIUNAI_GUILD) {
      const [draws, prizes] = await Promise.all([
        db.from('qiunai_ichiban_draws').select('id,prize_id,ticket_no,is_last_one,created_at')
          .eq('discord_user_id', userId).order('created_at', { ascending: false }).limit(1000),
        db.from('qiunai_ichiban_prizes').select('id,tier,name'),
      ]);
      const prizeMap = new Map((checked(prizes, '讀取一番賞獎品') || []).map(prize => [prize.id, prize]));
      for (const draw of checked(draws, '讀取一番賞中獎紀錄') || []) {
        if (!isIchibanPrize(draw)) continue;
        const prize = prizeMap.get(draw.prize_id);
        if (!prize) continue;
        const name = /^[a-f]-asd-[0-9]+$/.test(draw.prize_id)
          ? '全集賞｜AirPods Pro'
          : `${prize.tier} 賞｜${prize.name}${draw.is_last_one ? '＋全集賞 AirPods Pro' : ''}`;
        choices.push({ sourceType: 'ichiban_draw', sourceId: draw.id, name,
          label: `一番賞｜抽紙 #${draw.ticket_no} ${prize.name}`,
          description: `${prize.tier} 賞｜抽獎紀錄 ${draw.id.slice(0, 8)}`, createdAt: draw.created_at });
      }
    }
    const redemptions = checked(await db.from('bot_prize_redemptions').select('source_type,source_id')
      .eq('guild_id', guildId).eq('user_id', userId).limit(2000), '讀取已兌換紀錄');
    const redeemed = new Set((redemptions || []).map(row => `${row.source_type}:${row.source_id}`));
    return choices.filter(choice => !redeemed.has(`${choice.sourceType}:${choice.sourceId}`))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  function listPayload(userId, actorId, choices, page = 0) {
    if (!choices.length) return { content: `<@${userId}> 目前沒有可兌換的扭蛋或一番賞獎品。`, components: [], allowedMentions: { parse: [] } };
    const lastPage = Math.ceil(choices.length / PAGE_SIZE) - 1;
    const currentPage = Math.max(0, Math.min(page, lastPage));
    const pageChoices = choices.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
    const select = new StringSelectMenuBuilder()
      .setCustomId(`${PREFIX}pick:${actorId}:${userId}:${currentPage}`)
      .setPlaceholder('選擇要核銷的獎品')
      .addOptions(pageChoices.map(choice => ({
        label: choice.label.slice(0, 100), description: choice.description.slice(0, 100),
        value: `${choice.sourceType === 'gacha_item' ? 'g' : 'i'}:${choice.sourceId}`,
      })));
    const components = [new ActionRowBuilder().addComponents(select)];
    if (lastPage > 0) components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}page:${actorId}:${userId}:${currentPage - 1}`)
        .setLabel('上一頁').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 0),
      new ButtonBuilder().setCustomId(`${PREFIX}page:${actorId}:${userId}:${currentPage + 1}`)
        .setLabel('下一頁').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === lastPage),
    ));
    return { content: `🎁 <@${userId}> 的可兌換獎品，共 ${choices.length} 筆（第 ${currentPage + 1}/${lastPage + 1} 頁）。\n選擇後還要再次確認，才會標記為已兌換。`,
      components, allowedMentions: { parse: [] } };
  }

  async function handleCommand(interaction) {
    if (!interaction.isChatInputCommand?.() || interaction.guildId !== guildId) {
      return interaction.editReply('❌ 請在對應店家伺服器使用 /兌換獎品。');
    }
    if (!await authorized(interaction)) return interaction.editReply('❌ 只有客服或主管可以核銷獎品。');
    const target = interaction.options.getUser('指定的人', true);
    if (target.bot) return interaction.editReply('❌ 請指定真人會員。');
    const choices = await eligible(target.id);
    return interaction.editReply(listPayload(target.id, interaction.user.id, choices));
  }

  async function handleInteraction(interaction) {
    if (!(interaction.isStringSelectMenu?.() || interaction.isButton?.()) ||
        !interaction.customId?.startsWith(PREFIX)) return false;
    await interaction.deferUpdate();
    const parts = interaction.customId.slice(PREFIX.length).split(':');
    const [action, actorId, userId, token, sourceId] = parts;
    if (actorId !== interaction.user.id || interaction.guildId !== guildId ||
        !/^\d{17,20}$/.test(userId || '') || !await authorized(interaction)) {
      await interaction.editReply({ content: '❌ 這份獎品選單不屬於你，或沒有核銷權限。', components: [] });
      return true;
    }
    if (action === 'page' && interaction.isButton()) {
      const choices = await eligible(userId);
      await interaction.editReply(listPayload(userId, actorId, choices, Number(token) || 0));
      return true;
    }
    if (action === 'pick' && interaction.isStringSelectMenu()) {
      const value = interaction.values?.[0];
      const choices = await eligible(userId);
      const selected = choices.find(choice =>
        `${choice.sourceType === 'gacha_item' ? 'g' : 'i'}:${choice.sourceId}` === value);
      if (!selected) {
        await interaction.editReply({ content: '❌ 此獎品已不在可兌換清單，請重新執行指令。', components: [] });
        return true;
      }
      const kind = selected.sourceType === 'gacha_item' ? 'g' : 'i';
      await interaction.editReply({ content: `請確認 **${selected.name}** 已交付給 <@${userId}>。確認後會記錄核銷；扭蛋獎品會從背包移除。`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`${PREFIX}confirm:${actorId}:${userId}:${kind}:${selected.sourceId}`)
            .setLabel('確認已交付並兌換').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`${PREFIX}cancel:${actorId}:${userId}:0`)
            .setLabel('取消').setStyle(ButtonStyle.Secondary),
        )], allowedMentions: { parse: [] } });
      return true;
    }
    if (action === 'cancel' && interaction.isButton()) {
      await interaction.editReply({ content: '已取消，沒有核銷任何獎品。', components: [] });
      return true;
    }
    if (action === 'confirm' && interaction.isButton() && ['g', 'i'].includes(token) && sourceId) {
      const result = await db.rpc('bot_redeem_prize', {
        p_guild_id: guildId, p_user_id: userId,
        p_source_type: token === 'g' ? 'gacha_item' : 'ichiban_draw', p_source_id: sourceId,
        p_actor_id: actorId, p_operation_id: interaction.id,
      });
      if (result.error) {
        const already = String(result.error.message || '').includes('已兌換');
        await interaction.editReply({ content: already ? '❌ 這筆獎品已兌換，未重複核銷。' :
          `❌ 兌換結果暫時無法確認，請查核銷紀錄後再操作。操作編號：${interaction.id}`, components: [] });
        return true;
      }
      await interaction.editReply({ content: `✅ ${result.data.already_processed ? '已處理' : '兌換完成'}\n對象：<@${userId}>\n獎品：${result.data.prize_name}\n核銷編號：${result.data.redemption_id}`,
        components: [], allowedMentions: { parse: [] } });
      return true;
    }
    await interaction.editReply({ content: '❌ 獎品操作已失效，請重新執行指令。', components: [] });
    return true;
  }

  return { handleCommand, handleInteraction, eligible };
}

module.exports = { buildRedeemPrizeCommand, createPrizeRedemption, isGachaPrize, isIchibanPrize };
