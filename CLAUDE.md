# Helios — regole per Claude

Client web di Yu-Gi-Oh! (motore EDOPro in WASM, duelli P2P). Vanilla JS + Vite, niente framework. Interfaccia in
inglese, commenti nel codice in italiano.

## Lavoro sulle liste del progetto
- Le richieste arrivano da `bug-reports.md`, `features-and-improvements.md` e `reminders.md`.
- I tre file hanno tre sezioni (## 1. da fare / ## 2. fatto, da testare / ## 3. verificato), divise in categorie
  (### ...), ogni voce `- [ ] **Nome**: descrizione`. Una voce fatta si sposta nella sezione 2; nella sezione 3 la
  spostano solo gli utenti, mai Claude. Per spostarle: `npm run feature -- [--bugs|--reminders] test "nome"`
  (CLI interattiva con `npm run feature`; estensione di VS Code in `tools/vscode-features`, `npm run vscode-ext`).
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
