const { getSupabase } = require('../config/supabase');
const logger = require('./logger');
const { withTimeout } = require('./errorHandler');

// 用户数据操作
const userDB = {
  async getUser(userId) {
    const { data, error } = await withTimeout(
      getSupabase()
        .from('users')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle(),
      5000,
      'USER_GET'
    );

    if (error && error.code !== 'PGRST116') {
      logger.error('USER_GET', `获取用户失败: ${userId}`, error);
      throw error;
    }

    if (!data) {
      const { error: insertError } = await withTimeout(
        getSupabase()
          .from('users')
          .insert([{ user_id: userId, coins: 0 }]),
        5000,
        'USER_CREATE'
      );

      if (insertError) {
        logger.error('USER_CREATE', `创建用户失败: ${userId}`, insertError);
      }

      return { user_id: userId, coins: 0, last_checkin: null };
    }

    return data;
  },

  async changeCoins(userId, amount) {
    const { data, error } = await withTimeout(
      getSupabase().rpc('change_user_coins', {
        p_user_id: userId,
        p_amount: amount,
      }),
      5000,
      'COIN_CHANGE'
    );

    if (error) {
      logger.error('COIN_CHANGE', `更改硬币失败: ${userId}`, error);
      throw new Error('无法更新硬币');
    }

    return Number(data || 0);
  },
};

// 钱包日志操作
const walletDB = {
  async addLog(userId, type, amount, balance, note = '') {
    if (amount === 0 && type !== '十抽') return;

    try {
      const { error } = await withTimeout(
        getSupabase().from('wallet_logs').insert({
          user_id: userId,
          type,
          amount,
          balance,
          note,
        }),
        5000,
        'WALLET_LOG'
      );

      if (error) {
        logger.warn('WALLET_LOG', `钱包日志写入失败: ${userId}`, error);
      }
    } catch (err) {
      logger.error('WALLET_LOG', '钱包日志操作异常', err);
    }
  },

  async getLogs(userId, limit = 15) {
    const { data, error } = await withTimeout(
      getSupabase()
        .from('wallet_logs')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit),
      5000,
      'WALLET_GET_LOGS'
    );

    if (error) {
      logger.warn('WALLET_GET_LOGS', `获取钱包日志失败: ${userId}`, error);
      return [];
    }

    return data || [];
  },
};

// 订单操作
const orderDB = {
  async getOrder(channelId) {
    const { data, error } = await withTimeout(
      getSupabase()
        .from('play_orders')
        .select('*')
        .eq('channel_id', channelId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      5000,
      'ORDER_GET'
    );

    if (error && error.code !== 'PGRST116') {
      logger.error('ORDER_GET', `获取订单失败: ${channelId}`, error);
    }

    return data || null;
  },

  async updateOrder(orderId, updates) {
    const { error } = await withTimeout(
      getSupabase()
        .from('play_orders')
        .update(updates)
        .eq('id', orderId),
      5000,
      'ORDER_UPDATE'
    );

    if (error) {
      logger.error('ORDER_UPDATE', `更新订单失败: ${orderId}`, error);
      throw error;
    }
  },
};

module.exports = {
  userDB,
  walletDB,
  orderDB,
};
