function tokenize(input) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(input))) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

const COMMAND_CATEGORIES = [
  {
    title: "查詢與錢包",
    commands: [
      "指令",
      "ping",
      "我的排名",
      "餘額",
      "隱藏餘額",
      "交易紀錄",
      "會籍查詢",
      "查詢累積",
      "我的商品",
    ],
  },
  {
    title: "金流",
    commands: ["發錢", "扣錢", "發紅包"],
  },
  {
    title: "訂單與客服",
    commands: ["加時", "滿意度調查", "批量刪除頻道"],
  },
  {
    title: "優惠券與身分組",
    commands: ["發送優惠券", "使用優惠券", "給與身份組"],
  },
  {
    title: "VIP 累積",
    commands: ["調整累積消費", "調整累積儲值"],
  },
  {
    title: "月結",
    commands: ["設定月結", "月結餘額扣款", "標記月結已繳", "保證金抵扣"],
  },
  {
    title: "商店與扭蛋",
    commands: [
      "新增商品",
      "刪除商品",
      "新增卡池",
      "刪除扭蛋",
      "新增獎勵",
      "刪除獎勵",
      "扭蛋列表",
      "單抽",
      "十抽",
    ],
  },
];

function getCommandOrder(name) {
  for (
    let categoryIndex = 0;
    categoryIndex < COMMAND_CATEGORIES.length;
    categoryIndex += 1
  ) {
    const commandIndex =
      COMMAND_CATEGORIES[categoryIndex].commands.indexOf(name);
    if (commandIndex >= 0) return categoryIndex * 100 + commandIndex;
  }
  return 9999;
}

function sortCommandDefinitions(commands) {
  return [...commands].sort(
    (left, right) =>
      getCommandOrder(left.name) - getCommandOrder(right.name) ||
      left.name.localeCompare(right.name, "zh-TW"),
  );
}

function buildCommandHelp(commands) {
  const available = new Set(commands.map((command) => command.name));
  const sections = COMMAND_CATEGORIES.map((category) => {
    const names = category.commands.filter((name) => available.has(name));
    return names.length
      ? `【${category.title}】\n${names.map((name) => `!${name}`).join("　")}`
      : null;
  }).filter(Boolean);
  return `📚 指令分類\n\n${sections.join("\n\n")}\n\n含空格的參數請使用引號，例如：!新增商品 "商品名稱" 100 "商品介紹" 一般商品`;
}

function stripId(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

function findMember(message, value) {
  const id = stripId(value);
  if (id) {
    return message.guild?.members.cache.get(id) || null;
  }
  const text = String(value || "").toLowerCase();
  return (
    message.guild?.members.cache.find(
      (member) =>
        member.displayName.toLowerCase() === text ||
        member.user.username.toLowerCase() === text,
    ) || null
  );
}

function findChannel(message, value) {
  const id = stripId(value);
  if (id) return message.guild?.channels.cache.get(id) || null;
  const text = String(value || "").toLowerCase();
  return (
    message.guild?.channels.cache.find(
      (channel) => channel.name?.toLowerCase() === text,
    ) || null
  );
}

function findRole(message, value) {
  const id = stripId(value);
  if (id) return message.guild?.roles.cache.get(id) || null;
  const text = String(value || "").toLowerCase();
  return (
    message.guild?.roles.cache.find(
      (role) => role.name.toLowerCase() === text,
    ) || null
  );
}

function normalizeChoice(option, value) {
  const choice = option.choices?.find(
    (item) =>
      String(item.name).toLowerCase() === String(value).toLowerCase() ||
      String(item.value).toLowerCase() === String(value).toLowerCase(),
  );
  return choice ? choice.value : value;
}

function convertValue(message, option, rawValue) {
  if (rawValue == null) return null;
  const value = normalizeChoice(option, rawValue);
  if (option.type === 4) {
    const number = Number(value);
    return Number.isInteger(number) ? number : null;
  }
  if (option.type === 10) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  if (option.type === 5) {
    if (["true", "是", "開", "on", "1"].includes(String(value).toLowerCase()))
      return true;
    if (["false", "否", "關", "off", "0"].includes(String(value).toLowerCase()))
      return false;
    return null;
  }
  if (option.type === 6) return findMember(message, value)?.user || null;
  if (option.type === 7) return findChannel(message, value);
  if (option.type === 8) return findRole(message, value);
  return String(value);
}

function buildUsage(definition) {
  const options = (definition.options || []).map((option) => {
    const text = `${option.name}${option.required ? "" : "?"}`;
    return option.type === 3 ? `"${text}"` : `<${text}>`;
  });
  return `!${definition.name}${options.length ? ` ${options.join(" ")}` : ""}`;
}

function parseOptions(message, definition, rawInput) {
  const tokens = tokenize(rawInput);
  const named = new Map();
  const positional = [];
  for (const token of tokens) {
    const match = token.match(/^([^=：:]+)[=：:](.*)$/);
    if (match) named.set(match[1].toLowerCase(), match[2]);
    else positional.push(token);
  }

  const values = new Map();
  let position = 0;
  const options = definition.options || [];
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    let rawValue = named.get(option.name.toLowerCase());
    if (rawValue == null && position < positional.length) {
      rawValue = positional[position];
      position += 1;
    }
    const value = convertValue(message, option, rawValue);
    if (option.required && value == null) {
      return {
        error: `缺少或無法辨識必要參數「${option.name}」\n用法：${buildUsage(definition)}`,
      };
    }
    values.set(option.name, value);
  }
  return { values };
}

