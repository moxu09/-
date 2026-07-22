function getGrowthVip(totalTopup, totalSpent, highestSingleTopup = 0) {
  void totalTopup;
  if (highestSingleTopup >= 75000 || totalSpent >= 75000) {
    return "vvip";
  }

  if (highestSingleTopup >= 50000 || totalSpent >= 50000) {
    return "vip_plus";
  }

  if (highestSingleTopup >= 18000 || totalSpent >= 18000) {
    return "vip";
  }

  return "none";
}

function getVipRoleId(vipLevel) {
  const roles = {
    small_light: process.env.SMALL_LIGHT_VIP_ROLE_ID,
    star_light: process.env.STAR_LIGHT_VIP_ROLE_ID,
    eternal_light: process.env.ETERNAL_LIGHT_VIP_ROLE_ID,
  };

  return roles[vipLevel];
}

function getGrowthVipRoleId(growthVip) {
  const roles = {
    vip: process.env.GROWTH_VIP_ROLE_ID,
    vip_plus: process.env.GROWTH_VIP_PLUS_ROLE_ID,
    vvip: process.env.GROWTH_VVIP_ROLE_ID,
  };

  return roles[growthVip];
}

module.exports = {
  getGrowthVip,
  getVipRoleId,
  getGrowthVipRoleId,
};
