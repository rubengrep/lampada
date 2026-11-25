/*
 * Lampada web: la stessa Lampada in una pagina HTML, per i computer senza Obsidian (repo rubengrep/lampada-web,
 * una release per ogni versione del plugin, con lo stesso numero). Con settings.webViewer Lampada la mette nel vault
 * (WEB_FILE) e la riscarica quando cambia la versione del plugin: la sincronizzazione la porta, per esempio, su OneDrive.
 */
import { Notice, Platform, requestUrl } from 'obsidian';
import { t } from './lingua.js';

const WEB_FILE = 'Lampada.html';
const webUrl = (v) => `https://github.com/rubengrep/lampada-web/releases/download/${v}/lampada.html`;

/**
 * Scarica la pagina della versione installata, se non c'è o è di un'altra versione (force: comunque).
 * → true se l'ha scritta. `get` serve alle prove.
 */
async function updateWebViewer(plugin, force = false, get = requestUrl) {
  const s = plugin.settings;
  const v = plugin.manifest.version;
  const a = plugin.app.vault.adapter;
  if (!force && s.webVersion === v && (await a.exists(WEB_FILE))) return false;
  const r = await get({ url: webUrl(v), throw: false });
  // La pagina web di una versione nuova arriva qualche ora dopo il plugin: si riprova al prossimo avvio.
  if (r.status !== 200) {
    if (force) new Notice(t('La pagina web di Lampada {v} non è ancora pronta: riprova più tardi.', { v }));
    return false;
  }
  await a.writeBinary(WEB_FILE, r.arrayBuffer);
  s.webVersion = v;
  await plugin.saveAll(false);
  return true;
}

/** All'avvio, solo sul computer: telefono e computer aggiornerebbero insieme lo stesso file sincronizzato. */
function autoUpdateWebViewer(plugin) {
  if (!plugin.settings.webViewer || Platform.isMobile || Platform.isWeb) return;
  plugin.app.workspace.onLayoutReady(() =>
    window.setTimeout(() => updateWebViewer(plugin).catch((e) => console.warn('[lampada] pagina web non aggiornata', e)), 6000)
  );
}

/** Dal comando e dalle impostazioni: aggiorna subito e dice com'è andata. */
async function updateWebViewerNow(plugin) {
  try {
    if (await updateWebViewer(plugin, true)) new Notice(t('{file} aggiornato (versione {v}).', { file: WEB_FILE, v: plugin.manifest.version }));
  } catch (e) {
    new Notice(t('Pagina web non scaricata: {msg}', { msg: e.message }));
  }
}

export { WEB_FILE, autoUpdateWebViewer, updateWebViewer, updateWebViewerNow };
