import { Menu, Modal, Scope, setIcon, Platform } from 'obsidian';
import { CITE_CATEGORIES, CITE_PERIODICALS } from './biblioteca-dati.js';
import { renderMd } from './file.js';

/**
 * Telefono e tablet: scorrendo in giù le barre si chiudono, in su (o in cima) tornano.
 * Si collega alle viste Bibbia, Biblioteca e SCRABB; scroller è l'elemento che scorre.
 */
function autoHideBars(view, scroller) {
  if (!Platform.isMobile) return;
  view.registerDomEvent(scroller, 'scroll', () => {
    if (view.plugin.settings.autoHideBars === false) return setBarsHidden(view, false);
    const top = scroller.scrollTop;
    const delta = top - (view.lastScrollTop || 0);
    view.lastScrollTop = top;
    // In fondo iOS "rimbalza": quel piccolo ritorno in su non deve riaprire le barre.
    if (Math.abs(delta) < 6 || top + scroller.clientHeight >= scroller.scrollHeight - 2) return;
    setBarsHidden(view, delta > 0 && top > 80);
  }, { passive: true });
  view.registerEvent(view.app.workspace.on('active-leaf-change', (leaf) => leaf !== view.leaf && setBarsHidden(view, false)));
}

function setBarsHidden(view, hidden) {
  if (hidden === !!view.barsHidden) return;
  view.barsHidden = hidden;
  view.containerEl.toggleClass('lmp-bars-hidden', hidden);
  const tabs = view.containerEl.closest('.workspace-tabs');
  if (tabs) tabs.toggleClass('lmp-bars-hidden', hidden);
  // anche la barra in basso di Obsidian sul telefono
  document.body.toggleClass('lmp-immersive', hidden);
}

/** Chiave di un segnalibro: versetto della Bibbia o paragrafo di una pubblicazione. */
function bookmarkKey(b) {
  return b.doc ? `d:${b.doc}:${b.par || 0}` : `${b.book}:${b.chapter}:${b.verse}`;
}

/** Le aree del plugin, nello stesso ordine ovunque (con la vista unica sono le sezioni del guscio). */
const AREAS = [
  ['home', 'sun', 'Oggi', (p) => p.openToday()],
  ['bible', 'book-open', 'Bibbia', (p) => p.openReader()],
  ['lib', 'library-big', 'Biblioteca', (p) => p.openLibrary()],
  ['scrabb', 'waypoints', 'SCRABB', (p) => p.openScrabb()],
  ['chat', 'messages-square', 'Chiedi', (p) => p.openLibraryChat()],
];

/**
 * Tasti di una vista ([tasto, funzione]…). Da sola ha il suo Scope; dentro il guscio è il guscio a passarglieli
 * quando la sezione si vede.
 */
function viewKeys(view, keys) {
  view.keyHandlers = keys;
  if (view.inShell) return;
  view.scope = new Scope(view.app.scope);
  for (const [k, fn] of keys) view.scope.register([], k, fn);
}

/** Pulsante della modalità app (nasconde l'interfaccia di Obsidian intorno al guscio). */
function addAppToggle(parent, plugin, cls = 'lmp-tb-btn clickable-icon') {
  const b = parent.createEl('button', { cls: `${cls} lmp-app-toggle`, attr: { 'aria-label': 'Modalità app (nasconde Obsidian)' } });
  setIcon(b, plugin.ui.appMode ? 'minimize-2' : 'maximize-2');
  b.toggleClass('is-active', !!plugin.ui.appMode);
  b.addEventListener('click', () => plugin.toggleAppMode());
  return b;
}

/** Selettore "Bibbia | Biblioteca | SCRABB" nelle barre: un'altra voce apre quella vista, quella attiva torna alla sua home. */
function addViewSwitch(tb, plugin, current, goHome, shell) {
  const sw = tb.createDiv({ cls: 'lmp-switch', attr: { role: 'group', 'aria-label': 'Bibbia, Biblioteca o SCRABB' } });
  for (const [id, icon, text, open] of AREAS) {
    const on = id === current;
    const b = sw.createEl('button', { cls: `lmp-switch-btn${on ? ' is-active' : ''}`, attr: { 'aria-pressed': String(on), 'aria-label': text } });
    setIcon(b.createSpan('lmp-switch-icon'), icon);
    b.createSpan({ cls: 'lmp-switch-label', text });
    b.addEventListener('click', on ? goHome : () => open(plugin));
  }
  // Con il guscio stretto lo stesso pulsante è nelle linguette in basso (il CSS nasconde questo).
  if (shell) addAppToggle(tb, plugin);
}

/** Sul telefono (barra nascosta): una sola azione "Vai a…" con lo stesso elenco del selettore. */
function addGoToAction(view, current, goHome) {
  view.addAction('compass', 'Vai a…', (evt) => {
    const menu = new Menu();
    for (const [id, icon, text, open] of AREAS) {
      menu.addItem((it) => it.setTitle(id === current ? `${text} · inizio` : text).setIcon(icon).setChecked(id === current)
        .onClick(id === current ? goHome : () => open(view.plugin)));
    }
    menu.showAtMouseEvent(evt);
  });
}

