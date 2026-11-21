import { ItemView, Component, Notice, setIcon, debounce, Platform, Menu, normalizePath } from 'obsidian';
import { GotoModal } from './bibbia-modali.js';
import { renderBibleDownload } from './bibbia-epub.js';
import { LIB_VIEW_TYPE } from './biblioteca-dati.js';
import { CATEGORIES, HIGHLIGHTS, SECTION_ORDER, VIEW_TYPE, paneOrder, paneLabel } from './costanti.js';
import { fileMeta, fileSrc, readFile, renderMd } from './file.js';
import { jwlTag } from './jwl-formati.js';
import { SCRABB_TYPES } from './scrabb-dati.js';
import { linkVerseToScrabb } from './scrabb-vista.js';
import { categoryOf, codesFromJwUrl, parseRefLinks, compressVerses, extractBlock, jwTokenText, newGuid, norm, noteFreeText, parseNoteFile, refFromCodes, splitJwTokens, stripFrontmatter, verseCode } from './testo.js';
import { Pager, ReadingModal, pageKey, placeSelBar, showDefinition } from './lettura.js';
import { GOSPELS, ParallelModal, aiMenu, highlightParts, parallelsInChapter, renderRbi8Verse, showAiSuggestions, verseAiCtx, wordStudy } from './studio.js';
import { PlacesModal, addGoToAction, addViewSwitch, autoHideBars, renderCitedIn, setBarsHidden, viewKeys } from './ui.js';

/* ------------------------------------------------------------------ */
/* Vista lettore                                                       */
/* ------------------------------------------------------------------ */

