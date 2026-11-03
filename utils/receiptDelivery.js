const { createHash } = require("node:crypto");

function createReceiptDelivery({ client, render, store, brand = "qiunai", logger = console }) {
  const inFlight = new Set();
  const pending = new Map();
  async function sendReceipt(receipt) {
    const { channelId, key, label, data } = receipt;
    if (!channelId || !key) return false;
    const marker = `🧾 ${label}｜${key}`;
    const id = createHash("sha256").update(`${channelId}:${marker}`).digest("hex");
    if (inFlight.has(id)) return false;
    inFlight.add(id);
    let claim;
    try {
      if (store) {
        claim = await store.claim(id, receipt);
        if (!claim) return false;
      }
      pending.set(id, receipt);
      const channel = await client.channels.fetch(String(channelId));
      if (!channel?.isTextBased?.()) throw new Error(`收據頻道無法傳送：${channelId}`);
      let before, found;
      for (let page = 0; page < 50; page++) {
        const recent = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        found = recent.find?.(m => m.author?.id === client.user?.id && m.content === marker);
        if (!found && !recent.find && recent.some(m => m.author?.id === client.user?.id && m.content === marker)) {
          found = { attachments: { size: 1 } };
        }
        if (found || !recent.size || recent.size < 100) break;
        before = recent.last().id;
        if (page === 49) throw new Error("收據歷史尚未查完，暫緩補送避免重複");
      }
      if (found?.attachments?.size) {
        if (store) await store.finish(claim, "sent", found.id);
        pending.delete(id);
        return false;
      }
      const files = [{ attachment: render(data), name: `${brand}-${label === "打賞收據" ? "tip" : "order"}-receipt.png` }];
      const sent = found ? await found.edit({ files }) : await channel.send({
        content: marker, files, allowedMentions: { parse: [] },
        nonce: id.slice(0, 25), enforceNonce: true,
      });
      if (store) await store.finish(claim, "sent", sent.id);
      pending.delete(id);
      return true;
    } catch (error) {
      const deleted = Number(error.code) === 10003;
      if (deleted) pending.delete(id);
      if (store && claim) {
        try { await store.finish(claim, deleted ? "channel_deleted" : "retry", null, String(error.message || error).slice(0, 500)); }
        catch (saveError) { logger.error("[收據重試保存失敗]", saveError); }
      }
      logger.error(`[${label}傳送失敗] ${key}`, error);
      return false;
    } finally { inFlight.delete(id); }
  }
  sendReceipt.retryPending = async () => {
    const persisted = store ? await store.pending() : [];
    for (const receipt of [...pending.values(), ...persisted]) await sendReceipt(receipt);
  };
  return sendReceipt;
}
module.exports = { createReceiptDelivery };
