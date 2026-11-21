// Dati in più dagli EPUB: campi risposta, testi delle immagini, programma dell'adunanza e regola delle fonti.
const assert = require('assert');
const { carica } = require('./obsidian-finto');
global.DOMParser = require('./dom-finto').DOMParser;
const { epubExtras } = carica(process.argv[2])._test;

const doc = (id, body) => `<?xml version="1.0" encoding="utf-8" ?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body class="pub-mwb docId-${id}">${body}</body></html>`;
const settimana = (id, giorni) =>
  doc(
    id,
    `<header><h1 id="p1" data-pid="1">${giorni} NOVEMBRE</h1>
<h2 id="p2" data-pid="2"><strong><a epub:type="noteref" href="#citation1">GEREMIA 49-50</a></strong></h2></header>
<div class="du-color--teal-700"><h2 class="du-color--teal-700" id="p4" data-pid="4"><strong>TESORI</strong></h2></div>
<div id="f1"><figure><img src="images/${id}_univ_cnt_1.jpg" alt="Una sorella studia la Bibbia." /></figure></div>
<p id="p7" data-pid="7">Geova condannò Babilonia (<a epub:type="noteref" href="#citation2">Ger 50:14,</a><a epub:type="noteref" href="#citation3"> 29</a>; <a href="${id}-extracted.xhtml#pcitation1"><em>it</em> “Presunzione” par. 10</a>)</p>
<div class="gen-field" id="p13" data-pid="13"><label for="tt20">La tua risposta</label><textarea id="tt20"></textarea></div>
<aside epub:type="footnote"><div epub:type="footnote" class="extScrpCite" id="citation1"><p><a href="#citationsource1">^ <strong>(Ger. 49:1-50:46)</strong></a> Contro gli ammoniti.</p></div></aside>
<aside epub:type="footnote"><div epub:type="footnote" class="extScrpCite" id="citation2"><p><a href="#citationsource2">^ <strong>(Ger. 50:14)</strong></a> Venite contro Babilonia.</p></div></aside>
<aside epub:type="footnote"><div epub:type="footnote" class="extScrpCite" id="citation3"><p><a href="#citationsource3">^ <strong>(Ger. 50:29, 30)</strong></a> Convocate.</p></div></aside>`
  );
const estratto = (id) =>
  doc(
    id,
    `<div class="groupExt"><div class="groupExtPubRef"><div class="extPubRef"><p><a href="${id}.xhtml#pcitationsource1">^ <span id="pcitation1"></span><strong>***it-2 “Presunzione” par. 10***</strong></a></p>
<p class="p11"><span class="parNum" data-pnum="10"></span><strong>Fine della presunzione.</strong> L’antica Babilonia &amp; altro.</p>
<div class="groupExt"><aside epub:type="footnote"><div epub:type="footnote" class="extScrpCite" id="citation15"><p>Nota da saltare</p></div></aside></div>
</div></div></div>`
  );
const files = {
  '202026401.xhtml': settimana('202026401', '2-8'),
  '202026401-extracted.xhtml': estratto('202026401'),
  '202026402.xhtml': settimana('202026402', '9-15'),
  '202026402-extracted.xhtml': estratto('202026402'),
  'toc.xhtml': doc('', '<p data-pid="1">Indice</p>'),
};

function finto(iniziali) {
  const mem = Object.fromEntries(Object.entries(iniziali).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    mem,
    answerFieldsPath: 'd/af.json',
    imageAltsPath: 'd/ia.json',
    meetingsPath: 'd/mt.json',
    readJson: async (p) => (p in mem ? JSON.parse(mem[p]) : null),
    app: { vault: { adapter: { exists: async (p) => p === 'd' || p in mem, mkdir: async () => {}, write: async (p, s) => (mem[p] = s) } } },
    bible: {
      ensureLoaded: async () => {},
      parseReference: (s) => {
        const m = /^Ger\. (\d+):(\d+)$/.exec(s);
        return m && { book: 24, chapter: +m[1], verse: +m[2] };
      },
    },
  };
}
const leggi = (pl, p) => JSON.parse(pl.mem[p]);

