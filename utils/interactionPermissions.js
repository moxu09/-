function memberHasRole(member, roleId) {
  if (!member || !roleId) return false;
  if (typeof member.roles?.cache?.has === "function") return member.roles.cache.has(roleId);
  return Array.isArray(member.roles) && member.roles.includes(roleId);
}

function hasPermission(permissions, flag) {
  if (typeof permissions?.has === "function") return permissions.has(flag);
  try {
    if (permissions === null || permissions === undefined) return false;
    const bits = BigInt(permissions);
    return (bits & 8n) === 8n || (bits & BigInt(flag)) === BigInt(flag);
  } catch { return false; }
}

function interactionHasPermission(interaction, flag) {
  return hasPermission(interaction?.memberPermissions ?? interaction?.member?.permissions, flag);
}

module.exports = { memberHasRole, hasPermission, interactionHasPermission };
