import { DATA_DIR, INDEX_MIRROR } from './costanti.js';
import { fileAt, folderFiles, readFile, scanHidden, subfolders } from './file.js';
import { stripFrontmatter, verseCode } from './testo.js';

/* ------------------------------------------------------------------ */
/* Biblioteca: tutte le pubblicazioni di JWSTUDY, in stile JW Library  */
/* ------------------------------------------------------------------ */

const LIB_VIEW_TYPE = 'lampada-biblioteca';

const LIB_CATEGORIES = [
  ['bibbie', 'Bibbie'],
  ['libri', 'Libri'],
  ['opuscoli', 'Opuscoli e brochure'],
  ['torre-di-guardia', 'La Torre di Guardia'],
  ['svegliatevi', 'Svegliatevi!'],
  ['guida-per-ladunanza', 'Guida per l’adunanza'],
  ['ministero-del-regno', 'Ministero del Regno'],
  ['perspicacia', 'Perspicacia'],
  ['glossario', 'Glossario'],
  ['indice', 'Indici e guide alle ricerche'],
  ['articoli', 'Articoli'],
  ['volantini', 'Volantini e inviti'],
  ['altre', 'Altre pubblicazioni'],
];

// Gruppi di "Citato in" nel pannello di studio, in quest'ordine.
const CITE_CATEGORIES = [
  ['torre-di-guardia', 'La Torre di Guardia'],
  ['svegliatevi', 'Svegliatevi!'],
  ['libri', 'Libri'],
  ['perspicacia', 'Perspicacia'],
  ['opuscoli', 'Opuscoli e brochure'],
  ['guida-per-ladunanza', 'Guida per l’adunanza'],
  ['ministero-del-regno', 'Ministero del Regno'],
  ['articoli', 'Articoli di jw.org'],
  ['video', 'Video'],
  ['annuari', 'Annuari'],
  ['glossario', 'Glossario'],
  ['indice', 'Indici e guide alle ricerche'],
  ['bibbie', 'Bibbie'],
  ['volantini', 'Volantini e inviti'],
  ['altre', 'Altre pubblicazioni'],
];
const CITE_PERIODICALS = new Set(['torre-di-guardia', 'svegliatevi', 'guida-per-ladunanza', 'ministero-del-regno', 'annuari']);

