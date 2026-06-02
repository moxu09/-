const { TTLMap } = require('./queue');
const logger = require('./logger');

/**
 * 全局缓存管理 - 减少 Supabase 查询
 */
class CacheManager {
  constructor() {
    // 用户数据缓存 (30分钟)
    this.users = new TTLMap(30 * 60 * 1000, 5000);
    // 订单缓存 (10分钟)
    this.orders = new TTLMap(10 * 60 * 1000, 1000);
    // 商店缓存 (1小时)
    this.shop = new TTLMap(60 * 60 * 1000, 100);
    // VIP 缓存 (15分钟)
    this.vip = new TTLMap(15 * 60 * 1000, 5000);
  }

  getStats() {
    return {
      users: this.users.size(),
      orders: this.orders.size(),
      shop: this.shop.size(),
      vip: this.vip.size(),
    };
  }

  clear() {
    this.users.clear();
    this.orders.clear();
    this.shop.clear();
    this.vip.clear();
    logger.info('CACHE', '所有缓存已清空');
  }
}

const cache = new CacheManager();

module.exports = cache;
