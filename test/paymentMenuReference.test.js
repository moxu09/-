const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { getGeneralOrderPaymentOptions, getTipPaymentOptions, buildPaymentMethodButtonRows } = require("../utils/paymentMethodEmojis");

test("付款選單完全依參考圖，普通客人只少員工扣薪", () => {
  const names = ["街口支付", "線上刷卡", "轉帳匯款", "中信無卡", "錢包扣款", "加密貨幣", "超商代碼", "超商條碼", "美金轉帳"];
  for (const salaryEligible of [false, true]) {
    const normal = getGeneralOrderPaymentOptions({ ecpayAvailable: true, salaryEligible, amount: 100 });
    const tip = getTipPaymentOptions({ includeEcpay: true, includeSalary: salaryEligible, amount: 100 });
    assert.deepEqual(normal, tip);
    assert.deepEqual(normal.map(x => x.label), salaryEligible ? [...names, "員工扣薪"] : names);
    const rows = buildPaymentMethodButtonRows("tip_payment_test", normal);
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map(x => x.components.map(y => y.data.style)),
      salaryEligible ? [[4,4],[3,3],[1,1],[4,4],[3,3]] : [[4,4],[3,3],[1,1],[4,4],[3]]);
    assert.ok(!normal.some(x => x.label === "月結付款"));
  }
});

test("員工身分查詢失敗或非員工時不會開放扣薪選項", async () => {
  const source = fs.readFileSync(require.resolve("../events/dispatchSystem.js"), "utf8");
  const match = source.match(/async function (isActiveSalaryDeductionStaff|isActiveDeepnightStaff)\([^]*?\n\}/);
  assert.ok(match);
  for (const scenario of ["nonstaff", "error", "active"]) {
    const queries = [];
    const db = { from(table) {
      queries.push(table);
      return { select() { return this; }, eq(key, value) { queries.push([key,value]); return this; },
        maybeSingle: async () => ({ data: scenario === "active" ? { discord_id: "123" } : null, error: scenario === "error" ? { message: "error" } : null }),
        then(resolve) { resolve({ data: scenario === "active" ? [{ discord_id: "123", guild_id: "guild", is_active: true }] : [], error: scenario === "error" ? { message: "error" } : null }); }
      };
    }};
    const context = { supabase: db, DEEPNIGHT_GUILD_ID: "guild", console: { error() {} } };
    vm.createContext(context);
    vm.runInContext(match[0] + "; this.run = " + match[1], context);
    assert.equal(await context.run("123"), scenario === "active");
    assert.ok(queries.some(x => Array.isArray(x) && x[0] === "is_active" && x[1] === true));
    assert.equal(await context.run(""), false);
  }
});
