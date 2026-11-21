
const VIEW_TYPE = 'lampada';
// Indici delle pubblicazioni nel formato aperto (<cartella>/index/<simbolo>.json; prima "Indici", ancora letto).
const INDEX_MIRROR = 'index';
// Dati che il plugin ricava da solo (campi risposta, adunanze, copertine, indice di Chiedi…): nascosti, si rigenerano.
const DATA_DIR = '.lampada/data';

const DEFAULT_SETTINGS = {
  // Pubblicazioni nel formato aperto (Markdown e Indici/*.json): cartella nascosta, Obsidian non le indicizza.
  rootFolder: '.lampada/markdown',
  symbol: 'nwtsty',
  // Lingua della Bibbia scaricata dall'EPUB (codice del sito: I, E…).
  bibleLang: 'I',
  fontSize: 19,
  lineHeight: 1.75,
  fontFamily: 'atkinson',
  showStudyMarkers: true,
  showRefMarkers: true,
  notesFolder: 'Note Bibbia',
  insertTemplate: '> [!quote] {{link}}\n> {{text}}\n',
  readerLocation: 'tab',
  leftTab: true,
  clickAction: 'reader',
  hoverPreview: true,
  expandBookName: true,
  suggestTrigger: '@',
  openAfterCite: false,
  autoHideBars: true,
  detectPlainRefs: true,
  showCiteMarkers: true,
  scrabbFolder: 'SCRABB',
  scrabbTrigger: '++',
  openrouterKey: '',
  aiModel: '',
  // Prompt rapidi: [{ name, prompt }]; vuoto = quelli predefiniti.
  aiPresets: '',
  aiInstructions: '',
  // Cartelle di note in cui cerca anche Chiedi, una per riga.
  chatFolders: '',
  pageMode: 'scroll',
  readingTheme: 'auto',
  margins: 'normal',
  justify: false,
  // Vista unica (guscio): Bibbia, Biblioteca, SCRABB e Chiedi in una sola scheda.
  appShell: true,
};

// Abbreviazioni usate in JW Library (italiano), indicizzate per numero di libro - 1.
const BOOK_ABBR = [
  'Ge', 'Eso', 'Le', 'Nu', 'De', 'Gsè', 'Gdc', 'Ru', '1Sa', '2Sa', '1Re', '2Re', '1Cr', '2Cr',
  'Esd', 'Ne', 'Est', 'Gb', 'Sl', 'Pr', 'Ec', 'Ca', 'Isa', 'Ger', 'La', 'Ez', 'Da', 'Os', 'Gle',
  'Am', 'Abd', 'Gna', 'Mic', 'Na', 'Aba', 'Sof', 'Ag', 'Zac', 'Mal',
  'Mt', 'Mr', 'Lu', 'Gv', 'At', 'Ro', '1Co', '2Co', 'Gal', 'Ef', 'Flp', 'Col', '1Ts', '2Ts',
  '1Tm', '2Tm', 'Tit', 'Flm', 'Eb', 'Gc', '1Pt', '2Pt', '1Gv', '2Gv', '3Gv', 'Gda', 'Ri',
];

// Alias aggiuntivi accettati in "Vai a…" (chiavi già normalizzate, senza spazi/accenti).
const EXTRA_ALIASES = {
  ge: 1, gen: 1, es: 2, eso: 2, lev: 3, num: 4, deut: 5, dt: 5, gs: 6, gios: 6, giud: 7,
  sal: 19, salmo: 19, prov: 20, eccl: 21, qo: 21, cant: 22, is: 23, lam: 25, dan: 27,
  mc: 41, lc: 42, ac: 44, at: 44, ap: 66, apoc: 66, apocalisse: 66, riv: 66,
  levit: 3, giob: 18, ecc: 21, ezec: 26, nee: 16, abac: 35, matt: 40, mar: 41, giov: 43,
  rom: 45, efes: 49, filip: 50, ebr: 58, giac: 59,
  '1sam': 9, '2sam': 10, '1cron': 13, '2cron': 14, '1cor': 46, '2cor': 47, '1tess': 52, '2tess': 53,
  '1tim': 54, '2tim': 55, '1piet': 60, '2piet': 61, '1pie': 60, '2pie': 61, '1giov': 62, '2giov': 63, '3giov': 64,
  '1gio': 62, '2gio': 63, '3gio': 64, gio: 43,
};

const CATEGORIES = [
  { from: 1, to: 5, id: 'pent', label: 'Pentateuco' },
  { from: 6, to: 17, id: 'hist', label: 'Libri storici' },
  { from: 18, to: 22, id: 'poet', label: 'Libri poetici' },
  { from: 23, to: 39, id: 'proph', label: 'Libri profetici' },
  { from: 40, to: 44, id: 'gosp', label: 'Vangeli e Atti' },
  { from: 45, to: 65, id: 'lett', label: 'Lettere' },
  { from: 66, to: 66, id: 'rev', label: 'Profezia' },
];

const HIGHLIGHTS = [
  { id: 'yellow', label: 'Giallo' },
  { id: 'green', label: 'Verde' },
  { id: 'blue', label: 'Blu' },
  { id: 'pink', label: 'Rosa' },
  { id: 'orange', label: 'Arancione' },
  { id: 'purple', label: 'Viola' },
];

const FONT_CHOICES = [
  ['atkinson', 'Atkinson Hyperlegible (massima leggibilità)'],
  ['merriweather', 'Merriweather (serif da schermo)'],
  ['literata', 'Literata (serif da libro)'],
  ['serif', 'Serif di sistema'],
  ['sans', 'Sans-serif'],
  ['theme', 'Carattere del tema'],
];

const SECTION_ORDER = ['Approfondimenti', 'Note in calce', 'Riferimenti', 'Media', 'Citato in'];
// Sezioni del pannello del versetto (chiave → nome mostrato, uguale ovunque), nell'ordine predefinito; l'utente lo cambia
// (settings.paneOrder). Le chiavi restano quelle vecchie: le usano paneOrder, ui.collapsed e ui.paneTabs.
const PANE_SECTIONS = [
  ['Note', 'Note JW Library'],
  ['Approfondimenti', 'Approfondimenti'],
  ['Note in calce', 'Note in calce'],
  ['Riferimenti', 'Riferimenti'],
  ['Bibbia con riferimenti', 'Rbi8'],
  ['Nelle mie note', 'Nelle mie note'],
  ['Media', 'Media'],
  ['Citato in', 'Citato in'],
  ['SCRABB', 'SCRABB'],
];
const PANE_LABELS = new Map(PANE_SECTIONS);
/** Nome mostrato di una sezione del pannello (chiave di PANE_SECTIONS, o il titolo così com'è). */
const paneLabel = (title) => PANE_LABELS.get(title) || title;
/** Ordine delle sezioni del pannello: quello scelto (settings.paneOrder), le sezioni che mancano in fondo. */
function paneOrder(settings) {
  const all = PANE_SECTIONS.map(([t]) => t);
  const saved = ((settings && settings.paneOrder) || []).filter((t) => all.includes(t));
  return [...saved, ...all.filter((t) => !saved.includes(t))];
}

export { VIEW_TYPE, INDEX_MIRROR, DATA_DIR, DEFAULT_SETTINGS, BOOK_ABBR, EXTRA_ALIASES, CATEGORIES, HIGHLIGHTS, FONT_CHOICES, SECTION_ORDER, PANE_SECTIONS, paneOrder, paneLabel };
