const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { compileSource } = require('./helpers/compile-helper');
const { runBundle } = require('./helpers/dom-mock');

describe('compilador: reactividad básica', () => {
  test('reactive se actualiza al hacer click', async () => {
    const src = `
reactive contador = 0

visual test =
<button>
    {contador}
</button>
    -> onclick:
        contador++

render(
    test
)
`;
    const { js } = compileSource(src);
    const { app, ready } = runBundle(js);
    await ready;
    const btn = app.children[0];
    assert.equal(btn.textContent, '0');
    btn.listeners.click({ target: btn });
    assert.equal(btn.textContent, '1');
  });

  test('var (no reactiva) no cambia aunque dependa de una reactive', async () => {
    const src = `
reactive base = 100
var derivado = base * 2

visual test =
<div>
    <p>{base}</p>
    <p>{derivado}</p>
</div>
    -> onclick:
        base = base + 10

render(
    test
)
`;
    const { js } = compileSource(src);
    const { app, ready } = runBundle(js);
    await ready;
    const div = app.children[0];
    assert.equal(div.children[0].textContent, '100');
    assert.equal(div.children[1].textContent, '200');
    div.listeners.click({ target: div });
    assert.equal(div.children[0].textContent, '110', 'base sí se actualiza');
    assert.equal(div.children[1].textContent, '200', 'derivado se queda congelado');
  });

  test('el handler recibe el objeto event de verdad', async () => {
    const src = `
reactive texto = ""

visual test =
<input>
    -> oninput:
        texto = event.target.value

render(
    test
)
`;
    const { js } = compileSource(src);
    const { app, ready } = runBundle(js);
    await ready;
    const input = app.children[0];
    input.value = 'hola';
    input.listeners.input({ target: input });
    // no hay nada visible que comprobar aquí sin un segundo visual, pero si "event"
    // no existiera como parámetro, esta línea ya habría lanzado ReferenceError
    assert.ok(true);
  });
});

describe('compilador: if / else if / else', () => {
  test('elige la rama correcta y reacciona a cambios', async () => {
    const src = `
reactive x = 0

visual test =
<div>
    if (x == 0)
        <p>cero</p>
    else if (x < 5)
        <p>poco</p>
    else
        <p>mucho</p>
</div>
    -> onclick:
        x = x + 10

render(
    test
)
`;
    const { js } = compileSource(src);
    const { app, ready } = runBundle(js);
    await ready;
    const div = app.children[0];
    assert.equal(div.children.filter(c => c.tag === 'p').length, 1, 'solo una rama montada');
    assert.equal(div.textContent, 'cero');
    div.listeners.click({ target: div });
    assert.equal(div.textContent, 'mucho');
    assert.equal(div.children.filter(c => c.tag === 'p').length, 1, 'sigue habiendo solo una rama, no se acumulan');
  });
});

describe('compilador: for', () => {
  test('renderiza la lista y reacciona a una reasignación con spread', async () => {
    const src = `
reactive lista = ["a", "b"]

visual test =
<ul>
    for (item in lista)
        <li>{item}</li>
</ul>
    -> onclick:
        lista = [...lista, "c"]

render(
    test
)
`;
    const { js } = compileSource(src);
    const { app, ready } = runBundle(js);
    await ready;
    const ul = app.children[0];
    assert.deepEqual(ul.children.filter(c => c.tag === 'li').map(li => li.textContent), ['a', 'b']);
    ul.listeners.click({ target: ul });
    assert.deepEqual(ul.children.filter(c => c.tag === 'li').map(li => li.textContent), ['a', 'b', 'c']);
  });

  test('la variable del for hace shadowing de una reactive con el mismo nombre', async () => {
    const src = `
reactive contador = 100
reactive lista = ["a", "b", "c"]

visual test =
<ul>
    for (contador in lista)
        <li>{contador}</li>
</ul>

render(
    test
)
`;
    const { js } = compileSource(src);
    const { app, ready } = runBundle(js);
    await ready;
    const ul = app.children[0];
    assert.deepEqual(
      ul.children.filter(c => c.tag === 'li').map(li => li.textContent),
      ['a', 'b', 'c'],
      'debe mostrar los elementos de la lista, NO 100 repetido'
    );
  });

  test('diffing por clave: no reconstruye ítems que no cambiaron', async () => {
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
    assert.equal(getTextNodeCount(), 0, 'no debería crear NINGÚN nodo de texto nuevo al solo quitar el primero');
    const beaDespues = ul.children.filter(c => c.tag === 'li')[0];
    assert.strictEqual(beaAntes, beaDespues, 'el nodo de Bea debe ser el MISMO objeto DOM, reutilizado');
  });
});

