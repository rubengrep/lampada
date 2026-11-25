import { ItemView, Modal, SuggestModal, FuzzySuggestModal, EditorSuggest, Setting, Notice, setIcon, debounce, Platform } from 'obsidian';
import { issueLabel } from './biblioteca-dati.js';
import { renderMd } from './file.js';
import { SCRABB_ALL_LISTS, SCRABB_BIBLE_LISTS, SCRABB_ERAS, SCRABB_FIELD_FOR, SCRABB_INTRO, SCRABB_LANES, SCRABB_LINK_FIELDS, scrabbApprox, scrabbFonti, scrabbLinkpaths, scrabbList, scrabbNum, SCRABB_STUDY_LISTS, SCRABB_TEACHERS, SCRABB_TEACHINGS, SCRABB_TYPES, SCRABB_USABLE, SCRABB_VIEW_TYPE, scrabbBody, scrabbDate, scrabbFmtDate, scrabbFold, scrabbListOf, scrabbListTypes, scrabbSafeName, scrabbUsageText, scrabbYear } from './scrabb-dati.js';
import { cleanSnippet } from './testo.js';
import { compare, t } from './lingua.js';
import { addGoToAction, addViewSwitch, autoHideBars, setBarsHidden } from './ui.js';

/* ---------------- finestre: scelta e creazione delle schede ---------------- */

