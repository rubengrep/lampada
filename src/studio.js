import { Menu, Modal, Notice, requestUrl, setIcon } from 'obsidian';
import { fileMeta, mdFiles, readFile } from './file.js';
import { codesFromJwUrl, norm, parseRefLinks, refFromCodes, stripFrontmatter } from './testo.js';

/* ------------------------------------------------------------------ */
/* Studio di una parola, racconti paralleli, commenti con l'AI         */
/* ------------------------------------------------------------------ */

/** Minuscole senza accenti, apostrofo unico: un carattere resta un carattere (serve per evidenziare). */
const fold = (s) => [...String(s)].map((c) => norm(c).replace(/[’‘`]/g, "'")[0] || c).join('');

/** "peccati" → radice "peccat" (trova peccato, peccatore…); parole corte e frasi restano intere. */
function wordKey(word) {
  const w = fold(word).replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!w) return null;
  const stem = !w.includes(' ') && w.length > 4 ? w.replace(/[aeiou]+$/, '') : w;
  const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { word: w, re: new RegExp(`(^|[^a-z])(${esc}${stem === w ? '' : '[a-z]*'})(?![a-z])`, 'g') };
}

function matches(key, s) {
  key.re.lastIndex = 0;
  return key.re.test(fold(s));
}

/** Pezzi di testo con le parole trovate: [{ s, hit }]. */
function highlightParts(key, text) {
  const f = fold(text);
  const out = [];
  let last = 0;
  key.re.lastIndex = 0;
  let m;
  while ((m = key.re.exec(f))) {
    const start = m.index + m[1].length;
    if (start > last) out.push({ s: text.slice(last, start) });
    out.push({ s: text.slice(start, start + m[2].length), hit: true });
    last = start + m[2].length;
  }
  if (last < text.length) out.push({ s: text.slice(last) });
  return out;
}

const cache = new WeakMap();
function memo(plugin, name, fn) {
  let c = cache.get(plugin);
  if (!c) cache.set(plugin, (c = {}));
  if (!c[name]) c[name] = fn().catch((e) => {
    delete c[name];
    throw e;
  });
  return c[name];
}

function filesIn(plugin, folder) {
  const prefix = `${plugin.bible.prefix}${folder}/`;
  return mdFiles(plugin.app, prefix);
}

/** Titoli di Glossario e Perspicacia. */
function titleIndex(plugin) {
  return memo(plugin, 'titles', async () => {
    const out = {};
    // Nelle cartelle nascoste il frontmatter non è in memoria: il titolo viene dall'indice della biblioteca.
    await plugin.library.ensureLoaded().catch(() => null);
    const byFile = plugin.library.byFile;
    for (const [k, folder] of [['glossario', 'nwtstg'], ['perspicacia', 'it']]) {
      out[k] = filesIn(plugin, folder).map((file) => ({ file, title: fileMeta(plugin.app, file)?.frontmatter?.title || byFile?.get(file.basename)?.title || file.basename }));
    }
    return out;
  });
}

/** Note di studio della Bibbia per lo studio: una voce per parola spiegata ("**spirito** O “forza attiva”…"). */
function studyNoteIndex(plugin) {
  return memo(plugin, 'notes', async () => {
    const out = [];
    for (const file of filesIn(plugin, 'nwtsty/Approfondimenti')) {
      let code = null;
      for (const line of stripFrontmatter(await readFile(plugin.app, file)).split('\n')) {
        const v = /^\[[\d:,\s-]+\]\((jwlibrary:[^)]+)\)\s*\^p\d+\s*$/.exec(line);
        if (v) {
          code = codesFromJwUrl(v[1]);
          continue;
        }
        const n = /^\*\*(.+?)\*\*.*\^(p\d+)\s*$/.exec(line);
        if (n && code) out.push({ head: n[1].replace(/\\/g, ''), ref: refFromCodes(code[0]), file, id: n[2] });
      }
    }
    return out;
  });
}

/** Prima il titolo identico, poi quelli che iniziano con la parola, poi gli altri. */
const titleRank = (key, t) => (fold(t) === key.word ? 0 : fold(t).startsWith(key.word.slice(0, 4)) ? 1 : 2);
const bestTitles = (key, list) =>
  list.filter((x) => matches(key, x.title)).sort((a, b) => titleRank(key, a.title) - titleRank(key, b.title) || a.title.length - b.title.length);

/** Prima riga di testo vera di un articolo, senza link e codici dei paragrafi. */
function leadText(md) {
  const lines = stripFrontmatter(md)
    .split('\n')
    .map((l) => l.replace(/\s*\^[\w-]+\s*$/, '').replace(/!?\[\[[^\]|]*\|?([^\]]*)\]\]/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_]/g, '').trim())
    .filter((l) => l && !/^(#|!|>|\||---)/.test(l));
  const t = lines.find((l) => l.length > 60) || lines[0] || '';
  return t.length > 240 ? `${t.slice(0, 240).replace(/\s+\S*$/, '')}…` : t;
}

/** Definizione breve per il tocco lungo su una parola: la voce del Glossario, altrimenti Perspicacia (solo titoli vicini). */
async function quickDefinition(plugin, word) {
  const key = wordKey(word);
  if (!key || key.word.includes(' ') || key.word.length < 3) return null;
  const titles = await titleIndex(plugin);
  for (const [k, source] of [['glossario', 'Glossario'], ['perspicacia', 'Perspicacia']]) {
    const hit = bestTitles(key, titles[k]).find((x) => titleRank(key, x.title) < 2);
    if (hit) return { title: hit.title, source, file: hit.file, text: leadText(await readFile(plugin.app, hit.file)) };
  }
  return null;
}

async function wordStudy(plugin, word) {
  const key = wordKey(word);
  if (!key) return null;
  const [titles, notes] = await Promise.all([titleIndex(plugin), studyNoteIndex(plugin)]);
  const byTitle = (list, max) => bestTitles(key, list).slice(0, max);
  return {
    key,
    glossario: byTitle(titles.glossario, 4),
    perspicacia: byTitle(titles.perspicacia, 12),
    notes: notes.filter((n) => matches(key, n.head)).sort((a, b) => a.ref.book - b.ref.book || a.ref.chapter - b.ref.chapter || (a.ref.verse || 0) - (b.ref.verse || 0)),
  };
}

/* ---------------- racconti paralleli (appendice A7) ---------------- */

const GOSPELS = [40, 41, 42, 43];

/**
 * Eventi della vita di Gesù dalle tabelle A7 della Bibbia per lo studio: luogo, avvenimento e quattro celle
 * (Matteo, Marco, Luca, Giovanni). Le celle vuote sono righe con un solo spazio indivisibile.
 */
function parallelEvents(plugin) {
  return memo(plugin, 'parallels', async () => {
    const files = filesIn(plugin, 'nwtsty/Appendici')
      .filter((f) => /^nwtsty_a7-/.test(f.basename))
      .sort((a, b) => a.basename.localeCompare(b.basename));
    const events = [];
    for (const file of files) {
      const items = [];
      for (const raw of stripFrontmatter(await readFile(plugin.app, file)).split('\n')) {
        const t = raw.replace(/\s*\^p\d+\s*$/, '');
        if (/^ \s*$/.test(t)) items.push({ cell: [] });
        else if (/^\[.*bible=/.test(t.trim())) {
          const refs = [];
          for (const m of t.matchAll(/\(jwlibrary:[^)]*bible=(\d+)(?:-(\d+))?\)/g)) refs.push(refFromCodes(m[1], m[2]));
          items.push({ cell: refs });
        } else if (t.trim()) items.push({ text: t.trim() });
      }
      let place = '';
      for (let i = 0; i < items.length; i++) {
        const x = items[i];
        if (!x.text) continue;
        const cells = items.slice(i + 1, i + 5);
        if (cells.length === 4 && cells.every((c) => c.cell)) {
          const prev = items[i - 1];
          if (prev && prev.text && !/^\*\*/.test(prev.text)) place = prev.text;
          events.push({ title: x.text, place, refs: cells.map((c) => c.cell) });
          i += 4;
        }
      }
    }
    return events;
  });
}

/** Eventi che iniziano in questo capitolo del Vangelo: versetto → eventi. */
async function parallelsInChapter(plugin, book, chapter) {
  const col = GOSPELS.indexOf(book);
  if (col < 0) return new Map();
  const out = new Map();
  for (const e of await parallelEvents(plugin)) {
    const others = e.refs.filter((r, i) => i !== col && r.length).length;
    if (!others) continue;
    for (const r of e.refs[col]) {
      if (r.chapter !== chapter) continue;
      const v = r.verse || 1;
      if (!out.has(v)) out.set(v, []);
      out.get(v).push(e);
    }
  }
  return out;
}

class ParallelModal extends Modal {
  constructor(plugin, event, currentBook) {
    super(plugin.app);
    this.plugin = plugin;
    this.event = event;
    this.currentBook = currentBook;
  }

  async onOpen() {
    const { contentEl, modalEl } = this;
    const bible = this.plugin.bible;
    modalEl.addClass('lmp-par-modal');
    this.titleEl.setText(this.event.title);
    if (this.event.place) contentEl.createDiv({ cls: 'lmp-par-place', text: this.event.place });
    const grid = contentEl.createDiv('lmp-par-grid');
    this.event.refs.forEach((refs, i) => {
      if (!refs.length) return;
      const col = grid.createDiv('lmp-par-col');
      if (GOSPELS[i] === this.currentBook) col.addClass('is-current');
      for (const ref of refs) {
        const head = col.createEl('button', { cls: 'lmp-par-head', text: bible.refLabel(ref), attr: { 'aria-label': 'Apri nella Bibbia' } });
        head.addEventListener('click', () => {
          this.close();
          this.plugin.openReader(ref);
        });
        const body = col.createDiv('lmp-par-text');
        bible
          .getChapter(ref.book, ref.chapter)
          .then((data) => {
            const list = ref.verse ? bible.versesOf(ref) : [...data.verseLines.keys()];
            for (const v of list) {
              const p = body.createDiv('lmp-par-verse');
              p.createSpan({ cls: 'lmp-par-vnum', text: String(v) });
              p.appendText(' ' + bible.verseText(data, v));
            }
          })
          .catch(() => body.setText('Testo non trovato.'));
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ---------------- AI (OpenRouter) ---------------- */

const AI_DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';

/** Codice breve e stabile di un testo (per tenere sullo stesso fornitore le richieste sullo stesso articolo). */
function textKey(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Una richiesta a OpenRouter con `body` (messages, tools…); il modello è quello delle impostazioni. → risposta JSON */
async function openRouter(plugin, body) {
  const key = (plugin.settings.openrouterKey || '').trim();
  if (!key) throw new Error('Manca la chiave OpenRouter: Impostazioni → Lampada → Intelligenza artificiale.');
  const res = await requestUrl({
    url: 'https://openrouter.ai/api/v1/chat/completions',
    method: 'POST',
    contentType: 'application/json',
    throw: false,
    headers: { Authorization: `Bearer ${key}`, 'X-Title': 'Lampada' },
    body: JSON.stringify({ model: (plugin.settings.aiModel || '').trim() || AI_DEFAULT_MODEL, ...body }),
  });
  let json = null;
  try {
    json = res.json;
  } catch (e) {
    /* risposta non JSON */
  }
  const msg = (json && json.error && json.error.message) || `OpenRouter ha risposto ${res.status}`;
  if (res.status === 401) throw new Error(`Chiave OpenRouter non valida (${msg})`);
  if (res.status === 402) throw new Error(`Credito OpenRouter esaurito (${msg})`);
  if (res.status >= 400 || !json) throw new Error(msg);
  const u = json.usage || {};
  const det = u.prompt_tokens_details || {};
  if (u.prompt_tokens) console.debug(`[lampada] AI: ${u.prompt_tokens} token in ingresso, ${det.cached_tokens || 0} letti dalla cache, ${det.cache_write_tokens || 0} scritti in cache`);
  return json;
}

/**
 * Una richiesta a OpenRouter (API compatibile OpenAI). requestUrl di Obsidian funziona anche su iPad e telefono,
 * dove fetch verso un altro dominio sarebbe bloccato.
 * `user` è un testo o una lista di parti { text, cache }: le parti con `cache` (l'articolo, uguale per tutte le domande)
 * restano in cache un'ora da Anthropic. Le domande dopo la prima rileggono l'articolo a circa il 5% del prezzo e
 * rispondono prima. `session_id` fa arrivare le richieste sullo stesso fornitore, dove la cache c'è.
 */
async function aiChat(plugin, system, user) {
  const json = await openRouter(plugin, {
    messages: [
      { role: 'system', content: withUserStyle(plugin, system) },
      {
        role: 'user',
        content: Array.isArray(user)
          ? user.map((p) => (p.cache ? { type: 'text', text: p.text, cache_control: { type: 'ephemeral', ttl: '1h' } } : { type: 'text', text: p.text }))
          : user,
      },
    ],
    ...(Array.isArray(user) && user.some((p) => p.cache) ? { session_id: `lmp-${textKey(user.filter((p) => p.cache).map((p) => p.text).join(''))}` } : {}),
  });
  const text = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!text) throw new Error('Risposta vuota dal modello');
  return text;
}

/** Istruzioni personali (Impostazioni → Intelligenza artificiale) in fondo al prompt di sistema. */
function withUserStyle(plugin, system) {
  const own = String(plugin.settings.aiInstructions || '').trim();
  return own ? `${system}\n\nISTRUZIONI DELL'UTENTE (valgono per lo stile, non cambiano il formato della risposta né l'uso delle fonti):\n${own}` : system;
}

/* ---------------- spunti per il commento ---------------- */

const DEFAULT_PRESETS = `Commento breve: un commento breve e diretto che risponde alla domanda.
Su una scrittura: un commento che mostra come una delle scritture citate risponde alla domanda.
Dettaglio in più: un commento con un dettaglio che arricchisce, preso dalle note di studio, dai riferimenti o dalle pubblicazioni che citano le scritture.
Applicazione pratica: un commento su come mettere in pratica il punto del paragrafo nella vita di tutti i giorni.
Esempio biblico: un commento con un esempio o un personaggio biblico che illustra il punto, preso dalle fonti.`;

/** Prompt rapidi: elenco [{ name, prompt }] dalle impostazioni, oppure testo "Nome: istruzione" per riga; vuoto = predefiniti. */
function parsePresets(text) {
  if (Array.isArray(text) && text.length) return text.map((p) => ({ name: String(p.name || '').trim(), prompt: String(p.prompt || '').trim() || String(p.name || '').trim() })).filter((p) => p.name);
  return ((typeof text === 'string' && text.trim()) || DEFAULT_PRESETS)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(':');
      return i > 0 ? { name: l.slice(0, i).trim(), prompt: l.slice(i + 1).trim() } : { name: l, prompt: l };
    });
}

/** Markdown delle pubblicazioni → testo semplice. */
function plain(md) {
  return String(md || '')
    .replace(/!\[\[[^\]]*\]\]/g, '')
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s*\^p\d+[ \t]*$/gm, '')
    .replace(/\\([\\`*_\[\]().!-])/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/^\s*(?:#+|[-*])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fonti numerate (F1, F2…) da dare al modello: testo, etichetta da mostrare e dove portarti se la tocchi.
 * ponytail: tetto di caratteri fisso; oltre si tralasciano le fonti meno vicine (prima cadono i "Citato in").
 */
class SourceList {
  constructor(budget = 200000) {
    this.items = [];
    this.chars = 0;
    this.budget = budget;
    this.skipped = 0;
    this.seen = new Map();
  }

  add(label, text, target) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const key = `${label}\n${text}`;
    if (this.seen.has(key)) return this.seen.get(key);
    if (this.chars + text.length > this.budget) {
      this.skipped++;
      return null;
    }
    this.chars += text.length;
    const id = `F${this.items.length + 1}`;
    this.items.push({ id, label, text, target });
    this.seen.set(key, id);
    return id;
  }
}

