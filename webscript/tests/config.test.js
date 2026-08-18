const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, DEFAULTS } = require('../src/config');

describe('config: wconfig.json opcional del proyecto', () => {
  test('sin wconfig.json, devuelve los valores por defecto tal cual', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-'));
    try {
      assert.deepEqual(loadConfig(dir), DEFAULTS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('con wconfig.json válido (parcial), mezcla con los valores por defecto', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-'));
    try {
      fs.writeFileSync(path.join(dir, 'wconfig.json'), JSON.stringify({ 'http-port': 4000 }));
      const config = loadConfig(dir);
      assert.equal(config['http-port'], 4000);
      assert.equal(config['ws-port'], DEFAULTS['ws-port'], 'lo no especificado debe seguir en su valor por defecto');
      assert.equal(config['allow-acorn'], DEFAULTS['allow-acorn']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('con wconfig.json completo, todos los valores se toman del archivo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-'));
    try {
      const custom = {
        'http-port': 4000, 'ws-port': 4001, 'allow-acorn': false,
        'wson-history-route': '/var/log/x.jsonl', 'cluster-workers': 4,
        'stylesheets': ['https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css'],
        'rate-limit-max': 500, 'rate-limit-window-ms': 30000,
        'wson-replay-window-ms': 120000,
      };
      fs.writeFileSync(path.join(dir, 'wconfig.json'), JSON.stringify(custom));
      assert.deepEqual(loadConfig(dir), custom);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('JSON inválido -- rechazado con un error claro, no ignorado en silencio', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-'));
    try {
      fs.writeFileSync(path.join(dir, 'wconfig.json'), '{ esto no es JSON');
      assert.throws(() => loadConfig(dir), /no es JSON válido/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('clave desconocida -- rechazada, con el nombre de la clave y las válidas en el mensaje', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-'));
    try {
      fs.writeFileSync(path.join(dir, 'wconfig.json'), JSON.stringify({ 'puerto-mal-escrito': 3000 }));
      assert.throws(() => loadConfig(dir), /clave desconocida.*puerto-mal-escrito/s);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('tipos incorrectos -- cada campo valida el suyo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-'));
    try {
      fs.writeFileSync(path.join(dir, 'wconfig.json'), JSON.stringify({ 'http-port': 'no-es-un-numero' }));
      assert.throws(() => loadConfig(dir), /"http-port" debe ser un entero positivo/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cluster-workers debe ser un entero de 1 o más', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-'));
    try {
      fs.writeFileSync(path.join(dir, 'wconfig.json'), JSON.stringify({ 'cluster-workers': 0 }));
      assert.throws(() => loadConfig(dir), /"cluster-workers" debe ser un entero de 1 o más/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('config: integrado con allow-acorn (js-analyzer) y wson-history-route (compilador)', () => {
  test('buildSite() aplica allow-acorn ANTES de compilar -- jsAnalyzer.isAvailable() refleja el wconfig.json', () => {
    const { buildSite } = require('../src/site-builder');
    const jsAnalyzer = require('../src/js-analyzer');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-acorn-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-acorn-out-'));
    try {
      fs.writeFileSync(path.join(dir, 'wconfig.json'), JSON.stringify({ 'allow-acorn': false }));
      fs.writeFileSync(path.join(dir, 'api.ws'), 'route("/x")\n\nget function f(query)\n    return { ok: true }\n');
      buildSite(dir, outDir);
      assert.equal(jsAnalyzer.isAvailable(), false, 'allow-acorn:false debe forzar isAvailable() a false, incluso si Acorn estuviera instalado');
      jsAnalyzer.setAllowAcorn(true); // deja el estado global limpio para el resto de tests
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('buildSite() propaga wson-history-route al server.js generado -- se escribe en la ruta configurada', async () => {
    const { buildSite, startServer } = require('../src/site-builder');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-wson-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-wson-out-'));
    const historyFile = path.join(os.tmpdir(), `ws-config-history-${Date.now()}.jsonl`);
    try {
      fs.writeFileSync(path.join(dir, 'wconfig.json'), JSON.stringify({ 'wson-history-route': historyFile }));
      fs.writeFileSync(path.join(dir, 'api.ws'), `route("/api/x")

post function enviar(args)
    try { await WSON.send({ to: "http://localhost:1/x", content: "x" }) } catch (e) {}
    return { ok: true }
`);
      const { table } = buildSite(dir, outDir);
      const server = startServer(table, outDir, 0);
      await new Promise(resolve => server.on('listening', resolve));
      const port = server.address().port;
      await fetch(`http://localhost:${port}/api/x`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      server.close();
      assert.ok(fs.existsSync(historyFile), 'debe haberse escrito en la ruta configurada por wconfig.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.rmSync(historyFile, { force: true });
    }
  });

  test('serveSite() usa "http-port" de wconfig.json cuando no se pasa un puerto explícito', async () => {
    const { serveSite } = require('../src/site-builder');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-port-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-port-out-'));
    try {
      // puerto 0 = "cualquiera libre" en Node -- pero wconfig.json dice un valor
      // concreto (aunque improbable, si ese puerto exacto no está libre el test
      // fallaría por una razón ajena; se usa un puerto alto poco probable de colisión)
      const puertoElegido = 58234;
      fs.writeFileSync(path.join(dir, 'wconfig.json'), JSON.stringify({ 'http-port': puertoElegido }));
      fs.writeFileSync(path.join(dir, 'api.ws'), 'route("/x")\n\nget function f(query)\n    return { ok: true }\n');
      const server = serveSite(dir, outDir, undefined);
      await new Promise(resolve => server.on('listening', resolve));
      assert.equal(server.address().port, puertoElegido);
      server.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('serveSite() con un puerto explícito ignora el "http-port" de wconfig.json', async () => {
    const { serveSite } = require('../src/site-builder');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-port2-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-port2-out-'));
    try {
      fs.writeFileSync(path.join(dir, 'wconfig.json'), JSON.stringify({ 'http-port': 9999 }));
      fs.writeFileSync(path.join(dir, 'api.ws'), 'route("/x")\n\nget function f(query)\n    return { ok: true }\n');
      const server = serveSite(dir, outDir, 0); // 0 explícito -- debe ganar sobre wconfig.json
      await new Promise(resolve => server.on('listening', resolve));
      assert.notEqual(server.address().port, 9999);
      server.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('config: "stylesheets" de extremo a extremo -- Bootstrap por CDN, con SSG real', () => {
  test('el <link> aparece en el HTML compilado, y las clases sobreviven en la SSG', () => {
    const { buildSite } = require('../src/site-builder');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-css-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-css-out-'));
    try {
      fs.writeFileSync(path.join(dir, 'wconfig.json'), JSON.stringify({
        stylesheets: ['https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css'],
      }));
      fs.writeFileSync(path.join(dir, 'app.ws'), `route("/")

visual v =
<div class="container mt-5">
    <button class="btn btn-primary">Botón</button>
</div>

render(
    v
)
`);
      buildSite(dir, outDir);
      const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
      assert.match(html, /<link rel="stylesheet" href="https:\/\/cdn\.jsdelivr\.net\/npm\/bootstrap@5\.3\.3\/dist\/css\/bootstrap\.min\.css">/);
      assert.match(html, /class="container mt-5"/, 'las clases de Bootstrap deben sobrevivir en el HTML pre-renderizado (SSG)');
      assert.match(html, /class="btn btn-primary"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('sin stylesheets configuradas, el HTML sigue exactamente igual que siempre', () => {
    const { buildSite } = require('../src/site-builder');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-css2-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-css2-out-'));
    try {
      fs.writeFileSync(path.join(dir, 'app.ws'), 'route("/")\n\nvisual v =\n<p>x</p>\n\nrender(\n    v\n)\n');
      buildSite(dir, outDir);
      const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
      assert.doesNotMatch(html, /cdn\.jsdelivr|bootstrap/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('config: "ws-port" se conecta automáticamente vía serveSite() -- bug real encontrado y cerrado', () => {
  test('con ws-port en wconfig.json, una conexión WebSocket real funciona SIN pasar wsPort a mano', async () => {
    const { serveSite } = require('../src/site-builder');
    const { connectWs } = require('./helpers/ws-test-client');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-wsport-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-wsport-out-'));
    try {
      const wsPort = 49000 + Math.floor(Math.random() * 3000);
      fs.writeFileSync(path.join(dir, 'wconfig.json'), JSON.stringify({ 'ws-port': wsPort }));
      fs.writeFileSync(path.join(dir, 'chat.ws'), 'route("/chat")\n\nws function entradaWS(args)\n    return { eco: args.mensaje }\n');

      // Antes del arreglo, esto no conectaba nada -- serveSite() nunca leía "ws-port"
      // de la configuración, solo funcionaba si "wsPort" se pasaba a mano en options.
      const server = serveSite(dir, outDir, 0);
      await new Promise(resolve => server.on('listening', resolve));
      try {
        const client = await connectWs(wsPort, '/chat');
        const respuesta = await new Promise((resolve) => {
          client.onMessage(resolve);
          client.send({ mensaje: 'hola' });
        });
        assert.deepEqual(respuesta, { eco: 'hola' });
        client.close();
      } finally {
        server.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
