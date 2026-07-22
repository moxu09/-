function normalizeVipRewardName(value) {
  const name = String(value || "")
    .trim()
    .replace(/前綴|冠名/g, "後綴");

  if (name.includes("心動值") && name.includes("雙倍")) {
    return "心動值禮物雙倍券";
  }

  return name;
}

function parseVipCouponReward(rewardCoupon = "") {
  return String(rewardCoupon || "")
    .split(/[,，、;；\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(.*?)(?:\s*[*×xX]\s*(\d+))?$/);
      return {
        name: normalizeVipRewardName(match?.[1] || part),
        count: Math.max(1, Number(match?.[2] || 1)),
      };
    })
    .filter((reward) => reward.name && !reward.name.includes("禮品卡"));
}

function isCouponInventoryItem(item) {
  const itemName = String(item?.item_name || "");

  return (
    item?.item_type === "coupon" ||
    itemName.includes("折券") ||
    itemName.includes("折價券") ||
    itemName.includes("優惠券") ||
    (itemName.includes("後綴") && itemName.includes("券")) ||
    (itemName.includes("心動值") && itemName.includes("雙倍"))
  );
}

function qualifiesForVipLevel({
  totalSpent = 0,
  highestSingleTopup = 0,
  totalSpendRequired = 0,
  singleTopupRequired = 0,
} = {}) {
  const spendRequired = Number(totalSpendRequired || 0);
  const topupRequired = Number(singleTopupRequired || 0);

  return (
    (spendRequired > 0 && Number(totalSpent || 0) >= spendRequired) ||
    (topupRequired > 0 &&
      Number(highestSingleTopup || 0) >= topupRequired)
  );
}

module.exports = {
  isCouponInventoryItem,
  normalizeVipRewardName,
  parseVipCouponReward,
  qualifiesForVipLevel,
};
