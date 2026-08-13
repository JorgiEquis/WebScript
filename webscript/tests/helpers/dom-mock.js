// Mock mínimo de DOM para ejecutar un bundle.js generado por WebScript dentro de un
// test, en un contexto aislado (vm.createContext) para que no se contamine entre
// tests. Incluye las correcciones de semántica de insertBefore que encontramos
// haciendo el diffing por clave de "for": mover un nodo ya posicionado (no
// duplicarlo), y el caso especial del spec de DOM "insertBefore(nodo, nodo mismo)".

const vm = require('vm');

function makeEl(tag) {
  const el = {
    tag,
    nodeType: 1, // Node.ELEMENT_NODE, como en un DOM real
    children: [],
    attrs: {},
    listeners: {},
    _cls: [],
    _text: '',
    parentNode: null,
    get textContent() {
      return this.tag ? this.children.map(c => (c.textContent !== undefined ? c.textContent : '')).join('') : this._text;
    },
    set textContent(v) { this._text = v; },
    appendChild(c) {
      if (c.isFragment) { c.children.slice().forEach(gc => this.appendChild(gc)); return; }
      if (c.parentNode) {
        const i = c.parentNode.children.indexOf(c);
        if (i !== -1) c.parentNode.children.splice(i, 1);
      }
      c.parentNode = this;
      this.children.push(c);
    },
    insertBefore(newNode, ref) {
      if (newNode.isFragment) { newNode.children.slice().forEach(gc => this.insertBefore(gc, ref)); return; }
      // Spec de DOM: si la referencia es el propio nodo, se usa su nextSibling.
      if (ref === newNode) {
        const curIdx = this.children.indexOf(newNode);
        ref = curIdx !== -1 ? (this.children[curIdx + 1] || null) : null;
      }
      if (newNode.parentNode) {
        const oldIdx = newNode.parentNode.children.indexOf(newNode);
        if (oldIdx !== -1) newNode.parentNode.children.splice(oldIdx, 1);
      }
      newNode.parentNode = this;
      if (ref == null) { this.children.push(newNode); return; }
      const idx = this.children.indexOf(ref);
      this.children.splice(idx === -1 ? this.children.length : idx, 0, newNode);
    },
    remove() {
      if (this.parentNode) {
        const i = this.parentNode.children.indexOf(this);
        if (i !== -1) this.parentNode.children.splice(i, 1);
        this.parentNode = null;
      }
    },
    get nextSibling() {
      if (!this.parentNode) return null;
      const i = this.parentNode.children.indexOf(this);
      return this.parentNode.children[i + 1] || null;
    },
    get previousSibling() {
      if (!this.parentNode) return null;
      const i = this.parentNode.children.indexOf(this);
      return i > 0 ? this.parentNode.children[i - 1] : null;
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(ev, fn) { this.listeners[ev] = fn; },
  };
  el.classList = { add: (c) => el._cls.push(c) };
  return el;
}

function makeText(v) {
  return {
    tag: null,
    nodeType: 3, // Node.TEXT_NODE (usamos el mismo para comentarios en el mock, no importa aquí)
    _text: v,
    parentNode: null,
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; },
    remove() {
      if (this.parentNode) {
        const i = this.parentNode.children.indexOf(this);
        if (i !== -1) this.parentNode.children.splice(i, 1);
        this.parentNode = null;
      }
    },
    get nextSibling() {
      if (!this.parentNode) return null;
      const i = this.parentNode.children.indexOf(this);
      return this.parentNode.children[i + 1] || null;
    },
    get previousSibling() {
      if (!this.parentNode) return null;
      const i = this.parentNode.children.indexOf(this);
      return i > 0 ? this.parentNode.children[i - 1] : null;
    },
  };
}

function makeFragment() {
  return {
    tag: null,
    nodeType: 11, // Node.DOCUMENT_FRAGMENT_NODE, como en un DOM real
    isFragment: true,
    children: [],
    get childNodes() { return this.children; }, // alias, como en un DOM real
    parentNode: null,
    appendChild(c) { c.parentNode = this; this.children.push(c); },
    insertBefore(newNode, ref) {
      newNode.parentNode = this;
      if (ref == null) { this.children.push(newNode); return; }
      const idx = this.children.indexOf(ref);
      this.children.splice(idx === -1 ? this.children.length : idx, 0, newNode);
    },
  };
}

// Compila y ejecuta un bundle.js generado por WebScript en un contexto aislado.
// Devuelve { app, sandbox, ready } donde `app` es el elemento #app ya montado
// (tras disparar DOMContentLoaded), y `ready` es una promesa que se resuelve
// cuando el montaje (posiblemente async, en rutas dinámicas) termina.
function runBundle(bundleSource, opts = {}) {
  const appEl = makeEl('div');
  const listeners = {};
  let createTextNodeCalls = 0;

  const sandbox = {
    document: {
      createElement: (tag) => makeEl(tag),
      createTextNode: (v) => { createTextNodeCalls++; return makeText(v); },
      createComment: () => makeText(''),
      createDocumentFragment: () => makeFragment(),
      getElementById: () => appEl,
      addEventListener: (ev, fn) => { listeners[ev] = fn; },
    },
    location: opts.location || { protocol: 'http:', pathname: '/' },
    fetch: opts.fetch || (async () => ({ json: async () => ({}) })),
    console,
    setTimeout,
    Promise,
    JSON,
    Math,
  };
  vm.createContext(sandbox);
  vm.runInContext(bundleSource, sandbox, { filename: 'bundle.js' });

  const ready = Promise.resolve(listeners.DOMContentLoaded ? listeners.DOMContentLoaded() : undefined);

  return {
    app: appEl,
    sandbox,
    ready,
    getTextNodeCount: () => createTextNodeCalls,
    resetTextNodeCounter: () => { createTextNodeCalls = 0; },
  };
}

module.exports = { runBundle, makeEl, makeText, makeFragment };
