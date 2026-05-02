# Refertium Online - versione semplice

## Cosa fa questa versione

```text
Medico -> login Refertium -> apre il suo HTML personale
HTML personale -> usa il suo proxy Cloudflare gia configurato
Portale -> controlla ogni 30 secondi se la licenza e ancora attiva
```

Quindi:

- gli HTML restano con il loro proxy Cloudflare;
- il portale non cambia `PROXY_URL`;
- il portale non cambia `PROXY_AUTH`;
- se blocchi la licenza, la pagina aperta si blocca entro circa 30 secondi;
- la lingua del portale puo essere italiano/inglese.

## Cosa puoi fare da admin

- creare un medico;
- dare username e password;
- caricare o sostituire HTML;
- bloccare/sbloccare licenza;
- impostare limite token;
- aprire anteprima.

## Credenziali iniziali

```text
Admin
username: admin
password: refertium-admin

Utente demo
username: demo
password: demo123
```

## Come metterlo online velocemente con Render

1. Crea account su Render.
2. Metti questa cartella su GitHub.
3. Render -> New -> Web Service.
4. Collega il repository.
5. Runtime: Node.
6. Start command:

```bash
node backend/server.js
```

7. Deploy.

Render ti dara un link tipo:

```text
https://refertium-portal.onrender.com
```

Quello sara il link da dare ai medici.

## Cloudflare Worker

Se i tuoi HTML funzionano gia con Cloudflare, non devi cambiare nulla.

Se vuoi usare il Worker di esempio, le variabili sono solo:

```text
OPENAI_API_KEY
PROXY_AUTH_TOKEN
DEEPGRAM_API_KEY
```

`DEEPGRAM_API_KEY` serve solo se usi Deepgram.

## Blocco licenza

Quando un medico apre il suo HTML, il portale inserisce solo un piccolo controllo licenza.

Ogni 30 secondi il controllo chiede:

```text
/api/license-status
```

Se la licenza e bloccata, compare una schermata sopra l'app e il medico non puo continuare.

## Tracking traffico per HTML

Senza modificare i proxy, il modo piu semplice e usare il `Referer`.

Quando l'HTML chiama Cloudflare, Cloudflare puo vedere da quale pagina arriva:

```text
/app/id-del-medico
```

Questo e utile come etichetta indicativa.

Non e un sistema di sicurezza forte, ma va bene per capire da quale HTML arriva il traffico.

