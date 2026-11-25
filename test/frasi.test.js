// Interlineare per frase: divisione in frasi e abbinamento tra due lingue (Gale e Church).
const assert = require('assert');
const { carica } = require('./obsidian-finto');
const { splitSentences, alignSentences } = carica(process.argv[2])._test;
const frasi = (t) => splitSentences(t).map((x) => x.s);

assert.deepStrictEqual(frasi('Gesù pianse. Poi disse: “Lazzaro, vieni fuori!” E lui uscì.'), ['Gesù pianse.', 'Poi disse: “Lazzaro, vieni fuori!”', 'E lui uscì.']);
// abbreviazioni e iniziali non chiudono la frase
assert.deepStrictEqual(frasi('Nel 33 E.V. Gesù morì. J. F. Rutherford scrisse molto, ecc. Fine.'), ['Nel 33 E.V. Gesù morì.', 'J. F. Rutherford scrisse molto, ecc. Fine.']);
// il riferimento dopo il punto va con la frase prima
assert.deepStrictEqual(frasi('They are spirits. (Ge 16:7; Re 22:8) Angels are powerful.'), ['They are spirits. (Ge 16:7; Re 22:8)', 'Angels are powerful.']);
const t = 'Uno. (Gv 3:16) Due.';
for (const x of splitSentences(t)) assert.strictEqual(t.slice(x.start, x.end).trim(), x.s, 'posizioni giuste');

// 1↔1 quando le lunghezze tornano, 2↔1 quando una lingua spezza in due
const len = (a) => a.map((x) => x.length);
const it = ['Termine utilizzato per indicare boccette di profumo realizzate con una pietra di Alabastron, in Egitto.', 'Tali contenitori avevano un collo stretto che si poteva sigillare.'];
const en = ['A small perfume jar originally made of a stone found near Alabastron, Egypt.', 'Such containers were usually made with a narrow neck that could be sealed.'];
assert.deepStrictEqual(alignSentences(len(it), len(en)), [[0, 1, 0, 1], [1, 2, 1, 2]]);
assert.deepStrictEqual(alignSentences(len(['Frase corta.', 'Altra frase che dice qualcosa di più lungo.']), len(['Short sentence and another sentence that says something longer.'])), [[0, 2, 0, 1]]);
// troppo diverse: null, così si mostra il paragrafo intero
assert.strictEqual(alignSentences([20, 400, 30, 500, 25], [40]), null);
