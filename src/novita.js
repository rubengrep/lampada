/* Novità dopo un aggiornamento: dal CHANGELOG.md del plugin, incluso in main.js come testo (niente internet).
 * Ogni plugin passa il suo: Lampada mostra solo le sue novità, un'estensione solo le proprie. */
import { Component, MarkdownRenderer, Modal } from 'obsidian';

/** > 0 se la versione a ("x.y.z") è più nuova di b. */
function cmpVersion(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

/** Sezioni "## x.y.z — data" con from < versione <= to. Senza from: solo la to; senza from né to: tutte. */
function newsBetween(md, from, to) {
  return md
    .split(/^(?=## )/m)
    .filter((s) => {
      const m = /^## (\d+(?:\.\d+)*)/.exec(s);
      if (!m) return false;
      if (to && cmpVersion(m[1], to) > 0) return false;
      if (from) return cmpVersion(m[1], from) > 0;
      return !to || cmpVersion(m[1], to) === 0;
    })
    .join('')
    .trim();
}

class NewsModal extends Modal {
  constructor(app, title, md) {
    super(app);
    this.title = title;
    this.md = md;
  }

  onOpen() {
    this.titleEl.setText(this.title);
    this.contentEl.addClass('lmp-news');
    this.comp = new Component();
    this.comp.load();
    MarkdownRenderer.render(this.app, this.md, this.contentEl, '', this.comp);
  }

  onClose() {
    if (this.comp) this.comp.unload();
    this.contentEl.empty();
  }
}

/**
 * Una volta per versione: dopo un aggiornamento apre le novità dalla versione vista l'ultima volta (settings.seenVersion).
 * Alla prima installazione (isNew) nessuna finestra. save(): salva le impostazioni.
 */
async function newsAfterUpdate(plugin, md, title, settings, save, isNew) {
  const cur = plugin.manifest.version;
  const seen = settings.seenVersion;
  if (seen === cur) return;
  settings.seenVersion = cur;
  await save();
  if (!seen && isNew) return;
  const news = newsBetween(md, seen, cur);
  if (news) new NewsModal(plugin.app, title, news).open();
}

export { NewsModal, cmpVersion, newsAfterUpdate, newsBetween };
