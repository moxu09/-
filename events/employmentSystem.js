const path = require("node:path");
const PDFDocument = require("pdfkit");
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const FLOW_TTL_MS = 24 * 60 * 60 * 1000;
const FONT_PATH = path.join(
  __dirname,
  "..",
  "assets",
  "fonts",
  "NotoSansCJKtc-Regular.otf",
);

const pendingApplications = new Map();
const processingReviews = new Set();

const GAMES = [
  { key: "valorant", label: "Valorant", template: "competitive" },
  { key: "apex", label: "Apex", template: "competitive" },
  { key: "lol", label: "LOL", template: "competitive" },
  { key: "delta", label: "三角洲", template: "delta" },
  { key: "naraka", label: "永劫無間", template: "naraka" },
  { key: "tft", label: "TFT", template: "competitive" },
  { key: "overwatch", label: "Overwatch", template: "competitive" },
  { key: "cs2", label: "CS2", template: "cs2" },
  { key: "honor_of_kings", label: "王者榮耀", template: "honor" },
  { key: "other", label: "其他項目", template: "other" },
];

const TRACK_LABELS = {
  technical: "技術",
  entertainment: "娛樂",
  other: "其他項目",
};

const PLATFORM_LABELS = {
  pc: "電腦版",
  mobile: "手機版",
};

const RULE_GROUPS = [
  [
    [
      "01｜尋找陪玩的方式",
      [
        "本店為消費型陪玩店，請勿在大廳內尋找陪玩",
        "若需找人打遊戲，請使用點單的方式進行",
        "入職後強制簽署陪玩承攬合約以使用法律保障你我雙方權益",
      ],
    ],
    [
      "02｜陪玩角色",
      [
        "部分陪玩同時是客人，可能會消費其他陪玩",
        "如果需要尋找陪玩，請透過點單的方式",
      ],
    ],
    [
      "03｜頻道使用規則",
      ["請勿在不適合聊天的頻道進行交流", "例如：派單房中聊天"],
    ],
    [
      "04｜退陪玩",
      [
        "若需退陪玩，請告知管理原因",
        "未告知理由再次申請入職將不予錄用",
      ],
    ],
    [
      "05｜接單及管控",
      [
        "若一個月內未接單或跳單未提供理由，將被踢除",
        "若臨時無法接單，請提前通知店內以便進行人員管控",
        "有特殊情況不能接單請提前請假",
        "禁止消失單，接單後禁止失聯，有特殊情況請及時告知",
      ],
    ],
  ],
  [
    [
      "06｜接單理由",
      [
        "扣單無法接單請說明無法接單的理由，如「在外無法接，晚上可接」等",
        "請勿互相推薦，推薦時應提供具體理由",
        "派單房是工作場所，請遵守規範",
        "派單房為公開頻道，請注意禮貌並只允許正向言語",
      ],
    ],
    [
      "07｜派單要求",
      ["技術／大神單需具備相應資格", "若未經考核或不符合資格，請勿直接扣1"],
    ],
    [
      "08｜冠名單處理",
      [
        "接到冠名單後，請主動到個人頻道找客服領取報單，若3日內未領取報單則視為充公",
        "冠名單還完後請立即找客服領取報單",
      ],
    ],
    [
      "09｜罰款及處罰",
      [
        "接單皆須報開始及結束時間（未報時間無報單）",
        "接單後10分鐘內未出現：罰款100元，並更換陪玩接單",
        "亂進老闆語音頻道：罰款50元",
        "派單不符合資格亂扣1：罰款80元，情節嚴重者將沒收該遊戲身份組三天",
        "接單態度差（包括但不限於不說話、施壓等）：經核實後退單，還給老闆",
        "開掛：經查證後罰款違約金5,000並終止合約",
        "私下議論管理客服可檢舉：檢舉人獎金500元＋黑名單被檢舉人",
        "接單期間跟老闆提到其他陪玩店：罰款200元",
        "接單期間多次詢問老闆私人問題讓老闆不適：禁止接單3日＋罰款200元",
        "接牌位單需優先開比老闆低牌位的號，違規：罰款80元",
        "預約單遲到：罰款250元",
        "有時間先詢問老闆優先還冠名單，勿有時間未還單去跳其他單：禁止接單3日＋罰款200元",
        "派單房點單成功後，禁止繼續傳送任何訊息：30秒內未自行刪除罰款50元",
      ],
    ],
  ],
  [
    [
      "10｜檢舉及罰款處理",
      [
        "以上情況同車陪玩可提供證據舉報",
        "管理層不會出賣檢舉人",
        "罰款三次未繳者將被踢出店鋪",
      ],
    ],
    ["11｜公告規章", ["所有公告已讀需按表情符號"]],
    ["12｜問題詢問", ["如果有問題，請找 CEO 或主管"]],
    [
      "13｜禁止",
      [
        "私接單／私下收款／私自帶客／惡意搶單／私加老闆（含 Discord）：第一次警告並扣抽成，第二次停權及通報處理",
        "禁止越界交易／引導線下交易／金錢騷擾／情緒勒索／未經同意交換現實聯絡方式",
        "禁止灰色內容／涉黃／擦邊服務／性暗示交易／其他任何違法內容（一經發現馬上報警）",
        "無論入店前後，禁止隱瞞不報身為他家店主、實際負責人、共同經營者、高階管理人員或競爭敏感職務人員",
      ],
    ],
  ],
];

