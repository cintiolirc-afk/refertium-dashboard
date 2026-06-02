const assert = require('node:assert/strict');
const test = require('node:test');
const {
  checkoutSessionParams,
  normalizePaymentAmount,
  paymentMonthKey,
  signedPaymentUrl,
  stripeUnitAmount
} = require('../lib/payments');

test('paymentMonthKey returns yyyy-mm', () => {
  assert.equal(paymentMonthKey(new Date('2026-06-15T12:00:00.000Z')), '2026-06');
});

test('normalizePaymentAmount rejects non-positive and non-numeric values', () => {
  assert.equal(normalizePaymentAmount('123.45'), 123.45);
  assert.throws(() => normalizePaymentAmount(0), /Prezzo mensile/);
  assert.throws(() => normalizePaymentAmount(-1), /Prezzo mensile/);
  assert.throws(() => normalizePaymentAmount('abc'), /Prezzo mensile/);
});

test('stripeUnitAmount converts euros to cents', () => {
  assert.equal(stripeUnitAmount(123.45), 12345);
  assert.equal(stripeUnitAmount(10), 1000);
});

test('signedPaymentUrl includes user month amount ref and signature', () => {
  const url = signedPaymentUrl({
    baseUrl: 'https://pay.example.test/',
    userId: 'user 1',
    month: '2026-06',
    amount: 99,
    linkId: 'pay_1',
    secret: 'secret'
  });
  assert.match(url, /^https:\/\/pay\.example\.test\?/);
  assert.match(url, /user=user%201/);
  assert.match(url, /month=2026-06/);
  assert.match(url, /amount=99\.00/);
  assert.match(url, /ref=pay_1/);
  assert.match(url, /sig=[a-f0-9]{24}/);
});

test('checkoutSessionParams embeds arbitrary amount and user metadata', () => {
  const params = checkoutSessionParams({
    user: { id: 'user_1', email: 'doctor@example.test', name: 'Dr Test' },
    payment: { linkId: 'pay_1', month: '2026-06', amount: 77.77 },
    currency: 'eur',
    publicBaseUrl: 'https://app.example.test'
  });
  assert.equal(params.mode, 'payment');
  assert.equal(params.customer_email, 'doctor@example.test');
  assert.equal(params.line_items[0].price_data.unit_amount, 7777);
  assert.equal(params.line_items[0].price_data.currency, 'eur');
  assert.deepEqual(params.metadata, {
    refertiumPaymentId: 'pay_1',
    userId: 'user_1',
    month: '2026-06'
  });
});
