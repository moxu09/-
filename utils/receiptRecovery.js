function createReceiptStore(supabase, organization) {
  const organization_code = `${organization}:receipts`;
  const table = () => supabase.from("bot_service_order_flows");
  const scoped = (query, id) => query.eq("organization_code", organization_code).eq("flow_id", id);
  return {
    async claim(id, receipt) {
      const inserted = await table().insert({ organization_code, flow_id: id,
        payload: { receipt }, expires_at: "2099-01-01T00:00:00Z" });
      if (inserted.error && inserted.error.code !== "23505") throw inserted.error;
      const { data: row, error } = await scoped(table().select("*"), id).single();
      if (error) throw error;
      if (row.closed_at || Date.parse(row.payload.leaseUntil || "") > Date.now()) return null;
      const revision = Number(row.revision) + 1;
      const payload = { ...row.payload, receipt, leaseUntil: new Date(Date.now() + 300000).toISOString() };
      const claimed = await scoped(table().update({ payload, revision, updated_at: new Date().toISOString() }), id)
        .eq("revision", row.revision).is("closed_at", null).select("revision").maybeSingle();
      if (claimed.error) throw claimed.error;
      return claimed.data ? { id, revision, payload } : null;
    },
    async finish(claim, status, messageId = null, errorText = null) {
      const result = await scoped(table().update({
        payload: { ...claim.payload, leaseUntil: null, status, messageId, error: errorText },
        closed_at: status === "retry" ? null : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }), claim.id).eq("revision", claim.revision);
      if (result.error) throw result.error;
    },
    async pending() {
      const result = await table().select("payload").eq("organization_code", organization_code)
        .is("closed_at", null).order("updated_at", { ascending: true }).limit(50);
      if (result.error) throw result.error;
      return (result.data || []).map(row => row.payload.receipt).filter(Boolean);
    },
  };
}

// Read only paid orders; number issuance and salary balances never count as payment.
function startReceiptRecovery({ supabase, guildId, sendOrderReceipt, sendReceipt, logger = console }) {
  let busy = false;
  let watermark = "2026-09-29T00:00:00.000Z";
  async function run() {
    if (busy) return;
    busy = true;
    const started = Date.now();
    try {
      await sendReceipt.retryPending();
      for (let from = 0; ; from += 100) {
        const { data, error } = await supabase.from("play_orders").select("*")
          .eq("guild_id", guildId).eq("paid", true).not("channel_id", "is", null)
          .not("customer_id", "is", null)
          .or(`created_at.gte.${watermark},paid_at.gte.${watermark}`)
          .order("id", { ascending: true }).range(from, from + 99);
        if (error) throw error;
        for (const order of data || []) {
          if (String(order.id).startsWith("WORK-") || order.order_type === "打賞" ||
              /cancel|refund|棄單|取消|退款/i.test(String(order.status || ""))) continue;
          await sendOrderReceipt(order);
        }
        if ((data || []).length < 100) break;
      }
      watermark = new Date(started - 300000).toISOString();
    } catch (error) { logger.error("[收據自動補送]", error); }
    finally { busy = false; }
  }
  void run();
  const timer = setInterval(run, 60000);
  timer.unref?.();
  return timer;
}
module.exports = { createReceiptStore, startReceiptRecovery };
