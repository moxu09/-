const logger = require('./logger');

class TimeoutError extends Error {
  constructor(message = '操作超时') {
    super(message);
    this.name = 'TimeoutError';
  }
}

// Promise 超时封装
async function withTimeout(promise, timeoutMs = 5000, tag = 'OPERATION') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new TimeoutError(`操作在 ${timeoutMs}ms 内未完成`)),
        timeoutMs
      )
    ),
  ]).catch(err => {
    if (err instanceof TimeoutError) {
      logger.warn(tag, err.message);
    }
    throw err;
  });
}

// 安全的交互回复
async function safeReply(interaction, options, tag = 'INTERACTION') {
  try {
    if (!interaction.isRepliable?.()) {
      logger.warn(tag, '交互不可回复');
      return;
    }

    const opts = { ...options };
    if (opts.ephemeral) {
      opts.flags = 64;
      delete opts.ephemeral;
    }

    if (interaction.deferred && !interaction.replied) {
      return await withTimeout(
        interaction.editReply(opts),
        5000,
        tag
      );
    }

    if (interaction.replied) {
      return await withTimeout(
        interaction.followUp(opts),
        5000,
        tag
      );
    }

    return await withTimeout(
      interaction.reply(opts),
      5000,
      tag
    );
  } catch (err) {
    logger.error(tag, '回复交互失败', err);
  }
}

// 错误格式化
function formatError(error) {
  if (error instanceof TimeoutError) {
    return '操作超时，请稍后重试';
  }

  if (error.message?.includes('餘額')) {
    return '余额不足';
  }

  if (error.message?.includes('找不到')) {
    return '数据未找到';
  }

  if (error.message?.includes('權限')) {
    return '权限不足';
  }

  return error.message || '系统错误';
}

// 全局错误处理
function setupGlobalErrorHandling(client) {
  process.on('unhandledRejection', async (reason, promise) => {
    logger.error('UNHANDLED_REJECTION', '未处理的 Promise 拒绝', reason);
  });

  process.on('uncaughtException', async (error) => {
    logger.error('UNCAUGHT_EXCEPTION', '未捕获的异常', error);
    process.exit(1);
  });
}

module.exports = {
  TimeoutError,
  withTimeout,
  safeReply,
  formatError,
  setupGlobalErrorHandling,
};
