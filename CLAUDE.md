# Helios — regole per Claude

Client web di Yu-Gi-Oh! (motore EDOPro in WASM, duelli P2P). Vanilla JS + Vite, niente framework. Interfaccia in
inglese, commenti nel codice in italiano.

## Lavoro sulle liste del progetto
- Le richieste arrivano da `bug-reports.md`, `features-and-improvements.md` e `reminders.md`.
- Una voce fatta resta `- [ ]` con ` [implementato, testare]` in fondo: la spunta `[x]` la mette chi l'ha provata.
- Le voci con `*` sono grandi o difficili: si fanno solo se richiesto esplicitamente.
- Se una voce è ambigua, chiedere prima di implementarla.

## Regole di interfaccia
- Ogni decklist da vedere, modificare o da cui scegliere carte usa la schermata del deck builder (`src/ui/editor.js`:
  `openDecklistEditor`, `openDeckPicker`, `openDeckViewer`, `openCardChooser`, `openCardCollector`, `openPoolEditor`),
  mai elenchi, griglie o menu a tendina fatti apposta.
- Quando un'interfaccia nomina una carta, mostra anche la sua immagine (`cardFace`, `miniCards`).
- Il deck builder, in qualunque modo si apra, mostra le opzioni utili in quella situazione (es. Sort).
- Il coaching è nascosto dietro `COACHING` in `src/data/features.js`; Watch resta visibile.

## Rilascio
- Ogni correzione deve arrivare anche allo standalone (`standalone/Helios.html`): versione in `package.json`
  (e `package-lock.json`) e tag `vX.Y.Z-beta`, che fa partire `.github/workflows/standalone.yml`.
- Niente `Co-Authored-By` di Claude nei commit.
- Flusso: commit su `testing`, PR `testing → main`, merge e tag solo dopo l'ok (PR e merge in passaggi separati).

## Verifica
- `npm run build` deve passare; `npm run dev` per provare nel browser.
- I bug visivi (campo 3D, vista inclinata, finestre) si controllano con uno screenshot.
