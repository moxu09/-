console.error(
  "[停用] 這是舊版指令部署程式，會覆蓋正式指令，已禁止執行。" +
    "正式 Slash Commands 會由 index.js 在機器人啟動時完整同步。",
);
process.exitCode = 1;
