import { PluginSettingTab, Setting, Notice } from 'obsidian';
import { DEFAULT_SETTINGS, paneLabel, paneOrder } from './costanti.js';
import { JwlExportModal } from './jwl-esporta.js';
import { JwlImportModal } from './jwl-importa.js';
import { AI_DEFAULT_MODEL, openRouter, parsePresets } from './studio.js';
import { UI_LANGS, setLang, t } from './lingua.js';
import { BIBLE_LANGS } from './bibbia-epub.js';

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
      new Setting(containerEl).setName(name).setDesc(desc).addToggle((c) => c.setValue(get()).onChange(set));
    const text = (name, desc, key, { placeholder = DEFAULT_SETTINGS[key], clean = (v) => v.trim(), after } = {}) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((c) =>
        c.setPlaceholder(placeholder || '').setValue(s[key] || '').onChange(async (v) => {
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

    /* ---------- Lingua ---------- */
    new Setting(containerEl)
      .setName(t('Lingua'))
      .setDesc(t('Lingua dei testi di Lampada. I comandi cambiano al prossimo avvio.'))
      .addDropdown((d) =>
        d.addOptions({ auto: t('Come Obsidian'), ...UI_LANGS }).setValue(s.uiLang || 'auto').onChange(async (v) => {
          s.uiLang = v;
          setLang(v);
          await this.plugin.saveAll(false);
          this.display();
          this.plugin.app.workspace.trigger('lampada:language', v);
        })
      );
    new Setting(containerEl)
      .setName(t('Lingua delle pubblicazioni'))
      .setDesc(t('Ogni lingua ha la sua biblioteca, con la sua Bibbia e le sue evidenziazioni (le risposte valgono in tutte, come in JW Library). Si cambia anche dalla Biblioteca e dalla pagina dei libri.'))
      .addDropdown((d) =>
        d.addOptions(Object.fromEntries(BIBLE_LANGS)).setValue(s.bibleLang || 'I').onChange(async (v) => {
          await this.plugin.setPubLang(v);
          this.display();
        })
      );

    new Setting(containerEl)
      .setName(t('Novità'))
      .setDesc(t('Versione installata: {v}', { v: this.plugin.manifest.version }))
      .addButton((b) => b.setButtonText(t('Mostra')).onClick(() => this.plugin.showNews()));

    /* ---------- App ---------- */
    new Setting(containerEl).setName(t('Lampada come app')).setHeading();
    toggle(t('Vista unica'), t('Bibbia, Biblioteca, SCRABB e Chiedi in una sola scheda, con un solo Indietro. Le icone nella barra di sinistra cambiano al prossimo avvio.'), () => s.appShell !== false, async (v) => {
      s.appShell = v;
      await this.plugin.saveAll(false);
      this.plugin.applyAppMode();
      this.display();
    });
    toggle(t('Modalità app'), t('Mentre usi Lampada nasconde le barre di Obsidian. Tornano quando apri una nota o con il pulsante ⤢.'), () => !!this.plugin.ui.appMode, (v) => this.plugin.toggleAppMode(v));
    if (s.appShell === false) {
      new Setting(containerEl)
        .setName(t('Posizione del lettore'))
        .setDesc(t('Dove si apre la Bibbia. Si può spostare anche dal menu ⋯ del lettore.'))
        .addDropdown((d) =>
          d.addOptions({ tab: t('Scheda normale'), left: t('Barra laterale sinistra'), right: t('Barra laterale destra') }).setValue(s.readerLocation).onChange(async (v) => {
            s.readerLocation = v;
            await this.plugin.settingsChanged();
          })
        );
      toggle(t('Scheda Bibbia nella barra laterale sinistra'), t('Una scheda fissa accanto a File, Cerca e Segnalibri.'), () => s.leftTab, async (v) => {
        s.leftTab = v;
        await this.plugin.settingsChanged();
        await this.plugin.ensureLeftTab();
      });
    }

    /* ---------- Lettura ---------- */
    new Setting(containerEl).setName(t('Lettura')).setHeading();
    new Setting(containerEl).setDesc(t('Carattere, dimensione, interlinea, tema e pagine si regolano dal pannello Aa del lettore.'));
    toggle(t('Nascondi le barre mentre scorri'), t('Tablet e telefono. Spegnilo se lo scorrimento ti sembra a scatti.'), () => s.autoHideBars !== false, async (v) => {
      s.autoHideBars = v;
      await this.plugin.saveAll(false);
    });
    toggle(t('Mostra i riferimenti (+)'), t('Un "+" nel testo: toccalo per vedere i riferimenti.'), () => s.showRefMarkers, async (v) => {
      s.showRefMarkers = v;
      await redraw();
    });
    if ((this.plugin.bible?.books || []).some((b) => b.versesFile)) {
      toggle(t('Indica i versetti con approfondimenti'), t('Un puntino accanto al numero del versetto.'), () => s.showStudyMarkers, async (v) => {
        s.showStudyMarkers = v;
        await this.plugin.settingsChanged();
      });
    }
    toggle(t('Segna i versetti più citati'), t('Un segno nel margine accanto ai versetti citati molto più spesso degli altri.'), () => this.plugin.ui.citeHeat !== false, (v) => {
      this.plugin.ui.citeHeat = v;
      this.plugin.requestSave();
      for (const view of this.plugin.views()) view.layoutCiteHeat();
    });
    toggle(t('Segna i versetti citati nelle tue note'), t('Il numero del versetto viene sottolineato.'), () => s.showCiteMarkers, async (v) => {
      s.showCiteMarkers = v;
      await this.plugin.settingsChanged();
    });

    /* ---------- Pannello del versetto: ordine delle sezioni ---------- */
    new Setting(containerEl).setName(t('Pannello del versetto')).setHeading();
    new Setting(containerEl).setDesc(t('Ordine delle sezioni quando tocchi un versetto. Le schede in alto seguono lo stesso ordine.'));
    const order = paneOrder(s);
    const move = async (i, d) => {
      [order[i], order[i + d]] = [order[i + d], order[i]];
      s.paneOrder = order;
      await this.plugin.saveAll(false);
      for (const view of this.plugin.views()) if (view.state.mode === 'reader' && view.paneVisible) view.renderPane();
      this.display();
    };
    order.forEach((k, i) =>
      new Setting(containerEl)
        .setName(`${i + 1}. ${paneLabel(k)}`)
        .setClass('lmp-order-row')
        .addExtraButton((b) => b.setIcon('arrow-up').setTooltip(t('Più su')).setDisabled(i === 0).onClick(() => i > 0 && move(i, -1)))
        .addExtraButton((b) => b.setIcon('arrow-down').setTooltip(t('Più giù')).setDisabled(i === order.length - 1).onClick(() => i < order.length - 1 && move(i, 1)))
    );
    if (s.paneOrder)
      new Setting(containerEl).addButton((b) => b.setButtonText(t('Ordine predefinito')).onClick(async () => {
        delete s.paneOrder;
        await this.plugin.saveAll(false);
        this.display();
      }));

    /* ---------- Riferimenti nelle note ---------- */
    new Setting(containerEl).setName(t('Riferimenti nelle note')).setHeading();
    new Setting(containerEl)
      .setName(t('Clic su un versetto in una nota'))
      .setDesc(t('Cosa succede quando clicchi un riferimento biblico in una tua nota (es. “Efesini 4:16”). Con ⌘/Ctrl-clic si apre JW Library (o Lampada, se qui scegli JW Library).'))
      .addDropdown((d) =>
        d.addOptions({
          popup: t('Mostra il versetto in un popup'),
          reader: t('Apri in Lampada'),
          tab: t('Apri in una nuova scheda'),
          left: t('Apri nella barra laterale sinistra'),
          right: t('Apri nella barra laterale destra'),
          jwlibrary: t('Apri in JW Library'),
        }).setValue(s.clickAction || 'reader').onChange(async (v) => {
          s.clickAction = v;
          await this.plugin.settingsChanged();
        })
      );
    toggle(t('Anteprima al passaggio del mouse'), t('Mostra il testo del versetto.'), () => s.hoverPreview, async (v) => {
      s.hoverPreview = v;
      await this.plugin.settingsChanged();
    });
    toggle(t('Riconosci i riferimenti scritti a mano'), t('“Gv 3:16” o “Salmo 23:1-4” anche come testo semplice (le abbreviazioni brevi con la maiuscola).'), () => s.detectPlainRefs, async (v) => {
      s.detectPlainRefs = v;
      await this.plugin.settingsChanged(false, true);
    });
    text(t('Prefisso per inserire versetti'), t('Es. @gv 3:16 inserisce link o citazione. Vuoto = disattivato.'), 'suggestTrigger', { after: () => this.plugin.settingsChanged() });
    toggle(t('Nome del libro per esteso'), t('“Giovanni 3:16” invece di “Gv 3:16” nei link creati.'), () => s.expandBookName, async (v) => {
      s.expandBookName = v;
      await this.plugin.settingsChanged();
    });
    toggle(t('Apri il versetto dopo averlo citato'), t('Si apre anche nel lettore; il cursore resta nella nota.'), () => s.openAfterCite, async (v) => {
      s.openAfterCite = v;
      await this.plugin.saveAll(false);
    });
    new Setting(containerEl)
      .setClass('lmp-setting-wide')
      .setName(t('Modello di inserimento'))
      .setDesc(t('Testo inserito con "Inserisci nella nota". Variabili: {{link}}, {{ref}}, {{text}}.'))
      .addTextArea((c) => {
        c.setValue(s.insertTemplate).onChange(async (v) => {
          s.insertTemplate = v;
          await this.plugin.settingsChanged();
        });
        c.inputEl.rows = 3;
        c.inputEl.addClass('lmp-template-input');
      });

    /* ---------- SCRABB ---------- */
    new Setting(containerEl).setName('SCRABB').setHeading();
    text(t('Cartella delle schede'), t('Dove vengono create le nuove schede (una sottocartella per tipo). Le schede sono riconosciute ovunque dal campo “tipo”.'), 'scrabbFolder', { clean: folder });
    text(t('Attivatore'), t('Mentre scrivi, questo più qualche lettera (es. ++umil) collega una scheda. Vuoto = disattivato.'), 'scrabbTrigger');

    /* ---------- Intelligenza artificiale ---------- */
    new Setting(containerEl).setName(t('Intelligenza artificiale')).setHeading();
    new Setting(containerEl)
      .setName(t('Chiave OpenRouter'))
      .setDesc(t('Facoltativa, per la lampadina e Chiedi. Resta su questo dispositivo.'))
      .addText((c) => {
        c.inputEl.type = 'password';
        c.setPlaceholder('sk-or-…').setValue(s.openrouterKey || '').onChange(async (v) => {
          s.openrouterKey = v.trim();
          await this.plugin.saveAll(false);
        });
      });
    text(t('Modello AI'), t('Nome su openrouter.ai/models. Vuoto = {m}.', { m: AI_DEFAULT_MODEL }), 'aiModel', { placeholder: AI_DEFAULT_MODEL }).addButton((b) =>
      b.setButtonText(t('Prova')).onClick(async () => {
        b.setDisabled(true);
        try {
          const json = await openRouter(this.plugin, { messages: [{ role: 'user', content: t('Rispondi solo: ok') }], max_tokens: 5 });
          new Notice(t('Funziona: {m}', { m: json.model || t('modello pronto') }));
        } catch (e) {
          new Notice(e.message);
        }
        b.setDisabled(false);
      })
    );
    new Setting(containerEl)
      .setClass('lmp-setting-wide')
      .setName(t('Istruzioni personali'))
      .setDesc(t('Valgono per tutte le risposte: spunti, domande e Chiedi. Es. "Frasi brevi e parole semplici, ho 14 anni".'))
      .addTextArea((c) => {
        c.setValue(s.aiInstructions || '').onChange(async (v) => {
          s.aiInstructions = v;
          await this.plugin.saveAll(false);
        });
        c.inputEl.rows = 2;
        c.inputEl.addClass('lmp-template-input');
      });
    this.renderPresets(containerEl.createDiv());
    this.renderChatFolders(containerEl);

    /* ---------- Dati e backup ---------- */
    new Setting(containerEl).setName(t('Dati e backup')).setHeading();
    text(t('Cartella delle tue note e dei tuoi dati'), t('Le note sui versetti e, in JW Library/, evidenziazioni, segnalibri, risposte e posizione di lettura.'), 'notesFolder', { clean: folder, after: () => this.plugin.settingsChanged() });
    new Setting(containerEl)
      .setName(t('Importa backup JW Library'))
      .setDesc(t('Note, evidenziazioni e segnalibri da un file .jwlibrary.'))
      .addButton((b) => b.setButtonText(t('Importa…')).onClick(() => new JwlImportModal(this.plugin).open()));
    new Setting(containerEl)
      .setName(t('Esporta backup JW Library'))
      .setDesc(this.plugin.jwlBase ? t('Nuovo .jwlibrary con le modifiche fatte qui, partendo da «{nome}».', { nome: this.plugin.jwlBase.name }) : t('Disponibile dopo aver importato un backup.'))
      .addButton((b) => b.setButtonText(t('Esporta…')).onClick(() => new JwlExportModal(this.plugin).open()));
    new Setting(containerEl)
      .setName(t('Indice delle note'))
      .setDesc(t('{ev} evidenziazioni, {seg} segnalibri, {note} note con riferimenti biblici.', { ev: this.plugin.marks.length, seg: this.plugin.bookmarks.length, note: this.plugin.noteIndex.byFile.size }))
      .addButton((b) =>
        b.setButtonText(t('Ricostruisci')).onClick(async () => {
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
    new Setting(el).setName(t('Prompt rapidi')).setDesc(t('Le voci che compaiono toccando la lampadina nel campo "La tua risposta".'));
    list.forEach((p, i) => {
      const row = new Setting(el).setClass('lmp-setting-wide').setClass('lmp-preset');
      row.addText((c) => c.setPlaceholder(t('Nome')).setValue(p.name).onChange((v) => ((p.name = v), save())));
      row.addTextArea((c) => {
        c.setPlaceholder(t('Cosa deve fare')).setValue(p.prompt).onChange((v) => ((p.prompt = v), save()));
        c.inputEl.rows = 2;
      });
      row.addExtraButton((b) => b.setIcon('arrow-up').setTooltip(t('Sposta su')).setDisabled(i === 0).onClick(() => (list.splice(i - 1, 0, ...list.splice(i, 1)), save(true))));
      row.addExtraButton((b) => b.setIcon('trash-2').setTooltip(t('Elimina')).onClick(() => (list.splice(i, 1), save(true))));
    });
    new Setting(el)
      .addButton((b) => b.setButtonText(t('Aggiungi')).onClick(() => (list.push({ name: t('Nuovo'), prompt: '' }), save(true))))
      .addButton((b) =>
        b.setButtonText(t('Ripristina predefiniti')).onClick(async () => {
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
      .setName(t('Cartelle in cui cerca anche Chiedi'))
      .setDesc(t('Oltre alle pubblicazioni. Una per riga, dalla radice del vault (es. "Studio/Discorsi"). Dopo una modifica premi "Aggiorna l’indice" in Chiedi, dal computer.'));
    const warn = folders.descEl.createDiv({ cls: 'mod-warning' });
    const check = () => {
      const missing = String(s.chatFolders || '')
        .split('\n')
        .map((f) => f.trim().replace(/^\/+|\/+$/g, ''))
        .filter((f) => f && !this.app.vault.getAbstractFileByPath(f));
      warn.setText(missing.length ? t('Non trovate: {cartelle}', { cartelle: missing.join(', ') }) : '');
    };
    folders.addTextArea((c) => {
      c.setPlaceholder(t('Studio/Discorsi\nStudio/Ricerche'))
        .setValue(s.chatFolders || '')
        .onChange(async (v) => {
          s.chatFolders = v;
          await this.plugin.saveAll(false);
          check();
        });
      c.inputEl.rows = 3;
      c.inputEl.addClass('lmp-template-input');
    });
    check();
  }
}

export { BibleSettingTab };
