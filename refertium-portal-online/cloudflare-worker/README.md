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
PROXY_AUTH_TOKEN             segreto condiviso con CLOUDFLARE_PROXY_AUTH nel backend
REFERTIUM_DASHBOARD_URL      URL online del portale/backend, es. https://app.refertium.it
REFERTIUM_ALLOWED_ORIGIN     opzionale; se assente usa l'origin di REFERTIUM_DASHBOARD_URL
WORKER_SHARED_SECRET         segreto condiviso con il backend del portale
OPENAI_API_KEY               chiave OpenAI lato server
DEEPGRAM_API_KEY             opzionale, solo se usi Deepgram
```

Il Worker accetta solo richieste browser provenienti dall'origin del portale.
Questo impedisce a un HTML salvato in locale (`file://`) o ospitato su un dominio
esterno di riusare una pagina Refertium e consumare token.

Il backend serve l'HTML del medico, sostituisce `PROXY_AUTH`, aggiunge una app
session attiva e il Worker chiede al portale se licenza/sessione sono valide
prima di inoltrare la richiesta ai provider AI.

## Deploy da dashboard Cloudflare

1. Vai su Cloudflare Dashboard.
2. Workers & Pages.
3. Crea Worker.
4. Incolla il contenuto di `refertium-proxy-worker.js`.
5. Salva e deploya.
6. Vai in Settings -> Variables and Secrets.
7. Aggiungi `PROXY_AUTH_TOKEN`.
8. Aggiungi `REFERTIUM_DASHBOARD_URL`.
9. Aggiungi `WORKER_SHARED_SECRET`.
10. Aggiungi `OPENAI_API_KEY`.
11. Aggiungi `DEEPGRAM_API_KEY` se usi Deepgram.
12. Aggiungi `REFERTIUM_ALLOWED_ORIGIN` se l'origin pubblico del portale e' diverso da `REFERTIUM_DASHBOARD_URL`.
10. Verifica che l'URL finale sia quello usato dall'app:

```text
https://refertium-api.cintioli-rc.workers.dev
```

## Test rapido

Da terminale:

```bash
curl -s https://refertium-api.cintioli-rc.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Origin: https://app.refertium.it" \
  -H "X-Auth-Token: PROXY_AUTH_TOKEN" \
  -H "X-Refertium-Proxy-Token: TOKEN_PROXY_DEL_MEDICO" \
  -H "X-Refertium-App-Session: SESSIONE_APP_ATTIVA" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Rispondi solo OK"}],"max_tokens":5}'
```

Se risponde con JSON OpenAI, il proxy funziona.

## Backend Refertium

Il backend deve avere lo stesso `WORKER_SHARED_SECRET` configurato sul Worker:

```text
WORKER_SHARED_SECRET=una-stringa-lunga-segreta
```
