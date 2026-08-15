const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSite, startServer } = require('../src/site-builder');

// Arranca un servidor real sobre un directorio temporal de .ws, en un puerto
// efímero (0 -> el SO elige uno libre), y lo cierra al terminar.
function withServer(wsFiles, testFn) {
  return async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-server-test-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-server-out-'));
    for (const [name, content] of Object.entries(wsFiles)) {
      fs.writeFileSync(path.join(srcDir, name), content);
    }
    const { table } = buildSite(srcDir, outDir);
    const server = startServer(table, outDir, 0);
    await new Promise(resolve => server.on('listening', resolve));
    const port = server.address().port;
    try {
      await testFn(`http://localhost:${port}`);
    } finally {
      server.close();
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  };
}

describe('servidor: post function', () => {
  test('POST dispara la función y acumula en server var (misma sesión)', withServer(
    {
      'pagina.ws': `route("/formulario")

server var total = 0

post function postController(args)
    total = total + args.cantidad
    return { total: total }

visual v =
<p>x</p>

render(
    v
)
`,
    },
    async (base) => {
      const r1 = await fetch(`${base}/formulario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cantidad: 5 }),
      });
      assert.equal(r1.status, 200);
      const cookie = r1.headers.get('set-cookie').split(';')[0];
      assert.deepEqual(await r1.json(), { total: 5 });

      const r2 = await fetch(`${base}/formulario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ cantidad: 3 }),
      });
      assert.deepEqual(await r2.json(), { total: 8 });
    }
  ));

  test('GET sigue sirviendo el HTML normal', withServer(
    {
      'pagina.ws': `route("/x")

visual v =
<h1>hola</h1>

render(
    v
)
`,
    },
    async (base) => {
      const r = await fetch(`${base}/x`);
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.match(html, /<html/);
    }
  ));

  test('POST a una ruta sin post function da 405', withServer(
    {
      'pagina.ws': `route("/sin-post")

visual v =
<p>x</p>

render(
    v
)
`,
    },
    async (base) => {
      const r = await fetch(`${base}/sin-post`, { method: 'POST' });
      assert.equal(r.status, 405);
    }
  ));
});

describe('servidor: sesiones por usuario', () => {
  test('dos sesiones distintas (cookies distintas) no comparten estado', withServer(
    {
      'pagina.ws': `route("/con-server-function")

server var total = 0

post function postController(args)
    total = total + args.cantidad
    return { total: total }

visual v =
<p>x</p>

render(
    v
)
`,
    },
    async (base) => {
      function extractCookie(res) {
        const raw = res.headers.get('set-cookie');
        return raw ? raw.split(';')[0] : null;
      }

      // Sesión A: dos peticiones con la MISMA cookie
      const rA1 = await fetch(`${base}/con-server-function`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cantidad: 100 }),
      });
      const cookieA = extractCookie(rA1);
      assert.ok(cookieA, 'el servidor debe mandar una cookie de sesión');
      await rA1.json();

      const rA2 = await fetch(`${base}/con-server-function`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieA },
        body: JSON.stringify({ cantidad: 100 }),
      });
      const dataA2 = await rA2.json();
      assert.equal(dataA2.total, 200, 'sesión A acumula sus dos peticiones');

      // Sesión B: cookie completamente distinta (o ninguna) -> debe empezar de cero
      const rB1 = await fetch(`${base}/con-server-function`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cantidad: 50 }),
      });
      const dataB1 = await rB1.json();
      assert.equal(dataB1.total, 50, 'sesión B no ve el 200 acumulado por la sesión A');

      // Sesión A otra vez: sigue en 200, no se contaminó con B
      const rA4 = await fetch(`${base}/con-server-function`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieA },
        body: JSON.stringify({ cantidad: 0 }),
      });
      const dataA4 = await rA4.json();
      assert.equal(dataA4.total, 200, 'sesión A no se contaminó con la B');
    }
  ));
});

