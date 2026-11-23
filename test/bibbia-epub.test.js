// Bibbia dall'EPUB: un EPUB finto e piccolo (stessa struttura di quello del sito) → formato aperto → BibleData lo legge.
const assert = require('assert');
const { carica } = require('./obsidian-finto');
const { convertBibleEpub, zipFiles, parseChapterMarkdown, BibleData } = carica(process.argv[2])._test;

const page = (title, body) => `<?xml version="1.0" encoding="utf-8" ?><html><head><title>${title}</title></head><body class="pub-nwt">${body}</body></html>`;
const nb = ' ';
const epub = {
  'OEBPS/biblebooknav.xhtml': page('Libri', '<a href="biblechapternav19.xhtml">Sal.</a> <a href="1001061169.xhtml">Giuda</a>'),
  'OEBPS/biblechapternav19.xhtml': page('Salmi', '<h2><a href="biblebooknav.xhtml">Salmi</a></h2><a href="1001061123.xhtml">1</a> <a href="1001061123-split2.xhtml">2</a>'),
  'OEBPS/1001061123.xhtml': page('Salmo 1', `<p class="w_navigation w_biblebookname"><a href="biblebooknav.xhtml">Salmi</a> <a href="biblechapternav19.xhtml">1</a> : <a href="bibleversenav19_1.xhtml">1 - 2</a></p>
<p id="p2" class="p2 sw"><span id="pos10"></span>Di Davide.</p>
<p id="p3" class="p3 sl"><span id="pos20"></span><span id="chapter1"></span><span id="chapter1_verse1"></span><span class="w_ch"><strong>1</strong> </span>Felice l’uomo<span id="footnotesource1"></span><a epub:type="noteref" href="#footnote1">*</a></p>
<p class="p3 sz">che non cammina [così].</p>
<p id="p4" class="p4 sl"><span id="pos30"></span><span id="chapter1_verse2"></span>${nb}<strong><sup>2</sup></strong> Ma trova <em>piacere</em> &amp; gioia.</p>
<div class="groupFootnote"><aside epub:type="footnote"><div epub:type="footnote" id="footnote1"><p><a href="1001061123.xhtml#footnotesource1">^ <span class="footnoteref">Sal. 1:1</span></a> O “beato”. Vedi <a href="1001061169.xhtml#pos40">Gda 3</a> e <a href="1001061175.xhtml#pos9">Glossario</a>.</p></div></aside></div>`),
  'OEBPS/1001061123-split2.xhtml': page('Salmo 2', `<p class="w_navigation w_biblebookname"><a href="biblebooknav.xhtml">Salmi</a> <a href="biblechapternav19.xhtml">2</a> : <a href="bibleversenav19_2.xhtml">1</a></p>
<p class="sl"><span id="chapter2"></span><span id="chapter2_verse1"></span><span class="w_ch"><strong>2</strong> </span>Perché le nazioni sono agitate?</p>`),
  'OEBPS/1001061169.xhtml': page('Giuda', `<p class="w_navigation w_biblebookname"><a href="biblebooknav.xhtml">Giuda</a> <a href="bibleversenav65_1.xhtml">1 - 3</a></p>
<header><h1><span class="pageNum" data-no="9"></span><strong>LETTERA DI GIUDA</strong></h1></header>
<p class="sb"><span id="chapter1"></span><span id="chapter1_verse1"></span><strong><sup>1</sup></strong> Giuda, schiavo. <span id="chapter1_verse2"></span><strong><sup>2</sup></strong> Misericordia.<span id="footnotesource2"></span><a epub:type="noteref" href="#footnote2">*</a> <span id="pos40"></span><span id="chapter1_verse3"></span><strong><sup>3</sup></strong> Miei cari.</p>
<div class="groupFootnote"><aside epub:type="footnote"><div epub:type="footnote" id="footnote2"><p><a href="1001061169.xhtml#footnotesource2">^ <span class="footnoteref">Gda 2</span></a> Vedi <a href="1001061123.xhtml#pos30">Sal 1:2, 3</a>.</p></div></aside></div>`),
  // Voce che non serve: non va letta.
  'OEBPS/images/grande.jpg': 'x'.repeat(5000),
};

