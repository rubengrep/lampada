import { CATEGORIES } from './costanti.js';

/* ------------------------------------------------------------------ */
/* Utility                                                             */
/* ------------------------------------------------------------------ */

function norm(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function nameKey(s) {
  return norm(s).replace(/[^a-z0-9]/g, '');
}

function pad(n, w) {
  return String(n).padStart(w, '0');
}

function verseCode(b, c, v) {
  return pad(b, 2) + pad(c, 3) + pad(v, 3);
}

function stripFrontmatter(text) {
  text = text.replace(/\r\n/g, '\n');
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text;
  const nl = text.indexOf('\n', end + 4);
  return nl === -1 ? '' : text.slice(nl + 1);
}

function splitParagraphs(text) {
  // Niente \s: le righe poetiche iniziano con NBSP, che va preservato.
  return text
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/\n/g, ' '))
    .filter((p) => p.trim().length);
}

function cleanInline(s) {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/\\([\[\]*_])/g, '$1')
    .replace(/[  \t]+/g, ' ');
}

function tokenizeInline(s) {
  const out = [];
  // Note in calce [^n] e segni dei riferimenti a margine [+](#rN) (N = primo riferimento del gruppo).
  const re = /\[\^(\w+)\]|\[\+\]\(#r(\d+)\)/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ t: 'text', s: cleanInline(s.slice(last, m.index)) });
    if (m[2]) out.push({ t: 'ref', n: +m[2] });
    else out.push({ t: 'fn', n: m[1] });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ t: 'text', s: cleanInline(s.slice(last)) });
  return out.filter((t) => t.t !== 'text' || t.s.length);
}

// "**[[giovanni_3_16|16]]**" (vecchio formato) oppure "**[16](jwlibrary:///finder?bible=43003016)**".
const VERSE_MARK_RE = /\*\*(?:\[\[([^\]|]+)\|(\d+)\]\]|\[(\d+)\]\(jwlibrary:[^)]*?bible=(\d{7,8})[^)]*\))\*\*/g;
const NAV_LINE_RE = /^\s*\[\[[^\]]+\]\](?:\s*·\s*\[\[[^\]]+\]\])*\s*$/;

/**
 * Trasforma il markdown di un capitolo in blocchi (titoli, soprascritte, paragrafi/righe poetiche)
 * composti da segmenti di versetto, più le note in calce e il testo semplice di ogni versetto.
 */
