const { runStartupTask } = require("../utils/runtime");

async function runStartupGroup(
  tasks,
  { concurrency = 3, healthState, runner = runStartupTask } = {},
) {
  if (!Array.isArray(tasks)) throw new TypeError("tasks 必須是陣列");
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency 必須是大於 0 的整數");
  }

  const startedAt = Date.now();
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      const task = tasks[index];
      results[index] = await runner(task.name, task.run, healthState);
    }
  }

  const workerCount = Math.min(concurrency, Math.max(tasks.length, 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return {
    elapsedMs: Date.now() - startedAt,
    succeeded: results.filter(Boolean).length,
    failed: results.filter((result) => result === false).length,
    total: tasks.length,
  };
}

module.exports = { runStartupGroup };
