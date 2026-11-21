import { Modal, requestUrl } from 'obsidian';
import { jwDownload } from './scarica-jw.js';
import { writeBinary } from './file.js';
import { unzipEntries } from './jwl-formati.js';
import { verseCode } from './testo.js';

/* ------------------------------------------------------------------ */
/* Bibbia dall'EPUB del sito: download e conversione nel formato aperto */
/* ------------------------------------------------------------------ */

// Lingue provate: i riferimenti nelle note sono link dell'EPUB, quindi valgono in ogni lingua.
const BIBLE_LANGS = [
  ['I', 'Italiano'],
  ['E', 'English'],
];
// Simbolo della Bibbia con l'EPUB (quella per lo studio non ce l'ha).
const EPUB_SYMBOL = 'nwt';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m));
// Come i nomi dei file esportati: «1º» → «1o», apostrofi e «/» tolti.
const slugify = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’'/]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const jwLink = (a, b) => `jwlibrary:///finder?bible=${a}${b && b !== a ? `-${b}` : ''}`;
const q = (s) => JSON.stringify(String(s));

/**
 * Testo in linea dell'EPUB → Markdown. st: { book, ch, cur, pending, fns, posCode, file }.
 * Numeri dei versetti → **[n](jwlibrary…)**, note → [^n], link ai versetti → [testo](jwlibrary…), il resto testo.
 */
function inlineMd(html, st) {
  html = html
    .replace(/<span class="w_ch"><strong>(\d+)<\/strong>\s*<\/span>/g, '<vn n="$1"/> ')
    .replace(/<strong><sup>(\d+)<\/sup><\/strong>/g, '<vn n="$1"/>')
    .replace(/<a epub:type="noteref" href="#footnote(\d+)">[^<]*<\/a>/g, '<fn n="$1"/>');
  let out = '';
  let link = null;
  const marker = (label) => {
    out += `**[${label}](${jwLink(verseCode(st.book, st.ch, st.pending))})**`;
    st.pending = 0;
  };
  for (const [tok] of html.matchAll(/<[^>]*>|[^<]+/g)) {
    if (tok[0] !== '<') {
      const t = decode(tok).replace(/\s*\n\s*/g, ' ').replace(/([[\]*_])/g, '\\$1');
      if (st.pending && t.trim()) marker(st.pending);
      if (link) link.text += t;
      else out += t;
      continue;
    }
    let m;
    if ((m = /^<span id="chapter(\d+)_verse(\d+)"/.exec(tok))) st.cur = st.pending = +m[2];
    else if ((m = /^<vn n="(\d+)"/.exec(tok))) st.pending ? marker(m[1]) : null;
    else if ((m = /^<fn n="(\d+)"/.exec(tok))) {
      out += `[^${m[1]}]`;
      st.fns.set(m[1], st.cur);
    } else if (/^<\/?em\b/.test(tok)) (link ? (link.text += '_') : (out += '_'));
    else if (/^<\/?strong\b/.test(tok)) out += '**';
    else if (/^<br\b/.test(tok)) out += ' ';
    else if ((m = /^<a [^>]*href="([^"]*)"/.exec(tok))) link = { href: m[1], text: '' };
    else if (tok === '</a>' && link) {
      // Link a un versetto (file#posN): inizio dal file, fine dal testo ("vv. 15 e 16" → 15-16).
      // "Esd 4:8 a 6:18": fine in un altro capitolo.
      const code = st.posCode.get(link.href.includes('#') ? link.href : `${link.href}#`);
      const pairs = [...link.text.matchAll(/(\d+):(\d+)/g)];
      const nums = (link.text.split(':').pop().match(/\d+/g) || []).map(Number);
      if (code) {
        const last = pairs.length > 1 ? verseCode(+code.slice(0, 2), +pairs[pairs.length - 1][1], +pairs[pairs.length - 1][2]) : '';
        const end = last > code ? last : nums.length > 1 && nums[nums.length - 1] > +code.slice(5) ? code.slice(0, 5) + String(nums[nums.length - 1]).padStart(3, '0') : '';
        // Spazi fuori dal link: " [e 24](…)", come nella Bibbia esportata.
        const [, pre, txt, post] = /^(\s*)([\s\S]*?)(\s*)$/.exec(link.text);
        out += `${pre}[${txt}](${jwLink(code, end)})${post}`;
      } else out += link.text;
      link = null;
    }
  }
  return out;
}

