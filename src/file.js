/*
 * File delle pubblicazioni, anche in cartelle nascoste (.lampada/…): Obsidian non le indicizza, quindi lì si legge dal
 * disco con un elenco dei file fatto all'avvio (scanHidden). Fuori dalle cartelle nascoste vale il vault come sempre.
 * Le funzioni prendono e restituiscono TFile oppure DiskFile (stessi campi usati qui: path, name, basename, extension, stat).
 */
import { MarkdownRenderer, TFile, parseYaml } from 'obsidian';

const byPath = new Map();
const byName = new Map(); // "nome.md" → DiskFile (il primo trovato)
const byFolder = new Map(); // cartella → [DiskFile]

const isHidden = (path) => path.split('/').some((s) => s.startsWith('.'));

class DiskFile {
  constructor(path) {
    this.path = path;
    this.name = path.split('/').pop();
    const i = this.name.lastIndexOf('.');
    this.basename = i > 0 ? this.name.slice(0, i) : this.name;
    this.extension = i > 0 ? this.name.slice(i + 1).toLowerCase() : '';
    // ponytail: mtime 0 finché non lo si legge; basta per le cache, perché il plugin aggiorna l'elenco quando scrive.
    this.stat = { mtime: 0, size: 0 };
    this.disk = true;
    this.meta = null;
  }
}

function addHidden(path) {
  if (byPath.has(path)) return byPath.get(path);
  const f = new DiskFile(path);
  byPath.set(path, f);
  if (!byName.has(f.name)) byName.set(f.name, f);
  const dir = path.split('/').slice(0, -1).join('/');
  if (!byFolder.has(dir)) byFolder.set(dir, []);
  byFolder.get(dir).push(f);
  return f;
}

/** Elenca una volta tutti i file sotto root (se è una cartella nascosta). Qualche secondo con decine di migliaia di file. */
async function scanHidden(app, root) {
  root = root.replace(/\/$/, '');
  if (!root || !isHidden(root)) return;
  for (const p of [...byPath.keys()]) if (p.startsWith(`${root}/`)) byPath.delete(p);
  for (const [k, list] of byName) if (list.path.startsWith(`${root}/`)) byName.delete(k);
  for (const k of [...byFolder.keys()]) if (k === root || k.startsWith(`${root}/`)) byFolder.delete(k);
  const a = app.vault.adapter;
  let level = [root];
  while (level.length) {
    const lists = await Promise.all(level.map((d) => a.list(d).catch(() => ({ files: [], folders: [] }))));
    level = [];
    for (const l of lists) {
      for (const f of l.files) addHidden(f);
      level.push(...l.folders);
    }
  }
}

/** File in path: TFile del vault, DiskFile in una cartella nascosta, oppure null. */
function fileAt(app, path) {
  const f = app.vault.getAbstractFileByPath(path);
  if (f instanceof TFile) return f;
  return byPath.get(path) || null;
}

/** File (non cartelle) direttamente dentro una cartella. */
function folderFiles(app, path) {
  const f = app.vault.getAbstractFileByPath(path);
  if (f && f.children) return f.children.filter((c) => c instanceof TFile);
  return byFolder.get(path.replace(/\/$/, '')) || [];
}

/** Percorsi delle sottocartelle dirette di una cartella. */
function subfolders(app, path) {
  path = path.replace(/\/$/, '');
  const f = app.vault.getAbstractFileByPath(path);
  if (f && f.children) return f.children.filter((c) => c.children).map((c) => c.path);
  return [...byFolder.keys()].filter((k) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes('/'));
}

/** Note .md sotto prefix (anche nelle sottocartelle). */
function mdFiles(app, prefix) {
  if (!isHidden(prefix)) return app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix));
  return [...byPath.values()].filter((f) => f.extension === 'md' && f.path.startsWith(prefix));
}

function parseMeta(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  let frontmatter = null;
  try {
    frontmatter = m ? parseYaml(m[1]) : null;
  } catch (e) {
    /* frontmatter illeggibile */
  }
  const headings = [];
  for (const h of text.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)) headings.push({ heading: h[2], level: h[1].length });
  return { frontmatter, headings };
}

async function readFile(app, f) {
  if (!f.disk) return app.vault.cachedRead(f);
  const text = await app.vault.adapter.read(f.path);
  if (!f.meta) f.meta = parseMeta(text);
  return text;
}

/** Come metadataCache.getFileCache: per i file nascosti c'è solo dopo averli letti (frontmatter e titoli). */
function fileMeta(app, f) {
  return f.disk ? f.meta : app.metadataCache.getFileCache(f);
}

/** Destinazione di un link [[nome]] o ![[immagine]]. Nelle cartelle nascoste si cerca per nome del file. */
function linkDest(app, link, sourcePath = '') {
  const dest = app.metadataCache.getFirstLinkpathDest(link, sourcePath);
  if (dest) return dest;
  if (!byPath.size) return null;
  if (byPath.has(link)) return byPath.get(link);
  const name = link.split('/').pop();
  // ponytail: con due file dallo stesso nome vale il primo trovato (Obsidian sceglie il più vicino alla nota).
  return byName.get(name) || byName.get(`${name}.md`) || null;
}

/** Indirizzo da mettere in <img src>. */
function fileSrc(app, f) {
  return f.disk ? app.vault.adapter.getResourcePath(f.path) : app.vault.getResourcePath(f);
}

const IMAGE = /^(png|jpe?g|gif|webp|svg|avif)$/;

/**
 * MarkdownRenderer.render, più le immagini ![[…]] che stanno in una cartella nascosta: Obsidian le lascia come
 * segnaposto non risolto, qui diventano <img>.
 */
async function renderMd(app, md, el, sourcePath, comp) {
  await MarkdownRenderer.render(app, md, el, sourcePath, comp);
  if (!byPath.size) return;
  for (const span of el.querySelectorAll('.internal-embed[src]')) {
    if (span.querySelector('img')) continue;
    const f = linkDest(app, span.getAttribute('src').split('#')[0], sourcePath);
    if (!f || !f.disk || !IMAGE.test(f.extension)) continue;
    span.empty();
    span.addClass('image-embed', 'is-loaded');
    span.createEl('img', { attr: { src: fileSrc(app, f), alt: span.getAttribute('alt') || '', loading: 'lazy' } });
  }
}

/** Scrive un file binario anche in una cartella nascosta (il vault non ci può creare file) e lo aggiunge all'elenco. */
async function writeBinary(app, path, data) {
  const a = app.vault.adapter;
  const dir = path.split('/').slice(0, -1).join('/');
  if (dir && !(await a.exists(dir))) await a.mkdir(dir);
  await a.writeBinary(path, data);
  if (isHidden(path)) addHidden(path);
}

export { isHidden, scanHidden, fileAt, folderFiles, subfolders, mdFiles, readFile, fileMeta, linkDest, fileSrc, renderMd, writeBinary, addHidden };
