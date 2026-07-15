const ALLIANCE_TIER_ORDER = [
  "star_traveler",
  "silver_wing",
  "gold_wing",
  "radiant_star",
  "obsidian",
  "exclusive",
];

const EXCLUSIVE_CARD_URLS = {
  white: "https://www.wearestilllhere.com/membership-cards/exclusive.png",
  black: "https://www.wearestilllhere.com/membership-cards/exclusive-black.png",
};

function resolveMembershipCardImage(member, currentTier) {
  if (currentTier?.tier_key !== "exclusive") return currentTier?.card_image_url || null;
  return EXCLUSIVE_CARD_URLS[member?.exclusive_card_variant] || null;
}

function createAllianceMembership(supabase, guildId) {
  async function getMembership(discordUserId) {
    const [{ data: member, error }, { data: tiers, error: tiersError }] =
      await Promise.all([
        supabase
          .from("alliance_members")
          .select("*")
          .eq("discord_user_id", String(discordUserId))
          .maybeSingle(),
        supabase
          .from("alliance_membership_tiers")
          .select("*")
          .eq("is_active", true)
          .order("sort_order", { ascending: true }),
      ]);
    if (error) throw error;
    if (tiersError) throw tiersError;
    const sortedTiers = tiers || [];
    const currentTier =
      sortedTiers.find((tier) => tier.tier_key === member?.tier_key) ||
      sortedTiers[0] ||
      null;
    const currentIndex = ALLIANCE_TIER_ORDER.indexOf(
      currentTier?.tier_key || "star_traveler",
    );
    const nextTier = sortedTiers.find(
      (tier) =>
        !tier.is_invitation_only &&
        ALLIANCE_TIER_ORDER.indexOf(tier.tier_key) > currentIndex &&
        Number(tier.threshold_points || 0) > Number(member?.lifetime_points || 0),
    );
    const resolvedTier = currentTier
      ? { ...currentTier, card_image_url: resolveMembershipCardImage(member, currentTier) }
      : null;
    return { member, currentTier: resolvedTier, nextTier, tiers: sortedTiers };
  }

  async function applyActivity({
    discordUserId,
    activityType,
    amount,
    sourceKey,
    note,
  }) {
    const { data, error } = await supabase.rpc("alliance_apply_activity", {
      p_discord_user_id: String(discordUserId),
      p_guild_id: String(guildId || ""),
      p_activity_type: activityType,
      p_amount: Number(amount),
      p_source_key: sourceKey || null,
      p_note: note || null,
    });
    if (error) throw error;
    return data;
  }

  async function adjustCumulative({
    discordUserId,
    activityType,
    mode,
    amount,
    sourceKey,
    note,
  }) {
    const field = activityType === "topup" ? "qualifying_topup" : "qualifying_spend";
    const { member } = await getMembership(discordUserId);
    const oldTotal = Number(member?.[field] || 0);
    const input = Number(amount);
    const newTotal =
      mode === "add"
        ? oldTotal + input
        : mode === "subtract"
          ? Math.max(0, oldTotal - input)
          : input;
    const delta = newTotal - oldTotal;

    if (delta !== 0) {
      await applyActivity({
        discordUserId,
        activityType,
        amount: delta,
        sourceKey,
        note,
      });
    }

    return { oldTotal, newTotal };
  }

  function formatSummary({ member, currentTier, nextTier }) {
    const points = Number(member?.lifetime_points || 0);
    const nextText = nextTier
      ? `${nextTier.tier_name}（尚差 ${Math.max(0, Number(nextTier.threshold_points) - points).toFixed(2)} 點）`
      : currentTier?.is_invitation_only
        ? "已達尊享會員"
        : "下一級為邀請制尊享會員";
    return [
      `會籍：**${currentTier?.tier_name || "星旅會員"}**`,
      `累積會籍積分：**${points.toFixed(2)} 點**`,
      `本期會籍積分：**${Number(member?.period_points || 0).toFixed(2)} 點**`,
      `獎勵積分：**${Number(member?.reward_points || 0).toLocaleString("zh-TW")} 點**`,
      `聯盟累積消費：**${Number(member?.qualifying_spend || 0).toLocaleString("zh-TW")} ASD**`,
      `聯盟累積儲值：**${Number(member?.qualifying_topup || 0).toLocaleString("zh-TW")} ASD**`,
      `晉升進度：**${nextText}**`,
      member?.expires_at
        ? `會籍期限：<t:${Math.floor(new Date(member.expires_at).getTime() / 1000)}:D>`
        : "會籍期限：永久",
    ].join("\n");
  }

  return { adjustCumulative, applyActivity, formatSummary, getMembership };
}

module.exports = { createAllianceMembership, resolveMembershipCardImage };
