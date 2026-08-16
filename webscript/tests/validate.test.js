const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseSource } = require('./helpers/compile-helper');

describe('validate: nombres duplicados', () => {
  test('reactive duplicada lanza error', () => {
    assert.throws(() => parseSource('reactive x = 1\nreactive x = 2'), /Nombre duplicado/);
  });

  test('reactive y var con el mismo nombre chocan (espacio compartido)', () => {
    assert.throws(() => parseSource('reactive x = 1\nvar x = 2'), /Nombre duplicado/);
  });

  test('visual y reactive con el mismo nombre chocan', () => {
    const src = 'reactive boton = 1\n\nvisual boton =\n<p>x</p>';
    assert.throws(() => parseSource(src), /Nombre duplicado/);
  });

  test('style SÍ puede compartir nombre con visual (espacio separado)', () => {
    const src = 'style boton =\n    -> color: red\n\nvisual boton =\n<p class={boton}>x</p>\n\nrender(\n    boton\n)';
    assert.doesNotThrow(() => parseSource(src));
  });

  test('dos style con el mismo nombre SÍ chocan entre sí', () => {
    const src = 'style x =\n    -> color: red\n\nstyle x =\n    -> color: blue';
    assert.throws(() => parseSource(src), /Nombre duplicado/);
  });

  test('reactive local shadowing una global NO choca (scoping legítimo)', () => {
    const src = 'reactive x = 100\n\nvisual v =\n    reactive x = 1\n<p>{x}</p>\n\nrender(\n    v\n)';
    assert.doesNotThrow(() => parseSource(src));
  });

  test('dos reactive locales del mismo visual SÍ chocan', () => {
    const src = 'visual v =\n    reactive x = 1\n    var x = 2\n<p>{x}</p>';
    assert.throws(() => parseSource(src), /Nombre duplicado/);
  });
});

describe('validate: recursión de visuales', () => {
  test('un visual no puede referenciarse a sí mismo', () => {
    const src = 'visual arbol =\n<div>\n    <arbol />\n</div>\n\nrender(\n    arbol\n)';
    assert.throws(() => parseSource(src), /se referencia a sí mismo/);
  });

  test('recursión indirecta (A usa B, B usa A) se detecta', () => {
    const src = 'visual a =\n<div>\n    <b />\n</div>\n\nvisual b =\n<div>\n    <a />\n</div>\n\nrender(\n    a\n)';
    assert.throws(() => parseSource(src), /Recursión entre visuales/);
  });

  test('reutilizar el mismo visual varias veces SIN ciclo no es un error', () => {
    const src = 'visual hoja =\n<p>hoja</p>\n\nvisual rama =\n<div>\n    <hoja />\n    <hoja />\n</div>\n\nrender(\n    rama\n)';
    assert.doesNotThrow(() => parseSource(src));
  });
});

describe('validate: server var / server function prohibidas en visuales', () => {
  test('server var referenciada a pelo en un visual falla', () => {
    const src = 'server var x = 1\n\nvisual v =\n<p>{x}</p>';
    assert.throws(() => parseSource(src), /server var/);
  });

  test('server.NOMBRE (con punto) SÍ está permitido', () => {
    const src = 'server var x = 1\n\nreactive y = server.x\n\nvisual v =\n<p>{y}</p>\n\nrender(\n    v\n)';
    assert.doesNotThrow(() => parseSource(src));
  });

  test('reactive global (fuera de cualquier visual) referenciando server var a secas falla', () => {
    const src = 'server var contador = 100\n\nreactive x = contador\n\nvisual v =\n<p>{x}</p>';
    assert.throws(() => parseSource(src), /Usa "server\.contador"/);
  });

  test('var global (no reactive) referenciando server var a secas también falla', () => {
    const src = 'server var contador = 100\n\nvar x = contador * 2\n\nvisual v =\n<p>x</p>';
    assert.throws(() => parseSource(src), /Usa "server\.contador"/);
  });

  test('mismo hueco, ahora vía import de una server var', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-server-bare-'));
    fs.writeFileSync(path.join(dir, 'otro.ws'), 'server var contador = 100');
    fs.writeFileSync(path.join(dir, 'pagina.ws'), 'import { contador } from "./otro.ws"\n\nreactive x = contador\n\nvisual v =\n<p>{x}</p>');
    const src = fs.readFileSync(path.join(dir, 'pagina.ws'), 'utf8');
    assert.throws(() => parseSource(src, path.join(dir, 'pagina.ws')), /Usa "server\.contador"/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('server function referenciada en un visual falla', () => {
    const src = 'server function calc(x)\n    return x * 2\n\nvisual v =\n<p>{calc(1)}</p>';
    assert.throws(() => parseSource(src), /server function/);
  });

  test('post function SÍ puede llamarse desde un visual (es la excepción)', () => {
    const src = 'post function postController(args)\n    return { ok: true }\n\nvisual v =\n<button onclick={postController({})}>\n    x\n</button>\n\nrender(\n    v\n)';
    assert.doesNotThrow(() => parseSource(src));
  });

  test('detecta la referencia prohibida dentro de un if/for anidado', () => {
    const src = 'server var x = 1\n\nvisual v =\n<div>\n    if (true)\n        <p>{x}</p>\n</div>';
    assert.throws(() => parseSource(src), /server var/);
  });

  test('bug real: declarar localmente un nombre que coincide con una server var ya no da falso positivo', () => {
    const src = 'server var contador = 5\n\nvisual v =\n<button onclick={\n    var contador = 99;\n}>\n    x\n</button>';
    assert.doesNotThrow(() => parseSource(src), 'una declaración local aislada, sin referencia posterior, no es una fuga real');
  });

  test('la excepción anterior no debilita la detección de una referencia REAL a una server var', () => {
    const src = 'server var contador = 5\n\nvisual v =\n<button onclick={\n    resultado = contador\n}>\n    x\n</button>';
    assert.throws(() => parseSource(src), /server var/, 'sin ninguna declaración local que la sombree, sigue siendo una referencia real');
  });
});