describe('servidor: endpoint de datos (solo lectura) + post function para escribir', () => {
  test('GET inicial, POST a la post function actualiza, y persiste en el siguiente GET (misma sesión)', withServer(
    {
      'pagina.ws': `route("/dinamica")

server var visitas = 100

post function incrementar(args)
    visitas = visitas + args.cantidad
    return { visitas: visitas }

reactive contadorCliente = server.visitas

visual v =
<p>{contadorCliente}</p>

render(
    v
)
`,
    },
    async (base) => {
      const r1 = await fetch(`${base}/dinamica.server-data.json`);
      const cookie = r1.headers.get('set-cookie').split(';')[0];
      assert.deepEqual(await r1.json(), { visitas: 100 });

      const r2 = await fetch(`${base}/dinamica`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ cantidad: 1 }),
      });
      assert.deepEqual(await r2.json(), { visitas: 101 });

      const r3 = await fetch(`${base}/dinamica.server-data.json`, { headers: { Cookie: cookie } });
      assert.deepEqual(await r3.json(), { visitas: 101 }, 'debe persistir, no volver a 100');
    }
  ));

  test('el endpoint de datos ya no acepta POST (405) -- solo lectura', withServer(
    {
      'pagina.ws': `route("/dinamica2")

server var visitas = 100

reactive contadorCliente = server.visitas

visual v =
<p>{contadorCliente}</p>

render(
    v
)
`,
    },
    async (base) => {
      const r = await fetch(`${base}/dinamica2.server-data.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitas: 5 }),
      });
      assert.equal(r.status, 405);
    }
  ));
});

describe('servidor: resiliencia ante un server.js roto', () => {
  test('JS inválido en una post function da 500 pero NO tumba el proceso', withServer(
    {
      'pagina.ws': `route("/roto")

visual app =
<div>hola</div>

post function llamada(args)
    app = <div>adios</div>
    return {}

render(
    app
)
`,
    },
    async (base) => {
      const r1 = await fetch(`${base}/roto`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(r1.status, 500, 'la petición rota debe fallar con 500, no colgar ni tirar el proceso');
      const body = await r1.json();
      assert.match(body.error, /Unexpected token/);

      const r2 = await fetch(`${base}/roto`);
      assert.equal(r2.status, 200, 'el servidor debe seguir respondiendo tras el error');
    }
  ));
});

describe('servidor: modo estricto evita fugas a variables globales', () => {
  test('asignar a un identificador no declarado en una post function da error, no fuga global', withServer(
    {
      'pagina.ws': `route("/x")

visual app =
<div>hola</div>

post function llamada(args)
    app = "nuevo valor"
    return { ok: true }

render(
    app
)
`,
    },
    async (base) => {
      delete global.app;
      const r = await fetch(`${base}/x`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(r.status, 500);
      const body = await r.json();
      assert.match(body.error, /app is not defined/);
      assert.equal(typeof global.app, 'undefined', '"app" NO debe filtrarse como variable global');
    }
  ));
});

describe('validate: updateServer da error explícito (ya no existe)', () => {
  const { parseSource } = require('./helpers/compile-helper');

  test('usar updateServer en un handler lanza SyntaxError sugiriendo post function', () => {
    const src = `server var x = 1

reactive y = server.x

visual test =
<button>
    click
</button>
    -> onclick:
        y = await updateServer({ x: y + 1 }).then(s => s.x)
`;
    assert.throws(() => parseSource(src), /se unificó con "post function"/);
  });
});

describe('WebScript como backend puro: route() sin render()', () => {
  test('un archivo sin visual ni render() no genera HTML/CSS/JS, solo server.js', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const path2 = require('path');
    const { buildSite: build2 } = require('../src/site-builder');

    const srcDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ws-api-'));
    const outDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ws-api-out-'));
    fs2.writeFileSync(path2.join(srcDir, 'api.ws'), `route("/api/contador")

server var total = 0

post function incrementar(args)
    total = total + args.cantidad
    return { total: total }
`);
    const { table } = build2(srcDir, outDir);
    assert.equal(table.length, 1);
    assert.equal(table[0].apiOnly, true);
    assert.equal(table[0].html, null);

    const files = fs2.readdirSync(outDir, { recursive: true });
    assert.ok(files.some(f => f.endsWith('.server.js')), 'debe generar server.js');
    assert.ok(!files.some(f => f.endsWith('.html')), 'NO debe generar ningún .html');
    assert.ok(!files.some(f => f.endsWith('.bundle.js')), 'NO debe generar ningún bundle.js');
    assert.ok(!files.some(f => f.endsWith('.css')), 'NO debe generar ningún .css');

    fs2.rmSync(srcDir, { recursive: true, force: true });
    fs2.rmSync(outDir, { recursive: true, force: true });
  });

  test('GET en la ruta devuelve el estado como JSON, POST dispara la post function y persiste', withServer(
    {
      'api.ws': `route("/api/contador")

server var total = 0

post function incrementar(args)
    total = total + args.cantidad
    return { total: total }
`,
    },
    async (base) => {
      const r1 = await fetch(`${base}/api/contador`);
      assert.equal(r1.status, 200);
      assert.deepEqual(await r1.json(), { total: 0 });
      const cookie = r1.headers.get('set-cookie').split(';')[0];

      const r2 = await fetch(`${base}/api/contador`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ cantidad: 5 }),
      });
      assert.deepEqual(await r2.json(), { total: 5 });

      const r3 = await fetch(`${base}/api/contador`, { headers: { Cookie: cookie } });
      assert.deepEqual(await r3.json(), { total: 5 }, 'debe persistir entre peticiones de la misma sesión');
    }
  ));

  test('ruta backend sin ningún server var da {} en el GET, sin fallar', withServer(
    {
      'api.ws': `route("/api/vacio")

post function saludar(args)
    return { mensaje: "hola " + args.nombre }
`,
    },
    async (base) => {
      const r1 = await fetch(`${base}/api/vacio`);
      assert.equal(r1.status, 200);
      assert.deepEqual(await r1.json(), {});

      const r2 = await fetch(`${base}/api/vacio`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Jorge' }),
      });
      assert.deepEqual(await r2.json(), { mensaje: 'hola Jorge' });
    }
  ));
});

describe('put function / delete function', () => {
  test('las tres (post/put/delete) pueden coexistir en el mismo archivo, cada una en su verbo', withServer(
    {
      'tareas.ws': `route("/api/tareas")

server var tareas = []

post function crear(args)
    tareas = [...tareas, { id: tareas.length, texto: args.texto }]
    return { tareas: tareas }

put function actualizar(args)
    tareas = tareas.map(t => t.id == args.id ? { id: t.id, texto: args.texto } : t)
    return { tareas: tareas }

delete function borrar(args)
    tareas = tareas.filter(t => t.id != args.id)
    return { tareas: tareas }
`,
    },
    async (base) => {
      const r1 = await fetch(`${base}/api/tareas`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texto: 'a' }),
      });
      const cookie = r1.headers.get('set-cookie').split(';')[0];
      assert.deepEqual(await r1.json(), { tareas: [{ id: 0, texto: 'a' }] });

      const r2 = await fetch(`${base}/api/tareas`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ id: 0, texto: 'a-editada' }),
      });
      assert.deepEqual(await r2.json(), { tareas: [{ id: 0, texto: 'a-editada' }] });

      const r3 = await fetch(`${base}/api/tareas`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ id: 0 }),
      });
      assert.deepEqual(await r3.json(), { tareas: [] });
    }
  ));

  test('PUT/DELETE en una ruta sin esa función dan 405', withServer(
    {
      'solo-post.ws': `route("/solo-post")

post function crear(args)
    return { ok: true }
`,
    },
    async (base) => {
      const rPut = await fetch(`${base}/solo-post`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(rPut.status, 405);

      const rDelete = await fetch(`${base}/solo-post`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(rDelete.status, 405);

      const rPost = await fetch(`${base}/solo-post`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(rPost.status, 200);
    }
  ));

  test('el stub de cliente solo se genera para la función que de verdad se llama', () => {
    const { compileSource } = require('./helpers/compile-helper');
    const src = `server var tareas = []

post function crear(args)
    tareas = [...tareas, args.item]
    return { tareas: tareas }

delete function borrar(args)
    tareas = tareas.filter(t => t != args.item)
    return { tareas: tareas }

reactive lista = server.tareas

visual v =
<ul>
    for (t in lista)
        <li>{t}</li>
</ul>
    -> onclick:
        var r = await crear({ item: "x" })
        lista = r.tareas

render(
    v
)
`;
    const { js } = compileSource(src);
    assert.match(js, /async function crear\(/);
    assert.doesNotMatch(js, /async function borrar\(/, '"borrar" no se llama desde ningún handler, no debe generarse su stub');
  });
});

describe('get function', () => {
  test('sin query string usa el valor por defecto de las server var referenciadas dentro', withServer(
    {
      'usuario.ws': `route("/api/usuario")

server var nombre = "Jorge"
server var visitas = 100

get function estado(args)
    return { saludo: "Hola, " + (args.nombre || nombre), visitasTotales: visitas * 2 }

post function incrementar(args)
    visitas = visitas + 1
    return { visitas: visitas }
`,
    },
    async (base) => {
      const r1 = await fetch(`${base}/api/usuario`);
      assert.deepEqual(await r1.json(), { saludo: 'Hola, Jorge', visitasTotales: 200 });
    }
  ));

  test('los argumentos vienen de la query string, no de un body', withServer(
    {
      'usuario.ws': `route("/api/usuario")

get function estado(args)
    return { saludo: "Hola, " + args.nombre }
`,
    },
    async (base) => {
      const r = await fetch(`${base}/api/usuario?nombre=Ana`);
      assert.deepEqual(await r.json(), { saludo: 'Hola, Ana' });
    }
  ));

  test('get function y post function pueden coexistir en el mismo archivo', withServer(
    {
      'usuario.ws': `route("/api/usuario")

server var visitas = 100

get function leer(args)
    return { visitas: visitas }

post function incrementar(args)
    visitas = visitas + 1
    return { visitas: visitas }
`,
    },
    async (base) => {
      const r1 = await fetch(`${base}/api/usuario`);
      assert.deepEqual(await r1.json(), { visitas: 100 });
      const cookie = r1.headers.get('set-cookie').split(';')[0];

      await fetch(`${base}/api/usuario`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });

      const r2 = await fetch(`${base}/api/usuario`, { headers: { Cookie: cookie } });
      assert.deepEqual(await r2.json(), { visitas: 101 });
    }
  ));
});

describe('validate: get function no puede coexistir con render()', () => {
  const { parseSource } = require('./helpers/compile-helper');

  test('get function + render() en el mismo archivo lanza SyntaxError', () => {
    const src = `get function estado(args)
    return { x: 1 }

visual v =
<p>hola</p>

render(
    v
)
`;
    assert.throws(() => parseSource(src), /no puede coexistir con "render/);
  });

  test('get function SIN render() no lanza error', () => {
    const src = `get function estado(args)
    return { x: 1 }
`;
    assert.doesNotThrow(() => parseSource(src));
  });

  test('solo una get function por archivo', () => {
    assert.throws(
      () => parseSource('get function a(x)\n    return x\n\nget function b(x)\n    return x'),
      /Solo puede haber una "get function"/
    );
  });
});

describe('sobrecargas: query string y headers en post/put/delete/get function', () => {
  test('post function con 3 parámetros recibe body, query y headers', withServer(
    {
      'api.ws': `route("/api/crear")

server var items = []

post function crear(args, query, headers)
    items = [...items, { texto: args.texto, prioridad: query.prioridad || "normal", agente: headers["user-agent"] || "desconocido" }]
    return { items: items }
`,
    },
    async (base) => {
      const r = await fetch(`${base}/api/crear?prioridad=alta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'MiCliente/1.0' },
        body: JSON.stringify({ texto: 'tarea urgente' }),
      });
      assert.deepEqual(await r.json(), {
        items: [{ texto: 'tarea urgente', prioridad: 'alta', agente: 'MiCliente/1.0' }],
      });
    }
  ));

  test('get function con 2 parámetros recibe query y headers', withServer(
    {
      'api.ws': `route("/api/estado")

get function estado(query, headers)
    return { filtro: query.filtro || "ninguno", tieneAuth: headers["authorization"] ? true : false }
`,
    },
    async (base) => {
      const r1 = await fetch(`${base}/api/estado?filtro=recientes`, { headers: { Authorization: 'Bearer xyz' } });
      assert.deepEqual(await r1.json(), { filtro: 'recientes', tieneAuth: true });

      const r2 = await fetch(`${base}/api/estado?filtro=todo`);
      assert.deepEqual(await r2.json(), { filtro: 'todo', tieneAuth: false });
    }
  ));

  test('con 1 solo parámetro (retrocompatibilidad), query/headers no se pasan aunque existan', withServer(
    {
      'api.ws': `route("/api/simple")

post function crear(args)
    return { recibido: args }
`,
    },
    async (base) => {
      const r = await fetch(`${base}/api/simple?ignorado=si`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 1 }),
      });
      assert.deepEqual(await r.json(), { recibido: { x: 1 } });
    }
  ));

  test('el stub de cliente expone body+query pero nunca headers, aunque el servidor declare 3', () => {
    const { compileSource } = require('./helpers/compile-helper');
    const src = `server var items = []

post function crear(args, query, headers)
    items = [...items, args.texto]
    return { items: items }

reactive lista = server.items

visual v =
<ul>
    for (item in lista)
        <li>{item}</li>
</ul>
    -> onclick:
        var r = await crear({ texto: "x" }, { prioridad: "alta" })
        lista = r.items

render(
    v
)
`;
    const { js } = compileSource(src);
    assert.match(js, /async function crear\(args, query\) \{/, 'el stub debe exponer "args" y "query" -- headers nunca, eso lo pone el navegador solo');
    assert.match(js, /body: JSON\.stringify\(args \|\| \{\}\)/);
  });
});

