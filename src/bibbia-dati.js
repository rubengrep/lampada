import { Notice, normalizePath } from 'obsidian';
import { CITE_PERIODICALS } from './biblioteca-dati.js';
import { BOOK_ABBR, EXTRA_ALIASES, INDEX_MIRROR } from './costanti.js';
import { fileAt, fileMeta, linkDest, readFile, scanHidden } from './file.js';
import { JWLIB_LINK_RE, codesFromJwUrl, extractBlock, jwLibraryUrl, nameKey, norm, parseChapterMarkdown, parseCode, parseVerseList, refFromCodes, stripFrontmatter, verseCode } from './testo.js';

/* ------------------------------------------------------------------ */
/* Dati della Bibbia                                                   */
/* ------------------------------------------------------------------ */

class BibleData {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.books = [];
    this.byNum = new Map();
    this.bySlug = new Map();
    this.names = new Map();
    this.chapterCache = new Map();
    this.docCache = new Map();
    this.searchIndex = null;
    this.loadPromise = null;
    this.pubFolders = [];
    this.bookInfo = new Map();
    this.verseDataCache = new Map();
  }

  get root() {
    return normalizePath(this.plugin.settings.rootFolder || '');
  }

  get symbol() {
    return this.plugin.settings.symbol;
  }

  get prefix() {
    const r = this.root;
    return r && r !== '/' ? `${r}/` : '';
  }

  get bibleFolder() {
    return `${this.prefix}${this.folder || this.symbol}`;
  }

  isPublicationFile(path) {
    return this.pubFolders.some((f) => path.startsWith(f));
  }

  reset() {
    this.loadPromise = null;
    this.docPubs = null;
    this.bookInfo.clear();
    this.verseDataCache.clear();
    this.chapterCache.clear();
    this.docCache.clear();
    this.searchIndex = null;
  }

  ensureLoaded() {
    if (!this.loadPromise) {
      this.loadPromise = this.load().catch((e) => {
        this.loadPromise = null;
        throw e;
      });
    }
    return this.loadPromise;
  }

  /** Cerca la cartella con gli indici (index, o Indici col nome vecchio): prima nella cartella impostata, poi nel vault. */
  async findIndexDir() {
    const a = this.app.vault.adapter;
    const candidates = (prefix) => [INDEX_MIRROR, 'Indici'].map((d) => ({ prefix, dir: `${prefix}${d}` }));
    const prefixes = [this.prefix];
    try {
      const top = await a.list('');
      for (const f of top.folders) if (!f.split('/').pop().startsWith('.')) prefixes.push(`${f}/`);
    } catch (e) {
      /* elenco non disponibile */
    }
    prefixes.push('');
    // La Bibbia impostata, altrimenti quella per lo studio o quella dall'EPUB.
    const syms = [...new Set([this.symbol, 'nwtsty', 'nwt'].filter(Boolean))];
    for (const prefix of prefixes) {
      for (const c of candidates(prefix)) for (const sym of syms) if (await a.exists(`${c.dir}/${sym}.json`)) return { ...c, sym };
    }
    return null;
  }

  async load() {
    const found = await this.findIndexDir();
    // noBible: le viste mostrano il pannello per scaricarla (bibbia-epub.js).
    if (!found) throw Object.assign(new Error('Bibbia non trovata: scaricala o importala.'), { noBible: true });
    if (found.sym !== this.symbol) {
      this.plugin.settings.symbol = found.sym;
      await this.plugin.saveAll(false);
    }
    if (found.prefix !== this.prefix) {
      this.plugin.settings.rootFolder = found.prefix.replace(/\/$/, '');
      await this.plugin.saveAll(false);
      new Notice(`Lampada: trovata la Bibbia in «${this.plugin.settings.rootFolder || '/'}»`);
    }
    // Pubblicazioni in una cartella nascosta (.lampada/…): Obsidian non le vede, se ne fa l'elenco.
    await scanHidden(this.app, found.prefix);
    const path = `${found.dir}/${this.symbol}.json`;
    this.indexDir = found.dir;
    const idx = JSON.parse(await this.app.vault.adapter.read(path));
    if (!idx.books) throw new Error(`${path} non contiene libri biblici.`);
    this.folder = idx.folder || this.symbol;

    // Cartelle delle pubblicazioni (Bibbie, Glossario, Torre di Guardia, …): non sono note personali.
    const pubs = new Set([this.folder, '_media', INDEX_MIRROR]);
    try {
      // Gli indici secondari pesano ~15 MB: si leggono solo se cambiati, altrimenti basta la cartella memorizzata (per dispositivo).
      const lsKey = `lampada:pub-folders:${this.app.vault.getName()}`;
      let known = {};
      try {
        known = JSON.parse(window.localStorage.getItem(lsKey) || '{}');
      } catch (e) {
        /* memoria locale non disponibile: si rileggono gli indici */
      }
      const next = {};
      const files = (await this.indexFiles()).filter((f) => f.split('/').pop() !== `${this.symbol}.json`);
      await Promise.all(
        files.map(async (f) => {
          const name = f.split('/').pop();
          const st = await this.app.vault.adapter.stat(f);
          const sig = st ? `${st.mtime}:${st.size}` : '';
          let folder = known[name] && known[name][0] === sig ? known[name][1] : null;
          if (!folder) folder = JSON.parse(await this.app.vault.adapter.read(f)).folder || name.replace(/\.json$/, '');
          next[name] = [sig, folder];
          pubs.add(folder);
        })
      );
      try {
        window.localStorage.setItem(lsKey, JSON.stringify(next));
      } catch (e) {
        /* memoria locale non disponibile */
      }
    } catch (e) {
      /* indici secondari illeggibili */
    }
    this.pubFolders = [...pubs].map((n) => `${this.prefix}${n}/`);

    this.title = idx.title || this.symbol;
    // Bibbia in un'altra lingua (dall'EPUB): abbreviazioni dell'EPUB e niente alias italiani.
    this.italian = !idx.lang || idx.lang === 'I';
    this.books = Object.entries(idx.books)
      .map(([num, b]) => ({
        num: +num,
        slug: b.slug || b.file,
        title: b.title,
        chapters: Array.isArray(b.chapters) ? b.chapters : Array.from({ length: +b.chapters || 0 }, (_, i) => i + 1),
        abbr: (!this.italian && b.abbr ? b.abbr.replace(/\.$/, '') : BOOK_ABBR[+num - 1]) || b.title,
        chapterName: b.chapterName || '',
        dir: b.rel ? b.rel.split('/').slice(0, -1).join('/') : `${this.folder}/${b.slug || b.file}`,
        versesFile: b.versesFile || null,
      }))
      .sort((a, b) => a.num - b.num);
    this.byNum = new Map(this.books.map((b) => [b.num, b]));
    this.bySlug = new Map(this.books.map((b) => [b.slug, b]));

    this.names = new Map();
    const addName = (k, num) => {
      k = nameKey(k);
      if (k && !this.names.has(k)) this.names.set(k, num);
    };
    for (const b of this.books) {
      addName(b.title, b.num);
      addName(b.slug, b.num);
      addName(b.abbr, b.num);
    }
    if (this.italian) for (const [k, num] of Object.entries(EXTRA_ALIASES)) addName(k, num);

    this.validCodes = new Set(Object.keys(idx.verses || {}));
    this.chapterMax = new Map();
    for (const code of this.validCodes) {
      const r = parseCode(code);
      const k = r.book * 1000 + r.chapter;
      if ((this.chapterMax.get(k) || 0) < r.verse) this.chapterMax.set(k, r.verse);
    }
    this.buildPlainRegex();
  }

  chapterPath(book, ch) {
    return `${this.prefix}${book.dir}/${book.slug}_${ch}.md`;
  }

  bookPath(book) {
    return `${this.prefix}${book.dir}/${book.slug}.md`;
  }

  getFile(path) {
    return fileAt(this.app, path);
  }

  async getBookInfo(book) {
    if (this.bookInfo.has(book.num)) return this.bookInfo.get(book.num);
    const info = {};
    const file = this.getFile(this.bookPath(book));
    if (file) {
      const keys = { Scrittore: 'writer', Scrittori: 'writer', 'Pronunciati da': 'writer', 'Luogo in cui fu scritto': 'place', Completato: 'completed', 'Tempo a cui si riferisce': 'period' };
      for (const line of stripFrontmatter(await readFile(this.app, file)).split('\n')) {
        const m = /^([^:#\-\[][^:]*):\s*\*\*(.+)\*\*\s*$/.exec(line);
        if (m && keys[m[1].trim()]) info[keys[m[1].trim()]] = m[2].replace(/\u00a0/g, ' ').trim();
      }
    }
    this.bookInfo.set(book.num, info);
    return info;
  }

  async getChapter(bookNum, ch) {
    const key = `${bookNum}:${ch}`;
    const cached = this.chapterCache.get(key);
    if (cached) return cached;
    const book = this.byNum.get(bookNum);
    if (!book) throw new Error(`Libro ${bookNum} non trovato`);
    const file = this.getFile(this.chapterPath(book, ch));
    if (!file) throw new Error(`File del capitolo non trovato: ${this.chapterPath(book, ch)}`);
    const parsed = parseChapterMarkdown(await readFile(this.app, file));
    parsed.book = book;
    parsed.chapter = ch;
    parsed.file = file;
    if (this.chapterCache.size > 120) this.chapterCache.delete(this.chapterCache.keys().next().value);
    this.chapterCache.set(key, parsed);
    return parsed;
  }

  verseText(data, v) {
    const lines = data.verseLines.get(v);
    return lines ? lines.join(' ').replace(/\s+/g, ' ').trim() : '';
  }

  /** File degli indici delle pubblicazioni (.json, senza quelli che iniziano con "_"). */
  async indexFiles() {
    if (!this.indexDir) return [];
    const files = await this.app.vault.adapter.list(this.indexDir).then((l) => l.files, () => []);
    return files.filter((f) => f.endsWith('.json') && !f.split('/').pop().startsWith('_'));
  }

  /** Nome file del documento → nome della pubblicazione, dagli indici di tutte le pubblicazioni. */
  async docPublications() {
    if (this.docPubs) return this.docPubs;
    const map = new Map();
    const cats = new Map();
    const dates = new Map();
    const months = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
    const a = this.app.vault.adapter;
    try {
      for (const f of await this.indexFiles()) {
        const name = f.split('/').pop();
        if (!name.endsWith('.json') || name.startsWith('_')) continue;
        const idx = JSON.parse(await a.read(f));
        const title = idx.title || name.replace(/\.json$/, '');
        const sym = idx.symbol || name.replace(/\.json$/, '');
        // Categoria per "Citato in": quella della biblioteca, con video e annuari a parte.
        const cat = sym === 'video' ? 'video' : /^yb\d*$/.test(sym) ? 'annuari' : idx.category || 'altre';
        for (const d of Object.values(idx.docs || {})) {
          if (!d.file) continue;
          cats.set(d.file, cat);
          // Periodici: data del numero dal nome del file (w20100301_…, wp201601_…, g19850622_…, mwb201601_…)
          const pd = CITE_PERIODICALS.has(cat) && /^[a-z]+(\d{4})(\d{2})(\d{2})?_/i.exec(d.file);
          if (pd) {
            const day = pd[3] && pd[3] !== '00' ? `${+pd[3] === 1 ? '1°' : +pd[3]} ` : '';
            const when = `${day}${months[+pd[2] - 1] || pd[2]} ${pd[1]}`;
            dates.set(d.file, { key: `${pd[1]}${pd[2]}${pd[3] || '00'}`, label: sym === 'wp' ? `${when} · edizione per il pubblico` : when });
          }
          let label = title;
          // La Torre di Guardia: un solo indice per tutti i numeri, il numero è nel nome del file.
          const w = idx.symbol === 'w' && /^w(\d{4})(\d{2})(\d{2})?_/.exec(d.file);
          if (w) label = `La Torre di Guardia · ${w[3] && w[3] !== '00' ? `${+w[3] === 1 ? '1°' : +w[3]} ` : ''}${months[+w[2] - 1] || w[2]} ${w[1]}`;
          map.set(d.file, label);
        }
      }
    } catch (e) {
      console.warn('[lampada] titoli delle pubblicazioni non disponibili', e);
    }
    this.docPubs = map;
    this.docCats = cats;
    this.docDates = dates;
    return map;
  }

  /** Formato nuovo: un file <libro>.versi.json con le sezioni di studio di tutti i versetti. */
  async getBookVerses(book) {
    if (!book.versesFile) return null;
    if (this.verseDataCache.has(book.num)) return this.verseDataCache.get(book.num);
    const raw = JSON.parse(await this.app.vault.adapter.read(`${this.prefix}${book.versesFile}`));
    const data = raw.verses || {};
    if (this.verseDataCache.size > 6) this.verseDataCache.delete(this.verseDataCache.keys().next().value);
    this.verseDataCache.set(book.num, data);
    return data;
  }

  /** Il versetto ha "Approfondimenti"? Solo con i dati del libro già in memoria (getBookVerses). */
  hasStudyCached(book, ch, v) {
    const data = this.verseDataCache.get(book.num);
    if (!data) return false;
    const e = data[`${ch}:${v}`];
    return !!e && (e.sections || []).some((s) => s.title === 'Approfondimenti');
  }

  /** Il versetto ha la sezione indicata (es. "Riferimenti")? Solo con i dati già in memoria. */
  verseHasSection(book, ch, v, title) {
    const data = this.verseDataCache.get(book.num);
    const e = data && data[`${ch}:${v}`];
    return !!e && (e.sections || []).some((x) => x.title === title && x.md && x.md.trim());
  }

  async getVerseDetails(book, ch, v) {
    const data = await this.getBookVerses(book);
    if (!data) return null;
    const e = data[`${ch}:${v}`];
    return {
      sections: e ? (e.sections || []).filter((s) => s.md && s.md.trim()).map((s) => ({ title: s.title, body: s.md.trim() })) : [],
      file: this.getFile(this.chapterPath(book, ch)),
    };
  }

  async readDoc(file) {
    const cached = this.docCache.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) return cached.text;
    const text = await readFile(this.app, file);
    if (this.docCache.size > 40) this.docCache.delete(this.docCache.keys().next().value);
    this.docCache.set(file.path, { mtime: file.stat.mtime, text });
    return text;
  }

  resolveLink(linktext, sourcePath) {
    const path = linktext.split('#')[0].split('|')[0].trim();
    return linkDest(this.app, path, sourcePath || '');
  }

  async getBlock(linktext, id, sourcePath) {
    const file = this.resolveLink(linktext, sourcePath);
    if (!file) return null;
    const md = extractBlock(await this.readDoc(file), id);
    return md == null ? null : { file, md };
  }

  /** Converte un file del vault in un riferimento biblico (libro/capitolo/versetto) se ne fa parte. */
  refFromFile(file) {
    if (!file || file.extension !== 'md') return null;
    if (!file.path.startsWith(this.bibleFolder + '/')) return null;
    const fm = fileMeta(this.app, file)?.frontmatter;
    if (fm && fm.book_num && fm.book_code === this.symbol) {
      if (fm.type === 'verse') return { book: +fm.book_num, chapter: +fm.chapter, verse: +fm.verse };
      if (fm.type === 'chapter') return { book: +fm.book_num, chapter: +fm.chapter };
      if (fm.type === 'book') return { book: +fm.book_num };
    }
    const m = /^(.+?)_(\d+)(?:_(\d+))?$/.exec(file.basename);
    if (m && this.bySlug.has(m[1])) {
      const ref = { book: this.bySlug.get(m[1]).num, chapter: +m[2] };
      if (m[3]) ref.verse = +m[3];
      return ref;
    }
    if (this.bySlug.has(file.basename)) return { book: this.bySlug.get(file.basename).num };
    return null;
  }

  async refPreview(linktext, label, sourcePath) {
    const file = this.resolveLink(linktext, sourcePath);
    const ref = this.refFromFile(file) || this.refFromLinkpath(linktext);
    if (!ref || !ref.chapter) return null;
    return this.previewRef(ref, label);
  }

  async previewRef(ref, label) {
    const data = await this.getChapter(ref.book, ref.chapter);
    let verses = parseVerseList(label);
    if (!verses) verses = ref.verse ? [ref.verse] : [];
    if (ref.verse && !verses.includes(ref.verse)) verses = [ref.verse];
    const text = verses
      .map((v) => {
        const t = this.verseText(data, v);
        return verses.length > 1 && t ? `${v} ${t}` : t;
      })
      .filter(Boolean)
      .join(' ');
    return { ref: { ...ref, verseEnd: verses.length > 1 ? verses[verses.length - 1] : undefined }, text };
  }

  findBook(key) {
    if (!key) return null;
    if (this.names.has(key)) return this.byNum.get(this.names.get(key));
    for (const b of this.books) {
      if (nameKey(b.title).startsWith(key) || nameKey(b.abbr).startsWith(key)) return b;
    }
    return null;
  }

  booksMatching(key) {
    if (!key) return this.books.slice();
    return this.books.filter(
      (b) => nameKey(b.title).startsWith(key) || nameKey(b.abbr).startsWith(key) || nameKey(b.title).includes(key)
    );
  }

  /** "gv 3:16", "1 Giovanni 1", "Sl 23:1-4", "Gda 5" */
  parseReference(q) {
    const s = norm(q).replace(/\s+/g, ' ').trim();
    const m = /^(\d?)\s*([a-z][a-z .]*?)\s*(?:(\d+)(?:\s*[:,.]\s*(\d+)(?:\s*[-–]\s*(\d+))?)?)?\s*$/.exec(s);
    if (!m) return null;
    const book = this.findBook((m[1] + m[2]).replace(/[ .]/g, ''));
    if (!book) return null;
    const ref = { book: book.num };
    if (m[3]) ref.chapter = +m[3];
    if (m[4]) ref.verse = +m[4];
    if (m[5]) ref.verseEnd = +m[5];
    if (book.chapters.length === 1 && ref.chapter && !ref.verse) {
      ref.verse = ref.chapter;
      ref.chapter = book.chapters[0];
    }
    if (ref.chapter && !book.chapters.includes(ref.chapter)) return { book: book.num, invalid: true };
    return ref;
  }

  bookName(book, withChapter) {
    if (!this.plugin.settings.expandBookName) return book.abbr;
    // Come in JW Library: "Salmo 23", ma il libro è "Salmi".
    return withChapter && book.num === 19 ? book.chapterName || 'Salmo' : book.title;
  }

  refLabel(ref, versesText) {
    const book = this.byNum.get(ref.book);
    if (!book) return '';
    if (!ref.chapter) return book.title;
    let s = `${this.bookName(book, true)} ${ref.chapter}`;
    if (versesText) s += `:${versesText}`;
    else if (ref.verse) s += `:${ref.verse}${ref.verseEnd && ref.verseEnd !== ref.verse ? '-' + ref.verseEnd : ''}`;
    return s;
  }

  /** Link JW Library al versetto (si apre in Lampada o nell'app, anche dal telefono). */
  formatLink(ref, versesText) {
    return `[${this.refLabel(ref, versesText)}](${jwLibraryUrl(ref)})`;
  }

  refFromLinkpath(linkpath) {
    const base = linkpath.split('#')[0].split('/').pop().replace(/\.md$/, '');
    const m = /^(.+?)_(\d+)(?:_(\d+))?$/.exec(base);
    if (!m || !this.bySlug.has(m[1])) return null;
    const ref = { book: this.bySlug.get(m[1]).num, chapter: +m[2] };
    if (m[3]) ref.verse = +m[3];
    return ref;
  }

  versesOf(ref) {
    if (!ref.verse) return [];
    let end = ref.verse;
    if (ref.verseEnd) end = ref.verseEnd;
    else if (ref.endChapter) end = this.chapterMax.get(ref.book * 1000 + ref.chapter) || ref.verse;
    const out = [];
    for (let v = ref.verse; v <= end && out.length < 60; v++) out.push(v);
    return out;
  }

  buildPlainRegex() {
    const variants = new Map();
    const add = (v, book) => {
      v = norm(v).replace(/[-\s]+/g, ' ').trim();
      const key = nameKey(v);
      if (!v || variants.has(key)) return;
      // Le abbreviazioni brevi (Gv, Mt, Es…) vanno scritte con la maiuscola, per evitare falsi positivi.
      variants.set(key, { v, book, short: v.replace(/^\d\s?/, '').length <= 3 });
    };
    for (const b of this.books) {
      add(b.title, b.num);
      add(b.abbr, b.num);
    }
    if (this.italian) for (const [k, n] of Object.entries(EXTRA_ALIASES)) add(k, n);
    this.plainVariants = variants;
    const pat = [...variants.values()]
      .map((x) => x.v)
      .sort((a, b) => b.length - a.length)
      .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/^(\d) ?/, '$1\\s?').replace(/ /g, '\\s+'))
      .join('|');
    this.plainRe = new RegExp(
      `(?<![a-z0-9])(${pat})\\.?\\s?(\\d{1,3})\\s?:\\s?(\\d{1,3})((?:\\s?[-–]\\s?\\d{1,3}(?![\\d:]))?(?:\\s?,\\s?\\d{1,3}(?![\\d:])(?:\\s?[-–]\\s?\\d{1,3}(?![\\d:]))?)*)(?![\\d])`,
      'g'
    );
  }

  /**
   * Trova i riferimenti biblici in una riga: link JW Library, wikilink ai file dei versetti
   * e (se attivo) riferimenti scritti in testo semplice come "Gv 3:16".
   */
  scanLine(line, withPlain = this.plugin.settings.detectPlainRefs) {
    const hits = [];
    const masked = line.split('');
    const mask = (start, len) => {
      for (let i = start; i < start + len; i++) masked[i] = ' ';
    };
    let m;
    JWLIB_LINK_RE.lastIndex = 0;
    while ((m = JWLIB_LINK_RE.exec(line))) {
      const codes = codesFromJwUrl(m[2]);
      if (codes) {
        const ref = refFromCodes(codes[0], codes[1]);
        if (this.byNum.has(ref.book)) hits.push({ kind: 'jw', start: m.index, end: m.index + m[0].length, ref, verses: this.versesOf(ref), url: m[2] });
      }
      mask(m.index, m[0].length);
    }
    const wikiRe = /!?\[\[([^\]|#]+)(#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
    while ((m = wikiRe.exec(line))) {
      const ref = this.refFromLinkpath(m[1]);
      if (ref && ref.chapter) hits.push({ kind: 'wiki', start: m.index, end: m.index + m[0].length, ref, verses: this.versesOf(ref) });
      mask(m.index, m[0].length);
    }
    const mdLinkRe = /\[[^\]]*\]\([^)]*\)|`[^`]*`|https?:\/\/\S+/g;
    while ((m = mdLinkRe.exec(line))) mask(m.index, m[0].length);

    if (withPlain && this.plainRe) {
      const orig = masked.join('');
      const n = norm(orig);
      if (n.length === orig.length) {
        this.plainRe.lastIndex = 0;
        while ((m = this.plainRe.exec(n))) {
          const info = this.plainVariants.get(nameKey(m[1]));
          if (!info) continue;
          if (info.short) {
            const letters = orig.slice(m.index, m.index + m[1].length).replace(/^\d\s*/, '');
            if (!letters || letters[0] === letters[0].toLowerCase()) continue;
          }
          const chapter = +m[2];
          const versesText = (m[3] + m[4]).replace(/\s+/g, ' ').replace(/\s?([-–,])\s?/g, (s, p) => (p === ',' ? ', ' : '-')).trim();
          const verses = (parseVerseList(':' + m[3] + m[4]) || []).filter((v) => this.validCodes.has(verseCode(info.book, chapter, v)));
          if (!verses.length) continue;
          const ref = { book: info.book, chapter, verse: verses[0] };
          if (verses[verses.length - 1] > verses[0]) ref.verseEnd = verses[verses.length - 1];
          hits.push({ kind: 'plain', start: m.index, end: m.index + m[0].length, ref, verses, versesText, text: line.slice(m.index, m.index + m[0].length) });
        }
      }
    }
    return hits.sort((a, b) => a.start - b.start);
  }

  adjacentChapter(bookNum, ch, delta) {
    const book = this.byNum.get(bookNum);
    if (!book) return null;
    const i = book.chapters.indexOf(ch) + delta;
    if (i >= 0 && i < book.chapters.length) return { book: bookNum, chapter: book.chapters[i] };
    const other = this.byNum.get(bookNum + delta);
    if (!other || !other.chapters.length) return null;
    return { book: other.num, chapter: delta > 0 ? other.chapters[0] : other.chapters[other.chapters.length - 1] };
  }

  async getSearchIndex(onProgress) {
    if (this.searchIndex) return this.searchIndex;
    const entries = [];
    const total = this.books.reduce((n, b) => n + b.chapters.length, 0);
    let done = 0;
    for (const book of this.books) {
      for (const ch of book.chapters) {
        const file = this.getFile(this.chapterPath(book, ch));
        if (file) {
          const data = parseChapterMarkdown(await readFile(this.app, file));
          for (const [v, lines] of data.verseLines) {
            const text = lines.join(' ').replace(/\s+/g, ' ').trim();
            entries.push({ book: book.num, chapter: ch, verse: v, text, n: norm(text) });
          }
        }
        done++;
        if (onProgress && done % 40 === 0) onProgress(done, total);
      }
    }
    this.searchIndex = entries;
    return entries;
  }
}

export { BibleData };
