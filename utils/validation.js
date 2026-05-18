function isAdmin(interaction) {
  return (
    interaction.guild.ownerId === interaction.user.id ||
    interaction.member.permissions.has('Administrator')
  );
}

module.exports = {
  isAdmin
};