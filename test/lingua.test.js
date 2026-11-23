// Lingua dell'interfaccia: t() traduce dal testo italiano, con {valori}; senza traduzione resta l'italiano.
const assert = require('assert');
const { carica } = require('./obsidian-finto.js');
const { _test } = carica();
const { setLang, lang, t, addStrings, contentLang } = _test.lingua;

assert.strictEqual(setLang('auto'), 'it'); // la lingua di Obsidian (finta: it)
assert.strictEqual(t('Lingua'), 'Lingua');
assert.strictEqual(t('{n} documenti', { n: 3 }), '3 documenti');
assert.strictEqual(setLang('fr'), 'en'); // senza traduzioni → inglese
assert.strictEqual(t('Lingua'), 'Language');
addStrings('en', { 'Prova {x}': 'Test {x}' });
assert.strictEqual(t('Prova {x}', { x: 1 }), 'Test 1');
assert.strictEqual(t('Testo senza traduzione'), 'Testo senza traduzione');
assert.strictEqual(lang(), 'en');
assert.strictEqual(contentLang({ bibleLang: 'E' }), 'en');
assert.strictEqual(contentLang({}), 'it');

// Ogni testo tradotto deve avere gli stessi {valori} dell'italiano.
const en = require('fs').readFileSync(require('path').join(__dirname, '../src/lingue/en.js'), 'utf8');
const dict = new Function(en.replace('export default', 'return'))();
for (const [k, v] of Object.entries(dict)) {
  const vars = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  assert.strictEqual(vars(v), vars(k), `valori diversi in: ${k}`);
}
console.log('ok');
