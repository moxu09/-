# 深夜不關燈 Rainbot

正式 Discord 營運機器人，包含訂單、打賞、儲值、錢包、VIP、報單、薪資報告與客服流程。

## 本機驗證

```bash
npm ci
npm run verify
```

正式環境使用 Node.js 22–24。必要設定請參考 `.env.example`，真實憑證只應放在 Railway Variables，不得提交至 Git。

## 服務狀態

- `GET /health`：程序存活狀態。
- `GET /ready`：Discord 已登入且啟動工作完成後回傳 200。
- 個別面板啟動失敗不會阻止其餘排程啟動，狀態會顯示為 `degraded`。

## 部署限制

目前互動表單仍包含程序內暫存狀態，因此正式環境必須維持單一副本。`railway.json` 已關閉新舊版本重疊，避免同一筆 Discord 互動在部署切換期間被兩個程序同時處理。要水平擴充至多副本前，應先把所有暫存流程與冪等鍵移至 Supabase 或 Redis。
