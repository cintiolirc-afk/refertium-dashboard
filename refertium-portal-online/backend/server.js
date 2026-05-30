const http = require('http');
const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || process.env.REFERTIUM_PORT || 47825);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const REFERTIUM_PROXY_MODE = process.env.REFERTIUM_PROXY_MODE || 'local';
const CLOUDFLARE_PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://refertium-api.cintioli-rc.workers.dev';
const CLOUDFLARE_PROXY_AUTH = process.env.CLOUDFLARE_PROXY_AUTH || 'refertium-sec-2026';
const WORKER_SHARED_SECRET = process.env.WORKER_SHARED_SECRET || 'refertium-worker-secret-dev';
const ADMIN_BOOTSTRAP_PASSWORD = process.env.REFERTIUM_ADMIN_PASSWORD || 'refertium-admin';
const FINANCE_BOOTSTRAP_PASSWORD = process.env.REFERTIUM_FINANCE_PASSWORD || '';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const TEMPLATE_DIR = path.join(ROOT, 'templates');
const BUNDLED_TEMPLATE_FILE = path.join(TEMPLATE_DIR, 'refertium-premium.html');
const BUNDLED_EN_TEMPLATE_FILE = path.join(TEMPLATE_DIR, 'refertium-premium-en.html');
const LEGACY_TEMPLATE_FILE = path.join(ROOT, '..', 'refertium-assets', 'REFERTIUM_v52-7.html');
const PERSISTENT_ROOT = process.env.REFERTIUM_DATA_DIR || (fss.existsSync('/var/data') ? '/var/data/refertium' : ROOT);
const DATA_DIR = path.join(PERSISTENT_ROOT, 'data');
const UPLOAD_DIR = path.join(PERSISTENT_ROOT, 'uploads');
const PERSISTENT_TEMPLATE_DIR = path.join(PERSISTENT_ROOT, 'templates');
const PERSISTENT_TEMPLATE_FILE = path.join(PERSISTENT_TEMPLATE_DIR, 'refertium-premium.html');
const PERSISTENT_EN_TEMPLATE_FILE = path.join(PERSISTENT_TEMPLATE_DIR, 'refertium-premium-en.html');
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
  await fs.mkdir(TEMPLATE_DIR, { recursive: true });
  await fs.mkdir(PERSISTENT_TEMPLATE_DIR, { recursive: true });
}

async function loadDb() {
  await ensureDirs();
  try {
    const db = JSON.parse(await fs.readFile(DB_FILE, 'utf8'));
    const changed = normalizeDb(db);
    const financeChanged = ensureFinanceUser(db);
    const recovered = await recoverDbIfBetter(db);
    if (recovered) return recovered;
    if (changed || financeChanged) await saveDb(db);
    return db;
  } catch {
    const recovered = await recoverDbIfBetter(null);
    if (recovered) return recovered;
    const now = new Date().toISOString();
    const db = {
      users: [
        {
          id: 'admin-demo',
          role: 'admin',
          name: 'Admin Refertium',
          username: 'admin',
          email: 'admin@refertium.local',
          passwordHash: hashPassword(ADMIN_BOOTSTRAP_PASSWORD),
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
          dictationHourLimit: 10,
          planName: 'Demo',
          planPrice: 0,
          isDemo: true,
          proxyToken: proxyToken(),
          htmlFile: '',
          htmlName: '',
          usage: {},
          createdAt: now,
          updatedAt: now
        },
        ...(FINANCE_BOOTSTRAP_PASSWORD ? [{
          id: 'finance-console',
          role: 'finance',
          name: 'Finance Refertium',
          username: 'finance',
          email: 'finance@refertium.local',
          passwordHash: hashPassword(FINANCE_BOOTSTRAP_PASSWORD),
          license: 'active',
          tokenLimit: 0,
          htmlFile: '',
          htmlName: '',
          usage: {},
          createdAt: now,
          updatedAt: now
        }] : [])
      ]
    };
    await saveDb(db);
    return db;
  }
}

async function recoverDbIfBetter(currentDb) {
  const currentCount = recoverableUserCount(currentDb);
  let best = null;
  const candidates = await findDbCandidates();
  for (const file of candidates) {
    if (path.resolve(file) === path.resolve(DB_FILE)) continue;
    try {
      const candidate = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Array.isArray(candidate.users)) continue;
      const count = recoverableUserCount(candidate);
      if (!best || count > best.count) best = { file, db: candidate, count };
    } catch {}
  }
  if (!best || best.count <= currentCount) return null;
  const changed = normalizeDb(best.db);
  const financeChanged = ensureFinanceUser(best.db);
  await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    if (fss.existsSync(DB_FILE)) {
      await fs.copyFile(DB_FILE, `${DB_FILE}.before-recovery-${Date.now()}.bak`);
    }
  } catch {}
  if (changed || financeChanged) {
    best.db.updatedAt = new Date().toISOString();
  }
  await fs.writeFile(DB_FILE, JSON.stringify(best.db, null, 2));
  console.log(`Refertium recovery: database recuperato da ${best.file} con ${best.db.users.length} utenti.`);
  return best.db;
}

function recoverableUserCount(db) {
  if (!db || !Array.isArray(db.users)) return 0;
  return db.users.filter(user => {
    if (!user || user.role !== 'user') return false;
    if (user.id === 'demo-user') return false;
    if (String(user.username || '').toLowerCase() === 'demo') return false;
    return true;
  }).length;
}

async function findDbCandidates() {
  const roots = Array.from(new Set([
    PERSISTENT_ROOT,
    ROOT,
    path.join(ROOT, 'backend'),
    '/var/data',
    '/opt/render/project/src'
  ]));
  const out = [];
  async function walk(dir, depth) {
    if (depth < 0) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && isDbCandidateName(entry.name)) out.push(full);
      if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) await walk(full, depth - 1);
    }
  }
  for (const root of roots) await walk(root, 5);
  return Array.from(new Set(out));
}

