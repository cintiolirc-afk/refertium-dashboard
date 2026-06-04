# Refertium HTML Template Agent Instructions

Use this document when generating a new Refertium application HTML file: the standalone HTML that runs dictation, speech recognition, and AI report generation.

The portal does not fully rewrite the app logic. It injects licensing, session, proxy, and user-specific configuration around the generated HTML. Because of that, the HTML must keep the contract below.

## Required Proxy Constants

The HTML must define these constants exactly as simple JavaScript declarations:

```html
<script>
const PROXY_URL = 'https://refertium-api.cintioli-rc.workers.dev';
const PROXY_AUTH = 'refertium-sec-2026';
</script>
```

Do not rename them. The portal rewrites these lines at runtime:

- local backend mode: `PROXY_URL = window.location.origin`, `PROXY_AUTH = 'session'`;
- Cloudflare mode: `PROXY_URL = CLOUDFLARE_PROXY_URL`, `PROXY_AUTH = CLOUDFLARE_PROXY_AUTH`.

The declarations must match this pattern:

```js
const PROXY_URL = '...';
const PROXY_AUTH = '...';
```

Avoid `let`, `var`, dynamic construction, environment reads, or minified declarations for these two constants.

## Required Injection Markers

The portal replaces content between marker pairs. Keep the markers exactly as shown.

For the doctor badge in HTML:

```html
<!-- @@REFERTIUM_INJECTION_POINT@@ DOCTOR_BADGE START -->
<!-- @@REFERTIUM_INJECTION_POINT@@ DOCTOR_BADGE END -->
```

For user-specific JavaScript data:

```js
/* @@REFERTIUM_INJECTION_POINT@@ MAGIC_PDF_TEXT START */
var MAGIC_PDF_TEXT = '';
/* @@REFERTIUM_INJECTION_POINT@@ MAGIC_PDF_TEXT END */

/* @@REFERTIUM_INJECTION_POINT@@ WHISPER_PROMPT START */
var WHISPER_PROMPT = '';
/* @@REFERTIUM_INJECTION_POINT@@ WHISPER_PROMPT END */

/* @@REFERTIUM_INJECTION_POINT@@ DOCTOR_SPECIALTY START */
var DOCTOR_SPECIALTY = [];
/* @@REFERTIUM_INJECTION_POINT@@ DOCTOR_SPECIALTY END */

/* @@REFERTIUM_INJECTION_POINT@@ ENABLED_DISTRICTS START */
var ENABLED_DISTRICTS = null;
/* @@REFERTIUM_INJECTION_POINT@@ ENABLED_DISTRICTS END */

/* @@REFERTIUM_INJECTION_POINT@@ IS_VERGINE START */
var IS_VERGINE = true;
/* @@REFERTIUM_INJECTION_POINT@@ IS_VERGINE END */

/* @@REFERTIUM_INJECTION_POINT@@ EDITION START */
var EDITION = 'pro';
var INCLUDE_DICTATION = true;
/* @@REFERTIUM_INJECTION_POINT@@ EDITION END */
```

The admin template upload currently rejects templates that do not include:

- `@@REFERTIUM_INJECTION_POINT@@ DOCTOR_BADGE START`
- `@@REFERTIUM_INJECTION_POINT@@ MAGIC_PDF_TEXT START`
- `const PROXY_URL`

The other markers are also required for correct generated user apps.

## AI and Recognition Calls

All AI and recognition calls must go through `PROXY_URL`. Never call OpenAI or Deepgram directly from the browser.

Supported endpoints:

```text
POST ${PROXY_URL}/v1/audio/transcriptions
POST ${PROXY_URL}/v1/chat/completions
POST ${PROXY_URL}/v1/responses
GET  ${PROXY_URL}/v1/deepgram/token
```

For OpenAI transcription:

```js
const headers = {};
if (PROXY_AUTH && PROXY_AUTH !== 'session') headers.Authorization = 'Bearer ' + PROXY_AUTH;

const response = await fetch(PROXY_URL + '/v1/audio/transcriptions', {
  method: 'POST',
  headers,
  body: formData
});
```

For JSON AI calls:

```js
const headers = { 'Content-Type': 'application/json' };
if (PROXY_AUTH && PROXY_AUTH !== 'session') headers.Authorization = 'Bearer ' + PROXY_AUTH;

const response = await fetch(PROXY_URL + '/v1/chat/completions', {
  method: 'POST',
  headers,
  body: JSON.stringify(payload)
});
```

For legacy templates, `X-Auth-Token: PROXY_AUTH` is also accepted by the Worker. New templates should prefer `Authorization: Bearer`.

## Session and License Integration

Do not implement your own license or user-session logic inside the generated HTML.

The portal injects runtime scripts that:

- call `/api/license-status`;
- block the page if the license is inactive or the tab session is stale;
- attach `X-Refertium-Proxy-Token` and `X-Refertium-App-Session` to AI requests;
- track token and dictation usage;
- enforce the single active app session rule.

Because of this, AI calls must use `fetch`. Do not bypass `window.fetch` with raw `XMLHttpRequest`, third-party SDK browser clients, Web Workers that make their own AI calls, or hidden iframes.

## Dictation Runtime Expectations

If the template supports live dictation, keep these runtime conventions:

```js
window.state = window.state || {};
state.sttProvider = state.sttProvider || 'deepgram';
state.deepgramKey = state.deepgramKey || '';
state.apiKey = state.apiKey || '';
```

The portal may patch these values:

- in local proxy mode it forces OpenAI STT through the backend;
- in Cloudflare mode it can use Deepgram token proxying;
- if `state.sttProvider === 'deepgram'` and there is no direct key, the portal can set `state.deepgramKey = '__refertium_proxy__'`.

The template should not require doctors to paste OpenAI or Deepgram keys in production.

## Prompt Hook Compatibility

If the template exposes these functions, keep their names stable:

```js
window.systemPromptForReport
window.buildMagicSystemPrompt
```

The portal may wrap them to add strict Refertium safety instructions. If the template uses different prompt builders, add compatibility wrappers with these names.

## Required HTML Shape

The file should be a complete standalone HTML document:

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
  ...
</body>
</html>
```

The portal injects scripts/styles immediately after `<head>`. Keep a normal `<head>` tag.

## Do Not Do This

- Do not hardcode real API keys in the HTML.
- Do not store provider secrets in `localStorage`.
- Do not call `https://api.openai.com` or `https://api.deepgram.com` directly from the browser, except Deepgram WebSocket after receiving a temporary proxied token.
- Do not rename `PROXY_URL` or `PROXY_AUTH`.
- Do not remove injection markers.
- Do not minify away or transform the required marker comments.
- Do not bypass `window.fetch` for AI requests.
- Do not implement independent payment, license, or session checks inside the HTML.

## Quick Validation Checklist

Before handing the HTML to the portal, confirm:

- `const PROXY_URL = '...';` exists.
- `const PROXY_AUTH = '...';` exists.
- All injection marker pairs exist.
- OpenAI transcription uses `${PROXY_URL}/v1/audio/transcriptions`.
- Chat/report generation uses `${PROXY_URL}/v1/chat/completions` or `${PROXY_URL}/v1/responses`.
- The template works without a user-entered OpenAI or Deepgram API key.
- The app makes AI calls through `fetch`.
- No real secrets are embedded in the file.