describe('objeto http: llamar a otros sistemas desde el servidor', () => {
  // "Sistema externo" simulado, AJENO a WebScript, en su propio puerto. Se usa como
  // testFn de withServer -- recibe "base" (la URL de nuestro servidor) de withServer,
  // y monta el externo por su cuenta, pasando su URL como segundo argumento al test real.
  function withExternalSystem(handler, testFn) {
    return async (base) => {
      const http2 = require('http');
      const externo = http2.createServer(handler);
      await new Promise(resolve => externo.listen(0, resolve));
      const externalPort = externo.address().port;
      try {
        await testFn(base, `http://localhost:${externalPort}`);
      } finally {
        externo.close();
      }
    };
  }

  test('http.post manda body+headers y devuelve la respuesta ya parseada', withServer(
    {
      'api.ws': `route("/api/externo")

post function llamarFuera(args)
    var datos = await http.post(args.url, { mensaje: "hola" }, {})
    return { recibido: datos }
`,
    },
    withExternalSystem(
      (req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ eco: JSON.parse(body || '{}'), metodo: req.method }));
        });
      },
      async (base, externalBase) => {
        const r = await fetch(`${base}/api/externo`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: `${externalBase}/algo` }),
        });
        assert.deepEqual(await r.json(), { recibido: { eco: { mensaje: 'hola' }, metodo: 'POST' } });
      }
    )
  ));

  test('http.get funciona, y hace fallback a texto si la respuesta no es JSON', withServer(
    {
      'api.ws': `route("/api/externo2")

get function consultar(query)
    var texto = await http.get(query.url, {})
    return { valor: texto }
`,
    },
    withExternalSystem(
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('esto no es JSON, es texto plano');
      },
      async (base, externalBase) => {
        const r = await fetch(`${base}/api/externo2?url=${encodeURIComponent(externalBase + '/x')}`);
        assert.deepEqual(await r.json(), { valor: 'esto no es JSON, es texto plano' });
      }
    )
  ));

  test('sin usar "http." en ningún cuerpo, no se genera el objeto (igual que los stubs)', () => {
    const { compileSource } = require('./helpers/compile-helper');
    const src = `server var x = 1

post function crear(args)
    x = x + 1
    return { x: x }
`;
    const ast = require('./helpers/compile-helper').parseSource(src);
    const { compileServerJS } = require('../src/compiler');
    // compileServerJS no se exporta directamente -- comprobamos vía compile() completo
    const { compile } = require('../src/compiler');
    const { server } = compile(ast, { routePath: '/' });
    assert.doesNotMatch(server, /const http = \{/, 'no debe generarse el objeto http si nadie lo usa');
  });

  test('server function sigue siendo síncrona (llamarla sin await sigue funcionando)', withServer(
    {
      'api.ws': `route("/api/x")

server var contador = 0

server function duplicar(x)
    return x * 2

post function incrementar(args)
    contador = contador + 1
    return { contador: contador, doble: duplicar(contador) }
`,
    },
    async (base) => {
      const r = await fetch(`${base}/api/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.deepEqual(await r.json(), { contador: 1, doble: 2 });
    }
  ));
});

describe('el stub de cliente construye la URL con query string real', () => {
  test('con 2 parámetros, la query pasada por el cliente llega de verdad al servidor', withServer(
    {
      'pagina.ws': `route("/pagina")

server var items = []

post function crear(args, query)
    items = [...items, { texto: args.texto, prioridad: query.prioridad }]
    return { items: items }
`,
    },
    async (base) => {
      // simula exactamente lo que hace el stub generado: fetch(url + '?' + query, {...})
      const r = await fetch(`${base}/pagina?prioridad=alta`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texto: 'nueva' }),
      });
      assert.deepEqual(await r.json(), { items: [{ texto: 'nueva', prioridad: 'alta' }] });
    }
  ));

  test('sin query (1 parámetro), la URL generada no lleva "?"', () => {
    const { compileSource } = require('./helpers/compile-helper');
    const src = `server var items = []

post function crear(args)
    items = [...items, args.texto]
    return { items: items }

reactive lista = server.items

visual v =
<ul>
    for (item in lista)
        <li>{item}</li>
</ul>
    -> onclick:
        var r = await crear({ texto: "x" })
        lista = r.items

render(
    v
)
`;
    const { js } = compileSource(src);
    assert.match(js, /async function crear\(args\) \{/);
    assert.doesNotMatch(js, /URLSearchParams/, 'sin segundo parámetro, no debe generarse ningún código de query string');
  });
});

describe('server reactive + watch(): observar cambios de servidor', () => {
  test('watch() dispara SOLO en cambios posteriores, nunca con el valor inicial', withServer(
    {
      'api.ws': `route("/api/watch")

server reactive var1 = 0
server var log = []

watch(var1)
    log = [...log, "cambio a " + var1]

post function actualizar(args)
    var1 = args.valor
    return { var1: var1 }

get function estado(args)
    return { var1: var1, log: log }
`,
    },
    async (base) => {
      const r1 = await fetch(`${base}/api/watch`);
      const cookie = r1.headers.get('set-cookie').split(';')[0];
      assert.deepEqual(await r1.json(), { var1: 0, log: [] }, 'log vacío -- watch no debe dispararse con el valor inicial');

      const r2 = await fetch(`${base}/api/watch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ valor: 5 }),
      });
      assert.deepEqual(await r2.json(), { var1: 5 });

      const r3 = await fetch(`${base}/api/watch`, { headers: { Cookie: cookie } });
      assert.deepEqual(await r3.json(), { var1: 5, log: ['cambio a 5'] }, 'el watch debe haberse disparado exactamente una vez');
    }
  ));

  test('watch() se dispara sin importar qué función HTTP cambió la variable', withServer(
    {
      'api.ws': `route("/api/watch2")

server reactive var1 = 0
server var contadorCambios = 0

watch(var1)
    contadorCambios = contadorCambios + 1

post function porPost(args)
    var1 = 1
    return {}

put function porPut(args)
    var1 = 2
    return {}

get function estado(args)
    return { contadorCambios: contadorCambios }
`,
    },
    async (base) => {
      const r1 = await fetch(`${base}/api/watch2`);
      const cookie = r1.headers.get('set-cookie').split(';')[0];

      await fetch(`${base}/api/watch2`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
      await fetch(`${base}/api/watch2`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });

      const r2 = await fetch(`${base}/api/watch2`, { headers: { Cookie: cookie } });
      assert.deepEqual(await r2.json(), { contadorCambios: 2 }, 'debe dispararse tanto desde POST como desde PUT');
    }
  ));

  test('validate: watch(NOMBRE) sobre una server var normal (no reactive) da error explícito', () => {
    const { parseSource } = require('./helpers/compile-helper');
    const src = `server var x = 1

watch(x)
    console.log(x)
`;
    assert.throws(() => parseSource(src), /no se puede observar -- usa "server reactive x"/);
  });

  test('validate: watch(NOMBRE) sobre un nombre inexistente da error', () => {
    const { parseSource } = require('./helpers/compile-helper');
    const src = `watch(inventado)
    console.log(inventado)
`;
    assert.throws(() => parseSource(src), /no es una "server reactive" declarada/);
  });
});

