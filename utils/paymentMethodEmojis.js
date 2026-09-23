const path = require("node:path");
const { isEcpayAtmAvailable } = require("./ecpayAtmSchedule");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const PAYMENT_BUTTON_MARKER = "__pm_";
const PAYMENT_METHOD_CODES = Object.freeze({
  // 舊代碼必須永久保留，否則部署前已送出的付款按鈕會失效。
  "街口掃碼（可刷卡）": "jks",
  街口支付: "jko",
  綠界支付: "ecp",
  匯款: "bank",
  匯款轉帳: "bank_transfer",
  匯款帳號: "bank_account",
  無卡: "atm",
  中信無卡: "ctbc_atm",
  儲值卡: "asd",
  錢包扣款: "wallet",
  月結: "month",
  月結付款: "monthly",
  扣薪: "salary",
  員工扣薪: "staff_salary",
  美金轉帳: "usd",
  加密貨幣: "crypto",
  虛擬貨幣: "virtual",
});
const PAYMENT_METHOD_BY_CODE = Object.freeze(Object.fromEntries(
  Object.entries(PAYMENT_METHOD_CODES).map(([method, code]) => [code, method]),
));

const PAYMENT_EMOJI_DEFINITIONS = Object.freeze([
  // 新版只使用品牌 Logo。保留舊 pay_jkopay 應用程式表情，避免既有訂單訊息失效。
  { key: "jkopay", name: "pay_jkopay_logo", file: "jkopay.png", fallback: "📱", matches: ["街口"] },
  { key: "ecpay", name: null, file: null, fallback: "💳", matches: ["綠界"] },
  { key: "bank_transfer", name: "pay_bank_transfer_v2", file: "bank-transfer.png", fallback: "🏦", matches: ["匯款", "轉帳"] },
  { key: "crypto", name: "pay_crypto_v2", file: "crypto.png", fallback: "🪙", matches: ["加密貨幣"] },
  { key: "monthly", name: "pay_monthly_v2", file: "monthly.png", fallback: "🌙", matches: ["月結"] },
  { key: "cardless", name: "pay_cardless_v2", file: "cardless.png", fallback: "🏧", matches: ["無卡"] },
  { key: "usd_transfer", name: "pay_usd_transfer_v2", file: "usd-transfer.png", fallback: "💵", matches: ["美金"] },
  { key: "asd_wallet", name: "pay_asd_wallet_v2", file: "asd-wallet.png", fallback: "💳", matches: ["ASD", "儲值卡", "錢包", "餘額"] },
  { key: "salary", name: null, file: null, fallback: "🧾", matches: ["扣薪"] },
]);

const uploadedEmojis = new Map();

function getCanonicalPaymentOptions({
  includeWallet = false,
  includeEcpay = false,
  includeMonthly = false,
  includeSalary = false,
  includeUsd = true,
  includeCrypto = true,
} = {}) {
  return [
    {
      label: "街口支付",
      description: "線上付款連結與街口掃碼整合於同一選項",
      value: "街口支付",
    },
    ...(includeEcpay ? [{
      label: "綠界支付",
      description: isEcpayAtmAvailable() ? "可選適用的信用卡、ATM 或超商付款，成功後自動核帳" : "可選站內刷卡或超商付款，成功後自動核帳",
      value: "綠界支付",
    }] : []),
    {
      label: includeEcpay && isEcpayAtmAvailable() ? "匯款／ATM 虛擬帳號" : "匯款帳號",
      description: includeEcpay && isEcpayAtmAvailable() ? "綠界專屬虛擬帳號，繳費後自動核帳" : "顯示銀行帳號，付款後上傳截圖",
      value: "匯款",
    },
    {
      label: "中信無卡",
      description: "顯示無卡帳號，付款後上傳截圖",
      value: "無卡",
    },
    ...(includeWallet
      ? [{
          label: "錢包扣款",
          description: "確認後直接由 ASD 餘額扣款",
          value: "儲值卡",
        }]
      : []),
    ...(includeCrypto
      ? [{
          label: "加密貨幣",
          description: "請等待客服提供錢包地址",
          value: "加密貨幣",
        }]
      : []),
    ...(includeUsd
      ? [{
          label: "美金轉帳",
          description: "請等待客服提供帳號",
          value: "美金轉帳",
        }]
      : []),
    ...(includeSalary
      ? [{
          label: "員工扣薪",
          description: "由抽成後薪資扣除，每人最多預支 NT$1,000",
          value: "扣薪",
        }]
      : []),
    ...(includeMonthly
      ? [{
          label: "月結付款",
          description: "確認後直接扣除月結額度",
          value: "月結",
        }]
      : []),
  ];
}

function findDefinition(value) {
  const text = String(value || "");
  return PAYMENT_EMOJI_DEFINITIONS.find((definition) =>
    definition.matches.some((match) => text.includes(match)),
  );
}

function getPaymentMethodEmoji(value) {
  const definition = findDefinition(value);
  if (!definition) return null;
  return uploadedEmojis.get(definition.key) || definition.fallback;
}

