const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { formatWalletPaymentName } = require("../utils/paymentDisplay");
const { buildOrderReceiptData, buildTipReceiptData, receiptSvg } = require("../utils/receiptImages");
const { getPaymentMethodSelection } = require("../utils/paymentMethodEmojis");

test("錢包顯示相容舊儲值卡資料，不改其他付款方式", () => {
  for (const old of ["儲值卡", "儲值卡 / 錢包", "儲值卡／錢包"])
    assert.equal(formatWalletPaymentName(old), "錢包");
  for (const current of ["街口支付", "線上刷卡", "超商條碼", "錢包扣款"])
    assert.equal(formatWalletPaymentName(current), current);
  const legacy = getPaymentMethodSelection({ customId: "tip_payment_old", values: ["儲值卡"] }, "tip_payment_");
  assert.equal(legacy.paymentMethod, "儲值卡", "付款路由值不得因更名失效");
});

test("訂單與打賞收據顯示錢包，幣別仍為ASD，原資料不變", () => {
  const order = { id: "id", payment_method: "儲值卡 / 錢包" };
  const result = buildOrderReceiptData({ order, payerName: "闆闆", playerNames: ["陪陪"], amount: 100 });
  assert.equal(result.payment, "錢包");
  assert.equal(result.currency, "ASD");
  assert.equal(order.payment_method, "儲值卡 / 錢包");
  const tip = buildTipReceiptData({ tipData: { paymentMethod: "儲值卡" },
    allocations: [{ staffId: "staff", amount: 100 }], staffNames: ["陪陪"], payerName: "闆闆" });
  assert.equal(tip.payment, "錢包");
  assert.equal(tip.currency, "ASD");
  const svg = receiptSvg({ ...result, payment: "儲值卡 / 錢包" });
  assert.doesNotMatch(svg, /儲值卡/);
  assert.match(svg, /錢包/);
});

test("打賞、加時、月結與訂單提示不再使用舊顯示名稱", () => {
  for (const file of ["../index.js", "../events/dispatchSystem.js"]) {
    const source = fs.readFileSync(require.resolve(file), "utf8");
    for (const line of source.split("\n")) {
      if (/\.setLabel|\.setTitle|\.setPlaceholder|content:/.test(line))
        assert.doesNotMatch(line, /儲值卡/, line.trim());
    }
  }
});
