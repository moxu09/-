/**
 * 工具函数库
 */

function getTodayDateString() {
  const now = new Date();
  const utc8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return utc8.toISOString().split('T')[0];
}

function getTaiwanNow() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

function getBillingMonth(date = new Date()) {
  const taiwanDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return taiwanDate.toISOString().slice(0, 7);
}

function getNextMonthDueDate() {
  const taiwanNow = getTaiwanNow();
  const year = taiwanNow.getUTCFullYear();
  const month = taiwanNow.getUTCMonth();
  const dueDate = new Date(Date.UTC(year, month + 1, 16));
  return dueDate.toISOString().slice(0, 10);
}

function getRarityEmoji(rarity) {
  switch (rarity) {
    case 'SSR':
      return '🌈';
    case 'SR':
      return '⭐';
    case 'R':
      return '🔹';
    default:
      return '📦';
  }
}

function isAdmin(interaction) {
  return (
    interaction.guild?.ownerId === interaction.user.id ||
    interaction.member?.permissions?.has('Administrator')
  );
}

function isAdminOrStaff(interaction) {
  const { STAFF_ROLE } = require('../config/environment');
  return (
    isAdmin(interaction) ||
    interaction.member?.roles?.cache?.has(STAFF_ROLE)
  );
}

module.exports = {
  getTodayDateString,
  getTaiwanNow,
  getBillingMonth,
  getNextMonthDueDate,
  getRarityEmoji,
  isAdmin,
  isAdminOrStaff,
};
