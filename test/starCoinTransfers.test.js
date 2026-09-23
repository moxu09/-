const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

test("深夜關閉星雨幣玩家互轉並保留其他銀行功能", () => {
  assert.match(source, /const STAR_COIN_PLAYER_TRANSFERS_ENABLED = false/);
  const transferFunction = source.slice(
    source.indexOf("async function safeTransfer"),
    source.indexOf("// 取得今日日期"),
  );
  assert.match(transferFunction, /if \(!STAR_COIN_PLAYER_TRANSFERS_ENABLED\)/);
  assert.ok(
    transferFunction.indexOf("STAR_COIN_PLAYER_TRANSFERS_ENABLED") <
      transferFunction.indexOf('supabase.rpc("transfer_coins"'),
  );
  const atmPanel = source.slice(
    source.indexOf("async function sendAtmPanel"),
    source.indexOf("async function sendShopPanel"),
  );
  assert.doesNotMatch(atmPanel, /\.setCustomId\("transfer_menu"\)/);
  assert.match(atmPanel, /星雨幣玩家轉帳目前關閉/);
  assert.match(source, /if \(customId === "transfer_menu"\)[\s\S]*?星雨幣玩家轉帳目前已關閉/);
  assert.match(source, /if \(interaction\.customId === "transfer_user_select"\)[\s\S]*?STAR_COIN_PLAYER_TRANSFERS_ENABLED/);
  assert.match(source, /if \(interaction\.customId\.startsWith\("transfer_modal_"\)\)[\s\S]*?STAR_COIN_PLAYER_TRANSFERS_ENABLED/);
  assert.match(atmPanel, /transfer_records/);
  assert.match(atmPanel, /check_coins/);
});
