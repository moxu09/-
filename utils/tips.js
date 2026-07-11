function getTipGiftByKey(gifts, key) {
  return gifts.find((gift) => gift.key === key);
}

function getTipStaffIds(tipData = {}) {
  const rawIds = Array.isArray(tipData.selectedStaffIds)
    ? tipData.selectedStaffIds
    : [tipData.selectedStaffId];

  return [
    ...new Set(rawIds.map((id) => String(id || "").trim()).filter(Boolean)),
  ];
}

function formatTipStaffMentions(staffIds = []) {
  return staffIds.map((staffId) => `<@${staffId}>`).join("、");
}

function getTipTotalAmount(amount, staffIds = []) {
  return Number(amount || 0) * Math.max(staffIds.length, 1);
}

module.exports = {
  formatTipStaffMentions,
  getTipGiftByKey,
  getTipStaffIds,
  getTipTotalAmount,
};
