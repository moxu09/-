const DEFAULT_CUSTOMER_SERVICE_ROLE_ID = "1210642900355125288";

function hasCustomerServicePointRole(interaction, roleId = DEFAULT_CUSTOMER_SERVICE_ROLE_ID) {
  const resolvedRoleId = String(roleId || DEFAULT_CUSTOMER_SERVICE_ROLE_ID);
  const roles = interaction?.member?.roles;
  if (roles?.cache?.has?.(resolvedRoleId)) return true;
  if (Array.isArray(roles)) return roles.includes(resolvedRoleId);
  return false;
}

async function recordCustomerServicePoint(
  supabase,
  { appKey, orderId, discordId, servedAt = new Date().toISOString() },
) {
  if (!supabase || !appKey || !orderId || !discordId) return false;

  const { error } = await supabase.from("customer_service_order_points").upsert(
    {
      app_key: String(appKey),
      order_id: String(orderId),
      discord_id: String(discordId),
      points: 1,
      served_at: servedAt,
    },
    { onConflict: "app_key,order_id", ignoreDuplicates: true },
  );

  if (error) throw error;
  return true;
}

module.exports = {
  DEFAULT_CUSTOMER_SERVICE_ROLE_ID,
  hasCustomerServicePointRole,
  recordCustomerServicePoint,
};
