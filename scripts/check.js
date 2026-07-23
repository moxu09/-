const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const ignoredDirectories = new Set([".git", "node_modules", "coverage"]);
const files = [];

function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(fullPath);
    if (entry.isFile() && entry.name.endsWith(".js")) files.push(fullPath);
  }
}

collect(root);

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

const indexSource = fs.readFileSync(path.join(root, "index.js"), "utf8");
const commandNames = [
  ...indexSource.matchAll(
    /new SlashCommandBuilder\(\)\s*\.setName\("([^"]+)"\)/g,
  ),
].map((match) => match[1]);
const duplicateCommandNames = commandNames.filter(
  (name, index) => commandNames.indexOf(name) !== index,
);

if (!commandNames.length || duplicateCommandNames.length) {
  console.error("[CHECK] Slash Commands 定義遺失或名稱重複", [
    ...new Set(duplicateCommandNames),
  ]);
  process.exit(1);
}

console.log(
  `[CHECK] ${files.length} 個 JavaScript 檔案與 ${commandNames.length} 個 Slash Commands 檢查通過`,
);
