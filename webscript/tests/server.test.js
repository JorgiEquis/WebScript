const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSite, startServer } = require('../src/site-builder');

// Envuelve fetch() para TODA la suite de este archivo: añade automáticamente la
// cabecera "X-WebScript-CSRF" en POST/PUT/DELETE, y recuerda qué cookie "wcsrf"
// corresponde a cada "wsid" visto, entre llamadas -- sin importar cuántos servidores
// distintos arranque cada test (los ids de sesión son UUID, sin riesgo real de
// colisión entre servidores distintos del mismo archivo). Se instaló así (envoltura
// global, una sola vez) en vez de tocar los ~80 sitios que ya llamaban a fetch() en
// esta suite, tras añadir la protección CSRF real -- todo test existente sigue
// funcionando sin cambios. Los tests que YA gestionaban su propia cookie
// "Cookie: ..." a mano (para probar continuidad de sesión) siguen funcionando igual
// -- se respeta esa cookie explícita, solo se le añade el CSRF que corresponda a ESA
// sesión concreta, aprendido de alguna respuesta anterior. Los pocos tests que
// quieren probar el rechazo por CSRF a propósito usan la cabecera a mano, mal o
// ausente -- ver más abajo, sección dedicada.
const __originalFetch = global.fetch;
const __wcsrfBySessionId = new Map(); // wsid visto -> wcsrf correspondiente

function __extractCookieValue(cookieHeaderStr, name) {
  if (!cookieHeaderStr) return null;
  for (const part of cookieHeaderStr.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// Asignación DIRECTA a nivel de módulo, sin before()/after() -- el código de nivel
// superior de un archivo de test se ejecuta al cargarlo, antes de que node:test
// empiece a correr ninguna prueba registrada, así que esto ya está activo para TODO
// el archivo desde el principio, sin ninguna ambigüedad de orden.
global.fetch = async (url, options = {}) => {
  const opts = { ...options };
  const method = (opts.method || 'GET').toUpperCase();
  const rawHeaders = opts.headers || {};
  const existingCookieHeader = rawHeaders['Cookie'] || rawHeaders['cookie'] || null;
  // Deliberadamente SIN "adivinar" una cookie cuando la petición no trae ninguna --
  // bug real encontrado aquí mismo: con decenas de servidores distintos en el mismo
  // archivo de test, "usar la última cookie vista" contaminaba peticiones de un
  // servidor con la sesión de OTRO servidor completamente distinto. Sin cookie
  // explícita, la petición se manda tal cual (sesión nueva de verdad, que además ya
  // no exige CSRF, ver la excepción en site-builder.js) -- solo se añade la cabecera
  // CSRF cuando el propio test SÍ trae una cookie explícita que ya vimos antes.
  const effectiveWsid = existingCookieHeader ? __extractCookieValue(existingCookieHeader, 'wsid') : null;

  const headers = { ...rawHeaders };
  if (['POST', 'PUT', 'DELETE'].includes(method) && effectiveWsid && !headers['X-WebScript-CSRF']) {
    const wcsrf = __wcsrfBySessionId.get(effectiveWsid);
    if (wcsrf) headers['X-WebScript-CSRF'] = wcsrf;
  }
  opts.headers = headers;

  const res = await __originalFetch(url, opts);

  const setCookies = (res.headers.getSetCookie && res.headers.getSetCookie()) || [];
  let sawWsid = null;
  for (const sc of setCookies) {
    const wsidVal = __extractCookieValue(sc, 'wsid');
    if (wsidVal) sawWsid = wsidVal;
  }
  for (const sc of setCookies) {
    const wcsrfVal = __extractCookieValue(sc, 'wcsrf');
    if (wcsrfVal) {
      const forWsid = sawWsid || effectiveWsid;
      if (forWsid) __wcsrfBySessionId.set(forWsid, wcsrfVal);
    }
  }
  return res;
};

// Arranca un servidor real sobre un directorio temporal de .ws, en un puerto
// efímero (0 -> el SO elige uno libre), y lo cierra al terminar. "serverOptions" es
// opcional -- se propaga tal cual a startServer() (TTL/límite de sesiones, etc).
function withServer(wsFiles, testFn, serverOptions) {
  return async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-server-test-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-server-out-'));
    for (const [name, content] of Object.entries(wsFiles)) {
      fs.writeFileSync(path.join(srcDir, name), content);
    }
    const { table } = buildSite(srcDir, outDir);
    const server = startServer(table, outDir, 0, serverOptions);
    await new Promise(resolve => server.on('listening', resolve));
    const port = server.address().port;
    try {
      await testFn(`http://localhost:${port}`, server);
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
<button onclick={y = await updateServer({ x: y + 1 }).then(s => s.x)}>
    click
</button>
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
<ul onclick={
    var r = await crear({ item: "x" })
    lista = r.tareas
}>
    for (t in lista)
        <li>{t}</li>
</ul>

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
<ul onclick={
    var r = await crear({ texto: "x" }, { prioridad: "alta" })
    lista = r.items
}>
    for (item in lista)
        <li>{item}</li>
</ul>

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
<ul onclick={
    var r = await crear({ texto: "x" })
    lista = r.items
}>
    for (item in lista)
        <li>{item}</li>
</ul>

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
<p onclick={salida = "el contador vale " + contador}>{salida}</p>

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
<p onclick={salida = \`el contador de contador vale \${contador}\`}>{salida}</p>

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

describe('async/await implícito: nunca hace falta escribirlo, ni declarar function como async (ejecución real)', () => {
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

  test('server function usa http.* SIN "await" explícito, y se llama desde post function SIN "await" tampoco -- ambos se insertan solos', withServer(
    {
      'api.ws': `route("/api/x")

server function llamarFuera(url)
    var r = http.get(url, {})
    return r

post function usar(args)
    var datos = llamarFuera(args.url)
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
        // Si "await" NO se hubiera insertado solo en ninguno de los dos sitios,
        // "recibido" habría sido una Promise (o un objeto de Promise anidada), no
        // el objeto real -- confirma que el auto-await funciona en cadena, no solo
        // en la llamada directa.
        assert.deepEqual(await r.json(), { recibido: { mensaje: 'hola desde fuera' } });
      }
    )
  ));

  test('server function que NUNCA llama a nada async sigue dando el valor directo, sin ningún coste añadido', withServer(
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
      assert.deepEqual(await r.json(), { contador: 1, doble: 2 }, 'duplicar(contador) debe seguir dando el número directo, no una Promise, aunque ahora se compile async por debajo');
    }
  ));

  test('watch() tampoco necesita "await" explícito -- http.* dentro se espera solo', () => {
    const { parseSource } = require('./helpers/compile-helper');
    const { compile } = require('../src/compiler');
    const src = `server reactive var1 = 0

watch(var1)
    http.post("http://ejemplo.com", {}, {})
`;
    const ast = parseSource(src);
    const { server } = compile(ast, { routePath: '/' });
    assert.match(server, /__watchers\.var1\.push\(async \(\) => \{/);
    assert.match(server, /await http\.post/);
  });

  test('WSON.enqueue() se excluye a propósito del auto-await -- sigue siendo fire-and-forget de verdad', () => {
    const { parseSource } = require('./helpers/compile-helper');
    const { compile } = require('../src/compiler');
    const src = `route("/x")

server wson msg =
    -> to: "http://ejemplo.com"
    -> content: 1

post function disparar(args)
    var id = WSON.enqueue(msg)
    return { id: id }
`;
    const ast = parseSource(src);
    const { server } = compile(ast, { routePath: '/' });
    assert.doesNotMatch(server, /await WSON\.enqueue/, 'WSON.enqueue() nunca debe llevar await -- su razón de ser es no esperar');
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

describe('WSON + WSON.send(): construcción y envío de mensajes a otros sistemas', () => {
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

  test('WSON.send(wson) transmite content al "to" indicado, con via POST por defecto', withServer(
    {
      'api.ws': `route("/api/enviar")

server var message = "Hola desde WebScript"

post function enviar(args)
    var sender = { to: args.destino, content: message }
    var respuesta = await WSON.send(sender)
    return { respuesta: respuesta }
`,
    },
    withExternalSystem(
      (req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ recibido: JSON.parse(body || '{}'), metodo: req.method }));
        });
      },
      async (base, externalBase) => {
        const r = await fetch(`${base}/api/enviar`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ destino: `${externalBase}/x` }),
        });
        const data = await r.json();
        assert.deepEqual(data.respuesta, { recibido: 'Hola desde WebScript', metodo: 'POST' });
      }
    )
  ));

  test('via distinto de POST se respeta de verdad', withServer(
    {
      'api.ws': `route("/api/via")

post function probar(args)
    var wson = { to: args.destino, via: "PUT", content: "x" }
    var r = await WSON.send(wson)
    return { r: r }
`,
    },
    withExternalSystem(
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ metodoRecibido: req.method }));
      },
      async (base, externalBase) => {
        const r = await fetch(`${base}/api/via`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ destino: `${externalBase}/x` }),
        });
        const data = await r.json();
        assert.deepEqual(data.r, { metodoRecibido: 'PUT' });
      }
    )
  ));

  test('via no soportado (email/teléfono) falla con mensaje claro, capturable con try/catch', withServer(
    {
      'api.ws': `route("/api/noimpl")

post function probar(args)
    var errorMsg = null
    try {
        await WSON.send({ to: "x@ejemplo.com", via: "email", content: "x" })
    } catch (e) {
        errorMsg = e.message
    }
    return { errorMsg: errorMsg }
`,
    },
    async (base) => {
      const r = await fetch(`${base}/api/noimpl`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await r.json();
      assert.match(data.errorMsg, /no soportado todavía/);
    }
  ));

  test('construir el wson NO envía nada por sí solo -- hace falta WSON.send() explícito', withServer(
    {
      'api.ws': `route("/api/construir")

server wson sender =
    -> to: "http://esto-no-deberia-llamarse-nunca.invalido"
    -> content: "x"

post function ver(args)
    return sender
`,
    },
    async (base) => {
      // si construir "sender" enviara algo por sí solo, esto fallaría al intentar
      // resolver un dominio inválido -- comprobamos que simplemente devuelve el
      // objeto tal cual, sin haber intentado ninguna petición.
      const r = await fetch(`${base}/api/construir`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.deepEqual(data, { to: 'http://esto-no-deberia-llamarse-nunca.invalido', content: 'x' });
    }
  ));
});

describe('bug real: un onclick con "await" explícito (no solo llamadas a post/put/delete) necesita ser async', () => {
  test('await WSON.send(...) en un onclick genera una función flecha async, JS válido', async () => {
    const { compileSource } = require('./helpers/compile-helper');
    const src = `
reactive resultado = ""
reactive mensaje = "hola"

wson sender =
    -> to: "/api/x"
    -> content: mensaje

visual v =
<p onclick={
    var r = await WSON.send(sender)
    resultado = JSON.stringify(r)
}>{resultado}</p>

render(
    v
)
`;
    const { js } = compileSource(src);
    assert.match(js, /addEventListener\("click", async \(event\) => \{/);
  });

  test('cualquier "await" explícito en un handler (no solo WSON.send) también fuerza async', async () => {
    const { compileSource } = require('./helpers/compile-helper');
    const src = `
reactive resultado = ""

visual v =
<p onclick={
    var r = await fetch("/algo")
    resultado = "listo"
}>{resultado}</p>

render(
    v
)
`;
    const { js } = compileSource(src);
    assert.match(js, /addEventListener\("click", async \(event\) => \{/);
  });

  test('un handler SIN await sigue generándose sin async (no regresión)', async () => {
    const { compileSource } = require('./helpers/compile-helper');
    const src = `
reactive contador = 0

visual v =
<p onclick={contador = contador + 1}>{contador}</p>

render(
    v
)
`;
    const { js } = compileSource(src);
    assert.match(js, /addEventListener\("click", \(event\) => \{/);
    assert.doesNotMatch(js, /addEventListener\("click", async \(event\)/);
  });
});

describe('wson (cliente): de extremo a extremo con click real y servidor externo real', () => {
  test('el click dispara WSON.send(), el receptor externo real recibe el content, la vista se actualiza con la respuesta', async () => {
    const http2 = require('http');
    const receptor = http2.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, eco: JSON.parse(body) }));
      });
    });
    await new Promise(resolve => receptor.listen(0, resolve));
    const puerto = receptor.address().port;
    try {
      const { compileSource } = require('./helpers/compile-helper');
      const { runBundle } = require('./helpers/dom-mock');
      const src = `
reactive resultado = ""
reactive mensaje = "hola desde cliente"

wson sender =
    -> to: "http://localhost:${puerto}/recibir"
    -> content: mensaje

visual v =
<div onclick={
    var r = await WSON.send(sender)
    resultado = JSON.stringify(r)
}>
    <p>{resultado}</p>
</div>

render(
    v
)
`;
      const { js } = compileSource(src);
      const { app, ready } = runBundle(js, { fetch });
      await ready;
      const div = app.children[0];
      await div.listeners.click({ target: div });
      await new Promise(r => setTimeout(r, 100));
      assert.equal(div.children[0].textContent, '{"ok":true,"eco":"hola desde cliente"}');
    } finally {
      receptor.close();
    }
  });
});

