const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
} = require("discord.js");
const path = require("node:path");
const {
  createWorkReportSystem,
  isStaffInteraction,
} = require("./workReportSystem");
const { ORDER_FLOW_TTL_MS } = require("../utils/orderFlow");
const {
  buildTopupTopic,
  getNextTopupNumber,
  getTopupNumberFromTopic,
} = require("../utils/topupNumbers");
const {
  hasCustomerServicePointRole,
  recordCustomerServicePoint,
} = require("../utils/customerServicePoints");
const {
  DEFAULT_SALARY_ADVANCE_LIMIT,
  calculateSalaryDeductionState,
} = require("../utils/salaryDeduction");
const {
  buildPaymentMethodButtonRows,
  getCanonicalPaymentOptions,
  getPaymentMethodDisplayName,
  getPaymentMethodSelection,
} = require("../utils/paymentMethodEmojis");

let supabase;
let client;
let paymentHelpers = {};
let workReportSystem;

const STAFF_TABLE = process.env.STAFF_TABLE || "players";
const DEEPNIGHT_STAFF_DISCORD_GUILD_ID =
  process.env.DEEPNIGHT_STAFF_DISCORD_GUILD_ID || "1501836172199202856";
const pendingNewOrders = new Map();
const pendingNewOrderSelectionTimers = new Map();
const NEW_ORDER_SELECTION_TIMEOUT_MS = 15 * 60 * 1000;
const NEW_ORDER_SELECTION_EXTENSION_MS = 5 * 60 * 1000;
const pendingTopups = new Map();
const TOPUP_PRESET_AMOUNTS = Object.freeze([100, 250, 500, 1000, 3000, 5000, 10000, 15000]);
const pendingServiceOrders = new Map();
const JKOPAY_QR_CODE_PATH = path.join(
  __dirname,
  "..",
  "assets",
  "payments",
  "jkopay-deepnight.png",
);
const BANK_TRANSFER_QR_CODE_PATH = path.join(
  __dirname,
  "..",
  "assets",
  "payments",
  "bank-transfer-line-bank.png",
);
const TIP_ORDER_PANEL_CHANNEL_ID = "1531517576432189470";
const CUSTOMER_SERVICE_POINT_ROLE_ID =
  process.env.CUSTOMER_SERVICE_POINT_ROLE_ID || "1210642900355125288";
const CUSTOMER_SERVICE_POINT_APP_KEY = "deepnight";
const DEEPNIGHT_GUILD_ID =
  process.env.DEEPNIGHT_GUILD_ID ||
  process.env.GUILD_ID ||
  "1501098191813214312";
const DEEPNIGHT_ORGANIZATION_CODE = "deepnight";
const DELIVERY_RECOVERY_STALE_MS = 5 * 60 * 1000;

function clearNewOrderSelectionTimer(flowId) {
  const timer = pendingNewOrderSelectionTimers.get(flowId);
  if (timer) clearTimeout(timer);
  pendingNewOrderSelectionTimers.delete(flowId);
}

function scheduleNewOrderSelectionTimeout(flowId) {
  clearNewOrderSelectionTimer(flowId);
  const pending = pendingNewOrders.get(flowId);
  const expiresAt = Number(pending?.selectionExpiresAt || 0);
  if (!pending || !Number.isFinite(expiresAt) || expiresAt <= 0) return;

  const timer = setTimeout(async () => {
    pendingNewOrderSelectionTimers.delete(flowId);
    const latest = pendingNewOrders.get(flowId);
    if (!latest || Number(latest.selectionExpiresAt || 0) !== expiresAt) return;

    pendingNewOrders.delete(flowId);
    const channel = await client.channels.fetch(latest.channelId).catch(() => null);
    if (channel?.isTextBased()) {
      await channel.send({
        content:
          `<@${latest.userId}> 這次自助下單在選人期限內沒有完成選擇，已自動棄單。\n` +
          `如仍有需要，請重新開啟下單表單。`,
      }).catch(() => null);
    }
  }, Math.max(0, expiresAt - Date.now()));
  timer.unref?.();
  pendingNewOrderSelectionTimers.set(flowId, timer);
}

function buildNewOrderSelectionControlRow(flowId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`new_order_selection_extend_${flowId}`)
      .setLabel("加長選人時間（+5 分鐘）")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`new_order_selection_cancel_${flowId}`)
      .setLabel("棄單")
      .setStyle(ButtonStyle.Danger),
  );
}

async function notifyNewOrderSelectionExtension(interaction, pending) {
  const dispatchChannel = process.env.PLAYER_ORDER_CHANNEL
    ? await client.channels.fetch(process.env.PLAYER_ORDER_CHANNEL).catch(() => null)
    : null;
  if (!dispatchChannel?.isTextBased()) return;

  await dispatchChannel.send({
    content:
      `⏱️ <@${pending.userId}> 已延長自助下單選人時間 5 分鐘。\n` +
      `下單頻道：<#${interaction.channelId}>\n` +
      `新的選人期限：<t:${Math.floor(pending.selectionExpiresAt / 1000)}:F>（<t:${Math.floor(pending.selectionExpiresAt / 1000)}:R>）`,
  }).catch(() => null);
}

async function handleNewOrderSelectionExtend(interaction) {
  const flowId = interaction.customId.replace("new_order_selection_extend_", "");
  const pending = pendingNewOrders.get(flowId);
  if (!pending) {
    return interaction.reply({ content: "❌ 這筆下單流程已過期，請重新填寫。", flags: 64 });
  }
  if (pending.userId !== interaction.user.id) {
    return interaction.reply({ content: "❌ 只有下單者可以延長選人時間。", flags: 64 });
  }

  const currentDeadline = Math.max(Date.now(), Number(pending.selectionExpiresAt || 0));
  pending.selectionExpiresAt = currentDeadline + NEW_ORDER_SELECTION_EXTENSION_MS;
  pendingNewOrders.set(flowId, pending);
  scheduleNewOrderSelectionTimeout(flowId);
  await notifyNewOrderSelectionExtension(interaction, pending);

  return interaction.reply({
    content:
      `✅ 已延長選人時間 5 分鐘。\n` +
      `新的期限：<t:${Math.floor(pending.selectionExpiresAt / 1000)}:F>（<t:${Math.floor(pending.selectionExpiresAt / 1000)}:R>）`,
    flags: 64,
  });
}

async function handleNewOrderSelectionCancel(interaction) {
  const flowId = interaction.customId.replace("new_order_selection_cancel_", "");
  const pending = pendingNewOrders.get(flowId);
  if (!pending) {
    return interaction.reply({ content: "❌ 這筆下單流程已經結束。", flags: 64 });
  }
  if (pending.userId !== interaction.user.id) {
    return interaction.reply({ content: "❌ 只有下單者可以棄單。", flags: 64 });
  }

  clearNewOrderSelectionTimer(flowId);
  pendingNewOrders.delete(flowId);
  return interaction.update({
    content: "✅ 已手動棄單，這次自助下單不會繼續建立訂單。",
    components: [],
  });
}

function parseRoleIds(...values) {
  return new Set(
    values
      .flatMap((value) => String(value || "").match(/\d{16,22}/g) || [])
      .filter(Boolean),
  );
}

function canApproveSalaryDeduction(interaction) {
  if (interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  const allowedRoleIds = parseRoleIds(
    process.env.CUSTOMER_SERVICE_ROLE_ID,
    process.env.CUSTOMER_SERVICE_ROLE_IDS,
    process.env.MANAGEMENT_ROLE_ID,
    process.env.MANAGEMENT_ROLE_IDS,
  );

  return [...allowedRoleIds].some((roleId) =>
    interaction.member?.roles?.cache?.has(roleId),
  );
}

async function deferReplyOnce(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: 64 });
  }
}

async function recordPaidExtensionConsumption(extension, note) {
  const amount = Number(extension?.amount || 0);
  const customerId = String(extension?.customer_id || "").trim();
  if (!customerId || !Number.isFinite(amount) || amount <= 0) return;

  const { data: vipOperation, error: vipError } = await supabase.rpc(
    "deepnight_apply_vip_activity_once",
    {
      p_operation_key: `extension:${extension.id}`,
      p_user_id: customerId,
      p_guild_id: extension.guild_id || DEEPNIGHT_GUILD_ID,
      p_trigger_type: "spend",
      p_amount: amount,
    },
  );
  if (vipError || !vipOperation) {
    throw new Error(vipError?.message || "加時 VIP 累積失敗");
  }
  if (!paymentHelpers.recordSpendActivity) {
    throw new Error("聯盟消費累積函式尚未接入");
  }
  await paymentHelpers.recordSpendActivity({
    userId: customerId,
    amount,
    sourceKey: `order-extension:${extension.id}`,
    note,
  });
  if (!paymentHelpers.checkAndUpgradeVip) {
    throw new Error("VIP 等級函式尚未接入");
  }
  await paymentHelpers.checkAndUpgradeVip(
    customerId,
    "spend",
    0,
    extension.guild_id || DEEPNIGHT_GUILD_ID,
    Number(vipOperation.total_spent || 0),
    { strict: true },
  );
}

async function loadAllSalaryRows(buildQuery) {
  const rows = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

async function getSalaryDeductionEligibility(discordId, amount) {
  const normalizedDiscordId = String(discordId || "").trim();
  const { data: staffRows, error: staffError } = await supabase
    .from("players")
    .select("id, discord_id, discord_name, display_name, real_name, guild_id")
    .eq("discord_id", normalizedDiscordId)
    .eq("is_active", true);

  if (staffError) throw staffError;
  const matchingStaff = (staffRows || []).filter((row) => {
    if (row.guild_id == null || String(row.guild_id).trim() === "") return true;
    return String(row.guild_id)
      .split(",")
      .map((value) => value.trim())
      .includes(DEEPNIGHT_GUILD_ID);
  });
  const staff =
    matchingStaff.find(
      (row) => String(row.guild_id || "").trim() === DEEPNIGHT_GUILD_ID,
    ) || matchingStaff[0];
  if (!staff) throw new Error("扣薪付款僅限深夜不關燈在職員工使用");

  const walletStartIso = new Date(
    `${process.env.SALARY_WALLET_START_DATE || "2026-07-17"}T00:00:00+08:00`,
  ).toISOString();
  const [walletEntries, withdrawRequests, pendingOrders, pendingAdjustments] =
    await Promise.all([
      loadAllSalaryRows(() =>
        supabase
          .from("salary_wallet_entries")
          .select("amount")
          .eq("app_key", "deepnight")
          .eq("discord_id", normalizedDiscordId),
      ),
      loadAllSalaryRows(() =>
        supabase
          .from("salary_withdraw_requests")
          .select("amount, status")
          .eq("app_key", "deepnight")
          .eq("discord_id", normalizedDiscordId)
          .in("status", ["pending", "approved"]),
      ),
      loadAllSalaryRows(() =>
        supabase
          .from("play_orders")
          .select("staff_salary, bonus_amount")
          .eq("discord_id", normalizedDiscordId)
          .gte("order_finished_at", walletStartIso)
          .eq("guild_id", DEEPNIGHT_GUILD_ID)
          .is("wallet_settled_at", null)
          .or("is_deleted.eq.false,is_deleted.is.null")
          .or("status.neq.已入帳,status.is.null"),
      ),
      loadAllSalaryRows(() =>
        supabase
          .from("players_bonus")
          .select("amount")
          .eq("discord_id", normalizedDiscordId)
          .gte("created_at", walletStartIso)
          .is("wallet_settled_at", null),
      ),
    ]);

  return {
    staff,
    state: calculateSalaryDeductionState({
      walletEntries,
      withdrawRequests,
      pendingOrders,
      pendingAdjustments,
      amount,
      advanceLimit: DEFAULT_SALARY_ADVANCE_LIMIT,
    }),
  };
}

async function createSalaryDeductionPrompt({
  channel,
  customerId,
  amount,
  eligibility,
  confirmId,
  cancelId,
  purpose = "訂單",
}) {
  const { state } = eligibility;
  const balanceText = Math.max(0, state.availableBefore).toLocaleString("zh-TW");
  const details = state.shortage
    ? `目前抽成後可用薪資：NT$${balanceText}\n` +
      `本筆${purpose}金額：NT$${amount.toLocaleString("zh-TW")}\n` +
      `不足金額：NT$${state.shortage.toLocaleString("zh-TW")}\n` +
      `確認後預支總額：NT$${state.projectedAdvance.toLocaleString("zh-TW")} / NT$${state.advanceLimit.toLocaleString("zh-TW")}`
    : `目前抽成後可用薪資：NT$${state.availableBefore.toLocaleString("zh-TW")}\n` +
      `本筆扣薪：NT$${amount.toLocaleString("zh-TW")}\n` +
      `扣除後剩餘：NT$${state.projectedBalance.toLocaleString("zh-TW")}`;

  await channel.send({
    content: `<@&${process.env.STAFF_ROLE}> <@${customerId}> 選擇了員工扣薪付款。`,
    embeds: [
      new EmbedBuilder()
        .setColor(state.shortage ? "#f59e0b" : "#57F287")
        .setTitle(state.shortage ? "⚠️ 薪資不足，是否確認預支" : "💼 確認使用扣薪付款")
        .setDescription(
          `${details}\n\n` +
            "只有客服或管理員可以確認；確認後會在深夜 EIP 新增「使用薪水點單」扣項。",
        )
        .setTimestamp(),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(confirmId)
          .setLabel("確認使用扣薪")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(cancelId)
          .setLabel("不使用扣薪")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

async function applySalaryDeductionToOrders({
  customerId,
  amount,
  orderIds,
  finalStatus,
  quoteStatus = null,
  confirmedBy,
}) {
  const { data, error } = await supabase.rpc(
    "deepnight_pay_orders_with_salary",
    {
      p_order_ids: orderIds,
      p_customer_id: customerId,
      p_guild_id: DEEPNIGHT_GUILD_ID,
      p_final_status: finalStatus,
      p_quote_status: quoteStatus,
      p_confirmed_by: String(confirmedBy || ""),
    },
  );
  if (error || !data) {
    throw new Error(error?.message || "扣薪付款原子處理失敗");
  }
  if (Number(data.amount || 0) !== Number(amount || 0)) {
    throw new Error("扣薪付款金額與訂單資料不一致");
  }
  return {
    orders: Array.isArray(data.orders) ? data.orders : [],
    adjustmentId: data.adjustment_id,
    alreadyProcessed: data.already_processed === true,
  };
}

async function awardCustomerServicePoint(orderId, discordId) {
  try {
    await recordCustomerServicePoint(supabase, {
      appKey: CUSTOMER_SERVICE_POINT_APP_KEY,
      orderId,
      discordId,
    });
  } catch (error) {
    console.error("[客服點數] 記錄失敗", error);
  }
}

async function getNextPlayOrderNumber() {
  const { data, error } = await supabase.rpc("next_play_order_number");
  const orderNo = String(data || "").trim();

  if (error || !/^ORD-\d{10,}$/.test(orderNo)) {
    console.error("[訂單編號] 取得流水號失敗", error || data);
    throw new Error(error?.message || "無法取得訂單編號");
  }

  return orderNo;
}

function canCustomerOrStaffSubmit(interaction, customerId) {
  return (
    interaction.user.id === String(customerId || "") ||
    isStaffInteraction(
      interaction,
      process.env.STAFF_ROLE,
      process.env.STAFF_ROLE_ID,
      process.env.STAFF_ROLE_IDS,
      process.env.CUSTOMER_SERVICE_ROLE_ID,
      process.env.CUSTOMER_SERVICE_ROLE_IDS,
      "1501271090918326362",
      "1502010574781943989",
    )
  );
}

function createFlowId(userId) {
  return `${userId}_${Date.now()}`;
}

function getServiceName(serviceType) {
  if (serviceType === "valorant") return "特戰英豪";
  if (serviceType === "delta") return "三角洲行動";
  if (serviceType === "apex") return "Apex";
  if (serviceType === "lol") return "英雄聯盟";
  if (serviceType === "steam") return "Steam";
  if (serviceType === "other") return "其他項目";

  if (serviceType === "pubg") return "絕地求生";
  if (serviceType === "pubgm") return "PUBG M";
  if (serviceType === "naraka") return "NARAKA";
  if (serviceType === "minecraft") return "Minecraft";
  if (serviceType === "voice_chat") return "語音聊天";
  if (serviceType === "song") return "點歌服務";
  if (serviceType === "custom") return "自訂輸入";

  if (serviceType === "chat") return "陪聊";
  if (serviceType === "emotion") return "出氣包";

  return "訂單";
}
const pendingPanelOrders = new Map();

const GAME_ORDER_PANELS = [
  {
    envKey: "VALORANT_ORDER_CHANNEL",
    panelName: "valorant",
    title: "🎯 特戰英豪下單區",
    description: "請選擇你要下單的特戰英豪項目。",
    customId: "game_order_select_valorant",
    options: [
      { label: "大神", value: "god", description: "特戰英豪｜大神" },
      { label: "技術", value: "skill", description: "特戰英豪｜技術" },
      { label: "娛樂", value: "entertain", description: "特戰英豪｜娛樂" },
      {
        label: "技術+娛樂",
        value: "skill_entertain",
        description: "特戰英豪｜技術+娛樂，至少 2 位陪陪",
      },
      {
        label: "購買星雨幣",
        value: "topup",
        description: "建立購買星雨幣訂單",
      },
    ],
  },
  {
    envKey: "DELTA_ORDER_CHANNEL",
    panelName: "delta",
    title: "🛡️ 三角洲行動下單區",
    description: "請選擇你要下單的三角洲行動項目。",
    customId: "game_order_select_delta",
    options: [
      { label: "電腦版", value: "pc", description: "三角洲行動｜電腦版" },
      { label: "手機版", value: "mobile", description: "三角洲行動｜手機版" },
      {
        label: "購買星雨幣",
        value: "topup",
        description: "建立購買星雨幣訂單",
      },
    ],
  },
  {
    envKey: "APEX_ORDER_CHANNEL",
    panelName: "apex",
    title: "🔺 Apex 下單區",
    description: "請選擇你要下單的 Apex 項目。",
    customId: "game_order_select_apex",
    options: [
      { label: "大神陪玩", value: "god", description: "Apex｜大神陪玩" },
      { label: "技術陪玩", value: "skill", description: "Apex｜技術陪玩" },
      { label: "娛樂陪玩", value: "entertain", description: "Apex｜娛樂陪玩" },
      {
        label: "購買星雨幣",
        value: "topup",
        description: "建立購買星雨幣訂單",
      },
    ],
  },
  {
    envKey: "LOL_ORDER_CHANNEL",
    panelName: "lol",
    title: "🧙 英雄聯盟下單區",
    description: "請先選擇英雄聯盟項目，下一步再選大神 / 技術 / 娛樂。",
    customId: "game_order_select_lol",
    options: [
      { label: "英雄聯盟", value: "lol_main", description: "召喚峽谷" },
      { label: "ARAM", value: "aram", description: "咆哮深淵" },
      { label: "聯盟戰棋", value: "tft", description: "Teamfight Tactics" },
      {
        label: "購買星雨幣",
        value: "topup",
        description: "建立購買星雨幣訂單",
      },
    ],
  },
  {
    envKey: "STEAM_ORDER_CHANNEL",
    panelName: "steam",
    title: "🎮 Steam 下單區",
    description: "請選擇你要下單的 Steam 遊戲類型。",
    customId: "game_order_select_steam",
    options: [
      { label: "肉鴿遊戲", value: "roguelike", description: "Steam｜肉鴿遊戲" },
      { label: "生存遊戲", value: "survival", description: "Steam｜生存遊戲" },
      { label: "恐怖遊戲", value: "horror", description: "Steam｜恐怖遊戲" },
      { label: "派對遊戲", value: "party", description: "Steam｜派對遊戲" },
      {
        label: "購買星雨幣",
        value: "topup",
        description: "建立購買星雨幣訂單",
      },
    ],
  },
  {
    envKey: "OTHER_ORDER_CHANNEL",
    panelName: "other",
    title: "🌙 其他項目下單區",
    description: "請選擇你要下單的其他服務項目。",
    customId: "game_order_select_other",
    options: [
      { label: "PUBG M", value: "pubgm", description: "PUBG M" },
      { label: "NARAKA", value: "naraka", description: "NARAKA" },
      { label: "Minecraft", value: "minecraft", description: "Minecraft" },
      {
        label: "王者榮耀",
        value: "honor_of_kings",
        description: "王者榮耀｜娛樂／技術",
      },
      {
        label: "第五人格",
        value: "identity_v",
        description: "第五人格｜娛樂／四階～七階",
      },
      { label: "語音聊天", value: "voice_chat", description: "語音聊天" },
      { label: "點歌服務", value: "song", description: "點歌服務" },
      { label: "自訂輸入", value: "custom", description: "其他項目｜自訂需求" },
      {
        label: "購買星雨幣",
        value: "topup",
        description: "建立購買星雨幣訂單",
      },
    ],
  },
];

function findOptionLabel(panelName, value) {
  const panel = GAME_ORDER_PANELS.find((item) => item.panelName === panelName);

  const option = panel?.options.find((item) => item.value === value);

  return option?.label || value;
}
async function resetSelectMenuMessage(interaction) {
  try {
    if (!interaction.message || !interaction.message.components?.length) {
      return;
    }

    // 私人回覆中的選單無法透過一般頻道訊息 API 重設；後續流程會自行
    // 更新私人回覆，因此這裡直接略過，避免 Discord 回傳 Unknown Message。
    if (interaction.message.flags?.has(64)) return;

    const rows = interaction.message.components
      .map((row) => {
        const newRow = new ActionRowBuilder();

        for (const component of row.components) {
          // String Select Menu
          if (component.type === 3) {
            const menu = StringSelectMenuBuilder.from(component);

            const options = component.options.map((option) => ({
              label: option.label,
              value: option.value,
              description: option.description || undefined,
              emoji: option.emoji || undefined,
              default: false,
            }));

            menu.setOptions(options);
            newRow.addComponents(menu);
          }

          // Button
          if (component.type === 2) {
            newRow.addComponents(ButtonBuilder.from(component));
          }
        }

        return newRow;
      })
      .filter((row) => row.components.length > 0);

    if (!rows.length) return;

    await interaction.message.edit({
      components: rows,
    });
  } catch (err) {
    // 面板可能已被客服刪除。重設只影響外觀，不應讓已收到的互動失敗。
    if (Number(err?.code) === 10008) return;
    console.error("[下拉選單重置失敗]", {
      code: err?.code,
      message: err?.message,
      channelId: interaction.channelId,
      messageId: interaction.message?.id,
    });
  }
}
function buildPanelInitialData(gameKey, value) {
  const label = findOptionLabel(gameKey, value);

  if (gameKey === "valorant") {
    const valorantSelection = getValorantTypeSelection(value);

    return {
      category: "valorant",
      gameLabel: "特戰英豪",
      itemLabel: valorantSelection?.label || label,
      serviceType: valorantSelection?.label || label,
      serviceTypes: valorantSelection?.serviceTypes || [],
      playMode: valorantSelection?.label || label,
      playerCount: value === "skill_entertain" ? 2 : null,
      fromPanel: true,
    };
  }

  if (gameKey === "delta") {
    return {
      category: "delta",
      gameLabel: "三角洲行動",
      itemLabel: label, // 電腦版 / 手機版
      serviceType: `三角洲行動｜${label}`,
      deltaPlatform: label,
      deltaMode: null,
      fromPanel: true,
    };
  }

  if (gameKey === "apex") {
    return {
      category: "apex",
      gameLabel: "Apex",
      itemLabel: label,
      serviceType: `Apex｜${label}`,
      playMode: label,
      fromPanel: true,
    };
  }

  if (gameKey === "steam") {
    return {
      category: "steam",
      gameLabel: "Steam",
      itemLabel: label,
      serviceType: `Steam｜${label}`,
      steamCategory: label,
      fromPanel: true,
    };
  }

  if (gameKey === "other") {
    return {
      category: "other",
      gameLabel: "其他項目",
      itemLabel: label,
      serviceType: `其他項目｜${label}`,
      playMode: label,
      fromPanel: true,
    };
  }

  return {
    category: gameKey,
    gameLabel: getServiceName(gameKey),
    itemLabel: label,
    serviceType: `${getServiceName(gameKey)}｜${label}`,
    playMode: label,
    fromPanel: true,
  };
}

async function upsertGameOrderPanel(panel) {
  const channelId = process.env[panel.envKey];

  if (!channelId) {
    console.log(`[下單分區] 未設定 ${panel.envKey}`);
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);

  if (!channel) {
    console.log(`[下單分區] 找不到頻道：${panel.envKey}`);
    return;
  }

  const embed = new EmbedBuilder()
    .setColor("#cdb4db")
    .setTitle(panel.title)
    .setDescription(
      `${panel.description}\n\n` +
        `選到「購買星雨幣」會建立購買訂單。\n` +
        `選到「打賞」會建立打賞頻道。\n` +
        `選其他項目會建立專屬臨時下單頻道。`
    )
    .setFooter({
      text: "深夜不關燈｜We Are Still Here",
    })
    .setTimestamp();

  const menu = new StringSelectMenuBuilder()
    .setCustomId(panel.customId)
    .setPlaceholder("請選擇下單項目")
    .addOptions(
      panel.options.map((option) => ({
        label: option.label.slice(0, 100),
        description: option.description.slice(0, 100),
        value: option.value,
      }))
    );

  const row = new ActionRowBuilder().addComponents(menu);

  const messages = await channel.messages
    .fetch({
      limit: 10,
    })
    .catch(() => null);

  const oldPanel = messages?.find(
    (msg) =>
      msg.author.id === client.user.id &&
      msg.embeds.length > 0 &&
      msg.embeds[0].title === panel.title
  );

  if (oldPanel) {
    await oldPanel.edit({
      embeds: [embed],
      components: [row],
    });
    console.log(`[下單分區] 已更新：${panel.title}`);
    return;
  }

  await channel.send({
    embeds: [embed],
    components: [row],
  });

  console.log(`[下單分區] 已建立：${panel.title}`);
}

async function sendGameOrderPanels() {
  for (const panel of GAME_ORDER_PANELS) {
    await upsertGameOrderPanel(panel);
  }
}

async function sendTipOrderPanel() {
  const channel = await client.channels
    .fetch(TIP_ORDER_PANEL_CHANNEL_ID)
    .catch(() => null);

  if (!channel) {
    throw new Error(`找不到打賞下單頻道：${TIP_ORDER_PANEL_CHANNEL_ID}`);
  }

  const embed = new EmbedBuilder()
    .setColor("#ff99cc")
    .setTitle("💝 打賞下單區")
    .setDescription(
      `想支持喜歡的陪陪嗎？請點擊下方按鈕建立專屬打賞頻道。\n\n` +
        `可建立一般打賞單或冠名單，完成後選擇陪陪及付款方式。`,
    )
    .setFooter({ text: "深夜不關燈｜打賞系統" })
    .setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("order_start_tip")
      .setLabel("建立打賞單")
      .setEmoji("💝")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("order_start_crown")
      .setLabel("建立冠名單")
      .setEmoji("👑")
      .setStyle(ButtonStyle.Primary),
  );
  const messages = await channel.messages.fetch({ limit: 20 });
  const oldPanel = messages.find(
    (message) =>
      message.author.id === client.user.id &&
      message.embeds[0]?.title === "💝 打賞下單區",
  );

  if (oldPanel) {
    await oldPanel.edit({ embeds: [embed], components: [row] });
    console.log("[TIP PANEL] 已更新");
    return oldPanel;
  }

  const message = await channel.send({ embeds: [embed], components: [row] });
  console.log("[TIP PANEL] 已建立");
  return message;
}

async function handleGameOrderSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const gameKey = interaction.customId.replace("game_order_select_", "");

  const value = interaction.values[0];

  await resetSelectMenuMessage(interaction);

  if (value === "topup") {
    return await createTopupTicket(interaction);
  }

  if (value === "tip") {
    return await createTipTicket(interaction);
  }

  if (gameKey === "lol") {
    const flowId = createFlowId(interaction.user.id);

    pendingPanelOrders.set(flowId, {
      userId: interaction.user.id,
      gameKey,
      lolMode: value,
    });

    setTimeout(() => {
      pendingPanelOrders.delete(flowId);
    }, ORDER_FLOW_TTL_MS);

    const modeLabel = findOptionLabel("lol", value);

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`lol_style_select_${flowId}`)
      .setPlaceholder("請選擇陪玩類型")
      .addOptions([
        {
          label: "大神陪玩",
          value: "god",
          description: `${modeLabel}｜大神陪玩`,
        },
        {
          label: "技術陪玩",
          value: "skill",
          description: `${modeLabel}｜技術陪玩`,
        },
        {
          label: "娛樂陪玩",
          value: "entertain",
          description: `${modeLabel}｜娛樂陪玩`,
        },
      ]);

    const row = new ActionRowBuilder().addComponents(menu);

    return await interaction.editReply({
      content:
        `你選擇的是：${modeLabel}\n\n` +
        `請再選擇大神陪玩 / 技術陪玩 / 娛樂陪玩：`,
      components: [row],
    });
  }

  if (gameKey === "other" && ["honor_of_kings", "identity_v"].includes(value)) {
    const flowId = createFlowId(interaction.user.id);
    const gameLabel = findOptionLabel("other", value);

    pendingPanelOrders.set(flowId, {
      userId: interaction.user.id,
      gameKey,
      otherGame: value,
      gameLabel,
    });

    setTimeout(() => pendingPanelOrders.delete(flowId), ORDER_FLOW_TTL_MS);

    const options =
      value === "honor_of_kings"
        ? [
            {
              label: "娛樂",
              value: "entertain",
              description: "王者榮耀｜娛樂",
            },
            { label: "技術", value: "skill", description: "王者榮耀｜技術" },
          ]
        : [
            {
              label: "娛樂",
              value: "entertain",
              description: "第五人格｜娛樂",
            },
            { label: "四階", value: "rank_4", description: "第五人格｜四階" },
            { label: "五階", value: "rank_5", description: "第五人格｜五階" },
            { label: "六階", value: "rank_6", description: "第五人格｜六階" },
            { label: "七階", value: "rank_7", description: "第五人格｜七階" },
          ];

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`other_game_style_select_${flowId}`)
      .setPlaceholder(`請選擇${gameLabel}項目`)
      .addOptions(options);

    return interaction.editReply({
      content: `你選擇的是：${gameLabel}\n\n請選擇服務項目：`,
      components: [new ActionRowBuilder().addComponents(menu)],
    });
  }

  const initial = buildPanelInitialData(gameKey, value);

  return await createServiceTicket(interaction, initial.category, initial);
}

async function handleOtherGameStyleSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: 64 });
  }

  const flowId = interaction.customId.replace("other_game_style_select_", "");
  const pending = pendingPanelOrders.get(flowId);
  await resetSelectMenuMessage(interaction);

  if (!pending || pending.userId !== interaction.user.id) {
    return interaction.editReply({
      content: "❌ 這個選單已過期，請回其他項目下單區重新選擇。",
      components: [],
    });
  }

  const value = interaction.values[0];
  const labels = {
    entertain: "娛樂",
    skill: "技術",
    rank_4: "四階",
    rank_5: "五階",
    rank_6: "六階",
    rank_7: "七階",
  };
  const itemLabel = labels[value] || value;
  pendingPanelOrders.delete(flowId);

  return createServiceTicket(interaction, "other", {
    category: "other",
    gameLabel: pending.gameLabel,
    itemLabel,
    serviceType: `${pending.gameLabel}｜${itemLabel}`,
    playMode: itemLabel,
    fromPanel: true,
  });
}

async function handleLolStyleSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(async () => {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({
          flags: 64,
        });
      }
    });
  }

  const flowId = interaction.customId.replace("lol_style_select_", "");

  await resetSelectMenuMessage(interaction);

  const pending = pendingPanelOrders.get(flowId);

  if (!pending) {
    return await interaction.editReply({
      content: "❌ 這個選單已過期，請回英雄聯盟下單區重新選擇。",
      components: [],
    });
  }

  if (pending.userId !== interaction.user.id) {
    return await interaction.editReply({
      content: "❌ 只有剛剛選擇英雄聯盟項目的人可以操作。",
      components: [],
    });
  }

  const modeLabel = findOptionLabel("lol", pending.lolMode);

  const styleMap = {
    god: "大神陪玩",
    skill: "技術陪玩",
    entertain: "娛樂陪玩",
  };

  const styleLabel = styleMap[interaction.values[0]] || interaction.values[0];

  pendingPanelOrders.delete(flowId);

  return await createServiceTicket(interaction, "lol", {
    category: "lol",
    gameLabel: "英雄聯盟",
    itemLabel: modeLabel,
    serviceType: `${modeLabel}｜${styleLabel}`,
    playMode: styleLabel,
    fromPanel: true,
  });
}

async function sendQuickServiceNeedPanel(channel, flowId, initial = {}) {
  const countMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_player_count_${flowId}`)
    .setPlaceholder("請選擇陪陪人數")
    .addOptions([
      { label: "1 位", value: "1" },
      { label: "2 位", value: "2" },
      { label: "3 位", value: "3" },
      { label: "4 位", value: "4" },
    ]);

  const genderMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_gender_${flowId}`)
    .setPlaceholder("請選擇陪陪性別偏好")
    .addOptions([
      { label: "不指定", value: "不指定" },
      { label: "男陪", value: "男陪" },
      { label: "女陪", value: "女陪" },
    ]);

  const assignMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_assign_${flowId}`)
    .setPlaceholder("是否指定陪陪")
    .addOptions([
      { label: "不指定陪陪", value: "不指定" },
      { label: "指定陪陪", value: "指定" },
      { label: "預約指定陪陪", value: "預約指定" },
    ]);

  const durationMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_duration_${flowId}`)
    .setPlaceholder("請選擇時間")
    .addOptions([
      { label: "30 分鐘", value: "0.5" },
      { label: "1 小時", value: "1" },
      { label: "1.5 小時", value: "1.5" },
      { label: "2 小時", value: "2" },
      { label: "自訂", value: "custom" },
    ]);

  const roundsMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_rounds_${flowId}`)
    .setPlaceholder("請選擇局數")
    .addOptions([
      { label: "1 局", value: "1" },
      { label: "3 局", value: "3" },
      { label: "5 局", value: "5" },
      { label: "自訂", value: "custom" },
    ]);

  const valorantRankMenu = new StringSelectMenuBuilder()
    .setCustomId(`valorant_rank_${flowId}`)
    .setPlaceholder("請選擇目前段位")
    .addOptions([
      { label: "鐵牌", value: "鐵牌" },
      { label: "銅牌", value: "銅牌" },
      { label: "銀牌", value: "銀牌" },
      { label: "金牌", value: "金牌" },
      { label: "白金", value: "白金" },
      { label: "鑽石", value: "鑽石" },
      { label: "超凡", value: "超凡" },
      { label: "神話", value: "神話" },
      { label: "輻能", value: "輻能" },
      { label: "不指定 / 尚未確認", value: "不指定" },
    ]);
  const apexRankMenu = new StringSelectMenuBuilder()
    .setCustomId(`apex_rank_${flowId}`)
    .setPlaceholder("請選擇 Apex 目前段位")
    .addOptions([
      { label: "菜鳥", value: "菜鳥" },
      { label: "青銅", value: "青銅" },
      { label: "白銀", value: "白銀" },
      { label: "黃金", value: "黃金" },
      { label: "白金", value: "白金" },
      { label: "鑽石", value: "鑽石" },
      { label: "大師", value: "大師" },
      { label: "頂尖獵殺者", value: "頂尖獵殺者" },
      { label: "不指定 / 尚未確認", value: "不指定" },
    ]);
  const lolRankMenu = new StringSelectMenuBuilder()
    .setCustomId(`lol_rank_${flowId}`)
    .setPlaceholder("請選擇英雄聯盟段位 / 娛樂")
    .addOptions([
      { label: "娛樂", value: "娛樂", description: "不看段位，娛樂陪玩" },
      { label: "黑鐵", value: "黑鐵" },
      { label: "銅牌", value: "銅牌" },
      { label: "銀牌", value: "銀牌" },
      { label: "金牌", value: "金牌" },
      { label: "白金", value: "白金" },
      { label: "翡翠", value: "翡翠" },
      { label: "鑽石", value: "鑽石" },
      { label: "大師", value: "大師" },
      { label: "宗師", value: "宗師" },
      { label: "菁英", value: "菁英" },
      { label: "不指定 / 尚未確認", value: "不指定" },
    ]);
  const deltaModeMenu = new StringSelectMenuBuilder()
    .setCustomId(`delta_mode_${flowId}`)
    .setPlaceholder("請選擇三角洲服務內容")
    .addOptions([
      {
        label: "娛樂陪玩",
        value: "娛樂陪玩",
        description: "一般娛樂陪玩",
      },
      {
        label: "基本單護",
        value: "基本單護",
        description: "基本單人護航",
      },
      {
        label: "機密雙護",
        value: "機密雙護",
        description: "機密雙人護航",
      },
      {
        label: "機密雙護（有保底）",
        value: "機密雙護（有保底）",
        description: "機密雙護含保底",
      },
      {
        label: "猛攻護航",
        value: "猛攻護航",
        description: "猛攻模式護航",
      },
      {
        label: "猛攻護航（有保底）",
        value: "猛攻護航（有保底）",
        description: "猛攻護航含保底",
      },
    ]);

  const isDeltaOrder = initial.category === "delta";
  const isTftOrder =
    initial.category === "lol" && initial.itemLabel === "聯盟戰棋";
  const isApexOrder = initial.category === "apex";
  const isLolOrder = initial.category === "lol";
  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`order_add_note_${flowId}`)
      .setLabel("填寫備註 / 自訂需求")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId(`order_finish_need_${flowId}`)
      .setLabel("送出訂單")
      .setEmoji("📨")
      .setStyle(ButtonStyle.Success)
  );

  if (initial.category === "steam") {
    buttonRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`steam_game_name_${flowId}`)
        .setLabel("輸入 Steam 遊戲名稱")
        .setStyle(ButtonStyle.Primary)
    );
  }

  const needRows = [
    ...(initial.category === "valorant"
      ? [new ActionRowBuilder().addComponents(valorantRankMenu)]
      : []),

    ...(isApexOrder
      ? [new ActionRowBuilder().addComponents(apexRankMenu)]
      : []),

    ...(isLolOrder ? [new ActionRowBuilder().addComponents(lolRankMenu)] : []),

    ...(isDeltaOrder
      ? [new ActionRowBuilder().addComponents(deltaModeMenu)]
      : []),

    new ActionRowBuilder().addComponents(countMenu),
    new ActionRowBuilder().addComponents(genderMenu),
    new ActionRowBuilder().addComponents(assignMenu),

    ...(initial.category === "valorant"
      ? []
      : isTftOrder
      ? [new ActionRowBuilder().addComponents(roundsMenu)]
      : [new ActionRowBuilder().addComponents(durationMenu)]),
  ];

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#ffd166")
        .setTitle("📋 下單需求填寫")
        .setDescription(
          `已選擇：${
            initial.serviceType || initial.itemLabel || "未填寫"
          }\n\n` +
            `請依序選擇${isDeltaOrder ? "服務內容、" : ""}${
              isApexOrder ? "段位、" : ""
            }${isLolOrder ? "段位 / 娛樂、" : ""}人數、性別偏好、指定方式與${
              isTftOrder ? "局數" : "時間"
            }。\n` +
            `有特殊需求可以按「填寫備註 / 自訂需求」。\n\n` +
            `填寫完成後請按「送出訂單」，客服會協助正式報價。`
        )
        .setTimestamp(),
    ],
    components: needRows.slice(0, 5),
  });

  await channel.send({
    components: [buttonRow],
  });
}
function setup(supabaseInstance, clientInstance, helpers = {}) {
  supabase = supabaseInstance;
  client = clientInstance;
  paymentHelpers = helpers;
  workReportSystem = createWorkReportSystem({
    supabase,
    client,
    appKey: "deepnight",
    guildId: process.env.GUILD_ID || "1501098191813214312",
    reportGuildId: DEEPNIGHT_STAFF_DISCORD_GUILD_ID,
    manualChannelId: "1525872495331377372",
    staffTable: STAFF_TABLE,
    staffRoleId:
      process.env.STAFF_ROLE ||
      process.env.STAFF_ROLE_ID ||
      "1501271090918326362",
    customerServiceRoleId:
      [
        process.env.CUSTOMER_SERVICE_ROLE_ID,
        process.env.CUSTOMER_SERVICE_ROLE_IDS,
        "1501271090918326362",
        "1502010574781943989",
      ]
        .filter(Boolean)
        .join(","),
    salaryTable: "play_orders",
  });
}
function getStaffGuildId() {
  return process.env.STAFF_GUILD_ID || process.env.GUILD_ID;
}
function applyStaffGuildFilter(query) {
  return query;
}

async function isActiveDeepnightStaff(discordId) {
  const normalizedDiscordId = String(discordId || "").trim();
  if (!normalizedDiscordId) return false;
  const { data, error } = await supabase
    .from("players")
    .select("discord_id,guild_id,is_active")
    .eq("discord_id", normalizedDiscordId)
    .eq("is_active", true);
  if (error) {
    console.error("[付款方式] 讀取員工身分失敗", error);
    return false;
  }
  return (data || []).some((row) => {
    const guildIds = String(row.guild_id || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return guildIds.length === 0 || guildIds.includes(DEEPNIGHT_GUILD_ID);
  });
}

function getStaffDisplayName(staff) {
  return String(
    staff?.display_name ||
      staff?.real_name ||
      staff?.discord_name ||
      staff?.name ||
      staff?.discord_id ||
      "未知員工"
  );
}
function getBillingMonth(date = new Date()) {
  const taiwanDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);

  return taiwanDate.toISOString().slice(0, 7);
}
function isCardPayment(text = "") {
  const value = String(text || "");
  return (
    value.includes("街口支付") ||
    value.includes("街口掃碼") ||
    value.includes("刷卡") ||
    value.includes("信用卡") ||
    value.includes("card")
  );
}
function isNoCardPayment(text = "") {
  return text.includes("無卡") || text.includes("無卡存款");
}
function isBankTransfer(text = "") {
  return text.includes("匯款") || text.includes("轉帳");
}
function isWalletPayment(text = "") {
  const value = String(text || "");
  return value.includes("儲值卡") || value.includes("錢包") || value.includes("餘額");
}
function isMonthlyPayment(text = "") {
  const value = String(text || "");
  return value.includes("月結") || value.includes("月結付款") || value.includes("月結會員");
}

async function sendJkopayPaymentPrompt(channel, userId, amount, payment, label) {
  const message = await channel.send({
    content: `<@${userId}>`,
    embeds: [new EmbedBuilder().setColor("#E94B5F").setTitle(`📱 ${label}街口支付`).setDescription(
      `應付金額：NT$${Number(amount).toLocaleString("zh-TW")}\n` +
        `街口訂單編號：${payment.platformOrderId}\n\n` +
        "可按下方按鈕開啟街口付款頁，或掃描收款碼付款。線上付款完成後會自動核帳；使用掃碼付款請上傳付款截圖，請勿重複付款。",
    ).setImage("attachment://jkopay-deepnight.png").setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("使用街口支付").setEmoji("📱").setStyle(ButtonStyle.Link).setURL(payment.paymentUrl),
    )],
    files: [{ attachment: JKOPAY_QR_CODE_PATH, name: "jkopay-deepnight.png" }],
  });
  await paymentHelpers.attachJkopayPaymentMessage?.(payment.platformOrderId, message.id);
  return message;
}

async function sendEcpayPaymentPrompt(channel, userId, amount, payment, label) {
  const message = await channel.send({
    content: `<@${userId}>`,
    embeds: [new EmbedBuilder().setColor("#168B50").setTitle(`💳 ${label}綠界支付`).setDescription(
      `應付金額：NT$${Number(amount).toLocaleString("zh-TW")}\n` +
        `綠界訂單編號：${payment.platformOrderId}\n\n` +
        "請按下方按鈕選擇適用的綠界付款方式；實際付款成功後才會自動核帳，請勿重複付款。",
    ).setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("使用綠界支付").setEmoji("💳").setStyle(ButtonStyle.Link).setURL(payment.paymentUrl),
    )],
  });
  await paymentHelpers.attachEcpayPaymentMessage?.(payment.platformOrderId, message.id);
  return message;
}

async function sendBankTransferInfo(channel) {
  const embed = new EmbedBuilder()
    .setColor("#ffd166")
    .setTitle("🏦 匯款轉帳資訊")
    .setDescription(
      `請依照以下資訊完成匯款：\n\n` +
        `銀行：824連線銀行\n` +
        `分行：6880總行（非必填）\n` +
        `帳號：312000002665\n` +
        `戶名：深夜不關燈工作室\n` +
        `備註：（麻煩空白即可）\n\n` +
        `也可以掃描下方 QR Code 付款。\n\n` +
        `匯款完成後，請在此頻道上傳匯款截圖，等待客服確認。\n\n` +
        `若有其他銀行之需求，請在下方告訴客服。`
    )
    .setFooter({
      text: "請確認金額正確後再匯款",
    })
    .setTimestamp();

  await channel.send({
    embeds: [embed.setImage("attachment://bank-transfer-line-bank.png")],
    files: [
      {
        attachment: BANK_TRANSFER_QR_CODE_PATH,
        name: "bank-transfer-line-bank.png",
      },
    ],
  });
}
async function sendNoCardPaymentInfo(channel) {
  const embed = new EmbedBuilder()
    .setColor("#ffd166")
    .setTitle("🏧 中信無卡資訊")
    .setDescription(
      `請依照以下資訊完成無卡付款：\n\n` +
        `銀行：中國信託\n` +
        `銀行代碼：822\n` +
        `帳號：901565426642\n` +
        `戶名：許O星\n\n` +
        `或是\n\n` +
        `銀行：國泰世華\n` +
        `銀行代碼：013\n` +
        `帳號：134500100962\n` +
        `戶名：許O星\n\n` +
        `付款完成後，請在此頻道上傳存款明細，等待客服確認。`
    )
    .setFooter({
      text: "請確認金額正確後再付款",
    })
    .setTimestamp();

  await channel.send({
    embeds: [embed],
  });
}
async function sendCardPaymentInfo(channel) {
  const embed = new EmbedBuilder()
    .setColor("#ef1b24")
    .setTitle("📱 街口支付")
    .setDescription(
      `請使用街口支付掃描下方收款碼完成付款；也可在街口付款頁面選擇信用卡。\n\n` +
        `付款完成後，請在此頻道上傳付款成功截圖，等待客服確認。\n\n` +
        `截圖請包含：\n` +
        `1. 付款成功畫面\n` +
        `2. 付款金額\n` +
        `3. 交易時間或交易編號`
    )
    .setFooter({
      text: "請確認金額正確後再付款",
    })
    .setTimestamp();

  await channel.send({
    embeds: [embed.setImage("attachment://jkopay-deepnight.png")],
    files: [
      {
        attachment: JKOPAY_QR_CODE_PATH,
        name: "jkopay-deepnight.png",
      },
    ],
  });
}
async function applyExtensionToPlayOrder(extension) {
  const amount = Number(extension.amount || 0);

  if (!amount || amount <= 0) {
    throw new Error("加時金額錯誤");
  }

  const { data, error } = await supabase.rpc(
    "deepnight_apply_extension_to_order",
    {
      p_extension_id: Number(extension.id),
      p_customer_id: String(extension.customer_id || ""),
      p_guild_id: DEEPNIGHT_GUILD_ID,
    },
  );
  if (error || !data?.order || !data?.extension) {
    console.error("[加時進薪資網] 原子套用失敗", error);
    throw new Error(error?.message || "原子套用加時失敗");
  }
  const updatedOrder = data.order;
  const lockedExtension = data.extension;
  const oldPrice = Number(data.old_price || 0);
  const newPrice = Number(data.new_price || 0);

  // 加時是獨立的一段服務：原訂單更新總價，同時在每位陪陪的填單區
  // 建立一張可報時的新單。createReports 以 extension id 去重，不會重複建立。
  const { data: currentBeforeSend } = await supabase
    .from("order_extensions")
    .select("paid,status")
    .eq("id", extension.id)
    .eq("guild_id", DEEPNIGHT_GUILD_ID)
    .maybeSingle();
  if (!currentBeforeSend?.paid || currentBeforeSend.status !== "paid") {
    throw new Error("加時狀態已改變，未建立工時面板");
  }
  const extensionReports = await workReportSystem.sendForPaidExtension(
    lockedExtension,
    updatedOrder
  );
  const { data: currentAfterSend } = await supabase
    .from("order_extensions")
    .select("paid,status")
    .eq("id", extension.id)
    .eq("guild_id", DEEPNIGHT_GUILD_ID)
    .maybeSingle();
  if (!currentAfterSend?.paid || currentAfterSend.status !== "paid") {
    await supabase
      .from("play_orders")
      .update({ is_deleted: true, status: "refunded" })
      .like("order_id", `WORK-EXT-${extension.id}-%`)
      .eq("guild_id", DEEPNIGHT_GUILD_ID)
      .is("wallet_settled_at", null);
    throw new Error("工時面板建立期間加時已退款，已停用報單");
  }

  return {
    order: updatedOrder,
    oldPrice,
    newPrice,
    amount,
    extensionReportCount: extensionReports.length,
  };
}
function formatAvailableTime(player) {
  const time = player.available_time || {};

  if (!time || Object.keys(time).length === 0) {
    return "未填寫可接時間";
  }

  if (time.mode === "daily") {
    return `每天 ${time.daily || "未填寫"}`;
  }

  if (time.mode === "weekday_holiday") {
    return `平日 ${time.weekday || "未填寫"}｜假日 ${time.holiday || "未填寫"}`;
  }

  if (time.mode === "weekly") {
    const parts = [
      ["一", time.monday],
      ["二", time.tuesday],
      ["三", time.wednesday],
      ["四", time.thursday],
      ["五", time.friday],
      ["六", time.saturday],
      ["日", time.sunday],
    ]
      .filter(([, value]) => value)
      .map(([day, value]) => `週${day} ${value}`);

    return parts.length ? parts.join("｜") : "未填寫可接時間";
  }

  return "未填寫可接時間";
}
function normalizeAllowedServices(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);

      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch {}

    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function matchPlayerService(player, keyword) {
  const allowedServices = normalizeAllowedServices(player.allowed_services);

  // 沒設定服務，就先不讓他出現在選單，避免誤接技術單
  if (!allowedServices.length) return false;

  const target = String(keyword || "")
    .replace(/\s+/g, "")
    .trim();

  return allowedServices.some((service) => {
    const serviceText = String(service || "")
      .replace(/\s+/g, "")
      .trim();

    return serviceText === target;
  });
}

function matchPlayerGender(player, genderPreference) {
  if (
    !genderPreference ||
    genderPreference === "不指定" ||
    genderPreference === "男女皆可"
  ) {
    return true;
  }

  const gender = String(player.gender || "").trim();

  if (genderPreference === "男陪") {
    return gender === "男" || gender.includes("男");
  }

  if (genderPreference === "女陪") {
    return gender === "女" || gender.includes("女");
  }

  return true;
}
function cleanServiceKey(text = "") {
  return String(text || "")
    .replace(/\s+/g, "")
    .replace(/[｜|]/g, "")
    .replace(/　/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function getRequiredServiceRoleIdsFromPending(pending = {}) {
  const game = cleanServiceKey(pending.game || pending.category || "");

  const item = cleanServiceKey(
    pending.item ||
      pending.serviceType ||
      pending.service ||
      pending.playMode ||
      pending.deltaMode ||
      pending.steamCategory ||
      ""
  );

  const combined = `${game}${item}`;

  // ===== 特戰英豪 =====
  if (
    game.includes("特戰英豪") ||
    game.includes("valorant") ||
    pending.category === "valorant"
  ) {
    if (item.includes("娛樂") || combined.includes("娛樂")) {
      return [process.env.VALORANT_ENTERTAIN_ROLE_ID].filter(Boolean);
    }

    if (item.includes("技術") || combined.includes("技術")) {
      return [process.env.VALORANT_SKILL_ROLE_ID].filter(Boolean);
    }

    return [process.env.VALORANT_ENTERTAIN_ROLE_ID].filter(Boolean);
  }

  // ===== 三角洲 =====
  if (
    game.includes("三角洲") ||
    game.includes("delta") ||
    pending.category === "delta"
  ) {
    if (
      item.includes("娛樂") ||
      item.includes("一般") ||
      combined.includes("娛樂") ||
      combined.includes("一般")
    ) {
      return [process.env.DELTA_ENTERTAIN_ROLE_ID].filter(Boolean);
    }

    if (
      item.includes("雙護") ||
      item.includes("猛攻") ||
      item.includes("護航") ||
      item.includes("單護")
    ) {
      return [process.env.DELTA_SKILL_ROLE_ID].filter(Boolean);
    }

    return [process.env.DELTA_ENTERTAIN_ROLE_ID].filter(Boolean);
  }

  // ===== Steam =====
  if (
    game.includes("Steam") ||
    game.includes("steam") ||
    pending.category === "steam"
  ) {
    return [process.env.STEAM_ROLE_ID].filter(Boolean);
  }

  // ===== 絕地求生 PUBG =====
  if (
    game.includes("絕地求生") ||
    game.includes("PUBG") ||
    game.includes("pubg") ||
    pending.category === "pubg"
  ) {
    return [process.env.PUBG_ROLE_ID].filter(Boolean);
  }

  // ===== 陪聊 =====
  if (
    game.includes("陪聊") ||
    item.includes("陪聊") ||
    pending.category === "chat"
  ) {
    return [process.env.CHAT_ROLE_ID].filter(Boolean);
  }

  // ===== 出氣包 =====
  if (
    game.includes("出氣") ||
    item.includes("出氣") ||
    pending.category === "emotion"
  ) {
    return [process.env.EMOTION_ROLE_ID].filter(Boolean);
  }

  return [];
}
function getAllServiceRoleIds() {
  return [
    process.env.VALORANT_ENTERTAIN_ROLE_ID,
    process.env.VALORANT_SKILL_ROLE_ID,

    process.env.DELTA_ENTERTAIN_ROLE_ID,
    process.env.DELTA_SKILL_ROLE_ID,

    process.env.STEAM_ROLE_ID,
    process.env.PUBG_ROLE_ID,

    process.env.CHAT_ROLE_ID,
    process.env.EMOTION_ROLE_ID,
  ].filter(Boolean);
}

function memberHasAnyServiceRole(member) {
  const serviceRoleIds = getAllServiceRoleIds();

  if (!serviceRoleIds.length) {
    return false;
  }

  return serviceRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

async function memberHasRequiredServiceRole(
  guild,
  userId,
  requiredRoleIds = []
) {
  if (!requiredRoleIds.length) {
    return false;
  }

  const member = await guild.members.fetch(userId).catch(() => null);

  if (!member) return false;

  return requiredRoleIds.some((roleId) => member.roles.cache.has(roleId));
}
async function getQualifiedPlayerOptions(pending) {
  let playerQuery = supabase
    .from(STAFF_TABLE)
    .select("*")
    .not("discord_id", "is", null)
    .order("status", { ascending: true });

  playerQuery = applyStaffGuildFilter(playerQuery);

  const { data: players, error } = await playerQuery;

  if (error) {
    console.error("[新下單] 讀取陪陪失敗", error);
    return [];
  }

  const serviceKeyword = getServiceKeywordFromPending(pending);

  const seenPlayerIds = new Set();

  const filtered = (players || []).filter((player) => {
    const id = String(player.discord_id || "").trim();

    if (!id) return false;

    if (seenPlayerIds.has(id)) {
      return false;
    }

    seenPlayerIds.add(id);

    if (
      !matchPlayerGender(player, pending.gender || pending.genderPreference)
    ) {
      return false;
    }

    const allowedServices = normalizeAllowedServices(player.allowed_services);

    // 沒有設定可接服務，不顯示
    if (!allowedServices.length) return false;

    return matchAllowedServiceName(allowedServices, serviceKeyword);
  });

  const onlinePlayers = filtered.filter(
    (player) => player.status === "available"
  );

  const offlinePlayers = filtered.filter(
    (player) => player.status !== "available"
  );

  const options = [
    {
      label: "不指定陪陪",
      description: "由客服協助安排適合的陪陪",
      value: "none",
    },

    ...onlinePlayers.map((player) => ({
      label: `🟢 ${getStaffDisplayName(player)}`.slice(0, 100),
      description: "目前在線，可直接安排".slice(0, 100),
      value: `online_${player.discord_id}`,
    })),

    ...offlinePlayers.map((player) => ({
      label: `⚪ ${getStaffDisplayName(player)}`.slice(0, 100),
      description: formatAvailableTime(player).slice(0, 100),
      value: `reserve_${player.discord_id}`,
    })),
  ];

  return options.slice(0, 25);
}
async function getAvailablePlayerOptions(service) {
  let playerQuery = supabase
    .from(STAFF_TABLE)
    .select("*")
    .eq("status", "available")
    .not("discord_id", "is", null);

  playerQuery = applyStaffGuildFilter(playerQuery);

  const { data: players, error } = await playerQuery;

  if (error) {
    console.error("[指定陪陪] 讀取可接單陪陪失敗", error);
    return [];
  }

  const targetService = cleanServiceKey(service || "");

  const seenPlayerIds = new Set();

  return (players || [])
    .filter((player) => {
      const id = String(player.discord_id || "").trim();

      if (!id) return false;

      if (seenPlayerIds.has(id)) {
        return false;
      }

      seenPlayerIds.add(id);

      if (!targetService) return true;

      const allowedServices = normalizeAllowedServices(player.allowed_services);

      if (!allowedServices.length) return false;

      return matchAllowedServiceName(allowedServices, targetService);
    })
    .slice(0, 24)
    .map((player) => ({
      label: getStaffDisplayName(player).slice(0, 100),
      description: formatAvailableTime(player).slice(0, 100),
      value: player.discord_id,
    }));
}
// ===== 派單紀錄 =====
async function sendPlayLog({ title, description, color = "#00ff99" }) {
  try {
    const channelId = String(process.env.PLAYER_LOG_CHANNEL || "").trim();
    if (!/^\d{16,22}$/.test(channelId)) return;
    const channel = await client.channels.fetch(channelId);

    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setDescription(description)
      .setTimestamp();

    await channel.send({
      embeds: [embed],
    });
  } catch (err) {
    console.log("[派單紀錄失敗]", err);
  }
}
async function playerOnline(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  let playerQuery = supabase
    .from(STAFF_TABLE)
    .select("*")
    .eq("discord_id", interaction.user.id)
    .limit(1);

  playerQuery = applyStaffGuildFilter(playerQuery);

  const { data: players, error } = await playerQuery;

  if (error) {
    console.error("[開始接單] 讀取 qiunai_staff 失敗:", error);

    return interaction.editReply({
      content: "❌ 讀取陪陪資料失敗，請稍後再試。",
    });
  }

  const player = players?.[0];

  if (!player) {
    return interaction.editReply({
      content: "❌ 你尚未登記陪玩，請先請管理員在後台新增你的陪玩資料。",
    });
  }

  let updateQuery = supabase
    .from(STAFF_TABLE)
    .update({
      status: "available",
      online_started_at: new Date().toISOString(),
    })
    .eq("discord_id", interaction.user.id);

  updateQuery = applyStaffGuildFilter(updateQuery);

  const { error: updateError } = await updateQuery;

  if (updateError) {
    console.error("[開始接單] 更新 qiunai_staff 狀態失敗:", updateError);

    return interaction.editReply({
      content: "❌ 開始接單失敗，請稍後再試。",
    });
  }

  return interaction.editReply({
    content: "🟢 你已開始接單。",
  });
}
function hasAllowedServicesFromDb(player) {
  if (!player) return false;

  const services = player.allowed_services;

  if (Array.isArray(services)) {
    return services.length > 0;
  }

  if (typeof services === "string") {
    return services.trim().length > 0;
  }

  return false;
}
// 陪玩下班
async function playerOffline(interaction) {
  let updateQuery = supabase
    .from(STAFF_TABLE)
    .update({
      status: "offline",
    })
    .eq("discord_id", interaction.user.id);

  updateQuery = applyStaffGuildFilter(updateQuery);

  await updateQuery;

  return interaction.editReply({
    content: "🔴 你已停止接單",
  });
}
function getTodayRangeTW() {
  const now = new Date();

  const taiwanNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);

  const dateText = taiwanNow.toISOString().slice(0, 10);

  const start = new Date(`${dateText}T00:00:00+08:00`);

  const end = new Date(`${dateText}T23:59:59+08:00`);

  return {
    dateText,
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

async function sendDailyPlayerSummary() {
  console.log("[每日陪玩總結] 已停用，保留 salary 端每日報告。");
  return;

  const { dateText, start, end } = getTodayRangeTW();

  const guildId = getStaffGuildId();
  let playerQuery = supabase.from(STAFF_TABLE).select("*");
  playerQuery = applyStaffGuildFilter(playerQuery);
  const { data: players, error: playerError } = await playerQuery;

  if (playerError) {
    console.log("[每日陪玩總結] 讀取陪玩失敗", playerError);
    return;
  }

  if (!players?.length) {
    return;
  }

  const buildOrderQuery = (timeColumn) => {
    let query = supabase
      .from("play_orders")
      .select("*")
      .gte(timeColumn, start)
      .lte(timeColumn, end);

    if (guildId) {
      query = query.or(`guild_id.eq.${guildId},guild_id.is.null`);
    }

    return query;
  };

  const orderMap = new Map();
  const timeColumns = [
    "order_finished_at",
    "completed_at",
    "accepted_at",
    "created_at",
  ];

  for (const timeColumn of timeColumns) {
    const { data, error } = await buildOrderQuery(timeColumn);

    if (error) {
      console.log(`[每日陪玩總結] 讀取 ${timeColumn} 訂單失敗`, error);
      continue;
    }

    for (const order of data || []) {
      const status = String(order.status || "").trim();

      if (order.is_deleted) continue;
      if (["cancelled", "canceled", "已取消", "取消"].includes(status))
        continue;

      orderMap.set(String(order.id), order);
    }
  }

  const orders = Array.from(orderMap.values());

  const getOrderPlayerIds = (order) => {
    const ids = [];
    const assignedPlayer = order.assigned_player;

    if (Array.isArray(assignedPlayer)) {
      ids.push(...assignedPlayer);
    } else if (assignedPlayer) {
      ids.push(
        ...String(assignedPlayer)
          .split(",")
          .map((id) => id.trim())
      );
    }

    ids.push(order.discord_id, order.staff_id, order.player_id);

    return new Set(
      ids
        .map((id) =>
          String(id || "")
            .replace(/[<@!>]/g, "")
            .trim()
        )
        .filter(Boolean)
    );
  };

  for (const player of players) {
    const playerOrders = orders.filter((order) =>
      getOrderPlayerIds(order).has(String(player.discord_id))
    );

    const totalOrders = playerOrders.length;

    const totalPrice = playerOrders.reduce(
      (sum, order) =>
        sum +
        Number(
          order.final_price ||
            order.order_amount ||
            order.group_total_price ||
            order.price ||
            0
        ),
      0
    );

    const orderList = playerOrders.length
      ? playerOrders
          .map((order, index) => {
            return (
              `${index + 1}. ${
                order.service ||
                order.service_name ||
                order.order_item ||
                "未填寫"
              }\n` +
              `訂單編號：${order.order_no || order.id}\n` +
              `金額：NT$${
                order.final_price ||
                order.order_amount ||
                order.group_total_price ||
                order.price ||
                0
              }\n` +
              `內容：${order.note || "無"}`
            );
          })
          .join("\n\n")
      : "今日尚無完成訂單";

    const embed = new EmbedBuilder()
      .setColor("#66ccff")
      .setTitle("📊 陪玩每日總結")
      .setDescription(
        `日期：${dateText}\n` +
          `陪玩：<@${player.discord_id}>\n\n` +
          `今日訂單：${totalOrders}\n` +
          `總金額：NT$${totalPrice}\n\n` +
          `━━━━━━━━━━\n\n` +
          `${orderList}`
      )
      .setTimestamp();

    if (player.report_channel_id) {
      const reportChannel = await client.channels
        .fetch(player.report_channel_id)
        .catch(() => null);

      if (reportChannel) {
        await reportChannel.send({
          embeds: [embed],
        });
      }
    }
  }

  console.log(`[每日陪玩總結] 已送出 ${dateText}`);
}
// 查看狀態
async function playerStatus(interaction) {
  let playerQuery = supabase
    .from(STAFF_TABLE)
    .select("*")
    .eq("discord_id", interaction.user.id)
    .limit(1);
  playerQuery = applyStaffGuildFilter(playerQuery);
  const { data: players, error } = await playerQuery;

  if (error) {
    console.error("[我的狀態] 讀取 players 失敗:", error);

    return interaction.editReply({
      content: "❌ 讀取陪玩狀態失敗，請稍後再試。",
    });
  }

  const data = players?.[0];

  if (!data) {
    return interaction.editReply({
      content: "你尚未登記陪玩，請先請管理員在後台新增你的陪玩資料。",
    });
  }

  return interaction.editReply({
    content:
      `📋 你的狀態：${data.status || "未設定"}\n` +
      `📦 完成單數：${data.total_orders || 0}\n` +
      `🎮 可接服務：不限制身分組`,
  });
}
function buildPreferredPlayerText(preferredPlayerIds) {
  if (!preferredPlayerIds) return "不指定";

  const ids = String(preferredPlayerIds)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (!ids.length) return "不指定";

  return ids.map((id) => `<@${id}>`).join("、");
}

function messageHasCustomId(message, customId) {
  return Boolean(
    message?.components?.some?.((row) =>
      row.components?.some?.(
        (component) =>
          String(component.customId || component.custom_id || "") === customId,
      ),
    ),
  );
}

async function findRecentBotMessage(channel, customId) {
  const recentMessages = await channel.messages
    .fetch({ limit: 100 })
    .catch(() => null);
  return (
    recentMessages?.find?.(
      (message) =>
        message.author?.id === client.user?.id &&
        messageHasCustomId(message, customId),
    ) || null
  );
}

async function checkpointOrderMessage(order, column, messageId) {
  const currentId = order[column] ? String(order[column]) : null;
  let update = supabase
    .from("play_orders")
    .update({ [column]: messageId, updated_at: new Date().toISOString() })
    .eq("id", order.id)
    .eq("guild_id", DEEPNIGHT_GUILD_ID);
  update = currentId
    ? update.eq(column, currentId)
    : update.is(column, null);
  const { data, error } = await update.select("id").maybeSingle();
  if (error) throw new Error(error.message || `保存 ${column} 失敗`);
  if (!data) {
    const { data: fresh, error: freshError } = await supabase
      .from("play_orders")
      .select(column)
      .eq("id", order.id)
      .eq("guild_id", DEEPNIGHT_GUILD_ID)
      .maybeSingle();
    if (freshError) throw new Error(freshError.message || `確認 ${column} 失敗`);
    if (String(fresh?.[column] || "") !== String(messageId)) {
      throw new Error(`${column} 已由其他補償程序更新`);
    }
  }
  order[column] = messageId;
}

async function sendOrderToStaffChannel(order) {
  const channel = await client.channels.fetch(process.env.PLAYER_ORDER_CHANNEL);

  if (order.dispatch_message_id) {
    const existingMessage = await channel.messages
      .fetch(String(order.dispatch_message_id))
      .catch(() => null);
    if (existingMessage) return existingMessage;
  }

  const recoveredMessage = await findRecentBotMessage(
    channel,
    `accept_play_order_${order.id}`,
  );
  if (recoveredMessage) {
    await checkpointOrderMessage(order, "dispatch_message_id", recoveredMessage.id);
    return recoveredMessage;
  }

  const preferredText = buildPreferredPlayerText(order.preferred_player);

  const embed = new EmbedBuilder()
    .setColor("#00ff99")
    .setTitle("📦 已建立新陪玩訂單")
    .addFields(
      {
        name: "📌 訂單編號",
        value: order.order_no || "未知",
        inline: true,
      },
      {
        name: "🌟 指定陪陪",
        value: preferredText,
        inline: true,
      },
      {
        name: "🎮 服務項目",
        value: order.service || "未填寫",
        inline: false,
      },
      {
        name: "🏅 段位",
        value: order.rank_preference || "不指定",
        inline: true,
      },
      {
        name: "👥 需要人數",
        value: `${Number(order.player_count || 1) || 1} 位`,
        inline: true,
      },
      {
        name: "🕒 預約時間",
        value: order.reserved_time || order.duration_text || "未填寫",
        inline: true,
      },
      {
        name: "💰 商品金額",
        value: `NT$${order.final_price || order.price || 0}`,
        inline: true,
      },
      {
        name: "📝 備註需求",
        value: order.note || "無",
        inline: false,
      }
    )
    .setFooter({
      text: "星雨派單系統",
    })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`accept_play_order_${order.id}`)
      .setLabel("接單")
      .setStyle(ButtonStyle.Success)
  );

  const playerRoleMention = process.env.PLAYER_ROLE_ID
    ? `<@&${process.env.PLAYER_ROLE_ID}>`
    : "";
  const message = await channel.send({
    content:
      order.dispatch_type === "reserve"
        ? `${playerRoleMention} 🕒 預約派單：<@${order.reserved_player}>｜時間：${order.reserved_time}`
        : order.preferred_player
        ? `${playerRoleMention} 🌟 指定陪陪派單：${preferredText}`
        : `${playerRoleMention} 📢 開放接單`,
    embeds: [embed],
    components: [row],
  });
  await checkpointOrderMessage(order, "dispatch_message_id", message.id);
  return message;
}
async function sendStaffOrderControlPanel(channel, order) {
  if (order.dispatch_control_message_id) {
    const existingMessage = await channel.messages
      .fetch(String(order.dispatch_control_message_id))
      .catch(() => null);
    if (existingMessage) return existingMessage;
  }
  const recoveredMessage = await findRecentBotMessage(
    channel,
    `staff_edit_order_${order.id}`,
  );
  if (recoveredMessage) {
    await checkpointOrderMessage(
      order,
      "dispatch_control_message_id",
      recoveredMessage.id,
    );
    return recoveredMessage;
  }
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`staff_edit_order_${order.id}`)
      .setLabel("修改訂單")
      .setEmoji("🛠️")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId(`change_order_price_${order.id}`)
      .setLabel("修改金額")
      .setEmoji("💰")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId(`extend_order_${order.id}`)
      .setLabel("訂單加時")
      .setEmoji("➕")
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`complete_order_${order.id}`)
      .setLabel("完成訂單")
      .setEmoji("🏁")
      .setStyle(ButtonStyle.Success)
  );

  const message = await channel.send({
    content: `<@&${process.env.STAFF_ROLE}> 訂單客服操作面板`,
    embeds: [
      new EmbedBuilder()
        .setColor("#66ccff")
        .setTitle("🛠️ 客服訂單管理")
        .setDescription(
          `訂單編號：${order.order_no || order.id}\n` +
            `闆闆：<@${order.customer_id}>\n` +
            `服務：${order.service || order.order_item || "未填寫"}\n` +
            `金額：NT$${order.final_price || order.price || 0}\n\n` +
            `可在這裡修改訂單、修改金額、建立加時，或在服務結束後完成訂單。`
        )
        .setTimestamp(),
    ],
    components: [row1, row2],
  });
  await checkpointOrderMessage(order, "dispatch_control_message_id", message.id);
  return message;
}

async function enqueueDeliveryRecovery(
  jobType,
  orderId,
  { force = false, payload = {} } = {},
) {
  const rpcName = force
    ? "deepnight_retry_delivery_recovery"
    : "deepnight_enqueue_delivery_recovery";
  const { data, error } = await supabase.rpc(rpcName, {
    p_guild_id: DEEPNIGHT_GUILD_ID,
    p_job_type: jobType,
    p_entity_key: String(orderId),
    p_payload: { order_id: String(orderId), ...payload },
  });
  if (error) throw new Error(error.message || "建立派單補償工作失敗");
  return Array.isArray(data) ? data[0] : data;
}

async function completeDeliveryRecovery(jobId, attempt) {
  const { data, error } = await supabase.rpc(
    "deepnight_complete_delivery_recovery",
    {
      p_job_id: Number(jobId),
      p_guild_id: DEEPNIGHT_GUILD_ID,
      p_attempt: Number(attempt),
    },
  );
  if (error) throw new Error(error.message || "完成派單補償工作失敗");
  return Boolean(data);
}

async function failDeliveryRecovery(jobId, attempt, error) {
  const { data, error: rpcError } = await supabase.rpc(
    "deepnight_fail_delivery_recovery",
    {
      p_job_id: Number(jobId),
      p_guild_id: DEEPNIGHT_GUILD_ID,
      p_attempt: Number(attempt),
      p_error: String(error?.message || error || "未知錯誤"),
    },
  );
  if (rpcError) {
    console.error("[派單補償] 保存失敗狀態失敗", rpcError);
    return false;
  }
  return Boolean(data);
}

async function checkpointDeliveryFinancialEffect(jobId, attempt, effect) {
  const { data, error } = await supabase.rpc(
    "deepnight_checkpoint_delivery_effect",
    {
      p_job_id: Number(jobId),
      p_guild_id: DEEPNIGHT_GUILD_ID,
      p_attempt: Number(attempt),
      p_effect: effect,
    },
  );
  if (error) throw new Error(error.message || "保存財務效果檢查點失敗");
  return Boolean(data);
}

async function processDeliveryRecoveryJob(job) {
  const { data: claim, error: claimError } = await supabase.rpc(
    "deepnight_claim_delivery_recovery",
    {
      p_job_id: Number(job.id),
      p_guild_id: DEEPNIGHT_GUILD_ID,
      p_stale_seconds: Math.floor(DELIVERY_RECOVERY_STALE_MS / 1000),
    },
  );
  if (claimError) throw new Error(claimError.message || "取得派單補償工作失敗");
  if (!claim?.claimed) {
    return { claimed: false, reason: claim?.reason || "not_claimed" };
  }

  const attempt = Number(claim.attempt);
  const claimedJob = claim.job || job;
  try {
    const jobType = String(claimedJob.job_type || "");
    const orderId = String(
      claimedJob.payload?.order_id || claimedJob.entity_key || "",
    );
    const orderJobTypes = new Set([
      "order_dispatch",
      "customer_confirmation",
      "order_financial_effects",
      "work_report_panel",
      "tip_work_report_panel",
    ]);
    let order = null;
    if (orderJobTypes.has(jobType)) {
      const { data, error: orderError } = await supabase
        .from("play_orders")
        .select("*")
        .eq("id", orderId)
        .eq("guild_id", DEEPNIGHT_GUILD_ID)
        .maybeSingle();
      if (orderError) throw orderError;
      if (!data) throw new Error("找不到深夜訂單，未執行跨店補償");
      order = data;
    }

    if (jobType === "order_dispatch") {
      if (!order.paid) throw new Error("訂單尚未付款，不可派單");
      if (["cancelled", "refunded"].includes(String(order.status || ""))) {
        await completeDeliveryRecovery(job.id, attempt);
        return { claimed: true, completed: true, skipped: "terminal" };
      }
      // An accepted order is already full.  Never recreate its open "接單"
      // message; only repair the staff control panel if that checkpoint is gone.
      if (order.status === "pending") {
        await sendOrderToStaffChannel(order);
      }
      const orderChannel = order.channel_id
        ? await client.channels.fetch(order.channel_id).catch(() => null)
        : null;
      if (!orderChannel?.isTextBased()) {
        throw new Error("找不到訂單客服頻道");
      }
      await sendStaffOrderControlPanel(orderChannel, order);
    } else if (jobType === "customer_confirmation") {
      if (!order.paid) throw new Error("訂單尚未付款，不可發送確認面板");
      if (order.status !== "waiting_confirm") {
        await completeDeliveryRecovery(job.id, attempt);
        return { claimed: true, completed: true, skipped: "not_waiting_confirm" };
      }
      const orderChannel = order.channel_id
        ? await client.channels.fetch(order.channel_id).catch(() => null)
        : null;
      if (!orderChannel?.isTextBased()) {
        throw new Error("找不到訂單客戶頻道");
      }
      await sendCustomerFinalConfirm(orderChannel, order);
    } else if (jobType === "order_financial_effects") {
      if (!order.paid) throw new Error("訂單尚未付款，不可計入財務效果");
      if (order.status === "refund_pending") {
        throw new Error("訂單退款預留中，財務效果稍後重試");
      }
      if (
        order.is_deleted ||
        ["cancelled", "refunded"].includes(String(order.status || ""))
      ) {
        await completeDeliveryRecovery(job.id, attempt);
        return { claimed: true, completed: true, skipped: "terminal" };
      }
      const paymentMethod = String(
        order.payment_method || claimedJob.payload?.payment_method || "",
      );
      const isMonthly = paymentMethod.includes("月結") || paymentMethod === "monthly";
      const isWallet =
        paymentMethod.includes("儲值") ||
        paymentMethod.includes("錢包") ||
        paymentMethod.includes("ASD") ||
        paymentMethod === "wallet";
      const isJkopay = paymentMethod.includes("街口");
      const isSalary = paymentMethod.includes("扣薪");
      const amount = Number(
        claimedJob.payload?.amount ?? order.final_price ?? order.price ?? 0,
      );
      if (!amount || amount <= 0) throw new Error("訂單金額錯誤，無法補財務效果");

      if (!claimedJob.financial_vip_completed_at) {
        if (!paymentHelpers.countOrderVipSpentOnce) {
          throw new Error("VIP 累積函式尚未接入 dispatchSystem");
        }
        await paymentHelpers.countOrderVipSpentOnce(
          order,
          `${paymentMethod || "訂單"}付款完成`,
          amount,
        );
        const checkpointed = await checkpointDeliveryFinancialEffect(
          job.id,
          attempt,
          "vip",
        );
        if (!checkpointed) {
          throw new Error("財務效果 attempt 已過期，停止寫入後續會計");
        }
      }

      if (!claimedJob.financial_accounting_completed_at) {
        if (!paymentHelpers.recordAccountingLedger) {
          throw new Error("會計流水函式尚未接入 dispatchSystem");
        }
        const entrySuffix = isMonthly
          ? "monthly"
          : isWallet
            ? "wallet"
            : isSalary
              ? "salary"
            : isJkopay
              ? "jkopay"
              : "manual";
        await paymentHelpers.recordAccountingLedger({
          strict: true,
          entry_type: isMonthly
            ? "customer_spend_monthly"
            : isWallet
              ? "customer_spend_wallet"
              : isSalary
                ? "customer_spend_salary"
              : isJkopay
                ? "customer_order_jkopay"
                : "customer_order_manual",
          entry_label: "客人消費",
          amount,
          revenue_amount: amount,
          ...(isMonthly
            ? { receivable_amount: amount }
            : isWallet
              ? { liability_amount: -amount }
              : isSalary
                ? { liability_amount: -amount }
              : { cash_amount: amount }),
          payment_method: paymentMethod || "客服確認",
          customer_id: order.customer_id,
          customer_name: order.customer_name || order.customer_username || null,
          staff_id: order.discord_id || order.assigned_player || null,
          staff_name: order.staff_name || null,
          order_id: String(order.id),
          order_no: order.order_no || order.order_id || null,
          source_table: "play_orders",
          source_id: String(order.id),
          dedupe_key: `play_orders:${order.id}:customer_spend_${entrySuffix}`,
          note: order.service || order.service_name || "陪玩訂單",
          metadata: {
            recovery_job_id: Number(job.id),
            platform_order_id: claimedJob.payload?.platform_order_id || null,
            trade_no: claimedJob.payload?.trade_no || null,
          },
        });
        const checkpointed = await checkpointDeliveryFinancialEffect(
          job.id,
          attempt,
          "accounting",
        );
        if (!checkpointed) {
          throw new Error("財務效果 attempt 已過期，會計流水將依 dedupe key 安全重試");
        }
      }
    } else if (jobType === "work_report_panel") {
      if (order.status !== "accepted" || order.is_deleted) {
        await completeDeliveryRecovery(job.id, attempt);
        return { claimed: true, completed: true, skipped: "not_accepted" };
      }
      const staffIds = String(order.assigned_player || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      if (!staffIds.length) throw new Error("已接單訂單沒有陪陪資料");
      await workReportSystem.sendForAcceptedOrder(order, staffIds);
      const { data: currentOrder } = await supabase
        .from("play_orders")
        .select("status,is_deleted")
        .eq("id", order.id)
        .eq("guild_id", DEEPNIGHT_GUILD_ID)
        .maybeSingle();
      if (currentOrder?.is_deleted || currentOrder?.status !== "accepted") {
        await supabase
          .from("play_orders")
          .update({ is_deleted: true, status: "refunded" })
          .like("order_id", `WORK-${order.id}-%`)
          .eq("guild_id", DEEPNIGHT_GUILD_ID)
          .is("wallet_settled_at", null);
        throw new Error("工時面板建立期間訂單狀態已變更，已停用報單");
      }
    } else if (jobType === "tip_work_report_panel") {
      if (order.status === "refund_pending") {
        throw new Error("打賞退款預留中，工時面板稍後重試");
      }
      if (!order.paid || order.is_deleted || order.order_type !== "打賞") {
        await completeDeliveryRecovery(job.id, attempt);
        return { claimed: true, completed: true, skipped: "terminal" };
      }
      await workReportSystem.sendForCompletedTipOrders([order], {
        customerId: order.customer_id,
        serviceName: order.service || order.order_item || "打賞",
        amount: Number(order.final_price || order.price || 0),
      });
      const { data: currentOrder } = await supabase
        .from("play_orders")
        .select("paid,status,is_deleted")
        .eq("id", order.id)
        .eq("guild_id", DEEPNIGHT_GUILD_ID)
        .maybeSingle();
      if (!currentOrder?.paid || currentOrder.is_deleted) {
        await supabase
          .from("play_orders")
          .update({ is_deleted: true, status: "refunded" })
          .like("order_id", `WORK-${order.id}-%`)
          .eq("guild_id", DEEPNIGHT_GUILD_ID)
          .is("wallet_settled_at", null);
        throw new Error("工時面板建立期間打賞已退款，已停用報單");
      }
    } else if (jobType === "extension_financial_effects") {
      const extensionId = String(
        claimedJob.payload?.extension_id || claimedJob.entity_key || "",
      );
      const { data: extension, error: extensionError } = await supabase
        .from("order_extensions")
        .select("*")
        .eq("id", extensionId)
        .eq("guild_id", DEEPNIGHT_GUILD_ID)
        .maybeSingle();
      if (extensionError) throw extensionError;
      if (extension?.status === "refund_pending") {
        throw new Error("加時退款預留中，後續稍後重試");
      }
      if (!extension?.paid || extension.status !== "paid") {
        await completeDeliveryRecovery(job.id, attempt);
        return { claimed: true, completed: true, skipped: "terminal" };
      }
      const amount = Number(extension.amount || 0);
      const paymentMethod = String(
        extension.payment_method || claimedJob.payload?.payment_method || "",
      );
      if (!amount || amount <= 0) throw new Error("加時金額錯誤");

      if (!claimedJob.financial_vip_completed_at) {
        await recordPaidExtensionConsumption(
          extension,
          `續單${paymentMethod || "付款"} ${extension.order_no || extension.order_id}`,
        );
        if (!(await checkpointDeliveryFinancialEffect(job.id, attempt, "vip"))) {
          throw new Error("加時 VIP attempt 已過期");
        }
      }
      if (!claimedJob.financial_salary_completed_at) {
        await applyExtensionToPlayOrder(extension);
        if (!(await checkpointDeliveryFinancialEffect(job.id, attempt, "salary"))) {
          throw new Error("加時薪資 attempt 已過期");
        }
      }
      if (!claimedJob.financial_accounting_completed_at) {
        if (!paymentHelpers.recordAccountingLedger) {
          throw new Error("會計流水函式尚未接入 dispatchSystem");
        }
        const isMonthly = paymentMethod.includes("月結");
        const isWallet = paymentMethod.includes("儲值") || paymentMethod.includes("錢包");
        const isSalary = paymentMethod.includes("扣薪");
        await paymentHelpers.recordAccountingLedger({
          strict: true,
          entry_type: isMonthly
            ? "customer_extension_monthly"
            : isWallet
              ? "customer_extension_wallet"
              : isSalary
                ? "customer_extension_salary"
                : paymentMethod.includes("街口")
                  ? "customer_extension_jkopay"
                  : "customer_extension_manual",
          entry_label: "客人加時消費",
          amount,
          revenue_amount: amount,
          ...(isMonthly
            ? { receivable_amount: amount }
            : isWallet || isSalary
              ? { liability_amount: -amount }
              : { cash_amount: amount }),
          payment_method: paymentMethod,
          customer_id: extension.customer_id,
          order_id: extension.order_id || extension.order_no || null,
          order_no: extension.order_no || null,
          source_table: "order_extensions",
          source_id: String(extension.id),
          dedupe_key: `order_extensions:${extension.id}:customer_extension`,
          note: `加時 ${extension.extension_text || ""}`.trim(),
        });
        if (!(await checkpointDeliveryFinancialEffect(job.id, attempt, "accounting"))) {
          throw new Error("加時會計 attempt 已過期");
        }
      }
    } else if (jobType === "topup_financial_effects") {
      const payload = claimedJob.payload || {};
      const userId = String(payload.user_id || "");
      const amount = Number(payload.amount || 0);
      const operationKey = String(payload.operation_key || claimedJob.entity_key || "");
      if (!userId || amount <= 0 || !operationKey) {
        throw new Error("儲值補償資料不完整");
      }
      if (!claimedJob.financial_vip_completed_at) {
        if (!paymentHelpers.applyVipActivityOnce) {
          throw new Error("VIP 累積函式尚未接入");
        }
        await paymentHelpers.applyVipActivityOnce({
          operationKey: `topup:${operationKey}`,
          userId,
          triggerType: "topup",
          amount,
          sourceKey: `dispatch-topup:${operationKey}:${userId}`,
          note: `${operationKey}｜客服確認儲值`,
        });
        if (!(await checkpointDeliveryFinancialEffect(job.id, attempt, "vip"))) {
          throw new Error("儲值 VIP attempt 已過期");
        }
      }
      if (!claimedJob.financial_accounting_completed_at) {
        if (!paymentHelpers.recordAccountingLedger) {
          throw new Error("會計流水函式尚未接入");
        }
        await paymentHelpers.recordAccountingLedger({
          strict: true,
          entry_type: "customer_topup",
          entry_label: "客人儲值",
          amount,
          cash_amount: amount,
          liability_amount: amount,
          payment_method: "客服確認儲值",
          customer_id: userId,
          source_table: "wallet_logs",
          source_id: operationKey,
          dedupe_key: `topup:${operationKey}:${userId}:${amount}`,
          note: `${operationKey}｜客服確認儲值`,
          created_by: payload.confirmed_by || null,
        });
        if (!(await checkpointDeliveryFinancialEffect(job.id, attempt, "accounting"))) {
          throw new Error("儲值會計 attempt 已過期");
        }
      }
      if (!claimedJob.financial_external_completed_at) {
        if (paymentHelpers.sendWalletLog) {
          await paymentHelpers.sendWalletLog(
            userId,
            "儲值",
            amount,
            Number(payload.balance || 0),
            `自動儲值成功｜${operationKey}`,
            false,
          );
        }
        if (!(await checkpointDeliveryFinancialEffect(job.id, attempt, "external"))) {
          throw new Error("儲值通知 attempt 已過期");
        }
      }
    } else if (jobType === "shop_financial_effects") {
      const payload = claimedJob.payload || {};
      const userId = String(payload.user_id || "");
      const amount = Number(payload.price || 0);
      const operationKey = String(payload.operation_key || claimedJob.entity_key || "");
      if (!userId || amount <= 0 || !operationKey) {
        throw new Error("商店補償資料不完整");
      }
      if (!claimedJob.financial_vip_completed_at) {
        if (!paymentHelpers.applyVipActivityOnce) {
          throw new Error("VIP 累積函式尚未接入");
        }
        await paymentHelpers.applyVipActivityOnce({
          operationKey: `shop:${operationKey}`,
          userId,
          triggerType: "spend",
          amount,
          sourceKey: `shop-purchase:${operationKey}`,
          note: `商店購買：${payload.item_name || payload.item_id}`,
        });
        if (!(await checkpointDeliveryFinancialEffect(job.id, attempt, "vip"))) {
          throw new Error("商店 VIP attempt 已過期");
        }
      }
      if (!claimedJob.financial_accounting_completed_at) {
        if (!paymentHelpers.recordAccountingLedger) {
          throw new Error("會計流水函式尚未接入");
        }
        await paymentHelpers.recordAccountingLedger({
          strict: true,
          entry_type: "customer_shop_purchase",
          entry_label: "商店購買",
          amount,
          revenue_amount: amount,
          liability_amount: -amount,
          payment_method: "ASD 錢包",
          customer_id: userId,
          source_table: "shop_items",
          source_id: String(payload.item_id || ""),
          dedupe_key: `shop-purchase:${operationKey}`,
          note: `商店購買：${payload.item_name || payload.item_id}`,
        });
        if (!(await checkpointDeliveryFinancialEffect(job.id, attempt, "accounting"))) {
          throw new Error("商店會計 attempt 已過期");
        }
      }
      if (!claimedJob.financial_external_completed_at) {
        if (paymentHelpers.givePurchasedShopBenefit) {
          await paymentHelpers.givePurchasedShopBenefit(payload);
        }
        if (paymentHelpers.sendWalletLog) {
          await paymentHelpers.sendWalletLog(
            userId,
            "商店購買",
            -amount,
            Number(payload.balance || 0),
            `購買商品：${payload.item_name || payload.item_id}`,
            false,
          );
        }
        if (!(await checkpointDeliveryFinancialEffect(job.id, attempt, "external"))) {
          throw new Error("商店外部效果 attempt 已過期");
        }
      }
    } else {
      throw new Error(`不支援的派單補償類型：${jobType}`);
    }

    const fenced = !(await completeDeliveryRecovery(job.id, attempt));
    return { claimed: true, completed: !fenced, fenced };
  } catch (error) {
    const recorded = await failDeliveryRecovery(job.id, attempt, error);
    if (!recorded) {
      console.warn(`[派單補償] 工作 ${job.id} 已由較新的 attempt 接手`);
    }
    throw error;
  }
}

async function processOrderDeliveryNow(orderId, jobType, options = {}) {
  const job = await enqueueDeliveryRecovery(jobType, orderId, options);
  if (!job) throw new Error("建立派單補償工作後未取得資料");
  return processDeliveryRecoveryJob(job);
}

async function recoverIfPaymentAlreadyCompleted(orderId, jobTypes) {
  const { data: paidOrder, error } = await supabase
    .from("play_orders")
    .select("id,paid,guild_id")
    .eq("id", String(orderId))
    .eq("guild_id", DEEPNIGHT_GUILD_ID)
    .maybeSingle();
  if (error) throw error;
  if (!paidOrder?.paid) return false;
  for (const jobType of Array.isArray(jobTypes) ? jobTypes : [jobTypes]) {
    await processOrderDeliveryNow(paidOrder.id, jobType).catch((recoveryError) =>
      console.error("[付款後補償] 首次重送失敗，保留給排程重試", recoveryError),
    );
  }
  return true;
}

async function recoverPendingDeliveries() {
  const staleBefore = new Date(Date.now() - DELIVERY_RECOVERY_STALE_MS).toISOString();
  const baseColumns =
    "id,organization_code,guild_id,job_type,entity_key,payload,status,attempts,claimed_at,financial_vip_completed_at,financial_accounting_completed_at,financial_salary_completed_at,financial_external_completed_at,updated_at";
  const { data: ready, error: readyError } = await supabase
    .from("bot_delivery_recovery_jobs")
    .select(baseColumns)
    .eq("organization_code", DEEPNIGHT_ORGANIZATION_CODE)
    .eq("guild_id", DEEPNIGHT_GUILD_ID)
    .in("status", ["pending", "failed"])
    .order("updated_at", { ascending: true })
    .limit(50);
  if (readyError) throw readyError;
  const { data: stale, error: staleError } = await supabase
    .from("bot_delivery_recovery_jobs")
    .select(baseColumns)
    .eq("organization_code", DEEPNIGHT_ORGANIZATION_CODE)
    .eq("guild_id", DEEPNIGHT_GUILD_ID)
    .eq("status", "processing")
    .lt("claimed_at", staleBefore)
    .order("claimed_at", { ascending: true })
    .limit(50);
  if (staleError) throw staleError;

  const jobs = [
    ...new Map(
      [...(ready || []), ...(stale || [])].map((job) => [String(job.id), job]),
    ).values(),
  ];
  const summary = { candidates: jobs.length, completed: 0, failed: 0, fenced: 0 };
  for (const job of jobs) {
    try {
      const result = await processDeliveryRecoveryJob(job);
      if (result.fenced || !result.claimed) summary.fenced += 1;
      else if (result.completed) summary.completed += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(
        `[派單補償] ${job.job_type}:${job.entity_key} 執行失敗`,
        error,
      );
    }
  }
  return summary;
}

async function retryOrderDelivery(orderId, jobTypes = [
  "order_dispatch",
  "customer_confirmation",
  "work_report_panel",
  "order_financial_effects",
]) {
  const { data: order, error } = await supabase
    .from("play_orders")
    .select("id,guild_id")
    .eq("id", String(orderId))
    .eq("guild_id", DEEPNIGHT_GUILD_ID)
    .maybeSingle();
  if (error) throw error;
  if (!order) throw new Error("找不到深夜訂單");

  const results = [];
  for (const jobType of jobTypes) {
    results.push(
      await processOrderDeliveryNow(order.id, jobType, { force: true }),
    );
  }
  return results;
}
// ===== 陪玩控制面板 =====
async function sendPlayerPanel(channel) {
  const embed = new EmbedBuilder()
    .setColor("#00ff99")
    .setTitle("🎮 陪玩控制中心")
    .setDescription("請使用下方按鈕控制接單狀態。");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("player_online")
      .setLabel("🟢 開始接單")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("player_offline")
      .setLabel("🔴 停止接單")
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId("player_status")
      .setLabel("📋 我的狀態")
      .setStyle(ButtonStyle.Secondary)
  );

  const messages = await channel.messages.fetch({
    limit: 10,
  });
  const oldPanel = messages.find(
    (msg) =>
      msg.author.id === client.user.id &&
      msg.embeds.length > 0 &&
      msg.embeds[0].title === "🎮 陪玩控制中心"
  );
  if (oldPanel) {
    await oldPanel.edit({
      embeds: [embed],
      components: [row],
    });
    return;
  }
  await channel.send({
    embeds: [embed],
    components: [row],
  });
}
function buildOrderBackRow(flowId, target) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`new_order_back_${target}_${flowId}`)
      .setLabel("⬅️ 上一步")
      .setStyle(ButtonStyle.Secondary)
  );
}
async function createTopupTicket(interaction, presetAmount = null) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const normalizedPreset = presetAmount === null
    ? null
    : TOPUP_PRESET_AMOUNTS.includes(Number(presetAmount))
      ? Number(presetAmount)
      : null;
  if (presetAmount !== null && normalizedPreset === null) {
    return interaction.editReply({ content: "❌ 不支援的星雨幣購買金額。" });
  }

  const guild = interaction.guild;
  const topupNo = await getNextTopupNumber(supabase);
  const safeName = interaction.user.username
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5-_]/g, "")
    .slice(0, 10);

  const channel = await guild.channels.create({
    name: `購買-${topupNo.toLowerCase()}-${safeName}`.slice(0, 90),
    type: ChannelType.GuildText,
    parent: process.env.ORDER_CATEGORY || null,
    topic: buildTopupTopic(interaction.user.id, topupNo),
    permissionOverwrites: [
      {
        id: guild.id,
        deny: ["ViewChannel"],
      },
      {
        id: interaction.user.id,
        allow: [
          "ViewChannel",
          "SendMessages",
          "ReadMessageHistory",
          "AttachFiles",
        ],
      },
      {
        id: process.env.STAFF_ROLE,
        allow: [
          "ViewChannel",
          "SendMessages",
          "ReadMessageHistory",
          "AttachFiles",
          "ManageMessages",
        ],
      },
    ],
  });

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("open_topup_modal")
      .setLabel("輸入其他金額")
      .setEmoji("💳")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("owner_cancel_ticket")
      .setLabel("我按錯了，關閉頻道")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger)
  );

  const checkout = normalizedPreset
    ? prepareTopupCheckout({
        userId: interaction.user.id,
        amount: normalizedPreset,
        note: "快捷金額",
        topupNo,
      })
    : null;

  await channel.send({
    content: `<@${interaction.user.id}> <@&${process.env.STAFF_ROLE}>`,
    embeds: [
      new EmbedBuilder()
        .setColor("#ffd166")
        .setTitle("💳 購買星雨幣訂單")
        .setDescription(
          `訂單編號：${topupNo}\n` +
            (checkout
              ? `購買金額：NT$${normalizedPreset.toLocaleString("zh-TW")}\n請直接選擇付款方式。`
              : `請輸入購買金額後選擇付款方式。`),
        ),
    ],
    components: checkout ? [...checkout.rows, new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("owner_cancel_ticket")
        .setLabel("取消訂單並關閉頻道")
        .setEmoji("🗑️")
        .setStyle(ButtonStyle.Danger),
    )] : [actionRow],
  });

  return interaction.editReply({
    content: `✅ 已建立購買星雨幣訂單：<#${channel.id}>`,
  });
}
async function createTipTicket(interaction, mode = "tip") {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const guild = interaction.guild;

  const channel = await guild.channels.create({
    name: `${mode === "crown" ? "冠名" : "打賞"}-${interaction.user.username}`.slice(0, 90),
    type: ChannelType.GuildText,
    parent: process.env.ORDER_CATEGORY || null,
    topic: `owner:${interaction.user.id}`,
    permissionOverwrites: [
      {
        id: guild.id,
        deny: ["ViewChannel"],
      },
      {
        id: interaction.user.id,
        allow: [
          "ViewChannel",
          "SendMessages",
          "ReadMessageHistory",
          "AttachFiles",
        ],
      },
      {
        id: process.env.STAFF_ROLE,
        allow: [
          "ViewChannel",
          "SendMessages",
          "ReadMessageHistory",
          "AttachFiles",
          "ManageMessages",
        ],
      },
    ],
  });

  await channel.send({
    content: `<@${interaction.user.id}> <@&${process.env.STAFF_ROLE}>`,
    embeds: [
      new EmbedBuilder()
        .setColor("#ff99cc")
        .setTitle(mode === "crown" ? "👑 冠名單頻道" : "💝 打賞頻道")
        .setDescription(
          mode === "crown"
            ? "請依照下方選單選擇冠名方案。"
            : "請依照下方選單選擇打賞禮物。",
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("owner_cancel_ticket")
          .setLabel("我按錯了，關閉頻道")
          .setEmoji("🗑️")
          .setStyle(ButtonStyle.Danger)
      ),
    ],
  });

  const startFlow =
    mode === "crown"
      ? paymentHelpers.startCrownFlowInChannel
      : paymentHelpers.startTipFlowInChannel;
  if (!startFlow) {
    await channel.send("❌ 打賞／冠名流程尚未接入。");
  } else {
    await startFlow(channel, interaction.user);
  }

  return interaction.editReply({
    content: `✅ 已建立打賞頻道：<#${channel.id}>`,
  });
}
async function createServiceTicket(interaction, serviceType, initial = {}) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const guild = interaction.guild;
  const serviceName = getServiceName(serviceType);
  const flowId = createFlowId(interaction.user.id);

  const channel = await guild.channels.create({
    name: `${serviceName}-${interaction.user.username}`.slice(0, 90),
    type: ChannelType.GuildText,
    parent: process.env.ORDER_CATEGORY || null,
    topic: `owner:${interaction.user.id}`,
    permissionOverwrites: [
      {
        id: guild.id,
        deny: ["ViewChannel"],
      },
      {
        id: interaction.user.id,
        allow: [
          "ViewChannel",
          "SendMessages",
          "ReadMessageHistory",
          "AttachFiles",
        ],
      },
      {
        id: process.env.STAFF_ROLE,
        allow: [
          "ViewChannel",
          "SendMessages",
          "ReadMessageHistory",
          "AttachFiles",
          "ManageMessages",
        ],
      },
    ],
  });

  pendingServiceOrders.set(flowId, {
    flowId,
    guildId:
      interaction.guildId || interaction.guild?.id || process.env.GUILD_ID,
    channelId: channel.id,
    customerId: interaction.user.id,
    customerUsername: interaction.user.username,
    category: serviceType,

    gameLabel: initial.gameLabel || getServiceName(serviceType),
    itemLabel: initial.itemLabel || null,

    serviceType: initial.serviceType || null,
    serviceTypes: initial.serviceTypes || [],
    playMode: initial.playMode || null,
    rank: initial.rank || null,
    steamCategory: initial.steamCategory || null,
    steamGameName: initial.steamGameName || null,
    deltaPlatform: initial.deltaPlatform || null,
    deltaMode: initial.deltaMode || null,

    playerCount: initial.playerCount || null,
    genderPreference: null,
    assignMode: null,
    selectedPlayerIds: [],

    duration: null,
    rounds: null,
    note: "",
    quotedPrice: null,
    originalPrice: null,
    finalPrice: null,
    discountRate: 1,
    discountAmount: 0,
    couponText: "未使用優惠券",
    usedCouponItemId: null,
    usedCouponName: null,
    paymentMethod: null,
    timeSelectShown: false,
    fromPanel: Boolean(initial.fromPanel),

    // 新分區入口會先把「送出訂單」按鈕直接放進臨時頻道，避免重複出現
    finishButtonShown: Boolean(initial.fromPanel),
  });

  setTimeout(() => {
    pendingServiceOrders.delete(flowId);
  }, ORDER_FLOW_TTL_MS);

  if (initial.fromPanel) {
    await channel.send({
      content: `<@${interaction.user.id}> <@&${process.env.STAFF_ROLE}>`,
      embeds: [
        new EmbedBuilder()
          .setColor("#ffd166")
          .setTitle(`🌙 ${serviceName} 下單頻道`)
          .setDescription(
            `請依照下方選項填寫需求。\n\n` +
              `填寫完成後，客服會依照需求輸入正式報價。`
          )
          .setTimestamp(),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("owner_cancel_ticket")
            .setLabel("我按錯了，關閉頻道")
            .setEmoji("🗑️")
            .setStyle(ButtonStyle.Danger)
        ),
      ],
    });
    await sendQuickServiceNeedPanel(channel, flowId, initial);

    return interaction.editReply({
      content:
        `✅ 已建立臨時下單頻道：<#${channel.id}>\n` +
        `項目：${
          initial.serviceType ||
          initial.itemLabel ||
          getServiceName(serviceType)
        }`,
    });
  }

  await channel.send({
    content: `<@${interaction.user.id}> <@&${process.env.STAFF_ROLE}>`,
    embeds: [
      new EmbedBuilder()
        .setColor("#ffd166")
        .setTitle(`🌙 ${serviceName} 下單頻道`)
        .setDescription(
          `請依照下方選項填寫需求。\n\n` +
            `填寫完成後，客服會依照需求輸入正式報價。`
        )
        .setTimestamp(),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("owner_cancel_ticket")
          .setLabel("我按錯了，關閉頻道")
          .setEmoji("🗑️")
          .setStyle(ButtonStyle.Danger)
      ),
    ],
  });
  if (serviceType === "valorant") {
    await showValorantStart(channel, flowId);
  }
  if (serviceType === "steam") {
    await showSteamStart(channel, flowId);
  }
  if (serviceType === "delta") {
    await showDeltaStart(channel, flowId);
  }
  if (serviceType === "chat") {
    await showSimpleServiceStart(channel, flowId, "chat");
  }
  if (serviceType === "emotion") {
    await showSimpleServiceStart(channel, flowId, "emotion");
  }
  return interaction.editReply({
    content: `✅ 已建立下單頻道：<#${channel.id}>`,
  });
}
async function showValorantStart(channel, flowId) {
  const pending = pendingServiceOrders.get(flowId);
  const hasPresetType = Boolean(pending?.serviceType);
  const typeMenu = new StringSelectMenuBuilder()
    .setCustomId(`valorant_type_select_${flowId}`)
    .setPlaceholder("請選擇服務內容")
    .addOptions([
      {
        label: "大神",
        value: "god",
        description: "大神陪玩",
      },
      {
        label: "娛樂",
        value: "entertain",
        description: "娛樂陪玩",
      },
      {
        label: "技術",
        value: "skill",
        description: "技術陪玩",
      },
      {
        label: "技術+娛樂",
        value: "skill_entertain",
        description: "技術與娛樂同時下單，至少 2 位陪陪",
      },
    ]);

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`valorant_mode_rank_${flowId}`)
      .setLabel("排位")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId(`valorant_mode_normal_${flowId}`)
      .setLabel("一般")
      .setStyle(ButtonStyle.Secondary)
  );

  const rankMenu = new StringSelectMenuBuilder()
    .setCustomId(`valorant_rank_${flowId}`)
    .setPlaceholder("請選擇段位")
    .addOptions([
      {
        label: "鐵牌",
        value: "鐵牌",
      },
      {
        label: "銅牌",
        value: "銅牌",
      },
      {
        label: "銀牌",
        value: "銀牌",
      },
      {
        label: "金牌",
        value: "金牌",
      },
      {
        label: "白金",
        value: "白金",
      },
      {
        label: "鑽石",
        value: "鑽石",
      },
      {
        label: "超凡",
        value: "超凡",
      },
      {
        label: "神話",
        value: "神話",
      },
      {
        label: "輻能",
        value: "輻能",
      },
      {
        label: "不指定 / 尚未確認",
        value: "不指定",
      },
    ]);

  const countMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_player_count_${flowId}`)
    .setPlaceholder("請選擇陪陪人數")
    .addOptions([
      {
        label: "1 位",
        value: "1",
      },
      {
        label: "2 位",
        value: "2",
      },
      {
        label: "3 位",
        value: "3",
      },
      {
        label: "4 位",
        value: "4",
      },
    ]);

  const genderMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_gender_${flowId}`)
    .setPlaceholder("請選擇陪陪性別偏好")
    .addOptions([
      {
        label: "不指定",
        value: "不指定",
      },
      {
        label: "男陪",
        value: "男陪",
      },
      {
        label: "女陪",
        value: "女陪",
      },
    ]);

  const assignMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_assign_${flowId}`)
    .setPlaceholder("是否指定陪陪")
    .addOptions([
      {
        label: "不指定陪陪",
        value: "不指定",
      },
      {
        label: "指定陪陪",
        value: "指定",
      },
      {
        label: "預約指定陪陪",
        value: "預約指定",
      },
    ]);
  const durationMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_duration_${flowId}`)
    .setPlaceholder("請選擇時長｜娛樂 / 金牌以下技術適用")
    .addOptions([
      {
        label: "1 小時",
        value: "1",
      },
      {
        label: "2 小時",
        value: "2",
      },
      {
        label: "3 小時",
        value: "3",
      },
      {
        label: "4 小時",
        value: "4",
      },
      {
        label: "自訂",
        value: "custom",
      },
    ]);
  const roundsMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_rounds_${flowId}`)
    .setPlaceholder("請選擇局數｜技術金牌以上適用")
    .addOptions([
      {
        label: "1 局",
        value: "1",
      },
      {
        label: "3 局",
        value: "3",
      },
      {
        label: "5 局",
        value: "5",
      },
      {
        label: "自訂",
        value: "custom",
      },
    ]);
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#ff6b6b")
        .setTitle("🎯 特戰英豪需求")
        .setDescription(
          (hasPresetType
            ? `已選擇服務內容：${pending.serviceType}\n\n`
            : `請依序選擇服務內容。\n\n`) +
            `若選擇「技術+娛樂」，陪陪人數至少需要 2 位。\n\n` +
            `**客服價格參考**\n` +
            `娛樂陪玩：NT$250、250、260、270、310\n` +
            `技術陪玩：金牌以下以時長報價，金牌以上以局數報價\n\n` +
            `⚠️ 此價格僅供參考，正式金額仍以客服輸入為準。`
        ),
    ],
    components: [
      ...(hasPresetType
        ? []
        : [new ActionRowBuilder().addComponents(typeMenu)]),
      row2,
      new ActionRowBuilder().addComponents(rankMenu),
      new ActionRowBuilder().addComponents(countMenu),
      new ActionRowBuilder().addComponents(genderMenu),
    ],
  });

  await channel.send({
    content:
      `請繼續選擇指定方式與時間：\n\n` +
      `娛樂陪玩 / 金牌以下技術單 → 選「時長」\n` +
      `金牌以上技術單 → 選「局數」`,
    components: [
      new ActionRowBuilder().addComponents(assignMenu),
      new ActionRowBuilder().addComponents(durationMenu),
      new ActionRowBuilder().addComponents(roundsMenu),
    ],
  });
}
async function showSteamStart(channel, flowId) {
  const categoryMenu = new StringSelectMenuBuilder()
    .setCustomId(`steam_category_${flowId}`)
    .setPlaceholder("請選擇 Steam 遊戲類型")
    .addOptions([
      {
        label: "恐怖遊戲",
        description: "價格參考：由客服依遊戲與時長報價",
        value: "恐怖遊戲",
      },
      {
        label: "生存遊戲",
        description: "價格參考：由客服依遊戲與時長報價",
        value: "生存遊戲",
      },
      {
        label: "肉鴿遊戲",
        description: "價格參考：由客服依遊戲與時長報價",
        value: "肉鴿遊戲",
      },
      {
        label: "派對遊戲",
        description: "價格參考：由客服依遊戲與時長報價",
        value: "派對遊戲",
      },
      {
        label: "其他",
        description: "請輸入遊戲名稱，由客服報價",
        value: "其他",
      },
    ]);

  const countMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_player_count_${flowId}`)
    .setPlaceholder("請選擇陪陪人數")
    .addOptions([
      { label: "1 位", value: "1" },
      { label: "2 位", value: "2" },
      { label: "3 位", value: "3" },
      { label: "4 位", value: "4" },
    ]);

  const genderMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_gender_${flowId}`)
    .setPlaceholder("請選擇陪陪性別偏好")
    .addOptions([
      { label: "不指定", value: "不指定" },
      { label: "男陪", value: "男陪" },
      { label: "女陪", value: "女陪" },
    ]);

  const assignMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_assign_${flowId}`)
    .setPlaceholder("是否指定陪陪")
    .addOptions([
      { label: "不指定陪陪", value: "不指定" },
      { label: "指定陪陪", value: "指定" },
      { label: "預約指定陪陪", value: "預約指定" },
    ]);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`steam_game_name_${flowId}`)
      .setLabel("輸入遊戲名稱")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId(`order_add_note_${flowId}`)
      .setLabel("填寫備註 / 自訂需求")
      .setStyle(ButtonStyle.Secondary)
  );

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#5dade2")
        .setTitle("🎮 Steam 下單需求")
        .setDescription(
          `請選擇遊戲類型、人數、性別、指定方式與時長。\n\n` +
            `⚠️ 價格只提供客服參考，正式報價由客服輸入。`
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(categoryMenu),
      new ActionRowBuilder().addComponents(countMenu),
      new ActionRowBuilder().addComponents(genderMenu),
      new ActionRowBuilder().addComponents(assignMenu),
      row,
    ],
  });

  await showServiceDurationSelect(channel, flowId, "hour");
}
async function showDeltaStart(channel, flowId) {
  const modeMenu = new StringSelectMenuBuilder()
    .setCustomId(`delta_mode_${flowId}`)
    .setPlaceholder("請選擇三角洲玩法")
    .addOptions([
      { label: "基礎陪護", value: "基礎陪護" },
      { label: "機密雙護", value: "機密雙護" },
      { label: "機密雙護（保底）", value: "機密雙護（保底）" },
      { label: "猛攻護航", value: "猛攻護航" },
      { label: "猛攻護航（保底）", value: "猛攻護航（保底）" },
      { label: "一般陪玩", value: "一般陪玩" },
      { label: "其他玩法", value: "其他玩法" },
    ]);

  const countMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_player_count_${flowId}`)
    .setPlaceholder("請選擇陪陪人數")
    .addOptions([
      { label: "1 位", value: "1" },
      { label: "2 位", value: "2" },
      { label: "3 位", value: "3" },
      { label: "4 位", value: "4" },
    ]);

  const genderMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_gender_${flowId}`)
    .setPlaceholder("請選擇陪陪性別偏好")
    .addOptions([
      { label: "不指定", value: "不指定" },
      { label: "男陪", value: "男陪" },
      { label: "女陪", value: "女陪" },
    ]);

  const assignMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_assign_${flowId}`)
    .setPlaceholder("是否指定陪陪")
    .addOptions([
      { label: "不指定陪陪", value: "不指定" },
      { label: "指定陪陪", value: "指定" },
      { label: "預約指定陪陪", value: "預約指定" },
    ]);

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#95d5b2")
        .setTitle("🛡️ 三角洲下單需求")
        .setDescription(
          `請選擇玩法、人數、性別、指定方式與時間。\n\n` +
            `⚠️ 保底、雙護、護航等價格僅供客服參考，正式報價由客服輸入。`
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(modeMenu),
      new ActionRowBuilder().addComponents(countMenu),
      new ActionRowBuilder().addComponents(genderMenu),
      new ActionRowBuilder().addComponents(assignMenu),
    ],
  });

  await showServiceDurationSelect(channel, flowId, "hour");
}
async function showServiceDurationSelect(channel, flowId, unit = "hour") {
  const options =
    unit === "half"
      ? [
          { label: "30 分鐘", value: "0.5" },
          { label: "1 小時", value: "1" },
          { label: "1.5 小時", value: "1.5" },
          { label: "2 小時", value: "2" },
          { label: "自訂", value: "custom" },
        ]
      : [
          { label: "1 小時", value: "1" },
          { label: "2 小時", value: "2" },
          { label: "3 小時", value: "3" },
          { label: "4 小時", value: "4" },
          { label: "自訂", value: "custom" },
        ];

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`service_duration_${flowId}`)
    .setPlaceholder("請選擇時間")
    .addOptions(options);

  await channel.send({
    content: "請選擇服務時間：",
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

async function showServiceRoundSelect(channel, flowId) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`service_rounds_${flowId}`)
    .setPlaceholder("請選擇局數")
    .addOptions([
      { label: "1 局", value: "1" },
      { label: "3 局", value: "3" },
      { label: "5 局", value: "5" },
      { label: "自訂", value: "custom" },
    ]);

  await channel.send({
    content: "請選擇局數：",
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

function isValorantGoldOrBelow(rank) {
  return ["鐵牌", "銅牌", "銀牌", "金牌", "金牌含以下", "不指定"].includes(
    String(rank || "")
  );
}
function isValorantAboveGold(rank) {
  return ["白金", "鑽石", "超凡", "神話", "輻能"].includes(String(rank || ""));
}
async function showValorantTimeOrRoundOnce(channel, flowId, pending) {
  if (pending.timeSelectShown) {
    return;
  }

  if (!pending.serviceType) {
    return;
  }

  if (pending.serviceType === "娛樂") {
    pending.timeSelectShown = true;
    pendingServiceOrders.set(flowId, pending);
    await showServiceDurationSelect(channel, flowId, "hour");
    return;
  }

  if (pending.serviceType === "技術") {
    if (!pending.rank) {
      await channel.send("請先選擇段位，系統會依段位顯示時長或局數。");
      return;
    }

    pending.timeSelectShown = true;
    pendingServiceOrders.set(flowId, pending);

    if (isValorantGoldOrBelow(pending.rank)) {
      await showServiceDurationSelect(channel, flowId, "hour");
    } else {
      await showServiceRoundSelect(channel, flowId);
    }
  }
}
async function showSimpleServiceStart(channel, flowId, serviceType) {
  const isChat = serviceType === "chat";

  const title = isChat ? "💬 陪聊需求" : "🧸 出氣包需求";

  const description = isChat
    ? "陪聊以半小時為一單位，正式價格由客服輸入。"
    : "出氣包以半小時為一單位，正式價格由客服輸入。";

  const countMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_player_count_${flowId}`)
    .setPlaceholder("請選擇陪陪人數")
    .addOptions([
      {
        label: "1 位",
        value: "1",
      },
      {
        label: "2 位",
        value: "2",
      },
      {
        label: "3 位",
        value: "3",
      },
      {
        label: "4 位",
        value: "4",
      },
    ]);

  const genderMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_gender_${flowId}`)
    .setPlaceholder("請選擇陪陪性別偏好")
    .addOptions([
      {
        label: "不指定",
        value: "不指定",
      },
      {
        label: "男陪",
        value: "男陪",
      },
      {
        label: "女陪",
        value: "女陪",
      },
    ]);

  const assignMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_assign_${flowId}`)
    .setPlaceholder("是否指定陪陪")
    .addOptions([
      {
        label: "不指定陪陪",
        value: "不指定",
      },
      {
        label: "指定陪陪",
        value: "指定",
      },
      {
        label: "預約指定陪陪",
        value: "預約指定",
      },
    ]);

  const durationMenu = new StringSelectMenuBuilder()
    .setCustomId(`service_duration_${flowId}`)
    .setPlaceholder("請選擇時間")
    .addOptions([
      {
        label: "30 分鐘",
        value: "0.5",
      },
      {
        label: "1 小時",
        value: "1",
      },
      {
        label: "1.5 小時",
        value: "1.5",
      },
      {
        label: "2 小時",
        value: "2",
      },
      {
        label: "自訂",
        value: "custom",
      },
    ]);

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#cdb4db")
        .setTitle(title)
        .setDescription(
          `${description}\n\n` +
            `請依序選擇人數、性別、指定方式與時間。\n\n` +
            `⚠️ 價格僅供參考，正式報價由客服輸入。`
        )
        .setTimestamp(),
    ],
    components: [
      new ActionRowBuilder().addComponents(countMenu),
      new ActionRowBuilder().addComponents(genderMenu),
      new ActionRowBuilder().addComponents(assignMenu),
      new ActionRowBuilder().addComponents(durationMenu),
    ],
  });
}
async function openPlayOrderModal(interaction) {
  const flowId = `${interaction.user.id}_${Date.now()}`;

  pendingNewOrders.set(flowId, {
    userId: interaction.user.id,
    guildId:
      interaction.guildId || interaction.guild?.id || process.env.GUILD_ID,
    channelId: interaction.channel.id,
    game: "",
    item: "",
    rank: "",
    playerCount: 1,
    gender: "不指定",
    selectedPlayerType: "none",
    selectedPlayerId: null,
    selectedPlayerIds: [],
    duration: "",
    durationMinutes: 0,
    reservedTime: "",
    note: "無",
  });

  setTimeout(() => {
    pendingNewOrders.delete(flowId);
  }, ORDER_FLOW_TTL_MS);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`new_order_game_${flowId}`)
    .setPlaceholder("請選擇遊戲 / 服務類型")
    .addOptions([
      {
        label: "特戰英豪",
        description: "VALORANT 陪玩 / 技術單",
        value: "特戰英豪",
      },
      {
        label: "三角洲行動",
        description: "三角洲護航 / 保底 / 娛樂",
        value: "三角洲行動",
      },
      {
        label: "PUBG",
        description: "PUBG 陪玩",
        value: "PUBG",
      },
      {
        label: "STEAM",
        description: "Steam 遊戲陪玩",
        value: "STEAM",
      },
      {
        label: "陪聊服務",
        description: "聊天 / 陪伴 / 出氣",
        value: "陪聊服務",
      },
      {
        label: "打賞禮物",
        description: "打賞 / 禮物單",
        value: "打賞禮物",
      },
    ]);

  const row = new ActionRowBuilder().addComponents(menu);

  return interaction.reply({
    content: "🎮 請先選擇你要下單的遊戲 / 服務：",
    components: [row],
    flags: 64,
  });
}
function getOrderItemOptions(game) {
  if (game === "特戰英豪") {
    return [
      {
        label: "娛樂陪玩",
        value: "娛樂陪玩",
        description: "一般娛樂陪玩",
      },
      {
        label: "技術陪玩",
        value: "技術陪玩",
        description: "技術陪 / 強度單",
      },
    ];
  }

  if (game === "三角洲行動") {
    return [
      {
        label: "機密雙護",
        value: "機密雙護",
        description: "三角洲機密雙護",
      },
      {
        label: "猛攻護航",
        value: "猛攻護航",
        description: "三角洲猛攻護航",
      },
      {
        label: "娛樂陪玩",
        value: "娛樂陪玩",
        description: "一般娛樂陪玩",
      },
    ];
  }

  if (game === "PUBG") {
    return [
      {
        label: "娛樂單陪",
        value: "娛樂單陪",
        description: "PUBG 單陪",
      },
      {
        label: "娛樂雙陪",
        value: "娛樂雙陪",
        description: "PUBG 雙陪",
      },
    ];
  }

  if (game === "STEAM") {
    return [
      {
        label: "恐怖遊戲陪玩",
        value: "恐怖遊戲陪玩",
        description: "Steam 恐怖遊戲",
      },
      {
        label: "一般遊戲陪玩",
        value: "一般遊戲陪玩",
        description: "Steam 一般遊戲",
      },
    ];
  }

  if (game === "陪聊服務") {
    return [
      {
        label: "聊天陪伴",
        value: "聊天陪伴",
        description: "一般聊天陪伴",
      },
      {
        label: "出氣服務",
        value: "出氣服務",
        description: "陪聊 / 出氣",
      },
    ];
  }
  return [
    {
      label: "一般項目",
      value: "一般項目",
      description: "一般服務",
    },
  ];
}
async function handleNewOrderGameSelect(interaction) {
  const flowId = interaction.customId.replace("new_order_game_", "");

  const pending = pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      components: [],
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: "❌ 只有下單者可以操作這個選單。",
      flags: 64,
    });
  }

  const game = interaction.values[0];

  pending.game = game;
  pendingNewOrders.set(flowId, pending);
  if (game === "打賞禮物") {
    pendingNewOrders.delete(flowId);
    if (!paymentHelpers.startTipFlowInChannel) {
      return interaction.update({
        content:
          "❌ 打賞流程尚未接入，請確認 index.js 的 dispatchSystem.setup 有傳 startTipFlowInChannel。",
        components: [],
      });
    }
    await paymentHelpers.startTipFlowInChannel(
      interaction.channel,
      interaction.user
    );
    return interaction.update({
      content: "💝 已切換為打賞流程，請在下方選擇要打賞的禮物。",
      components: [],
    });
  }
  const options = getOrderItemOptions(game)
    .slice(0, 25)
    .map((item) => ({
      label: item.label.slice(0, 100),
      description: item.description.slice(0, 100),
      value: item.value,
    }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`new_order_item_${flowId}`)
    .setPlaceholder("請選擇項目")
    .addOptions(options);

  const row = new ActionRowBuilder().addComponents(menu);

  return interaction.update({
    content: `🎮 已選擇：${game}\n\n` + `請選擇你要的項目：`,
    components: [row, buildOrderBackRow(flowId, "game")],
  });
}
function getValorantRankOptions() {
  return [
    {
      label: "金牌含以下",
      value: "金牌含以下",
      description: "Gold and below",
    },
    {
      label: "白金",
      value: "白金",
      description: "Platinum",
    },
    {
      label: "鑽石",
      value: "鑽石",
      description: "Diamond",
    },
    {
      label: "超凡入聖",
      value: "超凡入聖",
      description: "Ascendant",
    },
    {
      label: "神話",
      value: "神話",
      description: "Immortal",
    },
    {
      label: "輻能戰魂",
      value: "輻能戰魂",
      description: "Radiant",
    },
    {
      label: "不指定 / 尚未確認",
      value: "不指定",
      description: "由客服協助確認",
    },
  ];
}
function isValorantRankGameBased(rank) {
  const value = String(rank || "");

  return (
    value.includes("白金") ||
    value.includes("鑽石") ||
    value.includes("超凡") ||
    value.includes("神話") ||
    value.includes("輻能")
  );
}
async function handleNewOrderItemSelect(interaction) {
  const flowId = interaction.customId.replace("new_order_item_", "");

  const pending = pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      components: [],
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: "❌ 只有下單者可以操作這個選單。",
      flags: 64,
    });
  }

  pending.item = interaction.values[0];
  pendingNewOrders.set(flowId, pending);
  if (pending.game === "特戰英豪") {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`new_order_rank_${flowId}`)
      .setPlaceholder("請選擇要打的段位")
      .addOptions(getValorantRankOptions());
    const row = new ActionRowBuilder().addComponents(menu);
    return interaction.update({
      content:
        `🎮 遊戲：${pending.game}\n` +
        `📌 項目：${pending.item}\n\n` +
        `請選擇這次要打的段位：`,
      components: [row, buildOrderBackRow(flowId, "item")],
    });
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`new_order_count_${flowId}`)
    .setPlaceholder("請選擇需要幾位陪陪")
    .addOptions([
      {
        label: "1 位陪陪",
        value: "1",
        description: "單陪",
      },
      {
        label: "2 位陪陪",
        value: "2",
        description: "雙陪",
      },
      {
        label: "3 位陪陪",
        value: "3",
        description: "三陪",
      },
      {
        label: "自訂",
        value: "custom",
        description: "由客服協助確認人數",
      },
    ]);

  const row = new ActionRowBuilder().addComponents(menu);

  return interaction.update({
    content:
      `🎮 遊戲：${pending.game}\n` +
      `📌 項目：${pending.item}\n\n` +
      `請選擇需要幾位陪陪：`,
    components: [row, buildOrderBackRow(flowId, "item")],
  });
}
async function handleNewOrderRankSelect(interaction) {
  const flowId = interaction.customId.replace("new_order_rank_", "");

  const pending = pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      components: [],
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: "❌ 只有下單者可以操作這個選單。",
      flags: 64,
    });
  }

  pending.rank = interaction.values[0];
  pendingNewOrders.set(flowId, pending);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`new_order_count_${flowId}`)
    .setPlaceholder("請選擇需要幾位陪陪")
    .addOptions([
      {
        label: "1 位陪陪",
        value: "1",
        description: "單陪",
      },
      {
        label: "2 位陪陪",
        value: "2",
        description: "雙陪",
      },
      {
        label: "3 位陪陪",
        value: "3",
        description: "三陪",
      },
      {
        label: "自訂",
        value: "custom",
        description: "由客服協助確認人數",
      },
    ]);

  const row = new ActionRowBuilder().addComponents(menu);

  return interaction.update({
    content:
      `🎮 遊戲：${pending.game}\n` +
      `📌 項目：${pending.item}\n` +
      `🏅 段位：${pending.rank || "未填寫"}\n\n` +
      `請選擇需要幾位陪陪：`,
    components: [row, buildOrderBackRow(flowId, "rank")],
  });
}
async function handleNewOrderCountSelect(interaction) {
  const flowId = interaction.customId.replace("new_order_count_", "");

  const pending = pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      components: [],
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: "❌ 只有下單者可以操作這個選單。",
      flags: 64,
    });
  }

  pending.playerCount =
    interaction.values[0] === "custom" ? 0 : Number(interaction.values[0]);

  pendingNewOrders.set(flowId, pending);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`new_order_gender_${flowId}`)
    .setPlaceholder("請選擇陪陪性別偏好")
    .addOptions([
      {
        label: "男陪",
        value: "男陪",
        description: "只看男陪",
      },
      {
        label: "女陪",
        value: "女陪",
        description: "只看女陪",
      },
      {
        label: "男女皆可",
        value: "男女皆可",
        description: "男陪女陪都可以",
      },
      {
        label: "不指定",
        value: "不指定",
        description: "不限制性別",
      },
    ]);

  const row = new ActionRowBuilder().addComponents(menu);

  return interaction.update({
    content:
      `🎮 遊戲：${pending.game}\n` +
      `📌 項目：${pending.item}\n` +
      (pending.game === "特戰英豪"
        ? `🏅 段位：${pending.rank || "未填寫"}\n`
        : "") +
      `👥 人數：${pending.playerCount || "自訂"}\n\n` +
      `請選擇陪陪性別偏好：`,
    components: [row, buildOrderBackRow(flowId, "count")],
  });
}
async function handleNewOrderGenderSelect(interaction) {
  const flowId = interaction.customId.replace("new_order_gender_", "");

  const pending = pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      components: [],
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: "❌ 只有下單者可以操作這個選單。",
      flags: 64,
    });
  }

  pending.gender = interaction.values[0];
  pendingNewOrders.set(flowId, pending);

  const playerOptions = await getQualifiedPlayerOptions(pending);

  if (!playerOptions.length) {
    return interaction.update({
      content:
        `🎮 遊戲：${pending.game}\n` +
        `📌 項目：${pending.item}\n` +
        (pending.game === "特戰英豪"
          ? `🏅 段位：${pending.rank || "未填寫"}\n`
          : "") +
        `👥 人數：${pending.playerCount || "自訂"}\n` +
        `🚻 性別偏好：${pending.gender}\n\n` +
        `❌ 目前沒有符合資格的陪陪，請聯繫客服協助安排。`,
      components: [],
    });
  }

  const maxPlayerCount = Math.max(1, Number(pending.playerCount || 1));
  pending.selectionExpiresAt = Date.now() + NEW_ORDER_SELECTION_TIMEOUT_MS;
  pendingNewOrders.set(flowId, pending);
  scheduleNewOrderSelectionTimeout(flowId);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`new_order_player_${flowId}`)
    .setPlaceholder(
      maxPlayerCount > 1 ? `可選 0～${maxPlayerCount} 位指定陪陪` : "請選擇陪陪"
    )
    .setMinValues(1)
    .setMaxValues(Math.min(maxPlayerCount, playerOptions.length))
    .addOptions(playerOptions);

  const row = new ActionRowBuilder().addComponents(menu);

  return interaction.update({
    content:
      `🎮 遊戲：${pending.game}\n` +
      `📌 項目：${pending.item}\n` +
      (pending.game === "特戰英豪"
        ? `🏅 段位：${pending.rank || "未填寫"}\n`
        : "") +
      `👥 人數：${pending.playerCount || "自訂"}\n` +
      `🚻 性別偏好：${pending.gender}\n\n` +
      `請選擇陪陪：\n` +
      `🟢 在線：可直接安排\n` +
      `⚪ 不在線：可查看可接單時間並預約\n` +
      `⏳ 請於 <t:${Math.floor(pending.selectionExpiresAt / 1000)}:R> 前完成選擇；需要更多時間可延長 5 分鐘。`,
    components: [
      row,
      buildNewOrderSelectionControlRow(flowId),
      buildOrderBackRow(flowId, "gender"),
    ],
  });
}
async function handleNewOrderPlayerSelect(interaction) {
  const flowId = interaction.customId.replace("new_order_player_", "");

  const pending = pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      components: [],
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: "❌ 只有下單者可以操作這個選單。",
      flags: 64,
    });
  }

  if (Number(pending.selectionExpiresAt || 0) <= Date.now()) {
    clearNewOrderSelectionTimer(flowId);
    pendingNewOrders.delete(flowId);
    return interaction.update({
      content: "❌ 選人時間已結束，這次自助下單已自動棄單，請重新填寫。",
      components: [],
    });
  }
  clearNewOrderSelectionTimer(flowId);
  delete pending.selectionExpiresAt;

  const selectedValues = interaction.values || [];
  if (selectedValues.includes("none")) {
    pending.selectedPlayerType = "none";
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pendingNewOrders.set(flowId, pending);
    return await showDurationSelect(interaction, flowId, pending);
  }
  const onlineIds = selectedValues
    .filter((value) => value.startsWith("online_"))
    .map((value) => value.replace("online_", ""));
  const reserveIds = selectedValues
    .filter((value) => value.startsWith("reserve_"))
    .map((value) => value.replace("reserve_", ""));
  const selectedIds = [...onlineIds, ...reserveIds]
    .map((id) => String(id).trim())
    .filter(Boolean);
  if (!selectedIds.length) {
    pending.selectedPlayerType = "none";
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pendingNewOrders.set(flowId, pending);
    return await showDurationSelect(interaction, flowId, pending);
  }
  pending.selectedPlayerIds = selectedIds;
  pending.selectedPlayerId = selectedIds[0];
  if (reserveIds.length > 0) {
    pending.selectedPlayerType = "reserve";
    pendingNewOrders.set(flowId, pending);
    let reserveQuery = supabase
      .from(STAFF_TABLE)
      .select("*")
      .in("discord_id", reserveIds);
    reserveQuery = applyStaffGuildFilter(reserveQuery);
    const { data: players } = await reserveQuery;
    const availableText =
      (players || [])
        .map((player) => {
          return `<@${player.discord_id}>：${formatAvailableTime(player)}`;
        })
        .join("\n") || "未填寫可接時間";
    const modal = new ModalBuilder()
      .setCustomId(`submit_new_order_reserve_time_${flowId}`)
      .setTitle("填寫預約時間");
    const reserveInput = new TextInputBuilder()
      .setCustomId("reserve_time")
      .setLabel("請輸入想預約的時間")
      .setPlaceholder("例如：今晚 20:00、明天 21:30、週六晚上")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(reserveInput));
    return await interaction.showModal(modal);
  }
  pending.selectedPlayerType = "online";
  pendingNewOrders.set(flowId, pending);
  return await showDurationSelect(interaction, flowId, pending);
}
async function showDurationSelect(interaction, flowId, pending) {
  const isValorantTech =
    pending.game === "特戰英豪" && pending.item === "技術陪玩";
  const isValorantGameBased =
    isValorantTech && isValorantRankGameBased(pending.rank);
  const options = isValorantGameBased
    ? [
        {
          label: "1 局",
          value: "game_1",
          description: "以局數計算",
        },
        {
          label: "3 局",
          value: "game_3",
          description: "以局數計算",
        },
        {
          label: "5 局",
          value: "game_5",
          description: "以局數計算",
        },
        {
          label: "自訂局數",
          value: "game_custom",
          description: "由客服協助確認局數",
        },
      ]
    : [
        {
          label: "30 分鐘",
          value: "30",
          description: "半小時",
        },
        {
          label: "60 分鐘",
          value: "60",
          description: "一小時",
        },
        {
          label: "90 分鐘",
          value: "90",
          description: "一小時半",
        },
        {
          label: "120 分鐘",
          value: "120",
          description: "兩小時",
        },
        {
          label: "自訂",
          value: "custom",
          description: "由客服協助確認時間",
        },
      ];

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`new_order_duration_${flowId}`)
    .setPlaceholder(isValorantGameBased ? "請選擇局數" : "請選擇時間段")
    .addOptions(options);

  const row = new ActionRowBuilder().addComponents(menu);

  const selectedPlayerIds = Array.isArray(pending.selectedPlayerIds)
    ? pending.selectedPlayerIds.map((id) => String(id).trim()).filter(Boolean)
    : [];
  const playerText =
    pending.selectedPlayerType === "none" || !selectedPlayerIds.length
      ? "不指定陪陪"
      : selectedPlayerIds.map((id) => `<@${id}>`).join("、");
  return interaction.update({
    content:
      `🎮 遊戲：${pending.game}\n` +
      `📌 項目：${pending.item}\n` +
      (pending.game === "特戰英豪"
        ? `🏅 段位：${pending.rank || "未填寫"}\n`
        : "") +
      `👥 人數：${pending.playerCount || "自訂"}\n` +
      `🚻 性別偏好：${pending.gender}\n` +
      `🌟 指定陪陪：${playerText}\n\n` +
      (isValorantGameBased ? `請選擇需要的局數：` : `請選擇需要的時間段：`),
    components: [row, buildOrderBackRow(flowId, "player")],
  });
}
async function handleNewOrderDurationSelect(interaction) {
  const flowId = interaction.customId.replace("new_order_duration_", "");

  const pending = pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      components: [],
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: "❌ 只有下單者可以操作這個選單。",
      flags: 64,
    });
  }

  const value = interaction.values[0];
  const isValorantTech =
    pending.game === "特戰英豪" && pending.item === "技術陪玩";
  const isValorantGameBased =
    isValorantTech && isValorantRankGameBased(pending.rank);
  if (isValorantGameBased) {
    if (value === "game_custom") {
      pending.duration = "自訂局數";
      pending.durationMinutes = 0;
      pending.gameCount = 0;
    } else {
      const count = Number(value.replace("game_", ""));
      pending.duration = `${count} 局`;
      pending.durationMinutes = 0;
      pending.gameCount = count;
    }
  } else {
    if (value === "custom") {
      pending.duration = "自訂";
      pending.durationMinutes = 0;
    } else {
      pending.duration = `${value} 分鐘`;
      pending.durationMinutes = Number(value);
    }
    pending.gameCount = 0;
  }
  pendingNewOrders.set(flowId, pending);
  return await askNewOrderNoteChoice(interaction, flowId, pending);
}
async function submitNewOrderReserveTime(interaction) {
  const flowId = interaction.customId.replace(
    "submit_new_order_reserve_time_",
    ""
  );

  const pending = pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.reply({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      flags: 64,
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: "❌ 只有下單者可以操作這個表單。",
      flags: 64,
    });
  }

  const reserveTime = interaction.fields.getTextInputValue("reserve_time");

  pending.reservedTime = reserveTime;
  pending.duration = "預約";
  pending.durationMinutes = 0;
  pendingNewOrders.set(flowId, pending);

  return await askNewOrderNoteChoice(interaction, flowId, pending);
}
async function askNewOrderNoteChoice(interaction, flowId, pending) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`new_order_note_yes_${flowId}`)
      .setLabel("我要填備註")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`new_order_note_no_${flowId}`)
      .setLabel("不填備註")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`new_order_back_duration_${flowId}`)
      .setLabel("⬅️ 上一步")
      .setStyle(ButtonStyle.Secondary)
  );

  const selectedPlayerIds = Array.isArray(pending.selectedPlayerIds)
    ? pending.selectedPlayerIds.map((id) => String(id).trim()).filter(Boolean)
    : [];
  const playerText =
    pending.selectedPlayerType === "none" || !selectedPlayerIds.length
      ? "不指定陪陪"
      : selectedPlayerIds.map((id) => `<@${id}>`).join("、");
  const timeText =
    pending.selectedPlayerType === "reserve"
      ? pending.reservedTime
      : pending.duration;

  const payload = {
    content:
      `📝 需求即將送出，是否要填寫備註？\n\n` +
      `🎮 遊戲：${pending.game}\n` +
      `📌 項目：${pending.item}\n` +
      (pending.game === "特戰英豪"
        ? `🏅 段位：${pending.rank || "未填寫"}\n`
        : "") +
      `👥 人數：${pending.playerCount || "自訂"}\n` +
      `🚻 性別偏好：${pending.gender}\n` +
      `🌟 指定陪陪：${playerText}\n` +
      `🕒 時間：${timeText || "未填寫"}\n\n` +
      `不填則預設為：無`,
    components: [row],
  };

  if (interaction.isModalSubmit()) {
    return interaction.reply({
      ...payload,
      flags: 64,
    });
  }

  return interaction.update(payload);
}
async function handleNewOrderBack(interaction) {
  const raw = interaction.customId.replace("new_order_back_", "");

  const firstUnderscore = raw.indexOf("_");

  const target = raw.slice(0, firstUnderscore);

  const flowId = raw.slice(firstUnderscore + 1);

  const pending = pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.update({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      components: [],
    });
  }

  if (!canCustomerOrStaffSubmit(interaction, pending.userId)) {
    return interaction.reply({
      content: "❌ 只有下單者、客服或管理員可以送出訂單。",
      flags: 64,
    });
  }

  if (target === "game") {
    pending.game = "";
    pending.item = "";
    pending.playerCount = 1;
    pending.gender = "不指定";
    pending.selectedPlayerType = "none";
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pending.duration = "";
    pending.durationMinutes = 0;
    pending.reservedTime = "";
    pending.note = "無";
    pendingNewOrders.set(flowId, pending);

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`new_order_game_${flowId}`)
      .setPlaceholder("請選擇遊戲 / 服務類型")
      .addOptions([
        {
          label: "特戰英豪",
          description: "VALORANT 陪玩 / 技術單",
          value: "特戰英豪",
        },
        {
          label: "三角洲行動",
          description: "三角洲護航 / 保底 / 娛樂",
          value: "三角洲行動",
        },
        {
          label: "PUBG",
          description: "PUBG 陪玩",
          value: "PUBG",
        },
        {
          label: "STEAM",
          description: "Steam 遊戲陪玩",
          value: "STEAM",
        },
        {
          label: "陪聊服務",
          description: "聊天 / 陪伴 / 出氣",
          value: "陪聊服務",
        },
        {
          label: "打賞禮物",
          description: "打賞 / 禮物單",
          value: "打賞禮物",
        },
      ]);

    const row = new ActionRowBuilder().addComponents(menu);

    return interaction.update({
      content: "🎮 請重新選擇你要下單的遊戲 / 服務：",
      components: [row],
    });
  }

  if (target === "item") {
    pending.item = "";
    pending.playerCount = 1;
    pending.gender = "不指定";
    pending.selectedPlayerType = "none";
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pending.duration = "";
    pending.durationMinutes = 0;
    pending.reservedTime = "";
    pending.note = "無";
    pendingNewOrders.set(flowId, pending);

    const options = getOrderItemOptions(pending.game)
      .slice(0, 25)
      .map((item) => ({
        label: item.label.slice(0, 100),
        description: item.description.slice(0, 100),
        value: item.value,
      }));

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`new_order_item_${flowId}`)
      .setPlaceholder("請選擇項目")
      .addOptions(options);

    const row = new ActionRowBuilder().addComponents(menu);

    return interaction.update({
      content: `🎮 遊戲：${pending.game}\n\n` + `請重新選擇你要的項目：`,
      components: [row, buildOrderBackRow(flowId, "game")],
    });
  }
  if (target === "rank") {
    pending.rank = "";
    pending.playerCount = 1;
    pending.gender = "不指定";
    pending.selectedPlayerType = "none";
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pending.duration = "";
    pending.durationMinutes = 0;
    pending.reservedTime = "";
    pending.note = "無";
    pendingNewOrders.set(flowId, pending);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`new_order_rank_${flowId}`)
      .setPlaceholder("請選擇要打的段位")
      .addOptions(getValorantRankOptions());
    const row = new ActionRowBuilder().addComponents(menu);
    return interaction.update({
      content:
        `🎮 遊戲：${pending.game}\n` +
        `📌 項目：${pending.item}\n\n` +
        `請重新選擇這次要打的段位：`,
      components: [row, buildOrderBackRow(flowId, "item")],
    });
  }
  if (target === "count") {
    pending.playerCount = 1;
    pending.gender = "不指定";
    pending.selectedPlayerType = "none";
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pending.duration = "";
    pending.durationMinutes = 0;
    pending.reservedTime = "";
    pending.note = "無";
    pendingNewOrders.set(flowId, pending);

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`new_order_count_${flowId}`)
      .setPlaceholder("請選擇需要幾位陪陪")
      .addOptions([
        {
          label: "1 位陪陪",
          value: "1",
          description: "單陪",
        },
        {
          label: "2 位陪陪",
          value: "2",
          description: "雙陪",
        },
        {
          label: "3 位陪陪",
          value: "3",
          description: "三陪",
        },
        {
          label: "自訂",
          value: "custom",
          description: "由客服協助確認人數",
        },
      ]);

    const row = new ActionRowBuilder().addComponents(menu);

    return interaction.update({
      content:
        `🎮 遊戲：${pending.game}\n` +
        `📌 項目：${pending.item}\n` +
        (pending.game === "特戰英豪"
          ? `🏅 段位：${pending.rank || "未填寫"}\n`
          : "") +
        `請重新選擇需要幾位陪陪：`,
      components: [
        row,
        buildOrderBackRow(
          flowId,
          pending.game === "特戰英豪" ? "rank" : "item"
        ),
      ],
    });
  }

  if (target === "gender") {
    clearNewOrderSelectionTimer(flowId);
    delete pending.selectionExpiresAt;
    pending.gender = "不指定";
    pending.selectedPlayerType = "none";
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pending.duration = "";
    pending.durationMinutes = 0;
    pending.reservedTime = "";
    pending.note = "無";
    pendingNewOrders.set(flowId, pending);

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`new_order_gender_${flowId}`)
      .setPlaceholder("請選擇陪陪性別偏好")
      .addOptions([
        {
          label: "男陪",
          value: "男陪",
          description: "只看男陪",
        },
        {
          label: "女陪",
          value: "女陪",
          description: "只看女陪",
        },
        {
          label: "男女皆可",
          value: "男女皆可",
          description: "男陪女陪都可以",
        },
        {
          label: "不指定",
          value: "不指定",
          description: "不限制性別",
        },
      ]);

    const row = new ActionRowBuilder().addComponents(menu);

    return interaction.update({
      content:
        `🎮 遊戲：${pending.game}\n` +
        `📌 項目：${pending.item}\n` +
        `👥 人數：${pending.playerCount || "自訂"}\n\n` +
        `請重新選擇陪陪性別偏好：`,
      components: [row, buildOrderBackRow(flowId, "count")],
    });
  }

  if (target === "player") {
    pending.selectedPlayerType = "none";
    pending.selectedPlayerId = null;
    pending.selectedPlayerIds = [];
    pending.duration = "";
    pending.durationMinutes = 0;
    pending.reservedTime = "";
    pending.note = "無";
    pendingNewOrders.set(flowId, pending);

    const playerOptions = await getQualifiedPlayerOptions(pending);

    if (!playerOptions.length) {
      return interaction.update({
        content:
          `🎮 遊戲：${pending.game}\n` +
          `📌 項目：${pending.item}\n` +
          `👥 人數：${pending.playerCount || "自訂"}\n` +
          `🚻 性別偏好：${pending.gender}\n\n` +
          `❌ 目前沒有符合資格的陪陪，請聯繫客服協助安排。`,
        components: [buildOrderBackRow(flowId, "gender")],
      });
    }

    pending.selectionExpiresAt = Date.now() + NEW_ORDER_SELECTION_TIMEOUT_MS;
    pendingNewOrders.set(flowId, pending);
    scheduleNewOrderSelectionTimeout(flowId);

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`new_order_player_${flowId}`)
      .setPlaceholder("請選擇陪陪，或選擇不指定")
      .addOptions(playerOptions);

    const row = new ActionRowBuilder().addComponents(menu);

    return interaction.update({
      content:
        `🎮 遊戲：${pending.game}\n` +
        `📌 項目：${pending.item}\n` +
        `👥 人數：${pending.playerCount || "自訂"}\n` +
        `🚻 性別偏好：${pending.gender}\n\n` +
        `請重新選擇陪陪：\n` +
        `⏳ 請於 <t:${Math.floor(pending.selectionExpiresAt / 1000)}:R> 前完成選擇；需要更多時間可延長 5 分鐘。`,
      components: [
        row,
        buildNewOrderSelectionControlRow(flowId),
        buildOrderBackRow(flowId, "gender"),
      ],
    });
  }

  if (target === "duration") {
    pending.duration = "";
    pending.durationMinutes = 0;
    pending.reservedTime = "";
    pending.note = "無";
    pendingNewOrders.set(flowId, pending);

    return await showDurationSelect(interaction, flowId, pending);
  }

  return interaction.reply({
    content: "❌ 找不到上一個步驟",
    flags: 64,
  });
}
async function openNewOrderNoteModal(interaction) {
  const flowId = interaction.customId.replace("new_order_note_yes_", "");

  const pending = pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.reply({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      flags: 64,
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.reply({
      content: "❌ 只有下單者可以操作這個按鈕。",
      flags: 64,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId(`submit_new_order_note_${flowId}`)
    .setTitle("填寫需求備註");

  const noteInput = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("請輸入備註")
    .setPlaceholder("例如：希望語音、不要太吵、指定風格、特殊需求")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(noteInput));

  return interaction.showModal(modal);
}
async function handleNewOrderNoNote(interaction) {
  const flowId = interaction.customId.replace("new_order_note_no_", "");

  const pending = pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      components: [],
    });
  }

  if (!canCustomerOrStaffSubmit(interaction, pending.userId)) {
    return interaction.editReply({
      content: "❌ 只有下單者、客服或管理員可以送出訂單。",
      components: [],
    });
  }

  pending.note = "無";
  pendingNewOrders.set(flowId, pending);

  return await createWaitingQuoteOrder(interaction, flowId, pending);
}
async function submitNewOrderNote(interaction) {
  const flowId = interaction.customId.replace("submit_new_order_note_", "");

  const pending = pendingNewOrders.get(flowId);

  if (!pending) {
    return interaction.reply({
      content: "❌ 這筆下單流程已過期，請重新填寫。",
      flags: 64,
    });
  }

  if (!canCustomerOrStaffSubmit(interaction, pending.userId)) {
    return interaction.reply({
      content: "❌ 只有下單者、客服或管理員可以送出訂單。",
      flags: 64,
    });
  }

  const note = interaction.fields.getTextInputValue("note") || "無";

  pending.note = note;
  pendingNewOrders.set(flowId, pending);

  return await createWaitingQuoteOrder(interaction, flowId, pending);
}
async function createWaitingQuoteOrder(interaction, flowId, pending) {
  const orderNo = await getNextPlayOrderNumber();

  const service = `${pending.game}｜${pending.item}`;

  const timeText =
    pending.selectedPlayerType === "reserve"
      ? pending.reservedTime
      : pending.duration;

  const selectedPlayerIds = Array.isArray(pending.selectedPlayerIds)
    ? pending.selectedPlayerIds.map((id) => String(id).trim()).filter(Boolean)
    : [];
  const preferredPlayer = selectedPlayerIds.length
    ? selectedPlayerIds.join(",")
    : null;

  const { data: order, error } = await supabase
    .from("play_orders")
    .insert({
      guild_id:
        pending.guildId ||
        interaction.guildId ||
        interaction.guild?.id ||
        process.env.GUILD_ID,
      order_no: orderNo,
      customer_id: pending.userId,
      customer_username: pending.username || interaction.user.username,
      channel_id: pending.channelId || interaction.channel.id,

      game: pending.game,
      order_item: pending.item,
      rank_preference: pending.rank || null,
      player_count: pending.playerCount || 0,
      gender_preference: pending.gender,
      preferred_player_type: pending.selectedPlayerType,

      service,
      preferred_player: preferredPlayer,
      reserved_player:
        pending.selectedPlayerType === "reserve" ? preferredPlayer : null,
      reserved_time:
        pending.selectedPlayerType === "reserve" ? pending.reservedTime : null,

      duration_minutes: pending.durationMinutes || 0,
      duration_text: timeText || "未填寫",

      note: pending.note || "無",
      price: 0,
      final_price: 0,
      original_price: 0,
      discount_rate: 1,
      discount_amount: 0,
      payment_method: "未選擇",
      paid: false,

      status: "waiting_quote",
      quote_status: "waiting_quote",
      confirmed_by_customer: false,
    })
    .select()
    .single();

  if (error || !order) {
    console.error("[新下單] 建立待報價訂單失敗", error);
    const payload = {
      content:
        "❌ 建立訂單失敗，請檢查 Supabase play_orders 欄位是否完整。\n" +
        `錯誤：${error?.message || "未知錯誤"}`,
      components: [],
    };
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply(payload).catch(async () => {
        return interaction
          .followUp({
            ...payload,
            flags: 64,
          })
          .catch(() => {});
      });
    }
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      return interaction.update(payload).catch(async () => {
        return interaction
          .reply({
            ...payload,
            flags: 64,
          })
          .catch(() => {});
      });
    }
    return interaction
      .reply({
        ...payload,
        flags: 64,
      })
      .catch(() => {});
  }
  pendingNewOrders.delete(flowId);

  const embed = new EmbedBuilder()
    .setColor("#ffd166")
    .setTitle("🧾 已送出需求｜等待客服報價")
    .addFields(
      {
        name: "📌 訂單編號",
        value: order.order_no,
        inline: true,
      },
      {
        name: "🎮 遊戲 / 服務",
        value: pending.game,
        inline: true,
      },
      {
        name: "📦 項目",
        value: pending.item,
        inline: true,
      },
      {
        name: "🏅 段位",
        value: pending.rank || "不指定",
        inline: true,
      },
      {
        name: "👥 陪陪人數",
        value: String(pending.playerCount || "自訂"),
        inline: true,
      },
      {
        name: "🚻 性別偏好",
        value: pending.gender || "不指定",
        inline: true,
      },
      {
        name: "🌟 陪陪",
        value: selectedPlayerIds.length
          ? selectedPlayerIds.map((id) => `<@${id}>`).join("、")
          : "不指定",
      },
      {
        name: "🕒 時間",
        value: timeText || "未填寫",
        inline: true,
      },
      {
        name: "📝 備註",
        value: pending.note || "無",
        inline: false,
      }
    )
    .setDescription(
      `需求已送出，請等待客服報價。\n` +
        `客服填寫金額後，系統會讓你選擇優惠券與付款方式。`
    )
    .setTimestamp();

  const payload = {
    content: `<@${pending.userId}> 你的需求已送出，請等待客服報價。`,
    embeds: [embed],
    components: [],
  };

  if (interaction.isModalSubmit()) {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(async () => {
        await interaction
          .followUp({
            ...payload,
            flags: 64,
          })
          .catch(() => {});
      });
    } else {
      await interaction
        .reply({
          ...payload,
          flags: 64,
        })
        .catch(() => {});
    }
  } else {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(async () => {
        await interaction
          .followUp({
            ...payload,
            flags: 64,
          })
          .catch(() => {});
      });
    } else {
      await interaction.update(payload).catch(async () => {
        await interaction
          .reply({
            ...payload,
            flags: 64,
          })
          .catch(() => {});
      });
    }
  }
  await sendStaffQuotePanel(order);
  return true;
}
async function sendStaffQuotePanel(order) {
  const channel = await client.channels
    .fetch(order.channel_id)
    .catch(() => null);

  if (!channel) {
    console.error("[新下單] 找不到訂單頻道，無法送客服報價面板");
    return;
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`staff_quote_price_${order.id}`)
      .setLabel("客服填寫金額")
      .setEmoji("💰")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`dispatch_assign_players_${order.id}`)
      .setLabel("客服選擇陪陪")
      .setEmoji("🌟")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`staff_edit_order_${order.id}`)
      .setLabel("修改訂單內容")
      .setEmoji("🛠️")
      .setStyle(ButtonStyle.Secondary)
  );
  await channel.send({
    content:
      `<@&${process.env.STAFF_ROLE}> 有新的需求等待報價。\n` +
      `請客服確認陪陪與金額後，再讓闆闆選擇付款方式。`,
    embeds: [
      new EmbedBuilder()
        .setColor("#66ccff")
        .setTitle("🧾 客服報價區")
        .addFields(
          {
            name: "📌 訂單編號",
            value: order.order_no || String(order.id),
            inline: true,
          },
          {
            name: "👤 客人",
            value: `<@${order.customer_id}>`,
            inline: true,
          },
          {
            name: "🎮 服務",
            value: order.service || "未填寫",
            inline: false,
          },
          {
            name: "🏅 段位",
            value: order.rank_preference || "不指定",
            inline: true,
          },
          {
            name: "👥 人數",
            value: String(order.player_count || "自訂"),
            inline: true,
          },
          {
            name: "🚻 性別偏好",
            value: order.gender_preference || "不指定",
            inline: true,
          },
          {
            name: "🕒 時間",
            value: order.reserved_time || order.duration_text || "未填寫",
            inline: true,
          },
          {
            name: "📝 備註",
            value: order.note || "無",
            inline: false,
          }
        )
        .setDescription(
          `這則訊息是客服操作用。\n` + `目前客人尚未付款，也尚未正式派單。`
        )
        .setTimestamp(),
    ],
    components: [row],
  });
}
async function openStaffQuotePriceModal(interaction) {
  if (
    !interaction.member.roles.cache.has(process.env.STAFF_ROLE) &&
    !interaction.member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return interaction.reply({
      content: "❌ 只有客服可以填寫報價",
      flags: 64,
    });
  }

  const orderId = interaction.customId.replace("staff_quote_price_", "");

  const modal = new ModalBuilder()
    .setCustomId(`submit_staff_quote_price_${orderId}`)
    .setTitle("客服填寫訂單金額");

  const priceInput = new TextInputBuilder()
    .setCustomId("price")
    .setLabel("請輸入原價金額")
    .setPlaceholder("例如：499")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(priceInput));

  return interaction.showModal(modal);
}
async function submitStaffQuotePrice(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  if (
    !interaction.member.roles.cache.has(process.env.STAFF_ROLE) &&
    !interaction.member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return interaction.editReply({
      content: "❌ 只有客服可以填寫報價",
    });
  }

  const orderId = interaction.customId.replace("submit_staff_quote_price_", "");

  const priceText = interaction.fields.getTextInputValue("price");

  const price = Number(priceText.replace(/[^\d]/g, ""));

  if (!price || price <= 0) {
    return interaction.editReply({
      content: "❌ 金額格式錯誤，請輸入大於 0 的數字",
    });
  }

  const { data: order, error } = await supabase
    .from("play_orders")
    .update({
      price,
      final_price: price,
      original_price: price,
      quoted_by: interaction.user.id,
      quote_status: "quoted",
      status: "quoted",
    })
    .eq("id", orderId)
    .select()
    .single();

  if (error || !order) {
    console.error("[客服報價] 更新金額失敗", error);
    return interaction.editReply({
      content: "❌ 更新報價失敗",
    });
  }

  if (hasCustomerServicePointRole(interaction, CUSTOMER_SERVICE_POINT_ROLE_ID)) {
    await awardCustomerServicePoint(order.id, interaction.user.id);
  }

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#ffd166")
        .setTitle("💰 客服已完成報價")
        .setDescription(
          `訂單編號：${order.order_no || order.id}\n` +
            `報價金額：NT$${price.toLocaleString("zh-TW")}\n` +
            `報價客服：<@${interaction.user.id}>\n\n` +
            `<@${order.customer_id}> 請選擇是否使用優惠券。`
        )
        .setTimestamp(),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`quote_use_coupon_${order.id}`)
          .setLabel("使用優惠券")
          .setEmoji("🎟️")
          .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
          .setCustomId(`quote_no_coupon_${order.id}`)
          .setLabel("不使用優惠券")
          .setStyle(ButtonStyle.Secondary)
      ),
    ],
  });

  return interaction.editReply({
    content: `✅ 已填寫報價 NT$${price.toLocaleString("zh-TW")}`,
  });
}
async function handleQuoteNoCoupon(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }
  const orderId = interaction.customId.replace("quote_no_coupon_", "");

  const { data: order, error: orderError } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .eq("guild_id", DEEPNIGHT_GUILD_ID)
    .single();

  if (orderError || !order) {
    console.error("[報價流程] 讀取訂單失敗", orderError);
    return interaction.editReply({
      content: "❌ 找不到訂單",
    });
  }

  if (order.customer_id !== interaction.user.id) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以選擇優惠券",
    });
  }

  const originalPrice = Number(
    order.original_price || order.price || order.final_price || 0,
  );

  const { data: updatedOrder, error: updateError } = await supabase
    .from("play_orders")
    .update({
      coupon_name: null,
      coupon_text: "未使用優惠券",
      coupon_item_id: null,
      coupon_consumed_at: null,
      discount_rate: 1,
      discount_amount: 0,
      final_price: originalPrice,
    })
    .eq("id", orderId)
    .eq("customer_id", interaction.user.id)
    .select()
    .single();

  if (updateError || !updatedOrder) {
    console.error("[報價流程] 不使用優惠券失敗", updateError);
    return interaction.editReply({
      content: "❌ 設定優惠券失敗",
    });
  }

  await sendPaymentMethodSelect(interaction.channel, updatedOrder);

  return interaction.editReply({
    content: "✅ 已選擇不使用優惠券",
  });
}
function getCouponDiscount(itemName = "") {
  const name = String(itemName || "");
  const fixedAmountMatch = name.match(/(\d+(?:\.\d+)?)\s*ASD\s*折價券/i);

  if (fixedAmountMatch) {
    const fixedAmount = Number(fixedAmountMatch[1]);
    return {
      rate: 1,
      fixedAmount,
      label: `折抵 ${fixedAmount.toLocaleString("zh-TW")} ASD`,
    };
  }

  if (name.includes("95折")) {
    return {
      rate: 0.95,
      label: "95折券",
    };
  }

  if (name.includes("9折")) {
    return {
      rate: 0.9,
      label: "9折券",
    };
  }

  if (name.includes("8折")) {
    return {
      rate: 0.8,
      label: "8折券",
    };
  }

  if (name.includes("7折")) {
    return {
      rate: 0.7,
      label: "7折券",
    };
  }

  if (name.includes("6折")) {
    return {
      rate: 0.6,
      label: "6折券",
    };
  }

  return {
    rate: 1,
    label: name || "未知優惠券",
  };
}
function getCouponMaxDiscountPrice(itemName = "") {
  const name = String(itemName || "");

  if (name.includes("95折")) {
    return 500;
  }

  if (name.includes("9折")) {
    return 800;
  }

  if (name.includes("8折")) {
    return 3000;
  }

  if (name.includes("7折")) {
    return 5000;
  }

  if (name.includes("6折")) {
    return 5000;
  }

  return null;
}
async function handleQuoteUseCoupon(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const orderId = interaction.customId.replace("quote_use_coupon_", "");

  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (error || !order) {
    return interaction.editReply({
      content: "❌ 找不到訂單",
    });
  }

  if (order.customer_id !== interaction.user.id) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以選擇優惠券",
    });
  }

  const { data: coupons, error: couponError } = await supabase
    .from("user_items")
    .select("*")
    .eq("user_id", interaction.user.id)
    .eq("guild_id", DEEPNIGHT_GUILD_ID)
    .or("item_type.eq.coupon,item_name.ilike.%折券%,item_name.ilike.%優惠券%")
    .order("created_at", { ascending: false });

  if (couponError) {
    console.error("[報價優惠券] 讀取優惠券失敗", couponError);
    return interaction.editReply({
      content: "❌ 讀取優惠券失敗，請稍後再試",
    });
  }

  if (!coupons || coupons.length === 0) {
    return interaction.editReply({
      content: "❌ 你目前沒有可使用的優惠券。\n" + "請改選「不使用優惠券」。",
      components: [],
    });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`quote_select_coupon_${order.id}`)
    .setPlaceholder("請選擇要使用的優惠券")
    .addOptions(
      coupons.slice(0, 25).map((coupon) => {
        const discount = getCouponDiscount(coupon.item_name);

        return {
          label: String(coupon.item_name).slice(0, 100),
          description: `${discount.label}｜${
            coupon.description || "優惠券"
          }`.slice(0, 100),
          value: String(coupon.id),
        };
      })
    );

  const row = new ActionRowBuilder().addComponents(menu);

  return interaction.editReply({
    content:
      `🎟️ 請選擇要使用的優惠券：\n\n` +
      `訂單金額：NT$${Number(
        order.final_price || order.price || 0
      ).toLocaleString("zh-TW")}`,
    components: [row],
  });
}
async function handleQuoteSelectCoupon(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const orderId = interaction.customId.replace("quote_select_coupon_", "");

  const couponId = interaction.values[0];

  const { data: order, error: orderError } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (orderError || !order) {
    return interaction.editReply({
      content: "❌ 找不到訂單",
    });
  }

  if (order.customer_id !== interaction.user.id) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以使用優惠券",
    });
  }

  const { data: coupon, error: couponError } = await supabase
    .from("user_items")
    .select("*")
    .eq("id", Number(couponId))
    .eq("user_id", interaction.user.id)
    .eq("guild_id", DEEPNIGHT_GUILD_ID)
    .maybeSingle();
  if (
    couponError ||
    !coupon ||
    !(
      coupon.item_type === "coupon" ||
      String(coupon.item_name || "").includes("折券") ||
      String(coupon.item_name || "").includes("優惠券")
    )
  ) {
    return interaction.editReply({
      content: "❌ 找不到這張優惠券，可能已經被使用",
    });
  }

  const originalPrice = Number(
    order.original_price || order.price || order.final_price || 0
  );

  if (!originalPrice || originalPrice <= 0) {
    return interaction.editReply({
      content: "❌ 訂單金額錯誤，請聯繫客服重新報價",
    });
  }

  const maxPrice = getCouponMaxDiscountPrice(coupon.item_name);

  if (maxPrice && originalPrice > maxPrice) {
    return interaction.editReply({
      content:
        `❌ 這張優惠券只限 NT$${maxPrice} 內訂單使用。\n` +
        `目前訂單金額：NT$${originalPrice.toLocaleString("zh-TW")}`,
    });
  }

  const discount = getCouponDiscount(coupon.item_name);

  const finalPrice = discount.fixedAmount
    ? Math.max(0, originalPrice - discount.fixedAmount)
    : Math.floor(originalPrice * discount.rate);

  const discountAmount = originalPrice - finalPrice;

  const { data: updatedOrder, error: updateError } = await supabase
    .from("play_orders")
    .update({
      discount_rate: discount.rate,
      discount_amount: discountAmount,
      final_price: finalPrice,
      coupon_name: coupon.item_name,
      coupon_text: coupon.item_name,
      coupon_item_id: coupon.id,
      coupon_consumed_at: null,
    })
    .eq("id", order.id)
    .select()
    .single();

  if (updateError || !updatedOrder) {
    console.error("[報價優惠券] 更新訂單失敗", updateError);
    return interaction.editReply({
      content: "❌ 套用優惠券失敗",
    });
  }

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#57F287")
        .setTitle("🎟️ 優惠券已套用")
        .setDescription(
          `<@${interaction.user.id}> 已套用：${coupon.item_name}\n` +
            `優惠券會在付款成功後才從背包扣除。\n\n` +
            `原價：NT$${originalPrice.toLocaleString("zh-TW")}\n` +
            `折扣：NT$${discountAmount.toLocaleString("zh-TW")}\n` +
            `折後金額：NT$${finalPrice.toLocaleString("zh-TW")}`
        )
        .setTimestamp(),
    ],
  });

  await sendPaymentMethodSelect(interaction.channel, updatedOrder);

  return interaction.editReply({
    content: "✅ 優惠券已套用，付款成功後才會使用，請繼續選擇付款方式",
    components: [],
  });
}
async function sendPaymentMethodSelect(channel, order) {
  const includeSalary = await isActiveDeepnightStaff(order.customer_id);
  const rows = buildPaymentMethodButtonRows(
    `quote_payment_method_${order.id}`,
    getCanonicalPaymentOptions({
      includeWallet: true,
      includeEcpay: paymentHelpers.ecpayAvailable,
      includeSalary,
    }),
  );

  await channel.send({
    content: `<@${order.customer_id}> 請選擇付款方式：`,
    components: rows,
  });
}
async function handleQuotePaymentMethodSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }
  await resetSelectMenuMessage(interaction);

  const selection = getPaymentMethodSelection(interaction, "quote_payment_method_");
  const orderId = selection?.entityId;
  const paymentMethod = selection?.paymentMethod;

  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (error || !order) {
    return interaction.editReply({
      content: "❌ 找不到訂單",
    });
  }

  if (order.customer_id !== interaction.user.id) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以選擇付款方式",
    });
  }
  if (order.paid) {
    return interaction.editReply({
      content:
        `❌ 這張訂單已經完成付款，不能重複選擇付款方式。\n` +
        `目前付款方式：${order.payment_method || "已付款"}`,
    });
  }
  if (String(paymentMethod).includes("扣薪")) {
    const amount = Number(order.final_price || order.price || 0);
    try {
      const eligibility = await getSalaryDeductionEligibility(
        order.customer_id,
        amount,
      );
      if (!eligibility.state.canUse) {
        return interaction.editReply({
          content:
            `❌ 無法使用扣薪付款：每人最多預支 NT$${eligibility.state.advanceLimit.toLocaleString("zh-TW")}。\n` +
            `本筆確認後會預支 NT$${eligibility.state.projectedAdvance.toLocaleString("zh-TW")}，已超過上限。`,
        });
      }

      await createSalaryDeductionPrompt({
        channel: interaction.channel,
        customerId: order.customer_id,
        amount,
        eligibility,
        confirmId: `salary_quote_confirm_${order.id}`,
        cancelId: `salary_quote_cancel_${order.id}`,
      });
      return interaction.editReply({
        content: "✅ 已送出扣薪確認，請等待客服或管理員處理。",
      });
    } catch (err) {
      return interaction.editReply({
        content: `❌ 無法使用扣薪付款：${err.message || err}`,
      });
    }
  }
  if (paymentMethod === "綠界支付") {
    if (!paymentHelpers.ecpayAvailable || !paymentHelpers.createEcpayServicePayment)
      return interaction.editReply({ content: "❌ 綠界信用卡付款目前尚未開放，請重新選擇付款方式。" });
    const amount = Number(order.final_price || order.price || 0);
    try {
      const payment = await paymentHelpers.createEcpayServicePayment({
        kind: "order", entityKey: String(order.id), userId: order.customer_id, amount,
        channelId: interaction.channel.id,
        description: `陪玩訂單 ${order.order_no || order.id}`,
        metadata: { flow: "quote", orderIds: [order.id], orderNo: order.order_no || null },
      });
      const { error: updateError } = await supabase.from("play_orders").update({
        payment_method: "綠界支付", status: "waiting_payment", updated_at: new Date().toISOString(),
      }).eq("id", order.id).eq("paid", false);
      if (updateError) throw updateError;
      await sendEcpayPaymentPrompt(interaction.channel, order.customer_id, amount, payment, "訂單");
      return interaction.editReply({ content: "✅ 已建立綠界付款連結，付款完成後會自動核帳。" });
    } catch (err) {
      return interaction.editReply({ content: `❌ 建立綠界付款失敗：${err.message || err}` });
    }
  }
  if (
    paymentMethod === "街口支付" &&
    paymentHelpers.jkopayAvailable &&
    paymentHelpers.createJkopayServicePayment
  ) {
    const amount = Number(order.final_price || order.price || 0);
    try {
      const payment = await paymentHelpers.createJkopayServicePayment({
        kind: "order",
        entityKey: String(order.id),
        userId: order.customer_id,
        amount,
        channelId: interaction.channel.id,
        description: `陪玩訂單 ${order.order_no || order.id}`,
        metadata: { flow: "quote", orderIds: [order.id], orderNo: order.order_no || null },
      });
      const { error: updateError } = await supabase.from("play_orders").update({
        payment_method: "街口支付",
        status: "waiting_payment",
        updated_at: new Date().toISOString(),
      }).eq("id", order.id).eq("paid", false);
      if (updateError) throw updateError;
      await sendJkopayPaymentPrompt(interaction.channel, order.customer_id, amount, payment, "訂單");
      return interaction.editReply({ content: "✅ 已建立街口付款連結，付款完成後會自動核帳。" });
    } catch (err) {
      return interaction.editReply({ content: `❌ 建立街口付款失敗：${err.message || err}` });
    }
  }
  let paidNow = false;
  let paidAt = null;
  if (isWalletPayment(paymentMethod)) {
    try {
      if (!paymentHelpers.payOrderByWallet) {
        throw new Error("錢包付款函式尚未接入 dispatchSystem");
      }
      const result = await paymentHelpers.payOrderByWallet(order);
      paidNow = true;
      paidAt = new Date().toISOString();
      await interaction.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor("#66ccff")
            .setTitle("💳 錢包扣款完成")
            .setDescription(
              `<@${order.customer_id}> 已使用錢包扣款。\n\n` +
                `扣款金額：${result.amount} 星雨幣\n` +
                `剩餘餘額：${result.finalCoins} 星雨幣`
            )
            .setTimestamp(),
        ],
      });
    } catch (err) {
      if (
        await recoverIfPaymentAlreadyCompleted(
          order.id,
          ["customer_confirmation", "order_financial_effects"],
        ).catch(() => false)
      ) {
        return interaction.editReply({
          content:
            "⚠️ 儲值卡扣款已完成，不會重複扣款；訂單確認面板已排入自動重試。",
        });
      }
      return interaction.editReply({
        content: `❌ 儲值卡付款失敗：${err.message}`,
      });
    }
  } else if (isMonthlyPayment(paymentMethod)) {
    try {
      if (!paymentHelpers.payOrderByMonthly) {
        throw new Error("月結付款函式尚未接入 dispatchSystem");
      }
      const result = await paymentHelpers.payOrderByMonthly(order);
      paidNow = true;
      paidAt = new Date().toISOString();
      await interaction.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor("#66ccff")
            .setTitle("🌙 月結付款完成")
            .setDescription(
              `<@${order.customer_id}> 已使用月結付款。\n\n` +
                `本筆金額：NT$${result.amount}\n` +
                `本筆回饋：${result.cashback} 星雨幣\n` +
                `剩餘月結額度：NT$${result.availableAmount}`
            )
            .setTimestamp(),
        ],
      });
    } catch (err) {
      if (
        await recoverIfPaymentAlreadyCompleted(
          order.id,
          ["customer_confirmation", "order_financial_effects"],
        ).catch(() => false)
      ) {
        return interaction.editReply({
          content:
            "⚠️ 月結扣額已完成，不會重複扣額；訂單確認面板已排入自動重試。",
        });
      }
      return interaction.editReply({
        content: `❌ 月結付款失敗：${err.message}`,
      });
    }
  }
  const { data: updatedOrder, error: updateError } = await supabase
    .from("play_orders")
    .update({
      payment_method: paymentMethod,
      status: paidNow ? "waiting_confirm" : "waiting_payment",
      paid: paidNow ? true : order.paid,
      paid_at: paidNow ? paidAt : order.paid_at,
    })
    .eq("id", order.id)
    .select()
    .single();
  if (updateError || !updatedOrder) {
    console.error("[報價流程] 更新付款方式失敗", updateError);
    return interaction.editReply({
      content: "❌ 更新付款方式失敗",
    });
  }

  if (isCardPayment(paymentMethod)) {
    await sendCardPaymentInfo(interaction.channel);
  } else if (isNoCardPayment(paymentMethod)) {
    await sendNoCardPaymentInfo(interaction.channel);
  } else if (isBankTransfer(paymentMethod)) {
    await sendBankTransferInfo(interaction.channel);
  } else if (
    paymentMethod.includes("美金") ||
    paymentMethod.includes("加密貨幣")
  ) {
    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#ffaa00")
          .setTitle("💳 特殊付款方式")
          .setDescription(
            `<@${order.customer_id}> 你選擇了：${getPaymentMethodDisplayName(paymentMethod)}\n\n` +
              `請等待客服提供付款帳號 / 錢包地址。\n` +
              `付款完成後請上傳付款截圖，等待客服確認。`
          )
          .setTimestamp(),
      ],
    });
  }
  if (paidNow) {
    await processOrderDeliveryNow(updatedOrder.id, "customer_confirmation");
    await processOrderDeliveryNow(updatedOrder.id, "order_financial_effects");
  } else {
    await sendCustomerFinalConfirm(interaction.channel, updatedOrder);
  }
  if (!paidNow) {
    await interaction.channel.send({
      content: `<@&${process.env.STAFF_ROLE}> 請客服確認此訂單是否已付款`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`staff_confirm_order_paid_${order.id}`)
            .setLabel("客服確認已付款")
            .setStyle(ButtonStyle.Success)
        ),
      ],
    });
  }
  return interaction.editReply({
    content: `✅ 已選擇付款方式：${getPaymentMethodDisplayName(paymentMethod)}`,
  });
}

async function handleSalaryQuoteConfirm(interaction) {
  await deferReplyOnce(interaction);
  if (!canApproveSalaryDeduction(interaction)) {
    return interaction.editReply({
      content: "❌ 只有客服或管理員可以確認扣薪付款。",
    });
  }

  const orderId = interaction.customId.replace("salary_quote_confirm_", "");
  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();
  if (error || !order) {
    return interaction.editReply({ content: "❌ 找不到這張訂單。" });
  }
  if (order.paid) {
    return interaction.editReply({ content: "❌ 這張訂單已完成付款。" });
  }

  const amount = Number(order.final_price || order.price || 0);
  let paymentCompleted = false;
  try {
    const result = await applySalaryDeductionToOrders({
      customerId: order.customer_id,
      amount,
      orderIds: [order.id],
      finalStatus: "waiting_confirm",
      confirmedBy: interaction.user.id,
    });
    paymentCompleted = true;
    const paidOrder = result.orders[0];
    await interaction.message.edit({ components: [] }).catch(() => null);
    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#57F287")
          .setTitle("✅ 扣薪付款完成")
          .setDescription(
            `<@${order.customer_id}> 已使用薪資支付 NT$${amount.toLocaleString("zh-TW")}。\n` +
              `深夜 EIP 已新增扣項：使用薪水點單\n` +
              `由 <@${interaction.user.id}> 確認。`,
          )
          .setTimestamp(),
      ],
    });
    await processOrderDeliveryNow(paidOrder.id, "customer_confirmation");
    await processOrderDeliveryNow(paidOrder.id, "order_financial_effects");
    return interaction.editReply({
      content: "✅ 已確認扣薪付款，深夜 EIP 扣項已建立。",
    });
  } catch (err) {
    return interaction.editReply({
      content: paymentCompleted
        ? `⚠️ 扣薪與深夜 EIP 扣項已完成，但通知訊息發送失敗：${err.message || err}`
        : `❌ 扣薪付款失敗：${err.message || err}`,
    });
  }
}

async function handleSalaryQuoteCancel(interaction) {
  await deferReplyOnce(interaction);
  if (!canApproveSalaryDeduction(interaction)) {
    return interaction.editReply({
      content: "❌ 只有客服或管理員可以取消扣薪付款。",
    });
  }

  const orderId = interaction.customId.replace("salary_quote_cancel_", "");
  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();
  if (error || !order) {
    return interaction.editReply({ content: "❌ 找不到這張訂單。" });
  }
  if (order.paid) {
    return interaction.editReply({ content: "❌ 這張訂單已完成付款。" });
  }

  await interaction.message.edit({ components: [] }).catch(() => null);
  await sendPaymentMethodSelect(interaction.channel, order);
  return interaction.editReply({
    content: "✅ 已取消扣薪付款，請員工重新選擇付款方式。",
  });
}
async function sendCustomerFinalConfirm(channel, order) {
  if (order.customer_confirm_message_id) {
    const existingMessage = await channel.messages
      .fetch(String(order.customer_confirm_message_id))
      .catch(() => null);
    if (existingMessage) return existingMessage;
  }
  const recoveredMessage = await findRecentBotMessage(
    channel,
    `customer_confirm_order_${order.id}`,
  );
  if (recoveredMessage) {
    await checkpointOrderMessage(
      order,
      "customer_confirm_message_id",
      recoveredMessage.id,
    );
    return recoveredMessage;
  }
  const preferredText = buildPreferredPlayerText(order.preferred_player);

  const embed = new EmbedBuilder()
    .setColor("#57F287")
    .setTitle("📋 請確認訂單資訊")
    .setDescription(
      `<@${order.customer_id}> 請確認以下訂單資訊是否正確。\n\n` +
        `確認後，系統才會正式發送派單資訊。`
    )
    .addFields(
      {
        name: "📌 訂單編號",
        value: order.order_no || String(order.id),
        inline: true,
      },
      {
        name: "🎮 遊戲 / 服務",
        value: order.game || order.service || "未填寫",
        inline: true,
      },
      {
        name: "📦 項目",
        value: order.order_item || "未填寫",
        inline: true,
      },
      {
        name: "👥 人數",
        value: String(order.player_count || "自訂"),
        inline: true,
      },
      {
        name: "🚻 性別偏好",
        value: order.gender_preference || "不指定",
        inline: true,
      },
      {
        name: "🌟 陪陪",
        value: preferredText,
        inline: true,
      },
      {
        name: "🕒 時間",
        value: order.reserved_time || order.duration_text || "未填寫",
        inline: true,
      },
      {
        name: "💰 金額",
        value: `NT$${Number(
          order.final_price || order.price || 0
        ).toLocaleString("zh-TW")}`,
        inline: true,
      },
      {
        name: "🎟️ 優惠券",
        value: order.coupon_text || "未使用優惠券",
        inline: true,
      },
      {
        name: "💳 付款方式",
        value: order.payment_method || "未選擇",
        inline: true,
      },
      {
        name: "📝 備註",
        value: order.note || "無",
        inline: false,
      }
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`customer_confirm_order_${order.id}`)
      .setLabel("確認正確")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`customer_order_wrong_${order.id}`)
      .setLabel("內容有誤")
      .setEmoji("✏️")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`extend_order_${order.id}`)
      .setLabel("➕ 加時 / 續單")
      .setStyle(ButtonStyle.Primary)
  );

  const message = await channel.send({
    embeds: [embed],
    components: [row],
  });
  await checkpointOrderMessage(order, "customer_confirm_message_id", message.id);
  return message;
}
async function handleStaffConfirmOrderPaid(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  if (
    !interaction.member.roles.cache.has(process.env.STAFF_ROLE) &&
    !interaction.member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return interaction.editReply({
      content: "❌ 只有客服可以確認付款",
    });
  }

  const orderId = interaction.customId.replace("staff_confirm_order_paid_", "");
  let paymentCommitted = false;
  try {
    const { data, error } = await supabase.rpc(
      "deepnight_confirm_manual_payment",
      {
        p_order_ids: [orderId],
        p_guild_id: DEEPNIGHT_GUILD_ID,
        p_confirmed_by: interaction.user.id,
        p_delivery_type: "customer_confirmation",
      },
    );
    if (error) throw error;
    paymentCommitted = true;
    const order = Array.isArray(data?.orders) ? data.orders[0] : null;
    if (!order) throw new Error("確認付款後找不到深夜訂單");
    await processOrderDeliveryNow(order.id, "order_financial_effects");
    await processOrderDeliveryNow(order.id, "customer_confirmation");
    return interaction.editReply({
      content: "✅ 已標記為已付款，訂單確認面板已送出。",
    });
  } catch (error) {
    console.error("[客服確認付款] 付款或後續處理失敗", error);
    const recovered =
      paymentCommitted ||
      (await recoverIfPaymentAlreadyCompleted(orderId, [
        "order_financial_effects",
        "customer_confirmation",
      ]).catch(() => false));
    return interaction.editReply({
      content: recovered
        ? "⚠️ 付款已確認，不會重複入帳；後續面板與財務效果已排入自動重試。"
        : `❌ 確認付款失敗：${error.message || error}`,
    });
  }
}
async function handleCustomerConfirmOrder(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const orderId = interaction.customId.replace("customer_confirm_order_", "");

  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (error || !order) {
    console.error("[闆闆確認訂單] 找不到訂單", error);
    return interaction.editReply({
      content: "❌ 找不到這張訂單",
    });
  }

  if (!canCustomerOrStaffSubmit(interaction, order.customer_id)) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆、客服或管理員可以確認訂單",
    });
  }

  if (!Number(order.final_price || order.price || 0)) {
    return interaction.editReply({
      content: "❌ 這張訂單尚未填寫金額，請等待客服報價",
    });
  }

  if (!order.payment_method || order.payment_method === "未選擇") {
    return interaction.editReply({
      content: "❌ 這張訂單尚未選擇付款方式",
    });
  }
  if (!order.paid) {
    return interaction.editReply({
      content: "❌ 尚未由客服確認付款，請付款後等待客服確認。",
    });
  }

  const { data: updatedOrder, error: updateError } = await supabase.rpc(
    "deepnight_confirm_order_and_enqueue",
    {
      p_order_id: order.id,
      p_customer_id: order.customer_id,
      p_guild_id: DEEPNIGHT_GUILD_ID,
    },
  );

  if (updateError || !updatedOrder) {
    console.error("[闆闆確認訂單] 更新失敗", updateError);
    return interaction.editReply({
      content: "❌ 確認訂單失敗，請稍後再試",
    });
  }

  let dispatchWarning = null;
  try {
    await processOrderDeliveryNow(updatedOrder.id, "order_dispatch");
  } catch (error) {
    dispatchWarning = error;
    console.error(
      "[闆闆確認訂單] 已保存派單補償工作，首次發送失敗",
      error,
    );
  }

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#57F287")
        .setTitle("✅ 訂單已確認，已送出派單")
        .setDescription(
          `訂單編號：${updatedOrder.order_no || updatedOrder.id}\n` +
            `闆闆：<@${updatedOrder.customer_id}>\n\n` +
            (dispatchWarning
              ? `首次派單通知失敗，系統已排入自動重試，不需再次付款或確認。`
              : `系統已將此單送到員工接單區，請等待陪陪接單。`)
        )
        .setTimestamp(),
    ],
  });

  await sendPlayLog({
    title: "✅ 訂單已確認並派單",
    description:
      `訂單編號：${updatedOrder.order_no || updatedOrder.id}\n` +
      `闆闆：<@${updatedOrder.customer_id}>\n` +
      `服務：${updatedOrder.service || "未填寫"}\n` +
      `金額：NT$${updatedOrder.final_price || updatedOrder.price || 0}`,
    color: "#57F287",
  });

  return interaction.editReply({
    content: "✅ 訂單已確認，已正式派單",
  });
}
async function handleCustomerOrderWrong(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }
  const orderId = interaction.customId.replace("customer_order_wrong_", "");

  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (error || !order) {
    return interaction.editReply({
      content: "❌ 找不到這張訂單",
    });
  }

  if (order.customer_id !== interaction.user.id) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以回報內容有誤",
    });
  }

  await supabase
    .from("play_orders")
    .update({
      quote_status: "need_fix",
      status: "quoted",
    })
    .eq("id", order.id);

  const staffFixRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`staff_edit_order_${order.id}`)
      .setLabel("客服修改訂單內容")
      .setEmoji("🛠️")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`change_order_price_${order.id}`)
      .setLabel("修改金額")
      .setEmoji("💰")
      .setStyle(ButtonStyle.Secondary)
  );
  await interaction.channel.send({
    content:
      `<@&${process.env.STAFF_ROLE}> 闆闆回報訂單內容有誤，請客服協助修改。\n` +
      `訂單編號：${order.order_no || order.id}`,
    components: [staffFixRow],
  });
  return interaction.editReply({
    content: "✅ 已通知客服協助修改訂單內容",
  });
}
async function openStaffEditOrderModal(interaction) {
  const orderId = interaction.customId.replace("staff_edit_order_", "");

  const isStaff =
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.reply({
      content: "❌ 只有客服可以修改訂單",
      flags: 64,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId(`submit_staff_edit_order_${orderId}`)
    .setTitle("客服修改訂單內容");

  const serviceInput = new TextInputBuilder()
    .setCustomId("service")
    .setLabel("服務項目")
    .setPlaceholder("例如：特戰英豪 技術陪玩")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  const timeInput = new TextInputBuilder()
    .setCustomId("time")
    .setLabel("時間 / 局數")
    .setPlaceholder("例如：3局、60分鐘、今晚22:00")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  const noteInput = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("備註 / 需求")
    .setPlaceholder("要修改的備註內容")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);
  const playerCountInput = new TextInputBuilder()
    .setCustomId("player_count")
    .setLabel("陪陪數量")
    .setPlaceholder("例如：1、2、3；不改就留空")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);
  const preferredPlayerInput = new TextInputBuilder()
    .setCustomId("preferred_player")
    .setLabel("指定陪陪 / 不指定")
    .setPlaceholder("輸入 不指定，或貼上陪陪 Discord ID / @陪陪")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);
  modal.addComponents(
    new ActionRowBuilder().addComponents(serviceInput),
    new ActionRowBuilder().addComponents(timeInput),
    new ActionRowBuilder().addComponents(noteInput),
    new ActionRowBuilder().addComponents(preferredPlayerInput),
    new ActionRowBuilder().addComponents(playerCountInput)
  );

  return interaction.showModal(modal);
}
async function submitStaffEditOrder(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const orderId = interaction.customId.replace("submit_staff_edit_order_", "");

  const isStaff =
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.editReply({
      content: "❌ 只有客服可以修改訂單",
    });
  }

  const { data: currentOrder, error: currentOrderError } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .single();
  if (currentOrderError || !currentOrder) {
    return interaction.editReply({ content: "❌ 找不到這張訂單" });
  }

  const service = interaction.fields.getTextInputValue("service") || "";

  const time = interaction.fields.getTextInputValue("time") || "";

  const note = interaction.fields.getTextInputValue("note") || "";

  const preferredPlayerRaw =
    interaction.fields.getTextInputValue("preferred_player") || "";
  const playerCountRaw =
    interaction.fields.getTextInputValue("player_count") || "";
  const preserveDispatch =
    Boolean(currentOrder.assigned_player) &&
    ["pending", "accepted", "completed"].includes(currentOrder.status);
  const updateData = preserveDispatch
    ? {}
    : { quote_status: "fixed", status: "quoted" };
  if (playerCountRaw.trim()) {
    const playerCount = Number(playerCountRaw.replace(/[^\d]/g, ""));
    if (!playerCount || playerCount <= 0) {
      return interaction.editReply({
        content: "❌ 陪陪數量格式錯誤，請輸入 1、2、3 這種數字",
      });
    }
    updateData.player_count = playerCount;
  }
  if (preferredPlayerRaw.trim()) {
    const raw = preferredPlayerRaw.trim();
    if (raw === "不指定" || raw === "無" || raw.toLowerCase() === "none") {
      updateData.preferred_player = null;
      updateData.preferred_player_type = "none";
      updateData.reserved_player = null;
      updateData.dispatch_type = null;
    } else {
      const playerIds = raw
        .split(/[\s,，、]+/)
        .map((text) =>
          text
            .replace(/[<@!>]/g, "")
            .replace(/[^0-9]/g, "")
            .trim()
        )
        .filter(Boolean);
      if (playerIds.length) {
        updateData.preferred_player = playerIds.join(",");
        updateData.preferred_player_type = "online";
        updateData.reserved_player = null;
        updateData.dispatch_type = "preferred";
        if (
          !updateData.player_count ||
          Number(updateData.player_count) < playerIds.length
        ) {
          updateData.player_count = playerIds.length;
        }
      }
    }
  }
  if (service.trim()) {
    updateData.service = service.trim();
  }

  if (time.trim()) {
    updateData.reserved_time = time.trim();
    updateData.duration_text = time.trim();
  }

  if (note.trim()) {
    updateData.note = note.trim();
  }

  const { data: updatedOrder, error } = await supabase
    .from("play_orders")
    .update(updateData)
    .eq("id", orderId)
    .select()
    .single();

  if (error || !updatedOrder) {
    console.error("[客服修改訂單失敗]", error);
    return interaction.editReply({
      content: "❌ 修改訂單失敗，請查看後台 Logs",
    });
  }
  try {
    await workReportSystem.syncAcceptedOrder(updatedOrder);
  } catch (syncError) {
    console.error("[客服修改訂單] 同步填單失敗", syncError);
    return interaction.editReply({
      content:
        "⚠️ 訂單已修改，但同步陪陪填單失敗，請查看 Railway Logs 後再操作。",
    });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`customer_confirm_order_${updatedOrder.id}`)
      .setLabel("確認訂單")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId(`customer_order_wrong_${updatedOrder.id}`)
      .setLabel("內容有誤")
      .setEmoji("⚠️")
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#66ccff")
        .setTitle("🛠️ 訂單內容已由客服修改")
        .setDescription(
          `訂單編號：${updatedOrder.order_no || updatedOrder.id}\n` +
            `闆闆：<@${updatedOrder.customer_id}>\n\n` +
            `🎮 服務：${updatedOrder.service || "未填寫"}\n` +
            `🌟 指定陪陪：${
              updatedOrder.preferred_player
                ? buildPreferredPlayerText(updatedOrder.preferred_player)
                : "不指定"
            }\n` +
            `🕒 時間 / 局數：${
              updatedOrder.reserved_time ||
              updatedOrder.duration_text ||
              "未填寫"
            }\n` +
            `💰 金額：NT$${
              updatedOrder.final_price || updatedOrder.price || 0
            }\n` +
            `💳 付款方式：${updatedOrder.payment_method || "未選擇"}\n` +
            `📝 備註：${updatedOrder.note || "無"}\n\n` +
            `請闆闆重新確認訂單內容。`
        )
        .setTimestamp(),
    ],
    components: preserveDispatch ? [] : [row],
  });

  return interaction.editReply({
    content: preserveDispatch
      ? "✅ 已修改訂單，原訂單與既有陪陪填單已同步更新"
      : "✅ 已修改訂單，並重新送出給闆闆確認",
  });
}
async function openExtendOrderModal(interaction) {
  const isStaff =
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.reply({
      content: "❌ 只有客服可以建立加時",
      flags: 64,
    });
  }

  const orderId = interaction.customId.replace("extend_order_", "");

  const modal = new ModalBuilder()
    .setCustomId(`submit_extend_order_${orderId}`)
    .setTitle("建立加時 / 續單");

  const textInput = new TextInputBuilder()
    .setCustomId("extension_text")
    .setLabel("加時內容")
    .setPlaceholder("例如：30分鐘、1局、3局、續聊1小時")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const amountInput = new TextInputBuilder()
    .setCustomId("amount")
    .setLabel("加時金額")
    .setPlaceholder("例如：150")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const noteInput = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("備註")
    .setPlaceholder("例如：客人要求延長，陪陪同意")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(textInput),
    new ActionRowBuilder().addComponents(amountInput),
    new ActionRowBuilder().addComponents(noteInput)
  );

  return interaction.showModal(modal);
}
async function submitExtendOrder(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const isStaff =
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.editReply({
      content: "❌ 只有客服可以建立加時",
    });
  }

  const orderId = interaction.customId.replace("submit_extend_order_", "");

  const extensionText = interaction.fields.getTextInputValue("extension_text");

  const amountText = interaction.fields.getTextInputValue("amount");

  const note = interaction.fields.getTextInputValue("note") || "";

  const amount = Number(amountText.replace(/[^\d]/g, ""));

  if (!amount || amount <= 0) {
    return interaction.editReply({
      content: "❌ 加時金額格式錯誤，請輸入大於 0 的數字",
    });
  }

  const { data: order, error: orderError } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .eq("guild_id", DEEPNIGHT_GUILD_ID)
    .single();

  if (orderError || !order) {
    console.error("[加時] 找不到原訂單", orderError);
    return interaction.editReply({
      content: "❌ 找不到原訂單",
    });
  }

  const { data: extension, error: insertError } = await supabase
    .from("order_extensions")
    .insert({
      guild_id: DEEPNIGHT_GUILD_ID,
      order_id: order.id,
      order_no: order.order_no || null,
      customer_id: order.customer_id,
      channel_id: order.channel_id || interaction.channel.id,
      staff_id: interaction.user.id,
      extension_text: extensionText,
      amount,
      payment_method: "未選擇",
      paid: false,
      status: "pending",
      applied_to_salary: false,
      note,
    })
    .select()
    .single();

  if (insertError || !extension) {
    console.error(
      "[加時] 建立加時失敗完整錯誤",
      JSON.stringify(insertError, null, 2)
    );
    return interaction.editReply({
      content:
        "❌ 建立加時失敗\n" +
        `錯誤訊息：${insertError?.message || "未知錯誤"}\n` +
        `錯誤代碼：${insertError?.code || "無"}\n` +
        `詳細資訊：${insertError?.details || "無"}\n` +
        `提示：${insertError?.hint || "無"}`,
    });
  }

  await sendExtensionPaymentMethodSelect(interaction.channel, extension);

  return interaction.editReply({
    content:
      `✅ 已建立加時：${extensionText}\n` +
      `金額：NT$${amount.toLocaleString("zh-TW")}`,
  });
}
async function sendExtensionPaymentMethodSelect(channel, extension) {
  const includeSalary = await isActiveDeepnightStaff(extension.customer_id);
  const rows = buildPaymentMethodButtonRows(
    `extension_payment_method_${extension.id}`,
    getCanonicalPaymentOptions({
      includeWallet: true,
      includeEcpay: paymentHelpers.ecpayAvailable,
      includeMonthly: true,
      includeSalary,
    }),
  );

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#66ccff")
        .setTitle("➕ 加時付款")
        .setDescription(
          `<@${extension.customer_id}> 請選擇加時付款方式。\n\n` +
            `原訂單：${extension.order_no || extension.order_id}\n` +
            `加時內容：${extension.extension_text}\n` +
            `加時金額：NT$${Number(extension.amount || 0).toLocaleString(
              "zh-TW"
            )}`
        )
        .setTimestamp(),
    ],
    components: rows,
  });
}
async function handleExtensionPaymentMethodSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }
  await resetSelectMenuMessage(interaction);

  const selection = getPaymentMethodSelection(interaction, "extension_payment_method_");
  const extensionId = selection?.entityId;
  const paymentMethod = selection?.paymentMethod;

  const { data: extension, error } = await supabase
    .from("order_extensions")
    .select("*")
    .eq("id", extensionId)
    .eq("guild_id", DEEPNIGHT_GUILD_ID)
    .single();

  if (error || !extension) {
    return interaction.editReply({
      content: "❌ 找不到加時資料",
    });
  }

  if (extension.customer_id !== interaction.user.id) {
    return interaction.editReply({
      content: "❌ 只有這筆訂單的闆闆可以選擇付款方式",
    });
  }

  const amount = Number(extension.amount || 0);

  if (extension.paid) {
    return interaction.editReply({
      content: "⚠️ 這筆加時已經付款過了，不能重複選擇付款方式。",
    });
  }

  if (String(paymentMethod).includes("扣薪")) {
    try {
      const eligibility = await getSalaryDeductionEligibility(
        extension.customer_id,
        amount,
      );
      if (!eligibility.state.canUse) {
        return interaction.editReply({
          content:
            `❌ 無法使用扣薪付款：每人最多預支 NT$${eligibility.state.advanceLimit.toLocaleString("zh-TW")}。\n` +
            `本筆確認後會預支 NT$${eligibility.state.projectedAdvance.toLocaleString("zh-TW")}，已超過上限。`,
        });
      }

      const { error: updateError } = await supabase
        .from("order_extensions")
        .update({
          payment_method: "扣薪",
          status: "waiting_salary_confirm",
          updated_at: new Date().toISOString(),
        })
        .eq("id", extension.id)
        .or("paid.eq.false,paid.is.null");
      if (updateError) throw updateError;

      await createSalaryDeductionPrompt({
        channel: interaction.channel,
        customerId: extension.customer_id,
        amount,
        eligibility,
        confirmId: `salary_extension_confirm_${extension.id}`,
        cancelId: `salary_extension_cancel_${extension.id}`,
        purpose: "續單",
      });
      return interaction.editReply({
        content: "✅ 已送出續單扣薪確認，請等待客服或管理員處理。",
      });
    } catch (err) {
      return interaction.editReply({
        content: `❌ 無法使用續單扣薪付款：${err.message || err}`,
      });
    }
  }

  if (paymentMethod === "綠界支付") {
    if (!paymentHelpers.ecpayAvailable || !paymentHelpers.createEcpayServicePayment)
      return interaction.editReply({ content: "❌ 綠界信用卡付款目前尚未開放，請重新選擇付款方式。" });
    try {
      const payment = await paymentHelpers.createEcpayServicePayment({
        kind: "extension", entityKey: String(extension.id), userId: extension.customer_id, amount,
        channelId: interaction.channel.id,
        description: `訂單加時 ${extension.order_no || extension.order_id}`,
        metadata: { extensionId: extension.id, orderId: extension.order_id, orderNo: extension.order_no || null },
      });
      const { error: updateError } = await supabase.from("order_extensions").update({
        payment_method: "綠界支付", status: "waiting_payment", updated_at: new Date().toISOString(),
      }).eq("id", extension.id).or("paid.eq.false,paid.is.null");
      if (updateError) throw updateError;
      await sendEcpayPaymentPrompt(interaction.channel, extension.customer_id, amount, payment, "加時");
      return interaction.editReply({ content: "✅ 已建立加時綠界付款連結，付款完成後會自動核帳。" });
    } catch (err) {
      return interaction.editReply({ content: `❌ 建立綠界付款失敗：${err.message || err}` });
    }
  }
  if (
    paymentMethod === "街口支付" &&
    paymentHelpers.jkopayAvailable &&
    paymentHelpers.createJkopayServicePayment
  ) {
    try {
      const payment = await paymentHelpers.createJkopayServicePayment({
        kind: "extension",
        entityKey: String(extension.id),
        userId: extension.customer_id,
        amount,
        channelId: interaction.channel.id,
        description: `訂單加時 ${extension.order_no || extension.order_id}`,
        metadata: { extensionId: extension.id, orderId: extension.order_id, orderNo: extension.order_no || null },
      });
      const { error: updateError } = await supabase.from("order_extensions").update({
        payment_method: "街口支付",
        status: "waiting_payment",
        updated_at: new Date().toISOString(),
      }).eq("id", extension.id).or("paid.eq.false,paid.is.null");
      if (updateError) throw updateError;
      await sendJkopayPaymentPrompt(interaction.channel, extension.customer_id, amount, payment, "加時");
      return interaction.editReply({ content: "✅ 已建立加時街口付款連結，付款完成後會自動核帳。" });
    } catch (err) {
      return interaction.editReply({ content: `❌ 建立街口付款失敗：${err.message || err}` });
    }
  }

  if (String(paymentMethod).includes("月結")) {
    try {
      const { data: result, error: paymentError } = await supabase.rpc(
        "deepnight_pay_extension_with_monthly",
        {
          p_extension_id: Number(extension.id),
          p_customer_id: extension.customer_id,
          p_guild_id: DEEPNIGHT_GUILD_ID,
        },
      );
      if (paymentError || !result) {
        throw new Error(paymentError?.message || "加時月結原子付款失敗");
      }
      await processOrderDeliveryNow(extension.id, "extension_financial_effects", {
        payload: { extension_id: extension.id, payment_method: "月結" },
      }).catch((recoveryError) =>
        console.error("[加時月結] 後續已排程重試", recoveryError),
      );

      await interaction.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor("#57F287")
            .setTitle("✅ 加時月結付款完成")
            .setDescription(
              `原訂單：${extension.order_no || extension.order_id}\n` +
                `闆闆：<@${extension.customer_id}>\n` +
                `加時內容：${extension.extension_text}\n` +
                `本筆金額：NT$${amount.toLocaleString("zh-TW")}\n` +
                `本筆回饋：${Number(result.cashback || 0).toLocaleString("zh-TW")} 星雨幣\n` +
                `剩餘月結額度：NT$${Number(result.available_amount || 0).toLocaleString("zh-TW")}`,
            )
            .setTimestamp(),
        ],
      });
      return interaction.editReply({ content: "✅ 已使用月結完成加時付款。" });
    } catch (err) {
      return interaction.editReply({
        content: `❌ 加時月結付款失敗：${err.message || err}`,
      });
    }
  }

  // 儲值卡直接扣款
  if (isWalletPayment(paymentMethod)) {
    await supabase
      .from("order_extensions")
      .update({
        payment_method: paymentMethod,
        status: "waiting_wallet_confirm",
        updated_at: new Date().toISOString(),
      })
      .eq("id", extension.id);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm_extension_wallet_${extension.id}`)
        .setLabel("確認錢包扣款")
        .setEmoji("💳")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`cancel_extension_wallet_${extension.id}`)
        .setLabel("取消此付款方式")
        .setStyle(ButtonStyle.Danger)
    );
    await interaction.channel.send({
      content: `<@${extension.customer_id}>`,
      embeds: [
        new EmbedBuilder()
          .setColor("#ffd166")
          .setTitle("💳 確認加時錢包扣款")
          .setDescription(
            `請確認是否使用錢包扣款。\n\n` +
              `原訂單：${extension.order_no || extension.order_id}\n` +
              `加時內容：${extension.extension_text}\n` +
              `扣款金額：${Number(extension.amount || 0).toLocaleString(
                "zh-TW"
              )} ASD\n\n` +
              `確認後會直接從你的 ASD 餘額扣款。`
          )
          .setTimestamp(),
      ],
      components: [row],
    });
    return interaction.editReply({
      content: "✅ 已選擇錢包扣款，請闆闆確認是否使用此付款方式。",
    });
  }
  const { data: updatedExtension, error: updateError } = await supabase
    .from("order_extensions")
    .update({
      payment_method: paymentMethod,
      status: "waiting_payment",
    })
    .eq("id", extension.id)
    .select()
    .single();

  if (updateError || !updatedExtension) {
    console.error("[加時] 更新付款方式失敗", updateError);
    return interaction.editReply({
      content: "❌ 更新加時付款方式失敗",
    });
  }

  if (isCardPayment(paymentMethod)) {
    await sendCardPaymentInfo(interaction.channel);
  } else if (isNoCardPayment(paymentMethod)) {
    await sendNoCardPaymentInfo(interaction.channel);
  } else if (isBankTransfer(paymentMethod)) {
    await sendBankTransferInfo(interaction.channel);
  } else if (
    paymentMethod.includes("美金") ||
    paymentMethod.includes("加密貨幣")
  ) {
    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#ffaa00")
          .setTitle("💳 特殊付款方式")
          .setDescription(
            `<@${extension.customer_id}> 你選擇了：${getPaymentMethodDisplayName(paymentMethod)}\n\n` +
              `請等待客服提供付款帳號 / 錢包地址。\n` +
              `付款完成後請上傳付款截圖，等待客服確認。`
          )
          .setTimestamp(),
      ],
    });
  }

  await interaction.channel.send({
    content: `<@&${process.env.STAFF_ROLE}> 請客服確認這筆加時是否已付款`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`staff_confirm_extension_paid_${extension.id}`)
          .setLabel("客服確認加時已付款")
          .setStyle(ButtonStyle.Success)
      ),
    ],
  });

  return interaction.editReply({
    content: `✅ 已選擇加時付款方式：${getPaymentMethodDisplayName(paymentMethod)}`,
  });
}

async function handleSalaryExtensionConfirm(interaction) {
  await deferReplyOnce(interaction);
  if (!canApproveSalaryDeduction(interaction)) {
    return interaction.editReply({
      content: "❌ 只有客服或管理員可以確認續單扣薪付款。",
    });
  }

  const extensionId = interaction.customId.replace(
    "salary_extension_confirm_",
    "",
  );
  const { data: extension, error } = await supabase
    .from("order_extensions")
    .select("*")
    .eq("id", extensionId)
    .eq("guild_id", DEEPNIGHT_GUILD_ID)
    .maybeSingle();
  if (error || !extension) {
    return interaction.editReply({ content: "❌ 找不到這筆加時資料。" });
  }
  if (extension.paid) {
    return interaction.editReply({ content: "❌ 這筆加時已完成付款。" });
  }
  if (extension.payment_method !== "扣薪") {
    return interaction.editReply({
      content: "❌ 這筆加時目前不是扣薪付款，請重新選擇付款方式。",
    });
  }

  const amount = Number(extension.amount || 0);
  if (!amount || amount <= 0) {
    return interaction.editReply({ content: "❌ 加時金額錯誤。" });
  }

  try {
    const { data: result, error: paymentError } = await supabase.rpc(
      "deepnight_pay_extension_with_salary",
      {
        p_extension_id: Number(extension.id),
        p_customer_id: extension.customer_id,
        p_guild_id: DEEPNIGHT_GUILD_ID,
        p_confirmed_by: interaction.user.id,
      },
    );
    if (paymentError || !result) {
      throw new Error(paymentError?.message || "續單扣薪原子付款失敗");
    }
    await processOrderDeliveryNow(extension.id, "extension_financial_effects", {
      payload: { extension_id: extension.id, payment_method: "扣薪" },
    }).catch((recoveryError) =>
      console.error("[加時扣薪] 後續已排程重試", recoveryError),
    );

    await interaction.message.edit({ components: [] }).catch(() => null);
    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#57F287")
          .setTitle("✅ 續單扣薪付款完成")
          .setDescription(
            `原訂單：${extension.order_no || extension.order_id}\n` +
              `闆闆：<@${extension.customer_id}>\n` +
              `加時內容：${extension.extension_text}\n` +
              `加時金額：NT$${amount.toLocaleString("zh-TW")}\n` +
              `付款方式：員工扣薪\n` +
              `深夜 EIP 已新增扣項：使用薪水續單\n` +
              `確認客服：<@${interaction.user.id}>`,
          )
          .setTimestamp(),
      ],
    });
    return interaction.editReply({
      content: "✅ 已確認續單扣薪付款並建立深夜 EIP 扣項。",
    });
  } catch (err) {
    return interaction.editReply({
      content: `❌ 續單扣薪付款失敗：${err.message || err}`,
    });
  }
}

async function handleSalaryExtensionCancel(interaction) {
  await deferReplyOnce(interaction);
  if (!canApproveSalaryDeduction(interaction)) {
    return interaction.editReply({
      content: "❌ 只有客服或管理員可以取消續單扣薪付款。",
    });
  }

  const extensionId = interaction.customId.replace(
    "salary_extension_cancel_",
    "",
  );
  const { data: extension, error } = await supabase
    .from("order_extensions")
    .select("*")
    .eq("id", extensionId)
    .eq("guild_id", DEEPNIGHT_GUILD_ID)
    .maybeSingle();
  if (error || !extension) {
    return interaction.editReply({ content: "❌ 找不到這筆加時資料。" });
  }
  if (extension.paid) {
    return interaction.editReply({ content: "❌ 這筆加時已完成付款。" });
  }

  const { error: updateError } = await supabase
    .from("order_extensions")
    .update({
      payment_method: null,
      status: "waiting_payment",
      updated_at: new Date().toISOString(),
    })
    .eq("id", extension.id)
    .or("paid.eq.false,paid.is.null");
  if (updateError) {
    return interaction.editReply({
      content: `❌ 取消續單扣薪失敗：${updateError.message}`,
    });
  }

  await interaction.message.edit({ components: [] }).catch(() => null);
  await sendExtensionPaymentMethodSelect(interaction.channel, extension);
  return interaction.editReply({
    content: "✅ 已取消續單扣薪付款，請員工重新選擇付款方式。",
  });
}
async function handleConfirmExtensionWallet(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const extensionId = interaction.customId.replace(
    "confirm_extension_wallet_",
    ""
  );

  const { data: extension, error } = await supabase
    .from("order_extensions")
    .select("*")
    .eq("id", extensionId)
    .eq("guild_id", DEEPNIGHT_GUILD_ID)
    .maybeSingle();

  if (error || !extension) {
    return interaction.editReply({
      content: "❌ 找不到這筆加時資料",
    });
  }

  if (interaction.user.id !== extension.customer_id) {
    return interaction.editReply({
      content: "❌ 只有下單闆闆可以確認加時儲值卡付款",
    });
  }

  if (extension.paid) {
    return interaction.editReply({
      content: "⚠️ 這筆加時已經付款過了",
    });
  }

  const amount = Number(extension.amount || 0);

  if (!amount || amount <= 0) {
    return interaction.editReply({
      content: "❌ 加時金額錯誤",
    });
  }

  let finalCoins = 0;
  try {
    const { data: result, error: paymentError } = await supabase.rpc(
      "deepnight_pay_extension_with_wallet",
      {
        p_extension_id: Number(extension.id),
        p_customer_id: extension.customer_id,
        p_guild_id: DEEPNIGHT_GUILD_ID,
      },
    );
    if (paymentError || !result) {
      throw new Error(paymentError?.message || "加時錢包原子付款失敗");
    }
    finalCoins = Number(result.balance || 0);
    await processOrderDeliveryNow(extension.id, "extension_financial_effects", {
      payload: { extension_id: extension.id, payment_method: "儲值卡" },
    }).catch((recoveryError) =>
      console.error("[加時儲值卡] 後續已排程重試", recoveryError),
    );
  } catch (error) {
    console.error("[加時儲值卡確認] 扣款失敗", error);

    return interaction.editReply({
      content:
        `❌ 儲值卡扣款失敗。\n` +
        `可能是 ASD 餘額不足，或錢包系統異常。\n` +
        `錯誤：${error.message || error}`,
    });
  }

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#57F287")
        .setTitle("✅ 加時儲值卡付款完成")
        .setDescription(
          `原訂單：${extension.order_no || extension.order_id}\n` +
            `闆闆：<@${extension.customer_id}>\n` +
            `加時內容：${extension.extension_text}\n` +
            `加時金額：NT$${amount.toLocaleString("zh-TW")}\n` +
            `付款方式：儲值卡\n` +
            `扣款後餘額：${Number(finalCoins || 0).toLocaleString(
              "zh-TW"
            )} ASD`
        )
        .setTimestamp(),
    ],
  });

  return interaction.editReply({
    content: "✅ 已確認使用儲值卡完成加時付款",
  });
}
async function handleStaffConfirmExtensionPaid(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const isStaff =
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.editReply({
      content: "❌ 只有客服可以確認加時付款",
    });
  }

  const extensionId = interaction.customId.replace(
    "staff_confirm_extension_paid_",
    ""
  );

  const { data: extension, error } = await supabase
    .from("order_extensions")
    .select("*")
    .eq("id", extensionId)
    .eq("guild_id", DEEPNIGHT_GUILD_ID)
    .single();

  if (error || !extension) {
    return interaction.editReply({
      content: "❌ 找不到加時資料",
    });
  }

  if (extension.paid) {
    return interaction.editReply({
      content: "⚠️ 這筆加時已經確認付款過了",
    });
  }

  const { data: result, error: paymentError } = await supabase.rpc(
    "deepnight_confirm_extension_manual",
    {
      p_extension_id: Number(extension.id),
      p_customer_id: extension.customer_id,
      p_guild_id: DEEPNIGHT_GUILD_ID,
      p_confirmed_by: interaction.user.id,
    },
  );
  if (paymentError || !result) {
    return interaction.editReply({
      content: `加時付款確認失敗：${paymentError?.message || "未知錯誤"}`,
    });
  }
  await processOrderDeliveryNow(extension.id, "extension_financial_effects", {
    payload: {
      extension_id: extension.id,
      payment_method: extension.payment_method,
      confirmed_by: interaction.user.id,
    },
  }).catch((recoveryError) =>
    console.error("[加時客服確認] 後續已排程重試", recoveryError),
  );
  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#57F287")
        .setTitle("✅ 加時付款已確認")
        .setDescription(
          `原訂單：${extension.order_no || extension.order_id}\n` +
            `闆闆：<@${extension.customer_id}>\n` +
            `加時內容：${extension.extension_text}\n` +
            `加時金額：NT$${Number(extension.amount || 0).toLocaleString(
              "zh-TW"
            )}\n` +
            `確認客服：<@${interaction.user.id}>`
        )
        .setTimestamp(),
    ],
  });

  return interaction.editReply({
    content: "✅ 已確認加時付款",
  });
}
async function startNewOrderFlow(channel, user) {
  const flowId = `${user.id}_${Date.now()}`;

  pendingNewOrders.set(flowId, {
    userId: user.id,
    username: user.username,
    channelId: channel.id,

    game: "",
    item: "",
    playerCount: 1,
    gender: "不指定",

    selectedPlayerType: "none",
    selectedPlayerId: null,
    selectedPlayerName: "",
    selectedPlayerStatus: "",

    duration: "",
    reservedTime: "",
    note: "無",
  });

  setTimeout(() => {
    pendingNewOrders.delete(flowId);
  }, ORDER_FLOW_TTL_MS);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`new_order_game_${flowId}`)
    .setPlaceholder("請選擇遊戲 / 服務")
    .addOptions([
      {
        label: "特戰英豪",
        description: "VALORANT 陪玩 / 技術單",
        value: "特戰英豪",
      },
      {
        label: "三角洲行動",
        description: "三角洲護航 / 保底 / 娛樂",
        value: "三角洲行動",
      },
      {
        label: "PUBG",
        description: "PUBG 陪玩",
        value: "PUBG",
      },
      {
        label: "STEAM",
        description: "Steam 遊戲陪玩",
        value: "STEAM",
      },
      {
        label: "陪聊服務",
        description: "聊天 / 陪伴 / 出氣",
        value: "陪聊服務",
      },
      {
        label: "打賞禮物",
        description: "打賞 / 禮物單",
        value: "打賞禮物",
      },
    ]);

  const row = new ActionRowBuilder().addComponents(menu);

  await channel.send({
    content:
      `<@${user.id}> 歡迎使用深夜不關燈點單系統。\n\n` +
      `請先選擇你要下單的遊戲 / 服務：`,
    components: [row],
  });
}
async function openTopupModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId("submit_topup_form")
    .setTitle("💰 購買星雨幣");

  const amountInput = new TextInputBuilder()
    .setCustomId("amount")
    .setLabel("購買金額")
    .setPlaceholder("例如：1000")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const noteInput = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("備註")
    .setPlaceholder("沒有可填無")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(amountInput),
    new ActionRowBuilder().addComponents(noteInput)
  );

  await interaction.showModal(modal);
}
function canEditOrderPrice(interaction) {
  return (
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE) ||
    (process.env.CUSTOMER_SERVICE_ROLE_ID &&
      interaction.member.roles.cache.has(process.env.CUSTOMER_SERVICE_ROLE_ID))
  );
}
// ===== 開啟更改訂單金額視窗 =====
async function openChangeOrderPriceModal(interaction) {
  if (!canEditOrderPrice(interaction)) {
    return interaction.reply({
      content: "❌ 你沒有權限更改訂單金額",
      flags: 64,
    });
  }

  const orderId = interaction.customId.replace("change_order_price_", "");

  const modal = new ModalBuilder()
    .setCustomId(`submit_change_order_price_${orderId}`)
    .setTitle("更改訂單金額");

  const priceInput = new TextInputBuilder()
    .setCustomId("new_price")
    .setLabel("請輸入新的訂單金額")
    .setPlaceholder("例如：499")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(priceInput));

  await interaction.showModal(modal);
}
async function openSaveOrderNoteModal(interaction) {
  const orderId = interaction.customId.replace("save_order_note_", "");

  const modal = new ModalBuilder()
    .setCustomId(`submit_save_order_note_${orderId}`)
    .setTitle("📝 存單內容");

  const noteInput = new TextInputBuilder()
    .setCustomId("saved_order_text")
    .setLabel("請輸入要存單的內容")
    .setPlaceholder("例如：闆闆要存單的內容")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(noteInput));

  await interaction.showModal(modal);
}

async function openDispatchPlayerMenu(interaction) {
  const orderId = interaction.customId.replace("dispatch_assign_players_", "");

  if (
    !interaction.member.roles.cache.has(process.env.STAFF_ROLE) &&
    !interaction.member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return interaction.editReply({
      content: "❌ 只有客服可以派單",
    });
  }

  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (error || !order) {
    return interaction.editReply({
      content: "❌ 找不到這張訂單",
    });
  }

  if (
    !["waiting_quote", "quoted", "waiting_payment", "pending"].includes(
      order.status
    )
  ) {
    return interaction.editReply({
      content: "❌ 這張訂單目前狀態不能再選擇陪陪",
    });
  }
  const service =
    order.dispatch_service_key ||
    order.service ||
    order.order_item ||
    order.game ||
    "";

  const playerOptions = await getAvailablePlayerOptions(service);
  if (!playerOptions.length) {
    return interaction.editReply({
      content: "❌ 目前沒有可接單陪陪",
    });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`submit_dispatch_players_${order.id}`)
    .setPlaceholder("可多選指定陪陪")
    .setMinValues(1)
    .setMaxValues(Math.min(playerOptions.length, 10))
    .addOptions(playerOptions.slice(0, 25));

  const row = new ActionRowBuilder().addComponents(menu);

  return interaction.editReply({
    content: "🌟 請選擇要指定派單的陪陪，可多選：",
    components: [row],
  });
}

async function submitDispatchPlayers(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const orderId = interaction.customId.replace("submit_dispatch_players_", "");

  if (
    !interaction.member.roles.cache.has(process.env.STAFF_ROLE) &&
    !interaction.member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return interaction.editReply({
      content: "❌ 只有客服可以派單",
      components: [],
    });
  }

  const selectedPlayerIds = interaction.values;

  const preferredPlayerValue = selectedPlayerIds.join(",");

  const { data: order, error } = await supabase
    .from("play_orders")
    .update({
      preferred_player: preferredPlayerValue,
    })
    .eq("id", orderId)
    .select()
    .single();

  if (error || !order) {
    console.log("[指定派單失敗]", error);
    return interaction.editReply({
      content: "❌ 指定派單失敗",
      components: [],
    });
  }

  return interaction.editReply({
    content:
      `✅ 已選擇陪陪：${selectedPlayerIds
        .map((id) => `<@${id}>`)
        .join("、")}\n` +
      `請繼續完成報價、優惠券與付款方式流程，等闆闆確認後才會正式派單。`,
    components: [],
  });
}

function parseTopupPresetAmount(customId) {
  const matched = String(customId || "").match(/^order_start_topup_amount_(\d+)$/);
  if (!matched) return null;
  const amount = Number(matched[1]);
  return TOPUP_PRESET_AMOUNTS.includes(amount) ? amount : null;
}

function buildTopupPaymentMethodRows(topupId) {
  return buildPaymentMethodButtonRows(
    `topup_payment_method_${topupId}`,
    getCanonicalPaymentOptions(),
  );
}

function prepareTopupCheckout({ userId, amount, note = "無", topupNo }) {
  const topupId = `${userId}_${Date.now()}`;
  pendingTopups.set(topupId, { userId, amount, note, topupNo });
  const expiryTimer = setTimeout(() => pendingTopups.delete(topupId), 30 * 60 * 1000);
  expiryTimer.unref?.();
  return { topupId, rows: buildTopupPaymentMethodRows(topupId) };
}

async function submitTopupForm(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  const amountText = interaction.fields.getTextInputValue("amount");
  let note = "無";
  try {
    note = interaction.fields.getTextInputValue("note") || "無";
  } catch {}
  // ===== 金額處理 =====
  const amount = parseInt(amountText.replace(/[^\d]/g, ""), 10);
  if (!amount || amount <= 0) {
    return interaction.editReply({
      content: "❌ 金額格式錯誤",
    });
  }
  let topupNo = getTopupNumberFromTopic(interaction.channel?.topic);
  if (!topupNo) {
    topupNo = await getNextTopupNumber(supabase);
    const safeName = interaction.user.username
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5-_]/g, "")
      .slice(0, 10);
    await interaction.channel
      ?.edit({
        name: `購買-${topupNo.toLowerCase()}-${safeName}`.slice(0, 90),
        topic: buildTopupTopic(interaction.user.id, topupNo),
      })
      .catch(() => {});
  }
  const { rows } = prepareTopupCheckout({
    userId: interaction.user.id,
    amount,
    note,
    topupNo,
  });

  return interaction.editReply({
    content:
      `訂單編號：${topupNo}\n` +
      `✅ 購買金額：NT$${amount}\n` +
      `📝 備註：${note}\n\n` +
      `請繼續選擇付款方式：`,
    components: rows,
  });
}
async function handleTopupPaymentMethodSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }
  await resetSelectMenuMessage(interaction);

  const selection = getPaymentMethodSelection(interaction, "topup_payment_method_");
  const topupId = selection?.entityId;

  const pending = pendingTopups.get(topupId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆儲值申請已過期，請重新填寫。",
      components: [],
    });
  }

  if (pending.userId !== interaction.user.id) {
    return interaction.editReply({
      content: "❌ 只有建立儲值申請的人可以選擇付款方式。",
      components: [],
    });
  }

  const method = selection?.paymentMethod;

  const { amount, note, topupNo } = pending;

  pendingTopups.delete(topupId);

  const embed = new EmbedBuilder()
    .setColor("#ffd166")
    .setTitle("💰 儲值申請")
    .setDescription(
      `👤 會員：${interaction.user}\n\n` +
        `🔢 儲值編號：${topupNo}\n` +
        `💵 儲值金額：NT$${amount}\n` +
        `💳 付款方式：${getPaymentMethodDisplayName(method)}\n` +
        `📝 備註：${note}`
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(
        `confirm_topup_${interaction.user.id}_${amount}_${topupNo}`,
      )
      .setLabel("確認儲值")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("close_ticket")
      .setLabel("關閉單子")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.channel.send({
    embeds: [embed],
    components: [row],
  });

  if (isCardPayment(method)) {
    await sendCardPaymentInfo(interaction.channel);
  } else if (isNoCardPayment(method)) {
    await sendNoCardPaymentInfo(interaction.channel);
  } else if (isBankTransfer(method)) {
    await sendBankTransferInfo(interaction.channel);
  } else if (method.includes("美金") || method.includes("加密貨幣")) {
    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#ffaa00")
          .setTitle("💳 特殊付款方式")
          .setDescription(
            `<@${interaction.user.id}> 你選擇了：${method}\n\n` +
              `請等待客服提供付款帳號 / 錢包地址。\n` +
              `付款完成後請上傳付款截圖，等待客服確認。`
          )
          .setTimestamp(),
      ],
    });
  }

  return interaction.editReply({
    content: `✅ 已選擇付款方式：${getPaymentMethodDisplayName(method)}`,
    components: [],
  });
}
async function confirmTopup(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const isStaff =
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.editReply({
      content: "❌ 只有客服可以確認儲值",
    });
  }

  const parts = interaction.customId.split("_");

  // confirm_topup_userId_amount_topupNo
  const userId = parts[2];

  const amount = Number(parts[3]);
  const topupNo =
    parts[4] || getTopupNumberFromTopic(interaction.channel?.topic) || null;

  if (!userId || !amount || amount <= 0) {
    return interaction.editReply({
      content: "❌ 儲值資料錯誤",
    });
  }

  const topupKey = topupNo || interaction.message?.id || interaction.customId;
  let finalCoins = 0;
  try {
    const { data: result, error: topupError } = await supabase.rpc(
      "deepnight_confirm_topup",
      {
        p_operation_key: String(topupKey),
        p_user_id: userId,
        p_amount: amount,
        p_guild_id: DEEPNIGHT_GUILD_ID,
        p_confirmed_by: interaction.user.id,
      },
    );
    if (topupError || !result) {
      throw new Error(topupError?.message || "原子儲值失敗");
    }
    finalCoins = Number(result.balance || 0);
    await processOrderDeliveryNow(topupKey, "topup_financial_effects", {
      payload: result,
    }).catch((recoveryError) =>
      console.error("[確認儲值] 後續已排程重試", recoveryError),
    );
  } catch (error) {
    console.error("[確認儲值] 更新餘額失敗", error);
    return interaction.editReply({
      content: "❌ 儲值失敗，請查看後台 Logs",
    });
  }
  await interaction.message
    ?.edit({
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("close_ticket")
            .setLabel("關閉單子")
            .setEmoji("🗑️")
            .setStyle(ButtonStyle.Danger),
        ),
      ],
    })
    .catch(() => {});

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#57F287")
        .setTitle("✅ 儲值已完成")
        .setDescription(
          `<@${userId}> 已成功儲值。\n\n` +
            `儲值編號：${topupNo || "舊儲值單"}\n` +
            `儲值金額：${amount} ASD\n` +
            `目前餘額：${finalCoins} ASD\n` +
            `確認客服：<@${interaction.user.id}>`
        )
        .setTimestamp(),
    ],
  });

  return interaction.editReply({
    content: `✅ ${topupNo || "舊儲值單"} 已幫 <@${userId}> 儲值 ${amount} ASD`,
  });
}
async function submitSaveOrderNote(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const orderId = interaction.customId.replace("submit_save_order_note_", "");

  const savedText = interaction.fields.getTextInputValue("saved_order_text");

  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (error || !order) {
    console.log("[存單讀取訂單失敗]", error);
    return interaction.editReply({
      content: "❌ 找不到這張訂單",
    });
  }

  const saveChannel = await client.channels
    .fetch(process.env.SAVED_ORDER_CHANNEL)
    .catch(() => null);

  if (!saveChannel) {
    return interaction.editReply({
      content: "❌ 找不到存單指定頻道，請檢查 SAVED_ORDER_CHANNEL",
    });
  }

  const endButton = new ButtonBuilder()
    .setCustomId(`saved_order_end_${order.id}`)
    .setLabel("已結束")
    .setEmoji("✅")
    .setStyle(ButtonStyle.Danger);

  const row = new ActionRowBuilder().addComponents(endButton);

  const embed = new EmbedBuilder()
    .setColor("#66ccff")
    .setTitle("📝 訂單存單")
    .addFields(
      {
        name: "📌 訂單編號",
        value: order.order_no || "未知",
        inline: true,
      },
      {
        name: "👤 客人",
        value: `<@${order.customer_id}>`,
        inline: true,
      },
      {
        name: "🎮 服務項目",
        value: order.service || "未填寫",
        inline: false,
      },
      {
        name: "💰 金額",
        value: `NT$${order.final_price || order.price || 0}`,
        inline: true,
      },
      {
        name: "💳 付款方式",
        value: order.payment_method || "未填寫",
        inline: true,
      },
      {
        name: "📝 存單內容",
        value: savedText.slice(0, 1000),
        inline: false,
      }
    )
    .setFooter({
      text: `存單人：${interaction.user.username}`,
    })
    .setTimestamp();

  await saveChannel.send({
    embeds: [embed],
    components: [row],
  });

  await interaction.channel.send({
    content: `✅ <@${interaction.user.id}> 已完成存單，內容已送到指定頻道。`,
  });

  return interaction.editReply({
    content: "✅ 存單已送出",
  });
}
async function handleSavedOrderEnd(interaction) {
  const roleId = process.env.STAFF_ROLE;

  const isStaff =
    interaction.guild.ownerId === interaction.user.id ||
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(roleId);

  if (!isStaff) {
    return interaction.editReply({
      content: "❌ 只有客服可以按已結束",
    });
  }

  const oldEmbed = interaction.message.embeds[0];

  const newEmbed = EmbedBuilder.from(oldEmbed)
    .setColor("#999999")
    .setTitle("✅ 訂單存單｜已結束")
    .addFields({
      name: "🔒 結束人",
      value: `<@${interaction.user.id}>`,
      inline: true,
    });

  const disabledRow = new ActionRowBuilder().addComponents(
    ButtonBuilder.from(interaction.message.components[0].components[0])
      .setDisabled(true)
      .setLabel("已結束")
  );

  await interaction.message.edit({
    embeds: [newEmbed],
    components: [disabledRow],
  });

  return interaction.editReply({
    content: "✅ 已標記為結束",
  });
}
// ===== 送出更改訂單金額 =====
async function submitChangeOrderPrice(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  if (!canEditOrderPrice(interaction)) {
    return interaction.editReply({
      content: "❌ 你沒有權限更改訂單金額",
    });
  }

  const orderId = interaction.customId.replace(
    "submit_change_order_price_",
    ""
  );

  const priceText = interaction.fields.getTextInputValue("new_price");
  const cleanPriceText = priceText.replace(/[^\d]/g, "");
  if (cleanPriceText === "") {
    return interaction.editReply({
      content: "❌ 請輸入金額",
    });
  }
  const newPrice = Number(cleanPriceText);
  if (Number.isNaN(newPrice) || newPrice < 0) {
    return interaction.editReply({
      content: "❌ 金額不能小於 0",
    });
  }
  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (error || !order) {
    console.log("[更改金額讀取訂單失敗]", error);
    return interaction.editReply({
      content: "❌ 找不到這張訂單",
    });
  }

  const { data: updated, error: updateError } = await supabase
    .from("play_orders")
    .update({
      price: newPrice,
      final_price: newPrice,
    })
    .eq("id", orderId)
    .select()
    .single();

  if (updateError || !updated) {
    console.log("[更改金額失敗]", updateError);
    return interaction.editReply({
      content: "❌ 更改金額失敗",
    });
  }
  try {
    await workReportSystem.syncAcceptedOrder(updated);
  } catch (syncError) {
    console.error("[更改金額同步填單失敗]", syncError);
    return interaction.editReply({
      content:
        "⚠️ 原訂單金額已更新，但陪陪填單同步失敗，請查看 Railway Logs。",
    });
  }

  const orderChannel = await client.channels
    .fetch(order.channel_id)
    .catch(() => null);

  if (!orderChannel) {
    return interaction.editReply({
      content: "❌ 找不到訂單臨時頻道",
    });
  }

  const embed = new EmbedBuilder()
    .setColor("#ffaa00")
    .setTitle("💰 訂單金額已更新")
    .addFields(
      {
        name: "📌 訂單編號",
        value: order.order_no || "未知",
        inline: true,
      },
      {
        name: "👤 客人",
        value: `<@${order.customer_id}>`,
        inline: true,
      },
      {
        name: "🎮 服務項目",
        value: order.service || "未填寫",
        inline: false,
      },
      {
        name: "💰 原金額",
        value: `NT$${order.price || 0}`,
        inline: true,
      },
      {
        name: "💵 新金額",
        value: `NT$${newPrice}`,
        inline: true,
      },
      {
        name: "💳 付款方式",
        value: order.payment_method || "未填寫",
        inline: true,
      },
      {
        name: "📝 備註需求",
        value: order.note || "無",
        inline: false,
      }
    )
    .setFooter({
      text: `由 ${interaction.user.username} 更改`,
    })
    .setTimestamp();

  await orderChannel.send({
    content: `<@${order.customer_id}> 訂單金額已更新，請確認新的金額。`,
    embeds: [embed],
  });

  await sendPlayLog({
    title: "💰 訂單金額已更新",
    description:
      `訂單編號：${order.order_no}\n` +
      `修改人：<@${interaction.user.id}>\n` +
      `原金額：NT$${order.price || 0}\n` +
      `新金額：NT$${newPrice}`,
    color: "#ffaa00",
  });

  return interaction.editReply({
    content: `✅ 已將訂單金額改為 NT$${newPrice}`,
  });
}
// 接單
async function acceptPlayOrder(interaction) {
  try {
    const orderId = interaction.customId.replace("accept_play_order_", "");

    let playerQuery = supabase
      .from(STAFF_TABLE)
      .select("*")
      .eq("discord_id", interaction.user.id)
      .eq("status", "available")
      .limit(1);

    playerQuery = applyStaffGuildFilter(playerQuery);

    const { data: playerRows, error: playerError } = await playerQuery;

    const player = playerRows?.[0];

    if (playerError) {
      console.log("[接單錯誤 players]", playerError);
    }

    if (!player) {
      return interaction.editReply({
        content: "❌ 你目前不是可接單狀態，請先按「開始接單」",
      });
    }

    const { data: order, error: orderError } = await supabase
      .from("play_orders")
      .select("*")
      .eq("id", orderId)
      .maybeSingle();

    if (orderError) {
      console.log("[接單錯誤 play_orders]", orderError);
    }

    if (!order || !["pending", "accepted"].includes(order.status)) {
      return interaction.editReply({
        content: "❌ 這張訂單已經被接走了，或目前不能接單",
      });
    }

    const orderServiceText = `${order.game || ""}｜${order.order_item || ""}｜${
      order.service || ""
    }`;
    if (
      orderServiceText.includes("王者榮耀") ||
      orderServiceText.includes("第五人格")
    ) {
      const requiredService = getServiceKeywordFromPending({
        category: "other",
        gameLabel: order.game,
        itemLabel: order.order_item,
        serviceType: order.service,
      });
      if (!matchAllowedServiceName(player.allowed_services, requiredService)) {
        return interaction.editReply({
          content: `❌ 你的薪資網尚未勾選「${requiredService}」，目前不能接這張訂單。`,
        });
      }
    }

    // ===== 指定陪陪限制 =====
    if (order.preferred_player) {
      const preferredPlayers = String(order.preferred_player)
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);

      const needCount = Number(order.player_count || 1) || 1;

      const assignedPlayerIdsNow = String(order.assigned_player || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);

      const preferredFull = preferredPlayers.length >= needCount;

      const isPreferredPlayer = preferredPlayers.includes(interaction.user.id);

      const alreadyAssignedPreferredCount = assignedPlayerIdsNow.filter((id) =>
        preferredPlayers.includes(id)
      ).length;

      const stillWaitingPreferred =
        preferredPlayers.length > alreadyAssignedPreferredCount;

      if (preferredFull && !isPreferredPlayer) {
        return interaction.editReply({
          content:
            `❌ 這張訂單只開放指定陪陪接單：` +
            preferredPlayers.map((id) => `<@${id}>`).join("、"),
        });
      }

      if (!preferredFull && !isPreferredPlayer && stillWaitingPreferred) {
        return interaction.editReply({
          content:
            `❌ 這張訂單還有指定陪陪尚未接單，請先等待：` +
            preferredPlayers.map((id) => `<@${id}>`).join("、") +
            `\n如果指定陪陪無法接，請客服將指定改為不指定或調整名單。`,
        });
      }
    }

    // ===== 多人接單邏輯 =====
    let needCount = Number(order.player_count || 1) || 1;

    let assignedPlayerIds = String(order.assigned_player || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    if (assignedPlayerIds.includes(interaction.user.id)) {
      return interaction.editReply({
        content: "❌ 你已經接過這張訂單了",
      });
    }

    if (assignedPlayerIds.length >= needCount) {
      return interaction.editReply({
        content: `❌ 這張訂單需要 ${needCount} 位陪玩，目前名額已滿。`,
      });
    }

    const { data: acceptResult, error: updateError } = await supabase.rpc(
      "deepnight_accept_play_order",
      {
        p_order_id: orderId,
        p_player_id: interaction.user.id,
        p_guild_id: DEEPNIGHT_GUILD_ID,
      },
    );

    if (updateError) {
      console.log("[接單更新錯誤]", updateError);

      return interaction.editReply({
        content: `❌ 接單失敗：${updateError.message || "訂單狀態已變更"}`,
      });
    }

    const updated = acceptResult?.order;

    if (!updated) {
      return interaction.editReply({
        content: "❌ 這張訂單目前無法接單，可能已被接滿或狀態已變更",
      });
    }

    assignedPlayerIds = Array.isArray(acceptResult.assigned_player_ids)
      ? acceptResult.assigned_player_ids.map(String)
      : String(updated.assigned_player || "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
    needCount = Number(acceptResult.need_count || updated.player_count || 1) || 1;
    const isFull = Boolean(acceptResult.is_full);

    let workReportDeliveryError = null;
    if (isFull) {
      try {
        await processOrderDeliveryNow(updated.id, "work_report_panel");
      } catch (error) {
        workReportDeliveryError = error;
        console.error(
          "[工時申報] 首次發送失敗，已保存補償工作等待自動重試",
          error,
        );
      }
    }

    const orderChannel = await client.channels.fetch(order.channel_id);

    if (!orderChannel) {
      return interaction.editReply({
        content: "❌ 找不到客人訂單頻道",
      });
    }

    for (const playerId of assignedPlayerIds) {
      await orderChannel.permissionOverwrites.edit(playerId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });
    }

    await supabase
      .from("play_orders")
      .update({
        channel_id: orderChannel.id,
      })
      .eq("id", orderId);

    const embed = new EmbedBuilder()
      .setColor(isFull ? "#00ff99" : "#ffd166")
      .setTitle(isFull ? "✅ 陪玩訂單已接單" : "⏳ 陪玩接單中")
      .setDescription(
        `訂單編號：${order.order_no || order.id}\n` +
          `客人：<@${order.customer_id}>\n` +
          `目前陪玩：${assignedPlayerIds
            .map((id) => `<@${id}>`)
            .join("、")}\n` +
          `需要人數：${needCount} 位\n` +
          `目前人數：${assignedPlayerIds.length} 位\n` +
          `服務：${order.service || order.order_item || "未填寫"}\n` +
          `商品金額：NT$${order.final_price || order.price || 0}`
      );

    await orderChannel.send({
      content: isFull
        ? `<@${order.customer_id}> ${assignedPlayerIds
            .map((id) => `<@${id}>`)
            .join(" ")}`
        : `${assignedPlayerIds
            .map((id) => `<@${id}>`)
            .join(" ")} 已接單，目前還差 ${
            needCount - assignedPlayerIds.length
          } 位陪玩。`,
      embeds: [embed],
    });

    await sendPlayLog({
      title: "✅ 訂單已接取",
      description:
        `訂單編號：${order.order_no || order.id}\n` +
        `陪玩：${assignedPlayerIds.map((id) => `<@${id}>`).join("、")}\n` +
        `服務：${order.service || order.order_item || "未填寫"}\n` +
        `商品金額：NT$${order.final_price || order.price || 0}`,
    });

    return interaction.editReply({
      content: workReportDeliveryError
        ? "⚠️ 接單已完成；工時面板首次發送失敗，系統已排入自動重試，不需重新接單。"
        : undefined,
      embeds: [
        new EmbedBuilder()
          .setColor("#57F287")
          .setTitle("✅ 接單成功")
          .setDescription(`📂 點擊前往訂單頻道\n${orderChannel}`),
      ],
    });
  } catch (err) {
    console.log("[接單系統錯誤]", err);

    return interaction
      .editReply({
        content: `❌ 接單失敗：${err.message || "未知錯誤"}`,
      })
      .catch(() => {});
  }
}
function getGrowthVipLevel(totalTopup, singleTopup = 0) {
  void totalTopup;
  if (singleTopup >= 50000) {
    return "vvip";
  }
  if (singleTopup >= 30000) {
    return "vip_plus";
  }
  if (singleTopup >= 10000) {
    return "vip";
  }
  return "none";
}
function getTopupBonus(amount) {
  if (amount >= 75000) {
    return 8000;
  }
  if (amount >= 50000) {
    return 5000;
  }
  if (amount >= 30000) {
    return 3000;
  }
  if (amount >= 18000) {
    return 1800;
  }
  if (amount >= 8000) {
    return 700;
  }
  if (amount >= 5000) {
    return 300;
  }
  return 0;
}

function getGrowthVipRoleId(level) {
  const roles = {
    vip: process.env.GROWTH_VIP_ROLE_ID,
    vip_plus: process.env.GROWTH_VIP_PLUS_ROLE_ID,
    // vvip 不發身分組
  };

  return roles[level] || null;
}

async function checkGrowthVip(client, guildId, userId, singleTopup = 0) {
  const { data: user, error } = await supabase
    .from("users")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error || !user) {
    console.log("[VIP] 找不到使用者", error);
    return;
  }

  const totalTopup = user.total_topup || 0;

  const newLevel = getGrowthVipLevel(totalTopup, singleTopup);

  if (newLevel === user.growth_vip) {
    return;
  }

  await supabase
    .from("users")
    .update({
      growth_vip: newLevel,
    })
    .eq("user_id", userId);

  const guild = await client.guilds.fetch(guildId);

  const member = await guild.members.fetch(userId).catch(() => null);

  if (!member) return;

  const growthRoles = [
    process.env.GROWTH_VIP_ROLE_ID,
    process.env.GROWTH_VIP_PLUS_ROLE_ID,
  ].filter(Boolean);

  await member.roles.remove(growthRoles).catch(() => {});

  const roleId = getGrowthVipRoleId(newLevel);

  if (roleId) {
    await member.roles.add(roleId).catch(() => {});
  }

  const levelName = {
    vip: "💎 VIP",
    vip_plus: "🌟 VIP+",
    vvip: "👑 VVIP",
    none: "無",
  };

  await member
    .send({
      content: `🎉 恭喜你已升級為 ${levelName[newLevel]}！`,
    })
    .catch(() => {});
}
function getFlowIdFromCustomId(customId, prefix = "") {
  return String(customId || "").replace(prefix, "");
}
function getValorantTypeSelection(value) {
  const selections = {
    god: {
      label: "大神",
      serviceTypes: ["大神"],
    },
    skill: {
      label: "技術",
      serviceTypes: ["技術"],
    },
    entertain: {
      label: "娛樂",
      serviceTypes: ["娛樂"],
    },
    skill_entertain: {
      label: "技術+娛樂",
      serviceTypes: ["技術", "娛樂"],
    },
  };

  return selections[value] || null;
}
function getValorantServiceTypes(pending) {
  return Array.isArray(pending?.serviceTypes) ? pending.serviceTypes : [];
}
function isValorantEntertainmentSkillOrder(pending) {
  const serviceTypes = getValorantServiceTypes(pending);

  return (
    pending?.category === "valorant" &&
    serviceTypes.includes("娛樂") &&
    serviceTypes.includes("技術")
  );
}
function enforceValorantMinimumPlayerCount(pending) {
  if (!isValorantEntertainmentSkillOrder(pending)) {
    return false;
  }

  const currentCount = Number(pending.playerCount || 0);

  if (currentCount >= 2) {
    return false;
  }

  pending.playerCount = 2;
  return true;
}
function getValorantTypeReply(pending, adjusted = false) {
  const serviceTypes = getValorantServiceTypes(pending);

  if (!serviceTypes.length) {
    return "✅ 已取消選擇，目前尚未選擇特戰服務";
  }

  return (
    `✅ 目前已選擇特戰服務：${serviceTypes.join("＋")}` +
    (isValorantEntertainmentSkillOrder(pending)
      ? `\n同時選擇娛樂＋技術時，陪陪人數至少需要 2 位。` +
        (adjusted ? "\n已自動把陪陪人數調整為 2 位。" : "")
      : "")
  );
}
async function handleValorantTypeSelect(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("valorant_type_select_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  const selected = getValorantTypeSelection(interaction.values[0]);

  if (!selected) {
    return interaction.editReply({
      content: "❌ 找不到這個特戰服務選項，請重新選擇。",
    });
  }

  pending.itemLabel = selected.label;
  pending.playMode = selected.label;
  pending.serviceTypes = selected.serviceTypes;
  pending.serviceType = selected.label;

  const adjusted = enforceValorantMinimumPlayerCount(pending);

  pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content: getValorantTypeReply(pending, adjusted),
  });
}

async function handleValorantTypeButton(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const isEntertainment = interaction.customId.includes(
    "valorant_type_entertain_"
  );

  const prefix = isEntertainment
    ? "valorant_type_entertain_"
    : "valorant_type_skill_";

  const flowId = getFlowIdFromCustomId(interaction.customId, prefix);

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  const selectedType = isEntertainment ? "娛樂" : "技術";

  const serviceTypes = getValorantServiceTypes(pending);

  if (serviceTypes.includes(selectedType)) {
    pending.serviceTypes = serviceTypes.filter((type) => type !== selectedType);
  } else {
    pending.serviceTypes = [...serviceTypes, selectedType];
  }

  pending.serviceType = pending.serviceTypes.join("＋") || null;

  const adjusted = enforceValorantMinimumPlayerCount(pending);

  pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content: getValorantTypeReply(pending, adjusted),
  });
}

async function handleValorantModeButton(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const flowId = getFlowIdFromCustomId(
    interaction.customId,
    interaction.customId.includes("valorant_mode_rank_")
      ? "valorant_mode_rank_"
      : "valorant_mode_normal_"
  );
  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  pending.playMode = interaction.customId.includes("_rank_") ? "排位" : "一般";

  pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content: `✅ 已選擇模式：${pending.playMode}`,
  });
}

async function handleValorantRankSelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("valorant_rank_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  pending.rank = interaction.values[0];

  // 重新選段位時，清掉之前選過的時間 / 局數，避免資料混在一起
  pending.duration = null;
  pending.rounds = null;
  pending.timeSelectShown = true;

  pendingServiceOrders.set(flowId, pending);

  if (isValorantAboveGold(pending.rank)) {
    await showServiceRoundSelect(interaction.channel, flowId);

    return interaction.editReply({
      content:
        `✅ 已選擇段位：${pending.rank}\n` +
        `此段位屬於金牌以上，不含金牌，請改用「局數制」。`,
    });
  }

  await showServiceDurationSelect(interaction.channel, flowId, "hour");

  return interaction.editReply({
    content:
      `✅ 已選擇段位：${pending.rank}\n` +
      `此段位屬於金牌以下，含金牌，請使用「時間制」。`,
  });
}
async function handleApexRankSelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("apex_rank_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  pending.rank = interaction.values[0];

  pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content: `✅ 已選擇 Apex 段位：${pending.rank}`,
  });
}
async function handleLolRankSelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("lol_rank_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  pending.rank = interaction.values[0];

  pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content: `✅ 已選擇英雄聯盟段位 / 類型：${pending.rank}`,
  });
}
async function handleServicePlayerCountSelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("service_player_count_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期。",
    });
  }

  const selectedCount = Number(interaction.values[0]);

  if (isValorantEntertainmentSkillOrder(pending) && selectedCount < 2) {
    return interaction.editReply({
      content:
        "❌ 同時選擇娛樂＋技術時，陪陪人數至少需要 2 位。\n" +
        "請重新選擇 2 位以上。",
    });
  }

  pending.playerCount = selectedCount;

  pendingServiceOrders.set(flowId, pending);

  await showFinishNeedButtons(interaction.channel, flowId);
  return interaction.editReply({
    content:
      `✅ 已選擇陪陪人數：${pending.playerCount} 位\n` +
      `如果需求都填好了，可以按下方「送出訂單」。`,
  });
}

async function handleServiceGenderSelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("service_gender_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期。",
    });
  }

  pending.genderPreference = interaction.values[0];

  pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content: `✅ 已選擇性別偏好：${pending.genderPreference}`,
  });
}
function getServiceKeywordFromPending(pending = {}) {
  const text = [
    pending.serviceType,
    pending.gameLabel,
    pending.itemLabel,
    pending.playMode,
    pending.deltaMode,
    pending.steamCategory,
    pending.game,
    pending.item,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("｜");

  if (pending.category === "valorant" || text.includes("特戰英豪")) {
    if (text.includes("大神")) return "特戰英豪大神陪玩";
    if (text.includes("技術")) return "特戰英豪技術陪玩";
    if (text.includes("娛樂")) return "特戰英豪娛樂陪玩";
    return "特戰英豪";
  }

  if (pending.category === "apex" || text.includes("Apex")) {
    if (text.includes("大神")) return "Apex大神陪玩";
    if (text.includes("技術")) return "Apex技術陪玩";
    if (text.includes("娛樂")) return "Apex娛樂陪玩";
    return "Apex";
  }

  if (pending.category === "delta" || text.includes("三角洲")) {
    if (text.includes("娛樂陪玩")) return "三角洲行動娛樂陪玩";
    if (text.includes("基本單護")) return "三角洲行動基本單護";
    if (text.includes("機密雙護") && text.includes("保底"))
      return "三角洲行動機密雙護保底";
    if (text.includes("機密雙護")) return "三角洲行動機密雙護";
    if (text.includes("猛攻") && text.includes("保底"))
      return "三角洲行動猛攻護航保底";
    if (text.includes("猛攻")) return "三角洲行動猛攻護航";
    return "三角洲行動";
  }

  if (
    pending.category === "lol" ||
    text.includes("英雄聯盟") ||
    text.includes("ARAM") ||
    text.includes("聯盟戰棋")
  ) {
    if (text.includes("聯盟戰棋")) return "聯盟戰棋";

    if (text.includes("ARAM")) {
      if (text.includes("大神")) return "ARAM大神陪玩";
      if (text.includes("技術")) return "ARAM技術陪玩";
      if (text.includes("娛樂")) return "ARAM娛樂陪玩";
      return "ARAM";
    }

    if (text.includes("大神")) return "英雄聯盟大神陪玩";
    if (text.includes("技術")) return "英雄聯盟技術陪玩";
    if (text.includes("娛樂")) return "英雄聯盟娛樂陪玩";
    return "英雄聯盟";
  }

  if (pending.category === "steam" || text.includes("Steam")) {
    if (text.includes("肉鴿")) return "Steam肉鴿遊戲";
    if (text.includes("生存")) return "Steam生存遊戲";
    if (text.includes("恐怖")) return "Steam恐怖遊戲";
    if (text.includes("派對")) return "Steam派對遊戲";
    return "Steam";
  }

  if (pending.category === "other") {
    if (text.includes("王者榮耀")) {
      if (text.includes("技術")) return "王者榮耀技術";
      if (text.includes("娛樂")) return "王者榮耀娛樂";
    }
    if (text.includes("第五人格")) {
      if (text.includes("四階")) return "第五人格四階";
      if (text.includes("五階")) return "第五人格五階";
      if (text.includes("六階")) return "第五人格六階";
      if (text.includes("七階")) return "第五人格七階";
      if (text.includes("娛樂")) return "第五人格娛樂";
    }
    if (text.includes("語音聊天")) return "語音聊天";
    if (text.includes("點歌")) return "點歌服務";
    if (text.includes("PUBG M")) return "PUBG M";
    if (text.includes("NARAKA")) return "NARAKA";
    if (text.includes("Minecraft")) return "Minecraft";
  }

  return "";
}
function getServiceGroupName(targetService) {
  const target = cleanServiceKey(targetService);

  if (target.includes("特戰英豪")) return "特戰英豪";
  if (target.includes("三角洲行動")) return "三角洲行動";
  if (target.includes("Apex")) return "Apex";
  if (target.includes("英雄聯盟")) return "英雄聯盟";
  if (target.includes("ARAM")) return "ARAM";
  if (target.includes("聯盟戰棋")) return "聯盟戰棋";
  if (target.includes("Steam")) return "Steam";

  return target;
}

function matchAllowedServiceName(allowedServices, targetService) {
  const target = cleanServiceKey(targetService);

  if (!target) return false;

  const services = normalizeAllowedServices(allowedServices)
    .map((service) => cleanServiceKey(service))
    .filter(Boolean);

  if (!services.length) return false;

  const group = getServiceGroupName(target);

  const serviceAliases = {
    王者榮耀娛樂: "hok_entertain",
    王者榮耀技術: "hok_skill",
    第五人格娛樂: "identity_v_entertain",
    第五人格四階: "identity_v_rank_4",
    第五人格五階: "identity_v_rank_5",
    第五人格六階: "identity_v_rank_6",
    第五人格七階: "identity_v_rank_7",
  };
  const alias = serviceAliases[target];

  return (
    services.includes(target) ||
    (alias && services.includes(cleanServiceKey(alias))) ||
    services.includes("全部服務") ||
    services.includes(`${group}全部`)
  );
}
async function showServicePlayerSelect(channel, flowId, pending) {
  let playerQuery = supabase
    .from(STAFF_TABLE)
    .select("*")
    .order("status", { ascending: true });

  playerQuery = applyStaffGuildFilter(playerQuery);

  const { data: players, error } = await playerQuery;

  if (error) {
    console.error("[新版指定陪陪] 讀取陪陪失敗", error);
    return channel.send("❌ 讀取陪陪資料失敗，請聯繫客服。");
  }

  const serviceKeyword = getServiceKeywordFromPending(pending);

  const matchedPlayers = (players || [])
    .filter((player) => player.discord_id)
    .filter((player) => matchPlayerGender(player, pending.genderPreference))
    .filter((player) => {
      const allowedServices = normalizeAllowedServices(player.allowed_services);

      // 沒有設定可接服務，就不要顯示，避免誤接錯項目
      if (!allowedServices.length) return false;

      return matchAllowedServiceName(allowedServices, serviceKeyword);
    });

  const onlinePlayers = matchedPlayers.filter(
    (player) => player.status === "available"
  );

  const offlinePlayers = matchedPlayers.filter(
    (player) => player.status !== "available"
  );

  const options = [
    ...onlinePlayers.map((player) => ({
      label: `🟢 ${getStaffDisplayName(player)}`.slice(0, 100),
      description: "目前在線，可直接安排".slice(0, 100),
      value: `online_${player.discord_id}`,
    })),

    ...offlinePlayers.map((player) => ({
      label: `⚪ ${getStaffDisplayName(player)}`.slice(0, 100),
      description: formatAvailableTime(player).slice(0, 100),
      value: `reserve_${player.discord_id}`,
    })),
  ].slice(0, 25);

  if (!options.length) {
    return channel.send(
      `❌ 目前沒有符合條件的陪陪。\n` +
        `性別偏好：${pending.genderPreference || "不指定"}\n` +
        `服務：${serviceKeyword || "未填寫"}`
    );
  }

  const maxValues = Math.min(Number(pending.playerCount || 1), options.length);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`service_selected_players_${flowId}`)
    .setPlaceholder(`請選擇指定陪陪，最多 ${maxValues} 位`)
    .setMinValues(1)
    .setMaxValues(maxValues)
    .addOptions(options);

  await channel.send({
    content:
      `請選擇指定陪陪：\n` +
      `🟢 在線：可直接安排\n` +
      `⚪ 不在線：可查看可接單時間並預約`,
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}
async function handleServiceAssignSelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("service_assign_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期。",
    });
  }

  pending.assignMode = interaction.values[0];
  pendingServiceOrders.set(flowId, pending);
  if (pending.assignMode === "不指定") {
    await showFinishNeedButtons(interaction.channel, flowId);
    return interaction.editReply({
      content:
        "✅ 已選擇指定方式：不指定陪陪\n" +
        "請確認需求無誤後，按下方「送出訂單」。",
    });
  }
  await showServicePlayerSelect(interaction.channel, flowId, pending);
  return interaction.editReply({
    content:
      `✅ 已選擇指定方式：${pending.assignMode}\n` + `請在頻道內選擇陪陪。`,
  });
}
async function handleServiceSelectedPlayersSelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("service_selected_players_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期。",
    });
  }

  const selectedValues = interaction.values || [];

  const playerIds = selectedValues
    .map((value) =>
      String(value).replace("online_", "").replace("reserve_", "")
    )
    .filter(Boolean);

  const reserveIds = selectedValues
    .filter((value) => String(value).startsWith("reserve_"))
    .map((value) => String(value).replace("reserve_", ""));

  pending.selectedPlayerIds = playerIds;
  pending.selectedPlayerType = reserveIds.length > 0 ? "reserve" : "online";

  if (reserveIds.length > 0) {
    pending.assignMode = "預約指定";
  }

  pendingServiceOrders.set(flowId, pending);

  if (reserveIds.length > 0) {
    let reserveQuery = supabase
      .from(STAFF_TABLE)
      .select("*")
      .in("discord_id", reserveIds);
    reserveQuery = applyStaffGuildFilter(reserveQuery);
    const { data: players } = await reserveQuery;

    const availableText =
      (players || [])
        .map((player) => {
          return `<@${player.discord_id}>：${formatAvailableTime(player)}`;
        })
        .join("\n") || "未填寫可接時間";

    await interaction.channel.send({
      content:
        `⚪ 你選擇了不在線 / 可預約的陪陪：\n` +
        `${availableText}\n\n` +
        `請在備註或頻道內告訴客服想預約的時間。`,
    });
  }

  await showFinishNeedButtons(interaction.channel, flowId);
  return interaction.editReply({
    content:
      `✅ 已選擇陪陪：${playerIds.map((id) => `<@${id}>`).join("、")}\n` +
      `請確認需求無誤後，按下方「送出訂單」。`,
  });
}
async function handleServiceDurationSelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("service_duration_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期。",
    });
  }

  pending.duration = interaction.values[0];

  pendingServiceOrders.set(flowId, pending);

  await showFinishNeedButtons(interaction.channel, flowId);

  return interaction.editReply({
    content:
      pending.duration === "custom"
        ? "✅ 已選擇自訂時間，請在頻道內告訴客服想要的時間。"
        : `✅ 已選擇時間：${pending.duration} 小時`,
  });
}

async function handleServiceRoundsSelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("service_rounds_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期。",
    });
  }

  pending.rounds = interaction.values[0];

  pendingServiceOrders.set(flowId, pending);

  await showFinishNeedButtons(interaction.channel, flowId);

  return interaction.editReply({
    content:
      pending.rounds === "custom"
        ? "✅ 已選擇自訂局數，請在頻道內告訴客服想要的局數。"
        : `✅ 已選擇局數：${pending.rounds} 局`,
  });
}

async function handleSteamCategorySelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("steam_category_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期。",
    });
  }

  pending.steamCategory = interaction.values[0];

  pendingServiceOrders.set(flowId, pending);

  await showFinishNeedButtons(interaction.channel, flowId);
  return interaction.editReply({
    content:
      `✅ 已選擇 Steam 類型：${pending.steamCategory}\n` +
      `如果需求都填好了，可以按下方「送出訂單」。`,
  });
}
async function handleDeltaModeSelect(interaction) {
  await interaction.deferReply({
    flags: 64,
  });
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("delta_mode_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期。",
    });
  }

  pending.deltaMode = interaction.values[0];

  pending.serviceType = `三角洲行動｜${
    pending.deltaPlatform || pending.itemLabel || "未選平台"
  }｜${pending.deltaMode}`;

  pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content:
      `✅ 已選擇三角洲服務：${pending.deltaMode}\n` +
      `平台：${pending.deltaPlatform || pending.itemLabel || "未選平台"}`,
  });
}
async function showFinishNeedButtons(channel, flowId) {
  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return;
  }

  if (pending.finishButtonShown) {
    return;
  }

  pending.finishButtonShown = true;
  pendingServiceOrders.set(flowId, pending);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`order_add_note_${flowId}`)
      .setLabel("填寫備註")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId(`order_finish_need_${flowId}`)
      .setLabel("送出訂單")
      .setEmoji("📨")
      .setStyle(ButtonStyle.Success)
  );

  await channel.send({
    content: "需求填寫完成後，請按「送出訂單」。",
    components: [row],
  });
}
async function finishServiceNeed(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const flowId = interaction.customId.replace("order_finish_need_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期。",
    });
  }

  if (!canCustomerOrStaffSubmit(interaction, pending.customerId)) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆、客服或管理員可以送出訂單。",
    });
  }

  if (
    isValorantEntertainmentSkillOrder(pending) &&
    Number(pending.playerCount || 0) < 2
  ) {
    return interaction.editReply({
      content:
        "❌ 這筆特戰訂單同時選擇了娛樂＋技術，陪陪人數至少需要 2 位。\n" +
        "請先把陪陪人數改成 2 位以上，再送出訂單。",
    });
  }

  const embed = new EmbedBuilder()
    .setColor("#ffd166")
    .setTitle("📋 待客服報價訂單")
    .addFields(
      {
        name: "客人",
        value: `<@${pending.customerId}>`,
        inline: true,
      },
      {
        name: "服務類型",
        value: getServiceName(pending.category),
        inline: true,
      },
      {
        name: "服務內容",
        value:
          pending.steamGameName ||
          pending.serviceType ||
          pending.steamCategory ||
          pending.deltaMode ||
          "未填寫",
        inline: true,
      },
      {
        name: "模式 / 段位",
        value: `${pending.playMode || "無"} / ${pending.rank || "無"}`,
        inline: true,
      },
      {
        name: "陪陪人數",
        value: `${pending.playerCount || 1} 位`,
        inline: true,
      },
      {
        name: "性別偏好",
        value: pending.genderPreference || "不指定",
        inline: true,
      },
      {
        name: "指定方式",
        value: pending.assignMode || "不指定",
        inline: true,
      },
      {
        name: "時間 / 局數",
        value: pending.duration
          ? `${pending.duration} 小時`
          : pending.rounds
          ? `${pending.rounds} 局`
          : "未填寫",
        inline: true,
      },
      {
        name: "備註",
        value: pending.note || "無",
        inline: false,
      }
    )
    .setFooter({
      text: "正式價格請由客服輸入",
    })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`service_quote_price_${flowId}`)
      .setLabel("輸入價格")
      .setEmoji("💰")
      .setStyle(ButtonStyle.Success)
  );
  await interaction.channel.send({
    content: `<@&${process.env.STAFF_ROLE}> 有新的訂單需求等待報價。`,
    embeds: [embed],
    components: [row],
  });
  return interaction.editReply({
    content: "✅ 已送出需求，請等待客服報價。",
  });
}
async function openServiceQuotePriceModal(interaction) {
  if (
    !interaction.member.roles.cache.has(process.env.STAFF_ROLE) &&
    !interaction.member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return interaction.reply({
      content: "❌ 只有客服可以填寫報價",
      flags: 64,
    });
  }

  const flowId = interaction.customId.replace("service_quote_price_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.reply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
      flags: 64,
    });
  }

  const serviceTypes = Array.isArray(pending.serviceTypes)
    ? pending.serviceTypes
    : [];

  const isValorantSplit =
    pending.category === "valorant" &&
    serviceTypes.includes("娛樂") &&
    serviceTypes.includes("技術");

  const modal = new ModalBuilder()
    .setCustomId(`submit_service_quote_price_${flowId}`)
    .setTitle(isValorantSplit ? "客服輸入娛樂 / 技術報價" : "客服輸入正式報價");

  if (isValorantSplit) {
    const entertainInput = new TextInputBuilder()
      .setCustomId("entertain_price")
      .setLabel("娛樂陪玩金額")
      .setPlaceholder("例如：500")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const skillInput = new TextInputBuilder()
      .setCustomId("skill_price")
      .setLabel("技術陪玩金額")
      .setPlaceholder("例如：700")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(entertainInput),
      new ActionRowBuilder().addComponents(skillInput)
    );

    return interaction.showModal(modal);
  }

  const priceInput = new TextInputBuilder()
    .setCustomId("price")
    .setLabel("請輸入正式報價金額")
    .setPlaceholder("例如：560")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(priceInput));

  return interaction.showModal(modal);
}
async function submitServiceQuotePrice(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  if (
    !interaction.member.roles.cache.has(process.env.STAFF_ROLE) &&
    !interaction.member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return interaction.editReply({
      content: "❌ 只有客服可以填寫報價",
    });
  }

  const flowId = interaction.customId.replace(
    "submit_service_quote_price_",
    ""
  );

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  const serviceTypes = Array.isArray(pending.serviceTypes)
    ? pending.serviceTypes
    : [];
  const isValorantSplit =
    pending.category === "valorant" &&
    serviceTypes.includes("娛樂") &&
    serviceTypes.includes("技術");
  let price = 0;
  if (isValorantSplit) {
    const entertainText =
      interaction.fields.getTextInputValue("entertain_price");
    const skillText = interaction.fields.getTextInputValue("skill_price");
    const entertainPrice = Number(
      String(entertainText || "").replace(/[^\d]/g, "")
    );
    const skillPrice = Number(String(skillText || "").replace(/[^\d]/g, ""));
    if (!entertainPrice || entertainPrice <= 0) {
      return interaction.editReply({
        content: "❌ 娛樂陪玩金額格式錯誤",
      });
    }
    if (!skillPrice || skillPrice <= 0) {
      return interaction.editReply({
        content: "❌ 技術陪玩金額格式錯誤",
      });
    }
    price = entertainPrice + skillPrice;
    pending.quoteParts = {
      entertain: entertainPrice,
      skill: skillPrice,
    };
  } else {
    const priceText = interaction.fields.getTextInputValue("price");
    price = Number(String(priceText || "").replace(/[^\d]/g, ""));
    if (!price || price <= 0) {
      return interaction.editReply({
        content: "❌ 金額格式錯誤，請輸入大於 0 的數字",
      });
    }
    pending.quoteParts = null;
  }
  pending.quotedPrice = price;
  pending.originalPrice = price;
  pending.finalPrice = price;
  pending.discountRate = 1;
  pending.discountAmount = 0;
  pending.couponText = "未使用優惠券";
  pending.usedCouponItemId = null;
  pending.usedCouponName = null;
  pending.serviceCouponRecorded = false;
  pending.quotedBy = hasCustomerServicePointRole(
    interaction,
    CUSTOMER_SERVICE_POINT_ROLE_ID,
  )
    ? interaction.user.id
    : null;
  pendingServiceOrders.set(flowId, pending);

  await sendServiceCouponPrompt(interaction.channel, flowId, pending);

  return interaction.editReply({
    content: `✅ 已送出正式報價：NT$${price.toLocaleString("zh-TW")}`,
  });
}
function getServiceOriginalPrice(pending) {
  return Number(pending?.originalPrice || pending?.quotedPrice || 0);
}
function getServiceFinalPrice(pending) {
  const originalPrice = getServiceOriginalPrice(pending);

  if (
    pending &&
    pending.finalPrice !== null &&
    pending.finalPrice !== undefined &&
    pending.finalPrice !== ""
  ) {
    const finalPrice = Number(pending.finalPrice);

    if (Number.isFinite(finalPrice) && finalPrice >= 0) {
      return finalPrice;
    }
  }

  return originalPrice;
}
function buildServiceQuoteAmountText(pending) {
  const originalPrice = getServiceOriginalPrice(pending);
  const finalPrice = getServiceFinalPrice(pending);
  const discountAmount = Number(pending?.discountAmount || 0);

  const quoteText = pending?.quoteParts
    ? `娛樂陪玩：NT$${Number(pending.quoteParts.entertain || 0).toLocaleString(
        "zh-TW"
      )}\n` +
      `技術陪玩：NT$${Number(pending.quoteParts.skill || 0).toLocaleString(
        "zh-TW"
      )}\n` +
      `合計金額：NT$${originalPrice.toLocaleString("zh-TW")}`
    : `金額：NT$${originalPrice.toLocaleString("zh-TW")}`;

  if (!discountAmount) {
    return quoteText;
  }

  return (
    `${quoteText}\n` +
    `優惠券：${pending.couponText || "已使用優惠券"}\n` +
    `折扣：NT$${discountAmount.toLocaleString("zh-TW")}\n` +
    `應付金額：NT$${finalPrice.toLocaleString("zh-TW")}`
  );
}
async function sendServiceCouponPrompt(channel, flowId, pending) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`service_use_coupon_${flowId}`)
      .setLabel("使用優惠券")
      .setEmoji("🎟️")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`service_no_coupon_${flowId}`)
      .setLabel("不使用優惠券")
      .setStyle(ButtonStyle.Secondary)
  );

  await channel.send({
    content: `<@${pending.customerId}> 客服已完成報價，請選擇是否使用優惠券。`,
    embeds: [
      new EmbedBuilder()
        .setColor("#57F287")
        .setTitle("💰 正式報價單")
        .setDescription(
          `服務：${getServiceName(pending.category)}\n` +
            `${buildServiceQuoteAmountText(pending)}\n\n` +
            `請先選擇是否使用優惠券，再選擇付款方式。`
        )
        .setTimestamp(),
    ],
    components: [row],
  });
}
async function sendServicePaymentMethodSelect(channel, flowId, pending) {
  const includeSalary = await isActiveDeepnightStaff(pending.customerId);
  const rows = buildPaymentMethodButtonRows(
    `service_payment_method_${flowId}`,
    getCanonicalPaymentOptions({
      includeWallet: true,
      includeEcpay: paymentHelpers.ecpayAvailable,
      includeSalary,
    }),
  );

  await channel.send({
    content: `<@${pending.customerId}> 請選擇付款方式。`,
    embeds: [
      new EmbedBuilder()
        .setColor("#57F287")
        .setTitle("💳 選擇付款方式")
        .setDescription(
          `服務：${getServiceName(pending.category)}\n` +
            `${buildServiceQuoteAmountText(pending)}\n\n` +
            `付款完成後請上傳付款證明。`
        )
        .setTimestamp(),
    ],
    components: rows,
  });
}
function resetServiceCouponSelection(pending) {
  const originalPrice = getServiceOriginalPrice(pending);

  pending.finalPrice = originalPrice;
  pending.discountRate = 1;
  pending.discountAmount = 0;
  pending.couponText = "未使用優惠券";
  pending.usedCouponItemId = null;
  pending.usedCouponName = null;
  pending.serviceCouponRecorded = false;
}
async function handleServiceNoCoupon(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const flowId = interaction.customId.replace("service_no_coupon_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  if (interaction.user.id !== pending.customerId) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以選擇優惠券。",
    });
  }

  resetServiceCouponSelection(pending);
  pendingServiceOrders.set(flowId, pending);

  await sendServicePaymentMethodSelect(interaction.channel, flowId, pending);

  return interaction.editReply({
    content: "✅ 已選擇不使用優惠券，請繼續選擇付款方式。",
  });
}
async function handleServiceUseCoupon(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }

  const flowId = interaction.customId.replace("service_use_coupon_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  if (interaction.user.id !== pending.customerId) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以選擇優惠券。",
    });
  }

  const { data: coupons, error: couponError } = await supabase
    .from("user_items")
    .select("*")
    .eq("user_id", interaction.user.id)
    .eq("guild_id", DEEPNIGHT_GUILD_ID)
    .or("item_type.eq.coupon,item_name.ilike.%折券%,item_name.ilike.%優惠券%")
    .order("created_at", { ascending: false });

  if (couponError) {
    console.error("[新版下單優惠券] 讀取優惠券失敗", couponError);
    return interaction.editReply({
      content: "❌ 讀取優惠券失敗，請稍後再試。",
    });
  }

  if (!coupons?.length) {
    return interaction.editReply({
      content: "❌ 你目前沒有可使用的優惠券。\n" + "請改選「不使用優惠券」。",
    });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`service_select_coupon_${flowId}`)
    .setPlaceholder("請選擇要使用的優惠券")
    .addOptions(
      coupons.slice(0, 25).map((coupon) => {
        const discount = getCouponDiscount(coupon.item_name);

        return {
          label: String(coupon.item_name).slice(0, 100),
          description: `${discount.label}｜${
            coupon.description || "優惠券"
          }`.slice(0, 100),
          value: String(coupon.id),
        };
      })
    );

  return interaction.editReply({
    content:
      `🎟️ 請選擇要使用的優惠券：\n\n` +
      `訂單金額：NT$${getServiceOriginalPrice(pending).toLocaleString(
        "zh-TW"
      )}`,
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}
async function handleServiceSelectCoupon(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({
      flags: 64,
    });
  }
  await resetSelectMenuMessage(interaction);

  const flowId = interaction.customId.replace("service_select_coupon_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  if (interaction.user.id !== pending.customerId) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以使用優惠券。",
    });
  }

  const couponId = interaction.values[0];

  const { data: coupon, error: couponError } = await supabase
    .from("user_items")
    .select("*")
    .eq("id", Number(couponId))
    .eq("user_id", interaction.user.id)
    .eq("guild_id", DEEPNIGHT_GUILD_ID)
    .maybeSingle();

  if (
    couponError ||
    !coupon ||
    !(
      coupon.item_type === "coupon" ||
      String(coupon.item_name || "").includes("折券") ||
      String(coupon.item_name || "").includes("優惠券")
    )
  ) {
    return interaction.editReply({
      content: "❌ 找不到這張優惠券，可能已經被使用。",
    });
  }

  const originalPrice = getServiceOriginalPrice(pending);

  if (!originalPrice || originalPrice <= 0) {
    return interaction.editReply({
      content: "❌ 訂單金額錯誤，請聯繫客服重新報價。",
    });
  }

  const maxPrice = getCouponMaxDiscountPrice(coupon.item_name);

  if (maxPrice && originalPrice > maxPrice) {
    return interaction.editReply({
      content:
        `❌ 這張優惠券只限 NT$${maxPrice} 內訂單使用。\n` +
        `目前訂單金額：NT$${originalPrice.toLocaleString("zh-TW")}`,
    });
  }

  const discount = getCouponDiscount(coupon.item_name);
  const finalPrice = discount.fixedAmount
    ? Math.max(0, originalPrice - discount.fixedAmount)
    : Math.floor(originalPrice * discount.rate);
  const discountAmount = originalPrice - finalPrice;

  pending.finalPrice = finalPrice;
  pending.discountRate = discount.rate;
  pending.discountAmount = discountAmount;
  pending.couponText = coupon.item_name;
  pending.usedCouponItemId = coupon.id;
  pending.usedCouponName = coupon.item_name;
  pending.serviceCouponRecorded = false;
  pendingServiceOrders.set(flowId, pending);

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor("#57F287")
        .setTitle("🎟️ 優惠券已套用")
        .setDescription(
          `<@${interaction.user.id}> 已套用：${coupon.item_name}\n` +
            `優惠券會在付款成功後才從背包扣除。\n\n` +
            `原價：NT$${originalPrice.toLocaleString("zh-TW")}\n` +
            `折扣：NT$${discountAmount.toLocaleString("zh-TW")}\n` +
            `折後金額：NT$${finalPrice.toLocaleString("zh-TW")}`
        )
        .setTimestamp(),
    ],
  });

  await sendServicePaymentMethodSelect(interaction.channel, flowId, pending);

  return interaction.editReply({
    content: "✅ 優惠券已套用，付款成功後才會使用，請繼續選擇付款方式。",
    components: [],
  });
}
async function openServiceOrderNoteModal(interaction) {
  const flowId = interaction.customId.replace("order_add_note_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.reply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
      flags: 64,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId(`submit_service_order_note_${flowId}`)
    .setTitle("填寫訂單備註");

  const noteInput = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("請輸入備註 / 自訂需求")
    .setPlaceholder("例如：指定時間、遊戲名稱、希望氣氛、特殊需求等")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(noteInput));

  return interaction.showModal(modal);
}

async function submitServiceOrderNote(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const flowId = interaction.customId.replace("submit_service_order_note_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  const note = interaction.fields.getTextInputValue("note") || "";

  pending.note = note || "無";
  pendingServiceOrders.set(flowId, pending);

  return interaction.editReply({
    content: "✅ 已儲存備註",
  });
}
async function openSteamGameNameModal(interaction) {
  const flowId = interaction.customId.replace("steam_game_name_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.reply({
      content: "❌ 這筆訂單流程已過期",
      flags: 64,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId(`submit_steam_game_name_${flowId}`)
    .setTitle("Steam 遊戲名稱");

  const gameInput = new TextInputBuilder()
    .setCustomId("game_name")
    .setLabel("請輸入遊戲名稱")
    .setPlaceholder("例如：Lethal Company")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(gameInput));

  return interaction.showModal(modal);
}

async function submitSteamGameName(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const flowId = interaction.customId.replace("submit_steam_game_name_", "");

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期",
    });
  }

  pending.steamGameName = interaction.fields.getTextInputValue("game_name");

  pendingServiceOrders.set(flowId, pending);

  await showFinishNeedButtons(interaction.channel, flowId);
  return interaction.editReply({
    content:
      `✅ 已設定遊戲名稱：${pending.steamGameName}\n` +
      `如果需求都填好了，可以按下方「送出訂單」。`,
  });
}
function buildServiceTextFromPending(pending) {
  const timeText = pending.duration
    ? `${pending.duration}小時`
    : pending.rounds
    ? `${pending.rounds}局`
    : "";

  if (pending.category === "valorant") {
    return [
      "特戰英豪",
      pending.itemLabel || pending.playMode || pending.serviceType,
      pending.rank,
      timeText,
    ]
      .filter(Boolean)
      .join("｜");
  }

  if (pending.category === "apex") {
    return [
      "Apex",
      pending.itemLabel || pending.playMode || pending.serviceType,
      pending.rank,
      timeText,
    ]
      .filter(Boolean)
      .join("｜");
  }
  if (pending.category === "lol") {
    return [
      "英雄聯盟",
      pending.itemLabel || "未選擇模式",
      pending.playMode || "未選擇陪玩類型",
      pending.rank,
      timeText,
    ]
      .filter(Boolean)
      .join("｜");
  }

  if (pending.category === "steam") {
    return [
      "Steam",
      pending.steamCategory || pending.itemLabel,
      pending.steamGameName,
      timeText,
    ]
      .filter(Boolean)
      .join("｜");
  }

  if (pending.category === "delta") {
    return [
      "三角洲行動",
      pending.deltaPlatform || pending.itemLabel,
      pending.deltaMode,
      timeText,
    ]
      .filter(Boolean)
      .join("｜");
  }

  if (pending.category === "other") {
    return [
      "其他項目",
      pending.itemLabel || pending.playMode || pending.serviceType,
      timeText,
    ]
      .filter(Boolean)
      .join("｜");
  }

  if (pending.category === "chat") {
    return ["陪聊", timeText].filter(Boolean).join("｜");
  }

  if (pending.category === "emotion") {
    return ["出氣包", timeText].filter(Boolean).join("｜");
  }

  return (
    [
      getServiceName(pending.category),
      pending.itemLabel,
      pending.playMode,
      timeText,
    ]
      .filter(Boolean)
      .join("｜") || "陪玩訂單"
  );
}
function getDispatchServiceKeyFromPending(pending) {
  const text = [
    pending.serviceType,
    pending.itemLabel,
    pending.playMode,
    pending.steamCategory,
    pending.deltaMode,
  ]
    .filter(Boolean)
    .join("");

  if (pending.category === "valorant") {
    if (text.includes("大神")) return "特戰英豪大神陪玩";
    if (text.includes("技術")) return "特戰英豪技術陪玩";
    if (text.includes("娛樂")) return "特戰英豪娛樂陪玩";
    return "特戰英豪";
  }

  if (pending.category === "apex") {
    if (text.includes("大神")) return "Apex大神陪玩";
    if (text.includes("技術")) return "Apex技術陪玩";
    if (text.includes("娛樂")) return "Apex娛樂陪玩";
    return "Apex";
  }
  if (pending.category === "lol") {
    if (text.includes("大神")) return "英雄聯盟大神陪玩";
    if (text.includes("技術")) return "英雄聯盟技術陪玩";
    if (text.includes("娛樂")) return "英雄聯盟娛樂陪玩";
    return "英雄聯盟";
  }

  if (pending.category === "steam") {
    return pending.steamCategory ? `Steam${pending.steamCategory}` : "Steam";
  }

  if (pending.category === "delta") {
    return pending.deltaMode ? `三角洲行動${pending.deltaMode}` : "三角洲行動";
  }

  if (pending.category === "other") {
    return pending.itemLabel || pending.playMode || "其他項目";
  }

  if (pending.category === "chat") {
    return "語音聊天";
  }

  if (pending.category === "emotion") {
    return "出氣包";
  }

  return getServiceName(pending.category);
}
async function createPlayOrderFromServicePending(pending, channelId) {
  const originalAmount = getServiceOriginalPrice(pending);
  const amount = getServiceFinalPrice(pending);

  if (!originalAmount || originalAmount <= 0) {
    throw new Error("尚未報價，不能建立訂單");
  }

  const serviceText = buildServiceTextFromPending(pending);

  const preferredPlayer = pending.selectedPlayerIds?.length
    ? pending.selectedPlayerIds.join(",")
    : null;
  const orderNo = await getNextPlayOrderNumber();

  const { data, error } = await supabase
    .from("play_orders")
    .insert({
      guild_id: pending.guildId || process.env.GUILD_ID,
      order_no: orderNo,

      customer_id: pending.customerId,
      customer_username: pending.customerUsername || `<@${pending.customerId}>`,
      customer_name: `<@${pending.customerId}>`,

      channel_id: channelId,
      source_channel_id: channelId,

      game: getServiceName(pending.category),
      service: serviceText,
      dispatch_service_key: getDispatchServiceKeyFromPending(pending),
      order_type: "訂單",
      order_item: serviceText,

      rank_preference: pending.rank || null,
      player_count: Number(pending.playerCount || 1),
      gender_preference: pending.genderPreference || "不指定",

      preferred_player: preferredPlayer,
      reserved_player:
        pending.assignMode === "預約指定" ? preferredPlayer : null,
      dispatch_type:
        pending.selectedPlayerType === "reserve" ? "reserve" : null,
      assigned_player: null,

      duration_text: pending.duration
        ? `${pending.duration} 小時`
        : pending.rounds
        ? `${pending.rounds} 局`
        : null,

      note: pending.note || "",

      price: originalAmount,
      original_price: originalAmount,
      final_price: amount,
      discount_rate: Number(pending.discountRate || 1),
      discount_amount: Number(pending.discountAmount || 0),
      coupon_text: pending.couponText || "未使用優惠券",
      coupon_name: pending.usedCouponName || null,
      coupon_item_id: pending.usedCouponItemId || null,
      coupon_consumed_at: null,
      payment_method: pending.paymentMethod || null,
      quoted_by: pending.quotedBy || null,
      quote_status: "quoted",

      paid: false,
      paid_at: null,

      salary_paid: false,
      salary_paid_at: null,

      status: "waiting_payment",
    })
    .select()
    .single();

  if (error || !data) {
    console.error("[新版下單] 建立 play_orders 失敗", error);
    throw new Error(error?.message || "建立訂單失敗");
  }

  if (pending.quotedBy) {
    await awardCustomerServicePoint(data.id, pending.quotedBy);
  }

  return data;
}
function clonePendingForValorantSplit(
  pending,
  splitRole,
  splitPrice,
  splitFinalPrice,
  splitDiscountAmount,
  splitPlayerCount
) {
  return {
    ...pending,
    serviceType: splitRole,
    serviceTypes: [splitRole],
    quotedPrice: splitPrice,
    originalPrice: splitPrice,
    finalPrice: splitFinalPrice,
    discountAmount: splitDiscountAmount,
    playerCount: splitPlayerCount,
    quoteParts: null,
  };
}

async function createValorantSplitOrdersFromPending(pending, channelId) {
  const entertainPrice = Number(pending.quoteParts?.entertain || 0);

  const skillPrice = Number(pending.quoteParts?.skill || 0);

  if (!entertainPrice || !skillPrice) {
    throw new Error("娛樂 / 技術報價不完整");
  }

  const groupId = `VG-${Date.now()}-${pending.customerId}`;

  const originalTotal = entertainPrice + skillPrice;
  const finalTotal = getServiceFinalPrice(pending);
  const totalDiscount = Math.max(0, originalTotal - finalTotal);
  const totalPlayerCount = Math.max(2, Number(pending.playerCount || 2));
  const entertainPlayerCount = Math.max(1, Math.floor(totalPlayerCount / 2));
  const skillPlayerCount = Math.max(1, totalPlayerCount - entertainPlayerCount);

  let entertainFinal = entertainPrice;
  let skillFinal = skillPrice;
  let entertainDiscount = 0;
  let skillDiscount = 0;

  if (totalDiscount > 0 && originalTotal > 0) {
    entertainFinal = Math.floor((entertainPrice * finalTotal) / originalTotal);
    skillFinal = finalTotal - entertainFinal;
    entertainDiscount = entertainPrice - entertainFinal;
    skillDiscount = skillPrice - skillFinal;
  }

  const entertainPending = clonePendingForValorantSplit(
    pending,
    "娛樂",
    entertainPrice,
    entertainFinal,
    entertainDiscount,
    entertainPlayerCount
  );

  const skillPending = clonePendingForValorantSplit(
    pending,
    "技術",
    skillPrice,
    skillFinal,
    skillDiscount,
    skillPlayerCount
  );

  const entertainOrder = await createPlayOrderFromServicePending(
    entertainPending,
    channelId
  );

  const skillOrder = await createPlayOrderFromServicePending(
    skillPending,
    channelId
  );

  const totalPrice = finalTotal;

  await supabase
    .from("play_orders")
    .update({
      order_group_id: groupId,
      split_role: "娛樂",
      group_total_price: totalPrice,
    })
    .eq("id", entertainOrder.id);

  await supabase
    .from("play_orders")
    .update({
      order_group_id: groupId,
      split_role: "技術",
      group_total_price: totalPrice,
    })
    .eq("id", skillOrder.id);

  const { data: orders, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("order_group_id", groupId);

  if (error || !orders?.length) {
    console.error("[特戰分單] 讀取分單失敗", error);
    throw new Error("建立分單後讀取失敗");
  }

  return {
    groupId,
    totalPrice,
    orders,
  };
}
async function consumePaidOrderCoupon(orderOrOrders, customerId) {
  const orders = Array.isArray(orderOrOrders)
    ? orderOrOrders
    : [orderOrOrders].filter(Boolean);
  const orderIds = orders.map((order) => order?.id).filter(Boolean);
  if (!orderIds.length) return { consumed: false, reason: "no_orders" };

  const { data, error } = await supabase.rpc(
    "deepnight_consume_order_coupon",
    {
      p_order_ids: orderIds,
      p_customer_id: String(customerId || orders[0]?.customer_id || ""),
    },
  );

  if (error) throw new Error(error.message || "優惠券扣除失敗");
  return data;
}
async function sendServiceWalletConfirm(interaction, order, orderGroup) {
  const isGroup = !!orderGroup;

  const totalAmount = isGroup
    ? Number(orderGroup.totalPrice || 0)
    : Number(order.final_price || order.price || 0);

  const confirmId = isGroup
    ? `service_confirm_wallet_group_${orderGroup.groupId}`
    : `service_confirm_wallet_${order.id}`;

  const cancelId = isGroup
    ? `service_cancel_wallet_group_${orderGroup.groupId}`
    : `service_cancel_wallet_${order.id}`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(confirmId)
      .setLabel("確認錢包扣款")
      .setEmoji("💳")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId(cancelId)
      .setLabel("取消此付款方式")
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.channel.send({
    content: `<@${interaction.user.id}>`,
    embeds: [
      new EmbedBuilder()
        .setColor("#ffd166")
        .setTitle("💳 確認錢包扣款")
        .setDescription(
          `請確認是否使用錢包扣款。\n\n` +
            `扣款金額：NT$${totalAmount.toLocaleString("zh-TW")}\n\n` +
            (isGroup
              ? `此為特戰娛樂＋技術合併付款，系統會一次扣總額，扣款後分開派單。`
              : `確認後會直接從你的 ASD 餘額扣款。`)
        )
        .setTimestamp(),
    ],
    components: [row],
  });
}

async function sendServiceMonthlyConfirm(interaction, order, orderGroup) {
  const isGroup = !!orderGroup;

  const totalAmount = isGroup
    ? Number(orderGroup.totalPrice || 0)
    : Number(order.final_price || order.price || 0);

  const confirmId = isGroup
    ? `service_confirm_monthly_group_${orderGroup.groupId}`
    : `service_confirm_monthly_${order.id}`;

  const cancelId = isGroup
    ? `service_cancel_monthly_group_${orderGroup.groupId}`
    : `service_cancel_monthly_${order.id}`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(confirmId)
      .setLabel("確認使用月結付款")
      .setEmoji("🌙")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId(cancelId)
      .setLabel("取消此付款方式")
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.channel.send({
    content: `<@${interaction.user.id}>`,
    embeds: [
      new EmbedBuilder()
        .setColor("#66ccff")
        .setTitle("🌙 確認月結付款")
        .setDescription(
          `請確認是否使用月結額度付款。\n\n` +
            `扣額金額：NT$${totalAmount.toLocaleString("zh-TW")}\n\n` +
            (isGroup
              ? `此為特戰娛樂＋技術合併付款，系統會一次扣總額，扣款後分開派單。`
              : `確認後會直接扣除你的月結可用額度。`)
        )
        .setTimestamp(),
    ],
    components: [row],
  });
}
async function handleServicePaymentMethodSelect(interaction) {
  await deferReplyOnce(interaction);
  await resetSelectMenuMessage(interaction);

  const selection = getPaymentMethodSelection(interaction, "service_payment_method_");
  const flowId = selection?.entityId;

  const pending = pendingServiceOrders.get(flowId);

  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆訂單流程已過期，請重新下單。",
    });
  }

  if (interaction.user.id !== pending.customerId) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以選擇付款方式。",
    });
  }

  const paymentMethod = selection?.paymentMethod;

  pending.paymentMethod = paymentMethod;
  pendingServiceOrders.set(flowId, pending);

  if (String(paymentMethod).includes("扣薪")) {
    const amount = getServiceFinalPrice(pending);
    try {
      const eligibility = await getSalaryDeductionEligibility(
        pending.customerId,
        amount,
      );
      if (!eligibility.state.canUse) {
        pending.paymentMethod = null;
        pendingServiceOrders.set(flowId, pending);
        return interaction.editReply({
          content:
            `❌ 無法使用扣薪付款：每人最多預支 NT$${eligibility.state.advanceLimit.toLocaleString("zh-TW")}。\n` +
            `本筆確認後會預支 NT$${eligibility.state.projectedAdvance.toLocaleString("zh-TW")}，已超過上限。`,
        });
      }

      await createSalaryDeductionPrompt({
        channel: interaction.channel,
        customerId: pending.customerId,
        amount,
        eligibility,
        confirmId: `salary_service_confirm_${flowId}`,
        cancelId: `salary_service_cancel_${flowId}`,
      });
      return interaction.editReply({
        content: "✅ 已送出扣薪確認，請等待客服或管理員處理。",
      });
    } catch (err) {
      pending.paymentMethod = null;
      pendingServiceOrders.set(flowId, pending);
      return interaction.editReply({
        content: `❌ 無法使用扣薪付款：${err.message || err}`,
      });
    }
  }

  let order = null;
  let orderGroup = null;
  const serviceTypes = Array.isArray(pending.serviceTypes)
    ? pending.serviceTypes
    : [];
  const isValorantSplit =
    pending.category === "valorant" &&
    serviceTypes.includes("娛樂") &&
    serviceTypes.includes("技術") &&
    pending.quoteParts;
  try {
    if (isValorantSplit) {
      orderGroup = await createValorantSplitOrdersFromPending(
        pending,
        interaction.channel.id
      );
    } else {
      order = await createPlayOrderFromServicePending(
        pending,
        interaction.channel.id
      );
    }
  } catch (err) {
    console.error("[新版下單] 建立訂單失敗", err);
    return interaction.editReply({
      content: `❌ 建立訂單失敗：${err.message || err}`,
    });
  }
  if (String(paymentMethod).includes("錢包") || String(paymentMethod).includes("儲值卡")) {
    await sendServiceWalletConfirm(interaction, order, orderGroup);
    return interaction.editReply({
      content: "✅ 已選擇錢包扣款，請確認是否使用此付款方式。",
    });
  }
  if (String(paymentMethod).includes("月結")) {
    await sendServiceMonthlyConfirm(interaction, order, orderGroup);
    return interaction.editReply({
      content: "✅ 已選擇月結付款，請確認是否使用此付款方式。",
    });
  }

  if (paymentMethod === "綠界支付") {
    if (!paymentHelpers.ecpayAvailable || !paymentHelpers.createEcpayServicePayment)
      return interaction.editReply({ content: "❌ 綠界信用卡付款目前尚未開放，請重新選擇付款方式。" });
    const orders = orderGroup ? orderGroup.orders : [order];
    const amount = orders.reduce((sum, current) => sum + Number(current.final_price || current.price || 0), 0);
    const entityKey = orderGroup ? `group-${orderGroup.groupId}` : String(order.id);
    try {
      const payment = await paymentHelpers.createEcpayServicePayment({
        kind: "order", entityKey, userId: pending.customerId, amount,
        channelId: interaction.channel.id,
        description: `陪玩訂單 ${orderGroup?.groupId || order.order_no || order.id}`,
        metadata: { flow: "service", orderIds: orders.map((current) => current.id), orderGroupId: orderGroup?.groupId || null },
      });
      await sendEcpayPaymentPrompt(interaction.channel, pending.customerId, amount, payment, "訂單");
      pendingServiceOrders.delete(flowId);
      return interaction.editReply({ content: "✅ 已建立綠界付款連結，付款完成後會自動核帳並派單。" });
    } catch (err) {
      return interaction.editReply({ content: `❌ 建立綠界付款失敗：${err.message || err}` });
    }
  }
  if (
    paymentMethod === "街口支付" &&
    paymentHelpers.jkopayAvailable &&
    paymentHelpers.createJkopayServicePayment
  ) {
    const orders = orderGroup ? orderGroup.orders : [order];
    const amount = orders.reduce(
      (sum, current) => sum + Number(current.final_price || current.price || 0),
      0,
    );
    const entityKey = orderGroup ? `group-${orderGroup.groupId}` : String(order.id);
    try {
      const payment = await paymentHelpers.createJkopayServicePayment({
        kind: "order",
        entityKey,
        userId: pending.customerId,
        amount,
        channelId: interaction.channel.id,
        description: `陪玩訂單 ${orderGroup?.groupId || order.order_no || order.id}`,
        metadata: {
          flow: "service",
          orderIds: orders.map((current) => current.id),
          orderGroupId: orderGroup?.groupId || null,
        },
      });
      await sendJkopayPaymentPrompt(interaction.channel, pending.customerId, amount, payment, "訂單");
      pendingServiceOrders.delete(flowId);
      return interaction.editReply({ content: "✅ 已建立街口付款連結，付款完成後會自動核帳並派單。" });
    } catch (err) {
      return interaction.editReply({ content: `❌ 建立街口付款失敗：${err.message || err}` });
    }
  }

  if (isBankTransfer(paymentMethod)) {
    await sendBankTransferInfo(interaction.channel);
  }

  if (isCardPayment(paymentMethod)) {
    await sendCardPaymentInfo(interaction.channel);
  }

  if (isNoCardPayment(paymentMethod)) {
    await sendNoCardPaymentInfo(interaction.channel);
  }

  if (String(paymentMethod).includes("虛擬貨幣") || String(paymentMethod).includes("加密貨幣")) {
    await interaction.channel.send({
      content:
        `<@${pending.customerId}> 你選擇了加密貨幣付款。\n` +
        `請等待客服提供錢包地址，付款後請上傳付款證明。`,
    });
  }

  const confirmCustomId = orderGroup
    ? `service_confirm_paid_group_${orderGroup.groupId}`
    : `service_confirm_paid_${order.id}`;
  const cancelCustomId = orderGroup
    ? `service_cancel_order_group_${orderGroup.groupId}`
    : `service_cancel_order_${order.id}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(confirmCustomId)
      .setLabel("客服確認付款，派單")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(cancelCustomId)
      .setLabel("取消訂單")
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.channel.send({
    content:
      `<@&${process.env.STAFF_ROLE}> 客人已選擇付款方式：${getPaymentMethodDisplayName(paymentMethod)}\n` +
      (orderGroup
        ? `本次為特戰娛樂＋技術合併付款，合計 NT$${orderGroup.totalPrice.toLocaleString(
            "zh-TW"
          )}。\n`
        : "") +
      `付款完成並確認明細後，請按「客服確認付款，派單」。`,
    components: [row],
  });

  pendingServiceOrders.delete(flowId);

  return interaction.editReply({
    content: `✅ 已選擇付款方式：${getPaymentMethodDisplayName(paymentMethod)}，請依照頻道內資訊完成付款。`,
  });
}

async function handleSalaryServiceConfirm(interaction) {
  await deferReplyOnce(interaction);
  if (!canApproveSalaryDeduction(interaction)) {
    return interaction.editReply({
      content: "❌ 只有客服或管理員可以確認扣薪付款。",
    });
  }

  const flowId = interaction.customId.replace("salary_service_confirm_", "");
  const pending = pendingServiceOrders.get(flowId);
  if (!pending || pending.paymentMethod !== "扣薪") {
    return interaction.editReply({
      content: "❌ 這筆扣薪付款已過期或已處理，請重新下單。",
    });
  }

  const amount = getServiceFinalPrice(pending);
  let createdOrderIds = [];
  let paymentCompleted = false;
  try {
    const latestEligibility = await getSalaryDeductionEligibility(
      pending.customerId,
      amount,
    );
    if (!latestEligibility.state.canUse) {
      throw new Error(
        `本筆確認後會預支 NT$${latestEligibility.state.projectedAdvance.toLocaleString("zh-TW")}，已超過 NT$${latestEligibility.state.advanceLimit.toLocaleString("zh-TW")} 上限`,
      );
    }

    const serviceTypes = Array.isArray(pending.serviceTypes)
      ? pending.serviceTypes
      : [];
    const isValorantSplit =
      pending.category === "valorant" &&
      serviceTypes.includes("娛樂") &&
      serviceTypes.includes("技術") &&
      pending.quoteParts;
    let order = null;
    let orderGroup = null;
    if (isValorantSplit) {
      orderGroup = await createValorantSplitOrdersFromPending(
        pending,
        interaction.channel.id,
      );
      createdOrderIds = orderGroup.orders.map((item) => item.id);
    } else {
      order = await createPlayOrderFromServicePending(
        pending,
        interaction.channel.id,
      );
      createdOrderIds = [order.id];
    }

    const result = await applySalaryDeductionToOrders({
      customerId: pending.customerId,
      amount,
      orderIds: createdOrderIds,
      finalStatus: "pending",
      quoteStatus: "dispatched",
      confirmedBy: interaction.user.id,
    });
    paymentCompleted = true;

    for (const paidOrder of result.orders) {
      await processOrderDeliveryNow(paidOrder.id, "order_financial_effects");
      await processOrderDeliveryNow(paidOrder.id, "order_dispatch");
    }

    pendingServiceOrders.delete(flowId);
    await interaction.message.edit({ components: [] }).catch(() => null);
    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#57F287")
          .setTitle("✅ 扣薪付款完成")
          .setDescription(
            `<@${pending.customerId}> 已使用薪資支付 NT$${amount.toLocaleString("zh-TW")}。\n` +
              `深夜 EIP 已新增扣項：使用薪水點單\n` +
              `由 <@${interaction.user.id}> 確認，系統已自動派單。`,
          )
          .setTimestamp(),
      ],
    });
    return interaction.editReply({
      content: "✅ 已確認扣薪付款、建立深夜 EIP 扣項並完成派單。",
    });
  } catch (err) {
    if (!paymentCompleted && createdOrderIds.length) {
      await supabase
        .from("play_orders")
        .update({
          status: "cancelled",
          updated_at: new Date().toISOString(),
        })
        .in("id", createdOrderIds)
        .eq("paid", false);
    }
    return interaction.editReply({
      content: paymentCompleted
        ? `⚠️ 扣薪與深夜 EIP 扣項已完成，但派單通知發送失敗，請客服人工確認：${err.message || err}`
        : `❌ 扣薪付款失敗：${err.message || err}`,
    });
  }
}

async function handleSalaryServiceCancel(interaction) {
  await deferReplyOnce(interaction);
  if (!canApproveSalaryDeduction(interaction)) {
    return interaction.editReply({
      content: "❌ 只有客服或管理員可以取消扣薪付款。",
    });
  }

  const flowId = interaction.customId.replace("salary_service_cancel_", "");
  const pending = pendingServiceOrders.get(flowId);
  if (!pending) {
    return interaction.editReply({
      content: "❌ 這筆扣薪付款已過期或已處理。",
    });
  }

  pending.paymentMethod = null;
  pendingServiceOrders.set(flowId, pending);
  await interaction.message.edit({ components: [] }).catch(() => null);
  await sendServicePaymentMethodSelect(interaction.channel, flowId, pending);
  return interaction.editReply({
    content: "✅ 已取消扣薪付款，請員工重新選擇付款方式。",
  });
}
async function handleServiceConfirmWallet(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const orderId = interaction.customId.replace("service_confirm_wallet_", "");

  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();

  if (error || !order) {
    console.error("[儲值卡確認] 找不到訂單", error);
    return interaction.editReply({
      content: "❌ 找不到訂單",
    });
  }

  if (interaction.user.id !== order.customer_id) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以確認付款",
    });
  }

  try {
    const result = await paymentHelpers.payOrderByWallet(order);

    await supabase
      .from("play_orders")
      .update({
        status: "pending",
        quote_status: "dispatched",
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id);

    const { data: paidOrder } = await supabase
      .from("play_orders")
      .select("*")
      .eq("id", order.id)
      .single();

    await processOrderDeliveryNow(order.id, "order_dispatch");
    await processOrderDeliveryNow(order.id, "order_financial_effects");

    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#57F287")
          .setTitle("✅ 錢包扣款完成")
          .setDescription(
            `<@${order.customer_id}> 已確認使用錢包扣款。\n\n` +
              `扣款金額：${Number(result.amount || 0).toLocaleString(
                "zh-TW"
              )} ASD\n` +
              `剩餘餘額：${Number(result.finalCoins || 0).toLocaleString(
                "zh-TW"
              )} ASD\n\n` +
              `系統已自動派單。`
          )
          .setTimestamp(),
      ],
    });

    return interaction.editReply({
      content: "✅ 錢包扣款成功，已派單。",
    });
  } catch (err) {
    console.error("[儲值卡確認] 扣款失敗", err);

    const { data: paidOrder } = await supabase
      .from("play_orders")
      .select("id,paid,guild_id")
      .eq("id", order.id)
      .eq("guild_id", DEEPNIGHT_GUILD_ID)
      .maybeSingle();
    if (paidOrder?.paid) {
      await processOrderDeliveryNow(order.id, "order_dispatch").catch(
        (recoveryError) =>
          console.error("[儲值卡確認] 付款後派單仍待自動重試", recoveryError),
      );
      await processOrderDeliveryNow(order.id, "order_financial_effects").catch(
        (recoveryError) =>
          console.error("[儲值卡確認] 付款後財務效果仍待自動重試", recoveryError),
      );
      return interaction.editReply({
        content:
          "⚠️ 儲值卡扣款已完成，不會重複扣款；派單或通知尚未完成，系統已排入自動重試。",
      });
    }

    return interaction.editReply({
      content: `❌ 儲值卡付款失敗：${err.message || err}`,
    });
  }
}
async function handleServiceConfirmMonthly(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const orderId = interaction.customId.replace("service_confirm_monthly_", "");

  const { data: order, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();

  if (error || !order) {
    console.error("[月結確認] 找不到訂單", error);
    return interaction.editReply({
      content: "❌ 找不到訂單",
    });
  }

  if (interaction.user.id !== order.customer_id) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以確認付款",
    });
  }

  try {
    const result = await paymentHelpers.payOrderByMonthly(order);

    await supabase
      .from("play_orders")
      .update({
        status: "pending",
        quote_status: "dispatched",
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id);

    const { data: paidOrder } = await supabase
      .from("play_orders")
      .select("*")
      .eq("id", order.id)
      .single();

    await processOrderDeliveryNow(order.id, "order_dispatch");
    await processOrderDeliveryNow(order.id, "order_financial_effects");

    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#57F287")
          .setTitle("✅ 月結付款完成")
          .setDescription(
            `<@${order.customer_id}> 已確認使用月結付款。\n\n` +
              `本次扣額：NT$${Number(result.amount || 0).toLocaleString(
                "zh-TW"
              )}\n` +
              `剩餘月結額度：NT$${Number(
                result.availableAmount || 0
              ).toLocaleString("zh-TW")}\n\n` +
              `系統已自動派單。`
          )
          .setTimestamp(),
      ],
    });

    return interaction.editReply({
      content: "✅ 月結付款成功，已派單。",
    });
  } catch (err) {
    console.error("[月結確認] 扣額失敗", err);

    const { data: paidOrder } = await supabase
      .from("play_orders")
      .select("id,paid,guild_id")
      .eq("id", order.id)
      .eq("guild_id", DEEPNIGHT_GUILD_ID)
      .maybeSingle();
    if (paidOrder?.paid) {
      await processOrderDeliveryNow(order.id, "order_dispatch").catch(
        (recoveryError) =>
          console.error("[月結確認] 付款後派單仍待自動重試", recoveryError),
      );
      await processOrderDeliveryNow(order.id, "order_financial_effects").catch(
        (recoveryError) =>
          console.error("[月結確認] 付款後財務效果仍待自動重試", recoveryError),
      );
      return interaction.editReply({
        content:
          "⚠️ 月結扣額已完成，不會重複扣額；派單或通知尚未完成，系統已排入自動重試。",
      });
    }

    return interaction.editReply({
      content: `❌ 月結付款失敗：${err.message || err}`,
    });
  }
}
async function handleServiceConfirmWalletGroup(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const groupId = interaction.customId.replace(
    "service_confirm_wallet_group_",
    ""
  );

  const { data: orders, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("order_group_id", groupId)
    .eq("guild_id", DEEPNIGHT_GUILD_ID)
    .order("id", { ascending: true });

  if (error || !orders?.length) {
    console.error("[特戰分單儲值卡] 找不到分單", error);
    return interaction.editReply({
      content: "❌ 找不到這組分單",
    });
  }

  const customerId = orders[0].customer_id;

  if (interaction.user.id !== customerId) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以確認付款",
    });
  }

  let totalAmount = orders.reduce(
    (sum, order) => sum + Number(order.final_price || order.price || 0),
    0
  );

  try {
    const { data: paymentResult, error: paymentError } = await supabase.rpc(
      "deepnight_pay_service_group",
      {
        p_group_id: groupId,
        p_customer_id: customerId,
        p_guild_id: orders[0].guild_id || DEEPNIGHT_GUILD_ID,
        p_method: "wallet",
      },
    );

    if (paymentError) throw paymentError;

    const paidOrders = Array.isArray(paymentResult?.orders)
      ? paymentResult.orders
      : [];
    if (!paidOrders.length) throw new Error("付款完成但找不到分單資料");

    totalAmount = Number(paymentResult.amount || totalAmount);
    const finalCoins = Number(paymentResult.receipt?.balance || 0);

    await paymentHelpers.sendWalletLog(
      customerId,
      "訂單扣款",
      -totalAmount,
      finalCoins,
      `特戰娛樂＋技術合併付款｜${groupId}`,
      false,
    );

    for (const order of paidOrders) {
      await processOrderDeliveryNow(order.id, "order_dispatch");
      await processOrderDeliveryNow(order.id, "order_financial_effects");
    }

    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#57F287")
          .setTitle("✅ 特戰合併錢包扣款完成")
          .setDescription(
            `已一次扣除總額：${totalAmount.toLocaleString("zh-TW")} ASD\n` +
              `剩餘餘額：${Number(finalCoins || 0).toLocaleString(
                "zh-TW"
              )} ASD\n\n` +
              `娛樂 / 技術已分開派單。`
          )
          .setTimestamp(),
      ],
    });

    return interaction.editReply({
      content: "✅ 儲值卡合併付款成功，已分開派單。",
    });
  } catch (err) {
    console.error("[特戰分單儲值卡] 扣款失敗", err);

    const { data: paidOrders } = await supabase
      .from("play_orders")
      .select("id,paid,guild_id")
      .eq("order_group_id", groupId)
      .eq("guild_id", DEEPNIGHT_GUILD_ID);
    if (paidOrders?.length && paidOrders.every((paidOrder) => paidOrder.paid)) {
      for (const paidOrder of paidOrders) {
        await processOrderDeliveryNow(paidOrder.id, "order_dispatch").catch(
          (recoveryError) =>
            console.error("[特戰分單儲值卡] 付款後派單仍待自動重試", recoveryError),
        );
        await processOrderDeliveryNow(
          paidOrder.id,
          "order_financial_effects",
        ).catch((recoveryError) =>
          console.error(
            "[特戰分單儲值卡] 付款後財務效果仍待自動重試",
            recoveryError,
          ),
        );
      }
      return interaction.editReply({
        content:
          "⚠️ 特戰分單扣款已完成，不會重複扣款；尚未完成的派單已排入自動重試。",
      });
    }

    return interaction.editReply({
      content: `❌ 儲值卡合併付款失敗：${err.message || err}`,
    });
  }
}
async function handleServiceConfirmMonthlyGroup(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const groupId = interaction.customId.replace(
    "service_confirm_monthly_group_",
    ""
  );

  const { data: orders, error } = await supabase
    .from("play_orders")
    .select("*")
    .eq("order_group_id", groupId)
    .eq("guild_id", DEEPNIGHT_GUILD_ID)
    .order("id", { ascending: true });

  if (error || !orders?.length) {
    console.error("[特戰分單月結] 找不到分單", error);
    return interaction.editReply({
      content: "❌ 找不到這組分單",
    });
  }

  const customerId = orders[0].customer_id;

  if (interaction.user.id !== customerId) {
    return interaction.editReply({
      content: "❌ 只有下單的闆闆可以確認付款",
    });
  }

  let totalAmount = orders.reduce(
    (sum, order) => sum + Number(order.final_price || order.price || 0),
    0
  );

  try {
    const { data: paymentResult, error: paymentError } = await supabase.rpc(
      "deepnight_pay_service_group",
      {
        p_group_id: groupId,
        p_customer_id: customerId,
        p_guild_id: orders[0].guild_id || DEEPNIGHT_GUILD_ID,
        p_method: "monthly",
      },
    );

    if (paymentError) throw paymentError;

    const paidOrders = Array.isArray(paymentResult?.orders)
      ? paymentResult.orders
      : [];
    if (!paidOrders.length) throw new Error("付款完成但找不到分單資料");

    totalAmount = Number(paymentResult.amount || totalAmount);
    const availableAmount = Number(
      paymentResult.receipt?.available_amount || 0,
    );

    for (const order of paidOrders) {
      await processOrderDeliveryNow(order.id, "order_dispatch");
      await processOrderDeliveryNow(order.id, "order_financial_effects");
    }

    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#57F287")
          .setTitle("✅ 特戰合併月結付款完成")
          .setDescription(
            `已一次扣除月結總額：NT$${totalAmount.toLocaleString("zh-TW")}\n` +
              `剩餘月結額度：NT$${availableAmount.toLocaleString("zh-TW")}\n\n` +
              `娛樂 / 技術已分開派單。`
          )
          .setTimestamp(),
      ],
    });

    return interaction.editReply({
      content: "✅ 月結合併付款成功，已分開派單。",
    });
  } catch (err) {
    console.error("[特戰分單月結] 扣額失敗", err);

    const { data: paidOrders } = await supabase
      .from("play_orders")
      .select("id,paid,guild_id")
      .eq("order_group_id", groupId)
      .eq("guild_id", DEEPNIGHT_GUILD_ID);
    if (paidOrders?.length && paidOrders.every((paidOrder) => paidOrder.paid)) {
      for (const paidOrder of paidOrders) {
        await processOrderDeliveryNow(paidOrder.id, "order_dispatch").catch(
          (recoveryError) =>
            console.error("[特戰分單月結] 付款後派單仍待自動重試", recoveryError),
        );
        await processOrderDeliveryNow(
          paidOrder.id,
          "order_financial_effects",
        ).catch((recoveryError) =>
          console.error(
            "[特戰分單月結] 付款後財務效果仍待自動重試",
            recoveryError,
          ),
        );
      }
      return interaction.editReply({
        content:
          "⚠️ 特戰分單月結扣額已完成，不會重複扣額；尚未完成的派單已排入自動重試。",
      });
    }

    return interaction.editReply({
      content: `❌ 月結合併付款失敗：${err.message || err}`,
    });
  }
}
async function handleServiceConfirmPaidGroup(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const isStaff =
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.editReply({
      content: "❌ 只有客服可以確認付款",
    });
  }

  const groupId = interaction.customId.replace(
    "service_confirm_paid_group_",
    ""
  );

  const { data: existingOrders, error: readError } = await supabase
    .from("play_orders")
    .select("id")
    .eq("order_group_id", groupId)
    .eq("guild_id", DEEPNIGHT_GUILD_ID);

  if (readError || !existingOrders?.length) {
    console.error("[特戰分單] 找不到深夜分單", readError);
    return interaction.editReply({
      content: "❌ 找不到這組深夜分單",
    });
  }

  let paymentCommitted = false;
  let orders = [];
  try {
    const { data, error } = await supabase.rpc(
      "deepnight_confirm_manual_payment",
      {
        p_order_ids: existingOrders.map((order) => order.id),
        p_guild_id: DEEPNIGHT_GUILD_ID,
        p_confirmed_by: interaction.user.id,
        p_delivery_type: "order_dispatch",
      },
    );
    if (error) throw error;
    paymentCommitted = true;
    orders = Array.isArray(data?.orders) ? data.orders : [];
    if (orders.length !== existingOrders.length) {
      throw new Error("確認付款後取得的深夜分單資料不完整");
    }
    for (const order of orders) {
      await processOrderDeliveryNow(order.id, "order_dispatch");
      await processOrderDeliveryNow(order.id, "order_financial_effects");
    }
    await interaction.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#57F287")
          .setTitle("✅ 特戰合併付款已確認")
          .setDescription(
            `已分開派單：\n\n` +
              orders
                .map((order) => {
                  return (
                    `・${order.split_role || "分單"}：` +
                    `${order.service || "未填寫"}｜NT$${Number(
                      order.final_price || order.price || 0,
                    ).toLocaleString("zh-TW")}`
                  );
                })
                .join("\n"),
          )
          .setTimestamp(),
      ],
    });
    return interaction.editReply({
      content: "✅ 已確認合併付款，娛樂 / 技術已分開派單。",
    });
  } catch (error) {
    console.error("[特戰分單] 確認付款或後續派單失敗", error);
    const { data: paidOrders } = paymentCommitted
      ? { data: existingOrders.map((order) => ({ ...order, paid: true })) }
      : await supabase
          .from("play_orders")
          .select("id,paid")
          .in("id", existingOrders.map((order) => order.id))
          .eq("guild_id", DEEPNIGHT_GUILD_ID);
    if (
      paidOrders?.length === existingOrders.length &&
      paidOrders.every((order) => order.paid)
    ) {
      for (const order of paidOrders) {
        await processOrderDeliveryNow(order.id, "order_dispatch").catch(
          (recoveryError) =>
            console.error("[特戰分單] 派單仍待排程重試", recoveryError),
        );
        await processOrderDeliveryNow(order.id, "order_financial_effects").catch(
          (recoveryError) =>
            console.error("[特戰分單] 財務效果仍待排程重試", recoveryError),
        );
      }
      return interaction.editReply({
        content:
          "⚠️ 付款已確認，不會重複處理；派單或財務效果已保留並會自動重試。",
      });
    }
    return interaction.editReply({
      content: `❌ 確認付款失敗：${error.message || error}`,
    });
  }
}
async function handleServiceConfirmPaid(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const isStaff =
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.editReply({
      content: "❌ 只有客服可以確認付款",
    });
  }

  const orderId = interaction.customId.replace("service_confirm_paid_", "");

  let paymentCommitted = false;
  try {
    const { data, error } = await supabase.rpc(
      "deepnight_confirm_manual_payment",
      {
        p_order_ids: [orderId],
        p_guild_id: DEEPNIGHT_GUILD_ID,
        p_confirmed_by: interaction.user.id,
        p_delivery_type: "order_dispatch",
      },
    );
    if (error) throw error;
    paymentCommitted = true;
    const order = Array.isArray(data?.orders) ? data.orders[0] : null;
    if (!order) throw new Error("確認付款後找不到深夜訂單");
    await processOrderDeliveryNow(order.id, "order_dispatch");
    await processOrderDeliveryNow(order.id, "order_financial_effects");
    return interaction.editReply({
      content: "✅ 已確認付款，並已派單，客服操作面板也已送出。",
    });
  } catch (error) {
    console.error("[新版下單] 客服確認付款或後續派單失敗", error);
    const recovered =
      paymentCommitted ||
      (await recoverIfPaymentAlreadyCompleted(orderId, [
        "order_dispatch",
        "order_financial_effects",
      ]).catch(() => false));
    if (recovered) {
      return interaction.editReply({
        content:
          "⚠️ 付款已確認，不會重複處理；派單或財務效果已保留並會自動重試。",
      });
    }
    return interaction.editReply({
      content: `❌ 確認付款失敗：${error.message || error}`,
    });
  }
}
async function handleServiceCancelOrderGroup(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const isStaff =
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.editReply({
      content: "❌ 只有客服可以取消訂單",
    });
  }

  const groupId = interaction.customId.replace(
    "service_cancel_order_group_",
    ""
  );

  const { error } = await supabase
    .from("play_orders")
    .update({
      status: "cancelled",
      updated_at: new Date().toISOString(),
    })
    .eq("order_group_id", groupId)
    .eq("guild_id", DEEPNIGHT_GUILD_ID);

  if (error) {
    console.error("[特戰分單] 取消訂單失敗", error);
    return interaction.editReply({
      content: "❌ 取消訂單失敗",
    });
  }

  return interaction.editReply({
    content: "✅ 已取消這組特戰分單",
  });
}
async function handleServiceCancelOrder(interaction) {
  await interaction.deferReply({
    flags: 64,
  });

  const isStaff =
    interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
    interaction.member.roles.cache.has(process.env.STAFF_ROLE);

  if (!isStaff) {
    return interaction.editReply({
      content: "❌ 只有客服可以取消訂單",
    });
  }

  const orderId = interaction.customId.replace("service_cancel_order_", "");

  const { error } = await supabase
    .from("play_orders")
    .update({
      status: "cancelled",
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .eq("guild_id", DEEPNIGHT_GUILD_ID);

  if (error) {
    console.error("[新版下單] 取消訂單失敗", error);
    return interaction.editReply({
      content: "❌ 取消訂單失敗",
    });
  }

  return interaction.editReply({
    content: "✅ 已取消訂單",
  });
}
async function handleDispatchInteraction(interaction) {
  if (workReportSystem && (await workReportSystem.handleInteraction(interaction))) {
    return true;
  }
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "上班") {
      await playerOnline(interaction);
      return true;
    }
    if (interaction.commandName === "下班") {
      await playerOffline(interaction);
      return true;
    }
    if (interaction.commandName === "我的狀態") {
      await playerStatus(interaction);
      return true;
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId.startsWith("new_order_selection_extend_")) {
      await handleNewOrderSelectionExtend(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_selection_cancel_")) {
      await handleNewOrderSelectionCancel(interaction);
      return true;
    }
    if (interaction.customId.startsWith("quote_payment_method_")) {
      await handleQuotePaymentMethodSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("extension_payment_method_")) {
      await handleExtensionPaymentMethodSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("topup_payment_method_")) {
      await handleTopupPaymentMethodSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_payment_method_")) {
      await handleServicePaymentMethodSelect(interaction);
      return true;
    }
    // ===== 陪玩控制 =====
    if (interaction.customId === "open_topup_modal") {
      await openTopupModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("confirm_topup_")) {
      await confirmTopup(interaction);
      return true;
    }
    if (interaction.customId === "order_start_valorant") {
      await createServiceTicket(interaction, "valorant");
      return true;
    }

    if (interaction.customId === "order_start_steam") {
      await createServiceTicket(interaction, "steam");
      return true;
    }

    if (interaction.customId === "order_start_delta") {
      await createServiceTicket(interaction, "delta");
      return true;
    }

    if (interaction.customId === "order_start_chat") {
      await createServiceTicket(interaction, "chat");
      return true;
    }

    if (interaction.customId === "order_start_emotion") {
      await createServiceTicket(interaction, "emotion");
      return true;
    }

    if (
      interaction.customId === "order_start_topup" ||
      interaction.customId.startsWith("order_start_topup_amount_")
    ) {
      await createTopupTicket(
        interaction,
        parseTopupPresetAmount(interaction.customId),
      );
      return true;
    }

    if (interaction.customId === "order_start_tip") {
      await createTipTicket(interaction);
      return true;
    }
    if (interaction.customId === "order_start_crown") {
      await createTipTicket(interaction, "crown");
      return true;
    }
    if (interaction.customId.startsWith("valorant_type_")) {
      await handleValorantTypeButton(interaction);
      return true;
    }

    if (interaction.customId.startsWith("valorant_mode_")) {
      await handleValorantModeButton(interaction);
      return true;
    }
    if (interaction.customId.startsWith("order_add_note_")) {
      await openServiceOrderNoteModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("steam_game_name_")) {
      await openSteamGameNameModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("order_finish_need_")) {
      await finishServiceNeed(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_quote_price_")) {
      await openServiceQuotePriceModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_no_coupon_")) {
      await handleServiceNoCoupon(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_use_coupon_")) {
      await handleServiceUseCoupon(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_confirm_wallet_group_")) {
      await handleServiceConfirmWalletGroup(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_confirm_monthly_group_")) {
      await handleServiceConfirmMonthlyGroup(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_confirm_wallet_")) {
      await handleServiceConfirmWallet(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_confirm_monthly_")) {
      await handleServiceConfirmMonthly(interaction);
      return true;
    }
    if (
      interaction.customId.startsWith("service_cancel_wallet_") ||
      interaction.customId.startsWith("service_cancel_monthly_")
    ) {
      await interaction.reply({
        content: "已取消此付款方式，請重新選擇付款方式或聯繫客服。",
        flags: 64,
      });
      return true;
    }
    if (interaction.customId.startsWith("service_confirm_paid_group_")) {
      await handleServiceConfirmPaidGroup(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_cancel_order_group_")) {
      await handleServiceCancelOrderGroup(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_confirm_paid_")) {
      await handleServiceConfirmPaid(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_cancel_order_")) {
      await handleServiceCancelOrder(interaction);
      return true;
    }
    if (interaction.customId === "open_play_order_form") {
      await openPlayOrderModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("change_order_price_")) {
      await openChangeOrderPriceModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("save_order_note_")) {
      await openSaveOrderNoteModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("saved_order_end_")) {
      await handleSavedOrderEnd(interaction);
      return true;
    }
    if (interaction.customId.startsWith("dispatch_assign_players_")) {
      await openDispatchPlayerMenu(interaction);
      return true;
    }
    if (interaction.customId === "player_online") {
      await playerOnline(interaction);
      return true;
    }
    if (interaction.customId === "player_offline") {
      await playerOffline(interaction);
      return true;
    }
    if (interaction.customId === "player_status") {
      await playerStatus(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_note_yes_")) {
      await openNewOrderNoteModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_back_")) {
      await handleNewOrderBack(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_note_no_")) {
      await handleNewOrderNoNote(interaction);
      return true;
    }
    if (interaction.customId.startsWith("staff_quote_price_")) {
      await openStaffQuotePriceModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("dispatch_assign_players_")) {
      await openDispatchPlayerMenu(interaction);
      return true;
    }
    if (interaction.customId.startsWith("staff_confirm_order_paid_")) {
      await handleStaffConfirmOrderPaid(interaction);
      return true;
    }
    if (interaction.customId.startsWith("salary_quote_confirm_")) {
      await handleSalaryQuoteConfirm(interaction);
      return true;
    }
    if (interaction.customId.startsWith("salary_quote_cancel_")) {
      await handleSalaryQuoteCancel(interaction);
      return true;
    }
    if (interaction.customId.startsWith("salary_service_confirm_")) {
      await handleSalaryServiceConfirm(interaction);
      return true;
    }
    if (interaction.customId.startsWith("salary_service_cancel_")) {
      await handleSalaryServiceCancel(interaction);
      return true;
    }
    if (interaction.customId.startsWith("salary_extension_confirm_")) {
      await handleSalaryExtensionConfirm(interaction);
      return true;
    }
    if (interaction.customId.startsWith("salary_extension_cancel_")) {
      await handleSalaryExtensionCancel(interaction);
      return true;
    }
    if (interaction.customId.startsWith("quote_no_coupon_")) {
      await handleQuoteNoCoupon(interaction);
      return true;
    }
    if (interaction.customId.startsWith("quote_use_coupon_")) {
      await handleQuoteUseCoupon(interaction);
      return true;
    }
    if (interaction.customId.startsWith("customer_confirm_order_")) {
      await handleCustomerConfirmOrder(interaction);
      return true;
    }
    if (interaction.customId.startsWith("customer_order_wrong_")) {
      await handleCustomerOrderWrong(interaction);
      return true;
    }
    if (interaction.customId.startsWith("staff_edit_order_")) {
      await openStaffEditOrderModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_back_")) {
      await handleNewOrderBack(interaction);
      return true;
    }
    if (interaction.customId.startsWith("extend_order_")) {
      await openExtendOrderModal(interaction);
      return true;
    }
    if (interaction.customId.startsWith("confirm_extension_wallet_")) {
      await handleConfirmExtensionWallet(interaction);
      return true;
    }
    if (interaction.customId.startsWith("cancel_extension_wallet_")) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({
          flags: 64,
        });
      }
      return interaction.editReply({
        content: "已取消加時儲值卡付款，請重新選擇付款方式或聯繫客服。",
      });
    }
    if (interaction.customId.startsWith("staff_confirm_extension_paid_")) {
      await handleStaffConfirmExtensionPaid(interaction);
      return true;
    }
    //  ==== 接單 =====
    if (interaction.customId.startsWith("accept_play_order_")) {
      await acceptPlayOrder(interaction);
      return true;
    }
  }
  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith("submit_staff_edit_order_")) {
      await submitStaffEditOrder(interaction);
      return true;
    }
    if (interaction.customId.startsWith("submit_staff_quote_price_")) {
      await submitStaffQuotePrice(interaction);
      return true;
    }
    if (interaction.customId.startsWith("submit_service_quote_price_")) {
      await submitServiceQuotePrice(interaction);
      return true;
    }
    if (interaction.customId.startsWith("submit_service_order_note_")) {
      await submitServiceOrderNote(interaction);
      return true;
    }
    if (interaction.customId.startsWith("submit_steam_game_name_")) {
      await submitSteamGameName(interaction);
      return true;
    }
    if (interaction.customId.startsWith("submit_new_order_note_")) {
      await submitNewOrderNote(interaction);
      return true;
    }
    if (interaction.customId.startsWith("submit_new_order_reserve_time_")) {
      await submitNewOrderReserveTime(interaction);
      return true;
    }
    if (interaction.customId === "submit_topup_form") {
      await submitTopupForm(interaction);
      return true;
    }
    if (interaction.customId.startsWith("submit_change_order_price_")) {
      await submitChangeOrderPrice(interaction);
      return true;
    }
    if (interaction.customId.startsWith("submit_save_order_note_")) {
      await submitSaveOrderNote(interaction);
      return true;
    }
    if (interaction.customId.startsWith("submit_extend_order_")) {
      await submitExtendOrder(interaction);
      return true;
    }
  }
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId.startsWith("game_order_select_")) {
      await handleGameOrderSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("lol_style_select_")) {
      await handleLolStyleSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("other_game_style_select_")) {
      await handleOtherGameStyleSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("quote_select_coupon_")) {
      await handleQuoteSelectCoupon(interaction);
      return true;
    }
    if (interaction.customId.startsWith("quote_payment_method_")) {
      await handleQuotePaymentMethodSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("valorant_rank_")) {
      await handleValorantRankSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("valorant_type_select_")) {
      await handleValorantTypeSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("apex_rank_")) {
      await handleApexRankSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("lol_rank_")) {
      await handleLolRankSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_player_count_")) {
      await handleServicePlayerCountSelect(interaction);
      return true;
    }

    if (interaction.customId.startsWith("service_gender_")) {
      await handleServiceGenderSelect(interaction);
      return true;
    }

    if (interaction.customId.startsWith("service_assign_")) {
      await handleServiceAssignSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_selected_players_")) {
      await handleServiceSelectedPlayersSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_duration_")) {
      await handleServiceDurationSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_rounds_")) {
      await handleServiceRoundsSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_select_coupon_")) {
      await handleServiceSelectCoupon(interaction);
      return true;
    }
    if (interaction.customId.startsWith("steam_category_")) {
      await handleSteamCategorySelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("delta_mode_")) {
      await handleDeltaModeSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("service_payment_method_")) {
      await handleServicePaymentMethodSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_game_")) {
      await handleNewOrderGameSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_item_")) {
      await handleNewOrderItemSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_rank_")) {
      await handleNewOrderRankSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_count_")) {
      await handleNewOrderCountSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_gender_")) {
      await handleNewOrderGenderSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_player_")) {
      await handleNewOrderPlayerSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("new_order_duration_")) {
      await handleNewOrderDurationSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("submit_dispatch_players_")) {
      await submitDispatchPlayers(interaction);
      return true;
    }
    if (interaction.customId.startsWith("topup_payment_method_")) {
      await handleTopupPaymentMethodSelect(interaction);
      return true;
    }
    if (interaction.customId.startsWith("extension_payment_method_")) {
      await handleExtensionPaymentMethodSelect(interaction);
      return true;
    }
  }
  return false;
}

async function sendJkopayCompletionOnce(payment, channel, payload) {
  if (!channel?.isTextBased?.()) return null;
  if (payment.completion_message_id) {
    const existingMessage = await channel.messages
      .fetch(String(payment.completion_message_id))
      .catch(() => null);
    if (existingMessage) return existingMessage;
  }
  const message = await channel.send(payload);
  const { error } = await supabase
    .from(payment.provider === "ecpay" ? "ecpay_service_payments" : "jkopay_service_payments")
    .update({
      completion_message_id: message.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", payment.id)
    .eq("organization_code", "deepnight")
    .is("completion_message_id", null);
  if (error) throw new Error(error.message || "保存街口完成通知編號失敗");
  payment.completion_message_id = message.id;
  return message;
}

async function handleJkopayServicePaid({ payment, transaction }) {
  const ecpay = payment.provider === "ecpay";
  const paymentLabel = ecpay ? "綠界" : "街口";
  const channel = payment.channel_id
    ? await client.channels.fetch(payment.channel_id).catch(() => null)
    : null;

  if (payment.payment_kind === "order") {
    const { data: paidResult, error } = await supabase.rpc(
      ecpay ? "deepnight_mark_ecpay_orders_paid" : "deepnight_mark_jkopay_orders_paid",
      {
        [ecpay ? "p_merchant_trade_no" : "p_platform_order_id"]: String(payment.platform_order_id || ""),
        p_guild_id: DEEPNIGHT_GUILD_ID,
      },
    );
    if (error || !paidResult) {
      throw new Error(error?.message || "更新街口訂單付款狀態失敗");
    }
    const paidOrders = Array.isArray(paidResult.orders)
      ? paidResult.orders
      : [];
    if (!paidOrders.length) throw new Error("街口付款對應的訂單資料不完整");
    const serviceFlow = paidResult.service_flow === true;
    for (const order of paidOrders) {
      await processOrderDeliveryNow(order.id, "order_financial_effects");
      if (serviceFlow) {
        await processOrderDeliveryNow(order.id, "order_dispatch");
      } else {
        await processOrderDeliveryNow(order.id, "customer_confirmation");
      }
    }
    if (channel?.isTextBased()) {
      await sendJkopayCompletionOnce(payment, channel, {
        embeds: [new EmbedBuilder().setColor("#57F287").setTitle(`✅ ${paymentLabel}訂單付款完成`).setDescription(
          `<@${payment.user_id}> 已完成${paymentLabel}支付 NT$${Number(payment.amount).toLocaleString("zh-TW")}。\n` +
            `${paymentLabel}訂單編號：${payment.platform_order_id}\n` +
            (serviceFlow ? "系統已自動派單。" : "請繼續確認訂單內容。"),
        ).setTimestamp()],
      });
    }
    return;
  }

  if (payment.payment_kind === "extension") {
    const { data: extension, error } = await supabase.rpc(
      ecpay ? "deepnight_mark_ecpay_extension_paid" : "deepnight_mark_jkopay_extension_paid",
      {
        [ecpay ? "p_merchant_trade_no" : "p_platform_order_id"]: String(payment.platform_order_id || ""),
        p_guild_id: DEEPNIGHT_GUILD_ID,
      },
    );
    if (error || !extension) {
      throw new Error(error?.message || "更新街口加時付款狀態失敗");
    }
    await processOrderDeliveryNow(extension.id, "extension_financial_effects", {
      payload: {
        extension_id: extension.id,
        payment_method: ecpay ? "綠界支付" : "街口支付",
        platform_order_id: payment.platform_order_id,
        trade_no: transaction.tradeNo,
      },
    });
    if (channel?.isTextBased()) {
      await sendJkopayCompletionOnce(payment, channel, {
        embeds: [new EmbedBuilder().setColor("#57F287").setTitle(`✅ 加時${paymentLabel}付款完成`).setDescription(
          `原訂單：${extension.order_no || extension.order_id}\n` +
            `闆闆：<@${extension.customer_id}>\n` +
            `加時內容：${extension.extension_text}\n` +
            `加時金額：NT$${Number(extension.amount).toLocaleString("zh-TW")}\n` +
            `${paymentLabel}訂單編號：${payment.platform_order_id}`,
        ).setTimestamp()],
      });
    }
    return;
  }
  throw new Error(`不支援的街口付款類型：${payment.payment_kind}`);
}

module.exports = {
  setup,
  handleDispatchInteraction,
  sendPlayerPanel,
  sendGameOrderPanels,
  sendTipOrderPanel,
  startNewOrderFlow,
  TOPUP_PRESET_AMOUNTS,
  parseTopupPresetAmount,
  sendDailyPlayerSummary,
  submitTopupForm,
  openTopupModal,
  openPlayOrderModal,
  openChangeOrderPriceModal,
  submitChangeOrderPrice,
  openSaveOrderNoteModal,
  submitSaveOrderNote,
  sendOrderToStaffChannel,
  openDispatchPlayerMenu,
  submitDispatchPlayers,
  handleSavedOrderEnd,
  deferReplyOnce,
  ensureStaffReportChannel: (staff) =>
    workReportSystem?.ensureStaffReportChannel(staff),
  sendWorkReportPanel: () => workReportSystem?.sendManualPanel(),
  startCrownReminderScheduler: () =>
    workReportSystem?.startCrownReminderScheduler(),
  sendTipWorkReports: (orders, payload) =>
    workReportSystem?.sendForCompletedTipOrders(orders, payload),
  getSalaryDeductionEligibility,
  createSalaryDeductionPrompt,
  handleJkopayServicePaid,
  processRecoveryJobNow: processOrderDeliveryNow,
  recoverPendingDeliveries,
  retryOrderDelivery,
};