/**
 * Per le scritture citate: testo di ogni versetto, note di studio, note in calce, riferimenti a margine (Bibbia per lo
 * studio e Bibbia con riferimenti, con il testo) e i paragrafi delle pubblicazioni in "Citato in".
 * `citesFirst`: i "Citato in" prima dei riferimenti a margine (se le fonti superano il tetto cadono questi).
 */
async function addScriptureSources(plugin, refs, list, skipFile, { maxVerses = 40, citesFirst = false } = {}) {
  const bible = plugin.bible;
  const verses = [];
  for (const ref of refs)
    for (const v of bible.versesOf(ref))
      if (verses.length < maxVerses && !verses.some((x) => x.book === ref.book && x.chapter === ref.chapter && x.verse === v)) verses.push({ book: ref.book, chapter: ref.chapter, verse: v });
  const details = await Promise.all(
    verses.map(async (r) => {
      const book = bible.byNum.get(r.book);
      const [data, det, rbi] = await Promise.all([
        bible.getChapter(r.book, r.chapter).catch(() => null),
        book ? bible.getVerseDetails(book, r.chapter, r.verse).catch(() => null) : null,
        plugin.rbi8Verse ? plugin.rbi8Verse(r.book, r.chapter, r.verse).catch(() => null) : null,
      ]);
      return { r, label: bible.refLabel(r), text: data ? bible.verseText(data, r.verse) : '', sections: (det && det.sections) || [], src: det && det.file ? det.file.path : '', rbi };
    })
  );
  const sec = (d, t) => (d.sections.find((s) => s.title === t) || {}).body || '';

  // 1. versetti, note di studio, note in calce
  for (const d of details) {
    list.add(d.label, d.text, { verse: d.r });
    const study = sec(d, 'Approfondimenti');
    const embeds = [...study.matchAll(/!\[\[([^\]#|]+)#\^([^\]|]+)/g)];
    for (const m of embeds) {
      const b = await bible.getBlock(m[1], m[2], d.src).catch(() => null);
      if (b) list.add(`Nota di studio a ${d.label}`, plain(b.md), { verse: d.r });
    }
    if (!embeds.length && study) list.add(`Nota di studio a ${d.label}`, plain(study), { verse: d.r });
    const fn = sec(d, 'Note in calce');
    if (fn) list.add(`Note in calce a ${d.label}`, plain(fn), { verse: d.r });
    // Didascalie delle immagini ("*…*" sotto ogni immagine)
    for (const m of sec(d, 'Media').matchAll(/^\s*\*(.+)\*\s*$/gm)) list.add(`Immagine a ${d.label}`, plain(m[1]), { verse: d.r });
  }

  // 2. riferimenti a margine, con il loro testo
  const marginRefs = async () => {
    const seen = new Set(details.map((d) => d.label));
    for (const d of details) {
      const more = parseRefLinks(sec(d, 'Riferimenti')).map((x) => x.ref || bible.refFromLinkpath(x.link));
      for (const [, , rr] of (d.rbi && d.rbi.r) || []) for (const [a, b] of rr) more.push(refFromCodes(a, b || undefined));
      for (const r2 of more) {
        if (!r2 || !r2.chapter || !r2.verse) continue;
        const lbl = bible.refLabel(r2);
        if (seen.has(lbl)) continue;
        seen.add(lbl);
        const p = await bible.previewRef(r2, lbl).catch(() => null);
        if (p && p.text) list.add(`Riferimento a margine di ${d.label}: ${lbl}`, p.text, { verse: r2 });
      }
    }
  };

  // 3. "Citato in": il paragrafo della pubblicazione che cita il versetto
  const citedIn = async () => {
    const pubs = await bible.docPublications().catch(() => new Map());
    const seenCite = new Set();
    for (const d of details) {
      for (const line of sec(d, 'Citato in').split('\n')) {
        const head = /\[\[([^\]|#]+)(?:\|([^\]]*))?\]\]/.exec(line);
        if (!head) continue;
        const file = head[1].trim();
        // L'articolo stesso e l'Indice delle pubblicazioni (solo elenchi di rimandi) non servono.
        if (file === skipFile || /^dx/.test(file) || /^Indice/.test(pubs.get(file) || '')) continue;
        const title = (head[2] || file).trim();
        for (const m of line.matchAll(/#\^p(\d+)/g)) {
          const key = `${file}#${m[1]}`;
          if (seenCite.has(key)) continue;
          seenCite.add(key);
          const b = await bible.getBlock(file, `p${m[1]}`, '').catch(() => null);
          if (b) list.add(`${pubs.get(file) ? `${pubs.get(file)}, ` : ''}«${title}» ¶${m[1]} (cita ${d.label})`, plain(b.md), { cite: file, par: +m[1] });
        }
      }
    }
  };

  for (const step of citesFirst ? [citedIn, marginRefs] : [marginRefs, citedIn]) await step();
}

// Uguale per spunti e domande: così l'articolo in cache (subito dopo) serve a tutte e due.
const AI_SYSTEM = `Aiuti un Testimone di Geova a prepararsi alle adunanze e a studiare la Bibbia e le pubblicazioni.
Ricevi l'articolo intero (o il capitolo della Bibbia) e molte fonti numerate [F1], [F2]…: paragrafi, versetti, note di studio, note in calce, riferimenti a margine, paragrafi di pubblicazioni che citano le scritture, note personali. Le fonti possono essere in due elenchi (quelle dell'articolo e quelle per questa richiesta), con la stessa numerazione.
Usa SOLO le fonti fornite. Non aggiungere informazioni, interpretazioni o spiegazioni che non ci sono.
Il COMPITO alla fine del messaggio dice cosa fare e in che formato rispondere.`;

const COMMENT_TASK = `Proponi 3 commenti diversi tra loro, secondo la RICHIESTA.
- Ogni commento risponde alla domanda, in prima persona, con parole semplici e naturali, come si parla in sala: 1-3 frasi, al massimo 50 parole (circa 30 secondi), salvo richiesta diversa.
- Non ripetere il paragrafo parola per parola: riformula.
- Per ogni commento indica in "fonti" gli identificativi delle fonti che hai usato (es. "F3"), dalla più importante.
Rispondi solo con JSON, senza altro testo: {"commenti":[{"testo":"...","fonti":["F3","F12"]}]}`;

const ASK_TASK = `Rispondi alla DOMANDA in italiano semplice e chiaro, in 2-6 frasi.
- Dopo ogni affermazione metti tra parentesi quadre la fonte da cui la prendi (es. [F3]).
- Se le fonti non bastano per rispondere, dillo chiaramente invece di indovinare.
Rispondi solo con JSON, senza altro testo: {"risposta":"...","fonti":["F3","F12"]}`;

/**
 * Messaggio per il modello: titolo e fonti, poi `middle` (domanda, paragrafi, note…) e `tail` (richiesta e compito).
 * Con `ctx.shared` le prime fonti (articolo o capitolo) vanno in una parte a sé, prima di tutto il resto, che resta in
 * cache: deve essere identica, carattere per carattere, in ogni richiesta sullo stesso articolo.
 */
function aiMessage(ctx, middle, tail) {
  const line = (x) => `[${x.id}] (${x.label}) ${x.text}`;
  const items = ctx.sources.items;
  const shared = ctx.shared > 0 ? Math.min(ctx.shared, items.length) : 0;
  if (!shared) return [`ARTICOLO: ${ctx.title}`, ...middle, `FONTI:\n${items.map(line).join('\n')}`, ...tail].join('\n\n');
  const rest = shared < items.length ? [`FONTI PER QUESTA RICHIESTA:\n${items.slice(shared).map(line).join('\n')}`] : [];
  return [
    { text: `ARTICOLO: ${ctx.title}\n\nFONTI DELL'ARTICOLO:\n${items.slice(0, shared).map(line).join('\n')}`, cache: true },
    { text: [...middle, ...rest, ...tail].join('\n\n') },
  ];
}

/** Risposta JSON del modello → oggetto (anche se c'è del testo intorno). */
function aiJson(text) {
  const m = /\{[\s\S]*\}/.exec(text);
  try {
    return m ? JSON.parse(m[0]) : null;
  } catch (e) {
    return null;
  }
}

const sourcesOf = (ctx, ids) => {
  const byId = new Map(ctx.sources.items.map((x) => [x.id, x]));
  return (Array.isArray(ids) ? ids : []).map((id) => byId.get(String(id).replace(/[[\]\s]/g, ''))).filter(Boolean);
};

async function suggestComments(plugin, ctx, preset) {
  const src = (ids) => ids.map((id) => `[${id}]`).join(' ');
  const middle = [];
  // Senza domanda (un paragrafo qualsiasi, una parte del programma): si commenta il punto principale.
  middle.push(`DOMANDA DA COMMENTARE: ${ctx.question || 'nessuna domanda stampata: commenta il punto principale dei paragrafi indicati'}`);
  middle.push(
    `PARAGRAFI DELLA DOMANDA: ${
      ctx.review ? 'domanda di ripasso: la risposta riassume il punto dell’articolo che la riguarda, cercalo nei paragrafi' : src(ctx.paragraphIds) || '(vedi articolo)'
    }`
  );
  if (ctx.focus) middle.push(`TESTO SELEZIONATO (i commenti partono da qui): «${ctx.focus}»`);
  if (ctx.notes && ctx.notes.length) middle.push(`MIE NOTE SU QUESTI PARAGRAFI:\n${ctx.notes.join('\n')}`);
  const text = await aiChat(plugin, AI_SYSTEM, aiMessage(ctx, middle, [`RICHIESTA: ${preset.prompt}`, `COMPITO:\n${COMMENT_TASK}`]));
  const json = aiJson(text);
  const list = json && json.commenti;
  if (!Array.isArray(list) || !list.length) throw new Error('Il modello non ha restituito commenti leggibili');
  return list.filter((c) => c && c.testo).map((c) => ({ testo: String(c.testo).trim(), fonti: sourcesOf(ctx, c.fonti) }));
}

/**
 * Una domanda libera su un paragrafo (o sui versetti scelti), con le domande e risposte precedenti della stessa
 * conversazione. Stesso contesto (e stessa cache) degli spunti. → { testo, fonti }
 */
async function askAboutSources(plugin, ctx, question, history = []) {
  const src = (ids) => ids.map((id) => `[${id}]`).join(' ');
  const middle = [];
  if (ctx.paragraphIds && ctx.paragraphIds.length) middle.push(`PARAGRAFI DI CUI SI PARLA: ${src(ctx.paragraphIds)}`);
  if (ctx.question) middle.push(`DOMANDA STAMPATA PER QUESTI PARAGRAFI: ${ctx.question}`);
  if (ctx.focus) middle.push(`TESTO SELEZIONATO: «${ctx.focus}»`);
  if (ctx.notes && ctx.notes.length) middle.push(`MIE NOTE SU QUESTI PARAGRAFI:\n${ctx.notes.join('\n')}`);
  if (history.length) middle.push(`DOMANDE E RISPOSTE PRECEDENTI:\n${history.slice(-6).map((h) => `D: ${h.q}\nR: ${h.a}`).join('\n')}`);
  const text = await aiChat(plugin, AI_SYSTEM, aiMessage(ctx, middle, [`DOMANDA: ${String(question).trim()}`, `COMPITO:\n${ASK_TASK}`]));
  const json = aiJson(text);
  if (!json || !json.risposta) throw new Error('Il modello non ha restituito una risposta leggibile');
  return { testo: String(json.risposta).trim(), fonti: sourcesOf(ctx, json.fonti) };
}

/** Testo della risposta → pezzi di testo e fonti citate ("… [F3] …"), per mostrare le fonti dentro il testo. */
function splitCited(text, ctx) {
  const byId = new Map(ctx.sources.items.map((x) => [x.id, x]));
  const out = [];
  for (const piece of String(text).split(/(\[F\d+(?:\s*,\s*F\d+)*\])/)) {
    const ids = /^\[(F\d+(?:\s*,\s*F\d+)*)\]$/.exec(piece);
    if (!ids) {
      if (piece) out.push({ t: piece });
      continue;
    }
    for (const id of ids[1].split(/\s*,\s*/)) if (byId.has(id)) out.push({ src: byId.get(id) });
  }
  return out;
}

/**
 * Domande libere all'AI su un paragrafo: le domande fatte, le risposte con le fonti toccabili e il campo per chiedere.
 * `chat` ({ turns: [] }) lo tiene chi chiama, così la conversazione resta quando il pannello si ridisegna.
 * Restituisce il riquadro (da mettere nel pannello).
 */
function renderAskBox(plugin, getCtx, chat, onSource, placeholder = 'Chiedi qualcosa su questo paragrafo…', { ask: askFn } = {}) {
  const box = createDiv('lmp-ai-ask');
  const list = box.createDiv('lmp-ai-ask-list');
  const turnEl = (t) => {
    const el = createDiv('lmp-ai-ask-turn');
    el.createDiv({ cls: 'lmp-ai-ask-q', text: t.q });
    const a = el.createDiv('lmp-ai-ask-a');
    if (t.error) {
      a.addClass('is-error');
      a.setText(t.error);
    } else if (!t.a) {
      a.addClass('is-loading');
      a.setText(t.status || 'Sto cercando nelle fonti…');
    } else {
      for (const p of t.parts) {
        if (p.t) a.appendText(p.t);
        else {
          const chip = a.createEl('button', { cls: 'lmp-ai-src lmp-ai-src-inline', text: p.src.label, attr: { 'aria-label': p.src.text.slice(0, 300) } });
          chip.addEventListener('click', () => onSource(p.src.target, t.ctx));
        }
      }
      const copy = el.createEl('button', { cls: 'lmp-small-btn lmp-ai-ask-copy', text: 'Copia' });
      copy.addEventListener('click', async () => {
        await navigator.clipboard.writeText(t.a.replace(/\s*\[F\d+(?:\s*,\s*F\d+)*\]/g, ''));
        new Notice('Risposta copiata');
      });
    }
    return el;
  };
  const draw = () => {
    list.empty();
    for (const t of chat.turns) list.appendChild(turnEl(t));
    clear.toggleClass('is-hidden', !chat.turns.length);
    input.setAttr('placeholder', chat.turns.length ? 'Un’altra domanda…' : placeholder);
  };
  const form = box.createDiv('lmp-ai-ask-form');
  const input = form.createEl('textarea', { cls: 'lmp-ai-ask-input', attr: { rows: '1', 'aria-label': placeholder } });
  const send = form.createEl('button', { cls: 'clickable-icon lmp-ai-ask-send', attr: { 'aria-label': 'Chiedi' } });
  setIcon(send, 'send');
  const clear = form.createEl('button', { cls: 'clickable-icon lmp-ai-ask-clear', attr: { 'aria-label': 'Nuova conversazione' } });
  setIcon(clear, 'rotate-ccw');
  clear.addEventListener('click', () => {
    if (chat.busy) return;
    chat.turns = [];
    chat.ctx = null;
    draw();
  });
  const ask = async () => {
    const q = input.value.trim();
    if (!q || chat.busy) return;
    input.value = '';
    chat.busy = true;
    const t = { q };
    const history = chat.turns.filter((x) => x.a).map((x) => ({ q: x.q, a: x.a }));
    chat.turns.push(t);
    chat.redraw();
    try {
      let r;
      if (askFn) {
        // Altro modo di rispondere (chat sulla biblioteca): tiene da sé il contesto in chat.ctx e dice a che punto è.
        r = await askFn(q, chat, (status) => {
          t.status = status;
          chat.redraw();
        });
      } else {
        // Il contesto si prepara una volta per conversazione (l'articolo resta anche in cache da OpenRouter).
        const ctx = await (chat.ctx = chat.ctx || getCtx());
        r = { ...(await askAboutSources(plugin, ctx, q, history)), ctx };
      }
      Object.assign(t, { a: r.testo, parts: splitCited(r.testo, r.ctx), ctx: r.ctx });
    } catch (e) {
      chat.ctx = null;
      t.error = e.message || String(e);
    }
    chat.busy = false;
    chat.redraw();
  };
  send.addEventListener('click', ask);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      ask();
    }
  });
  // Il pannello può essere ridisegnato mentre si aspetta la risposta: aggiorna l'ultimo riquadro disegnato.
  chat.redraw = draw;
  draw();
  return box;
}

/** Prompt rapidi (Impostazioni → Intelligenza artificiale), più una richiesta scritta al momento. */
function aiMenu(plugin, evt, run) {
  const menu = new Menu();
  for (const preset of parsePresets(plugin.settings.aiPresets)) menu.addItem((i) => i.setTitle(preset.name).onClick(() => run(preset)));
  menu.addSeparator();
  menu.addItem((i) => i.setTitle('Scrivi tu la richiesta…').setIcon('pencil').onClick(() => new FreePromptModal(plugin, run).open()));
  menu.showAtMouseEvent(evt);
}

/** Richiesta libera per gli spunti: l'ultima resta scritta, per correggerla e riprovare. */
class FreePromptModal extends Modal {
  constructor(plugin, run) {
    super(plugin.app);
    this.plugin = plugin;
    this.run = run;
  }

  onOpen() {
    this.titleEl.setText('Cosa vuoi negli spunti?');
    const ta = this.contentEl.createEl('textarea', { cls: 'lmp-free-prompt', attr: { rows: 3, placeholder: 'Es. un commento che parte dall’immagine, per un bambino' } });
    ta.value = this.plugin.lastFreePrompt || '';
    const go = () => {
      const prompt = ta.value.trim();
      if (!prompt) return ta.focus();
      this.plugin.lastFreePrompt = prompt;
      this.close();
      this.run({ name: 'Richiesta libera', prompt });
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        go();
      }
    });
    const bar = this.contentEl.createDiv({ cls: 'modal-button-container' });
    bar.createEl('button', { cls: 'mod-cta', text: 'Chiedi' }).addEventListener('click', go);
    window.setTimeout(() => ta.focus(), 50);
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * Chiede gli spunti e li mostra nel riquadro (subito, con "Sto cercando…"): ogni spunto con le fonti usate, che si
 * toccano per aprirle (onSource), "Usa" se c'è un campo di risposta `ta` e "Copia". `place(box)` lo mette in pagina.
 */
async function showAiSuggestions(plugin, preset, getCtx, { btn, ta, place, onSource, onClose }) {
  if (btn && btn.disabled) return;
  if (btn) {
    btn.disabled = true;
    btn.addClass('is-loading');
  }
  const box = createDiv('lmp-ai-box');
  const head = box.createDiv('lmp-ai-head');
  const note = head.createDiv({ cls: 'lmp-ai-note', text: `${preset.name} · sto cercando nelle fonti…` });
  const close = head.createEl('button', { cls: 'clickable-icon lmp-ai-close', attr: { 'aria-label': 'Chiudi gli spunti' } });
  setIcon(close, 'x');
  const drop = () => {
    box.remove();
    if (onClose) onClose(box);
  };
  close.addEventListener('click', drop);
  place(box);
  try {
    const ctx = await getCtx();
    const list = await suggestComments(plugin, ctx, preset);
    const skipped = ctx.sources && ctx.sources.skipped;
    note.setText(`${preset.name} · scegline uno e dillo con parole tue${skipped ? ` · ${skipped} fonti escluse perché troppo lunghe` : ''}`);
    for (const c of list) {
      const card = box.createDiv('lmp-ai-card');
      card.createDiv({ cls: 'lmp-ai-text', text: c.testo });
      if (c.fonti.length) {
        const fonti = card.createDiv('lmp-ai-sources');
        for (const f of c.fonti) {
          const chip = fonti.createEl('button', { cls: 'lmp-ai-src', text: f.label, attr: { 'aria-label': f.text.slice(0, 300) } });
          chip.addEventListener('click', () => onSource(f.target, ctx));
        }
      }
      const acts = card.createDiv('lmp-ai-actions');
      if (ta) {
        const use = acts.createEl('button', { cls: 'lmp-small-btn', text: 'Usa nella risposta' });
        use.addEventListener('click', () => {
          ta.value = ta.value.trim() ? `${ta.value.trim()}\n${c.testo}` : c.testo;
          ta.dispatchEvent(new Event('input'));
          drop();
        });
      }
      const copy = acts.createEl('button', { cls: 'lmp-small-btn', text: 'Copia' });
      copy.addEventListener('click', async () => {
        await navigator.clipboard.writeText(c.testo);
        new Notice('Spunto copiato');
      });
    }
  } catch (e) {
    note.setText(e.message || String(e));
    note.addClass('is-error');
  }
  if (btn) {
    btn.disabled = false;
    btn.removeClass('is-loading');
  }
}

/**
 * Contesto per l'AI su alcuni versetti di un capitolo (`d` = bible.getChapter; senza versetti: il capitolo intero):
 * il capitolo, le tue note che citano i versetti e, per ognuno, note di studio, note in calce, "Citato in" e riferimenti.
 * ponytail: tetto di 400.000 caratteri (~100k token); oltre cadono prima i riferimenti a margine, poi i "Citato in".
 */
async function verseAiCtx(plugin, d, vs, title, focus) {
  const bible = plugin.bible;
  const at = (v) => ({ book: d.book.num, chapter: d.chapter, verse: v });
  const all = [...d.verseLines.keys()].sort((a, b) => a - b);
  const chosen = vs || all;
  const sources = new SourceList(400000);
  const ids = new Map(all.map((v) => [v, sources.add(bible.refLabel(at(v)), bible.verseText(d, v), { verse: at(v) })]));
  // Il capitolo è uguale per tutte le richieste su questo capitolo: resta in cache (vedi aiChat).
  const shared = sources.items.length;
  const seen = new Set();
  for (const v of chosen)
    for (const e of plugin.noteIndex.lookup(d.book.num, d.chapter, v)) {
      const key = `${e.path}:${e.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.add(`Mia nota «${e.path.split('/').pop().replace(/\.md$/, '')}» (cita ${bible.refLabel(at(v))})`, e.snippet, { note: e.path, line: e.line });
    }
  await addScriptureSources(plugin, chosen.map(at), sources, '', { maxVerses: Infinity, citesFirst: true });
  return {
    title: `Bibbia, ${bible.refLabel({ book: d.book.num, chapter: d.chapter })}`,
    question: `Che cosa impariamo da ${title}?`,
    paragraphIds: chosen.map((v) => ids.get(v)).filter(Boolean),
    focus: focus ? focus.replace(/\s+/g, ' ').trim().slice(0, 1500) : '',
    sources,
    shared,
    notes: [],
  };
}

/** "Bibbia con riferimenti" di un versetto, dentro `sec`: testo dell'edizione 1987, riferimenti a margine e note, con la lettera e la parola. */
async function renderRbi8Verse(plugin, sec, ref, { alive, onRef, refresh }) {
  const e = await plugin.rbi8Verse(ref.book, ref.chapter, ref.verse).catch(() => null);
  if (!alive()) return;
  if (e === undefined) {
    // Dati non scaricati: senza un'estensione che li fornisca la sezione non compare.
    if (!plugin.has('downloadReferenceBible')) return (sec.closest('details') || sec).remove();
    sec.createDiv({ cls: 'lmp-rbi-intro', text: 'Testo della Traduzione del Nuovo Mondo con riferimenti (1987), con i riferimenti a margine e le note, da confrontare con la Bibbia per lo studio.' });
    const b = sec.createEl('button', { cls: 'mod-cta lmp-rbi-get', text: 'Scarica (26 MB, una volta sola)' });
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await plugin.ask('downloadReferenceBible', (t) => b.isConnected && b.setText(t));
        new Notice('Bibbia con riferimenti pronta');
        refresh();
      } catch (err) {
        b.disabled = false;
        if (err.cancelled) return b.setText('Scarica (26 MB, una volta sola)');
        b.setText('Riprova a scaricare');
        new Notice(`Bibbia con riferimenti: ${err.message}`);
      }
    });
    return;
  }
  if (!e) {
    sec.createDiv({ cls: 'lmp-empty lmp-small', text: 'Questo versetto non c’è nell’edizione con riferimenti.' });
    return;
  }
  sec.createDiv({ cls: 'lmp-rbi-text', text: e.t });
  const row = (letter, word) => {
    const r = sec.createDiv('lmp-rbi-row');
    r.createSpan({ cls: 'lmp-rbi-letter', text: letter });
    if (word) r.createSpan({ cls: 'lmp-rbi-word', text: `${word}: ` });
    return r;
  };
  for (const [letter, word, refs] of e.r || []) {
    const r = row(letter, word);
    refs.forEach(([a, b], i) => {
      const to = refFromCodes(a, b || undefined);
      const link = r.createEl('a', { cls: 'lmp-rbi-ref', text: plugin.bible.refLabel(to), href: '#' });
      link.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        onRef(link, to);
      });
      if (i < refs.length - 1) r.appendText('; ');
    });
  }
  if (e.f && e.f.length) {
    sec.createDiv({ cls: 'lmp-rbi-sub', text: 'Note' });
    for (const [letter, word, text] of e.f) row(`*${letter}`, word).appendText(text);
  }
}

export { AI_DEFAULT_MODEL, openRouter, withUserStyle, DEFAULT_PRESETS, aiMenu, askAboutSources, renderAskBox, splitCited, showAiSuggestions, GOSPELS, ParallelModal, SourceList, addScriptureSources, highlightParts, leadText, parallelsInChapter, parsePresets, plain, quickDefinition, renderRbi8Verse, suggestComments, verseAiCtx, wordStudy };