/** Finestra dei segnalibri (con il segnalibro dove sei) o dei recenti; kind: 'bookmarks' | 'recent' | '' (tutti e due). */
class PlacesModal extends Modal {
  constructor(plugin, here, kind = '') {
    super(plugin.app);
    this.plugin = plugin;
    this.here = here;
    this.kind = kind;
  }

  onOpen() {
    this.titleEl.setText({ bookmarks: 'Segnalibri', recent: 'Aperti di recente' }[this.kind] || 'Segnalibri e recenti');
    if (this.here && this.kind !== 'recent') {
      const has = this.plugin.findBookmark(this.here.place);
      const b = this.contentEl.createEl('button', { cls: has ? 'lmp-place-here' : 'lmp-place-here mod-cta', text: `${has ? 'Rimuovi il segnalibro' : 'Aggiungi segnalibro'}: ${this.here.label}` });
      setIcon(b.createSpan({ cls: 'lmp-place-here-icon', prepend: true }), has ? 'bookmark-minus' : 'bookmark-plus');
      b.addEventListener('click', () => {
        this.plugin.toggleBookmark(this.here.place);
        this.close();
      });
    }
    const list = this.contentEl.createDiv();
    this.plugin.renderPlaces(list, () => this.close(), false, this.kind).then(() => {
      if (!list.childElementCount) list.createDiv({ cls: 'lmp-empty', text: this.kind === 'recent' ? 'Ancora niente.' : 'Nessun segnalibro.' });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** "Citato in": le pubblicazioni che citano il versetto, raggruppate per tipo (Bibbia e biblioteca). */
async function renderCitedIn(plugin, el, md, sourcePath, comp) {
  const app = plugin.app;
  const pubs = await plugin.bible.docPublications();
  const cats = plugin.bible.docCats || new Map();
  const dates = plugin.bible.docDates || new Map();
  const groups = new Map();
  for (const line of md.split('\n')) {
    if (!/^\s*-\s/.test(line)) continue;
    const m = /\[\[([^\]|#]+)/.exec(line);
    const file = m ? m[1].trim() : '';
    const cat = cats.get(file) || 'altre';
    if (!groups.has(cat)) groups.set(cat, []);
    const dt = dates.get(file);
    groups.get(cat).push({ line, file, pub: dt ? dt.label : pubs.get(file) || '', key: dt ? dt.key : '' });
  }
  if (!groups.size) {
    await renderMd(app, md, el.createDiv('lmp-md'), sourcePath, comp);
    return;
  }
  const order = CITE_CATEGORIES.map(([id]) => id);
  const keys = [...groups.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  const labels = new Map(CITE_CATEGORIES);
  const open = plugin.ui.citeOpen || {};
  const SHOW = 10;
  for (const cat of keys) {
    const items = groups.get(cat);
    if (CITE_PERIODICALS.has(cat)) items.sort((a, b) => b.key.localeCompare(a.key) || b.file.localeCompare(a.file));
    const det = el.createEl('details', { cls: 'lmp-cite-cat' });
    det.open = keys.length === 1 || !!open[cat];
    const sum = det.createEl('summary');
    sum.createSpan({ cls: 'lmp-cite-cat-name', text: labels.get(cat) || cat });
    sum.createSpan({ cls: 'lmp-cite-cat-n', text: String(items.length) });
    const body = det.createDiv('lmp-md lmp-cite-pub-list');
    let rendered = false;
    const render = async () => {
      if (rendered) return;
      rendered = true;
      await renderMd(app, items.map((x) => x.line).join('\n'), body, sourcePath, comp);
      const lis = [...body.querySelectorAll(':scope > ul > li')];
      // Da quale pubblicazione viene (se nel gruppo ce n'è più d'una): "Torre di Guardia · 1° marzo 2010", "Gesù: la via…"
      const many = new Set(items.map((x) => x.pub)).size > 1;
      if (many) lis.forEach((li, i) => items[i] && items[i].pub && li.prepend(createDiv({ cls: 'lmp-cite-src', text: items[i].pub })));
      if (lis.length > SHOW + 3) {
        lis.slice(SHOW).forEach((li) => li.hide());
        const b = body.createEl('button', { cls: 'lmp-small-btn lmp-show-more', text: `Mostra tutti (${lis.length})` });
        b.addEventListener('click', () => {
          lis.forEach((li) => li.show());
          b.remove();
        });
      }
    };
    if (det.open) await render();
    det.addEventListener('toggle', () => {
      if (det.open) render();
      plugin.ui.citeOpen = { ...(plugin.ui.citeOpen || {}), [cat]: det.open };
      plugin.requestSave();
    });
  }
}

/**
 * "Nelle mie note": una riga per nota (le più recenti prima, 3 e poi "Mostra tutte") con le righe che citano il versetto.
 * cites = voci di noteIndex.lookup ({ path, line, snippet }); openAt(file, line, evt). Usata da Bibbia e Biblioteca.
 */
function renderNoteCites(plugin, sec, cites, openAt) {
  const byPath = new Map();
  for (const e of cites) {
    if (!byPath.has(e.path)) byPath.set(e.path, []);
    if (!byPath.get(e.path).some((x) => x.line === e.line)) byPath.get(e.path).push(e);
  }
  const files = [...byPath.keys()].map((p) => plugin.bible.getFile(p)).filter(Boolean).sort((a, b) => b.stat.mtime - a.stat.mtime);
  const more = [];
  files.forEach((file, i) => {
    const box = sec.createDiv('lmp-cite');
    if (i >= 3) {
      box.hide();
      more.push(box);
    }
    const head = box.createDiv('lmp-cite-head');
    setIcon(head.createSpan('lmp-cite-icon'), 'file-text');
    head.createSpan({ cls: 'lmp-cite-name', text: file.basename });
    const folder = file.parent && file.parent.path !== '/' ? file.parent.path : '';
    if (folder) head.createSpan({ cls: 'lmp-cite-folder', text: folder.split('/').pop() });
    const list = byPath.get(file.path);
    head.addEventListener('click', (evt) => openAt(file, list[0].line, evt));
    for (const e of list.slice(0, 6)) box.createDiv({ cls: 'lmp-cite-snippet', text: e.snippet || '…' }).addEventListener('click', (evt) => openAt(file, e.line, evt));
  });
  if (more.length) {
    const b = sec.createEl('button', { cls: 'lmp-small-btn lmp-show-more', text: `Mostra tutte (${files.length})` });
    b.addEventListener('click', () => {
      more.forEach((x) => x.show());
      b.remove();
    });
  }
}

/** Paragrafi citati da un link (#^pN); senza ¶ nel link, tutti quelli della stessa riga dell'elenco. */
function citedPars(a, linktext) {
  const parOf = (s) => +((/#\^p(\d+)$/.exec(s || '') || [])[1] || 0);
  const one = parOf(linktext);
  if (one) return [one];
  const li = a.closest('li');
  return li ? [...li.querySelectorAll('a.internal-link')].map((x) => parOf(x.dataset.href || x.getAttribute('href'))).filter(Boolean) : [];
}

/**
 * Anteprima di una pubblicazione citata: titolo, i paragrafi (al massimo 5; toccane uno per aprirlo lì) e
 * "Apri la pubblicazione". Scrive in el; open(par). Popup della Bibbia e finestra della Biblioteca.
 */
async function fillCitePreview(el, plugin, d, pars, open) {
  const MAX = 5;
  const texts = await Promise.all(pars.slice(0, MAX).map((p) => plugin.library.paragraphText(d, p).catch(() => '')));
  el.createDiv({ cls: 'lmp-pop-title', text: d.pub.title });
  el.createDiv({ cls: 'lmp-cite-pop-doc', text: d.title });
  pars.slice(0, MAX).forEach((p, i) => {
    const b = el.createDiv({ cls: 'lmp-cite-pop-par', attr: { role: 'button', tabindex: '0', 'aria-label': `Apri al paragrafo ${p}` } });
    b.createSpan({ cls: 'lmp-cite-pop-n', text: `¶${p} ` });
    b.appendText((texts[i] || 'Testo del paragrafo non trovato.').replace(/`/g, '')); // i minuti dei video sono `00:14`
    b.addEventListener('click', () => open(p));
    b.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open(p)));
  });
  if (pars.length > MAX) el.createDiv({ cls: 'lmp-cite-pop-more', text: `e altri ${pars.length - MAX} paragrafi` });
  const bar = el.createDiv('lmp-cite-pop-actions');
  bar.createEl('button', { cls: 'mod-cta', text: 'Apri la pubblicazione' }).addEventListener('click', () => open(pars[0]));
}

/** La stessa anteprima in una finestra (Biblioteca, dove non c'è il popup della Bibbia). */
class CitePreviewModal extends Modal {
  constructor(plugin, d, pars, open) {
    super(plugin.app);
    Object.assign(this, { plugin, d, pars, go: open });
  }
  onOpen() {
    this.modalEl.addClass('lmp-cite-modal');
    fillCitePreview(this.contentEl, this.plugin, this.d, this.pars, (p) => {
      this.close();
      this.go(p);
    });
  }
  onClose() {
    this.contentEl.empty();
  }
}

export { AREAS, citedPars, fillCitePreview, CitePreviewModal, addAppToggle, viewKeys, renderCitedIn, renderNoteCites, autoHideBars, setBarsHidden, bookmarkKey, addViewSwitch, addGoToAction, PlacesModal };
