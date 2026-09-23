const test = require("node:test");
const assert = require("node:assert/strict");

const {
  findStaffSearchMatches,
  resolveStaffSearchInput,
  splitStaffSearchInput,
} = require("../utils/staffSearch");

const staff = [
  { discord_id: "111111111111111", display_name: "小奈" },
  { discord_id: "222222222222222", display_name: "小喵" },
  { discord_id: "333333333333333", display_name: "小喵二號" },
  { discord_id: "444444444444444", display_name: "兜兜" },
];

test("陪陪搜尋輸入可用逗號、頓號、分號及換行一次分隔多人", () => {
  assert.deepEqual(
    splitStaffSearchInput("小奈，小喵、兜兜；<@444444444444444>\n111111111111111"),
    ["小奈", "小喵", "兜兜", "<@444444444444444>", "111111111111111"],
  );
});

test("陪陪搜尋優先精確名稱與 Discord ID 並保留模糊複選結果", () => {
  assert.deepEqual(
    findStaffSearchMatches(staff, "小喵").map((row) => row.discord_id),
    ["222222222222222"],
  );
  const result = resolveStaffSearchInput(
    staff,
    "小奈、小、<@444444444444444>、找不到",
    { excludeIds: ["111111111111111"] },
  );
  assert.deepEqual(result.resolvedIds, ["444444444444444"]);
  assert.deepEqual(result.ambiguousMatches.map((group) => group.query), ["小"]);
  assert.deepEqual(result.missingQueries, ["小奈", "找不到"]);
});