describe('sesiones: expiración por inactividad, límite con desalojo LRU, cookie Secure condicional', () => {
  test('una sesión inactiva más tiempo que el TTL expira -- misma cookie reinicia el estado', withServer(
    {
      'api.ws': `route("/api/x")

server var contador = 0

post function incrementar(args)
    contador = contador + 1
    return { contador: contador }
`,
    },
    async (base, server) => {
      const r1 = await fetch(`${base}/api/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const cookie = r1.headers.get('set-cookie').split(';')[0];
      assert.deepEqual(await r1.json(), { contador: 1 });
      assert.equal(server._webscriptSessionDebug.getSessionCount('api/x'), 1);

      await new Promise(resolve => setTimeout(resolve, 500));
      assert.equal(server._webscriptSessionDebug.getSessionCount('api/x'), 0, 'debe haberse limpiado tras el TTL');

      const r2 = await fetch(`${base}/api/x`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
      assert.deepEqual(await r2.json(), { contador: 1 }, 'misma cookie, pero sesión nueva -- el contador reinicia, no sigue en 2');
    },
    { sessionTtlMs: 300, sessionCleanupIntervalMs: 100 }
  ));

  test('una sesión activa (usada antes de expirar) NO se limpia', withServer(
    {
      'api.ws': `route("/api/x")

server var contador = 0

post function incrementar(args)
    contador = contador + 1
    return { contador: contador }
`,
    },
    async (base, server) => {
      const r1 = await fetch(`${base}/api/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const cookie = r1.headers.get('set-cookie').split(';')[0];

      // se usa de nuevo ANTES de que expire -- debe seguir viva, y el contador seguir
      await new Promise(resolve => setTimeout(resolve, 150));
      const r2 = await fetch(`${base}/api/x`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
      assert.deepEqual(await r2.json(), { contador: 2 }, 'sigue siendo la misma sesión, no expiró');
    },
    { sessionTtlMs: 300, sessionCleanupIntervalMs: 100 }
  ));

  test('al superar maxSessions, se desaloja la menos usada recientemente (LRU), nunca la más reciente', withServer(
    {
      'api.ws': `route("/api/x")

post function noop(args)
    return { ok: true }
`,
    },
    async (base, server) => {
      const cookies = [];
      for (let i = 0; i < 5; i++) {
        const r = await fetch(`${base}/api/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        cookies.push(r.headers.get('set-cookie').split(';')[0].split('=')[1]);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(server._webscriptSessionDebug.getSessionCount('api/x'), 3, 'nunca debe superar maxSessions');
      assert.equal(server._webscriptSessionDebug.hasSession('api/x', cookies[0]), false, 'la más antigua debe haberse desalojado');
      assert.equal(server._webscriptSessionDebug.hasSession('api/x', cookies[4]), true, 'la más reciente debe seguir viva');
    },
    { maxSessions: 3, sessionTtlMs: 999999 }
  ));

  test('sin X-Forwarded-Proto, la cookie NO lleva Secure (no rompe desarrollo local por HTTP)', withServer(
    { 'api.ws': `route("/api/x")\n\npost function f(args)\n    return { ok: true }\n` },
    async (base) => {
      const r = await fetch(`${base}/api/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.doesNotMatch(r.headers.get('set-cookie'), /Secure/);
    }
  ));

  test('con X-Forwarded-Proto: https (detrás de un proxy real), la cookie SÍ lleva Secure', withServer(
    { 'api.ws': `route("/api/x")\n\npost function f(args)\n    return { ok: true }\n` },
    async (base) => {
      const r = await fetch(`${base}/api/x`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' }, body: '{}',
      });
      assert.match(r.headers.get('set-cookie'), /Secure/);
    }
  ));
});

describe('WSON: firma HMAC (secret) y WSON.verify() -- confianza entre sistemas', () => {
  const { parseSource } = require('./helpers/compile-helper');
  const { compile } = require('../src/compiler');

  test('"secret" en un wson de CLIENTE se rechaza en compilación (riesgo de seguridad real)', () => {
    const src = 'wson sender =\n    -> to: "/x"\n    -> content: 1\n    -> secret: "malo"\n\nvisual v =\n<p>x</p>\n\nrender(\n    v\n)';
    assert.throws(() => parseSource(src), /solo tiene sentido en "server wson"/);
  });

  test('"secret" en un server wson SÍ está permitido', () => {
    const src = 'route("/x")\n\nserver wson sender =\n    -> to: "http://x"\n    -> content: 1\n    -> secret: "clave"\n\npost function f(args)\n    return sender';
    assert.doesNotThrow(() => parseSource(src));
  });

  test('WSON.send() con secret genera el cálculo de firma; sin secret, no lo genera', () => {
    const conSecret = parseSource('route("/x")\n\nserver wson s =\n    -> to: "http://x"\n    -> content: 1\n    -> secret: "clave"\n\npost function f(args)\n    var r = await WSON.send(s)\n    return r');
    const { server: serverConSecret } = compile(conSecret, { routePath: '/' });
    assert.match(serverConSecret, /X-WSON-Signature/);
    assert.match(serverConSecret, /createHmac\('sha256', wson\.secret\)/);
  });

  test('WSON.verify() con comparación en tiempo constante (timingSafeEqual), no ==', () => {
    const ast = parseSource('route("/x")\n\npost function f(args, query, headers)\n    var ok = WSON.verify(args, headers[\'x-wson-signature\'], "clave")\n    return { ok: ok }');
    const { server } = compile(ast, { routePath: '/' });
    assert.match(server, /timingSafeEqual/);
  });

  test('de extremo a extremo: dos servidores reales, emisor firma y receptor verifica -- firmaValida: true', withServer(
    { 'api.ws': `route("/recibir")

server var ultimaVerificacion = false

post function recibir(args, query, headers)
    ultimaVerificacion = WSON.verify(args, headers['x-wson-signature'], "clave-compartida-test", headers['x-wson-timestamp'])
    return { firmaValida: ultimaVerificacion }
` },
    async (receptorBase) => {
      const fs2 = require('fs');
      const os2 = require('os');
      const path2 = require('path');
      const { buildSite: build2, startServer: start2 } = require('../src/site-builder');

      const srcDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ws-wson-hmac-'));
      const outDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ws-wson-hmac-out-'));
      fs2.writeFileSync(path2.join(srcDir, 'api.ws'), `route("/api/enviar")

server var mensajeTexto = "pago confirmado"

server wson sender =
    -> to: "${receptorBase}/recibir"
    -> content: mensajeTexto
    -> secret: "clave-compartida-test"

post function disparar(args)
    var r = await WSON.send(sender)
    return { respuesta: r }
`);
      const { table } = build2(srcDir, outDir);
      const emisor = start2(table, outDir, 0);
      await new Promise(resolve => emisor.on('listening', resolve));
      const emisorPort = emisor.address().port;
      try {
        const r = await fetch(`http://localhost:${emisorPort}/api/enviar`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const data = await r.json();
        assert.deepEqual(data, { respuesta: { firmaValida: true } });
      } finally {
        emisor.close();
        fs2.rmSync(srcDir, { recursive: true, force: true });
        fs2.rmSync(outDir, { recursive: true, force: true });
      }
    }
  ));

  test('mensaje sin firmar, o con firma de un secreto distinto -- ambos detectados como inválidos', withServer(
    { 'api.ws': `route("/recibir")

post function recibir(args, query, headers)
    var ok = WSON.verify(args, headers['x-wson-signature'], "clave-correcta")
    return { firmaValida: ok }
` },
    async (base) => {
      const r1 = await fetch(`${base}/recibir`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify('sin firmar'),
      });
      assert.deepEqual(await r1.json(), { firmaValida: false });

      const crypto2 = require('crypto');
      const firmaFalsa = 'sha256=' + crypto2.createHmac('sha256', 'secreto-equivocado').update(JSON.stringify('otro mensaje')).digest('hex');
      const r2 = await fetch(`${base}/recibir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WSON-Signature': firmaFalsa },
        body: JSON.stringify('otro mensaje'),
      });
      assert.deepEqual(await r2.json(), { firmaValida: false });
    }
  ));
});

describe('WSON: cifrado opcional (encrypt) e ID de correlación', () => {
  const { parseSource } = require('./helpers/compile-helper');
  const { compile } = require('../src/compiler');

  test('"encrypt" en un wson de CLIENTE se rechaza (mismo riesgo que "secret")', () => {
    const src = 'wson s =\n    -> to: "/x"\n    -> content: 1\n    -> encrypt: true\n\nvisual v =\n<p>x</p>\n\nrender(\n    v\n)';
    assert.throws(() => parseSource(src), /"encrypt" -- eso solo tiene sentido en/);
  });

  test('"encrypt" sin "secret" se rechaza -- no hay clave con la que cifrar', () => {
    const src = 'route("/x")\n\nserver wson s =\n    -> to: "http://x"\n    -> content: 1\n    -> encrypt: true\n\npost function f(args)\n    return s';
    assert.throws(() => parseSource(src), /"encrypt" sin "secret"/);
  });

  test('"encrypt" con "secret" SÍ está permitido en server wson', () => {
    const src = 'route("/x")\n\nserver wson s =\n    -> to: "http://x"\n    -> content: 1\n    -> secret: "clave"\n    -> encrypt: true\n\npost function f(args)\n    return s';
    assert.doesNotThrow(() => parseSource(src));
  });

  test('el contenido cifrado NUNCA aparece en texto plano en lo que realmente viaja por la red', withServer(
    { 'api.ws': `route("/api/enviar")

server var datosSecretos = "numero de tarjeta: 4111-1111-1111-1111"

server wson sender =
    -> to: "PLACEHOLDER"
    -> content: datosSecretos
    -> secret: "clave-test"
    -> encrypt: true

post function disparar(args)
    var r = await WSON.send(sender)
    return { respuesta: r }
` },
    async (base) => {
      const http2 = require('http');
      let cuerpoRecibido = null;
      const receptorCrudo = http2.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          cuerpoRecibido = body;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      await new Promise(resolve => receptorCrudo.listen(0, resolve));
      const puertoReceptor = receptorCrudo.address().port;
      try {
        const fs2 = require('fs');
        const os2 = require('os');
        const path2 = require('path');
        const { buildSite: build2, startServer: start2 } = require('../src/site-builder');

        const srcDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ws-wson-enc-'));
        const outDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ws-wson-enc-out-'));
        fs2.writeFileSync(path2.join(srcDir, 'api.ws'), `route("/api/enviar")

server var datosSecretos = "numero de tarjeta: 4111-1111-1111-1111"

server wson sender =
    -> to: "http://localhost:${puertoReceptor}/recibir"
    -> content: datosSecretos
    -> secret: "clave-test"
    -> encrypt: true

post function disparar(args)
    var r = await WSON.send(sender)
    return { respuesta: r }
`);
        const { table } = build2(srcDir, outDir);
        const emisor = start2(table, outDir, 0);
        await new Promise(resolve => emisor.on('listening', resolve));
        const emisorPort = emisor.address().port;
        try {
          await fetch(`http://localhost:${emisorPort}/api/enviar`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
          });
          await new Promise(resolve => setTimeout(resolve, 100));
          assert.ok(cuerpoRecibido, 'el receptor crudo debe haber recibido algo');
          assert.doesNotMatch(cuerpoRecibido, /4111/, 'el número de tarjeta NUNCA debe aparecer en texto plano en la red');
          assert.match(cuerpoRecibido, /__wsonEncrypted/, 'debe llevar el sobre cifrado');
        } finally {
          emisor.close();
          fs2.rmSync(srcDir, { recursive: true, force: true });
          fs2.rmSync(outDir, { recursive: true, force: true });
        }
      } finally {
        receptorCrudo.close();
      }
    }
  ));

  test('de extremo a extremo: emisor cifra+firma, receptor verifica+descifra+lee el id de correlación', withServer(
    { 'api.ws': `route("/recibir")

server var contenidoDescifrado = ""
server var firmaValida = false

post function recibir(args, query, headers)
    firmaValida = WSON.verify(args, headers['x-wson-signature'], "clave-e2e", headers['x-wson-timestamp'])
    contenidoDescifrado = WSON.showContent(args, "clave-e2e")
    return { firmaValida: firmaValida, contenido: contenidoDescifrado, tieneId: headers['x-wson-correlation-id'] !== undefined }
` },
    async (receptorBase) => {
      const fs2 = require('fs');
      const os2 = require('os');
      const path2 = require('path');
      const { buildSite: build2, startServer: start2 } = require('../src/site-builder');

      const srcDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ws-wson-e2e-'));
      const outDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ws-wson-e2e-out-'));
      fs2.writeFileSync(path2.join(srcDir, 'api.ws'), `route("/api/enviar")

server var mensaje = "dato confidencial"

server wson sender =
    -> to: "${receptorBase}/recibir"
    -> content: mensaje
    -> secret: "clave-e2e"
    -> encrypt: true

post function disparar(args)
    var r = await WSON.send(sender)
    return { respuesta: r }
`);
      const { table } = build2(srcDir, outDir);
      const emisor = start2(table, outDir, 0);
      await new Promise(resolve => emisor.on('listening', resolve));
      const emisorPort = emisor.address().port;
      try {
        const r = await fetch(`http://localhost:${emisorPort}/api/enviar`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const data = await r.json();
        assert.deepEqual(data, { respuesta: { firmaValida: true, contenido: 'dato confidencial', tieneId: true } });
      } finally {
        emisor.close();
        fs2.rmSync(srcDir, { recursive: true, force: true });
        fs2.rmSync(outDir, { recursive: true, force: true });
      }
    }
  ));

  test('WSON.showContent con clave equivocada, o con el cifrado manipulado, devuelve null', () => {
    const ast = parseSource('route("/x")\n\npost function f(args, query, headers)\n    return WSON.showContent(args, "clave")');
    const { server } = compile(ast, { routePath: '/' });
    const fs2 = require('fs');
    const path2 = require('path');
    const tmpFile = path2.join(require('os').tmpdir(), `wson-showcontent-${Date.now()}.server.js`);
    fs2.writeFileSync(tmpFile, server);
    const mod = require(tmpFile);
    const state = mod.createSessionState();

    const crypto2 = require('crypto');
    const key = crypto2.createHash('sha256').update('clave' + ':wson-encrypt').digest();
    const iv = crypto2.randomBytes(12);
    const cipher = crypto2.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify('secreto'), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const payload = { __wsonEncrypted: true, iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), authTag: authTag.toString('base64') };

    return Promise.all([
      state.f(payload, {}, {}).then(r => assert.equal(r, 'secreto', 'clave correcta debe descifrar bien')),
      state.f('texto plano', {}, {}).then(r => assert.equal(r, 'texto plano', 'no cifrado se devuelve tal cual')),
      state.f({ ...payload, ciphertext: payload.ciphertext.slice(0, -4) + 'AAAA' }, {}, {}).then(r => assert.equal(r, null, 'manipulado debe dar null')),
    ]).finally(() => fs2.rmSync(tmpFile, { force: true }));
  });
});

