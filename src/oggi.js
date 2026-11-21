import { ItemView, setIcon } from 'obsidian';
import { renderBibleDownload } from './bibbia-epub.js';
import { renderWeekCard } from './biblioteca-vista.js';
import { addViewSwitch } from './ui.js';

/* ------------------------------------------------------------------ */
/* Oggi: da dove si parte (settimana, riprendi, segnalibri, cerca)     */
/* ------------------------------------------------------------------ */

const TODAY_VIEW_TYPE = 'lampada-oggi';
const DAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

class TodayView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return TODAY_VIEW_TYPE;
  }

  getIcon() {
    return 'sun';
  }

  getDisplayText() {
    return 'Oggi';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('lmp-today-view');
    const tb = root.createDiv('lmp-toolbar');
    this.backBtn = tb.createEl('button', { cls: 'lmp-tb-btn clickable-icon', attr: { 'aria-label': 'Indietro' } });
    setIcon(this.backBtn, 'arrow-left');
    this.backBtn.addEventListener('click', () => this.inShell && this.inShell.goBack());
    this.backBtn.toggle(!!this.inShell);
    addViewSwitch(tb, this.plugin, 'home', () => this.render(), this.inShell);
    this.bodyEl = root.createDiv('lmp-today-body');
    this.render();
  }

  /** Il guscio la mostra di nuovo: settimana, recenti e "riprendi" possono essere cambiati. */
  onShown() {
    this.render();
  }

  snapshot() {
    return {};
  }

  render() {
    const p = this.plugin;
    const el = this.bodyEl;
    if (!el) return;
    el.empty();
    const wrap = el.createDiv('lmp-today');
    const now = new Date();
    const day = DAYS[now.getDay()];
    wrap.createDiv({ cls: 'lmp-today-date', text: `${day.charAt(0).toUpperCase()}${day.slice(1)} ${now.getDate()} ${MONTHS[now.getMonth()]}` });
    // Al primo avvio non c'è la Bibbia: il pannello per scaricarla, in cima.
    const dl = wrap.createDiv();
    p.bible.ensureLoaded().catch((e) => e && e.noBible && dl.isConnected && renderBibleDownload(p, dl, { onDone: () => p.openReader({ book: 1, chapter: 1 }) }));

    // Cerca o chiedi: la stessa finestra di "Cerca ovunque", che propone anche di chiedere alla biblioteca.
    const search = wrap.createEl('button', { cls: 'lmp-today-search' });
    setIcon(search.createSpan('lmp-today-search-icon'), 'search');
    search.createSpan({ text: 'Cerca o chiedi: un versetto, un titolo, un argomento, una domanda…' });
    search.addEventListener('click', () => p.openSearch());

    renderWeekCard(p, wrap, (st) => p.openLibraryAt(st));

    // Riprendi: dove eri arrivato nella Bibbia e nell'ultima pubblicazione.
    const cont = [];
    const last = p.last;
    if (last && last.book && p.bible.byNum && p.bible.byNum.get(last.book)) {
      cont.push({ icon: 'book-open', kind: 'Bibbia', title: p.bible.refLabel({ book: last.book, chapter: last.chapter }), open: () => p.openReader({ book: last.book, chapter: last.chapter, verse: last.verse }) });
    }
    const ll = p.ui.libLast;
    const d = ll && ll.mode === 'doc' && p.library.byDocId && p.library.byDocId.get(String(ll.doc));
    if (d) cont.push({ icon: 'library-big', kind: d.pub.title, title: d.title, open: () => p.openLibraryDoc(d) });
    if (cont.length) {
      wrap.createEl('h4', { cls: 'lmp-section-title', text: 'Riprendi' });
      const row = wrap.createDiv('lmp-today-continue');
      for (const c of cont) {
        const b = row.createEl('button', { cls: 'lmp-today-card' });
        setIcon(b.createSpan('lmp-today-card-icon'), c.icon);
        const t = b.createSpan('lmp-today-card-text');
        t.createSpan({ cls: 'lmp-today-card-kind', text: c.kind });
        t.createSpan({ cls: 'lmp-today-card-title', text: c.title });
        b.addEventListener('click', c.open);
      }
    }

    p.renderPlaces(wrap.createDiv(), null, true);
    // La biblioteca si carica in ritardo: al primo giro "Riprendi" può non avere ancora l'ultimo documento.
    if (!this.libWaited && ll && ll.mode === 'doc' && !(p.library.byDocId && p.library.byDocId.size) && (this.libWaited = true)) p.library.ensureLoaded().then(() => el.isConnected && this.render()).catch(() => null);
  }
}

export { TODAY_VIEW_TYPE, TodayView };
