# Refertium Cloudflare Proxy Worker

Questo Worker espone le rotte che l'HTML Refertium usa gia':

```text
/v1/chat/completions
/v1/responses
/v1/audio/transcriptions
/v1/deepgram/token
```

## Variabili/secrets da impostare su Cloudflare

```text
OPENAI_API_KEY          chiave OpenAI lato server
PORTAL_BASE_URL         URL online del portale, es. https://app.refertium.it
WORKER_SHARED_SECRET    segreto condiviso con il backend del portale
DEEPGRAM_API_KEY        opzionale, solo se usi Deepgram
```

Il vecchio `PROXY_AUTH_TOKEN` unico non si usa piu'.

Ogni medico ha un token personale generato dal portale. Quando il portale serve
l'HTML del medico, sostituisce `PROXY_AUTH` con quel token personale. Il Worker
riceve quel token, chiede al portale se la licenza e' attiva, poi registra i token consumati.

## Deploy da dashboard Cloudflare

1. Vai su Cloudflare Dashboard.
2. Workers & Pages.
3. Crea Worker.
4. Incolla il contenuto di `refertium-proxy-worker.js`.
5. Salva e deploya.
6. Vai in Settings -> Variables and Secrets.
7. Aggiungi `OPENAI_API_KEY`.
8. Aggiungi `PORTAL_BASE_URL`.
9. Aggiungi `WORKER_SHARED_SECRET`.
10. Aggiungi `DEEPGRAM_API_KEY` se usi Deepgram.
10. Verifica che l'URL finale sia quello usato dall'app:

```text
https://refertium-api.cintioli-rc.workers.dev
```

## Test rapido

Da terminale:

```bash
curl -s https://refertium-api.cintioli-rc.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: TOKEN_PROXY_DEL_MEDICO" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Rispondi solo OK"}],"max_tokens":5}'
```

Se risponde con JSON OpenAI, il proxy funziona.

## Backend Refertium

Il backend deve avere lo stesso `WORKER_SHARED_SECRET` configurato sul Worker:

```text
WORKER_SHARED_SECRET=una-stringa-lunga-segreta
```
