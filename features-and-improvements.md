# Features and Improvements

`*` = funzione grande o difficile/impossibile da implementare: si fa solo se richiesta esplicitamente.

Tre sezioni:
1. **Da implementare**: quello che manca.
2. **Implementate, da testare**: fatte, da provare da noi. Claude può spostare qui una voce quando la implementa.
3. **Implementate e verificate**: provate da noi. Solo noi spostiamo qui una voce, Claude mai.

---

## 1. Da implementare

- [ ] * **Motore ibrido TCG/OCG**: il motore ibrido TCG/OCG di Omega compilato in WebAssembly.
- [ ] * **Carte anime e Rush**: modalità con carte anime e Rush come in YGO Omega (serve una nuova fonte per le immagini).

### Carte e dati
- [ ] * **Importare collezioni**: importare la collezione da altri simulatori.

### Contenuti per iniziare
- [ ] * **Combo delle decklist base**: combo per le decklist base.

### Interfaccia
- [ ]  **Overhaul del menu**: rifare il menu principale. 

---

## 2. Implementate, da testare

### Interfaccia
- [ ] **Profilo nella home**: nella schermata principale foto profilo, username (con il segno di verificato se registrato on-chain), tag OG, titolo e rating ELO.
- [ ] **Mazzi della card nel deck builder**: in Settings → Player card i mazzi della card si scelgono nella schermata del deck builder in sola lettura: a destra l'elenco dei mazzi (salvati e giocati online), un clic mostra la lista, la casella lo mette sulla card (massimo 3).

### Duello
- [ ] **Mano e board di partenza in Vs CPU e Test Duel**: nel setup "Starting hand and board" apre il deck builder con mano, campo, GY e carte bandite di entrambi i giocatori. Le carte della mano sono sempre in mano (il resto si pesca normalmente), quelle in gioco si tolgono dal mazzo se ci sono, altrimenti si aggiungono; mostri scoperti in Attacco, Magie Terreno scoperte, altre Magie/Trappole coperte. L'ultima scelta resta salvata, "Clear" torna alla partenza normale.
- [ ] **Costi di scarto dalla mano**: per i costi che scartano non si apre una finestra, si sceglie direttamente dalla mano.
- [ ] **Spessore di Deck ed Extra Deck**: mostrare lo spessore del Deck e dell'Extra Deck nella vista inclinata ("Tilted view in the Duel (like Master Duel) instead of from above").

### Trainer
- [ ] **Salta alla endboard**: nel pannello del Trainer "Skip to end board" gioca il resto della combo da solo e senza animazioni, fino alla board finale.
- [ ] **Controlli in auto mode**: bloccati in auto mode nel Trainer si può comunque cambiare la velocità delle animazioni e usare il bottone del fullscreen.

### Deck builder
- [ ] **Filtro avanzato**: filtro ispirato a https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=1 (senza data di uscita, che non abbiamo), con il filtro per stato nella banlist.
- [ ] **Opzioni secondo la situazione**: in qualunque modo si apra, il deck builder mostra le opzioni utili in quel momento (es. sorting).
- [ ] **Esporta come immagine**: esportare un deck come immagine.
- [ ] **No deck**: tra i deck c'è "No deck", da usare come calcolatore ipergeometrico (tipo https://stattrek.com/online-calculator/hypergeometric).
- [ ] **Copertina a scelta**: la copertina di bundle e deck si sceglie tra le carte che contengono; senza scelta è la prima.
- [ ] **Deck box vera**: la scatola del mazzo è un parallelepipedo con cima e fianco allineati agli spigoli del fronte e la linea del coperchio.
- [ ] **Colore e copertina della deck box**: pulsante con la tavolozza su ogni mazzo dell'elenco (e Deck → Deck box nell'editor) per scegliere la carta di copertina e il colore (11 proposti, automatico o libero).
- [ ] **Colori dei Base decks**: Radiant Typhoon indaco, Labrynth cremisi, Centur-ion bianco, Melorbious viola, Blue-Eyes oro (anche le copie già salvate).

