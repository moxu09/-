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

function parseTipQuantityList(value, expectedCount) {
  const quantities = String(value || "")
    .trim()
    .split(/[\s,，、/]+/)
    .filter(Boolean)
    .map(Number);

  if (
    quantities.length !== expectedCount ||
    quantities.some(
      (quantity) =>
        !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 999,
    )
  ) {
    throw new Error(`請依序輸入 ${expectedCount} 個 1～999 的整數數量`);
  }
  return quantities;
}

function getTipGiftSelections(tipData = {}) {
  if (Array.isArray(tipData.gifts) && tipData.gifts.length) {
    return tipData.gifts.map((gift) => ({
      key: String(gift.key || gift.name || ""),
      name: String(gift.name || "打賞"),
      price: Number(gift.price || 0),
      customPrice: Boolean(gift.customPrice),
    }));
  }
  if (!tipData.item) return [];
  return [
    {
      key: "legacy",
      name: String(tipData.item),
      price: Number(tipData.amount || 0),
      customPrice: false,
    },
  ];
}

function buildTipAllocations(tipData = {}) {
  const staffIds = getTipStaffIds(tipData);
  const gifts = getTipGiftSelections(tipData);
  const sharedQuantities = Array.isArray(tipData.sharedQuantities)
    ? tipData.sharedQuantities
    : gifts.map(() => 1);

  return staffIds.map((staffId) => {
    const quantities = Array.isArray(tipData.quantitiesByStaff?.[staffId])
      ? tipData.quantitiesByStaff[staffId]
      : sharedQuantities;
    const lines = gifts.map((gift, index) => {
      const quantity = Number(quantities[index] || 1);
      return {
        ...gift,
        quantity,
        subtotal: Number(gift.price || 0) * quantity,
      };
    });
    return {
      staffId,
      lines,
      item: lines.map((line) => `${line.name}×${line.quantity}`).join("、"),
      amount: lines.reduce((sum, line) => sum + line.subtotal, 0),
    };
  });
}

function getTipAllocationTotal(tipData = {}) {
  return buildTipAllocations(tipData).reduce(
    (sum, allocation) => sum + allocation.amount,
    0,
  );
}

module.exports = {
  buildTipAllocations,
  formatTipStaffMentions,
  getTipAllocationTotal,
  getTipGiftByKey,
  getTipGiftSelections,
  getTipStaffIds,
  getTipTotalAmount,
  parseTipQuantityList,
};
