const assert = require("node:assert/strict");
const test = require("node:test");
const { createEcpayService } = require("../utils/ecpay");

// APP 付款抽（payment_kind 'draw'）由秋奈 bot 入帳；深夜 bot 的補償迴圈必須在查詢時就排除，不得 claim。
test("深夜補償迴圈查詢排除 payment_kind draw，其他深夜付款單照常處理", async () => {
  const rows = [
    { id: 1, organization_code: "deepnight", payment_kind: "topup", status: "paid", fulfillment_status: "pending", merchant_trade_no: "DN1" },
    { id: 2, organization_code: "deepnight", payment_kind: "draw", status: "paid", fulfillment_status: "pending", merchant_trade_no: "QD2" },
    { id: 3, organization_code: "deepnight", payment_kind: "order", status: "paid", fulfillment_status: "failed", merchant_trade_no: "DN3" },
  ];
  const filters = [];
  const supabase = {
    from(table) {
      assert.equal(table, "ecpay_service_payments");
      const q = {
        select() { return q; }, order() { return q; },
        eq(k, v) { filters.push(["eq", k, v]); return q; },
        neq(k, v) { filters.push(["neq", k, v]); return q; },
        in(k, v) { filters.push(["in", k, v]); return q; },
        async limit() {
          const data = rows.filter((r) => filters.every(([op, k, v]) => (op === "eq" ? r[k] === v : op === "neq" ? r[k] !== v : v.includes(r[k]))));
          return { data, error: null };
        },
      };
      return q;
    },
    async rpc(name, args) {
      if (name === "ecpay_claim_service_fulfillment") return { data: { ...rows.find((r) => r.id === args.p_payment_id), claimed: true, attempt: 1 }, error: null };
      return { data: true, error: null };
    },
  };
  const handled = [];
  const service = createEcpayService({ supabase, organizationCode: "deepnight", env: { ECPAY_PUBLIC_BASE_URL: "https://pay.example" },
    onServicePaid: async ({ payment }) => handled.push(payment.payment_kind) });
  const summary = await service.recoverPaidFulfillments();
  assert.deepEqual(filters.find(([op]) => op === "neq"), ["neq", "payment_kind", "draw"]);
  assert.deepEqual(handled.sort(), ["order", "topup"]);
  assert.equal(summary.candidates, 2);
});
