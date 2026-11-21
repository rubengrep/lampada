/* Dati in più dagli EPUB importati: campi "La tua risposta", testi delle immagini, programma dell'adunanza.
   Non sovrascrive mai i dati già presenti (vengono da fonti più complete). Niente rete. */
import { parseMeetingHtml, weekStartFromLabel } from './biblioteca-dati.js';

async function saveJson(plugin, path, data) {
  const a = plugin.app.vault.adapter;
  const dir = path.split('/').slice(0, -1).join('/');
  if (dir && !(await a.exists(dir))) await a.mkdir(dir);
  await a.write(path, JSON.stringify(data));
}

/** files: { 'nome.xhtml': testo } dell'EPUB; issue 'AAAAMM' o null. */
export async function epubExtras(plugin, { symbol, issue, files }) {
  const byName = Object.fromEntries(Object.entries(files).map(([k, v]) => [k.split('/').pop(), v]));
  // Documenti: il nome del file è il docId.
  const docs = Object.entries(byName)
    .filter(([n]) => /^\d+\.xhtml$/.test(n))
    .map(([n, html]) => [n.slice(0, -6), html, new DOMParser().parseFromString(html, 'text/html')]);

  // 1. Campi risposta: { docId: { pid: [tt…] } }
  const af = (await plugin.readJson(plugin.answerFieldsPath)) || {};
  af.docs = af.docs || {};
  let changed = false;
  for (const [id, , doc] of docs) {
    if (af.docs[id]) continue;
    const f = {};
    for (const t of doc.querySelectorAll('textarea')) {
      const pid = /^tt\d+$/.test(t.id) && t.closest('[data-pid]');
      if (pid) (f[pid.getAttribute('data-pid')] = f[pid.getAttribute('data-pid')] || []).push(t.id);
    }
    if (Object.keys(f).length) (af.docs[id] = f), (changed = true);
  }
  if (changed) await saveJson(plugin, plugin.answerFieldsPath, af);

  // 2. Testi alternativi: { alts: { file: testo } }
  const ia = (await plugin.readJson(plugin.imageAltsPath)) || {};
  ia.alts = ia.alts || {};
  changed = false;
  for (const [, , doc] of docs)
    for (const img of doc.querySelectorAll('img')) {
      const file = (img.getAttribute('src') || '').split('/').pop();
      const alt = (img.getAttribute('alt') || '').trim();
      if (file && alt && !ia.alts[file]) (ia.alts[file] = alt), (changed = true);
    }
  if (changed) await saveJson(plugin, plugin.imageAltsPath, ia);

  // 3. Programma dell'adunanza: solo le settimane che mancano, se il numero viene da una fonte migliore.
  if (symbol !== 'mwb' || !issue) return;
  let mt = await plugin.readJson(plugin.meetingsPath);
  if (!mt || mt.v !== 3) mt = { v: 3, pubs: {}, docs: {}, weeks: {} };
  const key = `mwb|${issue}`;
  const prev = mt.pubs[key];
  // I dati di questo numero sono nostri (EPUB) solo se pubs lo dice: allora si possono aggiornare.
  const ours = prev && prev.src === 'epub';
  await plugin.bible.ensureLoaded().catch(() => {});
  const epub = { bible: plugin.bible, files: byName };
  changed = false;
  for (const [id, html] of docs) {
    const items = parseMeetingHtml(html, epub);
    const h1 = items.find((x) => x.k === 'h1');
    const k = h1 && weekStartFromLabel(h1.x.filter((t) => typeof t === 'string').join(''), issue);
    if (!k) continue;
    const mine = ours && (!mt.weeks[k] || mt.weeks[k] === id);
    if (!mine && (mt.weeks[k] || mt.docs[id])) continue;
    mt.weeks[k] = id;
    mt.docs[id] = items;
    changed = true;
  }
  if (prev == null || ours) (mt.pubs[key] = { t: Date.now(), src: 'epub' }), (changed = true);
  if (changed) await saveJson(plugin, plugin.meetingsPath, mt);
}