// "**CAPITOLO 23**", "**CANTICO 4**", "**LEZIONE 05**"… nelle prime righe del documento
const DOC_LABEL_RE = /^\s*(?:\*\*|#+\s*)?(capitolo|cantico|lezione|parte|studio|domanda|sezione)[\s\u00a0]+(\d{1,3})(?:\*\*)?\s*(?:\^[\w-]+)?\s*$/i;

function findDocLabel(body) {
  const lines = body.split('\n');
  let seen = 0;
  for (let i = 0; i < lines.length && seen < 4; i++) {
    if (!lines[i].trim()) continue;
    seen++;
    const m = DOC_LABEL_RE.exec(lines[i]);
    if (m) return { kind: m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase(), num: +m[2], line: i };
  }
  return null;
}

const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

/** "19540801" → "1° agosto 1954", "201808" → "agosto 2018" */
function issueLabel(key) {
  const m = /^(\d{4})(\d{2})(\d{2})?$/.exec(key || '');
  if (!m) return key;
  const month = MONTHS[+m[2] - 1] || m[2];
  if (!m[3] || m[3] === '00') return `${month} ${m[1]}`;
  return `${+m[3] === 1 ? '1°' : +m[3]} ${month} ${m[1]}`;
}

class LibraryData {
  /** Articolo di studio della Torre di Guardia per settimana: lunedì → documento della biblioteca. */
  async studyArticles() {
    if (this.weeks) return this.weeks;
    const weeks = new Map();
    // Dall'indice di ogni numero: "### Articolo di studio 2-8 novembre 2026" e il link subito sotto.
    for (const d of this.bySym.get('w')?.docs || []) {
      if (d.title !== 'Indice') continue;
      const f = fileAt(this.app, `${d.pub.prefix}${d.rel}`);
      if (!f) continue;
      const lines = (await readFile(this.app, f)).split('\n');
      lines.forEach((l, i) => {
        const h = /^#+\s*Articolo di studio\s+(.+)$/i.exec(l);
        const k = h && weekStartFromLabel(h[1], d.issue);
        const link = k && /\[\[([^\]|#]+)/.exec(lines.slice(i + 1, i + 4).join('\n'));
        const art = link && this.byFile.get(link[1].trim());
        if (art) weeks.set(k, art);
      });
    }
    this.weeks = weeks;
    return weeks;
  }

  async paragraphText(d, par) {
    const f = fileAt(this.app, `${d.pub.prefix}${d.rel}`);
    if (!f) return '';
    return docParagraphText(await readFile(this.app, f), par);
  }

  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.bible = plugin.bible;
    this.pubs = [];
    this.bySym = new Map();
    this.byDocId = new Map();
    this.byFile = new Map();
    this.covers = new Map();
    this.loadPromise = null;
  }

  ensureLoaded() {
    if (!this.loadPromise) this.loadPromise = this.load().catch((e) => ((this.loadPromise = null), Promise.reject(e)));
    return this.loadPromise;
  }

  reset() {
    this.loadPromise = null;
  }

  async load() {
    await this.bible.ensureLoaded();
    const a = this.app.vault.adapter;
    const prefix = this.bible.prefix;
    const pubs = [];
    for (const f of await this.bible.indexFiles()) {
      const name = f.split('/').pop();
      if (!name.endsWith('.json') || name.startsWith('_')) continue;
      let idx;
      try {
        idx = JSON.parse(await a.read(f));
      } catch (e) {
        continue;
      }
      if (!idx || !idx.docs) continue;
      const symbol = idx.symbol || name.replace(/\.json$/, '');
      const docs = Object.entries(idx.docs)
        .filter(([, d]) => d && d.rel && d.title)
        .map(([id, d]) => ({ id: String(id), file: d.file, rel: d.rel, title: d.title, ...(idx.source === 'epub' && { epub: true }) }));
      // Indici con lo stesso simbolo (w.json dell'esportatore e w.wol.json dei documenti scaricati): una sola
      // pubblicazione; se un documento è in tutti e due vale quello dell'esportatore.
      const same = pubs.find((p) => p.symbol === symbol);
      if (same) {
        const fromWol = name.endsWith('.wol.json'); // documenti scaricati
        const ids = new Set((fromWol ? same.docs : docs).map((d) => d.id));
        if (fromWol) same.docs.push(...docs.filter((d) => !ids.has(d.id)));
        else same.docs = [...docs, ...same.docs.filter((d) => !ids.has(d.id))];
        if (!fromWol) Object.assign(same, { title: (idx.title || symbol).replace(/\s*\(\d{4}\)\s*$/, ''), category: idx.category || same.category, folder: idx.folder || same.folder });
        continue;
      }
      pubs.push({ symbol, title: (idx.title || symbol).replace(/\s*\(\d{4}\)\s*$/, ''), category: idx.category || 'altre', folder: idx.folder || symbol, docs, prefix });
    }
    // Periodici: documenti raggruppati per numero (cartella …/AAAAMMGG/)
    const issueOf = (d) => {
      const parts = d.rel.split('/');
      return parts.length >= 4 && /^\d{6,8}$/.test(parts[parts.length - 2]) ? parts[parts.length - 2] : '';
    };
    for (const pub of pubs) {
      const docs = pub.docs;
      if (docs.filter(issueOf).length > docs.length / 2) {
        const groups = new Map();
        for (const d of docs) {
          const k = issueOf(d) || 'altro';
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(d);
          d.issue = k;
        }
        pub.issues = [...groups.entries()].sort((x, y) => y[0].localeCompare(x[0])).map(([key, list]) => ({ key, docs: list }));
      }
      for (const d of docs) {
        d.pub = pub;
        this.byDocId.set(d.id, d);
        if (d.file) this.byFile.set(d.file, d);
      }
    }
    pubs.sort((x, y) => x.title.localeCompare(y.title, 'it', { sensitivity: 'base' }));
    this.pubs = pubs;
    this.weeks = null;
    this.bySym = new Map(pubs.map((p) => [p.symbol, p]));

    // Copertine delle pubblicazioni: .lampada/data/covers/<simbolo>.jpg
    this.symCovers = new Map();
    await scanHidden(this.app, this.coversFolder);
    for (const file of folderFiles(this.app, this.coversFolder)) if (/\.(jpe?g|png|webp)$/i.test(file.name || '')) this.symCovers.set(file.name.replace(/\.[^.]+$/, ''), file);
    // Copertine dei documenti esportati: _media/<simbolo>/<docId>_..._cvr.jpg
    this.covers = new Map();
    for (const dir of subfolders(this.app, `${prefix}_media`)) {
      for (const file of folderFiles(this.app, dir)) {
        const m = /^(\d+)_.*cvr\.(jpe?g|png|webp)$/i.exec(file.name);
        if (m) this.covers.set(m[1], file);
      }
    }
  }

  get coversFolder() {
    return `${DATA_DIR}/covers`;
  }

  /**
   * Toglie dal vault una pubblicazione, o un solo numero (issue): note, immagini, voci degli indici e di
   * index/_sources.json (così si può scaricare di nuovo). La Bibbia in uso non si toglie. Poi ricarica tutto.
   */
  async remove(symbol, issue = '') {
    const pub = this.bySym.get(symbol);
    if (!pub) return;
    if (symbol === this.bible.symbol) throw new Error('È la Bibbia che stai usando: scegline un’altra prima di toglierla.');
    const a = this.app.vault.adapter;
    const prefix = this.bible.prefix;
    const docs = issue ? pub.issues?.find((i) => i.key === issue)?.docs || [] : pub.docs;
    const ids = new Set(docs.map((d) => d.id));
    const files = new Set(docs.map((d) => d.rel));
    // Cartelle tutte di questa pubblicazione: un nome semplice, non usato da altre né dalla Bibbia in uso
    const own = (f) => f && !/[\\/]|^\.|^_/.test(f) && f !== INDEX_MIRROR && f !== this.bible.folder && !this.pubs.some((q) => q !== pub && q.folder === f);
    for (const f of await this.bible.indexFiles()) {
      let idx;
      try {
        idx = JSON.parse(await a.read(f));
      } catch (e) {
        continue;
      }
      if (!idx?.docs || (idx.symbol || f.split('/').pop().replace(/\.json$/, '')) !== symbol) continue;
      for (const id of ids) delete idx.docs[id];
      if (issue && Object.keys(idx.docs).length) {
        await a.write(f, JSON.stringify(idx));
        continue;
      }
      for (const d of Object.values(idx.docs)) if (d?.rel) files.add(d.rel);
      for (const b of Object.values(idx.books || {})) for (const r of [b.rel, b.versesFile]) if (r) files.add(r);
      for (const v of Object.values(idx.verses || {})) if (v?.chapter) files.add(v.chapter);
      const extra = idx.files || [];
      for (const r of Array.isArray(extra) ? extra : Object.values(extra).flat()) if (typeof r === 'string') files.add(r);
      await a.remove(f).catch(() => null);
    }
    const media = [...new Set([symbol, pub.folder])].map((m) => `${prefix}_media/${m}`);
    if (!issue) {
      for (const dir of [...new Set([pub.folder, symbol])].filter(own)) if (await a.exists(prefix + dir)) await a.rmdir(prefix + dir, true);
      for (const dir of media) if (await a.exists(dir)) await a.rmdir(dir, true);
      const cover = this.symCovers.get(symbol);
      if (cover) await a.remove(cover.path).catch(() => null);
    } else {
      for (const dir of media) {
        const list = (await a.exists(dir)) ? (await a.list(dir)).files : [];
        for (const f of list) if (ids.has(f.split('/').pop().split('_')[0])) await a.remove(f).catch(() => null);
      }
    }
    for (const r of files) if (await a.exists(prefix + r)) await a.remove(prefix + r).catch(() => null);
    const sp = `${prefix}${INDEX_MIRROR}/_sources.json`;
    if (await a.exists(sp)) {
      const src = JSON.parse(await a.read(sp));
      const low = symbol.toLowerCase();
      for (const [k, r] of Object.entries(src)) if (String(r?.pub || '').toLowerCase() === low && (!issue || (r.issue && issue.startsWith(String(r.issue))))) delete src[k];
      await a.write(sp, JSON.stringify(src, null, 2));
    }
    await this.plugin.refresh();
  }

  pubCover(p) {
    return this.symCovers.get(p.symbol) || this.coverOf(p.issues ? p.issues[0].docs : p.docs);
  }

  /** Numero di capitolo/cantico/lezione del documento (letto dalle sue prime righe, poi ricordato). */
  async docLabel(d) {
    if (d.label !== undefined) return d.label;
    const file = fileAt(this.app, `${d.pub.prefix}${d.rel}`);
    d.label = null;
    if (file) {
      try {
        d.label = findDocLabel(stripFrontmatter(await readFile(this.app, file)));
      } catch (e) {
        /* file illeggibile */
      }
    }
    return d.label;
  }

  coverOf(docs) {
    for (const d of docs) if (this.covers.has(d.id)) return this.covers.get(d.id);
    return null;
  }

  categories() {
    const known = new Map(LIB_CATEGORIES);
    const out = [];
    for (const [id, label] of LIB_CATEGORIES) {
      const list = this.pubs.filter((p) => p.category === id);
      if (list.length) out.push({ id, label, pubs: list });
    }
    const others = this.pubs.filter((p) => !known.has(p.category));
    if (others.length) out.push({ id: 'varie', label: 'Varie', pubs: others });
    return out;
  }
}

/** Testo semplice di un paragrafo (^pN) di un documento della biblioteca. */
function docParagraphText(md, par) {
  const m = new RegExp(`^(.*?)[ \\t]+\\^p${par}[ \\t]*$`, 'm').exec(md);
  if (!m) return '';
  return m[1]
    .replace(/<sup>\d+<\/sup>/g, '')
    .replace(/!\[\[[^\]]*\]\]/g, '')
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\\([\\`*_\[\]().!-])/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/^\s*(?:#+|[-*]|\d+\.)\s+/, '')
    .trim();
}

/* ---------------- settimana delle adunanze ---------------- */

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Lunedì della settimana di una data, "2026-11-02". */
function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return isoDate(d);
}

/**
 * "2-8 novembre", "26 gennaio–1° febbraio", "30 novembre 2026 – 6 dicembre 2026", "28 (5-11 settembre 2022)"
 * → lunedì di quella settimana. Senza anno vale quello del numero (AAAAMM), +1 se il mese è già dell'anno dopo.
 */
function weekStartFromLabel(text, issue) {
  const clean = String(text || '').replace(/<sup>o<\/sup>|[°º\\]/g, '');
  const m = /^\s*(?:\d+\s*\(\s*)?(\d{1,2})(?:\s*[-–]\s*\d{1,2})?\s+([a-z]+)(?:\s+(\d{4}))?/i.exec(clean);
  const month = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  if (month < 0) return null;
  let year = m[3] ? +m[3] : +String(issue || '').slice(0, 4);
  if (!m[3] && +String(issue).slice(4, 6) - 1 - month > 6) year++;
  return year ? mondayOf(new Date(year, month, +m[1])) : null;
}

/** "2026-11-02" → "2–8 novembre 2026", "30 novembre – 6 dicembre 2026" */
function weekLabel(iso) {
  const a = new Date(`${iso}T12:00:00`);
  const b = new Date(a);
  b.setDate(a.getDate() + 6);
  const day = (d) => (d.getDate() === 1 ? '1°' : String(d.getDate()));
  if (a.getMonth() === b.getMonth()) return `${day(a)}–${day(b)} ${MONTHS[a.getMonth()]} ${a.getFullYear()}`;
  const ya = a.getFullYear() !== b.getFullYear() ? ` ${a.getFullYear()}` : '';
  return `${day(a)} ${MONTHS[a.getMonth()]}${ya} – ${day(b)} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
}

/**
 * HTML di un documento della Guida per l'adunanza (.jwpub) → elenco di blocchi:
 * { k: 'h1'|'h2'|'h3'|'p'|'f', s: 'teal'|'gold'|'maroon', song, x: [segmento…], f: [tt…] } e le immagini
 * { k: 'img', file, alt, cap } (file nel .jwpub, testo alternativo, didascalia).
 * Segmenti: testo | [testo, codice, codiceFine] (Bibbia) | { t, doc, a, b } (pubblicazione, paragrafi a-b) | { t, url }
 * Con epub = { bible, files } legge l'HTML di un EPUB: versetti dalle note "#citationN", rimandi
 * { t, ex: [paragrafo…] } col testo citato nei file "-extracted.xhtml" (files: nome → testo).
 */
function parseMeetingHtml(html, epub) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = [];
  for (const el of doc.querySelectorAll('[data-pid], figure img')) {
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') || '';
      const file = (/^jwpub-media:\/\/(.+)$/.exec(src) || [])[1] || (epub && /^images\//.test(src) && src.split('/').pop());
      const cap = el.closest('figure').querySelector('figcaption');
      if (file) out.push({ k: 'img', file, alt: (el.getAttribute('alt') || '').trim(), cap: cap ? cap.textContent.replace(/\s+/g, ' ').trim() : '' });
      continue;
    }
    if ((el.parentElement && el.parentElement.closest('[data-pid]')) || el.closest('figcaption')) continue;
    const cls = el.getAttribute('class') || '';
    const item = { k: /\bgen-field\b/.test(cls) ? 'f' : el.tagName.toLowerCase() };
    const sec = /du-color--(teal|gold|maroon)/.exec(cls);
    if (sec) item.s = sec[1];
    if (/dc-icon--music/.test(cls)) item.song = 1;
    if (item.k === 'f') {
      item.f = [...el.querySelectorAll('textarea')].map((t) => t.id).filter(Boolean);
      if (item.f.length) out.push(item);
      continue;
    }
    const x = [];
    const add = (t) => (typeof x[x.length - 1] === 'string' ? (x[x.length - 1] += t) : x.push(t));
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) add(c.textContent);
        else if (c.nodeType === 1 && c.tagName !== 'TEXTAREA') {
          const b = c.tagName === 'A' && /^jwpub:\/\/b\/[^/]+\/(\d+):(\d+):(\d+)(?:-(\d+):(\d+):(\d+))?/.exec(c.getAttribute('href') || '');
          const pub = !b && c.tagName === 'A' && /^jwpub:\/\/p\/[A-Z]+:(\d+)\/(?:(\d+)(?:-(\d+))?)?/.exec(c.getAttribute('href') || '');
          const url = !b && !pub && c.tagName === 'A' && /^https?:\/\//.test(c.getAttribute('href') || '') && c.getAttribute('href');
          const ev = epub && !b && !pub && !url && c.tagName === 'A' && epubLink(epub, doc, c);
          if (b) x.push([c.textContent, verseCode(b[1], b[2], b[3]), b[4] ? verseCode(b[4], b[5], b[6]) : '']);
          else if (pub) x.push({ t: c.textContent, doc: pub[1], a: +pub[2] || 0, b: +pub[3] || +pub[2] || 0 });
          else if (url) x.push({ t: c.textContent, url });
          else if (ev) x.push(ev);
          else walk(c);
        }
      }
    };
    walk(el);
    if (typeof x[0] === 'string') x[0] = x[0].replace(/^\s+/, '');
    if (typeof x[x.length - 1] === 'string') x[x.length - 1] = x[x.length - 1].replace(/\s+$/, '');
    item.x = x.filter((t) => t !== '');
    if (item.x.length) out.push(item);
  }
  return out;
}

