// Spunti per il commento: prompt rapidi, tetto delle fonti, risposta del modello → spunti con le fonti.
const assert = require('assert');
const { carica, obsidian } = require('./obsidian-finto');
const { BibleView, LibraryView, SourceList, askAboutSources, splitCited, leadText, parsePresets, suggestComments, parseOutline } = carica(process.argv[2])._test;

// Schema del libro: punti dell'elenco col primo link biblico; i numeri soli sono i capitoli (Sommario).
const schema = parseOutline(['---', 'title: x', '---', '# SOMMARIO', '-   [3](jwlibrary:///finder?bible=43003001-43003036) ^p11', '',
  '    -   Gesù e **Nicodemo** ([1-21](jwlibrary:///finder?bible=43003001-43003021)) ^p11', '        -   Nascere di nuovo ([3-8](jwlibrary:///finder?bible=43003003-43003008)) ^p12',
  '-   Fuori dal libro ([1:1](jwlibrary:///finder?bible=40001001))', '-   Senza link'].join('\n'), 43);
assert.deepStrictEqual(schema.map((o) => [o.depth, o.label, o.chapter, o.verse, o.endChapter, o.endVerse]), [
  [0, '3', 3, 1, 3, 36], [1, 'Gesù e Nicodemo (1-21)', 3, 1, 3, 21], [2, 'Nascere di nuovo (3-8)', 3, 3, 3, 8]]);

// Definizione al tocco lungo: prima riga vera dell'articolo, senza titolo, link e codici dei paragrafi.
assert.strictEqual(leadText('---\ntitle: x\n---\n\n# SPIRITO SANTO\n\nVedi [[it_spirito_1|SPIRITO]]. ^p2\n'), 'Vedi SPIRITO.');
const lead = leadText(`# Spirito\n\nIl sostantivo **ebraico** [rùach](jwlibrary:///x) e quello greco pnèuma hanno vari significati. ${'parola '.repeat(60)}^p3\n`);
assert.ok(lead.startsWith('Il sostantivo ebraico rùach e quello greco') && lead.endsWith('…') && lead.length <= 241, lead);

assert.strictEqual(parsePresets('').length, 5);
assert.deepStrictEqual(parsePresets('Breve: corto\nSenza due punti'), [{ name: 'Breve', prompt: 'corto' }, { name: 'Senza due punti', prompt: 'Senza due punti' }]);

const src = new SourceList(25);
assert.strictEqual(src.add('¶1', 'uno due tre', { par: 1 }), 'F1');
assert.strictEqual(src.add('¶2', 'testo troppo lungo per il tetto', { par: 2 }), null);
assert.strictEqual(src.add('Gv 3:16', 'Dio ha amato', { verse: {} }), 'F2');
assert.strictEqual(src.skipped, 1);
assert.strictEqual(src.add('¶1', 'uno due tre', { par: 1 }), 'F1'); // stessa fonte: stesso id

