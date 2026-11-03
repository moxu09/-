function buildSalaryOrderDetails(order = {}, amount) {
  const service = order.service || order.game || order.category || "陪玩服務";
  const item = order.order_item || order.itemLabel || order.item || order.serviceType || order.deltaMode;
  const duration = order.duration_minutes ?? order.durationMinutes ?? (Number(order.duration) * 60 || null);
  const fields = [
    ["服務／項目", [service, item].filter(Boolean).join(" · ")],
    ["訂單編號", order.order_no || order.orderNo],
    ["時長／局數", order.rounds || order.gameCount ? `${order.rounds || order.gameCount} 局／單` : duration ? `${duration} 分鐘` : order.hours ? `${order.hours} 小時` : null],
    ["陪陪人數", order.player_count || order.playerCount],
    ["段位／模式", [order.rank, order.playMode].filter(Boolean).join(" · ")],
    ["預約時間", order.reserved_time || order.reservedTime],
    ["確認金額", `NT$${Number(amount).toLocaleString("zh-TW")}`],
  ];
  return fields.filter(([,value]) => value != null && value !== "")
    .map(([name,value]) => ({ name, value: String(value).slice(0, 1024), inline: true }));
}
module.exports = { buildSalaryOrderDetails };
