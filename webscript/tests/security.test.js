const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSite, startServer } = require('../src/site-builder');

function withServer(wsFiles, testFn) {
  return async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-sec-test-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-sec-out-'));
    for (const [name, content] of Object.entries(wsFiles)) {
      fs.writeFileSync(path.join(srcDir, name), content);
    }
    const { table } = buildSite(srcDir, outDir);
    const server = startServer(table, outDir, 0);
    await new Promise(resolve => server.on('listening', resolve));
    const port = server.address().port;
    try {
      await testFn(`http://localhost:${port}`, outDir);
    } finally {
      server.close();
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  };
}

describe('seguridad: path traversal', () => {
  test('no se puede leer un archivo fuera de outDir vía estáticos (%2f codificado)', withServer(
    {
      'pagina.ws': `route("/")

visual v =
<h1>hola</h1>

render(
    v
)
`,
    },
    async (base, outDir) => {
      const depth = outDir.split(path.sep).filter(Boolean).length + 2;
      const traversal = '..%2f'.repeat(depth) + 'etc%2fpasswd';
      const r = await fetch(`${base}/${traversal}`);
      assert.notEqual(r.status, 200, 'no debe devolver 200 para una ruta fuera de outDir');
      const text = await r.text();
      assert.doesNotMatch(text, /root:.*:0:0:/, 'la respuesta no debe contener contenido de /etc/passwd');
    }
  ));

  test('la ruta legítima sigue funcionando tras la protección', withServer(
    {
      'pagina.ws': `route("/")

visual v =
<h1>hola</h1>

render(
    v
)
`,
    },
    async (base) => {
      const r = await fetch(`${base}/`);
      assert.equal(r.status, 200);
    }
  ));

  test('baseName manipulado en el endpoint de datos se rechaza (no llega a require())', withServer(
    {
      'pagina.ws': `route("/con-datos")

server var x = 1

reactive y = server.x

visual v =
<p>{y}</p>

render(
    v
)
`,
    },
    async (base) => {
      const legit = await fetch(`${base}/con-datos.server-data.json`);
      assert.equal(legit.status, 200);
      assert.deepEqual(await legit.json(), { x: 1 });

      const attack = await fetch(`${base}/..%2f..%2f..%2fetc%2fpasswd.server-data.json`);
      assert.equal(attack.status, 404, 'un baseName que no está en la tabla de rutas debe dar 404');
    }
  ));
});
