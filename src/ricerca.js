/* ------------------------------------------------------------------ */
/* Ricerca per parole nei paragrafi delle pubblicazioni (per la chat)  */
/* Niente Obsidian qui: si prova in Node (test/ricerca.test.js).       */
/* ------------------------------------------------------------------ */

const STOP = new Set(
  `abbia abbiamo abbiano adesso agli alcuni alcune all alla alle allo allora altra altre altri altro anche ancora avere aveva avevano avete avuto
  che chi cio come con contro cosa cosi cui dal dall dalla dalle dagli dallo degli dei del dell della delle dello dentro deve devono dopo dove
  ecc era erano essa esse essere essi esso fra gli hanno in invece lei loro lui mai molto nei nel nell nella nelle nello negli noi non nostra
  nostre nostri nostro occorre ogni oppure per perche pero piu poi possono puo qual quale quali quando quanto quella quelle quelli quello questa
  queste questi questo sara sarebbe sei sia siamo siano sono sta stato stessa stesso suo sua sue suoi sul sull sulla sulle sullo sugli tale
  tali tra tua tuo tue tuoi tutta tutte tutti tutto una uno vengono viene voi vostra vostro gia ciascuno qualcosa qualche nessuno quindi mentre
  pure tanto tanti tanta tante cioe pag par vedi nota`.split(/\s+/)
);

// Desinenze tolte per ritrovare la stessa parola in forme diverse (perdono, perdonare, perdonati → "perdon").
// ponytail: elenco corto e fisso; le forme che sfuggono le prova l'AI con altre ricerche.
const SUFFIXES = ['amente', 'imente', 'mente', 'azioni', 'azione', 'izioni', 'izione', 'zioni', 'zione', 'menti', 'mento', 'avano', 'evano', 'ivano',
  'iamo', 'ando', 'endo', 'are', 'ere', 'ire', 'ato', 'ata', 'ati', 'ate', 'ito', 'ita', 'iti', 'ite', 'uto', 'uta', 'uti', 'ute', 'ava', 'eva', 'iva', 'oso', 'osa', 'osi', 'ose'];

// Inglese (contenuti in inglese): parole vuote e desinenze semplici.
// ponytail: elenco corto e fisso, come per l'italiano; uno stemmer vero (Porter) se le ricerche in inglese sbagliano troppo.
const STOP_EN = new Set(
  `the and for are but not you all any can had her was one our out has him his how its may new now old see two who did get let say she too
  use about above after again against also been before being below between both could does doing down during each from further have having
  here hers herself himself into itself just more most myself nor off once only other ours ourselves over own same should some such than that
  their theirs them themselves then there these they this those through under until very were what when where which while whom why will with
  would yet your yours yourself yourselves upon shall etc page par note`.split(/\s+/)
);
const SUFFIXES_EN = ['ations', 'ation', 'iness', 'ness', 'ments', 'ment', 'ingly', 'ings', 'ing', 'edly', 'ies', 'ied', 'ers', 'er', 'ed', 'es', 'y', 's'];

function stemEn(w) {
  for (const s of SUFFIXES_EN) if (w.length - s.length >= 3 && w.endsWith(s) && !(s === 'y' && /[aeiou]y$/.test(w))) {
    w = w.slice(0, -s.length);
    break;
  }
  if (w.length >= 4 && w.endsWith('e')) w = w.slice(0, -1); // love, loved, loving → "lov"
  if (/([bdgmnpt])\1$/.test(w)) w = w.slice(0, -1); // running → "run"
  return w;
}

function stem(w, lang = 'it') {
  if (/^\d/.test(w)) return w;
  if (lang === 'en') return stemEn(w);
  for (const s of SUFFIXES) if (w.length - s.length >= 4 && w.endsWith(s)) return w.slice(0, -s.length);
  if (w.length >= 4 && /[aeiou]$/.test(w)) {
    w = w.slice(0, -1);
    if (/[aeiou]$/.test(w) && w.length >= 4) w = w.slice(0, -1);
    if (/[cg]h$/.test(w)) w = w.slice(0, -1);
  }
  return w;
}

