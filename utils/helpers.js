function getTodayDateString() {
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return utc8.toISOString().split('T')[0];
}

async function replyError(interaction, message) {
  try {
    if (interaction.replied || interaction.deferred) {
      return await interaction.followUp({
        content: `❌ ${message}`,
        flags: 64
      });
    }

    return await interaction.reply({
      content: `❌ ${message}`,
      flags: 64
    });
  } catch (err) {
    console.error(err);
  }
}

async function replySuccess(interaction, message) {
  try {
    if (interaction.replied || interaction.deferred) {
      return await interaction.followUp({
        content: `✅ ${message}`,
        flags: 64
      });
    }

    return await interaction.reply({
      content: `✅ ${message}`,
      flags: 64
    });
  } catch (err) {
    console.error(err);
  }
}

module.exports = {
  getTodayDateString,
  replyError,
  replySuccess
};