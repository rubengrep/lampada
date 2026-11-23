import { Modal, Platform, debounce } from 'obsidian';
import { FONT_CHOICES } from './costanti.js';
import { t } from './lingua.js';
import { quickDefinition } from './studio.js';
import { hasSelection, setBarsHidden } from './ui.js';

/* ------------------------------------------------------------------ */
/* Lettura "come un Kindle": pagine, piè di pagina, aspetto del testo   */
/* ------------------------------------------------------------------ */

// ponytail: velocità di lettura fissa per i minuti che mancano; un'impostazione se mai servisse
const WPM = 200;
/** Larghezza massima del testo per i tre margini (px, come il vecchio max-width di 720). */
const MEASURES = { narrow: 860, normal: 720, wide: 600 };
const READING_THEMES = ['paper', 'sepia', 'night'];

/**
 * Piega dello schermo (iPhone Duo aperto a libro, altri pieghevoli): dove cade nel riquadro e quanto è larga.
 * Prima i segmenti del viewport (posizione esatta), poi la postura "folded" (piega al centro dello schermo).
 */
function foldIn(el) {
  const r = el.getBoundingClientRect();
  if (!r.width) return null;
  const segs = window.viewport && window.viewport.segments;
  if (segs && segs.length === 2 && segs[0].y === segs[1].y) {
    const a = segs[0].x + segs[0].width;
    const b = segs[1].x;
    if (a > r.left && b < r.right) return { at: (a + b) / 2 - r.left, width: Math.max(0, b - a) };
  }
  const posture = navigator.devicePosture;
  if (posture && posture.type === 'folded' && window.innerWidth > window.innerHeight) {
    const at = window.innerWidth / 2 - r.left;
    if (at > 0 && at < r.width) return { at, width: 0 };
  }
  return null;
}

/**
 * Pagine da libro e piè di pagina per il lettore della Bibbia e per i documenti della biblioteca.
 * In modalità "Pagine" il testo va in colonne CSS alte quanto il riquadro; si gira pagina spostando scrollLeft.
 * o.content(): il blocco del testo (null fuori dalla lettura); o.label(): nome nel piè di pagina;
 * o.edge(delta): oltre l'ultima o prima pagina (capitolo/documento accanto); o.settle(): lettura ferma, salva la posizione;
 * o.anchor(): l'elemento scelto (versetto o paragrafo con il pannello aperto) da tenere in vista quando si reimpagina.
 */
class Pager {
  constructor(view, scroller, footParent, o) {
    this.view = view;
    this.el = scroller;
    this.o = o;
    this.W = 1;
    this.pad = 0;
    this.words = 0;
    this.endEl = createDiv('lmp-page-end');
    this.foot = footParent.createDiv('lmp-foot');
    this.foot.hide();
    view.registerDomEvent(this.foot, 'click', () => setBarsHidden(view, !view.barsHidden));
    view.registerDomEvent(scroller, 'click', (e) => this.onTap(e), { capture: true });
    view.registerDomEvent(scroller, 'wheel', (e) => this.onWheel(e), { passive: false });
    let touch = null;
    view.registerDomEvent(scroller, 'touchstart', (e) => {
      touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    }, { passive: true });
    view.registerDomEvent(scroller, 'touchend', (e) => {
      if (!touch || !this.on) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touch.x;
      const dy = t.clientY - touch.y;
      touch = null;
      if (Math.abs(dx) > 50 && Math.abs(dy) < 60 && !hasSelection()) this.turn(dx < 0 ? 1 : -1);
    }, { passive: true });
    let frame = 0;
    const settle = debounce(() => this.o.content() && this.o.settle(), 1500, true);
    view.registerDomEvent(scroller, 'scroll', () => {
      if (!frame) frame = window.requestAnimationFrame(() => ((frame = 0), this.updateFoot()));
      settle();
    }, { passive: true });
    const relayout = debounce(() => this.layout(), 150, true);
    const ro = new ResizeObserver(() => relayout());
    ro.observe(scroller);
    view.register(() => ro.disconnect());
    // Piegare o aprire il telefono non cambia sempre le dimensioni: si ascolta la piega stessa.
    const targets = [navigator.devicePosture, window.matchMedia('(horizontal-viewport-segments: 2)')].filter(Boolean);
    for (const t of targets) t.addEventListener('change', relayout);
    view.register(() => targets.forEach((t) => t.removeEventListener('change', relayout)));
  }

  /** A pagine: scelto nel pannello Aa, oppure sempre (due pagine affiancate) con lo schermo piegato a libro. */
  get on() {
    const mode = this.view.plugin.settings.pageMode;
    return !!this.o.content() && (mode === 'pages' || mode === 'spread' || !!foldIn(this.el));
  }

