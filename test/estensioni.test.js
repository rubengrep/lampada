// API per estensioni: registerProvider, has, ask e gli hook dei dati che mancano nel vault.
const assert = require('assert');
const { carica } = require('./obsidian-finto');
const exp = carica(process.argv[2]);
const Plugin = exp.default || exp;
// In Obsidian c'è già.
Array.prototype.remove ??= function (x) { const i = this.indexOf(x); if (i >= 0) this.splice(i, 1); };

(async () => {
  const files = {};
  const pl = Object.create(Plugin.prototype);
  Object.assign(pl, { providers: [], readJson: async (p) => files[p] || null });
  assert.strictEqual(pl.has('meetingWeek'), false);
  assert.strictEqual(await pl.ask('meetingWeek', 'x'), null, 'senza fornitori: null');

  const vuoto = { meetingWeek: () => null };
  const pieno = { meetingWeek: async (k) => ({ id: 1, items: [k] }), answerFields: () => ({ 3: ['tt1'] }), imageAlts: (d, f) => ({ [f[0]]: 'nuovo' }) };
  pl.registerProvider(vuoto);
  const togli = pl.registerProvider(pieno);
  assert.strictEqual(pl.has('meetingWeek'), true);
  assert.deepStrictEqual(await pl.ask('meetingWeek', 'k'), { id: 1, items: ['k'] }, 'vale il primo risultato non null');
  assert.deepStrictEqual(await pl.meetingWeek('k', true), null, 'cachedOnly: non chiede');

  // Dati nel vault: vincono e non si chiede niente.
  files[pl.meetingsPath] = { v: 3, weeks: { k: 7 }, docs: { 7: ['a'] } };
  assert.deepStrictEqual(await pl.meetingWeek('k'), { id: 7, items: ['a'] });
  // Settimana presa dall'EPUB: il fornitore ha la precedenza, l'EPUB resta se il fornitore non risponde.
  files[pl.meetingsPath] = { v: 3, pubs: { 'mwb|202611': { src: 'epub' } }, weeks: { '2026-11-23': 8 }, docs: { 8: ['epub'] } };
  assert.deepStrictEqual(await pl.meetingWeek('2026-11-23'), { id: 1, items: ['2026-11-23'] });
  assert.deepStrictEqual(await pl.meetingWeek('2026-11-23', true), { id: 8, items: ['epub'] });
  files[pl.meetingsPath].pubs['mwb|202611'] = { src: 'altro' };
  assert.deepStrictEqual(await pl.meetingWeek('2026-11-23'), { id: 8, items: ['epub'] }, 'fonte non EPUB: non chiede');
  files[pl.answerFieldsPath] = { docs: { 5: { 1: ['tt9'] } } };
  assert.deepStrictEqual(await pl.docAnswerFields({ id: '5' }), { 1: ['tt9'] });
  assert.deepStrictEqual(await pl.docAnswerFields({ id: '6' }), { 3: ['tt1'] }, 'manca: dal fornitore');
  files[pl.imageAltsPath] = { alts: { 'a.jpg': 'noto' } };
  assert.deepStrictEqual(await pl.imageAlts({}, ['a.jpg']), { 'a.jpg': 'noto' });
  assert.deepStrictEqual(await pl.imageAlts({}, ['b.jpg']), { 'b.jpg': 'nuovo' });
  pl.registerProvider({ imageAlts: () => Promise.reject(new Error('offline')) });
  pl.providers.reverse();
  assert.deepStrictEqual(await pl.imageAlts({}, ['b.jpg']), { 'a.jpg': 'noto' }, 'errore: restano quelli noti');

  togli();
  assert.strictEqual(pl.providers.includes(pieno), false, 'la funzione restituita toglie il fornitore');
  assert.strictEqual(await pl.docAnswerFields({ id: '6' }), null);
  console.log('OK estensioni');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