### Cube editor
- [ ] **Bundle e carte più grandi**: bundle e carte più grossi sullo schermo.
- [ ] **Immagini tenute in memoria**: le immagini delle carte non si ricaricano di continuo, restano caricate per la sessione.
- [ ] **Rarità con + e −**: nella schermata di modifica di un bundle la rarità si cambia anche con i bottoni + e −.
- [ ] **"+" in fondo a ogni rarità**: un bottone "+" (come New bundle) alla fine di ogni lista di bundle crea un bundle nuovo già di quella rarità.
- [ ] **Copie uguali raggruppate**: nel deck editor del cube le carte uguali sono raggruppate come nell'HDPC, così due copie della stessa carta non possono avere rarità diverse.
- [ ] **Sorter per rarità**: nell'editor delle carte singole di un cube, ordinamento delle carte dentro le loro rarità.
- [ ] **Versioni e fork**: aggiornare o forkare un cube a una nuova versione, con la lista dei cambiamenti tra le due.
- [ ] **Statistiche del cube**: per ogni versione giocata online, pick media di carte e bundle, win-rate delle carte messe nel deck (non solo in collezione) e, da questi dati, la classifica dei bundle e delle carte più forti.

### Draft
- [ ] **Nomi dei bundle che scorrono**: durante il draft il nome di un bundle scorre quando ci passa sopra il cursore.
- [ ] **Tab laterale minimizzabile**: overhaul della tab laterale durante il draft; si può minimizzare e si riapre quando ci si trascina sopra un item per sceglierlo.
- [ ] **Preset per provare i deck draft**: preset nelle rules senza limiti di deckbuilding; Main ed Extra Deck sullo stesso schermo e il Side nell'altra tab. Il deck viene tracciato durante il draft e si apre nel deck editor a fine draft; ogni pick va in Main o Side a seconda della tab aperta quando è stato scelto.
- [ ] **Vista per bundle**: vista per bundle nel deck editor del draft.
- [ ] **Artwork alternativi**: nel deck editor del draft si possono usare gli altri artwork di una carta che hai in collezione (attenzione alle carte con lo stesso nome che non sono la stessa carta, come Fallen of the White Dragon).

### Replay e spettatori
- [ ] **Aggiungere funzionalità di replay**: la funzionalità di replay per partite fatte sia online che contro amici va aggiunta in primo luogo consentendo di vedere ed esportare sia come video che come codice replay di helios
- [ ] **qualità dei video dei replay**: il video esportato è di qualità infima migliorala considerevolmente
- [ ] **configurazione schermo**: cosa appare alla sininstra dei replay deve essere configurabile; o nulla o il log o (se nel trainer) il combo log. Inoltre non dovrebbero apparire le icone dei bottoni che sono utili durante una partita ma non senvono a chi guarda, tipo il toggle della chain, le impostazionie l'opzione di autoselezione delle zone
- [ ] **life points coperti nel replay**: adesso la finestra del log copre i life points del giocatore 1, spostare i life points a destra dove adesso si trova il pulsante delle impostazione, dell'autoplace e del toggle.

### Carte e dati
- [ ]  **Editor di carte custom**: editor in gioco con editor di script integrato; le carte devono essere usabili online e visibili all'avversario.
- [ ]  **Popolarità da YGOPRODeck**: integrare il database di www.ygoprodeck.com per filtrare per popolarità, utile in più parti del client.
- [ ]  **Related cards**: carte collegate come in Master Duel.

### Online e formati
- [ ]  **Banlist custom**: supporto alle banlist personalizzate (da aggiungere insieme al drafting).

