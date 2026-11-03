const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function harness(result, { fallback = false, notificationFails = false, publicFails = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
  const start = source.indexOf("async function claimRedPacket(interaction)");
  const end = source.indexOf("\nasync function createPrivateRoom(", start);
  assert.ok(start >= 0 && end > start);
  const calls = { notifications: [], publicMessages: [], replies: [], fallback: 0, edits: 0 };
  const builder = () => {
    const b = {};
    for (const name of ["setColor", "setTitle", "addFields", "setDisabled", "setLabel", "addComponents"])
      b[name] = () => b;
    return b;
  };
  const context = {
    createHash: require("node:crypto").createHash,
    console: { error() {} },
    claimPreparedRedPacket: async () => fallback ? null : result,
    supabase: { rpc: async (name, args) => {
      calls.fallback++;
      assert.equal(name, "claim_red_packet_safe");
      assert.equal(args.p_packet_id, 1237);
      return { data: result, error: null };
    }},
    sendWalletLog: async (...args) => {
      calls.notifications.push(args);
      if (notificationFails) throw Error("DM blocked");
    },
    EmbedBuilder: { from: builder },
    ButtonBuilder: { from: builder },
    ActionRowBuilder: function () { return builder(); },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + "\nthis.claim = claimRedPacket;", context);
  const interaction = {
    deferred: false, replied: false, customId: "claim_red_packet_1237",
    user: { id: "519157080503091211" },
    deferReply: async value => assert.equal(value.flags, 64),
    editReply: async value => { calls.replies.push(value); return "reply"; },
    message: {
      id: "original-red-packet-message",
      channel: { send: async payload => {
        calls.publicMessages.push(payload);
        if (publicFails) throw Object.assign(Error("Forbidden"), { code: 50013 });
      }},
      embeds: [{}], components: [{ components: [{}] }],
      edit: async () => { calls.edits++; },
    },
  };
  return { calls, run: () => context.claim(interaction) };
}

const success = { success: true, claim_amount: 2, new_balance: 303, left_amount: 5, left_count: 2 };
test("領取成功只通知一次，使用 RPC 餘額且禁止重寫錢包明細", async () => {
  const h = harness(success);
  assert.equal(await h.run(), "reply");
  assert.equal(h.calls.notifications.length, 1);
  const args = h.calls.notifications[0];
  assert.equal(args[0], "519157080503091211");
  assert.equal(args[1], "搶紅包");
  assert.equal(args[2], 2);
  assert.equal(args[3], 303);
  assert.match(args[4], /1237/);
  assert.equal(args[5], false);
  assert.match(h.calls.replies[0].content, /303/);
  assert.equal(h.calls.publicMessages.length, 1);
  const message = h.calls.publicMessages[0];
  assert.match(message.content, /<@519157080503091211>.*2 星雨幣/);
  assert.doesNotMatch(message.content, /303|餘額/);
  assert.equal(message.reply.messageReference, "original-red-packet-message");
  assert.equal(message.reply.failIfNotExists, false);
  assert.equal(message.allowedMentions.parse.length, 0);
  assert.equal(message.allowedMentions.repliedUser, false);
  assert.equal(message.enforceNonce, true);
  assert.equal(message.nonce.length, 24);
});
test("舊紅包 fallback 領取也通知", async () => {
  const h = harness(success, { fallback: true });
  await h.run();
  assert.equal(h.calls.fallback, 1);
  assert.equal(h.calls.notifications.length, 1);
});
test("最後一份紅包更新搶完狀態並通知", async () => {
  const h = harness({ ...success, left_amount: 0, left_count: 0 });
  await h.run();
  assert.equal(h.calls.edits, 1);
  assert.equal(h.calls.notifications.length, 1);
});
test("重複領取或失敗不得發成功通知", async () => {
  const h = harness({ success: false, message: "你已經搶過這包紅包了" });
  await h.run();
  assert.equal(h.calls.notifications.length, 0);
  assert.equal(h.calls.publicMessages.length, 0);
});
test("私訊失敗不得把已入帳的領取回報成交易失敗", async () => {
  const h = harness(success, { notificationFails: true });
  assert.equal(await h.run(), "reply");
  assert.equal(h.calls.replies.length, 1);
  assert.equal(h.calls.notifications.length, 1);
  assert.equal(h.calls.publicMessages.length, 1);
});

test("頻道通知失敗仍保留領取成功與私人通知，不得重新入帳", async () => {
  const h = harness(success, { publicFails: true });
  assert.equal(await h.run(), "reply");
  assert.equal(h.calls.notifications.length, 1);
  assert.equal(h.calls.notifications[0][5], false);
});
test("同一包同一人的公開訊息使用固定 nonce", async () => {
  const a = harness(success), b = harness(success);
  await a.run(); await b.run();
  assert.equal(a.calls.publicMessages[0].nonce, b.calls.publicMessages[0].nonce);
});