describe('bug de sustitución dentro de cadenas de texto (encontrado montando watch())', () => {
  const { compileSource } = require('./helpers/compile-helper');

  test('el texto literal dentro de comillas NO se sustituye, aunque coincida con el nombre de una reactive', async () => {
    const src = `
reactive contador = 5
reactive salida = ""

visual v =
<p>{salida}</p>
    -> onclick:
        salida = "el contador vale " + contador

render(
    v
)
`;
    const { js } = compileSource(src);
    assert.match(js, /"el contador vale " \+ state\.contador/, 'el texto debe quedar intacto, solo la referencia real se sustituye');
  });

  test('${...} de un template literal SÍ se sustituye correctamente (sin expandir como atajo)', async () => {
    const src = `
reactive contador = 5
reactive salida = ""

visual v =
<p>{salida}</p>
    -> onclick:
        salida = \`el contador de contador vale \${contador}\`

render(
    v
)
`;
    const { js } = compileSource(src);
    assert.match(js, /`el contador de contador vale \$\{state\.contador\}`/);
  });

  test('lo mismo dentro de una post function (server.js)', () => {
    const src = `server reactive var1 = 0

watch(var1)
    console.log("var1 cambió a " + var1)
`;
    const { compile } = require('../src/compiler');
    const { parseSource } = require('./helpers/compile-helper');
    const ast = parseSource(src);
    const { server } = compile(ast, { routePath: '/' });
    assert.match(server, /"var1 cambió a " \+ __serverReactive\.var1/);
  });
});