class BibleView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.bible = plugin.bible;
    this.state = { mode: 'books' };
    this.history = [];
    this.selected = new Set();
    this.primary = null;
    this.anchor = null;
    this.paneVisible = true;
    this.paneStack = [];
    this.paneComponent = null;
    this.chapterData = null;
    this.renderToken = 0;
    this.paneToken = 0;
    this.hoverPopover = null;
    this.navigationId = 0;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getIcon() {
    return 'book-open';
  }

  getDisplayText() {
    const s = this.state;
    if (s.mode === 'reader' && s.book) return this.bible.refLabel({ book: s.book, chapter: s.chapter });
    if (s.mode === 'chapters' && s.book) return this.bible.byNum.get(s.book)?.title || 'Bibbia';
    if (s.mode === 'tags') return 'Etichette';
    if (s.mode === 'tag') return this.plugin.tagLabel(s.tag);
    return 'Bibbia';
  }

  getState() {
    const s = this.state;
    // at: il versetto in cima, per riaprire Obsidian dove si stava leggendo
    const top = s.mode === 'reader' && this.primary == null && this.pager ? this.pager.anchorEl() : null;
    return { mode: s.mode, book: s.book, chapter: s.chapter, tag: s.tag, verse: this.primary ?? undefined, at: top ? +top.dataset.v : undefined };
  }

  async setState(state, result) {
    await super.setState(state, result);
    if (state && state.peek) this.peek = true;
    if (state && (state.book || state.mode)) await this.navigate(state, { push: false });
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('lmp-view');
    this.applyTypography();

    this.toolbarEl = root.createDiv('lmp-toolbar');
    this.bodyEl = root.createDiv('lmp-body');
    this.mainEl = this.bodyEl.createDiv('lmp-main');
    this.paneEl = this.bodyEl.createDiv('lmp-pane');
    this.pager = new Pager(this, this.mainEl, this.bodyEl, {
      content: () => (this.state.mode === 'reader' && this.chapterData ? this.mainEl.querySelector('.lmp-reader') : null),
      label: () => this.getDisplayText(),
      edge: (d) => this.stepChapter(d),
      settle: () => this.savePlace(),
      anchor: () => (this.primary != null ? this.mainEl.querySelector(`.lmp-verse[data-v="${this.primary}"]`) : null),
    });
    this.popoverEl = root.createDiv('lmp-fn-popover');
    this.popoverEl.hide();
    this.buildSelectionBar();
    this.registerDomEvent(document, 'selectionchange', debounce(() => this.onSelectionChange(), 200, true));
    this.buildToolbar();
    if (Platform.isPhone && this.addAction && !this.inShell) {
      // L'intestazione di Obsidian mostra già il titolo: le azioni vanno lì, la barra del plugin si nasconde.
      this.addAction('chevron-right', 'Capitolo successivo', () => this.stepChapter(1));
      this.addAction('chevron-left', 'Capitolo precedente', () => this.stepChapter(-1));
      this.addAction('search', 'Cerca ovunque', () => this.plugin.openSearch(this));
      this.addAction('bookmark', 'Segnalibri', () => new PlacesModal(this.plugin, this.herePlace(), 'bookmarks').open());
      this.addAction('history', 'Aperti di recente', () => new PlacesModal(this.plugin, null, 'recent').open());
      this.addAction('list', 'Libri e capitoli', () => {
        const st = this.state;
        if (st.mode === 'reader' && st.book) this.navigate({ mode: 'chapters', book: st.book });
        else this.navigate({ mode: 'books' });
      });
      addGoToAction(this, 'bible', () => this.navigate({ mode: 'books' }));
      root.addClass('lmp-native-header');
    }

    this.registerDomEvent(this.mainEl, 'click', (evt) => this.onMainClick(evt));
    this.registerDomEvent(this.mainEl, 'mouseover', (evt) => {
      const w = evt.target instanceof HTMLElement && evt.target.closest('[data-mid]');
      const mid = w ? w.dataset.mid : null;
      if (mid === this.hoverMid) return;
      this.hoverMid = mid;
      const links = mid ? (this.noteLinks || []).filter((l) => l.mark && l.mark.id === mid) : [];
      if (links.length) this.showNoteLinks(links);
      else this.showSelectedNoteLinks();
    });
    // Lavoro dello scorrimento al massimo una volta per fotogramma.
    let scrollFrame = 0;
    this.registerDomEvent(this.mainEl, 'scroll', () => {
      if (scrollFrame) return;
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = 0;
        this.hidePopover();
        this.redrawLinksSoon();
        this.updateProgress();
      });
    }, { passive: true });
    autoHideBars(this, this.mainEl);
    this.registerDomEvent(this.paneEl, 'scroll', () => {
      this.hidePopover();
      this.redrawLinksSoon();
    }, { passive: true });
    this.registerDomEvent(this.paneEl, 'click', (evt) => this.onLinkClick(evt));
    this.registerDomEvent(this.paneEl, 'mouseover', (evt) => this.onLinkHover(evt));

    let touch = null;
    this.registerDomEvent(this.mainEl, 'touchstart', (e) => {
      touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    }, { passive: true });
    this.registerDomEvent(this.mainEl, 'touchend', (e) => {
      if (!touch || this.state.mode !== 'reader' || this.pager.on) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touch.x;
      const dy = t.clientY - touch.y;
      touch = null;
      if (Math.abs(dx) > 80 && Math.abs(dy) < 50) this.stepChapter(dx < 0 ? 1 : -1);
    }, { passive: true });

    viewKeys(this, [
      ['ArrowLeft', () => (this.pager.on ? pageKey(this.pager, -1) : (this.stepChapter(-1), false))],
      ['ArrowRight', () => (this.pager.on ? pageKey(this.pager, 1) : (this.stepChapter(1), false))],
      ['ArrowUp', () => (this.primary == null ? true : (this.stepVerse(-1), false))],
      ['ArrowDown', () => (this.primary == null ? true : (this.stepVerse(1), false))],
      ['Escape', () => (this.clearSelection(), false)],
    ]);

    // Ridimensionamenti a raffica (barre che si chiudono, telefono che si apre): si ricalcola una volta sola alla fine.
    const relayout = debounce(() => this.applyLayout(), 120, true);
    const ro = new ResizeObserver(() => relayout());
    ro.observe(this.bodyEl);
    this.register(() => ro.disconnect());
    this.progressEl = this.bodyEl.createDiv('lmp-progress').createDiv();

    this.registerEvent(this.app.vault.on('create', (f) => this.onVaultChange(f)));
    this.registerEvent(this.app.vault.on('delete', (f) => this.onVaultChange(f)));
    this.registerEvent(this.app.vault.on('rename', (f) => this.onVaultChange(f)));
    this.registerEvent(
      this.app.workspace.on('lampada:index-changed', () => {
        if (this.state.mode !== 'reader' || !this.chapterData) return;
        this.decorateVerses();
        if (this.primary != null && !this.paneStack.length) {
          const n = this.plugin.noteIndex.lookup(this.chapterData.book.num, this.chapterData.chapter, this.primary).length;
          if (n !== this.paneCiteCount) this.renderPane();
        }
      })
    );

    if (!this.renderToken) await this.navigate({ mode: 'books' }, { push: false });
    this.plugin.checkUserDataFile();
  }

  async onClose() {
    setBarsHidden(this, false);
    this.contentEl.empty();
  }

  onVaultChange(file) {
    const folder = normalizePath(this.plugin.settings.notesFolder || '');
    if (this.state.mode === 'reader' && file && file.path.startsWith(folder)) {
      this.decorateVerses();
      this.renderPane();
    }
  }

  applyTypography() {
    this.plugin.applyFont(this.contentEl);
    if (this.pager) this.pager.layout();
  }

  /** Dove si è arrivati a leggere: il versetto in cima, per "Continua a leggere" anche su un altro dispositivo. */
  savePlace() {
    const d = this.chapterData;
    const el = this.pager.anchorEl();
    if (this.state.mode !== 'reader' || !d || !el) return;
    this.plugin.last = { book: d.book.num, chapter: d.chapter, verse: +el.dataset.v, t: Date.now() };
    this.plugin.savePosition(null, this.plugin.last);
    this.plugin.requestSave();
  }

  /* ---------------- toolbar ---------------- */

  buildToolbar() {
    const tb = this.toolbarEl;
    tb.empty();
    const btn = (icon, label, onClick, cls = '') => {
      const b = tb.createEl('button', { cls: `lmp-tb-btn clickable-icon ${cls}`, attr: { 'aria-label': label } });
      setIcon(b, icon);
      b.addEventListener('click', onClick);
      return b;
    };
    this.backBtn = btn('arrow-left', 'Indietro', () => this.goBack());
    addViewSwitch(tb, this.plugin, 'bible', () => this.navigate({ mode: 'books' }), this.inShell);
    this.titleBtn = tb.createEl('button', { cls: 'lmp-tb-title' });
    this.titleBtn.addEventListener('click', () => {
      const s = this.state;
      if (s.mode === 'reader') this.navigate({ mode: 'chapters', book: s.book });
      else this.navigate({ mode: 'books' });
    });
    tb.createDiv('lmp-tb-spacer');
    this.prevBtn = btn('chevron-left', 'Capitolo precedente (←)', () => this.stepChapter(-1), 'lmp-reader-only');
    this.nextBtn = btn('chevron-right', 'Capitolo successivo (→)', () => this.stepChapter(1), 'lmp-reader-only');
    btn('search', 'Cerca ovunque', () => this.plugin.openSearch(this));
    // Sul telefono questi stanno nel menu ⋯ (fillMenu): la barra resta leggibile, col titolo intero.
    this.parBtn = btn('columns-3', 'Racconti paralleli', () => this.toggleParallels(), 'lmp-reader-only lmp-desktop-only');
    btn('history', 'Aperti di recente', () => new PlacesModal(this.plugin, null, 'recent').open(), 'lmp-desktop-only');
    btn('bookmark', 'Segnalibri', () => new PlacesModal(this.plugin, this.herePlace(), 'bookmarks').open(), 'lmp-desktop-only');
    btn('type', 'Aspetto del testo', () => new ReadingModal(this.plugin).open(), 'lmp-desktop-only');
    this.paneBtn = btn('panel-right', 'Mostra/nascondi pannello di studio', () => this.togglePane(), 'lmp-reader-only lmp-desktop-only');
    btn('more-vertical', 'Altre opzioni', (evt) => this.showMoreMenu(evt));
    this.updateToolbar();
  }

  isPhoneNavigator() {
    return Platform.isPhone && this.leaf && this.plugin.leafLocation(this.leaf) !== 'tab' && this.plugin.settings.readerLocation === 'tab';
  }

  openGoto() {
    new GotoModal(this.plugin, (ref) => this.navigate(ref)).open();
  }

  togglePane() {
    this.peek = false;
    this.paneVisible = !this.paneVisible;
    this.renderPane();
    this.updateToolbar();
  }

  showMoreMenu(evt) {
    const menu = new Menu();
    this.fillMenu(menu);
    menu.showAtMouseEvent(evt);
  }

  /** Sul telefono le opzioni stanno nel menu ⋮ di Obsidian della scheda. */
  onPaneMenu(menu, source) {
    if (super.onPaneMenu) super.onPaneMenu(menu, source);
    if (!Platform.isPhone) return;
    menu.addSeparator();
    this.fillMenu(menu);
  }

  fillMenu(menu) {
    const s = this.plugin.settings;
    if (Platform.isPhone) {
      menu.addItem((i) => i.setTitle('Segnalibri').setIcon('bookmark').onClick(() => new PlacesModal(this.plugin, this.herePlace(), 'bookmarks').open()));
      menu.addItem((i) => i.setTitle('Aperti di recente').setIcon('history').onClick(() => new PlacesModal(this.plugin, null, 'recent').open()));
      menu.addSeparator();
    }
    menu.addItem((i) => i.setTitle('Vai a riferimento…').setIcon('locate').onClick(() => this.openGoto()));
    menu.addItem((i) => i.setTitle('Libri della Bibbia').setIcon('library').onClick(() => this.navigate({ mode: 'books' })));
    if ((this.bible.bibles || []).length > 1) {
      menu.addSeparator();
      for (const b of this.bible.bibles) menu.addItem((i) => i.setTitle(b.title).setIcon('book').setChecked(b.symbol === this.bible.symbol).onClick(() => this.plugin.setBible(b.symbol)));
      menu.addSeparator();
    }
    menu.addItem((i) => i.setTitle('Etichette').setIcon('tags').onClick(() => this.navigate({ mode: 'tags' })));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('Aspetto del testo…').setIcon('type').onClick(() => new ReadingModal(this.plugin).open()));
    menu.addSeparator();
    if (this.state.mode === 'reader') {
      menu.addItem((i) =>
        i
          .setTitle(this.paneVisible ? 'Nascondi pannello di studio' : 'Mostra pannello di studio')
          .setIcon('panel-right')
          .onClick(() => this.togglePane())
      );
      if (!Platform.isPhone)
        menu.addItem((i) =>
          i
            .setTitle('Apri i riferimenti in un riquadro a parte')
            .setIcon('columns-2')
            .setChecked(!!this.plugin.ui.splitRefs)
            .onClick(() => {
              this.plugin.ui.splitRefs = !this.plugin.ui.splitRefs;
              this.plugin.requestSave();
            })
        );
      if (this.isGospel())
        menu.addItem((i) => i.setTitle('Racconti paralleli').setIcon('columns-3').setChecked(!!this.plugin.ui.parallels).onClick(() => this.toggleParallels()));
      menu.addItem((i) =>
        i
          .setTitle('Segna i versetti più citati')
          .setIcon('flame')
          .setChecked(this.plugin.ui.citeHeat !== false)
          .onClick(() => {
            this.plugin.ui.citeHeat = this.plugin.ui.citeHeat === false;
            this.plugin.requestSave();
            for (const v of this.plugin.views()) v.layoutCiteHeat();
          })
      );
      menu.addItem((i) => i.setTitle('Spunti sul capitolo').setIcon('lightbulb').onClick((evt) => this.bibleAi(evt, null)));
      menu.addItem((i) =>
        i
          .setTitle('Apri il capitolo in JW Library')
          .setIcon('smartphone')
          .onClick(() => this.plugin.openInJwLibrary({ book: this.state.book, chapter: this.state.chapter, verse: this.primary ?? 1 }))
      );
    }
    const here = this.plugin.leafLocation(this.leaf);
    for (const [where, title, icon] of [
      ['tab', 'Sposta in una scheda', 'square'],
      ['left', 'Sposta nella barra laterale sinistra', 'panel-left-open'],
      ['right', 'Sposta nella barra laterale destra', 'panel-right-open'],
    ]) {
      if (where === here) continue;
      menu.addItem((i) =>
        i
          .setTitle(title)
          .setIcon(icon)
          .onClick(async () => {
            s.readerLocation = where;
            await this.plugin.saveAll(false);
            this.plugin.openReader(null, where, true);
          })
      );
    }
  }

  updateToolbar() {
    if (!this.toolbarEl) return;
    const s = this.state;
    this.toolbarEl.toggleClass('is-reader', s.mode === 'reader');
    this.backBtn.toggleClass('is-disabled', !this.canGoBack());
    // Nella home il selettore dice già "Bibbia": il titolo serve solo dentro un libro o un'etichetta.
    this.titleBtn.setText(s.mode === 'books' || !s.mode ? '' : this.getDisplayText());
    this.paneBtn.toggleClass('is-active', this.paneVisible);
    this.parBtn.toggle(this.isGospel());
    this.parBtn.toggleClass('is-active', !!this.plugin.ui.parallels);
    this.applyLayout();
  }

  /** Larghezza della vista: note a margine e linea di avanzamento. */
  applyLayout() {
    if (!this.bodyEl) return;
    this.bodyEl.toggleClass('is-narrow', this.bodyEl.clientWidth < 760);
    this.layoutMarginNotes();
    this.layoutCiteHeat();
    this.updateProgress();
  }

  /**
   * Segno sottile a destra dei versetti più citati nelle pubblicazioni ("Citato in"), più intenso dove ce ne sono di più.
   * Relativo al capitolo: solo i versetti citati almeno il doppio della mediana (×3 e ×5 per i livelli più forti),
   * circa il 6% dei versetti; nei capitoli dove tutti sono citati in modo simile non compare nulla.
   */
  async layoutCiteHeat() {
    const d = this.chapterData;
    const wrap = this.mainEl && this.mainEl.querySelector('.lmp-reader');
    if (this.citeHeatEl) this.citeHeatEl.remove();
    this.citeHeatEl = null;
    if (!d || !wrap || this.state.mode !== 'reader' || this.plugin.ui.citeHeat === false || !d.book.versesFile) return;
    const data = await this.bible.getBookVerses(d.book).catch(() => null);
    if (!data || this.chapterData !== d || !wrap.isConnected || this.citeHeatEl) return;
    const counts = [];
    for (let v = 1; v <= d.verseCount; v++) {
      const sec = ((data[`${d.chapter}:${v}`] || {}).sections || []).find((x) => x.title === 'Citato in');
      const n = sec && sec.md ? (sec.md.match(/^\s*-\s/gm) || []).length : 0;
      if (n) counts.push([v, n]);
    }
    const sorted = Array.from({ length: d.verseCount }, (_, i) => (counts.find((x) => x[0] === i + 1) || [0, 0])[1]).sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] || 0;
    const levelOf = (n) => (n >= Math.max(5, med * 5) ? 3 : n >= Math.max(4, med * 3) ? 2 : n >= Math.max(3, med * 2) ? 1 : 0);
    const wrapTop = wrap.getBoundingClientRect().top;
    const cs = getComputedStyle(wrap);
    const lineH = parseFloat(cs.lineHeight) || 30;
    const glyph = parseFloat(cs.fontSize) || 19;
    // Più versetti sulla stessa riga: un segno solo, il più intenso.
    const lines = new Map();
    for (const [v, n] of counts) {
      const level = levelOf(n);
      const r = level && wrap.querySelector(`.lmp-verse[data-v="${v}"]`)?.getClientRects()[0];
      if (!r) continue;
      const top = r.top - wrapTop;
      const key = Math.round(top / lineH);
      if (!lines.has(key) || lines.get(key).n < n) lines.set(key, { v, n, level, top });
    }
    if (!lines.size) return;
    const layer = (this.citeHeatEl = wrap.createDiv('lmp-cite-heat'));
    for (const x of lines.values()) {
      const m = layer.createDiv({ cls: 'lmp-cite-heat-mark', attr: { 'data-level': String(x.level), 'aria-label': `${d.chapter}:${x.v} · citato in ${x.n} pubblicazioni` } });
      m.style.top = `${x.top + (glyph * 1.15 - glyph) / 2}px`;
      m.style.height = `${glyph}px`;
      m.addEventListener('click', (evt) => {
        evt.stopPropagation();
        this.selectVerses([x.v], x.v);
      });
    }
  }

  /** Dove sei: il versetto scelto, altrimenti il primo visibile. */
  herePlace() {
    const d = this.chapterData;
    if (this.state.mode !== 'reader' || !d) return null;
    let v = this.primary;
    if (v == null) {
      const el = this.pager.anchorEl();
      v = el ? +el.dataset.v : 1;
    }
    const place = { book: d.book.num, chapter: d.chapter, verse: v };
    return { place, label: this.bible.refLabel(place) };
  }

  /** Linea sottile in alto: quanto manca alla fine del capitolo. */
  updateProgress() {
    if (!this.progressEl || !this.mainEl) return;
    const m = this.mainEl;
    const p = m.scrollHeight > m.clientHeight ? m.scrollTop / (m.scrollHeight - m.clientHeight) : 1;
    this.progressEl.style.transform = `scaleX(${Math.min(1, Math.max(0, p)).toFixed(3)})`;
  }

  /** Modalità "riquadro a parte" (non sul telefono, dove non si può dividere lo schermo). */
  wantSplit() {
    return !!this.plugin.ui.splitRefs && !Platform.isPhone;
  }

  /**
   * Apre un versetto, un documento della biblioteca o una nota in un riquadro accanto al lettore.
   * Il riquadro è sempre lo stesso: i clic successivi ne cambiano il contenuto.
   */
  async openInSplit(target) {
    const ws = this.app.workspace;
    let leaf = this.splitLeaf;
    let alive = false;
    if (leaf) ws.iterateAllLeaves((l) => (alive = alive || l === leaf));
    if (!alive || leaf === this.leaf) {
      leaf = ws.createLeafBySplit(this.leaf, 'vertical');
      this.splitLeaf = leaf;
    }
    if (target.ref) {
      // Nel riquadro a parte il versetto citato resta solo evidenziato: il pannello di studio si apre toccandolo.
      if (leaf.view instanceof BibleView) {
        leaf.view.peek = true;
        await leaf.view.navigate(target.ref);
      } else await leaf.setViewState({ type: VIEW_TYPE, active: false, state: { ...target.ref, peek: true } });
    } else if (target.doc) {
      await leaf.setViewState({ type: LIB_VIEW_TYPE, active: false, state: { mode: 'doc', sym: target.doc.pub.symbol, doc: target.doc.id, par: target.par ?? undefined } });
    } else if (target.file) {
      await leaf.openFile(target.file, { active: false, eState: target.line != null ? { line: target.line } : target.subpath ? { subpath: target.subpath } : undefined });
    }
    ws.revealLeaf(leaf);
  }

  /** Un file aperto da un riferimento o da "Citato in": nel riquadro a parte, come documento della biblioteca se lo è. */
  async openFileInSplit(file, subpath) {
    await this.plugin.library.ensureLoaded().catch(() => null);
    const doc = this.plugin.library.byFile && this.plugin.library.byFile.get(file.basename);
    if (doc && !(subpath && subpath.startsWith('#^'))) return this.openInSplit({ doc });
    // Nascosto (Obsidian non lo apre): nella biblioteca, al paragrafo.
    if (file.disk) return this.plugin.openFileRaw(file, 'tab', subpath);
    return this.openInSplit({ file, subpath });
  }

  /* ---------------- navigazione ---------------- */

  snapshot() {
    const s = this.state;
    return { mode: s.mode, book: s.book, chapter: s.chapter, tag: s.tag, verse: this.primary ?? undefined, scroll: this.mainEl?.scrollTop || 0 };
  }

  /** Prima di cambiare pagina: dove si era (nella vista unica la cronologia è del guscio). */
  pushHistory() {
    if (this.inShell) return this.inShell.push(this, this.snapshot());
    this.history.push(this.snapshot());
    if (this.history.length > 100) this.history.shift();
  }

  canGoBack() {
    return this.inShell ? this.inShell.stack.length > 0 : this.history.length > 0;
  }

  async goBack() {
    if (this.inShell) return this.inShell.goBack();
    const prev = this.history.pop();
    if (prev) await this.restore(prev);
  }

  async restore(prev) {
    await this.navigate({ ...prev, noSelect: !prev.verse }, { push: false });
    if (prev.scroll != null && !prev.verse) this.mainEl.scrollTop = prev.scroll;
  }

  stepChapter(delta) {
    if (this.state.mode !== 'reader') return;
    const t = this.bible.adjacentChapter(this.state.book, this.state.chapter, delta);
    if (!t) return;
    this.navigate(t);
  }

  stepVerse(delta) {
    if (this.state.mode !== 'reader' || !this.chapterData) return;
    const max = this.chapterData.verseCount;
    const v = Math.min(max, Math.max(1, (this.primary ?? 0) + delta));
    this.selectVerses([v], v);
    this.scrollToVerse(v);
  }

  async navigate(target, opts = {}) {
    const push = opts.push !== false;
    const token = ++this.renderToken;
    if (!this.mainEl) return;
    try {
      await this.bible.ensureLoaded();
    } catch (e) {
      if (token === this.renderToken) this.renderError(e);
      return;
    }
    if (token !== this.renderToken) return;

    if (target.mode === 'tags' || target.mode === 'tag') {
      if (push && this.state.mode) {
        this.pushHistory();
      }
      this.state = { mode: target.mode, tag: target.tag };
      this.hidePopover();
      this.contentEl.dataset.mode = target.mode;
      this.chapterData = null;
      this.paneStack = [];
      this.selected.clear();
      this.primary = null;
      this.renderPane();
      if (target.mode === 'tags') await this.renderTags(token);
      else await this.renderTag(target.tag, token);
      if (token !== this.renderToken) return;
      this.pager.refresh();
      this.updateToolbar();
      this.leaf.updateHeader?.();
      this.app.workspace.requestSaveLayout();
      return;
    }
    if (this.isPhoneNavigator() && (target.chapter || (target.book && this.bible.byNum.get(+target.book)?.chapters.length === 1 && target.mode !== 'chapters' && target.mode !== 'books'))) {
      // Sul telefono la scheda nella barra laterale fa da indice: il capitolo si apre nella scheda principale.
      const ws = this.app.workspace;
      const side = this.plugin.leafLocation(this.leaf) === 'left' ? ws.leftSplit : ws.rightSplit;
      if (side && side.collapse) side.collapse();
      await this.plugin.openReader({ ...target }, this.plugin.settings.appShell ? undefined : 'tab');
      return;
    }
    let book = target.book ? this.bible.byNum.get(+target.book) : null;
    let mode = target.mode || (target.chapter ? 'reader' : book ? 'chapters' : 'books');
    if (mode !== 'books' && !book) mode = 'books';
    let chapter = target.chapter ? +target.chapter : undefined;
    if (mode === 'chapters' && book.chapters.length === 1) {
      mode = 'reader';
      chapter = book.chapters[0];
    }
    if (mode === 'reader' && !book.chapters.includes(chapter)) chapter = book.chapters[0];

    const sameChapter = this.state.mode === 'reader' && mode === 'reader' && this.state.book === book.num && this.state.chapter === chapter;
    if (push && this.state.mode && !(sameChapter && !target.verse)) {
      this.pushHistory();
    }
    this.state = { mode, book: book?.num, chapter };
    this.hidePopover();
    this.contentEl.dataset.mode = mode;

    if (mode === 'books') {
      this.chapterData = null;
      this.paneStack = [];
      this.selected.clear();
      this.primary = null;
      this.renderBooks();
      this.renderPane();
      this.pager.refresh();
    } else if (mode === 'chapters') {
      this.chapterData = null;
      this.paneStack = [];
      this.selected.clear();
      this.primary = null;
      await this.renderChapters(book, token);
      this.renderPane();
      this.pager.refresh();
    } else {
      if (sameChapter && this.chapterData) {
        this.applyTargetSelection(target);
      } else {
        await this.renderReader(book, chapter, target, token);
      }
      this.plugin.last = { book: book.num, chapter, verse: target.verse ?? target.at, t: Date.now() };
      this.plugin.savePosition(null, this.plugin.last);
      this.plugin.requestSave();
    }
    if (token !== this.renderToken) return;
    this.updateToolbar();
    this.leaf.updateHeader?.();
    this.app.workspace.requestSaveLayout();
  }

  renderError(e) {
    this.mainEl.empty();
    // Nessuna Bibbia nel vault: si scarica da qui.
    if (e && e.noBible) return renderBibleDownload(this.plugin, this.mainEl.createDiv('lmp-error'), { onDone: () => this.navigate({ book: 1, chapter: 1 }) });
    const box = this.mainEl.createDiv('lmp-error');
    box.createEl('h3', { text: 'Impossibile aprire la Bibbia' });
    box.createEl('p', { text: e && e.message ? e.message : String(e) });
    const b = box.createEl('button', { text: 'Apri impostazioni' });
    b.addEventListener('click', () => {
      this.app.setting.open();
      this.app.setting.openTabById(this.plugin.manifest.id);
    });
  }

  /* ---------------- home: libri ---------------- */

  /** Selettore della Bibbia in uso, se nel vault ce n'è più di una completa. */
  biblePicker(parent) {
    const list = this.bible.bibles || [];
    if (list.length < 2) return;
    const sel = parent.createDiv('lmp-bible-pick').createEl('select', { cls: 'dropdown', attr: { 'aria-label': 'Bibbia' } });
    for (const b of list) sel.createEl('option', { text: b.title, value: b.symbol });
    sel.value = this.bible.symbol;
    sel.addEventListener('change', () => this.plugin.setBible(sel.value));
  }

  renderBooks() {
    const main = this.mainEl;
    main.empty();
    main.scrollTop = 0;
    const wrap = main.createDiv('lmp-home');
    this.biblePicker(wrap);

    const quick = wrap.createDiv('lmp-quick');
    // L'ultima lettura, anche se fatta su un altro dispositivo.
    const card = quick.createDiv('lmp-continue');
    card.hide();
    this.plugin.readPositions().catch(() => ({})).then(({ bible }) => {
      const last = [this.plugin.last, bible].filter(Boolean).sort((a, b) => (b.t || 0) - (a.t || 0))[0];
      if (!last || !this.bible.byNum.get(last.book) || !card.isConnected) return;
      setIcon(card.createDiv('lmp-continue-icon'), 'book-open');
      const txt = card.createDiv();
      txt.createDiv({ cls: 'lmp-continue-label', text: 'Continua a leggere' });
      txt.createDiv({ cls: 'lmp-continue-ref', text: this.bible.refLabel({ book: last.book, chapter: last.chapter, verse: last.verse }) });
      card.addEventListener('click', () => this.navigate({ book: last.book, chapter: last.chapter, at: last.verse }));
      card.show();
    });

    const tagsCard = quick.createDiv('lmp-continue lmp-tags-card');
    setIcon(tagsCard.createDiv('lmp-continue-icon'), 'tags');
    const tagsTxt = tagsCard.createDiv();
    tagsTxt.createDiv({ cls: 'lmp-continue-label', text: 'Note di JW Library' });
    tagsTxt.createDiv({ cls: 'lmp-continue-ref', text: 'Etichette' });
    tagsCard.addEventListener('click', () => this.navigate({ mode: 'tags' }));

    this.plugin.renderPlaces(wrap.createDiv(), null, true);

    const tiles = [];
    const group = (title, from, to) => {
      wrap.createEl('h4', { cls: 'lmp-section-title', text: title });
      const legend = wrap.createDiv('lmp-legend');
      for (const cat of CATEGORIES.filter((c) => c.from >= from && c.to <= to)) {
        legend.createSpan({ cls: `lmp-cat-label cat-${cat.id}`, text: cat.label });
      }
      const grid = wrap.createDiv('lmp-book-grid');
      for (const b of this.bible.books.filter((b) => b.num >= from && b.num <= to)) {
        const tile = grid.createDiv({ cls: `lmp-tile cat-${categoryOf(b.num)}` });
        const top = tile.createDiv('lmp-tile-top');
        top.createSpan({ cls: 'lmp-tile-abbr', text: b.abbr });
        top.createSpan({ cls: 'lmp-tile-num', text: String(b.num) });
        tile.createDiv({ cls: 'lmp-tile-name', text: b.title });
        const writer = tile.createDiv('lmp-tile-writer');
        const date = tile.createDiv('lmp-tile-date');
        tile.addEventListener('click', () => this.navigate({ book: b.num }));
        tiles.push({ b, tile, writer, date });
      }
    };
    group('Scritture Ebraico-Aramaiche', 1, 39);
    group('Scritture Greche Cristiane', 40, 66);

    Promise.all(tiles.map((t) => this.bible.getBookInfo(t.b).then((info) => ({ ...t, info })))).then((list) => {
      for (const { b, tile, writer, date, info } of list) {
        if (!tile.isConnected) return;
        // "Matteo / Matteo": lo scrittore si mostra solo se dice qualcosa in più del nome del libro.
        writer.setText(info.writer && info.writer !== b.title ? info.writer : '');
        date.setText(info.completed || '');
        const cat = CATEGORIES.find((c) => b.num >= c.from && b.num <= c.to);
        tile.setAttr(
          'title',
          [
            `${b.title}${cat ? ` · ${cat.label}` : ''}`,
            info.writer && `Scrittore: ${info.writer}`,
            info.place && `Luogo: ${info.place}`,
            info.completed && `Completato: ${info.completed}`,
            info.period && `Periodo: ${info.period}`,
          ]
            .filter(Boolean)
            .join('\n')
        );
      }
    });
  }

  /* ---------------- etichette ---------------- */

  async renderTags(token) {
    const main = this.mainEl;
    main.empty();
    main.scrollTop = 0;
    const wrap = main.createDiv('lmp-tags');
    wrap.createEl('h2', { text: 'Etichette' });
    const status = wrap.createDiv({ cls: 'lmp-empty', text: 'Carico le note…' });
    const notes = await this.plugin.collectTaggedNotes();
    if (token !== this.renderToken) return;
    status.remove();
    const counts = new Map();
    for (const n of notes) for (const t of n.tags) counts.set(t, (counts.get(t) || 0) + 1);
    if (!counts.size) {
      wrap.createDiv({ cls: 'lmp-empty', text: 'Nessuna etichetta: importa un backup di JW Library o aggiungi #etichette nei blocchi delle note.' });
      return;
    }
    const input = wrap.createEl('input', { type: 'search', cls: 'lmp-tags-filter', attr: { placeholder: 'Filtra le etichette…' } });
    const list = wrap.createDiv('lmp-tag-list');
    const tags = [...counts.entries()].sort((a, b) => this.plugin.tagLabel(a[0]).localeCompare(this.plugin.tagLabel(b[0]), 'it', { sensitivity: 'base' }));
    const draw = () => {
      list.empty();
      const q = norm(input.value).trim();
      for (const [tag, n] of tags) {
        const label = this.plugin.tagLabel(tag);
        if (q && !norm(label).includes(q)) continue;
        const row = list.createDiv('lmp-tag-row');
        setIcon(row.createSpan('lmp-tag-icon'), 'tag');
        row.createSpan({ cls: 'lmp-tag-name', text: label });
        row.createSpan({ cls: 'lmp-badge', text: String(n) });
        row.addEventListener('click', () => this.navigate({ mode: 'tag', tag }));
      }
    };
    input.addEventListener('input', draw);
    draw();
  }

  async renderTag(tag, token) {
    const main = this.mainEl;
    main.empty();
    main.scrollTop = 0;
    const wrap = main.createDiv('lmp-tags');
    const head = wrap.createDiv('lmp-tag-head');
    setIcon(head.createSpan('lmp-tag-icon'), 'tag');
    head.createEl('h2', { text: this.plugin.tagLabel(tag) });
    const notes = (await this.plugin.collectTaggedNotes()).filter((n) => n.tags.includes(tag));
    if (token !== this.renderToken) return;
    // Prima le note sulla Bibbia, in ordine di libro/capitolo/versetto, poi quelle sulle pubblicazioni.
    notes.sort((a, b) => (a.ref ? 0 : 1) - (b.ref ? 0 : 1) || (a.ref && b.ref ? verseCode(a.ref.book, a.ref.chapter, a.ref.verse || 0).localeCompare(verseCode(b.ref.book, b.ref.chapter, b.ref.verse || 0)) : a.where.localeCompare(b.where)));
    head.createSpan({ cls: 'lmp-badge', text: String(notes.length) });
    for (const n of notes) {
      const card = wrap.createDiv('lmp-tag-note');
      if (n.ref) card.addClass(`cat-${categoryOf(n.ref.book)}`);
      card.createDiv({ cls: 'lmp-tag-note-where', text: n.ref ? this.bible.refLabel(n.ref) : n.where });
      if (n.title) card.createDiv({ cls: 'lmp-tag-note-title', text: n.title });
      if (n.snippet) card.createDiv({ cls: 'lmp-tag-note-text', text: n.snippet });
      const others = n.tags.filter((t) => t !== tag);
      if (others.length) {
        const chips = card.createDiv('lmp-tag-chips');
        for (const t of others) {
          const chip = chips.createSpan({ cls: 'lmp-tag-chip', text: this.plugin.tagLabel(t) });
          chip.addEventListener('click', (evt) => {
            evt.stopPropagation();
            this.navigate({ mode: 'tag', tag: t });
          });
        }
      }
      card.addEventListener('click', (evt) => {
        if (n.ref && !(evt.metaKey || evt.ctrlKey)) this.navigate({ ...n.ref });
        else {
          const f = this.bible.getFile(n.path);
          if (f) this.plugin.openNoteAt(f, n.line, evt);
        }
      });
    }
  }

  /* ---------------- capitoli ---------------- */

  async renderChapters(book, token) {
    await this.plugin.userDataReady;
    if (token !== this.renderToken) return;
    const main = this.mainEl;
    main.empty();
    main.scrollTop = 0;
    const wrap = main.createDiv('lmp-chapters');
    const head = wrap.createDiv({ cls: `lmp-book-head cat-${categoryOf(book.num)}` });
    head.createDiv({ cls: 'lmp-book-head-abbr', text: book.abbr });
    head.createEl('h2', { text: book.title });
    const info = wrap.createDiv('lmp-book-info');
    const links = wrap.createDiv('lmp-book-links');

    const grid = wrap.createDiv('lmp-chapter-grid');
    for (const ch of book.chapters) {
      const cell = grid.createDiv({ cls: 'lmp-chapter-cell', text: String(ch) });
      if (this.plugin.last && this.plugin.last.book === book.num && this.plugin.last.chapter === ch) cell.addClass('is-last');
      const marks = this.plugin.marksFor(book.num, ch);
      if (marks.length) {
        cell.addClass('has-marks');
        cell.setAttr('aria-label', `${marks.length} evidenziazion${marks.length === 1 ? 'e' : 'i'}`);
        cell.createSpan({ cls: 'lmp-chapter-dot' }).dataset.hl = marks[marks.length - 1].color;
      }
      cell.addEventListener('click', () => this.navigate({ book: book.num, chapter: ch }));
    }

    const file = this.bible.getFile(this.bible.bookPath(book));
    if (!file) return;
    const text = stripFrontmatter(await readFile(this.app, file));
    if (token !== this.renderToken) return;
    for (const line of text.split('\n')) {
      const m = /^([^:#\-\[][^:]*):\s*\*\*(.+)\*\*\s*$/.exec(line);
      if (m) {
        const row = info.createDiv('lmp-book-info-row');
        row.createSpan({ cls: 'lmp-book-info-key', text: m[1].trim() });
        row.createSpan({ cls: 'lmp-book-info-val', text: m[2].trim() });
      }
      const l = /^- \[\[([^\]|]+)\|([^\]]+)\]\]/.exec(line);
      if (l) {
        const b = links.createEl('button', { cls: 'lmp-book-link', text: l[2] });
        b.addEventListener('click', (evt) => this.app.workspace.openLinkText(l[1], file.path, evt.metaKey || evt.ctrlKey ? 'split' : 'tab'));
      }
    }
  }

  /* ---------------- lettore ---------------- */

  async renderReader(book, chapter, target, token) {
    let data;
    try {
      data = await this.bible.getChapter(book.num, chapter);
    } catch (e) {
      if (token === this.renderToken) this.renderError(e);
      return;
    }
    await this.plugin.userDataReady;
    if (book.versesFile) await this.bible.getBookVerses(book).catch(() => null);
    const notes = await this.loadChapterNotes(book, chapter).catch(() => new Map());
    if (token === this.renderToken) this.chapterNotes = notes;
    if (token !== this.renderToken) return;
    this.chapterData = data;
    this.plugin.addRecent({ book: book.num, chapter });
    this.selected.clear();
    this.primary = null;
    this.paneStack = [];

    const main = this.mainEl;
    main.empty();
    main.scrollTop = 0;
    const wrap = main.createDiv('lmp-reader');
    const titleEl = wrap.createDiv({ cls: 'lmp-chapter-title' });
    titleEl.createSpan({ cls: 'lmp-chapter-title-book', text: book.title });
    titleEl.createSpan({ cls: 'lmp-chapter-title-num', text: book.chapters.length > 1 ? ` ${chapter}` : '' });

    const counters = new Map();
    for (const block of data.blocks) {
      if (block.type === 'heading') {
        wrap.createDiv({ cls: 'lmp-book-heading', text: block.text });
        continue;
      }
      const cls = ['lmp-p'];
      if (block.type === 'super') cls.push('lmp-superscription');
      if (block.poetry) cls.push('is-poetry');
      if (block.indent) cls.push('is-indent');
      const p = wrap.createEl('p', { cls: cls.join(' ') });
      for (const seg of block.segs) {
        const span = seg.v ? p.createSpan({ cls: 'lmp-verse', attr: { 'data-v': String(seg.v) } }) : p.createSpan();
        if (seg.marker) {
          const isFirst = seg.v === 1;
          span.createSpan({ cls: isFirst ? 'lmp-num lmp-chnum' : 'lmp-num lmp-vnum', text: seg.marker });
        }
        for (const t of seg.tokens) {
          if (t.t === 'ref') {
            if (seg.v && this.plugin.settings.showRefMarkers) {
              span.createSpan({ cls: 'lmp-ref-mark lmp-ref-inline', text: '+', attr: { 'data-v': String(seg.v), 'data-r': String(t.n), 'aria-label': 'Riferimenti' } });
            }
            continue;
          }
          if (t.t !== 'text') {
            span.createEl('sup', { cls: 'lmp-fn', text: '*', attr: { 'data-fn': t.n, 'aria-label': 'Nota in calce' } });
            continue;
          }
          if (!seg.v) {
            span.appendText(t.s);
            continue;
          }
          // Ogni parola ha il suo indice (come in JW Library), così le evidenziazioni sono parola per parola.
          for (const part of splitJwTokens(t.s)) {
            const n = counters.get(seg.v) || 0;
            if (part.w) {
              span.createSpan({ cls: 'lmp-w', text: part.s, attr: { 'data-t': String(n) } });
              counters.set(seg.v, n + 1);
            } else span.createSpan({ cls: 'lmp-sp', text: part.s, attr: { 'data-a': String(n - 1) } });
          }
        }
      }
    }

    const nav = wrap.createDiv('lmp-chapter-nav');
    const prev = this.bible.adjacentChapter(book.num, chapter, -1);
    const next = this.bible.adjacentChapter(book.num, chapter, 1);
    const navBtn = (ref, label, icon, after) => {
      const b = nav.createEl('button', { cls: 'lmp-nav-btn' });
      if (!ref) {
        b.addClass('is-hidden');
        return;
      }
      const i = createSpan();
      setIcon(i, icon);
      if (!after) b.appendChild(i);
      b.createSpan({ text: label + ' ' + this.bible.refLabel(ref) });
      if (after) b.appendChild(i);
      b.addEventListener('click', () => this.navigate(ref));
    };
    navBtn(prev, '', 'chevron-left', false);
    navBtn(next, '', 'chevron-right', true);

    this.decorateVerses();
    this.decorateParallels();
    this.pager.refresh();
    this.applyTargetSelection(target);
    this.marginEl = wrap.createDiv('lmp-margin');
    window.requestAnimationFrame(() => this.applyLayout());
  }

  /**
   * Evidenziazione collegata a una nota: quella indicata nel blocco oppure, per le note importate prima
   * che il collegamento venisse salvato, quella del versetto il cui testo coincide con il titolo (come in JW Library).
   */
  noteMark(blk, book, chapter, v, data) {
    const marks = this.plugin.marksFor(book.num, chapter);
    if (blk.mark) {
      const m = marks.find((x) => x.id === blk.mark) || this.plugin.marks.find((x) => x.id === blk.mark);
      if (m) return m;
    }
    const title = (blk.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!title || !data) return null;
    for (const m of marks) {
      if (!m.ranges.some((r) => r.v === v)) continue;
      const text = m.ranges
        .map((r) => jwTokenText(this.bible.verseText(data, r.v), r.s, r.e))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (text && (text === title || text.startsWith(title) || title.startsWith(text))) return m;
    }
    return null;
  }

  /** Note dei versetti del capitolo: titolo e colore dell'evidenziazione collegata. */
  async loadChapterNotes(book, chapter) {
    const out = new Map();
    const prefix = this.plugin.notePath(book, chapter, 1).replace(/-1\.md$/, '-');
    const folder = prefix.split('/').slice(0, -1).join('/');
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix) && /-\d+\.md$/.test(f.path) && f.path.split('/').slice(0, -1).join('/') === folder);
    for (const f of files) {
      const v = +/-(\d+)\.md$/.exec(f.path)[1];
      const parsed = parseNoteFile(await this.app.vault.cachedRead(f));
      const data = await this.bible.getChapter(book.num, chapter).catch(() => null);
      const list = parsed.blocks.map((b) => {
        const m = this.noteMark(b, book, chapter, v, data);
        return { title: b.title && b.title !== 'Nota' ? b.title : b.content.split('\n')[0], color: m ? m.color : '', mark: m || null };
      });
      if (!list.length && noteFreeText(parsed.rest)) list.push({ title: 'Appunti', color: '' });
      if (list.length) out.set(v, list);
    }
    return out;
  }

  /** Apre il pannello sul versetto, alla sezione Note. */
  openNotesOf(v) {
    this.paneVisible = true;
    this.scrollNotesOnRender = true;
    this.selectVerses([v], v);
  }

  /** Come in JW Library: un quadratino del colore della nota nel margine sinistro, accanto alla prima riga del versetto. */
  layoutMarginNotes() {
    const margin = this.marginEl;
    if (!margin || !margin.isConnected) return;
    margin.empty();
    const has = !!(this.chapterNotes && this.chapterNotes.size);
    this.mainEl.toggleClass('has-margin-notes', has);
    if (!has) return;
    const wrap = margin.parentElement;
    const lineH = parseFloat(getComputedStyle(wrap).lineHeight) || 30;
    // Come in JW Library: il quadratino sta sulla riga dove inizia l'evidenziazione della nota
    // (o dove inizia il versetto, se la nota non ha evidenziazione). Note sulla stessa riga: un quadratino con il numero.
    const wrapTop = wrap.getBoundingClientRect().top;
    const lines = new Map();
    for (const [v, list] of this.chapterNotes) {
      for (const n of list) {
        const r = n.mark && (n.mark.ranges.find((x) => x.v === v) || n.mark.ranges[0]);
        const anchor =
          (r && wrap.querySelector(`.lmp-verse[data-v="${r.v}"] .lmp-w[data-t="${r.s}"]`)) || wrap.querySelector(`.lmp-verse[data-v="${v}"] .lmp-w`) || wrap.querySelector(`.lmp-verse[data-v="${v}"]`);
        if (!anchor) continue;
        const top = anchor.getBoundingClientRect().top - wrapTop;
        const key = Math.round(top / (lineH / 2));
        if (!lines.has(key)) lines.set(key, { top, v, notes: [], anchors: [] });
        lines.get(key).notes.push(n);
        lines.get(key).anchors.push({ v, mark: n.mark, anchor: n.mark ? anchor : null });
      }
    }
    this.noteLinks = [];
    for (const line of lines.values()) {
      const many = line.notes.length > 1;
      const size = many ? 15 : 12;
      const sq = margin.createDiv({ cls: `lmp-margin-square${many ? ' is-many' : ''}`, attr: { 'aria-label': line.notes.map((n) => n.title).join(' · ') } });
      const colored = line.notes.find((n) => n.color);
      if (colored) sq.dataset.hl = colored.color;
      if (many) sq.setText(String(line.notes.length));
      // la riga inizia dove inizia il testo: centrato sull'altezza della riga
      const glyph = parseFloat(getComputedStyle(wrap).fontSize) || 19;
      sq.style.top = `${line.top + (glyph * 1.15 - size) / 2}px`;
      sq.addEventListener('click', () => this.openNotesOf(line.v));
      const links = line.anchors.filter((a) => a.mark).map((a) => ({ ...a, sq }));
      this.noteLinks.push(...links);
      sq.addEventListener('mouseenter', () => this.showNoteLinks(links));
      sq.addEventListener('mouseleave', () => this.showSelectedNoteLinks());
    }
    this.showSelectedNoteLinks();
  }

  /**
   * Collegamento tra un'evidenziazione e la sua nota nel pannello: una linea curva e leggera
   * dalla parola evidenziata al riquadro della nota (che deve essere visibile).
   */
  showNoteLinks(links) {
    this.clearNoteLinks();
    for (const l of links) if (l.mark) this.drawNoteConnector(l.mark.id);
  }

  drawNoteConnector(mid, card) {
    if (!this.mainEl) return;
    const words = [...this.mainEl.querySelectorAll(`.lmp-w[data-mid="${mid}"]`)];
    if (!words.length) return;
    words.forEach((e) => e.addClass('is-linked'));
    this.mainEl.querySelectorAll(`.lmp-sp[data-mid="${mid}"]`).forEach((e) => e.addClass('is-linked'));
    card = card || (this.paneEl && this.paneEl.querySelector(`.lmp-note-card[data-mid="${mid}"]`));
    if (!card || !card.isConnected || !card.offsetParent) return;
    const root = this.contentEl.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const pane = this.paneEl.getBoundingClientRect();
    if (c.bottom < pane.top + 10 || c.top > pane.bottom - 10) return; // nota fuori dalla vista del pannello
    const w = words[words.length - 1].getBoundingClientRect();
    const narrow = this.bodyEl.hasClass('is-narrow');
    // Pannello di lato: dalla fine dell'evidenziazione al bordo sinistro della nota. Pannello sotto: verso il bordo alto.
    const x1 = (w.left + w.right) / 2 - root.left;
    const y1 = w.bottom - root.top;
    const x2 = narrow ? c.left + 24 - root.left : c.left - root.left;
    const y2 = narrow ? Math.max(c.top, pane.top) - root.top : Math.min(Math.max(c.top + 22, pane.top + 8), pane.bottom - 8) - root.top;
    if (!this.linkSvg || !this.linkSvg.isConnected) {
      this.linkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this.linkSvg.setAttribute('class', 'lmp-link-svg');
      this.contentEl.appendChild(this.linkSvg);
    }
    const ns = 'http://www.w3.org/2000/svg';
    const path = document.createElementNS(ns, 'path');
    const mx = (x1 + x2) / 2;
    path.setAttribute('d', narrow ? `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}` : `M ${x1} ${y1} C ${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`);
    path.setAttribute('class', 'lmp-link-path');
    const mark = this.plugin.marks.find((m) => m.id === mid);
    if (mark) path.dataset.hl = mark.color;
    this.linkSvg.appendChild(path);
    for (const [x, y] of [[x1, y1], [x2, y2]]) {
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', y);
      dot.setAttribute('r', 2.5);
      dot.setAttribute('class', 'lmp-link-dot');
      if (mark) dot.dataset.hl = mark.color;
      this.linkSvg.appendChild(dot);
    }
    card.addClass('is-linked');
  }

  clearNoteLinks() {
    if (!this.mainEl) return;
    if (this.linkSvg) this.linkSvg.empty ? this.linkSvg.empty() : (this.linkSvg.innerHTML = '');
    this.mainEl.querySelectorAll('.is-linked').forEach((e) => e.removeClass('is-linked'));
    if (this.paneEl) this.paneEl.querySelectorAll('.is-linked').forEach((e) => e.removeClass('is-linked'));
  }

  /**
   * Linee tra le evidenziazioni e le note aperte nel pannello: compaiono da sole
   * (si possono spegnere col pulsante nella sezione Note); altrimenti solo passando sopra.
   */
  showSelectedNoteLinks() {
    this.clearNoteLinks();
    if (this.plugin.ui.autoLinks === false || !this.paneEl || Platform.isPhone) return;
    // solo le note visibili (con le schede la sezione Note può essere nascosta)
    this.paneEl.querySelectorAll('.lmp-note-card[data-mid]').forEach((card) => card.offsetParent && this.drawNoteConnector(card.dataset.mid, card));
  }

  /** Dopo uno scorrimento le linee si ridisegnano quando il testo è fermo. */
  redrawLinksSoon() {
    // si cancellano una volta all'inizio dello scorrimento, non a ogni fotogramma
    if (!this.linkRedrawTimer) this.clearNoteLinks();
    window.clearTimeout(this.linkRedrawTimer);
    this.linkRedrawTimer = window.setTimeout(() => {
      this.linkRedrawTimer = 0;
      this.showSelectedNoteLinks();
    }, 150);
  }

  applyTargetSelection(target) {
    if (target.verse && !target.noSelect) {
      const end = target.verseEnd && target.verseEnd > target.verse ? target.verseEnd : target.verse;
      const list = [];
      for (let v = target.verse; v <= end; v++) list.push(v);
      this.selectVerses(list, target.verse);
      this.scrollToVerse(target.verse, true);
    } else {
      if (target.verse) this.scrollToVerse(target.verse, false);
      else if (target.at > 1) this.scrollToVerse(target.at, false, 0, true);
      this.selected.clear();
      this.primary = null;
      this.decorateVerses();
      this.renderPane();
    }
  }

  /** atTop: il versetto in cima (riprendere a leggere), altrimenti solo se non si vede già. */
  scrollToVerse(v, flash, tries = 0, atTop = false) {
    const el = this.mainEl.querySelector(`.lmp-verse[data-v="${v}"]`);
    if (!el) return;
    // Riquadro appena creato: non ancora impaginato, si riprova al fotogramma dopo.
    if (!this.mainEl.clientHeight && tries < 20) {
      window.requestAnimationFrame(() => this.scrollToVerse(v, flash, tries + 1, atTop));
      return;
    }
    if (this.pager.on) this.pager.layout(el);
    else if (atTop) {
      this.mainEl.scrollTop += el.getBoundingClientRect().top - this.mainEl.getBoundingClientRect().top - 16;
      this.lastScrollTop = this.mainEl.scrollTop;
    } else this.scrollIntoViewIfHidden(el);
    if (flash) {
      const els = this.mainEl.querySelectorAll(`.lmp-verse[data-v="${v}"]`);
      els.forEach((e) => e.addClass('is-flash'));
      window.setTimeout(() => els.forEach((e) => e.removeClass('is-flash')), 1200);
    }
  }

  scrollIntoViewIfHidden(el) {
    const mainRect = this.mainEl.getBoundingClientRect();
    // Nei riquadri stretti il pannello di studio copre la parte bassa del testo: conta solo la parte visibile.
    let bottom = mainRect.bottom;
    if (this.bodyEl.hasClass('is-narrow') && this.bodyEl.hasClass('has-pane')) bottom = Math.min(bottom, this.paneEl.getBoundingClientRect().top);
    const r = el.getBoundingClientRect();
    if (r.top < mainRect.top + 40 || r.top > bottom - 60) {
      this.mainEl.scrollTop += r.top - mainRect.top - (bottom - mainRect.top) / 4;
      this.lastScrollTop = this.mainEl.scrollTop; // scorrimento nostro: le barre non si nascondono
    }
  }

  decorateVerses() {
    const d = this.chapterData;
    if (!d || !this.mainEl) return;
    const b = d.book.num;
    const c = d.chapter;
    this.mainEl.querySelectorAll('.lmp-note-mark, .lmp-ref-mark:not(.lmp-ref-inline)').forEach((e) => e.remove());
    this.mainEl.toggleClass('has-selection', this.selected.size > 0);
    window.requestAnimationFrame(() => this.showSelectedNoteLinks());
    const lastSpan = new Map();
    this.mainEl.querySelectorAll('.lmp-verse').forEach((el) => {
      const v = +el.dataset.v;
      el.toggleClass('is-selected', this.selected.has(v));
      lastSpan.set(v, el);
    });
    this.applyMarks();

    const showStudy = this.plugin.settings.showStudyMarkers;
    const showCites = this.plugin.settings.showCiteMarkers;
    for (const [v, el] of lastSpan) {
      const num = this.mainEl.querySelector(`.lmp-verse[data-v="${v}"] .lmp-num`);
      if (num) num.toggleClass('has-cites', showCites && this.plugin.noteIndex.hasCites(b, c, v));
      if (num && showStudy) {
        num.toggleClass('has-study', this.bible.hasStudyCached(d.book, c, v));
      } else if (num) num.removeClass('has-study');

      const vNotes = (this.chapterNotes && this.chapterNotes.get(v)) || null;
      if (vNotes || this.bible.getFile(this.plugin.notePath(d.book, c, v))) {
        // Icona della nota all'inizio del versetto, del colore dell'evidenziazione collegata.
        const n = vNotes ? vNotes.length : 0;
        const mark = createSpan({ cls: 'lmp-note-mark', attr: { 'aria-label': n ? `${n} not${n === 1 ? 'a' : 'e'}` : 'Nota su questo versetto' } });
        setIcon(mark, 'sticky-note');
        if (vNotes && vNotes[0].color) mark.dataset.hl = vNotes[0].color;
        if (n > 1) mark.createSpan({ cls: 'lmp-note-count', text: String(n) });
        mark.addEventListener('click', (evt) => {
          evt.stopPropagation();
          this.openNotesOf(v);
        });
        const first = this.mainEl.querySelector(`.lmp-verse[data-v="${v}"]`);
        const firstNum = first && first.querySelector('.lmp-num');
        if (firstNum) firstNum.after(mark);
        else if (first) first.prepend(mark);
      }
      // "+" in fondo al versetto solo se l'esportazione non ha i segni nel punto esatto.
      const hasInline = !!this.mainEl.querySelector(`.lmp-verse[data-v="${v}"] .lmp-ref-inline`);
      if (!hasInline && this.plugin.settings.showRefMarkers && this.bible.verseHasSection(d.book, c, v, 'Riferimenti')) {
        el.createSpan({ cls: 'lmp-ref-mark', text: '+', attr: { 'data-v': String(v), 'aria-label': 'Riferimenti' } });
      }
    }
  }

  /** Colora le parole evidenziate (intervalli di parole per versetto, come in JW Library). */
  applyMarks() {
    const d = this.chapterData;
    if (!d || !this.mainEl) return;
    this.mainEl.querySelectorAll('.lmp-w[data-hl], .lmp-sp[data-hl]').forEach((e) => {
      delete e.dataset.hl;
      delete e.dataset.mid;
    });
    const marks = this.plugin.marksFor(d.book.num, d.chapter);
    if (!marks.length) return;
    const cache = new Map();
    const elsOf = (v) => {
      if (!cache.has(v)) {
        const w = [];
        const sp = [];
        this.mainEl.querySelectorAll(`.lmp-verse[data-v="${v}"] .lmp-w, .lmp-verse[data-v="${v}"] .lmp-sp`).forEach((e) => (e.hasClass('lmp-w') ? w : sp).push(e));
        cache.set(v, { w, sp });
      }
      return cache.get(v);
    };
    for (const m of marks) {
      for (const r of m.ranges) {
        const { w, sp } = elsOf(r.v);
        const end = r.e < 0 ? Infinity : r.e;
        for (const e of w) {
          const t = +e.dataset.t;
          if (t >= r.s && t <= end) {
            e.dataset.hl = m.color;
            e.dataset.mid = m.id;
          }
        }
        for (const e of sp) {
          const a = +e.dataset.a;
          if (a >= r.s && a < end) {
            e.dataset.hl = m.color;
            e.dataset.mid = m.id;
          }
        }
      }
    }
  }

  /** Parole selezionate col mouse o col dito, raggruppate per versetto. */
  selectionWords() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !this.chapterData || this.state.mode !== 'reader') return null;
    const range = sel.getRangeAt(0);
    if (!this.mainEl.contains(range.commonAncestorContainer)) return null;
    const byV = new Map();
    this.mainEl.querySelectorAll('.lmp-w').forEach((el) => {
      if (!range.intersectsNode(el)) return;
      const v = +el.closest('.lmp-verse').dataset.v;
      const t = +el.dataset.t;
      const r = byV.get(v);
      if (!r) byV.set(v, { v, s: t, e: t });
      else {
        r.s = Math.min(r.s, t);
        r.e = Math.max(r.e, t);
      }
    });
    if (!byV.size) return null;
    return { ranges: [...byV.values()].sort((a, b) => a.v - b.v), rect: range.getBoundingClientRect(), text: sel.toString() };
  }

  buildSelectionBar() {
    const bar = (this.selBar = this.contentEl.createDiv('lmp-selbar'));
    bar.hide();
    // mousedown: non perdere la selezione cliccando sulla barra
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    for (const h of HIGHLIGHTS) {
      const dot = bar.createEl('button', { cls: `lmp-color-dot hl-${h.id}`, attr: { 'aria-label': `Evidenzia: ${h.label}` } });
      dot.addEventListener('click', () => this.applySelection(h.id));
    }
    const erase = bar.createEl('button', { cls: 'lmp-color-dot lmp-color-erase clickable-icon', attr: { 'aria-label': 'Rimuovi evidenziazione' } });
    setIcon(erase, 'eraser');
    erase.addEventListener('click', () => this.applySelection(null));
    const note = bar.createEl('button', { cls: 'lmp-color-dot lmp-color-erase clickable-icon', attr: { 'aria-label': 'Nota sul testo selezionato' } });
    setIcon(note, 'sticky-note');
    note.addEventListener('click', () => this.noteFromSelection());
    const word = bar.createEl('button', { cls: 'lmp-color-dot lmp-color-erase clickable-icon', attr: { 'aria-label': 'Studia la parola' } });
    setIcon(word, 'book-a');
    word.addEventListener('click', () => this.studyWord());
    const copy = bar.createEl('button', { cls: 'lmp-color-dot lmp-color-erase clickable-icon', attr: { 'aria-label': 'Copia' } });
    setIcon(copy, 'copy');
    copy.addEventListener('click', async () => {
      if (!this.selInfo) return;
      await navigator.clipboard.writeText(this.selInfo.text);
      new Notice('Testo copiato');
      this.hideSelectionBar();
    });
    const ai = bar.createEl('button', { cls: 'lmp-color-dot lmp-color-erase clickable-icon', attr: { 'aria-label': 'Spunti sul testo selezionato' } });
    setIcon(ai, 'lightbulb');
    ai.addEventListener('click', (evt) => {
      const info = this.selInfo;
      if (!info) return;
      window.getSelection().removeAllRanges();
      this.hideSelectionBar();
      this.bibleAi(evt, info.ranges.map((r) => r.v), info.text);
    });
    this.selDef = bar.createDiv('lmp-selbar-def');
    this.selDef.hide();
  }

  onSelectionChange() {
    const info = this.selectionWords();
    if (!info) {
      this.hideSelectionBar();
      return;
    }
    const same = this.selInfo && this.selInfo.text === info.text;
    this.selInfo = info;
    this.selBar.show();
    if (!same) showDefinition(this, this.selDef, info.text, () => this.studyWord(), () => placeSelBar(this));
    placeSelBar(this);
  }

  hideSelectionBar() {
    if (this.selBar) this.selBar.hide();
    this.selInfo = null;
  }

  applySelection(color) {
    const info = this.selInfo;
    const d = this.chapterData;
    if (!info || !d) return;
    this.plugin.cutMarks(d.book.num, d.chapter, info.ranges);
    if (color) {
      this.plugin.addMark(d.book.num, d.chapter, color, info.ranges);
      this.plugin.ui.lastColor = color;
    }
    window.getSelection().removeAllRanges();
    this.hideSelectionBar();
    this.applyMarks();
    this.renderPane();
  }

  /** Come in JW Library: evidenzia la selezione e apre una nota con il testo evidenziato come titolo. */
  noteFromSelection() {
    const info = this.selInfo;
    const d = this.chapterData;
    if (!info || !d) return;
    // Se la selezione coincide con un'evidenziazione esistente, la nota si collega a quella.
    const same = this.plugin
      .marksFor(d.book.num, d.chapter)
      .find((m) => m.ranges.length === info.ranges.length && m.ranges.every((r, i) => r.v === info.ranges[i].v && r.s === info.ranges[i].s && r.e === info.ranges[i].e));
    let mark = same;
    if (!mark) {
      this.plugin.cutMarks(d.book.num, d.chapter, info.ranges);
      mark = this.plugin.addMark(d.book.num, d.chapter, this.plugin.ui.lastColor || 'yellow', info.ranges);
    }
    const title = info.text.replace(/\s+/g, ' ').trim();
    window.getSelection().removeAllRanges();
    this.hideSelectionBar();
    this.pendingNote = { title, mark: mark.id };
    this.paneVisible = true;
    this.selectVerses([info.ranges[0].v], info.ranges[0].v);
  }

  /** Testo evidenziato di un'evidenziazione (anche su più versetti). */
  markText(m) {
    const d = this.chapterData;
    if (!d) return '';
    return m.ranges
      .map((r) => jwTokenText(this.bible.verseText(d, r.v), r.s, r.e))
      .filter(Boolean)
      .join(' … ');
  }

  onMainClick(evt) {
    const target = evt.target;
    if (!(target instanceof HTMLElement)) return;
    const fn = target.closest('.lmp-fn');
    if (fn) {
      evt.stopPropagation();
      this.showFootnote(fn);
      return;
    }
    const plus = target.closest('.lmp-ref-mark');
    if (plus) {
      evt.stopPropagation();
      this.showRefs(plus);
      return;
    }
    this.hidePopover();
    const verseEl = target.closest('.lmp-verse');
    if (!verseEl && Platform.isMobile && this.state.mode === 'reader' && !target.closest('button, a, .lmp-margin-square, .lmp-print-refs')) {
      // Tocco fuori dal testo (margini, tra i paragrafi): toglie la selezione, oppure apre/chiude lo schermo pieno come nei lettori di libri.
      if (this.selected.size) this.clearSelection();
      else setBarsHidden(this, !this.barsHidden);
      return;
    }
    if (!verseEl || !this.chapterData) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    const v = +verseEl.dataset.v;
    const peek = this.peek;
    this.peek = false;

    if (evt.shiftKey && this.anchor != null) {
      const a = Math.min(this.anchor, v);
      const b = Math.max(this.anchor, v);
      const list = [];
      for (let i = a; i <= b; i++) list.push(i);
      this.selectVerses(list, v, true);
    } else if (evt.metaKey || evt.ctrlKey) {
      const set = new Set(this.selected);
      if (set.has(v)) set.delete(v);
      else set.add(v);
      this.selectVerses([...set], set.has(v) ? v : [...set][0] ?? null);
    } else if (this.selected.size === 1 && this.selected.has(v) && !peek) {
      this.clearSelection();
    } else {
      this.selectVerses([v], v);
    }
  }

  selectVerses(list, primary, keepAnchor) {
    this.selected = new Set(list);
    this.primary = list.length ? primary ?? list[0] : null;
    if (!keepAnchor) this.anchor = this.primary;
    this.paneStack = [];
    this.decorateVerses();
    this.renderPane();
    this.app.workspace.requestSaveLayout();
  }

  clearSelection() {
    this.hidePopover();
    if (!this.selected.size) {
      // Spunti sul capitolo: il pannello è aperto senza versetti selezionati.
      if (this.paneStack.length) {
        this.paneStack = [];
        this.renderPane();
      }
      return;
    }
    this.selectVerses([], null);
  }

  showFootnote(fnEl) {
    const d = this.chapterData;
    const text = d && d.footnotes[fnEl.dataset.fn];
    if (!text) return;
    const pop = this.popoverEl;
    pop.empty();
    pop.createDiv({ cls: 'lmp-fn-popover-text', text });
    this.positionPopover(fnEl, 340);
  }

  /** "+" dei riferimenti: elenco dei riferimenti del versetto con il loro testo. */
  async showRefs(plusEl) {
    const d = this.chapterData;
    const v = +plusEl.dataset.v;
    const details = await this.bible.getVerseDetails(d.book, d.chapter, v).catch(() => null);
    const sec = details && details.sections.find((x) => x.title === 'Riferimenti');
    if (!sec || this.chapterData !== d) return;
    let md = sec.body;
    const start = +plusEl.dataset.r || 0;
    if (start) {
      // Gruppo del segno: dal suo primo riferimento fino a quello prima del segno successivo nello stesso versetto.
      const marks = [...new Set([...this.mainEl.querySelectorAll(`.lmp-ref-inline[data-v="${v}"]`)].map((e) => +e.dataset.r))].sort((a, b) => a - b);
      const next = marks.find((n) => n > start) || Infinity;
      const items = md.split('\n').filter((l) => /^\s*-\s/.test(l));
      const group = items.slice(start - 1, next === Infinity ? undefined : next - 1);
      if (group.length) md = group.join('\n');
    }
    const pop = this.popoverEl;
    pop.empty();
    pop.createDiv({ cls: 'lmp-pop-title', text: `Riferimenti · ${d.book.title} ${d.chapter}:${v}` });
    const body = pop.createDiv('lmp-pop-refs');
    const src = details.file ? details.file.path : '';
    body.dataset.sourcePath = src;
    this.renderReferences(body, md, src);
    this.positionPopover(plusEl, 400);
  }

  positionPopover(anchor, maxWidth) {
    const pop = this.popoverEl;
    pop.show();
    const rootRect = this.contentEl.getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    const width = Math.min(maxWidth, rootRect.width - 24);
    pop.style.width = `${width}px`;
    let left = r.left - rootRect.left - width / 2;
    left = Math.max(12, Math.min(left, rootRect.width - width - 12));
    pop.style.left = `${left}px`;
    let top = r.bottom - rootRect.top + 6;
    const h = pop.offsetHeight;
    if (top + h > rootRect.height - 8 && r.top - rootRect.top - h - 6 > 8) top = r.top - rootRect.top - h - 6;
    pop.style.top = `${top}px`;
  }

  hidePopover() {
    if (this.popoverEl) this.popoverEl.hide();
  }

  /* ---------------- pannello di studio ---------------- */

  selectionInfo() {
    const d = this.chapterData;
    const verses = [...this.selected].sort((a, b) => a - b);
    const label = `${d.book.title} ${d.chapter}:${compressVerses(verses)}`;
    const text = verses
      .map((v) => {
        const t = this.bible.verseText(d, v);
        return verses.length > 1 ? `${v} ${t}` : t;
      })
      .join(' ');
    const ref = { book: d.book.num, chapter: d.chapter, verse: verses[0] };
    if (verses.length > 1) ref.verseEnd = verses[verses.length - 1];
    const link = this.bible.formatLink(ref, compressVerses(verses));
    return { verses, label, text, link, ref };
  }

  async renderPane() {
    const token = ++this.paneToken;
    if (!this.paneEl) return;
    const show = this.paneVisible && !this.peek && this.state.mode === 'reader' && (this.primary != null || this.paneStack.length > 0) && !!this.chapterData;
    this.bodyEl.toggleClass('has-pane', show);
    if (!show) this.bodyEl.removeClass('pane-expanded');
    if (this.paneComponent) {
      this.removeChild(this.paneComponent);
      this.paneComponent = null;
    }
    this.paneEl.empty();
    this.paneEl.removeClass('lmp-tabbed');
    if (!show) return;
    const comp = (this.paneComponent = this.addChild(new Component()));
    const top = this.paneStack[this.paneStack.length - 1];
    if (top && top.word) await this.renderPaneWord(top, comp, token);
    else if (top && top.ai) {
      this.paneHeader(top.title, { back: () => this.dropPaneAi(top.ai) });
      this.paneEl.createDiv('lmp-pane-content').appendChild(top.ai);
    } else if (top) await this.renderPaneDoc(top, comp, token);
    else await this.renderPaneVerse(comp, token);
  }

  paneHeader(title, { back, extra } = {}) {
    const handle = this.paneEl.createDiv({ cls: 'lmp-pane-handle', attr: { 'aria-label': 'Ingrandisci o riduci' } });
    handle.createDiv('lmp-pane-handle-bar');
    let startY = null;
    handle.addEventListener('click', () => this.bodyEl.toggleClass('pane-expanded', !this.bodyEl.hasClass('pane-expanded')));
    handle.addEventListener('touchstart', (e) => (startY = e.touches[0].clientY), { passive: true });
    handle.addEventListener('touchend', (e) => {
      if (startY == null) return;
      const dy = e.changedTouches[0].clientY - startY;
      startY = null;
      if (dy > 60) {
        if (this.bodyEl.hasClass('pane-expanded')) this.bodyEl.removeClass('pane-expanded');
        else this.clearSelection();
      } else if (dy < -60) this.bodyEl.addClass('pane-expanded');
    });
    const header = this.paneEl.createDiv('lmp-pane-header');
    const iconBtn = (icon, label, fn) => {
      const b = header.createEl('button', { cls: 'clickable-icon lmp-pane-btn', attr: { 'aria-label': label } });
      setIcon(b, icon);
      b.addEventListener('click', fn);
      return b;
    };
    if (back) iconBtn('arrow-left', 'Indietro', back);
    header.createDiv({ cls: 'lmp-pane-title', text: title });
    if (extra) extra(iconBtn);
    iconBtn('x', 'Chiudi', () => this.clearSelection());
    return header;
  }

  async renderPaneVerse(comp, token) {
    const d = this.chapterData;
    const book = d.book;
    const c = d.chapter;
    const v = this.primary;
    const info = this.selectionInfo();
    const pane = this.paneEl;
    const wantNotes = this.scrollNotesOnRender || !!this.pendingNote;
    this.scrollNotesOnRender = false;

    this.paneHeader(info.label, {
      extra: (iconBtn) => {
        iconBtn('chevron-up', 'Versetto precedente (↑)', () => this.stepVerse(-1));
        iconBtn('chevron-down', 'Versetto successivo (↓)', () => this.stepVerse(1));
      },
    });

    // Azioni
    const actions = pane.createDiv('lmp-actions');
    const colors = actions.createDiv('lmp-colors');
    const current = this.plugin.markColorAt(book.num, c, v);
    for (const h of HIGHLIGHTS) {
      const dot = colors.createEl('button', { cls: `lmp-color-dot hl-${h.id}`, attr: { 'aria-label': `Evidenzia: ${h.label}` } });
      if (current === h.id) dot.addClass('is-active');
      dot.addEventListener('click', () => {
        if (current !== h.id) this.plugin.ui.lastColor = h.id;
        this.setHighlight(current === h.id ? null : h.id);
      });
    }
    const erase = colors.createEl('button', { cls: 'lmp-color-dot lmp-color-erase clickable-icon', attr: { 'aria-label': 'Rimuovi evidenziazione' } });
    setIcon(erase, 'eraser');
    erase.addEventListener('click', () => this.setHighlight(null));

    const tools = actions.createDiv('lmp-tools');
    const tool = (icon, label, fn, active) => {
      const b = tools.createEl('button', { cls: 'clickable-icon lmp-tool', attr: { 'aria-label': label } });
      setIcon(b, icon);
      if (active) b.addClass('is-active');
      b.addEventListener('click', fn);
      return b;
    };
    const bm = this.plugin.findBookmark({ book: book.num, chapter: c, verse: v });
    tool(bm ? 'bookmark-check' : 'bookmark', bm ? 'Rimuovi segnalibro' : 'Aggiungi segnalibro', () => {
      this.plugin.toggleBookmark({ book: book.num, chapter: c, verse: v });
      this.renderPane();
    }, !!bm);
    tool('copy', 'Copia testo', async () => {
      await navigator.clipboard.writeText(`${info.text} (${info.label})`);
      new Notice('Versetto copiato');
    });
    tool('lightbulb', 'Spunti su questi versetti', (evt) => this.bibleAi(evt, [...this.selected]));
    tool('smartphone', 'Apri in JW Library', () => this.plugin.openInJwLibrary(info.ref));
    tool('more-horizontal', 'Altre azioni', (evt) => {
      const menu = new Menu();
      menu.addItem((it) => it.setTitle('Copia link').setIcon('link').onClick(async () => {
        await navigator.clipboard.writeText(info.link);
        new Notice('Link copiato');
      }));
      menu.addItem((it) => it.setTitle('Inserisci nella nota aperta').setIcon('text-cursor-input').onClick(() => this.plugin.insertIntoNote(info)));
      if (this.plugin.scrabb && this.plugin.scrabb.ready)
        menu.addItem((it) => it.setTitle('Collega a una scheda SCRABB…').setIcon('waypoints').onClick(() => this.linkToScrabb(book, c, v)));
      menu.addSeparator();
      menu.addItem((it) => it.setTitle('Apri il file markdown').setIcon('file-text').onClick(() => {
        const f = this.bible.getFile(this.bible.chapterPath(book, c));
        if (f) this.plugin.openFileRaw(f, 'tab');
      }));
      menu.showAtMouseEvent(evt);
    });

    const content = pane.createDiv({ cls: 'lmp-pane-content', text: 'Caricamento…' });
    let details;
    try {
      details = await this.bible.getVerseDetails(book, c, v);
    } catch (e) {
      details = null;
    }
    if (token !== this.paneToken) return;
    content.empty();

    const noteFile = this.bible.getFile(this.plugin.notePath(book, c, v));
    const parsedNote = noteFile ? parseNoteFile(await this.app.vault.cachedRead(noteFile)) : null;
    if (token !== this.paneToken) return;
    await this.renderNotesSection(content, { book, c, v, verseText: this.bible.verseText(d, v), file: noteFile, parsed: parsedNote }, comp);
    window.requestAnimationFrame(() => token === this.paneToken && this.showSelectedNoteLinks());

    const cites = this.plugin.noteIndex.lookup(book.num, c, v).filter((e) => !noteFile || e.path !== noteFile.path);
    this.paneCiteCount = this.plugin.noteIndex.lookup(book.num, c, v).length;
    let citesDone = false;
    const renderMine = () => {
      if (citesDone) return;
      citesDone = true;
      if (cites.length) this.renderCitations(content, cites);
      else if (!this.plugin.noteIndex.ready) content.createDiv({ cls: 'lmp-empty lmp-small', text: 'Indicizzazione delle note in corso…' });
    };

    // Ordine: le tue note, lo studio (approfondimenti, note in calce, riferimenti), dove ne hai scritto, dove è citato, media.
    const sections = details && details.sections.length
      ? details.sections.slice().sort((a, b) => {
          const ia = SECTION_ORDER.indexOf(a.title);
          const ib = SECTION_ORDER.indexOf(b.title);
          return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        })
      : [];
    const src = details && details.file ? details.file.path : '';
    // Bibbia con riferimenti (1987): dopo i riferimenti della Bibbia per lo studio.
    let rbiDone = false;
    const renderRbi = async () => {
      if (rbiDone) return;
      rbiDone = true;
      this.renderRbi8(content, book, c, v, token).catch((e) => console.warn('[lampada] Bibbia con riferimenti', e));
    };
    for (const s of sections) {
      if (token !== this.paneToken) return;
      if (['Media', 'Citato in'].includes(s.title)) await renderRbi();
      if (s.title === 'Citato in' || s.title === 'Media') renderMine();
      const sec = this.section(content, s.title);
      sec.dataset.sourcePath = src;
      if (s.title === 'Approfondimenti') await this.renderStudyNotes(sec, s.body, src, comp, token);
      else if (s.title === 'Riferimenti') this.renderReferences(sec, s.body, src);
      else if (s.title === 'Media') this.renderMedia(sec, s.body, src, comp);
      else if (s.title === 'Citato in') await this.renderCitedIn(sec, s.body, src, comp);
      else await renderMd(this.app, s.body, sec.createDiv('lmp-md'), src, comp);
      this.addSectionCount(sec, s.title);
      if (s.title === 'Riferimenti') await renderRbi();
    }
    if (token !== this.paneToken) return;
    await renderRbi();
    if (token !== this.paneToken) return;
    renderMine();
    this.renderScrabbSection(content, book, c, v);
    if (!sections.length && !(parsedNote && parsedNote.blocks.length) && !cites.length)
      content.createDiv({ cls: 'lmp-empty', text: 'Nessun approfondimento per questo versetto.' });

    this.buildPaneNav(content, wantNotes ? 'Note' : null);
  }

  /** Numero di elementi nell'intestazione delle sezioni di studio (per vedere subito quanto c'è). */
  addSectionCount(body, title) {
    const sel = { Approfondimenti: '.lmp-study-card', Riferimenti: '.lmp-ref', 'Citato in': null, Media: '.lmp-figure', 'Note in calce': 'li, p' }[title];
    const summary = body.parentElement && body.parentElement.querySelector('summary');
    if ((!sel && title !== 'Citato in') || !summary || summary.querySelector('.lmp-badge')) return;
    const n = sel ? body.querySelectorAll(sel).length : [...body.querySelectorAll('.lmp-cite-cat-n')].reduce((t, x) => t + +x.textContent, 0);
    if (n) summary.createSpan({ cls: 'lmp-badge', text: String(n) });
  }

  /**
   * Schede del versetto (come in JW Library): una pillola per sezione, con il numero di elementi;
   * si accendono una o più schede e la scelta resta per i versetti successivi.
   */
  buildPaneNav(content, want) {
    const secs = [...content.querySelectorAll(':scope > .lmp-section')];
    this.paneEl.removeClass('lmp-tabbed');
    if (secs.length < 2) return;
    const nav = createDiv('lmp-pane-nav');
    content.before(nav);
    this.paneEl.addClass('lmp-tabbed');
    const tabs = secs.map((det) => {
      const summary = det.querySelector('summary');
      const title = det.dataset.title || '';
      const chip = nav.createEl('button', { cls: 'lmp-pane-chip' });
      chip.createSpan({ text: paneLabel(title) });
      const n = chip.createSpan({ cls: 'lmp-pane-chip-n' });
      // il numero può arrivare dopo (Bibbia con riferimenti, conteggi): lo si copia quando compare
      const sync = () => n.setText(summary.querySelector('.lmp-badge')?.textContent || '');
      sync();
      new MutationObserver(sync).observe(summary, { childList: true, subtree: true, characterData: true });
      // la sezione resta aperta: niente ▾ da toccare, solo i pulsanti nell'intestazione
      summary.addEventListener('click', (evt) => !evt.target.closest('button') && evt.preventDefault());
      chip.addEventListener('click', () => toggle(title));
      return { det, chip, title };
    });
    // Più schede insieme: ogni pillola si accende o si spegne (almeno una resta accesa); la scelta vale anche per i versetti dopo.
    const ui = this.plugin.ui;
    const saved = () => new Set(ui.paneTabs || (ui.paneTab ? [ui.paneTab] : []));
    const apply = () => {
      const want = saved();
      let on = tabs.filter((t) => want.has(t.title));
      if (!on.length) on = [tabs[0]];
      for (const t of tabs) {
        const yes = on.includes(t);
        t.det.toggleClass('is-current', yes);
        t.chip.toggleClass('is-active', yes);
        t.chip.setAttr('aria-pressed', String(yes));
        if (yes) t.det.open = true;
      }
      this.paneEl.toggleClass('is-multi', on.length > 1);
      this.showSelectedNoteLinks();
    };
    const toggle = (title) => {
      const set = saved();
      const shown = tabs.filter((t) => t.chip.hasClass('is-active')).map((t) => t.title);
      // si parte da ciò che si vede (anche se il versetto non ha tutte le schede salvate)
      for (const t of shown) set.add(t);
      if (set.has(title) && shown.length > 1) set.delete(title);
      else set.add(title);
      ui.paneTabs = [...set];
      this.plugin.requestSave();
      apply();
    };
    const header = this.paneEl.querySelector('.lmp-pane-header');
    nav.style.top = `${header ? header.offsetTop + header.offsetHeight : 0}px`;
    if (this.paneSpy) this.paneEl.removeEventListener('scroll', this.paneSpy);
    this.paneSpy = null;
    if (want && !saved().has(want)) ui.paneTabs = [...saved(), want];
    apply();
  }

  /** Schede SCRABB che citano il versetto, e collegamento rapido del versetto a una scheda. */
  renderScrabbSection(content, book, c, v) {
    const sc = this.plugin.scrabb;
    if (!sc || !sc.ready) return;
    const ents = sc.lookup(book.num, c, v);
    if (!ents.length) return;
    const sec = this.section(content, 'SCRABB', String(ents.length));
    const chips = sec.createDiv('scrabb-chips');
    for (const e of ents) {
      const chip = chips.createSpan({ cls: `scrabb-chip scrabb-t-${e.tipo}`, attr: { 'aria-label': SCRABB_TYPES[e.tipo].label } });
      chip.createSpan('scrabb-dot');
      chip.createSpan({ text: e.name });
      chip.addEventListener('click', () => this.plugin.showInScrabb(e.path));
    }
    const btn = sec.createEl('button', { cls: 'lmp-small-btn', text: '+ Collega a un\'altra scheda' });
    btn.addEventListener('click', () => this.linkToScrabb(book, c, v));
  }

  linkToScrabb(book, c, v) {
    linkVerseToScrabb(this.plugin, this.bible.refLabel({ book: book.num, chapter: c, verse: v }), () => this.renderPane());
  }

  renderCitations(content, cites) {
    const byPath = new Map();
    for (const e of cites) {
      if (!byPath.has(e.path)) byPath.set(e.path, []);
      if (!byPath.get(e.path).some((x) => x.line === e.line)) byPath.get(e.path).push(e);
    }
    const sec = this.section(content, 'Nelle mie note', String(byPath.size));
    const paths = [...byPath.keys()].sort((a, b) => {
      const fa = this.bible.getFile(a);
      const fb = this.bible.getFile(b);
      return (fb ? fb.stat.mtime : 0) - (fa ? fa.stat.mtime : 0);
    });
    const LIMIT = 3;
    let shown = 0;
    const more = [];
    for (const path of paths) {
      const file = this.bible.getFile(path);
      if (!file) continue;
      const box = sec.createDiv('lmp-cite');
      if (++shown > LIMIT) {
        box.hide();
        more.push(box);
      }
      const head = box.createDiv('lmp-cite-head');
      setIcon(head.createSpan('lmp-cite-icon'), 'file-text');
      head.createSpan({ cls: 'lmp-cite-name', text: file.basename });
      const folder = file.parent && file.parent.path !== '/' ? file.parent.path : '';
      if (folder) head.createSpan({ cls: 'lmp-cite-folder', text: folder.split('/').pop() });
      const openAt = (line, evt) => (this.wantSplit() ? this.openInSplit({ file, line }) : this.plugin.openNoteAt(file, line, evt));
      head.addEventListener('click', (evt) => openAt(byPath.get(path)[0].line, evt));
      for (const e of byPath.get(path).slice(0, 6)) {
        const sn = box.createDiv({ cls: 'lmp-cite-snippet', text: e.snippet || '…' });
        sn.addEventListener('click', (evt) => openAt(e.line, evt));
      }
    }
    if (more.length) {
      const b = sec.createEl('button', { cls: 'lmp-small-btn lmp-show-more', text: `Mostra tutte (${shown})` });
      b.addEventListener('click', () => {
        more.forEach((x) => x.show());
        b.remove();
      });
    }
  }

  /** Note del versetto come in JW Library: riquadri con titolo, testo ed etichette; aggiunta e modifica nel pannello. */
  async renderNotesSection(content, ctx, comp) {
    const { file, parsed } = ctx;
    const blocks = parsed ? parsed.blocks : [];
    const sec = this.section(content, 'Note', blocks.length ? String(blocks.length) : '');
    sec.dataset.sourcePath = file ? file.path : '';
    const list = sec.createDiv('lmp-notes');
    for (const blk of blocks) await this.renderNoteCard(list, blk, ctx, comp);
    if (!Platform.isPhone && list.querySelector('.lmp-note-card[data-mid]')) {
      // Pulsante nell'intestazione della sezione: linee di collegamento sempre visibili sì/no
      const summary = sec.parentElement.querySelector('summary');
      const tg = summary.createEl('button', { cls: 'clickable-icon lmp-links-toggle' });
      const paint = () => {
        const on = this.plugin.ui.autoLinks !== false;
        tg.toggleClass('is-active', on);
        tg.setAttr('aria-label', on ? 'Nascondi le linee di collegamento' : 'Mostra le linee di collegamento');
        setIcon(tg, on ? 'spline' : 'unlink');
      };
      paint();
      tg.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        this.plugin.ui.autoLinks = this.plugin.ui.autoLinks === false;
        this.plugin.requestSave();
        paint();
        this.showSelectedNoteLinks();
      });
    }

    const free = parsed ? noteFreeText(parsed.rest) : '';
    if (free) {
      const card = list.createDiv('lmp-note-card lmp-note-free');
      card.createDiv({ cls: 'lmp-note-card-title', text: 'Appunti' });
      await renderMd(this.app, free, card.createDiv('lmp-md'), file.path, comp);
    }

    const actions = sec.createDiv('lmp-note-actions');
    const add = actions.createEl('button', { cls: 'mod-cta lmp-add-note', text: '+ Aggiungi nota' });
    add.addEventListener('click', () => {
      actions.hide();
      this.noteForm(list, { tags: [] }, ctx, () => actions.show());
    });
    if (this.pendingNote) {
      const pending = this.pendingNote;
      this.pendingNote = null;
      actions.hide();
      await this.noteForm(list, { tags: [], title: pending.title, mark: pending.mark }, ctx, () => actions.show());
      sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    if (file) {
      const open = actions.createEl('button', { cls: 'lmp-small-btn', text: 'Apri il file' });
      open.addEventListener('click', () => this.plugin.openNote(ctx.book, ctx.c, ctx.v, ctx.verseText));
    }
  }

  async renderNoteCard(list, blk, ctx, comp) {
    const card = list.createDiv('lmp-note-card');
    const linked = this.chapterData ? this.noteMark(blk, this.chapterData.book, this.chapterData.chapter, ctx.v, this.chapterData) : null;
    if (linked) {
      card.dataset.hl = linked.color;
      card.dataset.mid = linked.id;
      card.addEventListener('mouseenter', () => this.drawNoteConnector(linked.id, card));
      card.addEventListener('mouseleave', () => this.showSelectedNoteLinks());
      // telefono: tocco sul riquadro (non sui pulsanti) mostra solo il suo collegamento per un momento
      card.addEventListener('click', (evt) => {
        if (evt.target instanceof HTMLElement && evt.target.closest('button, a')) return;
        this.clearNoteLinks();
        this.drawNoteConnector(linked.id, card);
        window.clearTimeout(this.linkTimer);
        this.linkTimer = window.setTimeout(() => this.showSelectedNoteLinks(), 2500);
      });
      const quote = this.markText(linked);
      if (quote && quote !== blk.title) card.createDiv({ cls: 'lmp-note-quote', text: `«${quote}»` });
    }
    const head = card.createDiv('lmp-note-card-head');
    head.createDiv({ cls: 'lmp-note-card-title', text: blk.title && blk.title !== 'Nota' ? blk.title : 'Nota' });
    const edit = head.createEl('button', { cls: 'clickable-icon lmp-note-edit', attr: { 'aria-label': 'Modifica' } });
    setIcon(edit, 'pencil');
    if (blk.content) await renderMd(this.app, blk.content, card.createDiv('lmp-md lmp-note-card-body'), ctx.file ? ctx.file.path : '', comp);
    if (blk.tags.length || blk.date) {
      const foot = card.createDiv('lmp-tag-chips');
      for (const t of blk.tags) {
        const chip = foot.createSpan({ cls: 'lmp-tag-chip', text: this.plugin.tagLabel(t) });
        chip.addEventListener('click', () => this.navigate({ mode: 'tag', tag: t }));
      }
      if (blk.date) foot.createSpan({ cls: 'lmp-note-date', text: blk.date.replace(/\*/g, '') });
    }
    edit.addEventListener('click', () => {
      card.hide();
      this.noteForm(list, blk, ctx, () => card.show(), card);
    });
  }

  /** Modulo per scrivere o modificare una nota (titolo, testo, etichette). */
  async noteForm(container, initial, ctx, onCancel, before) {
    await this.plugin.loadTagNames();
    const form = createDiv('lmp-note-form');
    if (before) container.insertBefore(form, before);
    else container.appendChild(form);
    let mark = initial.mark || '';
    // Evidenziazioni del versetto: toccandone una, la nota si collega a quella e ne prende il testo come titolo.
    const d = this.chapterData;
    const marks = d ? this.plugin.marksFor(d.book.num, d.chapter).filter((m) => m.ranges.some((r) => r.v === ctx.v)) : [];
    let pickRow = null;
    if (marks.length) {
      pickRow = form.createDiv('lmp-note-marks');
      pickRow.createSpan({ cls: 'lmp-note-marks-label', text: 'Collega a:' });
    }
    const title = form.createEl('input', { type: 'text', cls: 'lmp-note-title-input', attr: { placeholder: 'Titolo' } });
    title.value = initial.title && initial.title !== 'Nota' ? initial.title : '';
    const drawPicks = () => {
      if (!pickRow) return;
      pickRow.querySelectorAll('.lmp-note-mark-pick').forEach((e) => e.remove());
      for (const m of marks) {
        const text = this.markText(m);
        const pick = pickRow.createSpan({ cls: `lmp-note-mark-pick${m.id === mark ? ' is-active' : ''}`, text: text.length > 60 ? `${text.slice(0, 60)}…` : text });
        pick.dataset.hl = m.color;
        pick.addEventListener('click', () => {
          const prev = marks.find((x) => x.id === mark);
          mark = mark === m.id ? '' : m.id;
          if (mark && (!title.value.trim() || (prev && title.value.trim() === this.markText(prev)))) title.value = text;
          drawPicks();
        });
      }
    };
    drawPicks();
    const body = form.createEl('textarea', { cls: 'lmp-note-body-input', attr: { placeholder: 'Scrivi la nota…', rows: '5' } });
    body.value = initial.content || '';
    const grow = () => {
      body.style.height = 'auto';
      body.style.height = `${Math.min(body.scrollHeight + 2, 420)}px`;
    };
    body.addEventListener('input', grow);

    const tags = [...(initial.tags || [])];
    const tagsRow = form.createDiv('lmp-note-tags');
    const chips = tagsRow.createDiv('lmp-tag-chips');
    const listId = `lmp-tags-${Date.now()}`;
    const tagInput = tagsRow.createEl('input', { type: 'text', cls: 'lmp-note-tag-input', attr: { placeholder: '+ Etichetta', list: listId } });
    const datalist = tagsRow.createEl('datalist', { attr: { id: listId } });
    for (const label of [...new Set(Object.values(this.plugin.tagNames || {}))].sort((a, b) => a.localeCompare(b, 'it'))) datalist.createEl('option', { attr: { value: label } });
    const drawChips = () => {
      chips.empty();
      for (const t of tags) {
        const chip = chips.createSpan({ cls: 'lmp-tag-chip', text: `${this.plugin.tagLabel(t)} ×` });
        chip.addEventListener('click', () => {
          tags.splice(tags.indexOf(t), 1);
          drawChips();
        });
      }
    };
    const addTag = () => {
      const label = tagInput.value.trim();
      if (!label) return;
      const key = jwlTag(label);
      if (key && !tags.includes(key)) {
        tags.push(key);
        if (!this.plugin.tagNames) this.plugin.tagNames = {};
        if (!this.plugin.tagNames[key]) this.plugin.tagNames[key] = label;
      }
      tagInput.value = '';
      drawChips();
    };
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addTag();
      }
    });
    tagInput.addEventListener('change', addTag);
    drawChips();

    const buttons = form.createDiv('lmp-note-form-buttons');
    const cancel = buttons.createEl('button', { text: 'Annulla' });
    const save = buttons.createEl('button', { cls: 'mod-cta', text: 'Salva' });
    cancel.addEventListener('click', () => {
      form.remove();
      onCancel && onCancel();
    });
    save.addEventListener('click', async () => {
      addTag();
      if (!title.value.trim() && !body.value.trim()) {
        new Notice('Scrivi un titolo o un testo');
        return;
      }
      save.disabled = true;
      try {
        await this.plugin.saveJwlNote(ctx, {
          ...initial,
          mark,
          guid: initial.guid || newGuid(),
          title: title.value.trim(),
          content: body.value.replace(/\r\n/g, '\n').trim(),
          tags,
        });
        if (this.chapterData) this.chapterNotes = await this.loadChapterNotes(this.chapterData.book, this.chapterData.chapter);
        this.decorateVerses();
        this.layoutMarginNotes();
        this.renderPane();
      } catch (e) {
        console.error('[lampada] salvataggio della nota non riuscito', e);
        new Notice(`Nota non salvata: ${e.message}`);
        save.disabled = false;
      }
    });
    (initial.guid ? body : title).focus();
    grow();
  }

  /** Sezione "Bibbia con riferimenti" del versetto (vedi renderRbi8Verse). */
  renderRbi8(content, book, c, v, token) {
    const sec = this.section(content, 'Bibbia con riferimenti');
    return renderRbi8Verse(this.plugin, sec, { book: book.num, chapter: c, verse: v }, {
      alive: () => token === this.paneToken && sec.isConnected,
      onRef: (link, ref) => this.showRefPopover(link, ref),
      refresh: () => this.renderPane(),
    });
  }

  section(parent, title, badge) {
    // Al suo posto secondo l'ordine scelto (anche le sezioni che arrivano dopo); quelle fuori elenco in fondo.
    const order = paneOrder(this.plugin.settings);
    const rank = (t) => (order.includes(t) ? order.indexOf(t) : 99);
    const det = createEl('details', { cls: 'lmp-section', attr: { 'data-title': title } });
    const next = rank(title) < 99 && [...parent.children].find((e) => e.matches('.lmp-section') && rank(e.dataset.title) > rank(title));
    if (next) parent.insertBefore(det, next);
    else parent.appendChild(det);
    const collapsed = this.plugin.ui.collapsed || {};
    det.open = !collapsed[title];
    const summary = det.createEl('summary', { text: paneLabel(title) });
    if (badge) summary.createSpan({ cls: 'lmp-badge', text: badge });
    det.addEventListener('toggle', () => {
      this.plugin.ui.collapsed = { ...(this.plugin.ui.collapsed || {}), [title]: !det.open };
      this.plugin.requestSave();
    });
    const body = det.createDiv('lmp-section-body');
    return body;
  }

  async renderStudyNotes(el, md, sourcePath, comp, token) {
    const re = /!\[\[([^\]#|]+)#\^([^\]|]+)(?:\|[^\]]*)?\]\]/g;
    const embeds = [];
    let m;
    while ((m = re.exec(md))) embeds.push({ link: m[1], id: m[2] });
    if (!embeds.length) {
      await renderMd(this.app, md, el, sourcePath, comp);
      return;
    }
    const cards = embeds.map(() => el.createDiv('lmp-study-card'));
    const results = await Promise.all(embeds.map((e) => this.bible.getBlock(e.link, e.id, sourcePath).catch(() => null)));
    if (token !== this.paneToken) return;
    const docs = new Map();
    for (let i = 0; i < embeds.length; i++) {
      const r = results[i];
      const card = cards[i];
      if (!r) {
        card.remove();
        continue;
      }
      card.dataset.sourcePath = r.file.path;
      docs.set(r.file.path, { file: r.file, id: embeds[i].id });
      await renderMd(this.app, r.md, card, r.file.path, comp);
    }
    // Approfondimenti lunghi: si vedono le prime righe, il resto con "Leggi tutto".
    window.requestAnimationFrame(() => {
      for (const card of cards) {
        if (!card.isConnected || card.scrollHeight < 300) continue;
        card.addClass('is-clamped');
        const more = card.createEl('button', { cls: 'lmp-card-more', text: 'Leggi tutto' });
        const open = (evt) => {
          if (evt && evt.target instanceof HTMLElement && evt.target.closest('a')) return;
          card.removeClass('is-clamped');
          more.remove();
          card.removeEventListener('click', open);
        };
        card.addEventListener('click', open);
      }
    });
    for (const { file, id } of docs.values()) {
      const title = fileMeta(this.app, file)?.frontmatter?.title || file.basename;
      const a = el.createEl('button', { cls: 'lmp-small-btn', text: `Apri: ${title}` });
      a.addEventListener('click', () => this.plugin.openFileRaw(file, 'tab', `#^${id}`));
    }
  }

  /** "Citato in" raggruppato per pubblicazione (Glossario, Bibbia per lo studio, Perspicacia, Torre di Guardia…). */
  /**
   * "Citato in" diviso per tipo di pubblicazione (Torre di Guardia, Libri, Video…), come la biblioteca.
   * Ogni gruppo si apre e si chiude (e se lo ricorda); i periodici dal numero più recente.
   */
  renderCitedIn(el, md, sourcePath, comp) {
    return renderCitedIn(this.plugin, el, md, sourcePath, comp);
  }

  renderReferences(el, md, sourcePath) {
    for (const l of parseRefLinks(md)) {
      const item = el.createDiv('lmp-ref');
      item.createDiv({ cls: 'lmp-ref-label', text: l.label });
      const txt = item.createDiv({ cls: 'lmp-ref-text', text: '…' });
      let target = null;
      (l.ref ? this.bible.previewRef(l.ref, l.label) : this.bible.refPreview(l.link, l.label, sourcePath))
        .then((r) => {
          if (!r) {
            txt.setText('');
            return;
          }
          target = r.ref;
          txt.setText(r.text);
        })
        .catch(() => txt.setText(''));
      item.addEventListener('click', (evt) => {
        if (target && !(evt.metaKey || evt.ctrlKey)) {
          if (this.wantSplit()) this.openInSplit({ ref: target });
          else this.navigate(target);
        } else if (l.ref) this.plugin.openInJwLibrary(l.ref);
        else this.openLink(l.link, sourcePath, evt);
      });
    }
  }

  renderMedia(el, md, sourcePath, comp) {
    const lines = md.split('\n');
    const grid = el.createDiv('lmp-media');
    let fallback = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*$/.exec(lines[i].trim());
      if (!m) {
        if (lines[i].trim() && !/^\*.*\*$/.test(lines[i].trim())) fallback.push(lines[i]);
        continue;
      }
      const file = this.bible.resolveLink(m[1], sourcePath);
      let caption = '';
      const next = (lines[i + 1] || '').trim();
      if (/^\*.+\*$/.test(next)) {
        caption = next.slice(1, -1).trim();
        i++;
      }
      if (!file || !/^(png|jpe?g|gif|webp|svg|avif)$/i.test(file.extension)) {
        fallback.push(lines[i]);
        continue;
      }
      const fig = grid.createEl('figure', { cls: 'lmp-figure' });
      const img = fig.createEl('img', { attr: { src: fileSrc(this.app, file), loading: 'lazy', alt: caption } });
      img.addEventListener('click', () => this.plugin.openFileRaw(file, 'tab'));
      if (caption) fig.createEl('figcaption', { text: caption });
    }
    if (fallback.length) renderMd(this.app, fallback.join('\n'), el.createDiv('lmp-md'), sourcePath, comp);
  }

  /* ---------------- racconti paralleli ---------------- */

  isGospel() {
    return this.state.mode === 'reader' && GOSPELS.includes(this.state.book);
  }

  toggleParallels() {
    this.plugin.ui.parallels = !this.plugin.ui.parallels;
    this.plugin.requestSave();
    this.decorateParallels();
    this.updateToolbar();
  }

  /** Nei Vangeli: sopra il primo versetto di ogni avvenimento, il titolo e gli altri Vangeli che lo raccontano. */
  async decorateParallels() {
    const d = this.chapterData;
    if (!d || !this.mainEl) return;
    this.mainEl.querySelectorAll('.lmp-par-mark').forEach((e) => e.remove());
    if (!this.plugin.ui.parallels || !GOSPELS.includes(d.book.num)) return;
    let byVerse;
    try {
      byVerse = await parallelsInChapter(this.plugin, d.book.num, d.chapter);
    } catch (e) {
      console.warn('[lampada] racconti paralleli', e);
      return;
    }
    if (this.chapterData !== d || !this.plugin.ui.parallels) return;
    this.mainEl.querySelectorAll('.lmp-par-mark').forEach((e) => e.remove());
    const abbr = (b) => (this.bible.byNum.get(b) || {}).abbr || '';
    for (const [v, events] of byVerse) {
      const first = this.mainEl.querySelector(`.lmp-verse[data-v="${v}"]`);
      if (!first) continue;
      for (const ev of events) {
        const mark = createSpan({ cls: 'lmp-par-mark', attr: { 'aria-label': 'Confronta i racconti paralleli' } });
        setIcon(mark.createSpan('lmp-par-icon'), 'columns-3');
        mark.createSpan({ cls: 'lmp-par-title', text: ev.title });
        const others = GOSPELS.filter((b, i) => b !== d.book.num && ev.refs[i].length).map(abbr);
        mark.createSpan({ cls: 'lmp-par-books', text: others.join(' · ') });
        mark.addEventListener('click', (evt) => {
          evt.stopPropagation();
          new ParallelModal(this.plugin, ev, d.book.num).open();
        });
        first.before(mark);
      }
    }
  }

  /* ---------------- spunti con l'AI ---------------- */

  /** Spunti su alcuni versetti (senza versetti: sul capitolo intero), nel pannello di studio. */
  bibleAi(evt, verses, focus) {
    const d = this.chapterData;
    if (!d) return;
    const bible = this.bible;
    const ref = { book: d.book.num, chapter: d.chapter };
    const vs = verses && verses.length ? [...new Set(verses)].sort((a, b) => a - b) : null;
    const title = vs ? bible.refLabel(ref, compressVerses(vs)) : bible.refLabel(ref);
    aiMenu(this.plugin, evt, (preset) =>
      showAiSuggestions(this.plugin, preset, () => this.bibleAiCtx(d, vs, title, focus), {
        place: (box) => {
          this.paneStack.push({ ai: box, title: `Spunti · ${title}` });
          this.peek = false;
          this.paneVisible = true;
          this.renderPane();
          this.updateToolbar();
        },
        onSource: (t) => this.openAiSource(t),
        onClose: (box) => this.dropPaneAi(box),
      })
    );
  }

  /**
   * Al modello vanno il capitolo intero, le tue note che citano i versetti scelti e, per ognuno, note di studio, note in
   * calce, tutti i "Citato in" e i riferimenti a margine.
   * ponytail: tetto di 400.000 caratteri (~100k token); oltre cadono prima i riferimenti a margine, poi i "Citato in".
   */
  bibleAiCtx(d, vs, title, focus) {
    return verseAiCtx(this.plugin, d, vs, title, focus);
  }

  dropPaneAi(box) {
    const i = this.paneStack.findIndex((x) => x.ai === box);
    if (i < 0) return;
    this.paneStack.splice(i, 1);
    this.renderPane();
  }

  /** Fonte di uno spunto: un versetto del capitolo si mostra nel testo, gli altri si aprono; una pubblicazione nel pannello. */
  openAiSource(t) {
    if (!t) return;
    const d = this.chapterData;
    if (t.verse && d && t.verse.book === d.book.num && t.verse.chapter === d.chapter) return this.scrollToVerse(t.verse.verse, true);
    if (t.verse) return this.navigate(t.verse);
    const note = t.note && this.bible.getFile(t.note);
    if (note) return this.plugin.openNoteAt(note, t.line);
    if (t.cite) this.openLink(t.par ? `${t.cite}#^p${t.par}` : t.cite, '');
  }

  /* ---------------- studio di una parola ---------------- */

  studyWord() {
    const info = this.selInfo;
    if (!info) return;
    const word = info.text.replace(/\s+/g, ' ').trim().slice(0, 60);
    const v = info.ranges[0].v;
    window.getSelection().removeAllRanges();
    this.hideSelectionBar();
    if (!word) return;
    this.peek = false;
    this.paneVisible = true;
    this.selectVerses([v], v);
    this.paneStack.push({ word });
    this.renderPane();
    this.updateToolbar();
  }

  /** Una parola: Glossario, note di studio che la spiegano, Perspicacia, dove ricorre nella Bibbia. */
  async renderPaneWord(entry, comp, token) {
    this.paneHeader(`«${entry.word}»`, {
      back: () => {
        this.paneStack.pop();
        this.renderPane();
      },
    });
    const content = this.paneEl.createDiv({ cls: 'lmp-pane-content lmp-word', text: 'Cerco la parola…' });
    let res;
    try {
      res = await wordStudy(this.plugin, entry.word);
    } catch (e) {
      console.warn('[lampada] studio della parola', e);
    }
    if (token !== this.paneToken) return;
    content.empty();
    if (!res) {
      content.createDiv({ cls: 'lmp-empty', text: 'Seleziona una parola del versetto.' });
      return;
    }
    const { key } = res;

    const glossSec = res.glossario.length ? this.section(content, 'Glossario', String(res.glossario.length)) : null;
    for (const g of res.glossario) {
      const sec = glossSec;
      const body = stripFrontmatter(await readFile(this.app, g.file)).replace(/^#\s+.*$/m, '').trim();
      if (token !== this.paneToken) return;
      const card = sec.createDiv('lmp-study-card');
      card.dataset.sourcePath = g.file.path;
      card.createDiv({ cls: 'lmp-word-card-title', text: g.title });
      await renderMd(this.app, body, card.createDiv(), g.file.path, comp);
    }

    if (res.notes.length) {
      const sec = this.section(content, 'Note di studio', String(res.notes.length));
      for (const n of res.notes.slice(0, 80)) {
        const item = sec.createDiv('lmp-word-note');
        const head = item.createDiv('lmp-word-note-head');
        head.createSpan({ cls: 'lmp-ref-label', text: this.bible.refLabel(n.ref) });
        this.appendHighlighted(head.createSpan('lmp-word-note-term'), key, n.head);
        let open = false;
        head.addEventListener('click', async () => {
          open = !open;
          item.toggleClass('is-open', open);
          if (!open || item.querySelector('.lmp-study-card')) return;
          const r = await this.bible.getBlock(n.file.basename, n.id, n.file.path).catch(() => null);
          if (!r) return;
          const card = item.createDiv('lmp-study-card');
          card.dataset.sourcePath = r.file.path;
          await renderMd(this.app, r.md, card, r.file.path, comp);
          const go = item.createEl('button', { cls: 'lmp-small-btn', text: `Vai a ${this.bible.refLabel(n.ref)}` });
          go.addEventListener('click', () => this.navigate(n.ref));
        });
      }
      if (res.notes.length > 80) sec.createDiv({ cls: 'lmp-empty lmp-small', text: `…e altre ${res.notes.length - 80}` });
    }

    if (res.perspicacia.length) {
      const sec = this.section(content, 'Perspicacia', String(res.perspicacia.length));
      const chips = sec.createDiv('lmp-word-chips');
      for (const p of res.perspicacia) {
        const chip = chips.createEl('button', { cls: 'lmp-word-chip', text: p.title });
        chip.addEventListener('click', () => this.plugin.openPerspicacia({ perspicacia: p.file.basename, path: p.file.path }));
      }
    }

    // Concordanza: tutti i versetti con la parola (o una parola con la stessa radice), libro per libro.
    const sec = this.section(content, 'Nella Bibbia');
    const status = sec.createDiv({ cls: 'lmp-empty lmp-small', text: 'Cerco nei versetti…' });
    const index = await this.bible.getSearchIndex((done, total) => status.setText(`Cerco nei versetti… ${Math.round((done / total) * 100)}%`)).catch(() => null);
    if (token !== this.paneToken) return;
    const hits = (index || []).filter((e) => {
      key.re.lastIndex = 0;
      return key.re.test(e.n.replace(/[’‘`]/g, "'"));
    });
    status.setText(hits.length ? `${hits.length} versetti` : 'Nessun versetto con questa parola.');
    const summary = sec.parentElement && sec.parentElement.querySelector('summary');
    if (summary && hits.length) summary.createSpan({ cls: 'lmp-badge', text: String(hits.length) });
    const byBook = new Map();
    for (const h of hits) {
      if (!byBook.has(h.book)) byBook.set(h.book, []);
      byBook.get(h.book).push(h);
    }
    for (const [b, list] of byBook) {
      const det = sec.createEl('details', { cls: 'lmp-word-book' });
      const sum = det.createEl('summary', { text: this.bible.byNum.get(b)?.title || String(b) });
      sum.createSpan({ cls: 'lmp-badge', text: String(list.length) });
      det.addEventListener('toggle', () => {
        if (!det.open || det.dataset.done) return;
        det.dataset.done = '1';
        for (const h of list) {
          const row = det.createDiv('lmp-word-verse');
          row.createSpan({ cls: 'lmp-ref-label', text: `${h.chapter}:${h.verse}` });
          this.appendHighlighted(row.createSpan(), key, h.text);
          row.addEventListener('click', () => this.navigate({ book: h.book, chapter: h.chapter, verse: h.verse }));
        }
      });
    }
  }

  appendHighlighted(el, key, text) {
    for (const part of highlightParts(key, text)) {
      if (part.hit) el.createEl('mark', { cls: 'lmp-word-hit', text: part.s });
      else el.appendText(part.s);
    }
  }

  async renderPaneDoc(entry, comp, token) {
    const { file, subpath } = entry;
    if (file.disk) await readFile(this.app, file);
    const title = fileMeta(this.app, file)?.frontmatter?.title || file.basename;
    this.paneHeader(title, {
      back: () => {
        this.paneStack.pop();
        this.renderPane();
      },
      extra: (iconBtn) => iconBtn('external-link', 'Apri in una scheda', () => this.plugin.openFileRaw(file, 'tab', subpath)),
    });
    const content = this.paneEl.createDiv({ cls: 'lmp-pane-content lmp-doc', text: 'Caricamento…' });
    content.dataset.sourcePath = file.path;
    const text = await this.bible.readDoc(file);
    if (token !== this.paneToken) return;
    content.empty();
    const blockId = subpath && subpath.startsWith('#^') ? subpath.slice(2) : null;
    if (blockId) {
      const md = extractBlock(text, blockId);
      if (md != null) {
        await renderMd(this.app, md, content.createDiv('lmp-study-card'), file.path, comp);
        const full = content.createEl('button', { cls: 'lmp-small-btn', text: 'Mostra documento intero' });
        full.addEventListener('click', () => {
          this.paneStack[this.paneStack.length - 1] = { file, subpath: '' };
          this.renderPane();
        });
        return;
      }
    }
    if (text.length > 250000) {
      content.createDiv({ cls: 'lmp-empty', text: 'Documento molto lungo: aprilo in una scheda.' });
      const b = content.createEl('button', { cls: 'lmp-small-btn', text: 'Apri in una scheda' });
      b.addEventListener('click', () => this.plugin.openFileRaw(file, 'tab', subpath));
      return;
    }
    const body = stripFrontmatter(text).replace(/<!--[\s\S]*?-->/g, '');
    await renderMd(this.app, body, content.createDiv('lmp-md'), file.path, comp);
  }

  /* ---------------- link nel pannello ---------------- */

  sourcePathFor(el) {
    const holder = el.closest('[data-source-path]');
    return holder ? holder.dataset.sourcePath : this.chapterData?.file.path || '';
  }

  onLinkClick(evt) {
    const target = evt.target;
    if (!(target instanceof HTMLElement)) return;
    if (!target.closest('a')) this.hidePopover();
    const jw = target.closest('a[href^="jwlibrary:"]');
    if (jw) {
      evt.preventDefault();
      evt.stopPropagation();
      const codes = codesFromJwUrl(jw.getAttribute('href'));
      if (!codes) return;
      const ref = refFromCodes(codes[0], codes[1]);
      if (evt.metaKey || evt.ctrlKey) this.plugin.openInJwLibrary(ref);
      else this.showRefPopover(jw, ref);
      return;
    }
    const a = target.closest('a.internal-link');
    if (!a) return;
    evt.preventDefault();
    evt.stopPropagation();
    const href = a.dataset.href || a.getAttribute('href');
    if (!href) return;
    const src = this.sourcePathFor(a);
    if (evt.metaKey || evt.ctrlKey) return this.openLink(href, src, evt);
    this.showCitePopover(a, href, src).then((ok) => ok || this.openLink(href, src, evt, a));
  }

  /**
   * Clic su una pubblicazione citata ("Citato in", ¶N): il paragrafo in un popup, con "Apri" per entrare nel documento.
   * Sul titolo mostra tutti i ¶ della stessa riga. false = non è un documento della biblioteca, si apre come prima.
   */
  async showCitePopover(a, linktext, sourcePath) {
    const file = this.bible.resolveLink(linktext, sourcePath);
    if (!file || file.extension !== 'md' || this.bible.refFromFile(file)) return false;
    const lib = this.plugin.library;
    // Biblioteca non ancora caricata: il link si apre subito come prima, il popup sarà pronto dal clic successivo.
    if (!lib.byFile || !lib.byFile.size) {
      lib.ensureLoaded().catch(() => null);
      return false;
    }
    const d = lib.byFile.get(file.basename);
    if (!d) return false;
    const parOf = (s) => +((/#\^p(\d+)$/.exec(s || '') || [])[1] || 0);
    let pars = [parOf(linktext)].filter(Boolean);
    if (!pars.length && a.closest('li')) {
      pars = [...a.closest('li').querySelectorAll('a.internal-link')].map((x) => parOf(x.dataset.href || x.getAttribute('href'))).filter(Boolean);
    }
    if (!pars.length) return false;
    const token = (this.citePopToken = (this.citePopToken || 0) + 1);
    const MAX = 5;
    const texts = await Promise.all(pars.slice(0, MAX).map((p) => lib.paragraphText(d, p).catch(() => '')));
    if (token !== this.citePopToken) return true;
    const open = (par) => {
      this.hidePopover();
      if (this.wantSplit()) this.openInSplit({ doc: d, par });
      else this.plugin.openLibraryDoc(d, par);
    };
    const pop = this.popoverEl;
    pop.empty();
    pop.createDiv({ cls: 'lmp-pop-title', text: d.pub.title });
    pop.createDiv({ cls: 'lmp-cite-pop-doc', text: d.title });
    pars.slice(0, MAX).forEach((p, i) => {
      const b = pop.createDiv({ cls: 'lmp-cite-pop-par', attr: { role: 'button', tabindex: '0', 'aria-label': `Apri al paragrafo ${p}` } });
      b.createSpan({ cls: 'lmp-cite-pop-n', text: `¶${p} ` });
      b.appendText(texts[i] || 'Testo del paragrafo non trovato.');
      b.addEventListener('click', () => open(p));
      b.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open(p)));
    });
    if (pars.length > MAX) pop.createDiv({ cls: 'lmp-cite-pop-more', text: `e altri ${pars.length - MAX} paragrafi` });
    const bar = pop.createDiv('lmp-cite-pop-actions');
    const btn = bar.createEl('button', { cls: 'mod-cta', text: 'Apri la pubblicazione' });
    btn.addEventListener('click', () => open(pars[0]));
    this.positionPopover(a, 440);
    return true;
  }

  /**
   * Riferimento toccato nel testo di studio: il versetto in un riquadrino, senza cambiare pagina.
   * "Apri" lo apre qui (← per tornare), "A lato" nel riquadro accanto (non sul telefono).
   */
  async showRefPopover(anchor, ref) {
    const token = (this.citePopToken = (this.citePopToken || 0) + 1);
    const data = await this.bible.getChapter(ref.book, ref.chapter).catch(() => null);
    if (token !== this.citePopToken) return;
    const first = ref.verse || 1;
    const last = ref.verse ? Math.max(first, ref.verseEnd || first) : Math.min(data ? data.verseCount : 1, 3);
    const parts = [];
    for (let v = first; data && v <= last; v++) {
      const t = this.bible.verseText(data, v);
      if (t) parts.push(last > first ? `${v} ${t}` : t);
    }
    const open = (side) => {
      this.hidePopover();
      if (side) this.openInSplit({ ref });
      else this.navigate(ref);
    };
    const pop = this.popoverEl;
    pop.empty();
    pop.createDiv({ cls: 'lmp-pop-title', text: this.bible.refLabel(ref) });
    const txt = parts.join(' ');
    pop.createDiv({ cls: 'lmp-ref-pop-text', text: txt ? txt + (ref.verse ? '' : ' …') : 'Testo non trovato.' });
    const bar = pop.createDiv('lmp-cite-pop-actions');
    if (!Platform.isPhone) bar.createEl('button', { text: 'A lato' }).addEventListener('click', () => open(true));
    bar.createEl('button', { cls: 'mod-cta', text: 'Apri' }).addEventListener('click', () => open(false));
    this.positionPopover(anchor, 420);
  }

  onLinkHover(evt) {
    const target = evt.target;
    if (!(target instanceof HTMLElement)) return;
    const a = target.closest('a.internal-link');
    if (!a) return;
    this.app.workspace.trigger('hover-link', {
      event: evt,
      source: VIEW_TYPE,
      hoverParent: this,
      targetEl: a,
      linktext: a.dataset.href || a.getAttribute('href'),
      sourcePath: this.sourcePathFor(a),
    });
  }

  /** anchor: il link toccato; se è un versetto se ne mostra prima l'anteprima. */
  openLink(linktext, sourcePath, evt, anchor) {
    const file = this.bible.resolveLink(linktext, sourcePath);
    if (!file) {
      const ref = this.bible.refFromLinkpath(linktext);
      if (ref && ref.chapter) {
        if (anchor) this.showRefPopover(anchor, ref);
        else if (this.wantSplit()) this.openInSplit({ ref });
        else this.navigate(ref);
        return;
      }
      new Notice(`Collegamento non trovato: ${linktext}`);
      return;
    }
    const hash = linktext.indexOf('#');
    const subpath = hash >= 0 ? linktext.slice(hash) : '';
    if (evt && (evt.metaKey || evt.ctrlKey)) {
      this.plugin.openFileRaw(file, 'tab', subpath);
      return;
    }
    const ref = this.bible.refFromFile(file);
    if (ref) {
      if (anchor && ref.chapter) this.showRefPopover(anchor, ref);
      else if (this.wantSplit()) this.openInSplit({ ref });
      else this.navigate(ref);
      return;
    }
    if (file.extension !== 'md') {
      this.plugin.openFileRaw(file, 'tab', subpath);
      return;
    }
    if (this.wantSplit()) {
      this.openFileInSplit(file, subpath);
      return;
    }
    this.paneStack.push({ file, subpath });
    this.renderPane();
  }

  /** Colori del pannello: evidenziano (o cancellano) i versetti selezionati per intero. */
  async setHighlight(color) {
    const d = this.chapterData;
    if (!d) return;
    const ranges = [...this.selected].sort((a, b) => a - b).map((v) => ({ v, s: 0, e: -1 }));
    this.plugin.cutMarks(d.book.num, d.chapter, ranges);
    if (color) this.plugin.addMark(d.book.num, d.chapter, color, ranges);
    this.decorateVerses();
    this.renderPane();
  }
}

export { BibleView };