const COMPETITIVE_FIELDS = [
  field("nickname", "暱稱"),
  field("gender", "性別"),
  field("referrer", "推薦人", false),
  field("employment", "全職／兼職"),
  field("peak_rank", "歷史段位"),
  field("current_rank", "現今段位"),
  field("available_time", "可接單時間"),
  field("age_16", "是否已滿16歲"),
  field("beginner_experience", "是否有帶新手經驗（有／無）"),
  field("boosting_experience", "是否有陪玩／代打經驗（有／無）"),
  field("voice", "是否能語音溝通（可以／不行）"),
  field("cooperate", "是否能配合工作室安排（可以／不行）"),
  field("cheats", "是否使用外掛／輔助程式（沒有／有）"),
  field("green_rules", "是否同意工作室純綠規範"),
];

const FORM_SCHEMAS = {
  competitive: COMPETITIVE_FIELDS,
  delta: [
    field("nickname", "暱稱"),
    field("age", "年齡"),
    field("gender", "性別"),
    field("game_id", "遊戲 ID"),
    field("main_mode", "主要模式（機密／猛攻）"),
    field("maps", "擅長地圖"),
    field("available_time", "每日平均可接單時間"),
    field("platform", "手機版／電腦版"),
    field("beginner_experience", "是否有帶新手經驗（有／無）"),
    field("boosting_experience", "是否有陪玩／代打經驗（有／無）"),
    field("voice", "是否能語音溝通（可以／不行）"),
    field("cooperate", "是否能配合工作室安排（可以／不行）"),
    field("cheats", "是否使用外掛／輔助程式（沒有／有）"),
    field("green_rules", "是否同意工作室純綠規範"),
  ],
  naraka: [
    field("nickname", "暱稱"),
    field("gender", "性別"),
    field("referrer", "推薦人", false),
    field("employment", "全職／兼職"),
    field("mode", "PVE／大逃殺"),
    field("available_time", "可接單時間"),
    field("age_16", "是否已滿16歲"),
  ],
  cs2: [
    field("nickname", "遊戲暱稱"),
    field("discord_id", "Discord ID"),
    field("gender", "性別"),
    field("referrer", "推薦人", false),
    field("employment", "全職／兼職"),
    field("faceit", "Faceit 等級", false),
    field("perfect_world", "完美世界分數", false),
    field("five_e", "5E 分數", false),
    field("historical_premier", "歷史優先匹配分數", false),
    field("premier", "優先匹配分數", false),
    field("position", "擅長位置", false),
    field("available_time", "可接單時段"),
    field("age_16", "是否已滿16歲"),
  ],
  honor: [
    field("nickname", "暱稱"),
    field("gender", "性別"),
    field("referrer", "推薦人", false),
    field("employment", "全職／兼職"),
    field("peak_rank", "歷史段位"),
    field("current_rank", "現今段位"),
    field("historical_badge", "歷史國標"),
    field("available_time", "可接單時間"),
    field("age_16", "是否已滿16歲"),
  ],
  other: [
    field("applied_item", "報考項目"),
    field("nickname", "暱稱"),
    field("discord_id", "Discord ID"),
    field("gender", "性別"),
    field("referrer", "推薦人", false),
    field("employment", "全職／兼職"),
    field("available_time", "可接單時段"),
    field("age_16", "是否已滿16歲"),
    field("sound_card", "是否有聲卡設備"),
  ],
};

function field(key, label, required = true) {
  return { key, label, required };
}

function getGame(gameKey) {
  return GAMES.find((game) => game.key === gameKey);
}

function getApplicationFields(gameKey) {
  const game = getGame(gameKey);
  return FORM_SCHEMAS[game?.template] || FORM_SCHEMAS.other;
}

