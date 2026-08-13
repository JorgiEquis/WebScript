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

describe('servidor: updateServer / endpoint de datos', () => {
  test('GET inicial, POST actualiza, y persiste en el siguiente GET (misma sesión)', withServer(
    {
      'pagina.ws': `route("/dinamica")

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
      const r1 = await fetch(`${base}/dinamica.server-data.json`);
      const cookie = r1.headers.get('set-cookie').split(';')[0];
      assert.deepEqual(await r1.json(), { visitas: 100 });

      const r2 = await fetch(`${base}/dinamica.server-data.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ visitas: 101 }),
      });
      assert.deepEqual(await r2.json(), { visitas: 101 });

      const r3 = await fetch(`${base}/dinamica.server-data.json`, { headers: { Cookie: cookie } });
      assert.deepEqual(await r3.json(), { visitas: 101 }, 'debe persistir, no volver a 100');
    }
  ));

  test('claves desconocidas en el POST se ignoran (no se cuelan variables nuevas)', withServer(
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
        body: JSON.stringify({ visitas: 5, campoInventado: 'hackeo' }),
      });
      const data = await r.json();
      assert.deepEqual(data, { visitas: 5 });
      assert.equal(data.campoInventado, undefined);
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
