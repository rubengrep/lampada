// Finto modulo "obsidian" per provare il plugin in Node, senza Obsidian.
// carica(percorso) restituisce le esportazioni di main.js (predefinito: ../main.js).
const Module = require('module');
const path = require('path');

// Oggetto che accetta qualsiasi proprietà o chiamata (elementi HTML, componenti delle impostazioni…).
// Non ha "then": altrimenti sembrerebbe una Promise.
function finto() {
  const cache = {};
  return new Proxy(function () {}, {
    get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : (cache[k] ??= finto())),
    set: (t, k, v) => ((cache[k] = v), true),
    apply: () => finto(),
    construct: () => finto(),
  });
}

// Come in Obsidian, Setting ha un metodo then(): restituirlo dentro una Promise crea un ciclo infinito.
class Setting {
  constructor() {
    this.settingEl = finto();
    this.controlEl = finto();
    this.descEl = finto();
  }
  then(t) {
    t(this);
    return this;
  }
}
for (const m of ['setName', 'setDesc', 'setHeading', 'setClass', 'setTooltip', 'setDisabled']) Setting.prototype[m] = function () { return this; };
for (const m of ['addSlider', 'addToggle', 'addDropdown', 'addText', 'addTextArea', 'addButton', 'addExtraButton', 'addSearch', 'addColorPicker'])
  Setting.prototype[m] = function (cb) { cb(finto()); return this; };

class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = finto();
  }
}

const noti = {
  Setting,
  PluginSettingTab,
  Platform: { isMobile: false, isPhone: false, isDesktop: true },
  normalizePath: (p) => p,
  // Basta per il frontmatter delle prove: "chiave: valore" su ogni riga.
  parseYaml: (s) => Object.fromEntries(s.split('\n').map((l) => l.split(/:\s*/))),
  debounce: (f) => f,
  setIcon: () => {},
};
const obsidian = new Proxy(noti, { get: (t, k) => (k in t ? t[k] : class {}) });

function carica(file = path.join(__dirname, '..', 'main.js')) {
  const orig = Module._load;
  Module._load = function (req, ...r) { return req === 'obsidian' ? obsidian : orig.call(this, req, ...r); };
  global.window = global.window || { setInterval: () => 0, setTimeout, clearTimeout };
  return require(path.resolve(file));
}

module.exports = { carica, finto, obsidian };
