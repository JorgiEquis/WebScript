const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseProgram } = require('../src/parser');
const { renderRouteToHtml, injectIntoShell, escapeHtml } = require('../src/ssr-renderer');
const { buildSite, startServer } = require('../src/site-builder');

function ast(src) {
  return parseProgram(src, path.join(os.tmpdir(), '__ssr_test__.ws'));
}

describe('ssr-renderer: renderizado básico', () => {
  test('interpolación, if/else y for se resuelven a HTML real', () => {
    const src = `
reactive nombre = "Jorge"
reactive contador = 3
reactive lista = ["a", "b", "c"]

visual test =
<div>
    <p>Hola {nombre}</p>
    if (contador > 2)
        <p>alto</p>
    else
        <p>bajo</p>
    <ul>
        for (item in lista)
            <li>{item}</li>
    </ul>
</div>

render(
    test
)
`;
    const r = renderRouteToHtml(ast(src));
    assert.equal(r.ok, true);
    assert.equal(r.html, '<div><p>Hola Jorge</p><p>alto</p><ul><li>a</li><li>b</li><li>c</li></ul></div>');
  });

  test('valores interpolados se escapan (XSS)', () => {
    const src = `
reactive nombre = '<script>alert(1)</script>'

visual test =
<p>{nombre}</p>

render(
    test
)
`;
    const r = renderRouteToHtml(ast(src));
    assert.equal(r.ok, true);
    assert.ok(!r.html.includes('<script>'), 'no debe contener un <script> real sin escapar');
    assert.match(r.html, /&lt;script&gt;/);
  });

  test('expresión no evaluable en Node (document/window) -> fallback seguro, no crash', () => {
    const src = `
reactive x = document.title

visual test =
<p>{x}</p>

render(
    test
)
`;
    const r = renderRouteToHtml(ast(src));
    assert.equal(r.ok, false);
    assert.equal(r.html, '');
  });

  test('composición de visuales (props) se renderiza recursivamente', () => {
    const src = `
visual hijo =
<p>{props.texto}</p>

visual test =
<div>
    <hijo texto="hola" />
</div>

render(
    test
)
`;
    const r = renderRouteToHtml(ast(src));
    assert.equal(r.ok, true);
    assert.equal(r.html, '<div><p>hola</p></div>');
  });

  test('<slot/> inserta el contenido pasado por el padre', () => {
    const src = `
reactive titulo = "Panel"

visual panel =
<div>
    <h3>{props.titulo}</h3>
    <slot />
</div>

visual boton =
<button>
    +1
</button>

visual pagina =
<panel titulo="{titulo}">
    <boton />
    <p>extra</p>
</panel>

render(
    pagina
)
`;
    const r = renderRouteToHtml(ast(src));
    assert.equal(r.ok, true);
    assert.equal(r.html, '<div><h3>Panel</h3><button>+1</button><p>extra</p></div>');
  });

  test('el contenido de un slot se evalúa en el scope del PADRE, no del hijo', () => {
    const src = `
reactive contador = 7

visual tarjeta =
<div>
    <slot />
</div>

visual pagina =
<tarjeta>
    <p>Contador: {contador}</p>
</tarjeta>

render(
    pagina
)
`;
    const r = renderRouteToHtml(ast(src));
    assert.equal(r.ok, true);
    assert.equal(r.html, '<div><p>Contador: 7</p></div>');
  });

  test('server.NOMBRE usa el serverScope pasado como opción', () => {
    const src = `
server var visitas = 999

reactive contadorCliente = server.visitas

visual test =
<p>{contadorCliente}</p>

render(
    test
)
`;
    const r = renderRouteToHtml(ast(src), { serverScope: { visitas: 42 } });
    assert.equal(r.ok, true);
    assert.equal(r.html, '<p>42</p>');
  });

  test('injectIntoShell inserta en el marcador exacto de compileHTML()', () => {
    const shell = '<html><body><div id="app"></div></body></html>';
    const out = injectIntoShell(shell, '<p>x</p>');
    assert.equal(out, '<html><body><div id="app"><p>x</p></div></body></html>');
  });

  test('escapeHtml escapa los cinco caracteres peligrosos', () => {
    assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('SSG: build-time para rutas estáticas', () => {
  test('build de un archivo suelto incluye el HTML ya renderizado', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ssg-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ssg-out-'));
    const wsPath = path.join(dir, 'pagina.ws');
    fs.writeFileSync(wsPath, `
route("/")

reactive contador = 5

visual test =
<p>Contador: {contador}</p>

render(
    test
)
`);
    const { table } = buildSite(dir, outDir);
    const html = fs.readFileSync(path.join(outDir, table[0].html), 'utf8');
    assert.match(html, /<p>Contador: 5<\/p>/);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });
});

describe('SSR: en vivo, por petición, para rutas dinámicas', () => {
  test('GET trae contenido real (no la concha vacía) con el valor actual de sesión', async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ssr-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ssr-out-'));
    fs.writeFileSync(path.join(srcDir, 'pagina.ws'), `
route("/dinamica")

server var visitas = 100

reactive contadorCliente = server.visitas

visual test =
<h1>Visitas: {contadorCliente}</h1>

render(
    test
)
`);
    const { table } = buildSite(srcDir, outDir);
    const server = startServer(table, outDir, 0);
    await new Promise(resolve => server.on('listening', resolve));
    const port = server.address().port;

    try {
      const r1 = await fetch(`http://localhost:${port}/dinamica`);
      const html1 = await r1.text();
      assert.match(html1, /<h1>Visitas: 100<\/h1>/, 'primera visita: valor inicial de verdad, no concha vacía');
      const cookie = r1.headers.get('set-cookie').split(';')[0];

      await fetch(`http://localhost:${port}/dinamica.server-data.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ visitas: 250 }),
      });

      const r2 = await fetch(`http://localhost:${port}/dinamica`, { headers: { Cookie: cookie } });
      const html2 = await r2.text();
      assert.match(html2, /<h1>Visitas: 250<\/h1>/, 'segunda visita (misma sesión): valor actualizado, renderizado fresco');
    } finally {
      server.close();
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