function parseChapterMarkdown(text) {
  const body = stripFrontmatter(text);
  const footnotes = {};
  const kept = [];
  for (const line of body.split('\n')) {
    const m = /^\[\^(\w+)\]:\s?(.*)$/.exec(line);
    if (m) footnotes[m[1]] = m[2].trim();
    else kept.push(line);
  }

  let paras = splitParagraphs(kept.join('\n')).filter((p) => !NAV_LINE_RE.test(p));
  // L'esportazione ripete il testo delle note come paragrafi semplici prima delle definizioni.
  const fnTexts = new Set(Object.values(footnotes));
  while (paras.length && fnTexts.has(paras[paras.length - 1].trim())) paras.pop();

  // Poesia: l'esportazione mette un NBSP prima del numero dei versetti poetici; le righe brevi
  // adiacenti (prima riga del blocco, righe di continuazione) fanno parte dello stesso blocco.
  const isHeading = paras.map((p) => /^#{1,6}\s/.test(p.trim()));
  const poetryFlags = paras.map((p, i) => !isHeading[i] && /^ ? /.test(p));
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < paras.length; i++) {
      if (poetryFlags[i] || isHeading[i] || paras[i].length > 200) continue;
      if (poetryFlags[i - 1] || poetryFlags[i + 1]) {
        poetryFlags[i] = true;
        changed = true;
      }
    }
  }

  const blocks = [];
  const verseLines = new Map();
  let cur = 0;

  for (let pi = 0; pi < paras.length; pi++) {
    const raw = paras[pi];
    const h = /^(#{1,6})\s+(.*)$/.exec(raw.trim());
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: cleanInline(h[2]).trim() });
      continue;
    }

    const poetry = poetryFlags[pi];
    const indent = poetry && !/^[  ]*\*\*\[/.test(raw);

    const segs = [];
    const pushText = (s) => {
      const tokens = tokenizeInline(s);
      if (!tokens.length) return;
      const lastSeg = segs[segs.length - 1];
      if (lastSeg && lastSeg.v === cur) lastSeg.tokens.push(...tokens);
      else segs.push({ v: cur, marker: null, tokens });
    };

    VERSE_MARK_RE.lastIndex = 0;
    let last = 0;
    let m;
    while ((m = VERSE_MARK_RE.exec(raw))) {
      pushText(raw.slice(last, m.index));
      const vn = m[1] ? parseInt(m[1].split('_').pop(), 10) : parseCode(m[4]).verse;
      cur = isNaN(vn) ? cur + 1 : vn;
      segs.push({ v: cur, marker: m[2] || m[3], tokens: [] });
      last = VERSE_MARK_RE.lastIndex;
    }
    pushText(raw.slice(last));
    if (!segs.length) continue;

    // Spazi iniziali dopo il numero di versetto e a fine paragrafo.
    for (const seg of segs) {
      const first = seg.tokens[0];
      if ((seg.marker || seg === segs[0]) && first && first.t === 'text') first.s = first.s.replace(/^ +/, '');
    }
    const lastSeg = segs[segs.length - 1];
    const lastTok = lastSeg.tokens[lastSeg.tokens.length - 1];
    if (lastTok && lastTok.t === 'text') lastTok.s = lastTok.s.replace(/ +$/, '');
    for (const seg of segs) seg.tokens = seg.tokens.filter((t) => t.t !== 'text' || t.s.length);
    const finalSegs = segs.filter((s) => s.marker || s.tokens.length);
    if (!finalSegs.length) continue;

    const isSuper = finalSegs.every((s) => s.v === 0);
    blocks.push({ type: isSuper ? 'super' : 'para', poetry: !isSuper && poetry, indent: !isSuper && indent, segs: finalSegs });

    for (const seg of segs) {
      if (!seg.v) continue;
      const txt = seg.tokens
        .filter((t) => t.t === 'text')
        .map((t) => t.s)
        .join('')
        .trim();
      if (!verseLines.has(seg.v)) verseLines.set(seg.v, []);
      if (txt) verseLines.get(seg.v).push(txt);
    }
  }

  const verseCount = verseLines.size ? Math.max(...verseLines.keys()) : 0;
  return { blocks, footnotes, verseLines, verseCount };
}

/** "1:32-33" → [32,33]; "89:3, 4" → [3,4]. */
function parseVerseList(label) {
  const m = /:\s*([\d\s,\-–]+)$/.exec(label);
  if (!m) return null;
  const out = [];
  for (const part of m[1].split(',')) {
    const r = /(\d+)\s*(?:[-–]\s*(\d+))?/.exec(part);
    if (!r) continue;
    const a = +r[1];
    const b = r[2] ? +r[2] : a;
    for (let v = a; v <= b && out.length < 30; v++) out.push(v);
  }
  return out.length ? out : null;
}

function compressVerses(list) {
  const sorted = [...list].sort((a, b) => a - b);
  const parts = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const v = sorted[i];
    if (v === prev + 1) {
      prev = v;
      continue;
    }
    parts.push(start === prev ? `${start}` : prev === start + 1 ? `${start}, ${prev}` : `${start}-${prev}`);
    start = prev = v;
  }
  return parts.join(', ');
}

function extractBlock(text, id) {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)([^\\n]*?)\\s+\\^${esc}[ \\t]*(?=\\n|$)`).exec(text);
  return m ? m[1].trim() : null;
}

function parseCode(code) {
  const s = String(code).padStart(8, '0');
  return { book: +s.slice(0, 2), chapter: +s.slice(2, 5), verse: +s.slice(5, 8) };
}

/** Codici JW Library BBCCCVVV (inizio ed eventuale fine) → riferimento. */
function refFromCodes(a, b) {
  const s = parseCode(a);
  const ref = { book: s.book, chapter: s.chapter };
  if (s.verse) ref.verse = s.verse;
  if (b) {
    const e = parseCode(b);
    if (e.book === s.book && e.chapter === s.chapter && e.verse > s.verse) ref.verseEnd = e.verse;
    else if (e.book === s.book && e.chapter > s.chapter) ref.endChapter = e.chapter;
  }
  return ref;
}

function jwLibraryUrl(ref) {
  let url = `jwlibrary:///finder?bible=${verseCode(ref.book, ref.chapter, ref.verse || 0)}`;
  if (ref.verse && ref.verseEnd && ref.verseEnd !== ref.verse) url += `-${verseCode(ref.book, ref.chapter, ref.verseEnd)}`;
  return url;
}

