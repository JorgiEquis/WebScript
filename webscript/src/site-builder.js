const fs = require('fs');
const path = require('path');
const { parseProgram } = require('./parser');
const { compile, usesServerData } = require('./compiler');
const { renderRouteToHtml, injectIntoShell } = require('./ssr-renderer');

function findWsFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findWsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ws')) {
      results.push(full);
    }
  }
  return results;
}

// "/" -> "index" | "/ejemplo" -> "ejemplo" | "/blog/post" -> "blog/post"
function routeToBaseName(routePath) {
  if (routePath === '/') return 'index';
  return routePath.replace(/^\/+/, '').replace(/\/+$/, '');
}

// Descubre las rutas de un directorio: parsea cada .ws, junta los que declaran
// route(...) (los que no, se omiten -- piezas compartidas sin página propia, o
// pensadas solo para "import"), y valida que no haya dos archivos con la misma ruta.
function discoverRoutes(srcDir) {
  const files = findWsFiles(srcDir);
  const routes = [];
  const skipped = [];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const ast = parseProgram(source, path.resolve(file));
    const routeDecl = ast.body.find(n => n.type === 'RouteDecl');
    if (!routeDecl) {
      skipped.push(file);
      continue;
    }
    routes.push({ file, routePath: routeDecl.path, baseName: routeToBaseName(routeDecl.path), ast });
  }

  const seenRoutes = new Map();
  for (const r of routes) {
    if (seenRoutes.has(r.routePath)) {
      throw new SyntaxError(
        `Ruta duplicada "${r.routePath}": ya la declara "${seenRoutes.get(r.routePath)}", ` +
        `y también "${r.file}". Cada ruta debe declararse en un único archivo.`
      );
    }
    seenRoutes.set(r.routePath, r.file);
  }

  return { routes, skipped };
}

// Compila una lista de rutas ya descubiertas (o construidas a mano, ver
// buildSingleFileAsSite) a `outDir`. Es el paso común entre "site" (varias rutas,
// descubiertas escaneando un directorio) y un solo archivo servido en "/".
function compileRoutes(routes, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  const table = [];
  for (const r of routes) {
    const cssFilename = `${r.baseName}.css`;
    const jsFilename = `${r.baseName}.bundle.js`;
    const htmlFilename = `${r.baseName}.html`;
    const serverFilename = `${r.baseName}.server.js`;
    const dynamic = usesServerData(r.ast);
    const serverDataUrl = dynamic ? `/${r.baseName}.server-data.json` : null;
    const postFnNode = r.ast.body.find(n => n.type === 'PostFunctionDecl') || null;

    const { html, css, js, server } = compile(r.ast, {
      cssFilename, jsFilename, serverDataUrl, routePath: r.routePath,
    });

    // SSG: si la ruta NO es dinámica (no depende de server.X), se puede renderizar el
    // HTML real UNA vez, en tiempo de compilación, con los valores literales conocidos.
    // Si algo falla al evaluar (poco probable en una ruta sin server.X, pero por
    // seguridad), se sirve la concha vacía de siempre -- nunca queda peor que antes.
    let finalHtml = html;
    let ssgApplied = false;
    if (!dynamic) {
      const ssr = renderRouteToHtml(r.ast);
      if (ssr.ok) {
        finalHtml = injectIntoShell(html, ssr.html);
        ssgApplied = true;
      }
    }

    const htmlPath = path.join(outDir, htmlFilename);
    fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
    fs.writeFileSync(htmlPath, finalHtml);
    fs.writeFileSync(path.join(outDir, cssFilename), css);
    fs.writeFileSync(path.join(outDir, jsFilename), js);
    if (server) fs.writeFileSync(path.join(outDir, serverFilename), server);

    table.push({
      route: r.routePath,
      file: r.file,
      html: htmlFilename,
      hasServer: !!server,
      dynamic,
      serverDataUrl,
      baseName: r.baseName,
      postFnName: postFnNode ? postFnNode.name : null,
      ssgApplied,
      ast: r.ast,
    });
  }

  return table;
}

