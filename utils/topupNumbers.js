const TOPUP_NUMBER_PATTERN = /^TOP-\d{10,}$/;

function normalizeTopupNumber(value) {
  const topupNo = String(value || "").trim().toUpperCase();
  return TOPUP_NUMBER_PATTERN.test(topupNo) ? topupNo : null;
}

function getTopupNumberFromTopic(topic) {
  const match = String(topic || "").match(
    /(?:^|;)topup_no:(TOP-\d{10,})(?:;|$)/i,
  );
  return normalizeTopupNumber(match?.[1]);
}

function buildTopupTopic(ownerId, topupNo) {
  const normalized = normalizeTopupNumber(topupNo);
  if (!normalized) throw new Error("儲值編號格式錯誤");
  return `owner:${String(ownerId || "").trim()};topup_no:${normalized}`;
}

async function getNextTopupNumber(supabase) {
  const { data, error } = await supabase.rpc("next_topup_number");
  const topupNo = normalizeTopupNumber(data);

  if (error || !topupNo) {
    throw new Error(error?.message || "無法取得儲值編號");
  }

  return topupNo;
}

module.exports = {
  buildTopupTopic,
  getNextTopupNumber,
  getTopupNumberFromTopic,
  normalizeTopupNumber,
};