const JWLIB_LINK_RE = /\[([^\]]*)\]\((jwlibrary:\/\/\/?finder\?[^)\s]*)\)/g;

/** Riferimenti di una sezione "Riferimenti": [[link|etichetta]] o [etichetta](jwlibrary:…). */
function parseRefLinks(md) {
  const links = [];
  const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\((jwlibrary:[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(md))) {
    if (m[1]) links.push({ link: m[1].trim(), label: (m[2] || m[1]).trim() });
    else {
      const codes = codesFromJwUrl(m[4]);
      if (codes) links.push({ label: m[3].trim(), ref: refFromCodes(codes[0], codes[1]) });
    }
  }
  return links;
}

function codesFromJwUrl(url) {
  const m = /bible=(\d{7,8})(?:-(\d{7,8}))?/.exec(url);
  return m ? [m[1], m[2]] : null;
}

/**
 * Schema di un libro (Sommario o Panoramica): una voce per ogni punto dell'elenco col suo primo link biblico.
 * [{ depth, label, chapter, verse, endChapter, endVerse }], solo i punti del libro bookNum.
 */
function parseOutline(md, bookNum) {
  const out = [];
  for (const line of stripFrontmatter(md).split('\n')) {
    const m = /^(\s*)[-*]\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    const link = /\]\(jwlibrary:\/\/\/?finder\?[^)\s]*bible=(\d{7,8})(?:-(\d{7,8}))?/.exec(m[2]);
    if (!link) continue;
    const a = parseCode(link[1]);
    const b = parseCode(link[2] || link[1]);
    if (a.book !== bookNum) continue;
    const label = m[2].replace(/\s*\^[\w-]+$/, '').replace(JWLIB_LINK_RE, '$1').replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
    out.push({ depth: m[1].replace(/\t/g, '    ').length >> 2, label, chapter: a.chapter, verse: a.verse, endChapter: b.chapter, endVerse: b.verse });
  }
  const min = Math.min(...out.map((o) => o.depth));
  for (const o of out) o.depth -= min;
  return out;
}

function cleanSnippet(line) {
  return line
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/[\[\]]/g, '')
    .replace(/^\s*(?:[#>\-*+]|\d+\.)+\s*/, '')
    .replace(/[*_]{1,3}/g, '')
    .trim();
}

const sleep = (ms) => new Promise((r) => window.setTimeout(r, ms));

// Conteggio delle parole come JW Library: una parola può contenere : . - – ’ ' tra lettere o cifre
// ("dell’albero", "17:5", "14-16", "jw.org"); ogni altro segno di punteggiatura conta da solo.
// Verificato sulle evidenziazioni di un backup reale (Bibbia e pubblicazioni).
const JW_TOKEN_RE = /[\p{L}\p{N}]+(?:[:.\-–’'][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;

function jwTokenCount(text) {
  return (String(text).match(JW_TOKEN_RE) || []).length;
}

/** Divide un testo in parole/segni (w: true) e spazi (w: false), nello stesso ordine. */
function splitJwTokens(text) {
  const parts = [];
  const re = new RegExp(JW_TOKEN_RE.source, 'gu');
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ w: false, s: text.slice(last, m.index) });
    parts.push({ w: true, s: m[0] });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ w: false, s: text.slice(last) });
  return parts;
}

function newGuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

// Segno di un blocco di nota: "<!-- jwl:GUID -->", con l'evidenziazione collegata se c'è: "<!-- jwl:GUID | mark:GUID -->".
const JWL_MARKER_RE = /^<!-- jwl:([0-9A-Za-z-]{8,})(?:\s*\|\s*mark:([0-9A-Za-z-]{8,}))? -->$/;

