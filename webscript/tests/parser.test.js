const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseSource } = require('./helpers/compile-helper');

describe('parser: declaraciones básicas', () => {
  test('reactive con y sin valor', () => {
    const ast = parseSource('reactive x = 5\nreactive y = "hola"');
    assert.equal(ast.body[0].type, 'ReactiveDecl');
    assert.equal(ast.body[0].name, 'x');
    assert.equal(ast.body[0].init, '5');
    assert.equal(ast.body[1].init, '"hola"');
  });

  test('var no reactiva', () => {
    const ast = parseSource('var doble = (x) => x * 2');
    assert.equal(ast.body[0].type, 'VarDecl');
  });

  test('style con varias propiedades', () => {
    const ast = parseSource('style boton =\n    -> color: red\n    -> padding: 8px');
    const style = ast.body[0];
    assert.equal(style.type, 'StyleDecl');
    assert.equal(style.props.length, 2);
    assert.equal(style.props[0].prop, 'color');
    assert.equal(style.props[0].value, 'red');
  });

  test('visual con template simple', () => {
    const ast = parseSource('visual x =\n<p>hola</p>\n\nrender(\n    x\n)');
    const visual = ast.body.find(n => n.type === 'VisualDecl');
    assert.equal(visual.template.tag, 'p');
  });

  test('route debe empezar con "/"', () => {
    assert.throws(() => parseSource('route("sin-barra")'), /debe empezar con/);
  });

  test('route debe ser la primera declaración', () => {
    assert.throws(
      () => parseSource('reactive x = 1\n\nroute("/tarde")'),
      /PRIMERA declaración/
    );
  });

  test('server var con y sin valor inicial', () => {
    const ast = parseSource('server var a\nserver var b = 10');
    assert.equal(ast.body[0].init, 'undefined');
    assert.equal(ast.body[1].init, '10');
  });

  test('"server reactive" da error explicativo con el nombre correcto sugerido', () => {
    assert.throws(() => parseSource('server reactive visitas = 1'), /usa "server var visitas"/);
  });

  test('server function con parámetros', () => {
    const ast = parseSource('server function calcular(a, b)\n    return a + b');
    const fn = ast.body[0];
    assert.equal(fn.type, 'ServerFunctionDecl');
    assert.equal(fn.params, 'a, b');
    assert.match(fn.body, /return a \+ b/);
  });

  test('post function: solo una por archivo', () => {
    assert.throws(
      () => parseSource('post function a(x)\n    return x\n\npost function b(y)\n    return y'),
      /Solo puede haber una "post function"/
    );
  });

  test('comentarios de línea completa se ignoran', () => {
    const ast = parseSource('// esto es un comentario\nreactive x = 1\n// otro más');
    assert.equal(ast.body.length, 1);
    assert.equal(ast.body[0].type, 'ReactiveDecl');
  });

  test('instrucción no reconocida lanza SyntaxError con la línea', () => {
    assert.throws(() => parseSource('esto no es nada valido'), /Línea 1/);
  });
});

describe('parser: if / for', () => {
  test('if / else if / else en la plantilla', () => {
    const ast = parseSource(
      'reactive x = 1\n\nvisual v =\n<div>\n    if (x == 1)\n        <p>uno</p>\n    else if (x == 2)\n        <p>dos</p>\n    else\n        <p>otro</p>\n</div>'
    );
    const visual = ast.body.find(n => n.type === 'VisualDecl');
    const ifNode = visual.template.children[0];
    assert.equal(ifNode.type, 'if');
    assert.equal(ifNode.branches.length, 2);
    assert.ok(ifNode.elseBody);
  });

  test('else mal indentado (más) lanza error explícito, no se traga en silencio', () => {
    const src = 'reactive x = 1\n\nvisual v =\n<div>\n    if (x == 1)\n        <p>uno</p>\n      else\n        <p>otro</p>\n</div>';
    assert.throws(() => parseSource(src), /mal indentado/);
  });

  test('else mal indentado (menos) también lanza error', () => {
    const src = 'reactive x = 1\n\nvisual v =\n<div>\n    if (x == 1)\n        <p>uno</p>\n  else\n        <p>otro</p>\n</div>';
    assert.throws(() => parseSource(src), /mal indentado/);
  });

  test('for con clave opcional ("by")', () => {
    const ast = parseSource('reactive lista = []\n\nvisual v =\n<ul>\n    for (item in lista by item.id)\n        <li>{item.nombre}</li>\n</ul>');
    const visual = ast.body.find(n => n.type === 'VisualDecl');
    const forNode = visual.template.children[0];
    assert.equal(forNode.type, 'for');
    assert.equal(forNode.item, 'item');
    assert.equal(forNode.keyExpr, 'item.id');
  });

  test('for sin clave -> keyExpr null', () => {
    const ast = parseSource('reactive lista = []\n\nvisual v =\n<ul>\n    for (item in lista)\n        <li>{item}</li>\n</ul>');
    const visual = ast.body.find(n => n.type === 'VisualDecl');
    assert.equal(visual.template.children[0].keyExpr, null);
  });
});

