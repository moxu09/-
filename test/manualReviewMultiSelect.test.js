const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

test("手動滿意度調查可複選陪陪並合併保存與播報", () => {
  const commandStart = source.indexOf('.setName("滿意度調查")');
  const commandEnd = source.indexOf('.setName("發送優惠券")', commandStart);
  const commandSource = source.slice(commandStart, commandEnd);

  assert.ok(commandStart >= 0 && commandEnd > commandStart);
  assert.match(commandSource, /setName\("老闆"\)/);
  assert.doesNotMatch(commandSource, /setName\("陪陪"\)/);
  assert.match(source, /manual_review_staff_select_/);
  assert.match(source, /manual_review_staff_search_/);
  assert.match(source, /manual_review_staff_search_modal_/);
  assert.match(source, /manual_review_staff_search_result_/);
  assert.match(source, /打字搜尋陪陪/);
  assert.match(source, /\.setMinValues\(1\)/);
  assert.match(source, /\.setMaxValues\(25\)/);
  assert.match(source, /staff_ids: staffIds\.join\(","\)/);
  assert.match(source, /陪陪：\$\{staffMentions\}/);
  assert.match(source, /publishPositiveReview\(\{[\s\S]*?staffIds,[\s\S]*?orderNo: `MANUAL-/);
});

test("打賞可單獨移除陪陪且文字搜尋可一次輸入多人", () => {
  assert.match(source, /tip_staff_remove_/);
  assert.match(source, /tip_staff_remove_select_/);
  assert.match(source, /handleTipStaffRemoveSelect/);
  assert.match(source, /陪陪名字或 Discord ID（可輸入多人）/);
  assert.match(source, /resolveStaffSearchInput\(staffRecords, rawQuery/);
});
