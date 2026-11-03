const test = require('node:test');
const assert = require('node:assert/strict');
const { createServiceProxyQueue, validPayload } = require('../utils/serviceProxyQueue');

const row = () => ({
  organization_code: 'deepnight:service-proxy',
  flow_id: 'PROXY-00000000-0000-4000-8000-000000000001', revision: 1,
  payload: { version: 1, status: 'queued', actorId: '973236155019579442',
    userId: '850005930250862640', kind: 'custom-tip', attempts: 0 },
});

function fakeDb(initial) {
  const state = { row: structuredClone(initial) };
  return { state, from() { return {
    patch: null, filters: [],
    update(patch) { this.patch = patch; return this; },
    select() { return this; },
    eq(key, value) { this.filters.push([key, value]); return this; },
    maybeSingle() { return Promise.resolve(this.resolve()); },
    resolve() {
      const matches = this.filters.every(([key, value]) => state.row[key] === value);
      if (!matches) return { data: null, error: null };
      if (this.patch) state.row = { ...state.row, ...this.patch };
      return { data: structuredClone(state.row), error: null };
    },
    then(done, fail) { return Promise.resolve(this.resolve()).then(done, fail); },
  }; } };
}

test('only a valid scoped proxy request can start a flow', () => {
  assert.equal(validPayload(row()), true);
  assert.equal(validPayload({ ...row(), flow_id: 'bad' }), false);
  assert.equal(validPayload({ ...row(), payload: { ...row().payload, kind: 'topup' } }), false);
});

test('revision claim prevents duplicate channel creation', async () => {
  const db = fakeDb(row()); let created = 0;
  const queue = createServiceProxyQueue({ db, organization: 'deepnight', guildId: '1501098191813214312',
    client: { guilds: { fetch: async () => ({ members: { fetch: async id => ({ id, pending: false }) } }) } },
    createTicket: async () => { created++; return { channelId: '1567208050954211500' }; } });
  const stale = structuredClone(db.state.row);
  await queue.processRow(stale);
  await queue.processRow(stale);
  assert.equal(created, 1);
  assert.equal(db.state.row.payload.status, 'opened');
  assert.equal(db.state.row.payload.actorId, stale.payload.actorId);
  assert.ok(db.state.row.closed_at);
});

test('unverified customer stays queued without creating a channel', async () => {
  const db = fakeDb(row()); let created = 0;
  const queue = createServiceProxyQueue({ db, organization: 'deepnight', guildId: '1501098191813214312',
    client: { guilds: { fetch: async () => ({ members: { fetch: async id => ({ id, pending: true }) } }) } },
    createTicket: async () => { created++; return { channelId: '1567208050954211500' }; } });
  await queue.processRow(structuredClone(db.state.row));
  assert.equal(created, 0);
  assert.equal(db.state.row.payload.status, 'waiting_member');
});
