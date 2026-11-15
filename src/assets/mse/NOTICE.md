# Asset delle carte personalizzate

Cornici, attributi, stelle, segni di Magie/Trappole, frecce Link e riquadro Pendulum usati per disegnare le carte
personalizzate (`src/ui/card-render.js`) vengono dallo stile Yu-Gi-Oh! "Series 10" di Magic Set Editor:

- repository: https://github.com/247321453/MagicSetEditor-Style
  (`data/yugioh-series10.mse-style` e `data/yugioh-standard-levels.mse-symbol-font`)
- licenza: Apache License 2.0 (copia in `LICENSE`)
- Magic Set Editor: https://github.com/twanvl/MagicSetEditor2

Modifiche: le cornici (`frames/`) sono convertite da PNG a JPEG (qualità 90, stessa risoluzione 813×1185); i nomi dei
file sono abbreviati (es. `card-effect.png` → `frames/effect.jpg`, `attribute/dark_en.png` → `attribute/dark.png`,
`enmark/quickspell.png` → `marks/quickspell.png`, `pendulum/pendulum_md.png` → `pendulum.png`). I caratteri dello stile
(Matrix, ITC Stone Serif, Leisho) non sono inclusi: il disegno usa caratteri serif di sistema.

Yu-Gi-Oh! è un marchio di Konami; Helios è un client non ufficiale e senza scopo di lucro.
