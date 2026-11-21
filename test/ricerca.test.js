// Chiedi alla biblioteca: parole e radici, indice a pezzi, punteggio, e il giro dell'AI con gli strumenti.
const assert = require('assert');
const { carica, obsidian } = require('./obsidian-finto');
const { IndexBuilder, IndexReader, notePars, paragraphsOf, stem, terms, askLibrary } = carica(process.argv[2])._test;

// Stessa radice per forme diverse; accenti, parole vuote e numeri corti via.
assert.strictEqual(stem('perdonare'), stem('perdono'));
assert.strictEqual(stem('perdonati'), stem('perdono'));
assert.strictEqual(stem('amico'), stem('amiche'));
assert.deepStrictEqual(terms('La carità di Geova è grande, 12 volte nel 1914'), ['carit', 'geov', 'grand', 'volt', '1914']);

const nota = `# Titolo\n\n**1.** Perché perdonare? ^p1\n\nLa tua risposta ^p2\n\n**<sup>1</sup>** Geova ci [perdona](jwlibrary:///x) e anche noi perdoniamo gli altri di cuore. ^p3\n\nSenza codice\n\n![[img.jpg]]\n\nUn'altra riga su ansia e preoccupazioni della vita ^p5`;
assert.deepStrictEqual(paragraphsOf(nota).map((p) => p.pid), [1, 2, 3, 5]);

// Note tue (cartelle in più): blocchi tra righe vuote, pid = riga d'inizio, senza frontmatter.
const mia = `---\ntags: [x]\n\nfoo: 1\n---\n# Discorso\n\nPrimo punto sul perdono\ndi Geova verso di noi\n\n\nSecondo punto: ansia e preghiera sincera`;
assert.deepStrictEqual(notePars(mia).map((p) => p.pid), [5, 7, 11]);
assert.strictEqual(notePars(mia)[1].md, 'Primo punto sul perdono\ndi Geova verso di noi');

const b = new IndexBuilder();
assert.strictEqual(b.addDoc('a', nota), 2); // "Perché perdonare?" e "La tua risposta" sono troppo corti
b.addDoc('b', 'Il perdono di Geova è completo, perdono vero e sincero ^p7\n\nAnsia ansia ansia: come vincere ansia ^p8');
b.addDoc('vuoto', 'niente ^p1');
assert.strictEqual(b.addDoc('Studio/discorso.md', mia, { plain: true }), 2); // il titolo è troppo corto
const out = b.finish({ built: 1 });
assert.deepStrictEqual(out.meta.docs, ['a', 'b', 'Studio/discorso.md']);
const reader = new IndexReader(out.meta, out.pars, async (k) => out.shards.get(k) || null);
(async () => {
  const r = await reader.search('perdonare');
  // "perdona" e "perdoniamo" hanno la stessa radice: due volte in un paragrafo più corto vince.
  assert.deepStrictEqual(r.map((x) => `${x.doc}#${x.pid}`).filter((k) => !k.startsWith('Studio')), ['a#3', 'b#7']);
  assert.ok(r.some((x) => x.doc === 'Studio/discorso.md' && x.pid === 7));
  assert.deepStrictEqual((await reader.search('ansia', { docFilter: (d) => !d.includes('/') })).map((x) => `${x.doc}#${x.pid}`), ['b#8', 'a#5']);
  assert.deepStrictEqual((await reader.search('preoccup*')).map((x) => `${x.doc}#${x.pid}`), ['a#5']);
  assert.deepStrictEqual((await reader.search('ansia', { docFilter: (d) => d === 'a' })).map((x) => x.pid), [5]);
  assert.deepStrictEqual(await reader.search('zzzz'), []);

  // L'AI chiede una ricerca, riceve le fonti [F1]…, poi risponde citandole.
  const bodies = [];
  const replies = [
    { tool_calls: [{ id: 't1', type: 'function', function: { name: 'cerca', arguments: '{"parole":"perdono"}' } }], content: null },
    { content: 'Geova perdona davvero [F1].' },
  ];
  obsidian.requestUrl = async (o) => {
    bodies.push(JSON.parse(o.body));
    return { status: 200, json: { choices: [{ message: replies.shift() }] } };
  };
  const plugin = {
    settings: { openrouterKey: 'k' },
    librarySearch: {
      search: async (list, words) => {
        assert.strictEqual(words, 'perdono');
        return [list.add('«Perdono» ¶7', '(Torre di Guardia) Il perdono di Geova è completo', { cite: 'b', par: 7 })];
      },
    },
  };
  const chat = {};
  const steps = [];
  const r2 = await askLibrary(plugin, chat, 'Geova perdona?', (s) => steps.push(s));
  assert.strictEqual(r2.testo, 'Geova perdona davvero [F1].');
  assert.deepStrictEqual(steps, ['Cerco: perdono']);
  assert.strictEqual(bodies[0].tools.length, 2);
  const tool = bodies[1].messages.find((m) => m.role === 'tool');
  assert.strictEqual(tool.tool_call_id, 't1');
  assert.ok(tool.content.startsWith('[F1] «Perdono» ¶7 (Torre di Guardia) Il perdono'), tool.content);
  // La conversazione continua: stessi messaggi e stesse fonti.
  assert.strictEqual(chat.ctx.messages.length, 4);
  assert.strictEqual(chat.ctx.sources.items.length, 1);
  console.log('ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