(async () => {
  const enc = new TextEncoder();
  const zip = await zipFiles(Object.entries(epub).map(([name, s]) => ({ name, data: enc.encode(s) })));
  const out = await convertBibleEpub(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength), { title: 'Bibbia', lang: 'I' });
  const idx = JSON.parse(out.get('index/nwt.json'));
  assert.strictEqual([...out.keys()].pop(), 'index/nwt.json', "l'indice si scrive per ultimo");
  assert.deepStrictEqual(Object.keys(idx.books), ['19', '65']);
  assert.deepStrictEqual(idx.books[19], { file: 'salmi', rel: 'nwt/Libri/Salmi/salmi.md', title: 'Salmi', slug: 'salmi', abbr: 'Sal.', chapters: [1, 2], versesFile: 'nwt/Libri/Salmi/salmi.versi.json', chapterName: 'Salmo' });
  assert.strictEqual(idx.books[65].abbr, 'Giuda');
  assert.deepStrictEqual(Object.keys(idx.verses).sort(), ['19001000', '19001001', '19001002', '19002001', '65001001', '65001002', '65001003']);

  const ps = out.get('nwt/Libri/Salmi/salmi_1.md');
  assert.ok(ps.includes('\n\nDi Davide.\n\n**[1](jwlibrary:///finder?bible=19001001)** Felice l’uomo[^1]\n\nche non cammina \\[così\\].\n\n'), 'soprascritta, primo versetto, riga poetica');
  assert.ok(ps.includes(`\n${nb}**[2](jwlibrary:///finder?bible=19001002)** Ma trova _piacere_ & gioia.\n`), 'poesia con lo spazio non separabile');
  assert.ok(ps.includes('[^1]: O “beato”. Vedi [Gda 3](jwlibrary:///finder?bible=65001003) e Glossario.'), 'link a un versetto nella nota; gli altri link restano testo');
  const d = parseChapterMarkdown(ps);
  assert.strictEqual(d.verseLines.get(1).join(' '), 'Felice l’uomo che non cammina [così].');
  assert.strictEqual(d.footnotes[1].slice(0, 8), 'O “beato');
  const gda = out.get('nwt/Libri/Giuda/giuda_1.md');
  assert.ok(gda.includes('\n\n# LETTERA DI GIUDA\n\n'));
  assert.ok(gda.includes('[^2]: Vedi [Sal 1:2, 3](jwlibrary:///finder?bible=19001002-19001003).'), 'intervallo dal testo del link');
  assert.deepStrictEqual(JSON.parse(out.get('nwt/Libri/Giuda/giuda.versi.json')).verses, {
    '1:2': { code: '65001002', sections: [{ title: 'Note in calce', md: '- Vedi [Sal 1:2, 3](jwlibrary:///finder?bible=19001002-19001003).' }] },
  });

  // BibleData legge la Bibbia convertita (senza note di studio né riferimenti a margine).
  const disco = new Map([...out].map(([p, s]) => [`.lampada/markdown/${p}`, s]));
  const list = async (dir) => {
    const files = [];
    const folders = new Set();
    for (const p of disco.keys()) {
      if (!p.startsWith(`${dir}/`)) continue;
      const r = p.slice(dir.length + 1).split('/');
      if (r.length === 1) files.push(p);
      else folders.add(`${dir}/${r[0]}`);
    }
    return { files, folders: [...folders] };
  };
  const adapter = { list, exists: async (p) => disco.has(p), read: async (p) => disco.get(p), stat: async () => null };
  const settings = { rootFolder: '.lampada/markdown', symbol: 'nwt', expandBookName: true };
  const plugin = { settings, saveAll: async () => {}, app: { vault: { adapter, getName: () => 'prova', getAbstractFileByPath: () => null }, metadataCache: { getFirstLinkpathDest: () => null } } };
  const bible = new BibleData(plugin);
  await bible.load();
  assert.strictEqual(bible.title, 'Bibbia');
  assert.deepStrictEqual(bible.parseReference('Sl 1:2'), { book: 19, chapter: 1, verse: 2 });
  assert.deepStrictEqual(bible.parseReference('Gda 3'), { book: 65, chapter: 1, verse: 3 });
  assert.strictEqual(bible.refLabel({ book: 19, chapter: 1, verse: 2 }), 'Salmo 1:2');
  const ch = await bible.getChapter(19, 1);
  assert.strictEqual(bible.verseText(ch, 2), 'Ma trova _piacere_ & gioia.');
  const det = await bible.getVerseDetails(bible.byNum.get(65), 1, 2);
  assert.deepStrictEqual(det.sections.map((s) => s.title), ['Note in calce']);
  assert.deepStrictEqual((await bible.getVerseDetails(bible.byNum.get(65), 1, 3)).sections, []);

  // Altra lingua: abbreviazioni dell'EPUB, niente alias italiani.
  const idxE = JSON.parse(disco.get('.lampada/markdown/index/nwt.json'));
  idxE.lang = 'E';
  disco.set('.lampada/markdown/index/nwt.json', JSON.stringify(idxE));
  const bibleE = new BibleData(plugin);
  await bibleE.load();
  assert.strictEqual(bibleE.byNum.get(19).abbr, 'Sal');
  assert.strictEqual(bibleE.parseReference('sl 1:1'), null, 'alias italiani solo per la Bibbia italiana');
  // Bibbia inglese: abbreviazioni inglesi comuni, anche nei riferimenti scritti a mano.
  assert.deepStrictEqual(bibleE.parseReference('ps 1:2'), { book: 19, chapter: 1, verse: 2 });
  assert.deepStrictEqual(bibleE.parseReference('Jude 3'), { book: 65, chapter: 1, verse: 3 });
  assert.deepStrictEqual(bibleE.scanLine('See Ps 1:2.', true).map((h) => [h.kind, h.ref.book, h.verses]), [['plain', 19, [2]]]);
  assert.strictEqual(bibleE.scanLine('see ps 1:2.', true).length, 0, 'abbreviazione breve: solo con la maiuscola');
  console.log('OK Bibbia dall’EPUB');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