// Directorio con varias páginas (cada .ws declara su propio route(...)).
function buildSite(srcDir, outDir) {
  const { routes, skipped } = discoverRoutes(srcDir);
  const table = compileRoutes(routes, outDir);
  return { table, skipped };
}

// Un solo archivo, servido siempre en "/" -- ignora cualquier route(...) que declare
// (si la tiene) para que el comportamiento sea consistente con "build" de un archivo
// suelto: siempre produce index.html/styles.css/bundle.js en outDir.
function buildSingleFileAsSite(filePath, outDir) {
  const resolvedPath = path.resolve(filePath);
  const source = fs.readFileSync(resolvedPath, 'utf8');
  const ast = parseProgram(source, resolvedPath);
  const routes = [{ file: resolvedPath, routePath: '/', baseName: 'index', ast }];
  const table = compileRoutes(routes, outDir);
  return { table, skipped: [] };
}

// Servidor Node real (http nativo, sin dependencias) sobre una tabla de rutas YA
// compilada en `outDir`. Para las rutas "dinámicas" (usan server.NOMBRE) expone
// /<baseName>.server-data.json; para las que tienen "post function", despacha POST
// en la URL de la propia ruta.
//
// SESIONES: cada visitante recibe una cookie ("wsid") la primera vez que llega. El
// estado de servidor (server var) ya NO se comparte entre visitas -- cada sesión tiene
// su propia instancia, creada llamando a createSessionState() (ver compiler.js). No hay
// expiración ni límite de sesiones -- para un servidor de verdad en producción, esto
// necesitaría persistir a algo compartido (Redis, base de datos) en vez de memoria.
function startServer(table, outDir, port) {
  const http = require('http');
  const crypto = require('crypto');
  const rawModules = new Map(); // baseName -> require(<baseName>.server.js) (tiene createSessionState)
  const sessionStates = new Map(); // baseName -> Map<sessionId, instancia de createSessionState()>
  const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json' };

  function getRawModule(baseName) {
    // baseName SIEMPRE debe corresponder a una ruta conocida y compilada -- nunca se
    // resuelve a partir de un valor libre sacado de la URL (eso sería otra vía de
    // path traversal, ej. /../../../etc/passwd.server-data.json).
    if (!table.some(r => r.baseName === baseName)) {
      throw new Error(`"${baseName}" no corresponde a ninguna ruta conocida`);
    }
    if (!rawModules.has(baseName)) {
      const serverJsPath = path.resolve(path.join(outDir, `${baseName}.server.js`));
      rawModules.set(baseName, require(serverJsPath));
    }
    return rawModules.get(baseName);
  }

  function getSessionState(baseName, sessionId) {
    if (!sessionStates.has(baseName)) sessionStates.set(baseName, new Map());
    const perRoute = sessionStates.get(baseName);
    if (!perRoute.has(sessionId)) {
      perRoute.set(sessionId, getRawModule(baseName).createSessionState());
    }
    return perRoute.get(sessionId);
  }

  function parseCookies(header) {
    const out = {};
    (header || '').split(';').forEach(pair => {
      const idx = pair.indexOf('=');
      if (idx === -1) return;
      const key = pair.slice(0, idx).trim();
      if (key) out[key] = decodeURIComponent(pair.slice(idx + 1).trim());
    });
    return out;
  }

  // Lee la cookie "wsid" de la petición; si no existe, genera una nueva y la manda
  // en la respuesta. Devuelve el id de sesión que hay que usar para ESTA petición.
  function ensureSession(req, res) {
    const cookies = parseCookies(req.headers.cookie);
    let sid = cookies.wsid;
    if (!sid) {
      sid = crypto.randomUUID();
      res.setHeader('Set-Cookie', `wsid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
    }
    return sid;
  }

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const sessionId = ensureSession(req, res);

    const dataMatch = urlPath.match(/^\/(.+)\.server-data\.json$/);
    if (dataMatch) {
      const baseName = dataMatch[1];
      // Validar ANTES de construir ninguna ruta de archivo o llamar a require(): un
      // baseName no comprobado aquí podría escapar de outDir (path traversal) o, peor,
      // apuntar a un .server.js arbitrario del sistema que require() ejecutaría como
      // código -- no solo lectura de archivos, ejecución.
      if (!table.some(r => r.baseName === baseName)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `No hay server.js para "${baseName}"` }));
        return;
      }
      let state;
      try {
        state = getSessionState(baseName, sessionId);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Error interno cargando el servidor de "${baseName}": ${err.message}` }));
        return;
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          let updates;
          try {
            updates = JSON.parse(body || '{}');
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'JSON inválido en el body' }));
            return;
          }
          for (const key of Object.keys(updates)) {
            if (Object.prototype.hasOwnProperty.call(state, key)) {
              state[key] = updates[key];
            }
          }
          const data = {};
          for (const key of Object.keys(state)) data[key] = state[key];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        });
        return;
      }

      const data = {};
      for (const key of Object.keys(state)) data[key] = state[key];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    const route = table.find(r => r.route === urlPath || (urlPath === '/' && r.route === '/'));
    if (route) {
      if (req.method === 'POST') {
        if (!route.postFnName) {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `"${route.route}" no tiene ninguna "post function" definida` }));
          return;
        }
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          let args;
          try {
            args = JSON.parse(body || '{}');
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'JSON inválido en el body' }));
            return;
          }
          let state;
          try {
            state = getSessionState(route.baseName, sessionId);
          } catch (err) {
            // Un server.js roto (JS inválido, por ejemplo) no debe tumbar el proceso
            // entero -- solo esta petición falla, el servidor sigue en pie para todo
            // lo demás.
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Error interno cargando el servidor de "${route.route}": ${err.message}` }));
            return;
          }
          try {
            const result = state[route.postFnName](args);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result === undefined ? null : result));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      const shellHtml = fs.readFileSync(path.join(outDir, route.html), 'utf8');
      if (route.dynamic) {
        // SSR real: renderiza fresco en CADA petición, con los valores actuales de la
        // sesión de quien pide la página -- a diferencia de SSG (build-time), aquí sí
        // puede cambiar entre peticiones. Si falla al evaluar algo, se sirve la concha
        // vacía de siempre (el cliente la rellena vía fetch + JS, como ya hacía antes).
        const sessionState = (() => {
          try {
            return getSessionState(route.baseName, sessionId);
          } catch (err) {
            return null; // server.js roto -- se cae con seguridad a la concha vacía, abajo
          }
        })();
        if (sessionState) {
          const ssr = renderRouteToHtml(route.ast, { serverScope: sessionState });
          if (ssr.ok) {
            res.end(injectIntoShell(shellHtml, ssr.html));
            return;
          }
        }
      }
      res.end(shellHtml);
      return;
    }

    // Servir estáticos SOLO si el archivo resuelto sigue dentro de outDir -- sin esta
    // comprobación, "../../../etc/passwd" (o su versión codificada, %2e%2e%2f) escapa
    // de la carpeta servida. path.join() por sí solo NO protege de esto.
    const resolvedOutDir = path.resolve(outDir);
    const staticPath = path.resolve(path.join(outDir, urlPath));
    const isInsideOutDir = staticPath === resolvedOutDir || staticPath.startsWith(resolvedOutDir + path.sep);
    if (isInsideOutDir && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      const ext = path.extname(staticPath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(fs.readFileSync(staticPath));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 - no encontrado');
  });

  server.listen(port, () => {
    console.log(`Servidor en http://localhost:${port}`);
    table.forEach(r => {
      const tags = [];
      if (r.dynamic) tags.push(`GET dinámico -> ${r.serverDataUrl}`);
      if (r.postFnName) tags.push(`POST -> ${r.postFnName}(...)`);
      console.log(`  ${r.route}  ${tags.length ? '(' + tags.join(', ') + ')' : '(estática)'}`);
    });
  });

  return server;
}

// Conveniencia: descubre + compila + levanta servidor para un directorio, en un paso.
function serveSite(srcDir, outDir, port) {
  const { table } = buildSite(srcDir, outDir);
  return startServer(table, outDir, port);
}

module.exports = { buildSite, buildSingleFileAsSite, serveSite, startServer };