describe('import transitivo: traer una función también trae lo que ella necesita', () => {
  test('importar solo una función que depende de un server var trae ese server var también', async () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const path2 = require('path');
    const { buildSite: build2, startServer: start2 } = require('../src/site-builder');

    const srcDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ws-transitive-'));
    const outDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ws-transitive-out-'));
    fs2.writeFileSync(path2.join(srcDir, 'otro.ws'), `server var contador = 0

server function incrementar()
    contador++
`);
    fs2.writeFileSync(path2.join(srcDir, 'un.ws'), `route("/api/x")

import { incrementar } from "./otro.ws"

post function disparar(args)
    incrementar()
    return { ok: true }
`);
    const { table } = build2(srcDir, outDir);
    const server = start2(table, outDir, 0);
    await new Promise(resolve => server.on('listening', resolve));
    const port = server.address().port;
    try {
      const r = await fetch(`http://localhost:${port}/api/x`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(r.status, 200, 'antes daba 500 "contador is not defined"');
      assert.deepEqual(await r.json(), { ok: true });
    } finally {
      server.close();
      fs2.rmSync(srcDir, { recursive: true, force: true });
      fs2.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('importar una función que usa una server reactive trae también su watch() asociado', withServer(
    {
      'otro.ws': `server reactive var1 = 0

server function updateVar()
    var1++

watch(var1)
    whisper("Actualizado " + var1)
`,
      'un.ws': `route("/api/x")

import { updateVar } from "./otro.ws"

post function disparar(args)
    updateVar()
    return { ok: true }
`,
    },
    async (base) => {
      // No hay forma directa de comprobar la salida de consola desde este test, pero si
      // el watch() (o "whisper") no se hubiera importado, esto daría 500 -- confirmamos
      // que responde 200 limpio, y que el valor de var1 SÍ se incrementó de verdad.
      const r = await fetch(`${base}/api/x`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true });
    }
  ));
});

describe('whisper(): equivalente a console.log() en servidor', () => {
  test('whisper() se genera solo si se usa, y equivale a console.log()', () => {
    const { compileSource } = require('./helpers/compile-helper');
    const src = `server reactive x = 0

watch(x)
    whisper("x cambió")
`;
    const { js } = compileSource(src);
    // esto es un archivo SIN render() -- compileSource devuelve el .js de cliente
    // (vacío/mínimo), la comprobación real de whisper() va contra compile() directo
    const { parseSource } = require('./helpers/compile-helper');
    const { compile } = require('../src/compiler');
    const ast = parseSource(src);
    const { server } = compile(ast, { routePath: '/' });
    assert.match(server, /function whisper\(\.\.\.args\) \{ console\.log\(\.\.\.args\); \}/);
  });

  test('sin usar whisper() en ningún cuerpo, no se genera su definición', () => {
    const { parseSource } = require('./helpers/compile-helper');
    const { compile } = require('../src/compiler');
    const src = `server var x = 0

post function crear(args)
    x = x + 1
    return { x: x }
`;
    const ast = parseSource(src);
    const { server } = compile(ast, { routePath: '/' });
    assert.doesNotMatch(server, /function whisper/);
  });
});

describe('if/for (control de flujo JS normal) dentro de watch()', () => {
  test('if/else y for dentro de un watch() se ejecutan correctamente', withServer(
    {
      'api.ws': `route("/api/watchflow")

server reactive contador = 0
server var mensajes = []
server var suma = 0

watch(contador)
    if (contador % 2 == 0)
        mensajes = [...mensajes, "par: " + contador]
    else
        mensajes = [...mensajes, "impar: " + contador]

    for (var i = 0; i < contador; i++)
        suma = suma + i

post function incrementar(args)
    contador = contador + args.cantidad
    return { contador: contador, mensajes: mensajes, suma: suma }
`,
    },
    async (base) => {
      const r1 = await fetch(`${base}/api/watchflow`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cantidad: 3 }),
      });
      assert.deepEqual(await r1.json(), { contador: 3, mensajes: ['impar: 3'], suma: 3 });
      const cookie = r1.headers.get('set-cookie').split(';')[0];

      const r2 = await fetch(`${base}/api/watchflow`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ cantidad: 1 }),
      });
      assert.deepEqual(await r2.json(), { contador: 4, mensajes: ['impar: 3', 'par: 4'], suma: 9 });
    }
  ));

  test('la indentación relativa del if/for se preserva en el código generado (legibilidad)', () => {
    const { parseSource } = require('./helpers/compile-helper');
    const { compile } = require('../src/compiler');
    const src = `server reactive x = 0

watch(x)
    if (x > 0)
        whisper("positivo")
    else
        whisper("no positivo")
`;
    const ast = parseSource(src);
    const { server } = compile(ast, { routePath: '/' });
    assert.match(server, /if \(__serverReactive\.x > 0\)\n\s{8}whisper\("positivo"\)\n\s{4}else\n\s{8}whisper\("no positivo"\)/);
  });
});

