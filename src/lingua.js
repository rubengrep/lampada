/* ------------------------------------------------------------------ */
/* Lingua dell'interfaccia e dei contenuti                             */
/* ------------------------------------------------------------------ */
// I testi si scrivono in italiano nel codice, dentro t(): t('Apri') → 'Open' in inglese. La chiave è il testo
// italiano; se manca la traduzione resta l'italiano. Per un'altra lingua: un file in lingue/ come en.js, poi in DICTS.
// Le estensioni aggiungono i loro testi con addStrings(lingua, { italiano: traduzione }).
import * as obsidian from 'obsidian';
import en from './lingue/en.js';

const DICTS = { it: {}, en };
// Lingue dell'interfaccia: codice → nome (impostazioni).
const UI_LANGS = { it: 'Italiano', en: 'English' };
let cur = 'it';

/** Lingua di Obsidian ("it", "en"…): getLanguage() dalla 1.8.7, prima localStorage (vuoto = inglese). */
function obsidianLang() {
  try {
    const l = obsidian.getLanguage();
    if (typeof l === 'string' && l) return l;
  } catch (e) { /* Obsidian vecchio */ }
  try {
    return window.localStorage.getItem('language') || 'en';
  } catch (e) {
    return 'en';
  }
}

/** Sceglie la lingua: 'auto' (o vuoto) = quella di Obsidian; una lingua senza traduzioni → inglese. */
function setLang(choice) {
  const l = String(!choice || choice === 'auto' ? obsidianLang() : choice).slice(0, 2).toLowerCase();
  cur = DICTS[l] ? l : 'en';
  return cur;
}

const lang = () => cur;
const addStrings = (l, d) => Object.assign((DICTS[l] ??= {}), d);

/** Testo nella lingua scelta; {nome} si sostituisce con vars.nome. */
function t(s, vars) {
  const r = DICTS[cur][s] ?? s;
  return vars ? r.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : r;
}

// Date, numeri e confronti nella lingua scelta. Crearli costa (~50 µs l'uno, 30 volte un confronto con il collatore
// già pronto): negli elenchi e negli ordinamenti si sommano, quindi si creano una volta e si riusano.
const intlCache = new Map();
function intl(Kind, opts = {}) {
  const k = `${cur}|${Kind.name}|${JSON.stringify(opts)}`;
  let f = intlCache.get(k);
  if (!f) intlCache.set(k, (f = new Kind(cur, opts)));
  return f;
}
/** Confronto per ordinare testi (maiuscole e accenti non contano). */
const compare = (a, b) => intl(Intl.Collator, { sensitivity: 'base' }).compare(a, b);
/** Data nella lingua scelta: formatDate(d, { month: 'long', year: 'numeric' }). */
const formatDate = (d, opts) => intl(Intl.DateTimeFormat, opts).format(d);

// Lingua dei contenuti (Bibbia e pubblicazioni scaricate): codice del sito (settings.bibleLang) → codice ISO.
const JW_LANGS = { I: 'it', E: 'en', F: 'fr', S: 'es', X: 'de', T: 'pt' };
const contentLang = (settings) => JW_LANGS[(settings && settings.bibleLang) || 'I'] || 'it';

export { UI_LANGS, JW_LANGS, addStrings, compare, contentLang, formatDate, intl, lang, setLang, t };
