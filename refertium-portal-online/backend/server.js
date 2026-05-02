const http = require('http');
const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || process.env.REFERTIUM_PORT || 47825);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const REFERTIUM_PROXY_MODE = process.env.REFERTIUM_PROXY_MODE || 'cloudflare';
const CLOUDFLARE_PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://refertium-api.cintioli-rc.workers.dev';
const CLOUDFLARE_PROXY_AUTH = process.env.CLOUDFLARE_PROXY_AUTH || 'refertium-sec-2026';
const WORKER_SHARED_SECRET = process.env.WORKER_SHARED_SECRET || 'refertium-worker-secret-dev';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const COOKIE = 'refertium_sid';
const APP_USER_COOKIE = 'refertium_app_user';
const sessions = new Map();

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

function id(prefix = 'id') {
  return prefix + '_' + crypto.randomBytes(10).toString('hex');
}

function proxyToken() {
  return 'rft_' + crypto.randomBytes(24).toString('hex');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(String(password), salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), candidate);
}

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

async function loadDb() {
  await ensureDirs();
  try {
    const db = JSON.parse(await fs.readFile(DB_FILE, 'utf8'));
    const changed = normalizeDb(db);
    if (changed) await saveDb(db);
    return db;
  } catch {
    const now = new Date().toISOString();
    const db = {
      users: [
        {
          id: 'admin-demo',
          role: 'admin',
          name: 'Admin Refertium',
          username: 'admin',
          email: 'admin@refertium.local',
          passwordHash: hashPassword('refertium-admin'),
          license: 'active',
          tokenLimit: 0,
          htmlFile: '',
          htmlName: '',
          usage: {},
          createdAt: now,
          updatedAt: now
        },
        {
          id: 'demo-user',
          role: 'user',
          name: 'Dr. Demo',
          username: 'demo',
          email: 'demo@refertium.local',
          passwordHash: hashPassword('demo123'),
          license: 'active',
          tokenLimit: 600000,
          proxyToken: proxyToken(),
          htmlFile: '',
          htmlName: '',
          usage: {},
          createdAt: now,
          updatedAt: now
        }
      ]
    };
    await saveDb(db);
    return db;
  }
}

function normalizeDb(db) {
  let changed = false;
  db.users = Array.isArray(db.users) ? db.users : [];
  for (const user of db.users) {
    if (!user.username) {
      user.username = user.email ? String(user.email).split('@')[0] : user.id;
      changed = true;
    }
    if (user.role === 'user' && !user.proxyToken) {
      user.proxyToken = proxyToken();
      changed = true;
    }
    if (!user.usage) {
      user.usage = {};
      changed = true;
    }
  }
  return changed;
}

async function saveDb(db) {
  await ensureDirs();
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

function publicUser(user) {
  const session = sessionInfo(user.id);
  return {
    id: user.id,
    role: user.role,
    name: user.name,
    username: user.username || '',
    email: user.email,
    license: user.license,
    tokenLimit: Number(user.tokenLimit || 0),
    proxyToken: user.proxyToken || '',
    htmlName: user.htmlName || '',
    hasHtml: Boolean(user.htmlFile),
    usage: user.usage || {},
    online: session.online,
    lastSeenAt: session.lastSeenAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function sessionInfo(userId) {
  const now = Date.now();
  let lastSeen = 0;
  for (const session of sessions.values()) {
    if (session.userId === userId) lastSeen = Math.max(lastSeen, session.lastSeen || session.createdAt || 0);
  }
  return {
    online: Boolean(lastSeen && now - lastSeen < 5 * 60 * 1000),
    lastSeenAt: lastSeen ? new Date(lastSeen).toISOString() : ''
  };
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(raw.split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf('=');
    return [decodeURIComponent(v.slice(0, i)), decodeURIComponent(v.slice(i + 1))];
  }));
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { ...jsonHeaders, ...headers });
  res.end(payload);
}