function formatRuleGroup(group) {
  return group
    .map(
      ([title, rules]) =>
        `**${title}**\n${rules.map((rule) => `- ${rule}`).join("\n")}`,
    )
    .join("\n\n");
}

function buildRulesEmbeds(brandName) {
  return RULE_GROUPS.map((group, index) =>
    new EmbedBuilder()
      .setColor("#8b5cf6")
      .setTitle(
        index === 0
          ? `📋 ${brandName}｜陪玩共同守則`
          : `📋 陪玩共同守則（${index + 1}/${RULE_GROUPS.length}）`,
      )
      .setDescription(formatRuleGroup(group)),
  );
}

function buildConsentRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("employment_agree")
      .setLabel("以上已詳閱並同意")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("employment_disagree")
      .setLabel("不同意")
      .setStyle(ButtonStyle.Danger),
  );
}

function buildGameRows() {
  return [GAMES.slice(0, 5), GAMES.slice(5)].map((games) =>
    new ActionRowBuilder().addComponents(
      games.map((game) =>
        new ButtonBuilder()
          .setCustomId(`employment_game_${game.key}`)
          .setLabel(game.label)
          .setStyle(ButtonStyle.Primary),
      ),
    ),
  );
}

function buildTrackRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("employment_track_technical")
      .setLabel("技術")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("employment_track_entertainment")
      .setLabel("娛樂")
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildPlatformRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("employment_platform_pc")
      .setLabel("電腦版")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("employment_platform_mobile")
      .setLabel("手機版")
      .setStyle(ButtonStyle.Secondary),
  );
}

function createFlow(user) {
  const flow = {
    userId: user.id,
    username: user.username,
    displayName: user.globalName || user.username,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + FLOW_TTL_MS,
    consentRules: true,
    consentConflict: true,
    answers: {},
  };
  pendingApplications.set(user.id, flow);
  return flow;
}

function getFlow(userId) {
  const flow = pendingApplications.get(userId);
  if (!flow) return null;
  if (flow.expiresAt <= Date.now()) {
    pendingApplications.delete(userId);
    return null;
  }
  return flow;
}

function chunkFields(fields) {
  const pages = [];
  for (let index = 0; index < fields.length; index += 5) {
    pages.push(fields.slice(index, index + 5));
  }
  return pages;
}

function createApplicationModal(flow, pageIndex, userId) {
  const game = getGame(flow.gameKey);
  const pages = chunkFields(getApplicationFields(flow.gameKey));
  const page = pages[pageIndex];
  if (!page) return null;

  const modal = new ModalBuilder()
    .setCustomId(`employment_modal_${pageIndex}`)
    .setTitle(
      `${game?.label || "入職"}資料 ${pageIndex + 1}/${pages.length}`.slice(
        0,
        45,
      ),
    );

  modal.addComponents(
    page.map((definition) => {
      const input = new TextInputBuilder()
        .setCustomId(definition.key)
        .setLabel(definition.label.slice(0, 45))
        .setStyle(TextInputStyle.Short)
        .setRequired(definition.required)
        .setMaxLength(200)
        .setPlaceholder(
          definition.required
            ? "必填；若沒有請填「無」"
            : "非必填；若沒有可留空",
        );

      if (
        definition.key === "discord_id" &&
        !flow.answers[definition.key]
      ) {
        input.setValue(userId);
      } else if (flow.answers[definition.key]) {
        input.setValue(String(flow.answers[definition.key]).slice(0, 200));
      }

      return new ActionRowBuilder().addComponents(input);
    }),
  );

  return modal;
}

function formatTaipeiDate(date = new Date()) {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function normalizeRoleName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[｜|]/g, "")
    .replace(/[\s・．.]/g, "");
}

function getConfiguredRoleNames(config, gameKey, track) {
  const roleMap = config.examinerRoles || {};
  return (
    roleMap[`${gameKey}:${track}`] ||
    roleMap[`${gameKey}:*`] ||
    roleMap.default ||
    []
  );
}

function resolveExaminerRoles(guild, config, gameKey, track) {
  const names = getConfiguredRoleNames(config, gameKey, track);
  const roles = [];

  for (const expected of names) {
    const normalizedExpected = normalizeRoleName(expected);
    const exact = guild.roles.cache.find(
      (role) => normalizeRoleName(role.name) === normalizedExpected,
    );
    const partial =
      exact ||
      guild.roles.cache.find((role) =>
        normalizeRoleName(role.name).includes(normalizedExpected),
      );
    if (partial && !roles.some((role) => role.id === partial.id)) {
      roles.push(partial);
    }
  }

  return { names, roles };
}

