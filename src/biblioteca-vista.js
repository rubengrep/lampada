import { ItemView, Component, Menu, Modal, Notice, setIcon, debounce, Platform } from 'obsidian';
import { LIB_VIEW_TYPE, findDocLabel, isoDate, issueLabel, mondayOf, weekLabel } from './biblioteca-dati.js';
import { BIBLE_LANGS, epubInfo, renderBibleDownload } from './bibbia-epub.js';
import { EpubImportModal } from './biblioteca-epub.js';
import { HIGHLIGHTS, paneLabel, pubLang } from './costanti.js';
import { compare, lang, t } from './lingua.js';
import { fileAt, fileMeta, fileSrc, linkDest, readFile, renderMd } from './file.js';
import { SCRABB_TYPES } from './scrabb-dati.js';
import { ScrabbNewModal, ScrabbPickModal, linkVerseToScrabb } from './scrabb-vista.js';
import { codesFromJwUrl, norm, noteFreeText, parseCode, parseNoteFile, parseRefLinks, refFromCodes, splitJwTokens, stripFrontmatter } from './testo.js';
import { Pager, ReadingModal, pageKey, placeSelBar, showDefinition } from './lettura.js';
import { SourceList, addScriptureSources, aiMenu, renderAskBox, renderRbi8Verse, showAiSuggestions, verseAiCtx } from './studio.js';
import { CitePreviewModal, PlacesModal, addGoToAction, addViewSwitch, autoHideBars, citedPars, hasBibleIn, hasInLang, paneResizer, pubLangButton, renderCitedIn, renderNoteCites, setBarsHidden, viewKeys } from './ui.js';

const blockText = (b) => b.innerText.replace(/\s+/g, ' ').trim();
/** Domanda stampata: "4. …", "5, 6. …". */
const isQuestionBlock = (b) => /^\d+(\s*[-–,]\s*\d+)*\.\s/.test(blockText(b));
const isLabelBlock = (b) => /^(la tua risposta|le tue risposte|your answers?)$/i.test(blockText(b));

