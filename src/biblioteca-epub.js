import { Modal, Notice, Platform, requestUrl } from 'obsidian';
import { decode, epubInfo, jwLink, mb, q, slugify } from './bibbia-epub.js';
import { jwDownload } from './scarica-jw.js';
import { MONTHS, issueLabel, LIB_CATEGORIES } from './biblioteca-dati.js';
import { t } from './lingua.js';
import { epubExtras } from './epub-extra.js';
import { writeBinary } from './file.js';
import { unzipEntries } from './jwl-formati.js';
import { nameKey, norm, verseCode } from './testo.js';

/* ------------------------------------------------------------------ */
/* Pubblicazioni dagli EPUB del sito: da un file, per simbolo, nuovi numeri */
/* ------------------------------------------------------------------ */

const CATEGORY = { w: 'torre-di-guardia', wp: 'torre-di-guardia', ws: 'torre-di-guardia', g: 'svegliatevi', mwb: 'guida-per-ladunanza', km: 'ministero-del-regno' };
const attr = (tag, name) => (new RegExp(`\\b${name}="([^"]*)"`).exec(tag) || [])[1];

/** "w26.01", "w 202601", "mwb26.01", "g25.3", "lff" → { pub, issue }; null se non sembra un simbolo. */
function parseSymbol(s) {
  s = String(s).trim().toLowerCase();
  let m = /^([a-z][a-z0-9-]*?)\s*(\d{2})\.(\d{1,2})$/.exec(s);
  if (m && +m[3] >= 1 && +m[3] <= 12) return { pub: m[1], issue: `20${m[2]}${m[3].padStart(2, '0')}` };
  m = /^([a-z][a-z-]*?)\s*(\d{6}|\d{8})$/.exec(s);
  if (m) return { pub: m[1], issue: m[2] };
  return /^[a-z][a-z0-9-]*$/.test(s) ? { pub: s, issue: '' } : null;
}

/**
 * Testo di un rimando ("(Matt. 15:21-28)", "Riv. 21:3, 4", "Ebr. 5:14–6:1", "Isa 17-20", "Giuda 3") → [inizio, fine] in codici
 * LLCCCVVV (fine '' se è un versetto solo), con parseReference della Bibbia caricata; null se non è un versetto.
 */
function refRange(bible, text) {
  const s = text.replace(/[()]/g, '').replace(/[\s;,.]+$/, '').trim();
  const m = /^(.*?[^\d\s])\s*(\d+)(?::(\d+))?([\s\S]*)$/.exec(s);
  if (!m) return null;
  const r = bible.parseReference(`${m[1]} ${m[2]}${m[3] ? `:${m[3]}` : ''}`);
  if (!r || r.invalid || !r.chapter) return null;
  const last = (c) => {
    let v = 1;
    while (bible.validCodes && bible.validCodes.has(verseCode(r.book, c, v + 1))) v++;
    return v;
  };
  const start = verseCode(r.book, r.chapter, r.verse || 1);
  const x = /(\d+)(?::(\d+))?\s*$/.exec(m[4]);
  let end = '';
  if (x && r.verse && x[2]) end = verseCode(r.book, +x[1], +x[2]);
  else if (x && r.verse) end = verseCode(r.book, r.chapter, +x[1]);
  else if (x && !m[3]) end = verseCode(r.book, +x[1], last(+x[1]));
  else if (!r.verse) end = verseCode(r.book, r.chapter, last(r.chapter));
  return [start, end > start ? end : ''];
}

