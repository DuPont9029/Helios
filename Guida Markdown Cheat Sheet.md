# Markdown Cheat Sheet

Un riferimento rapido alla sintassi Markdown.

> Fonte: [Markdown Cheat Sheet – Markdown Guide](https://www.markdownguide.org/cheat-sheet/), un progetto di Matt Cone, rilasciato con licenza [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Questa versione è un adattamento in italiano ed è distribuita con la stessa licenza.

## Panoramica

Questa cheat sheet offre una panoramica di tutti gli elementi della sintassi Markdown. Non copre ogni caso limite: per approfondire, consulta le guide di riferimento per la [sintassi di base](https://www.markdownguide.org/basic-syntax/) e la [sintassi estesa](https://www.markdownguide.org/extended-syntax/).


---

## Sintassi di base

Sono gli elementi descritti nel documento di design originale di John Gruber. Tutte le applicazioni Markdown li supportano.

### Titoli

```markdown
# H1
## H2
### H3
```

### Grassetto

```markdown
**testo in grassetto**
```

### Corsivo

```markdown
*testo in corsivo*
```

### Citazione

```markdown
> citazione
```

### Lista ordinata

```markdown
1. Primo elemento
2. Secondo elemento
3. Terzo elemento
```

### Lista non ordinata

```markdown
- Primo elemento
- Secondo elemento
- Terzo elemento
```

### Codice inline

```markdown
`codice`
```

### Linea orizzontale

```markdown
---
```

### Link

```markdown
[titolo](https://www.example.com)
```

### Immagine

```markdown
![testo alternativo](immagine.jpg)
```


---

## Sintassi estesa

Questi elementi estendono la sintassi di base con funzionalità aggiuntive. Non tutte le applicazioni Markdown li supportano.

### Tabella

```markdown
| Sintassi    | Descrizione |
| ----------- | ----------- |
| Intestazione| Titolo      |
| Paragrafo   | Testo       |
```

### Blocco di codice delimitato

```markdown
```
{
  "firstName": "John",
  "lastName": "Smith",
  "age": 25
}
```
```

### Nota a piè di pagina

```markdown
Ecco una frase con una nota. [^1]

[^1]: Questa è la nota.
```

### ID del titolo

```markdown
### Il mio titolo {#custom-id}
```

### Lista di definizioni

```markdown
termine
: definizione
```

### Barrato

```markdown
~~La Terra è piatta.~~
```

### Lista di attività

```markdown
- [x] Scrivere il comunicato stampa
- [ ] Aggiornare il sito
- [ ] Contattare i media
```

### Emoji

```markdown
Che ridere! :joy:
```

(In alternativa puoi copiare e incollare direttamente l'emoji.)

### Evidenziato

```markdown
Devo evidenziare queste ==parole molto importanti==.
```

### Pedice

```markdown
H~2~O
```

### Apice

```markdown
X^2^
```


