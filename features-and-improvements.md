# Features and Improvements (\* indica una funzoine difficile/impossibile da implementare o grande feature)

- [x] Cambiare zone pendulum per farle funzionare come le foderine ossia ogniuno vede quelle impostate dall’altro sul campo avversario.
- [x] Cambiare le gemme pendulum default per somigliare più a le ufficiali.
- [x] Per le interazioni con il campo far selezionare le carte direttamente dal campo come per le evocazioni inerenti dall’extra deck. ES: Dawn Angel Kambi si offre in tributo insieme ad altre fate sul campo per evocare un mostro fata dal deck con un livello pari al totale dei lilvelli tributati dato che offre in tributo solo dal campo il giocatore dovrebbe selezionare dal campo i mostri anziche da una finestra.


- [x] Miglioramento generale del log, in particolare far vedere i target degli effetti e le carte che sono state influenzate da la risoluzione di un effetto (rubare quanto possibile dalla logica di omega).
- [x] Lingering effect window tipo master duel.
- [x] Sovrapporre il timer e le opzioni di priorità quando lo schermo è offuscato da una finestra.
- [x] Cambiare ordine della selezione nella schermata principale (online, deck, test, trainer, cpu, settings).
- [x] Implementare una modalità "strict" per il combo trainer dove qualsiasi mossa diversa da quella che devi fare non te la fa effettuare proprio e ti dice quale devi effettivamente fare.
- [x] mettere nella combo la possibilità di selezionare i target specifici di un effetto (carte specifiche da scartare, banishare, targettare, selezionare etc...), le zone specifiche in cui evocare i mostri e se attivare o no effetti aggiuntivi opzionali in risoluzione. In generale step delle combo molto più precisi.
- [x] Aggiungere funzionalità di rematch al combo tester.
- [x] Spostare il bottone per registrare i video alla schermata del combo trainer come opzione di esportazione video.
- [x] Aggiungere ctr+z/ctr+y all'editor delle combo.
- [x] Rimpiazzare le freccie nell'editor delle combo le freccie con un tasto che abilita il drag to reorder e incorporare l'opzione delete nei tre puntini mettendo il tasto drag to reorder tutto a destra e quello delle opzioni aggiuntive a sinistra per fare più spazio per gli step.
- [x] Cambiare "Interruptions" nel combo editor in "Hand Traps".
- [x] Nelle intrruptions invece di usre i preferiti apre una finestra che permette di cercare la carta che vuoi usare nel database.
- [x] Per alcune combo sono necessari alcuni prerequisiti tipo controllare un mostro oppure che l'avversario controlloi un mostro o che l'avverario abbia un certo tipo di carta in cima al deck o un certo tipo di mostro nell'extra deck in generale un particolare boardstate. Quindi sarebbe utile un modo di configurare lo stato della partita quando inizia la combo.
- [x] Si possono mettere a fine delle combo dei "tag" sulle carte che spiegano il ruolo di esse in una board (pop, omni-negate e cosi via.) questo testo appare nel video subito sopra la carta.
- [ ] Cambiare la visualizzazione nei replay per somigliare maggiormente a gli altri client e applicare i cambiamenti anche alla funzionalità di esportazione a video (dovrebbe ricreare il replay tramite gli step più dettagliati e registrarlo) (Elio deve ancora specificare quali sono le feature degli altri client).
- [ ] \* Engine ibrido TCG/OCG di omega in web assembly.
- [ ] \* Funzionalità di spettatore (visualizzazione come replay).
- [ ] \* Custom card editor in game con script editor integrato (le carte devono ovviamente essere usabili online e visualizzabili dall'avversario).
- [x] Aggiungere il side deck al BO3/BO5. Questo significa che tra le partite i giocatori devono essere in grado di scambiare fino a un massimo di 15 carte dal loro maindeck o extradeck con il loro side deck, prendere ispirazione da omega per capire la struttura generale.
- [ ] \* Integrare il database di www.ygoprodeck.com per permettere un filtro per popolarità che sarebbe utile in più aree del client.
- [ ] \* Funzionalità di draft/sealed/cube/roto (implementare con topografia a ring)
- [ ] \* Play queue (necessita signaling server)
- [ ] \* Friends list di giocatori online (necessita signaling server)
- [ ] Non mandare info su effetti che pagano un costo di attivazione come è gia implementato per summon.
- [ ] Auto copia e auto incolla di codice room come per la connesione con gli invite code. (aggiornare anche la pagina per lasciare intendere che entrambe le connessioni sono P2P serverless)
- [ ] Implementa funxionalità di PWA.
- [ ] Superimporre anche la lingering effect window e le istruzioni del combo trainer insieme alle opzioni di priorità.
- [ ] Ulteriore miglioramento del log, mostrare le zone nella quale vengono evocati i mostri e attivate le magie e trappole. Inoltre mostrare dove si attivano gli effetti tipo i dracotail che si attivano al cimitero dopo essere stati usati per fusioni, i melodious che si attivano in extradeck oppure dewn angel kambi che si attiva in mano per evocarsi.
- [ ] Cambiare la scritta: "special summon" in pendulum summon quando si evoca pendulum.
- [ ] Spostare il pulsante finish nel combo editor in modo tale da non dover scrollare tutti gli step precedenti per tornare al bottone.
- [ ] La finestra per arrendersi in una partita dovrebbe sovrapporsi a qualsiasi altra finestra aperta.
- [ ] Aggiungere opzione di combo auto play senza video.
- [ ] Abilità di manipolare la cima del proprio deck in combo trainer.
- [ ] Le pagine che presentano una lista di carte (ES: quando si sceglie una carta nel combo tester editor) ciò dovrebbe accadere seguendo l'ordine che si usa nel deck builder.
- [ ] Rimuovere il warning nel combo trainer per avere meno di una carta in mano.
- [ ] implementare una Hypergeometric Distribution Probability Calculator (da abbreviare come HDPC) necessaria a capire la probabilità di aprire certe carte nella tua mano iniziale prendendo ispirazione da https://stattrek.com/online-calculator/hypergeometric e https://www.deck-probability.com/ che funzionano bene.
- [ ] Raggruppare le sezioni del menu principale (vs cpu, test duel, combo trainer e Hypergeometric Distribution Probability Calculator) in una sola sezione chiamata training.

- [ ] Staccare le combo da una decklist e chiedere cosa serva a nel deck e extradeck per compiere la combo dal combo trainer editor riconoscere le carte necessarie nel dalla registrazione.

- [ ] Branching combos nel combo trainer per vedere versioni diverse della stessa combo magari con carte diverse necessarie nel deck o extradeck.

- [ ] Schema per la visualizzazione della combo (includere l'opzione di mettere note per il giocatore quando si crea una combo nuova) (prendere ad esempio la sezione combo di https://www.masterduelmeta.com/combos-and-counters#combos) e fork delle combo, versioni diverse con leggere differenze.

- [ ] Aggiungere una sezione spreadsheets che permette di creare spreadsheets che includono più combo per uno stesso deck con diversi starter e permettere di aggiungere combo ad essa o rimuoverle permettendo sia di registranrne o programmarne di nuove che di prenderne di già esistenti (Prendere ispirazione da https://www.masterduelmeta.com/combos-and-counters#spreadsheets).

- [ ] Integrare nella sezione spredsheets modo di aggiungere una sample decklist.

- [ ] Far calcolare a una spreadsheet tutte le carte necessarie per quel deck usando le informazinìoni su le carte necessarie per le combo individuali.


