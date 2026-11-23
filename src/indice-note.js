import { TFile, debounce, Platform } from 'obsidian';
import { cleanSnippet, sleep, verseCode } from './testo.js';

/* ------------------------------------------------------------------ */
/* Indice dei riferimenti biblici nelle note                           */
/* ------------------------------------------------------------------ */

class NoteIndex {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.bible = plugin.bible;
    this.byFile = new Map();
    this.byCode = new Map();
    this.ready = false;
    this.pending = new Map();
    this.emptyFiles = new Map();
    this.requestCacheSave = debounce(() => this.saveCache(), 20000, true);
    this.onChange = debounce(() => this.app.workspace.trigger('lampada:index-changed'), 400, true);
  }

  excluded(file) {
    return !(file instanceof TFile) || file.extension !== 'md' || this.bible.isPublicationFile(file.path);
  }

  get cachePath() {
    // Un file per tipo di dispositivo: i tempi di modifica cambiano tra computer e telefono.
    return `${this.plugin.manifest.dir}/index-cache-${Platform.isMobile ? 'mobile' : 'desktop'}.json`;
  }

  async loadCache() {
    try {
      const raw = JSON.parse(await this.app.vault.adapter.read(this.cachePath));
      return raw && raw.version === 1 && raw.settings === this.cacheKey() ? raw.files || {} : {};
    } catch (e) {
      return {};
    }
  }

  cacheKey() {
    // La lingua della Bibbia cambia gli alias dei riferimenti scritti a mano (l'italiano resta com'era).
    const bl = this.plugin.settings.bibleLang;
    return `${this.bible.root}|${this.bible.symbol}|${this.plugin.settings.detectPlainRefs}${bl && bl !== 'I' ? `|${bl}` : ''}`;
  }

  async saveCache() {
    const files = {};
    for (const [path, entries] of this.byFile) {
      const f = this.bible.getFile(path);
      if (f) files[path] = { m: f.stat.mtime, e: entries.map(({ path: _p, ...rest }) => rest) };
    }
    for (const [path, m] of this.emptyFiles) files[path] = { m, e: [] };
    try {
      await this.app.vault.adapter.write(this.cachePath, JSON.stringify({ version: 1, settings: this.cacheKey(), files }));
    } catch (e) {
      console.warn('[lampada] impossibile salvare la cache dell’indice', e);
    }
  }

  async build() {
    this.byFile.clear();
    this.byCode.clear();
    this.emptyFiles = new Map();
    const cache = await this.loadCache();
    const files = this.app.vault.getMarkdownFiles().filter((f) => !this.excluded(f));
    let i = 0;
    let read = 0;
    for (const f of files) {
      const c = cache[f.path];
      if (c && c.m === f.stat.mtime) {
        if (c.e.length) this.addEntries(f.path, c.e.map((e) => ({ path: f.path, ...e })));
        else this.emptyFiles.set(f.path, c.m);
        continue;
      }
      try {
        await this.indexFile(f, true);
        read++;
      } catch (e) {
        console.warn('[lampada] indicizzazione fallita', f.path, e);
      }
      if (++i % 100 === 0) await sleep(0);
    }
    this.ready = true;
    this.onChange();
    if (read || Object.keys(cache).length !== files.length) this.requestCacheSave();
  }

  addEntries(path, entries) {
    this.byFile.set(path, entries);
    for (const e of entries) {
      for (const v of e.verses) {
        const code = verseCode(e.ref.book, e.ref.chapter, v);
        if (!this.byCode.has(code)) this.byCode.set(code, []);
        this.byCode.get(code).push(e);
      }
    }
  }

  async indexFile(file, silent) {
    this.removeFile(file.path, true);
    if (this.excluded(file)) return;
    const text = await this.app.vault.cachedRead(file);
    const lines = text.split('\n');
    const entries = [];
    let inFm = lines[0] === '---';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (inFm) {
        if (i > 0 && line.trim() === '---') inFm = false;
        continue;
      }
      if (line.length > 8000 || !/\d:\d|jwlibrary|\[\[/.test(line)) continue;
      for (const hit of this.bible.scanLine(line)) {
        entries.push({ path: file.path, line: i, kind: hit.kind, ref: hit.ref, verses: hit.verses, snippet: cleanSnippet(line).slice(0, 400) });
      }
    }
    if (entries.length) {
      this.emptyFiles.delete(file.path);
      this.addEntries(file.path, entries);
    } else this.emptyFiles.set(file.path, file.stat.mtime);
    if (!silent) {
      this.onChange();
      this.requestCacheSave();
    }
  }

  removeFile(path, silent) {
    this.emptyFiles.delete(path);
    const entries = this.byFile.get(path);
    if (!entries) return;
    this.byFile.delete(path);
    for (const e of entries) {
      for (const v of e.verses) {
        const code = verseCode(e.ref.book, e.ref.chapter, v);
        const list = (this.byCode.get(code) || []).filter((x) => x.path !== path);
        if (list.length) this.byCode.set(code, list);
        else this.byCode.delete(code);
      }
    }
    if (!silent) this.onChange();
  }

  schedule(file) {
    if (!this.ready || this.excluded(file)) return;
    window.clearTimeout(this.pending.get(file.path));
    this.pending.set(
      file.path,
      window.setTimeout(() => {
        this.pending.delete(file.path);
        this.indexFile(file).catch(() => {});
      }, 1200)
    );
  }

  lookup(book, chapter, verse) {
    return this.byCode.get(verseCode(book, chapter, verse)) || [];
  }

  hasCites(book, chapter, verse) {
    return this.byCode.has(verseCode(book, chapter, verse));
  }
}

export { NoteIndex };
