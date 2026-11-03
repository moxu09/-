const test = require("node:test");
const assert = require("node:assert/strict");
const { handleEcpayDirect } = require("../utils/ecpayDiscord");

async function press(payment) {
  let reply;
  const db = { from() { return { select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: { user_id: "123", channel_id: "456", status: "pending", amount: 100, ...payment } }; }
  }; } };
  await handleEcpayDirect({customId:"ecpay_direct_ATM_DNTEST123", user:{id:"123"}, channelId:"456",
    async deferReply(){}, async editReply(value){reply=value.content;}},db,"https://pay.example");
  return reply;
}

test("人工訂單、續單、打賞的舊 ATM 按鈕均不得新取號", async()=>{
  const original=global.fetch;let calls=0;
  global.fetch=async()=>{calls++;throw Error("不應呼叫綠界");};
  try {
    for(const kind of ["order","extension","tip"])
      for(const metadata of [null,{}, {flow:"service"}])
        assert.match(await press({payment_kind:kind,metadata}),/此按鈕不再提供新的綠界 ATM 帳號/);
    assert.equal(calls,0);
  }finally{global.fetch=original;}
});

test("已取號交易、自助與儲值不因人工防護而被改回銀行",async()=>{
  const original=global.fetch,secret=process.env.SUPABASE_SERVICE_ROLE_KEY;let calls=0;
  process.env.SUPABASE_SERVICE_ROLE_KEY="test-only";
  global.fetch=async()=>{calls++;throw Error("TEST_EXISTING_ALLOWED");};
  try{
    for(const payment of [{payment_kind:"order",raw_result:{PaymentType:"ATM"}},
      {payment_kind:"extension",metadata:{ecpay_direct_method:"ATM"}},
      {payment_kind:"order",metadata:{flow:"self_service"}}, {payment_kind:"topup"}])
      assert.match(await press(payment),/TEST_EXISTING_ALLOWED/);
    assert.equal(calls,4);
  }finally{global.fetch=original;if(secret===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=secret;}
});
