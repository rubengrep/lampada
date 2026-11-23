// Pubblicazioni dall'EPUB: un EPUB finto e piccolo (stessa struttura di quelli del sito) → formato di .lampada/markdown/.
const assert = require('assert');
const { carica } = require('./obsidian-finto');
const { convertPubEpub, parseSymbol, refRange, zipFiles, unzipEntries } = carica(process.argv[2])._test;

// Simboli come nelle citazioni.
assert.deepStrictEqual(parseSymbol('w26.01'), { pub: 'w', issue: '202601' });
assert.deepStrictEqual(parseSymbol(' W 202601 '), { pub: 'w', issue: '202601' });
assert.deepStrictEqual(parseSymbol('mwb26.01'), { pub: 'mwb', issue: '202601' });
assert.deepStrictEqual(parseSymbol('g25.3'), { pub: 'g', issue: '202503' });
assert.deepStrictEqual(parseSymbol('lff'), { pub: 'lff', issue: '' });
assert.deepStrictEqual(parseSymbol('ip-1'), { pub: 'ip-1', issue: '' });
assert.deepStrictEqual(parseSymbol('w20020715'), { pub: 'w', issue: '20020715' });
assert.strictEqual(parseSymbol('w26.13'), null);
assert.strictEqual(parseSymbol('cosa?'), null);

// Bibbia finta: Matteo (40) e Salmi (19), con i versetti 1-6 del Salmo 23.
const BOOKS = { matt: 40, matteo: 40, sal: 19, salmo: 19 };
const bible = {
  validCodes: new Set([1, 2, 3, 4, 5, 6].map((v) => `19023${String(v).padStart(3, '0')}`)),
  parseReference(s) {
    const m = /^([a-z]+)\.?\s*(\d+)(?::(\d+))?$/i.exec(s.trim());
    return m && BOOKS[m[1].toLowerCase()] ? { book: BOOKS[m[1].toLowerCase()], chapter: +m[2], ...(m[3] ? { verse: +m[3] } : {}) } : null;
  },
};
assert.deepStrictEqual(refRange(bible, '(Matt. 15:21-28)'), ['40015021', '40015028']);
assert.deepStrictEqual(refRange(bible, 'Matt. 5:3;'), ['40005003', '']);
assert.deepStrictEqual(refRange(bible, 'Matt. 5:3, 4'), ['40005003', '40005004']);
assert.deepStrictEqual(refRange(bible, 'Matt. 5:14–6:1'), ['40005014', '40006001']);
assert.deepStrictEqual(refRange(bible, 'Salmo 23'), ['19023001', '19023006']);
assert.strictEqual(refRange(bible, 'Glossario'), null);

const page = (id, title, body) =>
  `<?xml version="1.0" encoding="utf-8" ?><html><head><title>${title}</title></head><body class="jwac docClass-40 pub-w docId-${id}">${body}</body></html>`;
