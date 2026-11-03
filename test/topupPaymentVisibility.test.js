const test = require("node:test");
const assert = require("node:assert/strict");
const { submitTopupForm, handleDispatchInteraction } = require("../events/dispatchSystem");

function fixture(amount = "1000") {
  const sent = [], replies = [], deferred = [];
  const interaction = {
    user: { id: "123", username: "customer" },
    channel: { topic: "owner:123;topup_no:TOP-202610180001", async send(payload) { sent.push(payload); return { id: "message" }; } },
    fields: { getTextInputValue(name) { return name === "amount" ? amount : "私人備註 @everyone"; } },
    async deferReply(payload) { deferred.push(payload); },
    async editReply(payload) { replies.push(payload); },
  };
  return { interaction, sent, replies, deferred };
}

test("自訂金額付款選單發到原頻道，而不是私人回覆", async () => {
  const f = fixture();
  await submitTopupForm(f.interaction);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].content, /TOP-202610180001/);
  assert.match(f.sent[0].content, /1000/);
  assert.match(f.sent[0].content, /請繼續選擇付款方式/);
  assert.ok(f.sent[0].components.length > 0);
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [] });
  assert.doesNotMatch(f.sent[0].content, /私人備註|@everyone/);
  assert.equal(f.sent[0].flags, undefined);
  assert.equal(f.sent[0].ephemeral, undefined);
  assert.deepEqual(f.replies.at(-1).components, []);
  assert.match(f.replies.at(-1).content, /已顯示在此儲值頻道/);
});

test("金額錯誤仍只回私人錯誤，不在頻道公開空選單", async () => {
  const f = fixture("不是金額");
  await submitTopupForm(f.interaction);
  assert.equal(f.sent.length, 0);
  assert.equal(f.deferred[0].flags, 64);
  assert.match(f.replies.at(-1).content, /金額格式錯誤/);
});

test("看得到公開選單的其他人仍不能替申請人選擇付款方式", async () => {
  const f = fixture();
  await submitTopupForm(f.interaction);
  const id = f.sent[0].components[0].components[0].data.custom_id;
  const replies = [];
  const interaction = {
    customId: id, user: { id: "456" }, deferred: false, replied: false,
    isChatInputCommand: () => false, isButton: () => true,
    async deferReply(payload) { assert.equal(payload.flags, 64); },
    async editReply(payload) { replies.push(payload); },
  };
  await handleDispatchInteraction(interaction);
  assert.match(replies.at(-1).content, /只有建立儲值申請的人/);
  assert.equal(f.sent.length, 1);
});

test("申請人可以從公開選單選擇匯款，確認單與付款資料仍發到原頻道", async () => {
  const f = fixture();
  await submitTopupForm(f.interaction);
  const button = f.sent[0].components.flatMap(row => row.components).find(button => button.data.custom_id?.endsWith("__pm_bank"));
  assert.ok(button);
  const replies = [];
  const interaction = {
    customId: button.data.custom_id, user: { id: "123" }, channel: f.interaction.channel,
    deferred: false, replied: false,
    isChatInputCommand: () => false, isButton: () => true,
    async deferReply() {}, async editReply(payload) { replies.push(payload); },
  };
  await handleDispatchInteraction(interaction);
  assert.equal(f.sent.length, 3);
  assert.match(f.sent[1].embeds[0].data.description, /付款方式/);
  assert.match(f.sent[2].embeds[0].data.description, /824/);
  assert.match(replies.at(-1).content, /已選擇付款方式/);
  assert.ok(f.sent[1].components[0].components.some(button => button.data.custom_id.startsWith("confirm_topup_")));
  await handleDispatchInteraction(interaction);
  assert.equal(f.sent.length, 3, "重複點擊不得再發確認單");
  assert.match(replies.at(-1).content, /申請已過期/);
});