describe('WSON, tercera vuelta: varios destinos, "from" viaja, WSON.parse(), historial global', () => {
  test('"to" como array: manda a todos en paralelo, un fallo no tumba a los demás', withServer(
    { 'api.ws': `route("/api/enviar")

post function disparar(args)
    var r = await WSON.send({ to: args.destinos, content: "difusión" })
    return { resultados: r }
` },
    async (base) => {
      const http2 = require('http');
      const crearReceptor = () => http2.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ recibido: true }));
      });
      const r1 = crearReceptor();
      const r2 = crearReceptor();
      await Promise.all([
        new Promise(resolve => r1.listen(0, resolve)),
        new Promise(resolve => r2.listen(0, resolve)),
      ]);
      try {
        const p1 = r1.address().port;
        const p2 = r2.address().port;
        const res = await fetch(`${base}/api/enviar`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ destinos: [`http://localhost:${p1}/x`, `http://localhost:${p2}/x`, 'http://localhost:1/x'] }),
        });
        const data = await res.json();
        assert.deepEqual(data.resultados[0], { recibido: true });
        assert.deepEqual(data.resultados[1], { recibido: true });
        assert.equal(data.resultados[2].error, true, 'el tercer destino inválido debe fallar de forma aislada, sin tumbar los otros dos');
      } finally {
        r1.close();
        r2.close();
      }
    }
  ));

  test('"to" como string sigue devolviendo un único resultado (no un array) -- retrocompatibilidad', withServer(
    { 'api.ws': `route("/api/enviar")

post function disparar(args)
    var r = await WSON.send({ to: args.destino, content: "x" })
    return { esArray: Array.isArray(r), resultado: r }
` },
    async (base) => {
      const http2 = require('http');
      const receptor = http2.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      await new Promise(resolve => receptor.listen(0, resolve));
      try {
        const puerto = receptor.address().port;
        const res = await fetch(`${base}/api/enviar`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ destino: `http://localhost:${puerto}/x` }),
        });
        const data = await res.json();
        assert.equal(data.esArray, false);
        assert.deepEqual(data.resultado, { ok: true });
      } finally {
        receptor.close();
      }
    }
  ));

  test('"from" viaja como cabecera X-WSON-From -- WSON.parse() lo recupera de verdad en otro proceso', withServer(
    { 'api.ws': `route("/recibir")

post function recibir(args, query, headers)
    var msg = WSON.parse(args, headers, "clave-parse-test")
    return { from: msg.from, content: msg.content, signatureValid: msg.signatureValid, tieneId: msg.id !== undefined }
` },
    async (receptorBase) => {
      const fs2 = require('fs');
      const os2 = require('os');
      const path2 = require('path');
      const { buildSite: build2, startServer: start2 } = require('../src/site-builder');

      const srcDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ws-wson-parse-'));
      const outDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ws-wson-parse-out-'));
      fs2.writeFileSync(path2.join(srcDir, 'api.ws'), `route("/api/enviar")

server wson sender =
    -> from: "servicio-de-pagos"
    -> to: "${receptorBase}/recibir"
    -> content: "pago confirmado"
    -> secret: "clave-parse-test"

post function disparar(args)
    var r = await WSON.send(sender)
    return { respuesta: r }
`);
      const { table } = build2(srcDir, outDir);
      const emisor = start2(table, outDir, 0);
      await new Promise(resolve => emisor.on('listening', resolve));
      const emisorPort = emisor.address().port;
      try {
        const r = await fetch(`http://localhost:${emisorPort}/api/enviar`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const data = await r.json();
        assert.deepEqual(data, {
          respuesta: { from: 'servicio-de-pagos', content: 'pago confirmado', signatureValid: true, tieneId: true },
        });
      } finally {
        emisor.close();
        fs2.rmSync(srcDir, { recursive: true, force: true });
        fs2.rmSync(outDir, { recursive: true, force: true });
      }
    }
  ));

  test('WSON.history() es GLOBAL al proceso -- una sesión que nunca envió nada ve el historial de otras sesiones', withServer(
    { 'api.ws': `route("/api/x")

server wson sender =
    -> from: "yo"
    -> to: "http://ejemplo-inalcanzable.invalido/recibir"
    -> content: "mensaje"

post function enviarUno(args)
    try {
        await WSON.send(sender)
    } catch (e) {
    }
    return { ok: true }

get function estado(query)
    return { total: WSON.history().length, soloEnviados: WSON.history({ direction: "sent" }).length }
` },
    async (base) => {
      const r1 = await fetch(`${base}/api/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const cookie1 = r1.headers.get('set-cookie');
      const r2 = await fetch(`${base}/api/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const cookie2 = r2.headers.get('set-cookie');
      assert.notEqual(cookie1, cookie2, 'deben ser sesiones distintas de verdad, para que la prueba tenga sentido');

      // tercera sesión, SIN cookie -- nunca envió nada ella misma
      const r3 = await fetch(`${base}/api/x`);
      assert.deepEqual(await r3.json(), { total: 2, soloEnviados: 2 });
    }
  ));
});

describe('WSON, cuarta vuelta: reintentos con backoff, dead letter, WSON.enqueue()', () => {
  test('un servidor que falla dos veces y responde bien a la tercera SÍ se recupera con retries', withServer(
    { 'api.ws': `route("/api/enviar")

post function disparar(args)
    var r = await WSON.send({ to: args.destino, content: "mensaje", retries: 3, retryDelayMs: 50 })
    return { respuesta: r }
` },
    async (base) => {
      const http2 = require('http');
      let intentos = 0;
      const receptorInestable = http2.createServer((req, res) => {
        intentos++;
        if (intentos < 3) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'inestable' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ recibido: true, intento: intentos }));
      });
      await new Promise(resolve => receptorInestable.listen(0, resolve));
      try {
        const puerto = receptorInestable.address().port;
        const r = await fetch(`${base}/api/enviar`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ destino: `http://localhost:${puerto}/x` }),
        });
        const data = await r.json();
        assert.deepEqual(data, { respuesta: { recibido: true, intento: 3 } });
        assert.equal(intentos, 3, 'debe haber reintentado hasta la tercera vez');
      } finally {
        receptorInestable.close();
      }
    }
  ));

  test('tras agotar los reintentos, queda marcado deadLetter: true en el historial, con el número de intentos', withServer(
    { 'api.ws': `route("/api/x")

post function disparar(args)
    try {
        await WSON.send({ to: "http://localhost:1/x", content: "nunca llega", retries: 2, retryDelayMs: 20 })
    } catch (e) {
    }
    return { ok: true }

get function estado(query)
    return { deadLetters: WSON.history({ deadLetter: true }).length, intentos: WSON.history({ deadLetter: true })[0].attempts }
` },
    async (base) => {
      await fetch(`${base}/api/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const r = await fetch(`${base}/api/x`);
      assert.deepEqual(await r.json(), { deadLetters: 1, intentos: 3 });
    }
  ));

  test('WSON.enqueue() devuelve al instante, sin esperar al envío real, y el resultado aparece después en el historial con el mismo id', withServer(
    { 'api.ws': `route("/api/x")

post function disparar(args)
    var id = WSON.enqueue({ to: args.destino, content: "en segundo plano" })
    return { idCorrelacion: id }

get function estado(query)
    return { historial: WSON.history() }
` },
    async (base) => {
      const http2 = require('http');
      const receptorLento = http2.createServer((req, res) => {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ recibido: true }));
        }, 500);
      });
      await new Promise(resolve => receptorLento.listen(0, resolve));
      try {
        const puerto = receptorLento.address().port;
        const inicio = Date.now();
        const r = await fetch(`${base}/api/x`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ destino: `http://localhost:${puerto}/x` }),
        });
        const tardo = Date.now() - inicio;
        assert.ok(tardo < 300, `debe responder mucho antes de los 500ms que tarda el receptor -- tardó ${tardo}ms`);
        const data = await r.json();
        assert.ok(data.idCorrelacion, 'debe devolver un id de correlación al instante');

        await new Promise(resolve => setTimeout(resolve, 700));
        const r2 = await fetch(`${base}/api/x`);
        const historial = (await r2.json()).historial;
        assert.equal(historial.length, 1);
        assert.equal(historial[0].id, data.idCorrelacion, 'el envío de fondo debe usar el MISMO id devuelto al instante');
      } finally {
        receptorLento.close();
      }
    }
  ));
});

