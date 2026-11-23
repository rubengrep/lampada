import { ItemView, Notice, Platform, TFile, setIcon } from 'obsidian';
import { dataDir } from './costanti.js';
import { fileAt, readFile } from './file.js';
import { contentLang, lang, t } from './lingua.js';
import { IndexBuilder, IndexReader, notePars } from './ricerca.js';
import { SourceList, addScriptureSources, openRouter, plain, renderAskBox, withUserStyle } from './studio.js';
import { extractBlock, sleep, stripFrontmatter } from './testo.js';
import { addViewSwitch } from './ui.js';

/* ------------------------------------------------------------------ */
/* Chiedi alla biblioteca: l'AI cerca nei paragrafi e risponde con fonti */
/* ------------------------------------------------------------------ */

const CHAT_VIEW_TYPE = 'lampada-chat';

/** Indice delle parole in .lampada/data/search/ (lo crea il computer, arriva sul telefono con la sincronizzazione). */
class LibrarySearch {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.reader = null;
    this.mtime = 0;
  }

  get folder() {
    return `${dataDir(this.plugin.settings)}/search`;
  }

  /** Documenti da indicizzare: tutta la biblioteca tranne gli indici (solo elenchi di rimandi). */
  async docs() {
    const lib = this.plugin.library;
    await lib.ensureLoaded();
    return lib.pubs.filter((p) => !/^dx/.test(p.symbol)).flatMap((p) => p.docs.filter((d) => d.file && d.title !== 'Indice'));
  }

  /** Cartelle di note in cui cercare anche (Impostazioni → Intelligenza artificiale), una per riga. */
  folders() {
    return String(this.plugin.settings.chatFolders || '')
      .split('\n')
      .map((f) => f.trim().replace(/^\/+|\/+$/g, ''))
      .filter(Boolean);
  }

  /** Note di quelle cartelle (con le sottocartelle), tranne le pubblicazioni, che ci sono già. */
  async notes() {
    const fs = this.folders();
    if (!fs.length) return [];
    const lib = this.plugin.library;
    await lib.ensureLoaded();
    return this.app.vault.getMarkdownFiles().filter((f) => fs.some((x) => f.path.startsWith(`${x}/`)) && !(lib.byFile && lib.byFile.has(f.basename)));
  }

  /** L'indice com'è adesso su disco (si ricarica se è cambiato, ad esempio arrivato dal computer). → reader o null */
  async open() {
    const a = this.app.vault.adapter;
    const st = await a.stat(`${this.folder}/meta.json`).catch(() => null);
    if (!st) return (this.reader = null);
    if (this.reader && st.mtime === this.mtime) return this.reader;
    const meta = JSON.parse(await a.read(`${this.folder}/meta.json`));
    const pars = await a.readBinary(`${this.folder}/pars.bin`);
    this.reader = new IndexReader(meta, pars, (k) => a.readBinary(`${this.folder}/s-${k}.bin`).catch(() => null));
    this.mtime = st.mtime;
    return this.reader;
  }

  /** Legge tutti i documenti e riscrive l'indice (circa 70 MB di memoria per 23 mila documenti: va anche sul telefono). */
  async build(progress = () => {}) {
    const docs = await this.docs();
    // Parole vuote e radici della lingua dei contenuti; resta in meta.lang (cambia → l'indice va rifatto).
    const b = new IndexBuilder(contentLang(this.plugin.settings));
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      const f = fileAt(this.app, `${d.pub.prefix}${d.rel}`);
      if (f) b.addDoc(d.file, stripFrontmatter(await readFile(this.app, f)));
      if (i % 300 === 0) {
        progress(t('Leggo le pubblicazioni: {i}/{n}…', { i, n: docs.length }));
        await sleep(0);
      }
    }
    // Le tue note: la chiave è il percorso (con "/"), quella delle pubblicazioni è il nome del file.
    const notes = await this.notes();
    for (let i = 0; i < notes.length; i++) {
      b.addDoc(notes[i].path, await this.app.vault.cachedRead(notes[i]), { plain: true });
      if (i % 300 === 0) {
        progress(t('Leggo le note: {i}/{n}…', { i, n: notes.length }));
        await sleep(0);
      }
    }
    progress(t('Scrivo l’indice…'));
    const out = b.finish({ built: Date.now(), docTotal: docs.length, folders: this.folders(), noteTotal: notes.length });
    const a = this.app.vault.adapter;
    if (await a.exists(this.folder)) await a.rmdir(this.folder, true);
    await a.mkdir(this.folder);
    for (const [k, buf] of out.shards) await a.writeBinary(`${this.folder}/s-${k}.bin`, buf);
    await a.writeBinary(`${this.folder}/pars.bin`, out.pars);
    // meta.json per ultimo: finché manca, l'indice non c'è.
    await a.write(`${this.folder}/meta.json`, JSON.stringify(out.meta));
    this.reader = null;
    return out.meta;
  }

  /**
   * Paragrafi che contengono le parole, dal più vicino: [{ d (documento della biblioteca, o null per una nota), file,
   * pid, text, pub, title, target (da aprire) }]. `symbol` limita a una pubblicazione (w, g, it…; "note" = solo le
   * tue note). Senza indice → null.
   */
  async find(words, { symbol, limit = 6 } = {}) {
    const reader = await this.open();
    if (!reader) return null;
    const lib = this.plugin.library;
    await lib.ensureLoaded();
    const sym = String(symbol || '').trim().toLowerCase();
    const isNote = (key) => key.includes('/');
    const docFilter = !sym ? null : sym === 'note' ? isNote : (key) => (lib.byFile.get(key)?.pub.symbol || '').toLowerCase() === sym;
    const hits = await reader.search(words, { limit, docFilter });
    const pubs = await this.plugin.bible.docPublications().catch(() => new Map());
    const out = [];
    for (const h of hits) {
      const d = isNote(h.doc) ? null : lib.byFile.get(h.doc);
      const f = fileAt(this.app, d ? `${d.pub.prefix}${d.rel}` : h.doc);
      if (!f) continue;
      const body = await readFile(this.app, f);
      if (d) {
        const md = extractBlock(body, `p${h.pid}`);
        if (md) out.push({ d, file: f, pid: h.pid, text: plain(md), pub: pubs.get(d.file) || d.pub.title, title: d.title, target: { cite: d.file, par: h.pid } });
      } else {
        const p = notePars(body).find((x) => x.pid === h.pid);
        if (p) out.push({ d: null, file: f, pid: h.pid, text: plain(p.md), pub: t('Mia nota'), title: f.basename, target: { note: f.path, line: h.pid } });
      }
    }
    return out;
  }

  /** Come find, ma i paragrafi diventano fonti di `list` (per l'AI). → identificativi delle fonti. */
  async search(list, words, opts) {
    const found = await this.find(words, opts);
    if (!found) throw new Error(t('Manca l’indice della biblioteca: crealo da Chiedi alla biblioteca → Crea l’indice.'));
    return found.map((x) => list.add(`«${x.title}»${x.d ? ` ¶${x.pid}` : ''}`, `(${x.pub}) ${x.text.slice(0, 1200)}`, x.target)).filter(Boolean);
  }
}

