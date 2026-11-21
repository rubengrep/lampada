// Togliere una pubblicazione (LibraryData.remove): tutta, o un solo numero di un periodico. Cartelle vere in una cartella temporanea.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { carica } = require('./obsidian-finto');
const { LibraryData } = carica(process.argv[2])._test;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lampada-togli-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const P = '.lampada/markdown/';
const full = (p) => path.join(root, p);
const put = (p, t) => (fs.mkdirSync(path.dirname(full(p)), { recursive: true }), fs.writeFileSync(full(p), typeof t === 'string' ? t : JSON.stringify(t)));
const has = (p) => fs.existsSync(full(p));
const adapter = {
  exists: async (p) => has(p),
  read: async (p) => fs.readFileSync(full(p), 'utf8'),
  write: async (p, t) => put(p, t),
  remove: async (p) => fs.rmSync(full(p)),
  rmdir: async (p, rec) => fs.rmSync(full(p), { recursive: rec }),
  list: async (p) => ({ files: fs.readdirSync(full(p)).filter((f) => fs.statSync(path.join(full(p), f)).isFile()).map((f) => `${p}/${f}`), folders: [] }),
};

// Libro "lff" (cartella sua), periodico "w" con due numeri, Bibbia in uso "nwt"
put(`${P}index/lff.json`, { symbol: 'lff', folder: 'lff', docs: { 1: { rel: 'lff/a_1.md', title: 'A' } } });
put(`${P}lff/a_1.md`, 'a');
put(`${P}_media/lff/1_img.jpg`, 'x');
put(`${P}index/w.json`, { symbol: 'w', folder: 'w', docs: { 10: { rel: 'w/2026/202601/x_10.md', title: 'X' }, 20: { rel: 'w/2026/202602/y_20.md', title: 'Y' } } });
put(`${P}w/2026/202601/x_10.md`, 'x');
put(`${P}w/2026/202602/y_20.md`, 'y');
put(`${P}_media/w/10_a.jpg`, 'x');
put(`${P}_media/w/20_a.jpg`, 'x');
put(`${P}index/_sources.json`, { lff: { pub: 'lff' }, w_202601: { pub: 'w', issue: '202601' }, w_202602: { pub: 'w', issue: '202602' }, 'video:x': { source: 'video' } });
put(`${P}nwt/genesi.md`, 'g');

let refreshed = 0;
const lib = new LibraryData({ app: { vault: { adapter } }, refresh: async () => refreshed++ });
lib.bible = { prefix: P, symbol: 'nwt', folder: 'nwt', indexFiles: async () => fs.readdirSync(full(`${P}index`)).filter((f) => !f.startsWith('_')).map((f) => `${P}index/${f}`) };
const w = { symbol: 'w', folder: 'w', docs: [{ id: '10', rel: 'w/2026/202601/x_10.md' }, { id: '20', rel: 'w/2026/202602/y_20.md' }] };
w.issues = [{ key: '202601', docs: [w.docs[0]] }, { key: '202602', docs: [w.docs[1]] }];
lib.pubs = [{ symbol: 'lff', folder: 'lff', docs: [{ id: '1', rel: 'lff/a_1.md' }] }, w, { symbol: 'nwt', folder: 'nwt', docs: [] }];
lib.bySym = new Map(lib.pubs.map((p) => [p.symbol, p]));
lib.symCovers = new Map();

(async () => {
  await lib.remove('w', '202601');
  assert.ok(!has(`${P}w/2026/202601/x_10.md`) && !has(`${P}_media/w/10_a.jpg`));
  assert.ok(has(`${P}w/2026/202602/y_20.md`) && has(`${P}_media/w/20_a.jpg`));
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(full(`${P}index/w.json`), 'utf8')).docs), ['20']);

  await lib.remove('lff');
  assert.ok(!has(`${P}lff`) && !has(`${P}_media/lff`) && !has(`${P}index/lff.json`));
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(full(`${P}index/_sources.json`), 'utf8'))), ['w_202602', 'video:x']);
  assert.strictEqual(refreshed, 2);

  await assert.rejects(lib.remove('nwt'), /Bibbia che stai usando/);
  assert.ok(has(`${P}nwt/genesi.md`) && has(`${P}w/2026/202602/y_20.md`));
  console.log('OK togli');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