/** Mentre si scrive: "++umil" propone le schede SCRABB e inserisce il link (o crea la scheda al volo). */
class ScrabbSuggest extends EditorSuggest {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.limit = 40;
  }

  onTrigger(cursor, editor) {
    const prefix = this.plugin.settings.scrabbTrigger;
    if (!prefix || !this.plugin.scrabb.ready) return null;
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    const idx = before.lastIndexOf(prefix);
    if (idx < 0) return null;
    if (idx > 0 && !/[\s(\[>"“'’]/.test(before[idx - 1])) return null;
    const query = before.slice(idx + prefix.length);
    if (query.length > 60 || /^\s|\s{2}$/.test(query)) return null;
    return { start: { line: cursor.line, ch: idx }, end: cursor, query };
  }

  getSuggestions(ctx) {
    const words = scrabbFold(ctx.query).split(/\s+/).filter(Boolean);
    const order = ['principio', 'qualità', 'modello', 'illustrazione', 'situazione', 'tema', 'persona', 'evento', 'periodo', 'luogo', 'libro'];
    const out = [];
    for (const e of this.plugin.scrabb.all()) {
      const n = scrabbFold(e.name);
      if (!words.every((w) => n.includes(w))) continue;
      const starts = words.length && n.startsWith(words[0]) ? 0 : 1;
      const exact = n === words.join(' ') ? -1000 : 0;
      out.push({ e, s: exact + starts * 100 + (order.indexOf(e.tipo) + 1 || 50) + n.length / 1000 });
    }
    const items = out.sort((a, b) => a.s - b.s).slice(0, 30).map((x) => ({ e: x.e }));
    const q = ctx.query.trim();
    if (q && !items.some((i) => scrabbFold(i.e.name) === scrabbFold(q))) {
      for (const tipo of ['principio', 'modello', 'illustrazione']) items.push({ create: tipo, name: q });
    }
    return items;
  }

  renderSuggestion(item, el) {
    el.addClass('scrabb-suggest');
    if (item.create) {
      const icon = el.createSpan(`scrabb-suggest-icon scrabb-t-${item.create}`);
      setIcon(icon, 'plus');
      el.createSpan({ cls: 'scrabb-suggest-name', text: t('Crea «{nome}»', { nome: item.name }) });
      el.createSpan({ cls: 'scrabb-suggest-meta', text: t('nuovo {tipo}', { tipo: t(SCRABB_TYPES[item.create].label).toLowerCase() }) });
      return;
    }
    const e = item.e;
    setIcon(el.createSpan(`scrabb-suggest-icon scrabb-t-${e.tipo}`), SCRABB_TYPES[e.tipo].icon);
    el.createSpan({ cls: 'scrabb-suggest-name', text: e.name });
    el.createSpan({ cls: 'scrabb-suggest-meta', text: [t(SCRABB_TYPES[e.tipo].label), e.categoria || scrabbDate(e)].filter(Boolean).join(' · ') });
  }

  selectSuggestion(item) {
    const ctx = this.context;
    if (!ctx) return;
    const { editor, start, end } = ctx;
    const put = (name) => {
      const link = `[[${name}]]`;
      editor.replaceRange(link, start, start);
      editor.setCursor({ line: start.line, ch: start.ch + link.length });
    };
    editor.replaceRange('', start, end);
    this.close();
    if (item.create) new ScrabbNewModal(this.plugin, { name: item.name, tipo: item.create }, (f) => put(f.basename)).open();
    else put(item.e.name);
  }
}


class ScrabbPickModal extends SuggestModal {
  constructor(plugin, opts, onPick) {
    super(plugin.app);
    this.plugin = plugin;
    this.opts = opts || {};
    this.onPick = onPick;
    this.setPlaceholder(this.opts.placeholder || t('Cerca una scheda SCRABB…'));
    this.emptyStateText = t('Nessuna scheda trovata');
  }

  getSuggestions(query) {
    const q = scrabbFold(query.trim());
    const list = this.plugin.scrabb.all(this.opts.types);
    const scored = [];
    for (const e of list) {
      // Nome o uno degli altri nomi (aliases): vale quello che corrisponde meglio.
      let best = null;
      for (const name of [e.name, ...(e.aliases || [])]) {
        const n = scrabbFold(name);
        const i = q ? n.indexOf(q) : 0;
        if (i < 0) continue;
        const sc = (i === 0 ? 0 : 1) + n.length / 1000 + (name === e.name ? 0 : 0.0005);
        if (best == null || sc < best) best = sc;
      }
      if (best != null) scored.push({ e, s: best });
    }
    scored.sort((a, b) => a.s - b.s);
    const out = scored.slice(0, 60).map((x) => x.e);
    if (this.opts.allowCreate && query.trim() && !list.some((e) => scrabbFold(e.name) === q)) out.push({ create: true, name: query.trim() });
    return out;
  }

  renderSuggestion(item, el) {
    el.addClass('scrabb-suggest');
    if (item.create) {
      setIcon(el.createSpan('scrabb-suggest-icon'), 'plus');
      el.createSpan({ text: t('Crea la scheda «{nome}»', { nome: item.name }) });
      return;
    }
    const icon = el.createSpan(`scrabb-suggest-icon scrabb-t-${item.tipo}`);
    setIcon(icon, SCRABB_TYPES[item.tipo].icon);
    el.createSpan({ cls: 'scrabb-suggest-name', text: item.name });
    let extra = scrabbDate(item);
    if (SCRABB_USABLE.includes(item.tipo)) {
      if (!this.usage) this.usage = this.plugin.scrabb.usageMap();
      extra = scrabbUsageText(this.usage.get(item.path) || []);
    }
    el.createSpan({ cls: 'scrabb-suggest-meta', text: [t(SCRABB_TYPES[item.tipo].label), extra].filter(Boolean).join(' · ') });
  }

  onChooseSuggestion(item) {
    this.onPick(item);
  }
}

class ScrabbNewModal extends Modal {
  constructor(plugin, opts, onDone) {
    super(plugin.app);
    this.plugin = plugin;
    this.opts = Object.assign({ name: '', tipo: 'principio', versetti: '', links: [], body: '', fonti: [] }, opts || {});
    this.onDone = onDone;
  }

  onOpen() {
    const o = this.opts;
    this.titleEl.setText(t('Nuova scheda SCRABB'));
    this.contentEl.addClass('scrabb-new');
    new Setting(this.contentEl).setName(t('Nome')).addText((c) => {
      c.setValue(o.name).onChange((v) => (o.name = v));
      window.setTimeout(() => c.inputEl.focus(), 30);
      c.inputEl.addEventListener('keydown', (evt) => evt.key === 'Enter' && this.submit());
    });
    new Setting(this.contentEl).setName(t('Tipo')).addDropdown((d) => {
      for (const [k, x] of Object.entries(SCRABB_TYPES)) d.addOption(k, t(x.label));
      d.setValue(o.tipo).onChange((v) => (o.tipo = v));
    });
    new Setting(this.contentEl)
      .setName(t('Versetti'))
      .setDesc(t('Separati da punto e virgola, es. Romani 12:19; Proverbi 20:22'))
      .addText((c) => c.setValue(o.versetti).onChange((v) => (o.versetti = v)));
    const linkSet = new Setting(this.contentEl).setName(t('Collegata a'));
    const chips = linkSet.controlEl.createDiv('scrabb-chips');
    const drawChips = () => {
      chips.empty();
      for (const n of o.links) {
        const c = chips.createSpan({ cls: 'scrabb-chip', text: n });
        const x = c.createSpan({ cls: 'scrabb-chip-x', text: '×' });
        x.addEventListener('click', () => {
          o.links = o.links.filter((l) => l !== n);
          drawChips();
        });
      }
      const add = chips.createEl('button', { cls: 'scrabb-chip scrabb-chip-add', text: t('+ collega') });
      add.addEventListener('click', () =>
        new ScrabbPickModal(this.plugin, { placeholder: t('Collega a…') }, (e) => {
          if (!o.links.includes(e.name)) o.links.push(e.name);
          drawChips();
        }).open()
      );
    };
    drawChips();
    if (o.body) {
      const prev = this.contentEl.createDiv('scrabb-new-quote');
      prev.setText(o.body.replace(/^>\s?/gm, '').slice(0, 400));
    }
    const btns = this.contentEl.createDiv('modal-button-container');
    const open = btns.createEl('label', { cls: 'scrabb-new-open' });
    const cb = open.createEl('input', { attr: { type: 'checkbox' } });
    cb.checked = !!this.plugin.ui.scrabbOpenNew;
    cb.addEventListener('change', () => {
      this.plugin.ui.scrabbOpenNew = cb.checked;
      this.plugin.requestSave();
    });
    open.appendText(' ' + t('Apri la nota'));
    btns.createEl('button', { cls: 'mod-cta', text: t('Crea') }).addEventListener('click', () => this.submit());
  }

  async submit() {
    const o = this.opts;
    if (!scrabbSafeName(o.name)) {
      new Notice(t('Scrivi un nome per la scheda.'));
      return;
    }
    try {
      const versetti = o.versetti.split(';').map((s) => s.trim()).filter(Boolean);
      const file = await this.plugin.scrabb.create({ name: o.name, tipo: o.tipo, versetti, links: o.links, body: o.body, fonti: o.fonti });
      this.close();
      new Notice(t('Scheda creata: {nome}', { nome: file.basename }));
      if (this.plugin.ui.scrabbOpenNew) await this.app.workspace.getLeaf('tab').openFile(file);
      if (this.onDone) this.onDone(file);
    } catch (e) {
      new Notice(t('Impossibile creare la scheda: {errore}', { errore: e.message }));
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Valore del campo "approssimata" per le due date (vedi scrabbApprox). */
function scrabbApproxValue(start, end) {
  return start && end ? true : start ? 'inizio' : end ? 'fine' : null;
}

// Campi del frontmatter che la finestra «Modifica» gestisce da sé; gli altri testi semplici finiscono in "Altri campi".
const SCRABB_KNOWN = new Set(['tipo', 'tags', 'aliases', 'versetti', 'fonti', 'perspicacia', 'categoria', 'domanda', 'ordine', 'anno', 'anno_fine', 'approssimata', 'corsia', 'data', 'position', ...SCRABB_LINK_FIELDS]);

/**
 * Modifica una scheda senza toccare lo YAML: tipo, versetti, collegamenti, fonti, data per la Cronologia e gli altri campi.
 * Scrive nel frontmatter solo i campi cambiati, con gli stessi nomi che si possono scrivere a mano.
 */
class ScrabbEditModal extends Modal {
  constructor(plugin, e) {
    super(plugin.app);
    this.plugin = plugin;
    this.e = e;
    const fm = plugin.app.metadataCache.getFileCache(e.file)?.frontmatter || {};
    const str = (x) => (x == null ? '' : Array.isArray(x) ? `[[${x.flat(3).join('')}]]` : String(x));
    const year = (y, ca) => (y == null ? { n: '', bce: true, ca: false } : { n: String(Math.abs(y)), bce: y < 0, ca: !!ca });
    const approx = scrabbApprox(fm.approssimata) || {};
    const links = [];
    for (const field of SCRABB_LINK_FIELDS)
      for (const item of scrabbList(fm[field]))
        for (const name of scrabbLinkpaths([item]))
          links.push({ field, name, raw: typeof item === 'string' && scrabbLinkpaths([item]).length === 1 ? item : `[[${name}]]` });
    this.v = {
      name: e.name,
      aliases: scrabbList(fm.aliases).map(String).join(', '),
      tipo: e.tipo,
      versetti: scrabbList(fm.versetti).map(String).join('\n'),
      links,
      fonti: scrabbList(fm.fonti).map(String),
      perspicacia: str(fm.perspicacia),
      categoria: str(fm.categoria),
      domanda: str(fm.domanda),
      ordine: str(fm.ordine),
      from: year(scrabbNum(fm.anno), approx.start),
      to: year(scrabbNum(fm.anno_fine), approx.end),
      corsia: str(fm.corsia),
      data: str(fm.data),
      extra: Object.entries(fm).filter(([k, x]) => !SCRABB_KNOWN.has(k) && ['string', 'number'].includes(typeof x)).map(([k, x]) => ({ k, x: String(x), num: typeof x === 'number' })),
    };
    this.init = this.toFm();
  }

  /** Valori del frontmatter (null = campo da togliere); lancia un errore con un messaggio per l'utente. */
  toFm() {
    const v = this.v;
    const yr = (y) => {
      if (!y.n) return null;
      const n = Math.abs(Math.round(Number(y.n)));
      if (!n) throw new Error(t('Scrivi l’anno (un numero, senza lo 0).'));
      return y.bce ? -n : n;
    };
    const anno = yr(v.from);
    const fine = yr(v.to);
    if (fine != null && anno == null) throw new Error(t('Manca l’anno di inizio.'));
    if (fine != null && fine < anno) throw new Error(t('«Fino a» viene prima dell’anno di inizio.'));
    const ordine = v.ordine.trim() === '' ? null : Number(v.ordine);
    if (ordine != null && !Number.isFinite(ordine)) throw new Error(t('L’ordine deve essere un numero.'));
    const list = (a) => (a.length ? a : null);
    const out = {
      aliases: list(v.aliases.split(',').map((s) => s.trim()).filter(Boolean)),
      tipo: v.tipo,
      versetti: list(v.versetti.split('\n').map((s) => s.trim()).filter(Boolean)),
      fonti: list(v.fonti),
      perspicacia: v.perspicacia.trim() || null,
      categoria: v.categoria.trim() || null,
      domanda: v.domanda.trim() || null,
      ordine,
      anno,
      anno_fine: fine === anno ? null : fine,
      // Una data sola: il «ca.» vale per lei, da qualunque riga venga.
      approssimata: anno == null ? null : scrabbApproxValue(v.from.ca || (fine == null || fine === anno ? v.to.ca : false), fine != null && fine !== anno && v.to.ca),
      corsia: v.corsia || null,
      data: v.data.trim() || null,
    };
    for (const f of SCRABB_LINK_FIELDS) out[f] = list(v.links.filter((l) => l.field === f).map((l) => l.raw));
    for (const x of v.extra) {
      const k = x.k.trim();
      if (!k) continue;
      if (x.isNew && (SCRABB_KNOWN.has(k) || k in out)) throw new Error(t('Il campo «{nome}» c’è già.', { nome: k }));
      out[k] = x.del || x.x.trim() === '' ? null : x.num && Number.isFinite(Number(x.x)) ? Number(x.x) : x.x.trim();
    }
    return out;
  }

  onOpen() {
    const v = this.v;
    const c = this.contentEl;
    this.titleEl.setText(t('Modifica «{nome}»', { nome: this.e.name }));
    c.addClass('scrabb-edit');
    const head = (name) => new Setting(c).setName(name).setHeading();
    const text = (name, desc, key, ph) =>
      new Setting(c).setName(name).setDesc(desc || '').addText((x) => x.setPlaceholder(ph || '').setValue(v[key]).onChange((s) => (v[key] = s)));

    text(t('Nome'), t('Cambiandolo, i link alla scheda nelle altre note si aggiornano (se in Obsidian è attivo l’aggiornamento dei link).'), 'name');
    text(t('Altri nomi'), t('Separati da virgola: anche con questi nomi la trovi e la colleghi.'), 'aliases');
    new Setting(c).setName(t('Tipo')).addDropdown((d) => {
      for (const [k, x] of Object.entries(SCRABB_TYPES)) d.addOption(k, t(x.label));
      d.setValue(v.tipo).onChange((s) => (v.tipo = s));
    });
    new Setting(c)
      .setName(t('Versetti'))
      .setDesc(t('Uno per riga, es. Romani 12:19'))
      .addTextArea((x) => {
        x.setValue(v.versetti).onChange((s) => (v.versetti = s));
        x.inputEl.rows = Math.min(8, Math.max(3, v.versetti.split('\n').length + 1));
      });

    head(t('Collegamenti'));
    const chips = new Setting(c).setDesc(t('Altre schede collegate a questa. × toglie il collegamento.')).controlEl.createDiv('scrabb-chips');
    const drawChips = () => {
      chips.empty();
      for (const l of v.links) {
        const ch = chips.createSpan({ cls: 'scrabb-chip', text: l.name });
        ch.createSpan({ cls: 'scrabb-chip-x', text: '×' }).addEventListener('click', () => {
          v.links = v.links.filter((x) => x !== l);
          drawChips();
        });
      }
      chips.createEl('button', { cls: 'scrabb-chip scrabb-chip-add', text: t('+ collega') }).addEventListener('click', () =>
        new ScrabbPickModal(this.plugin, { placeholder: t('Collega a…') }, (x) => {
          if (x.path === this.e.path || v.links.some((l) => l.name === x.name)) return;
          v.links.push({ field: SCRABB_FIELD_FOR[x.tipo], name: x.name, raw: `[[${x.name}]]` });
          drawChips();
        }).open()
      );
    };
    drawChips();
    if (v.fonti.length) {
      const box = new Setting(c).setName(t('Fonti')).setDesc(t('Paragrafi delle pubblicazioni. Si aggiungono dalla Biblioteca con «Collega a SCRABB».')).controlEl.createDiv('scrabb-chips');
      const drawFonti = () => {
        box.empty();
        for (const f of v.fonti) {
          const info = scrabbFonti(f)[0];
          const ch = box.createSpan({ cls: 'scrabb-chip', text: (info && (info.label || info.file)) || f });
          ch.createSpan({ cls: 'scrabb-chip-x', text: '×' }).addEventListener('click', () => {
            v.fonti = v.fonti.filter((x) => x !== f);
            drawFonti();
          });
        }
      };
      drawFonti();
    }
    let perspInput;
    new Setting(c)
      .setName(t('Perspicacia'))
      .setDesc(t('L’articolo di Perspicacia su questa voce: «Scegli…» lo cerca nella biblioteca.'))
      .addText((x) => (perspInput = x).setPlaceholder('[[…]]').setValue(v.perspicacia).onChange((s) => (v.perspicacia = s)))
      .addButton((b) => b.setButtonText(t('Scegli…')).onClick(() => this.pickPerspicacia((link) => {
        v.perspicacia = link;
        perspInput.setValue(link);
      })));

    head(t('Elenco e studio'));
    text(t('Categoria'), t('Gruppo nell’elenco, se la scheda non è collegata a un tema.'), 'categoria');
    text(t('Domanda'), t('Mostrata sotto il titolo della scheda.'), 'domanda');
    text(t('Ordine'), t('Numero: posizione nell’elenco (i più bassi prima).'), 'ordine');

    head(t('Data e Cronologia'));
    const yearRow = (name, desc, y) =>
      new Setting(c)
        .setName(name)
        .setDesc(desc)
        .addText((x) => {
          x.inputEl.type = 'number';
          x.inputEl.min = '1';
          x.setPlaceholder(t('anno')).setValue(y.n).onChange((s) => (y.n = s.trim()));
        })
        .addDropdown((d) => d.addOptions({ bce: t('a.E.V.'), ce: t('E.V.') }).setValue(y.bce ? 'bce' : 'ce').onChange((s) => (y.bce = s === 'bce')))
        .addToggle((x) => x.setTooltip(t('Circa: data approssimativa (ca.)')).setValue(y.ca).onChange((s) => (y.ca = s)));
    yearRow(t('Anno'), t('Quando è nato, è successo o è cominciato. Senza anno la scheda non va nella Cronologia. L’interruttore aggiunge «ca.».'), v.from);
    yearRow(t('Fino a'), t('Facoltativo: fine del periodo o della vita. L’interruttore aggiunge «ca.».'), v.to);
    new Setting(c)
      .setName(t('Corsia'))
      .setDesc(t('Riga della Cronologia in cui compare.'))
      .addDropdown((d) => {
        d.addOption('', t('Automatica'));
        for (const l of SCRABB_LANES) d.addOption(l, t(l));
        if (v.corsia && !SCRABB_LANES.includes(v.corsia)) d.addOption(v.corsia, v.corsia);
        d.setValue(v.corsia).onChange((s) => (v.corsia = s));
      });
    text(t('Testo della data'), t('Facoltativo, mostrato accanto alla data: es. «11 anni di regno». «futuro» mette la scheda in fondo alla Cronologia.'), 'data');

    head(t('Altri campi'));
    const extraEl = c.createDiv();
    const drawExtra = () => {
      extraEl.empty();
      for (const x of v.extra) {
        if (x.del) continue;
        const s = new Setting(extraEl).setName(x.k || t('Nuovo campo'));
        if (x.isNew) s.addText((n) => n.setPlaceholder(t('nome, es. esito')).setValue(x.k).onChange((k) => (x.k = k)));
        s.addText((n) => n.setPlaceholder(t('valore')).setValue(x.x).onChange((val) => (x.x = val)));
        s.addExtraButton((b) => b.setIcon('x').setTooltip(t('Togli')).onClick(() => {
          x.del = true;
          drawExtra();
        }));
      }
      new Setting(extraEl).addButton((b) => b.setButtonText(t('+ campo')).onClick(() => {
        v.extra.push({ k: '', x: '', isNew: true });
        drawExtra();
      }));
    };
    drawExtra();

    const btns = c.createDiv('modal-button-container');
    // Due tocchi per eliminare: il file va nel cestino scelto in Obsidian, da cui si recupera.
    const del = btns.createEl('button', { cls: 'mod-warning scrabb-edit-del', text: t('Elimina') });
    del.addEventListener('click', async () => {
      if (!del.hasClass('is-armed')) {
        del.addClass('is-armed');
        del.setText(t('Tocca di nuovo per eliminare'));
        return;
      }
      await this.app.fileManager.trashFile(this.e.file);
      this.close();
      new Notice(t('Scheda eliminata: {nome}', { nome: this.e.name }));
    });
    btns.createEl('button', { text: t('Apri nota') }).addEventListener('click', () => {
      this.close();
      this.app.workspace.getLeaf('tab').openFile(this.e.file);
    });
    btns.createEl('button', { cls: 'mod-cta', text: t('Salva') }).addEventListener('click', () => this.save());
  }

  /** Cerca un articolo di Perspicacia (simbolo "it") tra le pubblicazioni della biblioteca. */
  async pickPerspicacia(done) {
    const lib = this.plugin.library;
    await lib.ensureLoaded().catch(() => null);
    const docs = (lib.bySym && lib.bySym.get('it')?.docs) || [];
    if (!docs.length) {
      new Notice(t('Perspicacia non è nella biblioteca: importala, oppure scrivi il link a mano.'));
      return;
    }
    const m = new FuzzySuggestModal(this.app);
    m.setPlaceholder(t('Cerca una voce di Perspicacia…'));
    m.getItems = () => docs.filter((d) => d.file);
    m.getItemText = (d) => d.title;
    m.onChooseItem = (d) => done(`[[${d.file}|Perspicacia · ${d.title}]]`); // testo nel vault: resta in italiano
    m.open();
  }

  async save() {
    let out;
    try {
      out = this.toFm();
    } catch (err) {
      new Notice(err.message);
      return;
    }
    const changed = Object.keys(out).filter((k) => JSON.stringify(out[k]) !== JSON.stringify(this.init[k] ?? null));
    const name = scrabbSafeName(this.v.name);
    if (!name) {
      new Notice(t('Scrivi un nome per la scheda.'));
      return;
    }
    const file = this.e.file;
    const newPath = name === this.e.name ? null : `${file.parent && file.parent.path !== '/' ? file.parent.path + '/' : ''}${name}.md`;
    if (newPath && this.app.vault.getAbstractFileByPath(newPath)) {
      new Notice(t('C’è già una nota «{nome}» in questa cartella.', { nome: name }));
      return;
    }
    if (!changed.length && !newPath) return this.close();
    try {
      if (changed.length) await this.app.fileManager.processFrontMatter(file, (fm) => {
        for (const k of changed) {
          if (out[k] == null) delete fm[k];
          else fm[k] = out[k];
        }
        // Il tag segue il tipo (scrabb/persona…).
        if (changed.includes('tipo') && fm.tags) {
          const old = `scrabb/${scrabbFold(this.init.tipo)}`;
          fm.tags = scrabbList(fm.tags).map((x) => (String(x) === old ? `scrabb/${scrabbFold(out.tipo)}` : x));
        }
      });
      if (newPath) await this.app.fileManager.renameFile(file, newPath);
      this.close();
      new Notice(t('Scheda aggiornata: {nome}', { nome: name }));
    } catch (err) {
      new Notice(t('Impossibile salvare la scheda: {errore}', { errore: err.message }));
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ---------------- vista SCRABB ---------------- */

class ScrabbView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.index = plugin.scrabb;
    const saved = plugin.ui.scrabb || {};
    this.state = { tab: saved.tab || 'principi', list: saved.list || 'principio', sel: saved.sel || null, focus: saved.focus || null, study: saved.study || null, depth: saved.depth || 1, ppy: saved.ppy || 0, hidden: saved.hidden || [] };
    this.cardToken = 0;
  }

  getViewType() {
    return SCRABB_VIEW_TYPE;
  }

  getDisplayText() {
    return 'SCRABB';
  }

  getIcon() {
    return 'waypoints';
  }

  getState() {
    return { ...this.state };
  }

  async setState(state, result) {
    if (state) Object.assign(this.state, state);
    if (this.rootEl) this.render();
    return super.setState(state, result);
  }

  saveState() {
    const { tab, list, sel, focus, study, depth, ppy, hidden } = this.state;
    this.plugin.ui.scrabb = { tab, list, sel, focus, study, depth, ppy, hidden };
    this.plugin.requestSave();
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass('scrabb-view');
    this.rootEl = this.contentEl;
    const head = this.contentEl.createDiv('scrabb-header lmp-toolbar');
    const home = () => {
      this.state.tab = 'principi';
      this.saveState();
      this.render();
    };
    this.goHome = home;
    // Nella vista unica: Indietro (cronologia del guscio) prima del selettore, come nelle altre sezioni.
    if (this.inShell) {
      this.backBtn = head.createEl('button', { cls: 'lmp-tb-btn clickable-icon', attr: { 'aria-label': t('Indietro') } });
      setIcon(this.backBtn, 'arrow-left');
      this.backBtn.addEventListener('click', () => this.inShell.goBack());
    }
    addViewSwitch(head, this.plugin, 'scrabb', home, this.inShell);
    if (Platform.isPhone && this.addAction && !this.inShell) addGoToAction(this, 'scrabb', home);
    this.tabsEl = head.createDiv('scrabb-tabs');
    for (const [id, label, icon] of [['principi', t('Schede'), 'gem'], ['cronologia', t('Cronologia'), 'calendar-range'], ['mappa', t('Mappa'), 'waypoints']]) {
      const b = this.tabsEl.createEl('button', { cls: 'scrabb-tab', attr: { 'data-tab': id } });
      setIcon(b.createSpan(), icon);
      b.createSpan({ text: label });
      b.addEventListener('click', () => {
        if (this.state.tab === id) return;
        if (this.inShell) this.inShell.push(this, this.snapshot());
        this.state.tab = id;
        this.saveState();
        this.render();
      });
    }
    const tools = head.createDiv('scrabb-head-tools');
    const search = tools.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': t('Cerca ovunque') } });
    setIcon(search, 'search');
    search.addEventListener('click', () => this.plugin.openSearch());
    const plus = tools.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': t('Nuova scheda') } });
    setIcon(plus, 'plus');
    plus.addEventListener('click', () => {
      const tipo = this.state.tab === 'principi' && SCRABB_TYPES[this.state.list] ? this.state.list : 'persona';
      new ScrabbNewModal(this.plugin, { tipo }, (f) => this.selectWhenIndexed(f.path)).open();
    });
    const body = this.contentEl.createDiv('scrabb-body');
    this.mainEl = body.createDiv('scrabb-main');
    autoHideBars(this, this.mainEl);
    this.cardEl = body.createDiv('scrabb-card');
    this.mainEl.setText(t('Caricamento delle schede…'));
    this.registerEvent(this.app.workspace.on('lampada:scrabb-changed', () => this.requestRender()));
    // Trascinamento della cronologia col mouse (un solo ascoltatore per tutta la vita della vista).
    this.registerDomEvent(window, 'pointermove', (evt) => {
      const d = this.tlDrag;
      if (!d) return;
      d.el.scrollLeft = d.l - (evt.clientX - d.x);
      d.el.scrollTop = d.t - (evt.clientY - d.y);
    });
    this.registerDomEvent(window, 'pointerup', () => {
      if (this.tlDrag) this.tlDrag.el.removeClass('is-dragging');
      this.tlDrag = null;
    });
    this.requestRender = debounce(() => this.render(), 250, true);
    await this.index.ensure();
    this.render();
  }

  async onClose() {
    setBarsHidden(this, false);
    if (this.sim) cancelAnimationFrame(this.sim);
  }

  render() {
    if (!this.mainEl || !this.index.ready) return;
    this.tabsEl.querySelectorAll('.scrabb-tab').forEach((b) => b.toggleClass('is-active', b.dataset.tab === this.state.tab));
    if (this.sim) cancelAnimationFrame(this.sim);
    this.sim = null;
    this.mainEl.empty();
    this.mainEl.dataset.tab = this.state.tab;
    if (this.state.tab === 'cronologia') this.renderTimeline(this.mainEl);
    else if (this.state.tab === 'mappa') this.renderGraph(this.mainEl);
    else this.renderStudy(this.mainEl);
    this.renderCard();
  }

  /** Seleziona una scheda: si apre il riquadro a destra (e, se serve, la si mostra nella scheda attiva). */
  /** Per la cronologia del guscio: com'è la vista adesso, e come rimetterla così. */
  snapshot() {
    return { ...this.state, hidden: [...(this.state.hidden || [])] };
  }

  async restore(snap) {
    Object.assign(this.state, snap);
    this.saveState();
    this.render();
  }

  select(path, reveal) {
    if (this.inShell && path !== this.state.sel) this.inShell.push(this, this.snapshot());
    this.state.sel = path;
    const e = this.index.get(path);
    if (reveal && e) {
      if (this.state.tab === 'mappa') this.state.focus = path;
      if (this.state.tab === 'principi' && SCRABB_ALL_LISTS.includes(scrabbListOf(e.tipo))) {
        this.state.list = scrabbListOf(e.tipo);
        this.state.study = path;
      }
      if (this.state.tab === 'cronologia' && e.anno == null) new Notice(t('Questa scheda non ha ancora una data: toccala e scegli «Modifica».'));
      this.saveState();
      this.render();
      if (this.state.tab === 'cronologia') this.scrollTimelineTo(e);
      return;
    }
    this.saveState();
    this.mainEl.querySelectorAll('[data-path]').forEach((el) => el.toggleClass('is-selected', el.dataset.path === path));
    this.renderCard();
  }

  selectWhenIndexed(path) {
    let tries = 0;
    const tick = () => {
      if (this.index.get(path)) this.select(path, true);
      else if (tries++ < 20) window.setTimeout(tick, 300);
    };
    tick();
  }

  openTab(tab, path) {
    this.state.tab = tab;
    if (tab === 'mappa') this.state.focus = path;
    this.state.sel = path;
    this.saveState();
    this.render();
    const e = this.index.get(path);
    if (tab === 'cronologia' && e) this.scrollTimelineTo(e);
  }

  async openFile(e, evt) {
    const ws = this.app.workspace;
    const existing = ws.getLeavesOfType('markdown').find((l) => l.view.file && l.view.file.path === e.path);
    if (existing && !(evt && (evt.metaKey || evt.ctrlKey))) return ws.setActiveLeaf(existing, { focus: true });
    await this.plugin.mainAreaLeaf().openFile(e.file, { active: true });
  }

  chip(parent, e, opts = {}) {
    const c = parent.createSpan({ cls: `scrabb-chip scrabb-t-${e.tipo}`, attr: { 'data-path': e.path, 'aria-label': [t(SCRABB_TYPES[e.tipo].label), scrabbDate(e)].filter(Boolean).join(' · ') } });
    c.createSpan('scrabb-dot');
    c.createSpan({ text: e.name });
    if (!opts.static) c.addEventListener('click', (evt) => (evt.metaKey || evt.ctrlKey ? this.openFile(e, evt) : this.select(e.path, opts.reveal)));
    return c;
  }

  /* ---------- riquadro scheda ---------- */

  async renderCard() {
    const el = this.cardEl;
    const token = ++this.cardToken;
    el.empty();
    let e = this.state.sel && this.index.get(this.state.sel);
    // In "Schede" la scheda aperta al centro non si ripete nel riquadro a destra.
    if (e && this.state.tab === 'principi' && this.state.sel === this.state.study) e = null;
    this.contentEl.toggleClass('has-card', !!e);
    if (!e) return;
    const head = el.createDiv(`scrabb-card-head scrabb-t-${e.tipo}`);
    const close = head.createEl('button', { cls: 'clickable-icon scrabb-card-close', attr: { 'aria-label': t('Chiudi') } });
    setIcon(close, 'x');
    close.addEventListener('click', () => this.select(null));
    const type = head.createDiv('scrabb-card-type');
    setIcon(type.createSpan(), SCRABB_TYPES[e.tipo].icon);
    type.createSpan({ text: [t(SCRABB_TYPES[e.tipo].label), e.corsia ? t(e.corsia) : e.categoria].filter(Boolean).join(' · ') });
    head.createDiv({ cls: 'scrabb-card-title', text: e.name });
    const date = scrabbDate(e);
    if (date || (e.data && e.anno != null)) head.createDiv({ cls: 'scrabb-card-date', text: [date, e.anno != null ? e.data : null].filter(Boolean).join(' · ') });

    const acts = el.createDiv('scrabb-card-actions');
    const act = (icon, label, fn) => {
      const b = acts.createEl('button', { cls: 'scrabb-btn', attr: { 'aria-label': label } });
      setIcon(b.createSpan(), icon);
      b.createSpan({ text: label });
      b.addEventListener('click', fn);
    };
    act('file-text', t('Apri nota'), (evt) => this.openFile(e, evt));
    if (this.state.tab !== 'mappa') act('waypoints', t('Mappa'), () => this.openTab('mappa', e.path));
    if (e.anno != null && this.state.tab !== 'cronologia') act('calendar-range', t('Cronologia'), () => this.openTab('cronologia', e.path));
    act('pencil', t('Modifica'), () => new ScrabbEditModal(this.plugin, e).open());
    if (e.perspicacia) {
      act('library-big', t('Perspicacia'), () => this.plugin.openPerspicacia(e));
    }
    act('link', t('Collega'), () =>
      new ScrabbPickModal(this.plugin, { placeholder: t('Collega «{nome}» a…', { nome: e.name }), allowCreate: true }, async (x) => {
        if (x.create) {
          new ScrabbNewModal(this.plugin, { name: x.name, tipo: 'persona', links: [e.name] }).open();
          return;
        }
        await this.index.addToField(e, SCRABB_FIELD_FOR[x.tipo], `[[${x.name}]]`);
        new Notice(t('Collegato a {nome}', { nome: x.name }));
      }).open()
    );

    const scroll = el.createDiv('scrabb-card-scroll');
    await this.renderEntityBody(scroll, e, token, { compact: true });
  }

  /** Contenuto di una scheda: testo, versetti, modelli e illustrazioni, collegamenti, dove compare. */
  async renderEntityBody(el, e, token, opts = {}) {
    const isCurrent = () => token === this.cardToken || opts.token === 'study';
    const text = await this.app.vault.cachedRead(e.file);
    if (!isCurrent()) return;
    const body = scrabbBody(text);
    if (body) {
      const md = el.createDiv('scrabb-md markdown-rendered');
      await renderMd(this.app, body, md, e.path, this);
    } else if (!opts.hideEmpty) {
      el.createDiv({ cls: 'scrabb-empty', text: t('Scheda ancora da scrivere. Apri la nota per aggiungere i tuoi appunti.') });
    }

    if (e.refs.length) {
      const sec = this.sec(el, t('Versetti'), e.refs.length);
      for (const r of e.refs) await this.renderVerse(sec, r);
    } else if (e.versetti.length) {
      const sec = this.sec(el, t('Versetti'), e.versetti.length);
      for (const v of e.versetti) sec.createDiv({ cls: 'scrabb-verse-label', text: v });
    }
    if (!isCurrent()) return;
    if (e.fonti.length) {
      const sec = this.sec(el, t('Fonti'), e.fonti.length);
      await this.plugin.library.ensureLoaded().catch(() => null);
      for (const f of e.fonti) {
        const d = this.plugin.library.byFile && this.plugin.library.byFile.get(f.file);
        const box = sec.createDiv('scrabb-verse scrabb-fonte');
        box.createDiv({ cls: 'scrabb-verse-label', text: f.label || (d ? d.title : f.file) });
        if (d) box.createDiv({ cls: 'scrabb-fonte-pub', text: `${d.pub.title}${d.issue && d.issue !== 'altro' ? ` · ${issueLabel(d.issue)}` : ''}` });
        const txt = d && f.par ? await this.plugin.library.paragraphText(d, f.par) : '';
        if (!isCurrent()) return;
        if (txt) box.createDiv({ cls: 'scrabb-verse-text', text: txt.length > 320 ? `${txt.slice(0, 320)}…` : txt });
        if (d) box.addEventListener('click', () => this.plugin.openLibraryDoc(d, f.par));
      }
    }

    const related = this.index.related(e.path);
    const isTeacher = SCRABB_TEACHERS.includes(e.tipo);
    const usage = this.index.usageMap();
    if (!isTeacher) {
      for (const tp of SCRABB_TEACHERS) {
        const list = related.filter((r) => r.tipo === tp);
        if (!list.length) continue;
        const sec = this.sec(el, t(SCRABB_TYPES[tp].plural), list.length);
        for (const x of list) await this.renderTeachCard(sec, x, usage);
      }
    } else {
      const teachings = related.filter((r) => SCRABB_TEACHINGS.includes(r.tipo));
      if (teachings.length) {
        const sec = this.sec(el, e.tipo === 'illustrazione' ? t('Fa capire') : t('Insegna'), teachings.length);
        const chips = sec.createDiv('scrabb-chips');
        for (const p of teachings) this.chip(chips, p, { reveal: true });
      }
    }
    const groups = new Map();
    for (const r of related) {
      if (!isTeacher && SCRABB_TEACHERS.includes(r.tipo)) continue;
      if (isTeacher && SCRABB_TEACHINGS.includes(r.tipo)) continue;
      const key = r.tipo === 'periodo' ? 'evento' : r.tipo;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    for (const tipo of Object.keys(SCRABB_TYPES)) {
      const list = groups.get(tipo);
      if (!list) continue;
      const sec = this.sec(el, t(SCRABB_TYPES[tipo].plural), list.length);
      const chips = sec.createDiv('scrabb-chips');
      for (const r of list.sort((a, b) => (a.anno ?? 1e9) - (b.anno ?? 1e9) || compare(a.name, b.name))) this.chip(chips, r);
    }
    if (e.missing.length) {
      const sec = this.sec(el, t('Schede da creare'), e.missing.length);
      const chips = sec.createDiv('scrabb-chips');
      for (const m of e.missing) {
        const c = chips.createSpan({ cls: 'scrabb-chip scrabb-chip-missing', text: `+ ${m.name}` });
        const tipo = Object.keys(SCRABB_FIELD_FOR).find((k) => SCRABB_FIELD_FOR[k] === m.field) || 'tema';
        c.addEventListener('click', () => new ScrabbNewModal(this.plugin, { name: m.name, tipo, links: [e.name] }).open());
      }
    }

    // Illustrazioni: dove sono state usate (discorsi, parti), dalla più recente. Altre schede: note che le citano.
    const usable = SCRABB_USABLE.includes(e.tipo);
    const occ = usable ? usage.get(e.path) || [] : this.index.occurrences(e.path);
    if (occ.length || usable) {
      const sec = this.sec(el, usable ? t('Sentita / usata in') : t('Nelle mie note'), occ.length);
      if (!occ.length) sec.createDiv({ cls: 'scrabb-empty', text: t('Mai usata. Inseriscila in un discorso con “SCRABB: inserisci un’illustrazione…”.') });
      for (const o of occ.slice(0, 30)) {
        const lines = (await this.app.vault.cachedRead(o.file)).split('\n');
        if (!isCurrent()) return;
        const box = sec.createDiv('scrabb-occ');
        const h = box.createDiv('scrabb-occ-head');
        setIcon(h.createSpan(), o.source ? 'quote' : 'file-text');
        if (o.date) h.createSpan({ cls: 'scrabb-occ-date', text: scrabbFmtDate(o.date) });
        h.createSpan({ cls: 'scrabb-occ-name', text: o.file.basename });
        if (o.source) h.createSpan({ cls: 'scrabb-occ-folder', text: t('fonte') });
        else if (o.file.parent && o.file.parent.path !== '/') h.createSpan({ cls: 'scrabb-occ-folder', text: o.file.parent.name });
        h.addEventListener('click', (evt) => this.plugin.openNoteAt(o.file, o.lines[0] || 0, evt));
        for (const ln of o.lines.slice(0, 3)) {
          const s = box.createDiv({ cls: 'scrabb-occ-snippet', text: cleanSnippet(lines[ln] || '').slice(0, 220) || '…' });
          s.addEventListener('click', (evt) => this.plugin.openNoteAt(o.file, ln, evt));
        }
      }
    }
  }

  sec(parent, title, count) {
    const s = parent.createDiv('scrabb-sec');
    const h = s.createDiv('scrabb-sec-title');
    h.createSpan({ text: title });
    if (count) h.createSpan({ cls: 'scrabb-count', text: String(count) });
    return s.createDiv('scrabb-sec-body');
  }

  async renderVerse(parent, r) {
    const box = parent.createDiv('scrabb-verse');
    const label = box.createEl('a', { cls: 'scrabb-verse-label', text: r.label });
    label.addEventListener('click', () => this.plugin.openReader(r.ref));
    const textEl = box.createDiv('scrabb-verse-text');
    try {
      const data = await this.plugin.bible.getChapter(r.ref.book, r.ref.chapter);
      const t = r.verses.map((v) => this.plugin.bible.verseText(data, v)).join(' ');
      textEl.setText(t.length > 320 ? `${t.slice(0, 320).replace(/\s\S*$/, '')}…` : t);
    } catch (err) {
      textEl.remove();
    }
  }

  /** Riquadro di un modello o di un'illustrazione sotto un principio. */
  async renderTeachCard(parent, x, usage) {
    const card = parent.createDiv({ cls: `scrabb-example scrabb-t-${x.tipo}`, attr: { 'data-path': x.path } });
    if (x.path === this.state.sel) card.addClass('is-selected');
    const h = card.createDiv('scrabb-example-head');
    setIcon(h.createSpan('scrabb-example-icon'), SCRABB_TYPES[x.tipo].icon);
    h.createSpan({ cls: 'scrabb-example-title', text: x.name });
    if (SCRABB_USABLE.includes(x.tipo)) {
      const used = (usage || this.index.usageMap()).get(x.path) || [];
      h.createSpan({ cls: 'scrabb-usage', text: scrabbUsageText(used) });
    }
    const people = this.index.related(x.path, ['persona', 'luogo', 'evento', 'periodo']);
    if (people.length || x.refs.length) {
      const meta = card.createDiv('scrabb-example-meta');
      for (const p of people.slice(0, 5)) this.chip(meta, p);
      for (const r of x.refs.slice(0, 3)) {
        const a = meta.createEl('a', { cls: 'scrabb-ref', text: r.label });
        a.addEventListener('click', (evt) => {
          evt.stopPropagation();
          this.plugin.openReader(r.ref);
        });
      }
    }
    const body = scrabbBody(await this.app.vault.cachedRead(x.file));
    const first = body.split('\n').find((l) => l.trim() && !/^#{1,6} /.test(l));
    if (first) card.createDiv({ cls: 'scrabb-example-text', text: cleanSnippet(first.replace(/^>\s?/, '')).slice(0, 260) });
    card.addEventListener('click', (evt) => {
      if (evt.target.closest('.scrabb-chip')) return;
      if (evt.metaKey || evt.ctrlKey) this.openFile(x, evt);
      else this.select(x.path);
    });
  }

  /* ---------- Principi, modelli e illustrazioni ---------- */

  /** Gruppo di un principio nell'elenco: l'argomento (tema) a cui appartiene, altrimenti la categoria. */
  principleGroup(e) {
    const g = this.index.related(e.path, ['tema', 'qualità']).find((x) => this.index.isStrong(e.path, x.path));
    return (g && g.name) || e.categoria || t('Senza argomento');
  }

  renderStudy(el) {
    const wrap = el.createDiv('scrabb-study');
    const side = wrap.createDiv('scrabb-study-side');
    for (const [rowLabel, lists] of [[t('Studio'), SCRABB_STUDY_LISTS], [t('Bibbia'), SCRABB_BIBLE_LISTS]]) {
    side.createDiv({ cls: 'scrabb-seg-label', text: rowLabel });
    const seg = side.createDiv('scrabb-seg');
    for (const tp of lists) {
      const n = this.index.all(scrabbListTypes(tp)).length;
      const b = seg.createEl('button', { text: t(SCRABB_TYPES[tp].plural) });
      if (n) b.createSpan({ cls: 'scrabb-count', text: String(n) });
      b.toggleClass('is-active', this.state.list === tp);
      b.addEventListener('click', () => {
        this.state.list = tp;
        this.state.study = null;
        this.saveState();
        this.render();
      });
    }
    }
    const filter = side.createEl('input', { cls: 'scrabb-filter', attr: { type: 'search', placeholder: t('Filtra…') } });
    const listEl = side.createDiv('scrabb-list');
    const list = SCRABB_TYPES[this.state.list] ? scrabbListOf(this.state.list) : 'principio';
    const items = this.index.all(scrabbListTypes(list));
    const byYear = list === 'persona' || list === 'evento';
    const usage = this.index.usageMap();
    const teachCount = (e) => this.index.related(e.path, SCRABB_TEACHERS).length;
    const drawList = () => {
      listEl.empty();
      const q = scrabbFold(filter.value);
      const groups = new Map();
      for (const e of items) {
        if (q && !scrabbFold(e.name).includes(q)) continue;
        let g = e.categoria || '';
        if (byYear) g = e.corsia ? t(e.corsia) : e.anno == null ? t('Senza data') : '';
        if (list === 'principio') g = this.principleGroup(e);
        if (SCRABB_TEACHERS.includes(list)) g = (this.index.related(e.path, SCRABB_TEACHINGS)[0] || {}).name || t('Da collegare a un principio');
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(e);
      }
      for (const g of [...groups.keys()].sort((a, b) => compare(a, b))) {
        const many = items.length > 80 && !q;
        const open = !many || (this.state.openGroups || []).includes(g) || groups.get(g).some((e) => e.path === this.state.study);
        if (g && groups.size > 1) {
          const gh = listEl.createDiv({ cls: 'scrabb-list-group' + (many ? ' is-toggle' : '') });
          if (many) setIcon(gh.createSpan('scrabb-group-caret'), open ? 'chevron-down' : 'chevron-right');
          gh.createSpan({ text: g });
          if (many) {
            gh.createSpan({ cls: 'scrabb-count', text: String(groups.get(g).length) });
            gh.addEventListener('click', () => {
              const set = new Set(this.state.openGroups || []);
              if (set.has(g)) set.delete(g);
              else set.add(g);
              this.state.openGroups = [...set];
              drawList();
            });
          }
        }
        if (!open) continue;
        const sorter = byYear
          ? (a, b) => (a.anno ?? 1e9) - (b.anno ?? 1e9) || compare(a.name, b.name)
          : (a, b) => (a.ordine ?? 1e9) - (b.ordine ?? 1e9) || compare(a.name, b.name);
        for (const e of groups.get(g).sort(sorter)) {
          const row = listEl.createDiv({ cls: `scrabb-list-item scrabb-t-${e.tipo}`, attr: { 'data-study': e.path } });
          row.toggleClass('is-active', e.path === this.state.study);
          row.createSpan('scrabb-dot');
          row.createSpan({ cls: 'scrabb-list-name', text: e.name });
          if (byYear && e.anno != null) row.createSpan({ cls: 'scrabb-usage', text: scrabbYear(e.anno) });
          else if (SCRABB_USABLE.includes(list)) {
            const used = usage.get(e.path) || [];
            row.createSpan({ cls: 'scrabb-usage', text: used.length ? scrabbFmtDate(used[0].date) || `${used.length}×` : t('nuova') });
          } else if (list === 'situazione') {
            const n = this.index.related(e.path, ['principio']).length;
            if (n) row.createSpan({ cls: 'scrabb-count', text: String(n) });
          } else if (list !== 'modello') {
            const n = teachCount(e);
            if (n) row.createSpan({ cls: 'scrabb-count', text: String(n) });
          }
          row.addEventListener('click', () => {
            this.state.study = e.path;
            this.saveState();
            this.render();
          });
        }
      }
      if (!listEl.childElementCount) listEl.createDiv({ cls: 'scrabb-empty', text: t('Nessuna scheda.') });
    };
    filter.addEventListener('input', drawList);
    drawList();
    const add = side.createEl('button', { cls: 'scrabb-btn scrabb-add', text: `+ ${t(SCRABB_TYPES[list].label)}` });
    add.addEventListener('click', () => new ScrabbNewModal(this.plugin, { tipo: list }, (f) => this.selectWhenIndexed(f.path)).open());

    const detail = wrap.createDiv('scrabb-study-detail');
    const e = this.state.study && this.index.get(this.state.study);
    if (!e) {
      const intro = detail.createDiv('scrabb-intro');
      intro.createEl('h2', { text: t(SCRABB_TYPES[list].plural) });
      intro.createEl('p', { text: t(SCRABB_INTRO[list] || SCRABB_INTRO.principio) });
      return;
    }
    this.renderStudyDetail(detail, e);
  }

  async renderStudyDetail(el, e) {
    const head = el.createDiv(`scrabb-study-head scrabb-t-${e.tipo}`);
    const type = head.createDiv('scrabb-card-type');
    setIcon(type.createSpan(), SCRABB_TYPES[e.tipo].icon);
    type.createSpan({ text: [t(SCRABB_TYPES[e.tipo].label), e.categoria].filter(Boolean).join(' · ') });
    const title = head.createEl('h2', { text: e.name });
    title.addEventListener('click', (evt) => this.openFile(e, evt));
    if (e.domanda) head.createDiv({ cls: 'scrabb-domanda', text: e.domanda });
    const acts = head.createDiv('scrabb-card-actions');
    const btn = (icon, label, fn, cta) => {
      const b = acts.createEl('button', { cls: `scrabb-btn${cta ? ' mod-cta' : ''}` });
      setIcon(b.createSpan(), icon);
      b.createSpan({ text: label });
      b.addEventListener('click', fn);
    };
    const isTeacher = SCRABB_TEACHERS.includes(e.tipo) || e.tipo === 'situazione';
    if (!isTeacher) {
      btn(SCRABB_TYPES.modello.icon, t('Aggiungi modello'), () => new ScrabbNewModal(this.plugin, { tipo: 'modello', links: [e.name] }, (f) => this.select(f.path)).open(), true);
      btn(SCRABB_TYPES.illustrazione.icon, t('Aggiungi illustrazione'), () => new ScrabbNewModal(this.plugin, { tipo: 'illustrazione', links: [e.name] }, (f) => this.select(f.path)).open(), true);
      btn(SCRABB_TYPES.esperienza.icon, t('Aggiungi esperienza'), () => new ScrabbNewModal(this.plugin, { tipo: 'esperienza', links: [e.name] }, (f) => this.select(f.path)).open());
    }
    btn('file-text', t('Apri nota'), (evt) => this.openFile(e, evt));
    btn('waypoints', t('Mappa'), () => this.openTab('mappa', e.path));
    if (e.anno != null) btn('calendar-range', t('Cronologia'), () => this.openTab('cronologia', e.path));
    btn('pencil', t('Modifica'), () => new ScrabbEditModal(this.plugin, e).open());
    if (e.perspicacia) btn('library-big', t('Perspicacia'), () => this.plugin.openPerspicacia(e));
    const body = el.createDiv('scrabb-study-body');
    await this.renderEntityBody(body, e, null, { token: 'study' });
    if (!isTeacher && !this.index.related(e.path, SCRABB_TEACHERS).length) {
      body.createDiv({ cls: 'scrabb-empty', text: t('Nessun modello o illustrazione ancora. Aggiungi un racconto biblico da imitare, oppure un paragone che faccia capire il concetto.') });
    }
  }

  /* ---------- Cronologia ---------- */

  laneOf(e) {
    if (e.corsia) return e.corsia;
    if (e.tipo === 'evento' || e.tipo === 'periodo') return 'Eventi';
    if (e.tipo === 'persona') return 'Personaggi';
    return 'Altro';
  }

  renderTimeline(el) {
    const all = this.index.all();
    const dated = all.filter((e) => e.anno != null);
    const future = all.filter((e) => e.anno == null && /futur/i.test(String(e.data || '')));
    const hidden = new Set(this.state.hidden);

    const bar = el.createDiv('scrabb-tl-bar');
    const zoom = (f) => this.zoomTimeline(f);
    const zb = (icon, label, fn) => {
      const b = bar.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': label } });
      setIcon(b, icon);
      b.addEventListener('click', fn);
    };
    zb('zoom-out', t('Riduci'), () => zoom(1 / 1.6));
    zb('zoom-in', t('Ingrandisci'), () => zoom(1.6));
    zb('maximize-2', t('Mostra tutto'), () => {
      this.state.ppy = 0;
      this.saveState();
      this.render();
    });
    const eras = bar.createDiv('scrabb-tl-eras');
    for (const [label, y] of SCRABB_ERAS) {
      const b = eras.createEl('button', { cls: 'scrabb-era', text: t(label) });
      b.addEventListener('click', () => this.scrollTimelineToYear(y, true));
    }

    const lanesPresent = [...new Set(dated.map((e) => this.laneOf(e)))];
    lanesPresent.sort((a, b) => (SCRABB_LANES.indexOf(a) + 1 || 99) - (SCRABB_LANES.indexOf(b) + 1 || 99));
    const toggles = el.createDiv('scrabb-tl-lanes');
    for (const lane of lanesPresent) {
      const c = toggles.createEl('button', { cls: 'scrabb-lane-toggle', text: t(lane) });
      c.toggleClass('is-off', hidden.has(lane));
      c.addEventListener('click', () => {
        if (hidden.has(lane)) hidden.delete(lane);
        else hidden.add(lane);
        this.state.hidden = [...hidden];
        this.saveState();
        this.render();
      });
    }

    const scroller = el.createDiv('scrabb-tl');
    this.tlScroller = scroller;
    if (!dated.length) {
      scroller.createDiv({ cls: 'scrabb-empty', text: t('Nessuna scheda con data. Apri un personaggio o un evento e tocca «Modifica».') });
      return;
    }
    const minY = Math.floor((Math.min(...dated.map((e) => e.anno)) - 80) / 100) * 100;
    const ancientMax = Math.max(...dated.filter((e) => e.anno < 1000).map((e) => e.fine ?? e.anno), 100) + 40;
    const modern = dated.filter((e) => e.anno >= 1000);
    const modernStart = modern.length ? Math.floor((Math.min(...modern.map((e) => e.anno)) - 20) / 10) * 10 : null;
    const modernEnd = modern.length ? Math.max(...modern.map((e) => e.fine ?? e.anno)) + 40 : null;
    const GAP = 70;
    const PAD = 24;
    const width = Math.max(scroller.clientWidth || this.mainEl.clientWidth || 800, 400);
    const span = ancientMax - minY + (modern.length ? modernEnd - modernStart : 0);
    const fit = (width - PAD * 2 - (modern.length ? GAP : 0) - (future.length ? 120 : 0)) / span;
    const ppy = this.state.ppy || fit;
    this.tlPpy = ppy;
    this.tlFit = fit;
    const x = (y) => {
      if (y <= ancientMax || !modern.length) return PAD + (Math.min(y, ancientMax) - minY) * ppy;
      return PAD + (ancientMax - minY) * ppy + GAP + (Math.max(y, modernStart) - modernStart) * ppy;
    };
    const xInv = (px) => {
      const a = PAD + (ancientMax - minY) * ppy;
      if (px <= a || !modern.length) return (px - PAD) / ppy + minY;
      return Math.max(modernStart, (px - a - GAP) / ppy + modernStart);
    };
    this.tlX = x;
    this.tlXInv = xInv;
    const endX = modern.length ? x(modernEnd) : x(ancientMax);
    const totalW = endX + (future.length ? 140 : 0) + PAD;
    const canvas = scroller.createDiv('scrabb-tl-canvas');
    canvas.style.width = `${totalW}px`;

    // Asse degli anni
    const axis = canvas.createDiv('scrabb-tl-axis');
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((s) => s * ppy >= 70) || 1000;
    const tick = (y) => {
      const tk = axis.createDiv('scrabb-tl-tick');
      tk.style.left = `${x(y)}px`;
      tk.setText(y === 0 ? '' : y < 0 ? `${-y}` : t('{n} E.V.', { n: y }));
    };
    for (let y = Math.ceil(minY / step) * step; y <= ancientMax; y += step) if (y !== 0) tick(y);
    if (modern.length) {
      const brk = axis.createDiv('scrabb-tl-break');
      brk.style.left = `${x(ancientMax) + 4}px`;
      brk.style.width = `${GAP - 8}px`;
      brk.setText('⋯');
      const mStep = Math.max(step, 10);
      const mTicks = [];
      for (let y = Math.ceil(modernStart / mStep) * mStep; y <= modernEnd; y += mStep) mTicks.push(y);
      if (!mTicks.length) modern.forEach((e) => mTicks.push(e.anno));
      [...new Set(mTicks)].forEach(tick);
    }
    const ad = axis.createDiv('scrabb-tl-era-mark');
    ad.style.left = `${x(0)}px`;
    ad.setText(t('a.E.V. | E.V.'));
    if (future.length) {
      const f = axis.createDiv('scrabb-tl-tick scrabb-tl-future');
      f.style.left = `${endX + 40}px`;
      f.setText(t('Futuro'));
    }

    const ROW = 26;
    for (const lane of lanesPresent) {
      if (hidden.has(lane)) continue;
      const items = dated.filter((e) => this.laneOf(e) === lane).sort((a, b) => a.anno - b.anno || (b.fine ?? b.anno) - (a.fine ?? a.anno));
      if (lane === 'Eventi') items.push(...future);
      const laneEl = canvas.createDiv('scrabb-tl-lane');
      laneEl.createDiv({ cls: 'scrabb-tl-lane-label', text: t(lane) });
      const rowsEnd = [];
      const area = laneEl.createDiv('scrabb-tl-items');
      for (const e of items) {
        const isFuture = e.anno == null;
        const x0 = isFuture ? endX + 40 : x(e.anno);
        const x1 = isFuture ? x0 : x(e.fine ?? e.anno);
        const barW = Math.max(x1 - x0, 0);
        const textW = e.name.length * 6.6 + 18;
        const occupied = Math.max(barW, textW) + 6;
        let row = rowsEnd.findIndex((end) => end <= x0);
        if (row < 0) {
          row = rowsEnd.length;
          rowsEnd.push(0);
        }
        rowsEnd[row] = x0 + occupied;
        const it = area.createDiv({ cls: `scrabb-tl-item scrabb-t-${e.tipo}`, attr: { 'data-path': e.path, 'aria-label': `${e.name} · ${scrabbDate(e) || e.data || ''}` } });
        if (e.path === this.state.sel) it.addClass('is-selected');
        if (e.approx) it.addClass('is-approx');
        it.style.left = `${x0}px`;
        it.style.top = `${row * ROW}px`;
        if (barW >= 4) {
          const b = it.createDiv('scrabb-tl-bar-fill');
          b.style.width = `${barW}px`;
        } else it.createDiv('scrabb-tl-point');
        it.createSpan({ cls: 'scrabb-tl-label', text: e.name });
        it.addEventListener('click', (evt) => (evt.metaKey || evt.ctrlKey ? this.openFile(e, evt) : this.select(e.path)));
      }
      area.style.height = `${Math.max(1, rowsEnd.length) * ROW + 6}px`;
    }

    const undated = all.filter((e) => e.anno == null && !future.includes(e) && ['persona', 'evento', 'periodo'].includes(e.tipo));
    if (undated.length) {
      const u = el.createDiv('scrabb-tl-undated');
      u.createSpan({ cls: 'scrabb-muted', text: t('Senza data ({n}): ', { n: undated.length }) });
      for (const e of undated.slice(0, 40)) this.chip(u, e);
    }

    // Zoom con pizzico / ctrl+rotella, mantenendo fermo l'anno sotto il puntatore.
    scroller.addEventListener(
      'wheel',
      (evt) => {
        if (!evt.ctrlKey && !evt.metaKey) return;
        evt.preventDefault();
        const rect = scroller.getBoundingClientRect();
        this.zoomTimeline(Math.exp(-evt.deltaY * 0.012), evt.clientX - rect.left);
      },
      { passive: false }
    );
    // Trascinamento col mouse per scorrere.
    scroller.addEventListener('pointerdown', (evt) => {
      if (evt.pointerType !== 'mouse' || evt.button !== 0 || evt.target.closest('.scrabb-tl-item')) return;
      this.tlDrag = { el: scroller, x: evt.clientX, y: evt.clientY, l: scroller.scrollLeft, t: scroller.scrollTop };
      scroller.addClass('is-dragging');
    });

    if (this.tlCenterYear != null) {
      const y = this.tlCenterYear;
      this.tlCenterYear = null;
      window.requestAnimationFrame(() => this.scrollTimelineToYear(y, false, this.tlCenterAt));
    } else if (this.tlScrollLeft != null) {
      const l = this.tlScrollLeft;
      window.requestAnimationFrame(() => (scroller.scrollLeft = l));
    }
    scroller.addEventListener('scroll', () => (this.tlScrollLeft = scroller.scrollLeft));
  }

  zoomTimeline(factor, anchorPx) {
    const sc = this.tlScroller;
    if (!sc || !this.tlXInv) return;
    const at = anchorPx ?? sc.clientWidth / 2;
    this.tlCenterYear = this.tlXInv(sc.scrollLeft + at);
    this.tlCenterAt = at;
    this.state.ppy = Math.max(this.tlFit, Math.min(60, (this.tlPpy || this.tlFit) * factor));
    this.saveState();
    if (!this.zoomRaf) {
      this.zoomRaf = window.requestAnimationFrame(() => {
        this.zoomRaf = null;
        this.render();
      });
    }
  }

  scrollTimelineToYear(y, smooth, at) {
    const sc = this.tlScroller;
    if (!sc || !this.tlX) return;
    const left = this.tlX(y) - (at ?? sc.clientWidth / 2);
    sc.scrollTo({ left: Math.max(0, left), behavior: smooth ? 'smooth' : 'auto' });
  }

  scrollTimelineTo(e) {
    if (!e || e.anno == null) return;
    window.requestAnimationFrame(() => {
      if (this.tlPpy && this.tlPpy < 1.5) {
        this.state.ppy = 3;
        this.tlCenterYear = e.anno;
        this.render();
      } else this.scrollTimelineToYear(e.anno, true);
      const it = this.mainEl.querySelector(`.scrabb-tl-item[data-path="${CSS.escape(e.path)}"]`);
      if (it) it.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  /* ---------- Mappa delle relazioni ---------- */

  renderGraph(el) {
    const idx = this.index;
    let focus = this.state.focus && idx.get(this.state.focus);
    if (!focus) focus = idx.byName('Gesù') || idx.all(['principio'])[0] || idx.all()[0];
    if (!focus) {
      el.createDiv({ cls: 'scrabb-empty', text: t('Nessuna scheda.') });
      return;
    }
    this.state.focus = focus.path;
    const hidden = new Set(this.state.hiddenTypes || []);

    const bar = el.createDiv('scrabb-tl-bar');
    const f = bar.createDiv('scrabb-graph-focus');
    f.createSpan({ cls: 'scrabb-muted', text: t('Centro: ') });
    this.chip(f, focus, { static: true }).addEventListener('click', () => new ScrabbPickModal(this.plugin, {}, (e) => this.openTab('mappa', e.path)).open());
    const seg = bar.createDiv('scrabb-seg scrabb-seg-small');
    for (const [d, label] of [[1, t('Vicini')], [2, t('2 livelli')], [9, t('Tutta la rete')]]) {
      const b = seg.createEl('button', { text: label });
      b.toggleClass('is-active', this.state.depth === d);
      b.addEventListener('click', () => {
        this.state.depth = d;
        this.saveState();
        this.render();
      });
    }
    const types = bar.createDiv('scrabb-graph-types');
    for (const tp of Object.keys(SCRABB_TYPES)) {
      if (tp === 'periodo') continue;
      const c = types.createEl('button', { cls: `scrabb-lane-toggle scrabb-t-${tp}` });
      c.createSpan('scrabb-dot');
      c.createSpan({ text: t(SCRABB_TYPES[tp].plural) });
      c.toggleClass('is-off', hidden.has(tp));
      c.addEventListener('click', () => {
        if (hidden.has(tp)) hidden.delete(tp);
        else hidden.add(tp);
        this.state.hiddenTypes = [...hidden];
        this.render();
      });
    }

    // Nodi: visita in ampiezza dal centro.
    const visible = (e) => e.path === focus.path || !hidden.has(e.tipo === 'periodo' ? 'evento' : e.tipo);
    const dist = new Map([[focus.path, 0]]);
    const queue = [focus.path];
    while (queue.length) {
      const p = queue.shift();
      if (dist.get(p) >= this.state.depth) continue;
      for (const q of (idx.rel.get(p) || new Map()).keys()) {
        const e = idx.get(q);
        if (!e || dist.has(q) || !visible(e)) continue;
        dist.set(q, dist.get(p) + 1);
        queue.push(q);
      }
    }
    let paths = [...dist.keys()];
    if (paths.length > 220) paths = paths.sort((a, b) => dist.get(a) - dist.get(b)).slice(0, 220);
    const set = new Set(paths);
    const W = Math.max(el.clientWidth, 400);
    const H = Math.max(el.clientHeight - 60, 360);
    const nodes = paths.map((p, i) => {
      const a = (i / paths.length) * Math.PI * 2;
      const r = p === focus.path ? 0 : 60 + dist.get(p) * 90 + Math.random() * 30;
      return { e: idx.get(p), x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, d: dist.get(p), deg: (idx.rel.get(p) || new Map()).size };
    });
    const byPath = new Map(nodes.map((n) => [n.e.path, n]));
    const edges = [];
    for (const n of nodes) {
      for (const [q, strong] of idx.rel.get(n.e.path) || []) {
        if (set.has(q) && n.e.path < q) edges.push({ a: n, b: byPath.get(q), strong });
      }
    }
    const fixed = byPath.get(focus.path);
    fixed.fx = 0;
    fixed.fy = 0;

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.classList.add('scrabb-graph');
    el.appendChild(svg);
    const view = { x: -W / 2, y: -H / 2, w: W, h: H };
    const setView = () => svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    setView();
    const gEdges = document.createElementNS(NS, 'g');
    const gNodes = document.createElementNS(NS, 'g');
    svg.append(gEdges, gNodes);
    for (const ed of edges) {
      ed.el = document.createElementNS(NS, 'line');
      ed.el.setAttribute('class', `scrabb-edge${ed.strong ? '' : ' is-weak'}`);
      gEdges.appendChild(ed.el);
    }
    const showAll = nodes.length <= 70;
    for (const n of nodes) {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', `scrabb-node scrabb-t-${n.e.tipo}${n === fixed ? ' is-focus' : ''}${n.e.path === this.state.sel ? ' is-selected' : ''}${showAll || n.d <= 1 ? ' has-label' : ''}`);
      g.dataset.path = n.e.path;
      const c = document.createElementNS(NS, 'circle');
      n.r = n === fixed ? 15 : 5 + Math.min(9, Math.sqrt(n.deg) * 1.8);
      c.setAttribute('r', n.r);
      const lbl = document.createElementNS(NS, 'text');
      lbl.textContent = n.e.name;
      lbl.setAttribute('y', n.r + 12);
      const title = document.createElementNS(NS, 'title');
      title.textContent = `${n.e.name} · ${t(SCRABB_TYPES[n.e.tipo].label)}${scrabbDate(n.e) ? ' · ' + scrabbDate(n.e) : ''}`;
      g.append(c, lbl, title);
      gNodes.appendChild(g);
      n.el = g;
    }

    const draw = () => {
      for (const ed of edges) {
        ed.el.setAttribute('x1', ed.a.x);
        ed.el.setAttribute('y1', ed.a.y);
        ed.el.setAttribute('x2', ed.b.x);
        ed.el.setAttribute('y2', ed.b.y);
      }
      for (const n of nodes) n.el.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
    };
    let alpha = 1;
    const step = () => {
      const N = nodes.length;
      for (let i = 0; i < N; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < N; j++) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d2 = 0.25;
          }
          if (d2 > 160000) continue;
          const f = (2600 * alpha) / d2;
          const d = Math.sqrt(d2);
          a.vx += (dx / d) * f;
          a.vy += (dy / d) * f;
          b.vx -= (dx / d) * f;
          b.vy -= (dy / d) * f;
        }
      }
      for (const ed of edges) {
        const dx = ed.b.x - ed.a.x;
        const dy = ed.b.y - ed.a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const L = ed.a === fixed || ed.b === fixed ? 120 : 80;
        const k = ((d - L) / d) * 0.06 * alpha * (ed.strong ? 1 : 0.5);
        ed.a.vx += dx * k;
        ed.a.vy += dy * k;
        ed.b.vx -= dx * k;
        ed.b.vy -= dy * k;
      }
      for (const n of nodes) {
        n.vx -= n.x * 0.004 * alpha;
        n.vy -= n.y * 0.004 * alpha;
        n.vx *= 0.6;
        n.vy *= 0.6;
        if (n.fx != null) {
          n.x = n.fx;
          n.y = n.fy;
          n.vx = n.vy = 0;
        } else {
          n.x += Math.max(-30, Math.min(30, n.vx));
          n.y += Math.max(-30, Math.min(30, n.vy));
        }
      }
    };
    // Prima disposizione calcolata subito, poi una breve animazione di assestamento.
    for (let i = 0; i < 120; i++) step();
    alpha = 0.5;
    const animate = () => {
      step();
      draw();
      alpha *= 0.985;
      this.sim = alpha > 0.02 ? requestAnimationFrame(animate) : null;
    };
    const kick = () => {
      alpha = Math.max(alpha, 0.3);
      if (!this.sim) this.sim = requestAnimationFrame(animate);
    };
    draw();
    this.sim = requestAnimationFrame(animate);

    // Interazione: trascina i nodi, sposta e ingrandisci la mappa.
    const toSvg = (evt) => {
      const r = svg.getBoundingClientRect();
      return { x: view.x + ((evt.clientX - r.left) / r.width) * view.w, y: view.y + ((evt.clientY - r.top) / r.height) * view.h };
    };
    let dragNode = null;
    let pan = null;
    let moved = false;
    svg.addEventListener('pointerdown', (evt) => {
      const g = evt.target.closest('.scrabb-node');
      moved = false;
      svg.setPointerCapture(evt.pointerId);
      if (g) {
        dragNode = byPath.get(g.dataset.path);
        dragNode.wasFixed = dragNode.fx != null;
      } else pan = { x: evt.clientX, y: evt.clientY, vx: view.x, vy: view.y };
    });
    svg.addEventListener('pointermove', (evt) => {
      if (dragNode) {
        const p = toSvg(evt);
        if (Math.abs(p.x - dragNode.x) + Math.abs(p.y - dragNode.y) > 2) moved = true;
        dragNode.fx = p.x;
        dragNode.fy = p.y;
        kick();
      } else if (pan) {
        const r = svg.getBoundingClientRect();
        view.x = pan.vx - ((evt.clientX - pan.x) / r.width) * view.w;
        view.y = pan.vy - ((evt.clientY - pan.y) / r.height) * view.h;
        moved = true;
        setView();
      } else {
        const g = evt.target.closest('.scrabb-node');
        this.highlightGraph(gNodes, edges, g ? g.dataset.path : null);
      }
    });
    svg.addEventListener('pointerup', (evt) => {
      if (dragNode) {
        const n = dragNode;
        dragNode = null;
        if (!moved) {
          if (!n.wasFixed || n !== fixed) {
            n.fx = n.wasFixed ? n.fx : null;
            n.fy = n.wasFixed ? n.fy : null;
          }
          // Doppio tocco/clic (rilevato qui: con la cattura del puntatore "dblclick" non arriva al nodo).
          const now = Date.now();
          const dbl = this.lastTap && this.lastTap.path === n.e.path && now - this.lastTap.t < 350;
          this.lastTap = { path: n.e.path, t: now };
          if (dbl) return this.openTab('mappa', n.e.path);
          if (evt.metaKey || evt.ctrlKey) this.openFile(n.e, evt);
          else this.select(n.e.path);
          gNodes.querySelectorAll('.scrabb-node').forEach((x) => x.classList.toggle('is-selected', x.dataset.path === n.e.path));
        }
      }
      pan = null;
    });
    svg.addEventListener(
      'wheel',
      (evt) => {
        evt.preventDefault();
        const p = toSvg(evt);
        const k = Math.exp(evt.deltaY * (evt.ctrlKey ? 0.01 : 0.002));
        const nw = Math.max(150, Math.min(6000, view.w * k));
        const s = nw / view.w;
        view.x = p.x - (p.x - view.x) * s;
        view.y = p.y - (p.y - view.y) * s;
        view.w = nw;
        view.h *= s;
        setView();
      },
      { passive: false }
    );
    el.createDiv({ cls: 'scrabb-graph-hint', text: t('Clic: scheda · doppio clic: metti al centro · trascina: sposta · ⌘-clic: apri la nota') });
  }

  highlightGraph(gNodes, edges, path) {
    const near = new Set(path ? [path, ...(this.index.rel.get(path) || new Map()).keys()] : []);
    gNodes.querySelectorAll('.scrabb-node').forEach((g) => {
      g.classList.toggle('is-dim', !!path && !near.has(g.dataset.path));
      g.classList.toggle('is-hover', !!path && near.has(g.dataset.path));
    });
    for (const ed of edges) ed.el.classList.toggle('is-hot', !!path && (ed.a.e.path === path || ed.b.e.path === path));
  }
}

/** Collega un versetto (etichetta "Giovanni 3:16") a una scheda SCRABB, esistente o nuova; poi `refresh`. */
function linkVerseToScrabb(plugin, label, refresh) {
  new ScrabbPickModal(plugin, { placeholder: t('Collega {ref} a…', { ref: label }), allowCreate: true }, async (e) => {
    if (e.create) {
      new ScrabbNewModal(plugin, { name: e.name, tipo: 'modello', versetti: label }, () => window.setTimeout(refresh, 1500)).open();
      return;
    }
    await plugin.scrabb.addToField(e, 'versetti', label);
    new Notice(t('{ref} collegato a {nome}', { ref: label, nome: e.name }));
    window.setTimeout(refresh, 1500);
  }).open();
}

export { ScrabbSuggest, ScrabbPickModal, ScrabbNewModal, ScrabbEditModal, ScrabbView, linkVerseToScrabb };
