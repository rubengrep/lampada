import { TFile, debounce, normalizePath } from 'obsidian';
import { DEFAULT_SETTINGS } from './costanti.js';
import { verseCode } from './testo.js';

/* ------------------------------------------------------------------ */
/* SCRABB: schede di studio collegate (principi, modelli, illustrazioni, cronologia, mappa) */
/* ------------------------------------------------------------------ */

const SCRABB_VIEW_TYPE = 'lampada-scrabb';

const SCRABB_TYPES = {
  principio: { label: 'Principio', plural: 'Principi', icon: 'gem', folder: 'Principi' },
  modello: { label: 'Modello', plural: 'Modelli', icon: 'footprints', folder: 'Modelli' },
  illustrazione: { label: 'Illustrazione', plural: 'Illustrazioni', icon: 'lightbulb', folder: 'Illustrazioni' },
  esperienza: { label: 'Esperienza', plural: 'Esperienze', icon: 'heart-handshake', folder: 'Esperienze' },
  situazione: { label: 'Situazione', plural: 'Situazioni', icon: 'signpost', folder: 'Situazioni' },
  persona: { label: 'Persona', plural: 'Personaggi', icon: 'user', folder: 'Personaggi Biblici' },
  evento: { label: 'Evento', plural: 'Eventi', icon: 'flag', folder: 'Eventi Biblici' },
  periodo: { label: 'Periodo', plural: 'Periodi', icon: 'calendar-range', folder: 'Eventi Biblici' },
  luogo: { label: 'Luogo', plural: 'Luoghi', icon: 'map-pin', folder: 'Luoghi Biblici' },
  tema: { label: 'Tema', plural: 'Temi', icon: 'book-marked', folder: 'Argomenti Biblici' },
  qualità: { label: 'Qualità', plural: 'Qualità', icon: 'sprout', folder: 'Frutto dello Spirito' },
  libro: { label: 'Libro', plural: 'Libri', icon: 'book', folder: 'Libri Biblici' },
};

// Campo del frontmatter in cui finisce un collegamento, secondo il tipo della scheda collegata.
const SCRABB_FIELD_FOR = {
  principio: 'principi', qualità: 'temi', tema: 'temi', libro: 'temi',
  persona: 'persone', luogo: 'luoghi', evento: 'eventi', periodo: 'eventi', modello: 'modelli', illustrazione: 'illustrazioni', esperienza: 'esperienze', situazione: 'situazioni',
};
const SCRABB_LINK_FIELDS = ['principi', 'modelli', 'illustrazioni', 'esperienze', 'situazioni', 'persone', 'luoghi', 'eventi', 'temi'];
// Cosa si insegna (principi, qualità, temi) e con cosa lo si fa capire (modelli biblici, illustrazioni).
const SCRABB_TEACHINGS = ['principio', 'qualità', 'tema'];
const SCRABB_TEACHERS = ['modello', 'illustrazione', 'esperienza'];
// Ciò che si usa nei discorsi: se ne tiene lo storico d'uso.
const SCRABB_USABLE = ['illustrazione', 'esperienza'];
const SCRABB_STUDY_LISTS = ['principio', 'qualità', 'tema', 'modello', 'illustrazione', 'esperienza', 'situazione'];
// Schede "bibliche": personaggi, eventi (con i periodi), luoghi, libri. Stessa vista, seconda riga.
const SCRABB_BIBLE_LISTS = ['persona', 'evento', 'luogo', 'libro'];
const SCRABB_ALL_LISTS = [...SCRABB_STUDY_LISTS, ...SCRABB_BIBLE_LISTS];
const scrabbListTypes = (list) => (list === 'evento' ? ['evento', 'periodo'] : [list]);
const scrabbListOf = (tipo) => (tipo === 'periodo' ? 'evento' : tipo);
const SCRABB_INTRO = {
  persona: 'I personaggi biblici: chi erano, quando sono vissuti, i modelli e le lezioni che insegnano, i versetti e dove ne hai parlato. Da qui li apri anche in Cronologia, nella Mappa e in Perspicacia.',
  evento: 'Eventi e periodi della storia biblica, con le date di Perspicacia: aprili in Cronologia per vederli nel loro tempo.',
  luogo: 'Luoghi biblici: chi ci è vissuto, cosa vi è accaduto e i versetti che li nominano.',
  libro: 'I libri della Bibbia: scrittore, periodo, temi e i modelli che contengono.',
  esperienza: 'Un’esperienza è un fatto vero dei giorni nostri (una biografia, il racconto di un fratello o di una sorella) che mostra un principio nella vita reale. Come per le illustrazioni, qui vedi dove l’hai sentita e dove l’hai usata.',
  situazione: 'Situazioni concrete della vita (una decisione, un problema, un’occasione) con i principi biblici da considerare. Aprila quando devi decidere: trovi i principi, i versetti con il testo e le tue riflessioni.',
  principio: 'Scegli una voce a sinistra per vedere versetti, modelli biblici e illustrazioni collegate. In qualsiasi nota, un link alla scheda (o il comando “Collega a SCRABB”) la fa comparire qui sotto “Nelle mie note”.',
  modello: 'Un modello è una vicenda biblica che mostra un principio messo in pratica (o il contrario): persone, luoghi e versetti collegati a ciò che insegna. Crealo da qui, dal lettore della Bibbia o selezionando un passaggio con “SCRABB: crea un modello dalla selezione”.',
  illustrazione: 'Un’illustrazione è un paragone o una breve storia che fa capire un concetto. Collegala ai principi che spiega; quando la usi in un discorso (“SCRABB: inserisci un’illustrazione…”) qui vedi dove e quando, così eviti di ripeterla.',
};

