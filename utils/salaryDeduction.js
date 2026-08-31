const DEFAULT_SALARY_ADVANCE_LIMIT = 1000;

function numberValue(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function calculateSalaryDeductionState({
  walletEntries = [],
  withdrawRequests = [],
  pendingOrders = [],
  pendingAdjustments = [],
  amount,
  advanceLimit = DEFAULT_SALARY_ADVANCE_LIMIT,
}) {
  const deductionAmount = Math.max(0, numberValue(amount));
  const walletDeposited = walletEntries.reduce(
    (sum, entry) => sum + numberValue(entry.amount),
    0,
  );
  const reservedWithdrawals = withdrawRequests
    .filter((request) => ["pending", "approved"].includes(request.status))
    .reduce((sum, request) => sum + numberValue(request.amount), 0);
  const pendingSalary = pendingOrders.reduce(
    (sum, order) =>
      sum + numberValue(order.staff_salary) + numberValue(order.bonus_amount),
    0,
  );
  const pendingAdjustmentTotal = pendingAdjustments.reduce(
    (sum, adjustment) => sum + numberValue(adjustment.amount),
    0,
  );
  const availableBefore =
    walletDeposited -
    reservedWithdrawals +
    pendingSalary +
    pendingAdjustmentTotal;
  const projectedBalance = availableBefore - deductionAmount;
  const currentAdvance = Math.max(0, -availableBefore);
  const projectedAdvance = Math.max(0, -projectedBalance);
  const shortage = Math.max(0, deductionAmount - Math.max(0, availableBefore));
  const normalizedAdvanceLimit = Math.max(0, numberValue(advanceLimit));

  return {
    amount: deductionAmount,
    availableBefore,
    projectedBalance,
    currentAdvance,
    projectedAdvance,
    shortage,
    advanceLimit: normalizedAdvanceLimit,
    remainingAdvance: Math.max(0, normalizedAdvanceLimit - currentAdvance),
    canUse: deductionAmount > 0 && projectedAdvance <= normalizedAdvanceLimit,
  };
}

module.exports = {
  DEFAULT_SALARY_ADVANCE_LIMIT,
  calculateSalaryDeductionState,
};
