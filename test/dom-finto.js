// DOMParser finto per le prove in Node: XHTML ben formato, selettori semplici ("a b", "[x]", ".c", "tag", con virgole).
const VOID = new Set(['img', 'br', 'meta', 'link', 'hr', 'input']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m));

class Node {
  constructor(tag, attrs) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.childNodes = [];
    this.parentElement = null;
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  get id() {
    return this.attrs.id || '';
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  matches(sel) {
    return sel.split(',').some((g) => {
      const parts = g.trim().split(/\s+/);
      if (!one(this, parts.pop())) return false;
      let el = this.parentElement;
      for (; parts.length && el; el = el.parentElement) if (one(el, parts[parts.length - 1])) parts.pop();
      return !parts.length;
    });
  }
  closest(sel) {
    for (let el = this; el; el = el.parentElement) if (el.matches(sel)) return el;
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => n.childNodes.forEach((c) => c.nodeType === 1 && (c.matches(sel) && out.push(c), walk(c)));
    walk(this);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  getElementById(id) {
    return this.querySelector(`[id="${id}"]`);
  }
}

// Selettore semplice: tag, [attr], [attr="v"], .classe
function one(el, s) {
  const tag = /^[a-z]\w*/i.exec(s);
  if (tag && tag[0].toUpperCase() !== el.tagName) return false;
  for (const [, k, v] of s.matchAll(/\[([\w:-]+)(?:="([^"]*)")?\]/g)) if (el.getAttribute(k) == null || (v != null && el.getAttribute(k) !== v)) return false;
  for (const [, c] of s.matchAll(/\.([\w-]+)/g)) if (!(el.getAttribute('class') || '').split(/\s+/).includes(c)) return false;
  return true;
}

class DOMParser {
  parseFromString(html) {
    const root = new Node('#document', {});
    let cur = root;
    for (const [tok] of html.matchAll(/<!--[\s\S]*?-->|<[?!][^>]*>|<\/?[a-z][^>]*>|[^<]+/gi)) {
      if (/^<[?!]/.test(tok)) continue;
      const close = /^<\/([\w:-]+)/.exec(tok);
      if (close) {
        while (cur !== root && cur.tagName !== close[1].toUpperCase()) cur = cur.parentElement;
        if (cur !== root) cur = cur.parentElement;
        continue;
      }
      const open = /^<([\w:-]+)([^>]*?)(\/?)>$/.exec(tok);
      if (!open) {
        cur.childNodes.push({ nodeType: 3, textContent: decode(tok) });
        continue;
      }
      const attrs = {};
      for (const [, k, v] of open[2].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[k] = decode(v);
      const el = new Node(open[1], attrs);
      el.parentElement = cur === root ? null : cur;
      cur.childNodes.push(el);
      if (!open[3] && !VOID.has(open[1].toLowerCase())) cur = el;
    }
    return root;
  }
}

module.exports = { DOMParser };
