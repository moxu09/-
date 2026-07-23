const CHAT_DROP_PROBABILITY = 0.005;
const MIN_CHAT_DROP_REWARD = 1;
const MAX_CHAT_DROP_REWARD = 20;

function shouldCreateChatDrop(randomValue = Math.random()) {
  return (
    Number.isFinite(randomValue) &&
    randomValue >= 0 &&
    randomValue < CHAT_DROP_PROBABILITY
  );
}

function parseChatDropReward(customId) {
  const match = /^claim_(\d+)$/.exec(String(customId || ""));
  if (!match) return null;

  const reward = Number(match[1]);
  if (
    !Number.isInteger(reward) ||
    reward < MIN_CHAT_DROP_REWARD ||
    reward > MAX_CHAT_DROP_REWARD
  ) {
    return null;
  }

  return reward;
}

module.exports = {
  CHAT_DROP_PROBABILITY,
  MAX_CHAT_DROP_REWARD,
  MIN_CHAT_DROP_REWARD,
  parseChatDropReward,
  shouldCreateChatDrop,
};
