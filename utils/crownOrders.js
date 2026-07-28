function getCrownPackageByKey(packages, key) {
  return packages.find((item) => item.key === key) || null;
}

function buildCrownOrderItem(data) {
  const suffixText = data.changeSuffixes
    ? `｜雙方尾綴：闆闆「${data.customerSuffix}」／陪陪「${data.staffSuffix}」`
    : "｜雙方尾綴：不修改";
  return (
    `冠名單｜${data.crownName}` +
    `｜贈送還單 ${data.giftedHours}hrs` +
    `｜冠名時長 ${data.durationHours}hrs` +
    suffixText
  );
}

module.exports = {
  buildCrownOrderItem,
  getCrownPackageByKey,
};
