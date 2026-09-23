const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createCompanyAi,
  fitDiscordMessage,
  getWebSources,
  isDirectBotMention,
  shouldUseWebSearch,
} = require("../utils/companyAi");

test("公司 AI 回覆不超過 Discord 訊息上限", () => {
  const result = fitDiscordMessage("字".repeat(3000));
  assert.ok(result.length <= 1900);
  assert.match(result, /內容已截短/);
});

test("公司 AI 只接受訊息文字中直接標註機器人本人", () => {
  const botId = "123456789012345678";
  assert.equal(isDirectBotMention(`<@${botId}> 哈囉`, botId), true);
  assert.equal(isDirectBotMention(`<@!${botId}> 哈囉`, botId), true);
  assert.equal(
    isDirectBotMention("<@876543210987654321> 哈囉", botId),
    false,
  );
  assert.equal(isDirectBotMention("<@&123456789012345678> 哈囉", botId), false);
});

test("需要最新外部資料時啟用搜尋，但 Discord ID 查詢不送上網", () => {
  assert.equal(shouldUseWebSearch("請上網查今天台北天氣"), true);
  assert.equal(shouldUseWebSearch("陪我聊聊天"), false);
  assert.equal(
    shouldUseWebSearch("上網查 123456789012345678 的資料", true, true),
    false,
  );
});

test("整理並去除重複的網路搜尋來源", () => {
  const sources = getWebSources({
    output: [
      {
        type: "web_search_call",
        action: {
          sources: [
            { title: "官方資料", url: "https://example.com/a" },
            { title: "重複資料", url: "https://example.com/a" },
          ],
        },
      },
      {
        content: [
          {
            annotations: [
              { type: "url_citation", title: "第二來源", url: "https://example.org/b" },
            ],
          },
        ],
      },
    ],
  });
  assert.deepEqual(sources, [
    { title: "官方資料", url: "https://example.com/a" },
    { title: "第二來源", url: "https://example.org/b" },
  ]);
});

test("未設定 OpenAI 金鑰時提供明確提示且不查詢資料庫", async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  let queried = false;
  const companyAi = createCompanyAi({
    supabase: { from() { queried = true; throw new Error("不應查詢"); } },
    organization: "test",
    companyName: "測試公司",
    staffTable: "staff",
    orderTable: "orders",
    bonusTable: "bonus",
  });
  await assert.rejects(
    companyAi.answer({ userId: "123456789012345678", question: "測試" }),
    /尚未完成 OpenAI API 金鑰設定/,
  );
  assert.equal(queried, false);
  if (previous === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previous;
});

test("未提供公司價目表時不允許 AI 自行猜價", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    const companyAi = createCompanyAi({
      supabase: {},
      organization: "deepnight",
      companyName: "深夜不關燈",
      staffTable: "staff",
      orderTable: "orders",
      bonusTable: "bonus",
    });
    await assert.rejects(
      companyAi.suggestQuote({
        userId: "123456789012345678",
        order: { order_no: "ORD-TEST" },
      }),
      /尚未完成設定/,
    );
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
