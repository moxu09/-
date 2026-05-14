require('dotenv').config();
const {
  REST,
  Routes
} = require('discord.js');
const commands = require('./commands');
const rest = new REST({
  version: '10',
  timeout: 30000
}).setToken(process.env.TOKEN);
(async () => {
  try {
    console.log('[BOT] 清除 Global Commands');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });

    console.log('[BOT] 清除舊指令');
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: [] });

    console.log('[BOT] 重新註冊指令');
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });

    console.log('[BOT] Slash Commands 註冊成功');
  } catch (error) {
    console.error('[BOT] 指令註冊失敗:', error);
  }
})();