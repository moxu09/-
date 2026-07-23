const { REST, Routes } = require("discord.js");

function toCommandJson(command) {
  return typeof command?.toJSON === "function" ? command.toJSON() : command;
}

function projectRemoteValue(remote, localTemplate) {
  if (Array.isArray(localTemplate)) {
    if (!Array.isArray(remote) || remote.length !== localTemplate.length) {
      return remote;
    }
    return localTemplate.map((item, index) =>
      projectRemoteValue(remote[index], item),
    );
  }

  if (localTemplate && typeof localTemplate === "object") {
    if (!remote || typeof remote !== "object") return remote;
    return Object.fromEntries(
      Object.entries(localTemplate).map(([key, value]) => [
        key,
        projectRemoteValue(remote[key], value),
      ]),
    );
  }

  return remote;
}

function commandDefinitionsMatch(remoteCommands, localCommands) {
  if (!Array.isArray(remoteCommands)) return false;
  const localJson = localCommands.map(toCommandJson);
  if (remoteCommands.length !== localJson.length) return false;

  const remoteByName = new Map(
    remoteCommands.map((command) => [
      `${command.type || 1}:${command.name}`,
      command,
    ]),
  );

  return localJson.every((localCommand) => {
    const remote = remoteByName.get(
      `${localCommand.type || 1}:${localCommand.name}`,
    );
    if (!remote) return false;
    return (
      JSON.stringify(projectRemoteValue(remote, localCommand)) ===
      JSON.stringify(localCommand)
    );
  });
}

async function syncApplicationCommands({
  token,
  applicationId,
  commands,
  rest = new REST({ version: "10" }).setToken(token),
  logger = console,
}) {
  const route = Routes.applicationCommands(applicationId);
  const localCommands = commands.map(toCommandJson);

  try {
    const remoteCommands = await rest.get(route);
    if (commandDefinitionsMatch(remoteCommands, localCommands)) {
      logger.log(
        `[COMMANDS] ${localCommands.length} 個 Slash Commands 無變更，略過重複註冊`,
      );
      return { changed: false, count: localCommands.length };
    }
  } catch (error) {
    logger.warn(
      "[COMMANDS] 無法比對既有指令，將使用完整同步",
      error?.message || error,
    );
  }

  await rest.put(route, { body: localCommands });
  logger.log(`[COMMANDS] 已同步 ${localCommands.length} 個 Slash Commands`);
  return { changed: true, count: localCommands.length };
}

module.exports = {
  commandDefinitionsMatch,
  syncApplicationCommands,
};
