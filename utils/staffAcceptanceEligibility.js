function canStaffAcceptOrder(staff, guildId) {
  if (!staff?.discord_id || staff.is_active === false || staff.can_take_order === false) {
    return false;
  }
  const guildIds = String(staff.guild_id || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return guildIds.length === 0 || guildIds.includes(String(guildId));
}

module.exports = { canStaffAcceptOrder };
