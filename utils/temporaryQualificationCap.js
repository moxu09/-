const START_AT = Date.parse("2026-10-04T00:00:00+08:00");
const END_AT = Date.parse("2026-10-10T00:00:00+08:00");

async function applyTemporaryLegacyVipCredit(supabase, { userId, guildId, triggerType, amount, now = Date.now() }) {
  if (now < START_AT || now >= END_AT || !(Number(amount) > 0) ||
      !["spend", "topup"].includes(triggerType) ||
      !["1206138511535898654", "1501098191813214312"].includes(String(guildId))) return false;
  const { data, error } = await supabase.rpc("apply_temporary_legacy_vip_credit", {
    p_user_id: String(userId), p_guild_id: String(guildId),
    p_trigger_type: triggerType, p_amount: Number(amount),
  });
  if (error) throw new Error(`每日累積上限套用失敗：${error.message || error}`);
  return data?.applied === true;
}

module.exports = { START_AT, END_AT, applyTemporaryLegacyVipCredit };