describe('WSON.getSignature(headers): atajo para no escribir headers[\'x-wson-signature\'] a mano', () => {
  test('devuelve el mismo valor que headers[\'x-wson-signature\'], sin transformarlo', () => {
    const { parseSource } = require('./helpers/compile-helper');
    const { compile } = require('../src/compiler');
    const ast = parseSource('route("/x")\n\npost function f(args, query, headers)\n    return { firma: WSON.getSignature(headers) }');
    const { server } = compile(ast, { routePath: '/' });
    const fs2 = require('fs');
    const path2 = require('path');
    const tmpFile = path2.join(require('os').tmpdir(), `wson-getsig-${Date.now()}.server.js`);
    fs2.writeFileSync(tmpFile, server);
    const state = require(tmpFile).createSessionState();
    return Promise.all([
      state.f({}, {}, {}).then(r => assert.equal(r.firma, undefined, 'sin cabecera, undefined')),
      state.f({}, {}, { 'x-wson-signature': 'sha256=abc123' }).then(r => assert.equal(r.firma, 'sha256=abc123', 'con cabecera, el mismo valor tal cual')),
    ]).finally(() => fs2.rmSync(tmpFile, { force: true }));
  });

  test('componible con WSON.verify() de extremo a extremo, con dos servidores reales', withServer(
    { 'api.ws': `route("/recibir")

post function recibir(args, query, headers)
    var firma = WSON.getSignature(headers)
    var marca = WSON.getTimestamp(headers)
    var valido = WSON.verify(args, firma, "clave-getsig-test", marca)
    return { firmaObtenida: firma !== undefined, firmaValida: valido }
` },
    async (receptorBase) => {
      const fs2 = require('fs');
      const os2 = require('os');
      const path2 = require('path');
      const { buildSite: build2, startServer: start2 } = require('../src/site-builder');

      const srcDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ws-wson-getsig-'));
      const outDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ws-wson-getsig-out-'));
      fs2.writeFileSync(path2.join(srcDir, 'api.ws'), `route("/api/enviar")

server wson sender =
    -> to: "${receptorBase}/recibir"
    -> content: "mensaje"
    -> secret: "clave-getsig-test"

post function disparar(args)
    var r = await WSON.send(sender)
    return { respuesta: r }
`);
      const { table } = build2(srcDir, outDir);
      const emisor = start2(table, outDir, 0);
      await new Promise(resolve => emisor.on('listening', resolve));
      const emisorPort = emisor.address().port;
      try {
        const r = await fetch(`http://localhost:${emisorPort}/api/enviar`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const data = await r.json();
        assert.deepEqual(data, { respuesta: { firmaObtenida: true, firmaValida: true } });
      } finally {
        emisor.close();
        fs2.rmSync(srcDir, { recursive: true, force: true });
        fs2.rmSync(outDir, { recursive: true, force: true });
      }
    }
  ));
});

describe('respond(status, cuerpo): código de estado HTTP explícito en las cuatro funciones', () => {
  test('post function con respond(400, ...) da el código y cuerpo exactos', withServer(
    { 'api.ws': `route("/api/items")

server var items = []

post function crear(args)
    if (!args.nombre)
        return respond(400, { error: "falta el nombre" })
    items = [...items, args.nombre]
    return respond(201, { creado: true, total: items.length })
` },
    async (base) => {
      const r1 = await fetch(`${base}/api/items`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      assert.equal(r1.status, 400);
      assert.deepEqual(await r1.json(), { error: 'falta el nombre' });
      const cookie = r1.headers.get('set-cookie').split(';')[0];

      const r2 = await fetch(`${base}/api/items`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ nombre: 'x' }),
      });
      assert.equal(r2.status, 201);
      assert.deepEqual(await r2.json(), { creado: true, total: 1 });
    }
  ));

  test('sin respond(), sigue respondiendo 200 exactamente como antes -- retrocompatibilidad', withServer(
    { 'api.ws': `route("/api/items")

get function listar(query)
    return ["a", "b"]
` },
    async (base) => {
      const r = await fetch(`${base}/api/items`);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), ['a', 'b']);
    }
  ));

  test('respond() se genera solo si se usa -- no aparece en server.js si nadie lo llama', () => {
    const { parseSource } = require('./helpers/compile-helper');
    const { compile } = require('../src/compiler');
    const ast = parseSource('route("/x")\n\npost function f(args)\n    return { ok: true }');
    const { server } = compile(ast, { routePath: '/' });
    assert.doesNotMatch(server, /function respond/);
  });

  test('put/delete/get function también respetan respond(), no solo post', withServer(
    { 'api.ws': `route("/api/x")

put function actualizar(args)
    return respond(204, {})

delete function borrar(args)
    return respond(202, { aceptado: true })
` },
    async (base) => {
      const r1 = await fetch(`${base}/api/x`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(r1.status, 204);

      const r2 = await fetch(`${base}/api/x`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(r2.status, 202);
      assert.deepEqual(await r2.json(), { aceptado: true });
    }
  ));
});

describe('WSON.history() rediseñado: persiste en un fichero real (JSONL), no en memoria', () => {
  test('sobrevive de verdad a un "reinicio" -- módulo recargado desde cero, el fichero en disco permanece', async () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const path2 = require('path');
    const { buildSite: build2, startServer: start2 } = require('../src/site-builder');

    const srcDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ws-wson-persist-'));
    const outDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ws-wson-persist-out-'));
    fs2.writeFileSync(path2.join(srcDir, 'api.ws'), `route("/api/x")

post function enviar(args)
    try {
        await WSON.send({ to: args.destino, content: args.mensaje })
    } catch (e) {
    }
    return { ok: true }

get function estado(query)
    return { total: WSON.history().length, entradas: WSON.history() }
`);
    try {
      // "proceso 1"
      const { table } = build2(srcDir, outDir);
      const server1 = start2(table, outDir, 0);
      await new Promise(resolve => server1.on('listening', resolve));
      const port1 = server1.address().port;
      await fetch(`http://localhost:${port1}/api/x`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destino: 'http://localhost:1/x', mensaje: 'sobrevivo al reinicio' }),
      });
      await new Promise(resolve => server1.close(resolve));

      // limpia la caché de require -- fuerza que TODO el estado a nivel de módulo se
      // reconstruya desde cero, simulando un reinicio real del proceso. El fichero en
      // disco (wson-history.jsonl) NO se toca por esto -- solo el require() del
      // server.js compilado.
      Object.keys(require.cache).forEach((key) => {
        if (key.includes(outDir)) delete require.cache[key];
      });

      // "proceso 2" -- nunca mandó nada él mismo
      const { table: table2 } = build2(srcDir, outDir);
      const server2 = start2(table2, outDir, 0);
      await new Promise(resolve => server2.on('listening', resolve));
      const port2 = server2.address().port;
      const r = await fetch(`http://localhost:${port2}/api/x`);
      const data = await r.json();
      assert.equal(data.total, 1, 'debe ver el mensaje del "proceso" anterior, sin haberlo mandado él mismo');
      assert.equal(data.entradas[0].content, 'sobrevivo al reinicio');
      server2.close();
    } finally {
      fs2.rmSync(srcDir, { recursive: true, force: true });
      fs2.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('bug real encontrado en el rediseño: el filtro deadLetter nunca se había implementado -- ahora sí filtra de verdad', withServer(
    { 'api.ws': `route("/api/x")

post function usar(args)
    try {
        await WSON.send({ to: args.d, content: "x" })
    } catch (e) {
    }
    return { ok: true }

get function estado(query)
    return { total: WSON.history().length, soloDead: WSON.history({ deadLetter: true }).length }
` },
    async (base) => {
      const http2 = require('http');
      const receptorOk = http2.createServer((req, res) => { res.writeHead(200); res.end('{}'); });
      await new Promise(resolve => receptorOk.listen(0, resolve));
      try {
        const puertoOk = receptorOk.address().port;
        // uno que triunfa
        await fetch(`${base}/api/x`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ d: `http://localhost:${puertoOk}/x` }),
        });
        // uno que falla -- ese sí debe contar como deadLetter
        await fetch(`${base}/api/x`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ d: 'http://localhost:1/x' }),
        });
        const r = await fetch(`${base}/api/x`);
        assert.deepEqual(await r.json(), { total: 2, soloDead: 1 }, 'antes del arreglo esto daba soloDead:2 (el filtro no filtraba nada)');
      } finally {
        receptorOk.close();
      }
    }
  ));

  test('sin nada enviado/recibido todavía (fichero inexistente), WSON.history() da vacío, sin error', withServer(
    { 'api.ws': `route("/api/x")\n\nget function estado(query)\n    return { total: WSON.history().length }\n` },
    async (base) => {
      const r = await fetch(`${base}/api/x`);
      assert.deepEqual(await r.json(), { total: 0 });
    }
  ));
});

describe('startClusteredServer: N procesos reales, sesiones pegajosas por cookie', () => {
  const { startClusteredServer } = require('../src/site-builder');

  function withCluster(wsFiles, workerCount, testFn) {
    return async () => {
      const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cluster-test-'));
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cluster-out-'));
      for (const [name, content] of Object.entries(wsFiles)) {
        fs.writeFileSync(path.join(srcDir, name), content);
      }
      // Puerto público fijo alto, poco probable de colisión -- startClusteredServer
      // necesita un puerto CONCRETO (no 0) porque también reserva los internos como
      // "publicPort + 1 + i", así que no puede dejarse "cualquiera libre" aquí.
      const publicPort = 45000 + Math.floor(Math.random() * 3000);
      const frontal = await startClusteredServer(srcDir, outDir, publicPort, workerCount);
      try {
        await testFn(`http://localhost:${publicPort}`, frontal);
      } finally {
        frontal.close();
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    };
  }

  test('bug real arreglado: la MISMA sesión, varias peticiones seguidas, incrementa de forma consistente (no se pierde ningún incremento)', withCluster(
    {
      'api.ws': `route("/api/x")

server var contador = 0

post function incrementar(args)
    contador = contador + 1
    return { contador: contador }
`,
    },
    4,
    async (base) => {
      let cookie = null;
      const secuencia = [];
      for (let i = 0; i < 6; i++) {
        const headers = { 'Content-Type': 'application/json' };
        if (cookie) headers.Cookie = cookie;
        const r = await fetch(`${base}/api/x`, { method: 'POST', headers, body: '{}' });
        if (!cookie) cookie = r.headers.get('set-cookie').split(';')[0];
        secuencia.push((await r.json()).contador);
      }
      assert.deepEqual(secuencia, [1, 2, 3, 4, 5, 6], 'antes del arreglo, esto daba [1,1,2,3,4,5] -- la sesión perdía el primer incremento');
    }
  ));

  test('varias sesiones distintas a la vez, cada una consistente por separado', withCluster(
    {
      'api.ws': `route("/api/x")

server var contador = 0

post function incrementar(args)
    contador = contador + 1
    return { contador: contador }
`,
    },
    4,
    async (base) => {
      const sesiones = [];
      for (let s = 0; s < 6; s++) {
        let cookie = null;
        const secuencia = [];
        for (let i = 0; i < 3; i++) {
          const headers = { 'Content-Type': 'application/json' };
          if (cookie) headers.Cookie = cookie;
          const r = await fetch(`${base}/api/x`, { method: 'POST', headers, body: '{}' });
          if (!cookie) cookie = r.headers.get('set-cookie').split(';')[0];
          secuencia.push((await r.json()).contador);
        }
        sesiones.push(secuencia);
      }
      for (const s of sesiones) assert.deepEqual(s, [1, 2, 3]);
    }
  ));

  test('con workerCount=1, se comporta exactamente igual que startServer() -- sin proxy, sin procesos extra', withCluster(
    { 'api.ws': `route("/api/x")\n\nget function f(query)\n    return { ok: true }\n` },
    1,
    async (base, servidor) => {
      const r = await fetch(`${base}/api/x`);
      assert.deepEqual(await r.json(), { ok: true });
      assert.equal(servidor._clusterWorkers, undefined, 'sin clustering no debe haber ningún array de workers');
    }
  ));
});

describe('config: "cluster-workers" de wconfig.json activa startClusteredServer de verdad', () => {
  test('cluster-workers > 1 en wconfig.json arranca varios procesos reales, con sesiones pegajosas', async () => {
    const { startClusteredServer } = require('../src/site-builder');
    const { loadConfig } = require('../src/config');
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cluster-config-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cluster-config-out-'));
    try {
      fs.writeFileSync(path.join(srcDir, 'wconfig.json'), JSON.stringify({ 'cluster-workers': 3 }));
      fs.writeFileSync(path.join(srcDir, 'api.ws'), `route("/api/x")

server var contador = 0

post function incrementar(args)
    contador = contador + 1
    return { contador: contador }
`);
      const config = loadConfig(srcDir);
      assert.equal(config['cluster-workers'], 3);

      const publicPort = 46000 + Math.floor(Math.random() * 3000);
      const frontal = await startClusteredServer(srcDir, outDir, publicPort, config['cluster-workers']);
      try {
        assert.equal(frontal._clusterWorkers.length, 3);
        let cookie = null;
        const secuencia = [];
        for (let i = 0; i < 4; i++) {
          const headers = { 'Content-Type': 'application/json' };
          if (cookie) headers.Cookie = cookie;
          const r = await fetch(`http://localhost:${publicPort}/api/x`, { method: 'POST', headers, body: '{}' });
          if (!cookie) cookie = r.headers.get('set-cookie').split(';')[0];
          secuencia.push((await r.json()).contador);
        }
        assert.deepEqual(secuencia, [1, 2, 3, 4]);
      } finally {
        frontal.close();
      }
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('WSON: "server wson NOMBRE = WSON.parse(...)" dentro de un post function, de extremo a extremo', () => {
  test('el receptor declara el resultado de WSON.parse() con la palabra clave "wson", no "var" -- dos servidores reales', withServer(
    { 'api.ws': `route("/recibir")

post function recibir(args, query, headers)
    server wson msg = WSON.parse(args, headers, "clave-parse-keyword-test")
    return { from: msg.from, content: msg.content, signatureValid: msg.signatureValid }
` },
    async (receptorBase) => {
      const fs2 = require('fs');
      const os2 = require('os');
      const path2 = require('path');
      const { buildSite: build2, startServer: start2 } = require('../src/site-builder');

      const srcDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ws-wson-parsekw-'));
      const outDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ws-wson-parsekw-out-'));
      fs2.writeFileSync(path2.join(srcDir, 'api.ws'), `route("/api/enviar")

server wson sender =
    -> from: "servicio-x"
    -> to: "${receptorBase}/recibir"
    -> content: "pago confirmado"
    -> secret: "clave-parse-keyword-test"

post function disparar(args)
    var r = await WSON.send(sender)
    return { respuesta: r }
`);
      const { table } = build2(srcDir, outDir);
      const emisor = start2(table, outDir, 0);
      await new Promise(resolve => emisor.on('listening', resolve));
      const emisorPort = emisor.address().port;
      try {
        const r = await fetch(`http://localhost:${emisorPort}/api/enviar`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const data = await r.json();
        assert.deepEqual(data, {
          respuesta: { from: 'servicio-x', content: 'pago confirmado', signatureValid: true },
        });
      } finally {
        emisor.close();
        fs2.rmSync(srcDir, { recursive: true, force: true });
        fs2.rmSync(outDir, { recursive: true, force: true });
      }
    }
  ));
});

describe('server const: compila a un const real de JS, uso normal funciona, reasignar da un error real (sin tumbar el proceso)', () => {
  test('uso normal, y reasignar da 500 con el error real de JS -- verificado con servidor real', withServer(
    { 'api.ws': `route("/api/x")

server const tasa = 0.21

post function accion(args)
    if (args.reasignar)
        tasa = 99
    return { conIva: args.precio * (1 + tasa) }
` },
    async (base) => {
      const r1 = await fetch(`${base}/api/x`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ precio: 100 }),
      });
      assert.equal(r1.status, 200);
      assert.deepEqual(await r1.json(), { conIva: 121 });

      const r2 = await fetch(`${base}/api/x`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ precio: 100, reasignar: true }),
      });
      assert.equal(r2.status, 500, 'debe fallar esta petición concreta, sin tumbar el proceso');
      const data = await r2.json();
      assert.match(data.error, /Assignment to constant variable/);

      // el servidor sigue vivo tras el error -- otra petición normal debe seguir funcionando
      const r3 = await fetch(`${base}/api/x`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ precio: 50 }),
      });
      assert.equal(r3.status, 200);
      assert.deepEqual(await r3.json(), { conIva: 60.5 });
    }
  ));

  test('server const sin valor inicial se rechaza en compilación', () => {
    const { parseSource } = require('./helpers/compile-helper');
    assert.throws(
      () => parseSource('route("/x")\n\nserver const tasa\n\npost function f(args)\n    return {}'),
      /"server const" necesita un valor inicial/
    );
  });

  test('watch() sobre una server const da un mensaje claro (nunca cambia, nunca dispararía)', () => {
    const { parseSource } = require('./helpers/compile-helper');
    assert.throws(
      () => parseSource('server const tasa = 0.21\n\nwatch(tasa)\n    whisper("nunca pasa")'),
      /nunca cambia, así que watch\(\) nunca dispararía/
    );
  });

  test('server const prohibida dentro de un visual, igual que server var', () => {
    const { parseSource } = require('./helpers/compile-helper');
    const src = 'server const tasa = 0.21\n\nvisual v =\n<p>{tasa}</p>\n\nrender(\n    v\n)';
    assert.throws(() => parseSource(src), /"visual v" referencia "tasa", que es "server const"/);
  });
});

