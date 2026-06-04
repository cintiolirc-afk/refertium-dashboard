const OPENAI_BASE = 'https://api.openai.com';
const DEEPGRAM_BASE = 'https://api.deepgram.com';

function allowedOrigin(env) {
  const configured = env.REFERTIUM_ALLOWED_ORIGIN || env.REFERTIUM_DASHBOARD_URL || '';
  if (!configured) return '';
  try {
    return new URL(configured).origin;
  } catch {
    return String(configured).replace(/\/$/, '');
  }
}

function requestOrigin(request) {
  const origin = request.headers.get('Origin');
  if (origin) return origin;
  const referer = request.headers.get('Referer') || '';
  if (!referer) return '';
  try {
    return new URL(referer).origin;
  } catch {
    return '';
  }
}

function checkOrigin(request, env) {
  const expected = allowedOrigin(env);
  if (!expected) return false;
  return requestOrigin(request) === expected;
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token, X-Refertium-Proxy-Token, X-Refertium-App-Session',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status = 200, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(request ? corsHeaders(request) : {}),
      'Cache-Control': 'no-store',
    },
  });
}

function checkAuth(request, env) {
  if (!env.PROXY_AUTH_TOKEN) return false;
  const authHeader = request.headers.get('Authorization') || '';
  const bearerToken = authHeader.match(/^Bearer\s+(.+)$/i);
  return request.headers.get('X-Auth-Token') === env.PROXY_AUTH_TOKEN
    || (bearerToken && bearerToken[1] === env.PROXY_AUTH_TOKEN);
}

function trafficLabel(request) {
  const referer = request.headers.get('Referer') || '';
  try {
    const url = new URL(referer);
    return url.pathname || referer;
  } catch {
    return referer || 'unknown';
  }
}

function responseHeaders(upstream, request) {
  return {
    'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8',
    ...corsHeaders(request),
    'Cache-Control': 'no-store',
  };
}

async function proxyOpenAI(request, env, pathname) {
  if (!env.OPENAI_API_KEY) return json({ error: 'OPENAI_API_KEY non configurata nel Worker' }, 500, request);
  const authorized = await authorizeDashboardUsage(request, env);
  if (!authorized.allowed) return json({ error: authorized.error || 'Refertium session not authorized' }, authorized.status || 403, request);

  const label = trafficLabel(request);
  console.log('Refertium proxy traffic from:', label, 'route:', pathname);

  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${env.OPENAI_API_KEY}`);
  headers.delete('Host');
  headers.delete('X-Auth-Token');
  headers.delete('X-Refertium-Proxy-Token');
  headers.delete('X-Refertium-App-Session');

  const upstream = await fetch(OPENAI_BASE + pathname, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
  });

  const responseBody = await upstream.arrayBuffer();
  reportDashboardUsage(request, env, pathname, upstream.status, responseBody).catch(error => {
    console.warn('Refertium dashboard usage report failed:', error && error.message ? error.message : error);
  });

  return new Response(responseBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream, request),
  });
}

async function authorizeDashboardUsage(request, env) {
  const dashboardUrl = env.REFERTIUM_DASHBOARD_URL;
  const proxyToken = request.headers.get('X-Refertium-Proxy-Token');
  const appSession = request.headers.get('X-Refertium-App-Session');
  if (!dashboardUrl || !proxyToken || !env.WORKER_SHARED_SECRET) return { allowed: false, status: 401, error: 'Missing dashboard authorization' };
  const response = await fetch(dashboardUrl.replace(/\/$/, '') + '/api/proxy/authorize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Worker-Secret': env.WORKER_SHARED_SECRET,
    },
    body: JSON.stringify({ proxyToken, appSession }),
  });
  if (!response.ok) return { allowed: false, status: response.status, error: 'Dashboard authorization failed' };
  const data = await response.json();
  return data && data.allowed ? { allowed: true } : { allowed: false, status: 403, error: data && (data.error || data.reason) };
}

function operationFor(pathname) {
  if (pathname.includes('/audio/transcriptions')) return 'Trascrizione';
  if (pathname.includes('/responses')) return 'Responses';
  return 'Chat completions';
}

function tokensFromResponse(responseBody) {
  try {
    const data = JSON.parse(new TextDecoder().decode(responseBody));
    const usage = data.usage || {};
    return Number(usage.total_tokens || ((usage.prompt_tokens || usage.input_tokens || 0) + (usage.completion_tokens || usage.output_tokens || 0))) || 0;
  } catch {
    return 0;
  }
}

async function reportDashboardUsage(request, env, pathname, status, responseBody) {
  const dashboardUrl = env.REFERTIUM_DASHBOARD_URL;
  const proxyToken = request.headers.get('X-Refertium-Proxy-Token');
  const appSession = request.headers.get('X-Refertium-App-Session');
  if (!dashboardUrl || !proxyToken || !env.WORKER_SHARED_SECRET) return;
  await fetch(dashboardUrl.replace(/\/$/, '') + '/api/proxy/usage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Worker-Secret': env.WORKER_SHARED_SECRET,
    },
    body: JSON.stringify({
      proxyToken,
      appSession,
      operation: operationFor(pathname),
      tokens: tokensFromResponse(responseBody),
      source: 'cloudflare',
      status,
    }),
  });
}

async function deepgramToken(request, env) {
  if (!env.DEEPGRAM_API_KEY) return json({ error: 'DEEPGRAM_API_KEY non configurata nel Worker' }, 500, request);
  const authorized = await authorizeDashboardUsage(request, env);
  if (!authorized.allowed) return json({ error: authorized.error || 'Refertium session not authorized' }, authorized.status || 403, request);

  console.log('Refertium Deepgram token from:', trafficLabel(request));

  const upstream = await fetch(DEEPGRAM_BASE + '/v1/auth/grant', {
    method: 'POST',
    headers: {
      Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ time_to_live_in_seconds: 600 }),
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders(upstream, request),
  });
}

export default {
  async fetch(request, env) {
    if (!checkOrigin(request, env)) return json({ error: 'Unauthorized origin' }, 403, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
    if (!checkAuth(request, env)) return json({ error: 'Unauthorized proxy request' }, 401, request);

    const pathname = new URL(request.url).pathname;

    if (pathname === '/v1/deepgram/token') return deepgramToken(request, env);

    if ([
      '/v1/chat/completions',
      '/v1/responses',
      '/v1/audio/transcriptions',
    ].includes(pathname)) return proxyOpenAI(request, env, pathname);

    return json({ error: 'Route non supportata', path: pathname }, 404, request);
  },
};
