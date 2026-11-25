// Lampada web (web.js): Lampada.html nel vault si riscarica solo quando cambia la versione o manca.
const assert = require('assert');
const { carica } = require('./obsidian-finto.js');
const { updateWebViewer } = carica(process.argv[2])._test;

(async () => {
  const files = new Map();
  const plugin = {
    manifest: { version: '1.2.0' },
    settings: { webVersion: '' },
    saves: 0,
    saveAll: async () => plugin.saves++,
    app: { vault: { adapter: { exists: async (p) => files.has(p), writeBinary: async (p, d) => files.set(p, d) } } },
  };
  const urls = [];
  const ok = async (o) => (urls.push(o.url), { status: 200, arrayBuffer: 'pagina' });

  assert.strictEqual(await updateWebViewer(plugin, false, ok), true, 'prima volta: scarica');
  assert.strictEqual(files.get('Lampada.html'), 'pagina');
  assert.strictEqual(plugin.settings.webVersion, '1.2.0');
  assert.ok(urls[0].endsWith('/releases/download/1.2.0/lampada.html'), 'la release con lo stesso numero del plugin');

  assert.strictEqual(await updateWebViewer(plugin, false, ok), false, 'stessa versione e file presente: niente');
  files.clear();
  assert.strictEqual(await updateWebViewer(plugin, false, ok), true, 'file tolto: lo rimette');

  plugin.manifest.version = '1.3.0';
  const missing = async () => ({ status: 404 });
  assert.strictEqual(await updateWebViewer(plugin, false, missing), false, 'release web non ancora pronta: niente');
  assert.strictEqual(plugin.settings.webVersion, '1.2.0', 'si riprova al prossimo avvio');
  assert.strictEqual(await updateWebViewer(plugin, false, ok), true, 'versione nuova: scarica');
  assert.strictEqual(plugin.settings.webVersion, '1.3.0');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
