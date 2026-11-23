// Pubblica la versione di manifest.json come release di GitHub, con main.js, manifest.json e styles.css:
// da lì Obsidian (e BRAT) scaricano gli aggiornamenti. Le note della release sono la sezione della versione in CHANGELOG.md.
// Prima: alza "version" in manifest.json, aggiungila a versions.json, scrivi "## <versione> — <data>" in CHANGELOG.md,
// npm run build, commit.
// Uso: npm run release
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim();
const { id, version } = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const versions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8'));

if (!versions[version]) throw new Error(`versions.json non ha la ${version}`);
const log = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const sec = log.split(/^## /m).find((s) => s.startsWith(`${version} `) || s.startsWith(`${version}\n`));
const notes = sec && sec.split('\n').slice(1).join('\n').trim();
if (!notes) throw new Error(`CHANGELOG.md non ha la sezione "## ${version}"`);
// Le novità non parlano delle estensioni private: parole vietate, una per riga, in .parole-private (solo in locale).
const vietate = fs.existsSync(path.join(root, '.parole-private')) ? fs.readFileSync(path.join(root, '.parole-private'), 'utf8').split('\n').map((w) => w.trim().toLowerCase()).filter(Boolean) : [];
const trovata = vietate.find((w) => notes.toLowerCase().includes(w));
if (trovata) throw new Error(`Le novità della ${version} contengono «${trovata}» (.parole-private)`);
if (run('git', ['status', '--porcelain'])) throw new Error('Ci sono modifiche senza commit');
run('git', ['tag', version]);
run('git', ['push', 'origin', 'HEAD', version]);
console.log(run('gh', ['release', 'create', version, 'main.js', 'manifest.json', 'styles.css', '--title', version, '--notes', notes]));