function getManagementRoleIds() {
  return [
    process.env.STAFF_ROLE,
    process.env.STAFF_ROLE_ID,
    process.env.CUSTOMER_SERVICE_ROLE_ID,
    ...(process.env.STAFF_ROLE_IDS || "").split(","),
    ...(process.env.CUSTOMER_SERVICE_ROLE_IDS || "").split(","),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function canReview(interaction, examinerRoles) {
  if (
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    return true;
  }

  const memberRoles = interaction.member?.roles?.cache;
  if (!memberRoles) return false;

  const allowedIds = new Set([
    ...examinerRoles.map((role) => role.id),
    ...getManagementRoleIds(),
  ]);
  if (memberRoles.some((role) => allowedIds.has(role.id))) return true;

  return memberRoles.some((role) =>
    /(管理|主管|ceo|執行長|店長)/i.test(role.name),
  );
}

function buildApplicationEmbed(flow) {
  const game = getGame(flow.gameKey);
  const fields = [
    { name: "填寫日期", value: formatTaipeiDate(), inline: false },
    {
      name: "填寫人",
      value:
        `<@${flow.userId}>\n` +
        `帳號：${flow.displayName}（${flow.username}）\n` +
        `Discord ID：${flow.userId}`,
      inline: false,
    },
    { name: "遊戲項目", value: game?.label || flow.gameKey, inline: true },
    {
      name: "娛樂／技術",
      value: TRACK_LABELS[flow.track] || "其他項目",
      inline: true,
    },
  ];

  if (flow.platform) {
    fields.push({
      name: "遊戲平台",
      value: PLATFORM_LABELS[flow.platform] || flow.platform,
      inline: true,
    });
  }

  fields.push(
    {
      name: "是否同意陪玩共同守則",
      value: flow.consentRules ? "同意" : "不同意",
      inline: false,
    },
    {
      name: "是否同意他家店主、實際負責人、共同經營者、高階管理人員或競爭敏感職務人員恕無法應徵之規定",
      value: flow.consentConflict ? "同意" : "不同意",
      inline: false,
    },
  );

  for (const definition of getApplicationFields(flow.gameKey)) {
    fields.push({
      name: definition.label,
      value: String(flow.answers[definition.key] || "未填寫").slice(0, 1024),
      inline: false,
    });
  }

  return new EmbedBuilder()
    .setColor("#f59e0b")
    .setTitle("📝 新的陪玩入職申請")
    .addFields(fields)
    .setFooter({
      text: [
        "employment",
        flow.userId,
        flow.gameKey,
        flow.track,
        flow.platform || "none",
      ].join("|"),
    })
    .setTimestamp();
}

function getEmbedData(message) {
  const embed = message.embeds?.[0];
  if (!embed) return null;
  const data = embed.toJSON();
  const footerParts = String(data.footer?.text || "").split("|");
  if (footerParts[0] !== "employment") return null;

  return {
    embed,
    data,
    applicantId: footerParts[1],
    gameKey: footerParts[2],
    track: footerParts[3],
    platform: footerParts[4] === "none" ? null : footerParts[4],
    fields: data.fields || [],
  };
}

function safeFilename(value) {
  return String(value || "application")
    .replace(/[^\p{L}\p{N}_-]/gu, "_")
    .slice(0, 60);
}

function buildEmploymentPdfBuffer({
  brandName,
  applicantId,
  gameKey,
  track,
  platform,
  fields,
  result,
  reviewer,
  reviewedAt,
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 36, bottom: 36, left: 36, right: 36 },
      bufferPages: true,
      info: {
        Title: `${brandName}陪玩入職申請紀錄`,
        Author: brandName,
        Subject: `Discord 申請人 ${applicantId}`,
      },
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.registerFont("NotoSansTC", FONT_PATH);
    doc.font("NotoSansTC");

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const sideMargin = 36;
    const columnGap = 16;
    const columnWidth =
      (pageWidth - sideMargin * 2 - columnGap) / 2;
    const contentTop = 142;
    const resultTop = pageHeight - 104;
    const availableFieldHeight = resultTop - contentTop;

    doc
      .fontSize(17)
      .fillColor("#312e81")
      .text(`${brandName}｜陪玩入職申請紀錄`, sideMargin, 34, {
        align: "center",
        width: pageWidth - sideMargin * 2,
        lineBreak: false,
      });
    doc
      .fontSize(8.5)
      .fillColor("#6b7280")
      .text(`申請人 Discord ID：${applicantId}`, sideMargin, 63, {
        align: "center",
        width: pageWidth - sideMargin * 2,
        lineBreak: false,
      });

    const game = getGame(gameKey);
    const summary = [
      ["遊戲項目", game?.label || gameKey],
      ["娛樂／技術", TRACK_LABELS[track] || track],
      ...(platform
        ? [["遊戲平台", PLATFORM_LABELS[platform] || platform]]
        : []),
    ];
    const summaryWidth = (pageWidth - sideMargin * 2) / summary.length;
    summary.forEach(([label, value], index) => {
      const x = sideMargin + summaryWidth * index;
      doc
        .fontSize(7)
        .fillColor("#6b7280")
        .text(label, x, 88, {
          align: "center",
          width: summaryWidth,
          lineBreak: false,
        })
        .fontSize(9)
        .fillColor("#111827")
        .text(String(value || "未填寫"), x, 101, {
          align: "center",
          width: summaryWidth,
          lineBreak: false,
        });
    });

    doc
      .fontSize(11)
      .fillColor("#312e81")
      .text("申請內容", sideMargin, 122, {
        width: pageWidth - sideMargin * 2,
        lineBreak: false,
      });

    const summaryNames = new Set(["遊戲項目", "娛樂／技術", "遊戲平台"]);
    const detailFields = fields.filter(
      (entry) => !summaryNames.has(entry.name),
    );

    function measureEntry(entry, fontSize) {
      const labelSize = Math.max(4.5, fontSize - 1.2);
      const width = columnWidth - 12;
      const labelHeight = doc
        .fontSize(labelSize)
        .heightOfString(String(entry.name || "欄位"), {
          width,
          lineGap: 0,
        });
      const valueHeight = doc
        .fontSize(fontSize)
        .heightOfString(String(entry.value || "未填寫"), {
          width,
          lineGap: 0.3,
        });
      return {
        entry,
        labelHeight,
        valueHeight,
        totalHeight: labelHeight + valueHeight + 7,
      };
    }

    function findLayout(fontSize) {
      const measured = detailFields.map((entry) =>
        measureEntry(entry, fontSize),
      );
      let best = null;
      for (let split = 1; split < measured.length; split += 1) {
        const leftHeight = measured
          .slice(0, split)
          .reduce((sum, item) => sum + item.totalHeight, 0);
        const rightHeight = measured
          .slice(split)
          .reduce((sum, item) => sum + item.totalHeight, 0);
        const height = Math.max(leftHeight, rightHeight);
        if (!best || height < best.height) {
          best = { measured, split, height };
        }
      }
      return best || { measured, split: measured.length, height: 0 };
    }

    let fieldFontSize = 9;
    let layout = findLayout(fieldFontSize);
    while (layout.height > availableFieldHeight && fieldFontSize > 4.5) {
      fieldFontSize -= 0.25;
      layout = findLayout(fieldFontSize);
    }

    function drawColumn(items, x) {
      let y = contentTop;
      const labelSize = Math.max(4.5, fieldFontSize - 1.2);
      const width = columnWidth - 12;

      for (const item of items) {
        doc
          .fontSize(labelSize)
          .fillColor("#6b7280")
          .text(String(item.entry.name || "欄位"), x, y, {
            width,
            lineGap: 0,
          });
        y += item.labelHeight + 1;
        doc
          .fontSize(fieldFontSize)
          .fillColor("#111827")
          .text(String(item.entry.value || "未填寫"), x + 6, y, {
            width: width - 6,
            lineGap: 0.3,
          });
        y += item.valueHeight + 3;
        doc
          .moveTo(x, y)
          .lineTo(x + width, y)
          .lineWidth(0.35)
          .strokeColor("#e5e7eb")
          .stroke();
        y += 3;
      }
    }

    drawColumn(layout.measured.slice(0, layout.split), sideMargin);
    drawColumn(
      layout.measured.slice(layout.split),
      sideMargin + columnWidth + columnGap,
    );

    doc
      .roundedRect(
        sideMargin,
        resultTop + 4,
        pageWidth - sideMargin * 2,
        48,
        5,
      )
      .fill(result === "通過" ? "#ecfdf5" : "#fef2f2");
    doc
      .fontSize(12)
      .fillColor(result === "通過" ? "#15803d" : "#b91c1c")
      .text(`審核結果：${result}`, sideMargin + 12, resultTop + 12, {
        width: 150,
        lineBreak: false,
      });
    doc
      .fontSize(7.5)
      .fillColor("#374151")
      .text(`審核人：${reviewer}`, sideMargin + 174, resultTop + 11, {
        width: pageWidth - sideMargin * 2 - 186,
        lineBreak: false,
      })
      .text(`審核日期：${reviewedAt}`, sideMargin + 174, resultTop + 27, {
        width: pageWidth - sideMargin * 2 - 186,
        lineBreak: false,
      });

    const range = doc.bufferedPageRange();
    doc.switchToPage(range.start);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .fontSize(7)
      .fillColor("#9ca3af")
      .text(
        `${brandName} 入職申請紀錄  |  1 / 1`,
        sideMargin,
        pageHeight - 24,
        {
          align: "center",
          width: pageWidth - sideMargin * 2,
          lineBreak: false,
        },
      );
    doc.page.margins.bottom = bottomMargin;

    doc.end();
  });
}

