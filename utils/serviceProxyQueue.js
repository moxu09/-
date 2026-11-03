const KINDS = new Set(['order', 'tip', 'crown', 'custom-tip', 'custom-crown']);
const REQUEST_ID = /^PROXY-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validPayload(row) {
  const p = row?.payload;
  return REQUEST_ID.test(String(row?.flow_id || '')) && p?.version === 1 &&
    /^\d{17,20}$/.test(String(p.actorId || '')) && /^\d{17,20}$/.test(String(p.userId || '')) &&
    KINDS.has(p.kind);
}

function createServiceProxyQueue({ db, client, organization, guildId, createTicket, logger = console }) {
  const scope = `${organization}:service-proxy`;
  const table = () => db.from('bot_service_order_flows');
  const scoped = (query, row) => query.eq('organization_code', scope).eq('flow_id', row.flow_id);
  let running = false;

  async function processRow(row) {
    const p = row.payload || {};
    const now = Date.now();
    if (p.nextAttemptAt > now || (p.status === 'processing' && p.leaseUntil > now)) return;
    const claimed = await scoped(table().update({
      payload: { ...p, status: 'processing', leaseUntil: now + 120000 }, revision: row.revision + 1,
      updated_at: new Date(now).toISOString(),
    }), row).eq('revision', row.revision).select('*').maybeSingle();
    if (claimed.error) throw claimed.error;
    if (!claimed.data) return;
    let result;
    try {
      if (!validPayload(row)) throw Error('invalid_proxy_request');
      const guild = await client.guilds.fetch(guildId);
      let member;
      try { member = await guild.members.fetch(p.userId); }
      catch (error) { if (Number(error.code) !== 10007) throw error; }
      if (!member || member.pending) {
        result = { ...p, status: 'waiting_member', nextAttemptAt: now + 30000 };
      } else {
        const created = await createTicket({ ...p, flowId: row.flow_id, guild, member });
        if (!/^\d{17,20}$/.test(String(created?.channelId || ''))) throw Error('proxy_channel_missing');
        result = { ...p, status: 'opened', channelId: created.channelId, openedAt: new Date().toISOString() };
      }
    } catch (error) {
      const attempts = Number(p.attempts || 0) + 1;
      logger.error('[客服代建單]', row.flow_id, String(error.message || error).slice(0, 120));
      result = { ...p, status: attempts >= 5 ? 'failed' : 'retry', attempts,
        nextAttemptAt: now + Math.min(300000, attempts * 15000) };
    }
    delete result.leaseUntil;
    const saved = await scoped(table().update({ payload: result, revision: row.revision + 2,
      updated_at: new Date().toISOString(),
      ...(result.status === 'opened' || result.status === 'failed' ? { closed_at: new Date().toISOString() } : {}),
    }), row).eq('revision', row.revision + 1);
    if (saved.error) throw saved.error;
  }

  async function run() {
    if (running) return;
    running = true;
    try {
      const { data, error } = await table().select('*').eq('organization_code', scope)
        .is('closed_at', null).gt('expires_at', new Date().toISOString())
        .in('payload->>status', ['queued', 'retry', 'waiting_member', 'processing'])
        .order('created_at').limit(20);
      if (error) throw error;
      for (const row of data || []) await processRow(row);
    } finally { running = false; }
  }

  function start() {
    const tick = () => void run().catch(error => logger.error('[客服代建單輪詢]', String(error.message || error)));
    const timer = setInterval(tick, 4000);
    timer.unref?.();
    tick();
    return timer;
  }
  return { run, start, processRow };
}

module.exports = { createServiceProxyQueue, validPayload };
