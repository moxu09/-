const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { getTipPaymentOptions, getPaymentMethodSelection, buildPaymentMethodButtonRows } = require("../utils/paymentMethodEmojis");
const { buildEcpayPaymentRows } = require("../utils/ecpayDiscord");
const { EmbedBuilder } = require("discord.js");

test("打賞選單十種付款、五排紅綠藍紅綠，信用卡不再叫綠界支付", () => {
  const options = getTipPaymentOptions({ includeEcpay: true, includeSalary: true });
  assert.equal(options.length, 10);
  assert.deepEqual(options.filter(x => ["線上刷卡", "超商代碼", "超商條碼"].includes(x.label)).map(x => x.label), ["線上刷卡", "超商代碼", "超商條碼"]);
  assert.ok(!options.some(x => x.label === "綠界支付"));
  const rows = buildPaymentMethodButtonRows("tip_payment_id", options);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(row => row.components.map(x => x.data.style)), [[4,4],[3,3],[1,1],[4,4],[3,3]]);
  for (const method of ["線上刷卡", "超商代碼", "超商條碼"]) {
    assert.equal(getPaymentMethodSelection({ customId: "tip_payment_id", values: [method] }, "tip_payment_").paymentMethod, "綠界支付");
  }
  assert.equal(getPaymentMethodSelection({ customId: "tip_payment_id", values: ["線上刷卡"] }, "tip_payment_").requestedMethod, "CARD");
  assert.equal(getTipPaymentOptions({ includeEcpay: true, amount: 20 }).find(x => x.value === "超商代碼").disabled, true);
});

test("打賞只建立所選付款方式，刷卡直達站內卡號頁，ATM不被改成刷卡", async () => {
  const source = fs.readFileSync(require.resolve("../index.js"), "utf8");
  const body = source.match(/async function startEcpayTipPayment\([^]*?\n\}/)?.[0];
  assert.ok(body);
  for (const method of ["CARD", "ATM", "CVS", "BARCODE"]) {
    let created, sent;
    const context = {
      buildEcpayTipPaymentRows: buildEcpayPaymentRows,
      ecpayService: { config: { available: true }, createServicePayment: async args => {
        created = args;
        return { platformOrderId: "QN123", paymentUrl: "https://example.test/payments/ecpay/service/checkout?order=QN123" };
      }, attachPaymentMessage: async () => {} },
      refreshTipTotals: () => [{ item: "打賞" }], getTipAllocationTotal: () => 100,
      formatTipStaffMentions: () => "陪陪", getTipStaffIds: () => ["staff"], getTipAllocationText: () => "打賞",
      EmbedBuilder, QIUNAI_WATER_BLUE: "#123456", process,
    };
    vm.createContext(context);
    vm.runInContext(body + "; this.run = startEcpayTipPayment", context);
    await context.run({ tipId: "tip", tipData: { tipperId: "user", requestedMethod: method },
      channel: { id: "channel", send: async data => { sent = data; return { id: "message" }; } } });
    assert.equal(created.requestedMethod, method);
    const buttons = sent.components.flatMap(row => row.components.map(x => x.toJSON()));
    assert.equal(buttons.length, 1);
    if (method === "CARD") {
      assert.equal(buttons[0].label, "線上刷卡");
      assert.match(buttons[0].url, /\/insite\?order=QN123/);
    } else assert.equal(buttons[0].custom_id, "ecpay_direct_" + method + "_QN123");
    assert.match(sent.embeds[0].toJSON().description, /實際付款成功後/);
  }
});
