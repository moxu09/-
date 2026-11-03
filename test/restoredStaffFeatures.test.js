const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDuration } = require('../utils/timedRoles');
const { isGachaPrize, isIchibanPrize } = require('../utils/prizeRedemption');
const { createServiceGiftCatalog } = require('../utils/serviceGiftCatalog.cjs');

test('限時身分組支援混合時分秒，拒絕重複或無效單位', () => {
  assert.equal(parseDuration('1h12m').ms, 4_320_000);
  assert.equal(parseDuration('2m30s').ms, 150_000);
  assert.equal(parseDuration('45s').ms, 45_000);
  for (const value of ['1h1h', '0s', '12', '1d', '1h-1m'])
    assert.equal(parseDuration(value), null);
});

test('獎品核銷只列入扭蛋禮券與一番賞實際獎品', () => {
  assert.equal(isGachaPrize({ item_type: 'gacha' }), true);
  assert.equal(isGachaPrize({ item_type: 'coupon', item_name: '實體禮券', rarity: 'SR' }), true);
  assert.equal(isGachaPrize({ item_type: 'coupon', item_name: '85折券', rarity: 'SR' }), false);
  assert.equal(isIchibanPrize({ prize_id: 'a-asd-50', is_last_one: false }), false);
  assert.equal(isIchibanPrize({ prize_id: 'prize-id', is_last_one: false }), true);
});

test('客服禮物目錄只接受機器人憑證讀取', async () => {
  const catalog = createServiceGiftCatalog({ organization: 'deepnight',
    tipGifts: [{ key: 'gift', name: '禮物', price: 50 }], token: 'test-token' });
  async function request(authorization) {
    const result = { headers: {}, setHeader(name, value) { this.headers[name] = value; },
      end(body) { this.body = JSON.parse(body); } };
    const handled = await catalog.handleHttpRequest({ method: 'GET', url: '/service-gifts',
      headers: { authorization } }, result);
    assert.equal(handled, true);
    return result;
  }
  assert.equal((await request('Bearer wrong')).statusCode, 401);
  const allowed = await request('Bearer test-token');
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.body.regular[0].name, '禮物');
});
