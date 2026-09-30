const test = require("node:test");
const assert = require("node:assert/strict");
const { createReceiptDelivery } = require("../utils/receiptDelivery");

test("收據只發原點單頻道，重試時不重貼", async () => {
  const messages = [];
  const channel = {
    isTextBased: () => true,
    messages: { fetch: async () => ({ some: (predicate) => messages.some(predicate) }) },
    send: async (payload) => {
      messages.push({ author: { id: "bot" }, content: payload.content });
      return payload;
    },
  };
  const fetched = [];
  const client = {
    user: { id: "bot" },
    channels: { fetch: async (id) => { fetched.push(id); return channel; } },
  };
  const send = createReceiptDelivery({ client, render: () => Buffer.from("png") });
  const payload = { channelId: "order-channel", key: "O-1", label: "訂單付款收據", data: {} };
  assert.equal(await send(payload), true);
  assert.equal(await send(payload), false);
  assert.deepEqual(fetched, ["order-channel", "order-channel"]);
  assert.equal(messages.length, 1);
});

test("出圖或頻道讀取失敗不會變更付款結果", async () => {
  const errors = [];
  const channel = { isTextBased: () => true, messages: { fetch: async () => ({ some: () => false }) } };
  const send = createReceiptDelivery({
    client: { user: { id: "bot" }, channels: { fetch: async () => channel } },
    render: () => { throw new Error("render failed"); },
    logger: { error: (...args) => errors.push(args) },
  });
  assert.equal(await send({ channelId: "c", key: "O-1", label: "訂單付款收據", data: {} }), false);
  assert.equal(errors.length, 1);
});