const nb = ' ';
const epub = {
  'OEBPS/content.opf': `<package><metadata><dc:title>La Torre di Guardia, gennaio 2026</dc:title></metadata><manifest>
<item id="toc" href="toc.xhtml" media-type="application/xhtml+xml" /><item id="chapter1" href="2026247.xhtml" /><item id="chapter2" href="2026240.xhtml" /><item id="x" href="2026240-extracted.xhtml" />
</manifest><spine><itemref idref="toc" linear="no" /><itemref idref="chapter1" /><itemref idref="chapter2" /><itemref idref="x" /></spine></package>`,
  'OEBPS/toc.xhtml': page('', 'Indice', ''),
  'OEBPS/2026247.xhtml': page('2026247', 'Indice', `<header><h1 id="p1" data-pid="1"><strong>Indice</strong></h1></header>
<h3 id="p3" data-pid="3">Articolo di studio 2-8 marzo 2026</h3>
<p id="p4" data-pid="4"> 2 <a href="2026240.xhtml"><strong>Sete di verità</strong></a></p>
<p id="p13" data-pid="13">32 <a href="2026240.xhtml#p7"><strong>Studio | Parte</strong></a></p>
<p id="p14" data-pid="14" class="p14 sb"></p>`),
  'OEBPS/2026240.xhtml': page('2026240', 'Sete di verità', `<header>
<p class="contextTtl" id="p1" data-pid="1"><span id="page2" class="pageNum" data-no="2"></span><strong>2-8 MARZO 2026</strong></p>
<p id="p2" data-pid="2" class="pubRefs"><span id="pcitationsource1"></span><a href="2026240-extracted.xhtml#pcitation1"><strong>CANTICO 97</strong></a> La Parola di Dio è vita</p>
<h1 id="p3" data-pid="3"><strong>Sete di verità</strong></h1></header>
<div class="bodyTxt">
<p id="q1" class="qu"> <strong>1.</strong> Di cosa abbiamo bisogno? (<span id="citationsource1"></span><a epub:type="noteref" href="#citation1">Matteo 5:3</a>).</p>
<div class="gen-field" id="p40" data-pid="40">
<label for="tt46" id="tt44" class="dc-screenReaderText">La tua risposta</label>
<textarea id="tt46" name="textarea-4"></textarea>
</div>
<p id="p7" data-pid="7" data-rel-pid="[39]" class="p7"><span class="parNum" data-pnum="1"></span>GEOVA ci ha creati. <strong>(Leggi</strong> <span id="citationsource2"></span><strong><a epub:type="noteref" href="#citation2">vv. 21-28</a></strong><strong>.)</strong> Sua figlia “[era] indemoniata” (<a epub:type="noteref" href="#citation3">Sal. 23;</a><a epub:type="noteref" href="#citation1"> Matt. 5:3</a>).${nb}Fine.</p>
<p id="q2" class="qu"><strong>2.</strong> Cosa vedremo?</p>
<div class="gen-field" id="p42" data-pid="42"><label for="tt50" class="dc-screenReaderText">La tua risposta</label><textarea id="tt50"></textarea></div>
<p id="p8" data-pid="8" data-rel-pid="[41]" class="p8"><span class="parNum" data-pnum="2"><strong><sup>2</sup></strong></span> Vedremo <strong><em>tre</em></strong>   qualità.</p>
<h2 id="p10" data-pid="10"><strong>UN ESEMPIO</strong></h2>
<div id="f1"><figure><img src="images/2026240_univ_cnt_1.jpg" alt="Una donna" /><figcaption><p id="p74" data-pid="74" class="p74">Umiltà e fede<span id="footnotesource1"></span><a href="#footnote1">*</a></p></figcaption></figure></div>
<hr class="x"/>
</div>
<div class="blockTeach"><aside><div id="p30" data-pid="30" class="boxTtl du-x"><div><strong>COME POSSIAMO BENEFICIARE?</strong></div></div>
<div class="boxContent"><ul><li><p id="p31" data-pid="31" class="p31">  Cibo</p>
<div class="gen-field" id="p32" data-pid="32"><label for="tt27" class="dc-screenReaderText">La tua risposta</label><textarea id="tt27"></textarea></div>
</li><li><p id="p33" data-pid="33" class="p33">  Riparo</p>
<div class="gen-field" id="p34" data-pid="34"><label for="tt32" class="dc-screenReaderText">La tua risposta</label><textarea id="tt32"></textarea></div>
</li></ul></div></aside></div>
<p id="p37" data-pid="37" class="pubRefs"><a href="2026240-extracted.xhtml#pcitation2"><em>w18.06</em> 7 par. 16</a> e <a href="https://www.jw.org">sito</a></p>
<div class="groupFootnote"><div id="footnote1"><p id="p80" data-pid="80"><a href="#footnotesource1">^ </a> <strong>DESCRIZIONE.</strong> Una sorella.</p></div></div>
<div class="groupExt"><div class="groupExtScrpCite">
<aside epub:type="footnote"><div epub:type="footnote" class="extScrpCite" id="citation1"><p class="extScrpCiteTxt"><a href="#citationsource1">^ <strong>(Matt. 5:3)</strong></a> “Felici…</p></div></aside>
<aside epub:type="footnote"><div epub:type="footnote" class="extScrpCite" id="citation2"><p class="extScrpCiteTxt"><a href="#citationsource2">^ </a> <strong>(Matt. 15:21-28)</strong> Partito…</p></div></aside>
<aside epub:type="footnote"><div epub:type="footnote" class="extScrpCite" id="citation3"><p class="extScrpCiteTxt"><a href="#citationsource3">^ </a> <strong>(Sal. 23:1-6)</strong> Geova…</p></div></aside>
</div></div>`),
  'OEBPS/2026240-extracted.xhtml': page('', 'Testo estratto', `<div class="groupExt"><div class="groupExtPubRef">
<div class="extPubRef"><p><a href="2026240.xhtml#pcitationsource1">^ <span id="pcitation1"></span><strong>***sjj cantico 97 La Parola di Dio è vita***</strong></a></p><div class="bodyTxt"><p class="p4 sl">1. La Parola</p></div></div>
<div class="extPubRef"><p><a href="2026240.xhtml#pcitationsource2">^ <span id="pcitation2"></span><strong>***w18 giugno p. 7 “Il mio Regno non fa parte di questo mondo”***</strong></a></p><div class="bodyTxt"><p class="p26">16 È davvero</p></div></div>
</div></div>`),
  'OEBPS/images/2026240_univ_cnt_1.jpg': 'JPG1',
  'OEBPS/images/non-usata.jpg': 'x'.repeat(3000),
};

