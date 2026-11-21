// Pubblica la versione di manifest.json come release di GitHub, con main.js, manifest.json e styles.css:
// da lì Obsidian (e BRAT) scaricano gli aggiornamenti.
// Prima: alza "version" in manifest.json, aggiungila a versions.json, npm run build, commit.
// Uso: npm run release -- "Cosa cambia"
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim();
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const versions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8'));

if (!versions[version]) throw new Error(`versions.json non ha la ${version}`);
if (run('git', ['status', '--porcelain'])) throw new Error('Ci sono modifiche senza commit');
run('git', ['tag', version]);
run('git', ['push', 'origin', 'HEAD', version]);
console.log(run('gh', ['release', 'create', version, 'main.js', 'manifest.json', 'styles.css', '--title', version, '--notes', process.argv[2] || '']));
