const { createHash } = require("node:crypto");

function createReceiptDelivery({ client, render, logger = console }) {
  const inFlight = new Set();

  return async function sendReceipt({ channelId, key, label, data }) {
    if (!channelId || !key) return false;
    const marker = `🧾 ${label}｜${key}`;
    if (inFlight.has(marker)) return false;
    inFlight.add(marker);
    try {
      const channel = await client.channels.fetch(String(channelId)).catch(() => null);
      if (!channel?.isTextBased?.()) throw new Error(`收據頻道不存在：${channelId}`);
      // Discord history is the recovery guard across callback retries and process restarts.
      const recent = await channel.messages.fetch({ limit: 100 });
      if (recent.some((message) => message.author?.id === client.user?.id && message.content === marker)) return false;
      const nonce = createHash("sha256").update(`deepnight-receipt:${marker}`).digest("hex").slice(0, 25);
      await channel.send({
        content: marker,
        files: [{ attachment: render(data), name: `deepnight-${label === "打賞收據" ? "tip" : "order"}-receipt.png` }],
        allowedMentions: { parse: [] },
        nonce,
        enforceNonce: true,
      });
      return true;
    } catch (error) {
      logger.error(`[${label}傳送失敗] ${key}`, error);
      return false;
    } finally {
      inFlight.delete(marker);
    }
  };
}

module.exports = { createReceiptDelivery };
