# Lampada — guida rapida per lo sviluppo

Plugin Obsidian (JS puro, moduli ES in `src/`). `main.js` è generato: **non modificarlo mai a mano**.
Build, prove e copia sul telefono: skill `lampada-build` (oppure `npm run build`).
Formati dei dati del vault (note, indici, campi risposta): skill `jwstudy-formati`.

## Dove sta cosa
| Modulo | Contenuto |
|---|---|
| `guscio.js` | vista unica `LampadaView` (`lampada-app`): monta Bibbia, Biblioteca, SCRABB e Chiedi come sezioni (`view.inShell`), cronologia unica (`push`/`goBack`, `{ area, snap }`), linguette in basso quando è stretto. Con `settings.appShell` tutte le aperture (`openReader`, `openLibraryDoc`…) passano da `plugin.shellGo` |
| `oggi.js` | sezione Oggi (`TodayView`, `lampada-oggi`): data, "Cerca o chiedi", settimana (`renderWeekCard` da `biblioteca-vista.js`), Riprendi, segnalibri e recenti. È la sezione iniziale del guscio |
| `ricerca.js` | indice delle parole per Chiedi (radici italiane, pezzi in `Indici/ricerca/`, BM25). Pubblicazioni divise con `paragraphsOf` (^pN), note delle cartelle in più con `notePars` (blocchi tra righe vuote, pid = riga). Senza Obsidian: si prova in Node |
| `chat-biblioteca.js` | Chiedi alla biblioteca: `LibrarySearch` (indice nel vault; chiave = nome del file per le pubblicazioni, percorso con "/" per le note di `settings.chatFolders`), `askLibrary` (AI con gli strumenti `cerca` e `versetto`), vista chat |
| `plugin.js` | classe del plugin: comandi (`addCommand`), `refresh()` (rilegge le pubblicazioni dopo un import), salvataggi, dati utente, campi risposta (`answerBox`, `docAnswerFields`), `readJson`, API per estensioni (`registerProvider`, `has`, `ask`) |
| `bibbia-dati.js` | Bibbia: libri (con `idx.lang` diverso da `I`: abbreviazioni dell'indice e niente alias italiani), `findBook`, `parseReference`, `scanLine`, `indexFiles()` (indici delle pubblicazioni), `prefix` (= `.lampada/markdown/`), `bibles` (Bibbie complete del vault, dalla cache delle cartelle per dispositivo: `[firma, cartella, titolo se ha i libri]`). Pannello del versetto: ogni sezione si inserisce al suo posto in `section()` secondo `paneOrder(settings)` (`costanti.js`, `PANE_SECTIONS`: chiave → nome mostrato con `paneLabel`, uguale in Bibbia, Biblioteca e impostazioni; impostazioni "Pannello del versetto"), anche quelle che arrivano dopo. Si cambia con `plugin.setBible(symbol)` (selettore nella pagina dei libri e nel menu ⋯ del lettore; resta sullo stesso capitolo) |
| `bibbia-epub.js` | Bibbia dall'EPUB del sito (simbolo `nwt`, lingue `BIBLE_LANGS`, `settings.bibleLang`): `epubInfo(lang, pub, issue)` e `bibleEpubInfo` (API GETPUBMEDIALINKS, nessuna pagina HTML; `decode`, `slugify`, `jwLink`, `q`, `mb` in comune con `biblioteca-epub.js`), `convertBibleEpub` (EPUB → capitoli .md, `<libro>.versi.json` con le "Note in calce", `index/nwt.json` con `lang`, `abbr`, `chapterName`; legge solo le voci dello zip che servono), `downloadBible`, pannello `renderBibleDownload` (Bibbia, Biblioteca, Oggi quando `load()` lancia un errore con `noBible`) e comando *Scarica la Bibbia* (`BibleDownloadModal`) |
| `biblioteca-epub.js` | pubblicazioni dagli EPUB del sito (comandi *Importa un EPUB…* e *Cerca nuovi numeri*, pulsante "Importa…" della biblioteca, `EpubImportModal`): `parseSymbol` (`w26.01` → `{ pub, issue }`), `epubInfo` (in `bibbia-epub.js`, API GETPUBMEDIALINKS, 404 = non c'è), `convertPubEpub` (xhtml col docId → note come quelle esportate: `^pN` = `data-pid`, domande `p.qu` col `data-rel-pid` che segue, versetti `#citationN` risolti con `parseReference`, rimandi `-extracted.xhtml#pcitationN` → `[[file]]` se il titolo è nella biblioteca, immagini usate in `_media/<simbolo>/`), `saveEpub` (indice con `source: "epub"`; un indice di un'altra fonte non si tocca: stessi documenti → saltati, numeri nuovi → `<simbolo>.epub.json`), poi `epubExtras`. `newIssues`: periodici con un numero nell'ultimo anno, passo = distanza minima tra gli ultimi numeri. Sul telefono sopra 40 MB legge solo le voci che servono con richieste Range (`unzipEntries` accetta `{ size, read }`) |
| `bibbia-vista.js` | lettore della Bibbia (vista più grande, ~2700 righe) |
| `bibbia-modali.js` | ricerca globale "Cerca o chiedi" (`SearchModal`: anche paragrafi dall'indice di Chiedi e "chiedi alla biblioteca" per le domande), vai a, versetti di una nota |
| `biblioteca-dati.js` | `LibraryData`: carica gli indici → `pubs`, `bySym`, `byDocId`; numeri dei periodici dalla cartella `…/AAAAMM(GG)/`; `remove(symbol, issue)` toglie una pubblicazione o un numero (note, `_media`, voci degli indici e di `_sources.json`; non la Bibbia in uso), pulsante cestino nell'intestazione; `parseMeetingHtml(html, epub)` (programma dell'adunanza; con `epub = { bible, files }` legge l'HTML dell'EPUB: versetti da `#citationN`, rimandi `{ t, ex }` col testo dei file `-extracted.xhtml`) |
| `epub-extra.js` | `epubExtras(plugin, { symbol, issue, files })`, chiamata alla fine di ogni importazione di EPUB: campi risposta → `answer-fields.json`, `img alt` → `image-alts.json`, per `mwb` il programma → `meetings.json` con `pubs['mwb\|AAAAMM'] = { t, src: 'epub' }`. Non sovrascrive mai i dati che ci sono; se il numero viene da un'altra fonte (`pubs` numerico o `src` diverso) riempie solo le settimane che mancano. Niente rete |
| `biblioteca-vista.js` | vista biblioteca: home a categorie (`renderHome` → `mode: 'cat'`, `renderCat`), settimana, documento, `data-pid`, campi risposta, lampadina AI (`docAiCtx`, `docAiFocus`) |
| `studio.js` | AI (OpenRouter `aiChat`, `suggestComments`, `COMMENT_SYSTEM`, `verseAiCtx` per i versetti), fonti (`SourceList`), `renderRbi8Verse` (Bibbia con riferimenti, usata da Bibbia e Biblioteca), studio di una parola. Prompt caching: le prime `ctx.shared` fonti (articolo o capitolo) vanno in una parte con `cache_control` 1h; devono restare identiche tra le domande |
| `jwl-formati.js` / `jwl-importa.js` / `jwl-esporta.js` | backup `.jwlibrary` (`unzipEntries`: ArrayBuffer o `{ size, read(inizio, fine) }`, legge solo le voci chieste, `buildJwlPlan`, `JwlImporter`, `JwlExporter`) |
| `scarica-jw.js` | `jwDownload(app, infos, each, { auto, full })`: finestra "Scarica da jw.org" (indirizzo di ogni file, condizioni d'uso, conferma, barra con richieste Range da 1 MB; `auto` = già confermato, parte da sola; sul telefono sopra 40 MB `each` riceve null, tranne con `full`). Ogni download da jw.org passa da qui; lo usano anche le estensioni |
| `lettura.js` | impaginazione (pagine, aspetto del testo) |
| `scrabb-*.js` | schede di studio SCRABB |
| `indice-note.js` | indice dei riferimenti biblici nelle note personali |
| `testo.js` | utility: `norm`, `nameKey`, `verseCode`, `jwLibraryUrl`, `codesFromJwUrl`, `refFromCodes`, `stripFrontmatter` |
| `lingua.js` + `lingue/en.js` | multilingua: `t('testo italiano', { valori })` → traduzione (chiave = l'italiano; manca → italiano), `lang()` per date/numeri/ordinamenti, `contentLang(settings)` = lingua dei contenuti da `bibleLang` (I, E…). `settings.uiLang` ('auto' = lingua di Obsidian; senza dizionario → inglese), evento `lampada:language` quando cambia. Nuova lingua: copia `lingue/en.js` e aggiungila a `DICTS`/`UI_LANGS`. Le estensioni: `addStrings(lingua, dict)` |
| `novita.js` | novità dopo un aggiornamento: `CHANGELOG.md` incluso nel bundle come testo (loader `.md` di esbuild), `newsAfterUpdate` (una volta per versione, `settings.seenVersion`; niente alla prima installazione), `NewsModal`, comando e Impostazioni → Novità. Un'estensione lo usa col suo `CHANGELOG.md`: ognuno mostra solo le sue novità |
| `costanti.js` | `DEFAULT_SETTINGS`, `EXTRA_ALIASES` (abbreviazioni dei libri), `INDEX_MIRROR` (= `index`, cartella degli indici) |
| `ui.js` | componenti condivisi (segnalibri, barre, "Citato in", "Nelle mie note" `renderNoteCites`, anteprima di una pubblicazione citata `fillCitePreview`: popup nella Bibbia, `CitePreviewModal` nella Biblioteca) |
| `main.js` (src) | punto di ingresso + `_test`: le funzioni usate da `test/` vanno esportate qui |

## Cartelle (dal 2026-11-20)
- Pubblicazioni: `.lampada/markdown/` (nascosta: Obsidian non la indicizza). Per leggerle usare `src/file.js` (`fileAt`, `readFile`, `linkDest`, `fileSrc`, `renderMd`…), **non** `vault.getAbstractFileByPath`/`cachedRead`/`metadataCache`, che non vedono le cartelle col punto.
- Dati ricavati: `.lampada/data/` (`DATA_DIR`, nomi in inglese), spostati da soli all'avvio (`moveDerivedData`). Note e dati dell'utente: `Note Bibbia/`.
- Una biblioteca per lingua delle pubblicazioni (`settings.bibleLang`, codice del sito: I, E…; dal 2026-11-23): la lingua base (`baseLang` in `costanti.js`, `settings.baseLang`: italiano, o quella della Bibbia scaricata nella cartella principale con le versioni di prima, vedi `detectBaseLang` in `plugin.js`) resta in `rootFolder` e `.lampada/data/`, le altre in `.lampada/<codice>/markdown` e `.lampada/<codice>/data` (`langRoot`, `dataDir`, `pubLang`; `ensureDataDir` crea quella della lingua scelta). Usare sempre `bible.prefix` e i percorsi del plugin (`answerFieldsPath`…), mai `DATA_DIR`/`rootFolder` direttamente. Bibbia in uso: `settings.symbol` (lingua base) o `settings.symbols[codice]` (`bible.setSymbol`). Si cambia con `plugin.setPubLang(codice)` (ridisegna le viste sulla stessa pagina, evento `lampada:publang`; non rielenca le cartelle nascoste già lette): pulsantino "IT" (`pubLangButton` in `ui.js`) nella pagina dei libri, nella home della Biblioteca, nei pannelli "scarica la Bibbia", nell'intestazione di una pubblicazione e accanto al percorso di un documento (`pubLangMenu`/`openInLang` in `biblioteca-vista.js`: stesso documento per id, o per posizione nel numero); anche nelle impostazioni. Le evidenziazioni delle altre lingue hanno `lang` (senza = lingua base; si vedono solo nella loro lingua). Note sui versetti e sui paragrafi in tutte le lingue, come in JW Library: file del versetto per nome o per `codice` nelle proprietà (`plugin.verseNoteFile`), note delle pubblicazioni per `docid`. Le risposte non hanno lingua: `doc|tag` vale in tutte. Backup `.jwlibrary` neutro: ogni evidenziazione entra ed esce con la sua `Location.MepsLanguage` (`MEPS`, `langOfMeps`, `mepsOf` in `jwl-formati.js`, relativi alla lingua base: 4 = I, 0 = E, altre → `meps<n>`), le risposte su una `Location` senza lingua.

## Regole
- Commenti, testi dell'interfaccia e messaggi di commit in italiano; testi brevi e semplici. Ogni testo mostrato passa da `t()` e ha la sua voce in `lingue/en.js` (`test/lingua.test.js` controlla i `{valori}`); mai `t()` a livello di modulo (la lingua non è ancora scelta): le etichette delle costanti si traducono dove si mostrano. Restano in italiano le chiavi dei dati (titoli delle sezioni come 'Riferimenti', cartelle, frontmatter, testo scritto nel vault e riletto).
- Telefono e computer usano la stessa cartella `.obsidian/` (Syncthing porta il plugin sul telefono).
- Sul telefono: niente download grandi, campi di testo a 16px (iOS ingrandisce sotto), `touch-action` già gestito.
- Nessun dato personale nel repo; commit con l'email noreply di GitHub.
- Prove in `test/*.test.js` (Node, con `test/obsidian-finto.js` al posto di `obsidian`, senza DOM; per l'HTML c'è `test/dom-finto.js`, un `DOMParser` minimo).
- Gli indici in `.lampada/markdown/index/<simbolo>.json` li scrive l'importatore: il plugin modifica solo quelli che ha scritto lui dagli EPUB (`source: "epub"`; per un periodico di un'altra fonte i numeri nuovi vanno in `<simbolo>.epub.json`). I documenti scaricati (da un'estensione) vanno in `<simbolo>.wol.json`.
- Nessun nome di marchio in README e manifest; "JW Library" solo dove serve per la compatibilità (backup `.jwlibrary`, "Apri in JW Library").
- Nomi interni senza "jw": classi CSS con prefisso `lmp-`, viste ed eventi `lampada-…`/`lampada:…`. Fanno eccezione i moduli del formato `.jwlibrary` (`jwl-formati.js`…).

## Pubblicare un aggiornamento
Gli utenti ricevono gli aggiornamenti dalle release di GitHub (`rubengrep/lampada`, pubblico). Per ogni modifica da distribuire:
1. alza `version` in `manifest.json` e aggiungila a `versions.json` (versione → `minAppVersion`);
2. in cima a `CHANGELOG.md` la sezione `## <versione> — <data>` con le novità per chi usa Lampada (punti brevi, in italiano). Le novità di Lampada non parlano mai delle estensioni private: quelle vanno nel loro repo. `release.js` si ferma se trova una delle parole di `.parole-private` (file locale, fuori dal repo);
3. `npm run build` (prove ✓), commit;
4. `gh auth switch -u rubengrep`, `npm run release` (tag = versione, senza "v", release con main.js, manifest.json, styles.css e come note la sezione di `CHANGELOG.md`), poi di nuovo l’account di prima.

## API per estensioni
Un altro plugin può dare a Lampada dati e azioni che Lampada non ha. Lampada funziona anche senza nessun fornitore.
- `plugin.registerProvider(p)` aggiunge un fornitore (oggetto con alcuni degli hook sotto) e restituisce la funzione che lo toglie.
- `plugin.has(nome)`: c'è almeno un fornitore con quell'hook. `plugin.ask(nome, ...args)`: primo risultato non null dei fornitori, null se nessuno; gli errori salgono al chiamante.
- Alla fine di `onload` Lampada lancia `app.workspace.trigger('lampada:ready', plugin)`: l'estensione si registra lì (anche quando Lampada si ricarica) e, se Lampada è già attivo, subito.
- Tutti facoltativi. Dati nel vault prima, poi `ask`:

| Hook | Dove | Ritorna |
|---|---|---|
| `answerFields(d)` | `docAnswerFields(d)`, se `answer-fields.json` non ha `docs[d.id]` | campi come in `docs[id]`, o null |
| `imageAlts(d, files, url)` | `imageAlts(d, files, url)`, se `image-alts.json` non ha tutti i file | `{ file: testo }`, o null |
| `meetingWeek(k)` | `meetingWeek(k, cachedOnly)`, se `!cachedOnly` e `meetings.json` non ha la settimana, o l'ha presa dall'EPUB (`pubs['mwb|AAAAMM'].src === 'epub'`: l'EPUB resta di riserva) | `{ id, items }` o null |
| `downloadReferenceBible(progress)` | `renderRbi8Verse`: pulsante "Scarica" solo se c'è; senza dati e senza fornitore la sezione non compare | Promise (finita = dati in `rbi8Dir`) |
| `downloadCovers(progress)` | comando `library-covers` e pulsante copertine, solo se c'è | numero di copertine aggiunte |
| `linkAction(url)` | ricerca della biblioteca, quando il testo è un URL | `{ text, run }` → pulsante; null = niente |
| `libraryActions()` | barra degli strumenti della biblioteca | `[{ text, run }]` → un pulsante ciascuno |
| `libraryBrowse()` | home della biblioteca, sotto le categorie | `{ text, url, meta?, icon? }` → una riga che apre la pagina `url` |
| `libraryPage(url, el, ctx)` | `renderExt` (`mode: 'ext'`, `url`, `title`) | disegna in `el`; `ctx.go(url, titolo)`, `ctx.reload()`, `ctx.current()`; null = non è sua |
| `urlButton(url)` | `urlButtons` (link del programma della settimana) | `{ icon, label, run }` → icona dopo il link; `run()` → true = ridisegna la pagina; null = niente |
| `pubSource(pub, issue, docs)` | intestazione della pagina di una pubblicazione o di un numero (non dell'elenco dei numeri di un periodico) | async `{ text, action?: { label, run } }` → testo (da dove arriva) e un pulsante; `run()` → true = ridisegna; errori → avviso (non se `cancelled`); null = niente. Nei `docs`, `epub: true` = dall'indice scritto dall'EPUB |

Il fornitore usa dall'istanza: `answerFieldsPath`, `imageAltsPath`, `meetingsPath`, `rbi8Dir`, `readJson`, `bible`, `library` (anche `remove(symbol, issue)`), `refresh()`, `openLibraryAt`, `settings`, `saveSettings()`, `writeBinary(path, data)` (scrive anche nelle cartelle nascoste e Lampada vede subito il file), `importFromJw(pub, issue, progress, category)` (EPUB da jw.org con la conferma, anche sul telefono; `category` = id di `LIB_CATEGORIES` per una pubblicazione nuova; null = non c'è, `{ skipped }` = c'è già da un'altra fonte), `app`. Non cambiarli.

## Vista unica (guscio)
- Una sezione non ha una scheda sua: `this.leaf` è quella del guscio, l'intestazione di Obsidian è nascosta, i tasti si danno con `viewKeys(this, [[tasto, fn]…])` (non `this.scope`), la cronologia con `pushHistory()` / `canGoBack()` / `restore(snap)`.
- Cercare le viste aperte con `plugin.viewsOf(tipo, area)`, non solo `getLeavesOfType` (le sezioni nel guscio non sono foglie).
- Modalità app: classe `lmp-app` sul body solo mentre il guscio è la scheda attiva (`plugin.applyAppMode`).

## Trappole già incontrate
- `Setting` di Obsidian ha `then()`: restituirlo da una funzione async blocca tutto (ciclo infinito).
- L'altezza delle textarea calcolata una volta sola è sbagliata sul telefono: ricalcolarla quando cambia la larghezza (`ResizeObserver`).
- `\s` in JS comprende lo spazio non separabile (` `): le note esportate lo conservano, quindi non unirlo con `\s+` nel testo.
