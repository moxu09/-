const http = require("node:http");

function validateEnvironment(env, requiredNames) {
  const missing = requiredNames.filter(
    (name) => typeof env[name] !== "string" || env[name].trim() === "",
  );

  if (missing.length) {
    throw new Error(`缺少必要環境變數：${missing.join(", ")}`);
  }
}

function createHealthState(serviceName) {
  const startedAt = new Date().toISOString();
  const failures = [];
  let ready = false;

  return {
    addFailure(name, error) {
      failures.push({
        name,
        message: String(error?.message || error || "未知錯誤").slice(0, 300),
        at: new Date().toISOString(),
      });
      if (failures.length > 20) failures.shift();
    },
    markReady() {
      ready = true;
    },
    snapshot() {
      return {
        service: serviceName,
        status: ready ? (failures.length ? "degraded" : "ready") : "starting",
        ready,
        startedAt,
        uptimeSeconds: Math.floor(process.uptime()),
        startupFailureCount: failures.length,
        startupFailures: failures.map(({ name, at }) => ({ name, at })),
      };
    },
  };
}

function createHealthServer(healthState, options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  const host = options.host || "0.0.0.0";

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("PORT 必須是 1 到 65535 的整數");
  }

  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    const snapshot = healthState.snapshot();

    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");

    if (pathname === "/health") {
      response.statusCode = 200;
      response.end(JSON.stringify({ ...snapshot, alive: true }));
      return;
    }

    if (pathname === "/ready") {
      response.statusCode = snapshot.ready ? 200 : 503;
      response.end(JSON.stringify(snapshot));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });

  server.on("error", (error) => {
    console.error("[RUNTIME] 健康檢查服務錯誤", error);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 6000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  server.listen(port, host, () => {
    console.log(`[RUNTIME] 健康檢查已啟動於 ${host}:${port}`);
  });

  return server;
}

async function runStartupTask(name, task, healthState) {
  try {
    await task();
    console.log(`[STARTUP] ${name} 完成`);
    return true;
  } catch (error) {
    healthState.addFailure(name, error);
    console.error(`[STARTUP] ${name} 失敗`, error);
    return false;
  }
}

function createNonOverlappingTask(name, task) {
  let running = false;

  return async (...args) => {
    if (running) {
      console.warn(`[SCHEDULER] ${name} 前一輪尚未完成，已略過本輪`);
      return;
    }

    running = true;
    try {
      await task(...args);
    } catch (error) {
      console.error(`[SCHEDULER] ${name} 執行失敗`, error);
    } finally {
      running = false;
    }
  };
}

function createTtlSet(ttlMs, maxSize = 50000) {
  const values = new Map();

  function prune(now = Date.now()) {
    for (const [value, expiresAt] of values) {
      if (expiresAt > now && values.size <= maxSize) break;
      values.delete(value);
    }
  }

  return {
    add(value) {
      const now = Date.now();
      prune(now);
      if (values.has(value) && values.get(value) > now) return false;
      values.set(value, now + ttlMs);
      return true;
    },
    delete(value) {
      return values.delete(value);
    },
    get size() {
      prune();
      return values.size;
    },
  };
}

function scheduleMapExpiry(map, key, expectedValue, ttlMs) {
  const timer = setTimeout(() => {
    if (map.get(key) === expectedValue) map.delete(key);
  }, ttlMs);
  timer.unref?.();
  return timer;
}

function installProcessHandlers({ client, server, healthState }) {
  let shuttingDown = false;

  const shutdown = async (reason, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[RUNTIME] 開始安全關機：${reason}`);

    const forceExitTimer = setTimeout(() => process.exit(exitCode || 1), 10000);
    forceExitTimer.unref?.();

    try {
      client.destroy();
      await new Promise((resolve) => {
        if (!server?.listening) return resolve();
        server.close(resolve);
      });
    } catch (error) {
      console.error("[RUNTIME] 關機清理失敗", error);
      exitCode = exitCode || 1;
    } finally {
      clearTimeout(forceExitTimer);
      process.exit(exitCode);
    }
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("uncaughtException", (error) => {
    console.error("[RUNTIME] 未捕捉例外", error);
    healthState.addFailure("uncaughtException", error);
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (error) => {
    console.error("[RUNTIME] 未處理 Promise 拒絕", error);
    healthState.addFailure("unhandledRejection", error);
  });

  return shutdown;
}

module.exports = {
  createHealthServer,
  createHealthState,
  createNonOverlappingTask,
  createTtlSet,
  installProcessHandlers,
  runStartupTask,
  scheduleMapExpiry,
  validateEnvironment,
};
