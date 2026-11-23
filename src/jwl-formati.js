import { jwlMarker } from './testo.js';
import { t } from './lingua.js';

/* ------------------------------------------------------------------ */
/* Importazione di un backup JW Library (.jwlibrary)                   */
/* ------------------------------------------------------------------ */

const JWL_COLORS = { 1: 'yellow', 2: 'green', 3: 'blue', 4: 'pink', 5: 'orange', 6: 'purple' };

/**
 * Legge un archivio zip senza librerie esterne. only(nome): estrae solo i file che servono.
 * La sorgente è un ArrayBuffer, oppure { size, read(inizio, fine) → Uint8Array } (un Blob, richieste Range…):
 * così si leggono solo la directory centrale e le voci che servono.
 */
async function unzipEntries(src, only) {
  const { size, read } = typeof src.read !== 'function' ? { size: src.byteLength, read: async (s, e) => new Uint8Array(src, s, Math.min(e, src.byteLength) - s) } : src;
  const view = (u) => new DataView(u.buffer, u.byteOffset, u.byteLength);
  const tailStart = Math.max(0, size - 65557);
  const tail = await read(tailStart, size);
  const tv = view(tail);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(t('Il file non è un archivio valido.'));
  const count = tv.getUint16(eocd + 10, true);
  const cdSize = tv.getUint32(eocd + 12, true);
  const cdOff = tv.getUint32(eocd + 16, true);
  const cd = cdOff >= tailStart ? tail.subarray(cdOff - tailStart) : await read(cdOff, cdOff + cdSize);
  const dv = view(cd);
  const list = [];
  for (let n = 0, p = 0; n < count && dv.getUint32(p, true) === 0x02014b50; n++) {
    const nameLen = dv.getUint16(p + 28, true);
    const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nameLen));
    // Fine stimata: il campo "extra" locale può essere più lungo di quello centrale (sotto si rilegge se serve).
    const e = { name, method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), local: dv.getUint32(p + 42, true) };
    e.end = e.local + 30 + nameLen + e.size + 512;
    if (!only || only(name)) list.push(e);
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  // Voci vicine in una lettura sola: con le richieste Range sono poche richieste.
  list.sort((x, y) => x.local - y.local);
  const out = {};
  for (let i = 0; i < list.length; ) {
    let j = i + 1;
    while (j < list.length && list[j].local - list[j - 1].end < 65536 && list[j].end - list[i].local < 8e6) j++;
    const from = list[i].local;
    const chunk = await read(from, Math.min(size, list[j - 1].end));
    for (const e of list.slice(i, j)) {
      const h = view(chunk.subarray(e.local - from, e.local - from + 30));
      const start = e.local - from + 30 + h.getUint16(26, true) + h.getUint16(28, true);
      let data = chunk.subarray(start, start + e.size);
      if (data.length < e.size) data = await read(from + start, from + start + e.size);
      if (e.method === 0) out[e.name] = data.slice();
      else if (e.method === 8) {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        out[e.name] = new Uint8Array(await new Response(stream).arrayBuffer());
      }
    }
    i = j;
  }
  return out;
}

// Lingue nel backup (Location.MepsLanguage): 4 = italiano, 0 = inglese (visti nei backup veri). La lingua della cartella
// principale (base, costanti.js baseLang: di solito l'italiano) non ha `lang`, come i dati di prima; una lingua senza codice
// qui diventa "meps<n>": resta nei dati e torna nel backup uguale.
// ponytail: solo I ed E; per un'altra lingua aggiungi qui il suo numero MEPS.
const MEPS = { I: 4, E: 0 };
/** Numero MEPS → `lang` dei dati di Lampada (undefined = lingua base o senza lingua). */
function langOfMeps(n, base = 'I') {
  const l = n == null ? base : Object.keys(MEPS).find((k) => MEPS[k] === n) || `meps${n}`;
  return l === base ? undefined : l;
}
/** `lang` dei dati di Lampada → numero MEPS. */
function mepsOf(l, base = 'I') {
  l = l || base;
  if (l in MEPS) return MEPS[l];
  const m = /^meps(\d+)$/.exec(l);
  return m ? +m[1] : MEPS.I;
}
const withLang = (o, n, base) => {
  const l = langOfMeps(n, base);
  return l ? { ...o, lang: l } : o;
};

