// Pubblicazioni in una cartella nascosta (.lampada/…): Obsidian non le indicizza, Lampada le trova da sola.
const assert = require('assert');
const { carica } = require('./obsidian-finto');
const { scanHidden, fileAt, folderFiles, subfolders, mdFiles, readFile, fileMeta, linkDest, fileSrc } = carica(process.argv[2])._test;

const disco = {
  '.lampada/markdown/w/2025/202512/w202512_giobbe_2025683.md': '---\ntitle: Giobbe\n---\n# Giobbe\n\nTesto ^p1',
  '.lampada/markdown/_media/w/2025683_univ_cnt_1.jpg': '',
  '.lampada/markdown/Indici/w.json': '{}',
};
const cartelle = (dir) => {
  const files = [];
  const folders = new Set();
  for (const p of Object.keys(disco)) {
    if (!p.startsWith(`${dir}/`)) continue;
    const resto = p.slice(dir.length + 1).split('/');
    if (resto.length === 1) files.push(p);
    else folders.add(`${dir}/${resto[0]}`);
  }
  return { files, folders: [...folders] };
};
const app = {
  vault: {
    getAbstractFileByPath: () => null,
    getMarkdownFiles: () => [],
    adapter: { list: async (d) => cartelle(d), read: async (p) => disco[p], getResourcePath: (p) => `app://x/${p}` },
  },
  metadataCache: { getFirstLinkpathDest: () => null, getFileCache: () => null },
};

(async () => {
  await scanHidden(app, '.lampada/markdown/');
  const doc = fileAt(app, '.lampada/markdown/w/2025/202512/w202512_giobbe_2025683.md');
  assert.ok(doc && doc.disk, 'trovato il documento nascosto');
  assert.strictEqual(doc.basename, 'w202512_giobbe_2025683');
  assert.strictEqual(fileAt(app, '.lampada/markdown/manca.md'), null);
  assert.strictEqual(mdFiles(app, '.lampada/markdown/w/').length, 1, 'note sotto una cartella');
  assert.deepStrictEqual(subfolders(app, '.lampada/markdown/_media'), ['.lampada/markdown/_media/w']);
  assert.strictEqual(folderFiles(app, '.lampada/markdown/_media/w').length, 1);
  // Link [[nome]] e ![[immagine]] risolti per nome, come fa Obsidian nel vault.
  assert.strictEqual(linkDest(app, 'w202512_giobbe_2025683'), doc);
  assert.strictEqual(linkDest(app, '2025683_univ_cnt_1.jpg').extension, 'jpg');
  assert.strictEqual(fileSrc(app, doc), 'app://x/.lampada/markdown/w/2025/202512/w202512_giobbe_2025683.md');
  // Frontmatter e titoli: dopo la lettura.
  assert.strictEqual(fileMeta(app, doc), null);
  assert.ok((await readFile(app, doc)).includes('Testo ^p1'));
  assert.strictEqual(fileMeta(app, doc).frontmatter.title, 'Giobbe');
  assert.deepStrictEqual(fileMeta(app, doc).headings, [{ heading: 'Giobbe', level: 1 }]);
  // Una nuova scansione non raddoppia i file.
  await scanHidden(app, '.lampada/markdown');
  assert.strictEqual(mdFiles(app, '.lampada/markdown/').length, 1);
  console.log('OK file nascosti');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