/**
 * Link dell'EPUB → segmento: "#citationN" → [testo, codice, codiceFine] dal riferimento della nota, es. "(Ger. 49:1-50:46)";
 * "NNN-extracted.xhtml#pcitationN" → { t, ex } con i paragrafi del testo citato (al massimo ~3000 caratteri). Altrimenti null.
 */
function epubLink(epub, doc, link) {
  const href = link.getAttribute('href') || '';
  if (/^#citation\d+$/.test(href)) {
    const note = doc.getElementById(href.slice(1));
    const m = /^\((.+?)(?:\s*[-–,]\s*(?:(\d+):)?(\d+))?\)$/.exec(((note && note.querySelector('strong')) || {}).textContent || '');
    const r = m && epub.bible.parseReference(m[1]);
    if (!r || !r.verse) return null;
    const a = verseCode(r.book, r.chapter, r.verse);
    return [link.textContent, a, m[3] ? verseCode(r.book, m[2] || r.chapter, m[3]) : a];
  }
  const p = /^([^#]+-extracted\.xhtml)#(pcitation\d+)$/.exec(href);
  const html = p && epub.files[p[1]];
  if (!html) return null;
  const cache = (epub.parsed = epub.parsed || {});
  const ext = (cache[p[1]] = cache[p[1]] || new DOMParser().parseFromString(html, 'text/html'));
  const mark = ext.getElementById(p[2]);
  const box = mark && mark.closest('.extPubRef');
  if (!box) return null;
  const out = [];
  let n = 0;
  for (const el of box.querySelectorAll('p')) {
    if (n > 3000 || el.closest('.extScrpCite') || el === mark.closest('p')) continue;
    const t = el.textContent.replace(/[ \t\r\n]+/g, ' ').trim();
    if (t) out.push(t), (n += t.length);
  }
  return out.length ? { t: link.textContent, ex: out } : null;
}

export { LIB_VIEW_TYPE, LIB_CATEGORIES, CITE_CATEGORIES, CITE_PERIODICALS, DOC_LABEL_RE, findDocLabel, MONTHS, issueLabel, LibraryData, docParagraphText, isoDate, mondayOf, weekStartFromLabel, weekLabel, parseMeetingHtml };
