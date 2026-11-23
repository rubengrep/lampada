// Una biblioteca per lingua: cartelle separate, evidenziazioni e risposte della lingua scelta.
const assert = require('assert');
const { carica } = require('./obsidian-finto');
const exp = carica(process.argv[2]);
const Plugin = exp.default || exp;
const { dataDir, langRoot, BibleData } = exp._test;

const it = { rootFolder: '.lampada/markdown', bibleLang: 'I', symbol: 'nwtsty' };
const en = { ...it, bibleLang: 'E' };
assert.strictEqual(langRoot(it), '.lampada/markdown', 'l’italiano resta dov’era');
assert.strictEqual(langRoot({ rootFolder: '.lampada/markdown' }), '.lampada/markdown', 'senza lingua = italiano');
assert.strictEqual(langRoot(en), '.lampada/E/markdown');
assert.strictEqual(dataDir(it), '.lampada/data');
assert.strictEqual(dataDir(en), '.lampada/E/data');
assert.strictEqual(langRoot(it, 'E'), '.lampada/E/markdown', 'cartella di un’altra lingua');
// Bibbia inglese già nella cartella principale (versioni di prima): l'inglese resta lì, l'italiano va in .lampada/I/.
const vecchioEn = { ...en, baseLang: 'E' };
assert.strictEqual(langRoot(vecchioEn), '.lampada/markdown', 'la biblioteca inglese di prima resta dov’era');
assert.strictEqual(dataDir(vecchioEn), '.lampada/data');
assert.strictEqual(langRoot(vecchioEn, 'I'), '.lampada/I/markdown');

// Bibbia in uso: una per lingua
const bd = new BibleData({ settings: { ...en }, app: {} });
assert.strictEqual(bd.prefix, '.lampada/E/markdown/');
assert.strictEqual(bd.symbol, 'nwt', 'inglese senza scelta: nwt');
bd.setSymbol('nwtsty');
assert.deepStrictEqual(bd.plugin.settings.symbols, { E: 'nwtsty' });
assert.strictEqual(bd.plugin.settings.symbol, 'nwtsty', 'quella italiana non cambia');

// Evidenziazioni e risposte
const pl = Object.create(Plugin.prototype);
Object.assign(pl, { settings: { ...it }, marks: [], answers: {}, requestSave: () => {} });
pl.addMark(1, 1, 'yellow', [{ v: 1, s: 0, e: 2 }]);
pl.setAnswer(123, 'tt1', 'risposta');
pl.settings.bibleLang = 'E';
pl.rebuildMarkIndex();
assert.strictEqual(pl.marksFor(1, 1).length, 0, 'in inglese non si vedono le evidenziazioni italiane');
const m = pl.addMark(1, 1, 'blue', [{ v: 1, s: 0, e: 1 }]);
assert.strictEqual(m.lang, 'E');
pl.setAnswer(123, 'tt1', 'answer');
assert.deepStrictEqual(Object.keys(pl.answers), ['123|tt1'], 'come in JW Library: una risposta per documento, in tutte le lingue');
assert.strictEqual(pl.answers['123|tt1'].v, 'answer');
pl.settings.bibleLang = 'I';
pl.rebuildMarkIndex();
assert.deepStrictEqual(pl.marksFor(1, 1).map((x) => x.color), ['yellow'], 'tornando all’italiano: solo le sue');
console.log('OK lingue delle pubblicazioni');
