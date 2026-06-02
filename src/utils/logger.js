const fs = require('fs');
const path = require('path');

// 确保日志目录存在
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function getLogFile() {
  const date = new Date().toISOString().split('T')[0];
  return path.join(logsDir, `${date}.log`);
}

function writeToFile(message) {
  const logFile = getLogFile();
  fs.appendFileSync(logFile, message + '\n', 'utf8');
}

const logger = {
  info: (tag, message) => {
    const log = `[${getTimestamp()}] ${colors.blue}[${tag}]${colors.reset} ${message}`;
    console.log(log);
    writeToFile(`[${getTimestamp()}] [${tag}] ${message}`);
  },

  success: (tag, message) => {
    const log = `[${getTimestamp()}] ${colors.green}[${tag}]${colors.reset} ✅ ${message}`;
    console.log(log);
    writeToFile(`[${getTimestamp()}] [${tag}] ✅ ${message}`);
  },

  warn: (tag, message) => {
    const log = `[${getTimestamp()}] ${colors.yellow}[${tag}]${colors.reset} ⚠️  ${message}`;
    console.warn(log);
    writeToFile(`[${getTimestamp()}] [${tag}] ⚠️  ${message}`);
  },

  error: (tag, message, error = null) => {
    const errorMsg = error ? `${message}\n${error.stack || error}` : message;
    const log = `[${getTimestamp()}] ${colors.red}[${tag}]${colors.reset} ❌ ${errorMsg}`;
    console.error(log);
    writeToFile(`[${getTimestamp()}] [${tag}] ❌ ${errorMsg}`);
  },

  debug: (tag, message) => {
    if (process.env.DEBUG) {
      const log = `[${getTimestamp()}] ${colors.cyan}[${tag}]${colors.reset} 🔍 ${message}`;
      console.log(log);
    }
    writeToFile(`[${getTimestamp()}] [${tag}] 🔍 ${message}`);
  },
};

module.exports = logger;
