// Le impostazioni si aprono senza bloccarsi (15/11/2026: un Setting restituito in una Promise bloccava il telefono).
const assert = require('assert');
const { carica, finto } = require('./obsidian-finto');
const { BibleSettingTab } = carica(process.argv[2])._test;

const plugin = {
  manifest: { version: '0.0.0' },
  settings: { fontSize: 19, lineHeight: 1.7, fontFamily: 'literata', suggestTrigger: '@', notesFolder: 'N' },
  ui: {}, marks: [], bookmarks: [], jwlBase: null, rbi8Dir: 'N/JW Library/Bibbia con riferimenti',
  noteIndex: { byFile: new Map(), byCode: new Map() },
  bible: { books: [{ versesFile: 'x.json' }] },
  views: () => [],
};
const app = { vault: { adapter: { exists: async () => true }, getAbstractFileByPath: () => null } };
const tab = new BibleSettingTab(app, plugin);
assert.doesNotThrow(() => tab.display());
// Prompt rapidi: i predefiniti compaiono nell'elenco; un elenco salvato prende il loro posto.
const { parsePresets } = carica(process.argv[2])._test;
assert.strictEqual(parsePresets([{ name: 'Mio', prompt: '' }, { name: ' ', prompt: 'x' }]).length, 1);
assert.deepStrictEqual(parsePresets([{ name: 'Mio', prompt: '' }])[0], { name: 'Mio', prompt: 'Mio' });
assert.strictEqual(parsePresets([]).length, 5);
// Se una Promise gira all'infinito, questo timer non scatta mai e tutti.js segnala il tempo scaduto.
setTimeout(() => console.log('OK impostazioni aperte'), 200);
