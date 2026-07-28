function createDeviceAuditReviewerSync({
  client,
  supabase,
  organization,
  roleId,
}) {
  const normalizedRoleId = String(roleId || "").trim();

  async function findGuildAndRole() {
    if (!normalizedRoleId) {
      throw new Error("缺少電腦稽核審核員身分組 ID");
    }

    const preferredGuild = process.env.GUILD_ID
      ? client.guilds.cache.get(process.env.GUILD_ID)
      : null;
    const guilds = [
      preferredGuild,
      ...client.guilds.cache.values(),
    ].filter(
      (guild, index, values) =>
        guild && values.findIndex((item) => item.id === guild.id) === index,
    );

    for (const guild of guilds) {
      const role = await guild.roles.fetch(normalizedRoleId).catch(() => null);
      if (role) return { guild, role };
    }

    throw new Error(`找不到電腦稽核審核員身分組 ${normalizedRoleId}`);
  }

  async function upsertMember(member, active) {
    const now = new Date().toISOString();
    const displayName =
      member?.displayName ||
      member?.user?.globalName ||
      member?.user?.username ||
      member?.id ||
      "";
    const { error } = await supabase
      .from("device_audit_role_memberships")
      .upsert(
        {
          organization_code: organization,
          discord_id: member.id,
          display_name: displayName,
          source_role_id: normalizedRoleId,
          is_active: active,
          last_synced_at: now,
        },
        { onConflict: "organization_code,discord_id" },
      );
    if (error) throw error;
  }

  async function syncAll() {
    const { guild, role } = await findGuildAndRole();
    await guild.members.fetch();
    const activeMembers = role.members.filter((member) => !member.user.bot);
    const now = new Date().toISOString();

    const rows = activeMembers.map((member) => ({
      organization_code: organization,
      discord_id: member.id,
      display_name:
        member.displayName ||
        member.user.globalName ||
        member.user.username ||
        member.id,
      source_role_id: normalizedRoleId,
      is_active: true,
      last_synced_at: now,
    }));
    if (rows.length) {
      const { error } = await supabase
        .from("device_audit_role_memberships")
        .upsert(rows, { onConflict: "organization_code,discord_id" });
      if (error) throw error;
    }

    const activeIds = new Set(rows.map((row) => row.discord_id));
    const { data: existing, error: existingError } = await supabase
      .from("device_audit_role_memberships")
      .select("discord_id")
      .eq("organization_code", organization)
      .eq("source_role_id", normalizedRoleId)
      .eq("is_active", true);
    if (existingError) throw existingError;
    const staleIds = (existing || [])
      .map((row) => row.discord_id)
      .filter((discordId) => !activeIds.has(discordId));
    if (staleIds.length) {
      const { error: deactivateError } = await supabase
        .from("device_audit_role_memberships")
        .update({ is_active: false, last_synced_at: now })
        .eq("organization_code", organization)
        .eq("source_role_id", normalizedRoleId)
        .in("discord_id", staleIds);
      if (deactivateError) throw deactivateError;
    }

    console.log(
      `[電腦稽核權限] ${organization} 已同步 ${rows.length} 位審核員`,
    );
    return rows.length;
  }

  client.on("guildMemberUpdate", async (oldMember, newMember) => {
    const previouslyActive = oldMember.roles.cache.has(normalizedRoleId);
    const currentlyActive = newMember.roles.cache.has(normalizedRoleId);
    if (previouslyActive === currentlyActive) return;

    try {
      await upsertMember(newMember, currentlyActive);
      console.log(
        `[電腦稽核權限] ${organization} ${newMember.id} ${
          currentlyActive ? "已啟用" : "已停用"
        }`,
      );
    } catch (error) {
      console.error("[電腦稽核權限同步失敗]", error);
    }
  });

  return { syncAll };
}

module.exports = { createDeviceAuditReviewerSync };