function sendNoContent(res) {
  res.writeHead(204);
  res.end();
}

async function readBody(req, limit = 25 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Payload troppo grande'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

async function currentUser(req, db) {
  const sid = parseCookies(req)[COOKIE];
  const session = sid && sessions.get(sid);
  if (!session) return null;
  session.lastSeen = Date.now();
  return db.users.find(u => u.id === session.userId) || null;
}

function requireAuth(user) {
  if (!user) throw Object.assign(new Error('Non autenticato'), { status: 401 });
}

function requireAdmin(user) {
  requireAuth(user);
  if (user.role !== 'admin') throw Object.assign(new Error('Permesso negato'), { status: 403 });
}

function getMonthlyUsage(user) {
  user.usage = user.usage || {};
  const key = monthKey();
  user.usage[key] = user.usage[key] || { total: 0, events: [] };
  return user.usage[key];
}

function isOverLimit(user) {
  const limit = Number(user.tokenLimit || 0);
  return limit > 0 && getMonthlyUsage(user).total >= limit;
}

async function serveStatic(req, res, pathname) {
  const file = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
  const resolved = path.resolve(file);
  if (!resolved.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  try {
    const data = await fs.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' ? 'application/javascript; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

async function serveUserApp(req, res, db, user, targetUserId) {
  requireAuth(user);
  const target = user.role === 'admin' ? db.users.find(u => u.id === targetUserId) : user;
  if (!target || target.role !== 'user') return send(res, 404, { error: 'Utente non trovato' });
  if (target.license === 'blocked') return send(res, 403, pageMessage('Licenza bloccata', 'Accesso sospeso. Contatta il supporto Refertium.'), { 'content-type': 'text/html; charset=utf-8' });
  if (isOverLimit(target)) return send(res, 402, pageMessage('Limite token raggiunto', 'Il limite mensile e stato raggiunto.'), { 'content-type': 'text/html; charset=utf-8' });
  if (!target.htmlFile) return send(res, 404, pageMessage('App non caricata', 'L admin deve caricare l HTML personalizzato per questo utente.'), { 'content-type': 'text/html; charset=utf-8' });
  const htmlPath = path.join(UPLOAD_DIR, target.htmlFile);
  const html = injectLicenseGuard(await fs.readFile(htmlPath, 'utf8'), target);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'set-cookie': `${APP_USER_COOKIE}=${encodeURIComponent(target.id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`
  });
  res.end(html);
}

function injectLicenseGuard(html, user) {
  const guard = `<script>
(function(){
  var USER_ID=${JSON.stringify(user.id)};
  var CHECK_MS=30000;
  var overlay;
  function block(message){
    if(!overlay){
      overlay=document.createElement('div');
      overlay.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#050505;color:#ebe2cc;display:flex;align-items:center;justify-content:center;font-family:Inter,-apple-system,BlinkMacSystemFont,Segoe UI,system-ui,sans-serif;padding:24px;text-align:center;';
      overlay.innerHTML='<div style="max-width:520px;border:1px solid rgba(235,226,204,.18);background:#101010;border-radius:8px;padding:28px"><h1 style="margin:0 0 10px;font-size:26px">Licenza non attiva</h1><p id="refertiumLicenseMsg" style="margin:0;color:#aaa;line-height:1.55"></p></div>';
      document.documentElement.appendChild(overlay);
    }
    var msg=document.getElementById('refertiumLicenseMsg');
    if(msg) msg.textContent=message||'La licenza Refertium non e piu attiva. Contatta l amministratore.';
  }
  async function check(){
    try{
      var r=await fetch('/api/license-status?userId='+encodeURIComponent(USER_ID),{credentials:'same-origin',cache:'no-store'});
      if(!r.ok){ block('Sessione scaduta o accesso non autorizzato. Rientra dal portale Refertium.'); return; }
      var data=await r.json();
      if(!data.allowed) block(data.message||'La licenza Refertium non e piu attiva.');
    }catch(e){}
  }
  check();
  setInterval(check,CHECK_MS);
  document.addEventListener('visibilitychange',function(){ if(!document.hidden) check(); });
  window.addEventListener('focus',check);
})();
</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => m + guard);
  return guard + html;
}

function pageMessage(title, text) {
  return `<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body style="margin:0;background:#050505;color:#ebe2cc;font:16px system-ui;display:grid;place-items:center;min-height:100vh"><main style="max-width:520px;border:1px solid rgba(235,226,204,.18);padding:28px;border-radius:8px;background:#101010"><h1>${escapeHtml(title)}</h1><p style="color:#999">${escapeHtml(text)}</p></main></body></html>`;
}

function rewriteRefertiumHtml(html, user) {
  if (REFERTIUM_PROXY_MODE === 'local') {
    html = html.replace(/const\s+PROXY_URL\s*=\s*['"][^'"]*['"]\s*;/, "const PROXY_URL = window.location.origin;");
    html = html.replace(/const\s+PROXY_AUTH\s*=\s*['"][^'"]*['"]\s*;/, "const PROXY_AUTH = 'session';");
  } else {
    html = html.replace(/const\s+PROXY_URL\s*=\s*['"][^'"]*['"]\s*;/, `const PROXY_URL = ${JSON.stringify(CLOUDFLARE_PROXY_URL)};`);
    html = html.replace(/const\s+PROXY_AUTH\s*=\s*['"][^'"]*['"]\s*;/, `const PROXY_AUTH = ${JSON.stringify(CLOUDFLARE_PROXY_AUTH)};`);
  }
  const guard = `<script>
window.__REFERTIUM_USER__=${JSON.stringify({ id: user.id, name: user.name, license: user.license, tokenLimit: user.tokenLimit })};
(function(){
  var limit=${Number(user.tokenLimit || 0)};
  var used=${Number(getMonthlyUsage(user).total || 0)};
  var originalFetch=window.fetch&&window.fetch.bind(window);
  function aiUrl(input){ var url=typeof input==='string'?input:(input&&input.url)||''; return /\\/v1\\/(chat\\/completions|responses|audio\\/transcriptions)/.test(url); }
  if(originalFetch){
    window.fetch=async function(input, init){
      if(aiUrl(input) && limit>0 && used>=limit) throw new Error('Limite token Refertium raggiunto.');
      var resp=await originalFetch(input, init);
      try {
        var cloned=resp.clone();
        var data=await cloned.json();
        var usage=data&&data.usage;
        var tokens=usage&&(usage.total_tokens || ((usage.input_tokens||0)+(usage.output_tokens||0)));
        if(tokens){ used += Number(tokens)||0; }
      } catch(e){}
      return resp;
    };
  }
})();
</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => m + guard);
  return guard + html;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

async function handleApi(req, res, db, user, pathname) {
  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await readJson(req);
    const login = String(body.username || body.email || '').toLowerCase().trim();
    const found = db.users.find(u =>
      String(u.username || '').toLowerCase() === login ||
      String(u.email || '').toLowerCase() === login
    );
    if (!found || !verifyPassword(body.password || '', found.passwordHash)) return send(res, 401, { error: 'Credenziali non valide' });
    const sid = id('sid');
    sessions.set(sid, { userId: found.id, createdAt: Date.now() });
    return send(res, 200, { user: publicUser(found) }, { 'set-cookie': `${COOKIE}=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` });
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    const sid = parseCookies(req)[COOKIE];
    if (sid) sessions.delete(sid);
    return send(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
  }
  if (pathname === '/api/me' && req.method === 'GET') {
    requireAuth(user);
    return send(res, 200, { user: publicUser(user) });
  }
  if (pathname === '/api/license-status' && req.method === 'GET') {
    requireAuth(user);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const requestedId = url.searchParams.get('userId');
    let target = user;
    if (user.role === 'admin' && requestedId) {
      target = db.users.find(u => u.id === requestedId && u.role === 'user');
    }
    if (!target || target.role !== 'user') return send(res, 404, { allowed: false, message: 'Utente non trovato.' });
    const blocked = target.license === 'blocked';
    const overLimit = isOverLimit(target);
    return send(res, 200, {
      allowed: !blocked && !overLimit,
      license: target.license,
      used: getMonthlyUsage(target).total,
      tokenLimit: Number(target.tokenLimit || 0),
      message: blocked ? 'La licenza e stata bloccata dall amministratore.' : overLimit ? 'Il limite mensile e stato raggiunto.' : 'Licenza attiva.'
    });
  }
  if (pathname === '/api/users' && req.method === 'GET') {
    requireAdmin(user);
    return send(res, 200, { users: db.users.filter(u => u.role === 'user').map(publicUser) });
  }
  if (pathname === '/api/users' && req.method === 'POST') {
    requireAdmin(user);
    const body = await readJson(req);
    const now = new Date().toISOString();
    const username = String(body.username || body.email || '').trim();
    if (!username) return send(res, 400, { error: 'Username obbligatorio' });
    if (db.users.some(u => String(u.username || '').toLowerCase() === username.toLowerCase())) return send(res, 409, { error: 'Username gia presente' });
    if (body.email && db.users.some(u => String(u.email || '').toLowerCase() === String(body.email || '').toLowerCase())) return send(res, 409, { error: 'Email gia presente' });
    const created = {
      id: id('user'),
      role: 'user',
      name: String(body.name || 'Nuovo medico').trim(),
      username,
      email: String(body.email || '').trim(),
      passwordHash: hashPassword(body.password || 'demo123'),
      license: body.license || 'active',
      tokenLimit: Number(body.tokenLimit || 600000),
      proxyToken: proxyToken(),
      htmlFile: '',
      htmlName: '',
      usage: {},
      createdAt: now,
      updatedAt: now
    };
    db.users.push(created);
    await saveDb(db);
    return send(res, 201, { user: publicUser(created) });
  }
  const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && req.method === 'PATCH') {
    requireAdmin(user);
    const target = db.users.find(u => u.id === userMatch[1] && u.role === 'user');
    if (!target) return send(res, 404, { error: 'Utente non trovato' });
    const body = await readJson(req);
    if (body.username && db.users.some(u => u.id !== target.id && String(u.username || '').toLowerCase() === String(body.username).toLowerCase())) return send(res, 409, { error: 'Username gia presente' });
    if (body.email && db.users.some(u => u.id !== target.id && String(u.email || '').toLowerCase() === String(body.email).toLowerCase())) return send(res, 409, { error: 'Email gia presente' });
    if (body.name != null) target.name = String(body.name).trim();
    if (body.username != null) target.username = String(body.username).trim();
    if (body.email != null) target.email = String(body.email).trim();
    if (body.password) target.passwordHash = hashPassword(body.password);
    if (body.license != null) target.license = String(body.license);
    if (body.tokenLimit != null) target.tokenLimit = Number(body.tokenLimit || 0);
    if (body.rotateProxyToken) target.proxyToken = proxyToken();
    target.updatedAt = new Date().toISOString();
    await saveDb(db);
    return send(res, 200, { user: publicUser(target) });
  }
  if (userMatch && req.method === 'DELETE') {
    requireAdmin(user);
    const target = db.users.find(u => u.id === userMatch[1] && u.role === 'user');
    if (!target) return send(res, 404, { error: 'Utente non trovato' });
    db.users = db.users.filter(u => u.id !== target.id);
    await saveDb(db);
    return sendNoContent(res);
  }
  const uploadMatch = pathname.match(/^\/api\/users\/([^/]+)\/html$/);
  if (uploadMatch && req.method === 'POST') {
    requireAdmin(user);
    const target = db.users.find(u => u.id === uploadMatch[1] && u.role === 'user');
    if (!target) return send(res, 404, { error: 'Utente non trovato' });
    const contentType = req.headers['content-type'] || '';
    let html = '';
    let originalName = 'refertium.html';
    if (contentType.includes('application/json')) {
      const body = await readJson(req);
      html = String(body.html || '');
      originalName = String(body.name || originalName);
    } else {
      html = (await readBody(req)).toString('utf8');
      originalName = String(new URL(req.url, `http://${req.headers.host}`).searchParams.get('name') || originalName);
    }
    if (!html.trim()) return send(res, 400, { error: 'HTML mancante' });
    const filename = `${target.id}-${Date.now()}.html`;
    await fs.writeFile(path.join(UPLOAD_DIR, filename), html);
    target.htmlFile = filename;
    target.htmlName = originalName;
    target.updatedAt = new Date().toISOString();
    await saveDb(db);
    return send(res, 200, { user: publicUser(target) });
  }
  const resetMatch = pathname.match(/^\/api\/users\/([^/]+)\/usage-reset$/);
  if (resetMatch && req.method === 'POST') {
    requireAdmin(user);
    const target = db.users.find(u => u.id === resetMatch[1] && u.role === 'user');
    if (!target) return send(res, 404, { error: 'Utente non trovato' });
    target.usage = target.usage || {};
    target.usage[monthKey()] = { total: 0, events: [] };
    target.updatedAt = new Date().toISOString();
    await saveDb(db);
    return send(res, 200, { user: publicUser(target) });
  }
  if (pathname === '/api/proxy/authorize' && req.method === 'POST') {
    requireWorker(req);
    const body = await readJson(req);
    const target = db.users.find(u => u.role === 'user' && u.proxyToken === body.proxyToken);
    if (!target) return send(res, 401, { allowed: false, error: 'Token proxy non valido' });
    const usage = getMonthlyUsage(target);
    const allowed = target.license !== 'blocked' && !isOverLimit(target);
    return send(res, 200, {
      allowed,
      userId: target.id,
      name: target.name,
      license: target.license,
      tokenLimit: Number(target.tokenLimit || 0),
      used: usage.total,
      remaining: Number(target.tokenLimit || 0) ? Math.max(0, Number(target.tokenLimit || 0) - usage.total) : null,
      reason: allowed ? null : target.license === 'blocked' ? 'license_blocked' : 'token_limit_reached'
    });
  }
  if (pathname === '/api/proxy/usage' && req.method === 'POST') {
    requireWorker(req);
    const body = await readJson(req);
    const target = db.users.find(u => u.role === 'user' && u.proxyToken === body.proxyToken);
    if (!target) return send(res, 401, { ok: false, error: 'Token proxy non valido' });
    await recordTokens(db, target, {
      operation: body.operation || 'AI',
      tokens: Number(body.tokens || 0),
      source: body.source || 'cloudflare',
      status: Number(body.status || 200)
    });
    return send(res, 200, { ok: true, usage: getMonthlyUsage(target) });
  }
  return send(res, 404, { error: 'API not found' });
}

function requireWorker(req) {
  if (req.headers['x-worker-secret'] !== WORKER_SHARED_SECRET) {
    throw Object.assign(new Error('Worker non autorizzato'), { status: 401 });
  }
}

function resolveAiBillingUser(req, db, user) {
  requireAuth(user);
  if (user.role === 'user') return user;
  if (user.role === 'admin') {
    const appUserId = parseCookies(req)[APP_USER_COOKIE];
    const target = appUserId && db.users.find(u => u.id === appUserId && u.role === 'user');
    if (target) return target;
  }
  return null;
}

async function proxyOpenAI(req, res, db, user, pathname) {
  const billingUser = resolveAiBillingUser(req, db, user);
  if (!billingUser) return send(res, 403, { error: 'Apri prima una app utente da /app/:userId' });
  if (billingUser.license === 'blocked') return send(res, 403, { error: 'Licenza bloccata' });
  if (isOverLimit(billingUser)) return send(res, 402, { error: 'Limite token raggiunto' });
  if (!OPENAI_API_KEY) return send(res, 500, { error: 'OPENAI_API_KEY non configurata sul server' });

  const body = await readBody(req, 50 * 1024 * 1024);
  const upstreamUrl = 'https://api.openai.com' + pathname;
  const headers = {
    authorization: `Bearer ${OPENAI_API_KEY}`,
    'content-type': req.headers['content-type'] || 'application/json'
  };
  const upstream = await fetch(upstreamUrl, { method: req.method, headers, body: req.method === 'GET' ? undefined : body });
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const responseBuffer = Buffer.from(await upstream.arrayBuffer());

  let tokens = 0;
  let operation = pathname.includes('audio') ? 'Trascrizione' : pathname.includes('responses') ? 'Responses' : 'Chat completions';
  if (contentType.includes('application/json')) {
    try {
      const data = JSON.parse(responseBuffer.toString('utf8'));
      const usage = data.usage || {};
      tokens = Number(usage.total_tokens || ((usage.prompt_tokens || usage.input_tokens || 0) + (usage.completion_tokens || usage.output_tokens || 0)));
    } catch {}
  }
  if (!tokens) tokens = estimateTokensFromRequest(pathname, body, req.headers['content-type'] || '');
  await recordTokens(db, billingUser, { operation, tokens, source: tokens ? 'server' : 'estimate', status: upstream.status });

  res.writeHead(upstream.status, {
    'content-type': contentType,
    'access-control-allow-origin': req.headers.origin || '*',
    'cache-control': 'no-store'
  });
  res.end(responseBuffer);
}

function estimateTokensFromRequest(pathname, body, contentType) {
  if (pathname.includes('audio')) return 900;
  if (!contentType.includes('application/json')) return Math.ceil(body.length / 4);
  try {
    const json = JSON.parse(body.toString('utf8'));
    const maxOut = Number(json.max_tokens || json.max_output_tokens || 0);
    return Math.max(250, Math.ceil(JSON.stringify(json).length / 4) + Math.ceil(maxOut * 0.45));
  } catch {
    return Math.ceil(body.length / 4);
  }
}

async function recordTokens(db, user, event) {
  const usage = getMonthlyUsage(user);
  const tokens = Math.max(0, Math.round(Number(event.tokens || 0)));
  usage.total += tokens;
  usage.events.push({
    at: new Date().toISOString(),
    operation: event.operation || 'AI',
    tokens,
    source: event.source || 'server',
    status: event.status || 200
  });
  usage.events = usage.events.slice(-1000);
  user.updatedAt = new Date().toISOString();
  await saveDb(db);
}

async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': req.headers.origin || '*', 'access-control-allow-headers': 'content-type,x-auth-token', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS' });
      return res.end();
    }
    const db = await loadDb();
    const user = await currentUser(req, db);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/api/')) return await handleApi(req, res, db, user, pathname);
    if (pathname.startsWith('/v1/')) return await proxyOpenAI(req, res, db, user, pathname);
    const appMatch = pathname.match(/^\/app\/([^/]+)$/);
    if (appMatch) return await serveUserApp(req, res, db, user, appMatch[1]);
    return await serveStatic(req, res, pathname);
  } catch (err) {
    const status = err.status || 500;
    console.error(err);
    send(res, status, { error: err.message || 'Errore server' });
  }
}

http.createServer(handler).listen(PORT, () => {
  console.log(`Refertium backend attivo: http://localhost:${PORT}`);
  console.log(OPENAI_API_KEY ? 'OPENAI_API_KEY configurata.' : 'OPENAI_API_KEY mancante: il proxy AI rispondera con errore finche non la imposti.');
});
