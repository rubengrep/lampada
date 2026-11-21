import { ItemView, Scope, setIcon } from 'obsidian';
import { BibleView } from './bibbia-vista.js';
import { LibraryView } from './biblioteca-vista.js';
import { LibraryChatView } from './chat-biblioteca.js';
import { TodayView } from './oggi.js';
import { ScrabbView } from './scrabb-vista.js';
import { AREAS } from './ui.js';

/* ------------------------------------------------------------------ */
/* Lampada: una vista sola con Bibbia, Biblioteca, SCRABB e Chiedi     */
/* ------------------------------------------------------------------ */

const APP_VIEW_TYPE = 'lampada-app';
const SECTIONS = { home: TodayView, bible: BibleView, lib: LibraryView, scrabb: ScrabbView, chat: LibraryChatView };
// Tasti delle sezioni (registrati con viewKeys): il guscio li passa a quella che si vede.
const KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape'];

/**
 * Le sezioni sono le viste di sempre (BibleView, LibraryView…), create qui dentro e non come schede di Obsidian:
 * `view.inShell` è il guscio. Cronologia unica: prima di ogni cambio (dentro una sezione o tra sezioni) si mette da
 * parte dove si era ({ area, snap }); Indietro lo riprende, anche da una sezione all'altra.
 */
