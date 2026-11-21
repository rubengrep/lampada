import { Modal, SuggestModal, EditorSuggest, Notice, debounce } from 'obsidian';
import { categoryOf, norm } from './testo.js';

/* ------------------------------------------------------------------ */
/* Modali                                                              */
/* ------------------------------------------------------------------ */

class GotoModal extends SuggestModal {
  constructor(plugin, onChoose) {
    super(plugin.app);
    this.plugin = plugin;
    this.bible = plugin.bible;
    this.onChoose = onChoose;
    this.setPlaceholder('Es. Gv 3:16, Salmi 23, 1 Giovanni 4:8, Gda 5');
    this.setInstructions([
      { command: '↑↓', purpose: 'scegli' },
      { command: '↵', purpose: 'apri' },
      { command: 'esc', purpose: 'chiudi' },
    ]);
  }

  async onOpen() {
    super.onOpen();
    await this.bible.ensureLoaded().catch((e) => new Notice(e.message));
    this.inputEl.dispatchEvent(new Event('input'));
  }

  getSuggestions(query) {
    if (!this.bible.books.length) return [];
    const out = [];
    const ref = this.bible.parseReference(query);
    if (ref && !ref.invalid && ref.chapter) out.push({ ref, label: this.bible.refLabel(ref), primary: true });
    const s = norm(query).trim();
    const m = /^(\d?)\s*([a-z][a-z .]*)/.exec(s);
    const key = m ? (m[1] + m[2]).replace(/[ .]/g, '') : '';
    const books = s && !m ? [] : this.bible.booksMatching(key);
    for (const b of books) {
      if (out.some((o) => o.ref.book === b.num && !o.ref.chapter)) continue;
      if (ref && ref.book === b.num && ref.chapter) continue;
      out.push({ ref: { book: b.num }, label: b.title, abbr: b.abbr });
    }
    return out.slice(0, 40);
  }

  renderSuggestion(item, el) {
    el.addClass('lmp-suggest');
    const dot = el.createSpan({ cls: `lmp-suggest-dot cat-${categoryOf(item.ref.book)}` });
    dot.setText(this.bible.byNum.get(item.ref.book)?.abbr || '');
    el.createSpan({ cls: 'lmp-suggest-label', text: item.label });
    if (item.primary) el.createSpan({ cls: 'lmp-suggest-hint', text: 'Apri' });
  }

  onChooseSuggestion(item) {
    this.onChoose(item.ref);
  }
}

class SearchModal extends Modal {
  constructor(plugin, onPick) {
    super(plugin.app);
    this.plugin = plugin;
    this.bible = plugin.bible;
    this.onPick = onPick;
  }