function jwlTag(name) {
  return String(name)
    .trim()
    .replace(/\s*\/\s*/g, '/')
    .replace(/[^\p{L}\p{N}_\-/]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function formatIssue(tag) {
  const s = String(tag || '');
  if (!/^\d{8}$/.test(s) || s === '00000000') return '';
  const [y, m, d] = [s.slice(0, 4), s.slice(4, 6), s.slice(6, 8)];
  return d === '00' ? `${y}-${m}` : `${y}-${m}-${d}`;
}

function safeFileName(s) {
  return String(s).replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Trasforma il database del backup in un "piano" di importazione (nessuna scrittura):
 * evidenziazioni, segnalibri, note sui versetti e note sulle pubblicazioni.
 */
function buildJwlPlan(SQL, dbBytes, ctx) {
  const db = new SQL.Database(dbBytes);
  const rows = (sql) => {
    const res = db.exec(sql);
    if (!res.length) return [];
    const { columns, values } = res[0];
    return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
  };
  try {
    const tagsByNote = new Map();
    for (const r of rows('SELECT tm.NoteId AS id, t.Name AS name FROM TagMap tm JOIN Tag t ON t.TagId = tm.TagId WHERE tm.NoteId IS NOT NULL')) {
      const tag = jwlTag(r.name);
      if (!tag) continue;
      if (!tagsByNote.has(r.id)) tagsByNote.set(r.id, []);
      tagsByNote.get(r.id).push(tag);
    }

    const byGuid = new Map();
    for (const r of rows(`SELECT u.UserMarkGuid AS g, u.ColorIndex AS c, l.BookNumber AS b, l.ChapterNumber AS ch, br.Identifier AS v,
          br.StartToken AS s, br.EndToken AS e, l.MepsLanguage AS lang
        FROM UserMark u JOIN Location l ON l.LocationId = u.LocationId JOIN BlockRange br ON br.UserMarkId = u.UserMarkId
        WHERE l.BookNumber IS NOT NULL AND br.BlockType = 2 ORDER BY u.UserMarkId, br.Identifier`)) {
      if (!JWL_COLORS[r.c] || !ctx.validCode(r.b, r.ch, r.v)) continue;
      if (!byGuid.has(r.g)) byGuid.set(r.g, withLang({ id: r.g, b: r.b, c: r.ch, color: JWL_COLORS[r.c], ranges: [], src: 'jwl', mod: false }, r.lang, ctx.base));
      byGuid.get(r.g).ranges.push({ v: r.v, s: r.s == null ? 0 : r.s, e: r.e == null ? -1 : r.e });
    }
    const marks = [...byGuid.values()];

    // Pubblicazioni: intervalli di parole per paragrafo (BlockType 1, Identifier = numero di paragrafo)
    const byGuidDoc = new Map();
    if (ctx.hasDoc) {
      for (const r of rows(`SELECT u.UserMarkGuid AS g, u.ColorIndex AS c, l.DocumentId AS d, l.KeySymbol AS k, l.IssueTagNumber AS i,
            l.MepsLanguage AS lang, br.Identifier AS p, br.StartToken AS s, br.EndToken AS e
          FROM UserMark u JOIN Location l ON l.LocationId = u.LocationId JOIN BlockRange br ON br.UserMarkId = u.UserMarkId
          WHERE l.BookNumber IS NULL AND l.DocumentId IS NOT NULL AND br.BlockType = 1 ORDER BY u.UserMarkId, br.Identifier`)) {
        // hasDoc guarda la biblioteca della lingua aperta: le evidenziazioni delle altre lingue si tengono sempre.
        if (!JWL_COLORS[r.c] || r.s == null || r.e == null) continue;
        if (langOfMeps(r.lang, ctx.base) === ctx.lang && !ctx.hasDoc(r.d)) continue;
        if (!byGuidDoc.has(r.g))
          byGuidDoc.set(r.g, withLang({ id: r.g, doc: String(r.d), loc: { k: r.k, i: r.i || 0, lang: r.lang }, color: JWL_COLORS[r.c], ranges: [], src: 'jwl', mod: false }, r.lang, ctx.base));
        byGuidDoc.get(r.g).ranges.push({ v: r.p, s: r.s, e: r.e });
      }
    }
    const docMarks = [...byGuidDoc.values()];

    const bookmarks = [];
    for (const r of rows(`SELECT l.BookNumber AS b, l.ChapterNumber AS ch, bm.BlockType AS t, bm.BlockIdentifier AS v
        FROM Bookmark bm JOIN Location l ON l.LocationId = bm.LocationId WHERE l.BookNumber IS NOT NULL`)) {
      const verse = r.t === 2 && r.v ? r.v : 1;
      if (ctx.validCode(r.b, r.ch, verse)) bookmarks.push({ book: r.b, chapter: r.ch, verse });
    }

    const bibleNotes = [];
    for (const r of rows(`SELECT n.NoteId AS id, n.Guid AS guid, n.Title AS title, n.Content AS content, n.LastModified AS modified,
          n.BlockIdentifier AS v, l.BookNumber AS b, l.ChapterNumber AS ch,
          (SELECT MIN(br.Identifier) FROM BlockRange br WHERE br.UserMarkId = n.UserMarkId AND br.BlockType = 2) AS markVerse,
          (SELECT u.UserMarkGuid FROM UserMark u WHERE u.UserMarkId = n.UserMarkId) AS mark
        FROM Note n JOIN Location l ON l.LocationId = n.LocationId WHERE l.BookNumber IS NOT NULL ORDER BY n.NoteId`)) {
      if (!(r.title || '').trim() && !(r.content || '').trim()) continue;
      bibleNotes.push({ ...r, verse: r.v || r.markVerse || null, mark: r.mark || '', tags: tagsByNote.get(r.id) || [] });
    }

    const pubNotes = [];
    for (const r of rows(`SELECT n.NoteId AS id, n.Guid AS guid, n.Title AS title, n.Content AS content, n.LastModified AS modified,
          n.BlockType AS bt, n.BlockIdentifier AS par, l.KeySymbol AS sym, l.IssueTagNumber AS issue, l.DocumentId AS doc, l.Title AS locTitle,
          (SELECT MIN(br.Identifier) FROM BlockRange br WHERE br.UserMarkId = n.UserMarkId AND br.BlockType = 1) AS markPar,
          (SELECT u.UserMarkGuid FROM UserMark u WHERE u.UserMarkId = n.UserMarkId) AS mark
        FROM Note n JOIN Location l ON l.LocationId = n.LocationId WHERE l.BookNumber IS NULL ORDER BY l.KeySymbol, l.IssueTagNumber, l.DocumentId, n.BlockIdentifier`)) {
      if (!(r.title || '').trim() && !(r.content || '').trim()) continue;
      pubNotes.push({ ...r, par: r.par || r.markPar || null, mark: r.mark || '', tags: tagsByNote.get(r.id) || [] });
    }
    return { marks, docMarks, bookmarks, bibleNotes, pubNotes };
  } finally {
    db.close();
  }
}

function jwlNoteBlock(n, extraLines) {
  const lines = [];
  const title = (n.title || '').trim();
  lines.push(`### ${title ? title.replace(/\s+/g, ' ').slice(0, 160) : 'Nota'}`);
  lines.push(jwlMarker(n));
  for (const l of extraLines || []) lines.push(l);
  if ((n.content || '').trim()) lines.push('', n.content.trim());
  const meta = [];
  if (n.tags.length) meta.push(n.tags.map((t) => `#${t}`).join(' '));
  if (n.modified) meta.push(`*JW Library · ${String(n.modified).slice(0, 10)}*`);
  if (meta.length) lines.push('', meta.join(' · '));
  return lines.join('\n');
}

export { JWL_COLORS, MEPS, langOfMeps, mepsOf, unzipEntries, jwlTag, formatIssue, safeFileName, buildJwlPlan, jwlNoteBlock };
