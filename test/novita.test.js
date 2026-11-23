// Novità dopo un aggiornamento (novita.js): sezioni di CHANGELOG.md tra due versioni.
const assert = require('assert');
const { carica } = require('./obsidian-finto.js');
const { newsBetween, cmpVersion } = carica(process.argv[2])._test;

const md = '# Novità\n\n## 0.10.0 — 2026-11-23\n\n- dieci\n\n## 0.9.1 — 2026-11-21\n\n- nove uno\n\n## 0.9.0 — 2026-11-21\n\n- nove\n';
assert.ok(cmpVersion('0.10.0', '0.9.1') > 0, '0.10 viene dopo 0.9 (numeri, non testo)');
assert.strictEqual(cmpVersion('1.2', '1.2.0'), 0);
const v = (s) => [...s.matchAll(/^## (\S+)/gm)].map((m) => m[1]);
assert.deepStrictEqual(v(newsBetween(md, '0.9.0', '0.10.0')), ['0.10.0', '0.9.1'], 'da quella vista (esclusa) a quella installata');
assert.deepStrictEqual(v(newsBetween(md, null, '0.10.0')), ['0.10.0'], 'senza versione vista: solo quella installata');
assert.deepStrictEqual(v(newsBetween(md)), ['0.10.0', '0.9.1', '0.9.0'], 'tutte');
assert.strictEqual(newsBetween(md, '0.10.0', '0.10.0'), '', 'già vista: niente');
assert.ok(!newsBetween(md).includes('# Novità\n'), 'senza il titolo del file');
