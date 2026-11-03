const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { isStaffInteraction } = require("../events/workReportSystem");
const source = fs.readFileSync(require.resolve("../events/dispatchSystem"), "utf8");
function extract(name) {
  const match = source.match(new RegExp("(?:async )?function " + name + "\\([^]*?\\n\\}"));
  assert.ok(match, name);
  return match[0];
}
function actor(id, roles = [], permissions = "0") {
  return { user: { id, username: id }, member: { roles }, memberPermissions: permissions,
    customId: "new_order_player_flow", values: ["none"], reply: async payload => payload,
    update: async payload => payload };
}
function context(pending) {
  const c = { isStaffInteraction, process, pendingNewOrders: new Map([["flow", pending]]),
    clearNewOrderSelectionTimer() {}, showDurationSelect: async (_interaction, _flow, p) => p };
  vm.createContext(c);
  vm.runInContext(extract("canCustomerOrStaffSubmit") + "\n" + extract("handleNewOrderPlayerSelect"), c);
  return c;
}
test("客服可代客選人，原客人與無關成員權限不混淆", async () => {
  const old = process.env.CUSTOMER_SERVICE_ROLE_IDS;
  process.env.CUSTOMER_SERVICE_ROLE_IDS = "999999999999999991,999999999999999992";
  try {
    for (const [who, allowed] of [
      [actor("customer"), true],
      [actor("support", ["999999999999999992"]), true],
      [actor("admin", [], "8"), true],
      [actor("stranger"), false],
      [actor("companion", ["1206158440280621056"]), false],
    ]) {
      const pending = { userId: "customer", username: "原客人", selectionExpiresAt: Date.now() + 60000 };
      const c = context(pending);
      assert.equal(c.canCustomerOrStaffSubmit(who, pending.userId), allowed);
      const result = await c.handleNewOrderPlayerSelect(who);
      assert.equal(pending.userId, "customer");
      assert.equal(pending.username, "原客人");
      if (allowed) assert.equal(result.selectedPlayerType, "none");
      else assert.match(result.content, /只有下單者/);
    }
  } finally {
    if (old === undefined) delete process.env.CUSTOMER_SERVICE_ROLE_IDS;
    else process.env.CUSTOMER_SERVICE_ROLE_IDS = old;
  }
});
test("所有一般填單步驟與客服指定派單套用一致權限", () => {
  const block = source.slice(source.indexOf("async function handleNewOrderGameSelect("),
    source.indexOf("async function createWaitingQuoteOrder("));
  assert.ok(!block.includes("pending.userId !== interaction.user.id"));
  for (const name of ["openDispatchPlayerMenu", "submitDispatchPlayers"]) {
    assert.ok(extract(name).includes("canCustomerOrStaffSubmit(interaction, null)"));
  }
  assert.ok(extract("createWaitingQuoteOrder").includes("customer_id: pending.userId"));
  assert.ok(extract("handleNewOrderGameSelect").includes("users.fetch(pending.userId)"));
});
test("代客選人不放寬錢包扣款與退款", () => {
  for (const name of ["confirmWalletPayment", "confirmExtensionWalletPayment"]) {
    if (source.includes("async function " + name + "(")) {
      assert.match(extract(name), /order.customer_id !== interaction.user.id|interaction.user.id !== order.customer_id/);
    }
  }
  if (source.includes("async function confirmSelfServicePlayers(")) {
    assert.ok(extract("selectSelfServicePlayerNumbers").includes("canCustomerOrStaffSubmit(interaction, order.customer_id)"));
    assert.ok(extract("confirmSelfServicePlayers").includes("selection?.customerId === order.customer_id"));
    assert.ok(extract("cancelAndRefundSelfServiceOrder").includes("interaction.user.id !== order.customer_id"));
  }
});
test("客服代客略過優惠券時仍更新原客人的訂單", async () => {
  const calls = [];
  const order = { id: "order-1", customer_id: "customer", original_price: 500 };
  const query = {
    select() { return this; },
    update() { return this; },
    eq(column, value) { calls.push([column, value]); return this; },
    async single() { return { data: order, error: null }; },
  };
  const c = {
    supabase: { from: () => query },
    DEEPNIGHT_GUILD_ID: "guild",
    canCustomerOrStaffSubmit: () => true,
    sendPaymentMethodSelect: async () => {},
    console,
  };
  vm.createContext(c);
  vm.runInContext(extract("handleQuoteNoCoupon"), c);
  const interaction = {
    user: { id: "support" }, customId: "quote_no_coupon_order-1",
    deferReply: async () => {}, editReply: async payload => payload,
  };
  const result = await c.handleQuoteNoCoupon(interaction);
  assert.match(result.content, /不使用優惠券/);
  assert.ok(calls.some(([column, value]) => column === "customer_id" && value === "customer"));
  assert.ok(!calls.some(([column, value]) => column === "customer_id" && value === "support"));
});
test("客服代客使用優惠券時只能讀取原客人的背包", async () => {
  const userIds = [];
  const order = { id: "order-1", customer_id: "customer", original_price: 500 };
  const query = {
    select() { return this; },
    eq(column, value) { if (column === "user_id") userIds.push(value); return this; },
    or() { return this; },
    order: async () => ({ data: [], error: null }),
    async single() { return { data: order, error: null }; },
  };
  const c = {
    supabase: { from: () => query },
    DEEPNIGHT_GUILD_ID: "guild",
    canCustomerOrStaffSubmit: () => true,
    isCouponInventoryItem: () => true,
    console,
  };
  vm.createContext(c);
  vm.runInContext(extract("handleQuoteUseCoupon"), c);
  const result = await c.handleQuoteUseCoupon({
    user: { id: "support" }, customId: "quote_use_coupon_order-1",
    deferReply: async () => {}, editReply: async payload => payload,
  });
  assert.deepEqual(userIds, ["customer"]);
  assert.match(result.content, /沒有可使用的優惠券/);
});
