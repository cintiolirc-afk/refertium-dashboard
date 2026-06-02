const assert = require('node:assert/strict');
const test = require('node:test');
const {
  clearCookie,
  cookie,
  hashPassword,
  loginLimitKey,
  parseCookies,
  verifyPassword
} = require('../lib/security');

test('cookie uses secure http-only defaults', () => {
  const header = cookie('sid', 'abc 123', { maxAge: 60 });
  assert.equal(header, 'sid=abc%20123; HttpOnly; SameSite=Lax; Path=/; Secure; Max-Age=60');
});

test('cookie can disable secure only for local fallback', () => {
  const header = cookie('sid', 'abc', { secure: false });
  assert.equal(header.includes('Secure'), false);
});

test('clearCookie expires the cookie', () => {
  assert.equal(clearCookie('sid'), 'sid=; HttpOnly; SameSite=Lax; Path=/; Secure; Max-Age=0');
});

test('parseCookies ignores malformed values without throwing', () => {
  const parsed = parseCookies({
    headers: {
      cookie: 'good=value; broken=%E0%A4%A; noequals; encoded=a%20b'
    }
  });
  assert.deepEqual(parsed, { good: 'value', encoded: 'a b' });
});

test('password hash verifies valid password and rejects invalid or malformed hash', () => {
  const stored = hashPassword('correct', '00112233445566778899aabbccddeeff');
  assert.equal(verifyPassword('correct', stored), true);
  assert.equal(verifyPassword('wrong', stored), false);
  assert.equal(verifyPassword('correct', 'salt:not-hex'), false);
  assert.equal(verifyPassword('correct', ''), false);
});

test('loginLimitKey is normalized by login and scoped by client ip', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.1' }, socket: {} };
  assert.equal(loginLimitKey(req, 'Admin'), loginLimitKey(req, 'admin'));
  assert.notEqual(
    loginLimitKey(req, 'admin'),
    loginLimitKey({ headers: {}, socket: { remoteAddress: '198.51.100.20' } }, 'admin')
  );
});
