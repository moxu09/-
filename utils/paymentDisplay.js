// 僅供畫面／收據使用；付款路由及歷史資料值保持原樣。
function formatWalletPaymentName(value) {
  return String(value ?? "")
    .replaceAll("儲值卡 / 錢包", "錢包")
    .replaceAll("儲值卡／錢包", "錢包")
    .replaceAll("儲值卡", "錢包");
}

module.exports = { formatWalletPaymentName };
