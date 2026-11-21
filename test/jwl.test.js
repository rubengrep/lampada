// Importazione e archivio dei backup JW Library (.jwlibrary).
// Con il backup del vault (o JWL_BACKUP=percorso) prova anche la lettura vera del database.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { carica } = require('./obsidian-finto');
const { unzipEntries, zipFiles, buildJwlPlan, JwlImporter } = carica(process.argv[2])._test;

(async () => {
  // zip → unzip restituisce gli stessi file
  const files = [{ name: 'a.txt', data: new TextEncoder().encode('ciao '.repeat(200)) }, { name: 'b.bin', data: new Uint8Array([0, 1, 2, 255]) }];
  const zip = await zipFiles(files);
  const back = await unzipEntries(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength));
  assert.deepStrictEqual(Object.keys(back).sort(), ['a.txt', 'b.bin']);
  assert.strictEqual(new TextDecoder().decode(back['a.txt']), 'ciao '.repeat(200));
  assert.deepStrictEqual([...back['b.bin']], [0, 1, 2, 255]);

  // sql.js incluso in main.js: si carica senza rete
  const SQL = await new JwlImporter({}).loadSqlJs();
  assert.deepStrictEqual(new SQL.Database().exec('select 1+1')[0].values, [[2]]);
  const vault = path.join(__dirname, '..', '..', '..', '..');
  const backup = process.env.JWL_BACKUP || [path.join(vault, 'Note Bibbia'), path.join(vault, 'JWSTUDY', 'Note Bibbia')]
    .map((d) => path.join(d, 'JW Library', 'backup-base.jwlibrary')).find((f) => fs.existsSync(f));
  if (!backup) return console.log('OK zip e sql.js (lettura del backup saltata: file non trovato)');
  const buf = fs.readFileSync(backup);
  const entries = await unzipEntries(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const db = Object.keys(entries).find((n) => n.endsWith('.db'));
  assert(db, 'database nel backup');
  const plan = buildJwlPlan(SQL, entries[db], { validCode: () => true, hasDoc: () => true });
  assert(plan.marks.length > 0, 'evidenziazioni lette dal backup');
  for (const m of plan.marks.slice(0, 50)) assert(m.id && m.ranges && m.ranges.length, 'evidenziazione con id e intervalli');
  console.log(`OK zip e backup: ${plan.marks.length} evidenziazioni, ${plan.docMarks.length} nelle pubblicazioni, ${plan.bookmarks.length} segnalibri`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
