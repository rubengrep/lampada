// Esegue tutte le prove, ognuna in un processo a parte con un tempo massimo
// (così anche un ciclo infinito, come quello delle impostazioni, viene preso come errore).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let failed = 0;
for (const f of fs.readdirSync(__dirname).filter((x) => x.endsWith('.test.js')).sort()) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8', timeout: 30000 });
  const ok = r.status === 0;
  if (!ok) failed++;
  const out = (r.stdout + r.stderr).trim().split('\n').filter((l) => !l.startsWith('[lampada]') && !/^\s+at /.test(l));
  console.log(`${ok ? '✓' : '✗'} ${f}${r.error && r.error.code === 'ETIMEDOUT' ? ' (tempo scaduto: blocco?)' : ''}${ok ? '' : '\n   ' + out.slice(-6).join('\n   ')}`);
}
if (failed) {
  console.error(`${failed} prove non riuscite`);
  process.exit(1);
}
