const { createClient } = require('@supabase/supabase-js');
const config = require('./environment');

let supabaseInstance = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 5000; // 5秒

function createSupabaseClient() {
  return createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    db: { schema: 'public' },
    realtime: {
      params: { eventsPerSecond: 10 },
    },
  });
}

function getSupabase() {
  if (!supabaseInstance) {
    supabaseInstance = createSupabaseClient();
  }
  return supabaseInstance;
}

async function reconnectSupabase() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('[Supabase] 重连次数已达上限，请检查网络连接');
    process.exit(1);
  }

  reconnectAttempts++;
  console.log(`[Supabase] 尝试重新连接 (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

  try {
    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));
    supabaseInstance = createSupabaseClient();
    reconnectAttempts = 0;
    console.log('[Supabase] 重新连接成功');
    return true;
  } catch (err) {
    console.error('[Supabase] 重新连接失败:', err.message);
    return false;
  }
}

// 监听连接错误
function setupErrorHandling() {
  const supabase = getSupabase();

  supabase.on('SIGNED_OUT', async () => {
    console.warn('[Supabase] 连接已断开，尝试重新连接...');
    await reconnectSupabase();
  });
}

module.exports = {
  getSupabase,
  reconnectSupabase,
  setupErrorHandling,
};
