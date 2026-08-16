const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { compileSource } = require('./helpers/compile-helper');
const { runBundle } = require('./helpers/dom-mock');

describe('compilador: reactividad básica', () => {
  test('reactive se actualiza al hacer click', async () => {
    const src = `
reactive contador = 0

visual test =
<button onclick={contador++}>
    {contador}
</button>

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
<div onclick={base = base + 10}>
    <p>{base}</p>
    <p>{derivado}</p>
</div>

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
<input oninput={texto = event.target.value}>

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
<div onclick={x = x + 10}>
    if (x == 0)
        <p>cero</p>
    else if (x < 5)
        <p>poco</p>
    else
        <p>mucho</p>
</div>

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
<ul onclick={lista = [...lista, "c"]}>
    for (item in lista)
        <li>{item}</li>
</ul>

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
<div onclick={personas = personas.slice(1)}>
    <ul>
        for (p in personas by p.id)
            <li>{p.nombre}</li>
    </ul>
</div>

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
<button onclick={n++}>
    {n}
</button>

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
<button onclick={
    const obj = { contador: 99 }
    const { contador } = obj
    resultado = contador
}>
    {resultado}
</button>

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
<button onclick={
    var snapshot = { contador }
    snapshotStr = JSON.stringify(snapshot)
}>
    {snapshotStr}
</button>

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
<div onclick={feed = [...feed, { tipo: "texto", contenido: "item-" + feed.length }]}>
    <ul>
        for (item in feed)
            if (item.tipo == "texto")
                <li>{item.contenido}</li>
            else
                <li>desconocido</li>
    </ul>
</div>

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

describe('compilador: JSON.stringify/parse y referencias cruzadas entre reactive', () => {
  test('una reactive puede referenciar a otra reactive anterior en su valor inicial', async () => {
    const src = `
reactive textoJson = '{"nombre": "Ana", "edad": 25}'
reactive datos = JSON.parse(textoJson)

visual v =
<p>{datos.nombre} tiene {datos.edad} años</p>

render(
    v
)
`;
    const { js } = compileSource(src);
    const { app, ready } = runBundle(js);
    await ready;
    assert.equal(app.children[0].textContent, 'Ana tiene 25 años');
  });

  test('JSON.stringify/parse funcionan de extremo a extremo, incluyendo .filter()/Object.keys()', async () => {
    const src = `
reactive datos = { nombre: "Jorge", hobbies: ["programar", "leer"] }
reactive salida = ""

visual v =
<p onclick={
    var texto = JSON.stringify(datos)
    var vuelto = JSON.parse(texto)
    var largos = datos.hobbies.filter(h => h.length > 5)
    salida = vuelto.nombre + ":" + largos.join(",") + ":" + Object.keys(datos).join(",")
}>{salida}</p>

render(
    v
)
`;
    const { js } = compileSource(src);
    const { app, ready } = runBundle(js);
    await ready;
    const p = app.children[0];
    p.listeners.click({ target: p });
    assert.equal(p.textContent, 'Jorge:programar:nombre,hobbies');
  });

  test('mutar una propiedad de una reactive-objeto SÍ dispara re-render (reactividad profunda)', async () => {
    const src = `
reactive datos = { edad: 25 }

visual v =
<p onclick={datos.edad = 99}>{datos.edad}</p>

render(
    v
)
`;
    const { js } = compileSource(src);
    const { app, ready } = runBundle(js);
    await ready;
    const p = app.children[0];
    p.listeners.click({ target: p });
    assert.equal(p.textContent, '99', 'mutar una propiedad anidada SÍ debe re-renderizar (reactividad profunda)');
  });

  test('reasignar la reactive-objeto completa SÍ dispara re-render', async () => {
    const src = `
reactive datos = { edad: 25 }

visual v =
<p onclick={datos = { ...datos, edad: 99 }}>{datos.edad}</p>

render(
    v
)
`;
    const { js } = compileSource(src);
    const { app, ready } = runBundle(js);
    await ready;
    const p = app.children[0];
    p.listeners.click({ target: p });
    assert.equal(p.textContent, '99', 'reasignar la reactive completa sí debe re-renderizar');
  });
});

describe('compilador: function (cliente) con cuerpo multilínea', () => {
  test('ejecuta correctamente, incluyendo if/else e identificadores sustituidos', async () => {
    const src = `
reactive base = 10

function calcularConBase(x)
    var resultado = x + base
    if (resultado > 20)
        return "alto: " + resultado
    else
        return "bajo: " + resultado

visual v =
<p>{calcularConBase(15)}</p>

render(
    v
)
`;
    const { js } = compileSource(src);
    const { app, ready } = runBundle(js);
    await ready;
    assert.equal(app.children[0].textContent, 'alto: 25');
  });
});

describe('bug real encontrado verificando Acorn: "var NOMBRE" coincidiendo con una reactive generaba JS inválido', () => {
  test('var/let/const con un nombre que coincide con una reactive ya NO genera JS inválido', async () => {
    for (const kw of ['var', 'let', 'const']) {
      const src = `
reactive contador = 7
reactive resultado = 0

visual test =
<button onclick={
    ${kw} contador = 99;
    resultado = contador
}>
    {resultado}
</button>

render(
    test
)
`;
      const { js } = compileSource(src);
      assert.doesNotMatch(js, new RegExp(`${kw} state\\.contador`), `"${kw} state.contador" sería JS inválido -- antes se generaba así`);
      // confirma que de verdad es JS ejecutable, no solo que el texto no coincide --
      // ejecutando el bundle real, no con una comprobación de sintaxis recortada a mano
      const { app, ready } = runBundle(js);
      await ready;
      const btn = app.children[0];
      assert.doesNotThrow(() => btn.listeners.click({ target: btn }), `el bundle con "${kw}" debe ejecutarse sin lanzar`);
    }
  });

  test('declarar la sombra SIN referenciarla después ejecuta bien (caso aislado, totalmente resuelto)', async () => {
    const src = `
reactive contador = 7

visual test =
<button onclick={
    var contador = 99;
}>
    {contador}
</button>

render(
    test
)
`;
    const { js } = compileSource(src);
    const { app, ready } = runBundle(js);
    await ready;
    const btn = app.children[0];
    assert.doesNotThrow(() => btn.listeners.click({ target: btn }), 'no debe lanzar ningún error al ejecutar');
  });

  test('con referencia posterior a la sombra, el motor de respaldo sigue usando la reactive (limitación conocida, ya no un crash)', async () => {
    const src = `
reactive contador = 7
reactive resultado = 0

visual test =
<button onclick={
    var contador = 99;
    resultado = contador
}>
    {resultado}
</button>

render(
    test
)
`;
    const { js } = compileSource(src);
    const { app, ready } = runBundle(js);
    await ready;
    const btn = app.children[0];
    btn.listeners.click({ target: btn });

    const jsAnalyzer = require('../src/js-analyzer');
    if (jsAnalyzer.isAvailable()) {
      assert.equal(app.children[0].textContent, '99', 'con Acorn, debe usar la variable local sombreada (99), no la reactive (7)');
    } else {
      assert.equal(app.children[0].textContent, '7', 'motor de respaldo: limitación conocida (ya no es un crash, pero el valor sigue siendo el de la reactive)');
    }
  });
});

describe('Acorn: los otros dos límites documentados, nunca antes comprobados con la librería real instalada', () => {
  test('valor por defecto en destructuring referenciando una reactive', async () => {
    const src = `
reactive contador = 42
reactive resultado = 0

visual test =
<button onclick={
    var obj = {};
    var valor = 5;
    const { x = contador } = obj;
    resultado = x
}>
    {resultado}
</button>

render(
    test
)
`;
    const { js } = compileSource(src);
    const jsAnalyzer = require('../src/js-analyzer');
    if (jsAnalyzer.isAvailable()) {
      // con Acorn, "contador" dentro del valor por defecto SÍ debe sustituirse -- sin
      // eso, el bundle fallaría con ReferenceError al ejecutar
      const { app, ready } = runBundle(js);
      await ready;
      const btn = app.children[0];
      assert.doesNotThrow(() => btn.listeners.click({ target: btn }), 'con Acorn, no debe lanzar ReferenceError');
      assert.equal(app.children[0].textContent, '42', 'con Acorn, el valor por defecto debe resolver a la reactive');
    } else {
      // motor de respaldo: limitación documentada -- ReferenceError real al ejecutar
      assert.doesNotThrow(() => runBundle(js), 'compilar no debe fallar');
      const { app, ready } = runBundle(js);
      await ready;
      const btn = app.children[0];
      let lanzo = false;
      try { btn.listeners.click({ target: btn }); } catch (e) { lanzo = true; }
      assert.ok(lanzo, 'motor de respaldo: limitación conocida -- debe seguir lanzando ReferenceError (contador no sustituido)');
    }
  });

  test('destructuring en una asignación (sin declarador) con sombra local previa', async () => {
    const src = `
reactive contador = 7
reactive resultado = 0

visual test =
<button onclick={
    var contador = 1;
    var obj = { contador: 99 };
    ({ contador } = obj);
    resultado = contador
}>
    {resultado}
</button>

render(
    test
)
`;
    const { js } = compileSource(src);
    const jsAnalyzer = require('../src/js-analyzer');
    if (jsAnalyzer.isAvailable()) {
      const { app, ready } = runBundle(js);
      await ready;
      const btn = app.children[0];
      assert.doesNotThrow(() => btn.listeners.click({ target: btn }), 'con Acorn, debe ser JS válido y ejecutable');
      assert.equal(app.children[0].textContent, '99', 'con Acorn, debe asignar a la variable LOCAL sombreada, no a la reactive');
    } else {
      // motor de respaldo: no rastrea que "contador" ya estaba sombreada por el "var"
      // anterior -- puede o no ejecutar sin lanzar, según cómo caiga la sustitución;
      // lo único que hace falta confirmar es que el propio compileSource no revienta
      assert.doesNotThrow(() => compileSource(src), 'compilar no debe fallar en sí, aunque el resultado sea incorrecto');
    }
  });
});
