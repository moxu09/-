const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { Collection } = require("discord.js");
const { createReceiptDelivery } = require("../utils/receiptDelivery");
const { createReceiptStore } = require("../utils/receiptRecovery");
const { buildSalaryOrderDetails } = require("../utils/salaryOrderDetails");

function fixture() {
  let fail = false, sent = 0, edits = 0;
  const messages = new Collection();
  const channel = { isTextBased: () => true, messages: { fetch: async () => messages },
    async send(payload) {
      if (fail) { fail = false; throw new Error("temporary Discord outage"); }
      sent++;
      const message = { id: String(sent), content: payload.content, author: { id: "bot" },
        attachments: new Collection([["a", { name: payload.files[0].name }]]) };
      messages.set(message.id, message);
      return message;
    } };
  const client = { user: { id: "bot" }, channels: { fetch: async () => channel } };
  return { client, channel, messages, failOnce() { fail = true; }, get sent() { return sent; }, get edits() { return edits; },
    missingImage() { messages.set("old", { id: "old", content: "🧾 訂單付款收據｜O-1",
      author: { id: "bot" }, attachments: new Collection(), async edit() { edits++; return this; } }); } };
}
const receipt = { channelId: "c", key: "O-1", label: "訂單付款收據", data: {} };
const options = f => ({ client: f.client, render: () => Buffer.from("png"), logger: { error() {} } });

test("收據暫時發送失敗會排入重試，且不重複發送", async () => {
  const f = fixture(), send = createReceiptDelivery(options(f));
  f.failOnce();
  assert.equal(await send(receipt), false);
  await send.retryPending();
  assert.equal(f.sent, 1);
  await send.retryPending();
  assert.equal(f.sent, 1);
});
test("已有文字但缺收據圖片會修復原訊息，不另貼一張", async () => {
  const f = fixture(); f.missingImage();
  assert.equal(await createReceiptDelivery(options(f))(receipt), true);
  assert.equal(f.edits, 1);
  assert.equal(f.sent, 0);
});
test("超過一頁的歷史收據仍去重", async () => {
  const f = fixture(); let pages = 0;
  const old = new Collection([["old", { id: "old", content: "🧾 訂單付款收據｜O-1",
    author: { id: "bot" }, attachments: new Collection([["a", {}]]) }]]);
  f.channel.messages.fetch = async ({ before }) => {
    pages++;
    return before ? old : new Collection(Array.from({ length: 100 }, (_,i) => [String(i), { id: String(i), content: "other" }]));
  };
  assert.equal(await createReceiptDelivery(options(f))(receipt), false);
  assert.equal(pages, 2);
  assert.equal(f.sent, 0);
});
test("同一收據並行請求只發一次", async () => {
  const f = fixture(), send = createReceiptDelivery(options(f));
  await Promise.all(Array.from({ length: 10 }, () => send(receipt)));
  assert.equal(f.sent, 1);
});
function fakeDatabase() {
  const rows = new Map();
  return { rows, from() {
    let mode = "select", values, filters = [], cols;
    const q = {
      insert(v) { mode = "insert"; values = v; return q; },
      select(v) { cols = v; return q; },
      update(v) { mode = "update"; values = v; return q; },
      eq(k,v) { filters.push(r => r[k] === v); return q; },
      is(k,v) { filters.push(r => r[k] === v); return q; },
      order() { return q; }, limit() { return q; },
      single() { return execute(true); }, maybeSingle() { return execute(true); },
      then(resolve, reject) { return execute(false).then(resolve,reject); },
    };
    async function execute(single) {
      if (mode === "insert") {
        const id = values.organization_code + values.flow_id;
        if (rows.has(id)) return { error: { code: "23505" } };
        rows.set(id, { ...structuredClone(values), revision: 1, closed_at: null });
        return { error: null };
      }
      const matched = [...rows.values()].filter(r => filters.every(f => f(r)));
      if (mode === "update") for (const r of matched) Object.assign(r, structuredClone(values));
      return { error: null, data: single ? matched[0] || null : matched };
    }
    return q;
  } };
}
test("持久化重試跨重啟恢復，成功後不再送且兩品牌隔離", async () => {
  const db = fakeDatabase(), f = fixture(), store = createReceiptStore(db, "qiunai");
  f.failOnce();
  assert.equal(await createReceiptDelivery({ ...options(f), store })(receipt), false);
  const restarted = createReceiptDelivery({ ...options(f), store });
  await restarted.retryPending();
  assert.equal(f.sent, 1);
  assert.equal(await restarted(receipt), false);
  assert.equal((await store.pending()).length, 0);
  assert.ok(await createReceiptStore(db,"deepnight").claim("other",receipt));
});
test("不同處理器透過資料庫 revision 搶同一張收據只送一次", async () => {
  const db = fakeDatabase(), f = fixture();
  const a = createReceiptDelivery({ ...options(f), store: createReceiptStore(db,"qiunai") });
  const b = createReceiptDelivery({ ...options(f), store: createReceiptStore(db,"qiunai") });
  await Promise.all([a(receipt), b(receipt)]);
  assert.equal(f.sent, 1);
});
test("扣薪確認嵌入訂單明細，不建立實際扣項", async () => {
  const filename = path.join(__dirname,"..","events","dispatchSystem.js");
  const loaded = new Module(filename,module); loaded.filename=filename; loaded.paths=Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(fs.readFileSync(filename,"utf8")+"\nmodule.exports.testSalaryPrompt = createSalaryDeductionPrompt;",filename);
  let payload;
  await loaded.exports.testSalaryPrompt({
    channel: { async send(p) { payload=p; } }, customerId:"employee", amount:560,
    eligibility: { state: { availableBefore:1000, projectedBalance:440, shortage:0, canUse:true } },
    confirmId:"salary_service_confirm_test", cancelId:"salary_service_cancel_test",
    orderDetails: { service:"特戰英豪", itemLabel:"娛樂", duration:2, playerCount:1 },
  });
  const embed=payload.embeds[0].toJSON();
  assert.ok(embed.fields.some(f=>f.name==="服務／項目" && f.value.includes("特戰英豪")));
  assert.ok(embed.fields.some(f=>f.value==="120 分鐘"));
  assert.ok(embed.fields.some(f=>f.name==="確認金額" && f.value==="NT$560"));
  assert.equal(payload.components[0].toJSON().components[0].custom_id,"salary_service_confirm_test");
});
test("明細文字截斷符合 Discord 限制", () => {
  assert.ok(buildSalaryOrderDetails({ service: "a".repeat(2000) },1).every(f=>f.value.length<=1024));
});

