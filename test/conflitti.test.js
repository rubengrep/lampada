// Copie in conflitto di Syncthing (highlights.sync-conflict-*.json) e file col nome vecchio (evidenziazioni.json):
// unite e poi cancellate, senza perdere dati. Poi lo spostamento dei dati ricavati in .lampada/data.
const assert = require('assert');
const { carica } = require('./obsidian-finto');
const exp = carica(process.argv[2]);
const Plugin = exp.default || exp;
// file system finto
const files = {};
const adapter = {
  exists: async (p) => p in files || Object.keys(files).some((f) => f.startsWith(p + '/')),
  read: async (p) => files[p],
  write: async (p, t) => { files[p] = t; },
  remove: async (p) => { delete files[p]; },
  list: async (d) => ({ files: Object.keys(files).filter((f) => f.startsWith(d + '/')), folders: [] }),
  stat: async (p) => (p in files ? { mtime: 1, size: files[p].length } : null),
  mkdir: async () => {},
  rename: async (a, b) => { for (const f of Object.keys(files)) if (f === a || f.startsWith(a + '/')) { files[b + f.slice(a.length)] = files[f]; delete files[f]; } },
};
const pl = Object.create(Plugin.prototype);
Object.assign(pl, {
  app: { vault: { adapter }, workspace: { getLeavesOfType: () => [] } },
  manifest: { dir: 'plug' }, settings: { notesFolder: 'N', rootFolder: 'R' }, userDataLoaded: true,
  marks: [], markTomb: {}, bookmarks: [], bmTomb: {}, deletedJwl: [], jwlBase: null, answers: {},
  rebuildMarkIndex() {}, views: () => [],
});
const P = 'N/JW Library/highlights.json';
const snap = (marks, extra = {}) => JSON.stringify({ version: 1, marks, markTomb: {}, bookmarks: [], bmTomb: {}, deletedJwl: [], jwlBase: null, answers: {}, ...extra });
const m = (id, t, color = 1) => ({ id, b: 1, c: 1, color, ranges: [], t });
files[P] = snap([m('a', 1), m('b', 5)]);
files['N/JW Library/highlights.sync-conflict-20261115-1-X.json'] = snap([m('a', 1), m('b', 3), m('c', 4)]);
files['N/JW Library/highlights.sync-conflict-20261115-2-Y.json'] = '{"marks":[tronc'; // ancora in arrivo
files['N/JW Library/altro.json'] = '{}';
// Telefono non ancora aggiornato: riscrive il file col nome di prima.
files['N/JW Library/evidenziazioni.json'] = snap([m('e', 7)]);
(async () => {
  await pl.mergeConflictCopies();
  const shared = JSON.parse(files[P]);
  assert.deepStrictEqual(shared.marks.map((x) => x.id + x.t).sort(), ['a1', 'b5', 'c4', 'e7'], 'merge: vince il più recente, c ed e aggiunte');
  assert(!files['N/JW Library/evidenziazioni.json'], 'nome vecchio unito e cancellato');
  assert(!files['N/JW Library/highlights.sync-conflict-20261115-1-X.json'], 'copia unita cancellata');
  assert(files['N/JW Library/highlights.sync-conflict-20261115-2-Y.json'], 'copia illeggibile lasciata');
  assert(files['N/JW Library/altro.json'], 'altri file intatti');
  assert(files['plug/stato-desktop.json'], 'copia locale scritta');
  // salvataggio fallito: la copia non va cancellata
  files['N/JW Library/highlights.sync-conflict-3-Z.json'] = snap([m('d', 9)]);
  adapter.write = async () => { throw new Error('disco pieno'); };
  console.warn = () => {};
  await pl.mergeConflictCopies();
  assert(files['N/JW Library/highlights.sync-conflict-3-Z.json'], 'non cancellata se il salvataggio fallisce');
  // Spostamento una volta: nomi in inglese, dati ricavati in .lampada/data, indici da Indici a index.
  adapter.write = async (p, t) => { files[p] = t; };
  for (const k of Object.keys(files)) delete files[k];
  Object.assign(files, {
    'N/JW Library/campi-risposta.json': 'c', 'N/JW Library/adunanze.json': 'a', 'N/JW Library/Bibbia con riferimenti/01.json': 'g',
    'N/JW Library/evidenziazioni.json': 'e', 'N/JW Library/posizione.json': 'p', 'N/JW Library/backup-base.jwlibrary': 'b',
    'R/Indici/w.json': 'w', 'R/Indici/copertine/w.jpg': 'j', 'R/Indici/ricerca/meta.json': 'm',
  });
  await pl.moveDerivedData();
  assert.deepStrictEqual(Object.keys(files).sort(), [
    '.lampada/data/answer-fields.json', '.lampada/data/covers/w.jpg', '.lampada/data/meetings.json', '.lampada/data/reference-bible/01.json',
    '.lampada/data/search/meta.json', 'N/JW Library/backup-base.jwlibrary', 'N/JW Library/highlights.json', 'N/JW Library/position.json', 'R/index/w.json',
  ]);
  // Già spostato: la seconda volta non tocca niente.
  files['N/JW Library/adunanze.json'] = 'vecchio';
  await pl.moveDerivedData();
  assert.strictEqual(files['.lampada/data/meetings.json'], 'a', 'non sovrascrive i dati già spostati');
  console.log('OK tutte le verifiche');
})().catch((e) => { console.error('FALLITO', e.message); process.exit(1); });
