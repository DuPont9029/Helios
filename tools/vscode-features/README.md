# Helios Features

Sposta le voci di `features-and-improvements.md`, `bug-reports.md` e `reminders.md` tra le tre sezioni direttamente dalla preview del Markdown.

## Uso
1. Apri uno dei tre file e la sua preview (`Cmd/Ctrl+Shift+V` oppure `Cmd/Ctrl+K V`).
2. Accanto a ogni voce ci sono i bottoni verso le altre sezioni: **→ To do**, **→ To test**, **→ Verified**.
3. Clicca: la voce si sposta sotto la stessa categoria nella sezione scelta e il file viene salvato.

Al primo clic VS Code può chiedere se permettere all'estensione di aprire il link: conferma.

Regola del progetto: in **Verified** spostano le voci solo le persone che le hanno provate.

## Installazione
- Da file: in VS Code, Estensioni → menu `...` → **Install from VSIX...** e scegli `helios-features-*.vsix`.
- Dal repository: `npm run vscode-ext`, poi riavvia VS Code.

Dal terminale c'è anche la CLI: `npm run feature` (frecce sinistra/destra per cambiare file).
