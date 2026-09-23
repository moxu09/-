const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  PAYMENT_EMOJI_DEFINITIONS,
  buildPaymentMethodButtonRows,
  getCanonicalPaymentOptions,
  getPaymentMethodDisplayName,
  getPaymentMethodSelection,
  withPaymentMethodEmojis,
} = require("../utils/paymentMethodEmojis");

test("付款方式圖片完整且可套用到選單", () => {
  const imageDefinitions = PAYMENT_EMOJI_DEFINITIONS.filter((item) => item.file);
  assert.equal(imageDefinitions.length, 7);
  for (const definition of imageDefinitions) {
    const imagePath = path.join(__dirname, "..", "assets", "payment-method-icons", definition.file);
    assert.ok(fs.existsSync(imagePath), `${definition.file} 不存在`);
    assert.ok(fs.statSync(imagePath).size > 500, `${definition.file} 檔案異常`);
    assert.ok(fs.statSync(imagePath).size < 256 * 1024, `${definition.file} 超過 Discord 表情上限`);
  }
  const options = withPaymentMethodEmojis([
    { label: "街口支付", value: "街口支付" },
    { label: "匯款帳號", value: "匯款" },
    { label: "加密貨幣", value: "加密貨幣" },
    { label: "月結付款", value: "月結" },
    { label: "中信無卡", value: "無卡" },
    { label: "美金轉帳", value: "美金轉帳" },
    { label: "錢包扣款", value: "儲值卡" },
  ]);
  assert.ok(options.every((option) => option.emoji));
  const rows = buildPaymentMethodButtonRows("quote_payment_method_order-1", options);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => row.components.length), [2, 2, 2, 1]);
  assert.deepEqual(
    rows.map((row) => [...new Set(row.components.map((button) => button.data.style))]),
    [[4], [3], [1], [4]],
    "付款按鈕應依排數顯示紅、綠、藍，第四排維持紅色",
  );
  assert.equal(
    getPaymentMethodSelection(
      { customId: "quote_payment_method_order-1__pm_asd" },
      "quote_payment_method_",
    ).paymentMethod,
    "儲值卡",
  );
  assert.deepEqual(
    getPaymentMethodSelection(
      { customId: "quote_payment_method_order-legacy", values: ["街口支付"] },
      "quote_payment_method_",
    ),
    { entityId: "order-legacy", paymentMethod: "街口支付" },
  );
  assert.equal(
    PAYMENT_EMOJI_DEFINITIONS.find((item) => item.key === "jkopay").name,
    "pay_jkopay_logo",
  );
  assert.deepEqual(
    Object.fromEntries(PAYMENT_EMOJI_DEFINITIONS.filter((item) => item.file).map((item) => [item.key, item.name])),
    {
      jkopay: "pay_jkopay_logo",
      bank_transfer: "pay_bank_transfer_v2",
      crypto: "pay_crypto_v2",
      monthly: "pay_monthly_v2",
      cardless: "pay_cardless_v2",
      usd_transfer: "pay_usd_transfer_v2",
      asd_wallet: "pay_asd_wallet_v2",
    },
  );
});

test("深夜付款名稱統一且舊按鈕仍可使用", () => {
  const options = getCanonicalPaymentOptions({
    includeWallet: true,
    includeMonthly: true,
    includeSalary: true,
  });
  assert.deepEqual(options.map((option) => option.label), [
    "街口支付",
    "匯款帳號",
    "中信無卡",
    "錢包扣款",
    "加密貨幣",
    "美金轉帳",
    "員工扣薪",
    "月結付款",
  ]);
  assert.equal(options.filter((option) => option.label.includes("街口")).length, 1);
  assert.equal(getPaymentMethodDisplayName("街口掃碼（可刷卡）"), "街口支付");
  assert.equal(getPaymentMethodDisplayName("儲值卡 / 錢包"), "錢包扣款");
  assert.equal(getPaymentMethodDisplayName("匯款 / 轉帳"), "匯款帳號");
  assert.equal(
    getPaymentMethodSelection(
      { customId: "quote_payment_method_order-old__pm_jks" },
      "quote_payment_method_",
    ).paymentMethod,
    "街口掃碼（可刷卡）",
  );
});

test("一般訂單、加時、打賞、購幣與自助訂單付款方式均直接攤開", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const dispatchSource = fs.readFileSync(path.join(__dirname, "..", "events", "dispatchSystem.js"), "utf8");
  assert.match(indexSource, /buildPaymentMethodButtonRows\(\s*`tip_payment_/);
  assert.match(indexSource, /buildPaymentMethodButtonRows\([\s\S]*?`extension_payment_method_/);
  for (const id of ["quote_payment_method_", "extension_payment_method_", "topup_payment_method_", "service_payment_method_"]) {
    assert.match(dispatchSource, new RegExp(`buildPaymentMethodButtonRows\\([\\s\\S]*?${id}`));
  }
});

test("付款圖片按鈕不會重複 defer 並保留舊選單相容", () => {
  const dispatchSource = fs.readFileSync(path.join(__dirname, "..", "events", "dispatchSystem.js"), "utf8");
  for (const handler of [
    "handleQuotePaymentMethodSelect",
    "handleExtensionPaymentMethodSelect",
    "handleTopupPaymentMethodSelect",
    "handleServicePaymentMethodSelect",
  ]) {
    const body = dispatchSource.match(new RegExp(`async function ${handler}\\(interaction\\) \\{([\\s\\S]*?)\\n\\}`))?.[1];
    assert.ok(body, `${handler} 不存在`);
    assert.doesNotMatch(body, /^\s*await interaction\.deferReply/);
  }
  assert.match(dispatchSource, /interaction\.isStringSelectMenu\(\)[\s\S]*?service_payment_method_/);
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(indexSource, /interaction\.isButton\(\)[\s\S]*?customId\.startsWith\("tip_payment_"\)[\s\S]*?handleTipPaymentSelect\(interaction\)/);
});
