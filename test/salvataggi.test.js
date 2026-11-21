// Salvataggi: i dati utente (file condiviso da 3+ MB) si riscrivono solo quando cambiano davvero.
const assert = require('assert');
const { carica } = require('./obsidian-finto');
const exp = carica(process.argv[2]);
const Plugin = exp.default || exp;

(async () => {
  let dataJson = 0;
  let userData = 0;
  const locale = new Map();
  const pl = Object.create(Plugin.prototype);
  Object.assign(pl, {
    settings: { fontSize: 16 }, last: null, ui: {},
    app: { loadLocalStorage: (k) => locale.get(k), saveLocalStorage: (k, v) => locale.set(k, v) },
    saveData: async () => dataJson++,
    saveUserData: async () => userData++,
  });
  await pl.saveAll(false);
  assert.deepStrictEqual([dataJson, userData], [1, 0], 'solo interfaccia: niente dati utente');
  pl.userDataDirty = true;
  await pl.saveAll(false);
  assert.deepStrictEqual([dataJson, userData], [2, 1], 'dati utente cambiati: salvati');
  assert.strictEqual(pl.userDataDirty, false);
  await pl.saveAll();
  assert.deepStrictEqual([dataJson, userData], [3, 2], 'saveAll() completo salva sempre tutto');
  pl.userDataDirty = true;
  pl.onunload();
  assert.strictEqual(userData, 3, 'alla chiusura salva le modifiche rimaste');
  // Impostazioni di lettura: quelle del dispositivo vincono su data.json (che arriva dagli altri dispositivi).
  pl.loadData = async () => ({ settings: { fontSize: 22, symbol: 'x' } });
  await pl.loadAll();
  assert.strictEqual(pl.settings.fontSize, 16, 'dimensione del testo di questo dispositivo');
  assert.strictEqual(pl.settings.symbol, 'x', 'le altre impostazioni arrivano da data.json');
  console.log('OK salvataggi');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
