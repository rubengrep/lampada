import { Modal, Setting, normalizePath } from 'obsidian';
import { JWL_COLORS, unzipEntries } from './jwl-formati.js';
import { JwlImportModal, JwlImporter } from './jwl-importa.js';
import { JWL_MARKER_RE, jwTokenCount, parseCode } from './testo.js';

/* ------------------------------------------------------------------ */
/* Esportazione di un backup JW Library (.jwlibrary)                   */
/* ------------------------------------------------------------------ */

const JWL_COLOR_INDEX = Object.fromEntries(Object.entries(JWL_COLORS).map(([i, c]) => [c, +i]));

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Crea un archivio zip (deflate) senza librerie esterne. */
async function zipFiles(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const stream = new Blob([f.data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const data = new Uint8Array(await new Response(stream).arrayBuffer());
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 8, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 8, true);
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

async function sha256Hex(u8) {
  const h = await crypto.subtle.digest('SHA-256', u8);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Data locale nel formato dei manifest di JW Library: 2026-10-17T17:16:41+0200 */
function jwlStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
}

/**
 * Blocchi di nota JW Library scritti nelle note del vault:
 * "### Titolo" + "<!-- jwl:GUID -->" + testo (fino al blocco o titolo successivo).
 */
function parseJwlBlocks(text) {
  const out = [];
  const parts = text.split(/\n(?=### )/);
  for (const part of parts) {
    const lines = part.split('\n');
    const head = /^### (.*)$/.exec(lines[0] || '');
    const marker = JWL_MARKER_RE.exec((lines[1] || '').trim());
    if (!head || !marker) continue;
    let body = lines.slice(2);
    if (body.length && /^\*\*.*jwlibrary:\/\/\/finder\?docid=/.test(body[0])) body = body.slice(1);
    const stop = body.findIndex((l) => /^(#{1,2} |---\s*$)/.test(l));
    if (stop >= 0) body = body.slice(0, stop);
    let content = body.join('\n').replace(/\r\n/g, '\n').trim();
    // Riga finale aggiunta all'importazione: tag e data.
    content = content.replace(/\n*(?:#[^\s#]+(?: #[^\s#]+)*)?(?: · )?(?:\*JW Library · \d{4}-\d{2}-\d{2}\*)?$/, '').trim();
    out.push({ guid: marker[1], mark: marker[2] || '', title: head[1].trim(), content });
  }
  return out;
}

class JwlExporter {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.bible = plugin.bible;
    this.importer = new JwlImporter(plugin);
  }

  async run(progress) {
    const a = this.app.vault.adapter;
    const base = this.plugin.jwlBase;
    if (!base || !(await a.exists(this.plugin.jwlBasePath))) {
      throw new Error('Prima importa un backup di JW Library: l’esportazione parte da quello, così nel nuovo backup non si perde nulla.');
    }
    await this.bible.ensureLoaded();
    progress('Leggo il backup di partenza…');
    const entries = await unzipEntries(await a.readBinary(this.plugin.jwlBasePath));
    const dbName = Object.keys(entries).find((n) => n.endsWith('.db'));
    const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
    const SQL = await this.importer.loadSqlJs(progress);
    const db = new SQL.Database(entries[dbName]);
    const res = { added: 0, updated: 0, deleted: 0, notesUpdated: 0, notesAdded: 0, notesSkipped: 0 };
    let bytes;
    try {
      const one = (sql, params) => {
        const st = db.prepare(sql);
        st.bind(params || []);
        const row = st.step() ? st.getAsObject() : null;
        st.free();
        return row;
      };
      const exec = (sql, params) => db.run(sql, params || []);
      const lastId = () => one('SELECT last_insert_rowid() AS id').id;

      const loc = one(`SELECT KeySymbol AS k, MepsLanguage AS m FROM Location WHERE BookNumber IS NOT NULL AND ChapterNumber IS NOT NULL
          GROUP BY KeySymbol, MepsLanguage ORDER BY COUNT(*) DESC LIMIT 1`) || { k: this.bible.symbol, m: 4 };
      const locationId = (b, c) => {
        const r = one('SELECT LocationId AS id FROM Location WHERE BookNumber = ? AND ChapterNumber = ? AND KeySymbol = ? AND MepsLanguage = ? AND Type = 0', [b, c, loc.k, loc.m]);
        if (r) return r.id;
        const book = this.bible.byNum.get(b);
        exec('INSERT INTO Location (BookNumber, ChapterNumber, KeySymbol, MepsLanguage, Type, Title, IssueTagNumber) VALUES (?, ?, ?, ?, 0, ?, 0)', [
          b,
          c,
          loc.k,
          loc.m,
          book ? `${book.title} ${c}` : null,
        ]);
        return lastId();
      };
      const lastToken = async (b, c, v) => {
        const data = await this.bible.getChapter(b, c);
        return Math.max(0, jwTokenCount(this.bible.verseText(data, v)) - 1);
      };

      progress('Evidenziazioni…');
      for (const g of this.plugin.deletedJwl) {
        const r = one('SELECT UserMarkId AS id FROM UserMark WHERE UserMarkGuid = ?', [g]);
        if (!r) continue;
        exec('UPDATE Note SET UserMarkId = NULL WHERE UserMarkId = ?', [r.id]);
        exec('DELETE FROM BlockRange WHERE UserMarkId = ?', [r.id]);
        exec('DELETE FROM UserMark WHERE UserMarkId = ?', [r.id]);
        res.deleted++;
      }
      const lib = this.plugin.library;
      await lib.ensureLoaded().catch(() => null);
      // Documento di una pubblicazione: Location con DocumentId, simbolo e numero (es. 20150801, 20170100; libri: 0)
      const docLocationId = (m) => {
        const d = lib.byDocId.get(String(m.doc));
        const k = (m.loc && m.loc.k) || (d && d.pub.symbol);
        let i = m.loc ? m.loc.i : 0;
        if (!m.loc && d && d.issue && /^\d{6,8}$/.test(d.issue)) i = +d.issue.padEnd(8, '0');
        const lang = (m.loc && m.loc.lang) || (loc && loc.m) || 4;
        const r =
          one('SELECT LocationId AS id FROM Location WHERE DocumentId = ? AND KeySymbol = ? AND IssueTagNumber = ? AND MepsLanguage = ? AND Type = 0', [+m.doc, k, i, lang]) ||
          one('SELECT LocationId AS id FROM Location WHERE DocumentId = ? AND MepsLanguage = ? AND Type = 0', [+m.doc, lang]);
        if (r) return r.id;
        exec('INSERT INTO Location (DocumentId, IssueTagNumber, KeySymbol, MepsLanguage, Type, Title) VALUES (?, ?, ?, ?, 0, ?)', [+m.doc, i, k, lang, d ? d.title : null]);
        return lastId();
      };
      for (const m of this.plugin.marks) {
        const existing = one('SELECT UserMarkId AS id FROM UserMark WHERE UserMarkGuid = ?', [m.id]);
        if (existing && !m.mod) continue;
        const ranges = [];
        for (const r of m.ranges) {
          if (m.doc && r.e < 0) continue; // nei documenti gli intervalli sono sempre espliciti
          ranges.push({ v: r.v, s: r.s, e: r.e < 0 ? await lastToken(m.b, m.c, r.v) : r.e });
        }
        if (!ranges.length) continue;
        let id;
        if (existing) {
          id = existing.id;
          exec('UPDATE UserMark SET ColorIndex = ? WHERE UserMarkId = ?', [JWL_COLOR_INDEX[m.color], id]);
          exec('DELETE FROM BlockRange WHERE UserMarkId = ?', [id]);
          res.updated++;
        } else {
          exec('INSERT INTO UserMark (ColorIndex, LocationId, StyleIndex, UserMarkGuid, Version) VALUES (?, ?, 0, ?, 1)', [
            JWL_COLOR_INDEX[m.color],
            m.doc ? docLocationId(m) : locationId(m.b, m.c),
            m.id,
          ]);
          id = lastId();
          res.added++;
        }
        for (const r of ranges) {
          exec('INSERT INTO BlockRange (BlockType, Identifier, StartToken, EndToken, UserMarkId) VALUES (?, ?, ?, ?, ?)', [m.doc ? 1 : 2, r.v, r.s, r.e, id]);
        }
      }

      // Risposte scritte in Obsidian nei campi delle pubblicazioni ("La tua risposta")
      res.answers = 0;
      for (const ans of Object.values(this.plugin.answers || {})) {
        if (!lib.byDocId.has(String(ans.doc))) continue;
        const locId = docLocationId({ doc: ans.doc });
        if ((ans.v || '').trim()) exec('INSERT OR REPLACE INTO InputField (LocationId, TextTag, Value) VALUES (?, ?, ?)', [locId, ans.tag, ans.v]);
        else exec('DELETE FROM InputField WHERE LocationId = ? AND TextTag = ?', [locId, ans.tag]);
        res.answers++;
      }

      progress('Note…');
      const folder = normalizePath(this.plugin.settings.notesFolder);
      for (const f of this.app.vault.getMarkdownFiles().filter((x) => x.path.startsWith(`${folder}/`))) {
        const text = await this.app.vault.cachedRead(f);
        if (!text.includes('<!-- jwl:')) continue;
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter || {};
        for (const blk of parseJwlBlocks(text)) {
          const row = one('SELECT NoteId AS id, Title AS title, Content AS content FROM Note WHERE Guid = ?', [blk.guid]);
          if (row) {
            const oldTitle = (row.title || '').replace(/\s+/g, ' ').trim();
            const sameTitle = blk.title === oldTitle.slice(0, 160) || (blk.title === 'Nota' && !oldTitle);
            const sameContent = blk.content === (row.content || '').replace(/\r\n/g, '\n').trim();
            if (sameTitle && sameContent) continue;
            exec("UPDATE Note SET Title = ?, Content = ?, LastModified = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE NoteId = ?", [
              sameTitle ? row.title : blk.title,
              blk.content,
              row.id,
            ]);
            res.notesUpdated++;
          } else if (fm.codice && /^\d{8}$/.test(String(fm.codice))) {
            const r = parseCode(fm.codice);
            const um = blk.mark ? one('SELECT UserMarkId AS id FROM UserMark WHERE UserMarkGuid = ?', [blk.mark]) : null;
            exec('INSERT INTO Note (Guid, UserMarkId, LocationId, Title, Content, BlockType, BlockIdentifier) VALUES (?, ?, ?, ?, ?, 2, ?)', [
              blk.guid,
              um ? um.id : null,
              locationId(r.book, r.chapter),
              blk.title,
              blk.content,
              r.verse,
            ]);
            res.notesAdded++;
          } else res.notesSkipped++;
        }
      }
      bytes = db.export();
    } finally {
      db.close();
    }

    progress('Creo il file…');
    const stamp = jwlStamp();
    const name = `UserdataBackup_${stamp.slice(0, 10)}_Obsidian.jwlibrary`;
    manifest.name = name;
    manifest.creationDate = stamp;
    manifest.userDataBackup = { ...manifest.userDataBackup, databaseName: dbName, deviceName: 'Obsidian', lastModifiedDate: stamp, hash: await sha256Hex(bytes) };
    const files = [
      { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest)) },
      { name: dbName, data: bytes },
    ];
    if (entries['default_thumbnail.png']) files.push({ name: 'default_thumbnail.png', data: entries['default_thumbnail.png'] });
    const zip = await zipFiles(files);
    const outFolder = `${this.importer.baseFolder}/Esportati`;
    await this.importer.ensureFolder(outFolder);
    const outPath = `${outFolder}/${name}`;
    await a.writeBinary(outPath, zip.buffer);

    // Il backup esportato diventa la nuova base: è quello che verrà ripristinato in JW Library.
    await a.writeBinary(this.plugin.jwlBasePath, zip.buffer);
    this.plugin.jwlBase = { ...base, name, device: 'Obsidian', date: stamp, importedAt: new Date().toISOString() };
    for (const m of this.plugin.marks) {
      m.src = 'jwl';
      m.mod = false;
      m.t = Date.now();
    }
    this.plugin.deletedJwl = [];
    await this.plugin.saveAll();
    return { ...res, path: outPath };
  }
}

class JwlExportModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    const base = this.plugin.jwlBase;
    this.titleEl.setText('Esporta backup JW Library');
    if (!base) {
      contentEl.createEl('p', { text: 'Prima importa un backup di JW Library: l’esportazione parte da quello e ci aggiunge le modifiche fatte in Obsidian.' });
      new Setting(contentEl).addButton((b) =>
        b
          .setButtonText('Importa un backup…')
          .setCta()
          .onClick(() => {
            this.close();
            new JwlImportModal(this.plugin).open();
          })
      );
      return;
    }
    const pending = this.plugin.marks.filter((m) => m.mod).length + this.plugin.deletedJwl.length;
    contentEl.createEl('p', {
      text: `Crea un nuovo file .jwlibrary partendo da «${base.name}»${base.device ? ` (${base.device})` : ''} e aggiungendo le modifiche fatte in Obsidian: evidenziazioni (${pending} da esportare) e note scritte o modificate nei blocchi JW Library.`,
    });
    const warn = contentEl.createDiv('lmp-export-warning');
    warn.createEl('strong', { text: 'Attenzione: ' });
    warn.appendText(
      'ripristinare un backup in JW Library sostituisce tutti i dati del dispositivo. Ciò che hai fatto in JW Library dopo il backup di partenza andrebbe perso: prima di esportare, importa un backup recente.'
    );
    this.statusEl = contentEl.createDiv('lmp-import-status');
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText('Crea backup')
        .setCta()
        .onClick(async () => {
          b.setDisabled(true);
          try {
            const res = await new JwlExporter(this.plugin).run((msg) => this.statusEl.setText(msg));
            this.statusEl.empty();
            this.statusEl.createEl('p', { text: 'Backup creato:' });
            const ul = this.statusEl.createEl('ul');
            ul.createEl('li', { text: `Evidenziazioni: ${res.added} nuove, ${res.updated} modificate, ${res.deleted} cancellate` });
            ul.createEl('li', { text: `Note: ${res.notesAdded} nuove, ${res.notesUpdated} modificate` });
            if (res.answers) ul.createEl('li', { text: `Risposte nelle pubblicazioni: ${res.answers}` });
            ul.createEl('li', { text: res.path });
            const p = this.statusEl.createEl('p', { cls: 'setting-item-description' });
            p.setText('Aprilo con JW Library (sul telefono dall’app File, sul Mac con AirDrop o dalla cartella) e scegli «Ripristina».');
            if (this.app.showInFolder) this.app.showInFolder(res.path);
          } catch (e) {
            console.error('[lampada] esportazione non riuscita', e);
            this.statusEl.setText(`Errore: ${e.message}`);
            b.setDisabled(false);
          }
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

export { JWL_COLOR_INDEX, CRC_TABLE, crc32, zipFiles, sha256Hex, jwlStamp, parseJwlBlocks, JwlExporter, JwlExportModal };