/** Markdown delle note → testo semplice (senza link, immagini, ^pN). */
function mdText(md) {
  return String(md || '')
    .replace(/!\[\[[^\]]*\]\]/g, ' ')
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s*\^p\d+[ \t]*$/gm, '')
    .replace(/\\([\\`*_\[\]().!-])/g, '$1')
    .replace(/\*\*|__/g, '');
}

/** Testo → parole normalizzate (minuscole, senza accenti né parole vuote, con la radice). `lang`: 'it' o 'en'. */
function terms(text, lang = 'it') {
  const stop = lang === 'en' ? STOP_EN : STOP;
  const out = [];
  const s = String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const m of s.matchAll(/[a-z0-9]+/g)) {
    const w = m[0];
    if (w.length < 3 || stop.has(w)) continue;
    out.push(stem(w, lang));
  }
  return out;
}

/** Corpo di una nota → paragrafi { pid, md } (solo i blocchi con ^pN; una riga vuota li separa). */
function paragraphsOf(body) {
  const out = [];
  for (const chunk of String(body).split(/\n[ \t]*\n/)) {
    const m = /\^p(\d+)[ \t]*$/.exec(chunk.trimEnd());
    if (m) out.push({ pid: +m[1], md: chunk.trim() });
  }
  return out;
}

/**
 * Paragrafi di una nota qualsiasi (senza ^pN): i blocchi separati da righe vuote. pid = riga dove comincia (da 0),
 * così la fonte apre la nota proprio lì. Il frontmatter resta fuori.
 */
function notePars(body) {
  const lines = String(body).split('\n');
  let i = 0;
  if (lines[0].trim() === '---') {
    const end = lines.findIndex((l, j) => j > 0 && l.trim() === '---');
    if (end > 0) i = end + 1;
  }
  const out = [];
  let start = -1;
  for (; i <= lines.length; i++) {
    const blank = i === lines.length || !lines[i].trim();
    if (!blank && start < 0) start = i;
    else if (blank && start >= 0) {
      out.push({ pid: start, md: lines.slice(start, i).join('\n') });
      start = -1;
    }
  }
  return out;
}

const shardKey = (t) => t.slice(0, 2);
const MIN_TERMS = 3; // "La tua risposta", "* * *", didascalie di una parola: non servono

/**
 * Costruisce l'indice un documento alla volta. Un paragrafo = posizione nella tabella `pars` (documento, ^pN, parole).
 * Ogni parola → elenco di (paragrafo × 16 + ripetizioni, massimo 15).
 */
class IndexBuilder {
  /** `lang`: lingua dei testi (parole vuote e radici); resta nei metadati e la ricerca usa la stessa. */
  constructor(lang = 'it') {
    this.lang = lang;
    this.docs = [];
    this.pars = [];
    this.post = new Map();
    this.totalLen = 0;
  }

  /** `plain`: nota tua, divisa in paragrafi con notePars (le pubblicazioni hanno ^pN). */
  addDoc(key, body, { plain = false } = {}) {
    const d = this.docs.length;
    let added = 0;
    for (const p of plain ? notePars(body) : paragraphsOf(body)) {
      const ts = terms(mdText(p.md), this.lang);
      if (ts.length < MIN_TERMS) continue;
      const n = this.pars.length / 3;
      this.pars.push(d, p.pid, Math.min(ts.length, 65535));
      this.totalLen += ts.length;
      const tf = new Map();
      for (const t of ts) tf.set(t, (tf.get(t) || 0) + 1);
      // Elenchi in array tipizzati che raddoppiano: metà della memoria degli array normali (serve sul telefono).
      for (const [t, c] of tf) {
        let l = this.post.get(t);
        if (!l) this.post.set(t, (l = { a: new Uint32Array(4), n: 0 }));
        else if (l.n === l.a.length) {
          const a = new Uint32Array(l.n * 2);
          a.set(l.a);
          l.a = a;
        }
        l.a[l.n++] = n * 16 + Math.min(c, 15);
      }
      added++;
    }
    if (added) this.docs.push(key);
    return added;
  }

  /** → { meta, pars (ArrayBuffer), shards: Map(chiave → ArrayBuffer) } */
  finish(extra = {}) {
    const count = this.pars.length / 3;
    const groups = new Map();
    for (const t of this.post.keys()) {
      const k = shardKey(t);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    const shards = new Map();
    for (const [k, list] of groups) {
      shards.set(k, encodeShard(list.sort().map((t) => [t, this.post.get(t).a.subarray(0, this.post.get(t).n)])));
      for (const t of list) this.post.delete(t); // libera subito: il picco di memoria resta basso
    }
    // Senza `lang` (indici di prima) = italiano.
    const meta = { v: 1, lang: this.lang, count, avgLen: count ? this.totalLen / count : 0, docs: this.docs, shards: [...shards.keys()].sort(), ...extra };
    return { meta, pars: new Uint32Array(this.pars).buffer, shards };
  }
}

/** Pezzo dell'indice: [lunghezza intestazione][intestazione JSON: [parola, quante]…][elenchi, uno dopo l'altro]. */
function encodeShard(entries) {
  const head = new TextEncoder().encode(JSON.stringify(entries.map(([t, l]) => [t, l.length])));
  const pad = (4 - (head.length % 4)) % 4;
  const total = entries.reduce((s, [, l]) => s + l.length, 0);
  const buf = new ArrayBuffer(4 + head.length + pad + total * 4);
  new DataView(buf).setUint32(0, head.length, true);
  new Uint8Array(buf, 4, head.length).set(head);
  const posts = new Uint32Array(buf, 4 + head.length + pad, total);
  let o = 0;
  for (const [, l] of entries) {
    posts.set(l, o);
    o += l.length;
  }
  return buf;
}

/** → Map(parola → Uint32Array) */
function decodeShard(buf) {
  const len = new DataView(buf).getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, len)));
  const start = 4 + len + ((4 - (len % 4)) % 4);
  const out = new Map();
  let o = 0;
  for (const [t, n] of head) {
    out.set(t, new Uint32Array(buf, start + o * 4, n));
    o += n;
  }
  return out;
}

/**
 * Cerca nell'indice. `loadShard(chiave)` → ArrayBuffer (o null). Le parole che finiscono con * cercano tutte le parole
 * che iniziano così. → [{ doc (chiave del documento), pid, score }], al massimo `perDoc` paragrafi per documento.
 */
class IndexReader {
  constructor(meta, parsBuf, loadShard) {
    this.meta = meta;
    this.pars = new Uint32Array(parsBuf);
    this.loadShard = loadShard;
    this.cache = new Map();
  }

  async shard(k) {
    if (!this.cache.has(k)) {
      if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(k, this.meta.shards.includes(k) ? this.loadShard(k).then((b) => (b ? decodeShard(b) : new Map())) : Promise.resolve(new Map()));
    }
    return this.cache.get(k);
  }

  /** Parole della ricerca → elenchi da sommare (una parola con * può valere più elenchi). */
  async lists(query) {
    const out = [];
    for (const raw of String(query).split(/\s+/)) {
      const prefix = raw.endsWith('*');
      for (const t of terms(raw.replace(/\*$/, ''), this.meta.lang || 'it')) {
        const sh = await this.shard(shardKey(t));
        if (!prefix) {
          if (sh.has(t)) out.push(sh.get(t));
          continue;
        }
        const p = String(raw).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
        const base = p.length >= 3 ? p : t;
        for (const [w, l] of sh) if (w.startsWith(base) || w === t) out.push(l);
      }
    }
    return out;
  }

  async search(query, { limit = 8, perDoc = 2, docFilter } = {}) {
    const N = this.meta.count;
    const lists = await this.lists(query);
    if (!lists.length || !N) return [];
    const k1 = 1.2;
    const b = 0.75;
    const avg = this.meta.avgLen || 1;
    const scores = new Map();
    for (const l of lists) {
      const idf = Math.log(1 + (N - l.length + 0.5) / (l.length + 0.5));
      for (let i = 0; i < l.length; i++) {
        const p = Math.floor(l[i] / 16);
        const tf = l[i] % 16;
        const len = this.pars[p * 3 + 2];
        const s = (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / avg));
        scores.set(p, (scores.get(p) || 0) + s);
      }
    }
    const ranked = [...scores].sort((x, y) => y[1] - x[1]);
    const out = [];
    const perDocCount = new Map();
    for (const [p, score] of ranked) {
      const doc = this.meta.docs[this.pars[p * 3]];
      if (docFilter && !docFilter(doc)) continue;
      const n = perDocCount.get(doc) || 0;
      if (n >= perDoc) continue;
      perDocCount.set(doc, n + 1);
      out.push({ doc, pid: this.pars[p * 3 + 1], score });
      if (out.length >= limit) break;
    }
    return out;
  }
}

export { IndexBuilder, IndexReader, decodeShard, encodeShard, mdText, notePars, paragraphsOf, stem, terms };