/* ---------------- l'AI con gli strumenti ---------------- */

// I prompt si traducono quando servono (t() in askLibrary): restano uguali tra le domande finché la lingua non cambia.
const CHAT_SYSTEM = `Aiuti un Testimone di Geova a studiare la Bibbia e le pubblicazioni della sua biblioteca (La Torre di Guardia, Svegliatevi!, libri, opuscoli, Perspicacia nello studio delle Scritture, Bibbia per lo studio con note, Guida per l'adunanza…).
Trovi le informazioni con gli strumenti:
- cerca: ricerca per PAROLE (non per significato) nei paragrafi delle pubblicazioni. Usa 2-4 parole importanti per volta, senza articoli né frasi intere. Fai più ricerche con sinonimi e forme diverse (es. "ansia", poi "preoccupazioni angoscia"). Una parola che finisce con * trova tutte quelle che iniziano così (es. "perdon*").
- versetto: un versetto della Bibbia con le note di studio, i riferimenti a margine e i paragrafi delle pubblicazioni che lo citano.
Fai almeno 2 ricerche prima di rispondere (al massimo 6). Se i risultati sono fuori tema, cambia parole.
Poi rispondi in italiano semplice e chiaro, in testo normale (niente titoli, grassetto o altra formattazione; un trattino all'inizio della riga solo per un elenco).
- Usa SOLO quello che dicono le fonti trovate; non aggiungere informazioni tue.
- Dopo ogni affermazione metti la fonte tra parentesi quadre: [F3] oppure [F3, F7].
- Se le fonti non bastano per rispondere, dillo chiaramente.`;