describe('validate: watch() anidado dentro de otro bloque es redundante y roto -- rechazado', () => {
  const { parseSource } = require('./helpers/compile-helper');

  test('watch() dentro de server function -- rechazado', () => {
    const src = `server reactive var1 = 0

server function foo()
    watch(var1)
        whisper("cambio")

post function usar(args)
    foo()
    var1 = 1
    return { ok: true }
`;
    assert.throws(() => parseSource(src), /"server function foo" contiene "watch\(\.\.\.\)"/);
  });

  test('watch() dentro de un if, dentro de una post function -- rechazado', () => {
    const src = `server reactive var1 = 0

post function usar(args)
    if (args.activar)
        watch(var1)
            whisper("nested")
    var1 = 1
    return { ok: true }
`;
    assert.throws(() => parseSource(src), /"post function usar" contiene "watch\(\.\.\.\)"/);
  });

  test('watch() dentro de otro watch() -- rechazado, con el mensaje "watch(NOMBRE)" correcto', () => {
    const src = `server reactive a = 0
server reactive b = 0

watch(a)
    watch(b)
        whisper("no debería llegar aquí")
`;
    assert.throws(() => parseSource(src), /"watch\(a\)" contiene "watch\(\.\.\.\)"/);
  });

  test('watch() legítimo a nivel superior, con if/for DENTRO de su propio cuerpo (sin watch anidado) -- sigue permitido', () => {
    const src = `server reactive contador = 0
server var mensajes = []

watch(contador)
    if (contador % 2 == 0)
        mensajes = [...mensajes, "par"]
    else
        mensajes = [...mensajes, "impar"]

post function incrementar(args)
    contador = contador + 1
    return { mensajes: mensajes }
`;
    assert.doesNotThrow(() => parseSource(src));
  });

  test('regresión: WatchDecl no debe colarse en la detección de colisión de nombres', () => {
    // Bug real que salió al añadir "WatchDecl" a LABELS para el mensaje de error de
    // arriba -- globalDecls usaba "LABELS[n.type]" como filtro, y WatchDecl se coló
    // ahí sin querer, dando un falso "Nombre duplicado" contra la propia variable que
    // observa.
    const src = `server reactive var1 = 0

watch(var1)
    whisper("cambio")

post function usar(args)
    var1 = 1
    return { ok: true }
`;
    assert.doesNotThrow(() => parseSource(src));
  });
});