  /** Il primo versetto o paragrafo che si vede: in alto scorrendo, sulla pagina aperta a pagine. */
  anchorEl() {
    const c = this.o.content();
    if (!c) return null;
    const r = this.el.getBoundingClientRect();
    const paged = this.el.hasClass('is-paged');
    for (const x of c.querySelectorAll('.lmp-verse, [data-pid]')) {
      const b = x.getClientRects()[0];
      if (b && (paged ? b.left >= r.left - 2 && b.left < r.right - 2 : b.bottom > r.top + 4)) return x;
    }
    return null;
  }

  /** Numero di pagine. Un segnaposto dopo l'ultima fa sì che anche una pagina mezza vuota si apra intera. */
  pages() {
    const c = this.o.content();
    const n = c && this.on ? Math.max(1, Math.ceil((c.scrollWidth - 4) / this.W)) : 1;
    if (this.on) {
      if (this.endEl.parentElement !== this.el) this.el.appendChild(this.endEl);
      this.endEl.style.left = `${n * this.W - 1}px`;
    } else this.endEl.remove();
    return n;
  }

  pageOf(el) {
    const b = el.getClientRects()[0] || el.getBoundingClientRect();
    return Math.floor((b.left - this.el.getBoundingClientRect().left + this.el.scrollLeft + 2) / this.W);
  }

  get page() {
    return Math.round(this.el.scrollLeft / this.W);
  }

  goTo(p) {
    this.el.scrollLeft = Math.max(0, Math.min(p, this.pages() - 1)) * this.W;
    this.updateFoot();
  }

  turn(delta) {
    if (!this.on) return;
    const p = this.page + delta;
    if (p >= 0 && p < this.pages()) return this.goTo(p);
    // Capitolo precedente: si arriva sulla sua ultima pagina.
    this.landing = delta < 0 ? Date.now() : 0;
    this.o.edge(delta);
  }

  /** Impagina (o torna allo scorrimento) tenendo fermo il punto di lettura. */
  layout(anchor) {
    const c = this.o.content();
    const paged = this.on;
    const was = this.el.hasClass('is-paged');
    if (anchor === undefined) anchor = c && (paged || was) ? (this.o.anchor && this.o.anchor()) || this.anchorEl() : null;
    this.el.toggleClass('is-paged', paged);
    if (paged) {
      const s = this.view.plugin.settings;
      const cs = getComputedStyle(this.el);
      const W = this.el.clientWidth || 1;
      const H = this.el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const fold = foldIn(this.el);
      // Due pagine: schermo largo, piega rilevata, o scelte a mano ("Due pagine": iPhone Duo piegato, dove la piega non si legge).
      const n = fold || s.pageMode === 'spread' || W >= 1000 ? 2 : 1;
      // Margine laterale: almeno un po' (30 con due pagine: lo spazio centrale scavalca la piega), di più se la riga verrebbe troppo lunga.
      const pad = Math.max(Platform.isPhone && n === 1 ? 20 : 30, Math.round((W / n - (MEASURES[s.margins] || 720) + 52) / 2));
      // Le colonne distano W/n: lo spazio tra le due pagine (gap) si centra sulla piega, abbastanza largo da scavalcarla.
      // ponytail: le colonne CSS sono larghe uguali; con una piega lontana dal centro del riquadro resta un margine largo da un lato.
      let gap = 2 * pad;
      let left = pad;
      if (fold) {
        gap = Math.max(gap, fold.width + 2 * pad, 2 * Math.abs(fold.at - W / 2) + 2 * pad);
        left = fold.at - W / 2 + gap / 2;
      }
      this.W = W;
      this.pad = Math.min(left, gap - left);
      this.el.toggleClass('is-folded', !!fold);
      const st = this.el.style;
      st.setProperty('--lmp-page-w', `${W}px`);
      st.setProperty('--lmp-page-h', `${Math.max(200, H)}px`);
      st.setProperty('--lmp-cols', String(n));
      st.setProperty('--lmp-gap', `${gap}px`);
      st.setProperty('--lmp-pad-l', `${left}px`);
      st.setProperty('--lmp-pad-r', `${gap - left}px`);
      if (anchor) this.goTo(this.pageOf(anchor));
      else this.goTo(this.page);
    } else {
      this.endEl.remove();
      this.el.removeClass('is-folded');
      if (was && anchor) anchor.scrollIntoView({ block: 'start' });
    }
    this.updateFoot();
  }

