# Refertium Backend

Backend semplice per:

- login admin e utenti medico con username/password;
- gestione licenze;
- upload HTML personalizzato per singolo utente;
- apertura app personalizzata da `/app/:userId`;
- blocco automatico della pagina se la licenza scade mentre l'app e aperta;
- database JSON locale.

## Avvio locale

```bash
cd /Users/robertocintioli/Documents/Codex/2026-05-02/files-mentioned-by-the-user-index
node backend/server.js
```

Poi apri:

```text
http://localhost:47825
```

## Credenziali demo

```text
Admin:  admin / refertium-admin
Utente: demo  / demo123
```

## Flusso admin

1. Entra come admin.
2. Crea o seleziona un medico.
3. Imposta username, password e licenza.
4. Carica l'HTML personale.
5. Salva.
6. Clicca `Apri app utente`.

## Licenza mentre la pagina e aperta

Quando il medico apre il suo HTML, il portale aggiunge un piccolo controllo:

```text
/api/license-status
```

Il controllo parte ogni 30 secondi.

Se la licenza diventa bloccata, la pagina viene coperta da una schermata di blocco.

## Proxy Cloudflare

Gli HTML mantengono il loro proxy Cloudflare gia configurato.

Il portale non modifica:

```text
PROXY_URL
PROXY_AUTH
```

## Dati locali

```text
backend/data/db.json       utenti e licenze
backend/uploads/*.html     HTML caricati
```

