const { createHmac, timingSafeEqual } = require("node:crypto");

const DEFAULT_CALLBACK_IPS = [
  "210.17.19.154", "124.108.142.123", "210.17.19.129",
  "35.201.143.108", "210.17.103.201",
  "35.187.144.191",
];
const DEFAULT_FULFILLMENT_STALE_SECONDS = 120;
const DEFAULT_RECOVERY_BATCH_SIZE = 20;
const DEEPNIGHT_ORGANIZATION_CODE = "deepnight";

function signJkopayPayload(payload, secretKey) {
  return createHmac("sha256", String(secretKey || ""))
    .update(String(payload || ""), "utf8")
    .digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeIp(value) {
  const ip = String(value || "").trim();
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function parseCallbackIps(value) {
  const configured = String(value || "").split(",").map(normalizeIp).filter(Boolean);
  return new Set(configured.length ? configured : DEFAULT_CALLBACK_IPS);
}

function isAllowedCallbackIp(ip, allowedIps) {
  return allowedIps.has(normalizeIp(ip));
}

function buildServicePlatformOrderId(prefix, kind, entityKey) {
  const normalizedPrefix = String(prefix || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  const kindPrefix = { order: "ORD", extension: "EXT", tip: "TIP" }[kind];
  const normalizedKey = String(entityKey || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(-36);
  if (!normalizedPrefix || !kindPrefix || !normalizedKey) throw new Error("街口服務付款編號格式錯誤");
  return `${normalizedPrefix}-${kindPrefix}-${normalizedKey}`;
}

function normalizeJkopayServiceOrderId(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{1,12}-(?:ORD|EXT|TIP)-[A-Z0-9]{1,36}$/.test(normalized)) {
    throw new Error("街口服務訂單編號格式錯誤");
  }
  return normalized;
}

function buildJkopayRefundPayload(platformOrderId, refundAmount) {
  const normalizedOrderId = normalizeJkopayServiceOrderId(platformOrderId);
  const amount = Number(refundAmount);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("街口退款金額錯誤");
  }
  return {
    platform_order_id: normalizedOrderId,
    refund_amount: amount,
  };
}

function getJkopayConfig(env = process.env) {
  const config = {
    apiKey: String(env.JKOPAY_API_KEY || "").trim(),
    secretKey: String(env.JKOPAY_SECRET_KEY || "").trim(),
    storeId: String(env.JKOPAY_STORE_ID || "").trim(),
    entryUrl: String(env.JKOPAY_ENTRY_URL || "").trim(),
    inquiryUrl: String(env.JKOPAY_INQUIRY_URL || "").trim(),
    refundUrl: String(env.JKOPAY_REFUND_URL || "").trim(),
    publicBaseUrl: String(env.JKOPAY_PUBLIC_BASE_URL || "").trim().replace(/\/$/, ""),
    gatewayBaseUrl: String(env.JKOPAY_GATEWAY_BASE_URL || "").trim().replace(/\/$/, ""),
    gatewaySecret: String(env.JKOPAY_GATEWAY_SECRET || "").trim(),
    organizationCode: String(env.JKOPAY_ORGANIZATION_CODE || "deepnight").trim(),
    orderPrefix: String(env.JKOPAY_ORDER_PREFIX || "DEEPNIGHT").trim(),
    callbackIps: parseCallbackIps(env.JKOPAY_CALLBACK_IPS),
  };
  config.enabled = Boolean(config.apiKey && config.secretKey && config.storeId && config.entryUrl && config.inquiryUrl && config.publicBaseUrl);
  config.available = config.enabled && String(env.JKOPAY_ACCEPT_PAYMENTS || "").trim().toLowerCase() === "true";
  return config;
}

async function readJsonBody(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

function sendHtml(response, statusCode, html) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(html);
}

async function callJkopay({ url, method, payload, config }) {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "api-key": config.apiKey,
      digest: signJkopayPayload(payload, config.secretKey),
    },
    body: method === "GET" ? undefined : payload,
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`街口回傳非 JSON（HTTP ${response.status}）`); }
  if (!response.ok) throw new Error(`街口連線失敗（HTTP ${response.status}）`);
  return data;
}