(async () => {
  // Senza dati: tutto dall'EPUB.
  let pl = finto({ 'd/af.json': { pubs: {}, docs: { 202026402: { 5: ['tt1'] } } }, 'd/ia.json': { alts: { '202026402_univ_cnt_1.jpg': 'già noto' }, altro: 1 } });
  await epubExtras(pl, { symbol: 'mwb', issue: '202611', files });
  const af = leggi(pl, 'd/af.json');
  assert.deepStrictEqual(af.docs['202026401'], { 13: ['tt20'] }, 'campi risposta: pid → [tt]');
  assert.deepStrictEqual(af.docs['202026402'], { 5: ['tt1'] }, 'campi già noti: non si toccano');
  assert.deepStrictEqual(af.pubs, {});
  const ia = leggi(pl, 'd/ia.json');
  assert.strictEqual(ia.alts['202026401_univ_cnt_1.jpg'], 'Una sorella studia la Bibbia.');
  assert.strictEqual(ia.alts['202026402_univ_cnt_1.jpg'], 'già noto', 'testi già noti: non si toccano');
  assert.strictEqual(ia.altro, 1, 'le altre chiavi restano');

  let mt = leggi(pl, 'd/mt.json');
  assert.strictEqual(mt.v, 3);
  assert.deepStrictEqual(mt.weeks, { '2026-11-02': '202026401', '2026-11-09': '202026402' });
  assert.strictEqual(mt.pubs['mwb|202611'].src, 'epub');
  const items = mt.docs['202026401'];
  assert.deepStrictEqual(items[0], { k: 'h1', x: ['2-8 NOVEMBRE'] });
  assert.deepStrictEqual(items[1], { k: 'h2', x: [['GEREMIA 49-50', '24049001', '24050046']] }, 'lettura: da capitolo a capitolo');
  assert.deepStrictEqual(items[2], { k: 'h2', s: 'teal', x: ['TESORI'] });
  assert.deepStrictEqual(items[3], { k: 'img', file: '202026401_univ_cnt_1.jpg', alt: 'Una sorella studia la Bibbia.', cap: '' }, 'immagine: nome del file');
  assert.deepStrictEqual(items[4].x, [
    'Geova condannò Babilonia (',
    ['Ger 50:14,', '24050014', '24050014'],
    [' 29', '24050029', '24050030'],
    '; ',
    { t: 'it “Presunzione” par. 10', ex: ['Fine della presunzione. L’antica Babilonia & altro.'] },
    ')',
  ]);
  assert.deepStrictEqual(items[5], { k: 'f', f: ['tt20'] });
  assert.strictEqual(items.length, 6, 'le note in calce non sono parti del programma');

  // Fonte migliore (valore numerico o src diverso): solo le settimane che mancano, pubs resta com'è.
  for (const migliore of [123, { t: 1, src: 'altro' }]) {
    pl = finto({ 'd/mt.json': { v: 3, pubs: { 'mwb|202611': migliore }, docs: { X: ['suo'] }, weeks: { '2026-11-02': 'X' } } });
    await epubExtras(pl, { symbol: 'mwb', issue: '202611', files });
    mt = leggi(pl, 'd/mt.json');
    assert.deepStrictEqual(mt.pubs['mwb|202611'], migliore);
    assert.strictEqual(mt.weeks['2026-11-02'], 'X', 'la settimana della fonte migliore resta');
    assert.deepStrictEqual(mt.docs.X, ['suo']);
    assert.strictEqual(mt.docs['202026401'], undefined);
    assert.strictEqual(mt.weeks['2026-11-09'], '202026402', 'la settimana che mancava viene dall’EPUB');
  }

  // Dati già dall'EPUB: un nuovo import li aggiorna, ma non tocca le settimane di altri.
  pl = finto({ 'd/mt.json': { v: 3, pubs: { 'mwb|202611': { t: 1, src: 'epub' } }, docs: { 202026401: ['vecchio'], Y: ['suo'] }, weeks: { '2026-11-02': '202026401', '2026-11-09': 'Y' } } });
  await epubExtras(pl, { symbol: 'mwb', issue: '202611', files });
  mt = leggi(pl, 'd/mt.json');
  assert.strictEqual(mt.docs['202026401'].length, 6, 'i propri dati si aggiornano');
  assert.strictEqual(mt.weeks['2026-11-09'], 'Y');
  assert.ok(mt.pubs['mwb|202611'].t > 1);

  // Altre pubblicazioni: niente programma.
  pl = finto({});
  await epubExtras(pl, { symbol: 'w', issue: '202601', files });
  assert.strictEqual(pl.mem['d/mt.json'], undefined);
  assert.ok(pl.mem['d/af.json']);
  console.log('OK epub-extra');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