(async () => {
  const enc = new TextEncoder();
  const zip = await zipFiles(Object.entries(epub).map(([name, s]) => ({ name, data: enc.encode(s) })));
  const buf = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength);

  // Lettura a pezzi (Blob, richieste Range): stesse voci, e niente letture delle voci che non servono.
  const reads = [];
  const src = { size: buf.byteLength, read: async (s, e) => (reads.push([s, e]), new Uint8Array(buf.slice(s, e))) };
  const some = await unzipEntries(src, (n) => n.endsWith('.jpg') && n.includes('univ'));
  assert.deepStrictEqual(Object.keys(some), ['OEBPS/images/2026240_univ_cnt_1.jpg']);
  assert.strictEqual(new TextDecoder().decode(some['OEBPS/images/2026240_univ_cnt_1.jpg']), 'JPG1');
  assert.ok(reads.length <= 3, 'coda, al più la directory centrale, una voce');

  const docsLib = [
    { title: 'La Parola di Dio è vita', file: 'sjj_la-parola-di-dio-e-vita_1102016897' },
    { title: '“Il mio Regno non fa parte di questo mondo”', file: 'w201806_il-mio-regno_2018441', issue: '201806' },
  ];
  // Come refFinder: simbolo, poi il titolo alla fine del rimando.
  const findRef = (ref) => (docsLib.find((d) => ref.replace(/\W/g, '').endsWith(d.title.replace(/\W/g, ''))) || {}).file || null;
  const res = await convertPubEpub(src, { fileName: 'w_I_202601.epub', bible, findRef });
  assert.strictEqual(res.symbol, 'w');
  assert.strictEqual(res.issue, '202601');
  assert.strictEqual(res.title, 'La Torre di Guardia');
  assert.deepStrictEqual(res.docs.map((d) => d.rel), ['w/2026/202601/w202601_indice_2026247.md', 'w/2026/202601/w202601_sete-di-verita_2026240.md']);
  assert.deepStrictEqual(res.images, ['OEBPS/images/2026240_univ_cnt_1.jpg']);
  assert.ok(res.files['OEBPS/2026240-extracted.xhtml'], 'le xhtml vanno a epubExtras');
  assert.strictEqual(res.pubFile[0], 'w/2026/202601/w202601.md');
  assert.ok(res.pubFile[1].includes('- [[w202601_sete-di-verita_2026240|Sete di verità]]'));

  const [ind, art] = res.docs;
  assert.ok(ind.md.includes('\n# Indice\n\n### Articolo di studio 2-8 marzo 2026\n\n2 [[w202601_sete-di-verita_2026240|Sete di verità]] ^p4\n\n32 [[w202601_sete-di-verita_2026240#^p7|Studio  Parte]] ^p13\n\n ^p14\n'), ind.md);
  const md = art.md;
  assert.ok(md.startsWith('---\ntitle: "Sete di verità"\naliases:\n  - "Sete di verità"\n  - "2026240"\ntype: "document"\nbook_code: "w202601"\nissue: "202601"\npublication: "La Torre di Guardia 2026"\ndoc_class: "40"\nid: "2026240"\nbible_refs:\n  - "40005003"\n  - "40015021"\n  - "19023001"\n---\n\n**2-8 MARZO 2026** ^p1\n\n'), md);
  const body = md.split('---\n\n')[1];
  const want = [
    '**2-8 MARZO 2026** ^p1',
    '[[sjj_la-parola-di-dio-e-vita_1102016897|CANTICO 97]] La Parola di Dio è vita ^p2',
    '# Sete di verità',
    '**1.** Di cosa abbiamo bisogno? ([Matteo 5:3](jwlibrary:///finder?bible=40005003)). ^p39',
    'La tua risposta ^p40',
    `GEOVA ci ha creati. **(Leggi** [vv. 21-28](jwlibrary:///finder?bible=40015021-40015028)**.)** Sua figlia “\\[era\\] indemoniata” ([Sal. 23](jwlibrary:///finder?bible=19023001-19023006); [Matt. 5:3](jwlibrary:///finder?bible=40005003)).${nb}Fine. ^p7`,
    '**2.** Cosa vedremo? ^p41',
    'La tua risposta ^p42',
    '**<sup>2</sup>** Vedremo **_tre_** qualità. ^p8',
    '## UN ESEMPIO',
    '![[2026240_univ_cnt_1.jpg]]',
    'Umiltà e fede[^1] ^p74',
    '* * *',
    '## COME POSSIAMO BENEFICIARE?',
    ' ^p30',
    '-   Cibo ^p31\n    \n    La tua risposta ^p32\n    \n-   Riparo ^p33\n    \n    La tua risposta ^p34\n    ',
    '[[w201806_il-mio-regno_2018441#^p26|w18.06 7 par. 16]] e [sito](https://www.jw.org) ^p37',
    '[^1]: **DESCRIZIONE.** Una sorella.\n',
  ].join('\n\n');
  assert.strictEqual(body, want);
  assert.deepStrictEqual(art.anchors, [1, 2, 39, 40, 7, 41, 42, 8, 74, 30, 31, 32, 33, 34, 37, 80]);
  assert.deepStrictEqual(art.cites, [
    [39, '40005003', '40005003'],
    [7, '40015021', '40015028'],
    [7, '19023001', '19023006'],
    [7, '40005003', '40005003'],
  ]);

  // Senza Bibbia: i versetti restano testo.
  const plain = await convertPubEpub(buf, { fileName: 'w_I_202601.epub' });
  assert.ok(plain.docs[1].md.includes('**1.** Di cosa abbiamo bisogno? (Matteo 5:3). ^p39'));
  assert.ok(!plain.docs[1].md.includes('bible_refs'));
  // Libro (senza numero): cartella del simbolo, numero dal titolo solo per i periodici.
  const book = await convertPubEpub(buf, { symbol: 'lff', title: 'Puoi vivere felice' });
  assert.strictEqual(book.issue, '');
  assert.strictEqual(book.docs[1].rel, 'lff/lff_sete-di-verita_2026240.md');
  assert.strictEqual(book.pubFile[0], 'lff/lff.md');
  assert.ok(!book.docs[1].md.includes('issue:'));
  // Periodico inglese senza nome del file: numero dal titolo ("The Watchtower, January 2026").
  const zipEn = await zipFiles(Object.entries({ ...epub, 'OEBPS/content.opf': epub['OEBPS/content.opf'].replace('La Torre di Guardia, gennaio 2026', 'The Watchtower, January 2026') }).map(([name, s]) => ({ name, data: enc.encode(s) })));
  const wEn = await convertPubEpub(zipEn.buffer.slice(zipEn.byteOffset, zipEn.byteOffset + zipEn.byteLength));
  assert.strictEqual(wEn.issue, '202601');
  assert.strictEqual(wEn.title, 'The Watchtower');
  const wIt = await convertPubEpub(buf);
  assert.strictEqual(wIt.issue, '202601', 'titolo italiano');
  console.log('OK pubblicazioni dall’EPUB');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
