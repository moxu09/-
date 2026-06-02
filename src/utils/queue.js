const logger = require('./logger');

/**
 * 事件队列 - 防止事件堆积导致机器人卡顿
 */
class EventQueue {
  constructor(maxConcurrent = 5) {
    this.queue = [];
    this.running = 0;
    this.maxConcurrent = maxConcurrent;
    this.totalProcessed = 0;
    this.totalErrors = 0;
  }

  async add(task, priority = 0) {
    this.queue.push({ task, priority });
    // 优先级排序
    this.queue.sort((a, b) => b.priority - a.priority);
    this.process();
  }

  async process() {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      this.running++;
      const { task } = this.queue.shift();

      try {
        await task();
        this.totalProcessed++;
      } catch (err) {
        this.totalErrors++;
        logger.error('QUEUE', '队列任务执行失败', err);
      }

      this.running--;
      this.process();
    }
  }

  getStats() {
    return {
      queued: this.queue.length,
      running: this.running,
      totalProcessed: this.totalProcessed,
      totalErrors: this.totalErrors,
    };
  }
}

/**
 * 内存安全的 Map - 自动清理过期数据
 */
class TTLMap {
  constructor(defaultTTL = 30 * 60 * 1000, maxSize = 1000) {
    this.map = new Map();
    this.ttls = new Map();
    this.defaultTTL = defaultTTL;
    this.maxSize = maxSize;
  }

  set(key, value, ttl = this.defaultTTL) {
    // 超过最大容量，删除最旧的
    if (this.map.size >= this.maxSize) {
      const firstKey = this.map.keys().next().value;
      this.delete(firstKey);
    }

    this.map.set(key, value);

    // 清理旧的超时
    if (this.ttls.has(key)) {
      clearTimeout(this.ttls.get(key));
    }

    // 设置新的超时
    const timeout = setTimeout(() => this.delete(key), ttl);
    this.ttls.set(key, timeout);
  }

  get(key) {
    return this.map.get(key);
  }

  has(key) {
    return this.map.has(key);
  }

  delete(key) {
    this.map.delete(key);
    if (this.ttls.has(key)) {
      clearTimeout(this.ttls.get(key));
      this.ttls.delete(key);
    }
  }

  clear() {
    for (const timeout of this.ttls.values()) {
      clearTimeout(timeout);
    }
    this.map.clear();
    this.ttls.clear();
  }

  size() {
    return this.map.size;
  }
}

module.exports = {
  EventQueue,
  TTLMap,
};