  async onOpen() {
    this.modalEl.addClass('lmp-search-modal');
    this.titleEl.setText('Cerca o chiedi');
    const input = this.contentEl.createEl('input', { type: 'search', cls: 'lmp-search-input', attr: { placeholder: 'Un versetto (gv 3:16), un titolo, un argomento… o una domanda' } });
    this.statusEl = this.contentEl.createDiv('lmp-search-status');
    this.resultsEl = this.contentEl.createDiv('lmp-search-results');
    input.focus();
    if (this.plugin.lastSearch) {
      input.value = this.plugin.lastSearch;
      input.select();
    }
    const run = debounce(() => this.search(input.value), 250, true);
    input.addEventListener('input', run);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = this.resultsEl.querySelector('.lmp-search-item');
        if (first) first.click();
      }
    });

    try {
      await this.bible.ensureLoaded();
      if (!this.bible.searchIndex) this.statusEl.setText('Preparazione dell’indice di ricerca…');
      this.index = await this.bible.getSearchIndex((done, total) => this.statusEl.setText(`Preparazione dell’indice… ${Math.round((done / total) * 100)}%`));
      this.statusEl.setText('');
      if (input.value) this.search(input.value);
    } catch (e) {
      this.statusEl.setText(e.message);
    }
  }

  search(query) {
    this.plugin.lastSearch = query;
    this.resultsEl.empty();
    if (!this.index) return;
    const q = norm(query).trim();
    if (q.length < 2) {
      this.statusEl.setText('');
      return;
    }

    const ref = this.bible.parseReference(query);
    if (ref && !ref.invalid && ref.chapter) {
      const item = this.resultsEl.createDiv('lmp-search-item lmp-search-goto');
      item.createDiv({ cls: 'lmp-search-ref', text: `Vai a ${this.bible.refLabel(ref)}` });
      item.addEventListener('click', () => this.pick(ref));
    }

    // Una domanda ("perché…?", frase lunga): prima di tutto la proposta di chiederla alla biblioteca.
    const question = /\?\s*$/.test(query) || /^(perch[eé]|come|cosa|che cosa|chi|quando|dove|quale|quali|quanto|in che modo|cosa dice|cosa insegna)\b/i.test(query.trim()) || q.split(/\s+/).length >= 5;
    if (question) this.askItem(query);
    this.searchOthers(q);
    this.searchParagraphs(query);
    if (!question) this.askItem(query);

    const phrase = /^".*"$/.test(q) ? [q.slice(1, -1)] : null;
    const words = phrase || q.split(/\s+/).filter(Boolean);
    const results = [];
    let count = 0;
    for (const e of this.index) {
      if (words.every((w) => e.n.includes(w))) {
        count++;
        if (results.length < 300) results.push(e);
      }
    }
    this.statusEl.setText(count ? `${count} versetti${count > results.length ? ` (mostrati ${results.length})` : ''}` : 'Nessun versetto');
    if (results.length) this.resultsEl.createDiv({ cls: 'lmp-search-group', text: 'Versetti' });
    for (const e of results) {
      const item = this.resultsEl.createDiv('lmp-search-item');
      item.createDiv({ cls: 'lmp-search-ref', text: this.bible.refLabel(e) });
      this.renderHighlighted(item.createDiv('lmp-search-text'), e, words);
      item.addEventListener('click', () => this.pick({ book: e.book, chapter: e.chapter, verse: e.verse }));
    }
  }

  /** "Chiedi alla biblioteca": l'AI cerca nelle pubblicazioni e risponde con le fonti. */
  askItem(query) {
    const item = this.resultsEl.createDiv('lmp-search-item lmp-search-ask');
    item.createDiv({ cls: 'lmp-search-ref', text: 'Chiedi alla biblioteca' });
    item.createDiv({ cls: 'lmp-search-text', text: `«${query.trim()}» · l’AI cerca nelle pubblicazioni e risponde con le fonti` });
    item.addEventListener('click', () => {
      this.close();
      this.plugin.askLibrary(query.trim());
    });
  }

  /** Paragrafi delle pubblicazioni che parlano dell'argomento (indice delle parole di Chiedi), sotto i titoli. */
  searchParagraphs(query) {
    const ls = this.plugin.librarySearch;
    if (!ls || query.trim().length < 3) return;
    const box = this.resultsEl.createDiv();
    const token = (this.parToken = (this.parToken || 0) + 1);
    ls.find(query, { limit: 8 })
      .then((found) => {
        if (token !== this.parToken || !found || !found.length) return;
        box.createDiv({ cls: 'lmp-search-group', text: found.some((x) => !x.d) ? 'Paragrafi delle pubblicazioni e delle note' : 'Paragrafi delle pubblicazioni' });
        for (const x of found) {
          const item = box.createDiv('lmp-search-item is-other');
          item.createDiv({ cls: 'lmp-search-ref', text: `${x.title} · ${x.pub}` });
          item.createDiv({ cls: 'lmp-search-text', text: x.text.length > 260 ? `${x.text.slice(0, 260)}…` : x.text });
          item.addEventListener('click', () => {
            this.close();
            if (x.d) this.plugin.openLibraryDoc(x.d, x.pid);
            else this.plugin.openNoteAt(x.file, x.pid);
          });
        }
      })
      .catch(() => null);
  }

  /** Prima dei versetti: pubblicazioni, schede SCRABB e note che hanno la ricerca nel titolo (poche per gruppo). */
  searchOthers(q) {
    const MAX = 6;
    const group = (title, items, render) => {
      if (!items.length) return;
      this.resultsEl.createDiv({ cls: 'lmp-search-group', text: title });
      for (const x of items.slice(0, MAX)) {
        const item = this.resultsEl.createDiv('lmp-search-item is-other');
        const [label, sub, open] = render(x);
        item.createDiv({ cls: 'lmp-search-ref', text: label });
        if (sub) item.createDiv({ cls: 'lmp-search-text', text: sub });
        item.addEventListener('click', () => {
          this.close();
          open();
        });
      }
      if (items.length > MAX) this.resultsEl.createDiv({ cls: 'lmp-search-more', text: `e altri ${items.length - MAX}` });
    };
    const p = this.plugin;
    const lib = p.library;
    if (lib.pubs && lib.pubs.length) {
      const hits = [];
      for (const pub of lib.pubs) {
        if (norm(pub.title).includes(q) || norm(pub.symbol) === q) hits.push({ pub });
        for (const d of pub.docs) if (hits.length < 60 && norm(d.title).includes(q)) hits.push({ d });
      }
      group('Pubblicazioni', hits, (h) =>
        h.pub
          ? [h.pub.title, 'Pubblicazione', () => p.openLibraryAt({ mode: 'pub', sym: h.pub.symbol })]
          : [h.d.title, h.d.pub.title, () => p.openLibraryDoc(h.d)]
      );
    } else lib.ensureLoaded().catch(() => null);
    if (p.scrabb && p.scrabb.ready) {
      group('Schede SCRABB', p.scrabb.all().filter((e) => norm(e.name).includes(q)), (e) => [e.name, e.tipo.charAt(0).toUpperCase() + e.tipo.slice(1), () => p.showInScrabb(e.path)]);
    }
    const notes = this.app.vault
      .getMarkdownFiles()
      .filter((f) => norm(f.basename).includes(q) && !this.bible.refFromFile(f) && !(lib.byFile && lib.byFile.get(f.basename)) && !(p.scrabb && p.scrabb.get && p.scrabb.get(f.path)))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
    group('Note', notes, (f) => [f.basename, f.parent && f.parent.path !== '/' ? f.parent.path : '', () => this.app.workspace.getLeaf('tab').openFile(f)]);
  }

  renderHighlighted(el, entry, words) {
    const { text, n } = entry;
    if (n.length !== text.length) {
      el.setText(text);
      return;
    }
    const marks = [];
    for (const w of words) {
      let i = n.indexOf(w);
      while (i !== -1) {
        marks.push([i, i + w.length]);
        i = n.indexOf(w, i + w.length);
      }
    }
    marks.sort((a, b) => a[0] - b[0]);
    let pos = 0;
    for (const [a, b] of marks) {
      if (a < pos) continue;
      el.appendText(text.slice(pos, a));
      el.createEl('mark', { text: text.slice(a, b) });
      pos = b;
    }
    el.appendText(text.slice(pos));
  }

  pick(ref) {
    this.close();
    this.onPick(ref);
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Scrivi "@gv 3:16" (o il prefisso scelto) per inserire un link o una citazione. */
class RefSuggest extends EditorSuggest {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.bible = plugin.bible;
    this.limit = 30;
  }

  onTrigger(cursor, editor) {
    const prefix = this.plugin.settings.suggestTrigger;
    if (!prefix || !this.bible.books.length) return null;
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    const idx = before.lastIndexOf(prefix);
    if (idx < 0) return null;
    if (idx > 0 && !/[\s(\[>]/.test(before[idx - 1])) return null;
    const query = before.slice(idx + prefix.length);
    if (!/^[1-3]?\s?[A-Za-zÀ-ÿ]/.test(query) || query.length > 40 || /\s{2}$/.test(query)) return null;
    return { start: { line: cursor.line, ch: idx }, end: cursor, query };
  }

  async getSuggestions(ctx) {
    const ref = this.bible.parseReference(ctx.query);
    if (ref && !ref.invalid && ref.chapter) {
      let text = '';
      try {
        const data = await this.bible.getChapter(ref.book, ref.chapter);
        const verses = ref.verse ? this.bible.versesOf(ref) : [];
        text = verses.map((v) => (verses.length > 1 ? `${v} ` : '') + this.bible.verseText(data, v)).join(' ');
      } catch (e) {
        /* capitolo non trovato */
      }
      const items = [{ type: 'link', ref, text }];
      if (ref.verse) items.push({ type: 'quote', ref, text });
      items.push({ type: 'open', ref, text });
      return items;
    }
    const s = norm(ctx.query).trim();
    const m = /^(\d?)\s*([a-z][a-z .]*)$/.exec(s);
    if (!m) return [];
    return this.bible.booksMatching((m[1] + m[2]).replace(/[ .]/g, '')).map((b) => ({ type: 'book', book: b }));
  }

  renderSuggestion(item, el) {
    el.addClass('lmp-suggest', 'lmp-editor-suggest');
    const num = item.book ? item.book.num : item.ref.book;
    el.createSpan({ cls: `lmp-suggest-dot cat-${categoryOf(num)}`, text: this.bible.byNum.get(num)?.abbr || '' });
    const body = el.createDiv('lmp-suggest-body');
    if (item.type === 'book') {
      body.createDiv({ cls: 'lmp-suggest-label', text: item.book.title });
      return;
    }
    const hint = { link: 'Inserisci link', quote: 'Inserisci link + testo', open: 'Apri nel lettore' }[item.type];
    const row = body.createDiv('lmp-suggest-row');
    row.createSpan({ cls: 'lmp-suggest-label', text: this.bible.refLabel(item.ref) });
    row.createSpan({ cls: 'lmp-suggest-hint', text: hint });
    if (item.text && item.type !== 'open') body.createDiv({ cls: 'lmp-suggest-text', text: item.text });
  }

  selectSuggestion(item) {
    const ctx = this.context;
    if (!ctx) return;
    const { editor, start, end } = ctx;
    if (item.type === 'book') {
      const text = `${this.plugin.settings.suggestTrigger}${item.book.abbr} `;
      editor.replaceRange(text, start, end);
      editor.setCursor({ line: start.line, ch: start.ch + text.length });
      return;
    }
    if (item.type === 'open') {
      editor.replaceRange('', start, end);
      this.plugin.openReader(item.ref);
      this.close();
      return;
    }
    const link = this.bible.formatLink(item.ref);
    const out = item.type === 'quote' ? this.plugin.fillTemplate({ link, label: this.bible.refLabel(item.ref), text: item.text }) : link;
    editor.replaceRange(out, start, end);
    const lines = out.split('\n');
    editor.setCursor({ line: start.line + lines.length - 1, ch: (lines.length === 1 ? start.ch : 0) + lines[lines.length - 1].length });
    this.plugin.openAfterCite(item.ref, editor);
  }
}

/** Elenco dei riferimenti biblici presenti nella nota attiva, con il testo dei versetti. */
class NoteRefsModal extends Modal {
  constructor(plugin, file, hits) {
    super(plugin.app);
    this.plugin = plugin;
    this.file = file;
    this.hits = hits;
  }

  async onOpen() {
    const bible = this.plugin.bible;
    this.modalEl.addClass('lmp-search-modal');
    this.titleEl.setText(`Versetti in «${this.file.basename}»`);
    const seen = new Set();
    const list = this.contentEl.createDiv('lmp-search-results');
    if (!this.hits.length) list.createDiv({ cls: 'lmp-empty', text: 'Nessun riferimento biblico trovato in questa nota.' });
    for (const h of this.hits) {
      const key = `${h.ref.book}:${h.ref.chapter}:${h.verses.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const item = list.createDiv('lmp-search-item');
      const head = item.createDiv('lmp-search-ref');
      head.setText(bible.refLabel(h.ref, h.versesText));
      if (h.kind === 'plain') head.createSpan({ cls: 'lmp-suggest-hint', text: ' · testo semplice' });
      const txt = item.createDiv({ cls: 'lmp-search-text', text: '…' });
      item.addEventListener('click', () => {
        this.close();
        this.plugin.openReader(h.ref);
      });
      bible
        .getChapter(h.ref.book, h.ref.chapter)
        .then((data) => {
          const vs = h.verses.length ? h.verses : [1, 2];
          txt.setText(vs.map((v) => (vs.length > 1 ? `${v} ` : '') + bible.verseText(data, v)).join(' ').slice(0, 600));
        })
        .catch(() => txt.setText(''));
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

export { GotoModal, SearchModal, RefSuggest, NoteRefsModal };
