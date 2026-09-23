// 2026-09-28 00:00 Asia/Taipei.
const ECPAY_ATM_START = Date.parse("2026-09-27T16:00:00.000Z");

function isEcpayAtmAvailable(now = Date.now()) {
  return now >= ECPAY_ATM_START;
}

module.exports = { ECPAY_ATM_START, isEcpayAtmAvailable };