function isDbCandidateName(name) {
  return (
    name === 'db.json' ||
    name.startsWith('db.json.before-recovery-') ||
    name === 'db.json.bak' ||
    name.endsWith('.db.json')
  );
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
    if (user.role === 'admin' && process.env.REFERTIUM_ADMIN_PASSWORD && !verifyPassword(ADMIN_BOOTSTRAP_PASSWORD, user.passwordHash)) {
      user.passwordHash = hashPassword(ADMIN_BOOTSTRAP_PASSWORD);
      user.updatedAt = new Date().toISOString();
      changed = true;
    }
    if (user.role === 'finance' && process.env.REFERTIUM_FINANCE_PASSWORD && !verifyPassword(FINANCE_BOOTSTRAP_PASSWORD, user.passwordHash)) {
      user.passwordHash = hashPassword(FINANCE_BOOTSTRAP_PASSWORD);
      user.updatedAt = new Date().toISOString();
      changed = true;
    }
    if (user.role === 'user' && user.planName == null) {
      user.planName = user.isDemo === false ? 'Standard' : 'Demo';
      changed = true;
    }
    if (user.role === 'user' && user.dictationHourLimit == null) {
      user.dictationHourLimit = 10;
      changed = true;
    }
    if (user.role === 'user' && user.planPrice == null) {
      user.planPrice = 0;
      changed = true;
    }
    if (user.role === 'user' && user.isDemo == null) {
      user.isDemo = Number(user.planPrice || 0) <= 0;
      changed = true;
    }
    if (user.role === 'user') {
      const parts = String(user.name || '').trim().split(/\s+/).filter(Boolean);
      if (user.firstName == null) {
        user.firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] || '');
        changed = true;
      }
      if (user.lastName == null) {
        user.lastName = parts.length > 1 ? parts[parts.length - 1] : '';
        changed = true;
      }
      if (!Array.isArray(user.specialties)) {
        user.specialties = ['urgenza'];
        changed = true;
      }
      if (user.distillate == null) {
        user.distillate = '';
        changed = true;
      }
      if (user.softwareLanguage == null) {
        user.softwareLanguage = 'it';
        changed = true;
      }
      if (user.edition == null) {
        user.edition = 'pro';
        changed = true;
      }
    }
  }
  return changed;
}

function ensureFinanceUser(db) {
  if (!FINANCE_BOOTSTRAP_PASSWORD) return false;
  if (db.users.some(u => u.role === 'finance' || String(u.username || '').toLowerCase() === 'finance')) return false;
  const now = new Date().toISOString();
  db.users.push({
    id: 'finance-console',
    role: 'finance',
    name: 'Finance Refertium',
    username: 'finance',
    email: 'finance@refertium.local',
    passwordHash: hashPassword(FINANCE_BOOTSTRAP_PASSWORD),
    license: 'active',
    tokenLimit: 0,
    htmlFile: '',
    htmlName: '',
    usage: {},
    createdAt: now,
    updatedAt: now
  });
  return true;
}