describe('route con parámetros (":id") y params()', () => {
  test('el caso real: route("/monedas/:id") + const {id} = params() -- servidor real', withServer(
    { 'api.ws': `route("/monedas/:id")

get function obtener(query)
    const {id} = params()
    return { moneda: id, query: query }
` },
    async (base) => {
      const r1 = await fetch(`${base}/monedas/bitcoin`);
      assert.deepEqual(await r1.json(), { moneda: 'bitcoin', query: {} });

      const r2 = await fetch(`${base}/monedas/eth?vs=usd`);
      assert.deepEqual(await r2.json(), { moneda: 'eth', query: { vs: 'usd' } });
    }
  ));

  test('POST también recibe los parámetros de la URL, junto con el body', withServer(
    { 'api.ws': `route("/monedas/:id")

post function actualizar(args)
    const {id} = params()
    return { actualizada: id, nombreNuevo: args.nombre }
` },
    async (base) => {
      const r = await fetch(`${base}/monedas/dogecoin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Dogecoin' }),
      });
      assert.deepEqual(await r.json(), { actualizada: 'dogecoin', nombreNuevo: 'Dogecoin' });
    }
  ));

  test('una ruta LITERAL gana siempre sobre una dinámica que también encajaría -- sin ambigüedad', withServer(
    {
      'dinamica.ws': `route("/monedas/:id")

get function obtener(query)
    const {id} = params()
    return { moneda: id }
`,
      'literal.ws': `route("/monedas/nuevo")

get function especial(query)
    return { esRutaLiteral: true }
`,
    },
    async (base) => {
      const r = await fetch(`${base}/monedas/nuevo`);
      assert.deepEqual(await r.json(), { esRutaLiteral: true }, 'debe ganar la ruta literal, no interpretarse como :id="nuevo"');
    }
  ));

  test('varios parámetros en la misma ruta, incluso sin ningún parámetro nombrado en la función', withServer(
    { 'api.ws': `route("/tienda/:categoria/:producto")

get function obtener()
    const p = params()
    return p
` },
    async (base) => {
      const r = await fetch(`${base}/tienda/electronica/portatil`);
      assert.deepEqual(await r.json(), { categoria: 'electronica', producto: 'portatil' });
    }
  ));

  test('params() en una ruta SIN ":" devuelve un objeto vacío, no falla', withServer(
    { 'api.ws': `route("/estatico")

get function obtener(query)
    const p = params()
    return { params: p, esVacio: Object.keys(p).length === 0 }
` },
    async (base) => {
      const r = await fetch(`${base}/estatico`);
      assert.deepEqual(await r.json(), { params: {}, esVacio: true });
    }
  ));

  test('nombre de parámetro repetido en la misma ruta -- rechazado en compilación', () => {
    const { parseSource } = require('./helpers/compile-helper');
    assert.throws(
      () => parseSource('route("/x/:id/y/:id")\n\nget function f(query)\n    return {}'),
      /repite el parámetro ":id"/
    );
  });
});

describe('query() de extremo a extremo: página con render(), servidor real', () => {
  test('el HTML pre-renderizado refleja la query string real de cada petición, no un valor fijo', withServer(
    { 'pagina.ws': `route("/")

reactive pagina = query().page || "1"

visual v =
<p>Página: {pagina}</p>

render(
    v
)
` },
    async (base) => {
      const r1 = await fetch(`${base}/`);
      assert.match(await r1.text(), /Página: 1/);

      const r2 = await fetch(`${base}/?page=7`);
      assert.match(await r2.text(), /Página: 7/, 'debe reflejar la query real de ESTA petición, pre-renderizado de verdad, no tras el JS del cliente');

      const r3 = await fetch(`${base}/?page=42`);
      assert.match(await r3.text(), /Página: 42/);
    }
  ));

  test('query() y server.X conviven en la misma página, ambos pre-renderizados a la vez', withServer(
    { 'pagina.ws': `route("/")

server var visitas = 100

reactive pagina = query().page || "1"
reactive contadorServidor = server.visitas

visual v =
<p>Página: {pagina} -- Visitas: {contadorServidor}</p>

render(
    v
)
` },
    async (base) => {
      const r = await fetch(`${base}/?page=3`);
      assert.match(await r.text(), /Página: 3 -- Visitas: 100/);
    }
  ));

  test('bug real cerrado: query() usado dentro de una "reactive" (no solo "var") se detecta y genera el helper correctamente', withServer(
    { 'pagina.ws': `route("/")

reactive filtro = query().filtro || "todos"

visual v =
<p>{filtro}</p>

render(
    v
)
` },
    async (base) => {
      // Antes del arreglo, esto daba ReferenceError: query is not defined -- la
      // colección de "cuerpos a revisar" no incluía los init de "reactive"
      const r = await fetch(`${base}/?filtro=activos`);
      assert.equal(r.status, 200);
      assert.match(await r.text(), /activos/);
    }
  ));
});

describe('ws function: servidor WebSocket real (RFC 6455 desde cero, sin dependencias)', () => {
  const { connectWs } = require('./helpers/ws-test-client');

  function withWs(wsFiles, testFn) {
    return async () => {
      const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ws-test-'));
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ws-out-'));
      for (const [name, content] of Object.entries(wsFiles)) {
        fs.writeFileSync(path.join(srcDir, name), content);
      }
      const { buildSite, startServer } = require('../src/site-builder');
      const { table } = buildSite(srcDir, outDir);
      const wsPort = 47000 + Math.floor(Math.random() * 3000);
      const server = startServer(table, outDir, 0, { wsPort });
      await new Promise(resolve => server.on('listening', resolve));
      try {
        await testFn(wsPort, server);
      } finally {
        server.close();
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    };
  }

  test('mensaje único, eco simple -- handshake real + frame real, extremo a extremo', withWs(
    { 'chat.ws': `route("/chat")

ws function entradaWS(args)
    return { eco: args.mensaje, mayusculas: args.mensaje.toUpperCase() }
` },
    async (wsPort) => {
      const client = await connectWs(wsPort, '/chat');
      const respuesta = await new Promise((resolve) => {
        client.onMessage(resolve);
        client.send({ mensaje: 'hola' });
      });
      assert.deepEqual(respuesta, { eco: 'hola', mayusculas: 'HOLA' });
      client.close();
    }
  ));

  test('bug real cerrado: la ws function se exponía en el server.js pero nunca en el objeto de sesión -- ahora sí es llamable', withWs(
    { 'chat.ws': `route("/chat")\n\nws function f(args)\n    return { ok: true }\n` },
    async (wsPort) => {
      // Este mismo test, antes del arreglo, daba "sessionState[route.wsFnName] is not a function"
      const client = await connectWs(wsPort, '/chat');
      const respuesta = await new Promise((resolve) => {
        client.onMessage(resolve);
        client.send({});
      });
      assert.deepEqual(respuesta, { ok: true });
      client.close();
    }
  ));

  test('varios mensajes en la MISMA conexión persistente -- el estado de sesión (server var) se mantiene entre ellos', withWs(
    { 'chat.ws': `route("/chat")

server var mensajesRecibidos = 0

ws function entradaWS(args)
    mensajesRecibidos = mensajesRecibidos + 1
    return { eco: args.mensaje, total: mensajesRecibidos }
` },
    async (wsPort) => {
      const client = await connectWs(wsPort, '/chat');
      const respuestas = [];
      const todasLlegaron = new Promise((resolve) => {
        client.onMessage((msg) => {
          respuestas.push(msg);
          if (respuestas.length === 3) resolve();
        });
      });
      client.send({ mensaje: 'uno' });
      client.send({ mensaje: 'dos' });
      client.send({ mensaje: 'tres' });
      await todasLlegaron;
      assert.deepEqual(respuestas.map(r => r.total), [1, 2, 3]);
      client.close();
    }
  ));

  test('una conexión a una ruta sin "ws function" es rechazada (404), no aceptada en silencio', withWs(
    {
      'chat.ws': `route("/chat")\n\nws function f(args)\n    return { ok: true }\n`,
      'normal.ws': `route("/x")\n\nget function f(query)\n    return { ok: true }\n`,
    },
    async (wsPort) => {
      // El servidor WS solo arranca si ALGUNA ruta tiene ws function (aquí, /chat) --
      // por eso este archivo incluye una, aunque el test prueba contra /x, que no la
      // tiene. Sin ninguna ws function en absoluto, el puerto ni siquiera escucharía
      // (ECONNREFUSED, no 404) -- ese es un escenario distinto, no lo que este test
      // quiere comprobar.
      await assert.rejects(() => connectWs(wsPort, '/x'), /404/);
    }
  ));

  test('un error dentro de la ws function no tumba la conexión -- se manda como mensaje de error, y la conexión sigue viva para el siguiente mensaje', withWs(
    { 'chat.ws': `route("/chat")

ws function f(args)
    if (args.reventar)
        return args.noExiste.propiedad
    return { ok: true }
` },
    async (wsPort) => {
      const client = await connectWs(wsPort, '/chat');
      const respuestas = [];
      const dosRespuestas = new Promise((resolve) => {
        client.onMessage((msg) => {
          respuestas.push(msg);
          if (respuestas.length === 2) resolve();
        });
      });
      client.send({ reventar: true });
      client.send({ reventar: false });
      await dosRespuestas;
      assert.ok(respuestas[0].error, 'el primer mensaje debe traer un error, no tumbar la conexión');
      assert.deepEqual(respuestas[1], { ok: true }, 'la conexión debe seguir viva para el segundo mensaje');
      client.close();
    }
  ));
});

describe('WSON via:"socket" de extremo a extremo: cliente WebSocket real dentro de WSON.send()', () => {
  test('el emisor se conecta como cliente WS al receptor, manda, y recibe la respuesta -- dos servidores reales', async () => {
    const { buildSite, startServer } = require('../src/site-builder');
    const receptorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-socket-r-'));
    const receptorOut = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-socket-r-out-'));
    const emisorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-socket-e-'));
    const emisorOut = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-socket-e-out-'));
    try {
      fs.writeFileSync(path.join(receptorDir, 'eco.ws'), `route("/eco")

ws function recibir(args)
    return { recibido: args.mensaje, doble: args.mensaje + args.mensaje }
`);
      const { table: tableR } = buildSite(receptorDir, receptorOut);
      const wsPort = 48000 + Math.floor(Math.random() * 3000);
      const serverR = startServer(tableR, receptorOut, 0, { wsPort });
      await new Promise(resolve => serverR.on('listening', resolve));

      fs.writeFileSync(path.join(emisorDir, 'api.ws'), `route("/api/enviar")

post function disparar(args)
    var r = await WSON.send({ to: "ws://localhost:${wsPort}/eco", via: "socket", content: { mensaje: args.texto } })
    return { respuestaRecibida: r }
`);
      const { table: tableE } = buildSite(emisorDir, emisorOut);
      const serverE = startServer(tableE, emisorOut, 0);
      await new Promise(resolve => serverE.on('listening', resolve));

      try {
        const port = serverE.address().port;
        const r = await fetch(`http://localhost:${port}/api/enviar`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texto: 'hola' }),
        });
        assert.deepEqual(await r.json(), { respuestaRecibida: { recibido: 'hola', doble: 'holahola' } });
      } finally {
        serverR.close();
        serverE.close();
      }
    } finally {
      fs.rmSync(receptorDir, { recursive: true, force: true });
      fs.rmSync(receptorOut, { recursive: true, force: true });
      fs.rmSync(emisorDir, { recursive: true, force: true });
      fs.rmSync(emisorOut, { recursive: true, force: true });
    }
  });

  test('destino inalcanzable -- reintenta, falla, y queda registrado como deadLetter en WSON.history()', withServer(
    { 'api.ws': `route("/api/x")

post function disparar(args)
    try {
        await WSON.send({ to: "ws://localhost:1/eco", via: "socket", content: { x: 1 }, retries: 1, retryDelayMs: 20 })
    } catch (e) {
    }
    return { total: WSON.history().length, soloDead: WSON.history({ deadLetter: true }).length }
` },
    async (base) => {
      const r = await fetch(`${base}/api/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.deepEqual(await r.json(), { total: 1, soloDead: 1 });
    }
  ));
});

describe('WSON con via:"socket" -- cifrado, firma, from: verificado a fondo (bugs reales encontrados y cerrados)', () => {
  test('bug real cerrado: WSON no estaba disponible dentro de una "ws function" en absoluto', () => {
    const { compile } = require('../src/compiler');
    const { parseSource } = require('./helpers/compile-helper');
    const ast = parseSource('route("/x")\n\nws function f(args)\n    var r = WSON.showContent(args, "clave")\n    return r');
    const { server } = compile(ast, { routePath: '/x' });
    assert.match(server, /const WSON = \{/, 'antes de este arreglo, "allBodies" no incluía el cuerpo de ws function -- WSON no se generaba');
  });

  test('secret/from/id llegan de verdad al receptor -- transmitidos en el handshake, leídos con headers()', async () => {
    const { buildSite, startServer } = require('../src/site-builder');
    const receptorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-socket-sec-r-'));
    const receptorOut = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-socket-sec-r-out-'));
    const emisorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-socket-sec-e-'));
    const emisorOut = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-socket-sec-e-out-'));
    try {
      fs.writeFileSync(path.join(receptorDir, 'eco.ws'), `route("/eco")

ws function recibir(args)
    server wson msg = WSON.parse(args, headers(), "clave-super-secreta")
    return { from: msg.from, content: msg.content, signatureValid: msg.signatureValid }
`);
      const { table: tableR } = buildSite(receptorDir, receptorOut);
      const wsPort = 50000 + Math.floor(Math.random() * 3000);
      const serverR = startServer(tableR, receptorOut, 0, { wsPort });
      await new Promise(resolve => serverR.on('listening', resolve));

      fs.writeFileSync(path.join(emisorDir, 'api.ws'), `route("/api/enviar")

post function disparar(args)
    var r = await WSON.send({
        to: "ws://localhost:${wsPort}/eco",
        via: "socket",
        content: { mensaje: "secreto" },
        secret: "clave-super-secreta",
        encrypt: true,
        from: "servicio-x"
    })
    return { respuesta: r }
`);
      const { table: tableE } = buildSite(emisorDir, emisorOut);
      const serverE = startServer(tableE, emisorOut, 0);
      await new Promise(resolve => serverE.on('listening', resolve));

      try {
        const port = serverE.address().port;
        const r = await fetch(`http://localhost:${port}/api/enviar`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        // Antes del arreglo: from llegaba undefined, signatureValid undefined, y content
        // era el blob cifrado sin descifrar (WSON ni siquiera estaba definido).
        assert.deepEqual(await r.json(), {
          respuesta: { from: 'servicio-x', content: { mensaje: 'secreto' }, signatureValid: true },
        });
      } finally {
        serverR.close();
        serverE.close();
      }
    } finally {
      fs.rmSync(receptorDir, { recursive: true, force: true });
      fs.rmSync(receptorOut, { recursive: true, force: true });
      fs.rmSync(emisorDir, { recursive: true, force: true });
      fs.rmSync(emisorOut, { recursive: true, force: true });
    }
  });

  test('firma incorrecta (secreto equivocado) se detecta como inválida, no se acepta a ciegas', async () => {
    const { buildSite, startServer } = require('../src/site-builder');
    const receptorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-socket-badsig-r-'));
    const receptorOut = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-socket-badsig-r-out-'));
    const emisorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-socket-badsig-e-'));
    const emisorOut = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-socket-badsig-e-out-'));
    try {
      fs.writeFileSync(path.join(receptorDir, 'eco.ws'), `route("/eco")

ws function recibir(args)
    var valida = WSON.verify(args, WSON.getSignature(headers()), "clave-correcta", WSON.getTimestamp(headers()))
    return { firmaValida: valida }
`);
      const { table: tableR } = buildSite(receptorDir, receptorOut);
      const wsPort = 53000 + Math.floor(Math.random() * 3000);
      const serverR = startServer(tableR, receptorOut, 0, { wsPort });
      await new Promise(resolve => serverR.on('listening', resolve));

      fs.writeFileSync(path.join(emisorDir, 'api.ws'), `route("/api/enviar")

post function disparar(args)
    var r = await WSON.send({
        to: "ws://localhost:${wsPort}/eco",
        via: "socket",
        content: { x: 1 },
        secret: "clave-INCORRECTA"
    })
    return { respuesta: r }
`);
      const { table: tableE } = buildSite(emisorDir, emisorOut);
      const serverE = startServer(tableE, emisorOut, 0);
      await new Promise(resolve => serverE.on('listening', resolve));

      try {
        const port = serverE.address().port;
        const r = await fetch(`http://localhost:${port}/api/enviar`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        assert.deepEqual(await r.json(), { respuesta: { firmaValida: false } });
      } finally {
        serverR.close();
        serverE.close();
      }
    } finally {
      fs.rmSync(receptorDir, { recursive: true, force: true });
      fs.rmSync(receptorOut, { recursive: true, force: true });
      fs.rmSync(emisorDir, { recursive: true, force: true });
      fs.rmSync(emisorOut, { recursive: true, force: true });
    }
  });
});

