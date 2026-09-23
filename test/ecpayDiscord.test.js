const assert = require("node:assert/strict");
const test = require("node:test");
const { buildEcpayPaymentRows, handleEcpayDirect, sendPreferredEcpayDirect } = require("../utils/ecpayDiscord");
const { getPaymentMethodSelection } = require("../utils/paymentMethodEmojis");
const { ECPAY_ATM_START, isEcpayAtmAvailable } = require("../utils/ecpayAtmSchedule");

const order = "QN123456789012345678";
const payment = { platformOrderId: order, paymentUrl: `https://pay.example/payments/ecpay/service/checkout?order=${order}` };

test("綠界刷卡留在站內；ATM 與超商由機器人直接取號", () => {
  const originalNow = Date.now;
  Date.now = () => ECPAY_ATM_START;
  try {
  const rows = buildEcpayPaymentRows(payment, 100);
  const buttons = rows[0].components.map(button => button.toJSON());
  assert.equal(buttons[0].url, `https://pay.example/payments/ecpay/service/insite?order=${order}`);
  assert.equal(buttons[0].label, "站內刷卡");
  assert.deepEqual(buttons.slice(1).map(button => button.custom_id), [
    `ecpay_direct_ATM_${order}`, `ecpay_direct_CVS_${order}`, `ecpay_direct_BARCODE_${order}`,
  ]);
  assert.equal(buildEcpayPaymentRows(payment, 100, { topup: true })[0].components.length, 2);
  } finally { Date.now = originalNow; }
});

test("虛擬 ATM 開放日前，按鈕隱藏且匯款仍走原帳號", () => {
  assert.equal(isEcpayAtmAvailable(ECPAY_ATM_START - 1), false);
  assert.equal(isEcpayAtmAvailable(ECPAY_ATM_START), true);
  const originalNow = Date.now;
  const originalFlag = process.env.ECPAY_ACCEPT_PAYMENTS;
  Date.now = () => ECPAY_ATM_START - 1;
  process.env.ECPAY_ACCEPT_PAYMENTS = "true";
  try {
    const buttons = buildEcpayPaymentRows(payment, 100)[0].components.map(button => button.toJSON());
    assert.equal(buttons.some(button => button.custom_id?.includes("_ATM_")), false);
    const selected = getPaymentMethodSelection({ customId: "quote_payment_method_123", values: ["匯款"] }, "quote_payment_method_");
    assert.equal(selected.paymentMethod, "匯款");
    assert.equal(selected.requestedMethod, undefined);
    const oldButton = getPaymentMethodSelection({ customId: "quote_payment_method_123__pm_bank_account" }, "quote_payment_method_");
    assert.equal(oldButton.paymentMethod, "匯款");
    assert.equal(oldButton.requestedMethod, undefined);
  } finally {
    Date.now = originalNow;
    if (originalFlag === undefined) delete process.env.ECPAY_ACCEPT_PAYMENTS;
    else process.env.ECPAY_ACCEPT_PAYMENTS = originalFlag;
  }
});

test("選擇匯款時改走綠界虛擬 ATM，不再提供固定帳號", () => {
  const original = process.env.ECPAY_ACCEPT_PAYMENTS;
  const originalNow = Date.now;
  Date.now = () => ECPAY_ATM_START;
  process.env.ECPAY_ACCEPT_PAYMENTS = "true";
  try {
    const selected = getPaymentMethodSelection({ customId: "quote_payment_method_123", values: ["匯款"] }, "quote_payment_method_");
    assert.equal(selected.paymentMethod, "綠界支付");
    assert.equal(selected.requestedMethod, "ATM");
    const oldButton = getPaymentMethodSelection({ customId: "quote_payment_method_123__pm_bank_account" }, "quote_payment_method_");
    assert.equal(oldButton.paymentMethod, "綠界支付");
    assert.equal(oldButton.requestedMethod, "ATM");
  } finally {
    Date.now = originalNow;
    if (original === undefined) delete process.env.ECPAY_ACCEPT_PAYMENTS;
    else process.env.ECPAY_ACCEPT_PAYMENTS = original;
  }
});

test("虛擬 ATM 取號後直接發到原付款頻道，未標記已付款", async () => {
  const originalNow = Date.now;
  Date.now = () => ECPAY_ATM_START;
  const sent = [];
  const channel = { id: "456", async send(payload) { sent.push(payload); } };
  const supabase = { from(table) {
    assert.equal(table, "ecpay_service_payments");
    return { select() { return this; }, eq() { return this; },
      async maybeSingle() { return { data: { user_id: "123", channel_id: "456", status: "pending", amount: 100, payment_kind: "order" }, error: null }; } };
  } };
  const originalFetch = global.fetch;
  const originalSecret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-secret";
  global.fetch = async (url, init) => {
    assert.equal(url, "https://pay.example/api/payments/ecpay/service/direct-issue");
    assert.equal(JSON.parse(init.body).method, "ATM");
    return { ok: true, async json() { return { payment_info: { method: "ATM", expireDate: "2026/09/26",
      bankCode: "822", virtualAccount: "1234567890123456" } }; } };
  };
  try {
    await sendPreferredEcpayDirect(channel, "123", order, supabase, "https://pay.example");
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /虛擬帳號：`1234567890123456`/);
    assert.match(sent[0].content, /取號不代表已付款/);
  } finally { Date.now = originalNow; global.fetch = originalFetch; if (originalSecret === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = originalSecret; }
});

test("超商條碼在 Discord 直接產生三張 PNG", async () => {
  const sent = [];
  const interaction = { customId: `ecpay_direct_BARCODE_${order}`, user: { id: "123" }, channelId: "456",
    channel: { async send(payload) { sent.push(payload); } }, async deferReply() {}, async editReply() {} };
  const supabase = { from() { return { select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: { user_id: "123", channel_id: "456", status: "pending", amount: 100, payment_kind: "order" }, error: null }; } }; } };
  const originalFetch = global.fetch;
  const originalSecret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-secret";
  global.fetch = async () => ({ ok: true, async json() { return { payment_info: { method: "BARCODE", expireDate: "2026/09/26 23:59:59",
    barcode: ["1407086CY", "1557341899384519", "0708B4000000100"] } }; } });
  try {
    await handleEcpayDirect(interaction, supabase, "https://pay.example");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].files.length, 3);
    assert.match(sent[0].content, /條碼3/);
  } finally { global.fetch = originalFetch; if (originalSecret === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = originalSecret; }
});