let body;
obsidian.requestUrl = async (o) => {
  body = JSON.parse(o.body);
  return { status: 200, json: { choices: [{ message: { content: 'Ecco:\n{"commenti":[{"testo":" Primo ","fonti":["F2","[F1]","F99"]},{"testo":"Secondo"}]}' } }] } };
};
(async () => {
  const list = await suggestComments(
    { settings: { openrouterKey: 'k', aiModel: '' } },
    { title: 'Art', question: '1. Domanda?', paragraphIds: ['F1'], sources: src, notes: [] },
    { name: 'Breve', prompt: 'un commento breve' }
  );
  assert.strictEqual(body.model, 'anthropic/claude-sonnet-5.5');
  assert.ok(body.messages[1].content.includes('[F2] (Gv 3:16) Dio ha amato'));
  assert.ok(body.messages[1].content.includes('RICHIESTA: un commento breve'));
  assert.strictEqual(list[0].testo, 'Primo');
  assert.deepStrictEqual(list[0].fonti.map((f) => f.id), ['F2', 'F1']);
  assert.deepStrictEqual(list[1].fonti, []);
  await suggestComments(
    { settings: { openrouterKey: 'k' } },
    { title: 'Art', question: '', paragraphIds: ['F1'], sources: src, focus: 'Dio ha amato' },
    { name: 'Breve', prompt: 'x' }
  );
  assert.ok(body.messages[1].content.includes('nessuna domanda stampata'));
  assert.ok(body.messages[1].content.includes('TESTO SELEZIONATO (i commenti partono da qui): «Dio ha amato»'));
  // Prompt caching: l'articolo (le prime `shared` fonti) va per primo, con cache_control, uguale per ogni domanda.
  const art = new SourceList();
  art.add('¶1', 'Primo paragrafo', { par: 1 });
  art.add('¶2', 'Secondo paragrafo', { par: 2 });
  art.add('Gv 3:16', 'Dio ha amato', { verse: {} });
  const bodies = [];
  for (const q of ['1. Prima domanda?', '2. Seconda domanda?']) {
    await suggestComments({ settings: { openrouterKey: 'k' } }, { title: 'Art', question: q, paragraphIds: ['F1'], sources: art, shared: 2 }, { name: 'Breve', prompt: 'x' });
    bodies.push(body);
  }
  const [c1, c2] = bodies.map((b) => b.messages[1].content);
  assert.ok(Array.isArray(c1) && c1.length === 2);
  assert.deepStrictEqual(c1[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.ok(c1[0].text.startsWith('ARTICOLO: Art') && c1[0].text.includes('[F2] (¶2) Secondo paragrafo') && !c1[0].text.includes('Gv 3:16'));
  assert.ok(c1[1].text.includes('DOMANDA DA COMMENTARE: 1. Prima domanda?') && c1[1].text.includes('[F3] (Gv 3:16) Dio ha amato'));
  assert.ok(!c1[1].text.includes('ARTICOLO:') && !c1[1].cache_control);
  assert.strictEqual(c1[0].text, c2[0].text); // stessa parte in cache per due domande diverse
  assert.ok(bodies[0].session_id && bodies[0].session_id === bodies[1].session_id);
  // Domande libere: stessa parte in cache e stesso prompt di sistema degli spunti; fonti dentro il testo.
  obsidian.requestUrl = async (o) => {
    body = JSON.parse(o.body);
    return { status: 200, json: { choices: [{ message: { content: '{"risposta":"Perché ama [F1] e salva [F3, F2].","fonti":["F1"]}' } }] } };
  };
  const ans = await askAboutSources({ settings: { openrouterKey: 'k' } }, { title: 'Art', question: '1. Prima domanda?', paragraphIds: ['F1'], sources: art, shared: 2 }, 'Perché?', [{ q: 'Chi?', a: 'Dio.' }]);
  assert.strictEqual(body.messages[0].content, bodies[0].messages[0].content);
  assert.strictEqual(body.messages[1].content[0].text, c1[0].text);
  assert.ok(body.messages[1].content[1].text.includes('DOMANDA: Perché?') && body.messages[1].content[1].text.includes('D: Chi?\nR: Dio.'));
  assert.strictEqual(ans.testo, 'Perché ama [F1] e salva [F3, F2].');
  assert.deepStrictEqual(splitCited(ans.testo, { sources: art }).map((p) => p.t || p.src.id), ['Perché ama ', 'F1', ' e salva ', 'F3', 'F2', '.']);
  obsidian.requestUrl = async (o) => {
    body = JSON.parse(o.body);
    return { status: 200, json: { choices: [{ message: { content: 'Ecco:\n{"commenti":[{"testo":" Primo ","fonti":["F2","[F1]","F99"]},{"testo":"Secondo"}]}' } }] } };
  };
  await assert.rejects(suggestComments({ settings: {} }, { title: '', question: '', paragraphIds: [], sources: src, notes: [] }, { prompt: 'x' }), /Manca la chiave/);

  // Spunti sulla Bibbia: tutto il capitolo come contesto, i versetti scelti come "paragrafi della domanda".
  const lines = new Map([[1, ['In principio']], [2, ['la terra']], [3, ['Sia la luce']]]);
  const bible = {
    byNum: new Map(),
    versesOf: (r) => [r.verse],
    refLabel: (r, vt) => `Gen ${r.chapter}${vt ? ':' + vt : r.verse ? ':' + r.verse : ''}`,
    getChapter: async () => ({ verseLines: lines }),
    verseText: (d, v) => d.verseLines.get(v).join(' '),
    docPublications: async () => new Map(),
  };
  const cites = { 3: [{ path: 'Note/Luce.md', line: 4, snippet: 'Gen 1:3 e la luce' }] };
  const view = { bible, plugin: { bible, noteIndex: { lookup: (b, c, v) => cites[v] || [] } } };
  const d = { book: { num: 1 }, chapter: 1, verseLines: lines };
  const sel = await BibleView.prototype.bibleAiCtx.call(view, d, [3], 'Gen 1:3', ' Sia  la luce ');
  assert.deepStrictEqual(sel.sources.items.map((x) => x.label), ['Gen 1:1', 'Gen 1:2', 'Gen 1:3', 'Mia nota «Luce» (cita Gen 1:3)']);
  assert.deepStrictEqual(sel.paragraphIds, ['F3']);
  assert.strictEqual(sel.question, 'Che cosa impariamo da Gen 1:3?');
  assert.strictEqual(sel.focus, 'Sia la luce');
  const cap = await BibleView.prototype.bibleAiCtx.call(view, d, null, 'Gen 1', '');
  assert.deepStrictEqual(cap.paragraphIds, ['F1', 'F2', 'F3']);
  // Gemme spirituali: i capitoli della lettura (Gen 1, con versetti 1-3) sono la parte in cache.
  const gem = await LibraryView.prototype.readingAiCtx.call(view, ['GENESI 1', '01001000'], 'Quali gemme spirituali avete trovato nella lettura?');
  assert.deepStrictEqual(gem.sources.items.slice(0, gem.shared).map((x) => x.label), ['Gen 1:1', 'Gen 1:2', 'Gen 1:3']);
  assert.ok(gem.sources.items.some((x) => x.label.startsWith('Mia nota «Luce»')));
  assert.deepStrictEqual(gem.paragraphIds, ['F1', 'F2', 'F3']);
  assert.ok(/^Quali gemme spirituali.*versetto preciso/.test(gem.question));
  console.log('OK spunti');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