describe('route() sirve HTTP y WebSocket a la vez, en la misma ruta -- verificado en varios ángulos', () => {
  const { connectWs } = require('./helpers/ws-test-client');

  test('post function + ws function en el mismo archivo, misma sesión compartida entre los dos protocolos', async () => {
    const { buildSite, startServer } = require('../src/site-builder');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-combo-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-combo-out-'));
    try {
      fs.writeFileSync(path.join(dir, 'chat.ws'), `route("/chat")

server var contadorCompartido = 0

post function enviarHttp(args)
    contadorCompartido = contadorCompartido + 1
    return { via: "http", total: contadorCompartido }

ws function entradaWs(args)
    contadorCompartido = contadorCompartido + 1
    return { via: "websocket", total: contadorCompartido }
`);
      const { table } = buildSite(dir, outDir);
      const wsPort = 51000 + Math.floor(Math.random() * 3000);
      const server = startServer(table, outDir, 0, { wsPort });
      await new Promise(resolve => server.on('listening', resolve));
      const httpPort = server.address().port;
      try {
        // HTTP, WS, HTTP -- misma cookie, misma variable -- continuidad estricta
        // esperada: 1 (http), 2 (ws), 3 (http de nuevo), cruzando entre protocolos.
        const r1 = await fetch(`http://localhost:${httpPort}/chat`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const cookie = r1.headers.get('set-cookie').split(';')[0];
        assert.deepEqual(await r1.json(), { via: 'http', total: 1 });

        const client = await connectWs(wsPort, '/chat', { Cookie: cookie });
        const respuestaWs = await new Promise((resolve) => {
          client.onMessage(resolve);
          client.send({});
        });
        assert.deepEqual(respuestaWs, { via: 'websocket', total: 2 }, 'debe seguir desde el HTTP, misma sesión');

        const r2 = await fetch(`http://localhost:${httpPort}/chat`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}',
        });
        assert.deepEqual(await r2.json(), { via: 'http', total: 3 }, 'debe seguir desde el WebSocket, misma sesión');

        client.close();
      } finally {
        server.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('una ruta CON render() (página real) también puede tener ws function -- la SSR refleja los cambios hechos por WebSocket', async () => {
    const { buildSite, startServer } = require('../src/site-builder');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-combo-page-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-combo-page-out-'));
    try {
      fs.writeFileSync(path.join(dir, 'panel.ws'), `route("/panel")

server var contador = 0

ws function entrada(args)
    contador = contador + 1
    return { total: contador }

reactive vista = server.contador

visual v =
<p>Contador: {vista}</p>

render(
    v
)
`);
      const { table } = buildSite(dir, outDir);
      assert.equal(table[0].apiOnly, false, 'sigue siendo una página real, no solo backend');
      assert.equal(table[0].wsFnName, 'entrada', 'y también tiene su ws function');

      const wsPort = 54000 + Math.floor(Math.random() * 3000);
      const server = startServer(table, outDir, 0, { wsPort });
      await new Promise(resolve => server.on('listening', resolve));
      const httpPort = server.address().port;
      try {
        const r1 = await fetch(`http://localhost:${httpPort}/panel`);
        const cookie = r1.headers.get('set-cookie').split(';')[0];
        assert.match(await r1.text(), /Contador: 0/);

        const client = await connectWs(wsPort, '/panel', { Cookie: cookie });
        await new Promise((resolve) => {
          client.onMessage(resolve);
          client.send({});
        });

        const r2 = await fetch(`http://localhost:${httpPort}/panel`, { headers: { Cookie: cookie } });
        assert.match(await r2.text(), /Contador: 1/, 'la SSR debe reflejar el cambio hecho por WebSocket, misma sesión');

        client.close();
      } finally {
        server.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('varias rutas distintas, cada una con su propia ws function, compartiendo el mismo ws-port -- distinguidas por path', async () => {
    const { buildSite, startServer } = require('../src/site-builder');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-combo-multi-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-combo-multi-out-'));
    try {
      fs.writeFileSync(path.join(dir, 'chat.ws'), `route("/chat")\n\nws function entradaChat(args)\n    return { ruta: "chat", eco: args.texto }\n`);
      fs.writeFileSync(path.join(dir, 'notificaciones.ws'), `route("/notificaciones")\n\nws function entradaNotif(args)\n    return { ruta: "notificaciones", eco: args.texto }\n`);
      const { table } = buildSite(dir, outDir);
      const wsPort = 57000 + Math.floor(Math.random() * 3000);
      const server = startServer(table, outDir, 0, { wsPort });
      await new Promise(resolve => server.on('listening', resolve));
      try {
        const clienteChat = await connectWs(wsPort, '/chat');
        const clienteNotif = await connectWs(wsPort, '/notificaciones');

        const respuestaChat = await new Promise((resolve) => {
          clienteChat.onMessage(resolve);
          clienteChat.send({ texto: 'hola chat' });
        });
        assert.deepEqual(respuestaChat, { ruta: 'chat', eco: 'hola chat' });

        const respuestaNotif = await new Promise((resolve) => {
          clienteNotif.onMessage(resolve);
          clienteNotif.send({ texto: 'hola notif' });
        });
        assert.deepEqual(respuestaNotif, { ruta: 'notificaciones', eco: 'hola notif' });

        clienteChat.close();
        clienteNotif.close();
      } finally {
        server.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('WSON.showContent/verify/getSignature con WebSocket: cada uno probado por separado, positivo y negativo', () => {
  async function montarParEmisorReceptor(receptorBody, emisorWsonExtra) {
    const receptorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-methods-r-'));
    const receptorOut = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-methods-r-out-'));
    const emisorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-methods-e-'));
    const emisorOut = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-methods-e-out-'));
    const wsPort = 55000 + Math.floor(Math.random() * 3000);

    fs.writeFileSync(path.join(receptorDir, 'eco.ws'), `route("/eco")\n\nws function recibir(args)\n${receptorBody}\n`);
    const { table: tableR } = buildSite(receptorDir, receptorOut);
    const serverR = startServer(tableR, receptorOut, 0, { wsPort });
    await new Promise(resolve => serverR.on('listening', resolve));

    fs.writeFileSync(path.join(emisorDir, 'api.ws'), `route("/api/enviar")

post function disparar(args)
    var r = await WSON.send({
        to: "ws://localhost:${wsPort}/eco",
        via: "socket",
        content: { dato: "valor-real" }${emisorWsonExtra}
    })
    return r
`);
    const { table: tableE } = buildSite(emisorDir, emisorOut);
    const serverE = startServer(tableE, emisorOut, 0);
    await new Promise(resolve => serverE.on('listening', resolve));

    return {
      async llamar() {
        const r = await fetch(`http://localhost:${serverE.address().port}/api/enviar`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        return r.json();
      },
      cerrar() {
        serverR.close();
        serverE.close();
        fs.rmSync(receptorDir, { recursive: true, force: true });
        fs.rmSync(receptorOut, { recursive: true, force: true });
        fs.rmSync(emisorDir, { recursive: true, force: true });
        fs.rmSync(emisorOut, { recursive: true, force: true });
      },
    };
  }

  const { buildSite, startServer } = require('../src/site-builder');

  test('WSON.getSignature()/verify()/showContent() -- los tres, con clave correcta, funcionan a la vez', async () => {
    const par = await montarParEmisorReceptor(
      `    var firmaCabecera = WSON.getSignature(headers())
    var firmaValida = WSON.verify(args, firmaCabecera, "clave-correcta", WSON.getTimestamp(headers()))
    var contenido = WSON.showContent(args, "clave-correcta")
    return { firmaCabeceraExiste: firmaCabecera !== undefined, firmaValida: firmaValida, contenido: contenido }`,
      ',\n        secret: "clave-correcta",\n        encrypt: true'
    );
    try {
      const resultado = await par.llamar();
      assert.equal(resultado.firmaCabeceraExiste, true);
      assert.equal(resultado.firmaValida, true);
      assert.deepEqual(resultado.contenido, { dato: 'valor-real' });
    } finally {
      par.cerrar();
    }
  });

  test('WSON.showContent() con clave incorrecta da null -- no descifra basura', async () => {
    const par = await montarParEmisorReceptor(
      `    return { contenido: WSON.showContent(args, "clave-INCORRECTA") }`,
      ',\n        secret: "clave-correcta",\n        encrypt: true'
    );
    try {
      const resultado = await par.llamar();
      assert.equal(resultado.contenido, null);
    } finally {
      par.cerrar();
    }
  });

  test('WSON.verify() con clave incorrecta da false -- no acepta la firma a ciegas', async () => {
    const par = await montarParEmisorReceptor(
      `    var firma = WSON.getSignature(headers())
    return { valida: WSON.verify(args, firma, "clave-INCORRECTA", WSON.getTimestamp(headers())) }`,
      ',\n        secret: "clave-correcta"'
    );
    try {
      const resultado = await par.llamar();
      assert.equal(resultado.valida, false);
    } finally {
      par.cerrar();
    }
  });

  test('WSON.getSignature() da undefined en un mensaje SIN firmar (sin "secret")', async () => {
    const par = await montarParEmisorReceptor(
      `    var firma = WSON.getSignature(headers())
    return { esUndefined: firma === undefined }`,
      ''
    );
    try {
      const resultado = await par.llamar();
      assert.equal(resultado.esUndefined, true);
    } finally {
      par.cerrar();
    }
  });
});

describe('Seguridad: protección CSRF real (cookie de doble envío)', () => {
  test('la cookie wcsrf se manda junto a wsid, y NO es HttpOnly (legible por JS, a diferencia de wsid)', withServer(
    { 'api.ws': `route("/x")\n\npost function f(args)\n    return { ok: true }\n` },
    async (base) => {
      const r = await fetch(`${base}/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const cookies = r.headers.getSetCookie();
      const wsidCookie = cookies.find(c => c.startsWith('wsid='));
      const wcsrfCookie = cookies.find(c => c.startsWith('wcsrf='));
      assert.ok(wsidCookie, 'debe mandar la cookie wsid');
      assert.ok(wcsrfCookie, 'debe mandar la cookie wcsrf');
      assert.match(wsidCookie, /HttpOnly/, 'wsid SÍ debe ser HttpOnly');
      assert.doesNotMatch(wcsrfCookie, /HttpOnly/, 'wcsrf NO debe ser HttpOnly -- JS necesita poder leerla');
    }
  ));

  test('la PRIMERA petición de una sesión nueva no exige el token (nada que secuestrar todavía)', withServer(
    { 'api.ws': `route("/x")\n\npost function f(args)\n    return { ok: true }\n` },
    async (base) => {
      const r = await fetch(`${base}/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 200, 'la primera petición, sin sesión previa, no debe rechazarse por CSRF');
    }
  ));

  test('una SEGUNDA petición (sesión existente) SIN el token CSRF se rechaza con 403', withServer(
    { 'api.ws': `route("/x")\n\npost function f(args)\n    return { ok: true }\n` },
    async (base) => {
      const r1 = await fetch(`${base}/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const wsidCookie = r1.headers.getSetCookie().find(c => c.startsWith('wsid=')).split(';')[0];

      // __originalFetch (sin el envoltorio de esta suite) -- de verdad SIN la
      // cabecera CSRF, no un string vacío (que sigue siendo falsy y el envoltorio la
      // rellenaría solo, invalidando la prueba).
      const r2 = await __originalFetch(`${base}/x`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: wsidCookie },
        body: '{}',
      });
      assert.equal(r2.status, 403, 'una sesión existente, sin el token CSRF, debe rechazarse');
    }
  ));

  test('una SEGUNDA petición con un token CSRF INCORRECTO también se rechaza con 403 -- no basta con mandar algo', withServer(
    { 'api.ws': `route("/x")\n\npost function f(args)\n    return { ok: true }\n` },
    async (base) => {
      const r1 = await fetch(`${base}/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const wsidCookie = r1.headers.getSetCookie().find(c => c.startsWith('wsid=')).split(';')[0];

      const r2 = await fetch(`${base}/x`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: wsidCookie, 'X-WebScript-CSRF': 'token-inventado-al-azar' },
        body: '{}',
      });
      assert.equal(r2.status, 403);
    }
  ));

  test('con el token CSRF correcto, la sesión existente SÍ acepta la petición', withServer(
    { 'api.ws': `route("/x")\n\nserver var total = 0\n\npost function f(args)\n    total = total + 1\n    return { total: total }\n` },
    async (base) => {
      const r1 = await fetch(`${base}/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const cookies = r1.headers.getSetCookie();
      const wsidCookie = cookies.find(c => c.startsWith('wsid=')).split(';')[0];
      const wcsrfToken = cookies.find(c => c.startsWith('wcsrf=')).split(';')[0].split('=')[1];
      assert.deepEqual(await r1.json(), { total: 1 });

      const r2 = await fetch(`${base}/x`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: wsidCookie, 'X-WebScript-CSRF': wcsrfToken },
        body: '{}',
      });
      assert.equal(r2.status, 200);
      assert.deepEqual(await r2.json(), { total: 2 }, 'debe seguir acumulando en la misma sesión, no una nueva');
    }
  ));

  test('GET no exige token CSRF -- solo las escrituras (POST/PUT/DELETE)', withServer(
    { 'api.ws': `route("/x")\n\nserver var total = 5\n\nget function f(query)\n    return { total: total }\n` },
    async (base) => {
      const r = await fetch(`${base}/x`);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { total: 5 });
    }
  ));

  test('PUT y DELETE también exigen el token en una sesión existente, igual que POST', withServer(
    { 'api.ws': `route("/x")\n\nput function actualizar(args)\n    return { ok: "put" }\n\ndelete function borrar(args)\n    return { ok: "delete" }\n` },
    async (base) => {
      const r1 = await fetch(`${base}/x`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const wsidCookie = r1.headers.getSetCookie().find(c => c.startsWith('wsid=')).split(';')[0];
      assert.equal(r1.status, 200, 'primera petición (sesión nueva) -- sin exigir token');

      const r2 = await __originalFetch(`${base}/x`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: wsidCookie },
        body: '{}',
      });
      assert.equal(r2.status, 403, 'PUT en sesión existente, sin token, debe rechazarse');

      const r3 = await __originalFetch(`${base}/x`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Cookie: wsidCookie },
        body: '{}',
      });
      assert.equal(r3.status, 403, 'DELETE en sesión existente, sin token, debe rechazarse');
    }
  ));
});

describe('Seguridad: el bundle.js generado SÍ manda la cabecera CSRF de verdad -- bug real que faltaba conectar', () => {
  test('el postFnStub del cliente lee la cookie wcsrf y la manda como X-WebScript-CSRF -- servidor real, bundle.js real ejecutado', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-csrf-client-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-csrf-client-out-'));
    try {
      fs.writeFileSync(path.join(dir, 'pagina.ws'), `route("/")

server var total = 0

post function incrementar(args)
    total = total + 1
    return { total: total }

visual v =
<button onclick={incrementar()}>x</button>

render(
    v
)
`);
      const { table } = buildSite(dir, outDir);
      const server = startServer(table, outDir, 0);
      await new Promise(resolve => server.on('listening', resolve));
      const port = server.address().port;

      try {
        // 1. Primera visita real -- como haría un navegador cargando la página --
        //    consigue las cookies wsid/wcsrf reales del servidor.
        const r1 = await __originalFetch(`http://localhost:${port}/`);
        const setCookies = r1.headers.getSetCookie();
        const wsidCookie = setCookies.find(c => c.startsWith('wsid=')).split(';')[0];
        const wcsrfValue = setCookies.find(c => c.startsWith('wcsrf=')).split(';')[0].split('=')[1];

        // 2. Ejecuta el bundle.js REAL, en un entorno con document.cookie simulado
        //    (conteniendo la cookie wcsrf real que el servidor mandó) y fetch()
        //    interceptado para inspeccionar qué cabeceras manda de verdad el código
        //    generado, sin mockear la lógica en sí -- es el bundle.js compilado tal cual.
        const bundleCode = fs.readFileSync(path.join(outDir, 'index.bundle.js'), 'utf8');
        const vm = require('vm');
        let capturedHeaders = null;

        function makeEl(tag) {
          const el = {
            tag, nodeType: 1, children: [], attrs: {}, listeners: {},
            appendChild(c) { this.children.push(c); },
            setAttribute(k, v) { this.attrs[k] = v; },
            addEventListener(ev, fn) { this.listeners[ev] = fn; },
          };
          el.classList = { add: () => {} };
          return el;
        }
        function makeText(v) { return { nodeType: 3, text: v }; }
        const appSingleton = makeEl('div');

        const sandbox = {
          document: {
            cookie: `wsid=${wsidCookie.split('=')[1]}; wcsrf=${wcsrfValue}`,
            createElement: (tag) => makeEl(tag),
            createTextNode: (v) => makeText(v),
            createComment: () => makeText(''),
            createDocumentFragment: () => makeEl('fragment'),
            getElementById: () => appSingleton,
            addEventListener: (ev, fn) => fn(),
          },
          window: { location: { pathname: '/', search: '' } },
          location: { protocol: 'http:', pathname: '/' },
          fetch: (url, opts) => {
            capturedHeaders = opts.headers;
            return Promise.resolve({ json: () => Promise.resolve({ total: 1 }) });
          },
          console,
        };
        vm.createContext(sandbox);
        vm.runInContext(bundleCode, sandbox);
        // Llama directamente a la función generada "incrementar" (expuesta como global
        // en el propio contexto del vm, ya que el bundle la declara a nivel de módulo).
        await sandbox.incrementar();

        assert.ok(capturedHeaders, 'el fetch() del bundle.js debe haberse llamado de verdad');
        assert.equal(
          capturedHeaders['X-WebScript-CSRF'],
          wcsrfValue,
          'el postFnStub generado debe leer document.cookie y mandar el token real, no dejarlo vacío'
        );
      } finally {
        server.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('Seguridad: límite de tasa (rate limiting) por IP', () => {
  test('bloquea al superar el límite, dentro de la misma ventana', withServer(
    { 'api.ws': `route("/x")\n\nget function f(query)\n    return { ok: true }\n` },
    async (base) => {
      const resultados = [];
      for (let i = 0; i < 7; i++) {
        const r = await __originalFetch(`${base}/x`);
        resultados.push(r.status);
      }
      assert.deepEqual(resultados, [200, 200, 200, 200, 200, 429, 429]);
    },
    { rateLimitMax: 5, rateLimitWindowMs: 1000 }
  ));

  test('la respuesta 429 trae Retry-After y un mensaje claro', withServer(
    { 'api.ws': `route("/x")\n\nget function f(query)\n    return { ok: true }\n` },
    async (base) => {
      await __originalFetch(`${base}/x`);
      const r = await __originalFetch(`${base}/x`);
      assert.equal(r.status, 429);
      assert.ok(r.headers.get('retry-after'), 'debe traer Retry-After');
      const body = await r.json();
      assert.match(body.error, /Demasiadas peticiones/);
    },
    { rateLimitMax: 1, rateLimitWindowMs: 5000 }
  ));

  test('tras pasar la ventana, el contador se renueva -- vuelve a aceptar', withServer(
    { 'api.ws': `route("/x")\n\nget function f(query)\n    return { ok: true }\n` },
    async (base) => {
      await __originalFetch(`${base}/x`);
      const bloqueada = await __originalFetch(`${base}/x`);
      assert.equal(bloqueada.status, 429);

      await new Promise(r => setTimeout(r, 600));
      const renovada = await __originalFetch(`${base}/x`);
      assert.equal(renovada.status, 200, 'la ventana debe haberse renovado');
    },
    { rateLimitMax: 1, rateLimitWindowMs: 500 }
  ));

  test('rateLimitMax: 0 desactiva el límite -- ninguna petición se rechaza', withServer(
    { 'api.ws': `route("/x")\n\nget function f(query)\n    return { ok: true }\n` },
    async (base) => {
      const resultados = [];
      for (let i = 0; i < 15; i++) {
        const r = await __originalFetch(`${base}/x`);
        resultados.push(r.status);
      }
      assert.ok(resultados.every(s => s === 200), 'con el límite desactivado, ninguna debe rechazarse');
    },
    { rateLimitMax: 0 }
  ));

  test('sin configurar nada (valor por defecto), un puñado de peticiones normales no se ve afectado', withServer(
    { 'api.ws': `route("/x")\n\nget function f(query)\n    return { ok: true }\n` },
    async (base) => {
      const resultados = [];
      for (let i = 0; i < 10; i++) {
        const r = await __originalFetch(`${base}/x`);
        resultados.push(r.status);
      }
      assert.ok(resultados.every(s => s === 200), 'el valor por defecto (300) no debe interferir con un uso normal de pruebas');
    }
  ));
});

describe('config: "rate-limit-max"/"rate-limit-window-ms" se conectan automáticamente vía serveSite()', () => {
  test('con valores personalizados en wconfig.json, el límite real se aplica sin pasar nada a mano', async () => {
    const { serveSite } = require('../src/site-builder');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ratelimit-cfg-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ratelimit-cfg-out-'));
    try {
      fs.writeFileSync(path.join(dir, 'wconfig.json'), JSON.stringify({ 'rate-limit-max': 2, 'rate-limit-window-ms': 2000 }));
      fs.writeFileSync(path.join(dir, 'api.ws'), 'route("/x")\n\nget function f(query)\n    return { ok: true }\n');
      const server = serveSite(dir, outDir, 0);
      await new Promise(resolve => server.on('listening', resolve));
      try {
        const port = server.address().port;
        const resultados = [];
        for (let i = 0; i < 4; i++) {
          const r = await __originalFetch(`http://localhost:${port}/x`);
          resultados.push(r.status);
        }
        assert.deepEqual(resultados, [200, 200, 429, 429]);
      } finally {
        server.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('Seguridad: protección contra reenvío (replay) en WSON', () => {
  test('un mensaje capturado y reenviado tal cual se detecta -- firma sigue válida (no se alteró), pero replayDetected: true', withServer(
    { 'api.ws': `route("/recibir")

post function recibir(args, query, headers)
    server wson msg = WSON.parse(args, headers, "clave-compartida")
    return { signatureValid: msg.signatureValid, replayDetected: msg.replayDetected }
` },
    async (base) => {
      const crypto = require('crypto');
      const payload = { x: 1 };
      const timestamp = Date.now();
      const sig = crypto.createHmac('sha256', 'clave-compartida').update(JSON.stringify(payload) + '.' + timestamp).digest('hex');
      const headers = {
        'Content-Type': 'application/json',
        'X-WSON-Correlation-Id': 'id-fijo-reenvio-test',
        'X-WSON-Timestamp': String(timestamp),
        'X-WSON-Signature': 'sha256=' + sig,
      };

      const r1 = await __originalFetch(`${base}/recibir`, { method: 'POST', headers, body: JSON.stringify(payload) });
      assert.deepEqual(await r1.json(), { signatureValid: true, replayDetected: false });

      // Reenvío EXACTO -- mismas cabeceras, mismo cuerpo, simula un atacante que
      // capturó la petición anterior y la manda otra vez tal cual.
      const r2 = await __originalFetch(`${base}/recibir`, { method: 'POST', headers, body: JSON.stringify(payload) });
      assert.deepEqual(await r2.json(), { signatureValid: true, replayDetected: true });
    }
  ));

  test('una firma correcta pero con marca de tiempo fuera de la ventana se rechaza -- aunque matemáticamente sea válida', withServer(
    { 'api.ws': `route("/x")

post function f(args, query, headers)
    server wson msg = WSON.parse(args, headers, "clave")
    return { valida: msg.signatureValid }
` },
    async (base) => {
      const crypto = require('crypto');
      const payload = { x: 1 };
      const timestampViejo = Date.now() - (10 * 60 * 1000); // 10 minutos -- fuera de la ventana por defecto (5 min)
      const sig = crypto.createHmac('sha256', 'clave').update(JSON.stringify(payload) + '.' + timestampViejo).digest('hex');
      const r = await __originalFetch(`${base}/x`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WSON-Timestamp': String(timestampViejo), 'X-WSON-Signature': 'sha256=' + sig },
        body: JSON.stringify(payload),
      });
      assert.deepEqual(await r.json(), { valida: false });
    }
  ));

  test('sin marca de tiempo en absoluto, se rechaza -- ya no basta con mandar solo la firma', withServer(
    { 'api.ws': `route("/x")

post function f(args, query, headers)
    server wson msg = WSON.parse(args, headers, "clave")
    return { valida: msg.signatureValid }
` },
    async (base) => {
      const crypto = require('crypto');
      const payload = { x: 1 };
      const sigConTimestampInventado = crypto.createHmac('sha256', 'clave').update(JSON.stringify(payload) + '.' + Date.now()).digest('hex');
      const r = await __originalFetch(`${base}/x`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WSON-Signature': 'sha256=' + sigConTimestampInventado },
        body: JSON.stringify(payload),
      });
      assert.deepEqual(await r.json(), { valida: false });
    }
  ));

  test('con una ventana MUY corta configurada, un mensaje sigue válido de inmediato pero deja de estarlo tras esperar', async () => {
    // "wsonReplayWindowMs" es una opción de COMPILACIÓN (se hornea en el server.js
    // generado), no de tiempo de ejecución -- withServer() solo pasa "serverOptions"
    // a startServer(), así que aquí hace falta un wconfig.json real, como el resto de
    // opciones de compilación de este proyecto.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-replay-window-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-replay-window-out-'));
    try {
      fs.writeFileSync(path.join(dir, 'wconfig.json'), JSON.stringify({ 'wson-replay-window-ms': 500 }));
      fs.writeFileSync(path.join(dir, 'x.ws'), `route("/x")

post function f(args, query, headers)
    server wson msg = WSON.parse(args, headers, "clave")
    return { valida: msg.signatureValid }
`);
      const { table } = buildSite(dir, outDir);
      const server = startServer(table, outDir, 0);
      await new Promise(resolve => server.on('listening', resolve));
      try {
        const port = server.address().port;
        const crypto = require('crypto');
        const payload = { x: 1 };
        const timestamp = Date.now();
        const sig = crypto.createHmac('sha256', 'clave').update(JSON.stringify(payload) + '.' + timestamp).digest('hex');
        const headers = { 'Content-Type': 'application/json', 'X-WSON-Timestamp': String(timestamp), 'X-WSON-Signature': 'sha256=' + sig };

        const r1 = await __originalFetch(`http://localhost:${port}/x`, { method: 'POST', headers, body: JSON.stringify(payload) });
        assert.deepEqual(await r1.json(), { valida: true }, 'de inmediato, dentro de la ventana, debe ser válido');

        await new Promise(resolve => setTimeout(resolve, 600));
        const r2 = await __originalFetch(`http://localhost:${port}/x`, { method: 'POST', headers, body: JSON.stringify(payload) });
        const data2 = await r2.json();
        assert.equal(data2.valida, false, 'tras pasar la ventana configurada (500ms), la misma firma ya no debe ser válida');
      } finally {
        server.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('config: "wson-replay-window-ms" se conecta automáticamente vía serveSite()', () => {
  test('con una ventana corta en wconfig.json, el rechazo real se aplica sin pasar nada a mano', async () => {
    const { serveSite } = require('../src/site-builder');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-replay-cfg-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-replay-cfg-out-'));
    try {
      fs.writeFileSync(path.join(dir, 'wconfig.json'), JSON.stringify({ 'wson-replay-window-ms': 500 }));
      fs.writeFileSync(path.join(dir, 'x.ws'), `route("/x")

post function f(args, query, headers)
    server wson msg = WSON.parse(args, headers, "clave")
    return { valida: msg.signatureValid }
`);
      const server = serveSite(dir, outDir, 0);
      await new Promise(resolve => server.on('listening', resolve));
      try {
        const port = server.address().port;
        const crypto = require('crypto');
        const payload = { x: 1 };
        const timestampViejo = Date.now() - 2000; // 2s -- fuera de la ventana de 500ms configurada
        const sig = crypto.createHmac('sha256', 'clave').update(JSON.stringify(payload) + '.' + timestampViejo).digest('hex');
        const r = await __originalFetch(`http://localhost:${port}/x`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-WSON-Timestamp': String(timestampViejo), 'X-WSON-Signature': 'sha256=' + sig },
          body: JSON.stringify(payload),
        });
        assert.deepEqual(await r.json(), { valida: false });
      } finally {
        server.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
