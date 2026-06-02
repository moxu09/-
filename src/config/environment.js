// 环境变量管理
require('dotenv').config();

const config = {
  // Discord
  TOKEN: process.env.TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  GUILD_ID: process.env.GUILD_ID,

  // Supabase
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,

  // 频道配置
  CHANNEL_ID: process.env.CHANNEL_ID,
  CHECKIN_CHANNEL: process.env.CHECKIN_CHANNEL,
  GACHA_CHANNEL: process.env.GACHA_CHANNEL,
  SHOP_CHANNEL: process.env.SHOP_CHANNEL,
  ORDER_CHANNEL: process.env.ORDER_CHANNEL,
  STAFF_ROLE: process.env.STAFF_ROLE,
  STAFF_ROLE_ID: process.env.STAFF_ROLE_ID,
  ORDER_CATEGORY: process.env.ORDER_CATEGORY,
  PLAYER_CONTROL_CHANNEL: process.env.PLAYER_CONTROL_CHANNEL,
  PRIVATE_ROOM_PANEL_CHANNEL: process.env.PRIVATE_ROOM_PANEL_CHANNEL,
  PRIVATE_ROOM_CATEGORY: process.env.PRIVATE_ROOM_CATEGORY,
  ORDER_LOG_CHANNEL: process.env.ORDER_LOG_CHANNEL,
  TOPUP_LOG_CHANNEL: process.env.TOPUP_LOG_CHANNEL,

  // VIP 角色
  SMALL_LIGHT_VIP_ROLE_ID: process.env.SMALL_LIGHT_VIP_ROLE_ID,
  STAR_LIGHT_VIP_ROLE_ID: process.env.STAR_LIGHT_VIP_ROLE_ID,
  ETERNAL_LIGHT_VIP_ROLE_ID: process.env.ETERNAL_LIGHT_VIP_ROLE_ID,
  GROWTH_VIP_ROLE_ID: process.env.GROWTH_VIP_ROLE_ID,
  GROWTH_VIP_PLUS_ROLE_ID: process.env.GROWTH_VIP_PLUS_ROLE_ID,
  GROWTH_VVIP_ROLE_ID: process.env.GROWTH_VVIP_ROLE_ID,
  VIP_ROLE_IDS: (process.env.VIP_ROLE_IDS || '').split(',').map(id => id.trim()).filter(Boolean),
};

// 验证必需的环境变量
const required = [
  'TOKEN',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
];

for (const key of required) {
  if (!config[key]) {
    throw new Error(`缺少必需的环境变量: ${key}`);
  }
}

module.exports = config;