async function saveDb(db) {
  await ensureDirs();
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

function publicUser(user, options = {}) {
  const includeUsage = options.includeUsage !== false;
  const includeSensitive = options.includeSensitive === true;
  const session = sessionInfo(user.id);
  const out = {
    id: user.id,
    role: user.role,
    name: user.name,
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    specialties: Array.isArray(user.specialties) ? user.specialties : [],
    softwareLanguage: user.softwareLanguage || 'it',
    edition: user.edition || 'pro',
    username: user.username || '',
    email: user.email,
    license: user.license,
    tokenLimit: includeUsage ? Number(user.tokenLimit || 0) : 0,
    dictationHourLimit: includeUsage ? Number(user.dictationHourLimit || 0) : 0,
    planName: user.planName || '',
    planPrice: Number(user.planPrice || 0),
    isDemo: Boolean(user.isDemo),
    proxyToken: includeSensitive ? (user.proxyToken || '') : '',
    htmlName: user.htmlName || '',
    hasHtml: Boolean(user.htmlFile),
    usage: includeUsage ? (user.usage || {}) : {},
    online: session.online,
    lastSeenAt: session.lastSeenAt,
    generatedAt: user.generatedAt || '',
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
  if (includeSensitive) out.distillate = user.distillate || '';
  return out;
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

async function readText(req) {
  const buf = await readBody(req, 6 * 1024 * 1024);
  return buf.toString('utf8');
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

function requireFinance(user) {
  requireAuth(user);
  if (!['admin', 'finance'].includes(user.role)) throw Object.assign(new Error('Permesso negato'), { status: 403 });
}

function getMonthlyUsage(user) {
  user.usage = user.usage || {};
  const key = monthKey();
  user.usage[key] = user.usage[key] || { total: 0, dictationSeconds: 0, events: [] };
  user.usage[key].total = Number(user.usage[key].total || 0);
  user.usage[key].dictationSeconds = Number(user.usage[key].dictationSeconds || 0);
  user.usage[key].events = Array.isArray(user.usage[key].events) ? user.usage[key].events : [];
  return user.usage[key];
}

function isOverLimit(user) {
  const limit = Number(user.tokenLimit || 0);
  return limit > 0 && getMonthlyUsage(user).total >= limit;
}

function isOverDictationLimit(user) {
  const limitHours = Number(user.dictationHourLimit || 0);
  return limitHours > 0 && Number(getMonthlyUsage(user).dictationSeconds || 0) >= limitHours * 3600;
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

// Refertium International: editor multilingua per radiologi stranieri che
// telerefertano per cliniche italiane. Le chiamate /v1/* passano dal proxy
// del backend (lo stesso pattern degli altri editor): niente token nel
// sorgente HTML, niente CORS, niente allowlist Cloudflare da gestire.
const INTERNATIONAL_TEMPLATE_FILE = path.join(TEMPLATE_DIR, 'refertium-international.html');
const INTERNATIONAL_DEMO_USER_ID = 'international-demo';

// Idempotent: assicura che esista l'utente "international-demo" come billing
// holder per le chiamate AI dal template international. Tetto di token mensile
// generoso ma finito (per evitare abusi della rotta pubblica).
async function ensureInternationalDemoUser(db) {
  let target = db.users.find(u => u.id === INTERNATIONAL_DEMO_USER_ID);
  if (!target) {
    target = {
      id: INTERNATIONAL_DEMO_USER_ID,
      role: 'user',
      name: 'International Demo',
      firstName: 'International',
      lastName: 'Demo',
      username: 'international-demo',
      email: '',
      password: '',
      license: 'active',
      tokenLimit: 200000,          // 200k token/mese: limite generoso per demo
      dictationHourLimit: 10,
      softwareLanguage: 'it',
      edition: 'pro',
      specialties: ['urgenza'],
      planName: 'International demo',
      planPrice: 0,
      isDemo: true,
      htmlFile: '',
      htmlName: '',
      distillate: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.users.push(target);
    await saveDb(db);
  } else if (target.license === 'blocked') {
    target.license = 'active';
    await saveDb(db);
  }
  return target;
}

async function serveInternationalApp(req, res, user) {
  try {
    const db = await loadDb();
    const billingUser = await ensureInternationalDemoUser(db);
    const rawHtml = await fs.readFile(INTERNATIONAL_TEMPLATE_FILE, 'utf8');
    const html = rewriteRefertiumHtml(rawHtml, billingUser);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // Cookie APP_USER_COOKIE = international-demo: così le successive
      // chiamate /v1/* trovano il billing user via cookie e passano dal proxy.
      'set-cookie': `${APP_USER_COOKIE}=${encodeURIComponent(billingUser.id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`,
    });
    res.end(html);
  } catch (err) {
    console.error('serveInternationalApp:', err);
    return send(res, 500, pageMessage('International template error', err.message || 'errore'),
      { 'content-type': 'text/html; charset=utf-8' });
  }
}

async function serveUserApp(req, res, db, user, targetUserId) {
  requireAuth(user);
  const target = user.role === 'admin' ? db.users.find(u => u.id === targetUserId) : user;
  if (!target || target.role !== 'user') return send(res, 404, { error: 'Utente non trovato' });
  if (target.license === 'blocked') return send(res, 403, pageMessage('Licenza bloccata', 'Accesso sospeso. Contatta il supporto Refertium.'), { 'content-type': 'text/html; charset=utf-8' });
  if (isOverLimit(target)) return send(res, 402, pageMessage('Limite token raggiunto', 'Il limite mensile e stato raggiunto.'), { 'content-type': 'text/html; charset=utf-8' });
  if (isOverDictationLimit(target)) return send(res, 402, pageMessage('Limite ore raggiunto', 'Il limite mensile di ore dettate e stato raggiunto.'), { 'content-type': 'text/html; charset=utf-8' });
  if (!target.htmlFile) return send(res, 404, pageMessage('App non caricata', 'L admin deve caricare l HTML personalizzato per questo utente.'), { 'content-type': 'text/html; charset=utf-8' });

  // Quando l'HTML dell'utente è stato AUTO-GENERATO (filename pattern
  // `{userId}-generated-{timestamp}.html`) OPPURE quando il template madre
  // è stato modificato DOPO l'ultima generazione, rigeneriamo on-the-fly
  // dal template madre più recente. Così le modifiche al template (prompt
  // dettatura, checklist, fix UX, ecc.) si propagano automaticamente.
  // Solo gli HTML con filename arbitrari E template madre più vecchio
  // restano com'erano (rispetto per upload manuali immutati).
  const htmlPath = path.join(UPLOAD_DIR, target.htmlFile);
  const isAutoGenerated = /^[a-z0-9-]+-generated-\d+\.html$/i.test(target.htmlFile);
  let templateNewer = false;
  if (!isAutoGenerated) {
    try {
      const lang = target.softwareLanguage === 'en' ? 'en' : 'it';
      const tplPath = lang === 'en' ? BUNDLED_EN_TEMPLATE_FILE : BUNDLED_TEMPLATE_FILE;
      const [userStat, tplStat] = await Promise.all([
        fs.stat(htmlPath),
        fs.stat(tplPath),
      ]);
      templateNewer = tplStat.mtimeMs > userStat.mtimeMs;
    } catch {}
  }

  let rawHtml;
  if (isAutoGenerated || templateNewer) {
    try {
      rawHtml = await generateRefertiumHtmlForUser(target);
    } catch {
      rawHtml = await fs.readFile(htmlPath, 'utf8');
    }
  } else {
    rawHtml = await fs.readFile(htmlPath, 'utf8');
  }

  const html = injectLicenseGuard(rewriteRefertiumHtml(rawHtml, target), target);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'set-cookie': `${APP_USER_COOKIE}=${encodeURIComponent(target.id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`
  });
  res.end(html);
}

function injectLicenseGuard(html, user) {
  const uiPatch = `<style id="refertium-runtime-ui-patch">
  :root { --font-serif: 'EB Garamond', Garamond, 'Apple Garamond', Georgia, serif; }
  .report,
  .report.report-font-system,
  .report.report-font-roboto,
  .report.report-font-times,
  .report.report-font-garamond,
  .report.report-font-courier,
  .report .dict-interim,
  .report .dict-session {
    font-family: var(--font-serif) !important;
  }
  .report.dict-recording:focus,
  .report.dict-recording:focus-within {
    box-shadow: 0 0 0 2px var(--rec-color, #dc2626) !important;
  }
  .report.dict-recording {
    border-color: transparent !important;
    box-shadow: 0 0 0 2px var(--rec-color, #dc2626) !important;
    outline: none !important;
    animation: none !important;
  }
  @keyframes refertium-dict-border-pulse {
    0%, 100% { box-shadow: 0 0 0 2px rgba(220,38,38,0.12); }
    50% { box-shadow: 0 0 0 4px rgba(220,38,38,0.22); }
  }
  </style>`;
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
  function reportDictation(seconds, source){
    seconds=Math.max(0,Math.round(Number(seconds)||0));
    if(seconds<2) return;
    var body=JSON.stringify({userId:USER_ID,seconds:seconds,source:source||'microphone'});
    if(navigator.sendBeacon){
      try{
        var blob=new Blob([body],{type:'application/json'});
        if(navigator.sendBeacon('/api/dictation-usage',blob)) return;
      }catch(e){}
    }
    fetch('/api/dictation-usage',{method:'POST',headers:{'content-type':'application/json'},body:body,credentials:'same-origin',keepalive:true}).catch(function(){});
  }
  function watchStream(stream){
    if(!stream||!stream.getAudioTracks) return;
    var tracks=stream.getAudioTracks();
    if(!tracks.length) return;
    var start=Date.now();
    var reported=false;
    function done(){
      if(reported) return;
      if(tracks.some(function(t){ return t.readyState!=='ended'; })) return;
      reported=true;
      reportDictation((Date.now()-start)/1000,'microphone');
    }
    tracks.forEach(function(track){
      track.addEventListener&&track.addEventListener('ended',done,{once:true});
      var originalStop=track.stop&&track.stop.bind(track);
      if(originalStop&&!track.__refertiumStopWrapped){
        track.__refertiumStopWrapped=true;
        track.stop=function(){ try{return originalStop();} finally{setTimeout(done,0);} };
      }
    });
  }
  if(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia){
    var originalGetUserMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=function(constraints){
      return originalGetUserMedia(constraints).then(function(stream){
        try{ if(constraints&&constraints.audio) watchStream(stream); }catch(e){}
        return stream;
      });
    };
  }
  function aiUrl(input){
    var url=typeof input==='string'?input:(input&&input.url)||'';
    return /\\/v1\\/(chat\\/completions|responses|audio\\/transcriptions)/.test(url);
  }
  function aiOperation(input){
    var url=typeof input==='string'?input:(input&&input.url)||'';
    if(url.indexOf('/audio/transcriptions')!==-1) return 'Trascrizione';
    if(url.indexOf('/responses')!==-1) return 'Responses';
    return 'Chat completions';
  }
  function aiIsExternal(input){
    try{
      var raw=typeof input==='string'?input:(input&&input.url)||'';
      return new URL(raw, window.location.href).origin!==window.location.origin;
    }catch(e){ return true; }
  }
  function totalTokensFrom(data){
    var usage=data&&data.usage;
    if(!usage) return 0;
    return Number(usage.total_tokens||usage.totalTokens||((usage.prompt_tokens||usage.input_tokens||0)+(usage.completion_tokens||usage.output_tokens||0)))||0;
  }
  function reportAiUsage(payload){
    var body=JSON.stringify(payload);
    if(navigator.sendBeacon){
      try{
        var blob=new Blob([body],{type:'application/json'});
        if(navigator.sendBeacon('/api/client-ai-usage',blob)) return;
      }catch(e){}
    }
    fetch('/api/client-ai-usage',{method:'POST',headers:{'content-type':'application/json'},body:body,credentials:'same-origin',keepalive:true}).catch(function(){});
  }
  if(window.fetch){
    var originalFetch=window.fetch.bind(window);
    window.fetch=async function(input,init){
      var isAi=aiUrl(input);
      var resp=await originalFetch(input,init);
      if(isAi && aiIsExternal(input)){
        try{
          var cloned=resp.clone();
          var data=await cloned.json();
          var tokens=totalTokensFrom(data);
          if(tokens){
            reportAiUsage({userId:USER_ID,operation:aiOperation(input),tokens:tokens,status:resp.status,source:'browser'});
          }
        }catch(e){}
      }
      return resp;
    };
  }
	  try{
	    localStorage.setItem('reportify_report_font','garamond');
	    document.addEventListener('DOMContentLoaded',function(){
	      var sel=document.getElementById('reportFontSelect');
	      if(sel){
	        sel.value='garamond';
	        sel.dispatchEvent(new Event('change',{bubbles:true}));
	      }
	    });
	  }catch(e){}
	  function patchRefertiumRuntime(){
	    try{
	      if(window.PROXY_URL && window.state && state.sttProvider==='deepgram' && !state.deepgramKey){
	        state.deepgramKey='__refertium_proxy__';
	      }
	    }catch(e){}
	    try{
	      if(typeof window.systemPromptForReport==='function' && !window.systemPromptForReport.__refertiumStrict){
	        var originalSystemPromptForReport=window.systemPromptForReport;
	        window.systemPromptForReport=function(){
	          var base=String(originalSystemPromptForReport.apply(this,arguments)||'');
	          return base+'\\n\\nREGOLE REFERTIUM TASSATIVE PER LE CONCLUSIONI:\\n- Le conclusioni devono riferirsi solo all esame corrente e ai reperti effettivamente presenti nel referto/checklist.\\n- Non citare esami, metodiche, distretti anatomici, follow-up, controlli o approfondimenti non presenti nei dati del medico.\\n- Se il quadro e normale, scrivi solo una conclusione breve di normalita, senza raccomandazioni.\\n- Se i dati sono poveri o ambigui, resta prudente e non inventare ipotesi.';
	        };
	        window.systemPromptForReport.__refertiumStrict=true;
	      }
	    }catch(e){}
	    try{
	      if(typeof window.buildMagicSystemPrompt==='function' && !window.buildMagicSystemPrompt.__refertiumStrict){
	        var originalBuildMagicSystemPrompt=window.buildMagicSystemPrompt;
	        window.buildMagicSystemPrompt=function(){
	          var base=String(originalBuildMagicSystemPrompt.apply(this,arguments)||'');
	          return base+'\\n\\nREGOLA REFERTIUM EXTRA:\\nQuando parti da checklist, resta aderente alla metodica e al distretto della checklist. Non inserire riferimenti a esami, metodiche o distretti non presenti nell input.';
	        };
	        window.buildMagicSystemPrompt.__refertiumStrict=true;
	      }
	    }catch(e){}
	  }
	  patchRefertiumRuntime();
	  document.addEventListener('DOMContentLoaded',patchRefertiumRuntime);
	  setTimeout(patchRefertiumRuntime,500);
	  setTimeout(patchRefertiumRuntime,1500);
	})();
	</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => m + uiPatch + guard);
  return uiPatch + guard + html;
}