function disabledComponents(message) {
  return message.components.map((row) => ({
    ...row.toJSON(),
    components: row.components.map((component) => ({
      ...component.toJSON(),
      disabled: true,
    })),
  }));
}

function createEmploymentSystem(client, config) {
  async function sendPanel() {
    const channel = await client.channels.fetch(config.panelChannelId);
    if (!channel?.isTextBased() || typeof channel.send !== "function") {
      throw new Error(`入職表單頻道不可用：${config.panelChannelId}`);
    }

    const embed = new EmbedBuilder()
      .setColor("#8b5cf6")
      .setTitle(`🪪 ${config.brandName}｜陪玩入職申請`)
      .setDescription(
        "歡迎申請加入陪玩團隊。\n\n" +
          "請先閱讀完整陪玩共同守則；同意後選擇考取遊戲與類型，再依畫面完成所有資料。",
      )
      .setFooter({ text: "送出前請再次確認資料正確" });
    const components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("employment_start")
          .setLabel("申請入職")
          .setStyle(ButtonStyle.Success),
      ),
    ];

    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    const existing = recent?.find(
      (message) =>
        message.author.id === client.user.id &&
        message.embeds?.[0]?.title === `🪪 ${config.brandName}｜陪玩入職申請`,
    );

    if (existing) {
      await existing.edit({ embeds: [embed], components });
      return existing;
    }
    return await channel.send({ embeds: [embed], components });
  }

  async function replyExpired(interaction) {
    const payload = {
      content: "❌ 這份入職表單已過期，請回到申請頻道重新開始。",
      embeds: [],
      components: [],
    };
    if (interaction.isModalSubmit()) {
      return await interaction.reply({ ...payload, flags: 64 });
    }
    return await interaction.update(payload);
  }

  async function submitApplication(interaction, flow) {
    await interaction.deferReply({ flags: 64 });
    const reviewChannel = await client.channels.fetch(config.reviewChannelId);
    if (!reviewChannel?.isTextBased() || typeof reviewChannel.send !== "function") {
      throw new Error(`入職審核頻道不可用：${config.reviewChannelId}`);
    }

    await interaction.guild.roles.fetch().catch(() => null);
    const { names, roles } = resolveExaminerRoles(
      interaction.guild,
      config,
      flow.gameKey,
      flow.track,
    );
    const mentions = roles.map((role) => `<@&${role.id}>`);
    const examinerNotice =
      roles.length > 0
        ? `${mentions.join(" ")} 請協助審核上方的陪玩入職申請。`
        : `⚠️ 找不到審核身分組：${names.join("、") || "未設定"}`;
    const reviewRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("employment_review_approve")
        .setLabel("審核通過")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("employment_review_reject")
        .setLabel("婉拒申請")
        .setStyle(ButtonStyle.Danger),
    );

    const applicantName =
      interaction.member?.displayName ||
      interaction.user.globalName ||
      interaction.user.username;
    const threadStarter = await reviewChannel.send({
      content: `<@${interaction.user.id}> 已提交陪玩入職申請。`,
      allowedMentions: { users: [interaction.user.id] },
    });
    let reviewThread;
    try {
      reviewThread = await threadStarter.startThread({
        name: `入職申請｜${applicantName}`.slice(0, 100),
        autoArchiveDuration: 1440,
        reason: `${config.brandName} 陪玩入職申請`,
      });
    } catch (error) {
      await threadStarter.delete().catch(() => null);
      throw new Error(`無法建立入職申請討論串：${error.message}`);
    }

    const reviewMessage = await reviewThread.send({
      embeds: [buildApplicationEmbed(flow)],
      components: [reviewRow],
    });
    await reviewThread.send({
      content: examinerNotice,
      allowedMentions: { roles: roles.map((role) => role.id) },
    });

    pendingApplications.delete(interaction.user.id);
    await interaction.editReply({
      content: `✅ 入職申請已送出：${reviewMessage.url}`,
      components: [],
    });
  }

  async function handleFormModal(interaction, pageIndex) {
    const flow = getFlow(interaction.user.id);
    if (!flow) return await replyExpired(interaction);

    const pages = chunkFields(getApplicationFields(flow.gameKey));
    const page = pages[pageIndex];
    if (!page) return await replyExpired(interaction);

    for (const definition of page) {
      flow.answers[definition.key] = interaction.fields
        .getTextInputValue(definition.key)
        .trim();
    }

    if (pageIndex + 1 < pages.length) {
      return await interaction.reply({
        content: `✅ 已儲存第 ${pageIndex + 1}/${pages.length} 頁，請繼續填寫。`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`employment_form_page_${pageIndex + 1}`)
              .setLabel("繼續填寫")
              .setStyle(ButtonStyle.Primary),
          ),
        ],
        flags: 64,
      });
    }

    return await submitApplication(interaction, flow);
  }

  async function handleReview(interaction, result) {
    const reviewKey = interaction.message.id;
    if (processingReviews.has(reviewKey)) {
      await interaction.reply({
        content: "⏳ 這份申請正在處理中，請稍候。",
        flags: 64,
      });
      return;
    }

    const record = getEmbedData(interaction.message);
    if (!record) {
      await interaction.reply({
        content: "❌ 無法讀取這份申請資料。",
        flags: 64,
      });
      return;
    }

    await interaction.guild.roles.fetch().catch(() => null);
    const { roles } = resolveExaminerRoles(
      interaction.guild,
      config,
      record.gameKey,
      record.track,
    );
    if (!canReview(interaction, roles)) {
      await interaction.reply({
        content: "❌ 只有對應審核官或管理人員可以操作。",
        flags: 64,
      });
      return;
    }

    processingReviews.add(reviewKey);
    await interaction.deferReply({ flags: 64 });
    try {
      const archiveChannel = await client.channels.fetch(config.archiveChannelId);
      if (
        !archiveChannel?.isTextBased() ||
        typeof archiveChannel.send !== "function"
      ) {
        throw new Error(`入職存檔頻道不可用：${config.archiveChannelId}`);
      }

      const reviewedAt = formatTaipeiDate();
      const reviewer =
        interaction.member?.displayName || interaction.user.username;
      const pdfBuffer = await buildEmploymentPdfBuffer({
        brandName: config.brandName,
        applicantId: record.applicantId,
        gameKey: record.gameKey,
        track: record.track,
        platform: record.platform,
        fields: record.fields,
        result,
        reviewer: `${reviewer}（${interaction.user.id}）`,
        reviewedAt,
      });
      const game = getGame(record.gameKey);
      const filename =
        safeFilename(
          `${config.brandName}_${game?.label || record.gameKey}_${record.applicantId}_${Date.now()}`,
        ) + ".pdf";

      const pdfMessage = await archiveChannel.send({
        files: [new AttachmentBuilder(pdfBuffer, { name: filename })],
      });
      await pdfMessage.reply({
        content: `<@${record.applicantId}> 審核${result}`,
        allowedMentions: { users: [record.applicantId] },
      });

      const updatedEmbed = EmbedBuilder.from(record.embed)
        .setColor(result === "通過" ? "#16a34a" : "#dc2626")
        .addFields({
          name: "審核結果",
          value:
            `**${result}**\n` +
            `審核人：<@${interaction.user.id}>\n` +
            `審核日期：${reviewedAt}`,
          inline: false,
        });
      await interaction.message.edit({
        embeds: [updatedEmbed],
        components: disabledComponents(interaction.message),
      });

      const applicant = await client.users.fetch(record.applicantId);
      let dmDelivered = true;
      try {
        if (result === "通過") {
          await applicant.send(
            `恭喜成功入職${config.brandName}\n\n` +
              `以下為工作群連結：${config.workGuildInvite}\n\n` +
              `新人入職必看頻道：<#${config.newcomerChannelId}>`,
          );
        } else {
          await applicant.send(
            "經綜合考量，您的資料尚不符合我方所需之職位\n" +
              "對於以上結果深感遺憾\n" +
              "期待您下次申請，謝謝您",
          );
        }
      } catch (error) {
        dmDelivered = false;
        console.error("[入職審核] 私訊申請人失敗", error);
      }

      await interaction.editReply({
        content:
          `✅ 已完成審核並將 PDF 存入 <#${config.archiveChannelId}>。` +
          (dmDelivered ? "申請人已收到私訊。" : "⚠️ 申請人關閉私訊，未能送達通知。"),
      });
    } finally {
      processingReviews.delete(reviewKey);
    }
  }

  async function handleInteraction(interaction) {
    const customId = interaction.customId || "";
    if (!customId.startsWith("employment_")) return false;

    try {
      if (customId === "employment_start") {
        createFlow(interaction.user);
        await interaction.reply({
          content:
            "**是否同意陪玩共同守則？**\n" +
            "**是否同意他家店主、實際負責人、共同經營者、高階管理人員或競爭敏感職務人員恕無法應徵之規定？**",
          embeds: buildRulesEmbeds(config.brandName),
          components: [buildConsentRow()],
          flags: 64,
        });
        return true;
      }

      if (customId === "employment_disagree") {
        pendingApplications.delete(interaction.user.id);
        await interaction.update({
          content: "謝謝您抽空填寫。",
          embeds: [],
          components: [],
        });
        return true;
      }

      if (customId === "employment_agree") {
        const flow = getFlow(interaction.user.id);
        if (!flow) {
          await replyExpired(interaction);
          return true;
        }
        await interaction.update({
          content: "**下一步：請問考取之遊戲**",
          embeds: [],
          components: buildGameRows(),
        });
        return true;
      }

      if (customId.startsWith("employment_game_")) {
        const flow = getFlow(interaction.user.id);
        if (!flow) {
          await replyExpired(interaction);
          return true;
        }
        const gameKey = customId.slice("employment_game_".length);
        const game = getGame(gameKey);
        if (!game) {
          await replyExpired(interaction);
          return true;
        }
        flow.gameKey = gameKey;
        if (gameKey === "other") {
          flow.track = "other";
          await interaction.update({
            content: `已選擇：**${game.label}**\n請開始填寫入職資料。`,
            embeds: [],
            components: [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId("employment_form_page_0")
                  .setLabel("填寫入職資料")
                  .setStyle(ButtonStyle.Success),
              ),
            ],
          });
          return true;
        }

        await interaction.update({
          content: `已選擇：**${game.label}**\n**下一步：請選擇考取類型**`,
          embeds: [],
          components: [buildTrackRow()],
        });
        return true;
      }

      if (customId.startsWith("employment_track_")) {
        const flow = getFlow(interaction.user.id);
        if (!flow) {
          await replyExpired(interaction);
          return true;
        }
        flow.track = customId.slice("employment_track_".length);
        if (flow.gameKey === "delta") {
          await interaction.update({
            content:
              `已選擇：**${getGame(flow.gameKey)?.label}｜${TRACK_LABELS[flow.track]}**\n` +
              "**下一步：請選擇遊戲平台**",
            embeds: [],
            components: [buildPlatformRow()],
          });
          return true;
        }

        const modal = createApplicationModal(flow, 0, interaction.user.id);
        await interaction.showModal(modal);
        return true;
      }

      if (customId.startsWith("employment_platform_")) {
        const flow = getFlow(interaction.user.id);
        if (!flow) {
          await replyExpired(interaction);
          return true;
        }
        flow.platform = customId.slice("employment_platform_".length);
        flow.answers.platform = PLATFORM_LABELS[flow.platform] || flow.platform;
        const modal = createApplicationModal(flow, 0, interaction.user.id);
        await interaction.showModal(modal);
        return true;
      }

      if (customId.startsWith("employment_form_page_")) {
        const flow = getFlow(interaction.user.id);
        if (!flow) {
          await replyExpired(interaction);
          return true;
        }
        const pageIndex = Number(
          customId.slice("employment_form_page_".length),
        );
        const modal = createApplicationModal(
          flow,
          pageIndex,
          interaction.user.id,
        );
        if (!modal) {
          await replyExpired(interaction);
          return true;
        }
        await interaction.showModal(modal);
        return true;
      }

      if (customId.startsWith("employment_modal_")) {
        const pageIndex = Number(customId.slice("employment_modal_".length));
        await handleFormModal(interaction, pageIndex);
        return true;
      }

      if (customId === "employment_review_approve") {
        await handleReview(interaction, "通過");
        return true;
      }

      if (customId === "employment_review_reject") {
        await handleReview(interaction, "不通過");
        return true;
      }
    } catch (error) {
      console.error("[入職申請系統]", error);
      const payload = {
        content: `❌ 入職申請處理失敗：${error.message || "未知錯誤"}`,
        components: [],
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => null);
      } else {
        await interaction.reply({ ...payload, flags: 64 }).catch(() => null);
      }
      return true;
    }

    return false;
  }

  return {
    handleInteraction,
    sendPanel,
  };
}

module.exports = {
  GAMES,
  buildApplicationEmbed,
  buildEmploymentPdfBuffer,
  buildRulesEmbeds,
  createEmploymentSystem,
  getApplicationFields,
  normalizeRoleName,
};