function jwlMarker(n) {
  return `<!-- jwl:${n.guid}${n.mark ? ` | mark:${n.mark}` : ''} -->`;
}

/** Testo delle parole s..e (indici JW Library) di un versetto. */
function jwTokenText(text, s, e) {
  let n = 0;
  let out = '';
  for (const part of splitJwTokens(text)) {
    if (part.w) {
      if (n >= s && (e < 0 || n <= e)) out += part.s;
      n++;
    } else if (n > s && (e < 0 || n <= e)) out += part.s;
  }
  return out.trim();
}

/**
 * Nota di un versetto: frontmatter, citazione del versetto, blocchi di nota JW Library
 * ("### Titolo" + "<!-- jwl:GUID -->" + testo + riga di etichette) e altro testo libero.
 */
function parseNoteFile(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  if (lines[0] === '---') {
    i = 1;
    while (i < lines.length && lines[i].trim() !== '---') i++;
    i++;
  }
  const blocks = [];
  const rest = [];
  while (i < lines.length) {
    const head = /^### (.*)$/.exec(lines[i]);
    const marker = head && JWL_MARKER_RE.exec((lines[i + 1] || '').trim());
    if (!marker) {
      rest.push(lines[i++]);
      continue;
    }
    let j = i + 2;
    while (j < lines.length && !/^#{1,3} /.test(lines[j]) && !/^---\s*$/.test(lines[j])) j++;
    const body = lines.slice(i + 2, j);
    while (body.length && !body[body.length - 1].trim()) body.pop();
    let tags = [];
    let date = '';
    const meta = body.length ? /^((?:#[^\s#]+\s*)*)(?:·\s*)?(\*JW Library · \d{4}-\d{2}-\d{2}\*)?\s*$/.exec(body[body.length - 1].trim()) : null;
    if (meta && (meta[1].trim() || meta[2])) {
      tags = [...meta[1].matchAll(/#([^\s#]+)/g)].map((m) => m[1]);
      date = meta[2] || '';
      body.pop();
    }
    while (body.length && !body[0].trim()) body.shift();
    let linkLine = '';
    if (body.length && /^\*\*.*jwlibrary:\/\/\/finder\?docid=/.test(body[0])) linkLine = body.shift();
    blocks.push({ guid: marker[1], mark: marker[2] || '', title: head[1].trim(), content: body.join('\n').trim(), tags, date, linkLine, start: i, end: j });
    i = j;
  }
  return { lines, blocks, rest: rest.join('\n') };
}

function formatNoteBlock(n) {
  const out = [`### ${(n.title || '').replace(/\s+/g, ' ').trim() || 'Nota'}`, jwlMarker(n)];
  if (n.linkLine) out.push(n.linkLine);
  if (n.content && n.content.trim()) out.push('', n.content.trim());
  const meta = [n.tags && n.tags.length ? n.tags.map((t) => `#${t}`).join(' ') : '', n.date || ''].filter(Boolean).join(' · ');
  if (meta) out.push('', meta);
  return out.join('\n');
}

/** Testo libero della nota, senza la citazione del versetto in testa. */
function noteFreeText(rest) {
  const lines = rest.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (/^>\s*\[!quote\]/.test(lines[i] || '')) {
    i++;
    while (i < lines.length && /^>/.test(lines[i])) i++;
  }
  return lines.slice(i).join('\n').trim();
}

function categoryOf(num) {
  const c = CATEGORIES.find((c) => num >= c.from && num <= c.to);
  return c ? c.id : 'pent';
}

/* ---------------- frasi e allineamento tra due lingue (interlineare per frase) ---------------- */

// Abbreviazioni dopo cui il punto non chiude la frase (italiano e inglese).
const SENT_ABBR_RE = /(?:^|[\s(])(?:a\.E\.V|E\.V|a\.C|d\.C|B\.C\.E|C\.E|ecc|cfr|vol|nn?|pp?|vv?|cap|ca|par|e\.g|i\.e|etc|vs|Mr|Mrs|Dr|St|ft)$/i;

/** Posizioni in cui finisce una frase: dopo . ! ? … (e virgolette o parentesi chiuse), prima di spazio e maiuscola. */
function sentenceEnds(text) {
  const out = [];
  const re = /[.!?…]+["”»’)\]]*(?=\s+["“«(‘]?\p{Lu})/gu;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 12), m.index);
    // "ecc. Poi", "J. F. Rutherford": non sono fine frase.
    if (m[0][0] === '.' && (SENT_ABBR_RE.test(before) || /(?:^|[\s.])\p{Lu}$/u.test(before))) continue;
    out.push(m.index + m[0].length);
  }
  return out;
}

/** Frasi di un testo: [{ s, start, end }] (posizioni nel testo; end = dove la frase finisce). */
function splitSentences(text) {
  const out = [];
  let start = 0;
  for (const end of [...sentenceEnds(text), text.length]) {
    // "… messengers. (Ge 16:7) Angels …": il riferimento tra parentesi dopo il punto è della frase prima.
    const lead = out.length ? /^\s*\([^()]*\)/.exec(text.slice(start, end)) : null;
    if (lead) {
      const prev = out[out.length - 1];
      start += lead[0].length;
      prev.end = start;
      prev.s = text.slice(prev.start, start).trim();
    }
    const s = text.slice(start, end).trim();
    if (s) out.push({ s, start, end });
    start = end;
  }
  return out;
}

// Normale standard (Abramowitz e Stegun 7.1.26): basta per il metodo di Gale e Church.
function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// Abbinamenti possibili (frasi di qua → frasi di là) e quanto sono frequenti nelle traduzioni.
const BEADS = [[1, 1, 0.89], [1, 2, 0.045], [2, 1, 0.045], [2, 2, 0.011], [1, 3, 0.004], [3, 1, 0.004]];

/**
 * Allinea le frasi di due traduzioni dello stesso paragrafo (lunghezze in caratteri), col metodo di Gale e Church:
 * gruppi 1↔1, 1↔2, 2↔1… scelti perché le lunghezze tornino. [[a0, a1, b0, b1]…] (fine esclusa), oppure null
 * se un gruppo è troppo incerto (minP) o non si arriva in fondo: meglio il paragrafo intero che frasi sbagliate.
 */
function alignSentences(la, lb, minP = 0.02) {
  const n = la.length, m = lb.length;
  if (!n || !m) return null;
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const c = sum(lb) / sum(la) || 1;
  const D = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity));
  const from = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));
  D[0][0] = 0;
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= m; j++) {
      if (D[i][j] === Infinity) continue;
      for (const [da, db, prior] of BEADS) {
        if (i + da > n || j + db > m) continue;
        const l1 = sum(la.slice(i, i + da)), l2 = sum(lb.slice(j, j + db));
        const delta = (l2 - l1 * c) / Math.sqrt(Math.max(1, l1) * 6.8);
        const p = 2 * (1 - normCdf(Math.abs(delta)));
        const cost = D[i][j] - Math.log(prior) - Math.log(Math.max(p, 1e-12));
        if (cost < D[i + da][j + db]) {
          D[i + da][j + db] = cost;
          from[i + da][j + db] = [i, j, p];
        }
      }
    }
  if (D[n][m] === Infinity) return null;
  const beads = [];
  for (let i = n, j = m; i || j; ) {
    const [pi, pj, p] = from[i][j];
    if (p < minP) return null;
    beads.unshift([pi, i, pj, j]);
    [i, j] = [pi, pj];
  }
  return beads;
}

export { sentenceEnds, splitSentences, alignSentences, parseOutline, parseRefLinks, norm, nameKey, pad, verseCode, stripFrontmatter, splitParagraphs, cleanInline, tokenizeInline, VERSE_MARK_RE, NAV_LINE_RE, parseChapterMarkdown, parseVerseList, compressVerses, extractBlock, parseCode, refFromCodes, jwLibraryUrl, JWLIB_LINK_RE, codesFromJwUrl, cleanSnippet, sleep, JW_TOKEN_RE, jwTokenCount, splitJwTokens, newGuid, JWL_MARKER_RE, jwlMarker, jwTokenText, parseNoteFile, formatNoteBlock, noteFreeText, categoryOf };