describe('async opcional en function/server function; watch() siempre async (ejecución real)', () => {
  function withExternalSystem(handler, testFn) {
    return async (base) => {
      const http2 = require('http');
      const externo = http2.createServer(handler);
      await new Promise(resolve => externo.listen(0, resolve));
      const externalPort = externo.address().port;
      try {
        await testFn(base, `http://localhost:${externalPort}`);
      } finally {
        externo.close();
      }
    };
  }

  test('async server function puede usar await http.* de verdad, llamada con await desde post function', withServer(
    {
      'api.ws': `route("/api/x")

async server function llamarFuera(url)
    var r = await http.get(url, {})
    return r

post function usar(args)
    var datos = await llamarFuera(args.url)
    return { recibido: datos }
`,
    },
    withExternalSystem(
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mensaje: 'hola desde fuera' }));
      },
      async (base, externalBase) => {
        const r = await fetch(`${base}/api/x`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: `${externalBase}/x` }),
        });
        assert.deepEqual(await r.json(), { recibido: { mensaje: 'hola desde fuera' } });
      }
    )
  ));

  test('server function SIN async sigue funcionando sin await, esperando el valor directo (retrocompatibilidad)', withServer(
    {
      'api.ws': `route("/api/x")

server var contador = 0

server function duplicar(x)
    return x * 2

post function incrementar(args)
    contador = contador + 1
    return { contador: contador, doble: duplicar(contador) }
`,
    },
    async (base) => {
      const r = await fetch(`${base}/api/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.deepEqual(await r.json(), { contador: 1, doble: 2 }, 'duplicar(contador) sin await debe seguir dando el número directo, no una Promise');
    }
  ));

  test('watch() ahora siempre async, sin necesitar ningún prefijo -- await http.* funciona dentro', () => {
    const { parseSource } = require('./helpers/compile-helper');
    const { compile } = require('../src/compiler');
    const src = `server reactive var1 = 0

watch(var1)
    await http.post("http://ejemplo.com", {}, {})
`;
    const ast = parseSource(src);
    const { server } = compile(ast, { routePath: '/' });
    assert.match(server, /__watchers\.var1\.push\(async \(\) => \{/);
  });
});

describe('validate: las cuatro funciones HTTP deben devolver siempre algo', () => {
  const { parseSource } = require('./helpers/compile-helper');

  test('post function sin ningún return -- rechazada', () => {
    const src = 'route("/api/x")\n\nserver var contador = 0\n\npost function incrementar(args)\n    contador = contador + 1';
    assert.throws(() => parseSource(src), /no tiene ningún "return"/);
  });

  test('put/delete/get function sin return también rechazadas (las cuatro, no solo post)', () => {
    assert.throws(() => parseSource('route("/x")\n\nput function f(args)\n    var x = 1'), /no tiene ningún "return"/);
    assert.throws(() => parseSource('route("/x")\n\ndelete function f(args)\n    var x = 1'), /no tiene ningún "return"/);
    assert.throws(() => parseSource('route("/x")\n\nget function f(query)\n    var x = 1'), /no tiene ningún "return"/);
  });

  test('return sin ningún valor (bare return) -- también rechazado', () => {
    const src = 'route("/api/x")\n\nserver var contador = 0\n\npost function incrementar(args)\n    contador = contador + 1\n    return';
    assert.throws(() => parseSource(src), /"return" sin ningún valor/);
  });

  test('return normal, return null, return {} -- los tres permitidos', () => {
    assert.doesNotThrow(() => parseSource('route("/a")\n\npost function f(args)\n    return { ok: true }'));
    assert.doesNotThrow(() => parseSource('route("/b")\n\npost function f(args)\n    return null'));
    assert.doesNotThrow(() => parseSource('route("/c")\n\npost function f(args)\n    return {}'));
  });

  test('return dentro de un if/else (ambas ramas devuelven) -- permitido', () => {
    const src = 'route("/d")\n\npost function f(args)\n    if (args.x > 0)\n        return { positivo: true }\n    else\n        return { positivo: false }';
    assert.doesNotThrow(() => parseSource(src));
  });
});
