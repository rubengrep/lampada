// Finestra "Scarica da jw.org": mostra da dove arriva ogni file, chiede conferma (con le condizioni d'uso del sito)
// e scarica con la barra di avanzamento.
import { Modal, Platform, requestUrl } from 'obsidian';

const TERMS_URL = 'https://www.jw.org/it/condizioni-uso/';
const CHUNK = 1e6;
const mb = (n) => `${(n / 1e6).toFixed(1).replace('.', ',')} MB`;

/** Sul telefono, sopra 40 MB, non si scarica tutto: si leggono solo le parti che servono (richieste Range). Con `full` sì. */
const partial = (info) => !info.full && Platform.isMobile && info.size > 40e6;
/** Nome da mostrare: il titolo di jw.org può avere tag (<em>…</em>). */
const nameOf = (i) => String(i.label || i.title || i.pub || '').replace(/<[^>]*>/g, '');

/** Scarica a pezzi (il sito risponde 206), così la barra avanza davvero. Se il sito manda tutto in una volta, va bene lo stesso. */
async function fetchWithProgress(url, size, onBytes) {
  if (!size) return (await requestUrl({ url })).arrayBuffer;
  const out = new Uint8Array(size);
  for (let s = 0; s < size; s += CHUNK) {
    const e = Math.min(size, s + CHUNK);
    const r = await requestUrl({ url, headers: { Range: `bytes=${s}-${e - 1}` } });
    if (r.status !== 206) return r.arrayBuffer;
    out.set(new Uint8Array(r.arrayBuffer), s);
    onBytes(e);
  }
  return out.buffer;
}

class JwDownloadModal extends Modal {
  constructor(app, infos, each, done, auto) {
    super(app);
    Object.assign(this, { infos, each, done, auto, busy: false, finished: false });
  }

  onOpen() {
    const el = this.contentEl;
    this.titleEl.setText('Scarica da jw.org');
    const total = this.infos.reduce((s, i) => s + (i.size || 0), 0);
    for (const i of this.infos) {
      const f = el.createDiv('lmp-jw-file');
      f.createDiv({ cls: 'lmp-jw-name', text: `${nameOf(i)}${i.size ? ` · ${mb(i.size)}` : ''}` });
      f.createEl('code', { cls: 'lmp-jw-url', text: i.url });
    }
    const terms = el.createEl('p', { cls: 'lmp-jw-terms', text: 'Il file arriva direttamente da jw.org. Scaricandolo accetti le ' });
    terms.createEl('a', { text: 'condizioni d’uso di jw.org', href: TERMS_URL });
    terms.appendText('.');
    this.bar = el.createEl('progress', { cls: 'lmp-jw-bar', attr: { max: String(total || 1), value: '0' } });
    this.bar.hide();
    this.status = el.createDiv({ cls: 'lmp-bible-dl-status', attr: { 'aria-live': 'polite' } });
    const row = el.createDiv('modal-button-container');
    this.cancelBtn = row.createEl('button', { text: 'Annulla' });
    this.cancelBtn.addEventListener('click', () => this.close());
    this.okBtn = row.createEl('button', { cls: 'mod-cta', text: total ? `Scarica (${mb(total)})` : 'Scarica' });
    this.okBtn.addEventListener('click', () => this.start(total));
    if (this.auto) this.start(total);
  }

  async start(total) {
    this.busy = true;
    this.okBtn.disabled = this.cancelBtn.disabled = true;
    this.bar.show();
    const say = (t) => this.status.setText(t);
    let before = 0;
    try {
      for (const i of this.infos) {
        let buf = null;
        if (partial(i)) say(`${nameOf(i)}: leggo solo le parti che servono…`);
        else {
          say(`Scarico ${nameOf(i)}…`);
          buf = await fetchWithProgress(i.url, i.size, (n) => {
            this.bar.value = before + n;
            say(`Scarico ${nameOf(i)}: ${mb(before + n)}${total ? ` di ${mb(total)}` : ''}`);
          });
        }
        before += i.size || 0;
        this.bar.value = before;
        await this.each(i, buf, say);
      }
      this.finished = true;
      this.done.resolve();
      this.close();
    } catch (e) {
      this.busy = false;
      this.done.reject(e);
      this.close();
    }
  }

  onClose() {
    this.contentEl.empty();
    // Chiusa senza scaricare: annullato (chi chiama non mostra errori).
    if (!this.busy && !this.finished) this.done.reject(Object.assign(new Error('Annullato.'), { cancelled: true }));
  }
}

/**
 * Chiede conferma e scarica da jw.org i file (infos: [{ url, size, title, pub }]); per ognuno chiama
 * each(info, ArrayBuffer | null, say) — null sul telefono sopra 40 MB: lì si leggono solo le parti con le richieste Range;
 * con `full` (chi ha bisogno del file intero) arriva sempre il file.
 * Se l'utente annulla, l'errore ha `cancelled: true`. Con `auto` parte subito (già confermato, es. i file dopo il primo
 * di uno stesso lavoro): la finestra mostra lo stesso indirizzo e barra, poi si chiude.
 */
function jwDownload(app, infos, each, { auto = false, full = false } = {}) {
  if (full) infos = infos.map((i) => ({ ...i, full }));
  return new Promise((resolve, reject) => new JwDownloadModal(app, infos, each, { resolve, reject }, auto).open());
}

export { TERMS_URL, jwDownload, partial };
