// WebScript Runtime — sistema reactivo mínimo (estilo signals).
// Se incluye tal cual en el bundle final que corre en el navegador.

function createStore(initial) {
  const subscribers = new Map(); // key -> Set<effectFn>
  let currentEffect = null;

  const store = new Proxy({ ...initial }, {
    get(target, key) {
      if (currentEffect) {
        if (!subscribers.has(key)) subscribers.set(key, new Set());
        subscribers.get(key).add(currentEffect);
      }
      return target[key];
    },
    set(target, key, value) {
      target[key] = value;
      if (subscribers.has(key)) {
        subscribers.get(key).forEach((fn) => fn());
      }
      return true;
    },
  });

  function effect(fn) {
    const prev = currentEffect;
    currentEffect = fn;
    fn();
    currentEffect = prev;
  }

  return { store, effect };
}

if (typeof module !== 'undefined') {
  module.exports = { createStore };
}