function sanitizePayload(payload) {
  if (typeof payload === "string") return { content: payload };
  const next = { ...(payload || {}) };
  delete next.ephemeral;
  delete next.flags;
  return next;
}

function createMessageInteraction(message, commandName, values) {
  let replyMessage = null;
  const getValue = (name) => values.get(name) ?? null;
  const interaction = {
    commandName,
    user: message.author,
    member: message.member,
    guild: message.guild,
    guildId: message.guildId,
    channel: message.channel,
    channelId: message.channelId,
    client: message.client,
    createdTimestamp: message.createdTimestamp,
    isPrefixCommand: true,
    deferred: false,
    replied: false,
    options: {
      get: (name) => {
        const value = getValue(name);
        return value == null ? null : { name, value };
      },
      getString: getValue,
      getInteger: getValue,
      getNumber: getValue,
      getBoolean: getValue,
      getUser: getValue,
      getChannel: getValue,
      getRole: getValue,
      getMember: (name) => {
        const user = getValue(name);
        return user ? message.guild?.members.cache.get(user.id) || null : null;
      },
      getSubcommand: () => null,
      getSubcommandGroup: () => null,
    },
    isChatInputCommand: () => true,
    isRepliable: () => true,
    isAutocomplete: () => false,
    async deferReply() {
      interaction.deferred = true;
    },
    async reply(payload) {
      replyMessage = await message.reply(sanitizePayload(payload));
      interaction.replied = true;
      return replyMessage;
    },
    async editReply(payload) {
      const clean = sanitizePayload(payload);
      if (replyMessage) return replyMessage.edit(clean);
      replyMessage = await message.reply(clean);
      interaction.replied = true;
      return replyMessage;
    },
    async followUp(payload) {
      return message.reply(sanitizePayload(payload));
    },
    async fetchReply() {
      return replyMessage;
    },
    async deleteReply() {
      if (replyMessage) await replyMessage.delete().catch(() => {});
    },
  };
  return interaction;
}

function createPrefixCommandHandler({
  commands,
  dispatchSystem,
  handleSlashCommand,
  handleSlashExtendOrder,
}) {
  const definitions = new Map(
    commands.map((command) => {
      const definition =
        typeof command.toJSON === "function" ? command.toJSON() : command;
      return [definition.name.toLowerCase(), definition];
    }),
  );

  return async function handlePrefixCommand(message) {
    if (!message.content.startsWith("!") || message.content.startsWith("!!"))
      return false;
    const matched = message.content
      .slice(1)
      .trim()
      .match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (!matched) return false;
    const commandName = matched[1];
    const definition = definitions.get(commandName.toLowerCase());
    if (!definition) return false;

    const parsed = parseOptions(message, definition, matched[2] || "");
    if (parsed.error) {
      await message.reply(`❌ ${parsed.error}`);
      return true;
    }
    const interaction = createMessageInteraction(
      message,
      definition.name,
      parsed.values,
    );
    try {
      const handled =
        await dispatchSystem.handleDispatchInteraction(interaction);
      if (handled) return true;
      if (definition.name === "加時") {
        await handleSlashExtendOrder(interaction);
      } else {
        await handleSlashCommand(interaction);
      }
    } catch (error) {
      console.error(`[前綴指令錯誤] !${definition.name}`, error);
      await interaction
        .editReply({
          content: `❌ 指令執行失敗：${error.message || "未知錯誤"}`,
        })
        .catch(() => {});
    }
    return true;
  };
}

module.exports = {
  buildCommandHelp,
  createPrefixCommandHandler,
  sortCommandDefinitions,
};