function withPaymentMethodEmojis(options = []) {
  return options.map((option) => {
    if (option.emoji) return option;
    const emoji = getPaymentMethodEmoji(`${option.label || ""} ${option.value || ""}`);
    return emoji ? { ...option, emoji } : option;
  });
}

function getPaymentButtonStyle(rowIndex = 0) {
  if (rowIndex === 1) return ButtonStyle.Success;
  if (rowIndex === 2) return ButtonStyle.Primary;
  return ButtonStyle.Danger;
}

function getPaymentMethodDisplayName(method) {
  const value = String(method || "").trim();
  if (value.includes("街口")) return "街口支付";
  if (value.includes("扣薪")) return "員工扣薪";
  if (value.includes("月結")) return "月結付款";
  if (value.includes("儲值卡") || value.includes("錢包") || value.includes("餘額")) return "錢包扣款";
  if (value.includes("無卡")) return "中信無卡";
  if (value.includes("匯款") || value.includes("轉帳")) return value.includes("美金") ? "美金轉帳" : "匯款帳號";
  if (value.includes("虛擬貨幣") || value.includes("加密貨幣")) return "加密貨幣";
  return value;
}

function buildPaymentMethodButtonRows(baseCustomId, options = []) {
  const buttons = withPaymentMethodEmojis(options).map((option, index) => {
    const method = String(option.value || "");
    const code = PAYMENT_METHOD_CODES[method];
    if (!code) throw new Error(`未設定付款方式按鈕代碼：${method}`);
    const button = new ButtonBuilder()
      .setCustomId(`${baseCustomId}${PAYMENT_BUTTON_MARKER}${code}`)
      .setLabel(String(option.label || method))
      .setStyle(getPaymentButtonStyle(Math.floor(index / 2)));
    if (option.emoji) button.setEmoji(option.emoji);
    return button;
  });
  const rows = [];
  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(index, index + 2)));
  }
  return rows;
}

function getPaymentMethodSelection(interaction, prefix) {
  const customId = String(interaction?.customId || "");
  if (!customId.startsWith(prefix)) return null;
  const remainder = customId.slice(prefix.length);
  if (Array.isArray(interaction?.values) && interaction.values[0]) {
    const selected = interaction.values[0];
    const useAtm = selected === "匯款" && process.env.ECPAY_ACCEPT_PAYMENTS === "true" && isEcpayAtmAvailable();
    return { entityId: remainder, paymentMethod: useAtm ? "綠界支付" : selected,
      ...(useAtm ? { requestedMethod: "ATM" } : {}) };
  }
  const markerIndex = remainder.lastIndexOf(PAYMENT_BUTTON_MARKER);
  if (markerIndex < 0) return null;
  const code = remainder.slice(markerIndex + PAYMENT_BUTTON_MARKER.length);
  const paymentMethod = PAYMENT_METHOD_BY_CODE[code];
  if (!paymentMethod) return null;
  return { entityId: remainder.slice(0, markerIndex), paymentMethod: paymentMethod === "匯款" && process.env.ECPAY_ACCEPT_PAYMENTS === "true" && isEcpayAtmAvailable() ? "綠界支付" : paymentMethod,
    ...(paymentMethod === "匯款" && process.env.ECPAY_ACCEPT_PAYMENTS === "true" && isEcpayAtmAvailable() ? { requestedMethod: "ATM" } : {}) };
}

async function ensurePaymentMethodEmojis(client) {
  const manager = client?.application?.emojis;
  if (!manager) return { uploaded: 0, reused: 0, failed: 0, fallbackOnly: true };

  let current;
  try {
    current = await manager.fetch();
  } catch (error) {
    console.warn("[付款圖示] 無法讀取應用程式表情，改用內建圖示", error.message);
    return { uploaded: 0, reused: 0, failed: 0, fallbackOnly: true };
  }

  const summary = { uploaded: 0, reused: 0, failed: 0, fallbackOnly: false };
  for (const definition of PAYMENT_EMOJI_DEFINITIONS.filter((item) => item.file)) {
    let emoji = current.find((item) => item.name === definition.name);
    if (emoji) {
      summary.reused += 1;
    } else {
      try {
        emoji = await manager.create({
          attachment: path.join(__dirname, "..", "assets", "payment-method-icons", definition.file),
          name: definition.name,
        });
        summary.uploaded += 1;
      } catch (error) {
        summary.failed += 1;
        console.warn(`[付款圖示] ${definition.name} 上傳失敗，改用內建圖示`, error.message);
        continue;
      }
    }
    uploadedEmojis.set(definition.key, { id: emoji.id, name: emoji.name, animated: Boolean(emoji.animated) });
  }
  return summary;
}

module.exports = {
  PAYMENT_EMOJI_DEFINITIONS,
  ensurePaymentMethodEmojis,
  buildPaymentMethodButtonRows,
  getCanonicalPaymentOptions,
  getPaymentMethodDisplayName,
  getPaymentMethodSelection,
  getPaymentMethodEmoji,
  withPaymentMethodEmojis,
};
