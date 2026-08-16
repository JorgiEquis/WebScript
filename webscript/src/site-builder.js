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
// Cuenta cuántos parámetros declara una función (post/put/delete/get) -- determina
// cuánto contexto extra recibe además del primero (body o query según el verbo):
// 1 = solo lo básico, 2 = +query (o +headers en get), 3 = +headers.
function countParams(paramsStr) {
  const trimmed = (paramsStr || '').trim();
  if (trimmed === '') return 0;
  return trimmed.split(',').map(s => s.trim()).filter(Boolean).length;
}

function compileRoutes(routes, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  const table = [];
  for (const r of routes) {
    const hasRender = r.ast.body.some(n => n.type === 'RenderCall');
    const dynamic = usesServerData(r.ast);
    const serverDataUrl = dynamic ? `/${r.baseName}.server-data.json` : null;
    const postFnNode = r.ast.body.find(n => n.type === 'PostFunctionDecl') || null;
    const putFnNode = r.ast.body.find(n => n.type === 'PutFunctionDecl') || null;
    const deleteFnNode = r.ast.body.find(n => n.type === 'DeleteFunctionDecl') || null;
    const getFnNode = r.ast.body.find(n => n.type === 'GetFunctionDecl') || null;
    const httpFnNames = {
      postFnName: postFnNode ? postFnNode.name : null,
      postFnParamCount: postFnNode ? countParams(postFnNode.params) : 0,
      putFnName: putFnNode ? putFnNode.name : null,
      putFnParamCount: putFnNode ? countParams(putFnNode.params) : 0,
      deleteFnName: deleteFnNode ? deleteFnNode.name : null,
      deleteFnParamCount: deleteFnNode ? countParams(deleteFnNode.params) : 0,
      getFnName: getFnNode ? getFnNode.name : null,
      getFnParamCount: getFnNode ? countParams(getFnNode.params) : 0,
    };

    // Ruta "solo backend": sin render(), no hay página que servir -- ni HTML, ni CSS,
    // ni bundle.js. Se compila SOLO server.js (si hay algo de servidor), y la propia
    // URL de la ruta pasa a comportarse como un endpoint JSON: GET devuelve el estado
    // actual de sus "server var" (si tiene), POST/PUT/DELETE disparan la función del
    // verbo correspondiente (si tiene).
    if (!hasRender) {
      const { server } = compile(r.ast, {
        cssFilename: `${r.baseName}.css`, jsFilename: `${r.baseName}.bundle.js`,
        serverDataUrl, routePath: r.routePath,
      });
      const serverFilename = `${r.baseName}.server.js`;
      if (server) {
        const serverPath = path.join(outDir, serverFilename);
        fs.mkdirSync(path.dirname(serverPath), { recursive: true });
        fs.writeFileSync(serverPath, server);
      }

      table.push({
        route: r.routePath,
        file: r.file,
        html: null,
        apiOnly: true,
        hasServer: !!server,
        dynamic,
        serverDataUrl,
        baseName: r.baseName,
        ...httpFnNames,
        ssgApplied: false,
        ast: r.ast,
      });
      continue;
    }

    const cssFilename = `${r.baseName}.css`;
    const jsFilename = `${r.baseName}.bundle.js`;
    const htmlFilename = `${r.baseName}.html`;
    const serverFilename = `${r.baseName}.server.js`;

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
      apiOnly: false,
      hasServer: !!server,
      dynamic,
      serverDataUrl,
      baseName: r.baseName,
      ...httpFnNames,
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
// su propia instancia, creada llamando a createSessionState() (ver compiler.js).
//
// Expiran por inactividad (TTL) y hay un límite máximo de sesiones simultáneas (con
// desalojo LRU -- se libera primero la que lleva más tiempo sin usarse) -- las dos
// limitaciones reales que sí se pueden arreglar sin depender de nada externo. Lo que
// SIGUE sin resolver, a propósito: compartir este estado entre varias instancias del
// proceso Node (para escalar horizontalmente) necesitaría un almacén compartido real
// (Redis, base de datos) -- no hay forma de montar ni probar eso de verdad en este
// entorno, sin acceso a red. Documentado como limitación conocida, no resuelto aquí.
function startServer(table, outDir, port, options = {}) {
  const {
    sessionTtlMs = 30 * 60 * 1000, // 30 minutos de inactividad -> expira
    maxSessions = 10000, // por encima de esto, se desaloja la menos usada recientemente (LRU)
    sessionCleanupIntervalMs = 60 * 1000, // cada cuánto se barre en busca de sesiones caducadas
  } = options;

  const http = require('http');
  const crypto = require('crypto');
  const rawModules = new Map(); // baseName -> require(<baseName>.server.js) (tiene createSessionState)
  // baseName -> Map<sessionId, { state, lastAccessed }> -- el timestamp es lo que
  // permite tanto expirar por inactividad como desalojar la más vieja al llegar al límite.
  const sessionStates = new Map();
  let totalSessions = 0;
  const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json' };

  // Elimina la sesión menos usada recientemente, de TODAS las rutas -- se llama cuando
  // se alcanza "maxSessions", antes de crear una sesión nueva, para no crecer sin límite.
  function evictLeastRecentlyUsed() {
    let oldestBaseName = null;
    let oldestSessionId = null;
    let oldestTime = Infinity;
    for (const [baseName, perRoute] of sessionStates) {
      for (const [sessionId, entry] of perRoute) {
        if (entry.lastAccessed < oldestTime) {
          oldestTime = entry.lastAccessed;
          oldestBaseName = baseName;
          oldestSessionId = sessionId;
        }
      }
    }
    if (oldestBaseName !== null) {
      sessionStates.get(oldestBaseName).delete(oldestSessionId);
      totalSessions--;
    }
  }

  // Barrido periódico: quita cualquier sesión que lleve más de "sessionTtlMs" sin
  // usarse. Con "unref()" para no mantener vivo el proceso por sí solo (así un test
  // puede terminar limpio sin tener que esperar a este timer) -- y se limpia también
  // explícitamente en el evento "close" del servidor, más abajo, por si acaso.
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const perRoute of sessionStates.values()) {
      for (const [sessionId, entry] of perRoute) {
        if (now - entry.lastAccessed > sessionTtlMs) {
          perRoute.delete(sessionId);
          totalSessions--;
        }
      }
    }
  }, sessionCleanupIntervalMs);
  cleanupInterval.unref();

  // Extrae query string y cabeceras de una petición, para las funciones
  // get/post/put/delete que declaren más de un parámetro (ver README).
  function extractQueryAndHeaders(req) {
    const queryString = req.url.includes('?') ? req.url.split('?')[1] : '';
    const query = {};
    for (const [k, v] of new URLSearchParams(queryString)) query[k] = v;
    return { query, headers: { ...req.headers } };
  }

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
      if (totalSessions >= maxSessions) evictLeastRecentlyUsed();
      perRoute.set(sessionId, { state: getRawModule(baseName).createSessionState(), lastAccessed: Date.now() });
      totalSessions++;
    } else {
      perRoute.get(sessionId).lastAccessed = Date.now();
    }
    return perRoute.get(sessionId).state;
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
  //
  // "Secure" (exige HTTPS para que el navegador la mande de vuelta) se añade SOLO si
  // hay indicios reales de que la conexión llegó por HTTPS -- nuestro propio servidor
  // nunca hace terminación TLS (es http.createServer plano), así que el único caso
  // real es estar detrás de un proxy que sí la termina (nginx, Caddy, un balanceador
  // de carga...) y manda la cabecera estándar "X-Forwarded-Proto: https". Sin eso,
  // añadir "Secure" a ciegas rompería cualquier desarrollo local por HTTP normal (el
  // navegador simplemente descartaría la cookie, silenciosamente).
  function ensureSession(req, res) {
    const cookies = parseCookies(req.headers.cookie);
    let sid = cookies.wsid;
    if (!sid) {
      sid = crypto.randomUUID();
      const isHttps = req.headers['x-forwarded-proto'] === 'https';
      const secureFlag = isHttps ? '; Secure' : '';
      res.setHeader('Set-Cookie', `wsid=${sid}; Path=/; HttpOnly; SameSite=Lax${secureFlag}`);
    }
    return sid;
  }

  const server = http.createServer(async (req, res) => {
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

      // Este endpoint es SOLO de lectura -- el "updateServer" que aceptaba POST aquí se
      // unificó con "post function" (ver README). Escribir se hace vía POST a la URL
      // de la propia ruta, despachado más abajo, nunca aquí.
      if (req.method === 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Este endpoint es solo de lectura -- usa una "post function" para escribir' }));
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
      const VERB_TO_FN_NAME = { POST: 'postFnName', PUT: 'putFnName', DELETE: 'deleteFnName' };
      const VERB_TO_PARAM_COUNT = { POST: 'postFnParamCount', PUT: 'putFnParamCount', DELETE: 'deleteFnParamCount' };
      if (Object.prototype.hasOwnProperty.call(VERB_TO_FN_NAME, req.method)) {
        const fnName = route[VERB_TO_FN_NAME[req.method]];
        if (!fnName) {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `"${route.route}" no tiene ninguna función definida para ${req.method}` }));
          return;
        }
        const paramCount = route[VERB_TO_PARAM_COUNT[req.method]] || 1;
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
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
            // 1 parámetro = solo el body (como siempre); 2 = +query string; 3 = +headers.
            // "await" porque las funciones ahora son async (pueden llamar a fetch/http.*
            // a otros sistemas y esperar su respuesta antes de devolver la suya).
            const { query, headers } = extractQueryAndHeaders(req);
            const callArgs = [args, query, headers].slice(0, paramCount);
            const result = await state[fnName](...callArgs);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result === undefined ? null : result));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // GET en una ruta "solo backend" (sin render()): no hay página que servir --
      // la propia URL responde como un endpoint de datos, igual que
      // /<ruta>.server-data.json pero en la URL "natural" de la ruta.
      if (route.apiOnly) {
        // "get function", si existe, sustituye el volcado por defecto de las server
        // var -- útil para calcular algo en vez de solo exponer el estado tal cual.
        // Su primer parámetro es la QUERY STRING (?a=1&b=2), no un body -- un GET no
        // lleva cuerpo por convención, y fetch() con GET tampoco permite mandarlo.
        // Con 2 parámetros, el segundo son las cabeceras de la petición.
        if (route.getFnName) {
          const { query, headers } = extractQueryAndHeaders(req);
          const callArgs = [query, headers].slice(0, route.getFnParamCount || 1);

          let state;
          try {
            state = getSessionState(route.baseName, sessionId);
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Error interno cargando el servidor de "${route.route}": ${err.message}` }));
            return;
          }
          try {
            const result = await state[route.getFnName](...callArgs);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result === undefined ? null : result));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        if (!route.hasServer) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({}));
          return;
        }
        let state;
        try {
          state = getSessionState(route.baseName, sessionId);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Error interno cargando el servidor de "${route.route}": ${err.message}` }));
          return;
        }
        const data = {};
        for (const key of Object.keys(state)) data[key] = state[key];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
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
      if (r.apiOnly) tags.push('solo backend, sin página');
      if (r.dynamic) tags.push(`GET dinámico -> ${r.serverDataUrl}`);
      if (r.getFnName) tags.push(`GET -> ${r.getFnName}(...)`);
      if (r.postFnName) tags.push(`POST -> ${r.postFnName}(...)`);
      if (r.putFnName) tags.push(`PUT -> ${r.putFnName}(...)`);
      if (r.deleteFnName) tags.push(`DELETE -> ${r.deleteFnName}(...)`);
      console.log(`  ${r.route}  ${tags.length ? '(' + tags.join(', ') + ')' : '(estática)'}`);
    });
  });

  server.on('close', () => clearInterval(cleanupInterval));

  // Expuesto para tests/depuración -- no forma parte de la API pública normal.
  server._webscriptSessionDebug = {
    getTotalSessions: () => totalSessions,
    getSessionCount: (baseName) => (sessionStates.get(baseName) || new Map()).size,
    hasSession: (baseName, sessionId) => (sessionStates.get(baseName) || new Map()).has(sessionId),
  };

  return server;
}

// Conveniencia: descubre + compila + levanta servidor para un directorio, en un paso.
function serveSite(srcDir, outDir, port, options) {
  const { table } = buildSite(srcDir, outDir);
  return startServer(table, outDir, port, options);
}

module.exports = { buildSite, buildSingleFileAsSite, serveSite, startServer };