/** Chiusura di un link dell'EPUB: versetto, nota, rimando a un'altra pubblicazione, documento dello stesso EPUB, sito. */
function linkMd(link, st) {
  let [, pre, txt, post] = /^(\s*)([\s\S]*?)(\s*)$/.exec(link.text);
  const label = () => txt.replace(/\|/g, '');
  let m;
  if ((m = /^#citation(\d+)$/.exec(link.href))) {
    // Punteggiatura fuori dal link: "([Sal. 34:7](…); [Isa. 54:17](…))".
    const p = /^([\s\S]*?)([;,.]*)$/.exec(txt);
    txt = p[1];
    post = p[2] + post;
    const r = st.bible && refRange(st.bible, st.cite.get(m[1]) || txt);
    if (!r) return pre + txt + post;
    if (st.pid) st.cites.push([st.pid, r[0], r[1] || r[0]]);
    st.refs.add(r[0]);
    return `${pre}[${txt}](${jwLink(r[0], r[1])})${post}`;
  }
  if ((m = /^#footnote(\d+)$/.exec(link.href))) return `[^${m[1]}]`;
  if ((m = /-extracted\.xhtml#pcitation(\d+)$/.exec(link.href))) {
    const pc = st.pcite.get(m[1]);
    const file = pc && st.findRef(pc.ref);
    if (!file) return pre + txt + post;
    const par = pc.par && /\bpar\./.test(`${pc.ref} ${txt}`) ? `#^p${pc.par}` : '';
    return `${pre}[[${file}${par}|${label()}]]${post}`;
  }
  if ((m = /^(\d+)\.xhtml(?:#p(\d+))?$/.exec(link.href)) && st.fileOf.has(m[1])) return `${pre}[[${st.fileOf.get(m[1])}${m[2] ? `#^p${m[2]}` : ''}|${label()}]]${post}`;
  if (/^https?:/.test(link.href)) return `${pre}[${txt}](${link.href})${post}`;
  return link.text;
}

/** HTML in linea → Markdown, come le note esportate: grassetto **, corsivo _, <sup>, link (solo il testo, senza stili). */
function inlineMd(html, st) {
  html = html.replace(/<strong>(<a [^>]*>[\s\S]*?<\/a>)<\/strong>/g, '$1');
  let out = '';
  let link = null;
  for (const [tok] of html.matchAll(/<[^>]*>|[^<]+/g)) {
    if (tok[0] !== '<') {
      // Solo gli spazi normali: quello non separabile resta.
      const t = decode(tok.replace(/[ \t\r\n]+/g, ' ')).replace(/([[\]*_])/g, '\\$1');
      if (link) link.text += t;
      else out += t;
      continue;
    }
    let m;
    if (link) {
      if (tok === '</a>') (out += linkMd(link, st)), (link = null);
    } else if ((m = /^<a\b[^>]*\bhref="([^"]*)"/.exec(tok))) link = { href: decode(m[1]), text: '' };
    else if (/^<\/?strong\b/.test(tok)) out += '**';
    else if (/^<\/?em\b/.test(tok)) out += '_';
    else if ((m = /^<(\/?)(sup|sub)\b/.exec(tok))) out += `<${m[1]}${m[2]}>`;
    else if (/^<br\b/.test(tok)) out += ' ';
  }
  return out.replace(/\*\*\*\*/g, '');
}

const trimSp = (s) => s.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
const BLOCK_RE =
  /<(p|h[1-6])\b([^>]*)>([\s\S]*?)<\/\1>|<div class="gen-field"[^>]*data-pid="(\d+)"[^>]*>\s*<label[^>]*>([^<]*)<\/label>|<div [^>]*data-pid="(\d+)"[^>]*class="boxTtl[^"]*">([\s\S]*?)<\/div>\s*<\/div>|<img [^>]*src="([^"]+)"|<hr\b|<(\/?)(?:ul|ol)\b|<li\b/g;

/**
 * Un documento dell'EPUB → corpo Markdown nel formato delle pubblicazioni (^pN = data-pid, domande col pid del
 * paragrafo che le segue, "La tua risposta ^pN", immagini ![[nome]], note in calce). ctx: { bible, fileOf, extracted, findRef, images, dir }.
 */
function docMd(html, ctx) {
  const st = { ...ctx, pid: 0, cites: [], refs: new Set() };
  // Versetti citati: id="citationN" → "(Matt. 5:3)", il riferimento completo anche quando il link dice "vv. 15 e 16".
  st.cite = new Map([...html.matchAll(/id="citation(\d+)"[^>]*>(?:(?!<\/div>)[\s\S])*?<strong>\(([^<]*)\)<\/strong>/g)].map((m) => [m[1], decode(m[2])]));
  // Altre pubblicazioni: intestazione del testo estratto ("***w18 giugno p. 7 Titolo***") e primo paragrafo (classe pN).
  st.pcite = new Map();
  for (const m of (ctx.extracted || '').matchAll(/<span id="pcitation(\d+)"><\/span>([\s\S]*?)<\/a><\/p>([\s\S]*?)(?=<div class="extPubRef">|$)/g))
    st.pcite.set(m[1], { ref: decode(m[2].replace(/<[^>]*>/g, '')).replace(/\*/g, '').trim(), par: (/<p class="p(\d+)\b/.exec(m[3]) || [])[1] });

  const from = Math.max(0, html.search(/<body\b/));
  const to = html.slice(from).search(/<div class="(groupFootnote|groupExt)">/);
  const body = html.slice(from, to < 0 ? undefined : from + to);
  const blocks = [];
  const anchors = [];
  let depth = 0;
  let liNew = false;
  const push = (t) => {
    blocks.push({ t: depth ? `${liNew ? '-   ' : '    '}${t}` : t, li: depth > 0 });
    liNew = false;
  };
  for (const m of body.matchAll(BLOCK_RE)) {
    if (m[1]) {
      const head = m[1][0] === 'h';
      let id = attr(m[2], 'data-pid');
      // Domanda (p.qu, senza data-pid): il pid è nel data-rel-pid del paragrafo che segue.
      if (!id && /\bqu\b/.test(attr(m[2], 'class') || '')) id = (/data-rel-pid="\[(\d+)/.exec(body.slice(m.index + m[0].length)) || [])[1];
      st.pid = +id || 0;
      let t = trimSp(inlineMd(m[3], st));
      if (head) {
        t = t.replace(/\*\*/g, '').trim();
        if (t) push(`${'#'.repeat(+m[1][1])} ${t.replace(/^(\d+)\./, '$1\\.')}`);
        continue;
      }
      t = t.replace(/^(\d+)\.(\s)/, '$1\\.$2');
      if (!t && !id) continue;
      push(id ? `${t} ^p${id}` : t);
      if (id) anchors.push(+id);
    } else if (m[4]) {
      push(`${decode(m[5]).trim() || 'La tua risposta'} ^p${m[4]}`);
      anchors.push(+m[4]);
    } else if (m[6]) {
      push(`## ${inlineMd(m[7], { ...st, pid: 0 }).replace(/\*\*/g, '').trim()}`);
      push(` ^p${m[6]}`);
      anchors.push(+m[6]);
    } else if (m[8]) {
      ctx.images.add(ctx.dir + decode(m[8]).replace(/^\.\//, ''));
      push(`![[${decode(m[8]).split('/').pop()}]]`);
    } else if (m[0] === '<hr') push('* * *');
    else if (m[0] === '<li') liNew = true;
    else depth = Math.max(0, depth + (m[9] ? -1 : 1));
  }
  // Elenchi come nelle note esportate: righe vuote rientrate tra i blocchi dello stesso elenco.
  let out = '';
  blocks.forEach((b, i) => {
    if (i) out += blocks[i - 1].li ? (b.li ? '\n    \n' : '\n    \n\n') : '\n\n';
    out += b.t;
  });
  if (blocks.length && blocks[blocks.length - 1].li) out += '\n    \n';
  // Note in calce in fondo, una per riga: il loro pid va negli anchors e nei cites, ma non nel testo (come nelle note esportate).
  const notes = [];
  for (const m of html.matchAll(/<div id="footnote(\d+)">\s*<p([^>]*)>\s*<a [^>]*>[^<]*<\/a>([\s\S]*?)<\/p>/g)) {
    st.pid = +attr(m[2], 'data-pid') || 0;
    if (st.pid) anchors.push(st.pid);
    notes.push(`[^${m[1]}]: ${trimSp(inlineMd(m[3], st))}`);
  }
  if (notes.length) out += `\n\n${notes.join('\n')}`;
  return { body: out, anchors, cites: st.cites, refs: [...st.refs] };
}

// Mesi inglesi, per i titoli delle pubblicazioni inglesi ("The Watchtower, January 2026").
const MONTHS_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "La Torre di Guardia, gennaio 2026" o "The Watchtower, January 2026" → "202601" (titolo dell'EPUB, quando il nome del file non ha il numero). */
function issueFromTitle(title) {
  const m = new RegExp(`\\b(${[...MONTHS, ...MONTHS_EN].join('|')})\\b[^\\d]*(\\d{4})`).exec(norm(title));
  return m ? `${m[2]}${String((MONTHS.indexOf(m[1]) + 1 || MONTHS_EN.indexOf(m[1]) + 1)).padStart(2, '0')}` : '';
}

/**
 * EPUB di una pubblicazione (ArrayBuffer o { size, read }) → documenti Markdown nel formato di .lampada/markdown/.
 * opts: { symbol, issue, title, fileName, bible, findRef(rimando) → nome del file o null }.
 * Ritorna { symbol, issue, title, docs: [{ id, title, file, rel, md, anchors, cites }], pubFile: [rel, md], images, files }.
 */
async function convertPubEpub(src, opts = {}) {
  const td = new TextDecoder();
  const texts = {};
  for (const [n, d] of Object.entries(await unzipEntries(src, (n) => /\.(xhtml|opf)$/i.test(n)))) texts[n] = td.decode(d);
  const opfName = Object.keys(texts).find((n) => n.endsWith('.opf'));
  if (!opfName) throw new Error(t('Il file non è un EPUB.'));
  const opf = texts[opfName];
  const dir = opfName.replace(/[^/]*$/, '');
  // Documenti nell'ordine di lettura: le xhtml che hanno come nome il docId.
  const hrefOf = new Map([...opf.matchAll(/<item\b[^>]*>/g)].map(([t]) => [attr(t, 'id'), attr(t, 'href')]));
  const docs = [...opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)]
    .map((m) => hrefOf.get(m[1]))
    .filter((h) => h && /^\d+\.xhtml$/.test(h) && texts[dir + h])
    .map((h) => {
      const html = texts[dir + h];
      const id = h.slice(0, -6);
      return { id, html, title: decode((/<title>([^<]*)<\/title>/.exec(html) || [])[1] || id).trim(), cls: (/<body\b[^>]*class="([^"]*)"/.exec(html) || [])[1] || '' };
    });
  if (!docs.length) throw new Error(t('Nell’EPUB non ci sono documenti da importare.'));
  const fromName = /^([a-z0-9-]+)_[a-z]+(?:_(\d{6,8}))?\.epub$/i.exec(opts.fileName || '') || [];
  // Simbolo dal sito come lo scrive lui (T-31, come le esportazioni .jwpub); ricavato dal file: minuscolo.
  const symbol = opts.symbol || ((/\bpub-(\S+)/.exec(docs[0].cls) || [])[1] || fromName[1] || '').toLowerCase();
  if (!symbol) throw new Error(t('Non trovo il simbolo della pubblicazione.'));
  const dcTitle = decode((/<dc:title[^>]*>([^<]*)</.exec(opf) || [])[1] || '').trim();
  const issue = opts.issue || fromName[2] || (CATEGORY[symbol] ? issueFromTitle(dcTitle) : '');
  const title = opts.title || dcTitle.replace(/,[^,]*\d{4}\s*$/, '').trim() || symbol;

  const year = issue.slice(0, 4);
  const base = issue ? `${symbol}/${year}/${issue}/` : `${symbol}/`;
  const code = symbol + issue;
  const pubTitle = issue ? `${title} ${year}` : title;
  for (const d of docs) {
    d.file = `${code}_${slugify(d.title) || 'documento'}_${d.id}`;
    d.rel = `${base}${d.file}.md`;
  }
  const images = new Set();
  const ctx = { bible: opts.bible, fileOf: new Map(docs.map((d) => [d.id, d.file])), findRef: opts.findRef || (() => null), images, dir };
  for (const d of docs) {
    const r = docMd(d.html, { ...ctx, extracted: texts[`${dir}${d.id}-extracted.xhtml`] });
    const docClass = (/\bdocClass-(\d+)/.exec(d.cls) || [])[1];
    const fm = ['---', `title: ${q(d.title)}`, 'aliases:', `  - ${q(d.title)}`, `  - ${q(d.id)}`, 'type: "document"', `book_code: ${q(code)}`, issue && `issue: ${q(issue)}`, `publication: ${q(pubTitle)}`, docClass && `doc_class: ${q(docClass)}`, `id: ${q(d.id)}`];
    if (r.refs.length) fm.push('bible_refs:', ...r.refs.map((c) => `  - ${q(c)}`));
    d.md = `${fm.filter(Boolean).join('\n')}\n---\n\n${r.body}\n`;
    d.anchors = r.anchors;
    d.cites = r.cites;
    delete d.html;
  }
  const pubMd = ['---', `title: ${q(pubTitle)}`, 'aliases:', `  - ${q(pubTitle)}`, `  - ${q(code)}`, 'type: "publication"', `book_code: ${q(code)}`, '---', '', `# ${pubTitle}`, '', '## Documenti', '', ...docs.map((d) => `- [[${d.file}|${d.title}]]`), ''];
  const files = Object.fromEntries(Object.entries(texts).filter(([n]) => n.endsWith('.xhtml')));
  return { symbol, issue, title, docs, pubFile: [`${base}${code}.md`, pubMd.join('\n')], images: [...images], files };
}

/** Rimandi ad altre pubblicazioni ("w18 giugno p. 7 Titolo", "sjj cantico 97 Titolo") → nome del file nella biblioteca. */
function refFinder(lib) {
  return (ref) => {
    const tok = ref.split(/\s/)[0].toLowerCase();
    let pub = lib.bySym.get(tok);
    let yy = '';
    if (!pub && /\d{2}$/.test(tok)) (pub = lib.bySym.get(tok.slice(0, -2))), (yy = tok.slice(-2));
    if (!pub) return null;
    const key = nameKey(ref.slice(tok.length));
    let hits = pub.docs.filter((d) => {
      const k = nameKey(d.title);
      return k.length > 3 && key.endsWith(k);
    });
    // ponytail: titoli uguali in anni diversi → quello dell'anno della citazione (w18 → 2018), altrimenti il primo.
    if (hits.length > 1 && yy) hits = hits.filter((d) => (d.issue || '').slice(2, 4) === yy).concat(hits);
    return hits.length ? hits[0].file : null;
  };
}

/**
 * Scrive la pubblicazione convertita in .lampada/markdown/ (stessi percorsi a ogni importazione: niente doppioni).
 * Un indice scritto da un'altra fonte (senza source: "epub") non si tocca: se ha già questi documenti non si importa
 * niente ({ skipped: true }), altrimenti i nuovi documenti vanno in index/<simbolo>.epub.json, che la biblioteca unisce.
 */
async function saveEpub(plugin, res, src, progress) {
  const a = plugin.app.vault.adapter;
  const prefix = plugin.bible.prefix;
  const readIdx = (p) => a.read(prefix + p).then(JSON.parse).catch(() => null);
  let idxPath = `index/${res.symbol}.json`;
  let idx = await readIdx(idxPath);
  if (idx && idx.source !== 'epub') {
    if (res.docs.some((d) => idx.docs && idx.docs[d.id])) return { skipped: true };
    const other = idx;
    idxPath = `index/${res.symbol}.epub.json`;
    idx = (await readIdx(idxPath)) || { title: other.title, category: other.category };
  }
  idx = { symbol: res.symbol, title: res.title, folder: res.symbol, category: res.category, ...idx, source: 'epub', lang: res.lang, docs: (idx && idx.docs) || {}, verses: {}, books: {} };
  const enc = new TextEncoder();
  const put = (p, text) => writeBinary(plugin.app, prefix + p, enc.encode(text).buffer);
  let i = 0;
  for (const d of res.docs) {
    const old = idx.docs[d.id];
    if (old && old.rel !== d.rel) await a.remove(prefix + old.rel).catch(() => null);
    await put(d.rel, d.md);
    idx.docs[d.id] = { file: d.file, rel: d.rel, title: d.title, anchors: d.anchors, cites: d.cites };
    progress(t('Salvo… {n}%', { n: Math.round((++i * 100) / res.docs.length) }));
  }
  await put(...res.pubFile);
  if (res.images.length) {
    progress(t('Salvo le immagini…'));
    const want = new Set(res.images);
    for (const [n, data] of Object.entries(await unzipEntries(src, (n) => want.has(n)))) await writeBinary(plugin.app, `${prefix}_media/${res.symbol}/${n.split('/').pop()}`, data.buffer);
  }
  // L'indice per ultimo: se la scrittura si interrompe, la biblioteca non vede una pubblicazione a metà.
  await put(idxPath, JSON.stringify(idx));
  try {
    await epubExtras(plugin, { symbol: res.symbol, issue: res.issue || null, files: res.files });
  } catch (e) {
    console.warn('[lampada] dati in più dall’EPUB', e);
  }
  return { skipped: false };
}

/** EPUB (ArrayBuffer o { size, read }) → pubblicazione nel vault. meta: { symbol, issue, title, fileName }. */
async function importEpub(plugin, src, meta = {}, progress = () => {}) {
  progress(t('Converto…'));
  const bible = await plugin.bible.ensureLoaded().then(() => plugin.bible, () => null);
  const lib = await plugin.library.ensureLoaded().then(() => plugin.library, () => null);
  const res = await convertPubEpub(src, { ...meta, bible, findRef: lib ? refFinder(lib) : null });
  res.lang = plugin.settings.bibleLang || 'I';
  // ponytail: una pubblicazione nuova che non è un periodico noto va tra i libri (o nella categoria data da chi chiama).
  const asked = LIB_CATEGORIES.some(([id]) => id === meta.category) && meta.category;
  res.category = (lib && lib.bySym.get(res.symbol)?.category) || CATEGORY[res.symbol] || asked || 'libri';
  return { ...res, ...(await saveEpub(plugin, res, src, progress)) };
}

/** Sorgente per unzipEntries che legge con richieste Range (il sito risponde 206): solo le voci che servono. */
const rangeSource = (url, size) => ({
  size,
  read: async (s, e) => {
    const r = await requestUrl({ url, headers: { Range: `bytes=${s}-${e - 1}` } });
    if (r.status !== 206) throw new Error(t('Il sito non permette di scaricare solo una parte del file.'));
    return new Uint8Array(r.arrayBuffer);
  },
});

/**
 * Scarica gli EPUB trovati con l'API (una conferma "Scarica da jw.org" per tutti) e li importa.
 * Sul telefono, sopra 40 MB, legge solo le voci che servono.
 */
async function importInfos(plugin, infos, progress) {
  const out = [];
  await jwDownload(plugin.app, infos, async (info, buf, say) => {
    const p = (t) => (say(t), progress(t));
    const src = buf || rangeSource(info.url, info.size);
    out.push(await importEpub(plugin, src, { symbol: info.pub, issue: /^\d{6,8}$/.test(info.issue || '') ? info.issue : '', title: info.title, category: info.category }, p));
  });
  return out;
}

const importInfo = async (plugin, info, progress) => (await importInfos(plugin, [info], progress))[0];

const siteLang = (plugin) => plugin.settings.bibleLang || 'I';

/**
 * Nuovi numeri: per ogni periodico con un numero nell'ultimo anno prova i successivi all'ultimo, con il passo dei
 * numeri che ci sono (mensile, bimestrale…). 404 = non ancora uscito: lì si ferma. Ritorna i numeri importati.
 */
async function newIssues(plugin, progress = () => {}) {
  await plugin.library.ensureLoaded();
  const months = (k) => +k.slice(0, 4) * 12 + +k.slice(4, 6) - 1;
  const key = (n) => `${Math.floor(n / 12)}${String((n % 12) + 1).padStart(2, '0')}`;
  const now = new Date();
  const found = [];
  const infos = [];
  for (const p of plugin.library.pubs) {
    const keys = [...new Set((p.issues || []).map((i) => i.key).filter((k) => /^\d{6}$/.test(k)))].map(months).sort((x, y) => x - y);
    if (!keys.length || keys[keys.length - 1] < now.getFullYear() * 12 + now.getMonth() - 12) continue;
    const gaps = keys.slice(-5).map((k, i, l) => k - l[i - 1]).slice(1);
    const step = gaps.length ? Math.min(...gaps) : 1;
    for (let n = keys[keys.length - 1] + step; ; n += step) {
      progress(t('{title}, {issue}: cerco…', { title: p.title, issue: issueLabel(key(n)) }));
      const info = await epubInfo(siteLang(plugin), p.symbol, key(n));
      if (!info) break;
      infos.push({ ...info, label: `${p.title}, ${issueLabel(key(n))}` });
    }
  }
  if (infos.length) found.push(...(await importInfos(plugin, infos, progress)).filter((r) => !r.skipped));
  return found;
}

/** Dopo un'importazione: ricarica e apre la pubblicazione (il numero, per i periodici). */
async function openImported(plugin, r) {
  await plugin.refresh();
  await plugin.openLibraryAt(r.issue ? { mode: 'issue', sym: r.symbol, issue: r.issue } : { mode: 'pub', sym: r.symbol });
}

const skippedText = (r) => t('«{title}» c’è già, da una fonte più completa: non lo sostituisco.', { title: `${r.title}${r.issue ? ` ${issueLabel(r.issue)}` : ''}` });
const errText = (e) => t('Non riuscito: {why}', { why: (e && e.message) || e });
const addedText = (list) => t('Aggiunti: {list}', { list: list.map((r) => `${r.symbol} ${issueLabel(r.issue)}`).join(', ') });

/** Comando "Cerca nuovi numeri": avanzamento in un avviso. */
async function runNewIssues(plugin) {
  const n = new Notice(t('Cerco nuovi numeri…'), 0);
  try {
    const found = await newIssues(plugin, (t) => n.setMessage(t));
    n.hide();
    if (!found.length) return new Notice(t('Nessun numero nuovo.'));
    new Notice(addedText(found));
    await openImported(plugin, found[found.length - 1]);
  } catch (e) {
    n.hide();
    if (e && e.cancelled) return;
    console.warn('[lampada] nuovi numeri', e);
    new Notice(errText(e));
  }
}

/** Finestra "Importa…": da un file EPUB, per simbolo, nuovi numeri. */
class EpubImportModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.say = (t, err = false) => {
      this.status.setText(t);
      this.status.toggleClass('mod-error', err);
    };
  }

  onOpen() {
    const el = this.contentEl;
    const plugin = this.plugin;
    this.titleEl.setText(t('Importa pubblicazioni'));

    el.createEl('h4', { text: t('Da un file EPUB') });
    const input = el.createEl('input', { type: 'file', attr: { accept: '.epub,application/epub+zip', style: 'display:none' } });
    el.createEl('button', { cls: 'mod-cta', text: t('Scegli un EPUB…') }).addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      input.value = '';
      // Dal Blob si leggono solo le voci che servono: va bene anche sul telefono.
      const src = f && { size: f.size, read: async (s, e) => new Uint8Array(await f.slice(s, e).arrayBuffer()) };
      if (f) this.run(() => importEpub(plugin, src, { fileName: f.name }, this.say));
    });

    el.createEl('h4', { text: t('Per simbolo') });
    const row = el.createDiv('lmp-bible-dl-row');
    const sym = row.createEl('input', { type: 'text', cls: 'lmp-epub-sym', attr: { placeholder: 'w26.01, mwb26.01, lff…', 'aria-label': t('Simbolo'), autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' } });
    const get = row.createEl('button', { text: t('Scarica da jw.org') });
    el.createDiv({ cls: 'setting-item-description', text: t('Come nelle citazioni: simbolo, poi anno e mese del numero.') });
    const go = () => {
      const s = parseSymbol(sym.value);
      if (!s) return this.say(t('Scrivi un simbolo, ad esempio w26.01 o lff.'), true);
      this.run(async () => {
        this.say(t('Cerco…'));
        const info = await epubInfo(siteLang(plugin), s.pub, s.issue);
        if (!info) throw new Error(t('«{sym}» non c’è: controlla il simbolo, o il numero non è ancora uscito.', { sym: sym.value.trim() }));
        return importInfo(plugin, info, this.say);
      });
    };
    get.addEventListener('click', go);
    sym.addEventListener('keydown', (e) => e.key === 'Enter' && go());

    el.createEl('h4', { text: t('Nuovi numeri') });
    el.createDiv({ cls: 'setting-item-description', text: t('Cerca i numeri successivi dei periodici che hai già.') });
    el.createEl('button', { text: t('Cerca nuovi numeri') }).addEventListener('click', () =>
      this.run(async () => {
        const found = await newIssues(plugin, this.say);
        if (!found.length) return { none: true };
        return { ...found[found.length - 1], list: found };
      })
    );
    this.status = el.createDiv({ cls: 'lmp-bible-dl-status', attr: { 'aria-live': 'polite' } });
  }

  async run(fn) {
    const ctrls = [...this.contentEl.querySelectorAll('button, input')];
    ctrls.forEach((c) => (c.disabled = true));
    try {
      const r = await fn();
      if (r.none) return this.say(t('Nessun numero nuovo.'));
      if (r.skipped) return this.say(skippedText(r));
      new Notice(r.list ? addedText(r.list) : t('Importato: {title}', { title: r.title }));
      this.close();
      await openImported(this.plugin, r);
    } catch (e) {
      if (e && e.cancelled) return this.say('');
      console.warn('[lampada] importazione EPUB', e);
      this.say(errText(e), true);
    } finally {
      ctrls.forEach((c) => (c.disabled = false));
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

export { EpubImportModal, convertPubEpub, importEpub, importInfo, newIssues, parseSymbol, refRange, runNewIssues };
