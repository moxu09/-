const test = require("node:test");
const assert = require("node:assert/strict");
const {
  escapeXml, wrapText, buildTipReceiptData, buildOrderReceiptData,
  receiptSvg, renderReceiptPng,
} = require("../utils/receiptImages");

test("匿名打賞收據不包含打賞人名稱，錢包與街口金額單位正確", () => {
  const source = {
    tipData: { flowId: "TIP-1", broadcastAnonymous: true, paymentMethod: "ASD 錢包" },
    allocations: [{ amount: 300, lines: [{ name: "小熊餅乾", quantity: 2 }] }],
    staffNames: ["小奈"], payerName: "不可公開的名字",
  };
  const anonymous = buildTipReceiptData(source);
  assert.equal(anonymous.payer, "匿名闆闆");
  assert.equal(anonymous.currency, "ASD");
  assert.equal(anonymous.amount, 300);
  assert.doesNotMatch(receiptSvg(anonymous), /不可公開的名字/);
  const publicPayment = buildTipReceiptData({
    ...source, tipData: { ...source.tipData, broadcastAnonymous: false, paymentMethod: "街口支付" },
  });
  assert.equal(publicPayment.payer, "不可公開的名字");
  assert.equal(publicPayment.currency, "TWD");
  assert.equal(buildOrderReceiptData({
    order: { id: "O-1", service: "特戰英豪", payment_method: "街口支付" },
    payerName: "闆闆", playerNames: ["小奈"], amount: 250,
  }).amount, 250);
  assert.match(receiptSvg(buildOrderReceiptData({
    order: { id: "O-2", service: "特戰英豪" },
    payerName: "闆闆", playerNames: ["小奈"], amount: 0,
  })), /NT\$0/);
});

test("收據會跳脫使用者文字並限制長欄位，不把輸入當成 SVG 執行", () => {
  assert.equal(escapeXml('<img onload="x"> &'), '&lt;img onload=&quot;x&quot;&gt; &amp;');
  assert.equal(wrapText("陪玩".repeat(90), 24, 2).length, 2);
  const svg = receiptSvg({
    kind: "order",
    reference: "ORD-123",
    payer: '<script>alert("x")</script>',
    recipient: "小奈",
    details: "特戰英豪",
    amount: 250,
    payment: "街口支付",
    time: "2026-09-30T04:00:00.000Z",
  });
  assert.match(svg, /ORD-123/);
  assert.match(svg, /&lt;script&gt;/);
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /NT\$250/);
});

test("訂單與打賞都產生可辨識的 PNG，且 ASD 不標成新台幣", () => {
  for (const kind of ["order", "tip"]) {
    const png = renderReceiptPng({
      kind,
      reference: "TEST-1",
      payer: kind === "tip" ? "匿名闆闆" : "闆闆",
      recipient: "小奈、阿陌",
      details: "小熊棉花糖餅乾 × 3",
      amount: 300,
      currency: kind === "tip" ? "ASD" : "TWD",
      payment: kind === "tip" ? "ASD 錢包" : "街口支付",
      time: "2026-09-30T04:00:00.000Z",
    });
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), 720);
    assert.ok(png.readUInt32BE(20) > png.readUInt32BE(16));
    assert.ok(png.length > 15_000);
  }
  assert.match(receiptSvg({
    kind: "tip", payer: "匿名闆闆", recipient: "小奈", details: "打賞",
    amount: 300, currency: "ASD", payment: "ASD 錢包",
  }), /ASD 300/);
  assert.throws(() => renderReceiptPng({ kind: "order", amount: -1 }), /金額無效/);
});

test("熱感紙收據有鋸齒紙邊、已付款章與逐項打賞金額", () => {
  const data = buildTipReceiptData({
    tipData: { flowId: "TIP-2", paymentMethod: "街口支付" },
    allocations: [{ staffId: "1", amount: 440, lines: [
      { name: "客製打賞", quantity: 2, subtotal: 440 },
    ] }],
    staffNames: ["小奈"],
    payerName: "闆闆",
  });
  assert.equal(data.items[0].amount, 440);
  const svg = receiptSvg(data);
  assert.match(svg, /已付款/);
  assert.match(svg, /polygon points=/);
  assert.match(svg, /440 ASD/);
  assert.match(svg, /客製打賞/);
});

test("長暱稱與大量明細仍可產生完整直式 PNG，不遺失總額", () => {
  const items = Array.from({ length: 30 }, (_, index) => ({
    to: `陪陪${index + 1}的超長暱稱測試資料`,
    name: "客製語音陪玩與特殊需求".repeat(3),
    quantity: 2,
    amount: 100,
  }));
  const data = {
    kind: "tip", reference: "TIP-LONG-1", payer: "闆闆".repeat(20),
    recipient: items.map((item) => item.to).join("、"), items,
    amount: 3000, currency: "TWD", payment: "街口支付",
    time: "2026-09-30T04:00:00.000Z",
  };
  const svg = receiptSvg(data);
  assert.match(svg, /另有 18 位陪陪/);
  assert.match(svg, /NT\$3,000/);
  assert.match(svg, /A 熱感紙收據/);
  const png = renderReceiptPng(data);
  assert.equal(png.readUInt32BE(16), 720);
  assert.ok(png.readUInt32BE(20) > 3000);
  assert.ok(png.length < 8_000_000);
});