  /** Dopo aver disegnato un nuovo capitolo o documento. */
  refresh() {
    const c = this.o.content();
    this.words = c ? (c.textContent.match(/\S+/g) || []).length : 0;
    this.foot.toggle(!!c);
    const land = Date.now() - (this.landing || 0) < 4000;
    this.landing = 0;
    this.el.scrollLeft = 0;
    this.layout(null);
    if (!this.on) return;
    if (land) this.goTo(this.pages() - 1);
    // A pagine si legge a schermo pieno: le barre tornano toccando in alto o il piè di pagina.
    if (Platform.isMobile && this.view.plugin.settings.autoHideBars !== false) setBarsHidden(this.view, true);
  }

  /** Porta in vista un elemento: la sua pagina, oppure (scorrendo) in alto o al centro. */
  reveal(el, block = 'start') {
    if (this.on) return this.goTo(this.pageOf(el));
    el.scrollIntoView({ block });
  }

  updateFoot() {
    if (!this.foot.isShown()) return;
    const el = this.el;
    let p;
    let where;
    if (this.on) {
      const n = this.pages();
      const i = this.page;
      p = n > 1 ? i / (n - 1) : 1;
      where = t('Pagina {i} di {n}', { i: i + 1, n });
    } else {
      p = el.scrollHeight > el.clientHeight + 4 ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 1;
      where = `${Math.round(Math.min(1, p) * 100)}%`;
    }
    p = Math.min(1, Math.max(0, p));
    const min = Math.ceil((this.words * (1 - p)) / WPM);
    this.foot.empty();
    this.foot.createSpan({ cls: 'lmp-foot-label', text: this.o.label() });
    this.foot.createSpan({ text: `${where} · ${p > 0.99 ? t('fine') : min <= 1 ? t('meno di 1 min') : `${min} min`}` });
  }

  /** A pagine: tocco ai lati per girare, in alto (telefono e tablet) per le barre. */
  onTap(e) {
    if (!this.on || e.button) return;
    const t = e.target;
    if (!(t instanceof Element) || t.closest('a, button, input, textarea, select, .lmp-fn, .lmp-ref-mark, .lmp-par-mark, .lmp-ai-box') || hasSelection()) return;
    const r = this.el.getBoundingClientRect();
    const zone = Platform.isMobile ? r.width * 0.2 : Math.max(this.pad, 40);
    let d = 0;
    if (e.clientX < r.left + zone) d = -1;
    else if (e.clientX > r.right - zone) d = 1;
    else if (Platform.isMobile && e.clientY < r.top + r.height * 0.12) {
      e.stopImmediatePropagation();
      setBarsHidden(this.view, !this.view.barsHidden);
      return;
    }
    if (!d) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.turn(d);
  }

  /** Rotella e trackpad: un gesto, una pagina. */
  onWheel(e) {
    if (!this.on || e.ctrlKey) return;
    e.preventDefault();
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(d) < 4) return;
    const now = Date.now();
    const fresh = now - (this.wheelAt || 0) > 300;
    this.wheelAt = now;
    if (fresh) this.turn(d > 0 ? 1 : -1);
  }
}

/** Frecce ← → a pagine (non mentre si scrive in un campo). */
function pageKey(pager, delta) {
  const a = document.activeElement;
  if (!pager.on || a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement) return true;
  pager.turn(delta);
  return false;
}