function pageMessage(title, text) {
  return `<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body style="margin:0;background:#050505;color:#ebe2cc;font:16px system-ui;display:grid;place-items:center;min-height:100vh"><main style="max-width:520px;border:1px solid rgba(235,226,204,.18);padding:28px;border-radius:8px;background:#101010"><h1>${escapeHtml(title)}</h1><p style="color:#999">${escapeHtml(text)}</p></main></body></html>`;
}

function rewriteRefertiumHtml(html, user) {
  const usesLocalProxy = REFERTIUM_PROXY_MODE === 'local';
  if (REFERTIUM_PROXY_MODE === 'local') {
    html = html.replace(/const\s+PROXY_URL\s*=\s*['"][^'"]*['"]\s*;/, "const PROXY_URL = window.location.origin;");
    html = html.replace(/const\s+PROXY_AUTH\s*=\s*['"][^'"]*['"]\s*;/, "const PROXY_AUTH = 'session';");
  } else {
    html = html.replace(/const\s+PROXY_URL\s*=\s*['"][^'"]*['"]\s*;/, `const PROXY_URL = ${JSON.stringify(CLOUDFLARE_PROXY_URL)};`);
    html = html.replace(/const\s+PROXY_AUTH\s*=\s*['"][^'"]*['"]\s*;/, `const PROXY_AUTH = ${JSON.stringify(CLOUDFLARE_PROXY_AUTH)};`);
  }
  if (html.includes('window.__REFERTIUM_PROXY_MODE__=')) return html;
  const guard = `<script>
window.__REFERTIUM_USER__=${JSON.stringify({ id: user.id, name: user.name, license: user.license, tokenLimit: user.tokenLimit })};
window.__REFERTIUM_PROXY_MODE__=${JSON.stringify(REFERTIUM_PROXY_MODE)};
(function(){
  var limit=${Number(user.tokenLimit || 0)};
  var used=${Number(getMonthlyUsage(user).total || 0)};
  var usesLocalProxy=${JSON.stringify(usesLocalProxy)};
  function forceBackendProxyRuntime(){
    if(!usesLocalProxy) return;
    try{
      if(window.state){
        state.apiKey='proxy';
        state.deepgramKey='';
        state.sttProvider='openai';
        try{ localStorage.setItem('reportify_stt_provider','openai'); }catch(e){}
      }
    }catch(e){}
  }
  forceBackendProxyRuntime();
  document.addEventListener('DOMContentLoaded', forceBackendProxyRuntime);
  setTimeout(forceBackendProxyRuntime, 300);
  setTimeout(forceBackendProxyRuntime, 1200);
  var originalFetch=window.fetch&&window.fetch.bind(window);
  function aiUrl(input){ var url=typeof input==='string'?input:(input&&input.url)||''; return /\\/v1\\/(chat\\/completions|responses|audio\\/transcriptions)/.test(url); }
  if(originalFetch){
    window.fetch=async function(input, init){
      forceBackendProxyRuntime();
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

const SPECIALTIES = [
  { key: 'neuro', label: 'Neuro', initials: 'NE' },
  { key: 'body', label: 'Body', initials: 'BO' },
  { key: 'msk', label: 'MSK', initials: 'MS' },
  { key: 'senologia', label: 'Senologia', initials: 'SE' },
  { key: 'toracica', label: 'Toracica', initials: 'TO' },
  { key: 'eco', label: 'Eco', initials: 'EC' },
  { key: 'urgenza', label: 'Urgenza', initials: 'UR' }
];

const SPECIALTY_DISTRICTS = {
  neuro: ['encefalo','sella','angio_intracranica','orbite','rocche_petrose','massiccio_facciale','seni_paranasali','collo','tsa','rachide_cervicale','rachide_dorsale','rachide_lombare','rachide_sacrale','rachide_intero','altro'],
  body: ['collo','tiroide','paratiroidi','ghiandole_salivari','torace','cuore','aorta_toracica','embolia_polmonare','addome_completo','addome_superiore','fegato','vie_biliari','pancreas','milza','reni_surreni','uro','aorta_addominale','pelvi','prostata','vescica','utero_annessi','retto','arti_inf_arteriosi','arti_sup_arteriosi','arti_inf_venosi','whole_body','tc_total_body','altro'],
  msk: ['rachide_cervicale','rachide_dorsale','rachide_lombare','rachide_sacrale','rachide_intero','spalla','gomito','polso','mano','bacino_anche','ginocchio','gamba','caviglia','piede','altro'],
  senologia: ['mammella','pelvi','utero_annessi','altro'],
  toracica: ['torace','polmoni_hrct','cuore','aorta_toracica','embolia_polmonare','altro'],
  eco: ['collo','tiroide','paratiroidi','ghiandole_salivari','tsa','addome_completo','addome_superiore','fegato','pancreas','milza','reni_surreni','aorta_addominale','pelvi','prostata','vescica','utero_annessi','mammella','spalla','gomito','polso','ginocchio','caviglia','arti_inf_arteriosi','arti_sup_arteriosi','arti_inf_venosi','altro'],
  urgenza: ['encefalo','massiccio_facciale','collo','rachide_cervicale','torace','cuore','aorta_toracica','embolia_polmonare','addome_completo','aorta_addominale','pelvi','rachide_dorsale','rachide_lombare','spalla','gomito','polso','mano','bacino_anche','ginocchio','caviglia','piede','whole_body','tc_total_body','altro']
};

function replaceBetweenMarkers(source, name, replacement) {
  const startTag = '@@REFERTIUM_INJECTION_POINT@@ ' + name + ' START';
  const endTag = '@@REFERTIUM_INJECTION_POINT@@ ' + name + ' END';
  const startIdx = source.indexOf(startTag);
  const endIdx = source.indexOf(endTag);
  if (startIdx === -1 || endIdx === -1) return source;
  const injectFrom = source.indexOf('\n', startIdx) + 1;
  const back = source.substring(Math.max(0, endIdx - 200), endIdx);
  const relStart = Math.max(back.lastIndexOf('/*'), back.lastIndexOf('<!--'));
  if (injectFrom <= 0 || relStart === -1) return source;
  const injectTo = Math.max(0, endIdx - 200) + relStart;
  return source.substring(0, injectFrom) + replacement + source.substring(injectTo);
}

function safeSpecialties(value) {
  const known = new Set(SPECIALTIES.map(s => s.key));
  const selected = Array.isArray(value) ? value : String(value || '').split(',');
  const out = selected.map(v => String(v).trim()).filter(v => known.has(v));
  return out.length ? Array.from(new Set(out)) : ['urgenza'];
}

function buildDoctorBadgeHTML(user) {
  const firstName = user.firstName || String(user.name || '').split(/\s+/).slice(0, -1).join(' ') || user.name || '';
  const lastName = user.lastName || String(user.name || '').split(/\s+/).slice(-1)[0] || '';
  const specs = safeSpecialties(user.specialties).map(key => SPECIALTIES.find(s => s.key === key)).filter(Boolean);
  const iconHtml = specs.length === 1
    ? `    <span class="doctor-badge-specialty" title="${escapeHtml(specs[0].label)}" aria-label="${escapeHtml(specs[0].label)}">${specialtyIconSvg(specs[0].key)}</span>\n`
    : `    <span class="doctor-badge-specialties" title="${escapeHtml(specs.map(s => s.label).join(' + '))}" aria-label="${escapeHtml(specs.map(s => s.label).join(' + '))}">\n` +
      specs.map(s => `      <span class="doctor-badge-specialty" title="${escapeHtml(s.label)}">${specialtyIconSvg(s.key)}</span>\n`).join('') +
      '    </span>\n';
  return iconHtml +
    '    <span class="doctor-badge-divider" aria-hidden="true"></span>\n' +
    `    <span class="doctor-badge-name">${escapeHtml(lastName)}, ${escapeHtml(firstName)} <span class="doctor-badge-md">MD</span></span>\n`;
}

function specialtyIconSvg(key) {
  const common = 'viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"';
  const stroke = 'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"';
  const icons = {
    neuro: `<svg ${common}><path ${stroke} d="M15 6c-4.5 0-8 3.5-8 8.3 0 3.1 1.5 5.4 3.8 7"/><path ${stroke} d="M17 6c4.5 0 8 3.5 8 8.3 0 3.1-1.5 5.4-3.8 7"/><path ${stroke} d="M11 21.3V25h10v-3.7"/><path ${stroke} d="M11 12.5c2.2-.2 3.7.7 4.4 2.5M21 12.5c-2.2-.2-3.7.7-4.4 2.5M13 18h6"/></svg>`,
    body: `<svg ${common}><path ${stroke} d="M16 6c3.3 0 6 2.7 6 6v9c0 2.8-2.2 5-5 5h-2c-2.8 0-5-2.2-5-5v-9c0-3.3 2.7-6 6-6Z"/><path ${stroke} d="M10 15h12M13 6v20M19 6v20"/></svg>`,
    msk: `<svg ${common}><path ${stroke} d="M11 7c2 3 2 5.5 0 8.5s-2 5.5 0 8.5"/><path ${stroke} d="M21 7c-2 3-2 5.5 0 8.5s2 5.5 0 8.5"/><path ${stroke} d="M10 10h12M10 16h12M10 22h12"/></svg>`,
    senologia: `<svg ${common}><path ${stroke} d="M16 7c-5 4.2-8 7.6-8 12a8 8 0 0 0 16 0c0-4.4-3-7.8-8-12Z"/><path ${stroke} d="M13 18c1.2-1.2 4.8-1.2 6 0"/></svg>`,
    toracica: `<svg ${common}><path ${stroke} d="M15 8c-4 2-7 5.8-7 11.5V25c3.8-.4 6.8-3.8 7-8V8Z"/><path ${stroke} d="M17 8c4 2 7 5.8 7 11.5V25c-3.8-.4-6.8-3.8-7-8V8Z"/><path ${stroke} d="M16 7v19"/></svg>`,
    eco: `<svg ${common}><path ${stroke} d="M10 7h12l-2 11a4 4 0 0 1-8 0L10 7Z"/><path ${stroke} d="M13 25h6M16 21v4M12 11h8"/></svg>`,
    urgenza: `<svg ${common}><path ${stroke} d="M16 5v22M5 16h22"/><path ${stroke} d="M9 9l14 14M23 9 9 23"/></svg>`
  };
  return icons[key] || icons.urgenza;
}

function extractWhisperKeywords(text) {
  const words = String(text || '').toLowerCase().replace(/[^a-zàèéìíòóùúüöä\s-]/gi, ' ').split(/\s+/).filter(w => w.length >= 5 && w.length <= 22);
  const stop = new Set(['della','dello','degli','delle','nella','nello','negli','nelle','dalla','dallo','dagli','dalle','sulla','sullo','sugli','sulle','questo','questa','questi','queste','esame','esami','referto','referti','paziente','pazienti','presenza','assenza','aspetto','quadro','rilievo','reperto']);
  const freq = new Map();
  for (const word of words) {
    if (stop.has(word)) continue;
    freq.set(word, (freq.get(word) || 0) + 1);
  }
  return Array.from(freq.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 80)
    .map(([word]) => word)
    .join(', ');
}

async function generateRefertiumHtmlForUser(user) {
  const language = user.softwareLanguage === 'en' ? 'en' : 'it';
  let html = await readTemplateHtml(language);
  const edition = user.edition === 'text' ? 'text' : 'pro';
  const specialties = safeSpecialties(user.specialties);
  const distillate = language === 'en' ? '' : String(user.distillate || '').trim().slice(0, 20000);
  const enabledDistricts = Array.from(new Set(specialties.flatMap(key => SPECIALTY_DISTRICTS[key] || [])));

  html = html.replace(/<html\s+lang="[^"]*"/i, `<html lang="${language}"`);
  html = html.replace(/lang:\s*'it'\s*,/, `lang: '${language}',`);
  html = html.replace(/language:\s*'it'/g, `language: '${language}'`);
  html = replaceBetweenMarkers(html, 'DOCTOR_BADGE', buildDoctorBadgeHTML({ ...user, specialties }));
  html = replaceBetweenMarkers(html, 'MAGIC_PDF_TEXT', `var MAGIC_PDF_TEXT = ${JSON.stringify(distillate)};\n`);
  html = replaceBetweenMarkers(html, 'WHISPER_PROMPT', `var WHISPER_PROMPT = ${JSON.stringify(edition === 'pro' && distillate ? extractWhisperKeywords(distillate) : '')};\n`);
  html = replaceBetweenMarkers(html, 'DOCTOR_SPECIALTY', `var DOCTOR_SPECIALTY = ${JSON.stringify(specialties)};\n`);
  html = replaceBetweenMarkers(html, 'ENABLED_DISTRICTS', enabledDistricts.length ? `var ENABLED_DISTRICTS = ${JSON.stringify(enabledDistricts)};\n` : 'var ENABLED_DISTRICTS = null;\n');
  html = replaceBetweenMarkers(html, 'IS_VERGINE', 'var IS_VERGINE = false;\n');
  html = replaceBetweenMarkers(html, 'EDITION', `var EDITION = '${edition}';\nvar INCLUDE_DICTATION = (EDITION !== 'text');\n`);
  return rewriteRefertiumHtml(html, user);
}

async function readTemplateHtml(language = 'it') {
  const isEnglish = language === 'en';
  const candidates = isEnglish
    ? [BUNDLED_EN_TEMPLATE_FILE, PERSISTENT_EN_TEMPLATE_FILE]
    : [BUNDLED_TEMPLATE_FILE, PERSISTENT_TEMPLATE_FILE, LEGACY_TEMPLATE_FILE];
  for (const file of candidates) {
    try {
      const html = await fs.readFile(file, 'utf8');
      if (isValidRefertiumTemplate(html)) return html;
    } catch {}
  }
  throw Object.assign(new Error('Template madre mancante'), { status: 500 });
}

function isValidRefertiumTemplate(html) {
  return Boolean(
    html &&
    html.includes('@@REFERTIUM_INJECTION_POINT@@ DOCTOR_BADGE START') &&
    html.includes('@@REFERTIUM_INJECTION_POINT@@ MAGIC_PDF_TEXT START') &&
    html.includes('const PROXY_URL')
  );
}

async function templateStatus() {
  const candidates = [
    { file: BUNDLED_TEMPLATE_FILE, label: 'GitHub IT: backend/templates/refertium-premium.html', lang: 'it' },
    { file: BUNDLED_EN_TEMPLATE_FILE, label: 'GitHub EN: backend/templates/refertium-premium-en.html', lang: 'en' },
    { file: PERSISTENT_TEMPLATE_FILE, label: 'Render disk IT: templates/refertium-premium.html', lang: 'it' },
    { file: PERSISTENT_EN_TEMPLATE_FILE, label: 'Render disk EN: templates/refertium-premium-en.html', lang: 'en' },
    { file: LEGACY_TEMPLATE_FILE, label: 'GitHub: refertium-assets/REFERTIUM_v52-7.html' }
  ];
  const byLanguage = { it: null, en: null };
  for (const item of candidates) {
    try {
      const stat = await fs.stat(item.file);
      if (!stat.isFile()) continue;
      const html = await fs.readFile(item.file, 'utf8');
      if (isValidRefertiumTemplate(html)) {
        if (item.lang && !byLanguage[item.lang]) byLanguage[item.lang] = { file: item.label, size: stat.size };
        if (!item.lang && !byLanguage.it) byLanguage.it = { file: item.label, size: stat.size };
      }
    } catch {}
  }
  return {
    templateReady: Boolean(byLanguage.it),
    englishTemplateReady: Boolean(byLanguage.en),
    file: byLanguage.it ? byLanguage.it.file : '',
    englishFile: byLanguage.en ? byLanguage.en.file : '',
    size: byLanguage.it ? byLanguage.it.size : 0,
    englishSize: byLanguage.en ? byLanguage.en.size : 0
  };
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
    return send(res, 200, { user: publicUser(found, { includeUsage: true }) }, { 'set-cookie': `${COOKIE}=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` });
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    const sid = parseCookies(req)[COOKIE];
    if (sid) sessions.delete(sid);
    return send(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
  }
  if (pathname === '/api/me' && req.method === 'GET') {
    requireAuth(user);
    return send(res, 200, { user: publicUser(user, { includeUsage: true }) });
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
    const overDictationLimit = isOverDictationLimit(target);
    const usage = getMonthlyUsage(target);
    return send(res, 200, {
      allowed: !blocked && !overLimit && !overDictationLimit,
      license: target.license,
      used: user.role === 'admin' ? usage.total : undefined,
      tokenLimit: user.role === 'admin' ? Number(target.tokenLimit || 0) : undefined,
      dictationSeconds: user.role === 'admin' ? Number(usage.dictationSeconds || 0) : undefined,
      dictationHourLimit: user.role === 'admin' ? Number(target.dictationHourLimit || 0) : undefined,
      message: blocked ? 'La licenza e stata bloccata dall amministratore.' : overLimit ? 'Il limite mensile token e stato raggiunto.' : overDictationLimit ? 'Il limite mensile di ore dettate e stato raggiunto.' : 'Licenza attiva.'
    });
  }
  if (pathname === '/api/dictation-usage' && req.method === 'POST') {
    requireAuth(user);
    const body = await readJson(req);
    let target = user.role === 'user' ? user : null;
    if (user.role === 'admin') {
      const appUserId = parseCookies(req)[APP_USER_COOKIE];
      const requestedId = String(body.userId || appUserId || '');
      target = db.users.find(u => u.id === requestedId && u.role === 'user') || null;
    }
    if (!target || target.role !== 'user') return send(res, 404, { ok: false, error: 'Utente non trovato' });
    const seconds = Math.max(0, Math.round(Number(body.seconds || 0)));
    await recordTokens(db, target, {
      operation: 'Dettatura',
      tokens: 0,
      dictationSeconds: seconds,
      source: body.source || 'app',
      status: 200
    });
    return send(res, 200, { ok: true, usage: getMonthlyUsage(target) });
  }
  if (pathname === '/api/client-ai-usage' && req.method === 'POST') {
    requireAuth(user);
    const body = await readJson(req);
    let target = user.role === 'user' ? user : null;
    if (user.role === 'admin') {
      const appUserId = parseCookies(req)[APP_USER_COOKIE];
      const requestedId = String(body.userId || appUserId || '');
      target = db.users.find(u => u.id === requestedId && u.role === 'user') || null;
    }
    if (!target || target.role !== 'user') return send(res, 404, { ok: false, error: 'Utente non trovato' });
    await recordTokens(db, target, {
      operation: body.operation || 'AI',
      tokens: Number(body.tokens || 0),
      dictationSeconds: Number(body.dictationSeconds || 0),
      source: body.source || 'browser',
      status: Number(body.status || 200)
    });
    return send(res, 200, { ok: true, usage: getMonthlyUsage(target) });
  }
  if (pathname === '/api/users' && req.method === 'GET') {
    requireFinance(user);
    return send(res, 200, { users: db.users.filter(u => u.role === 'user').map(u => publicUser(u, { includeUsage: true, includeSensitive: user.role === 'admin' })) });
  }
  if (pathname === '/api/template-status' && req.method === 'GET') {
    requireAdmin(user);
    return send(res, 200, await templateStatus());
  }
  if (pathname === '/api/templates/premium' && req.method === 'POST') {
    requireAdmin(user);
    const html = await readText(req);
    if (!html.includes('@@REFERTIUM_INJECTION_POINT@@ DOCTOR_BADGE START') ||
        !html.includes('@@REFERTIUM_INJECTION_POINT@@ MAGIC_PDF_TEXT START') ||
        !html.includes('const PROXY_URL')) {
      return send(res, 400, { error: 'Questo HTML non sembra un template Refertium valido' });
    }
    await ensureDirs();
    await fs.writeFile(PERSISTENT_TEMPLATE_FILE, html, 'utf8');
    const status = await templateStatus();
    return send(res, 200, { ok: true, ...status });
  }
  if (pathname === '/api/users' && req.method === 'POST') {
    requireAdmin(user);
    const body = await readJson(req);
    const now = new Date().toISOString();
    const username = String(body.username || body.email || '').trim();
    if (!username) return send(res, 400, { error: 'Username obbligatorio' });
    if (db.users.some(u => String(u.username || '').toLowerCase() === username.toLowerCase())) return send(res, 409, { error: 'Username gia presente' });
    if (body.email && db.users.some(u => String(u.email || '').toLowerCase() === String(body.email || '').toLowerCase())) return send(res, 409, { error: 'Email gia presente' });
    const fullName = String(body.name || 'Nuovo medico').trim();
    const fullNameParts = fullName.split(/\s+/).filter(Boolean);
    const created = {
      id: id('user'),
      role: 'user',
      name: fullName,
      firstName: String(body.firstName || (fullNameParts.length > 1 ? fullNameParts.slice(0, -1).join(' ') : fullNameParts[0] || '')).trim(),
      lastName: String(body.lastName || (fullNameParts.length > 1 ? fullNameParts[fullNameParts.length - 1] : '')).trim(),
      specialties: safeSpecialties(body.specialties || ['urgenza']),
      distillate: String(body.distillate || ''),
      softwareLanguage: body.softwareLanguage === 'en' ? 'en' : 'it',
      edition: body.edition === 'text' ? 'text' : 'pro',
      username,
      email: String(body.email || '').trim(),
      passwordHash: hashPassword(body.password || 'demo123'),
      license: body.license || 'active',
      tokenLimit: Number(body.tokenLimit || 600000),
      dictationHourLimit: Number(body.dictationHourLimit || 10),
      planName: String(body.planName || 'Demo').trim(),
      planPrice: Number(body.planPrice || 0),
      isDemo: body.isDemo == null ? true : Boolean(body.isDemo),
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
    if (body.firstName != null) target.firstName = String(body.firstName || '').trim();
    if (body.lastName != null) target.lastName = String(body.lastName || '').trim();
    if (body.specialties != null) target.specialties = safeSpecialties(body.specialties);
    if (body.distillate != null) target.distillate = String(body.distillate || '');
    if (body.softwareLanguage != null) target.softwareLanguage = body.softwareLanguage === 'en' ? 'en' : 'it';
    if (body.edition != null) target.edition = body.edition === 'text' ? 'text' : 'pro';
    if (body.username != null) target.username = String(body.username).trim();
    if (body.email != null) target.email = String(body.email).trim();
    if (body.password) target.passwordHash = hashPassword(body.password);
    if (body.license != null) target.license = String(body.license);
    if (body.tokenLimit != null) target.tokenLimit = Number(body.tokenLimit || 0);
    if (body.dictationHourLimit != null) target.dictationHourLimit = Number(body.dictationHourLimit || 0);
    if (body.planName != null) target.planName = String(body.planName || '').trim();
    if (body.planPrice != null) target.planPrice = Number(body.planPrice || 0);
    if (body.isDemo != null) target.isDemo = Boolean(body.isDemo);
    if (body.rotateProxyToken) target.proxyToken = proxyToken();
    target.updatedAt = new Date().toISOString();
    await saveDb(db);
    return send(res, 200, { user: publicUser(target, { includeUsage: true, includeSensitive: true }) });
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
  const generateMatch = pathname.match(/^\/api\/users\/([^/]+)\/generate-html$/);
  if (generateMatch && req.method === 'POST') {
    requireAdmin(user);
    const target = db.users.find(u => u.id === generateMatch[1] && u.role === 'user');
    if (!target) return send(res, 404, { error: 'Utente non trovato' });
    if (!target.firstName || !target.lastName) return send(res, 400, { error: 'Inserisci nome e cognome del medico prima di generare il software' });
    try {
      await readTemplateHtml(target.softwareLanguage === 'en' ? 'en' : 'it');
    } catch {
      return send(res, 400, { error: target.softwareLanguage === 'en' ? 'Template madre inglese mancante: aggiungi backend/templates/refertium-premium-en.html' : 'Template madre mancante: carica il template premium dalla dashboard admin' });
    }
    const html = await generateRefertiumHtmlForUser(target);
    const safeName = `${target.lastName || target.name || 'medico'}`.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'medico';
    const filename = `${target.id}-generated-${Date.now()}.html`;
    await fs.writeFile(path.join(UPLOAD_DIR, filename), html);
    target.htmlFile = filename;
    target.htmlName = `Refertium_${target.softwareLanguage === 'en' ? 'EN_' : ''}${target.edition === 'text' ? 'Text' : 'Pro'}_${safeName}.html`;
    target.generatedAt = new Date().toISOString();
    target.updatedAt = target.generatedAt;
    await saveDb(db);
    return send(res, 200, { user: publicUser(target, { includeUsage: true, includeSensitive: true }), htmlName: target.htmlName });
  }
  const resetMatch = pathname.match(/^\/api\/users\/([^/]+)\/usage-reset$/);
  if (resetMatch && req.method === 'POST') {
    requireAdmin(user);
    const target = db.users.find(u => u.id === resetMatch[1] && u.role === 'user');
    if (!target) return send(res, 404, { error: 'Utente non trovato' });
    target.usage = target.usage || {};
    target.usage[monthKey()] = { total: 0, dictationSeconds: 0, events: [] };
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
    const overDictationLimit = isOverDictationLimit(target);
    const allowed = target.license !== 'blocked' && !isOverLimit(target) && !overDictationLimit;
    return send(res, 200, {
      allowed,
      userId: target.id,
      name: target.name,
      license: target.license,
      tokenLimit: Number(target.tokenLimit || 0),
      dictationHourLimit: Number(target.dictationHourLimit || 0),
      used: usage.total,
      dictationSeconds: Number(usage.dictationSeconds || 0),
      remaining: Number(target.tokenLimit || 0) ? Math.max(0, Number(target.tokenLimit || 0) - usage.total) : null,
      dictationRemainingSeconds: Number(target.dictationHourLimit || 0) ? Math.max(0, Number(target.dictationHourLimit || 0) * 3600 - Number(usage.dictationSeconds || 0)) : null,
      reason: allowed ? null : target.license === 'blocked' ? 'license_blocked' : isOverLimit(target) ? 'token_limit_reached' : 'dictation_limit_reached'
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
      dictationSeconds: Number(body.dictationSeconds || body.audioSeconds || 0),
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
  // Eccezione per Refertium International: l'editor è servito da /international
  // come MVP pubblico, senza login dashboard. Il backend mette il cookie
  // APP_USER_COOKIE = international-demo all'apertura della pagina, e qui lo
  // riconosciamo come billing holder per le chiamate AI. Il limite token
  // dell'utente "international-demo" funge da rate-limit complessivo per
  // la rotta pubblica.
  const cookies = parseCookies(req);
  const appUserId = cookies[APP_USER_COOKIE];
  if (!user && appUserId === INTERNATIONAL_DEMO_USER_ID) {
    const intl = db.users.find(u => u.id === INTERNATIONAL_DEMO_USER_ID);
    if (intl) return intl;
  }
  requireAuth(user);
  if (user.role === 'user') return user;
  if (user.role === 'admin') {
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
  const dictationSeconds = pathname.includes('audio') ? estimateAudioSecondsFromBody(body, req.headers['content-type'] || '') : 0;
  let operation = pathname.includes('audio') ? 'Trascrizione' : pathname.includes('responses') ? 'Responses' : 'Chat completions';
  if (contentType.includes('application/json')) {
    try {
      const data = JSON.parse(responseBuffer.toString('utf8'));
      const usage = data.usage || {};
      tokens = Number(usage.total_tokens || ((usage.prompt_tokens || usage.input_tokens || 0) + (usage.completion_tokens || usage.output_tokens || 0)));
    } catch {}
  }
  if (!tokens) tokens = estimateTokensFromRequest(pathname, body, req.headers['content-type'] || '');
  await recordTokens(db, billingUser, { operation, tokens, dictationSeconds, source: tokens ? 'server' : 'estimate', status: upstream.status });

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

function estimateAudioSecondsFromBody(body, contentType) {
  if (!body || !body.length) return 0;
  const bitrate = contentType.includes('audio/mp4') ? 96000 : 128000;
  return Math.max(1, Math.round((body.length * 8) / bitrate));
}

async function recordTokens(db, user, event) {
  const usage = getMonthlyUsage(user);
  const tokens = Math.max(0, Math.round(Number(event.tokens || 0)));
  const dictationSeconds = Math.max(0, Math.round(Number(event.dictationSeconds || 0)));
  usage.total += tokens;
  usage.dictationSeconds += dictationSeconds;
  usage.events.push({
    at: new Date().toISOString(),
    operation: event.operation || 'AI',
    tokens,
    dictationSeconds,
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
    // Refertium International — versione multilingua per radiologi stranieri.
    // Servita come template diretto: stesso pattern degli altri (PROXY_URL e
    // PROXY_AUTH riscritti, il backend fa proxy delle chiamate AI al worker).
    if (pathname === '/international' || pathname === '/international/') {
      return await serveInternationalApp(req, res, user);
    }
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
