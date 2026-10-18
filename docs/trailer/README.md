# Trailer dall'app vera

Il trailer (`helios-trailer.mp4`, 1080p, in inglese, senza audio) è girato sull'app vera, avviata in locale con Vite. Helios gira tutto nel browser, quindi non servono servizi finti: i dati di prova (il mazzo Melodious di `record/melodious.json`, due combo e uno spreadsheet) vengono messi nel localStorage del browser di registrazione alla prima apertura (vedi `record/record.mjs`). La scena Online mostra solo la pagina: non crea stanze sui relay pubblici.

## Come rifarlo

Servono macOS, `ffmpeg` e il Chromium di Playwright (`~/Library/Caches/ms-playwright/chromium-1248`, oppure `CHROME_PATH`).

```bash
# nella cartella del progetto: l'app in sviluppo sulla porta 5199
npm run dev -- --port 5199 &

cd docs/trailer
npm i --no-save playwright-core
node record/record.mjs          # registra le scene in work/clips (le attese vengono marcate per il taglio)
python3 build_timeline.py       # taglia le attese e adatta ogni scena alle battute → work/timeline.js
node record/render.mjs "$PWD/compose.html" helios-trailer.mp4 30
```

`compose.html` si può anche aprire nel browser per vedere il montaggio dal vivo: spazio mette in pausa, le frecce saltano di 5 secondi. Per controllare solo alcuni istanti senza renderizzare tutto: `node record/stills.mjs "$PWD/compose.html" work/stills 40 92.5`.

Per rifare una sola scena: `node record/record.mjs practice`. Le scene usano i dati lasciati da quelle precedenti nello stesso browser (es. la combo registrata), quindi per rifarle tutte da capo basta rilanciare il comando senza argomenti. Didascalie, zoom e durate (in battute da 2,4 s) si cambiano in `compose.html` e in `SCENES` di `build_timeline.py`.