/** Tocco lungo su una parola: sopra la barra della selezione, la definizione breve (Glossario o Perspicacia). */
function showDefinition(view, el, text, open, placed) {
  const word = String(text || '').trim();
  const token = (view.defToken = (view.defToken || 0) + 1);
  el.empty();
  el.hide();
  view.selBar.removeClass('has-def');
  if (!/^[\p{L}'’-]{3,40}$/u.test(word)) return;
  quickDefinition(view.plugin, word)
    .then((def) => {
      if (!def || token !== view.defToken || !view.selInfo) return;
      el.createDiv({ cls: 'lmp-selbar-def-title', text: `${def.title} · ${t(def.source)}` });
      if (def.text) el.createDiv({ cls: 'lmp-selbar-def-text', text: def.text });
      el.onclick = () => open(def);
      el.show();
      view.selBar.addClass('has-def');
      placed();
    })
    .catch(() => null);
}

/** Barra della selezione: sotto il testo scelto; al tocco lontano dal menu di iOS (in fondo, o in colonna di lato se largo). */
function placeSelBar(view) {
  const info = view.selInfo;
  const bar = view.selBar;
  if (!info || !bar) return;
  const root = view.contentEl.getBoundingClientRect();
  // Schermo largo al tocco (iPhone Duo aperto, tablet): colonna sul bordo del testo, a metà altezza, a portata di pollice
  // e lontana dal menu di iOS. Dal lato della colonna dei comandi (a sinistra se la striscia di sistema è a sinistra).
  const main = view.mainEl && view.mainEl.getBoundingClientRect();
  const side = Platform.isMobile && !!main && main.width >= 600;
  bar.toggleClass('is-side', side);
  if (side) {
    const sw = bar.offsetWidth || 52;
    const sh = bar.offsetHeight || 400;
    const atLeft = document.body.hasClass('lmp-rail-left');
    bar.toggleClass('def-right', atLeft);
    bar.style.left = `${(atLeft ? main.left - root.left + 10 : main.right - root.left - sw - 14)}px`;
    bar.style.top = `${Math.max(4, main.top - root.top + (main.height - sh) / 2)}px`;
    return;
  }
  const w = bar.offsetWidth || 300;
  const h = bar.offsetHeight || 44;
  let left = info.rect.left - root.left + info.rect.width / 2 - w / 2;
  left = Math.max(8, Math.min(left, root.width - w - 8));
  let top;
  if (Platform.isMobile) {
    // Telefono e tablet (anche iPhone Duo aperto): il menu di iOS (Copia, Cerca info…) va sopra la selezione, o sotto se sopra non c'è posto, e copre
    // qualsiasi cosa vicina. La barra sta in fondo, sopra il piè di pagina; in alto se la selezione arriva fin lì.
    left = (root.width - w) / 2;
    const foot = view.contentEl.querySelector('.lmp-foot');
    const fr = foot && foot.offsetParent ? foot.getBoundingClientRect() : null;
    const bottom = (fr && fr.height ? fr.top : root.bottom) - root.top;
    top = bottom - h - 10;
    if (info.rect.bottom - root.top > top - 8) top = 56;
  } else {
    // Sotto la selezione (sopra se in fondo non c'è posto).
    top = info.rect.bottom - root.top + 10;
    if (top + h + 6 > root.height) top = info.rect.top - root.top - h - 10;
  }
  bar.style.left = `${left}px`;
  bar.style.top = `${Math.max(4, top)}px`;
}

/** Pannello "Aa": carattere, dimensione, interlinea, margini, allineamento, tema e pagine, con anteprima dal vivo. */
class ReadingModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen() {
    this.containerEl.addClass('lmp-aa-container');
    this.modalEl.addClass('lmp-aa-modal');
    this.titleEl.setText(t('Aspetto del testo'));
    this.draw();
  }

  draw() {
    const s = this.plugin.settings;
    const el = this.contentEl;
    el.empty();
    const row = (label) => {
      const r = el.createDiv('lmp-aa-row');
      r.createDiv({ cls: 'lmp-aa-label', text: t(label) });
      return r.createDiv('lmp-aa-seg');
    };
    const choice = (label, key, opts) => {
      const g = row(label);
      for (const [v, text, cls] of opts) {
        const b = g.createEl('button', { cls: `lmp-aa-opt${s[key] === v ? ' is-active' : ''}${cls ? ` ${cls}` : ''}`, text: t(text) });
        b.addEventListener('click', async () => {
          s[key] = v;
          this.draw();
          await this.plugin.settingsChanged();
        });
      }
    };
    choice('Carattere', 'fontFamily', FONT_CHOICES.map(([id, label]) => [id, t(label).replace(/\s*\(.*\)$/, ''), `lmp-aa-font-${id}`]));
    const size = row('Dimensione');
    for (const [d, text] of [[-1, 'A−'], [0, `${s.fontSize}`], [1, 'A+']]) {
      const b = size.createEl('button', { cls: d ? 'lmp-aa-opt' : 'lmp-aa-opt lmp-aa-val', text });
      if (!d) continue;
      b.addEventListener('click', () => {
        this.plugin.changeFontSize(d);
        this.draw();
      });
    }
    choice('Interlinea', 'lineHeight', [[1.5, 'Compatta'], [1.75, 'Normale'], [2, 'Ariosa']]);
    choice('Margini', 'margins', [['narrow', 'Stretti'], ['normal', 'Normali'], ['wide', 'Larghi']]);
    choice('Allineamento', 'justify', [[false, 'A sinistra'], [true, 'Giustificato']]);
    choice('Tema', 'readingTheme', [['auto', 'Come Obsidian'], ['paper', 'Carta', 'lmp-aa-sw-paper'], ['sepia', 'Seppia', 'lmp-aa-sw-sepia'], ['night', 'Notte', 'lmp-aa-sw-night']]);
    choice('Lettura', 'pageMode', [['scroll', 'Scorrimento'], ['pages', 'Pagine'], ['spread', 'Due pagine']]);
  }
}

export { MEASURES, Pager, READING_THEMES, ReadingModal, pageKey, placeSelBar, showDefinition };