class LibraryView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.lib = plugin.library;
    this.state = { mode: 'home' };
    this.history = [];
    this.renderToken = 0;
    this.comp = null;
  }

  getViewType() {
    return LIB_VIEW_TYPE;
  }

  getIcon() {
    return 'library-big';
  }

  getDisplayText() {
    const s = this.state;
    const pub = s.sym && this.lib.bySym.get(s.sym);
    if (s.mode === 'doc' && s.doc) return this.lib.byDocId.get(s.doc)?.title || t('Biblioteca');
    if (s.mode === 'week') return t('Adunanze della settimana');
    if (s.mode === 'ext') return s.title || t('Biblioteca');
    if (s.mode === 'cat') return t((this.lib.categories().find((c) => c.id === s.cat) || {}).label || 'Biblioteca');
    if (s.mode === 'issue' && pub) return `${pub.title.replace(/\s*\(\d{4}\)$/, '')} · ${issueLabel(s.issue)}`;
    if (pub) return pub.title;
    return t('Biblioteca');
  }

  /** Titolo nella barra: niente nella home (lo dice il selettore), il percorso dentro una pubblicazione. */
  toolbarTitle() {
    const s = this.state;
    if (s.mode === 'home' || !s.mode) return '';
    const d = s.mode === 'doc' && s.doc && this.lib.byDocId.get(s.doc);
    if (d && d.pub) {
      const pub = d.pub.title.replace(/\s*\(\d{4}\)$/, '');
      return `${pub}${d.issue && d.issue !== 'altro' ? ` ${issueLabel(d.issue)}` : ''} › ${d.title}`;
    }
    return this.getDisplayText();
  }

  getState() {
    return { ...this.state };
  }

  async setState(state, result) {
    await super.setState(state, result);
    if (state && state.mode) await this.navigate(state, { push: false });
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('lmp-lib');
    // Telefono e tablet: un tocco che si sposta di poco (es. su un libro della colonna di sinistra) Obsidian lo prendeva per
    // uno swipe e apriva la sua barra laterale. Qui i gesti orizzontali sono di Lampada (capitolo, pagina): Obsidian li salta.
    root.dataset.ignoreSwipe = 'true';
    this.plugin.applyFont(root);
    this.toolbarEl = root.createDiv('lmp-toolbar');
    this.bodyEl = root.createDiv('lmp-body');
    this.mainEl = this.bodyEl.createDiv('lmp-lib-main lmp-main');
    this.paneEl = this.bodyEl.createDiv('lmp-pane lmp-lib-pane');
    paneResizer(this);
    this.pager = new Pager(this, this.mainEl, this.bodyEl, {
      content: () => (this.state.mode === 'doc' ? this.docWrap : null),
      label: () => (this.lib.byDocId.get(this.state.doc) || {}).title || '',
      edge: (d) => this.stepDoc(d),
      settle: () => this.savePlace(),
      anchor: () => (this.panePar != null && this.docWrap ? this.docBlock(this.panePar) : null),
    });
    const ro = new ResizeObserver(() => {
      this.bodyEl.toggleClass('is-narrow', this.bodyEl.clientWidth < 760);
      this.layoutDocNoteSquares();
    });
    ro.observe(this.bodyEl);
    this.register(() => ro.disconnect());
    viewKeys(this, [
      ['Escape', () => (this.paneMode ? (this.closeLibPane(), false) : true)],
      ['ArrowLeft', () => pageKey(this.pager, -1)],
      ['ArrowRight', () => pageKey(this.pager, 1)],
    ]);
    const btn = (icon, label, fn) => {
      const b = this.toolbarEl.createEl('button', { cls: 'lmp-tb-btn clickable-icon', attr: { 'aria-label': label } });
      setIcon(b, icon);
      b.addEventListener('click', fn);
      return b;
    };
    this.backBtn = btn('arrow-left', t('Indietro'), () => this.goBack());
    addViewSwitch(this.toolbarEl, this.plugin, 'lib', () => this.navigate({ mode: 'home' }), this.inShell);
    this.titleEl2 = this.toolbarEl.createDiv('lmp-tb-title lmp-lib-title');
    this.toolbarEl.createDiv('lmp-tb-spacer');
    this.prevBtn = btn('chevron-left', t('Documento precedente'), () => this.stepDoc(-1));
    this.nextBtn = btn('chevron-right', t('Documento successivo'), () => this.stepDoc(1));
    btn('search', t('Cerca ovunque'), () => this.plugin.openSearch());
    btn('history', t('Aperti di recente'), () => new PlacesModal(this.plugin, null, 'recent').open());
    btn('bookmark', t('Segnalibri'), () => new PlacesModal(this.plugin, this.herePlace(), 'bookmarks').open());
    btn('type', t('Aspetto del testo'), () => new ReadingModal(this.plugin).open());
    if (Platform.isPhone && this.addAction && !this.inShell) {
      this.addAction('type', t('Aspetto del testo'), () => new ReadingModal(this.plugin).open());
      this.addAction('chevron-right', t('Documento successivo'), () => this.stepDoc(1));
      this.addAction('chevron-left', t('Documento precedente'), () => this.stepDoc(-1));
      this.addAction('bookmark', t('Segnalibri'), () => new PlacesModal(this.plugin, this.herePlace(), 'bookmarks').open());
      this.addAction('history', t('Aperti di recente'), () => new PlacesModal(this.plugin, null, 'recent').open());
      this.addAction('search', t('Cerca ovunque'), () => this.plugin.openSearch());
      addGoToAction(this, 'lib', () => this.navigate({ mode: 'home' }));
      root.addClass('lmp-native-header');
    }
    this.registerDomEvent(this.mainEl, 'click', (evt) => this.onLinkClick(evt), { capture: true });
    this.buildSelectionBar();
    this.registerDomEvent(document, 'selectionchange', debounce(() => this.onSelectionChange(), 200, true));
    this.registerDomEvent(this.mainEl, 'scroll', () => this.hideSelectionBar());
    autoHideBars(this, this.mainEl);
    this.registerEvent(this.app.workspace.on('lampada:scrabb-changed', () => {
      this.layoutDocNoteSquares();
      if (this.paneMode === 'par') this.renderLibPane();
    }));
    if (!this.renderToken) await this.navigate(this.plugin.ui.libLast || { mode: 'home' }, { push: false });
  }

  async onClose() {
    setBarsHidden(this, false);
    this.contentEl.empty();
  }

  applyTypography() {
    this.plugin.applyFont(this.contentEl);
    if (this.pager) this.pager.layout();
  }

  /** Documento aperto senza un paragrafo preciso: dove si era arrivati a leggere (anche su un altro dispositivo). */
  async resumeDoc(token) {
    const pos = (await this.plugin.readPositions().catch(() => ({ docs: {} }))).docs[this.state.doc];
    const block = pos && pos.par > 1 && token === this.renderToken && this.docBlock(+pos.par);
    if (block) this.pager.reveal(block, 'start');
  }

  /** Il paragrafo in cima: riaprendo il documento (anche su un altro dispositivo) si riprende da lì. */
  savePlace() {
    const el = this.pager.anchorEl();
    if (this.state.mode === 'doc' && el) this.plugin.savePosition(this.state.doc, { par: +el.dataset.pid });
  }

  snapshot() {
    return { ...this.state, scroll: this.mainEl ? this.mainEl.scrollTop : 0 };
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
    await this.navigate(prev, { push: false });
    if (prev.scroll) this.mainEl.scrollTop = prev.scroll;
  }

  async navigate(target, opts = {}) {
    const token = ++this.renderToken;
    if (!this.mainEl) return;
    try {
      await this.lib.ensureLoaded();
    } catch (e) {
      this.mainEl.empty();
      // Senza Bibbia la biblioteca non si apre: il pannello per scaricarla.
      if (e && e.noBible) {
        pubLangButton(this.plugin, this.mainEl.createDiv('lmp-pub-lang-row'));
        renderBibleDownload(this.plugin, this.mainEl.createDiv('lmp-error'), { onDone: () => this.plugin.openReader({ book: 1, chapter: 1 }) });
      }
      else this.mainEl.createDiv({ cls: 'lmp-empty', text: t('Biblioteca non disponibile: {msg}', { msg: e.message }) });
      return;
    }
    if (token !== this.renderToken) return;
    if (opts.push !== false && this.state.mode) this.pushHistory();
    this.state = { mode: target.mode || 'home', sym: target.sym, issue: target.issue, doc: target.doc, letter: target.letter, week: target.week, cat: target.cat, url: target.url, title: target.title };
    this.paneMode = null;
    this.panePar = null;
    this.docWrap = null;
    this.docNotes = [];
    if (this.paneEl) {
      this.paneEl.empty();
      this.bodyEl.removeClass('has-pane');
    }
    if (this.comp) this.removeChild(this.comp);
    this.comp = this.addChild(new Component());
    this.mainEl.empty();
    this.mainEl.scrollTop = 0;
    this.docBody = null;
    this.hideSelectionBar();
    const m = this.state.mode;
    this.pendingLabels = [];
    if (m === 'doc') {
      await this.renderDoc(token);
      if (token === this.renderToken) this.pager.refresh();
      // Aperto da una fonte SCRABB: al paragrafo, con il suo pannello.
      const block = target.par != null && this.docBlock(+target.par);
      if (!block && token === this.renderToken) this.resumeDoc(token);
      if (block && token === this.renderToken) {
        window.setTimeout(() => {
          this.pager.reveal(block, 'center');
          block.addClass('is-flash');
          window.setTimeout(() => block.removeClass('is-flash'), 1400);
          this.openParPane(+block.dataset.pid);
        }, 50);
      }
    }
    else if (m === 'week') await this.renderWeek(token);
    else if (m === 'issue') this.renderIssue();
    else if (m === 'pub') this.renderPub();
    else if (m === 'cat') this.renderCat();
    else if (m === 'ext') await this.renderExt(token);
    else this.renderHome();
    if (m !== 'doc') this.pager.refresh();
    if (m === 'pub' || m === 'issue') this.fillLabels(token);
    if (token !== this.renderToken) return;
    this.titleEl2.setText(this.toolbarTitle());
    this.backBtn.toggleClass('is-disabled', !this.canGoBack());
    const inDoc = m === 'doc';
    this.prevBtn.style.display = inDoc ? '' : 'none';
    this.nextBtn.style.display = inDoc ? '' : 'none';
    this.plugin.ui.libLast = { ...this.state };
    this.plugin.requestSave();
    this.leaf.updateHeader?.();
    this.app.workspace.requestSaveLayout();
  }

  /* ---------------- home ---------------- */

  renderHome() {
    const wrap = this.mainEl.createDiv('lmp-lib-home');
    const top = wrap.createDiv('lmp-lib-top');
    const search = top.createEl('input', { type: 'search', cls: 'lmp-lib-search', attr: { placeholder: t('Cerca una pubblicazione o un titolo…') } });
    pubLangButton(this.plugin, top);
    const results = wrap.createDiv('lmp-lib-results');
    const sections = wrap.createDiv();
    // Con la vista unica settimana, segnalibri e recenti sono in "Oggi": qui solo il catalogo.
    if (!this.inShell) {
      this.weekHomeCard(sections);
      this.plugin.renderPlaces(sections.createDiv(), null, true);
    }
    // Catalogo: un elenco corto di categorie; le copertine si vedono entrando in una categoria.
    const cats = sections.createDiv('lmp-lib-cats');
    for (const cat of this.lib.categories()) {
      const row = cats.createEl('button', { cls: `lmp-lib-cat cat-lib-${cat.id}` });
      const covers = row.createDiv('lmp-lib-cat-covers');
      for (const p of cat.pubs.slice(0, 3)) {
        const art = covers.createDiv('lmp-lib-cat-cover');
        const cover = this.lib.pubCover(p);
        if (cover) art.createEl('img', { attr: { src: fileSrc(this.app, cover), loading: 'lazy', alt: '' } });
        else art.addClass('is-fake');
      }
      const tx = row.createDiv('lmp-lib-cat-text');
      tx.createDiv({ cls: 'lmp-lib-cat-title', text: t(cat.label) });
      const one = cat.pubs.length === 1 && cat.pubs[0];
      tx.createDiv({ cls: 'lmp-lib-cat-meta', text: one ? (one.issues ? t('{n} numeri', { n: one.issues.length }) : t('{n} documenti', { n: one.docs.length })) : t('{n} pubblicazioni', { n: cat.pubs.length }) });
      setIcon(row.createSpan('lmp-lib-cat-go'), 'chevron-right');
      row.addEventListener('click', () => this.navigate(one ? { mode: 'pub', sym: one.symbol } : { mode: 'cat', cat: cat.id }));
    }
    // Pagine delle estensioni (es. un catalogo da cui scaricare): una riga come le categorie.
    for (const p of this.plugin.providers) {
      const b = typeof p.libraryBrowse === 'function' && p.libraryBrowse();
      if (!b) continue;
      const row = cats.createEl('button', { cls: 'lmp-lib-cat lmp-lib-ext' });
      setIcon(row.createDiv('lmp-lib-cat-covers'), b.icon || 'globe');
      const tx = row.createDiv('lmp-lib-cat-text');
      tx.createDiv({ cls: 'lmp-lib-cat-title', text: b.text });
      if (b.meta) tx.createDiv({ cls: 'lmp-lib-cat-meta', text: b.meta });
      setIcon(row.createSpan('lmp-lib-cat-go'), 'chevron-right');
      row.addEventListener('click', () => this.navigate({ mode: 'ext', url: b.url, title: b.text }));
    }
    const tools = sections.createDiv('lmp-lib-tools');
    tools.createEl('button', { cls: 'lmp-small-btn', text: t('Importa…') }).addEventListener('click', () => new EpubImportModal(this.plugin).open());
    // Azioni delle estensioni (fornitori).
    for (const p of this.plugin.providers) {
      if (typeof p.libraryActions !== 'function') continue;
      for (const { text, run } of p.libraryActions() || []) tools.createEl('button', { cls: 'lmp-small-btn', text }).addEventListener('click', () => run());
    }
    if (this.plugin.has('downloadCovers')) {
      const more = tools.createEl('button', { cls: 'lmp-small-btn', text: t('Cerca copertine mancanti') });
      more.addEventListener('click', async () => {
        more.disabled = true;
        try {
          const got = await this.plugin.ask('downloadCovers', (t) => more.setText(t));
          new Notice(got ? t('{n} copertine aggiunte', { n: got }) : t('Nessuna nuova copertina trovata'));
        } catch (e) {
          new Notice(t('Copertine non scaricate: {msg}', { msg: e.message }));
        }
        this.navigate({ mode: 'home' }, { push: false });
      });
    }
    search.addEventListener('input', () => {
      const q = norm(search.value).trim();
      results.empty();
      sections.style.display = q ? 'none' : '';
      if (q.length < 2) return;
      // Link incollato nella ricerca: l'azione la decide un'estensione (es. aprire o scaricare il documento).
      const url = search.value.trim();
      if (/^https?:\/\//.test(url)) {
        this.plugin
          .ask('linkAction', url)
          .then((act) => {
            if (!act || search.value.trim() !== url) return;
            results.createEl('button', { cls: 'mod-cta', text: act.text }).addEventListener('click', () => act.run());
          })
          .catch((e) => console.warn('[lampada] link', e));
        return;
      }
      const pubs = this.lib.pubs.filter((p) => norm(p.title).includes(q) || norm(p.symbol) === q);
      if (pubs.length) {
        results.createEl('h4', { cls: 'lmp-section-title', text: t('Pubblicazioni') });
        const grid = results.createDiv('lmp-lib-grid');
        for (const p of pubs.slice(0, 24)) this.pubTile(grid, p);
      }
      const docs = [];
      for (const p of this.lib.pubs) {
        for (const d of p.docs) {
          if (norm(d.title).includes(q)) docs.push(d);
          if (docs.length >= 80) break;
        }
        if (docs.length >= 80) break;
      }
      if (docs.length) {
        results.createEl('h4', { cls: 'lmp-section-title', text: t('Titoli') });
        const list = results.createDiv('lmp-lib-doclist');
        for (const d of docs) this.docRow(list, d, true);
      }
      if (!pubs.length && !docs.length) results.createDiv({ cls: 'lmp-empty', text: t('Nessun risultato.') });
      this.fillLabels(this.renderToken);
    });
  }

  /** Una categoria del catalogo: le sue pubblicazioni con le copertine (e un filtro se sono tante). */
  /** Pagina di un'estensione (hook libraryPage): la disegna lei; go() apre un'altra pagina con la cronologia della biblioteca. */
  async renderExt(token) {
    if (!this.state.url || !this.plugin.has('libraryPage')) return this.renderHome();
    const wrap = this.mainEl.createDiv('lmp-lib-page');
    const ctx = {
      go: (url, title) => this.navigate({ mode: 'ext', url, title }),
      reload: () => this.navigate({ ...this.state }, { push: false }),
      current: () => token === this.renderToken,
    };
    try {
      await this.plugin.ask('libraryPage', this.state.url, wrap, ctx);
    } catch (e) {
      wrap.createDiv({ cls: 'lmp-empty', text: t('Pagina non caricata: {msg}', { msg: e.message || e }) });
    }
  }

  renderCat() {
    const cat = this.lib.categories().find((c) => c.id === this.state.cat);
    if (!cat) return this.renderHome();
    const wrap = this.mainEl.createDiv('lmp-lib-page');
    wrap.createEl('h2', { cls: 'lmp-lib-cat-heading', text: t(cat.label) });
    const filter = cat.pubs.length > 12 ? wrap.createEl('input', { type: 'search', cls: 'lmp-lib-search', attr: { placeholder: t('Cerca in {nome}…', { nome: lang() === 'it' ? t(cat.label).toLowerCase() : t(cat.label) }) } }) : null;
    const grid = wrap.createDiv('lmp-lib-grid');
    const draw = () => {
      grid.empty();
      const q = filter ? norm(filter.value).trim() : '';
      for (const p of cat.pubs) if (!q || norm(p.title).includes(q) || norm(p.symbol) === q) this.pubTile(grid, p);
    };
    if (filter) filter.addEventListener('input', draw);
    draw();
  }

  /* ---------------- settimana ---------------- */

  /** Home: la settimana in una scheda (lettura, infrasettimanale con le risposte scritte, Torre di Guardia). */
  weekHomeCard(parent) {
    renderWeekCard(this.plugin, parent, (st) => this.navigate(st));
  }

  /** Programma della settimana: lettura biblica, adunanza infrasettimanale (con le risposte), articolo di studio. */
  async renderWeek(token) {
    const today = mondayOf(new Date());
    const k = this.state.week || today;
    const wt = (await this.lib.studyArticles()).get(k);
    if (token !== this.renderToken) return;
    const wrap = this.mainEl.createDiv('lmp-lib-page lmp-week');
    const nav = wrap.createDiv('lmp-week-nav');
    const shift = (n) => {
      const d = new Date(`${k}T12:00:00`);
      d.setDate(d.getDate() + 7 * n);
      this.navigate({ mode: 'week', week: isoDate(d) }, { push: false });
    };
    const navBtn = (icon, label, fn) => {
      const b = nav.createEl('button', { cls: 'clickable-icon lmp-week-arrow', attr: { 'aria-label': label } });
      setIcon(b, icon);
      b.addEventListener('click', fn);
    };
    navBtn('chevron-left', t('Settimana precedente'), () => shift(-1));
    const head = nav.createDiv('lmp-week-head');
    head.createEl('h2', { text: weekLabel(k) });
    if (k !== today) {
      const back = head.createEl('button', { cls: 'lmp-small-btn', text: t('Torna a questa settimana') });
      back.addEventListener('click', () => this.navigate({ mode: 'week' }, { push: false }));
    } else head.createDiv({ cls: 'lmp-week-now', text: t('Questa settimana') });
    navBtn('chevron-right', t('Settimana successiva'), () => shift(1));

    // Prima le cose brevi (lettura, articolo di studio), poi il programma completo.
    const readingEl = wrap.createDiv();
    if (wt) this.weekStudyCard(wrap, wt);
    await this.weekMeeting(readingEl, wrap.createDiv(), k, token);
  }

  async weekMeeting(readingEl, el, k, token) {
    const status = el.createDiv({ cls: 'lmp-empty', text: t('Carico il programma…') });
    const [res, base] = await Promise.all([this.plugin.meetingWeek(k).catch((e) => ({ error: e })), this.plugin.baseAnswers()]);
    if (token !== this.renderToken) return;
    status.remove();
    if (!res || res.error) {
      const box = el.createDiv('lmp-week-card');
      box.createEl('h3', { text: t('Adunanza infrasettimanale') });
      box.createDiv({
        cls: 'lmp-empty',
        text:
          !res || /non disponibile per|not available for/.test(res.error.message)
            ? t('Programma non disponibile per questa settimana.')
            : t('Programma non disponibile ({msg}). Se sei offline, riprova quando sei connesso.', { msg: res.error.message }),
      });
      return;
    }
    const { id, items } = res;
    const d = this.lib.byDocId.get(id);
    const bible = this.plugin.bible;
    const refOf = (seg) => refFromCodes(seg[1], seg[2] || undefined);
    // Lettura biblica: il titolo con il link ai capitoli (es. "GEREMIA 49-50")
    const ri = items.findIndex((x) => x.k === 'h2' && !x.s && x.x.some((t) => Array.isArray(t)));
    if (ri >= 0) {
      const box = readingEl.createDiv('lmp-week-card lmp-week-reading');
      box.createEl('h3', { text: t('Lettura biblica') });
      const link = items[ri].x.find((t) => Array.isArray(t));
      const a = parseCode(link[1]);
      const b = parseCode(link[2] || link[1]);
      const chips = box.createDiv('lmp-week-chips');
      for (let c = a.chapter; a.book === b.book && c <= b.chapter; c++) {
        const ref = { book: a.book, chapter: c };
        const chip = chips.createEl('button', { cls: 'lmp-week-chip', text: bible.refLabel(ref) });
        chip.addEventListener('click', () => this.plugin.openReader(ref));
      }
      if (!chips.childElementCount) chips.createEl('button', { cls: 'lmp-week-chip', text: link[0] }).addEventListener('click', () => this.plugin.openReader(refOf(link)));
    }
    const box = el.createDiv('lmp-week-card lmp-week-meeting');
    box.createEl('h3', { text: t('Adunanza infrasettimanale') });
    const body = box.createDiv('lmp-week-body');
    for (const [i, it] of items.entries()) {
      if (i === ri || it.k === 'h1') continue;
      if (it.k === 'img') {
        this.weekFigure(body, it);
        continue;
      }
      if (it.k === 'f') {
        for (const tag of it.f) {
          const ta = body.appendChild(this.plugin.answerBox(id, tag, t('La tua risposta'), base));
          this.aiField(ta, () => this.weekAiCtx(items, i, k));
        }
        continue;
      }
      // "(10 min)" da solo: accanto al titolo della parte; all'inizio di un paragrafo: in grigio.
      const min = typeof it.x[0] === 'string' && /^\((\d+)\s+min\)\s*/.exec(it.x[0]);
      const prev = body.lastElementChild;
      if (min && it.k === 'p' && it.x.length === 1 && min[0].length === it.x[0].length && prev && prev.hasClass('lmp-week-part')) {
        prev.createSpan({ cls: 'lmp-week-min', text: `${min[1]} min` });
        continue;
      }
      const cls = it.k === 'h2' ? `lmp-week-sec is-${it.s || 'plain'}` : it.k === 'h3' ? `lmp-week-part is-${it.s || 'plain'}${it.song ? ' is-song' : ''}` : 'lmp-week-p';
      const line = body.createDiv(cls);
      if (it.song) setIcon(line.createSpan('lmp-week-song'), 'music');
      for (const [si, seg] of it.x.entries()) {
        if (typeof seg === 'string') {
          if (si === 0 && min && it.k === 'p') {
            line.createSpan({ cls: 'lmp-week-min', text: `${min[1]} min` });
            line.appendText(` ${seg.slice(min[0].length)}`);
          } else line.appendText(seg);
          continue;
        }
        const a = line.createEl('a', { cls: 'lmp-week-ref', text: Array.isArray(seg) ? seg[0] : seg.t, href: '#' });
        if (seg.url) this.urlButtons(line, seg.url);
        a.addEventListener('click', (evt) => {
          evt.preventDefault();
          if (seg.url) return window.open(seg.url);
          const doc = !Array.isArray(seg) && this.lib.byDocId.get(seg.doc);
          // Pubblicazione che non è nel vault (cantici, opuscoli…): sul sito, dal numero del documento.
          if (!Array.isArray(seg) && !doc && !seg.ex) return window.open(`https://www.jw.org/finder?wtlocale=${this.plugin.settings.bibleLang || 'I'}&docid=${seg.doc}`);
          const key = Array.isArray(seg) ? seg[1] + seg[2] : `${seg.doc || seg.t}:${seg.a}`;
          const open = line.nextElementSibling && line.nextElementSibling.dataset.code === key;
          body.querySelectorAll('.lmp-week-verse').forEach((e) => e.remove());
          if (open) return;
          const card = createDiv({ cls: 'lmp-ref lmp-week-verse' });
          card.dataset.code = key;
          line.after(card);
          if (doc) this.weekPubCard(card, doc, seg);
          else if (seg.ex) {
            // Testo citato preso dall'EPUB
            card.createDiv({ cls: 'lmp-ref-label', text: seg.t });
            for (const t of seg.ex) card.createDiv({ cls: 'lmp-ref-text', text: t });
          } else this.weekVerseCard(card, refOf(seg));
        });
      }
    }
    if (d) {
      const b = box.createEl('button', { cls: 'lmp-small-btn', text: t('Apri nella biblioteca') });
      b.addEventListener('click', () => this.navigate({ mode: 'doc', sym: d.pub.symbol, doc: d.id }));
    }
  }

  /** Icone delle estensioni accanto a un link (hook urlButton, es. la trascrizione di un video); dopo run() si ridisegna. */
  urlButtons(parent, url) {
    for (const p of this.plugin.providers) {
      const b = typeof p.urlButton === 'function' && p.urlButton(url);
      if (!b) continue;
      const el = parent.createSpan({ cls: 'clickable-icon lmp-url-btn', attr: { 'aria-label': b.label, role: 'button', tabindex: '0' } });
      setIcon(el, b.icon);
      el.addEventListener('click', async () => {
        if (el.hasClass('is-busy')) return;
        el.addClass('is-busy');
        try {
          if (await b.run()) this.navigate({ ...this.state }, { push: false });
        } catch (e) {
          new Notice(`${b.label}: ${e.message || e}`);
        } finally {
          el.removeClass('is-busy');
        }
      });
    }
  }

  /** Immagine del programma con didascalia e testo alternativo (senza file nel vault: solo i testi). */
  weekFigure(el, it) {
    const f = linkDest(this.app, it.file, '');
    if (!f && !it.alt && !it.cap) return;
    const fig = el.createEl('figure', { cls: 'lmp-week-figure' });
    if (f) {
      const img = fig.createEl('img', { attr: { src: fileSrc(this.app, f), alt: it.alt || '', loading: 'lazy' } });
      img.addEventListener('click', () => this.plugin.openFileRaw(f, 'tab'));
    }
    if (it.cap) fig.createEl('figcaption', { cls: 'lmp-img-caption', text: it.cap });
    if (it.alt && it.alt !== it.cap) fig.createDiv({ cls: 'lmp-img-alt', text: it.alt });
  }

  async weekVerseCard(card, ref) {
    const bible = this.plugin.bible;
    card.createDiv({ cls: 'lmp-ref-label', text: bible.refLabel(ref) });
    const txt = card.createDiv({ cls: 'lmp-ref-text', text: '…' });
    card.addEventListener('click', () => this.plugin.openReader(ref));
    const r = await bible.previewRef(ref, bible.refLabel(ref)).catch(() => null);
    txt.setText(r ? r.text : t('Testo non trovato: tocca per aprire la Bibbia.'));
  }

  /** Rimando a una pubblicazione del vault: i paragrafi citati (al massimo 4), tocca per aprirla lì. */
  async weekPubCard(card, d, seg) {
    card.createDiv({ cls: 'lmp-ref-label', text: `${d.pub.title}${d.issue && d.issue !== 'altro' ? ` · ${issueLabel(d.issue)}` : ''} — ${d.title}` });
    const pars = [];
    for (let p = seg.a; p && p <= seg.b && pars.length < 4; p++) pars.push(p);
    card.addEventListener('click', () => this.navigate({ mode: 'doc', sym: d.pub.symbol, doc: d.id, par: seg.a || undefined }));
    if (!pars.length) {
      card.createDiv({ cls: 'lmp-ref-text', text: t('Tocca per aprire.') });
      return;
    }
    const texts = await Promise.all(pars.map((p) => this.lib.paragraphText(d, p).catch(() => '')));
    for (const t of texts.filter(Boolean)) card.createDiv({ cls: 'lmp-ref-text', text: t });
    if (!texts.some(Boolean)) card.createDiv({ cls: 'lmp-ref-text', text: t('Tocca per aprire.') });
    if (seg.b - seg.a + 1 > pars.length) card.createDiv({ cls: 'lmp-ref-text lmp-week-more', text: t('Continua nella pubblicazione…') });
  }

  weekStudyCard(el, d) {
    const box = el.createDiv('lmp-week-card lmp-week-study');
    box.createEl('h3', { text: t('Studio Torre di Guardia') });
    const row = box.createDiv({ cls: 'lmp-week-article', attr: { role: 'button', tabindex: '0' } });
    row.createDiv({ cls: 'lmp-week-article-title', text: d.title });
    row.createDiv({ cls: 'lmp-week-article-sub', text: `${t('La Torre di Guardia')} · ${issueLabel(d.issue)}` });
    const go = () => this.navigate({ mode: 'doc', sym: d.pub.symbol, doc: d.id });
    row.addEventListener('click', go);
    row.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  }

  pubTile(grid, p) {
    const tile = grid.createDiv({ cls: `lmp-lib-tile cat-lib-${p.category}` });
    const cover = this.lib.pubCover(p);
    const art = tile.createDiv('lmp-lib-cover');
    if (cover) art.createEl('img', { attr: { src: fileSrc(this.app, cover), loading: 'lazy', alt: '' } });
    else this.fakeCover(art, p);
    tile.createDiv({ cls: 'lmp-lib-tile-title', text: p.title });
    tile.createDiv({ cls: 'lmp-lib-tile-meta', text: p.issues ? t('{n} numeri', { n: p.issues.length }) : p.docs.length === 1 ? t('1 documento') : t('{n} documenti', { n: p.docs.length }) });
    tile.addEventListener('click', () => this.navigate({ mode: 'pub', sym: p.symbol }));
  }

  /** Copertina disegnata per le pubblicazioni senza immagine: titolo e simbolo, nel colore della categoria. */
  fakeCover(art, p, subtitle) {
    art.addClass('is-fake');
    art.createDiv({ cls: 'lmp-lib-fake-title', text: subtitle || p.title });
    art.createDiv({ cls: 'lmp-lib-fake-sym', text: p.symbol });
  }

  docRow(list, d, showPub) {
    const row = list.createDiv('lmp-lib-docrow');
    const num = row.createDiv('lmp-lib-docnum');
    const txt = row.createDiv('lmp-lib-docrow-text');
    if (showPub) txt.createDiv({ cls: 'lmp-lib-docrow-pub', text: `${d.pub.title}${d.issue && d.issue !== 'altro' ? ` · ${issueLabel(d.issue)}` : ''}` });
    const kind = txt.createDiv('lmp-lib-docrow-kind');
    txt.createDiv({ cls: 'lmp-lib-docrow-title', text: d.title });
    row.addEventListener('click', () => this.navigate({ mode: 'doc', sym: d.pub.symbol, doc: d.id }));
    const fill = (label) => {
      if (!label || !num.isConnected) return;
      num.setText(String(label.num));
      list.addClass('has-numbers');
      if (label.kind !== 'Capitolo') kind.setText(t(label.kind));
    };
    if (d.label !== undefined) fill(d.label);
    else (this.pendingLabels = this.pendingLabels || []).push([d, fill]);
  }

  /** Legge i numeri dei capitoli dopo aver disegnato l'elenco, un po' per volta. */
  async fillLabels(token) {
    const queue = this.pendingLabels || [];
    this.pendingLabels = [];
    for (let i = 0; i < queue.length; i += 12) {
      if (token !== this.renderToken) return;
      await Promise.all(queue.slice(i, i + 12).map(([d, fill]) => this.lib.docLabel(d).then(fill)));
    }
  }

  /* ---------------- pubblicazione ---------------- */

  pubHeader(wrap, p, docs, subtitle, issue = '') {
    const head = wrap.createDiv({ cls: `lmp-lib-head cat-lib-${p.category}` });
    const cover = this.lib.coverOf(docs) || this.lib.symCovers.get(p.symbol);
    const art = head.createDiv('lmp-lib-cover lmp-lib-cover-big');
    if (cover) art.createEl('img', { attr: { src: fileSrc(this.app, cover), alt: '' } });
    else this.fakeCover(art, p);
    const txt = head.createDiv();
    txt.createEl('h2', { text: p.title });
    txt.createDiv({ cls: 'lmp-lib-head-meta', text: subtitle });
    if (!(p.issues && !issue) && this.plugin.has('pubSource')) this.pubSource(txt.createDiv('lmp-lib-head-src'), p, issue, docs);
    pubLangButton(this.plugin, head, (evt) => this.pubLangMenu(evt, p, issue));
    const del = head.createEl('button', { cls: 'clickable-icon lmp-lib-del', attr: { 'aria-label': issue ? t('Togli questo numero') : t('Togli la pubblicazione') } });
    setIcon(del, 'trash-2');
    del.addEventListener('click', () => new RemovePubModal(this.app, issue ? `${p.title} · ${issueLabel(issue)}` : p.title, async () => {
      await this.lib.remove(p.symbol, issue);
      new Notice(t('Tolto: {nome}', { nome: issue ? issueLabel(issue) : p.title }));
      this.navigate(issue && this.lib.bySym.has(p.symbol) ? { mode: 'pub', sym: p.symbol } : { mode: 'home' }, { push: false });
    }).open());
  }

  /** Lingue (codici) in cui c'è questa pubblicazione, oltre a quella attuale. */
  async pubLangsOf(p) {
    const cur = pubLang(this.plugin.settings);
    const others = BIBLE_LANGS.filter(([code]) => code !== cur);
    const there = await Promise.all(others.map(([code]) => hasInLang(this.plugin, code, ['', '.epub', '.wol'].map((x) => p.symbol + x))));
    return others.filter((_, i) => there[i]).map(([code]) => code);
  }

  /**
   * Menu delle lingue della pubblicazione (ogni lingua è una biblioteca a parte): ✓ quella attuale, il nome se lì c'è già
   * (apre lo stesso documento, numero o pubblicazione), "Scarica in English" (EPUB da jw.org) se lì c'è la Bibbia,
   * altrimenti si passa a quella lingua e si scarica prima la Bibbia. d: il documento aperto, se c'è.
   */
  async pubLangMenu(evt, p, issue, d) {
    const cur = pubLang(this.plugin.settings);
    const [have, bibles] = await Promise.all([this.pubLangsOf(p), Promise.all(BIBLE_LANGS.map(([code]) => hasBibleIn(this.plugin, code)))]);
    const menu = new Menu();
    BIBLE_LANGS.forEach(([code, name], i) => {
      menu.addItem((it) => {
        if (code === cur) return it.setTitle(name).setChecked(true);
        if (have.includes(code)) return it.setTitle(name).onClick(() => this.openInLang(code, p, issue, d));
        if (!bibles[i]) return it.setTitle(t('{lingua} · prima scarica la Bibbia', { lingua: name })).onClick(() => this.plugin.setPubLang(code));
        it.setTitle(t('Scarica in {lingua}', { lingua: name })).setIcon('download').onClick(() => this.downloadInLang(code, name, p, issue));
      });
    });
    menu.showAtMouseEvent(evt);
  }

  /**
   * Passa alla lingua code e apre lì la stessa pagina. Il documento: stesso id (l'id dei documenti di JW è uguale in tutte le
   * lingue), altrimenti (EPUB, id diversi) quello nella stessa posizione del numero, se i documenti sono tanti quanti.
   */
  async openInLang(code, p, issue, d) {
    const listOf = (pub) => (issue ? (pub.issues || []).find((x) => x.key === issue)?.docs : pub.docs) || [];
    const oldList = listOf(p);
    await this.plugin.setPubLang(code);
    await this.lib.ensureLoaded();
    const np = this.lib.bySym.get(p.symbol);
    if (!np) return this.navigate({ mode: 'home' }, { push: false });
    const list = listOf(np);
    let target = issue && list.length ? { mode: 'issue', sym: np.symbol, issue } : { mode: 'pub', sym: np.symbol };
    if (d) {
      const same = this.lib.byDocId.get(d.id);
      const nd = same && same.pub === np ? same : list.length === oldList.length ? list[oldList.indexOf(d)] : null;
      if (nd) target = { mode: 'doc', doc: nd.id };
    }
    this.navigate(target, { push: false });
  }

  async downloadInLang(code, name, p, issue) {
    try {
      if (!(await epubInfo(code, p.symbol, issue || ''))) return new Notice(t('Su jw.org non c’è un EPUB in {lingua} di questa pubblicazione.', { lingua: name }));
      await this.plugin.setPubLang(code);
      if (await this.plugin.importFromJw(p.symbol, issue || '', () => {}, p.category)) {
        await this.plugin.openLibraryAt(issue ? { mode: 'issue', sym: p.symbol, issue } : { mode: 'pub', sym: p.symbol });
      }
    } catch (e) {
      if (!e.cancelled) new Notice(`${t('Scarica in {lingua}', { lingua: name })}: ${e.message || e}`);
    }
  }

  /** Da dove arriva la pubblicazione (o il numero), dai fornitori: { text, action?: { label, run } }. */
  async pubSource(el, p, issue, docs) {
    const r = await this.plugin.ask('pubSource', p, issue, docs).catch(() => null);
    if (!r) return el.remove();
    el.createSpan({ text: r.text });
    if (!r.action) return;
    const b = el.createEl('button', { cls: 'mod-cta', text: r.action.label });
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        if (await r.action.run()) this.navigate({ ...this.state }, { push: false });
      } catch (e) {
        if (!e.cancelled) new Notice(`${r.action.label}: ${e.message || e}`);
      } finally {
        b.disabled = false;
      }
    });
  }

  renderPub() {
    const p = this.lib.bySym.get(this.state.sym);
    if (!p) return this.renderHome();
    const wrap = this.mainEl.createDiv('lmp-lib-page');
    if (p.issues) {
      this.pubHeader(wrap, p, p.issues[0].docs, t('{n} numeri · {m} articoli', { n: p.issues.length, m: p.docs.length }));
      let year = '';
      let grid = null;
      for (const iss of p.issues) {
        const y = iss.key.slice(0, 4);
        if (y !== year) {
          year = y;
          wrap.createEl('h4', { cls: 'lmp-section-title', text: /^\d{4}$/.test(y) ? y : t('Altro') });
          grid = wrap.createDiv('lmp-lib-grid lmp-lib-grid-issues');
        }
        const tile = grid.createDiv('lmp-lib-tile');
        const cover = this.lib.coverOf(iss.docs);
        const art = tile.createDiv('lmp-lib-cover');
        if (cover) art.createEl('img', { attr: { src: fileSrc(this.app, cover), loading: 'lazy', alt: '' } });
        else this.fakeCover(art, p, issueLabel(iss.key));
        tile.createDiv({ cls: 'lmp-lib-tile-title', text: issueLabel(iss.key) });
        tile.createDiv({ cls: 'lmp-lib-tile-meta', text: t('{n} articoli', { n: iss.docs.length }) });
        tile.addEventListener('click', () => this.navigate({ mode: 'issue', sym: p.symbol, issue: iss.key }));
      }
      return;
    }
    this.pubHeader(wrap, p, p.docs, p.docs.length === 1 ? t('1 documento') : t('{n} documenti', { n: p.docs.length }));
    let docs = p.docs;
    // Opere molto grandi (es. Perspicacia): indice alfabetico
    if (docs.length > 300) {
      const letters = [...new Set(docs.map((d) => norm(d.title).replace(/[^a-z]/g, '').charAt(0).toUpperCase()).filter(Boolean))].sort();
      const bar = wrap.createDiv('lmp-lib-letters');
      const letter = this.state.letter || letters[0];
      for (const l of letters) {
        const b = bar.createEl('button', { cls: `lmp-lib-letter${l === letter ? ' is-active' : ''}`, text: l });
        b.addEventListener('click', () => this.navigate({ mode: 'pub', sym: p.symbol, letter: l }, { push: false }));
      }
      const filter = wrap.createEl('input', { type: 'search', cls: 'lmp-lib-search', attr: { placeholder: t('Cerca in {nome}…', { nome: p.title }) } });
      const list = wrap.createDiv('lmp-lib-doclist');
      const draw = () => {
        list.empty();
        const q = norm(filter.value).trim();
        const shown = q ? docs.filter((d) => norm(d.title).includes(q)).slice(0, 200) : docs.filter((d) => norm(d.title).replace(/[^a-z]/g, '').charAt(0).toUpperCase() === letter);
        for (const d of shown.sort((a, b) => compare(a.title, b.title))) this.docRow(list, d);
      };
      filter.addEventListener('input', draw);
      draw();
      return;
    }
    const list = wrap.createDiv('lmp-lib-doclist');
    for (const d of docs) this.docRow(list, d);
  }

  renderIssue() {
    const p = this.lib.bySym.get(this.state.sym);
    const iss = p && p.issues && p.issues.find((i) => i.key === this.state.issue);
    if (!iss) return this.renderPub();
    const wrap = this.mainEl.createDiv('lmp-lib-page');
    this.pubHeader(wrap, p, iss.docs, `${issueLabel(iss.key)} · ${t('{n} articoli', { n: iss.docs.length })}`, iss.key);
    const list = wrap.createDiv('lmp-lib-doclist');
    for (const d of iss.docs) this.docRow(list, d);
  }

  /* ---------------- documento ---------------- */

  docSiblings(d) {
    if (d.issue && d.pub.issues) return (d.pub.issues.find((i) => i.key === d.issue) || { docs: [] }).docs;
    return d.pub.docs;
  }

  stepDoc(delta) {
    const d = this.state.mode === 'doc' && this.lib.byDocId.get(this.state.doc);
    if (!d) return;
    const list = this.docSiblings(d);
    const i = list.indexOf(d) + delta;
    if (i >= 0 && i < list.length) this.navigate({ mode: 'doc', sym: d.pub.symbol, doc: list[i].id });
  }

  async renderDoc(token) {
    const d = this.lib.byDocId.get(this.state.doc);
    if (!d) return this.renderHome();
    const file = fileAt(this.app, `${d.pub.prefix}${d.rel}`);
    const wrap = this.mainEl.createDiv('lmp-lib-doc');
    const top = wrap.createDiv('lmp-lib-doc-top');
    const crumbs = top.createDiv('lmp-lib-crumbs');
    // Lingua: solo se il documento c'è anche in un'altra lingua.
    this.pubLangsOf(d.pub).then((have) => {
      if (have.length && token === this.renderToken) pubLangButton(this.plugin, top, (evt) => this.pubLangMenu(evt, d.pub, d.issue !== 'altro' ? d.issue : '', d));
    });
    const pubLink = crumbs.createSpan({ cls: 'lmp-lib-crumb', text: d.pub.title });
    pubLink.addEventListener('click', () => this.navigate({ mode: 'pub', sym: d.pub.symbol }));
    if (d.issue && d.issue !== 'altro') {
      crumbs.appendText(' › ');
      const il = crumbs.createSpan({ cls: 'lmp-lib-crumb', text: issueLabel(d.issue) });
      il.addEventListener('click', () => this.navigate({ mode: 'issue', sym: d.pub.symbol, issue: d.issue }));
    }
    if (!file) {
      wrap.createDiv({ cls: 'lmp-empty', text: t('File del documento non trovato.') });
      return;
    }
    const text = await readFile(this.app, file);
    if (token !== this.renderToken) return;
    let body = stripFrontmatter(text)
      .replace(/<!--[\s\S]*?-->/g, '')
      // codici dei paragrafi (^p12): non si leggono, ma segnano il paragrafo per le evidenziazioni
      .replace(/[ \t]+\^p(\d+)[ \t]*$/gm, ' <span class="lmp-pid lmp-pid-$1"></span>')
      .replace(/[ \t]+\^[\w-]+[ \t]*$/gm, '');
    const label = findDocLabel(body);
    if (label) {
      const lines = body.split('\n');
      lines.splice(label.line, 1);
      body = lines.join('\n');
      wrap.createDiv({ cls: 'lmp-lib-doc-kicker', text: `${t(label.kind)} ${label.num}` });
    }
    const titleEl = wrap.createEl('h1', { cls: 'lmp-lib-doc-title', text: d.title });
    // Il titolo lo mostriamo noi: togli il primo titolo del documento se è lo stesso.
    // Nel file non ha il codice del paragrafo: è quello dopo il paragrafo precedente (serve alle evidenziazioni).
    const key = norm(d.title).replace(/[^a-z0-9]/g, '').slice(0, 24);
    body = body.replace(/^#{1,2}\s+(.+)$/m, (h, t, at) => {
      if (!norm(t).replace(/[^a-z0-9]/g, '').startsWith(key)) return h;
      const before = [...body.slice(0, at).matchAll(/lmp-pid-(\d+)/g)].map((x) => +x[1]);
      const pid = before.length ? Math.max(...before) + 1 : 1;
      const own = /lmp-pid-(\d+)/.exec(t);
      const plain = t.replace(/<span class="lmp-pid[^>]*><\/span>/, '').replace(/[*_]/g, '').trim();
      if (own || !body.includes(`lmp-pid-${pid}"`)) {
        titleEl.setText(plain || d.title);
        titleEl.appendChild(createSpan({ cls: `lmp-pid lmp-pid-${own ? own[1] : pid}` }));
        this.titlePidEl = titleEl;
      }
      return '';
    });
    const content = wrap.createDiv('lmp-lib-doc-body markdown-rendered');
    content.dataset.sourcePath = file.path;
    await renderMd(this.app, body, content, file.path, this.comp);
    if (token !== this.renderToken) return;
    this.docBody = wrap;
    this.docWrap = wrap;
    this.wrapDocWords(wrap);
    this.applyDocMarks();
    this.renderImageText(d, file, content, token);
    // Senza attendere: i campi possono arrivare da un'estensione.
    this.renderAnswerFields(d, wrap, token);
    await this.renderDocNotes();
    if (token !== this.renderToken) return;
    const nav = wrap.createDiv('lmp-chapter-nav');
    const sib = this.docSiblings(d);
    const i = sib.indexOf(d);
    const navBtn = (doc, icon, after) => {
      const b = nav.createEl('button', { cls: 'lmp-nav-btn' });
      if (!doc) return b.addClass('is-hidden');
      const ic = createSpan();
      setIcon(ic, icon);
      if (!after) b.appendChild(ic);
      b.createSpan({ text: doc.title.length > 40 ? `${doc.title.slice(0, 40)}…` : doc.title });
      if (after) b.appendChild(ic);
      b.addEventListener('click', () => this.navigate({ mode: 'doc', sym: doc.pub.symbol, doc: doc.id }));
    };
    navBtn(sib[i - 1], 'chevron-left', false);
    navBtn(sib[i + 1], 'chevron-right', true);
    this.plugin.addRecent({ doc: d.id });
  }

  /**
   * Immagini: la riga subito sotto senza codice di paragrafo è la didascalia e si mostra come tale; il testo alternativo
   * (quando si conosce) va sotto l'immagine.
   */
  async renderImageText(d, file, content, token) {
    const figs = [...content.querySelectorAll('.internal-embed[src]')]
      .filter((e) => /\.(png|jpe?g|gif|webp|avif)$/i.test(e.getAttribute('src')))
      .map((e) => {
        const block = e.closest('p') || e;
        const next = block.nextElementSibling;
        // wrapDocWords ha già tolto i codici (.lmp-pid) e messo data-pid sul blocco.
        const cap = next && next.tagName === 'P' && !next.dataset.pid && !next.querySelector('[data-pid], .lmp-pid, .internal-embed') ? next : null;
        if (cap) cap.addClass('lmp-img-caption');
        return { e, block, cap };
      });
    // Elenchi con il numero già nel testo ("1. **1.** Domanda"): senza il numero dell'elenco, se no si legge "1. 1.".
    for (const ol of content.querySelectorAll('ol')) {
      const items = [...ol.children].filter((li) => li.tagName === 'LI');
      if (items.length && items.every((li, i) => +(/^(\d+)\.\s/.exec(li.innerText.trim()) || [])[1] === i + (ol.start || 1))) ol.addClass('lmp-ol-plain');
    }
    // Etichetta breve ripetuta subito sotto ("Immagine A" due volte nel file esportato): basta una.
    for (const p of content.querySelectorAll('p + p')) {
      const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
      const t = text(p);
      if (t && t.length < 40 && t === text(p.previousElementSibling)) p.addClass('lmp-dup-label');
    }
    if (!figs.length) return;
    const files = figs.map((f) => f.e.getAttribute('src').split('/').pop());
    const alts = await this.plugin.imageAlts(d, files, fileMeta(this.app, file)?.frontmatter?.source);
    if (token !== this.renderToken) return;
    for (const [i, { e, block, cap }] of figs.entries()) {
      const alt = alts[files[i]];
      if (!alt || (cap && norm(cap.textContent) === norm(alt))) continue;
      e.setAttribute('alt', alt);
      const img = e.querySelector('img');
      if (img) img.setAttribute('alt', alt);
      block.after(createDiv({ cls: 'lmp-img-alt', text: alt }));
    }
  }

  /**
   * Paragrafi numerati come in JW Library (data-pid) e parole contate con la stessa regola,
   * così le evidenziazioni del backup cadono sulle parole giuste. Il numero del paragrafo (<sup>) non conta.
   */
  wrapDocWords(root) {
    root.querySelectorAll('.lmp-pid').forEach((mk) => {
      const pid = /lmp-pid-(\d+)/.exec(mk.className);
      const block = mk.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, figcaption') || mk.parentElement;
      mk.remove();
      if (!pid || !block || block.dataset.pid) return;
      block.dataset.pid = pid[1];
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement.closest('sup, .lmp-w, .lmp-sp, img, svg') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      let n = 0;
      for (const node of nodes) {
        const frag = document.createDocumentFragment();
        // Rimandi alle note in calce rimasti come testo ("[^1]"): JW Library non li conta come parole.
        for (const chunk of node.nodeValue.split(/(\[\^[^\]\s]+\])/)) {
          if (/^\[\^[^\]\s]+\]$/.test(chunk)) {
            frag.appendChild(createSpan({ cls: 'lmp-fn-ref', text: chunk }));
            continue;
          }
          for (const part of splitJwTokens(chunk)) {
            if (part.w) frag.appendChild(createSpan({ cls: 'lmp-w', text: part.s, attr: { 'data-t': String(n++) } }));
            else if (n > 0) frag.appendChild(createSpan({ cls: 'lmp-sp', text: part.s, attr: { 'data-a': String(n - 1) } }));
            else frag.appendChild(document.createTextNode(part.s));
          }
        }
        node.replaceWith(frag);
      }
    });
  }

  /** Dove sei: il paragrafo aperto nel pannello, altrimenti il primo visibile. */
  herePlace() {
    const d = this.state.mode === 'doc' && this.lib.byDocId.get(this.state.doc);
    if (!d || !this.docWrap) return null;
    let par = this.panePar;
    if (par == null) {
      const top = this.mainEl.getBoundingClientRect().top;
      const b = [...this.docWrap.querySelectorAll('[data-pid]')].find((x) => x.getBoundingClientRect().bottom > top + 4);
      par = b ? +b.dataset.pid : undefined;
    }
    return { place: { doc: d.id, par }, label: d.title };
  }

  /** Campi "La tua risposta" come in JW Library: la risposta del backup o quella scritta qui, modificabile. */
  async renderAnswerFields(d, wrap, token) {
    const labels = [...wrap.querySelectorAll('[data-pid]')].filter((b) => /^(la tua risposta|le tue risposte|your answers?)$/i.test(b.textContent.trim()));
    if (!labels.length) return;
    const [fields, base] = await Promise.all([this.plugin.docAnswerFields(d), this.plugin.baseAnswers()]);
    if (token !== this.renderToken || !fields) return;
    for (const block of labels) {
      const label = block.textContent.trim();
      let after = block;
      const tas = [];
      for (const tag of fields[block.dataset.pid] || []) {
        const ta = this.plugin.answerBox(d.id, tag, label, base);
        after.after(ta);
        after = ta;
        tas.push(ta);
      }
      if (after === block) continue;
      block.addClass('lmp-answer-label');
      // Lampadina discreta dentro ogni campo: propone qualche spunto di commento per la domanda.
      for (const ta of tas) this.aiField(ta, () => this.docAiCtx({ label: block }));
    }
  }

  /** Lampadina dentro un campo di risposta: prompt rapidi, poi gli spunti sotto il campo, con "Usa" per metterli lì. */
  aiField(ta, getCtx, qpid) {
    const wrap = createDiv('lmp-answer-wrap');
    ta.before(wrap);
    wrap.appendChild(ta);
    const btn = wrap.createEl('button', { cls: 'clickable-icon lmp-ai-btn', attr: { 'aria-label': t('Spunti per il commento') } });
    setIcon(btn, 'lightbulb');
    btn.addEventListener('click', (evt) =>
      aiMenu(this.plugin, evt, (preset) =>
        this.runAi(preset, getCtx, {
          btn,
          ta,
          qpid,
          place: (box) => {
            const old = wrap.nextElementSibling;
            if (old && old.hasClass('lmp-ai-box')) old.remove();
            wrap.after(box);
          },
        })
      )
    );
  }

  /** Spunti su un paragrafo (o sul testo selezionato), nel pannello del paragrafo. */
  aiOnParagraph(evt, pid, focus) {
    aiMenu(this.plugin, evt, (preset) => {
      if (this.paneMode !== 'par' || this.panePar !== pid) this.openParPane(pid);
      const f = this.docAiFocus(pid);
      this.runAi(preset, () => this.docAiCtx({ ...f, focus }), {
        ta: f.ta,
        qpid: pid,
        place: (box) => {
          if (this.paneAi && this.paneAi.box !== box) this.paneAi.box.remove();
          this.paneAi = { doc: this.state.doc, pid, box };
          const content = this.paneEl && this.paneEl.querySelector('.lmp-pane-content');
          if (content) content.prepend(box);
        },
      });
    });
  }

  /**
   * Domanda e paragrafi per un paragrafo qualsiasi: se è una domanda, i paragrafi che seguono; altrimenti il paragrafo
   * stesso e la domanda stampata prima (se c'è), con il suo campo di risposta per "Usa".
   */
  docAiFocus(pid) {
    const blocks = [...this.docWrap.querySelectorAll('[data-pid]')];
    const i = blocks.findIndex((b) => +b.dataset.pid === pid);
    let q = null;
    for (let j = i; j >= 0 && j > i - 12; j--) {
      if (isQuestionBlock(blocks[j])) {
        q = blocks[j];
        break;
      }
      if (j < i && /^H[1-6]$/.test(blocks[j].tagName)) break;
    }
    const label = q && blocks[blocks.indexOf(q) + 1];
    const wrap = label && isLabelBlock(label) && label.nextElementSibling;
    const ta = wrap && wrap.hasClass && wrap.hasClass('lmp-answer-wrap') ? wrap.querySelector('textarea') : null;
    return { q, used: q === blocks[i] ? null : [blocks[i]], ta };
  }

  /**
   * Contesto per gli spunti in un documento. Al modello vanno l'articolo intero, la domanda e i suoi paragrafi, le
   * scritture citate con note di studio, note in calce, riferimenti a margine e "Citato in", e le tue note sui paragrafi.
   */
  async docAiCtx({ label, q, used, focus }) {
    const d = this.currentDoc();
    const blocks = [...this.docWrap.querySelectorAll('[data-pid]')];
    if (label) q = blocks[blocks.indexOf(label) - 1];
    // Domanda di ripasso ("Come rispondereste?", senza numero): riguarda tutto l'articolo. Prima qui finivano
    // come "paragrafi della domanda" le altre domande del riquadro e il cantico finale.
    const review = !!(label && q && !isQuestionBlock(q));
    if (review) used = [];
    if (!used) {
      used = [];
      for (let j = blocks.indexOf(q) + 1; q && j < blocks.length && used.length < 6; j++) {
        if (isQuestionBlock(blocks[j])) break;
        if (!isLabelBlock(blocks[j]) && blockText(blocks[j])) used.push(blocks[j]);
      }
    }
    const sources = new SourceList();
    // L'articolo intero, paragrafo per paragrafo (i campi di risposta esclusi).
    const parIds = new Map();
    for (const b of blocks) {
      if (isLabelBlock(b) || !blockText(b)) continue;
      const id = sources.add(this.parLabel(+b.dataset.pid), blockText(b), { par: +b.dataset.pid });
      if (id) parIds.set(b, id);
    }
    // Immagini: testo alternativo e didascalia, con il paragrafo che le precede (toccando la fonte si va lì).
    for (const el of this.docWrap.querySelectorAll('.lmp-img-alt, p.lmp-img-caption')) {
      const prev = blocks.filter((b) => b.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).pop();
      const pid = prev ? +prev.dataset.pid : null;
      const where = pid ? this.parLabel(pid) : t('Paragrafo');
      sources.add(where === t('Paragrafo') ? t('Immagine') : t('Immagine dopo {where}', { where }), blockText(el), pid ? { par: pid } : {});
    }
    const refs = new Map();
    for (const b of [q, ...used].filter(Boolean))
      for (const a of b.querySelectorAll('a[href*="bible="]')) {
        const codes = codesFromJwUrl(a.getAttribute('href'));
        const ref = codes && refFromCodes(codes[0], codes[1]);
        const lbl = ref && ref.chapter && this.plugin.bible.refLabel(ref);
        if (lbl && !refs.has(lbl)) refs.set(lbl, ref);
      }
    // Fin qui (articolo intero e immagini) è uguale per tutte le domande dell'articolo: resta in cache (vedi aiChat).
    const shared = sources.items.length;
    await addScriptureSources(this.plugin, [...refs.values()], sources, d ? d.file : '');
    const pids = new Set([q, ...used].filter(Boolean).map((b) => +b.dataset.pid));
    return {
      title: d ? d.title : '',
      question: q ? blockText(q) : '',
      review,
      shared,
      paragraphIds: used.map((b) => parIds.get(b)).filter(Boolean),
      focus: focus ? focus.replace(/\s+/g, ' ').trim().slice(0, 1500) : '',
      sources,
      notes: (this.docNotes || []).filter((x) => pids.has(x.pid)).map((x) => [x.n.title, x.n.content].filter((t) => t && t !== 'Nota').join(': ')).filter(Boolean),
      qpid: q ? +q.dataset.pid : null,
    };
  }

  /** Contesto per un campo della Guida per l'adunanza: la parte del programma, le scritture e i paragrafi citati. */
  async weekAiCtx(items, fi, k) {
    const segText = (s) => (typeof s === 'string' ? s : Array.isArray(s) ? s[0] : s.t);
    const part = [];
    for (let j = fi - 1; j >= 0 && part.length < 12; j--) {
      const it = items[j];
      if (it.k === 'f') continue;
      if (it.k === 'h1' || it.k === 'h2') break;
      part.unshift(it);
      if (it.k === 'h3') break;
    }
    // La domanda è la riga subito sopra il campo (in "Gemme spirituali" ce ne sono due); il resto della parte fa da contesto.
    const last = part.filter((it) => it.k === 'p').pop();
    const q = last ? last.x.map(segText).join('').replace(/^\(\d+\s+min\)\s*/, '') : '';
    // "Quali gemme spirituali avete trovato?": il contesto è la lettura biblica della settimana, non il programma.
    if (/gemme spirituali|spiritual gems/i.test(q) && /lettura|reading/i.test(q)) {
      const reading = items.find((x) => x.k === 'h2' && !x.s && x.x.some((t) => Array.isArray(t)));
      const link = reading && reading.x.find((t) => Array.isArray(t));
      const ctx = link && (await this.readingAiCtx(link, q));
      if (ctx) return ctx;
    }
    const sources = new SourceList();
    const text = (it) => (it.k === 'img' ? [it.cap, it.alt].filter(Boolean).join(' — ') : it.x.map(segText).join(''));
    const label = (it) => (it.k === 'h3' ? t('Parte del programma') : it.k === 'img' ? t('Immagine del programma') : t('Guida per l’adunanza'));
    const ids = part.map((it) => sources.add(label(it), text(it), {})).filter(Boolean);
    const refs = [];
    for (const it of part)
      for (const s of it.x || []) {
        if (Array.isArray(s)) {
          const ref = refFromCodes(s[1], s[2] || undefined);
          if (ref && ref.chapter) refs.push(ref);
          continue;
        }
        if (s && s.ex) sources.add(s.t, s.ex.join('\n'), {});
        const d = s && s.doc && this.lib.byDocId.get(s.doc);
        if (!d) continue;
        for (let p = s.a; p && p <= s.b && p < s.a + 6; p++) {
          const t = await this.lib.paragraphText(d, p).catch(() => '');
          if (t) sources.add(`«${d.title}» ¶${p}`, t, { cite: d.file, par: p });
        }
      }
    await addScriptureSources(this.plugin, refs, sources, '');
    return { title: t('Guida per l’adunanza, {settimana}', { settimana: weekLabel(k) }), question: q, paragraphIds: ids, sources, notes: [] };
  }

  /**
   * Gemme spirituali: i capitoli della lettura (in cache, uguali per ogni richiesta della settimana), poi per ogni
   * versetto note di studio, note in calce, "Citato in" e riferimenti a margine, e le tue note che citano i versetti.
   * `link` è il link della lettura nel programma: [testo, codice inizio, codice fine].
   */
  async readingAiCtx(link, q) {
    const bible = this.plugin.bible;
    const a = parseCode(link[1]);
    const b = parseCode(link[2] || link[1]);
    if (a.book !== b.book) return null;
    const sources = new SourceList(400000);
    const ids = [];
    const refs = [];
    for (let c = a.chapter; c <= b.chapter && c < a.chapter + 8; c++) {
      const d = await bible.getChapter(a.book, c).catch(() => null);
      if (!d) continue;
      for (const v of [...d.verseLines.keys()].sort((x, y) => x - y)) {
        if ((c === a.chapter && a.verse && v < a.verse) || (c === b.chapter && b.verse && v > b.verse)) continue;
        const ref = { book: a.book, chapter: c, verse: v };
        const id = sources.add(bible.refLabel(ref), bible.verseText(d, v), { verse: ref });
        if (id) ids.push(id);
        refs.push(ref);
      }
    }
    if (!ids.length) return null;
    const shared = sources.items.length;
    const seen = new Set();
    for (const r of refs)
      for (const e of this.plugin.noteIndex ? this.plugin.noteIndex.lookup(r.book, r.chapter, r.verse) : []) {
        const key = `${e.path}:${e.line}`;
        if (seen.has(key) || seen.size >= 30) continue;
        seen.add(key);
        sources.add(t('Mia nota «{nome}» (cita {ref})', { nome: e.path.split('/').pop().replace(/\.md$/, ''), ref: bible.refLabel(r) }), e.snippet, { note: e.path, line: e.line });
      }
    await addScriptureSources(this.plugin, refs, sources, '', { maxVerses: Infinity, citesFirst: true });
    return {
      title: t('Lettura biblica della settimana: {ref}', { ref: `${bible.refLabel({ book: a.book, chapter: a.chapter })}${b.chapter !== a.chapter ? `-${b.chapter}` : ''}` }),
      question: `${q} ${t("(Ogni commento parte da un versetto preciso della lettura, che va nominato all'inizio, e aggiunge un dettaglio che lo rende prezioso: una nota di studio, un riferimento a margine o una pubblicazione che lo cita. Tre versetti diversi.)")}`,
      paragraphIds: ids,
      sources,
      shared,
      notes: [],
    };
  }

  runAi(preset, getCtx, { btn, ta, qpid, place }) {
    return showAiSuggestions(this.plugin, preset, getCtx, {
      btn,
      ta,
      place,
      onSource: (t, ctx) => this.openCommentSource(t, qpid ?? ctx.qpid),
      onClose: (box) => {
        if (this.paneAi && this.paneAi.box === box) this.paneAi = null;
      },
    });
  }

  /** Fonte di uno spunto: paragrafo dell'articolo, versetto (nel pannello "approfondisci") o pubblicazione citata. */
  openCommentSource(t, qpid) {
    if (!t) return;
    if (t.note) return this.app.workspace.openLinkText(t.note, '', true);
    if (t.verse && this.state.mode !== 'doc') return this.plugin.openReader(t.verse);
    if (t.par != null && !t.cite) return this.openParPane(t.par);
    if (t.verse) {
      if (qpid != null) this.openParPane(qpid);
      return this.goDeep(t.verse, true);
    }
    const doc = t.cite && this.plugin.library.byFile && this.plugin.library.byFile.get(t.cite);
    if (doc) this.navigate({ mode: 'doc', sym: doc.pub.symbol, doc: doc.id, par: t.par || undefined });
  }

  applyDocMarks() {
    const root = this.docBody;
    if (!root || this.state.mode !== 'doc') return;
    root.querySelectorAll('.lmp-w[data-hl], .lmp-sp[data-hl]').forEach((e) => {
      delete e.dataset.hl;
      delete e.dataset.mid;
    });
    const marks = this.plugin.marksForDoc(this.state.doc);
    if (!marks.length) return;
    const blocks = new Map();
    root.querySelectorAll('[data-pid]').forEach((b) => blocks.set(+b.dataset.pid, b));
    for (const m of marks) {
      for (const r of m.ranges) {
        const b = blocks.get(r.v);
        if (!b) continue;
        const end = r.e < 0 ? Infinity : r.e;
        b.querySelectorAll('.lmp-w, .lmp-sp').forEach((e) => {
          const w = e.hasClass('lmp-w');
          const t = w ? +e.dataset.t : +e.dataset.a;
          if (t >= r.s && (w ? t <= end : t < end)) {
            e.dataset.hl = m.color;
            e.dataset.mid = m.id;
          }
        });
      }
    }
  }

  /**
   * Note di JW Library sul documento, come nell'app: un quadratino nel margine sulla riga dove inizia
   * l'evidenziazione collegata (del suo colore), o all'inizio del paragrafo. Toccandolo si apre il
   * pannello del paragrafo con la nota. A destra, un segno sui paragrafi usati come fonte da schede SCRABB.
   */
  async renderDocNotes() {
    const wrap = this.docWrap;
    if (!wrap || !wrap.isConnected || this.state.mode !== 'doc') return;
    const doc = this.state.doc;
    const notes = await this.plugin.pubNotesFor(doc);
    if (this.state.doc !== doc || !wrap.isConnected) return;
    wrap.querySelectorAll('.lmp-doc-notes-btn').forEach((e) => e.remove());
    this.docNotes = [];
    const marks = new Map(this.plugin.marksForDoc(doc).map((m) => [m.id, m]));
    for (const n of notes) {
      const mark = n.mark ? marks.get(n.mark) : null;
      const par = n.par || (mark && mark.ranges[0] && mark.ranges[0].v) || null;
      const block = this.docBlock(par);
      const anchor = (mark && wrap.querySelector(`.lmp-w[data-mid="${mark.id}"]`)) || (block && block.querySelector('.lmp-w')) || block;
      this.docNotes.push({ n, mark, block, anchor, pid: block ? +block.dataset.pid : null });
    }
    if (notes.length) {
      const crumbs = wrap.querySelector('.lmp-lib-crumbs');
      if (crumbs) {
        const btn = crumbs.createSpan({ cls: 'lmp-doc-notes-btn', attr: { 'aria-label': t('Tutte le note del documento') } });
        setIcon(btn.createSpan(), 'sticky-note');
        btn.createSpan({ text: notes.length === 1 ? t('1 nota') : t('{n} note', { n: notes.length }) });
        btn.addEventListener('click', () => this.openNotesPane());
      }
    }
    this.layoutDocNoteSquares();
    if (this.paneMode) this.renderLibPane();
  }

  /** Blocco del paragrafo; se manca nel file esportato, il più vicino prima di lui. */
  docBlock(par) {
    const wrap = this.docWrap;
    if (!wrap || par == null) return null;
    let block = wrap.querySelector(`[data-pid="${par}"]`);
    if (!block) {
      wrap.querySelectorAll('[data-pid]').forEach((b) => {
        const p = +b.dataset.pid;
        if (p < par && (!block || p > +block.dataset.pid)) block = b;
      });
    }
    return block;
  }

  currentDoc() {
    return this.state.mode === 'doc' ? this.lib.byDocId.get(this.state.doc) : null;
  }

  /**
   * Nome del paragrafo come lo si legge nella pagina: "par. 3", "domanda 4", il titolo per i titoletti.
   * (Il numero interno di JW Library, ^p11, non coincide con quello stampato.)
   */
  parLabel(pid) {
    const b = this.docWrap && this.docWrap.querySelector(`[data-pid="${pid}"]`);
    if (!b) return t('Paragrafo');
    const sup = b.querySelector('sup');
    if (sup && /^\d+$/.test(sup.textContent.trim())) return t('par. {n}', { n: sup.textContent.trim() });
    const txt = b.textContent.replace(/\s+/g, ' ').trim();
    const q = /^(\d+(?:[-–]\d+)?)\.\s/.exec(txt);
    if (q) return t('domanda {n}', { n: q[1] });
    if (/^H[1-6]$/.test(b.tagName)) return txt.length > 40 ? `${txt.slice(0, 40)}…` : txt;
    return t('Paragrafo');
  }

  /** Schede SCRABB che usano un paragrafo di questo documento come fonte. */
  docFonti(par) {
    const d = this.currentDoc();
    const sc = this.plugin.scrabb;
    if (!d || !d.file || !sc || !sc.ready) return [];
    return sc.fontiOf(d.file, par);
  }

  /** Quadratini delle note (a sinistra) e segni delle schede SCRABB (a destra), riga per riga. */
  layoutDocNoteSquares() {
    const wrap = this.docWrap;
    if (!wrap || !wrap.isConnected) return;
    wrap.querySelectorAll('.lmp-doc-note-margin, .lmp-doc-scrabb-margin').forEach((e) => e.remove());
    const base = wrap.getBoundingClientRect().top;
    const list = (this.docNotes || []).filter((x) => x.anchor && x.anchor.isConnected);
    if (list.length) {
      const margin = wrap.createDiv('lmp-doc-note-margin');
      const rows = new Map();
      for (const x of list) {
        const r = x.anchor.getClientRects()[0] || x.anchor.getBoundingClientRect();
        const key = Math.round((r.top - base) / 12);
        if (!rows.has(key)) rows.set(key, { top: r.top - base, h: r.height, items: [] });
        rows.get(key).items.push(x);
      }
      for (const row of rows.values()) {
        const many = row.items.length > 1;
        const size = many ? 15 : 12;
        const sq = margin.createDiv({ cls: `lmp-margin-square${many ? ' is-many' : ''}`, attr: { 'aria-label': row.items.map((x) => x.n.title).join(' · ') } });
        const colored = row.items.find((x) => x.mark);
        if (colored) sq.dataset.hl = colored.mark.color;
        if (many) sq.setText(String(row.items.length));
        if (this.paneMode === 'par' && row.items.some((x) => x.pid === this.panePar)) sq.addClass('is-open');
        sq.style.top = `${row.top + (row.h - size) / 2}px`;
        sq.addEventListener('click', () => row.items[0].pid != null && this.openParPane(row.items[0].pid));
      }
    }
    const byPar = new Map();
    for (const f of this.docFonti()) {
      if (f.par == null) continue;
      if (!byPar.has(f.par)) byPar.set(f.par, []);
      byPar.get(f.par).push(f.e);
    }
    if (byPar.size) {
      const margin = wrap.createDiv('lmp-doc-scrabb-margin');
      for (const [par, ents] of byPar) {
        const block = wrap.querySelector(`[data-pid="${par}"]`);
        const first = block && (block.querySelector('.lmp-w') || block);
        if (!first) continue;
        const r = first.getClientRects()[0] || first.getBoundingClientRect();
        const ic = margin.createDiv({ cls: `lmp-doc-scrabb-mark scrabb-t-${ents[0].tipo}`, attr: { 'aria-label': ents.map((e) => e.name).join(' · ') } });
        setIcon(ic, SCRABB_TYPES[ents[0].tipo].icon);
        if (ents.length > 1) ic.createSpan({ cls: 'lmp-doc-scrabb-n', text: String(ents.length) });
        ic.style.top = `${r.top - base + (r.height - 16) / 2}px`;
        ic.addEventListener('click', () => this.openParPane(par));
      }
    }
  }

  /** Tocco su parole evidenziate che hanno una nota: si apre il pannello di quel paragrafo. */
  toggleDocNoteForMark(mid) {
    const x = (this.docNotes || []).find((y) => y.mark && y.mark.id === mid);
    if (!x || x.pid == null) return false;
    this.openParPane(x.pid);
    return true;
  }

  /* ---------- pannello laterale della biblioteca ---------- */

  openParPane(pid) {
    this.paneMode = 'par';
    this.panePar = pid;
    this.paneDeep = [];
    this.renderLibPane();
  }

  openNotesPane() {
    this.paneMode = 'notes';
    this.panePar = null;
    this.renderLibPane();
  }

  closeLibPane() {
    this.paneMode = null;
    this.panePar = null;
    this.paneDeep = [];
    this.renderLibPane();
  }

  libSection(parent, title, count) {
    const det = parent.createEl('details', { cls: 'lmp-section' });
    det.open = true;
    const sum = det.createEl('summary', { text: title });
    if (count) sum.createSpan({ cls: 'lmp-badge', text: String(count) });
    return det.createDiv('lmp-section-body');
  }

  async renderLibPane() {
    const pane = this.paneEl;
    if (!pane) return;
    const token = (this.libPaneToken = (this.libPaneToken || 0) + 1);
    const d = this.currentDoc();
    const show = !!(d && this.paneMode);
    this.bodyEl.toggleClass('has-pane', show);
    if (!show) this.bodyEl.removeClass('pane-expanded');
    if (this.docWrap) this.docWrap.querySelectorAll('.is-par-selected').forEach((b) => b.removeClass('is-par-selected'));
    pane.empty();
    if (!show) {
      this.layoutDocNoteSquares();
      return;
    }
    if (this.paneComp) this.removeChild(this.paneComp);
    this.paneComp = this.addChild(new Component());

    const handle = pane.createDiv({ cls: 'lmp-pane-handle', attr: { 'aria-label': t('Ingrandisci o riduci') } });
    handle.createDiv('lmp-pane-handle-bar');
    handle.addEventListener('click', () => this.bodyEl.toggleClass('pane-expanded', !this.bodyEl.hasClass('pane-expanded')));
    const header = pane.createDiv('lmp-pane-header');
    const iconBtn = (icon, label, fn) => {
      const b = header.createEl('button', { cls: 'clickable-icon lmp-pane-btn', attr: { 'aria-label': label } });
      setIcon(b, icon);
      b.addEventListener('click', fn);
      return b;
    };
    const content = createDiv('lmp-pane-content');

    if (this.paneMode === 'notes') {
      header.createDiv({ cls: 'lmp-pane-title', text: `${t('Note')} · ${d.title}` });
      iconBtn('x', t('Chiudi'), () => this.closeLibPane());
      pane.appendChild(content);
      const notes = (this.docNotes || []).slice().sort((a, b) => (a.pid ?? 1e9) - (b.pid ?? 1e9));
      if (!notes.length) content.createDiv({ cls: 'lmp-empty', text: t('Nessuna nota su questo documento.') });
      let last = undefined;
      let list = null;
      for (const x of notes) {
        if (x.pid !== last) {
          last = x.pid;
          const pl = x.pid != null ? this.parLabel(x.pid) : t('Documento');
          const h = content.createDiv({ cls: 'lmp-cite-pub lmp-lib-pane-par', text: pl.charAt(0).toUpperCase() + pl.slice(1) });
          if (x.pid != null) h.addEventListener('click', () => this.openParPane(x.pid));
          list = content.createDiv('lmp-notes');
        }
        await this.renderDocNoteCard(list, x);
        if (token !== this.libPaneToken) return;
      }
      this.layoutDocNoteSquares();
      return;
    }

    if (this.paneDeep && this.paneDeep.length) return this.renderDeepVerse(pane, header, iconBtn, content, token);

    const pid = this.panePar;
    const block = this.docWrap && this.docWrap.querySelector(`[data-pid="${pid}"]`);
    if (block) block.addClass('is-par-selected');
    const pl = this.parLabel(pid);
    header.createDiv({ cls: 'lmp-pane-title', text: `${pl.charAt(0).toUpperCase()}${pl.slice(1)} · ${d.title}` });
    const pids = this.docWrap ? [...this.docWrap.querySelectorAll('[data-pid]')].map((b) => +b.dataset.pid) : [];
    const i = pids.indexOf(pid);
    iconBtn('chevron-up', t('Paragrafo precedente'), () => i > 0 && this.openParPane(pids[i - 1]));
    iconBtn('chevron-down', t('Paragrafo successivo'), () => i >= 0 && i < pids.length - 1 && this.openParPane(pids[i + 1]));
    iconBtn('x', t('Chiudi'), () => this.closeLibPane());

    // Azioni: copia, collega a SCRABB, apri in JW Library
    const actions = pane.createDiv('lmp-actions');
    const tools = actions.createDiv('lmp-tools');
    const tool = (icon, label, fn) => {
      const b = tools.createEl('button', { cls: 'clickable-icon lmp-tool lmp-tool-labeled', attr: { 'aria-label': label } });
      setIcon(b.createSpan(), icon);
      b.createSpan({ cls: 'lmp-tool-text', text: label });
      b.addEventListener('click', fn);
    };
    const parText = () => (block ? block.innerText.replace(/^\d+\s+/, '').replace(/\s+/g, ' ').trim() : '');
    tool('waypoints', t('Collega a SCRABB'), () => this.linkToScrabb(pid, parText()));
    tool('copy', t('Copia'), async () => {
      await navigator.clipboard.writeText(parText());
      new Notice(t('Paragrafo copiato'));
    });
    tool('smartphone', 'JW Library', () => window.open(`jwlibrary:///finder?docid=${d.id}&par=${pid}`));
    tool('lightbulb', t('Spunti'), (evt) => this.aiOnParagraph(evt, pid));
    pane.appendChild(content);
    // Domande libere all'AI su questo paragrafo (solo con la chiave OpenRouter): la conversazione resta per paragrafo.
    if ((this.plugin.settings.openrouterKey || '').trim()) {
      this.paneChats = this.paneChats || new Map();
      const key = `${this.state.doc}:${pid}`;
      if (!this.paneChats.has(key)) this.paneChats.set(key, { turns: [] });
      if (this.paneChats.size > 30) this.paneChats.delete(this.paneChats.keys().next().value);
      const ask = renderAskBox(this.plugin, () => this.docAiCtx({ ...this.docAiFocus(pid) }), this.paneChats.get(key), (t) => this.openCommentSource(t, pid));
      content.prepend(ask);
    }
    if (this.paneAi && this.paneAi.doc === this.state.doc && this.paneAi.pid === pid) content.prepend(this.paneAi.box);

    // Note di JW Library
    const notes = (this.docNotes || []).filter((x) => x.pid === pid);
    if (notes.length) {
      const sec = this.libSection(content, paneLabel('Note'), notes.length);
      const list = sec.createDiv('lmp-notes');
      for (const x of notes) {
        await this.renderDocNoteCard(list, x);
        if (token !== this.libPaneToken) return;
      }
    }
    // Schede SCRABB che usano il paragrafo come fonte
    const fonti = this.docFonti(pid);
    if (fonti.length) {
      const sec = this.libSection(content, t('SCRABB'), fonti.length);
      const chips = sec.createDiv('scrabb-chips');
      for (const { e } of fonti) {
        const chip = chips.createSpan({ cls: `scrabb-chip scrabb-t-${e.tipo}`, attr: { 'aria-label': t(SCRABB_TYPES[e.tipo].label) } });
        chip.createSpan('scrabb-dot');
        chip.createSpan({ text: e.name });
        chip.addEventListener('click', () => this.plugin.showInScrabb(e.path));
      }
    }
    // Scritture citate nel paragrafo, con il testo
    const refs = [];
    if (block) {
      for (const a of block.querySelectorAll('a')) {
        const href = a.getAttribute('href') || '';
        const codes = /bible=/.test(href) ? codesFromJwUrl(href) : null;
        let ref = codes ? refFromCodes(codes[0], codes[1]) : null;
        if (!ref && a.hasClass('internal-link')) ref = this.plugin.bible.refFromLinkpath((a.dataset.href || href).split('#')[0]);
        if (!ref || !ref.chapter) continue;
        const label = this.plugin.bible.refLabel(ref);
        if (!refs.some((r) => r.label === label)) refs.push({ ref, label });
      }
    }
    if (refs.length) {
      const sec = this.libSection(content, t('Scritture'), refs.length);
      for (const r of refs) {
        const item = sec.createDiv('lmp-ref');
        item.createDiv({ cls: 'lmp-ref-label', text: r.label });
        const txt = item.createDiv({ cls: 'lmp-ref-text', text: '…' });
        this.plugin.bible.previewRef(r.ref, r.label).then((x) => txt.setText(x ? x.text : '')).catch(() => txt.setText(''));
        // si entra nel versetto qui nel pannello (approfondimenti e riferimenti), senza lasciare la pubblicazione
        item.addEventListener('click', () => this.goDeep(r.ref));
      }
    }
    if (!notes.length && !fonti.length && !refs.length)
      content.createDiv({ cls: 'lmp-empty', text: t('Nessuna nota, scheda o scrittura su questo paragrafo. Seleziona del testo per evidenziarlo o collegarlo a una scheda SCRABB.') });
    this.layoutDocNoteSquares();
  }

  /* ---------- approfondire un versetto senza lasciare la pubblicazione ---------- */

  goDeep(ref, reset) {
    if (reset) this.paneDeep = [];
    this.paneDeep = [...(this.paneDeep || []), ref];
    this.renderLibPane();
  }

  /**
   * Un versetto citato nel paragrafo: testo, approfondimenti, note in calce e riferimenti.
   * Ogni riferimento (o versetto citato negli approfondimenti) porta un livello più in giù; ← risale.
   */
  async renderDeepVerse(pane, header, iconBtn, content, token) {
    const bible = this.plugin.bible;
    const stack = this.paneDeep;
    const ref = stack[stack.length - 1];
    const up = () => {
      stack.pop();
      this.renderLibPane();
    };
    iconBtn('arrow-left', stack.length > 1 ? t('Torna a {ref}', { ref: bible.refLabel(stack[stack.length - 2]) }) : t('Torna al paragrafo'), up);
    header.createDiv({ cls: 'lmp-pane-title', text: bible.refLabel(ref) });
    iconBtn('book-open', t('Apri nella Bibbia'), () => this.plugin.openReader(ref));
    iconBtn('external-link', t('Apri in una nuova scheda'), () => this.plugin.openReaderInNewTab(ref));
    iconBtn('x', t('Chiudi'), () => this.closeLibPane());
    pane.appendChild(content);
    content.addClass('lmp-deep');

    // Percorso: ¶3 › Genesi 2:16 › Luca 19:10 (tocca un passo per tornarci)
    const crumbs = content.createDiv('lmp-deep-crumbs');
    const pl = this.parLabel(this.panePar);
    const steps = [pl.charAt(0).toUpperCase() + pl.slice(1), ...stack.map((r) => bible.refLabel(r))];
    steps.forEach((label, i) => {
      if (i) crumbs.createSpan({ cls: 'lmp-deep-sep', text: '›' });
      const last = i === steps.length - 1;
      const b = crumbs.createEl(last ? 'span' : 'a', { cls: 'lmp-deep-step', text: label, attr: last ? {} : { href: '#' } });
      if (!last)
        b.addEventListener('click', (evt) => {
          evt.preventDefault();
          stack.length = i;
          this.renderLibPane();
        });
    });

    const data = await bible.getChapter(ref.book, ref.chapter).catch(() => null);
    if (token !== this.libPaneToken) return;
    const first = ref.verse || 1;
    const last = Math.max(first, ref.verseEnd || first);
    const parts = [];
    for (let v = first; data && v <= last; v++) {
      const t = bible.verseText(data, v);
      if (t) parts.push(last > first ? `${v} ${t}` : t);
    }
    content.createDiv({ cls: 'lmp-deep-text', text: parts.join(' ') || t('Testo non trovato.') });
    const book = bible.byNum.get(ref.book);
    const label = bible.refLabel(ref);
    const sc = this.plugin.scrabb;
    const hasAi = !!(this.plugin.settings.openrouterKey || '').trim() && !!data;
    const acts = content.createDiv('lmp-deep-actions');
    const act = (text, fn) => acts.createEl('button', { cls: 'lmp-small-btn', text }).addEventListener('click', fn);
    act(t('Apri nella Bibbia'), () => this.plugin.openReader(ref));
    if (sc && sc.ready) act(t('Collega a SCRABB'), () => linkVerseToScrabb(this.plugin, label, () => this.renderLibPane()));

    // AI sul versetto, con lo stesso contesto della Bibbia (capitolo, note, approfondimenti, "Citato in").
    const verses = [];
    for (let v = first; data && v <= last; v++) verses.push(v);
    const getCtx = () => verseAiCtx(this.plugin, data, ref.verse ? verses : null, label);
    const onSource = (t) => (t && t.verse ? this.goDeep(t.verse) : this.openCommentSource(t, this.panePar));
    let aiAnchor = acts;
    if (hasAi) {
      act(t('Spunti'), (evt) =>
        aiMenu(this.plugin, evt, (preset) =>
          showAiSuggestions(this.plugin, preset, getCtx, {
            place: (box) => {
              if (this.paneAi && this.paneAi.box !== box) this.paneAi.box.remove();
              this.paneAi = { doc: this.state.doc, pid: null, deep: label, box };
              aiAnchor.after(box);
            },
            onSource,
            onClose: (box) => {
              if (this.paneAi && this.paneAi.box === box) this.paneAi = null;
            },
          })
        )
      );
      this.paneChats = this.paneChats || new Map();
      const key = `${this.state.doc}:${label}`;
      if (!this.paneChats.has(key)) this.paneChats.set(key, { turns: [] });
      if (this.paneChats.size > 30) this.paneChats.delete(this.paneChats.keys().next().value);
      aiAnchor = renderAskBox(this.plugin, getCtx, this.paneChats.get(key), onSource, t('Chiedi qualcosa su questo versetto…'));
      acts.after(aiAnchor);
      if (this.paneAi && this.paneAi.doc === this.state.doc && this.paneAi.deep === label) aiAnchor.after(this.paneAi.box);
    }
    let shown = 0;

    // Le tue note sul versetto (di sola lettura qui: la matita apre il file)
    const noteFile = book && ref.verse ? this.plugin.verseNoteFile(book, ref.chapter, ref.verse) : null;
    const parsed = noteFile ? parseNoteFile(await this.app.vault.cachedRead(noteFile)) : null;
    if (token !== this.libPaneToken) return;
    if (parsed && (parsed.blocks.length || noteFreeText(parsed.rest))) {
      shown++;
      const sec = this.libSection(content, paneLabel('Note'), parsed.blocks.length || 1);
      const list = sec.createDiv('lmp-notes');
      const card = (title, md, line) => {
        const c = list.createDiv('lmp-note-card lmp-doc-note-card');
        const head = c.createDiv('lmp-note-card-head');
        head.createDiv({ cls: 'lmp-note-card-title', text: title });
        const edit = head.createEl('button', { cls: 'clickable-icon lmp-note-edit', attr: { 'aria-label': t('Apri nel file delle note') } });
        setIcon(edit, 'pencil');
        edit.addEventListener('click', () => this.plugin.openNoteAt(noteFile, line));
        if (md) renderMd(this.app, md, c.createDiv('lmp-md lmp-note-card-body'), noteFile.path, this.paneComp);
      };
      for (const b of parsed.blocks) card(b.title && b.title !== 'Nota' ? b.title : t('Nota'), b.content, b.start);
      const free = noteFreeText(parsed.rest);
      if (free) card(t('Appunti'), free, 0);
    }

    const details = ref.verse && book ? await bible.getVerseDetails(book, ref.chapter, ref.verse).catch(() => null) : null;
    if (token !== this.libPaneToken) return;
    const src = details && details.file ? details.file.path : '';
    for (const title of ['Approfondimenti', 'Note in calce', 'Riferimenti']) {
      const s = details && details.sections.find((x) => x.title === title);
      if (!s) continue;
      shown++;
      const sec = this.libSection(content, paneLabel(title));
      if (title !== 'Riferimenti') {
        await this.renderStudyMd(sec, s.body, src);
        if (token !== this.libPaneToken) return;
        continue;
      }
      for (const l of parseRefLinks(s.body)) {
        const item = sec.createDiv('lmp-ref lmp-deep-ref');
        item.createDiv({ cls: 'lmp-ref-label', text: l.label });
        const txt = item.createDiv({ cls: 'lmp-ref-text', text: '…' });
        let target = l.ref || null;
        (l.ref ? bible.previewRef(l.ref, l.label) : bible.refPreview(l.link, l.label, src))
          .then((r) => {
            if (r) target = r.ref;
            txt.setText(r ? r.text : '');
          })
          .catch(() => txt.setText(''));
        item.addEventListener('click', () => target && this.goDeep(target));
      }
    }

    // Bibbia con riferimenti (1987), come nella Bibbia: i riferimenti a margine portano un livello più in giù.
    if (book && ref.verse) {
      shown++;
      const sec = this.libSection(content, paneLabel('Bibbia con riferimenti'));
      renderRbi8Verse(this.plugin, sec, ref, {
        alive: () => token === this.libPaneToken && sec.isConnected,
        onRef: (link, to) => this.goDeep(to),
        refresh: () => this.renderLibPane(),
      }).catch((e) => console.warn('[lampada] Bibbia con riferimenti', e));
    }

    // Dove ne hai scritto nelle tue note
    if (book && ref.verse) {
      const cites = this.plugin.noteIndex.lookup(book.num, ref.chapter, ref.verse).filter((e) => !noteFile || e.path !== noteFile.path);
      if (cites.length) {
        shown++;
        const sec = this.libSection(content, t('Nelle mie note'), new Set(cites.map((e) => e.path)).size);
        renderNoteCites(this.plugin, sec, cites, (file, line, evt) => this.plugin.openNoteAt(file, line, evt));
      }
    }

    // Pubblicazioni che citano il versetto (toccane una per aprirla qui al paragrafo)
    const cited = details && details.sections.find((x) => x.title === 'Citato in');
    if (cited) {
      shown++;
      const sec = this.libSection(content, t('Citato in'));
      await renderCitedIn(this.plugin, sec, cited.body, src, this.paneComp);
      if (token !== this.libPaneToken) return;
    }
    // Schede SCRABB che citano il versetto
    const ents = sc && sc.ready && book && ref.verse ? sc.lookup(book.num, ref.chapter, ref.verse) : [];
    if (ents.length) {
      shown++;
      const sec = this.libSection(content, t('SCRABB'), ents.length);
      const chips = sec.createDiv('scrabb-chips');
      for (const e of ents) {
        const chip = chips.createSpan({ cls: `scrabb-chip scrabb-t-${e.tipo}`, attr: { 'aria-label': t(SCRABB_TYPES[e.tipo].label) } });
        chip.createSpan('scrabb-dot');
        chip.createSpan({ text: e.name });
        chip.addEventListener('click', () => this.plugin.showInScrabb(e.path));
      }
    }
    if (!shown) content.createDiv({ cls: 'lmp-empty', text: t('Nessun approfondimento per questo versetto.') });

    // Versetti citati dentro gli approfondimenti: anche loro portano un livello più in giù.
    content.addEventListener('click', (evt) => {
      const a = evt.target instanceof HTMLElement && evt.target.closest('a');
      if (!a || a.hasClass('lmp-deep-step')) return;
      const href = a.dataset.href || a.getAttribute('href') || '';
      let r = null;
      const codes = /^jwlibrary:/.test(href) && /bible=/.test(href) ? codesFromJwUrl(href) : null;
      if (codes) r = refFromCodes(codes[0], codes[1]);
      else if (a.hasClass('internal-link')) {
        const f = bible.resolveLink(href, src);
        r = (f && bible.refFromFile(f)) || bible.refFromLinkpath(href.split('#')[0]);
        // pubblicazione della biblioteca ("Citato in"): anteprima dei paragrafi, poi si apre qui (⌘/Ctrl-clic: subito)
        const doc = !r && f && this.lib.byFile && this.lib.byFile.get(f.basename);
        if (doc) {
          evt.preventDefault();
          evt.stopPropagation();
          const go = (par) => this.navigate({ mode: 'doc', sym: doc.pub.symbol, doc: doc.id, par: par || undefined });
          const pars = citedPars(a, href);
          if (pars.length && !(evt.metaKey || evt.ctrlKey)) new CitePreviewModal(this.plugin, doc, pars, go).open();
          else go(pars[0]);
          return;
        }
      }
      if (!r || !r.chapter) return;
      evt.preventDefault();
      evt.stopPropagation();
      this.goDeep(r);
    }, true);
  }

  /** Approfondimenti: i blocchi incorporati (![[file#^id]]) si mostrano con il loro testo. */
  async renderStudyMd(el, md, src) {
    const bible = this.plugin.bible;
    const re = /!\[\[([^\]#|]+)#\^([^\]|]+)(?:\|[^\]]*)?\]\]/g;
    const embeds = [...md.matchAll(re)];
    if (!embeds.length) return renderMd(this.app, md, el.createDiv('lmp-md'), src, this.paneComp);
    for (const m of embeds) {
      const r = await bible.getBlock(m[1], m[2], src).catch(() => null);
      if (r) await renderMd(this.app, r.md, el.createDiv('lmp-study-card'), r.file.path, this.paneComp);
    }
  }

  async renderDocNoteCard(list, x) {
    const { n, mark } = x;
    const card = list.createDiv('lmp-note-card lmp-doc-note-card');
    if (mark) {
      card.dataset.hl = mark.color;
      const quote = [...(this.docWrap ? this.docWrap.querySelectorAll(`.lmp-w[data-mid="${mark.id}"], .lmp-sp[data-mid="${mark.id}"]`) : [])].map((e) => e.textContent).join('').trim();
      if (quote && quote !== n.title) card.createDiv({ cls: 'lmp-note-quote', text: `«${quote.length > 140 ? `${quote.slice(0, 140)}…` : quote}»` });
    }
    const head = card.createDiv('lmp-note-card-head');
    head.createDiv({ cls: 'lmp-note-card-title', text: n.title && n.title !== 'Nota' ? n.title : t('Nota') });
    const open = head.createEl('button', { cls: 'clickable-icon lmp-note-edit', attr: { 'aria-label': t('Apri nel file delle note') } });
    setIcon(open, 'pencil');
    open.addEventListener('click', () => this.plugin.openNoteAt(n.file, n.line));
    // Testo di JW Library: gli a capo sono quelli scritti nell'app.
    if (n.content) await renderMd(this.app, n.content.replace(/([^\n])\n(?!\n)/g, '$1  \n'), card.createDiv('lmp-md lmp-note-card-body'), n.file.path, this.paneComp || this.comp);
    const meta = [n.tags.length ? n.tags.map((t) => this.plugin.tagLabel(t)).join(' · ') : '', n.date.replace(/\*/g, '')].filter(Boolean).join(' · ');
    if (meta) card.createDiv({ cls: 'lmp-note-card-meta', text: meta });
  }

  /** Collega un paragrafo (o il testo selezionato) a una scheda SCRABB esistente o nuova. */
  async linkToScrabb(pid, quote) {
    const d = this.currentDoc();
    const sc = this.plugin.scrabb;
    if (!d || !d.file || !sc) return;
    await sc.ensure();
    const pl = this.parLabel(pid);
    const link = `[[${d.file}#^p${pid}|${d.title.replace(/[\[\]|]/g, '')}, ${pl}]]`;
    const text = (quote || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    const refresh = () => window.setTimeout(() => {
      this.layoutDocNoteSquares();
      if (this.paneMode) this.renderLibPane();
    }, 1500);
    new ScrabbPickModal(this.plugin, { placeholder: t('Collega {par} a una scheda (illustrazione, principio, persona…)', { par: pl }), allowCreate: true }, async (e) => {
      if (e.create) {
        new ScrabbNewModal(this.plugin, { name: e.name, tipo: 'illustrazione', fonti: [link], body: text ? `> ${text}\n> — ${link}` : '' }, refresh).open();
        return;
      }
      await sc.addFonte(e, link, text);
      new Notice(t('{par} collegato a {nome}', { par: `${pl.charAt(0).toUpperCase()}${pl.slice(1)}`, nome: e.name }));
      refresh();
    }).open();
  }

  /** Parole selezionate in un documento, raggruppate per paragrafo. */
  docSelectionWords() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !this.docBody || this.state.mode !== 'doc') return null;
    const range = sel.getRangeAt(0);
    if (!this.docBody.contains(range.commonAncestorContainer)) return null;
    const byP = new Map();
    this.docBody.querySelectorAll('[data-pid] .lmp-w').forEach((el) => {
      if (!range.intersectsNode(el)) return;
      const v = +el.closest('[data-pid]').dataset.pid;
      const t = +el.dataset.t;
      const r = byP.get(v);
      if (!r) byP.set(v, { v, s: t, e: t });
      else {
        r.s = Math.min(r.s, t);
        r.e = Math.max(r.e, t);
      }
    });
    if (!byP.size) return null;
    return { ranges: [...byP.values()].sort((a, b) => a.v - b.v), rect: range.getBoundingClientRect(), text: sel.toString() };
  }

  buildSelectionBar() {
    const bar = (this.selBar = this.contentEl.createDiv('lmp-selbar'));
    bar.hide();
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    for (const h of HIGHLIGHTS) {
      const dot = bar.createEl('button', { cls: `lmp-color-dot hl-${h.id}`, attr: { 'aria-label': t('Evidenzia: {colore}', { colore: t(h.label) }) } });
      dot.addEventListener('click', () => this.applySelection(h.id));
    }
    const erase = bar.createEl('button', { cls: 'lmp-color-dot lmp-color-erase clickable-icon', attr: { 'aria-label': t('Rimuovi evidenziazione') } });
    setIcon(erase, 'eraser');
    erase.addEventListener('click', () => this.applySelection(null));
    const scr = bar.createEl('button', { cls: 'lmp-color-dot lmp-color-erase clickable-icon', attr: { 'aria-label': t('Collega a una scheda SCRABB') } });
    setIcon(scr, 'waypoints');
    scr.addEventListener('click', () => {
      const info = this.selInfo;
      if (!info) return;
      window.getSelection().removeAllRanges();
      this.hideSelectionBar();
      this.linkToScrabb(info.ranges[0].v, info.text);
    });
    const copy = bar.createEl('button', { cls: 'lmp-color-dot lmp-color-erase clickable-icon', attr: { 'aria-label': t('Copia') } });
    setIcon(copy, 'copy');
    copy.addEventListener('click', async () => {
      if (!this.selInfo) return;
      await navigator.clipboard.writeText(this.selInfo.text);
      new Notice(t('Testo copiato'));
      this.hideSelectionBar();
    });
    const ai = bar.createEl('button', { cls: 'lmp-color-dot lmp-color-erase clickable-icon', attr: { 'aria-label': t('Spunti sul testo selezionato') } });
    setIcon(ai, 'lightbulb');
    ai.addEventListener('click', (evt) => {
      const info = this.selInfo;
      if (!info) return;
      window.getSelection().removeAllRanges();
      this.hideSelectionBar();
      this.aiOnParagraph(evt, info.ranges[0].v, info.text);
    });
    this.selDef = bar.createDiv('lmp-selbar-def');
    this.selDef.hide();
  }

  onSelectionChange() {
    const info = this.docSelectionWords();
    if (!info) return this.hideSelectionBar();
    const same = this.selInfo && this.selInfo.text === info.text;
    this.selInfo = info;
    this.selBar.show();
    if (!same) {
      showDefinition(this, this.selDef, info.text, (def) => {
        window.getSelection().removeAllRanges();
        this.hideSelectionBar();
        this.plugin.openPerspicacia({ perspicacia: def.file.basename, path: def.file.path });
      }, () => placeSelBar(this));
    }
    placeSelBar(this);
  }

  hideSelectionBar() {
    if (this.selBar) this.selBar.hide();
    this.selInfo = null;
  }

  applySelection(color) {
    const info = this.selInfo;
    if (!info || this.state.mode !== 'doc') return;
    this.plugin.cutDocMarks(this.state.doc, info.ranges);
    if (color) {
      this.plugin.addDocMark(this.state.doc, color, info.ranges);
      this.plugin.ui.lastColor = color;
    }
    window.getSelection().removeAllRanges();
    this.hideSelectionBar();
    this.applyDocMarks();
  }

  /** Link nei documenti: altri documenti si aprono qui, i versetti nel lettore della Bibbia. */
  onLinkClick(evt) {
    const target = evt.target;
    if (!(target instanceof HTMLElement)) return;
    const a = target.closest('a');
    if (!a) {
      const sel = window.getSelection();
      if (this.state.mode !== 'doc' || (sel && !sel.isCollapsed)) return;
      const w = target.closest('.lmp-w[data-mid], .lmp-sp[data-mid]');
      if (w && this.toggleDocNoteForMark(w.dataset.mid)) return;
      const block = target.closest('[data-pid]');
      if (!block || !this.docWrap || !this.docWrap.contains(block)) return;
      const pid = +block.dataset.pid;
      if (this.paneMode === 'par' && this.panePar === pid) this.closeLibPane();
      else this.openParPane(pid);
      return;
    }
    const href = a.getAttribute('href') || '';
    // Versetto citato nel testo: si apre nel pannello del paragrafo, da dove si può scendere nei riferimenti
    // (⌘/Ctrl-clic: come prima, nel lettore della Bibbia).
    const block = this.state.mode === 'doc' && !(evt.metaKey || evt.ctrlKey) && a.closest('[data-pid]');
    if (block) {
      const codes = /bible=/.test(href) ? codesFromJwUrl(href) : null;
      const vref = codes ? refFromCodes(codes[0], codes[1]) : a.hasClass('internal-link') ? this.plugin.bible.refFromLinkpath((a.dataset.href || href).split('#')[0]) : null;
      if (vref && vref.chapter) {
        evt.preventDefault();
        evt.stopPropagation();
        this.paneMode = 'par';
        this.panePar = +block.dataset.pid;
        this.goDeep(vref, true);
        return;
      }
    }
    const docid = /jwlibrary:\/\/\/finder\?[^)]*docid=(\d+)/.exec(href);
    if (docid && this.lib.byDocId.has(docid[1])) {
      evt.preventDefault();
      evt.stopPropagation();
      const d = this.lib.byDocId.get(docid[1]);
      this.navigate({ mode: 'doc', sym: d.pub.symbol, doc: d.id });
      return;
    }
    if (!a.hasClass('internal-link')) return;
    const link = (a.dataset.href || href).split('#')[0];
    const ref = this.plugin.bible.refFromLinkpath(link);
    if (ref && ref.chapter) return; // gestito dal lettore della Bibbia
    const d = this.lib.byFile.get(link.split('/').pop().replace(/\.md$/, ''));
    if (d) {
      evt.preventDefault();
      evt.stopPropagation();
      this.navigate({ mode: 'doc', sym: d.pub.symbol, doc: d.id });
    }
  }
}

