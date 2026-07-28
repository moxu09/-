function shouldPublishReview(rating) {
  const normalizedRating = Number(rating);
  return (
    Number.isInteger(normalizedRating) &&
    normalizedRating >= 4 &&
    normalizedRating <= 5
  );
}

function formatReviewCustomer(customerId, anonymous) {
  return anonymous ? "匿名" : `<@${customerId}>`;
}

module.exports = {
  formatReviewCustomer,
  shouldPublishReview,
};
