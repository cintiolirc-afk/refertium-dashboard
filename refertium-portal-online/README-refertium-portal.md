# Refertium Portal Demo

File principale:

- `refertium-login-portal.html`

Credenziali demo:

- Admin: `admin@refertium.local` / `refertium-admin`
- Utente: `demo@refertium.local` / `demo123`

Uso rapido:

1. Apri `refertium-login-portal.html` nel browser.
2. Entra come admin demo.
3. Seleziona `Dr. Demo`.
4. Carica un file HTML Refertium personalizzato nel campo `HTML personalizzato`.
5. Salva l'utente.
6. Apri l'app utente dal pulsante `Apri app utente`.

Funzioni incluse:

- Login admin e utente.
- Upload di un HTML personalizzato per ciascun utente.
- Stato licenza: attiva, limitata, bloccata.
- Limite token mensile per utente.
- Tracking token intercettando le chiamate dell'HTML caricato verso OpenAI/Responses/trascrizione.
- Esportazione JSON dello stato locale.

Nota importante:

Questa e' una demo frontend locale. Password, licenze, HTML caricati e consumi sono salvati in `localStorage`; va bene per prototipo e presentazione, non per produzione. Per andare online serve spostare autenticazione, storage HTML, licenze e conteggio token su un backend con database.

Ho copiato anche l'app allegata qui:

- `refertium-assets/REFERTIUM_v52-7.html`