/**
 * La settimana in una scheda (lettura, infrasettimanale con le risposte scritte, Torre di Guardia), per la home della
 * Biblioteca e per "Oggi". `go(stato)` apre uno stato della Biblioteca.
 */
function renderWeekCard(plugin, parent, go) {
    const k = mondayOf(new Date());
    const card = parent.createDiv('lmp-week-home');
    const head = card.createEl('button', { cls: 'lmp-week-entry' });
    setIcon(head.createSpan('lmp-week-entry-icon'), 'calendar-days');
    const tx = head.createSpan();
    tx.createDiv({ cls: 'lmp-week-entry-title', text: t('Adunanze della settimana') });
    tx.createDiv({ cls: 'lmp-week-entry-sub', text: weekLabel(k) });
    setIcon(head.createSpan('lmp-week-entry-go'), 'chevron-right');
    head.addEventListener('click', () => go({ mode: 'week' }));
    const rows = card.createDiv('lmp-week-rows');
    const row = (icon, label, value, fn, done) => {
      const r = rows.createEl('button', { cls: `lmp-week-row${done ? ' is-done' : ''}` });
      setIcon(r.createSpan('lmp-week-row-icon'), done ? 'check-circle-2' : icon);
      r.createSpan({ cls: 'lmp-week-row-label', text: label });
      r.createSpan({ cls: 'lmp-week-row-value', text: value });
      r.addEventListener('click', fn);
    };
    const ownTags = (docId) => new Set(Object.values(plugin.answers).filter((a) => a.doc === String(docId) && (a.v || '').trim()).map((a) => a.tag));
    Promise.all([plugin.meetingWeek(k, true).catch(() => null), plugin.library.studyArticles().catch(() => null)]).then(([mw, arts]) => {
      if (!card.isConnected) return;
      if (mw) {
        const reading = mw.items.find((x) => x.k === 'h2' && !x.s && x.x.some((s) => Array.isArray(s)));
        const link = reading && reading.x.find((s) => Array.isArray(s));
        if (link) {
          // "GEREMIA 51-52" → "Geremia 51-52"
          const x = parseCode(link[1]);
          const y = parseCode(link[2] || link[1]);
          const lbl = plugin.bible.refLabel({ book: x.book, chapter: x.chapter });
          row('book-open', t('Lettura biblica'), x.book === y.book && y.chapter > x.chapter ? `${lbl}-${y.chapter}` : lbl || link[0], () => plugin.openReader({ book: x.book, chapter: x.chapter }));
        }
        const tags = mw.items.filter((x) => x.k === 'f').flatMap((x) => x.f);
        const own = ownTags(mw.id);
        const n = tags.filter((tag) => own.has(tag)).length;
        row('users', t('Infrasettimanale'), tags.length ? t('{n}/{tot} risposte', { n, tot: tags.length }) : t('programma'), () => go({ mode: 'week' }), tags.length > 0 && n === tags.length);
      } else row('users', t('Infrasettimanale'), t('apri per scaricare il programma'), () => go({ mode: 'week' }));
      const wt = arts && arts.get(k);
      if (wt) {
        const n = ownTags(wt.id).size;
        row('tower-control', t('Torre di Guardia'), `${wt.title}${n ? ` · ${t('{n} risposte', { n })}` : ''}`, () => go({ mode: 'doc', sym: wt.pub.symbol, doc: wt.id }));
      }
    });
}

export { LibraryView, renderWeekCard };

/** Conferma prima di togliere una pubblicazione (o un numero) dal vault. */
class RemovePubModal extends Modal {
  constructor(app, name, run) {
    super(app);
    Object.assign(this, { name, run });
  }

  onOpen() {
    this.titleEl.setText(t('Togliere dalla biblioteca?'));
    const el = this.contentEl;
    el.createEl('p', { text: t('«{nome}»: note e immagini vengono cancellate dal vault. Le tue note personali e le evidenziazioni restano. Potrai scaricarla di nuovo.', { nome: this.name }) });
    const status = el.createDiv({ cls: 'lmp-bible-dl-status', attr: { 'aria-live': 'polite' } });
    const row = el.createDiv('modal-button-container');
    row.createEl('button', { text: t('Annulla') }).addEventListener('click', () => this.close());
    const ok = row.createEl('button', { cls: 'mod-warning', text: t('Togli') });
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      status.setText(t('Cancello…'));
      try {
        await this.run();
        this.close();
      } catch (e) {
        ok.disabled = false;
        status.setText(e.message || String(e));
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
