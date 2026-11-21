// Vista unica: una cronologia sola per Bibbia, Biblioteca, SCRABB e Chiedi. Indietro torna dove si era,
// anche da una sezione all'altra, e il passo fatto arrivando in una sezione non conta due volte.
const assert = require('assert');
const { carica } = require('./obsidian-finto');
const { LampadaView } = carica(process.argv[2])._test;

// Sezione finta: pagina attuale, navigate che (come le vere) mette da parte dove era, restore senza cronologia.
function sezione(area, page, shell) {
  return {
    shellArea: area,
    page,
    containerEl: { toggle() {} },
    getDisplayText: () => page,
    snapshot() {
      return { page: this.page };
    },
    async navigate(p) {
      shell.push(this, this.snapshot());
      this.page = p;
    },
    async restore(s) {
      this.page = s.page;
    },
  };
}

const shell = new LampadaView({}, { ui: {}, requestSave() {} });
shell.leaf = {};
shell.app = { workspace: { requestSaveLayout() {} } };
shell.hostEl = {};
for (const [a, p] of [['lib', 'home'], ['bible', 'Gv 3'], ['scrabb', 'Davide']]) shell.sections.set(a, sezione(a, p, shell));
const where = () => `${shell.area}:${shell.current().page}`;

(async () => {
  await shell.show('lib', { push: false });
  await shell.go('lib', (v) => v.navigate('A')); // dentro la biblioteca
  await shell.go('bible'); // cambio sezione
  await shell.go('bible', (v) => v.navigate('Gv 4'));
  await shell.go('lib', (v) => v.navigate('B')); // dalla Bibbia un paragrafo della biblioteca
  assert.strictEqual(where(), 'lib:B');
  const back = [];
  while (shell.stack.length) {
    await shell.goBack();
    back.push(where());
  }
  assert.deepStrictEqual(back, ['bible:Gv 4', 'bible:Gv 3', 'lib:A', 'lib:home']);
  await shell.goBack(); // niente più: resta dov'è
  assert.strictEqual(where(), 'lib:home');

  // Una sezione che non si vede non scrive nella cronologia.
  shell.push(shell.sections.get('scrabb'), { page: 'x' });
  assert.strictEqual(shell.stack.length, 0);
  console.log('ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