describe('parser: import', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  test('import trae declaraciones de otro archivo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
    const libPath = path.join(dir, 'lib.ws');
    const mainPath = path.join(dir, 'main.ws');
    fs.writeFileSync(libPath, 'style boton =\n    -> color: red');
    fs.writeFileSync(mainPath, 'import { boton } from "./lib.ws"\n\nvisual v =\n<p>x</p>\n\nrender(\n    v\n)');

    const src = fs.readFileSync(mainPath, 'utf8');
    const ast = parseSource(src, mainPath);
    assert.ok(ast.body.find(n => n.type === 'StyleDecl' && n.name === 'boton'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('no se puede importar un archivo con route()', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
    const libPath = path.join(dir, 'lib.ws');
    const mainPath = path.join(dir, 'main.ws');
    fs.writeFileSync(libPath, 'route("/x")\n\nvisual v =\n<p>x</p>\n\nrender(\n    v\n)');
    fs.writeFileSync(mainPath, 'import { v } from "./lib.ws"');

    const src = fs.readFileSync(mainPath, 'utf8');
    assert.throws(() => parseSource(src, mainPath), /route\(\.\.\.\)/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('import circular se detecta', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
    const aPath = path.join(dir, 'a.ws');
    const bPath = path.join(dir, 'b.ws');
    fs.writeFileSync(aPath, 'import { b } from "./b.ws"\nvar a = 1');
    fs.writeFileSync(bPath, 'import { a } from "./a.ws"\nvar b = 2');

    const src = fs.readFileSync(aPath, 'utf8');
    assert.throws(() => parseSource(src, aPath), /circular/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('parser: tipado opcional (reactive/var)', () => {
  test('tipo correcto no lanza error', () => {
    assert.doesNotThrow(() => parseSource('reactive string x = "hola"\nreactive number y = 5\nvar boolean z = true'));
  });

  test('sin tipo sigue funcionando (compatibilidad hacia atrás)', () => {
    const ast = parseSource('reactive x = 5');
    assert.equal(ast.body[0].varType, null);
  });

  test('number con valor string lanza error', () => {
    assert.throws(() => parseSource('reactive number edad = "veinticinco"'), /parece un string/);
  });

  test('string con valor number lanza error', () => {
    assert.throws(() => parseSource('reactive string nombre = 25'), /parece un number/);
  });

  test('boolean con valor string lanza error', () => {
    assert.throws(() => parseSource('var boolean activo = "si"'), /parece un string/);
  });

  test('expresión compleja NO se valida (sin inferencia de tipos)', () => {
    const src = 'reactive precio = 100\nreactive number total = precio * 1.21';
    assert.doesNotThrow(() => parseSource(src));
  });

  test('tipo en reactive/var LOCAL de un visual también se valida', () => {
    const src = 'visual test =\n    reactive number contador = "no es numero"\n<p>x</p>';
    assert.throws(() => parseSource(src), /local de visual test/);
  });

  test('nombre de variable que coincide con una palabra de tipo sigue funcionando', () => {
    const ast = parseSource('reactive string = 5');
    assert.equal(ast.body[0].name, 'string');
    assert.equal(ast.body[0].varType, null);
  });
});
