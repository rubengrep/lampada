// Finestra «Modifica» di SCRABB: legge il frontmatter e cambia solo i campi toccati.
const assert = require('assert');
const { carica } = require('./obsidian-finto');
const { ScrabbEditModal } = carica(process.argv[2])._test;

const fm = {
  tipo: 'persona',
  anno: -1767,
  anno_fine: -1657,
  corsia: 'Patriarchi',
  versetti: ['Genesi 39:2, 9', 'Genesi 45:4-8'],
  persone: ['[[Giacobbe]]'],
  luoghi: [[['Egitto']]], // [[Egitto]] senza virgolette: YAML lo legge come lista annidata
  perspicacia: '[[it_giuseppe_1200002515|Perspicacia · Giuseppe]]',
  oratore: 'Tizio',
  tags: ['scrabb/persona'],
};
const e = { name: 'Giuseppe', tipo: 'persona', file: {} };
const plugin = { app: { metadataCache: { getFileCache: () => ({ frontmatter: fm }) } } };
const m = new ScrabbEditModal(plugin, e);
const diff = () => {
  const out = m.toFm();
  return Object.keys(out).filter((k) => JSON.stringify(out[k]) !== JSON.stringify(m.init[k] ?? null));
};

assert.deepStrictEqual(m.v.from, { n: '1767', bce: true, ca: false });
assert.deepStrictEqual(m.v.links.map((l) => [l.field, l.name]), [['persone', 'Giacobbe'], ['luoghi', 'Egitto']]);
assert.deepStrictEqual(m.v.extra.map((x) => x.k), ['oratore']);
assert.deepStrictEqual(diff(), [], 'senza modifiche non si scrive niente');

m.v.from = { n: '1770', bce: true };
m.v.links = m.v.links.filter((l) => l.name !== 'Egitto');
m.v.versetti += '\nGenesi 50:19-21';
assert.deepStrictEqual(diff().sort(), ['anno', 'luoghi', 'versetti']);
assert.strictEqual(m.toFm().anno, -1770);
assert.strictEqual(m.toFm().luoghi, null, 'lista vuota = campo tolto');

m.v.to = { n: '1800', bce: true };
assert.throws(() => m.toFm(), /Fino a/);
m.v.to = { n: '', bce: true };
m.v.from = { n: '', bce: true };
assert.strictEqual(m.toFm().anno, null);
assert.strictEqual(m.toFm().approssimata, null);

m.v.extra.push({ k: 'anno', x: '3', isNew: true });
assert.throws(() => m.toFm(), /c’è già/);
m.v.extra.pop();
m.v.extra.push({ k: 'esito', x: 'da imitare', isNew: true });
m.v.extra[0].del = true;
assert.strictEqual(m.toFm().esito, 'da imitare');
assert.strictEqual(m.toFm().oratore, null);

// «ca.» per ogni data: true = tutte e due (come prima), "inizio" o "fine" = solo quella.
const { scrabbDate, scrabbApprox } = require('./obsidian-finto').carica(process.argv[2])._test;
const d = (approssimata, anno, fine) => scrabbDate({ anno, fine, approx: scrabbApprox(approssimata) });
assert.strictEqual(d(true, -647, -580), 'ca. 647–ca. 580 a.E.V.');
assert.strictEqual(d('inizio', -647, -580), 'ca. 647–580 a.E.V.');
assert.strictEqual(d('fine', -2, 32), '2 a.E.V. – ca. 32 E.V.');
assert.strictEqual(d(true, -632), 'ca. 632 a.E.V.');
assert.strictEqual(d(null, 29, 100), '29–100 E.V.');
const fm2 = { tipo: 'persona', anno: -647, anno_fine: -580, approssimata: true };
const m2 = new ScrabbEditModal({ app: { metadataCache: { getFileCache: () => ({ frontmatter: fm2 }) } } }, { name: 'Geremia', tipo: 'persona', file: {} });
assert.ok(m2.v.from.ca && m2.v.to.ca);
assert.strictEqual(m2.toFm().approssimata, true, 'true resta true');
m2.v.from.ca = false;
assert.strictEqual(m2.toFm().approssimata, 'fine');
m2.v.to.ca = false;
assert.strictEqual(m2.toFm().approssimata, null);
