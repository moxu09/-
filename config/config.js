module.exports = {
  token: process.env.TOKEN,

  clientId: process.env.CLIENT_ID,

  guildId: process.env.GUILD_ID,

  supabaseUrl: process.env.SUPABASE_URL,

  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,

  channels: {
    atm: process.env.ATM_CHANNEL,

    checkin: process.env.CHECKIN_CHANNEL,

    gacha: process.env.GACHA_CHANNEL,

    shop: process.env.SHOP_CHANNEL,

    order: process.env.ORDER_CHANNEL,

    orderLogs: process.env.ORDER_LOG_CHANNEL,
  },

  categories: {
    order: process.env.ORDER_CATEGORY,
  },

  roles: {
    staff: process.env.STAFF_ROLE,
  },
};
