function getManualCommissionRate(tier) {
  return {
    rate_80: 80,
    rate_85: 85,
    rate_90: 90,
    manager_95: 95,
  }[tier] || null;
}

function getOrderCommissionBase(order = {}) {
  return Number(order.price || order.order_amount || order.final_price || 0);
}

module.exports = { getManualCommissionRate, getOrderCommissionBase };