// Con le cartelle di note nell'indice (Impostazioni → Intelligenza artificiale).
const NOTES_HINT = `
La ricerca trova anche paragrafi delle note personali dell'utente (fonti «…» senza ¶, con "(Mia nota)"): usale se servono, ma dì quando una cosa viene dalle sue note e non da una pubblicazione.`;

const chatTools = () => [
  {
    type: 'function',
    function: {
      name: 'cerca',
      description: t('Cerca per parole nei paragrafi delle pubblicazioni. Restituisce i paragrafi più pertinenti come fonti [F…].'),
      parameters: {
        type: 'object',
        properties: {
          parole: { type: 'string', description: t('Parole da cercare, separate da spazi (es. "perdon* offese rancore").') },
          pubblicazione: { type: 'string', description: t('Facoltativo, simbolo di una sola pubblicazione: w = La Torre di Guardia, g = Svegliatevi!, it = Perspicacia, nwtsty = Bibbia per lo studio, mwb = Guida per l’adunanza; note = solo le note personali.') },
        },
        required: ['parole'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'versetto',
      description: t('Un versetto (o pochi versetti) della Bibbia con note di studio, riferimenti e paragrafi delle pubblicazioni che lo citano.'),
      parameters: { type: 'object', properties: { riferimento: { type: 'string', description: t('Es. "Giovanni 3:16" o "Salmo 23:1-4".') } }, required: ['riferimento'] },
    },
  },
];

const MAX_ROUNDS = 8;

function sourceLines(list, ids) {
  const byId = new Map(list.items.map((x) => [x.id, x]));
  return ids.map((id) => byId.get(id)).filter(Boolean).map((x) => `[${x.id}] ${x.label} ${x.text}`).join('\n');
}

async function runTool(plugin, list, name, args) {
  if (name === 'cerca') {
    const ids = await plugin.librarySearch.search(list, String(args.parole || ''), { symbol: args.pubblicazione });
    return ids.length ? sourceLines(list, ids) : t('Nessun paragrafo trovato: prova altre parole.');
  }
  if (name === 'versetto') {
    const bible = plugin.bible;
    await bible.ensureLoaded();
    const ref = bible.parseReference(String(args.riferimento || ''));
    if (!ref || ref.invalid || !ref.chapter || !ref.verse) return t('Riferimento non riconosciuto: scrivilo come "Giovanni 3:16".');
    // ponytail: tetto per chiamata alzando quello della lista, così i numeri F restano unici in tutta la conversazione.
    const start = list.items.length;
    const budget = list.budget;
    list.budget = Math.min(budget, list.chars + 15000);
    try {
      await addScriptureSources(plugin, [ref], list, '', { maxVerses: 5, citesFirst: true });
    } finally {
      list.budget = budget;
    }
    const ids = list.items.slice(start).map((x) => x.id);
    return ids.length ? sourceLines(list, ids) : t('Niente di nuovo su questo versetto (forse è già tra le fonti).');
  }
  return t('Strumento sconosciuto: {name}', { name });
}

/**
 * Una domanda nella chat: l'AI fa le sue ricerche (dice a che punto è con `status`) e risponde con le fonti [F…].
 * La conversazione (messaggi e fonti) resta in chat.ctx fino a "Nuova conversazione".
 */
async function askLibrary(plugin, chat, question, status) {
  const st = chat.ctx || (chat.ctx = { sources: new SourceList(400000), messages: [] });
  const meta = plugin.librarySearch && plugin.librarySearch.reader && plugin.librarySearch.reader.meta;
  const system = withUserStyle(plugin, t(CHAT_SYSTEM) + (meta && meta.noteTotal ? t(NOTES_HINT) : ''));
  st.messages.push({ role: 'user', content: question });
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const json = await openRouter(plugin, {
      messages: [{ role: 'system', content: system }, ...st.messages],
      tools: chatTools(),
      // All'ultimo giro deve rispondere con quello che ha trovato.
      ...(round === MAX_ROUNDS - 1 ? { tool_choice: 'none' } : {}),
    });
    const msg = json.choices && json.choices[0] && json.choices[0].message;
    if (!msg) throw new Error(t('Risposta vuota dal modello'));
    const calls = msg.tool_calls || [];
    st.messages.push({ role: 'assistant', content: msg.content || null, ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) {
      if (!msg.content) throw new Error(t('Risposta vuota dal modello'));
      return { testo: String(msg.content).trim(), ctx: st };
    }
    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse((call.function && call.function.arguments) || '{}');
      } catch (e) {
        /* argomenti non leggibili: lo strumento risponde che mancano */
      }
      const name = call.function && call.function.name;
      status(name === 'versetto' ? t('Leggo {ref}…', { ref: args.riferimento || t('il versetto') }) : t('Cerco: {w}', { w: args.parole || '…' }) + (args.pubblicazione ? ` (${args.pubblicazione})` : ''));
      let out;
      try {
        out = await runTool(plugin, st.sources, name, args);
      } catch (e) {
        out = t('Errore: {e}', { e: e.message || e });
      }
      st.messages.push({ role: 'tool', tool_call_id: call.id, content: out });
    }
  }
  throw new Error(t('Il modello non ha dato una risposta'));
}

