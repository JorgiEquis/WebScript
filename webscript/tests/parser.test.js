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

  test('"server reactive" se parsea como ServerReactiveDecl (reintroducida con watch())', () => {
    const ast = parseSource('server reactive visitas = 1');
    assert.equal(ast.body[0].type, 'ServerReactiveDecl');
    assert.equal(ast.body[0].name, 'visitas');
    assert.equal(ast.body[0].init, '1');
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

describe('parser: put function / delete function', () => {
  test('put function y delete function se parsean correctamente', () => {
    const ast = parseSource('put function actualizar(args)\n    return args\n\ndelete function borrar(args)\n    return args');
    assert.equal(ast.body[0].type, 'PutFunctionDecl');
    assert.equal(ast.body[0].name, 'actualizar');
    assert.equal(ast.body[1].type, 'DeleteFunctionDecl');
    assert.equal(ast.body[1].name, 'borrar');
  });

  test('las tres (post/put/delete) pueden coexistir en el mismo archivo', () => {
    const src = 'post function a(x)\n    return x\n\nput function b(x)\n    return x\n\ndelete function c(x)\n    return x';
    assert.doesNotThrow(() => parseSource(src));
  });

  test('solo una put function por archivo', () => {
    assert.throws(
      () => parseSource('put function a(x)\n    return x\n\nput function b(x)\n    return x'),
      /Solo puede haber una "put function"/
    );
  });

  test('solo una delete function por archivo', () => {
    assert.throws(
      () => parseSource('delete function a(x)\n    return x\n\ndelete function b(x)\n    return x'),
      /Solo puede haber una "delete function"/
    );
  });

  test('put function comparte espacio de nombres con reactive/visual/etc', () => {
    assert.throws(
      () => parseSource('reactive x = 1\n\nput function x(args)\n    return args'),
      /Nombre duplicado/
    );
  });
});

describe('validate: server function inalcanzable', () => {
  test('route() + server function SIN ninguna función HTTP -- rechazado', () => {
    const src = 'route("/api/x")\n\nserver function duplicar(x)\n    return x * 2';
    assert.throws(() => parseSource(src), /es inalcanzable/);
  });

  test('route() + server var SOLA (sin server function) -- permitido, se sirve por GET', () => {
    const src = 'route("/api/config")\n\nserver var version = "1.0"';
    assert.doesNotThrow(() => parseSource(src));
  });

  test('librería SIN route() con server function -- permitido (patrón de import)', () => {
    const src = 'server function duplicar(x)\n    return x * 2';
    assert.doesNotThrow(() => parseSource(src));
  });

  test('route() + server function + al menos una función HTTP -- permitido', () => {
    const src = 'route("/api/x")\n\nserver function duplicar(x)\n    return x * 2\n\npost function usar(args)\n    return { r: duplicar(args.n) }';
    assert.doesNotThrow(() => parseSource(src));
  });
});

describe('import: server var / server function funcionan correctamente', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  test('importar server var/server function desde una librería funciona en una post function', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-import-server-'));
    fs.writeFileSync(path.join(dir, 'lib.ws'), 'server var contador = 0\n\nserver function duplicar(x)\n    return x * 2');
    fs.writeFileSync(path.join(dir, 'api.ws'), 'route("/api/x")\n\nimport { contador, duplicar } from "./lib.ws"\n\npost function incrementar(args)\n    contador = contador + 1\n    return { contador: contador, doble: duplicar(contador) }');

    const src = fs.readFileSync(path.join(dir, 'api.ws'), 'utf8');
    assert.doesNotThrow(() => parseSource(src, path.join(dir, 'api.ws')));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('un server var importado SÍ se detecta como prohibido dentro de un visual', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-import-server2-'));
    fs.writeFileSync(path.join(dir, 'lib.ws'), 'server var contador = 0');
    fs.writeFileSync(path.join(dir, 'pagina.ws'), 'import { contador } from "./lib.ws"\n\nvisual v =\n<p>{contador}</p>');

    const src = fs.readFileSync(path.join(dir, 'pagina.ws'), 'utf8');
    assert.throws(() => parseSource(src, path.join(dir, 'pagina.ws')), /server var/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('validate: reactive/var (cliente) sin efecto en una ruta solo backend', () => {
  test('route() + var (sin server) + sin render() -- rechazado: el bundle.js se descarta entero', () => {
    const src = 'route("/api/x")\n\nvar x = 5\n\npost function leer(args)\n    return { valor: x }';
    assert.throws(() => parseSource(src), /no tiene ningún efecto/);
  });

  test('route() + reactive (sin server) + sin render() -- también rechazado', () => {
    const src = 'route("/api/x")\n\nreactive x = 5\n\npost function leer(args)\n    return { valor: x }';
    assert.throws(() => parseSource(src), /no tiene ningún efecto/);
  });

  test('la versión correcta (server var) SÍ funciona', () => {
    const src = 'route("/api/x")\n\nserver var x = 5\n\npost function leer(args)\n    return { valor: x }';
    assert.doesNotThrow(() => parseSource(src));
  });

  test('reactive/var en una librería SIN route() sigue permitido (patrón de import)', () => {
    const src = 'reactive contadorInicial = 0';
    assert.doesNotThrow(() => parseSource(src));
  });

  test('reactive/var en un archivo CON render() sigue permitido, como siempre', () => {
    const src = 'reactive x = 5\n\nvisual v =\n<p>{x}</p>\n\nrender(\n    v\n)';
    assert.doesNotThrow(() => parseSource(src));
  });
});

describe('function (cliente) -- equivalente a server function, cuerpo en varias líneas', () => {
  test('se parsea como FunctionDecl con cuerpo multilínea', () => {
    const ast = parseSource('function duplicar(x)\n    var y = x * 2\n    return y');
    assert.equal(ast.body[0].type, 'FunctionDecl');
    assert.equal(ast.body[0].name, 'duplicar');
    assert.equal(ast.body[0].params, 'x');
    assert.match(ast.body[0].body, /var y = x \* 2/);
  });

  test('comparte espacio de nombres con reactive/var/visual/etc', () => {
    assert.throws(
      () => parseSource('reactive duplicar = 1\n\nfunction duplicar(x)\n    return x'),
      /Nombre duplicado/
    );
  });

  test('function en una ruta solo backend (route sin render) es rechazada, sugiere server function', () => {
    const src = 'route("/api/x")\n\nfunction duplicar(x)\n    return x * 2\n\npost function leer(args)\n    return { valor: duplicar(5) }';
    assert.throws(() => parseSource(src), /usa "server function duplicar"/);
  });

  test('function en un archivo con render() sigue permitida, como siempre', () => {
    const src = 'function duplicar(x)\n    return x * 2\n\nreactive contador = 5\n\nvisual v =\n<p>{duplicar(contador)}</p>\n\nrender(\n    v\n)';
    assert.doesNotThrow(() => parseSource(src));
  });
});

describe('async/await implícito en function/server function: la palabra clave "async" ya no existe, "await" nunca hace falta escribirlo', () => {
  test('"async function"/"async server function" se rechazan en compilación, con un mensaje que explica el porqué', () => {
    assert.throws(
      () => parseSource('async function llamar(url)\n    var r = await fetch(url)\n    return r'),
      /"async" ya no hace falta delante de "function"/
    );
    assert.throws(
      () => parseSource('async server function consultar()\n    var r = await http.get("x", {})\n    return r'),
      /"async" ya no hace falta delante de "server function"/
    );
  });

  test('"function"/"server function" normales se parsean bien, sin ningún campo isAsync (ya no existe esa distinción)', () => {
    const ast1 = parseSource('function duplicar(x)\n    return x * 2');
    assert.equal(ast1.body[0].type, 'FunctionDecl');
    assert.equal('isAsync' in ast1.body[0], false);

    const ast2 = parseSource('server function duplicar(x)\n    return x * 2');
    assert.equal(ast2.body[0].type, 'ServerFunctionDecl');
    assert.equal('isAsync' in ast2.body[0], false);
  });

  test('"await" dentro de function/server function normales -- ya no hace falta declarar nada especial, se acepta tal cual', () => {
    const ast = parseSource('server function consultar()\n    var r = await http.get("x", {})\n    return r');
    assert.doesNotThrow(() => ast);
  });
});

describe('WSON: "wson"/"server wson" tienen su propia palabra clave dedicada, no un mecanismo genérico en reactive/var', () => {
  test('server wson con bloque -> se sintetiza como objeto literal', () => {
    const src = 'server var message = "Hola"\n\nserver wson sender =\n    -> from: "yo"\n    -> to: "/x"\n    -> via: "POST"\n    -> content: message';
    const ast = parseSource(src);
    const sender = ast.body[1];
    assert.equal(sender.type, 'ServerWsonDecl');
    assert.equal(sender.fields.find(f => f.key === 'content').value, 'message');
  });

  test('reactive/var/server reactive con un bloque "-> clave: valor" ya NO se reconoce -- ese mecanismo genérico se eliminó (era un fallo de seguridad real: "secret" colaba sin la validación de wson/server wson)', () => {
    const src1 = 'reactive sender =\n    -> to: "/x"\n    -> content: "hola"';
    assert.throws(() => parseSource(src1), /se esperaba "reactive \[tipo\] NOMBRE = valor"/);

    const src2 = 'var sender =\n    -> to: "/x"\n    -> content: "hola"';
    assert.throws(() => parseSource(src2), /se esperaba "var \[tipo\] NOMBRE = valor"/);

    const src3 = 'server reactive sender =\n    -> to: "/x"\n    -> content: "hola"';
    assert.throws(() => parseSource(src3), /se esperaba "server var NOMBRE", "server reactive NOMBRE"/);
  });

  test('bug real cerrado: "secret" ya no puede colarse en un var de CLIENTE por el mecanismo genérico viejo', () => {
    const src = 'var x =\n    -> to: "http://x"\n    -> content: 1\n    -> secret: "esto-se-veria-en-el-navegador"\n\nvisual v =\n<p>x</p>\n\nrender(\n    v\n)';
    assert.throws(() => parseSource(src)); // ya no compila -- "secret" nunca llega ni siquiera a evaluarse como campo WSON
  });

  test('sin bloque WSON (una sola línea normal), sigue funcionando exactamente igual que antes', () => {
    const ast = parseSource('server var x = 5');
    assert.equal(ast.body[0].init, '5');
  });

  test('server var/reactive SIN "=" (sin valor inicial) sigue dando undefined, no se confunde con WSON', () => {
    const ast = parseSource('server var x');
    assert.equal(ast.body[0].init, 'undefined');
  });

  test('WSON dentro de un cuerpo de función -- rechazado, no genera JS roto', () => {
    const src = 'route("/x")\n\npost function f(args)\n    var sender =\n        -> to: "/x"\n        -> content: "hola"\n    return {}';
    assert.throws(() => parseSource(src), /contiene algo que parece un bloque WSON/);
  });
});

describe('WSON: segunda forma "wson NOMBRE = expresión" -- para cuando el valor YA es un WSON en tiempo de ejecución, no un literal', () => {
  test('server wson con expresión, a nivel de archivo', () => {
    const ast = parseSource('route("/x")\n\nserver wson msg = { to: "http://x", content: 1 }\n\npost function f(args)\n    return msg');
    const decl = ast.body.find(n => n.type === 'ServerWsonDecl');
    assert.equal(decl.fields, null);
    assert.equal(decl.init, '{ to: "http://x", content: 1 }');
  });

  test('wson con expresión, a nivel de archivo (cliente)', () => {
    const ast = parseSource('wson msg = construirWson()\n\nvisual v =\n<p>x</p>\n\nrender(\n    v\n)');
    const decl = ast.body.find(n => n.type === 'WsonDecl');
    assert.equal(decl.init, 'construirWson()');
  });

  test('el caso real que motivó esto: "server wson msg = WSON.parse(...)" DENTRO de un post function', () => {
    const src = 'route("/x")\n\npost function recibir(args, query, headers)\n    server wson msg = WSON.parse(args, headers, "clave")\n    return { from: msg.from }';
    assert.doesNotThrow(() => parseSource(src));
  });

  test('bug real encontrado y arreglado: sin desazucarar, "wson"/"server" dentro de una función colaban literal y rompían el JS generado', () => {
    const { compile } = require('../src/compiler');
    const ast = parseSource('route("/x")\n\npost function recibir(args, query, headers)\n    server wson msg = WSON.parse(args, headers, "clave")\n    return { from: msg.from }');
    const { server } = compile(ast, { routePath: '/' });
    assert.doesNotMatch(server, /\bserver wson msg\b/, 'no debe quedar "server wson" literal en el JS generado');
    assert.match(server, /let msg = WSON\.parse\(/, 'debe haberse reescrito a un "let" normal');
    assert.doesNotThrow(() => new Function(server.replace(/^module\.exports.*$/m, '')));
  });

  test('bug de seguridad real, ya cerrado: "secret" ya no puede colarse en un wson de CLIENTE usando la segunda forma tampoco', () => {
    const src = 'wson msg =\n    -> to: "http://x"\n    -> content: 1\n    -> secret: "malo"\n\nvisual v =\n<p>x</p>\n\nrender(\n    v\n)';
    assert.throws(() => parseSource(src), /solo tiene sentido en "server wson"/);
  });

  test('la validación de "no referenciar server var desde cliente" sigue aplicando en la segunda forma', () => {
    const src = 'server var secreto = 1\n\nwson msg = { to: "http://x", content: secreto }\n\nvisual v =\n<p>x</p>\n\nrender(\n    v\n)';
    assert.throws(() => parseSource(src), /referencia "secreto"/);
  });
});

describe('ws function: parseo, y solo una por archivo', () => {
  test('parsea correctamente, igual que las cuatro HTTP', () => {
    const ast = parseSource('route("/chat")\n\nws function entradaWS(args)\n    return { eco: args.mensaje }');
    const decl = ast.body.find(n => n.type === 'WsFunctionDecl');
    assert.equal(decl.name, 'entradaWS');
    assert.equal(decl.params, 'args');
  });

  test('dos "ws function" en el mismo archivo -- rechazado, mismo criterio que post/put/delete/get', () => {
    const src = 'route("/x")\n\nws function a(args)\n    return {}\n\nws function b(args)\n    return {}';
    assert.throws(() => parseSource(src), /Solo puede haber una "ws function" por archivo/);
  });
});

describe('WSON via:"socket" -- validación', () => {
  test('"via: socket" es un valor aceptado, no rechazado', () => {
    const src = 'server wson msg =\n    -> to: "ws://localhost:9999/x"\n    -> via: "socket"\n    -> content: 1';
    assert.doesNotThrow(() => parseSource(src));
  });

  test('un verbo inventado sigue rechazándose, con el mensaje actualizado mencionando SOCKET', () => {
    const src = 'server wson msg =\n    -> to: "http://x"\n    -> via: "PATCH"\n    -> content: 1';
    assert.throws(() => parseSource(src), /POST.*PUT.*DELETE.*SOCKET/);
  });
});
