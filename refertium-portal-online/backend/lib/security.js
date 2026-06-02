const crypto = require('crypto');

function id(prefix = 'id') {
  return prefix + '_' + crypto.randomBytes(10).toString('hex');
}

function proxyToken() {
  return 'rft_' + crypto.randomBytes(24).toString('hex');
}

function appSessionToken() {
  return 'app_' + crypto.randomBytes(24).toString('hex');
}

function cookie(name, value, options = {}) {
  const maxAge = options.maxAge == null ? 2592000 : Number(options.maxAge);
  const secure = options.secure !== false;
  const parts = [
    `${name}=${encodeURIComponent(value || '')}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/'
  ];
  if (secure) parts.push('Secure');
  if (maxAge != null) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

function clearCookie(name, options = {}) {
  return cookie(name, '', { ...options, maxAge: 0 });
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const storedHash = Buffer.from(hash, 'hex');
  return storedHash.length === candidate.length && crypto.timingSafeEqual(storedHash, candidate);
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';').map(v => v.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1));
    } catch {}
  }
  return out;
}

function loginLimitKey(req, login) {
  return crypto.createHash('sha256').update(`${clientIp(req)}:${String(login || '').toLowerCase()}`).digest('hex');
}

module.exports = {
  appSessionToken,
  clearCookie,
  clientIp,
  cookie,
  hashPassword,
  id,
  loginLimitKey,
  parseCookies,
  proxyToken,
  verifyPassword
};
