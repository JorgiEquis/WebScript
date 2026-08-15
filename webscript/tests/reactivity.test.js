const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { compileSource } = require('./helpers/compile-helper');
const { runBundle } = require('./helpers/dom-mock');
const { createStore } = require('../src/runtime/reactive');

describe('runtime/reactive.js: reactividad profunda (aislado, sin compilador)', () => {
  test('mutar una propiedad anidada dispara el efecto que la lee', () => {
    const { store: state, effect } = createStore({ datos: { edad: 25 } });
    let renders = 0;
    effect(() => { renders++; return state.datos.edad; });
    state.datos.edad = 99;
    assert.equal(renders, 2);
  });

  test('mutar un campo HERMANO que el efecto nunca leyó NO lo re-ejecuta', () => {
    const { store: state, effect } = createStore({ datos: { edad: 25, nombre: 'Ana' } });
    let renders = 0;
    effect(() => { renders++; return state.datos.edad; });
    state.datos.nombre = 'Bea';
    assert.equal(renders, 1, 'no debe re-ejecutarse por un campo que nunca leyó');
  });

  test('mutar la misma propiedad no dispara el efecto DOS veces', () => {
    const { store: state, effect } = createStore({ datos: { edad: 25 } });
    let renders = 0;
    effect(() => { renders++; return state.datos.edad; });
    state.datos.edad = 99;
    assert.equal(renders, 2, 'exactamente un render extra, no dos');
  });

  test('un efecto que lee el objeto entero (JSON.stringify) SÍ se entera de cambios en un campo, sin mecanismo de ancestros', () => {
    const { store: state, effect } = createStore({ datos: { a: 1, b: 2 } });
    let renders = 0;
    let last;
    effect(() => { renders++; last = JSON.stringify(state.datos); });
    state.datos.a = 100;
    assert.equal(renders, 2);
    assert.equal(last, '{"a":100,"b":2}');
  });

  test('array.push() dispara el efecto', () => {
    const { store: state, effect } = createStore({ lista: [1, 2, 3] });
    let renders = 0;
    effect(() => { renders++; return state.lista.length; });
    state.lista.push(4);
    assert.equal(renders, 2);
  });

  test('índice de array directo dispara el efecto', () => {
    const { store: state, effect } = createStore({ lista: [1, 2, 3] });
    let renders = 0;
    effect(() => { renders++; return state.lista[0]; });
    state.lista[0] = 99;
    assert.equal(renders, 2);
  });

  test('mutación a 3 niveles de profundidad dispara el efecto', () => {
    const { store: state, effect } = createStore({ empresa: { direccion: { ciudad: 'Madrid' } } });
    let renders = 0;
    effect(() => { renders++; return state.empresa.direccion.ciudad; });
    state.empresa.direccion.ciudad = 'Valencia';
    assert.equal(renders, 2);
  });

  test('reasignación completa sigue funcionando (retrocompatibilidad)', () => {
    const { store: state, effect } = createStore({ contador: 0 });
    let renders = 0;
    effect(() => { renders++; return state.contador; });
    state.contador = 5;
    assert.equal(renders, 2);
  });

  test('identidad estable entre lecturas repetidas (=== se mantiene)', () => {
    const { store: state } = createStore({ empresa: { direccion: { ciudad: 'Madrid' } } });
    assert.strictEqual(state.empresa, state.empresa);
    assert.strictEqual(state.empresa.direccion, state.empresa.direccion);
  });

  test('leer un array vía .slice()/.filter() no produce doble-envoltura (Proxy sobre Proxy)', () => {
    const { store: state } = createStore({ lista: [{ id: 1 }, { id: 2 }] });
    const primero = state.lista[0];
    const copia = state.lista.slice();
    // el elemento leído a través de slice() debe ser el MISMO objeto reactivo, no una
    // segunda envoltura distinta -- si hubiera doble-envoltura, esto sería false.
    assert.strictEqual(copia[0], primero);
  });
});

describe('reactividad profunda: de extremo a extremo en el pipeline completo', () => {
  test('mutar una propiedad anidada actualiza la vista sin reasignar', async () => {
    const src = `
reactive datos = { edad: 25 }

visual v =
<p>{datos.edad}</p>
    -> onclick:
        datos.edad = 99

render(
    v
)
`;
    const { js } = compileSource(src);
    const { app, ready } = runBundle(js);
    await ready;
    const p = app.children[0];
    p.listeners.click({ target: p });
    assert.equal(p.textContent, '99');
  });

  test('lista.push() actualiza la vista sin reasignar', async () => {
    const src = `
reactive lista = ["a", "b"]

visual v =
<ul>
    for (item in lista)
        <li>{item}</li>
</ul>
    -> onclick:
        lista.push("c")

render(
    v
)
`;
    const { js } = compileSource(src);
    const { app, ready } = runBundle(js);
    await ready;
    const ul = app.children[0];
    ul.listeners.click({ target: ul });
    const items = ul.children.filter(c => c.tag === 'li').map(li => li.textContent);
    assert.deepEqual(items, ['a', 'b', 'c']);
  });

  test('diffing por clave sigue reutilizando nodos tras el cambio a reactividad profunda', async () => {
    const src = `
reactive personas = [{ id: 1, nombre: "Ana" }, { id: 2, nombre: "Bea" }, { id: 3, nombre: "Carlos" }]

visual test =
<div>
    <ul>
        for (p in personas by p.id)
            <li>{p.nombre}</li>
    </ul>
</div>
    -> onclick:
        personas = personas.slice(1)

render(
    test
)
`;
    const { js } = compileSource(src);
    const { app, ready, getTextNodeCount, resetTextNodeCounter } = runBundle(js);
    await ready;
    const ul = app.children[0].children[0];
    const beaAntes = ul.children.filter(c => c.tag === 'li')[1];

    resetTextNodeCounter();
    app.children[0].listeners.click({ target: app.children[0] });

    assert.deepEqual(ul.children.filter(c => c.tag === 'li').map(li => li.textContent), ['Bea', 'Carlos']);
    assert.equal(getTextNodeCount(), 0, 'no debe crear ningún nodo de texto nuevo -- regresión del bug de doble-envoltura');
    const beaDespues = ul.children.filter(c => c.tag === 'li')[0];
    assert.strictEqual(beaAntes, beaDespues, 'debe seguir siendo el MISMO nodo DOM tras la reactividad profunda');
  });
});
