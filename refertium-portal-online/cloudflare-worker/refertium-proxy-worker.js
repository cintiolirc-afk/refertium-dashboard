const OPENAI_BASE = 'https://api.openai.com';
const DEEPGRAM_BASE = 'https://api.deepgram.com';

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token',
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
  return Boolean(env.PROXY_AUTH_TOKEN) && request.headers.get('X-Auth-Token') === env.PROXY_AUTH_TOKEN;
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

  const label = trafficLabel(request);
  console.log('Refertium proxy traffic from:', label, 'route:', pathname);

  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${env.OPENAI_API_KEY}`);
  headers.delete('Host');
  headers.delete('X-Auth-Token');

  const upstream = await fetch(OPENAI_BASE + pathname, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream, request),
  });
}

async function deepgramToken(request, env) {
  if (!env.DEEPGRAM_API_KEY) return json({ error: 'DEEPGRAM_API_KEY non configurata nel Worker' }, 500, request);

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
