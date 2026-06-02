const { getSupabase } = require('../config/supabase');
const logger = require('./logger');
const { withTimeout } = require('./errorHandler');

/**
 * 錢包系統 - 所有金幣操作
 */
const walletSystem = {
  /**
   * 獲取使用者錢包
   */
  async getWallet(userId) {
    try {
      const { data, error } = await withTimeout(
        getSupabase()
          .from('users')
          .select('user_id, coins, created_at')
          .eq('user_id', userId)
          .maybeSingle(),
        5000,
        'WALLET_GET'
      );

      if (error && error.code !== 'PGRST116') {
        throw error;
      }

      if (!data) {
        const { error: insertError } = await withTimeout(
          getSupabase()
            .from('users')
            .insert([{ user_id: userId, coins: 0 }]),
          5000,
          'WALLET_CREATE'
        );

        if (insertError) {
          logger.error('WALLET', '建立使用者失敗', insertError);
        }

        return { user_id: userId, coins: 0, created_at: new Date().toISOString() };
      }

      return data;
    } catch (err) {
      logger.error('WALLET_GET', '獲取錢包失敗', err);
      throw err;
    }
  },

  /**
   * 增加或減少金幣
   */
  async changeCoins(userId, amount, reason = '') {
    try {
      const wallet = await this.getWallet(userId);
      const newBalance = wallet.coins + amount;

      if (newBalance < 0) {
        throw new Error('餘額不足');
      }

      const { error } = await withTimeout(
        getSupabase()
          .from('users')
          .update({ coins: newBalance })
          .eq('user_id', userId),
        5000,
        'COIN_CHANGE'
      );

      if (error) {
        throw error;
      }

      // 記錄交易
      await this.addWalletLog(userId, amount > 0 ? '入帳' : '出帳', Math.abs(amount), newBalance, reason);

      logger.debug('WALLET', `使用者 ${userId} 金幣變更: ${amount} (現餘額: ${newBalance})`);
      return newBalance;
    } catch (err) {
      logger.error('WALLET_CHANGE', '金幣變更失敗', err);
      throw err;
    }
  },

  /**
   * 轉帳
   */
  async transfer(fromUserId, toUserId, amount, reason = '') {
    try {
      if (amount <= 0) {
        throw new Error('轉帳金額必須大於 0');
      }

      const fromWallet = await this.getWallet(fromUserId);
      if (fromWallet.coins < amount) {
        throw new Error('餘額不足');
      }

      // 扣除轉帳人
      await this.changeCoins(fromUserId, -amount, `轉帳給 <@${toUserId}>`);
      // 增加接收人
      await this.changeCoins(toUserId, amount, `從 <@${fromUserId}> 接收轉帳`);

      logger.success('WALLET', `轉帳成功: ${fromUserId} -> ${toUserId} = ${amount}`);
      return true;
    } catch (err) {
      logger.error('WALLET_TRANSFER', '轉帳失敗', err);
      throw err;
    }
  },

  /**
   * 記錄錢包交易
   */
  async addWalletLog(userId, type, amount, balance, note = '') {
    try {
      const { error } = await withTimeout(
        getSupabase()
          .from('wallet_logs')
          .insert({
            user_id: userId,
            type,
            amount,
            balance,
            note,
            created_at: new Date().toISOString(),
          }),
        5000,
        'WALLET_LOG_ADD'
      );

      if (error) {
        logger.warn('WALLET_LOG', '記錄失敗', error);
      }
    } catch (err) {
      logger.error('WALLET_LOG', '記錄異常', err);
    }
  },

  /**
   * 獲取錢包交易記錄
   */
  async getWalletLogs(userId, limit = 15) {
    try {
      const { data, error } = await withTimeout(
        getSupabase()
          .from('wallet_logs')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(limit),
        5000,
        'WALLET_LOGS_GET'
      );

      if (error) {
        logger.warn('WALLET_LOGS', '獲取記錄失敗', error);
        return [];
      }

      return data || [];
    } catch (err) {
      logger.error('WALLET_LOGS', '記錄查詢異常', err);
      return [];
    }
  },

  /**
   * 充值金幣
   */
  async topup(userId, amount, method = 'manual') {
    try {
      if (amount <= 0) {
        throw new Error('充值金額必須大於 0');
      }

      const newBalance = await this.changeCoins(userId, amount, `充值 - ${method}`);
      logger.success('WALLET', `充值成功: ${userId} 充值 ${amount}`);
      return newBalance;
    } catch (err) {
      logger.error('WALLET_TOPUP', '充值失敗', err);
      throw err;
    }
  },
};

module.exports = walletSystem;