// Importazione e archivio dei backup JW Library (.jwlibrary).
// Con il backup del vault (o JWL_BACKUP=percorso) prova anche la lettura vera del database.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { carica } = require('./obsidian-finto');
const { unzipEntries, zipFiles, buildJwlPlan, JwlImporter, jwlNoteBlock, parseJwlBlocks, sameNoteTitle, langOfMeps, mepsOf } = carica(process.argv[2])._test;

// Titolo lungo: all'importazione si taglia a 160 caratteri; se il taglio finisce con uno spazio, all'esportazione
// il titolo intero del backup deve restare (prima veniva sostituito da quello tagliato).
{
  const long = 'Così Giuseppe fece stabilire suo padre e i suoi fratelli in Egitto e diede loro una proprietà nella parte migliore del paese, nel paese di Ràmses, proprio come il faraone aveva comandato.  12 E Giuseppe continuò';
  const md = jwlNoteBlock({ title: long, content: 'x', tags: [], guid: 'ABCDEF12-3456' });
  const [blk] = parseJwlBlocks(md);
  assert.ok(blk.title.endsWith('proprio come'), blk.title);
  assert.ok(sameNoteTitle(blk.title, long));
  assert.ok(sameNoteTitle('Nota', ''));
  assert.ok(!sameNoteTitle('Altro titolo', long));
}

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

  // Backup neutro rispetto alla lingua: ogni evidenziazione porta la sua (Location.MepsLanguage: 4 = I, 0 = E).
  assert.deepStrictEqual([langOfMeps(4), langOfMeps(null), langOfMeps(0), langOfMeps(7)], [undefined, undefined, 'E', 'meps7']);
  assert.deepStrictEqual([mepsOf(undefined), mepsOf('E'), mepsOf('meps7')], [4, 0, 7]);
  // Cartella principale in inglese (Bibbia inglese scaricata con le versioni di prima): lì niente `lang`, l'italiano ha 'I'.
  assert.deepStrictEqual([langOfMeps(0, 'E'), langOfMeps(4, 'E'), langOfMeps(null, 'E')], [undefined, 'I', undefined]);
  assert.deepStrictEqual([mepsOf(undefined, 'E'), mepsOf('I', 'E')], [0, 4]);
  {
    const d = new SQL.Database();
    d.run(`CREATE TABLE Location (LocationId INTEGER PRIMARY KEY, BookNumber, ChapterNumber, DocumentId, IssueTagNumber, KeySymbol, MepsLanguage, Type, Title);
      CREATE TABLE UserMark (UserMarkId INTEGER PRIMARY KEY, ColorIndex, LocationId, UserMarkGuid);
      CREATE TABLE BlockRange (BlockType, Identifier, StartToken, EndToken, UserMarkId);
      CREATE TABLE Tag (TagId, Name); CREATE TABLE TagMap (TagId, NoteId);
      CREATE TABLE Bookmark (LocationId, BlockType, BlockIdentifier);
      CREATE TABLE Note (NoteId, Guid, Title, Content, LastModified, BlockType, BlockIdentifier, LocationId, UserMarkId);
      INSERT INTO Location VALUES (1, 43, 3, NULL, 0, 'nwtsty', 4, 0, NULL), (2, 43, 3, NULL, 0, 'nwt', 0, 0, NULL),
        (3, NULL, NULL, 1102021, 0, 'lff', 4, 0, NULL), (4, NULL, NULL, 1102021, 0, 'lff', 0, 0, NULL);
      INSERT INTO UserMark VALUES (1, 1, 1, 'bi'), (2, 2, 2, 'be'), (3, 1, 3, 'di'), (4, 3, 4, 'de');
      INSERT INTO BlockRange VALUES (2, 16, 0, 3, 1), (2, 16, 0, 2, 2), (1, 5, 0, 4, 3), (1, 5, 1, 6, 4);`);
    const bytes = d.export();
    // Biblioteca italiana aperta senza quel documento: si salta solo l'evidenziazione italiana del documento.
    const p = buildJwlPlan(SQL, bytes, { validCode: () => true, hasDoc: () => false, lang: undefined });
    assert.deepStrictEqual(p.marks.map((m) => [m.id, m.lang]), [['bi', undefined], ['be', 'E']]);
    assert.deepStrictEqual(p.docMarks.map((m) => [m.id, m.lang, m.loc.lang]), [['de', 'E', 0]]);
    const p2 = buildJwlPlan(SQL, bytes, { validCode: () => true, hasDoc: () => true });
    assert.deepStrictEqual(p2.docMarks.map((m) => m.id), ['di', 'de']);
  }
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
