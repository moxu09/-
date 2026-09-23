const { randomBytes } = require("node:crypto");

const MIN_AMOUNT = 6;
const MAX_AMOUNT = 199_999;

function getEcpayConfig(env = process.env, organizationCode = "deepnight") {
  const publicBaseUrl = String(env.ECPAY_PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  const enabled = /^https:\/\//.test(publicBaseUrl);
  return {
    organizationCode,
    publicBaseUrl,
    enabled,
    available: enabled && String(env.ECPAY_ACCEPT_PAYMENTS || "").trim().toLowerCase() === "true",
  };
}

function createEcpayService({ supabase, onServicePaid, env = process.env, organizationCode = "deepnight" }) {
  const config = getEcpayConfig(env, organizationCode);

  async function createServicePayment({ kind, entityKey, userId, amount, channelId, description, metadata = {} }) {
    if (!config.available) throw new Error("綠界信用卡付款尚未開放");
    if (!["order", "extension", "tip", "topup"].includes(kind)) throw new Error("綠界付款類型錯誤");
    if (!entityKey || !userId) throw new Error("綠界付款資料不完整");
    if (!Number.isInteger(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT)
      throw new Error("綠界信用卡付款金額須介於 NT$6 至 NT$199,999");
    const { data: existing, error: lookupError } = await supabase
      .from("ecpay_service_payments").select("*")
      .eq("organization_code", config.organizationCode).eq("payment_kind", kind)
      .eq("entity_key", String(entityKey)).maybeSingle();
    if (lookupError) throw new Error(lookupError.message || "無法查詢綠界付款紀錄");
    if (existing) {
      if (existing.user_id !== String(userId) || Number(existing.amount) !== amount)
        throw new Error("綠界付款單與目前訂單資料不一致");
      if (existing.status !== "pending") throw new Error("這筆綠界付款已完成或不可付款");
      const createdAt = Date.parse(existing.created_at || "");
      if (!Number.isFinite(createdAt) || Date.now() - createdAt > 24 * 60 * 60 * 1000)
        throw new Error("綠界付款連結已過期，請聯絡客服建立新付款單");
      return {
        platformOrderId: existing.merchant_trade_no,
        paymentUrl: `${config.publicBaseUrl}/payments/ecpay/service/checkout?order=${encodeURIComponent(existing.merchant_trade_no)}`,
      };
    }
    const prefix = config.organizationCode === "qiunai" ? "QN" : "DN";
    const merchantTradeNo = `${prefix}${randomBytes(9).toString("hex").toUpperCase()}`;
    const { error: insertError } = await supabase.from("ecpay_service_payments").insert({
      organization_code: config.organizationCode,
      payment_kind: kind,
      entity_key: String(entityKey),
      merchant_trade_no: merchantTradeNo,
      user_id: String(userId),
      amount,
      channel_id: String(channelId || ""),
      description: String(description || "服務付款").slice(0, 100),
      metadata,
    });
    if (insertError) throw new Error(insertError.message || "無法建立綠界付款單");
    return {
      platformOrderId: merchantTradeNo,
      paymentUrl: `${config.publicBaseUrl}/payments/ecpay/service/checkout?order=${encodeURIComponent(merchantTradeNo)}`,
    };
  }

  async function attachPaymentMessage(platformOrderId, messageId) {
    const { error } = await supabase.from("ecpay_service_payments")
      .update({ payment_message_id: String(messageId), updated_at: new Date().toISOString() })
      .eq("organization_code", config.organizationCode).eq("merchant_trade_no", platformOrderId);
    if (error) throw new Error(error.message || "無法保存綠界付款訊息");
  }

  async function processPaidFulfillment(payment) {
    const { data: claimed, error: claimError } = await supabase.rpc("ecpay_claim_service_fulfillment", {
      p_payment_id: payment.id,
      p_stale_after_seconds: 120,
    });
    if (claimError) throw new Error(claimError.message || "無法取得綠界付款後續處理權");
    if (!claimed?.claimed) return { claimed: false, reason: claimed?.reason || "not_claimed" };
    const attempt = Number(claimed.attempt);
    try {
      if (typeof onServicePaid !== "function") throw new Error("綠界付款後續處理尚未設定");
      const transaction = {
        tradeNo: claimed.trade_no,
        final_price: Number(claimed.amount),
        trans_time: claimed.payment_date,
        status: 0,
      };
      await onServicePaid({
        payment: { ...claimed, platform_order_id: claimed.merchant_trade_no, provider: "ecpay" },
        transaction,
      });
      const { data: completed, error: finishError } = await supabase.rpc("ecpay_finish_service_fulfillment", {
        p_payment_id: payment.id, p_attempt: attempt, p_error: null,
      });
      if (finishError || !completed) throw new Error(finishError?.message || "綠界後續處理完成標記失敗");
      return { claimed: true, completed: true };
    } catch (error) {
      await supabase.rpc("ecpay_finish_service_fulfillment", {
        p_payment_id: payment.id, p_attempt: attempt, p_error: String(error?.message || error).slice(0, 2000),
      });
      throw error;
    }
  }

  async function recoverPaidFulfillments({ limit = 20 } = {}) {
    const { data: payments, error } = await supabase.from("ecpay_service_payments")
      .select("*").eq("organization_code", config.organizationCode).eq("status", "paid")
      .in("fulfillment_status", ["pending", "failed", "processing"])
      .order("fulfillment_updated_at", { ascending: true }).limit(Math.max(1, Math.min(limit, 100)));
    if (error) throw new Error(error.message || "無法查詢待處理綠界付款");
    const summary = { candidates: (payments || []).length, completed: 0, failed: 0, skipped: 0 };
    for (const payment of payments || []) {
      try {
        const result = await processPaidFulfillment(payment);
        if (result.completed) summary.completed += 1;
        else summary.skipped += 1;
      } catch (paymentError) {
        summary.failed += 1;
        console.error(`[ECPAY][RECOVERY] ${payment.merchant_trade_no} 後續處理失敗`, paymentError);
      }
    }
    return summary;
  }

  return { config, createServicePayment, attachPaymentMessage, recoverPaidFulfillments };
}

module.exports = { MIN_AMOUNT, MAX_AMOUNT, getEcpayConfig, createEcpayService };
