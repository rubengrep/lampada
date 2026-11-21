import { PluginSettingTab, Setting, Notice } from 'obsidian';
import { DEFAULT_SETTINGS, PANE_SECTIONS, paneOrder } from './costanti.js';
import { JwlExportModal } from './jwl-esporta.js';
import { JwlImportModal } from './jwl-importa.js';
import { AI_DEFAULT_MODEL, openRouter, parsePresets } from './studio.js';

/* ------------------------------------------------------------------ */
/* Impostazioni                                                        */
/* ------------------------------------------------------------------ */

class BibleSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();
    containerEl.addClass('lmp-settings');
    const toggle = (name, desc, get, set) =>
      new Setting(containerEl).setName(name).setDesc(desc).addToggle((t) => t.setValue(get()).onChange(set));
    const text = (name, desc, key, { placeholder = DEFAULT_SETTINGS[key], clean = (v) => v.trim(), after } = {}) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) =>
        t.setPlaceholder(placeholder || '').setValue(s[key] || '').onChange(async (v) => {
          s[key] = clean(v);
          await (after ? after() : this.plugin.saveAll(false));
        })
      );
    const folder = (v) => v.trim().replace(/\/+$/, '');
    // I segni nel testo cambiano subito: il capitolo aperto si ridisegna.
    const redraw = async () => {
      await this.plugin.settingsChanged();
      for (const view of this.plugin.views()) {
        if (view.state.mode !== 'reader') continue;
        view.chapterData = null;
        view.navigate({ ...view.getState() }, { push: false });
      }
    };

    /* ---------- App ---------- */
    new Setting(containerEl).setName('Lampada come app').setHeading();
    toggle('Vista unica', 'Bibbia, Biblioteca, SCRABB e Chiedi in una sola scheda, con un solo Indietro. Le icone nella barra di sinistra cambiano al prossimo avvio.', () => s.appShell !== false, async (v) => {
      s.appShell = v;
      await this.plugin.saveAll(false);
      this.plugin.applyAppMode();
      this.display();
    });
    toggle('Modalità app', 'Mentre usi Lampada nasconde le barre di Obsidian. Tornano quando apri una nota o con il pulsante ⤢.', () => !!this.plugin.ui.appMode, (v) => this.plugin.toggleAppMode(v));
    if (s.appShell === false) {
      new Setting(containerEl)
        .setName('Posizione del lettore')
        .setDesc('Dove si apre la Bibbia. Si può spostare anche dal menu ⋯ del lettore.')
        .addDropdown((d) =>
          d.addOptions({ tab: 'Scheda normale', left: 'Barra laterale sinistra', right: 'Barra laterale destra' }).setValue(s.readerLocation).onChange(async (v) => {
            s.readerLocation = v;
            await this.plugin.settingsChanged();
          })
        );
      toggle('Scheda Bibbia nella barra laterale sinistra', 'Una scheda fissa accanto a File, Cerca e Segnalibri.', () => s.leftTab, async (v) => {
        s.leftTab = v;
        await this.plugin.settingsChanged();
        await this.plugin.ensureLeftTab();
      });
    }

    /* ---------- Lettura ---------- */
    new Setting(containerEl).setName('Lettura').setHeading();
    new Setting(containerEl).setDesc('Carattere, dimensione, interlinea, tema e pagine si regolano dal pannello Aa del lettore.');
    toggle('Nascondi le barre mentre scorri', 'Tablet e telefono. Spegnilo se lo scorrimento ti sembra a scatti.', () => s.autoHideBars !== false, async (v) => {
      s.autoHideBars = v;
      await this.plugin.saveAll(false);
    });
    toggle('Mostra i riferimenti (+)', 'Un "+" nel testo: toccalo per vedere i riferimenti.', () => s.showRefMarkers, async (v) => {
      s.showRefMarkers = v;
      await redraw();
    });
    if ((this.plugin.bible?.books || []).some((b) => b.versesFile)) {
      toggle('Indica i versetti con approfondimenti', 'Un puntino accanto al numero del versetto.', () => s.showStudyMarkers, async (v) => {
        s.showStudyMarkers = v;
        await this.plugin.settingsChanged();
      });
    }
    toggle('Segna i versetti più citati', 'Un segno nel margine accanto ai versetti citati molto più spesso degli altri.', () => this.plugin.ui.citeHeat !== false, (v) => {
      this.plugin.ui.citeHeat = v;
      this.plugin.requestSave();
      for (const view of this.plugin.views()) view.layoutCiteHeat();
    });
    toggle('Segna i versetti citati nelle tue note', 'Il numero del versetto viene sottolineato.', () => s.showCiteMarkers, async (v) => {
      s.showCiteMarkers = v;
      await this.plugin.settingsChanged();
    });

    /* ---------- Pannello del versetto: ordine delle sezioni ---------- */
    new Setting(containerEl).setName('Pannello del versetto').setHeading();
    new Setting(containerEl).setDesc('Ordine delle sezioni quando tocchi un versetto. Le schede in alto seguono lo stesso ordine.');
    const names = new Map(PANE_SECTIONS);
    const order = paneOrder(s);
    const move = async (i, d) => {
      [order[i], order[i + d]] = [order[i + d], order[i]];
      s.paneOrder = order;
      await this.plugin.saveAll(false);
      for (const view of this.plugin.views()) if (view.state.mode === 'reader' && view.paneVisible) view.renderPane();
      this.display();
    };
    order.forEach((t, i) =>
      new Setting(containerEl)
        .setName(`${i + 1}. ${names.get(t)}`)
        .setClass('lmp-order-row')
        .addExtraButton((b) => b.setIcon('arrow-up').setTooltip('Più su').setDisabled(i === 0).onClick(() => i > 0 && move(i, -1)))
        .addExtraButton((b) => b.setIcon('arrow-down').setTooltip('Più giù').setDisabled(i === order.length - 1).onClick(() => i < order.length - 1 && move(i, 1)))
    );
    if (s.paneOrder)
      new Setting(containerEl).addButton((b) => b.setButtonText('Ordine predefinito').onClick(async () => {
        delete s.paneOrder;
        await this.plugin.saveAll(false);
        this.display();
      }));

    /* ---------- Riferimenti nelle note ---------- */
    new Setting(containerEl).setName('Riferimenti nelle note').setHeading();
    new Setting(containerEl)
      .setName('Clic su un riferimento biblico')
      .setDesc('Con ⌘/Ctrl-clic ottieni l’altra azione.')
      .addDropdown((d) =>
        d.addOptions({ reader: 'Apri in Lampada', jwlibrary: 'Apri in JW Library' }).setValue(s.clickAction === 'jwlibrary' ? 'jwlibrary' : 'reader').onChange(async (v) => {
          s.clickAction = v;
          await this.plugin.settingsChanged();
        })
      );
    toggle('Anteprima al passaggio del mouse', 'Mostra il testo del versetto.', () => s.hoverPreview, async (v) => {
      s.hoverPreview = v;
      await this.plugin.settingsChanged();
    });
    toggle('Riconosci i riferimenti scritti a mano', '“Gv 3:16” o “Salmo 23:1-4” anche come testo semplice (le abbreviazioni brevi con la maiuscola).', () => s.detectPlainRefs, async (v) => {
      s.detectPlainRefs = v;
      await this.plugin.settingsChanged(false, true);
    });
    text('Prefisso per inserire versetti', 'Es. @gv 3:16 inserisce link o citazione. Vuoto = disattivato.', 'suggestTrigger', { after: () => this.plugin.settingsChanged() });
    toggle('Nome del libro per esteso', '“Giovanni 3:16” invece di “Gv 3:16” nei link creati.', () => s.expandBookName, async (v) => {
      s.expandBookName = v;
      await this.plugin.settingsChanged();
    });
    toggle('Apri il versetto dopo averlo citato', 'Si apre anche nel lettore; il cursore resta nella nota.', () => s.openAfterCite, async (v) => {
      s.openAfterCite = v;
      await this.plugin.saveAll(false);
    });
    new Setting(containerEl)
      .setClass('lmp-setting-wide')
      .setName('Modello di inserimento')
      .setDesc('Testo inserito con "Inserisci nella nota". Variabili: {{link}}, {{ref}}, {{text}}.')
      .addTextArea((t) => {
        t.setValue(s.insertTemplate).onChange(async (v) => {
          s.insertTemplate = v;
          await this.plugin.settingsChanged();
        });
        t.inputEl.rows = 3;
        t.inputEl.addClass('lmp-template-input');
      });

    /* ---------- SCRABB ---------- */
    new Setting(containerEl).setName('SCRABB').setHeading();
    text('Cartella delle schede', 'Dove vengono create le nuove schede (una sottocartella per tipo). Le schede sono riconosciute ovunque dal campo “tipo”.', 'scrabbFolder', { clean: folder });
    text('Attivatore', 'Mentre scrivi, questo più qualche lettera (es. ++umil) collega una scheda. Vuoto = disattivato.', 'scrabbTrigger');

    /* ---------- Intelligenza artificiale ---------- */
    new Setting(containerEl).setName('Intelligenza artificiale').setHeading();
    new Setting(containerEl)
      .setName('Chiave OpenRouter')
      .setDesc('Facoltativa, per la lampadina e Chiedi. Resta su questo dispositivo.')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('sk-or-…').setValue(s.openrouterKey || '').onChange(async (v) => {
          s.openrouterKey = v.trim();
          await this.plugin.saveAll(false);
        });
      });
    text('Modello', `Nome su openrouter.ai/models. Vuoto = ${AI_DEFAULT_MODEL}.`, 'aiModel', { placeholder: AI_DEFAULT_MODEL }).addButton((b) =>
      b.setButtonText('Prova').onClick(async () => {
        b.setDisabled(true);
        try {
          const json = await openRouter(this.plugin, { messages: [{ role: 'user', content: 'Rispondi solo: ok' }], max_tokens: 5 });
          new Notice(`Funziona: ${json.model || 'modello pronto'}`);
        } catch (e) {
          new Notice(e.message);
        }
        b.setDisabled(false);
      })
    );
    new Setting(containerEl)
      .setClass('lmp-setting-wide')
      .setName('Istruzioni personali')
      .setDesc('Valgono per tutte le risposte: spunti, domande e Chiedi. Es. "Frasi brevi e parole semplici, ho 14 anni".')
      .addTextArea((t) => {
        t.setValue(s.aiInstructions || '').onChange(async (v) => {
          s.aiInstructions = v;
          await this.plugin.saveAll(false);
        });
        t.inputEl.rows = 2;
        t.inputEl.addClass('lmp-template-input');
      });
    this.renderPresets(containerEl.createDiv());
    this.renderChatFolders(containerEl);

    /* ---------- Dati e backup ---------- */
    new Setting(containerEl).setName('Dati e backup').setHeading();
    text('Cartella delle tue note e dei tuoi dati', 'Le note sui versetti e, in JW Library/, evidenziazioni, segnalibri, risposte e posizione di lettura.', 'notesFolder', { clean: folder, after: () => this.plugin.settingsChanged() });
    new Setting(containerEl)
      .setName('Importa backup JW Library')
      .setDesc('Note, evidenziazioni e segnalibri da un file .jwlibrary.')
      .addButton((b) => b.setButtonText('Importa…').onClick(() => new JwlImportModal(this.plugin).open()));
    new Setting(containerEl)
      .setName('Esporta backup JW Library')
      .setDesc(this.plugin.jwlBase ? `Nuovo .jwlibrary con le modifiche fatte qui, partendo da «${this.plugin.jwlBase.name}».` : 'Disponibile dopo aver importato un backup.')
      .addButton((b) => b.setButtonText('Esporta…').onClick(() => new JwlExportModal(this.plugin).open()));
    new Setting(containerEl)
      .setName('Indice delle note')
      .setDesc(`${this.plugin.marks.length} evidenziazioni, ${this.plugin.bookmarks.length} segnalibri, ${this.plugin.noteIndex.byFile.size} note con riferimenti biblici.`)
      .addButton((b) =>
        b.setButtonText('Ricostruisci').onClick(async () => {
          b.setDisabled(true);
          await this.plugin.noteIndex.build();
          this.display();
        })
      );
  }

  /** Prompt rapidi della lampadina: un elenco da modificare, con i predefiniti già dentro. */
  renderPresets(el) {
    el.empty();
    const s = this.plugin.settings;
    const list = parsePresets(s.aiPresets).map((p) => ({ ...p }));
    const save = async (again) => {
      s.aiPresets = list.filter((p) => p.name.trim());
      await this.plugin.saveAll(false);
      if (again) this.renderPresets(el);
    };
    new Setting(el).setName('Prompt rapidi').setDesc('Le voci che compaiono toccando la lampadina nel campo "La tua risposta".');
    list.forEach((p, i) => {
      const row = new Setting(el).setClass('lmp-setting-wide').setClass('lmp-preset');
      row.addText((t) => t.setPlaceholder('Nome').setValue(p.name).onChange((v) => ((p.name = v), save())));
      row.addTextArea((t) => {
        t.setPlaceholder('Cosa deve fare').setValue(p.prompt).onChange((v) => ((p.prompt = v), save()));
        t.inputEl.rows = 2;
      });
      row.addExtraButton((b) => b.setIcon('arrow-up').setTooltip('Sposta su').setDisabled(i === 0).onClick(() => (list.splice(i - 1, 0, ...list.splice(i, 1)), save(true))));
      row.addExtraButton((b) => b.setIcon('trash-2').setTooltip('Elimina').onClick(() => (list.splice(i, 1), save(true))));
    });
    new Setting(el)
      .addButton((b) => b.setButtonText('Aggiungi').onClick(() => (list.push({ name: 'Nuovo', prompt: '' }), save(true))))
      .addButton((b) =>
        b.setButtonText('Ripristina predefiniti').onClick(async () => {
          s.aiPresets = '';
          await this.plugin.saveAll(false);
          this.renderPresets(el);
        })
      );
  }

  /** Cartelle di note in cui cerca anche Chiedi; quelle che non esistono si vedono subito. */
  renderChatFolders(containerEl) {
    const s = this.plugin.settings;
    const folders = new Setting(containerEl)
      .setClass('lmp-setting-wide')
      .setName('Cartelle in cui cerca anche Chiedi')
      .setDesc('Oltre alle pubblicazioni. Una per riga, dalla radice del vault (es. "Studio/Discorsi"). Dopo una modifica premi "Aggiorna l’indice" in Chiedi, dal computer.');
    const warn = folders.descEl.createDiv({ cls: 'mod-warning' });
    const check = () => {
      const missing = String(s.chatFolders || '')
        .split('\n')
        .map((f) => f.trim().replace(/^\/+|\/+$/g, ''))
        .filter((f) => f && !this.app.vault.getAbstractFileByPath(f));
      warn.setText(missing.length ? `Non trovate: ${missing.join(', ')}` : '');
    };
    folders.addTextArea((t) => {
      t.setPlaceholder('Studio/Discorsi\nStudio/Ricerche')
        .setValue(s.chatFolders || '')
        .onChange(async (v) => {
          s.chatFolders = v;
          await this.plugin.saveAll(false);
          check();
        });
      t.inputEl.rows = 3;
      t.inputEl.addClass('lmp-template-input');
    });
    check();
  }
}

export { BibleSettingTab };