/* ---------------- la vista ---------------- */

class LibraryChatView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.chat = { turns: [] };
    this.building = false;
  }

  getViewType() {
    return CHAT_VIEW_TYPE;
  }

  getIcon() {
    return 'messages-square';
  }

  getDisplayText() {
    return t('Chiedi alla biblioteca');
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('lmp-chat-view');
    // Stessa barra delle altre sezioni: Indietro, selettore, titolo.
    const tb = root.createDiv('lmp-toolbar');
    this.backBtn = tb.createEl('button', { cls: 'lmp-tb-btn clickable-icon', attr: { 'aria-label': t('Indietro') } });
    setIcon(this.backBtn, 'arrow-left');
    this.backBtn.addEventListener('click', () => this.inShell && this.inShell.goBack());
    this.backBtn.toggle(!!this.inShell);
    addViewSwitch(tb, this.plugin, 'chat', () => {}, this.inShell);
    tb.createDiv({ cls: 'lmp-tb-title', text: Platform.isPhone ? t('Chiedi') : t('Chiedi alla biblioteca') });
    this.bodyEl = root.createDiv('lmp-chat');
    await (this.rendering = this.render());
  }

  snapshot() {
    return {};
  }

  async render() {
    const el = this.bodyEl;
    el.empty();
    this.canAsk = false;
    const info = el.createDiv('lmp-chat-info');
    const search = this.plugin.librarySearch;
    let reader = null;
    try {
      reader = await search.open();
    } catch (e) {
      console.warn('[lampada] indice della chat non leggibile', e);
    }
    if (reader) {
      const m = reader.meta;
      const docs = await search.docs().catch(() => []);
      const fresh = docs.length - (m.docTotal || 0);
      const folders = search.folders();
      const moved = folders.join('\n') !== (m.folders || []).join('\n');
      // Indice fatto con le parole di un'altra lingua (senza lang = italiano, indici di prima).
      const otherLang = (m.lang || 'it') !== contentLang(this.plugin.settings);
      const n = (x) => x.toLocaleString(lang());
      const parts = [
        t('Cerco in {n} paragrafi di {docs} documenti', { n: n(m.count), docs: n((m.docs || []).length) }) + (m.noteTotal ? ` ${t('({n} sono tue note)', { n: n(m.noteTotal) })}` : ''),
        t('indice del {date}', { date: new Date(m.built).toLocaleDateString(lang()) }),
      ];
      if (fresh > 0) parts.push(t('{n} documenti nuovi da aggiungere', { n: fresh }));
      if (moved) parts.push(t('le cartelle delle note sono cambiate: aggiorna l’indice'));
      if (otherLang) parts.push(t('la lingua dei contenuti è cambiata: aggiorna l’indice'));
      info.createSpan({ text: parts.join(' · ') });
    } else info.createSpan({ text: t('Per cercare nelle pubblicazioni serve l’indice delle parole (circa 30 MB, {time}). Creato su un dispositivo, arriva sugli altri con la sincronizzazione.', { time: Platform.isMobile ? t('qualche minuto sul telefono') : t('qualche secondo') }) });
    const btn = info.createEl('button', { cls: 'lmp-small-btn', text: this.building ? t('Creo l’indice…') : reader ? t('Aggiorna l’indice') : t('Crea l’indice') });
    btn.disabled = this.building;
    btn.addEventListener('click', () => this.buildIndex());
    if (!reader) return;
    el.appendChild(renderAskBox(this.plugin, null, this.chat, (x) => this.openSource(x), t('Chiedi qualcosa alle pubblicazioni…'), { ask: (q, chat, status) => askLibrary(this.plugin, chat, q, status) }));
    this.canAsk = true;
    const input = el.querySelector('textarea');
    if (input && !Platform.isMobile) input.focus();
  }

  /** Fa subito una domanda (da "Cerca o chiedi"): come scriverla nel campo e premere invio. */
  async askNow(q) {
    await this.rendering;
    const input = this.bodyEl.querySelector('.lmp-ai-ask-input');
    const send = this.bodyEl.querySelector('.lmp-ai-ask-send');
    if (!this.canAsk || !input || !send) return;
    input.value = q;
    send.click();
  }

  async buildIndex() {
    if (this.building) return;
    this.building = true;
    await this.render();
    const notice = new Notice(t('Creo l’indice…'), 0);
    try {
      const t0 = Date.now();
      const meta = await this.plugin.librarySearch.build((s) => notice.setMessage(s));
      notice.setMessage(t('Indice pronto: {n} paragrafi in {s} s', { n: meta.count.toLocaleString(lang()), s: Math.round((Date.now() - t0) / 1000) }));
    } catch (e) {
      console.error('[lampada] indice della chat', e);
      notice.setMessage(t('Indice non creato: {e}', { e: e.message || e }));
    }
    setTimeout(() => notice.hide(), 5000);
    this.building = false;
    await this.render();
  }

  /** Fonte toccata: paragrafo nella biblioteca, versetto nella Bibbia, nota alla sua riga. */
  async openSource(t) {
    if (!t) return;
    if (t.verse) return this.plugin.openReader(t.verse);
    if (t.note) {
      const f = this.app.vault.getAbstractFileByPath(t.note);
      return f instanceof TFile ? this.plugin.openNoteAt(f, t.line) : this.app.workspace.openLinkText(t.note, '', true);
    }
    const lib = this.plugin.library;
    await lib.ensureLoaded();
    const d = t.cite && lib.byFile.get(t.cite);
    if (d) return this.plugin.openLibraryDoc(d, t.par);
    if (t.cite) this.app.workspace.openLinkText(t.par ? `${t.cite}#^p${t.par}` : t.cite, '', true);
  }
}

export { CHAT_VIEW_TYPE, LibraryChatView, LibrarySearch, askLibrary };