const SCRABB_BODY = {
  persona: '## Chi era\n\n\n## Momenti chiave\n\n\n## Qualità e lezioni\n\n',
  evento: '## Cosa è successo\n\n\n## Perché è importante\n\n\n## Lezioni\n\n',
  periodo: '## Panoramica\n\n\n## Cosa insegna\n\n',
  luogo: '## Dove si trova\n\n\n## Cosa vi è accaduto\n\n',
  tema: '## Cosa insegna la Bibbia\n\n\n## Versetti chiave\n\n\n## Appunti\n\n',
  qualità: '## Cos’è\n\n\n## Come mostrarla\n\n\n## Appunti\n\n',
  libro: '## Scrittore, luogo e periodo\n\n\n## Contenuto\n\n\n## Appunti\n\n',
  principio: '## Il principio\n\n\n## Perché è saggio\n\n\n## Come applicarlo oggi\n\n',
  modello: '## Cosa è successo\n\n\n## Cosa insegna\n\n\n## Da imitare (o da evitare)\n\n',
  illustrazione: '## L’illustrazione\n\n\n## Cosa fa capire\n\n\n## Come presentarla\n\n',
  situazione: '## Principi da considerare\n\n\n## Le mie riflessioni\n\n',
  esperienza: '## L’esperienza\n\n\n## Cosa insegna\n\n\n## Come raccontarla\n\n',
};

// Corsie della cronologia, dall'alto in basso.
const SCRABB_LANES = ['Eventi', 'Patriarchi', 'Re (regno unito)', 'Re di Giuda', 'Re d’Israele', 'Profeti', 'Gesù e la congregazione', 'Personaggi', 'Altro'];

const SCRABB_ERAS = [
  ['Creazione', -4026], ['Diluvio', -2370], ['Patriarchi', -1900], ['Esodo', -1513], ['Giudici', -1300],
  ['Regno unito', -1077], ['Regni divisi', -880], ['Esilio', -607], ['Ritorno', -500], ['Gesù', 20], ['Apostoli', 60], ['Ultimi giorni', 1914],
];

function scrabbNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function scrabbList(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

/** Destinazioni dei link in un valore del frontmatter: "[[Mosè]]", [[Mosè]] (lista annidata in YAML) o testo semplice. */
/** Fonti di una scheda: paragrafi delle pubblicazioni, "[[w202512_…#^p12|Titolo ¶12]]" → { file, par, label }. */
function scrabbFonti(v) {
  const out = [];
  for (const item of scrabbList(v)) {
    for (const m of String(item).matchAll(/\[\[([^\]|#]+)(?:#\^p(\d+))?(?:\|([^\]]*))?\]\]/g))
      out.push({ file: m[1].trim().split('/').pop(), par: m[2] ? +m[2] : null, label: (m[3] || '').trim() });
  }
  return out;
}

function scrabbLinkpaths(v) {
  const out = [];
  for (const item of scrabbList(v)) {
    if (Array.isArray(item)) {
      for (const x of item.flat(3)) if (x) out.push(String(x).split('|')[0].trim());
      continue;
    }
    const s = String(item);
    const ms = [...s.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)];
    if (ms.length) ms.forEach((m) => out.push(m[1].trim()));
    else if (s.trim()) out.push(s.trim());
  }
  return out;
}

function scrabbYear(y) {
  return y < 0 ? `${-y} a.E.V.` : `${y} E.V.`;
}

function scrabbDate(e) {
  if (e.anno == null) return e.data ? String(e.data) : '';
  const ca = e.approx ? 'ca. ' : '';
  if (e.fine == null || e.fine === e.anno) return ca + scrabbYear(e.anno);
  if (e.anno < 0 && e.fine < 0) return `${ca}${-e.anno}–${-e.fine} a.E.V.`;
  if (e.anno > 0) return `${ca}${e.anno}–${e.fine} E.V.`;
  return `${ca}${scrabbYear(e.anno)} – ${scrabbYear(e.fine)}`;
}

/** Data di una nota (discorso, parte): campo data/date o "AAAA-MM-GG" nel nome del file. */
function scrabbNoteDate(app, file) {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter || {};
  const re = /(\d{4})[-.](\d{2})(?:[-.](\d{2}))?/;
  const m = re.exec(String(fm.data || fm.date || '')) || re.exec(file.basename);
  return m ? `${m[1]}-${m[2]}-${m[3] || '01'}` : null;
}

function scrabbFmtDate(d) {
  if (!d) return '';
  const [y, m, g] = d.split('-');
  return `${g}/${m}/${y}`;
}

function scrabbUsageText(used) {
  if (!used.length) return 'mai usata';
  const last = used.find((o) => o.date);
  return `${used.length}×${last ? ` · ultima ${scrabbFmtDate(last.date)}` : ''}`;
}

function scrabbFold(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function scrabbSafeName(s) {
  return String(s).replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim();
}

/** Testo della nota senza frontmatter e senza le sezioni rimaste vuote (solo titolo). */
function scrabbBody(text) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const parts = body.split(/^(?=#{1,6} )/m);
  return parts
    .filter((p) => p.replace(/^#{1,6} .*$/m, '').trim())
    .join('')
    .trim();
}

class ScrabbIndex {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.byPath = new Map();
    this.byCode = new Map();
    this.rel = new Map();
    this.ready = false;
    this.version = 0;
    this.scheduleBuild = debounce(() => this.build(), 700, true);
  }

  get folder() {
    return normalizePath(this.plugin.settings.scrabbFolder || DEFAULT_SETTINGS.scrabbFolder);
  }

  /** Costruisce l'indice la prima volta (dopo la Bibbia, per riconoscere i versetti) e resta in ascolto. */
  ensure() {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        try {
          await this.plugin.bible.ensureLoaded();
        } catch (e) {
          /* senza Bibbia: schede senza testo dei versetti */
        }
        this.build();
        this.watch();
      })();
    }
    return this.readyPromise;
  }

  watch() {
    const touches = (file) => {
      if (!(file instanceof TFile) || file.extension !== 'md') return false;
      if (this.byPath.has(file.path)) return true;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      return !!(fm && SCRABB_TYPES[String(fm.tipo || '').toLowerCase()]);
    };
    this.plugin.registerEvent(this.app.metadataCache.on('changed', (f) => touches(f) && this.scheduleBuild()));
    this.plugin.registerEvent(this.app.vault.on('delete', (f) => this.byPath.has(f.path) && this.scheduleBuild()));
    this.plugin.registerEvent(this.app.vault.on('rename', (f, old) => (this.byPath.has(old) || touches(f)) && this.scheduleBuild()));
  }

  build() {
    const mc = this.app.metadataCache;
    const byPath = new Map();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = mc.getFileCache(file);
      const fm = cache && cache.frontmatter;
      const tipo = fm && String(fm.tipo || '').toLowerCase();
      if (!tipo || !SCRABB_TYPES[tipo]) continue;
      const e = {
        path: file.path,
        name: file.basename,
        file,
        tipo,
        anno: scrabbNum(fm.anno),
        fine: scrabbNum(fm.anno_fine),
        approx: !!fm.approssimata,
        data: fm.data || null,
        corsia: fm.corsia ? String(fm.corsia) : null,
        categoria: fm.categoria ? String(fm.categoria) : null,
        ordine: scrabbNum(fm.ordine),
        domanda: fm.domanda ? String(fm.domanda) : null,
        versetti: scrabbList(fm.versetti).map(String),
        fonti: scrabbFonti(fm.fonti),
        perspicacia: scrabbLinkpaths(fm.perspicacia)[0] || null,
        links: [],
        missing: [],
        refs: [],
      };
      for (const field of SCRABB_LINK_FIELDS) {
        for (const lp of scrabbLinkpaths(fm[field])) {
          const dest = mc.getFirstLinkpathDest(lp, file.path);
          if (dest) e.links.push({ path: dest.path, field, strong: true });
          else e.missing.push({ name: lp, field });
        }
      }
      for (const l of cache.links || []) {
        const dest = mc.getFirstLinkpathDest(l.link.split('#')[0], file.path);
        if (dest && dest.path !== file.path) e.links.push({ path: dest.path, field: 'testo', strong: false });
      }
      byPath.set(file.path, e);
    }

    const rel = new Map();
    const add = (a, b, strong) => {
      if (!rel.has(a)) rel.set(a, new Map());
      const m = rel.get(a);
      m.set(b, m.get(b) || strong);
    };
    const byCode = new Map();
    const bible = this.plugin.bible;
    const bibleReady = !!(bible && bible.plainRe);
    for (const e of byPath.values()) {
      e.links = e.links.filter((l) => byPath.has(l.path) && l.path !== e.path);
      for (const l of e.links) {
        add(e.path, l.path, l.strong);
        add(l.path, e.path, l.strong);
      }
      if (!bibleReady) continue;
      for (const v of e.versetti) {
        for (const hit of bible.scanLine(v, true)) {
          e.refs.push({ ref: hit.ref, verses: hit.verses, label: bible.refLabel(hit.ref, hit.versesText) });
          for (const n of hit.verses) {
            const code = verseCode(hit.ref.book, hit.ref.chapter, n);
            if (!byCode.has(code)) byCode.set(code, new Set());
            byCode.get(code).add(e.path);
          }
        }
      }
    }
    // Paragrafi delle pubblicazioni usati come fonte: nome del file → [{ path, par }]
    const byFonte = new Map();
    for (const e of byPath.values())
      for (const f of e.fonti) {
        if (!byFonte.has(f.file)) byFonte.set(f.file, []);
        byFonte.get(f.file).push({ path: e.path, par: f.par });
      }
    this.byPath = byPath;
    this.rel = rel;
    this.byCode = byCode;
    this.byFonte = byFonte;
    this.ready = true;
    this.version++;
    this.app.workspace.trigger('lampada:scrabb-changed');
  }

  get(path) {
    return this.byPath.get(path) || null;
  }

  byName(name) {
    const dest = this.app.metadataCache.getFirstLinkpathDest(name, '');
    return (dest && this.byPath.get(dest.path)) || null;
  }

  all(types) {
    const list = [...this.byPath.values()];
    return types ? list.filter((e) => types.includes(e.tipo)) : list;
  }

  related(path, types) {
    const m = this.rel.get(path);
    if (!m) return [];
    const out = [];
    for (const p of m.keys()) {
      const e = this.byPath.get(p);
      if (e && (!types || types.includes(e.tipo))) out.push(e);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'it'));
  }

  isStrong(a, b) {
    return !!(this.rel.get(a) && this.rel.get(a).get(b));
  }

  /** Schede che citano un documento (o un suo paragrafo) come fonte. */
  fontiOf(file, par) {
    const list = (this.byFonte && this.byFonte.get(file)) || [];
    const out = [];
    for (const x of list) {
      if (par != null && x.par !== par) continue;
      const e = this.byPath.get(x.path);
      if (e) out.push({ e, par: x.par });
    }
    return out;
  }

  /**
   * Collega un paragrafo di una pubblicazione a una scheda: lo aggiunge a "fonti" e,
   * se c'è un testo, lo cita in fondo alla scheda con il link al paragrafo.
   */
  async addFonte(e, link, quote) {
    await this.addToField(e, 'fonti', link);
    if (quote) {
      const text = quote.replace(/\s+/g, ' ').trim();
      await this.app.vault.process(e.file, (t) => `${t.replace(/\s*$/, '')}\n\n> ${text}\n> — ${link}\n`);
    }
  }

  lookup(book, chapter, verse) {
    const s = this.byCode.get(verseCode(book, chapter, verse));
    return s ? [...s].map((p) => this.byPath.get(p)).filter(Boolean) : [];
  }

  /** Note fuori da SCRABB (discorsi, note dei versetti…) che collegano la scheda, con le righe dei link. */
  occurrences(path) {
    const mc = this.app.metadataCache;
    const out = [];
    for (const [src, targets] of Object.entries(mc.resolvedLinks)) {
      if (!targets[path] || this.byPath.has(src)) continue;
      const file = this.app.vault.getAbstractFileByPath(src);
      if (!(file instanceof TFile)) continue;
      const cache = mc.getFileCache(file) || {};
      const lines = [];
      for (const l of [...(cache.links || []), ...(cache.embeds || [])]) {
        const dest = mc.getFirstLinkpathDest(l.link.split('#')[0], src);
        if (dest && dest.path === path && !lines.includes(l.position.start.line)) lines.push(l.position.start.line);
      }
      out.push({ file, lines });
    }
    return out.sort((a, b) => b.file.stat.mtime - a.file.stat.mtime);
  }

  /**
   * Per ogni illustrazione: le note fuori da SCRABB che la collegano (discorsi, parti) e quelle che il suo testo
   * cita come fonte, dalla più recente.
   */
  usageMap() {
    const mc = this.app.metadataCache;
    const ill = new Set(this.all(SCRABB_USABLE).map((e) => e.path));
    const map = new Map([...ill].map((p) => [p, []]));
    if (!ill.size) return map;
    const add = (p, file, lines, source) => {
      const list = map.get(p);
      const ex = list.find((o) => o.file === file);
      if (ex) ex.lines.push(...lines.filter((l) => !ex.lines.includes(l)));
      else list.push({ file, lines, source, date: scrabbNoteDate(this.app, file) });
    };
    for (const [src, targets] of Object.entries(mc.resolvedLinks)) {
      if (this.byPath.has(src)) continue;
      const hits = Object.keys(targets).filter((t) => ill.has(t));
      if (!hits.length) continue;
      const file = this.app.vault.getAbstractFileByPath(src);
      if (!(file instanceof TFile)) continue;
      const cache = mc.getFileCache(file) || {};
      for (const t of hits) {
        const lines = [];
        for (const l of [...(cache.links || []), ...(cache.embeds || [])]) {
          const dest = mc.getFirstLinkpathDest(l.link.split('#')[0], src);
          if (dest && dest.path === t && !lines.includes(l.position.start.line)) lines.push(l.position.start.line);
        }
        add(t, file, lines, false);
      }
    }
    for (const p of ill) {
      const e = this.byPath.get(p);
      for (const l of mc.getFileCache(e.file)?.links || []) {
        const dest = mc.getFirstLinkpathDest(l.link.split('#')[0], p);
        if (dest && dest.extension === 'md' && !this.byPath.has(dest.path)) {
          const sub = /#\^([\w-]+)/.exec(l.link);
          let line = 0;
          if (sub) {
            const blk = (mc.getFileCache(dest)?.blocks || {})[sub[1]];
            if (blk) line = blk.position.start.line;
          }
          add(p, dest, [line], true);
        }
      }
    }
    for (const list of map.values()) list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.file.stat.mtime - a.file.stat.mtime);
    return map;
  }

  /** Crea una nuova scheda; `links` sono nomi di schede da collegare nel frontmatter. */
  async create({ name, tipo, versetti = [], links = [], body = '', extra = {}, fonti = [] }) {
    name = scrabbSafeName(name);
    if (!name) throw new Error('Nome mancante');
    const folder = normalizePath(`${this.folder}/${SCRABB_TYPES[tipo].folder}`);
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const path = normalizePath(`${folder}/${name}.md`);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing;
    const fields = {};
    for (const n of links) {
      const t = this.byName(n);
      const field = SCRABB_FIELD_FOR[t ? t.tipo : 'principio'];
      (fields[field] = fields[field] || []).push(n);
    }
    const q = (s) => JSON.stringify(String(s));
    const fm = ['---', `tipo: ${tipo}`];
    for (const [k, v] of Object.entries(extra)) fm.push(`${k}: ${typeof v === 'number' ? v : q(v)}`);
    if (versetti.length) fm.push('versetti:', ...versetti.map((v) => `  - ${q(v)}`));
    if (fonti.length) fm.push('fonti:', ...fonti.map((v) => `  - ${q(v)}`));
    for (const f of SCRABB_LINK_FIELDS) if (fields[f]) fm.push(`${f}:`, ...fields[f].map((n) => `  - ${q(`[[${n}]]`)}`));
    fm.push(`tags: [scrabb/${scrabbFold(tipo)}]`, '---');
    const text = `${fm.join('\n')}\n${body ? `${body.trim()}\n\n` : ''}${SCRABB_BODY[tipo]}`;
    return this.app.vault.create(path, text);
  }

  /** Aggiunge un valore a una lista del frontmatter di una scheda (senza duplicati). */
  async addToField(e, field, value) {
    await this.app.fileManager.processFrontMatter(e.file, (fm) => {
      const list = scrabbList(fm[field]).slice();
      if (!list.some((x) => String(x) === value)) list.push(value);
      fm[field] = list;
    });
  }
}

export { SCRABB_VIEW_TYPE, SCRABB_TYPES, SCRABB_FIELD_FOR, SCRABB_LINK_FIELDS, SCRABB_TEACHINGS, SCRABB_TEACHERS, SCRABB_USABLE, SCRABB_STUDY_LISTS, SCRABB_BIBLE_LISTS, SCRABB_ALL_LISTS, scrabbListTypes, scrabbListOf, SCRABB_INTRO, SCRABB_BODY, SCRABB_LANES, SCRABB_ERAS, scrabbNum, scrabbList, scrabbFonti, scrabbLinkpaths, scrabbYear, scrabbDate, scrabbNoteDate, scrabbFmtDate, scrabbUsageText, scrabbFold, scrabbSafeName, scrabbBody, ScrabbIndex };
