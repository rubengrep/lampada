import { Modal, Setting, normalizePath } from 'obsidian';
// sql.js 1.10.3 (licenza MIT): copiato da cdnjs in vendor/, esbuild lo include come testo e base64.
import SQLJS_CODE from '../vendor/sql-wasm.txt';
import SQLJS_WASM from '../vendor/sql-wasm.wasm';
import { buildJwlPlan, formatIssue, jwlNoteBlock, safeFileName, unzipEntries } from './jwl-formati.js';
import { jwLibraryUrl, sleep, verseCode } from './testo.js';
import { t } from './lingua.js';
import { baseLang } from './costanti.js';

class JwlImporter {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.bible = plugin.bible;
  }

  /** sql.js (SQLite in WebAssembly), incluso in main.js: nessun download. */
  async loadSqlJs() {
    if (this.SQL) return this.SQL;
    const module = { exports: {} };
    // "process" nascosto: sql.js deve comportarsi come in un browser anche su desktop.
    new Function('module', 'exports', 'process', SQLJS_CODE)(module, module.exports, undefined);
    const initSqlJs = module.exports.default || module.exports;
    this.SQL = await initSqlJs({ wasmBinary: Uint8Array.from(atob(SQLJS_WASM), (c) => c.charCodeAt(0)) });
    return this.SQL;
  }

  /** Titoli dei documenti esportati nel vault (per dare un nome alle note sulle pubblicazioni). */
  async loadDocTitles() {
    const titles = new Map();
    const a = this.app.vault.adapter;
    const dir = this.bible.indexDir;
    if (!dir) return titles;
    for (const f of await this.bible.indexFiles()) {
      if (!f.endsWith('.json') || f.split('/').pop().startsWith('_')) continue;
      try {
        const idx = JSON.parse(await a.read(f));
        for (const [id, d] of Object.entries(idx.docs || {})) titles.set(String(id), { title: d.title, file: d.file, pub: idx.title });
      } catch (e) {
        /* indice illeggibile */
      }
    }
    return titles;
  }

  async ensureFolder(path) {
    const parts = normalizePath(path).split('/');
    let cur = '';
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) await this.app.vault.createFolder(cur);
    }
  }

  /** Aggiunge in fondo al file solo i blocchi con un identificativo JW Library non ancora presente. */
  async appendBlocks(path, header, blocks) {
    const fresh = (text) => blocks.filter((b) => !text.includes(`<!-- jwl:${b.guid}`));
    let file = this.bible.getFile(path);
    if (!file) {
      const todo = blocks;
      if (!todo.length) return 0;
      await this.ensureFolder(path.split('/').slice(0, -1).join('/'));
      await this.app.vault.create(path, `${header}\n\n${todo.map((b) => b.md).join('\n\n')}\n`);
      return todo.length;
    }
    let text = await this.app.vault.read(file);
    // Note già importate prima che si ricordasse l'evidenziazione collegata: si aggiunge il collegamento.
    let upgraded = false;
    for (const b of blocks) {
      if (!b.mark) continue;
      const old = `<!-- jwl:${b.guid} -->`;
      if (text.includes(old)) {
        text = text.replace(old, `<!-- jwl:${b.guid} | mark:${b.mark} -->`);
        upgraded = true;
      }
    }
    const todo = fresh(text);
    if (!todo.length) {
      if (upgraded) await this.app.vault.modify(file, text);
      return 0;
    }
    await this.app.vault.modify(file, `${text.replace(/\s*$/, '')}\n\n${todo.map((b) => b.md).join('\n\n')}\n`);
    return todo.length;
  }

  get baseFolder() {
    return normalizePath(`${this.plugin.settings.notesFolder}/JW Library`);
  }

  async run(buffer, opts, progress, fileName) {
    await this.bible.ensureLoaded();
    progress(t('Apro il backup…'));
    const entries = await unzipEntries(buffer);
    const dbName = Object.keys(entries).find((n) => n.endsWith('.db'));
    if (!dbName) throw new Error(t('Nel backup non c’è il database delle note (userData.db).'));
    // Il backup resta come base per l'esportazione: contiene anche tutto ciò che Obsidian non mostra.
    let manifest = {};
    try {
      manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
    } catch (e) {
      /* manifest mancante */
    }
    await this.ensureFolder(this.baseFolder);
    const basePath = this.plugin.jwlBasePath;
    await this.app.vault.adapter.writeBinary(basePath, buffer);
    this.plugin.jwlBase = {
      path: basePath,
      name: fileName || manifest.name || 'backup.jwlibrary',
      device: manifest.userDataBackup ? manifest.userDataBackup.deviceName : '',
      date: manifest.creationDate || '',
      importedAt: new Date().toISOString(),
    };
    this.plugin.tagNames = null;
    const SQL = await this.loadSqlJs(progress);
    progress(t('Leggo note ed evidenziazioni…'));
    await this.plugin.library.ensureLoaded().catch(() => null);
    const lib = this.plugin.library;
    const plan = buildJwlPlan(SQL, entries[dbName], {
      validCode: (b, c, v) => this.bible.validCodes.has(verseCode(b, c, v)),
      hasDoc: (d) => lib.byDocId.has(String(d)),
      lang: this.plugin.langField().lang, // lingua aperta (undefined = lingua base): hasDoc vale solo per quella
      base: baseLang(this.plugin.settings),
    });
    const res = { highlights: 0, bookmarks: 0, bibleNotes: 0, bibleFiles: 0, pubNotes: 0, pubFiles: 0, skipped: 0 };

    if (opts.highlights) {
      // Le evidenziazioni del backup sostituiscono quelle importate prima; restano quelle create qui e non ancora esportate.
      const incoming = [...plan.marks, ...plan.docMarks];
      const ids = new Set(incoming.map((m) => m.id));
      const local = this.plugin.marks.filter((m) => m.src === 'local' && !ids.has(m.id));
      const localSet = new Set(local);
      const now = Date.now();
      // Le evidenziazioni del vecchio backup che non ci sono più vanno ricordate come cancellate (anche sugli altri dispositivi).
      for (const m of this.plugin.marks) if (!localSet.has(m) && !ids.has(m.id)) this.plugin.markTomb[m.id] = now;
      for (const m of incoming) m.t = now;
      this.plugin.marks = [...incoming, ...local];
      this.plugin.deletedJwl = [];
      this.plugin.rebuildMarkIndex();
      res.highlights = plan.marks.length;
      res.docHighlights = plan.docMarks.length;
      res.localMarks = local.length;
    }
    if (opts.bookmarks) {
      for (const bm of plan.bookmarks) {
        if (this.plugin.findBookmark(bm)) continue;
        this.plugin.bookmarks.push({ ...bm, created: Date.now(), t: Date.now() });
        res.bookmarks++;
      }
    }
    await this.plugin.saveAll();

    if (opts.bibleNotes) {
      const byPath = new Map();
      for (const n of plan.bibleNotes) {
        const book = this.bible.byNum.get(n.b);
        if (!book) continue;
        const path = n.verse
          ? this.plugin.verseNoteFile(book, n.ch, n.verse)?.path || this.plugin.notePath(book, n.ch, n.verse)
          : normalizePath(`${this.plugin.settings.notesFolder}/${book.title} ${n.ch}.md`);
        if (!byPath.has(path)) byPath.set(path, { book, chapter: n.ch, verse: n.verse, notes: [] });
        byPath.get(path).notes.push(n);
      }
      let i = 0;
      for (const [path, g] of byPath) {
        if (++i % 25 === 0) {
          progress(t('Note sulla Bibbia: {i}/{n}…', { i, n: byPath.size }));
          await sleep(0);
        }
        const label = g.verse ? `${g.book.title} ${g.chapter}:${g.verse}` : `${g.book.title} ${g.chapter}`;
        const ref = { book: g.book.num, chapter: g.chapter, verse: g.verse || undefined };
        const tags = [...new Set(['nota-bibbia', ...g.notes.flatMap((n) => n.tags)])];
        let quote = '';
        if (g.verse) {
          const data = await this.bible.getChapter(g.book.num, g.chapter).catch(() => null);
          const text = data ? this.bible.verseText(data, g.verse) : '';
          quote = `> [!quote] [${label}](${jwLibraryUrl(ref)})\n> ${text}`;
        } else quote = `> [!quote] [${label}](${jwLibraryUrl({ ...ref, verse: 0 })})`;
        const header = [
          '---',
          `riferimento: "${label}"`,
          g.verse ? `codice: "${verseCode(g.book.num, g.chapter, g.verse)}"` : null,
          `tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]`,
          '---',
          quote,
        ]
          .filter((l) => l !== null)
          .join('\n');
        const blocks = g.notes.map((n) => ({ guid: n.guid, md: jwlNoteBlock(n) }));
        const added = await this.appendBlocks(path, header, blocks);
        res.bibleNotes += added;
        res.skipped += blocks.length - added;
        if (added) res.bibleFiles++;
      }
    }

    if (opts.pubNotes) {
      const titles = await this.loadDocTitles();
      const folder = normalizePath(`${this.plugin.settings.notesFolder}/JW Library`);
      const byFile = new Map();
      for (const n of plan.pubNotes) {
        const issue = formatIssue(n.issue);
        const name = safeFileName(`${n.sym || 'pubblicazione'}${issue ? ` ${issue}` : ''}`);
        const path = `${folder}/${name}.md`;
        if (!byFile.has(path)) byFile.set(path, { sym: n.sym, issue, notes: [] });
        byFile.get(path).notes.push(n);
      }
      let i = 0;
      for (const [path, g] of byFile) {
        if (++i % 10 === 0) {
          progress(t('Note sulle pubblicazioni: {i}/{n}…', { i, n: byFile.size }));
          await sleep(0);
        }
        const pubTitle = g.notes.map((n) => titles.get(String(n.doc))?.pub).find(Boolean);
        const header = [
          '---',
          `pubblicazione: "${g.sym}"`,
          g.issue ? `numero: "${g.issue}"` : null,
          `tags: ["jw-library"]`,
          '---',
          `# ${pubTitle || g.sym}${g.issue ? ` (${g.issue})` : ''}`,
        ]
          .filter((l) => l !== null)
          .join('\n');
        const blocks = g.notes.map((n) => {
          const doc = titles.get(String(n.doc));
          const docLabel = doc ? doc.title : n.locTitle || `Documento ${n.doc}`;
          const links = [];
          if (n.doc) links.push(`[${n.par ? `¶${n.par}` : 'Apri'} in JW Library](jwlibrary:///finder?docid=${n.doc}${n.par ? `&par=${n.par}` : ''})`);
          if (doc && doc.file) links.push(`[[${doc.file}${n.par ? `#^p${n.par}` : ''}|${n.par ? `¶${n.par}` : 'apri'} nel vault]]`);
          return { guid: n.guid, mark: n.mark, md: jwlNoteBlock(n, [`**${docLabel}** · ${links.join(' · ')}`]) };
        });
        const added = await this.appendBlocks(path, header, blocks);
        res.pubNotes += added;
        res.skipped += blocks.length - added;
        if (added) res.pubFiles++;
      }
    }
    return res;
  }
}

class JwlImportModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.opts = { bibleNotes: true, highlights: true, bookmarks: true, pubNotes: true };
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText(t('Importa backup JW Library'));
    contentEl.createEl('p', {
      text: t('Scegli un file .jwlibrary (in JW Library: Impostazioni → Backup e ripristino → Crea un backup). Puoi reimportare backup più recenti: le note già importate vengono saltate.'),
      cls: 'setting-item-description',
    });
    const opt = (key, name, desc) =>
      new Setting(contentEl)
        .setName(t(name))
        .setDesc(desc)
        .addToggle((t) => t.setValue(this.opts[key]).onChange((v) => (this.opts[key] = v)));
    opt('bibleNotes', 'Note sulla Bibbia', t('Nelle note personali dei versetti ({folder}).', { folder: this.plugin.settings.notesFolder }));
    opt('highlights', 'Evidenziazioni sulla Bibbia', t('Parola per parola, come in JW Library. Sostituiscono quelle importate prima; quelle create in Obsidian e non ancora esportate restano.'));
    opt('bookmarks', 'Segnalibri sulla Bibbia', t('Nei segnalibri del lettore.'));
    opt('pubNotes', 'Note sulle pubblicazioni', t('Un file per pubblicazione in {folder}.', { folder: `${this.plugin.settings.notesFolder}/JW Library` }));

    this.statusEl = contentEl.createDiv('lmp-import-status');
    const input = contentEl.createEl('input', { type: 'file', attr: { style: 'display:none' } });
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(t('Scegli il backup…'))
        .setCta()
        .onClick(() => input.click())
    );
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      contentEl.querySelectorAll('button, input').forEach((el) => (el.disabled = true));
      try {
        const res = await new JwlImporter(this.plugin).run(await file.arrayBuffer(), this.opts, (msg) => this.statusEl.setText(msg), file.name);
        this.statusEl.empty();
        this.statusEl.createEl('p', { text: t('Importazione completata da «{file}»:', { file: file.name }) });
        const ul = this.statusEl.createEl('ul');
        ul.createEl('li', { text: t('{n} note sulla Bibbia ({files} file)', { n: res.bibleNotes, files: res.bibleFiles }) });
        ul.createEl('li', { text: res.localMarks ? t('{n} evidenziazioni sulla Bibbia (+{local} create in Obsidian, mantenute)', { n: res.highlights, local: res.localMarks }) : t('{n} evidenziazioni sulla Bibbia', { n: res.highlights }) });
        if (res.docHighlights) ul.createEl('li', { text: t('{n} evidenziazioni sulle pubblicazioni presenti nel vault', { n: res.docHighlights }) });
        ul.createEl('li', { text: t('{n} segnalibri', { n: res.bookmarks }) });
        ul.createEl('li', { text: t('{n} note sulle pubblicazioni ({files} file)', { n: res.pubNotes, files: res.pubFiles }) });
        if (res.skipped) ul.createEl('li', { text: t('{n} note già presenti, saltate', { n: res.skipped }) });
        for (const v of this.plugin.views()) if (v.state.mode === 'reader') v.decorateVerses();
        this.plugin.noteIndex.build();
      } catch (e) {
        console.error('[lampada] importazione non riuscita', e);
        this.statusEl.setText(t('Errore: {msg}', { msg: e.message }));
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export { JwlImporter, JwlImportModal };