### Account management
- [ ] **Creare account crypto**: ogni utente ha un account generato con un trng di 24 words le prime 12 andranno poi a costituire 
- [ ] **Profilo salvato su Nostr**: deck, combo, spreadsheet, cube, draft giocati contro i bot (pool, deck, risultati), sleeve, gemme Pendulum e Moai sono salvati cifrati con il profilo e tornano importandolo su un altro browser; le cancellazioni si propagano; gli elementi grandi si spezzano in parti e si riuniscono.
- [ ] **Seed veramente casuale**: "New profile" crea le 12 parole dal rumore fisico (webcam, microfono, movimenti del mouse), con la logica di Noise TRNG e la finestra in stile Helios.
- [ ] **Wallets**: Settings → Profile → Wallets mostra un indirizzo Ethereum e uno Monero derivati dalle parole del profilo come Cake Wallet, con i saldi (ETH da RPC pubblico, XMR scansionando i blocchi nel browser). In Advanced: passphrase, seed Monero a 25 parole, rescan.
- [ ] **Accesso con OneKey KeyTag e wallet del browser**: in Wallets (e in Import profile) si rifanno i buchi del proprio KeyTag su una piastra (12 buchi per riga in tre gruppi da 4 come sulla piastra, da 2048 a 1; 12 o 24 parole, controllo del checksum) e le parole diventano il profilo; "Connect browser wallet" collega un'estensione (OneKey, MetaMask, Rabby… con EIP-6963) e ne mostra indirizzo e saldo ETH, ripreso alla riapertura e scollegabile. All'account si accede solo con le parole ("Log in with seed words") o con il KeyTag: il wallet del browser serve solo a pagare il gas, non fa entrare.
- [ ] **Schede dei giocatori**: ogni giocatore ha un'immagine del profilo, una frase e una scheda pubblica (evento Nostr firmato): cliccando un amico, una richiesta, un avversario recente o un nome in classifica si apre la scheda con statistiche ELO (posizione, rating, vittorie, ultimi duelli), i mazzi che gioca online (nel deck viewer), "Add friend" o "Accept" e "Send XMR" (link monero: per il proprio wallet) se ha scelto di mostrare l'indirizzo Monero. Settings → Profile → Player card: immagine, frase, mostrare i mazzi e l'indirizzo XMR, "View my card".
- [ ] **Scheda condivisibile e personalizzabile**: la scheda del giocatore ha colore e motivo del fascione scelti da chi la crea (Settings → Profile → Player card: 8 colori o uno a scelta, Rays/Grid/Waves/Hexagons/Stars/Plain), cerchio della percentuale di vittorie, rating massimo, ultimi duelli a pallini e mazzi con la copertina; "Share" (o "Copy my card link") dà un link breve https://ygoweb.eu/#p/<10 caratteri> che apre solo la scheda, con "Open Helios" per entrare.
- [ ] **Titoli dagli scacchi**: in base all'ELO ogni giocatore ha un titolo (Class C/B/A, Expert, Candidate Master, Helios Master, International Master, Grandmaster; soglie sulla scala di Helios, da 1450 a 1900); da Candidate Master in su il titolo resta anche se il rating scende (conta il rating massimo). Il titolo è sulla scheda e in Settings → Profile (con i punti al titolo successivo) e, in partita online, titolo ed ELO stanno accanto al nome come su chess.com.
- [ ] **Username unici on-chain**: ogni username è unico (senza distinzione tra maiuscole e minuscole, "Duelist" escluso) e intestato a un wallet sul registro Ethereum contracts/HeliosNames.sol (OpenZeppelin, senza admin né commissioni, commit-reveal contro il furto del nome). Al primo avvio con il registro attivo ognuno sceglie un nome libero e lo paga (gas) con il wallet del profilo o del browser, oppure chiede a un amico di pagarlo (firma EIP-712 gratis, richiesta cifrata su Nostr, "Asked to pay" nella scheda Friends). Chi non ha uno username verificato si vede come Duelist-xxxxxx in classifica, schede, amici e partita. Il registro si deploya dalla pagina #deploy-names e l'indirizzo va in src/data/names-config.js.
- [ ] **Card NFT on-chain numerata**: la player card di Helios diventa un NFT soulbound con l'immagine SVG generata on-chain, con gli stessi dati della scheda: username, immagine del profilo, colore, motivo, frase, wallet ETH e XMR, ranking (titolo, ELO, rating massimo e Duel classificati: fotografia del momento del conio o dell'aggiornamento) e i 3 mazzi della scheda con la copertina (immagini salvate on-chain con SSTORE2). Ogni username ha un numero progressivo (#1, #2…) e i primi 100 sono OG. Da Settings → Profile → Username: "Mint my on-chain card" (anche pagato da un amico) e "Update my on-chain card", con l'avviso quando la scheda (o il ranking) non è più uguale all'NFT. Prima di firmare la finestra mostra l'anteprima esatta disegnata dal renderer del contratto (nell'aggiornamento accanto alla card di adesso).
- [ ] **Mazzi scelti sulla scheda**: in Settings → Profile → Player card si scelgono fino a 3 mazzi (tra quelli salvati e quelli giocati online, con la copertina) da mostrare sulla scheda e sulla card NFT; senza scelta valgono i 3 giocati online più di recente.
- [ ] **Registro username attivo su Ethereum mainnet**: HeliosNames è deployato su mainnet a 0x8539D33A42cf1f2ACDD72DEBD3e31A75C9F136C6 (blocco 26451515, renderer 0x7F54c5e0052c78E0f419bfc5CBFFA1ffB74B208f, sorgente verificato su Sourcify, initcode identico alla build del progetto a parte i metadata). L'indirizzo è in src/data/names-config.js: da questa versione username verificati e card NFT sono accesi per tutti.
- [ ] **Con il wallet del browser collegato c'è solo quello per Ethereum**: se è collegato MetaMask (o OneKey, Rabby…), nella finestra Wallets il wallet ETH derivato dalle parole di Helios non si mostra più (restano Monero e il wallet del browser) e per username e card NFT si paga e si firma solo con il wallet del browser ("My Helios wallet" non viene proposto). Scollegando il wallet del browser torna il wallet ETH di Helios.
- [ ] **Le parole sono l'account**: entrando con le 12 parole (o KeyTag, nsec, backup con password) si ritrova tutto l'account: username on-chain, scheda (immagine, frase, colori, mazzi scelti), rating, amici, mazzi e card personalizzate; i dati della scheda del profilo di prima non restano. Se il wallet del browser collegato (MetaMask…) ha uno username registrato con un altro account, la finestra Wallets lo dice ("This wallet is DuPont9029 #1 on another Helios account") con il pulsante "Log in with the seed words"; se invece è dello stesso account, collegandolo lo username si prende subito.

---

## 3. Implementate e verificate

### Duello
- [x] **Ricerca nel log**: si può cercare nel log della partita.

### Deck
- [x] **Nomi lunghi che scorrono**: nella schermata dei deck, un nome troppo lungo (che finisce in "...") scorre di lato quando il cursore è sulla cella del deck.

### Duello e motore
- [x] * **Tipo di effetto nelle finestre di chain**: le finestre aperte durante la partita per attivare un effetto in chain dicono di che tipo di effetto si tratta. Es: --da aggiungere esempio di altro sim--.

### Replay e spettatori
- [x] * **Spettatori**: guardare una partita in corso, visualizzata come un replay.

### Online e formati
- [x] * **Queue standard**: coda di matchmaking standard.

### Contenuti per iniziare
- [x] * **Decklist base**: decklist base incluse nel gioco, di livello base.

### Trainer
- [x] **Nuovo Trainer**: interfaccia e funzionalità ispirate a https://ygopocket.com/combos, con le feature che il client già aveva e l'ispirazione da https://www.masterduelmeta.com/combos-and-counters#spreadsheets.

### App
- [x] **Flag beta e versione 1.0**: indicazione che l'app è una beta, con la versione portata a 1.0.
- [x] **Versione per telefono**: lo stesso Helios (e lo stesso Helios.html) su un telefono usa un'interfaccia per il touch, in verticale e girato: duello col campo 3D, home, deck builder a schede con la scheda della carta (pressione lunga al posto del tasto destro), pagine su una colonna, tavolo del draft. Icone sempre centrate nei bottoni.
