function numberValue(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function createAccountingLedger(supabase, options = {}) {
  const appKey =
    options.appKey || process.env.ACCOUNTING_APP_KEY || "deepnight";
  let tableMissingLogged = false;

  function buildDedupeKey(entry) {
    if (entry.dedupe_key) return String(entry.dedupe_key);

    const parts = [
      entry.entry_type,
      entry.source_table,
      entry.source_id,
      entry.order_id,
      entry.order_no,
      entry.customer_id,
      entry.staff_id,
      entry.amount,
    ]
      .filter((part) => part !== undefined && part !== null && part !== "")
      .map(String);

    if (parts.length >= 3) return parts.join(":");

    return `${entry.entry_type || "entry"}:${Date.now()}:${Math.random()
      .toString(36)
      .slice(2)}`;
  }

  async function recordAccountingLedger(entry = {}) {
    if (tableMissingLogged) return;

    if (!entry.entry_type) {
      console.error("[會計流水] 缺少 entry_type", entry);
      return;
    }

    const payload = {
      app_key: appKey,
      dedupe_key: buildDedupeKey(entry),
      occurred_at: entry.occurred_at || new Date().toISOString(),
      entry_type: entry.entry_type,
      entry_label: entry.entry_label || null,
      amount: numberValue(entry.amount),
      cash_amount: numberValue(entry.cash_amount),
      revenue_amount: numberValue(entry.revenue_amount),
      expense_amount: numberValue(entry.expense_amount),
      discount_amount: numberValue(entry.discount_amount),
      liability_amount: numberValue(entry.liability_amount),
      receivable_amount: numberValue(entry.receivable_amount),
      payment_method: entry.payment_method || null,
      customer_id: entry.customer_id || null,
      customer_name: entry.customer_name || null,
      staff_id: entry.staff_id || null,
      staff_name: entry.staff_name || null,
      order_id: entry.order_id ? String(entry.order_id) : null,
      order_no: entry.order_no || null,
      source_table: entry.source_table || null,
      source_id: entry.source_id ? String(entry.source_id) : null,
      note: entry.note || null,
      metadata: entry.metadata || {},
      created_by: entry.created_by || null,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase.from("accounting_ledger").upsert(payload, {
      onConflict: "app_key,dedupe_key",
    });

    if (error) {
      if (error.code === "PGRST205" || error.code === "42P01") {
        tableMissingLogged = true;
        console.error(
          "[會計流水] accounting_ledger 尚未建立，請先執行 salary-app/supabase/accounting_ledger.sql"
        );
        return;
      }

      console.error("[會計流水] 寫入失敗", error);
    }
  }

  return {
    recordAccountingLedger,
  };
}

module.exports = {
  createAccountingLedger,
};