describe('compilador: estado local vs global', () => {
  test('reactive local a un visual es independiente por instancia', async () => {
    const src = `
visual contadorLocal =
    reactive n = 0
<button>
    {n}
</button>
    -> onclick:
        n++

visual pagina =
<div>
    <contadorLocal />
    <contadorLocal />
</div>

render(
    pagina
)
`;
    const { js } = compileSource(src);
    const { app, ready } = runBundle(js);
    await ready;
    const [btn1, btn2] = app.children[0].children;
    btn1.listeners.click({ target: btn1 });
    btn1.listeners.click({ target: btn1 });
    btn2.listeners.click({ target: btn2 });
    assert.equal(btn1.textContent, '2');
    assert.equal(btn2.textContent, '1');
  });
});

describe('compilador: JS embebido (destructuring / atajos)', () => {
  test('destructuring corto genera JS válido; el shadowing tras él depende del motor', async () => {
    const src = `
reactive contador = 5
reactive resultado = 0

visual test =
<button>
    {resultado}
</button>
    -> onclick:
        const obj = { contador: 99 }
        const { contador } = obj
        resultado = contador

render(
    test
)
`;
    const { js } = compileSource(src);
    // si la sustitución hubiera roto el destructuring en sí, esto lanzaría SyntaxError
    // al ejecutar el bundle -- eso es lo que SIEMPRE debe cumplirse, con o sin Acorn.
    const { app, ready } = runBundle(js);
    await ready;
    const btn = app.children[0];
    btn.listeners.click({ target: btn });

    const jsAnalyzer = require('../src/js-analyzer');
    if (jsAnalyzer.isAvailable()) {
      // Con Acorn: scoping real -- "contador" tras el destructuring es la variable
      // LOCAL (99), no la reactive (5). Comportamiento correcto.
      assert.equal(btn.textContent, '99', 'con Acorn, debe usar el "contador" local del destructuring');
    } else {
      // Motor de respaldo (regex): limitación DOCUMENTADA -- la exclusión solo cubre
      // la propia línea del destructuring, no sabe que "contador" queda sombreada
      // para el resto del bloque. Sustituye igual por la reactive.
      assert.equal(btn.textContent, '5', 'motor de respaldo: limitación conocida, ver README');
    }
  });

  test('atajo de objeto se expande correctamente ({ contador } -> { contador: state.contador })', async () => {
    const src = `
reactive contador = 42
reactive snapshotStr = ""

visual test =
<button>
    {snapshotStr}
</button>
    -> onclick:
        var snapshot = { contador }
        snapshotStr = JSON.stringify(snapshot)

render(
    test
)
`;
    const { js } = compileSource(src);
    const { app, ready } = runBundle(js);
    await ready;
    const btn = app.children[0];
    btn.listeners.click({ target: btn });
    assert.equal(btn.textContent, '{"contador":42}');
  });

  test('if anidado dentro de for: orden correcto al añadir elementos incrementalmente', async () => {
    const src = `
reactive feed = []

visual test =
<div>
    <ul>
        for (item in feed)
            if (item.tipo == "texto")
                <li>{item.contenido}</li>
            else
                <li>desconocido</li>
    </ul>
</div>
    -> onclick:
        feed = [...feed, { tipo: "texto", contenido: "item-" + feed.length }]

render(
    test
)
`;
    const { js } = compileSource(src);
    const { app, ready } = runBundle(js);
    await ready;
    const div = app.children[0];
    const ul = div.children[0];

    div.listeners.click({ target: div });
    div.listeners.click({ target: div });
    div.listeners.click({ target: div });

    const items = ul.children.filter(c => c.tag === 'li').map(li => li.textContent);
    assert.deepEqual(items, ['item-0', 'item-1', 'item-2'], 'el orden debe respetar el orden de inserción, no invertirse');
  });
});
