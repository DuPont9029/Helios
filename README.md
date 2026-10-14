# Helios

Client di Yu-Gi-Oh! che gira interamente nel browser (HTML, CSS e JavaScript senza framework), con:

- **motore regole completo**: il core di EDOPro (`ygopro-core`) compilato in WebAssembly ed eseguito in un Web Worker;
- **carte, script e banlist di Project Ignis**: [CardScripts](https://github.com/ProjectIgnis/CardScripts), [BabelCDB](https://github.com/ProjectIgnis/BabelCDB), [LFLists](https://github.com/ProjectIgnis/LFLists);
- **duelli P2P via WebRTC** (DataChannel), con STUN per la connessione diretta e TURN come relay;
- timer di riflessione con la logica di YGO Omega (180 s per giocatore, +3 s per azione fino a +450 s, il tempo accelera se resti fermo, si azzera a ogni turno);
- elenco mazzi (crea, importa, elimina uno o più mazzi), deck editor, duello contro una CPU semplice e duello di prova in cui controlli entrambi i giocatori.

## Avvio rapido

```bash
npm install          # scarica anche il core WASM (scripts/fetch-ocgcore.mjs)
npm run data         # clona i repo Project Ignis in vendor/ e genera public/data/
npm run signal       # server di segnalazione + /api/ice  (porta 8787)
npm run dev          # http://localhost:5173
```

Per provare il motore senza interfaccia: `npm run test:core` (due IA giocano due partite con lo stesso seed e il test verifica che siano identiche).
Per vedere una partita IA contro IA nel browser: `http://localhost:5173/#ai-vs-ai`.

### Produzione

```bash
npm run build                    # genera dist/ (include public/data, circa 90 MB di script)
PORT=8080 npm run signal         # serve dist/ e fa da server di segnalazione sulla stessa porta
```

`dist/` funziona anche su un hosting statico qualsiasi (GitHub Pages, Netlify...). In quel caso si gioca online con il **codice invito** oppure indicando nelle Impostazioni l'URL di un server di segnalazione separato.

## Come funziona il multiplayer

```
 Browser A                    server di segnalazione              Browser B
 ─────────                    (solo per l'incontro)               ─────────
 offerta SDP + candidati ICE ──────────► stanza ◄────────── risposta SDP + candidati ICE
          ◄──────────── DataChannel WebRTC diretto (o via TURN) ────────────►
```

1. **Incontro.** Ci sono due modi:
   - *Stanza online*: `server/signal.mjs` (WebSocket) mette in contatto i due giocatori con un codice di 6 caratteri;
   - *Codice invito*: l'host genera un codice (SDP compresso con deflate) e l'altro risponde con un secondo codice. Non serve nessun server, solo STUN/TURN.
2. **Connessione.** Si usa `RTCPeerConnection` con i server ICE configurati: STUN (Google e Cloudflare di default) per il P2P diretto, TURN quando i NAT non lo permettono. La pagina online mostra se la connessione è diretta o passa dal relay.
3. **Accordo.** I peer si scambiano nomi, mazzi e versione dei dati. Il seed del duello si ottiene con un commit-reveal (`SHA-256`), così nessuno dei due può sceglierlo da solo. Un lancio di moneta deterministico decide chi sceglie se iniziare per primo.
4. **Lockstep.** Entrambi eseguono lo stesso core con lo stesso seed. Sulla rete passano solo le risposte del giocatore che deve scegliere, insieme a un checksum dello stato che serve a rilevare desincronizzazioni. Il core è deterministico: `npm run test:core` lo verifica.

> Nota: come in ogni lockstep, il client conosce anche le informazioni nascoste (la mano avversaria, per esempio). L'interfaccia non le mostra, ma un client modificato potrebbe leggerle. Per partite competitive servirebbe un server autoritativo che filtri i messaggi.

## STUN e TURN

Nelle **Impostazioni** si possono indicare server STUN e TURN, e il pulsante *Testa STUN/TURN* controlla quali candidati si riescono a ottenere.

Per un server TURN proprio con [coturn](https://github.com/coturn/coturn) e credenziali temporanee:

```conf
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
realm=ygo.example.com
use-auth-secret
static-auth-secret=UN_SEGRETO_LUNGO
fingerprint
no-cli
```

```bash
TURN_URLS="turn:ygo.example.com:3478?transport=udp turn:ygo.example.com:3478?transport=tcp turns:ygo.example.com:5349" \
TURN_SECRET=UN_SEGRETO_LUNGO npm run signal
```

Il server di segnalazione genera per ogni stanza credenziali TURN valide 24 ore (formato *TURN REST API*). In alternativa si possono usare credenziali statiche con `TURN_USERNAME` e `TURN_CREDENTIAL`.

### TURN di Cloudflare con il sito su GitHub Pages

Il token di Cloudflare non va mai messo nel sito: chiunque potrebbe leggerlo. In `cloudflare/turn-credentials/` c'è un Worker che lo tiene come secret e restituisce al client solo credenziali temporanee (4 ore), e solo alle pagine del dominio autorizzato.

```bash
cd cloudflare/turn-credentials
# in wrangler.toml imposta ALLOWED_ORIGINS = "https://TUONOME.github.io"
npx wrangler login
npx wrangler secret put TURN_KEY_ID          # Turn Token ID dal pannello Realtime → TURN
npx wrangler secret put TURN_KEY_API_TOKEN   # API Token della stessa chiave
npx wrangler deploy                          # stampa l'URL, es. https://ygo-turn-credentials.TUONOME.workers.dev
```

Poi scrivi l'URL del Worker in `.env.production` (`VITE_ICE_SERVERS_URL=...`), fai commit e push: il workflow di Pages lo usa nella build. Non è un segreto, quindi può stare nel repository.

Nelle Settings del client il TURN predefinito è "Cloudflare"; ogni giocatore può scegliere un suo server ("Custom") oppure nessun relay ("None").

## Struttura

```
scripts/build-data.mjs     Project Ignis → public/data (cards.json, strings.json, banlists.json, script/*.lua)
scripts/fetch-ocgcore.mjs  scarica ocgcore-wasm 0.1.4 da JSR, verifica l'integrità, applica le patch
scripts/smoke-test.mjs     test di determinismo del core in Node
server/signal.mjs          segnalazione WebSocket, /api/ice con credenziali TURN, file statici
src/core/                  motore indipendente dal DOM: engine, IA, costanti, somme, dichiarazioni
src/duel/worker.js         core WASM in un Web Worker (prefetch degli script + XHR sincrono)
src/duel/session.js        ciclo della partita: UI locale / IA / avversario remoto
src/net/                   WebRTC (peer.js), segnalazione (signaling.js), accordo iniziale (match.js)
src/ui/                    menu, deck editor, campo di gioco, richieste del core, animazioni
```

### Patch a ocgcore-wasm

`scripts/fetch-ocgcore.mjs` corregge tre bug della build minificata:

1. la risposta a `SORT_CARD` aggiungeva in testa un byte di lunghezza che il core non si aspetta;
2. `readQuery` non leggeva `QUERY_TYPE` e non saltava i campi sconosciuti, per cui il resto della query veniva letto disallineato;
3. ATK e DEF venivano letti come interi senza segno (il valore `-2`, cioè "?", diventava 4294967294).

Su npm c'è solo la versione 0.1.2: oltre a questi bug ha un core troppo vecchio per gli script attuali (per esempio non riconosce i nuovi flag `CHAININFO`) e scrive le scale pendulum e le freccette link agli offset sbagliati. Per questo il progetto usa la 0.1.4 pubblicata su JSR.

## Grafica e asset

L'interfaccia riprende lo stile di MDPro3 (fondo nero con scie rosse e blu, menu con voci grandi in maiuscolo, accento verde lime, riquadri con bordo bianco e angoli smussati). Le schermate sono state progettate con Google Stitch partendo da screenshot di MDPro3 e poi riscritte a mano in CSS. Campo in prospettiva, dorso delle carte, scatole dei mazzi ed emblema della home sono disegnati in CSS. **Non** include asset estratti da MDPro3 o da Master Duel: provengono dal gioco di Konami e non si possono ridistribuire.

Font: Chakra Petch, JetBrains Mono e Material Symbols da Google Fonts.

Le immagini delle carte vengono caricate a runtime da un URL configurabile (di default `images.ygoprodeck.com`). Se un'immagine manca, il client disegna una cornice in CSS con i dati della carta.

## Licenze

- Il core ocgcore è AGPL-3.0 (edo9300/ygopro-core), il wrapper ocgcore-wasm è MIT.
- Script e database: Project Ignis (vedi i rispettivi repository).
- Yu-Gi-Oh! è un marchio di Konami. Questo è un progetto amatoriale, non ufficiale e senza scopo di lucro.