test("新舊員工扣薪選項都進專用明細確認，不落入人工匯款確認", async () => {
  const filename = path.join(__dirname,"..","events","dispatchSystem.js");
  const source = fs.readFileSync(filename,"utf8");
  const loaded = new Module(filename,module); loaded.filename=filename; loaded.paths=Module._nodeModulePaths(path.dirname(filename));
  const mapSetup = source.includes("const pendingServiceOrders = new Map()")
    ? 'pendingServiceOrders.clear(); pendingServiceOrders.set("flow", pending);'
    : 'pendingServiceOrders = new Map([["flow", pending]]);';
  loaded._compile(source + `
    module.exports.__salaryRouting = {
      run: handleServicePaymentMethodSelect,
      wire(pending) {
        ${mapSetup}
        getSalaryDeductionEligibility = async () => ({ state: {
          availableBefore: 1000, projectedBalance: 440, shortage: 0, canUse: true
        } });
      }
    };`, filename);
  for (const selected of ["員工扣薪", "扣薪"]) {
    const api = loaded.exports.__salaryRouting, sent = [], replies = [];
    api.wire({ customerId: "employee", category: "valorant", serviceTypes: ["娛樂"],
      itemLabel: "特戰英豪", duration: 2, playerCount: 1, quotedPrice: 560,
      originalPrice: 560, finalPrice: 560, quoteConfirmedPrice: 560 });
    await api.run({
      customId: "service_payment_method_flow", values: [selected], user: { id: "employee" },
      async deferReply() { this.deferred = true; },
      async editReply(p) { replies.push(p); },
      channel: { async send(p) { sent.push(p); } },
    });
    assert.equal(sent.length, 1);
    const details = sent[0].embeds[0].toJSON().fields;
    assert.ok(details.some(f => f.name === "確認金額" && f.value === "NT$560"));
    assert.equal(sent[0].components[0].toJSON().components[0].custom_id, "salary_service_confirm_flow");
    assert.ok(replies.some(p => /已送出扣薪確認/.test(p.content)));
    assert.equal(sent.some(p => /客服確認付款，派單/.test(p.content || "")), false);
  }
});
