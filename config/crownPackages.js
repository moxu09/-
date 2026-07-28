const packages = [
  ["crown_half_day", "半日冠", 1899, 6, 12],
  ["crown_one_day", "一日冠", 3999, 12, 24],
  ["crown_three_days", "三日冠", 12888, 36, 72],
  ["crown_week", "周冠名", 26666, 84, 168],
  ["crown_month", "月冠名", 188888, 336, 720],
  ["crown_custom", "自定冠", null, null, null, true],
];

module.exports = packages.map(
  ([key, name, price, giftedHours, durationHours, custom]) => ({
    key,
    name,
    price,
    giftedHours,
    durationHours,
    custom: Boolean(custom),
  }),
);