async function callJkopayGateway({ path, payload, config }) {
  const response = await fetch(`${config.gatewayBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${config.gatewaySecret}`,
    },
    body: payload,
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`街口出口服務回傳非 JSON（HTTP ${response.status}）`); }
  if (!response.ok) throw new Error(data?.message || `街口出口服務失敗（HTTP ${response.status}）`);
  return data;
}

function createJkopayService({
  supabase,
  onServicePaid,
  onValidateServiceRefund,
  onPrepareServiceRefund,
  onCancelServiceRefund,
  onServiceRefunded,
  env = process.env,
}) {
  const config = getJkopayConfig(env);

  async function createServicePayment({ kind, entityKey, userId, amount, channelId, description, metadata = {} }) {
    if (!config.enabled) throw new Error("街口支付尚未完成環境設定");
    if (!["order", "extension", "tip"].includes(kind)) throw new Error("街口付款類型錯誤");
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("街口付款金額錯誤");
    const platformOrderId = buildServicePlatformOrderId(config.orderPrefix, kind, entityKey);
    const { data: existing, error: existingError } = await supabase
      .from("jkopay_service_payments")
      .select("*")
      .eq("organization_code", config.organizationCode)
      .eq("payment_kind", kind)
      .eq("entity_key", String(entityKey))
      .maybeSingle();
    if (existingError) throw new Error(existingError.message || "無法查詢街口付款紀錄");
    if (existing) {
      if (String(existing.user_id) !== String(userId) || Number(existing.amount) !== amount) throw new Error("街口付款編號已被其他付款資料使用");
      if (existing.status === "paid") throw new Error("這筆街口付款已完成");
      if (["refunding", "refund_reversal_pending", "refunded"].includes(existing.status)) {
        throw new Error("這筆街口付款已進入退款流程，不能重新付款");
      }
      if (existing.payment_url) return { paymentUrl: existing.payment_url, qrImg: existing.qr_img || null, qrTimeout: existing.qr_timeout || null, platformOrderId };
    } else {
      const { error } = await supabase.from("jkopay_service_payments").insert({
        organization_code: config.organizationCode,
        payment_kind: kind,
        entity_key: String(entityKey),
        platform_order_id: platformOrderId,
        user_id: String(userId),
        amount,
        channel_id: String(channelId || ""),
        description: String(description || "服務付款").slice(0, 200),
        metadata,
      });
      if (error) throw new Error(error.message || "無法建立街口付款紀錄");
    }
    const resultUrl = `${config.publicBaseUrl}/payments/jkopay/service-result`;
    const displayUrl = `${config.publicBaseUrl}/payments/jkopay/service-display?order=${encodeURIComponent(platformOrderId)}`;
    const payloadObject = {
      platform_order_id: platformOrderId,
      store_id: config.storeId,
      currency: "TWD",
      total_price: amount,
      final_price: amount,
      result_url: resultUrl,
      result_display_url: displayUrl,
      payment_type: "onetime",
      escrow: false,
      products: [{ name: String(description || "服務付款").slice(0, 80), unit_count: 1, unit_price: amount, unit_final_price: amount }],
    };
    const entryPayload = JSON.stringify(payloadObject);
    const data = config.gatewayBaseUrl && config.gatewaySecret
      ? await callJkopayGateway({ path: "/payments/jkopay/gateway/service-entry", payload: entryPayload, config })
      : await callJkopay({ url: config.entryUrl, method: "POST", payload: entryPayload, config });
    if (data?.result !== "000" || !data?.result_object?.payment_url) throw new Error(data?.message || `街口建立付款失敗（${data?.result || "unknown"}）`);
    const payment = { paymentUrl: data.result_object.payment_url, qrImg: data.result_object.qr_img || null, qrTimeout: data.result_object.qr_timeout || null, platformOrderId };
    const { error: updateError } = await supabase.from("jkopay_service_payments").update({ payment_url: payment.paymentUrl, qr_img: payment.qrImg, qr_timeout: payment.qrTimeout, updated_at: new Date().toISOString() }).eq("platform_order_id", platformOrderId);
    if (updateError) throw new Error(updateError.message || "無法保存街口付款連結");
    return payment;
  }

  async function attachPaymentMessage(platformOrderId, messageId) {
    await supabase.from("jkopay_service_payments").update({ payment_message_id: String(messageId), updated_at: new Date().toISOString() }).eq("organization_code", config.organizationCode).eq("platform_order_id", platformOrderId);
  }

  async function inquire(platformOrderId) {
    const query = `platform_order_ids=${encodeURIComponent(platformOrderId)}`;
    console.log(`[JKOPAY][INQUIRY][REQUEST] ${query}`);
    const data = config.gatewayBaseUrl && config.gatewaySecret
      ? await callJkopayGateway({ path: "/payments/jkopay/gateway/service-inquiry", payload: JSON.stringify({ platform_order_id: platformOrderId }), config })
      : await callJkopay({ url: `${config.inquiryUrl}?${query}`, method: "GET", payload: query, config });
    if (data?.result !== "000") throw new Error(data?.message || `街口查單失敗（${data?.result || "unknown"}）`);
    const transaction = (data.result_object?.transactions || []).find((item) => item.platform_order_id === platformOrderId);
    console.log(`[JKOPAY][INQUIRY][RESPONSE] ${JSON.stringify({ result: data.result, platform_order_id: transaction?.platform_order_id || platformOrderId, status: transaction?.status ?? null, final_price: transaction?.final_price ?? null, trade_no: transaction?.tradeNo || null })}`);
    return transaction;
  }

  async function inquirePayment(platformOrderId) {
    const normalizedOrderId = normalizeJkopayServiceOrderId(platformOrderId);
    return {
      platformOrderId: normalizedOrderId,
      transaction: await inquire(normalizedOrderId),
    };
  }

  function getStoredTransaction(payment) {
    const rawResult =
      payment?.raw_result && typeof payment.raw_result === "object"
        ? payment.raw_result
        : {};
    return {
      ...rawResult,
      platform_order_id:
        rawResult.platform_order_id || payment?.platform_order_id || null,
      status: rawResult.status ?? 0,
      final_price: rawResult.final_price ?? Number(payment?.amount || 0),
      tradeNo: rawResult.tradeNo || rawResult.trade_no || payment?.trade_no || null,
      trans_time: rawResult.trans_time || payment?.trans_time || null,
    };
  }

  async function claimPaidFulfillment(
    paymentId,
    staleAfterSeconds = DEFAULT_FULFILLMENT_STALE_SECONDS,
  ) {
    const { data, error } = await supabase.rpc(
      "deepnight_claim_jkopay_fulfillment",
      {
        p_payment_id: paymentId,
        p_stale_after_seconds: Math.max(
          30,
          Math.min(Number(staleAfterSeconds) || DEFAULT_FULFILLMENT_STALE_SECONDS, 3600),
        ),
      },
    );
    if (error) {
      throw new Error(error.message || "街口付款後續處理鎖定失敗");
    }
    return data || { claimed: false, reason: "empty_result" };
  }

  async function completePaidFulfillment(paymentId, attempt) {
    const { data, error } = await supabase.rpc(
      "deepnight_complete_jkopay_fulfillment",
      { p_payment_id: paymentId, p_attempt: attempt },
    );
    if (error) {
      throw new Error(error.message || "街口付款後續完成狀態保存失敗");
    }
    return data === true;
  }

  async function failPaidFulfillment(paymentId, attempt, failure) {
    const { data, error } = await supabase.rpc(
      "deepnight_fail_jkopay_fulfillment",
      {
        p_payment_id: paymentId,
        p_attempt: attempt,
        p_error: String(failure?.message || failure || "unknown").slice(0, 2000),
      },
    );
    if (error) {
      throw new Error(error.message || "街口付款後續失敗狀態保存失敗");
    }
    return data === true;
  }

  async function processPaidFulfillment(
    payment,
    {
      transaction = getStoredTransaction(payment),
      alreadyProcessed = true,
      staleAfterSeconds = DEFAULT_FULFILLMENT_STALE_SECONDS,
    } = {},
  ) {
    const claim = await claimPaidFulfillment(payment.id, staleAfterSeconds);
    if (!claim.claimed) {
      return {
        claimed: false,
        completed: claim.reason === "completed",
        reason: claim.reason || "not_claimed",
      };
    }

    const attempt = Number(claim.attempt || claim.fulfillment_attempts || 0);
    if (!Number.isInteger(attempt) || attempt <= 0) {
      throw new Error("街口付款後續處理 attempt 無效");
    }

    try {
      if (typeof onServicePaid !== "function") {
        throw new Error("街口付款後續處理尚未設定");
      }
      await onServicePaid({
        payment: claim,
        transaction,
        alreadyProcessed,
      });
    } catch (serviceError) {
      try {
        const failed = await failPaidFulfillment(payment.id, attempt, serviceError);
        if (!failed) {
          console.warn(
            `[JKOPAY][FULFILLMENT][FENCED] ${payment.platform_order_id} attempt ${attempt} 的失敗結果已過期`,
          );
        }
      } catch (stateError) {
        console.error(
          `[JKOPAY][FULFILLMENT] ${payment.platform_order_id} 保存失敗狀態時發生錯誤`,
          stateError,
        );
      }
      throw serviceError;
    }

    const completed = await completePaidFulfillment(payment.id, attempt);
    if (!completed) {
      console.warn(
        `[JKOPAY][FULFILLMENT][FENCED] ${payment.platform_order_id} attempt ${attempt} 的完成結果已過期`,
      );
    }
    return { claimed: true, completed, fenced: !completed, attempt };
  }

  async function recoverPaidFulfillments({
    limit = DEFAULT_RECOVERY_BATCH_SIZE,
    staleAfterSeconds = DEFAULT_FULFILLMENT_STALE_SECONDS,
  } = {}) {
    const batchLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_RECOVERY_BATCH_SIZE, 100));
    const staleSeconds = Math.max(
      30,
      Math.min(Number(staleAfterSeconds) || DEFAULT_FULFILLMENT_STALE_SECONDS, 3600),
    );
    const [retryableResult, processingResult] = await Promise.all([
      supabase
        .from("jkopay_service_payments")
        .select("*")
        .eq("organization_code", DEEPNIGHT_ORGANIZATION_CODE)
        .eq("status", "paid")
        .in("fulfillment_status", ["pending", "failed"])
        .order("fulfillment_updated_at", { ascending: true })
        .limit(batchLimit),
      supabase
        .from("jkopay_service_payments")
        .select("*")
        .eq("organization_code", DEEPNIGHT_ORGANIZATION_CODE)
        .eq("status", "paid")
        .eq("fulfillment_status", "processing")
        .order("fulfillment_claimed_at", { ascending: true })
        .limit(batchLimit),
    ]);
    if (retryableResult.error) {
      throw new Error(retryableResult.error.message || "讀取待補償街口付款失敗");
    }
    if (processingResult.error) {
      throw new Error(processingResult.error.message || "讀取逾時街口付款失敗");
    }

    const staleBefore = Date.now() - staleSeconds * 1000;
    const staleProcessing = (processingResult.data || []).filter((payment) => {
      const claimedAt = Date.parse(
        payment.fulfillment_claimed_at ||
          payment.fulfillment_updated_at ||
          payment.updated_at ||
          "1970-01-01T00:00:00.000Z",
      );
      return !Number.isFinite(claimedAt) || claimedAt <= staleBefore;
    });
    const uniqueCandidates = new Map();
    for (const payment of [...(retryableResult.data || []), ...staleProcessing]) {
      uniqueCandidates.set(payment.id, payment);
    }
    const candidates = [...uniqueCandidates.values()]
      .sort((left, right) => {
        const leftAt = Date.parse(left.fulfillment_updated_at || left.updated_at || 0) || 0;
        const rightAt = Date.parse(right.fulfillment_updated_at || right.updated_at || 0) || 0;
        return leftAt - rightAt;
      })
      .slice(0, batchLimit);

    const summary = {
      candidates: candidates.length,
      claimed: 0,
      completed: 0,
      fenced: 0,
      failed: 0,
      skipped: 0,
    };
    for (const payment of candidates) {
      try {
        const result = await processPaidFulfillment(payment, {
          transaction: getStoredTransaction(payment),
          alreadyProcessed: true,
          staleAfterSeconds: staleSeconds,
        });
        if (!result.claimed) {
          summary.skipped += 1;
          continue;
        }
        summary.claimed += 1;
        if (result.completed) summary.completed += 1;
        if (result.fenced) summary.fenced += 1;
      } catch (error) {
        summary.failed += 1;
        console.error(
          `[JKOPAY][RECOVERY] ${payment.platform_order_id} 補償失敗`,
          error,
        );
      }
    }
    return summary;
  }

  async function handleServiceResultCallback(request, response) {
    const requestIp = normalizeIp(request.headers["x-real-ip"] || request.socket?.remoteAddress);
    if (!isAllowedCallbackIp(requestIp, config.callbackIps)) {
      console.warn(`[JKOPAY][SERVICE] 拒絕非白名單 callback IP：${requestIp || "unknown"}`);
      sendJson(response, 403, { ok: false });
      return;
    }
    const body = await readJsonBody(request);
    const platformOrderId = String(body?.transaction?.platform_order_id || "");
    const { data: payment, error } = await supabase.from("jkopay_service_payments").select("*").eq("organization_code", config.organizationCode).eq("platform_order_id", platformOrderId).maybeSingle();
    if (error || !payment) { sendJson(response, 404, { ok: false }); return; }
    const transaction = await inquire(platformOrderId);
    if (!transaction || Number(transaction.status) !== 0) throw new Error("街口查單結果尚未付款成功");
    if (Number(transaction.final_price) !== Number(payment.amount)) throw new Error("街口查單金額與服務付款單不一致");
    if (body.transaction?.tradeNo && !safeEqual(body.transaction.tradeNo, transaction.tradeNo)) throw new Error("街口 callback 與查單交易序號不一致");
    if (["refunding", "refund_reversal_pending", "refunded"].includes(payment.status)) {
      sendJson(response, 200, { ok: true });
      return;
    }
    let paidPayment = payment;
    const wasAlreadyPaid = payment.status === "paid";
    if (!wasAlreadyPaid) {
      const staleBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      if (payment.status === "processing" && payment.updated_at > staleBefore) { sendJson(response, 200, { ok: true }); return; }
      const { data: claimed, error: claimError } = await supabase
        .from("jkopay_service_payments")
        .update({ status: "processing", updated_at: new Date().toISOString() })
        .eq("id", payment.id)
        .eq("status", payment.status)
        .select("id")
        .maybeSingle();
      if (claimError) throw new Error(claimError.message || "街口付款狀態鎖定失敗");
      if (!claimed) { sendJson(response, 200, { ok: true }); return; }

      // 街口查單已確認付款時，先把不可逆的金流事實寫入資料庫，再做
      // Discord 派單、累積消費與會計等可重試的下游工作。下游失敗時
      // 絕不能把已付款訂單退回 pending，否則會重新收款或失去退款依據。
      const paidAt = new Date().toISOString();
      const { data: persistedPayment, error: paidError } = await supabase
        .from("jkopay_service_payments")
        .update({
          status: "paid",
          trade_no: transaction.tradeNo,
          trans_time: transaction.trans_time || null,
          raw_result: transaction,
          paid_at: paidAt,
          fulfillment_status: "pending",
          fulfillment_error: null,
          fulfillment_updated_at: paidAt,
          updated_at: paidAt,
        })
        .eq("id", payment.id)
        .eq("status", "processing")
        .select("*")
        .maybeSingle();
      if (paidError || !persistedPayment) {
        throw new Error(paidError?.message || "街口付款完成狀態保存失敗");
      }
      paidPayment = persistedPayment;
    }

    await processPaidFulfillment(paidPayment, {
      transaction,
      alreadyProcessed: wasAlreadyPaid,
    });
    sendJson(response, 200, { ok: true });
  }

  async function refundServicePayment({ platformOrderId, requestedBy }) {
    if (!config.enabled || !config.refundUrl) {
      throw new Error("街口退款尚未完成環境設定");
    }
    if (
      (typeof onValidateServiceRefund !== "function" &&
        typeof onPrepareServiceRefund !== "function") ||
      typeof onServiceRefunded !== "function"
    ) {
      throw new Error("街口服務退款尚未完成帳務回沖設定");
    }

    const normalizedOrderId = normalizeJkopayServiceOrderId(platformOrderId);
    let { data: payment, error: paymentError } = await supabase
      .from("jkopay_service_payments")
      .select("*")
      .eq("organization_code", config.organizationCode)
      .eq("platform_order_id", normalizedOrderId)
      .maybeSingle();
    if (paymentError) {
      throw new Error(paymentError.message || "無法查詢街口服務付款紀錄");
    }
    if (!payment) throw new Error("找不到街口服務付款訂單");

    if (payment.status === "refunded") {
      return {
        kind: "service",
        serviceKind: payment.payment_kind,
        alreadyProcessed: true,
        amount: Number(payment.amount),
        order: payment,
        refundResult: payment.raw_result?.refund?.response || null,
      };
    }

    // 街口端已退款、本地回沖尚未完成時，只重試本地回沖，絕不再次呼叫
    // 街口退款 API。
    if (payment.status === "refund_reversal_pending") {
      await onServiceRefunded({
        payment,
        refundResult: payment.raw_result?.refund?.response || null,
        requestedBy,
      });
      const completedAt = new Date().toISOString();
      const { data: completed, error: completeError } = await supabase
        .from("jkopay_service_payments")
        .update({ status: "refunded", updated_at: completedAt })
        .eq("id", payment.id)
        .eq("status", "refund_reversal_pending")
        .select("*")
        .maybeSingle();
      if (completeError || !completed) {
        throw new Error(completeError?.message || "街口退款已成功，但本地帳務完成標記失敗");
      }
      return {
        kind: "service",
        serviceKind: completed.payment_kind,
        alreadyProcessed: false,
        amount: Number(completed.amount),
        order: completed,
        refundResult: completed.raw_result?.refund?.response || null,
      };
    }

    if (payment.status === "refunding") {
      throw new Error("此訂單的退款結果仍在確認中，請先向街口確認，勿重複退款");
    }
    if (payment.status !== "paid") {
      throw new Error("只有已付款的街口服務訂單可以退款");
    }

    const refundObject = buildJkopayRefundPayload(normalizedOrderId, payment.amount);
    const payload = JSON.stringify(refundObject);
    const preparedAt = new Date().toISOString();
    const refundState = {
      ...(payment.raw_result?.refund || {}),
      request: refundObject,
      requested_by: String(requestedBy || ""),
      prepared_at: preparedAt,
    };
    if (typeof onPrepareServiceRefund === "function") {
      payment = await onPrepareServiceRefund({
        payment,
        requestedBy,
        refundState,
      });
      if (!payment || payment.status !== "refunding") {
        throw new Error("街口服務退款預留失敗");
      }
    } else {
      await onValidateServiceRefund({ payment });
      const { data: locked, error: lockError } = await supabase
        .from("jkopay_service_payments")
        .update({
          status: "refunding",
          raw_result: { ...(payment.raw_result || {}), refund: refundState },
          updated_at: preparedAt,
        })
        .eq("id", payment.id)
        .eq("status", "paid")
        .select("*")
        .maybeSingle();
      if (lockError) throw new Error(lockError.message || "街口服務退款鎖定失敗");
      if (!locked) throw new Error("此訂單已被其他退款操作處理，請重新查詢");
      payment = locked;
    }

    let data;
    try {
      data = config.gatewayBaseUrl && config.gatewaySecret
        ? await callJkopayGateway({
            path: "/payments/jkopay/gateway/service-refund",
            payload,
            config,
          })
        : await callJkopay({ url: config.refundUrl, method: "POST", payload, config });
    } catch (error) {
      console.error(
        `[JKOPAY][SERVICE_REFUND][UNCERTAIN] ${normalizedOrderId}｜${error.message || error}`,
      );
      throw new Error("街口退款結果不明，訂單已鎖定；請先向街口確認，請勿重複退款");
    }

    if (data?.result !== "000") {
      const cancelledAt = new Date().toISOString();
      const cancelledRefundState = {
        ...refundState,
        response: data || {},
        cancelled_at: cancelledAt,
      };
      if (typeof onCancelServiceRefund === "function") {
        await onCancelServiceRefund({
          payment,
          requestedBy,
          refundState: cancelledRefundState,
        });
      } else {
        await supabase
          .from("jkopay_service_payments")
          .update({
            status: "paid",
            raw_result: {
              ...(payment.raw_result || {}),
              refund: cancelledRefundState,
            },
            updated_at: cancelledAt,
          })
          .eq("id", payment.id)
          .eq("status", "refunding");
      }
      throw new Error(data?.message || `街口退款失敗（${data?.result || "unknown"}）`);
    }

    const succeededAt = new Date().toISOString();
    const { data: pendingReversal, error: pendingError } = await supabase
      .from("jkopay_service_payments")
      .update({
        status: "refund_reversal_pending",
        raw_result: {
          ...(payment.raw_result || {}),
          refund: { ...refundState, response: data, succeeded_at: succeededAt },
        },
        updated_at: succeededAt,
      })
      .eq("id", payment.id)
      .eq("status", "refunding")
      .select("*")
      .maybeSingle();
    if (pendingError || !pendingReversal) {
      throw new Error(pendingError?.message || "街口退款成功，但本地退款狀態保存失敗，請勿重複退款");
    }

    await onServiceRefunded({ payment: pendingReversal, refundResult: data, requestedBy });
    const completedAt = new Date().toISOString();
    const { data: completed, error: completeError } = await supabase
      .from("jkopay_service_payments")
      .update({ status: "refunded", updated_at: completedAt })
      .eq("id", payment.id)
      .eq("status", "refund_reversal_pending")
      .select("*")
      .maybeSingle();
    if (completeError || !completed) {
      throw new Error(completeError?.message || "街口退款成功，但本地帳務完成標記失敗");
    }

    return {
      kind: "service",
      serviceKind: completed.payment_kind,
      alreadyProcessed: false,
      amount: Number(completed.amount),
      order: completed,
      refundResult: data,
    };
  }

  async function handleHttpRequest(request, response) {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname === "/payments/jkopay/service-result" && request.method === "POST") {
      try { await handleServiceResultCallback(request, response); } catch (error) { console.error("[JKOPAY][SERVICE] callback 處理失敗", error); sendJson(response, 500, { ok: false }); }
      return true;
    }
    if (url.pathname === "/payments/jkopay/service-display" && request.method === "GET") {
      const platformOrderId = String(url.searchParams.get("order") || "");
      const { data: payment } = await supabase.from("jkopay_service_payments").select("description,amount,status").eq("organization_code", config.organizationCode).eq("platform_order_id", platformOrderId).maybeSingle();
      const paid = payment?.status === "paid";
      sendHtml(response, 200, `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${paid ? "付款成功" : "付款結果確認中"}</title><style>body{margin:0;background:#111827;color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh}.card{max-width:520px;margin:24px;padding:36px;border-radius:20px;background:#1f2937;text-align:center}h1{color:${paid ? "#34d399" : "#fbbf24"}}p{line-height:1.8;color:#d1d5db}</style></head><body><main class="card"><h1>${paid ? "付款成功" : "付款結果確認中"}</h1><p>${paid ? `已完成 NT$${Number(payment.amount).toLocaleString("zh-TW")} 付款，可回到 Discord 查看。` : "系統正在向街口確認付款結果，請回到 Discord 稍候通知。"}</p><p>${payment?.description || ""}</p></main></body></html>`);
      return true;
    }
    return false;
  }

  return {
    attachPaymentMessage,
    config,
    createServicePayment,
    handleHttpRequest,
    inquire,
    inquirePayment,
    recoverPaidFulfillments,
    refundServicePayment,
  };
}

module.exports = {
  DEFAULT_CALLBACK_IPS,
  DEFAULT_FULFILLMENT_STALE_SECONDS,
  DEFAULT_RECOVERY_BATCH_SIZE,
  buildJkopayRefundPayload,
  buildServicePlatformOrderId,
  createJkopayService,
  getJkopayConfig,
  isAllowedCallbackIp,
  normalizeJkopayServiceOrderId,
  parseCallbackIps,
  signJkopayPayload,
};
