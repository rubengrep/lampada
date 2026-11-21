// Genera main.js da src/ con esbuild (scaricato da npx, niente node_modules nel vault),
// poi esegue le prove.
const { execFileSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });

run('npx', ['--yes', 'esbuild@0.28.2', 'src/main.js', '--bundle', '--format=cjs', '--platform=browser', '--target=es2020',
  '--external:obsidian', '--loader:.txt=text', '--loader:.wasm=base64', '--log-level=warning', '--outfile=main.js',
  '--banner:js=/* File generato da src/ con "npm run build": non modificarlo a mano. */']);
run('node', ['test/tutti.js']);

