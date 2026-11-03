const path = require("node:path");
const { isEcpayAtmAvailable } = require("./ecpayAtmSchedule");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const PAYMENT_BUTTON_MARKER = "__pm_";
const PAYMENT_METHOD_CODES = Object.freeze({
  // 舊代碼必須永久保留，否則部署前已送出的付款按鈕會失效。
  "街口掃碼（可刷卡）": "jks",
  街口支付: "jko",
  綠界支付: "ecp",
  線上刷卡: "ecp_card",
  超商代碼: "ecp_cvs",
  超商條碼: "ecp_barcode",
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
  { key: "ecpay", name: null, file: null, fallback: "💳", matches: ["綠界", "線上刷卡"] },
  { key: "cvs_code", name: null, file: null, fallback: "🧾", matches: ["超商代碼"] },
  { key: "cvs_barcode", name: null, file: null, fallback: "🏪", matches: ["超商條碼"] },
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
  manualOrder = false,
} = {}) {
  return [
    {
      label: "街口支付",
      description: "線上付款連結與街口掃碼整合於同一選項",
      value: "街口支付",
    },
    ...(includeEcpay ? [{
      label: "線上刷卡",
      description: "在官網站內輸入卡號，付款成功後自動核帳",
      value: "線上刷卡",
    }] : []),
    {
      label: !manualOrder && includeEcpay && isEcpayAtmAvailable() ? "匯款／ATM 虛擬帳號" : "匯款帳號",
      description: !manualOrder && includeEcpay && isEcpayAtmAvailable() ? "綠界專屬虛擬帳號，繳費後自動核帳" : "顯示銀行帳號，付款後上傳截圖",
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

function getGeneralOrderPaymentOptions({ ecpayAvailable = false, salaryEligible = false, amount = null } = {}) {
  const cardAvailable = ecpayAvailable && (amount == null || isGeneralEcpayAmountAllowed("CARD", amount));
  const cvsAvailable = ecpayAvailable && (amount == null || isGeneralEcpayAmountAllowed("CVS", amount));
  const barcodeAvailable = ecpayAvailable && (amount == null || isGeneralEcpayAmountAllowed("BARCODE", amount));
  return [
    { label: "街口支付", value: "街口支付", style: ButtonStyle.Danger },
    { label: "線上刷卡", value: "線上刷卡", style: ButtonStyle.Danger, disabled: !cardAvailable },
    { label: "轉帳匯款", value: "匯款", style: ButtonStyle.Success },
    { label: "中信無卡", value: "無卡", style: ButtonStyle.Success },
    { label: "錢包扣款", value: "儲值卡", style: ButtonStyle.Primary },
    { label: "加密貨幣", value: "加密貨幣", style: ButtonStyle.Primary },
    { label: "超商代碼", value: "超商代碼", style: ButtonStyle.Danger, disabled: !cvsAvailable },
    { label: "超商條碼", value: "超商條碼", style: ButtonStyle.Danger, disabled: !barcodeAvailable },
    { label: "美金轉帳", value: "美金轉帳", style: ButtonStyle.Success },
    ...(salaryEligible ? [{ label: "員工扣薪", value: "扣薪", style: ButtonStyle.Success }] : []),
  ];
}

function isGeneralEcpayAmountAllowed(method, amount) {
  const limits = { CARD: [6, 199_999], ATM: [16, 49_999], CVS: [34, 20_000], BARCODE: [18, 20_000] };
  const range = limits[method];
  const value = Number(amount);
  return Boolean(range && Number.isInteger(value) && value >= range[0] && value <= range[1]);
}

function getTipPaymentOptions({ includeEcpay = false, includeSalary = false, amount = null } = {}) {
  return getGeneralOrderPaymentOptions({ ecpayAvailable: includeEcpay, salaryEligible: includeSalary, amount });
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
      .setStyle(option.style || getPaymentButtonStyle(Math.floor(index / 2)));
    if (option.disabled) button.setDisabled(true);
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
  // 人工報價與人工開單的舊付款訊息仍走原銀行匯款。
  const resolveBankMethod = (method) => {
    const methods = { 線上刷卡: "CARD", 超商代碼: "CVS", 超商條碼: "BARCODE" };
    if (methods[method]) return { paymentMethod: "綠界支付", requestedMethod: methods[method] };
    const bank = ["匯款", "匯款帳號", "匯款轉帳", "匯款 / 轉帳"].includes(method);
    if (!bank) return { paymentMethod: method };
    if (
      prefix === "quote_payment_method_" ||
      prefix === "service_payment_method_" ||
      prefix === "extension_payment_method_"
    ) {
      return { paymentMethod: "匯款" };
    }
    if (process.env.ECPAY_ACCEPT_PAYMENTS === "true" && isEcpayAtmAvailable()) {
      return { paymentMethod: "綠界支付", requestedMethod: "ATM" };
    }
    return { paymentMethod: "匯款" };
  };
  if (Array.isArray(interaction?.values) && interaction.values[0]) {
    const selected = interaction.values[0];
    return { entityId: remainder, ...resolveBankMethod(selected) };
  }
  const markerIndex = remainder.lastIndexOf(PAYMENT_BUTTON_MARKER);
  if (markerIndex < 0) return null;
  const code = remainder.slice(markerIndex + PAYMENT_BUTTON_MARKER.length);
  const paymentMethod = PAYMENT_METHOD_BY_CODE[code];
  if (!paymentMethod) return null;
  return { entityId: remainder.slice(0, markerIndex), ...resolveBankMethod(paymentMethod) };
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
  getTipPaymentOptions,
  getGeneralOrderPaymentOptions,
  isGeneralEcpayAmountAllowed,
  getPaymentMethodDisplayName,
  getPaymentMethodSelection,
  getPaymentMethodEmoji,
  withPaymentMethodEmojis,
};
