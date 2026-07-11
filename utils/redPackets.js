function getRedPacketModeLabel(mode) {
  return mode === "average" ? "平均分" : "隨機分";
}

function normalizeRedPacketMode(mode) {
  return mode === "average" ? "average" : "random";
}

function randomInt(min, max) {
  const lower = Math.ceil(min);
  const upper = Math.floor(max);
  if (upper <= lower) return lower;
  return lower + Math.floor(Math.random() * (upper - lower + 1));
}

function shuffleNumbers(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function buildAverageRedPacketShares(totalAmount, totalCount) {
  const base = Math.floor(totalAmount / totalCount);
  const remainder = totalAmount % totalCount;
  return shuffleNumbers(
    Array.from(
      { length: totalCount },
      (_, index) => base + (index < remainder ? 1 : 0)
    )
  );
}

function buildRandomRedPacketShares(totalAmount, totalCount) {
  const average = totalAmount / totalCount;
  const minShare = Math.max(1, Math.floor(average * 0.8));
  const maxShare = Math.max(minShare, Math.ceil(average * 1.2));
  const shares = [];
  let remaining = totalAmount;

  for (let index = 0; index < totalCount; index += 1) {
    const remainingSlots = totalCount - index - 1;
    if (remainingSlots === 0) {
      shares.push(remaining);
      break;
    }
    const minAllowed = Math.max(
      minShare,
      remaining - maxShare * remainingSlots
    );
    const maxAllowed = Math.min(
      maxShare,
      remaining - minShare * remainingSlots
    );
    shares.push(randomInt(minAllowed, maxAllowed));
    remaining -= shares[shares.length - 1];
  }

  return shuffleNumbers(shares);
}

function buildRedPacketShares(totalAmount, totalCount, mode) {
  return mode === "average"
    ? buildAverageRedPacketShares(totalAmount, totalCount)
    : buildRandomRedPacketShares(totalAmount, totalCount);
}

function getPendingRedPacketUserId(packetId, index) {
  return `__pending_red_packet_${packetId}_${index}`;
}

function getPendingRedPacketPrefix(packetId) {
  return `__pending_red_packet_${packetId}_`;
}

module.exports = {
  buildAverageRedPacketShares,
  buildRandomRedPacketShares,
  buildRedPacketShares,
  getPendingRedPacketPrefix,
  getPendingRedPacketUserId,
  getRedPacketModeLabel,
  normalizeRedPacketMode,
};