/**
 * EPUB della Bibbia (ArrayBuffer) → Map percorso → testo, con i percorsi sotto la cartella delle pubblicazioni
 * (stesso formato della Bibbia esportata: capitoli .md, <libro>.versi.json con le note in calce, index/<simbolo>.json).
 * Legge solo le voci dello zip che servono (indici dei libri e capitoli).
 */
async function convertBibleEpub(buffer, { symbol = EPUB_SYMBOL, title = '', lang = '' } = {}) {
  const base = (n) => n.split('/').pop();
  const td = new TextDecoder();
  const nav = {};
  for (const [n, d] of Object.entries(await unzipEntries(buffer, (n) => /^bible(book|chapter)nav\d*\.xhtml$/.test(base(n))))) nav[base(n)] = td.decode(d);
  const books = nav['biblebooknav.xhtml'];
  if (!books) throw new Error("Nell'EPUB non c'è la Bibbia.");
  // Abbreviazioni: dall'elenco dei libri (link all'elenco dei capitoli, o al capitolo per i libri di un capitolo solo).
  const abbrOf = new Map([...books.matchAll(/<a href="([^"#]+)">([^<]+)<\/a>/g)].map((m) => [m[1], decode(m[2]).trim()]));
  const chapterFiles = new Set([...abbrOf.keys()].filter((h) => !h.startsWith('biblechapternav')));
  for (const [n, html] of Object.entries(nav)) if (n.startsWith('biblechapternav')) for (const m of html.matchAll(/<a href="([^"#]+\.xhtml)">\d+<\/a>/g)) chapterFiles.add(m[1]);
  const raw = await unzipEntries(buffer, (n) => chapterFiles.has(base(n)));

  // 1. Capitoli: libro e capitolo dal link "bibleversenavB_C", posizioni (posN) → versetto seguente.
  const chapters = [];
  const posCode = new Map();
  for (const [n, d] of Object.entries(raw)) {
    const file = base(n);
    const html = td.decode(d);
    delete raw[n];
    const navM = /<p class="w_navigation w_biblebookname">([\s\S]*?)<\/p>/.exec(html);
    const bc = navM && /bibleversenav(\d+)_(\d+)\.xhtml/.exec(navM[1]);
    if (!bc) continue;
    const book = +bc[1];
    const ch = +bc[2];
    const bookTitle = decode((/<a href="biblebooknav\.xhtml">([^<]*)<\/a>/.exec(navM[1]) || [])[1] || String(book)).trim();
    const chapterTitle = decode((/<title>([^<]*)<\/title>/.exec(html) || [])[1] || '').replace(/\s*\d+\s*$/, '').trim();
    let waiting = [`${file}#`];
    let last = '';
    for (const m of html.matchAll(/<span id="(pos\d+)"><\/span>|<span id="chapter\d+_verse(\d+)"><\/span>/g)) {
      if (m[1]) waiting.push(`${file}#${m[1]}`);
      else {
        last = verseCode(book, ch, +m[2]);
        for (const k of waiting) posCode.set(k, last);
        waiting = [];
      }
    }
    for (const k of waiting) if (last) posCode.set(k, last);
    chapters.push({ file, book, ch, bookTitle, chapterTitle, html: html.slice(navM.index + navM[0].length) });
  }
  if (!chapters.length) throw new Error("Nell'EPUB non c'è la Bibbia.");
  chapters.sort((a, b) => a.book - b.book || a.ch - b.ch);

  // 2. Libri
  const byBook = new Map();
  for (const c of chapters) {
    if (!byBook.has(c.book)) {
      const slug = slugify(c.bookTitle) || String(c.book);
      const dir = `${symbol}/Libri/${c.bookTitle.replace(/[\\/:*?"<>|#^[\]]+/g, ' ').trim()}`;
      byBook.set(c.book, { num: c.book, title: c.bookTitle, slug, dir, chapters: [], verses: {}, abbr: abbrOf.get(`biblechapternav${c.book}.xhtml`) || abbrOf.get(c.file) || '' });
    }
    const b = byBook.get(c.book);
    b.chapters.push(c.ch);
    if (c.chapterTitle && c.chapterTitle !== b.title) b.chapterName = c.chapterTitle;
  }

  // 3. Capitoli in Markdown, note in calce per versetto
  const out = new Map();
  const index = { symbol, title: title || symbol, folder: symbol, category: 'bibbie', lang, verses: {}, books: {} };
  for (const c of chapters) {
    const b = byBook.get(c.book);
    const st = { book: c.book, ch: c.ch, cur: 0, pending: 0, fns: new Map(), posCode };
    // Note in calce: <div epub:type="footnote" id="footnoteN"><p><a …>^ Gen. 1:2</a> testo</p></div>
    const notes = [];
    let body = c.html.replace(/<div epub:type="footnote" id="footnote(\d+)">\s*<p[^>]*>\s*<a [^>]*>[\s\S]*?<\/a>\s*([\s\S]*?)<\/p>\s*<\/div>/g, (m, n, t) => {
      notes.push([n, t]);
      return '';
    });
    body = body.replace(/<div class="groupFootnote">[\s\S]*$/, '');
    const paras = [];
    for (const m of body.matchAll(/<(h[1-6]|p)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
      let t = inlineMd(m[3], st).replace(/^[ \t]+|[ \t]+$/g, '');
      if (m[1][0] === 'h') t = `${'#'.repeat(+m[1][1])} ${t.replace(/\*\*/g, '').trim()}`;
      if (!t.replace(/\*\*/g, '').trim()) continue;
      paras.push(t);
      // Soprascritta dei Salmi (prima del versetto 1): versetto 0, come nella Bibbia esportata.
      if (!st.cur && /class="[^"]*\bsw\b/.test(m[2])) index.verses[verseCode(c.book, c.ch, 0)] = { chapter: `${b.dir}/${b.slug}_${c.ch}.md` };
    }
    const fnLines = [];
    for (const [n, t] of notes) {
      const md = inlineMd(t, { ...st, fns: new Map(), pending: 0 }).trim();
      fnLines.push(`[^${n}]: ${md}`);
      const v = st.fns.get(n);
      if (v == null) continue;
      const e = (b.verses[`${c.ch}:${v}`] ??= { code: verseCode(c.book, c.ch, v), sections: [{ title: 'Note in calce', md: '' }] });
      e.sections[0].md += `${e.sections[0].md ? '\n' : ''}- ${md}`;
    }
    const rel = `${b.dir}/${b.slug}_${c.ch}.md`;
    for (const m of body.matchAll(/<span id="chapter\d+_verse(\d+)"><\/span>/g)) index.verses[verseCode(c.book, c.ch, +m[1])] = { chapter: rel };
    const i = b.chapters.indexOf(c.ch);
    const navLine = [i > 0 && `[[${b.slug}_${b.chapters[i - 1]}|← ${b.title} ${b.chapters[i - 1]}]]`, `[[${b.slug}|${b.title}]]`, i < b.chapters.length - 1 && `[[${b.slug}_${b.chapters[i + 1]}|${b.title} ${b.chapters[i + 1]} →]]`].filter(Boolean).join(' · ');
    const fm = ['---', `title: ${q(`${b.title} ${c.ch}`)}`, 'aliases:', `  - ${q(`${b.title} ${c.ch}`)}`, 'type: "chapter"', `book_code: ${q(symbol)}`, `book: ${q(b.title)}`, `book_num: ${c.book}`, `chapter: ${c.ch}`, '---'];
    out.set(rel, `${fm.join('\n')}\n\n${navLine}\n\n${paras.join('\n\n')}\n${fnLines.length ? `\n${fnLines.join('\n')}\n` : ''}`);
  }
  for (const b of byBook.values()) {
    const rel = `${b.dir}/${b.slug}.md`;
    const fm = ['---', `title: ${q(b.title)}`, 'aliases:', `  - ${q(b.title)}`, 'type: "book"', `book_code: ${q(symbol)}`, `book_num: ${b.num}`, '---'];
    out.set(rel, `${fm.join('\n')}\n\n# ${b.title}\n\n## Capitoli\n\n${b.chapters.map((ch) => `[[${b.slug}_${ch}|${ch}]]`).join(' ')}\n`);
    const versesFile = `${b.dir}/${b.slug}.versi.json`;
    out.set(versesFile, JSON.stringify({ version: 1, symbol, book: b.num, slug: b.slug, verses: b.verses }));
    index.books[b.num] = { file: b.slug, rel, title: b.title, slug: b.slug, abbr: b.abbr, chapters: b.chapters, versesFile, ...(b.chapterName ? { chapterName: b.chapterName } : {}) };
  }
  // L'indice per ultimo: se la scrittura si interrompe, Lampada non trova una Bibbia a metà.
  out.set(`index/${symbol}.json`, JSON.stringify(index));
  return out;
}

const infoCache = new Map();
/**
 * Indirizzo, peso e titolo dell'EPUB di una pubblicazione: l'API dei pulsanti "Scarica" del sito, nessuna pagina HTML.
 * null se non c'è (404: numero che non esiste o non ancora uscito).
 */
function epubInfo(lang, pub, issue = '') {
  const key = `${lang}|${pub}|${issue}`;
  if (!infoCache.has(key)) {
    const e = encodeURIComponent;
    const url = `https://b.jw-cdn.org/apis/pub-media/GETPUBMEDIALINKS?output=json&langwritten=${e(lang)}&alllangs=0&fileformat=EPUB&pub=${e(pub)}${issue ? `&issue=${e(issue)}` : ''}`;
    const p = requestUrl({ url, throw: false }).then((r) => {
      if (r.status === 404) return null;
      if (r.status >= 400) throw Object.assign(new Error(`il sito ha risposto con l’errore ${r.status}.`), { status: r.status });
      const f = r.json?.files?.[lang]?.EPUB?.[0];
      if (!f?.file?.url) return null;
      return { url: f.file.url, size: f.filesize || 0, title: decode(r.json.pubName || '').replace(/\u00a0/g, ' '), pub: r.json.pub || pub, issue: r.json.issue || issue };
    });
    // Errori e "non c'è" non restano in memoria: si può riprovare.
    p.then((v) => v || infoCache.delete(key), () => infoCache.delete(key));
    infoCache.set(key, p);
  }
  return infoCache.get(key);
}

/** EPUB della Bibbia in una lingua. */
const bibleEpubInfo = (lang) =>
  epubInfo(lang, EPUB_SYMBOL).then((i) => {
    if (!i) throw new Error('Per questa lingua non c’è la Bibbia da scaricare.');
    return i;
  });

const mb = (n) => `${Math.max(1, Math.round(n / 1e6))} MB`;

/** Scarica l'EPUB (con la conferma "Scarica da jw.org"), lo converte e scrive la Bibbia in .lampada/markdown/; poi la imposta e ricarica. */
async function downloadBible(plugin, lang, progress = () => {}) {
  progress('Cerco la Bibbia…');
  const info = await bibleEpubInfo(lang);
  progress('');
  await jwDownload(plugin.app, [info], async (i, buf, say) => {
    const p = (t) => (say(t), progress(t));
    p('Converto…');
    const files = await convertBibleEpub(buf || (await requestUrl({ url: i.url })).arrayBuffer, { title: i.title, lang });
    const prefix = plugin.bible.prefix;
    const enc = new TextEncoder();
    let n = 0;
    for (const [path, text] of files) {
      await writeBinary(plugin.app, prefix + path, enc.encode(text).buffer);
      if (++n % 40 === 0) p(`Salvo… ${Math.round((n * 100) / files.size)}%`);
    }
    plugin.settings.symbol = EPUB_SYMBOL;
    plugin.settings.bibleLang = lang;
    await plugin.saveAll(false);
    p('Apro…');
    await plugin.refresh();
  });
}

/**
 * Pannello "scarica la Bibbia": lingua, pulsante con il peso, avanzamento, errore con "Riprova".
 * opts: { title, desc, button, onDone }.
 */
function renderBibleDownload(plugin, el, opts = {}) {
  const box = el.createDiv('lmp-bible-dl');
  box.createEl('h3', { text: opts.title || 'Per iniziare, scarica la Bibbia' });
  if (opts.desc) box.createEl('p', { cls: 'lmp-bible-dl-desc', text: opts.desc });
  const row = box.createDiv('lmp-bible-dl-row');
  const sel = row.createEl('select', { cls: 'dropdown lmp-bible-dl-lang', attr: { 'aria-label': 'Lingua' } });
  for (const [k, n] of BIBLE_LANGS) sel.createEl('option', { value: k, text: n });
  sel.value = plugin.settings.bibleLang || 'I';
  const btn = row.createEl('button', { cls: 'mod-cta' });
  const status = box.createDiv({ cls: 'lmp-bible-dl-status', attr: { 'aria-live': 'polite' } });
  let size = 0;
  const label = (text = opts.button || 'Scarica da jw.org') => btn.setText(size ? `${text} (${mb(size)})` : text);
  const look = () => {
    const lang = sel.value;
    size = 0;
    label();
    bibleEpubInfo(lang).then((i) => sel.value === lang && !btn.disabled && ((size = i.size), label()), () => null);
  };
  sel.addEventListener('change', look);
  look();
  btn.addEventListener('click', async () => {
    btn.disabled = sel.disabled = true;
    status.removeClass('mod-error');
    try {
      await downloadBible(plugin, sel.value, (t) => status.setText(t));
      status.setText('Fatto.');
      if (opts.onDone) opts.onDone();
    } catch (e) {
      if (e && e.cancelled) {
        status.setText('');
        btn.disabled = sel.disabled = false;
        return label();
      }
      console.warn('[lampada] download della Bibbia', e);
      status.addClass('mod-error');
      const code = (e && e.status) || (/status (\d+)/.exec((e && e.message) || '') || [])[1];
      status.setText(`Non riuscito: ${code ? `il sito ha risposto con l’errore ${code}.` : (e && e.message) || e}`);
      btn.disabled = sel.disabled = false;
      label('Riprova');
    }
  });
  return box;
}

/** Comando "Scarica la Bibbia": solo se non ce n'è già una (non sostituisce mai una Bibbia più completa). */
class BibleDownloadModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  async onOpen() {
    if (await this.plugin.bible.ensureLoaded().then(() => true, () => false)) {
      this.titleEl.setText('Scarica la Bibbia');
      this.contentEl.createEl('p', { text: `La Bibbia c’è già («${this.plugin.bible.title}»).` });
      return;
    }
    renderBibleDownload(this.plugin, this.contentEl, {
      title: 'Scarica la Bibbia',
      button: 'Scarica da jw.org',
      onDone: () => {
        this.close();
        this.plugin.openReader({ book: 1, chapter: 1 });
      },
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export { BIBLE_LANGS, BibleDownloadModal, convertBibleEpub, decode, downloadBible, epubInfo, jwLink, mb, q, renderBibleDownload, slugify };
