const assert = require("node:assert/strict");
const test = require("node:test");
const { createEcpayService, getEcpayConfig } = require("../utils/ecpay");

test("綠界付款須同時具備 HTTPS 結帳站與收款開關", () => {
  assert.equal(getEcpayConfig({ ECPAY_PUBLIC_BASE_URL: "https://example.com", ECPAY_ACCEPT_PAYMENTS: "true" }).available, true);
  assert.equal(getEcpayConfig({ ECPAY_PUBLIC_BASE_URL: "http://example.com", ECPAY_ACCEPT_PAYMENTS: "true" }).available, false);
  assert.equal(getEcpayConfig({ ECPAY_PUBLIC_BASE_URL: "https://example.com", ECPAY_ACCEPT_PAYMENTS: "false" }).available, false);
});

test("建立綠界服務付款使用獨立付款表與 20 字元內交易編號", async () => {
  let inserted;
  const supabase = {
    from(table) {
      assert.equal(table, "ecpay_service_payments");
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: null, error: null }; },
        async insert(value) { inserted = value; return { error: null }; },
      };
    },
  };
  const service = createEcpayService({
    supabase,
    env: { ECPAY_PUBLIC_BASE_URL: "https://www.wearestilllhere.com", ECPAY_ACCEPT_PAYMENTS: "true" },
  });
  const result = await service.createServicePayment({
    kind: "order", entityKey: "order-1", userId: "123", amount: 100,
    channelId: "456", description: "訂單", metadata: { flow: "service" },
  });
  assert.match(result.platformOrderId, /^[A-Z0-9]{1,20}$/);
  assert.equal(result.platformOrderId.length, 20);
  assert.equal(result.platformOrderId, inserted.merchant_trade_no);
  assert.equal(inserted.organization_code, "deepnight");
  assert.equal(inserted.payment_kind, "order");
  assert.match(result.paymentUrl, /\/payments\/ecpay\/service\/checkout\?order=/);
  await assert.rejects(service.createServicePayment({ kind: "order", entityKey: "x", userId: "1", amount: 5 }), /金額/);
});

test("停止接受新付款後仍會補處理已入帳的綠界訂單", async () => {
  const payment = { id: "payment-1", merchant_trade_no: "DN123", amount: 100, status: "paid", payment_kind: "tip", trade_no: "trade-1" };
  const calls = [];
  const supabase = {
    from(table) {
      assert.equal(table, "ecpay_service_payments");
      return { select() { return this; }, eq() { return this; }, in() { return this; }, order() { return this; },
        async limit() { return { data: [payment], error: null }; } };
    },
    async rpc(name, args) {
      calls.push(name);
      if (name === "ecpay_claim_service_fulfillment") return { data: { ...payment, claimed: true, attempt: 1 }, error: null };
      if (name === "ecpay_finish_service_fulfillment") return { data: true, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  const service = createEcpayService({ supabase,
    env: { ECPAY_PUBLIC_BASE_URL: "https://www.wearestilllhere.com", ECPAY_ACCEPT_PAYMENTS: "false" },
    onServicePaid: async ({ payment: paid }) => assert.equal(paid.provider, "ecpay"),
  });
  assert.equal(service.config.available, false);
  assert.equal(service.config.enabled, true);
  assert.equal((await service.recoverPaidFulfillments()).completed, 1);
  assert.deepEqual(calls, ["ecpay_claim_service_fulfillment", "ecpay_finish_service_fulfillment"]);
});
