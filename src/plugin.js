import { Plugin, MarkdownView, Notice, TFile, setIcon, debounce, Platform, normalizePath } from 'obsidian';
import { BibleData } from './bibbia-dati.js';
import { BibleDownloadModal, epubInfo } from './bibbia-epub.js';
import { EpubImportModal, importInfo, runNewIssues } from './biblioteca-epub.js';
import { GotoModal, NoteRefsModal, RefSuggest, SearchModal } from './bibbia-modali.js';
import { BibleView } from './bibbia-vista.js';
import { LIB_VIEW_TYPE, LibraryData } from './biblioteca-dati.js';
import { LibraryView } from './biblioteca-vista.js';
import { CHAT_VIEW_TYPE, LibraryChatView, LibrarySearch } from './chat-biblioteca.js';
import { APP_VIEW_TYPE, LampadaView } from './guscio.js';
import { TODAY_VIEW_TYPE, TodayView } from './oggi.js';
import { DATA_DIR, DEFAULT_SETTINGS, INDEX_MIRROR, VIEW_TYPE } from './costanti.js';
import { fileSrc, linkDest, writeBinary } from './file.js';

// Impostazioni di lettura salvate per dispositivo (computer e telefono di solito le vogliono diverse).
const DEVICE_KEY = 'lampada-lettura';
const DEVICE_SETTINGS = ['fontFamily', 'fontSize', 'lineHeight', 'margins', 'justify', 'pageMode', 'readingTheme'];
import { BibleSettingTab } from './impostazioni.js';
import { NoteIndex } from './indice-note.js';
import { MEASURES, READING_THEMES } from './lettura.js';
import { JwlExportModal } from './jwl-esporta.js';
import { jwlTag, unzipEntries } from './jwl-formati.js';
import { JwlImportModal, JwlImporter } from './jwl-importa.js';
import { SCRABB_ALL_LISTS, SCRABB_TEACHINGS, SCRABB_TYPES, SCRABB_VIEW_TYPE, ScrabbIndex, scrabbBody, scrabbFold, scrabbListOf } from './scrabb-dati.js';
import { ScrabbNewModal, ScrabbPickModal, ScrabbSuggest, ScrabbView } from './scrabb-vista.js';
import { categoryOf, cleanSnippet, codesFromJwUrl, formatNoteBlock, jwLibraryUrl, newGuid, parseCode, parseNoteFile, refFromCodes, sleep, stripFrontmatter, verseCode } from './testo.js';
import { PlacesModal, bookmarkKey } from './ui.js';

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class LampadaPlugin extends Plugin {
  async onload() {
    // Estensioni: fornitori di dati e azioni (vedi "API per estensioni" in CLAUDE.md).
    this.providers = [];
    await this.loadAll();
    await this.moveDerivedData();
    this.bible = new BibleData(this);
    this.lastMarkdownView = null;
    const save = debounce(() => this.saveAll(false), 800, true);
    // userData = true quando cambiano evidenziazioni, segnalibri o risposte: il file condiviso (3+ MB)
    // si riscrive solo allora, non a ogni capitolo aperto o sezione chiusa.
    this.requestSave = (userData) => {
      if (userData) this.userDataDirty = true;
      save();
    };

    this.noteIndex = new NoteIndex(this);
    // Evidenziazioni e segnalibri: si caricano subito, non a fine avvio, così compaiono insieme al testo.
    this.userDataReady = this.loadUserData().catch((e) => console.warn('[lampada] evidenziazioni non caricate', e));
    this.registerView(VIEW_TYPE, (leaf) => new BibleView(leaf, this));
    this.library = new LibraryData(this);
    this.registerView(LIB_VIEW_TYPE, (leaf) => new LibraryView(leaf, this));
    // Vista unica: Bibbia, Biblioteca, SCRABB e Chiedi dentro un solo guscio, con una cronologia sola.
    this.registerView(APP_VIEW_TYPE, (leaf) => new LampadaView(leaf, this));
    this.registerView(TODAY_VIEW_TYPE, (leaf) => new TodayView(leaf, this));
    this.addCommand({ id: 'open-today', name: 'Oggi (settimana, riprendi, segnalibri)', callback: () => this.openToday() });
    const ribbon = (icon, title, fn) => !this.settings.appShell && this.addRibbonIcon(icon, title, fn);
    if (this.settings.appShell) this.addRibbonIcon('lamp', 'Apri Lampada', () => this.openApp());
    this.addCommand({
      id: 'refresh',
      name: 'Ricarica le pubblicazioni',
      callback: () => this.refresh().then(() => new Notice('Pubblicazioni ricaricate'), (e) => new Notice(`Ricarica non riuscita: ${e.message}`)),
    });
    this.addCommand({ id: 'download-bible', name: 'Scarica la Bibbia', callback: () => new BibleDownloadModal(this).open() });
    this.addCommand({ id: 'import-epub', name: 'Importa un EPUB…', callback: () => new EpubImportModal(this).open() });
    this.addCommand({ id: 'new-issues', name: 'Cerca nuovi numeri', callback: () => runNewIssues(this) });
    this.addCommand({ id: 'open-app', name: 'Apri Lampada (Bibbia, Biblioteca, SCRABB, Chiedi)', callback: () => this.openApp() });
    this.addCommand({ id: 'app-mode', name: 'Modalità app: nascondi Obsidian intorno a Lampada (sì/no)', icon: 'maximize-2', callback: () => this.toggleAppMode() });
    ribbon('library-big', 'Apri la biblioteca', () => this.openLibrary());
    // Da mettere nella barra degli strumenti del telefono: piegando l'iPhone Duo si passa a due pagine con un tocco.
    this.addCommand({
      id: 'two-pages',
      name: 'Lettura: due pagine affiancate (sì/no)',
      icon: 'book-open',
      callback: async () => {
        const s = this.settings;
        if (s.pageMode === 'spread') s.pageMode = this.ui.pageModeBefore || 'scroll';
        else {
          this.ui.pageModeBefore = s.pageMode;
          s.pageMode = 'spread';
        }
        await this.settingsChanged();
      },
    });
    this.addCommand({ id: 'open-library', name: 'Apri la biblioteca (pubblicazioni)', callback: () => this.openLibrary() });
    this.addCommand({ id: 'open-week', name: 'Adunanze della settimana', callback: () => this.openLibraryAt({ mode: 'week' }) });
    // Chiedi alla biblioteca: l'AI cerca nei paragrafi delle pubblicazioni (indice in .lampada/data/search) e risponde con le fonti.
    this.librarySearch = new LibrarySearch(this);
    this.registerView(CHAT_VIEW_TYPE, (leaf) => new LibraryChatView(leaf, this));
    ribbon('messages-square', 'Chiedi alla biblioteca', () => this.openLibraryChat());
    this.addCommand({ id: 'library-chat', name: 'Chiedi alla biblioteca (AI)', callback: () => this.openLibraryChat() });
    this.addCommand({
      id: 'library-covers',
      name: 'Scarica le copertine mancanti delle pubblicazioni',
      checkCallback: (checking) => {
        if (!this.has('downloadCovers')) return false;
        if (!checking)
          this.ask('downloadCovers').then(
            (got) => new Notice(got ? `${got} copertine aggiunte` : 'Nessuna nuova copertina trovata'),
            (e) => new Notice(`Copertine non scaricate: ${e.message}`)
          );
        return true;
      },
    });
    this.scrabb = new ScrabbIndex(this);
    this.registerView(SCRABB_VIEW_TYPE, (leaf) => new ScrabbView(leaf, this));
    ribbon('waypoints', 'Apri SCRABB', () => this.openScrabb());
    this.addCommand({ id: 'scrabb-open', name: 'SCRABB: apri', callback: () => this.openScrabb() });
    this.addCommand({
      id: 'scrabb-open-card',
      name: 'SCRABB: apri la scheda di questa nota',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        const ok = !!(f && this.scrabb && this.scrabb.get(f.path));
        if (ok && !checking) this.showInScrabb(f.path);
        return ok;
      },
    });
    this.registerEvent(this.app.workspace.on('file-open', () => this.updateScrabbAction(this.app.workspace.getMostRecentLeaf())));
    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => this.updateScrabbAction(leaf)));
    this.registerEvent(this.app.workspace.on('lampada:scrabb-changed', () => this.app.workspace.iterateAllLeaves((l) => this.updateScrabbAction(l))));
    this.addCommand({ id: 'scrabb-link', name: 'SCRABB: collega a una scheda…', editorCallback: (editor) => this.scrabbLink(editor) });
    for (const [id, tipo, name] of [
      ['scrabb-example', 'modello', 'SCRABB: crea un modello dalla selezione…'],
      ['scrabb-illustration', 'illustrazione', 'SCRABB: salva la selezione come illustrazione…'],
    ]) {
      this.addCommand({
        id,
        name,
        editorCheckCallback: (checking, editor, ctx) => {
          if (!editor.somethingSelected() || !ctx.file) return false;
          if (!checking) this.scrabbFromSelection(editor, ctx.file, tipo);
          return true;
        },
      });
    }
    this.addCommand({ id: 'scrabb-insert-illustration', name: 'SCRABB: inserisci un’illustrazione…', editorCallback: (editor) => this.scrabbInsertIllustration(editor) });
    this.addCommand({
      id: 'scrabb-show',
      name: 'SCRABB: mostra la nota corrente',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const fm = file && this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (!fm || !SCRABB_TYPES[String(fm.tipo || '').toLowerCase()]) return false;
        if (!checking) this.showInScrabb(file.path);
        return true;
      },
    });
    this.registerEditorSuggest(new ScrabbSuggest(this));
    // Tasto destro nell'editor: collegare il testo a una scheda senza cercare i comandi.
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, info) => {
        const sel = editor.somethingSelected();
        menu.addItem((i) => i.setTitle(sel ? 'SCRABB: collega la selezione a una scheda…' : 'SCRABB: collega a una scheda…').setIcon('waypoints').onClick(() => this.scrabbLink(editor)));
        if (sel && info.file) {
          menu.addItem((i) => i.setTitle('SCRABB: crea un modello dalla selezione…').setIcon(SCRABB_TYPES.modello.icon).onClick(() => this.scrabbFromSelection(editor, info.file, 'modello')));
          menu.addItem((i) => i.setTitle('SCRABB: salva come illustrazione…').setIcon(SCRABB_TYPES.illustrazione.icon).onClick(() => this.scrabbFromSelection(editor, info.file, 'illustrazione')));
        } else menu.addItem((i) => i.setTitle('SCRABB: inserisci un’illustrazione…').setIcon(SCRABB_TYPES.illustrazione.icon).onClick(() => this.scrabbInsertIllustration(editor)));
      })
    );
    this.registerEditorSuggest(new RefSuggest(this));
    this.registerHoverLinkSource(VIEW_TYPE, { display: 'Lampada', defaultMod: true });
    ribbon('book-open', 'Apri la Bibbia', () => this.openReader());
    this.addSettingTab(new BibleSettingTab(this.app, this));

    this.addCommand({ id: 'open', name: 'Apri la Bibbia', callback: () => this.openReader() });
    this.addCommand({ id: 'open-tab', name: 'Apri la Bibbia in una scheda', callback: () => this.openReader(null, 'tab') });
    this.addCommand({ id: 'open-sidebar', name: 'Apri la Bibbia nella barra laterale destra', callback: () => this.openReader(null, 'right') });
    this.addCommand({ id: 'open-left', name: 'Apri la Bibbia nella barra laterale sinistra', callback: () => this.openReader(null, 'left') });
    this.addCommand({
      id: 'goto',
      name: 'Vai a riferimento…',
      callback: () => new GotoModal(this, (ref) => this.openReader(ref)).open(),
    });
    this.addCommand({ id: 'search', name: 'Cerca o chiedi (Bibbia, pubblicazioni, paragrafi, SCRABB, note, AI)…', callback: () => this.openSearch() });
    const viewCmd = (id, name, fn) =>
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          const view = this.activeBible();
          if (!view) return false;
          if (!checking) fn(view);
          return true;
        },
      });
    viewCmd('next-chapter', 'Capitolo successivo', (v) => v.stepChapter(1));
    viewCmd('prev-chapter', 'Capitolo precedente', (v) => v.stepChapter(-1));
    this.addCommand({
      id: 'back',
      name: 'Indietro',
      checkCallback: (checking) => {
        const shell = this.app.workspace.getActiveViewOfType(LampadaView);
        const view = shell || this.activeBible();
        if (!view) return false;
        if (!checking) view.goBack();
        return true;
      },
    });
    this.addCommand({
      id: 'open-current-file',
      name: 'Apri il file corrente nel lettore',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ref = file && this.bible.loadPromise ? this.bible.refFromFile(file) : null;
        if (!file || !file.path.startsWith(this.bible.bibleFolder + '/')) return false;
        if (!checking) this.bible.ensureLoaded().then(() => this.openReader(this.bible.refFromFile(file) || ref));
        return true;
      },
    });

    this.addCommand({
      id: 'convert-refs',
      name: 'Converti i riferimenti biblici in link (riga o selezione)',
      editorCallback: (editor) => this.convertRefs(editor, false),
    });
    this.addCommand({
      id: 'convert-refs-note',
      name: 'Converti tutti i riferimenti biblici della nota in link',
      editorCallback: (editor) => this.convertRefs(editor, true),
    });
    this.addCommand({
      id: 'insert-verse',
      name: 'Inserisci versetto…',
      editorCallback: (editor) =>
        new GotoModal(this, async (ref) => {
          if (!ref.chapter) return;
          const data = await this.bible.getChapter(ref.book, ref.chapter);
          const verses = this.bible.versesOf(ref);
          const text = verses.map((v) => (verses.length > 1 ? `${v} ` : '') + this.bible.verseText(data, v)).join(' ');
          const link = this.bible.formatLink(ref);
          editor.replaceSelection(verses.length ? this.fillTemplate({ link, label: this.bible.refLabel(ref), text }) : link);
          this.openAfterCite(ref, editor);
        }).open(),
    });
    this.addCommand({
      id: 'open-ref-at-cursor',
      name: 'Apri nel lettore il riferimento sotto il cursore',
      editorCallback: async (editor) => {
        await this.bible.ensureLoaded();
        const cur = editor.getCursor();
        const hits = this.bible.scanLine(editor.getLine(cur.line), true);
        const hit = hits.find((h) => cur.ch >= h.start && cur.ch <= h.end) || hits[0];
        if (hit) this.openReader(hit.ref);
        else new Notice('Nessun riferimento biblico in questa riga.');
      },
    });
    this.addCommand({ id: 'import-jwlibrary', name: 'Importa backup JW Library…', callback: () => new JwlImportModal(this).open() });
    this.addCommand({ id: 'export-jwlibrary', name: 'Esporta backup JW Library…', callback: () => new JwlExportModal(this).open() });
    this.addCommand({
      id: 'note-refs',
      name: 'Mostra i versetti citati in questa nota',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) this.showNoteRefs(file);
        return true;
      },
    });

    this.setupLinkHandling();
    // Le schede SCRABB si indicizzano dopo la Bibbia (servono i versetti), anche se la vista non è aperta.
    this.app.workspace.onLayoutReady(() => window.setTimeout(() => this.scrabb.ensure(), Platform.isMobile ? 9000 : 3500));
    this.app.workspace.onLayoutReady(async () => {
      await this.migrateToShell().catch((e) => console.warn('[lampada] passaggio alla vista unica', e));
      this.applyAppMode();
      await this.ensureLeftTab();
      await this.userDataReady;
      this.registerEvent(
        this.app.vault.on('modify', (f) => {
          if (f.path === this.userDataPath) this.onUserDataChanged();
        })
      );
      this.registerEvent(
        this.app.vault.on('create', (f) => {
          if (f.path === this.userDataPath) this.onUserDataChanged();
        })
      );
      // Lascia finire l'avvio di Obsidian (e degli altri plugin) prima di indicizzare.
      await sleep(Platform.isMobile ? 8000 : 3000);
      try {
        await this.bible.ensureLoaded();
      } catch (e) {
        console.warn('[lampada]', e.message);
        return;
      }
      await this.noteIndex.build();
      this.registerEvent(this.app.vault.on('modify', (f) => this.noteIndex.schedule(f)));
      for (const ev of ['modify', 'create', 'delete', 'rename']) this.registerEvent(this.app.vault.on(ev, (f) => this.onPubNoteFileChange(f)));
      this.registerEvent(this.app.vault.on('create', (f) => this.noteIndex.schedule(f)));
      this.registerEvent(this.app.vault.on('delete', (f) => this.noteIndex.removeFile(f.path)));
      this.registerEvent(
        this.app.vault.on('rename', (f, oldPath) => {
          this.noteIndex.removeFile(oldPath);
          this.noteIndex.schedule(f);
        })
      );
    });

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf && leaf.view instanceof MarkdownView) this.lastMarkdownView = leaf.view;
      })
    );
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile) || !file.path.startsWith(this.bible.bibleFolder + '/')) return;
        menu.addItem((item) =>
          item
            .setTitle('Apri nel lettore Bibbia')
            .setIcon('book-open')
            .onClick(async () => {
              await this.bible.ensureLoaded();
              const ref = this.bible.refFromFile(file);
              if (ref) this.openReader(ref);
            })
        );
      })
    );
    this.app.workspace.trigger('lampada:ready', this);
  }

  /* ---------------- estensioni ---------------- */

  /** Aggiunge un fornitore; la funzione restituita lo toglie. */
  registerProvider(p) {
    this.providers.push(p);
    return () => this.providers.remove(p);
  }

  has(name) {
    return this.providers.some((p) => typeof p[name] === 'function');
  }

  /** Primo risultato non null dei fornitori che hanno l'hook; gli errori salgono al chiamante. */
  async ask(name, ...args) {
    for (const p of this.providers)
      if (typeof p[name] === 'function') {
        const r = await p[name](...args);
        if (r != null) return r;
      }
    return null;
  }

  /** Scrive un file binario anche nelle cartelle nascoste, così Lampada lo vede subito (per i fornitori). */
  writeBinary(path, data) {
    return writeBinary(this.app, path, data);
  }

  /** Per le estensioni che cambiano le impostazioni. */
  saveSettings() {
    return this.saveAll(false);
  }

  /* ---------------- vista unica e modalità app ---------------- */

  /** Il guscio aperto (quello nell'area principale, se ce n'è più d'uno). */
  shellLeaf() {
    const leaves = this.app.workspace.getLeavesOfType(APP_VIEW_TYPE);
    return leaves.find((l) => this.leafLocation(l) === 'tab') || leaves[0] || null;
  }

  /** Sezioni aperte di un tipo, sia come schede sia dentro il guscio. */
  viewsOf(type, area) {
    const ws = this.app.workspace;
    const out = ws.getLeavesOfType(type).map((l) => l.view);
    for (const l of ws.getLeavesOfType(APP_VIEW_TYPE)) {
      const v = l.view && l.view.sections && l.view.sections.get(area);
      if (v) out.push(v);
    }
    return out;
  }

  /** La Bibbia attiva: una scheda della Bibbia, oppure il guscio quando mostra la Bibbia. */
  activeBible() {
    const ws = this.app.workspace;
    const v = ws.getActiveViewOfType(BibleView);
    if (v) return v;
    const shell = ws.getActiveViewOfType(LampadaView);
    return shell && shell.area === 'bible' ? shell.current() : null;
  }

  /**
   * Con la vista unica (impostazione appShell) ogni apertura passa dal guscio: `fn(sezione)` ci fa qualcosa
   * (navigate…). Lo crea se non c'è. → la sezione, o null se la vista unica è spenta.
   */
  async shellGo(area, fn) {
    if (!this.settings.appShell) return null;
    const ws = this.app.workspace;
    let leaf = this.shellLeaf();
    if (!leaf) {
      const recent = ws.getMostRecentLeaf(ws.rootSplit);
      leaf = recent && recent.view && recent.view.getViewType() === 'empty' ? recent : ws.getLeaf('tab');
      await leaf.setViewState({ type: APP_VIEW_TYPE, active: true, state: { area } });
    }
    await ws.revealLeaf(leaf);
    if (leaf.loadIfDeferred) await leaf.loadIfDeferred();
    if (!(leaf.view instanceof LampadaView)) return null;
    ws.setActiveLeaf(leaf, { focus: true });
    return leaf.view.go(area, fn);
  }

  /**
   * Una volta sola, accendendo la vista unica: le schede separate di Bibbia, Biblioteca, SCRABB e Chiedi diventano un
   * guscio solo (con il loro stato). La Bibbia fissa nella barra laterale sinistra resta.
   */
  async migrateToShell() {
    // Il segno resta su questo dispositivo (ognuno ha la sua disposizione delle schede; data.json si sincronizza).
    const KEY = 'lampada-vista-unica';
    // ponytail: nome vecchio ("jw-…") letto fino alla pubblicazione, poi togliere questa riga e quella dell'aspetto.
    if (!this.settings.appShell || this.app.loadLocalStorage(KEY) || this.app.loadLocalStorage('jw-' + KEY)) return;
    this.app.saveLocalStorage(KEY, '1');
    const ws = this.app.workspace;
    if (this.shellLeaf()) return;
    const areaOf = { [VIEW_TYPE]: 'bible', [LIB_VIEW_TYPE]: 'lib', [SCRABB_VIEW_TYPE]: 'scrabb', [CHAT_VIEW_TYPE]: 'chat' };
    const old = [];
    ws.iterateAllLeaves((l) => {
      const type = l.getViewState().type;
      if (areaOf[type] && !(type === VIEW_TYPE && this.leafLocation(l) === 'left')) old.push(l);
    });
    if (!old.length) return;
    const recent = ws.getMostRecentLeaf(ws.rootSplit);
    const state = { area: (recent && areaOf[recent.getViewState().type]) || 'bible' };
    for (const l of old) {
      const st = l.getViewState();
      const area = areaOf[st.type];
      if (st.state && Object.keys(st.state).length && !state[area]) state[area] = st.state;
    }
    const leaf = ws.getLeaf('tab');
    await leaf.setViewState({ type: APP_VIEW_TYPE, active: true, state });
    for (const l of old) l.detach();
  }

  /** Oggi: nel guscio, o da sola in una scheda se la vista unica è spenta. */
  async openToday() {
    if (await this.shellGo('home')) return;
    const ws = this.app.workspace;
    const leaf = ws.getLeavesOfType(TODAY_VIEW_TYPE)[0] || ws.getLeaf('tab');
    await leaf.setViewState({ type: TODAY_VIEW_TYPE, active: true });
    await ws.revealLeaf(leaf);
  }

  /** Una domanda a Chiedi alla biblioteca (da "Cerca o chiedi"). */
  async askLibrary(q) {
    const v = (await this.shellGo('chat')) || (await this.openLibraryChat(), this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0]?.view);
    if (v && v.askNow) await v.askNow(q);
  }

  async openApp() {
    if (!(await this.shellGo(this.ui.shellArea || 'home'))) await this.openReader();
  }

  async toggleAppMode(on) {
    this.ui.appMode = on ?? !this.ui.appMode;
    this.requestSave();
    if (this.ui.appMode && !this.shellLeaf()) await this.openApp();
    this.applyAppMode();
  }

  /**
   * Modalità app: barra delle icone, linguette, barre laterali e barra di stato nascoste, ma solo mentre si è nel
   * guscio. Aprendo una nota (o un'altra scheda) Obsidian torna com'è; tornando al guscio si nasconde di nuovo.
   */
  applyAppMode() {
    const ws = this.app.workspace;
    const leaf = ws.getMostRecentLeaf(ws.rootSplit);
    const on = !!this.ui.appMode && !!this.settings.appShell && !!leaf && leaf.view instanceof LampadaView;
    document.body.toggleClass('lmp-app', on);
    document.querySelectorAll('.lmp-app-toggle').forEach((b) => {
      b.toggleClass('is-active', !!this.ui.appMode);
      const icon = b.querySelector('.lmp-tab-icon') || b;
      setIcon(icon, this.ui.appMode ? 'minimize-2' : 'maximize-2');
    });
  }

  onunload() {
    // (in Node, nelle prove, document non c'è)
    if (typeof document !== 'undefined') document.body.removeClass('lmp-app');
    // Una modifica fatta meno di un secondo prima di chiudere non va persa.
    if (this.userDataDirty) this.saveUserData();
  }

  async loadAll() {
    const d = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, d.settings || {});
    // Aspetto della lettura: ogni dispositivo ha il suo (data.json si sincronizza, questo no).
    Object.assign(this.settings, this.app.loadLocalStorage?.(DEVICE_KEY) || this.app.loadLocalStorage?.('jw-' + DEVICE_KEY) || {});
    this.last = d.last || null;
    this.ui = d.ui || {};
    // Evidenziazioni, segnalibri e stato JW Library: file condiviso nel vault (vedi loadUserData).
    this.marks = [];
    this.bookmarks = [];
    this.deletedJwl = [];
    this.jwlBase = null;
    this.markTomb = {};
    this.bmTomb = {};
    this.answers = {};
    this.rebuildMarkIndex();
  }

  /* ---------------- dati dell'utente condivisi tra dispositivi ---------------- */

  /**
   * Una volta: nomi in inglese, e i dati ricavati passano da <note>/JW Library e Indici/ a .lampada/data. I dati
   * dell'utente (highlights.json, position.json, backup) restano nella cartella delle note, che si sincronizza sempre.
   */
  async moveDerivedData() {
    const a = this.app.vault.adapter;
    if (!(await a.exists(DATA_DIR))) await a.mkdir(DATA_DIR);
    const notes = normalizePath(`${this.settings.notesFolder}/JW Library`);
    const idx = normalizePath(`${this.settings.rootFolder}/Indici`);
    const moves = [
      [`${notes}/campi-risposta.json`, this.answerFieldsPath],
      [`${notes}/immagini.json`, this.imageAltsPath],
      [`${notes}/adunanze.json`, this.meetingsPath],
      [`${notes}/Bibbia con riferimenti`, this.rbi8Dir],
      [`${idx}/copertine`, `${DATA_DIR}/covers`],
      [`${idx}/ricerca`, `${DATA_DIR}/search`],
      [idx, normalizePath(`${this.settings.rootFolder}/${INDEX_MIRROR}`)],
      // Se un dispositivo non aggiornato riscrive il nome vecchio, mergeConflictCopies lo unisce.
      [`${notes}/evidenziazioni.json`, this.userDataPath],
      [`${notes}/posizione.json`, this.positionPath],
    ];
    for (const [from, to] of moves) {
      if (!(await a.exists(from)) || (await a.exists(to))) continue;
      await a.rename(from, to).catch((e) => console.warn('[lampada] spostamento non riuscito', from, e));
    }
  }

  get userDataPath() {
    return normalizePath(`${this.settings.notesFolder}/JW Library/highlights.json`);
  }

  get localUserDataPath() {
    return `${this.manifest.dir}/stato-${Platform.isMobile ? 'mobile' : 'desktop'}.json`;
  }

  async readJson(path) {
    try {
      if (await this.app.vault.adapter.exists(path)) return JSON.parse(await this.app.vault.adapter.read(path));
    } catch (e) {
      console.warn('[lampada] file illeggibile', path, e);
    }
    return null;
  }

  /**
   * Unisce più copie dei dati (file condiviso, copia del dispositivo, vecchio data.json):
   * per ogni evidenziazione/segnalibro vince la modifica più recente, le cancellazioni sono ricordate.
   */
  mergeUserData(parts) {
    const marks = new Map();
    const markTomb = {};
    const bms = new Map();
    const bmTomb = {};
    const deleted = new Set();
    const answers = {};
    let base = null;
    for (const p of parts) {
      if (!p) continue;
      for (const m of p.marks || []) {
        const cur = marks.get(m.id);
        if (!cur || (m.t || 0) > (cur.t || 0)) marks.set(m.id, m);
      }
      for (const [id, t] of Object.entries(p.markTomb || {})) markTomb[id] = Math.max(markTomb[id] || 0, t);
      for (const b of p.bookmarks || []) {
        const k = bookmarkKey(b);
        const cur = bms.get(k);
        if (!cur || (b.t || b.created || 0) > (cur.t || cur.created || 0)) bms.set(k, b);
      }
      for (const [k, t] of Object.entries(p.bmTomb || {})) bmTomb[k] = Math.max(bmTomb[k] || 0, t);
      for (const id of p.deletedJwl || []) deleted.add(id);
      for (const [k, a] of Object.entries(p.answers || {})) if (!answers[k] || (a.t || 0) > (answers[k].t || 0)) answers[k] = a;
      if (p.jwlBase && (!base || (p.jwlBase.importedAt || '') > (base.importedAt || ''))) base = p.jwlBase;
      // Vecchio formato: un colore per versetto intero.
      for (const [code, color] of Object.entries(p.highlights || {})) {
        const r = parseCode(code);
        const id = `hl-${code}`;
        if (!marks.has(id)) marks.set(id, { id, b: r.book, c: r.chapter, color, ranges: [{ v: r.verse, s: 0, e: -1 }], src: 'local', mod: true, t: 0 });
      }
    }
    return {
      marks: [...marks.values()].filter((m) => !markTomb[m.id] || (m.t || 0) > markTomb[m.id]),
      markTomb,
      bookmarks: [...bms.entries()].filter(([k, b]) => (b.t || b.created || 0) > (bmTomb[k] || 0)).map(([, b]) => b),
      bmTomb,
      deletedJwl: [...deleted],
      jwlBase: base,
      answers,
    };
  }

  userDataSnapshot() {
    return {
      version: 1,
      marks: this.marks,
      markTomb: this.markTomb,
      bookmarks: this.bookmarks,
      bmTomb: this.bmTomb,
      deletedJwl: this.deletedJwl,
      jwlBase: this.jwlBase,
      answers: this.answers,
    };
  }

  /* ---------------- campi di risposta delle pubblicazioni ---------------- */

  /** Risposte del backup importato (sola lettura): "documento|tt12" → testo. */
  async baseAnswers() {
    const base = this.jwlBase;
    if (!base) return new Map();
    if (this.baseAnswersCache && this.baseAnswersCache.key === base.importedAt) return this.baseAnswersCache.map;
    const map = new Map();
    try {
      const a = this.app.vault.adapter;
      if (await a.exists(this.jwlBasePath)) {
        const entries = await unzipEntries(await a.readBinary(this.jwlBasePath), (n) => n.endsWith('.db'));
        const SQL = await new JwlImporter(this).loadSqlJs(() => {});
        const db = new SQL.Database(Object.values(entries)[0]);
        try {
          const res = db.exec('SELECT l.DocumentId, i.TextTag, i.Value FROM InputField i JOIN Location l ON l.LocationId = i.LocationId WHERE l.DocumentId IS NOT NULL');
          for (const [d, tag, v] of res.length ? res[0].values : []) map.set(`${d}|${tag}`, v);
        } finally {
          db.close();
        }
      }
    } catch (e) {
      console.warn('[lampada] risposte del backup illeggibili', e);
    }
    this.baseAnswersCache = { key: base.importedAt, map };
    return map;
  }

  get answerFieldsPath() {
    return `${DATA_DIR}/answer-fields.json`;
  }

  get imageAltsPath() {
    return `${DATA_DIR}/image-alts.json`;
  }

  /** Campi di risposta di un documento della biblioteca: { paragrafo: [tt12, …] }, o null se non si sanno. */
  async docAnswerFields(d) {
    const known = await this.readJson(this.answerFieldsPath);
    if (known && known.docs && known.docs[d.id]) return known.docs[d.id];
    return this.ask('answerFields', d);
  }

  /** Testi alternativi delle immagini del documento: { file: testo }. Se ne manca qualcuno, li chiede ai fornitori. */
  async imageAlts(d, files, url) {
    const data = await this.readJson(this.imageAltsPath);
    const alts = (data && data.alts) || {};
    if (!files || files.every((f) => alts[f])) return alts;
    try {
      return (await this.ask('imageAlts', d, files, url)) || alts;
    } catch (e) {
      console.warn('[lampada] testi delle immagini non disponibili', e);
      return alts;
    }
  }

  get rbi8Dir() {
    return `${DATA_DIR}/reference-bible`;
  }

  /** Versetto della Bibbia con riferimenti: dati, null se manca in quell'edizione, undefined se non è ancora scaricata. */
  async rbi8Verse(book, c, v) {
    const a = this.app.vault.adapter;
    this.rbi8Cache = this.rbi8Cache || new Map();
    let data = this.rbi8Cache.get(book);
    if (!data) {
      const path = `${this.rbi8Dir}/${String(book).padStart(2, '0')}.json`;
      if (!(await a.exists(`${this.rbi8Dir}/fatto.json`)) || !(await a.exists(path))) return undefined;
      data = JSON.parse(await a.read(path));
      if (this.rbi8Cache.size > 4) this.rbi8Cache.delete(this.rbi8Cache.keys().next().value);
      this.rbi8Cache.set(book, data);
    }
    return data[`${c}:${v}`] || null;
  }

  get meetingsPath() {
    return `${DATA_DIR}/meetings.json`;
  }

  /**
   * Programma dell'adunanza infrasettimanale di una settimana (lunedì "AAAA-MM-GG"): { id, items } oppure null.
   * Da meetings.json; se manca, lo chiede ai fornitori.
   * cachedOnly: solo quello già salvato (la home della biblioteca non deve scaricarlo da sola).
   */
  async meetingWeek(k, cachedOnly) {
    const j = await this.readJson(this.meetingsPath);
    const id = j && j.v === 3 && j.weeks && j.weeks[k];
    const hit = id && j.docs && j.docs[id] ? { id, items: j.docs[id] } : null;
    if (cachedOnly) return hit;
    // Settimana presa dall'EPUB: se un'estensione ha una fonte più completa, ha la precedenza (l'EPUB resta di riserva).
    const [y, m] = k.split('-').map(Number);
    const fromEpub = hit && [m % 2 ? m : m - 1, m].some((x) => j.pubs?.[`mwb|${y}${String(x).padStart(2, '0')}`]?.src === 'epub');
    if (hit && !(fromEpub && this.has('meetingWeek'))) return hit;
    const r = await this.ask('meetingWeek', k).catch((e) => {
      if (!hit) throw e;
      return null;
    });
    return r || hit;
  }

  /** Campo "La tua risposta": la risposta salvata qui, altrimenti quella del backup di JW Library. */
  answerBox(docId, tag, label, base) {
    const key = `${docId}|${tag}`;
    const own = this.answers[key];
    const ta = createEl('textarea', { cls: 'lmp-answer', attr: { rows: '2', placeholder: label, 'aria-label': label } });
    ta.value = own ? own.v : (base && base.get(key)) || '';
    const fit = () => {
      if (!ta.offsetWidth) return; // non ancora in pagina o nascosto: l'altezza verrebbe sbagliata
      ta.style.height = 'auto';
      ta.style.height = `${ta.scrollHeight + 2}px`;
    };
    ta.addEventListener('input', () => {
      fit();
      this.setAnswer(docId, tag, ta.value);
    });
    // Sul telefono il campo spesso non ha ancora la sua larghezza quando viene creato (pagina che si
    // monta, pannello che si apre, rotazione): si ricalcola l'altezza ogni volta che cambia la larghezza.
    let lastW = 0;
    const ro = new ResizeObserver(() => {
      if (!ta.isConnected) return ro.disconnect();
      const w = ta.offsetWidth;
      if (w && w !== lastW) {
        lastW = w;
        fit();
      }
    });
    ro.observe(ta);
    window.requestAnimationFrame(fit);
    return ta;
  }

  setAnswer(doc, tag, v) {
    this.answers[`${doc}|${tag}`] = { doc: String(doc), tag, v, t: Date.now() };
    this.requestSave(true);
  }

  async loadUserData() {
    const [shared, local] = await Promise.all([this.readJson(this.userDataPath), this.readJson(this.localUserDataPath)]);
    const merged = this.mergeUserData([local, shared, this.userDataSnapshot()]);
    Object.assign(this, merged);
    this.rebuildMarkIndex();
    this.userDataLoaded = true;
    const st = await this.app.vault.adapter.stat(this.userDataPath).catch(() => null);
    this.userDataSig = st ? `${st.mtime}:${st.size}` : null;
    this.registerInterval(window.setInterval(() => this.checkUserDataFile(), 5000));
    this.registerInterval(window.setInterval(() => this.mergeConflictCopies(), 30000));
    this.mergeConflictCopies();
    // La copia del dispositivo resta aggiornata anche se poi il file condiviso viene sovrascritto.
    await this.saveUserData(shared, local);
  }

  /** shared/local: contenuto già letto dei due file, se noto; quelli già identici non si riscrivono. */
  async saveUserData(shared, local) {
    if (!this.userDataLoaded) return;
    const text = JSON.stringify(this.userDataSnapshot());
    // Si riscrive solo se qualcosa è cambiato: meno sincronizzazioni e meno conflitti.
    if (text === this.lastUserDataText) return;
    this.lastUserDataText = text;
    const a = this.app.vault.adapter;
    try {
      const folder = this.userDataPath.split('/').slice(0, -1).join('/');
      if (folder && !(await a.exists(folder))) await a.mkdir(folder);
      // Riscrivere un file identico cambia solo la data, e Syncthing lo rimanda a tutti i dispositivi.
      if (!shared || JSON.stringify(shared) !== text) {
        this.ownWriteAt = Date.now();
        await a.write(this.userDataPath, text);
      }
      if (!local || JSON.stringify(local) !== text) await a.write(this.localUserDataPath, text);
      const st = await a.stat(this.userDataPath);
      if (st) this.userDataSig = `${st.mtime}:${st.size}`;
    } catch (e) {
      console.warn('[lampada] salvataggio delle evidenziazioni non riuscito', e);
    }
  }

  /**
   * Controllo periodico: sul telefono Obsidian spesso non avvisa quando la sincronizzazione
   * sostituisce un file, quindi si guarda direttamente la data di modifica.
   */
  async checkUserDataFile() {
    try {
      const st = await this.app.vault.adapter.stat(this.userDataPath);
      if (!st) return;
      const sig = `${st.mtime}:${st.size}`;
      if (sig === this.userDataSig) return;
      const first = this.userDataSig === undefined;
      this.userDataSig = sig;
      if (!first) await this.onUserDataChanged(true);
    } catch (e) {
      /* file non ancora sincronizzato */
    }
  }

  /**
   * Syncthing: se due dispositivi cambiano il file prima di sincronizzarsi, una versione diventa
   * "highlights.sync-conflict-….json" e le sue modifiche sparirebbero. Si uniscono e la copia si cancella.
   */
  async mergeConflictCopies() {
    if (this.mergingConflicts) return;
    this.mergingConflicts = true;
    try {
      const a = this.app.vault.adapter;
      const path = this.userDataPath;
      const dir = path.slice(0, path.lastIndexOf('/'));
      const prefix = `${path.replace(/\.json$/, '')}.sync-conflict-`;
      // Nome di prima (evidenziazioni.json e le sue copie): un dispositivo non ancora aggiornato può riscriverlo.
      const legacy = `${dir}/evidenziazioni.`;
      const list = await a.list(dir).catch(() => null);
      const copies = [];
      for (const f of list ? list.files : []) {
        if (!(f.startsWith(prefix) || f.startsWith(legacy)) || !f.endsWith('.json')) continue;
        const data = await this.readJson(f);
        if (data) copies.push([f, data]); // illeggibile = ancora in arrivo: si riprova al giro dopo
      }
      if (!copies.length) return;
      await this.onUserDataChanged(true, copies.map(([, d]) => d));
      // Si cancella solo ciò che il file condiviso ora contiene già tutto (se il salvataggio non è riuscito, la copia resta).
      const shared = await this.readJson(path);
      const same = (x) => JSON.stringify(this.mergeUserData([shared, x])) === JSON.stringify(this.mergeUserData([shared]));
      for (const [f, d] of copies) if (shared && same(d)) await a.remove(f).catch(() => null);
    } finally {
      this.mergingConflicts = false;
    }
  }

  /** Il file condiviso è arrivato da un altro dispositivo: unisci e aggiorna il lettore. */
  async onUserDataChanged(force, extra = []) {
    if (!force && Date.now() - (this.ownWriteAt || 0) < 3000) return;
    const shared = await this.readJson(this.userDataPath);
    if (!shared && !extra.length) return;
    const before = JSON.stringify(this.userDataSnapshot());
    const merged = this.mergeUserData([this.userDataSnapshot(), shared, ...extra]);
    Object.assign(this, merged);
    this.rebuildMarkIndex();
    await this.saveUserData(shared);
    if (JSON.stringify(this.userDataSnapshot()) === before) return;
    for (const v of this.views()) {
      if (v.state.mode === 'reader' && v.chapterData) {
        v.chapterNotes = await v.loadChapterNotes(v.chapterData.book, v.chapterData.chapter).catch(() => v.chapterNotes);
        v.decorateVerses();
        v.layoutMarginNotes();
        v.renderPane();
      } else if (v.state.mode === 'books') v.renderBooks();
      else if (v.state.mode === 'chapters') v.navigate({ ...v.getState() }, { push: false });
    }
    for (const v of this.viewsOf(LIB_VIEW_TYPE, 'lib')) if (v instanceof LibraryView) {
      v.applyDocMarks();
      v.renderDocNotes();
    }
  }

  /** userData = false: solo impostazioni e stato dell'interfaccia (data.json), più i dati utente se sono cambiati. */
  async saveAll(userData = true) {
    await this.saveData({
      settings: this.settings,
      last: this.last,
      ui: this.ui,
    });
    this.app.saveLocalStorage?.(DEVICE_KEY, Object.fromEntries(DEVICE_SETTINGS.map((k) => [k, this.settings[k]])));
    // Convertire in testo i dati utente costa (3+ MB, lento sul telefono): solo se c'è qualcosa da salvare.
    if (!userData && !this.userDataDirty) return;
    this.userDataDirty = false;
    await this.saveUserData();
  }

  views() {
    return this.viewsOf(VIEW_TYPE, 'bible').filter((v) => v instanceof BibleView);
  }

  async settingsChanged(sourceChanged, rebuildIndex) {
    await this.saveAll(false);
    if (sourceChanged) this.bible.reset();
    if (sourceChanged || rebuildIndex) {
      this.bible
        .ensureLoaded()
        .then(() => this.noteIndex.build())
        .catch(() => {});
    }
    if (sourceChanged) this.library.reset();
    this.restyle();
    for (const v of this.views()) {
      if (sourceChanged) v.navigate({ mode: 'books' }, { push: false });
      else if (v.state.mode === 'reader') v.decorateVerses();
    }
  }

  /**
   * Rilegge pubblicazioni e indici dal disco (anche le cartelle nascoste) e aggiorna le viste aperte.
   * Da chiamare dopo aver aggiunto o cambiato file in .lampada/, es. da un importatore: plugins.lampada.refresh().
   */
  async refresh() {
    this.bible.reset();
    this.library.reset();
    await this.bible.ensureLoaded();
    for (const v of this.views()) v.navigate({ mode: v.state.mode, book: v.state.book, chapter: v.state.chapter }, { push: false });
    await this.noteIndex.build();
  }

  changeFontSize(delta) {
    this.settings.fontSize = Math.max(13, Math.min(30, this.settings.fontSize + delta));
    this.requestSave();
    this.restyle();
  }

  /** Scheda fissa "Bibbia" nella barra laterale sinistra, accanto a File, Cerca, Segnalibri. */
  async ensureLeftTab() {
    const ws = this.app.workspace;
    const existing = ws.getLeavesOfType(VIEW_TYPE).filter((l) => this.leafLocation(l) === 'left');
    if (!this.settings.leftTab) {
      if (this.settings.readerLocation !== 'left') existing.forEach((l) => l.detach());
      return;
    }
    if (existing.length) return;
    const leaf = ws.getLeftLeaf(false);
    if (leaf) await leaf.setViewState({ type: VIEW_TYPE, active: false, state: { mode: 'books' } });
  }

  leafLocation(leaf) {
    const ws = this.app.workspace;
    const root = leaf.getRoot();
    if (root === ws.rootSplit) return 'tab';
    return root === ws.leftSplit ? 'left' : 'right';
  }

  /** Opzione "Apri il versetto dopo averlo citato": lo mostra nel lettore; su computer e tablet il cursore torna nella nota. */
  async openAfterCite(ref, editor) {
    if (!this.settings.openAfterCite) return;
    const noteLeaf = this.app.workspace.getMostRecentLeaf();
    await this.openReader(ref);
    // Sul telefono si vede una scheda alla volta: tornare alla nota nasconderebbe subito il lettore.
    if (Platform.isPhone || !noteLeaf) return;
    this.app.workspace.setActiveLeaf(noteLeaf, { focus: true });
    editor.focus();
  }

  async openReader(ref, location, move) {
    // Senza un posto preciso (scheda, barra laterale): nel guscio.
    if (!location && !move) {
      const s = await this.shellGo('bible', (v) => ref && v.navigate(ref));
      if (s) return s;
    }
    const ws = this.app.workspace;
    const where = location || this.settings.readerLocation;
    // Scheda vuota in primo piano: la Bibbia si apre lì come copia nuova (più capitoli aperti insieme).
    const recent = ws.getMostRecentLeaf();
    if (where === 'tab' && !move && recent && recent.view && recent.view.getViewType() === 'empty') {
      await recent.setViewState({ type: VIEW_TYPE, active: true, state: ref || this.last || { mode: 'books' } });
      await ws.revealLeaf(recent);
      return recent.view;
    }
    const leaves = ws.getLeavesOfType(VIEW_TYPE);
    let leaf = leaves.find((l) => this.leafLocation(l) === where);
    if (!leaf) {
      // Spostamento dal menu: il lettore cambia posto mantenendo dove eri arrivato.
      // Altrimenti se ne apre uno nuovo (la scheda fissa nella barra sinistra resta dov'è).
      const old = move ? leaves.find((l) => this.leafLocation(l) !== 'left' || !this.settings.leftTab) || leaves[0] : null;
      const state = ref || (old && old.view instanceof BibleView ? old.view.getState() : null) || this.last || { mode: 'books' };
      leaf = (where === 'right' && ws.getRightLeaf(false)) || (where === 'left' && ws.getLeftLeaf(false)) || ws.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true, state });
      if (old) old.detach();
      await ws.revealLeaf(leaf);
      return leaf.view;
    }
    await ws.revealLeaf(leaf);
    if (leaf.loadIfDeferred) await leaf.loadIfDeferred();
    const view = leaf.view;
    if (view instanceof BibleView && ref) await view.navigate(ref);
    return view;
  }

  /* ---------------- SCRABB ---------------- */

  async openScrabb(state) {
    const s = await this.shellGo('scrabb', (v) => state && v.setState(state, { history: false }));
    if (s) return s;
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(SCRABB_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = ws.getLeaf('tab');
      await leaf.setViewState({ type: SCRABB_VIEW_TYPE, active: true, state: state || {} });
    } else if (state) await leaf.setViewState({ type: SCRABB_VIEW_TYPE, active: true, state });
    await ws.revealLeaf(leaf);
    if (leaf.loadIfDeferred) await leaf.loadIfDeferred();
    return leaf.view;
  }

  async showInScrabb(path) {
    await this.scrabb.ensure();
    const view = await this.openScrabb();
    if (!(view instanceof ScrabbView)) return;
    // Dalla nota di una scheda: si apre la sua pagina nella scheda "Schede" (anche se eri in Mappa o Cronologia).
    const e = this.scrabb.get(path);
    if (e && SCRABB_ALL_LISTS.includes(scrabbListOf(e.tipo))) view.state.tab = 'principi';
    view.select(path, true);
  }

  /** Inserisce un link a una scheda (sulla selezione, se c'è): la nota comparirà nella scheda sotto "Nelle mie note". */
  async scrabbLink(editor) {
    await this.scrabb.ensure();
    const sel = editor.getSelection();
    const insert = (name) => editor.replaceSelection(sel ? `[[${name}|${sel}]]` : `[[${name}]]`);
    new ScrabbPickModal(this, { placeholder: sel ? `Collega «${sel.slice(0, 40)}» a…` : 'Collega a una scheda SCRABB…', allowCreate: true }, (e) => {
      if (e.create) new ScrabbNewModal(this, { name: e.name, tipo: 'principio' }, (f) => insert(f.basename)).open();
      else insert(e.name);
    }).open();
  }

  /**
   * Dalla selezione (un passaggio di un discorso, una nota…) nasce un modello o un'illustrazione collegata a un principio:
   * il paragrafo riceve un ^id e la scheda lo cita, così si torna sempre alla fonte.
   */
  async scrabbFromSelection(editor, file, tipo) {
    await this.scrabb.ensure();
    const sel = editor.getSelection().trim();
    const line = editor.getCursor('to').line;
    const text = editor.getLine(line);
    let id = (/\s\^([\w-]+)\s*$/.exec(text) || [])[1];
    const versetti = this.bible.plainRe ? this.bible.scanLine(sel.replace(/\n/g, ' '), true).map((h) => this.bible.refLabel(h.ref, h.versesText)) : [];
    const foldedSel = scrabbFold(sel);
    const people =
      tipo === 'modello'
        ? this.scrabb
            .all(['persona', 'luogo'])
            .filter((e) => new RegExp(`(^|[^\\p{L}])${scrabbFold(e.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u').test(foldedSel))
            .map((e) => e.name)
        : [];
    const make = (principle) => {
      if (!id) {
        id = `scrabb-${Math.random().toString(36).slice(2, 8)}`;
        editor.replaceRange(` ^${id}`, { line, ch: text.length });
      }
      const source = `[[${this.app.metadataCache.fileToLinktext(file, '')}#^${id}|${file.basename}]]`;
      const body = `${sel.split('\n').map((l) => `> ${l}`).join('\n')}\n\nFonte: ${source}`;
      new ScrabbNewModal(this, { tipo, links: [principle, ...people], versetti: versetti.join('; '), body }).open();
    };
    const question = tipo === 'illustrazione' ? 'Quale principio fa capire questa illustrazione?' : 'Quale principio mostra questo modello?';
    new ScrabbPickModal(this, { types: SCRABB_TEACHINGS, placeholder: question, allowCreate: true }, async (e) => {
      if (e.create) await this.scrabb.create({ name: e.name, tipo: 'principio' });
      make(e.name);
    }).open();
  }

  /** Inserisce nel discorso un'illustrazione (link + testo): la scheda registra così dove e quando è stata usata. */
  async scrabbInsertIllustration(editor) {
    await this.scrabb.ensure();
    const insert = async (name, file) => {
      let text = '';
      if (file) {
        const body = scrabbBody(await this.app.vault.cachedRead(file));
        const sec = body.split(/^#{1,6} .*$/m).map((x) => x.trim()).find(Boolean) || '';
        text = sec.replace(/^Fonte:.*$/gm, '').replace(/^>\s?/gm, '').trim();
      }
      const lines = [`> [!tip] Illustrazione: [[${name}]]`, ...(text ? text.split('\n').map((l) => `> ${l}`) : [])];
      editor.replaceSelection(`${lines.join('\n')}\n`);
    };
    new ScrabbPickModal(this, { types: ['illustrazione'], placeholder: 'Quale illustrazione? (accanto: quante volte e quando l’hai usata)', allowCreate: true }, (e) => {
      if (e.create) new ScrabbNewModal(this, { name: e.name, tipo: 'illustrazione' }, (f) => insert(f.basename, null)).open();
      else insert(e.name, e.file);
    }).open();
  }

  /** Articolo di Perspicacia di una scheda: nella biblioteca (con evidenziazioni e note), altrimenti il file. */
  async openPerspicacia(e) {
    const f = linkDest(this.app, e.perspicacia, e.path);
    await this.library.ensureLoaded().catch(() => null);
    const d = this.library.byFile && this.library.byFile.get(f ? f.basename : String(e.perspicacia).split('/').pop());
    if (d) return this.openLibraryDoc(d);
    if (f && f.disk) return this.openFileRaw(f, 'tab');
    if (f) this.mainAreaLeaf().openFile(f, { active: true });
  }

  /**
   * Per le estensioni: pubblicazione da jw.org in EPUB (finestra "Scarica da jw.org", va anche sul telefono), poi la
   * biblioteca si rilegge. null = non c'è in EPUB; { skipped: true } = c'è già da un'altra fonte. Annullato: errore con cancelled.
   * category: id di una categoria della biblioteca (es. "volantini") per una pubblicazione nuova; ignorato se non esiste.
   */
  async importFromJw(pub, issue = '', progress = () => {}, category = '') {
    const info = await epubInfo(this.settings.bibleLang || 'I', pub, issue || '');
    if (!info) return null;
    const r = await importInfo(this, { ...info, category }, progress);
    await this.refresh();
    return r;
  }

  async openLibraryAt(state) {
    if (await this.shellGo('lib', (v) => v.navigate(state))) return;
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(LIB_VIEW_TYPE).find((l) => this.leafLocation(l) === 'tab');
    if (leaf && leaf.view instanceof LibraryView) await leaf.view.navigate(state);
    else {
      leaf = ws.getLeaf('tab');
      await leaf.setViewState({ type: LIB_VIEW_TYPE, active: true, state });
    }
    await ws.revealLeaf(leaf);
  }

  /** Il versetto in una scheda nuova della Bibbia (le altre restano dove sono). */
  async openReaderInNewTab(ref) {
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE, active: true, state: ref });
    await this.app.workspace.revealLeaf(leaf);
  }

  async openLibraryDoc(d, par) {
    if (await this.shellGo('lib', (v) => v.navigate({ mode: 'doc', sym: d.pub.symbol, doc: d.id, par: par ?? undefined }))) return;
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(LIB_VIEW_TYPE).find((l) => this.leafLocation(l) === 'tab');
    const state = { mode: 'doc', sym: d.pub.symbol, doc: d.id, par: par ?? undefined };
    if (leaf && leaf.view instanceof LibraryView) await leaf.view.navigate(state);
    else {
      leaf = ws.getLeaf('tab');
      await leaf.setViewState({ type: LIB_VIEW_TYPE, active: true, state });
    }
    await ws.revealLeaf(leaf);
  }

  /**
   * Nelle note delle schede SCRABB (es. Personaggi Biblici/Davide.md) un pulsante nell'intestazione
   * apre la scheda nella vista SCRABB.
   */
  updateScrabbAction(leaf) {
    const view = leaf && leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const path = view.file && view.file.path;
    const isCard = !!(path && this.scrabb && this.scrabb.ready && this.scrabb.get(path));
    if (isCard && !view.lmpScrabbAction) {
      view.lmpScrabbAction = view.addAction('waypoints', 'Apri la scheda in SCRABB', () => view.file && this.showInScrabb(view.file.path));
      view.lmpScrabbAction.addClass('lmp-scrabb-action');
    }
    if (view.lmpScrabbAction) view.lmpScrabbAction.toggle(isCard);
  }

  /** La chat sulla biblioteca: nella barra laterale destra sul computer (le fonti si aprono nella scheda accanto). */
  async openLibraryChat() {
    if (await this.shellGo('chat')) return;
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(CHAT_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = Platform.isMobile ? ws.getLeaf('tab') : ws.getRightLeaf(false);
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }
    await ws.revealLeaf(leaf);
  }

  async openLibrary() {
    if (await this.shellGo('lib')) return;
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(LIB_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = ws.getLeaf('tab');
      await leaf.setViewState({ type: LIB_VIEW_TYPE, active: true, state: this.ui.libLast || { mode: 'home' } });
    }
    await ws.revealLeaf(leaf);
  }

  /** Carattere e dimensione del testo (Bibbia e biblioteca). */
  /** Carattere, misura della riga, allineamento e tema di lettura (il tema sulla scheda intera, intestazione compresa). */
  applyFont(el) {
    const s = this.settings;
    el.style.setProperty('--lmp-font-size', `${s.fontSize}px`);
    el.style.setProperty('--lmp-line-height', String(s.lineHeight));
    el.style.setProperty('--lmp-measure', `${MEASURES[s.margins] || 720}px`);
    el.dataset.font = s.fontFamily;
    el.toggleClass('lmp-justify', !!s.justify);
    el.lang = 'it';
    const host = el.parentElement || el;
    for (const t of READING_THEMES) host.toggleClass(`lmp-theme-${t}`, s.readingTheme === t);
  }

  /** Dopo un cambio di aspetto: tutte le viste di lettura. */
  restyle() {
    for (const v of this.views()) v.applyTypography();
    for (const v of this.viewsOf(LIB_VIEW_TYPE, 'lib')) if (v instanceof LibraryView) v.applyTypography();
  }

  /** Ultimo backup di JW Library importato (base per l'esportazione). Calcolato: jwlBase.path può avere una cartella vecchia. */
  get jwlBasePath() {
    return normalizePath(`${this.settings.notesFolder}/JW Library/backup-base.jwlibrary`);
  }

  get positionPath() {
    return normalizePath(`${this.settings.notesFolder}/JW Library/position.json`);
  }

  /**
   * Dove si è arrivati a leggere (Bibbia e ogni documento), condiviso tra dispositivi: vince la lettura più recente.
   * File piccolo a parte: quello dei dati utente è grande e lento da riscrivere a ogni pagina.
   */
  async readPositions() {
    const f = (await this.readJson(this.positionPath)) || {};
    const m = this.positions || { docs: {} };
    const newer = (a, b) => (!a ? b : !b ? a : (a.t || 0) >= (b.t || 0) ? a : b);
    const docs = { ...(f.docs || {}) };
    for (const [k, v] of Object.entries(m.docs || {})) docs[k] = newer(v, docs[k]);
    this.positions = { bible: newer(m.bible, f.bible), docs };
    return this.positions;
  }

  /** doc: id del documento, oppure null per la Bibbia. */
  savePosition(doc, place) {
    this.positions = this.positions || { docs: {} };
    const p = { ...place, t: Date.now() };
    if (doc) this.positions.docs[doc] = p;
    else this.positions.bible = p;
    window.clearTimeout(this.positionTimer);
    this.positionTimer = window.setTimeout(async () => {
      try {
        const cur = await this.readPositions();
        cur.docs = Object.fromEntries(Object.entries(cur.docs).sort((a, b) => (b[1].t || 0) - (a[1].t || 0)).slice(0, 300));
        await this.app.vault.adapter.write(this.positionPath, JSON.stringify(cur));
      } catch (e) {
        console.warn('[lampada] posizione di lettura non salvata', e);
      }
    }, 2000);
  }

  openSearch(view) {
    new SearchModal(this, (ref) => (view ? view.navigate(ref) : this.openReader(ref))).open();
  }

  async openFileRaw(file, mode, subpath) {
    // In una cartella nascosta Obsidian non lo può aprire: documento in Lampada, immagine nel browser.
    if (file.disk) {
      await this.library.ensureLoaded().catch(() => null);
      const d = this.library.byFile && this.library.byFile.get(file.basename);
      const par = /\^p(\d+)/.exec(subpath || '');
      if (d) return this.openLibraryDoc(d, par ? +par[1] : undefined);
      if (file.extension !== 'md') return window.open(fileSrc(this.app, file));
      return new Notice('Questo file si apre solo dentro Lampada');
    }
    const leaf = this.app.workspace.getLeaf(mode === 'split' ? 'split' : 'tab');
    await leaf.openFile(file, subpath ? { eState: { subpath } } : undefined);
  }

  /* ---------------- etichette (tag di JW Library) ---------------- */

  /** Nome da mostrare: quello originale di JW Library (con spazi ed emoji) se conosciuto. */
  tagLabel(tag) {
    return (this.tagNames && this.tagNames[tag]) || String(tag).replace(/-/g, ' ');
  }

  /** Nomi originali delle etichette, letti una volta dal backup importato. */
  async loadTagNames() {
    if (this.tagNames || !this.jwlBase) return;
    this.tagNames = {};
    try {
      const imp = new JwlImporter(this);
      const a = this.app.vault.adapter;
      if (!(await a.exists(this.jwlBasePath))) return;
      const entries = await unzipEntries(await a.readBinary(this.jwlBasePath));
      const dbName = Object.keys(entries).find((n) => n.endsWith('.db'));
      const SQL = await imp.loadSqlJs(() => {});
      const db = new SQL.Database(entries[dbName]);
      try {
        const res = db.exec('SELECT Name FROM Tag');
        for (const [name] of res.length ? res[0].values : []) if (name) this.tagNames[jwlTag(name)] = String(name).trim();
      } finally {
        db.close();
      }
    } catch (e) {
      console.warn('[lampada] nomi delle etichette non disponibili', e);
    }
  }

  /** Tutte le note (blocchi JW Library) nella cartella delle note, con le loro etichette. */
  async collectTaggedNotes() {
    await this.loadTagNames();
    const folder = normalizePath(this.settings.notesFolder);
    const out = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(`${folder}/`)) continue;
      const text = await this.app.vault.cachedRead(f);
      if (!text.includes('<!-- jwl:')) continue;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter || {};
      const ref = fm.codice && /^\d{8}$/.test(String(fm.codice)) ? parseCode(fm.codice) : null;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const head = /^### (.*)$/.exec(lines[i]);
        if (!head || !/^<!-- jwl:/.test((lines[i + 1] || '').trim())) continue;
        let j = i + 2;
        const body = [];
        while (j < lines.length && !/^#{1,3} /.test(lines[j]) && !/^---\s*$/.test(lines[j])) body.push(lines[j++]);
        const tags = [...new Set([...body.join('\n').matchAll(/(?:^|\s)#(\p{L}[^\s#·,;:!?()[\]]*)/gu)].map((m) => m[1]))];
        if (!tags.length) continue;
        let where = fm.pubblicazione ? `${fm.pubblicazione}${fm.numero ? ` ${fm.numero}` : ''}` : f.basename;
        const linkLine = body.find((l) => /^\*\*.*jwlibrary:\/\/\/finder\?docid=/.test(l));
        if (linkLine) where = `${linkLine.replace(/^\*\*(.*?)\*\*.*$/, '$1')} · ${where}`;
        const snippet = cleanSnippet(
          body
            .filter((l) => l !== linkLine && !/^\s*(#[^\s#]+\s*)+(·.*)?$/.test(l) && !/^\*JW Library ·/.test(l))
            .join(' ')
        ).slice(0, 220);
        out.push({
          path: f.path,
          line: i,
          title: head[1].trim() === 'Nota' ? '' : head[1].trim(),
          snippet,
          tags,
          ref: ref ? { book: ref.book, chapter: ref.chapter, verse: ref.verse } : null,
          where,
        });
      }
    }
    return out;
  }

  /* ---------------- evidenziazioni (formato JW Library) ---------------- */

  rebuildMarkIndex() {
    this.marksByCh = new Map();
    this.marksByDoc = new Map();
    for (const m of this.marks) {
      const map = m.doc ? this.marksByDoc : this.marksByCh;
      const k = m.doc ? String(m.doc) : `${m.b}:${m.c}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(m);
    }
  }

  /** Evidenziazioni di un documento della biblioteca (intervalli di parole per paragrafo). */
  marksForDoc(doc) {
    return (this.marksByDoc && this.marksByDoc.get(String(doc))) || [];
  }

  addDocMark(doc, color, ranges) {
    const m = { id: newGuid(), doc: String(doc), color, ranges: ranges.map((r) => ({ v: r.v, s: r.s, e: r.e })), src: 'local', mod: true, t: Date.now() };
    this.marks.push(m);
    this.rebuildMarkIndex();
    this.requestSave(true);
    return m;
  }

  cutDocMarks(doc, ranges) {
    this.cutMarksIn(this.marksForDoc(doc), ranges, { doc: String(doc) });
  }

  marksFor(b, c) {
    return (this.marksByCh && this.marksByCh.get(`${b}:${c}`)) || [];
  }

  markColorAt(b, c, v) {
    let color = null;
    for (const m of this.marksFor(b, c)) if (m.ranges.some((r) => r.v === v)) color = m.color;
    return color;
  }

  addMark(b, c, color, ranges) {
    const m = { id: newGuid(), b, c, color, ranges: ranges.map((r) => ({ v: r.v, s: r.s, e: r.e })), src: 'local', mod: true, t: Date.now() };
    this.marks.push(m);
    this.rebuildMarkIndex();
    this.requestSave(true);
    return m;
  }

  deleteMark(m) {
    const i = this.marks.indexOf(m);
    if (i >= 0) this.marks.splice(i, 1);
    this.markTomb[m.id] = Date.now();
    if (m.src === 'jwl' && !this.deletedJwl.includes(m.id)) this.deletedJwl.push(m.id);
  }

  /** Toglie le parti di evidenziazione che cadono negli intervalli dati (come quando si riscrive sopra in JW Library). */
  cutMarks(b, c, ranges) {
    this.cutMarksIn(this.marksFor(b, c), ranges, { b, c });
  }

  cutMarksIn(list, ranges, base) {
    for (const m of [...list]) {
      let changed = false;
      const keep = [];
      const extra = [];
      for (const r of m.ranges) {
        const cut = ranges.find((x) => x.v === r.v);
        const end = r.e < 0 ? Infinity : r.e;
        const cEnd = !cut ? -1 : cut.e < 0 ? Infinity : cut.e;
        if (!cut || cEnd < r.s || cut.s > end) {
          keep.push(r);
          continue;
        }
        changed = true;
        if (r.s < cut.s) keep.push({ v: r.v, s: r.s, e: cut.s - 1 });
        if (end > cEnd) extra.push({ v: r.v, s: cEnd + 1, e: r.e });
      }
      if (!changed) continue;
      if (!keep.length && extra.length) keep.push(...extra.splice(0));
      if (keep.length) {
        m.ranges = keep;
        m.mod = true;
        m.t = Date.now();
      } else this.deleteMark(m);
      if (extra.length) this.marks.push({ id: newGuid(), ...base, color: m.color, ranges: extra, src: 'local', mod: true, t: Date.now() });
    }
    this.rebuildMarkIndex();
    this.requestSave(true);
  }

  /** place: { book, chapter, verse } (Bibbia) oppure { doc, par } (paragrafo di una pubblicazione). */
  findBookmark(place) {
    const k = bookmarkKey(place);
    return this.bookmarks.find((b) => bookmarkKey(b) === k);
  }

  toggleBookmark(place) {
    const existing = this.findBookmark(place);
    if (existing) {
      this.bookmarks.splice(this.bookmarks.indexOf(existing), 1);
      this.bmTomb[bookmarkKey(place)] = Date.now();
    } else this.bookmarks.push({ ...place, created: Date.now(), t: Date.now() });
    this.requestSave(true);
    new Notice(existing ? 'Segnalibro rimosso' : 'Segnalibro aggiunto');
  }

  /** Aperti di recente (capitoli della Bibbia e documenti), su questo dispositivo. */
  addRecent(place) {
    const key = (p) => (p.doc ? `d:${p.doc}` : `${p.book}:${p.chapter}`);
    const list = (this.ui.recent || []).filter((p) => key(p) !== key(place));
    this.ui.recent = [{ ...place, t: Date.now() }, ...list].slice(0, 15);
    this.requestSave();
  }

  /**
   * Segnalibri e letture recenti, Bibbia e pubblicazioni insieme. done: chiamata prima di aprire (es. per chiudere una finestra).
   * compact (home della Bibbia e della Biblioteca): una riga per sezione che scorre di lato, "Tutti" apre l'elenco completo.
   */
  async renderPlaces(el, done, compact) {
    await this.library.ensureLoaded().catch(() => null);
    await this.bible.ensureLoaded().catch(() => null);
    const lib = this.library;
    const describe = (p) => {
      if (p.doc) {
        const d = lib.byDocId && lib.byDocId.get(String(p.doc));
        return d && { icon: 'library-big', title: d.title, sub: d.pub.title, open: () => this.openLibraryDoc(d, p.par) };
      }
      return this.bible.byNum && this.bible.byNum.get(p.book) && {
        icon: 'book-open',
        title: this.bible.refLabel(p),
        sub: 'Bibbia',
        open: () => this.openReader({ book: p.book, chapter: p.chapter, verse: p.verse }),
      };
    };
    let allBtn = false;
    const strip = (title, items) => {
      const head = el.createDiv('lmp-strip-head');
      head.createEl('h4', { cls: 'lmp-section-title', text: title });
      if (!allBtn) {
        allBtn = true;
        const all = head.createEl('button', { cls: 'lmp-strip-all', text: 'Tutti' });
        all.addEventListener('click', () => new PlacesModal(this, null).open());
      }
      const row = el.createDiv('lmp-strip');
      for (const [, x] of items) {
        const chip = row.createEl('button', { cls: 'lmp-chip', attr: { 'aria-label': `${x.title} · ${x.sub}` } });
        setIcon(chip.createSpan('lmp-chip-icon'), x.icon);
        chip.createSpan({ cls: 'lmp-chip-text', text: x.title });
        chip.addEventListener('click', () => x.open());
      }
    };
    const section = (title, list, removable) => {
      const items = list.map((p) => [p, describe(p)]).filter(([, x]) => x);
      if (!items.length) return;
      if (compact) return strip(title, items);
      el.createEl('h4', { cls: 'lmp-section-title', text: title });
      const box = el.createDiv('lmp-places');
      for (const [p, x] of items) {
        const row = box.createDiv('lmp-place');
        setIcon(row.createSpan('lmp-place-icon'), x.icon);
        const txt = row.createDiv('lmp-place-text');
        txt.createDiv({ cls: 'lmp-place-title', text: x.title });
        txt.createDiv({ cls: 'lmp-place-sub', text: x.sub });
        row.addEventListener('click', () => {
          if (done) done();
          x.open();
        });
        if (!removable) continue;
        const del = row.createEl('button', { cls: 'clickable-icon lmp-place-remove', attr: { 'aria-label': 'Rimuovi segnalibro' } });
        setIcon(del, 'x');
        del.addEventListener('click', (evt) => {
          evt.stopPropagation();
          this.toggleBookmark(p);
          row.remove();
        });
      }
    };
    section('Segnalibri', [...this.bookmarks].sort((a, b) => (b.created || 0) - (a.created || 0)), true);
    section('Aperti di recente', this.ui.recent || [], false);
  }

  notePath(book, chapter, verse) {
    return normalizePath(`${this.settings.notesFolder}/${book.title} ${chapter}-${verse}.md`);
  }

  async ensureNoteFile(book, chapter, verse, text) {
    const path = this.notePath(book, chapter, verse);
    let file = this.bible.getFile(path);
    if (!file) {
      const folder = normalizePath(this.settings.notesFolder);
      if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
      const label = `${book.title} ${chapter}:${verse}`;
      const content = [
        '---',
        `riferimento: "${label}"`,
        `codice: "${verseCode(book.num, chapter, verse)}"`,
        'tags: [nota-bibbia]',
        '---',
        `> [!quote] [${label}](${jwLibraryUrl({ book: book.num, chapter, verse })})`,
        `> ${text}`,
        '',
        '',
      ].join('\n');
      file = await this.app.vault.create(path, content);
    }
    return file;
  }

  /** Scrive (o aggiorna) un blocco di nota JW Library nella nota del versetto. */
  async saveJwlNote(ctx, note) {
    const file = await this.ensureNoteFile(ctx.book, ctx.c, ctx.v, ctx.verseText);
    const md = formatNoteBlock(note);
    await this.app.vault.process(file, (text) => {
      const parsed = parseNoteFile(text);
      const existing = parsed.blocks.find((b) => b.guid === note.guid);
      if (!existing) return `${text.replace(/\s*$/, '')}\n\n${md}\n`;
      const lines = parsed.lines.slice();
      lines.splice(existing.start, existing.end - existing.start, ...md.split('\n'), '');
      return lines.join('\n');
    });
  }

  async openNote(book, chapter, verse, text) {
    const file = await this.ensureNoteFile(book, chapter, verse, text);
    const existing = this.app.workspace.getLeavesOfType('markdown').find((l) => l.view.file === file);
    if (existing) {
      this.app.workspace.setActiveLeaf(existing, { focus: true });
      return;
    }
    const leaf = this.readerInMainArea() && !Platform.isPhone ? this.app.workspace.getLeaf('split', 'vertical') : this.mainAreaLeaf();
    await leaf.openFile(file, { active: true });
  }

  readerInMainArea() {
    const ws = this.app.workspace;
    const leaf = ws.getLeavesOfType(VIEW_TYPE)[0];
    return !!leaf && leaf.getRoot() === ws.rootSplit;
  }

  /** Una nuova scheda nell'area principale (anche se il lettore è nella barra laterale). */
  mainAreaLeaf() {
    const ws = this.app.workspace;
    const recent = ws.getMostRecentLeaf(ws.rootSplit);
    if (recent && !(recent.view instanceof BibleView)) {
      ws.setActiveLeaf(recent, { focus: false });
      return ws.getLeaf('tab');
    }
    return ws.getLeaf('tab');
  }

  /**
   * Note di JW Library sulle pubblicazioni (file in "Note Bibbia/JW Library"), per documento:
   * { guid, mark, title, content, tags, date, par, file, line }. Si ricostruisce quando quei file cambiano.
   */
  async pubNotesFor(doc) {
    if (!this.pubNoteIndex) {
      const folder = normalizePath(`${this.settings.notesFolder}/JW Library`) + '/';
      const map = new Map();
      for (const f of this.app.vault.getMarkdownFiles()) {
        if (!f.path.startsWith(folder)) continue;
        const parsed = parseNoteFile(await this.app.vault.cachedRead(f));
        for (const b of parsed.blocks) {
          const m = /docid=(\d+)(?:&par=(\d+))?/.exec(b.linkLine || '');
          if (!m) continue;
          if (!map.has(m[1])) map.set(m[1], []);
          map.get(m[1]).push({ ...b, par: m[2] ? +m[2] : null, file: f, line: b.start });
        }
      }
      this.pubNoteIndex = map;
    }
    return this.pubNoteIndex.get(String(doc)) || [];
  }

  onPubNoteFileChange(f) {
    const folder = normalizePath(`${this.settings.notesFolder}/JW Library`) + '/';
    if (!f || !f.path.startsWith(folder) || !this.pubNoteIndex) return;
    this.pubNoteIndex = null;
    window.clearTimeout(this.pubNoteTimer);
    this.pubNoteTimer = window.setTimeout(() => {
      for (const v of this.viewsOf(LIB_VIEW_TYPE, 'lib')) if (v instanceof LibraryView) v.renderDocNotes();
    }, 800);
  }

  async openNoteAt(file, line, evt) {
    const ws = this.app.workspace;
    const existing = ws.getLeavesOfType('markdown').find((l) => l.view.file === file);
    if (existing && !(evt && (evt.metaKey || evt.ctrlKey))) {
      ws.setActiveLeaf(existing, { focus: true });
      existing.setEphemeralState({ line });
      return;
    }
    const leaf = this.mainAreaLeaf();
    await leaf.openFile(file, { active: true, eState: { line } });
  }

  openInJwLibrary(ref) {
    window.open(jwLibraryUrl(ref));
  }

  fillTemplate(info) {
    return this.settings.insertTemplate
      .replace(/\{\{link\}\}/g, info.link)
      .replace(/\{\{ref\}\}/g, info.label)
      .replace(/\{\{text\}\}/g, info.text);
  }

  async convertRefs(editor, wholeNote) {
    await this.bible.ensureLoaded();
    let from;
    let to;
    if (wholeNote) {
      from = { line: 0, ch: 0 };
      const last = editor.lastLine();
      to = { line: last, ch: editor.getLine(last).length };
    } else if (editor.somethingSelected()) {
      from = editor.getCursor('from');
      to = editor.getCursor('to');
    } else {
      const line = editor.getCursor().line;
      from = { line, ch: 0 };
      to = { line, ch: editor.getLine(line).length };
    }
    let count = 0;
    let inFm = wholeNote && editor.getLine(0) === '---';
    const out = editor
      .getRange(from, to)
      .split('\n')
      .map((line, i) => {
        if (inFm) {
          if (i > 0 && line.trim() === '---') inFm = false;
          return line;
        }
        const hits = this.bible.scanLine(line, true).filter((h) => h.kind === 'plain');
        for (const h of hits.reverse()) {
          line = line.slice(0, h.start) + this.bible.formatLink(h.ref, h.versesText) + line.slice(h.end);
          count++;
        }
        return line;
      });
    if (!count) {
      new Notice('Nessun riferimento da convertire.');
      return;
    }
    editor.replaceRange(out.join('\n'), from, to);
    new Notice(`${count} riferiment${count === 1 ? 'o convertito' : 'i convertiti'} in link`);
  }

  async showNoteRefs(file) {
    await this.bible.ensureLoaded();
    const text = await this.app.vault.cachedRead(file);
    const hits = [];
    for (const line of stripFrontmatter(text).split('\n')) {
      if (/\d:\d|jwlibrary|\[\[/.test(line)) hits.push(...this.bible.scanLine(line, true));
    }
    new NoteRefsModal(this, file, hits).open();
  }

  /* ---------------- link biblici nelle note ---------------- */

  setupLinkHandling() {
    for (const type of ['mousedown', 'mouseup', 'click']) {
      this.registerDomEvent(document, type, (evt) => this.onDocPointer(evt), { capture: true });
    }
    this.registerDomEvent(document, 'mouseover', (evt) => this.onDocHover(evt));
    this.registerDomEvent(document, 'mouseout', (evt) => this.onDocHoverOut(evt));
    this.hoverEl = document.body.createDiv('lmp-hover-card');
    this.hoverEl.hide();
    this.hoverEl.addEventListener('mouseenter', () => window.clearTimeout(this.hoverHideTimer));
    this.hoverEl.addEventListener('mouseleave', () => this.hideHover());
    this.register(() => this.hoverEl.remove());
  }

  /** Riconosce un link biblico sotto il puntatore, in modalità lettura o in anteprima live. */
  detectBibleLink(target, forClick) {
    if (!(target instanceof HTMLElement) || !this.bible.validCodes) return null;
    // Bibbia, testo delle pubblicazioni e pannello "approfondisci" gestiscono da sé i loro link.
    if (target.closest('.lmp-view, .lmp-hover-card, .modal-container, .lmp-lib [data-pid], .lmp-deep')) return null;
    const a = target.closest('a');
    if (a) {
      const href = a.getAttribute('href') || '';
      if (href.startsWith('jwlibrary:')) {
        const codes = codesFromJwUrl(href);
        if (!codes) return null;
        const ref = refFromCodes(codes[0], codes[1]);
        return this.bible.byNum.has(ref.book) ? { kind: 'jw', ref, el: a } : null;
      }
      if (a.hasClass('internal-link')) {
        const ref = this.bible.refFromLinkpath(a.dataset.href || href);
        return ref && ref.chapter ? { kind: 'wiki', ref, el: a } : null;
      }
      return null;
    }
    const span = target.closest('.cm-link, .cm-url, .cm-hmd-internal-link');
    if (!span || !span.closest('.cm-content')) return null;
    const leaf = this.app.workspace.getLeavesOfType('markdown').find((l) => l.view.containerEl.contains(span));
    const view = leaf && leaf.view;
    const cm = view && view.editor && view.editor.cm;
    if (!cm || !cm.posAtDOM) return null;
    if (forClick && view.getState().source) return null; // sorgente pura: lascia modificare
    let pos;
    try {
      pos = cm.posAtDOM(span);
    } catch (e) {
      return null;
    }
    const line = cm.state.doc.lineAt(pos);
    const off = pos - line.from;
    const hit = this.bible.scanLine(line.text, false).find((h) => off >= h.start && off < h.end);
    if (!hit) return null;
    if (forClick) {
      // Se il cursore è dentro il link, il markdown è visibile: l'utente lo sta modificando.
      const head = cm.state.selection.main.head;
      if (head >= line.from + hit.start && head <= line.from + hit.end) return null;
    }
    return { kind: hit.kind, ref: hit.ref, el: span };
  }

  onDocPointer(evt) {
    if (evt.button !== 0) return;
    const info = this.detectBibleLink(evt.target, true);
    if (!info) return;
    const mod = evt.metaKey || evt.ctrlKey;
    const wantReader = (this.settings.clickAction === 'reader') !== mod;
    // Lasciamo fare a Obsidian quando il comportamento normale coincide con quello voluto.
    if (!wantReader && info.kind === 'jw') return;
    if (!wantReader && info.kind === 'wiki' && this.settings.clickAction === 'reader') return;
    evt.preventDefault();
    evt.stopPropagation();
    evt.stopImmediatePropagation();
    if (evt.type !== 'click') return;
    this.hideHover(true);
    if (wantReader) this.openReader(info.ref);
    else this.openInJwLibrary(info.ref);
  }

  onDocHover(evt) {
    if (!this.settings.hoverPreview) return;
    const info = this.detectBibleLink(evt.target, false);
    if (!info) return;
    if (this.hoverInfo && this.hoverInfo.el === info.el) {
      window.clearTimeout(this.hoverHideTimer);
      return;
    }
    window.clearTimeout(this.hoverShowTimer);
    this.hoverShowTimer = window.setTimeout(() => this.showHover(info), 350);
  }

  onDocHoverOut(evt) {
    window.clearTimeout(this.hoverShowTimer);
    if (!this.hoverInfo) return;
    const to = evt.relatedTarget;
    if (to instanceof Node && (this.hoverInfo.el.contains(to) || this.hoverEl.contains(to))) return;
    this.hideHover();
  }

  hideHover(now) {
    window.clearTimeout(this.hoverHideTimer);
    const hide = () => {
      this.hoverEl.hide();
      this.hoverInfo = null;
    };
    if (now) hide();
    else this.hoverHideTimer = window.setTimeout(hide, 200);
  }

  async showHover(info) {
    if (!info.el.isConnected) return;
    this.hoverInfo = info;
    const card = this.hoverEl;
    card.empty();
    const head = card.createDiv('lmp-hover-head');
    head.createSpan({ cls: `lmp-suggest-dot cat-${categoryOf(info.ref.book)}`, text: this.bible.byNum.get(info.ref.book)?.abbr || '' });
    head.createSpan({ cls: 'lmp-hover-ref', text: this.bible.refLabel(info.ref) });
    const body = card.createDiv({ cls: 'lmp-hover-text', text: '…' });
    const actions = card.createDiv('lmp-hover-actions');
    const act = (label, fn) => {
      const b = actions.createEl('button', { text: label });
      b.addEventListener('click', () => {
        this.hideHover(true);
        fn();
      });
    };
    act('Apri nel lettore', () => this.openReader(info.ref));
    act('JW Library', () => this.openInJwLibrary(info.ref));

    const r = info.el.getBoundingClientRect();
    card.show();
    const w = Math.min(380, window.innerWidth - 24);
    card.style.width = `${w}px`;
    card.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - w - 12))}px`;
    const below = r.bottom + 8;
    card.style.top = `${below}px`;

    try {
      const data = await this.bible.getChapter(info.ref.book, info.ref.chapter);
      if (this.hoverInfo !== info) return;
      let verses = this.bible.versesOf(info.ref);
      if (!verses.length) verses = [1, 2, 3].filter((v) => data.verseLines.has(v));
      const text = verses.map((v) => (verses.length > 1 ? `${v} ` : '') + this.bible.verseText(data, v)).join(' ');
      body.setText(text.length > 900 ? text.slice(0, 900) + '…' : text);
    } catch (e) {
      body.setText('Testo non disponibile.');
    }
    const h = card.offsetHeight;
    if (below + h > window.innerHeight - 8) card.style.top = `${Math.max(8, r.top - h - 8)}px`;
  }

  insertIntoNote(info) {
    const view = this.lastMarkdownView;
    const stillOpen = view && this.app.workspace.getLeavesOfType('markdown').some((l) => l.view === view);
    if (!stillOpen || !view.editor) {
      new Notice('Apri prima una nota in cui inserire il versetto.');
      return;
    }
    view.editor.replaceSelection(this.fillTemplate(info));
    new Notice(`Inserito in ${view.file ? view.file.basename : 'nota'}`);
  }
}

export { LampadaPlugin };
