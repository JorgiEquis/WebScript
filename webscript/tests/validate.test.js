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
    const src = 'style boton =\n    -> color: red\n\nvisual boton =\n<p>x</p>\n    -> style: boton\n\nrender(\n    boton\n)';
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

  test('server function referenciada en un visual falla', () => {
    const src = 'server function calc(x)\n    return x * 2\n\nvisual v =\n<p>{calc(1)}</p>';
    assert.throws(() => parseSource(src), /server function/);
  });

  test('post function SÍ puede llamarse desde un visual (es la excepción)', () => {
    const src = 'post function postController(args)\n    return { ok: true }\n\nvisual v =\n<button>\n    x\n</button>\n    -> onclick:\n        postController({})\n\nrender(\n    v\n)';
    assert.doesNotThrow(() => parseSource(src));
  });

  test('detecta la referencia prohibida dentro de un if/for anidado', () => {
    const src = 'server var x = 1\n\nvisual v =\n<div>\n    if (true)\n        <p>{x}</p>\n</div>';
    assert.throws(() => parseSource(src), /server var/);
  });
});