class LampadaView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.sections = new Map();
    this.creating = new Map();
    this.area = null;
    this.stack = [];
    this.saved = {};
    this.switching = false;
    // Le note aperte da qui vanno in un'altra scheda, non al posto del guscio.
    this.navigation = false;
  }

  getViewType() {
    return APP_VIEW_TYPE;
  }

  getIcon() {
    return (AREAS.find((a) => a[0] === this.area) || [null, 'lamp'])[1];
  }

  getDisplayText() {
    const v = this.current();
    return v ? v.getDisplayText() : 'Lampada';
  }

  current() {
    return this.sections.get(this.area) || null;
  }

  getState() {
    const st = { ...this.saved, area: this.area || undefined };
    for (const [a, v] of this.sections) st[a] = v.getState();
    return st;
  }

  async setState(state, result) {
    await super.setState(state, result);
    if (!state) return;
    for (const a of Object.keys(SECTIONS)) {
      if (!state[a]) continue;
      if (this.sections.has(a)) await this.sections.get(a).setState(state[a], { history: false });
      else this.saved[a] = state[a];
    }
    if (this.hostEl) await this.show(state.area || this.area || 'home', { push: false });
    else this.pendingArea = state.area;
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('lmp-shell');
    this.hostEl = root.createDiv('lmp-shell-host');
    // Linguette in basso: si vedono solo quando il guscio è stretto (telefono, Split View), lo decide il CSS.
    this.buildTabbar(root);
    this.scope = new Scope(this.app.scope);
    for (const key of KEYS) {
      this.scope.register([], key, (evt, ctx) => {
        const h = ((this.current() || {}).keyHandlers || []).find(([k]) => k === key);
        return h ? h[1](evt, ctx) : true;
      });
    }
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.plugin.applyAppMode()));
    // setState arriva subito dopo onOpen con la sezione da mostrare: altrimenti l'ultima usata.
    window.setTimeout(() => {
      if (!this.area) this.show(this.pendingArea || this.plugin.ui.shellArea || 'home', { push: false });
    }, 0);
    this.plugin.applyAppMode();
  }

  async onClose() {
    for (const v of this.sections.values()) {
      try {
        await v.onClose();
      } catch (e) {
        console.warn('[lampada] chiusura della sezione', e);
      }
    }
    this.sections.clear();
    this.contentEl.empty();
    // Senza guscio la modalità app nasconderebbe Obsidian senza un modo per tornare.
    window.setTimeout(() => this.plugin.applyAppMode(), 0);
  }

  /** La sezione (creata la prima volta che serve, con lo stato salvato). */
  section(area) {
    if (this.sections.has(area)) return Promise.resolve(this.sections.get(area));
    if (!this.creating.has(area)) {
      this.creating.set(
        area,
        (async () => {
          const v = new SECTIONS[area](this.leaf, this.plugin);
          v.inShell = this;
          v.shellArea = area;
          const el = v.containerEl instanceof HTMLElement ? v.containerEl : createDiv();
          if (!(v.contentEl instanceof HTMLElement)) v.contentEl = el.createDiv('view-content');
          v.containerEl = el;
          el.addClass('lmp-area');
          el.dataset.area = area;
          el.hide();
          this.hostEl.appendChild(el);
          this.addChild(v);
          await v.onOpen();
          const saved = this.saved[area] || (area === 'bible' && this.plugin.last ? { ...this.plugin.last } : null);
          if (saved) await v.setState(saved, { history: false });
          delete this.saved[area];
          this.sections.set(area, v);
          this.creating.delete(area);
          return v;
        })()
      );
    }
    return this.creating.get(area);
  }

  /** Mostra una sezione; prima mette da parte dove si era (salvo push: false). */
  async show(area, opts = {}) {
    if (!SECTIONS[area]) area = 'home';
    if (area === this.area && this.sections.has(area)) return this.current();
    const prev = this.current();
    if (opts.push !== false && prev) this.push(prev, prev.snapshot ? prev.snapshot() : {});
    const v = await this.section(area);
    this.area = area;
    for (const [a, s] of this.sections) s.containerEl.toggle(a === area);
    this.plugin.ui.shellArea = area;
    this.plugin.requestSave();
    this.updateChrome();
    if (v.applyTypography) v.applyTypography();
    if (v.onShown) v.onShown();
    this.leaf.updateHeader?.();
    this.app.workspace.requestSaveLayout();
    return v;
  }

  /**
   * Va in una sezione e ci fa qualcosa (`fn(view)`: navigate, select…). Arrivando da un'altra sezione, il "dove eri"
   * l'ha già messo da parte show(): il passo dentro la nuova sezione non se ne aggiunge un altro.
   */
  async go(area, fn) {
    const from = this.area;
    const v = await this.show(area);
    if (fn) {
      this.switching = from !== null && from !== area;
      try {
        await fn(v);
      } finally {
        this.switching = false;
      }
    }
    return v;
  }

  /** Una sezione sta per cambiare pagina: dove era, per Indietro. */
  push(view, snap) {
    if (this.switching || !view || view.shellArea !== this.area) return;
    this.stack.push({ area: view.shellArea, snap });
    if (this.stack.length > 100) this.stack.shift();
    this.updateChrome();
  }

  async goBack() {
    const e = this.stack.pop();
    if (!e) return;
    const v = await this.show(e.area, { push: false });
    if (v.restore) await v.restore(e.snap);
    this.updateChrome();
  }

  /** Tasto Indietro di ogni sezione e linguette in basso. */
  updateChrome() {
    for (const v of this.sections.values()) if (v.backBtn) v.backBtn.toggleClass('is-disabled', !this.stack.length);
    if (this.tabbarEl) this.tabbarEl.querySelectorAll('[data-area]').forEach((b) => b.toggleClass('is-active', b.dataset.area === this.area));
  }

  /** Sezione già aperta toccata di nuovo: la sua pagina iniziale. */
  async home(area) {
    const v = await this.go(area);
    if (area === 'bible') await v.navigate({ mode: 'books' });
    else if (area === 'lib') await v.navigate({ mode: 'home' });
    else if (area === 'scrabb') v.goHome();
    else if (area === 'home') v.render();
  }

  /** Guscio stretto: le sezioni in basso, come in un'app. */
  buildTabbar(root) {
    const bar = (this.tabbarEl = root.createDiv('lmp-tabbar'));
    bar.dataset.ignoreSwipe = 'true'; // come la barra in alto (addViewSwitch): niente barra laterale per un tocco
    for (const [id, icon, text] of AREAS) {
      const b = bar.createEl('button', { cls: 'lmp-tab', attr: { 'data-area': id, 'aria-label': text } });
      setIcon(b.createSpan('lmp-tab-icon'), icon);
      b.createSpan({ cls: 'lmp-tab-label', text });
      b.addEventListener('click', () => (id === this.area ? this.home(id) : this.go(id)));
    }
    const app = bar.createEl('button', { cls: 'lmp-tab lmp-app-toggle', attr: { 'aria-label': 'Modalità app (nasconde Obsidian)' } });
    setIcon(app.createSpan('lmp-tab-icon'), 'maximize-2');
    app.createSpan({ cls: 'lmp-tab-label', text: 'App' });
    app.addEventListener('click', () => this.plugin.toggleAppMode());
  }
}

export { APP_VIEW_TYPE, LampadaView };
