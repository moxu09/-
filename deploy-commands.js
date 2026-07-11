require("dotenv").config();

const commands = require("./commands");

async function deploy() {
  try {
    console.log("==============================");
    console.log("🚀 開始部署 Slash Commands");
    console.log("==============================");

    console.log(`📌 CLIENT_ID: ${process.env.CLIENT_ID}`);

    console.log(`📌 GUILD_ID: ${process.env.GUILD_ID}`);

    console.log("");

    const url =
      `https://discord.com/api/v10/applications/` +
      `${process.env.CLIENT_ID}/guilds/` +
      `${process.env.GUILD_ID}/commands`;

    // ===== 清除 =====
    console.log("🧹 清除舊指令中...");

    const clearResponse = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bot ${process.env.TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([]),
    });

    console.log(`📨 清除狀態: ${clearResponse.status}`);

    if (!clearResponse.ok) {
      const err = await clearResponse.text();

      console.log(err);

      return;
    }

    console.log("✅ 舊指令已清除");

    console.log("");

    // ===== 指令列表 =====
    console.log("📦 即將註冊指令:");

    commands.forEach((cmd) => {
      console.log(`- ${cmd.name}`);
    });

    console.log("");

    // ===== 註冊 =====
    console.log("📡 註冊中...");

    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bot ${process.env.TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    });

    console.log("");

    console.log(`📨 HTTP STATUS: ${response.status}`);

    const data = await response.json();

    console.log("");

    if (response.ok) {
      console.log("✅ Slash Commands 註冊成功");

      console.log("");

      data.forEach((cmd) => {
        console.log(`✔ ${cmd.name}`);
      });
    } else {
      console.log("❌ Discord API 錯誤");

      console.log(data);
    }
  } catch (error) {
    console.error("❌ 部署失敗");

    console.error(error);
  }
}

deploy();
