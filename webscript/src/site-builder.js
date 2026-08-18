const fs = require('fs');
const path = require('path');
const { parseProgram } = require('./parser');
const { compile, usesServerData, usesQueryParams } = require('./compiler');
const { renderRouteToHtml, injectIntoShell } = require('./ssr-renderer');
const jsAnalyzer = require('./js-analyzer');
const { loadConfig } = require('./config');

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
// "/monedas/:id" -> "monedas/_id" -- ":" no es válido en nombres de archivo en todos
// los sistemas (Windows, en particular) -- se sanea a "_" para el nombre de archivo,
// sin afectar al patrón real de la ruta (routePath), que sigue siendo "/monedas/:id"
// tal cual para el emparejamiento de peticiones entrantes.
function routeToBaseName(routePath) {
  if (routePath === '/') return 'index';
  return routePath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/:/g, '_');
}

// Convierte un patrón de ruta ("/monedas/:id"/"/x") en un RegExp + la lista ordenada
// de nombres de parámetro que contiene ("id"). Se compila UNA SOLA VEZ por ruta, al
// arrancar el servidor -- no en cada petición, que sería recompilar la misma regex una
// y otra vez sin necesidad. Cada segmento que empieza por ":" se convierte en un grupo
// de captura que acepta cualquier cosa menos "/" (un solo segmento, no varios).
function compileRoutePattern(routePath) {
  const paramNames = [];
  const escaped = routePath
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${escaped}$`), paramNames };
}

// Encuentra en `table` la ruta que corresponde a `urlPath` -- primero por coincidencia
// EXACTA (más barato, y evita ambigüedad: una ruta literal "/monedas/nuevo" gana
// siempre sobre una dinámica "/monedas/:id", aunque la dinámica también encajaría),
// y solo si ninguna coincide exacta, se prueban los patrones con ":parámetro".
// Devuelve { route, params } o null si nada encaja.
function matchRoute(table, urlPath) {
  const exact = table.find((r) => r.route === urlPath);
  if (exact) return { route: exact, params: {} };

  for (const r of table) {
    if (!r.routePattern) continue; // ruta sin ":" -- ya se comprobó arriba, como exacta
    const m = r.routePattern.regex.exec(urlPath);
    if (m) {
      const params = {};
      r.routePattern.paramNames.forEach((name, idx) => { params[name] = decodeURIComponent(m[idx + 1]); });
      return { route: r, params };
    }
  }
  return null;
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

// Escribe el resultado de una get/post/put/delete function como respuesta HTTP real.
// Si el valor devuelto es el sobre especial que genera "respond(status, cuerpo)", usa
// ESE código de estado y ESE cuerpo; si no (el caso de siempre, sin cambios), responde
// 200 con el valor devuelto tal cual -- exactamente el comportamiento de antes de que
// existiera "respond()".
function writeHandlerResult(res, result) {
  if (result && typeof result === 'object' && result.__wsHttpResponse === true) {
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body === undefined ? null : result.body));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result === undefined ? null : result));
}

function compileRoutes(routes, outDir, wsonHistoryRoute = null, stylesheets = [], wsonReplayWindowMs = undefined) {
  fs.mkdirSync(outDir, { recursive: true });

  const table = [];
  for (const r of routes) {
    const hasRender = r.ast.body.some(n => n.type === 'RenderCall');
    const dynamic = usesServerData(r.ast);
    // query() -- a diferencia de server.X, no necesita ningún fetch async (la query
    // string ya está disponible de forma síncrona en el navegador), pero SÍ significa
    // que el HTML no se puede fijar una vez en tiempo de compilación (SSG) -- cambia en
    // cada petición, así que necesita renderizarse fresco cada vez, igual que una ruta
    // dinámica -- solo que sin el mecanismo de fetch de "server.X".
    const usesQuery = usesQueryParams(r.ast);
    const serverDataUrl = dynamic ? `/${r.baseName}.server-data.json` : null;
    const postFnNode = r.ast.body.find(n => n.type === 'PostFunctionDecl') || null;
    const putFnNode = r.ast.body.find(n => n.type === 'PutFunctionDecl') || null;
    const deleteFnNode = r.ast.body.find(n => n.type === 'DeleteFunctionDecl') || null;
    const getFnNode = r.ast.body.find(n => n.type === 'GetFunctionDecl') || null;
    const wsFnNode = r.ast.body.find(n => n.type === 'WsFunctionDecl') || null;
    const httpFnNames = {
      postFnName: postFnNode ? postFnNode.name : null,
      postFnParamCount: postFnNode ? countParams(postFnNode.params) : 0,
      putFnName: putFnNode ? putFnNode.name : null,
      putFnParamCount: putFnNode ? countParams(putFnNode.params) : 0,
      deleteFnName: deleteFnNode ? deleteFnNode.name : null,
      deleteFnParamCount: deleteFnNode ? countParams(deleteFnNode.params) : 0,
      getFnName: getFnNode ? getFnNode.name : null,
      getFnParamCount: getFnNode ? countParams(getFnNode.params) : 0,
      wsFnName: wsFnNode ? wsFnNode.name : null,
    };

    // Ruta "solo backend": sin render(), no hay página que servir -- ni HTML, ni CSS,
    // ni bundle.js. Se compila SOLO server.js (si hay algo de servidor), y la propia
    // URL de la ruta pasa a comportarse como un endpoint JSON: GET devuelve el estado
    // actual de sus "server var" (si tiene), POST/PUT/DELETE disparan la función del
    // verbo correspondiente (si tiene).
    if (!hasRender) {
      const { server } = compile(r.ast, {
        cssFilename: `${r.baseName}.css`, jsFilename: `${r.baseName}.bundle.js`,
        serverDataUrl, routePath: r.routePath, wsonHistoryRoute, wsonReplayWindowMs,
      });
      const serverFilename = `${r.baseName}.server.js`;
      if (server) {
        const serverPath = path.join(outDir, serverFilename);
        fs.mkdirSync(path.dirname(serverPath), { recursive: true });
        fs.writeFileSync(serverPath, server);
      }

      table.push({
        route: r.routePath,
        routePattern: r.routePath.includes(':') ? compileRoutePattern(r.routePath) : null,
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
      cssFilename, jsFilename, serverDataUrl, routePath: r.routePath, wsonHistoryRoute, stylesheets, wsonReplayWindowMs,
    });

    // SSG: si la ruta NO es dinámica (no depende de server.X) NI usa query() (que
    // cambia en cada petición, no se puede fijar de una vez), se puede renderizar el
    // HTML real UNA vez, en tiempo de compilación, con los valores literales conocidos.
    // Si algo falla al evaluar (poco probable en una ruta así, pero por seguridad), se
    // sirve la concha vacía de siempre -- nunca queda peor que antes.
    let finalHtml = html;
    let ssgApplied = false;
    if (!dynamic && !usesQuery) {
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
      routePattern: r.routePath.includes(':') ? compileRoutePattern(r.routePath) : null,
      file: r.file,
      html: htmlFilename,
      apiOnly: false,
      hasServer: !!server,
      dynamic,
      usesQuery,
      serverDataUrl,
      baseName: r.baseName,
      ...httpFnNames,
      ssgApplied,
      ast: r.ast,
    });
  }

  return table;
}

// Directorio con varias páginas (cada .ws declara su propio route(...)). Busca
// "wconfig.json" en el propio srcDir -- si no existe, se usan los valores por
// defecto de siempre (ver src/config.js). "allow-acorn" se aplica ANTES de compilar
// nada, para que afecte a todo el sitio de una vez.
function buildSite(srcDir, outDir) {
  const config = loadConfig(srcDir);
  jsAnalyzer.setAllowAcorn(config['allow-acorn']);
  const { routes, skipped } = discoverRoutes(srcDir);
  const table = compileRoutes(routes, outDir, config['wson-history-route'], config.stylesheets, config['wson-replay-window-ms']);
  return { table, skipped, config };
}

// Un solo archivo, servido siempre en "/" -- ignora cualquier route(...) que declare
// (si la tiene) para que el comportamiento sea consistente con "build" de un archivo
// suelto: siempre produce index.html/styles.css/bundle.js en outDir. El wconfig.json,
// si existe, se busca en el mismo directorio que el archivo.
function buildSingleFileAsSite(filePath, outDir) {
  const resolvedPath = path.resolve(filePath);
  const config = loadConfig(path.dirname(resolvedPath));
  jsAnalyzer.setAllowAcorn(config['allow-acorn']);
  const source = fs.readFileSync(resolvedPath, 'utf8');
  const ast = parseProgram(source, resolvedPath);
  const routes = [{ file: resolvedPath, routePath: '/', baseName: 'index', ast }];
  const table = compileRoutes(routes, outDir, config['wson-history-route'], config.stylesheets, config['wson-replay-window-ms']);
  return { table, skipped: [], config };
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
    rateLimitMax = 300, // peticiones permitidas por IP dentro de la ventana -- 0 desactiva el límite
    rateLimitWindowMs = 60 * 1000, // duración de la ventana (1 minuto por defecto)
  } = options;

  const http = require('http');
  const crypto = require('crypto');
  const rawModules = new Map(); // baseName -> require(<baseName>.server.js) (tiene createSessionState)
  // baseName -> Map<sessionId, { state, lastAccessed }> -- el timestamp es lo que
  // permite tanto expirar por inactividad como desalojar la más vieja al llegar al límite.
  const sessionStates = new Map();
  let totalSessions = 0;
  const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json' };

  // Secreto CSRF -- generado una vez por proceso, nunca expuesto directamente (solo un
  // HMAC derivado de él, ligado a cada sesión, sí se manda al cliente). Un reinicio del
  // proceso invalida los tokens vivos -- aceptable: el cliente simplemente vuelve a
  // pedir la página y recibe uno nuevo, no es un fallo de seguridad, solo fuerza a
  // renovar.
  const csrfSecret = crypto.randomBytes(32);
  // Token CSRF determinista a partir del id de sesión -- mismo id, mismo token,
  // siempre, sin necesitar guardar nada aparte (se puede volver a derivar en la
  // verificación, no hace falta buscarlo en ningún sitio).
  function deriveCsrfToken(sessionId) {
    return crypto.createHmac('sha256', csrfSecret).update(sessionId).digest('hex');
  }
  // Patrón "double-submit cookie": una cookie SIN HttpOnly (legible por JS, a
  // diferencia de "wsid") lleva el token -- el cliente la lee y la reenvía como
  // cabecera en cada POST/PUT/DELETE. Un atacante en otro origen puede conseguir que
  // el navegador de la víctima mande la cookie "wsid" automáticamente (ese es
  // precisamente el problema que es CSRF), pero NO puede leer el valor de "wcsrf"
  // (las cookies de un origen no son legibles por JS de otro origen) -- así que no
  // puede construir la cabecera que hace falta para que la petición se acepte.
  function ensureCsrfCookie(req, res, sessionId) {
    const cookies = parseCookies(req.headers.cookie);
    const expected = deriveCsrfToken(sessionId);
    if (cookies.wcsrf === expected) return; // ya la tiene, y es la correcta -- nada que hacer
    const isHttps = req.headers['x-forwarded-proto'] === 'https';
    const secureFlag = isHttps ? '; Secure' : '';
    const existing = res.getHeader('Set-Cookie');
    const wcsrfCookie = `wcsrf=${expected}; Path=/; SameSite=Lax${secureFlag}`;
    res.setHeader('Set-Cookie', existing ? [].concat(existing, wcsrfCookie) : wcsrfCookie);
  }
  // Verifica la cabecera "X-WebScript-CSRF" contra el token esperado de la sesión --
  // usada antes de ejecutar cualquier POST/PUT/DELETE. Comparación en tiempo
  // constante (mismo motivo que la firma de WSON): comparar tokens con "===" filtra
  // por temporización cuánto coincide el prefijo, dando a un atacante paciente una
  // forma de adivinarlo byte a byte.
  function verifyCsrf(req, sessionId) {
    const received = req.headers['x-webscript-csrf'];
    if (!received) return false;
    const expected = deriveCsrfToken(sessionId);
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  // Límite de tasa: ventana FIJA por IP -- cada IP tiene como mucho "rateLimitMax"
  // peticiones dentro de "rateLimitWindowMs"; al pasarse, se rechaza con 429 hasta
  // que la ventana se renueve. Deliberadamente simple (ventana fija, no una ventana
  // deslizante ni un "token bucket") -- suficiente para frenar abuso básico, sin la
  // complejidad de un algoritmo más fino que este proyecto no necesita todavía.
  // "rateLimitMax: 0" desactiva el límite por completo (para quien prefiera poner su
  // propio límite delante, en un proxy real).
  const rateLimitBuckets = new Map(); // ip -> { count, windowStart }
  function getClientIp(req) {
    // Detrás de un proxy real (nginx, etc.), la IP de socket es la del propio proxy,
    // no la del visitante -- se usa X-Forwarded-For si está presente, igual que ya se
    // hace para detectar HTTPS (x-forwarded-proto). Sin proxy, la del socket directo.
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress || 'desconocida';
  }
  function checkRateLimit(req) {
    if (!rateLimitMax || rateLimitMax <= 0) return true; // desactivado
    const ip = getClientIp(req);
    const now = Date.now();
    const bucket = rateLimitBuckets.get(ip);
    if (!bucket || now - bucket.windowStart >= rateLimitWindowMs) {
      rateLimitBuckets.set(ip, { count: 1, windowStart: now });
      return true;
    }
    bucket.count++;
    return bucket.count <= rateLimitMax;
  }
  // Barrido periódico: quita cualquier IP cuya ventana ya haya expirado -- para no
  // acumular memoria sin límite si pasan muchas IPs distintas por el servidor a lo
  // largo de su vida. "unref()" para no mantener vivo el proceso solo por esto.
  const rateLimitCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of rateLimitBuckets) {
      if (now - bucket.windowStart >= rateLimitWindowMs) rateLimitBuckets.delete(ip);
    }
  }, rateLimitWindowMs);
  rateLimitCleanupInterval.unref();

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
    const isNew = !sid;
    if (isNew) {
      sid = crypto.randomUUID();
      const isHttps = req.headers['x-forwarded-proto'] === 'https';
      const secureFlag = isHttps ? '; Secure' : '';
      res.setHeader('Set-Cookie', `wsid=${sid}; Path=/; HttpOnly; SameSite=Lax${secureFlag}`);
    }
    // Se comprueba SIEMPRE, no solo cuando la sesión es nueva -- cubre el caso de un
    // cliente que conserva "wsid" pero, por lo que sea, perdió o nunca llegó a tener
    // "wcsrf" (ej. la borró a mano, o un proxy intermedio se la comió).
    ensureCsrfCookie(req, res, sid);
    return { sid, isNew };
  }

  const server = http.createServer(async (req, res) => {
    // Límite de tasa: se comprueba ANTES de cualquier otra cosa (incluso antes de
    // asignar sesión) -- un cliente que se pasa del límite no debería ni siquiera
    // lograr crear sesiones nuevas sin parar, que sería otra forma de abuso.
    if (!checkRateLimit(req)) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(rateLimitWindowMs / 1000)) });
      res.end(JSON.stringify({ error: `Demasiadas peticiones -- límite de ${rateLimitMax} cada ${rateLimitWindowMs / 1000}s. Reintenta más tarde.` }));
      return;
    }
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const { sid: sessionId, isNew: isNewSession } = ensureSession(req, res);

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

    const matched = matchRoute(table, urlPath);
    if (matched) {
      const { route, params: routeParams } = matched;
      const VERB_TO_FN_NAME = { POST: 'postFnName', PUT: 'putFnName', DELETE: 'deleteFnName' };
      const VERB_TO_PARAM_COUNT = { POST: 'postFnParamCount', PUT: 'putFnParamCount', DELETE: 'deleteFnParamCount' };
      if (Object.prototype.hasOwnProperty.call(VERB_TO_FN_NAME, req.method)) {
        const fnName = route[VERB_TO_FN_NAME[req.method]];
        if (!fnName) {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `"${route.route}" no tiene ninguna función definida para ${req.method}` }));
          return;
        }
        // CSRF: toda escritura (POST/PUT/DELETE) exige la cabecera "X-WebScript-CSRF"
        // con el token de esta sesión -- ver ensureCsrfCookie()/verifyCsrf() para el
        // porqué (patrón "double-submit cookie"). El código de cliente generado
        // (postFnStub) ya la manda solo; una petición hecha a mano (curl, otro
        // servicio) necesita mandarla explícitamente, tras haber leído la cookie
        // "wcsrf" de una respuesta anterior del mismo servidor.
        //
        // EXCEPCIÓN deliberada: si esta petición es la que ACABA de crear la sesión
        // (sin ninguna cookie "wsid" previa), no hay ninguna sesión existente que un
        // atacante pudiera estar secuestrando -- CSRF explota una sesión YA
        // autenticada; una sesión recién creada, vacía, no tiene ningún estado de
        // valor que proteger todavía. Exigir el token también aquí solo forzaría a
        // cualquier cliente (incluido uno legítimo, sin navegador, como un móvil o
        // un script) a hacer una petición GET de "calentamiento" antes de poder
        // escribir nada, sin ganar protección real a cambio.
        if (!isNewSession && !verifyCsrf(req, sessionId)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Falta o es inválida la cabecera "X-WebScript-CSRF" -- toda petición ' +
              'que escribe (POST/PUT/DELETE) en una sesión existente necesita el token CSRF ' +
              'de esa sesión, mandado como esa cabecera. Visita la página primero (o cualquier ' +
              'GET a este servidor) para recibir la cookie "wcsrf", y manda su valor como esta cabecera.',
          }));
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
            // a otros sistemas y esperar su respuesta antes de devolver la suya). Los
            // parámetros de ruta (":id") van SIEMPRE como argumento adicional, al final,
            // sin importar cuántos parámetros nombrados declare la función -- la función
            // compilada los lee vía params(), no como un parámetro más que haya que
            // declarar a mano.
            const { query, headers } = extractQueryAndHeaders(req);
            const callArgs = [args, query, headers].slice(0, paramCount);
            const result = await state[fnName](...callArgs, routeParams);
            writeHandlerResult(res, result);
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
            const result = await state[route.getFnName](...callArgs, routeParams);
            writeHandlerResult(res, result);
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
      if (route.dynamic || route.usesQuery) {
        // SSR real: renderiza fresco en CADA petición -- con los valores actuales de la
        // sesión de quien pide la página (si usa server.X) y/o con la query string REAL
        // de esta petición concreta (si usa query()) -- a diferencia de SSG (build-time),
        // aquí sí puede cambiar entre peticiones. Si falla al evaluar algo, se sirve la
        // concha vacía de siempre (el cliente la rellena en el navegador, como ya hacía
        // antes). Sesión solo se busca si la ruta de verdad usa server.X -- una página
        // que solo use query() no necesita ninguna sesión, para no crear una de más sin
        // motivo en cada visita.
        const sessionState = route.dynamic
          ? (() => {
            try {
              return getSessionState(route.baseName, sessionId);
            } catch (err) {
              return null; // server.js roto -- se cae con seguridad a la concha vacía, abajo
            }
          })()
          : {};
        if (sessionState) {
          const queryString = req.url.includes('?') ? req.url.split('?')[1] : '';
          const queryParams = {};
          for (const [k, v] of new URLSearchParams(queryString)) queryParams[k] = v;
          const ssr = renderRouteToHtml(route.ast, { serverScope: sessionState, queryParams });
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
      if (r.wsFnName) tags.push(`WS -> ${r.wsFnName}(...)`);
      console.log(`  ${r.route}  ${tags.length ? '(' + tags.join(', ') + ')' : '(estática)'}`);
    });
  });

  server.on('close', () => {
    clearInterval(cleanupInterval);
    clearInterval(rateLimitCleanupInterval);
  });

  // Servidor WebSocket -- SOLO se levanta si de verdad hay al menos una "ws function"
  // en algún archivo y se pasó un "wsPort" (vía wconfig.json "ws-port" normalmente).
  // Puerto SEPARADO del HTTP normal, a propósito -- un http.Server normal no distingue
  // "petición HTTP normal" de "quiero pasar a WebSocket" salvo por la cabecera Upgrade,
  // y mezclar los dos casos en el MISMO listener complica el código sin necesidad real
  // aquí (WSON y las páginas normales siguen funcionando exactamente igual, en su
  // propio puerto, sin que este servidor WS interfiera para nada).
  const wsPort = options.wsPort;
  const hasAnyWsFn = table.some(r => r.wsFnName);
  let wsServer = null;
  // Limitación CONOCIDA de Node, no específica de este proyecto: http.Server.close()
  // solo deja de ACEPTAR conexiones nuevas -- NO cierra las que ya están abiertas. Con
  // una conexión WebSocket persistente todavía viva, .close() nunca terminaría de
  // cerrar el servidor, y el proceso se quedaría colgado esperando indefinidamente
  // (confirmado con un repro real antes de este arreglo). Se rastrean explícitamente
  // todos los sockets WS abiertos, para poder destruirlos a la fuerza al cerrar.
  const openWsSockets = new Set();
  if (wsPort && hasAnyWsFn) {
    const wsProtocol = require('./ws-protocol');

    wsServer = http.createServer((req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('Se esperaba una conexión WebSocket (cabecera "Upgrade: websocket"), no una petición HTTP normal.');
    });

    wsServer.on('upgrade', (req, socket, head) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const matched = matchRoute(table, urlPath);
      if (!matched || !matched.route.wsFnName) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      const clientKey = req.headers['sec-websocket-key'];
      if (!clientKey) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }
      const { route, params: routeParams } = matched;
      openWsSockets.add(socket);
      socket.on('close', () => openWsSockets.delete(socket));

      const acceptKey = wsProtocol.computeAcceptKey(clientKey);
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
      );

      // La sesión reutiliza el mismo mecanismo que las peticiones HTTP normales -- el
      // handshake ES una petición HTTP de verdad y puede llevar la cookie "wsid", así
      // que una conexión WS de un visitante ya conocido comparte su mismo estado
      // (server var/server reactive) con sus peticiones HTTP normales a la misma ruta.
      const cookies = parseCookies(req.headers.cookie);
      const sessionId = cookies.wsid || crypto.randomUUID();
      let sessionState;
      try {
        sessionState = getSessionState(route.baseName, sessionId);
      } catch (err) {
        socket.destroy();
        return;
      }

      let buffer = Buffer.alloc(0);
      socket.on('data', async (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        let frame;
        while ((frame = wsProtocol.decodeFrame(buffer)) !== null) {
          buffer = buffer.subarray(frame.bytesConsumed);
          if (frame.opcode === wsProtocol.OPCODE_CLOSE) {
            socket.end(wsProtocol.encodeCloseFrame(false));
            return;
          }
          if (frame.opcode !== wsProtocol.OPCODE_TEXT) continue; // ping/pong -- sin keepalive explícito por ahora
          let args;
          try {
            args = JSON.parse(frame.payload.toString('utf8'));
          } catch (e) {
            continue; // mensaje que no es JSON válido -- se ignora, no revienta la conexión entera
          }
          try {
            const result = await sessionState[route.wsFnName](args, { params: routeParams, headers: req.headers });
            if (result !== undefined) {
              socket.write(wsProtocol.encodeTextFrame(JSON.stringify(result), false));
            }
          } catch (err) {
            // Un error en la "ws function" (ej. tocar algo indefinido) no debe tumbar
            // la conexión -- se manda como mensaje de error, la conexión sigue viva
            // para el siguiente mensaje, mismo espíritu que el resto del proyecto (un
            // fallo puntual nunca debe tumbar más de lo estrictamente necesario).
            try { socket.write(wsProtocol.encodeTextFrame(JSON.stringify({ error: err.message }), false)); } catch (e) {}
          }
        }
      });

      socket.on('error', () => {}); // conexión cerrada abruptamente por el cliente -- no es un error del servidor
    });

    wsServer.listen(wsPort, () => {
      console.log(`WebSocket en ws://localhost:${wsPort}`);
    });
  }

  // Expuesto para tests/depuración -- no forma parte de la API pública normal.
  server._webscriptSessionDebug = {
    getTotalSessions: () => totalSessions,
    getSessionCount: (baseName) => (sessionStates.get(baseName) || new Map()).size,
    hasSession: (baseName, sessionId) => (sessionStates.get(baseName) || new Map()).has(sessionId),
  };
  server._wsServer = wsServer;
  if (wsServer) {
    const closeOriginal = server.close.bind(server);
    server.close = (cb) => {
      for (const socket of openWsSockets) socket.destroy();
      wsServer.close();
      return closeOriginal(cb);
    };
  }

  return server;
}

// Conveniencia: descubre + compila + levanta servidor para un directorio, en un paso.
// Precedencia del puerto: argumento explícito > "http-port" de wconfig.json > 3000.
// El puerto WebSocket ("ws-port" de wconfig.json) se pasa siempre que no se haya
// indicado ya explícitamente en "options" -- solo tiene efecto real si además hay al
// menos una "ws function" en el sitio (ver startServer).
function serveSite(srcDir, outDir, port, options = {}) {
  const { table, config } = buildSite(srcDir, outDir);
  const resolvedPort = (port === undefined || port === null) ? config['http-port'] : port;
  const resolvedOptions = {
    wsPort: config['ws-port'],
    rateLimitMax: config['rate-limit-max'],
    rateLimitWindowMs: config['rate-limit-window-ms'],
    ...options,
  };
  return startServer(table, outDir, resolvedPort, resolvedOptions);
}

// Hash determinista simple (variante de djb2) -- de un mismo string SIEMPRE sale el
// mismo índice, sin necesitar guardar ninguna tabla de "a qué worker mandé esta
// sesión la última vez". Suficiente aquí: el id de sesión ya es un UUID aleatorio
// bien distribuido, no hace falta un hash criptográfico para repartirlo parejo.
function hashToWorkerIndex(str, count) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash * 33) ^ str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % count;
}

// N procesos Node reales (cluster.fork()), cada uno un clon completo del sitio,
// escuchando en su propio puerto INTERNO (nunca expuesto directamente). Un proceso
// "frontal" escucha el puerto PÚBLICO y hace de proxy inverso: decide a qué worker
// reenviar cada petición según su cookie de sesión ("wsid") -- SESIONES PEGAJOSAS,
// no al azar ni por turnos: la MISMA sesión SIEMPRE llega al MISMO worker, para que
// su estado en memoria (server var/server reactive) sea consistente. Sin cookie
// todavía (primera visita), se reparte por turnos.
//
// Con "workerCount <= 1" no hay ningún proceso de más ni ningún proxy -- arranca
// exactamente igual que startServer() de siempre, sin ningún coste ni cambio de
// comportamiento para quien no pida clustering.
function startClusteredServer(srcTarget, outDir, publicPort, workerCount, options = {}) {
  if (!workerCount || workerCount <= 1) {
    const isDirectory = fs.statSync(srcTarget).isDirectory();
    const { table, config } = isDirectory ? buildSite(srcTarget, outDir) : buildSingleFileAsSite(srcTarget, outDir);
    const resolvedOptions = {
      wsPort: config['ws-port'],
      rateLimitMax: config['rate-limit-max'],
      rateLimitWindowMs: config['rate-limit-window-ms'],
      ...options,
    };
    return Promise.resolve(startServer(table, outDir, publicPort, resolvedOptions));
  }

  // "ws function" + cluster-workers > 1 juntos: NO soportado todavía -- el proxy
  // inverso del frontal (más abajo) solo retransmite peticiones HTTP normales, no
  // conexiones WebSocket. Se avisa explícitamente en vez de dejarlo fallar en
  // silencio (una conexión WS a este puerto simplemente no encontraría nada
  // escuchando, sin ninguna pista de por qué).
  const hasAnyWsFnCluster = (() => {
    try {
      const isDirectory = fs.statSync(srcTarget).isDirectory();
      const { routes } = isDirectory ? discoverRoutes(srcTarget) : { routes: [] };
      return routes.some(r => r.ast.body.some(n => n.type === 'WsFunctionDecl'));
    } catch (e) {
      return false;
    }
  })();
  if (hasAnyWsFnCluster) {
    console.warn(
      '⚠ Aviso: "ws function" + "cluster-workers" > 1 juntos no están soportados todavía -- ' +
      'el proxy del frontal solo reenvía peticiones HTTP normales, no conexiones WebSocket. ' +
      'Las conexiones WebSocket no funcionarán en este modo. Usa "cluster-workers": 1 si necesitas WebSocket.'
    );
  }

  const cluster = require('cluster');
  const http = require('http');
  cluster.setupPrimary({ exec: path.join(__dirname, 'cluster-worker.js') });

  const workers = [];
  const workerPorts = [];
  for (let i = 0; i < workerCount; i++) {
    const internalPort = publicPort + 1 + i; // puertos internos, nunca expuestos directamente
    const worker = cluster.fork({
      WS_CLUSTER_SRC_TARGET: srcTarget,
      WS_CLUSTER_OUT_DIR: outDir,
      WS_CLUSTER_INTERNAL_PORT: String(internalPort),
    });
    workers.push(worker);
    workerPorts.push(internalPort);
  }

  function parseWsidCookie(header) {
    if (!header) return null;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === 'wsid') return part.slice(eq + 1).trim();
    }
    return null;
  }

  // Extrae el valor de "wsid" de una cabecera Set-Cookie (puede venir como un solo
  // string o un array, según la versión de Node) -- para descubrir qué sesión NUEVA
  // acaba de crear un worker en su respuesta.
  function extractWsidFromSetCookie(setCookieHeader) {
    if (!setCookieHeader) return null;
    const values = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const v of values) {
      const m = /(?:^|;\s*)wsid=([^;]+)/.exec(v);
      if (m) return m[1];
    }
    return null;
  }

  let siguienteTurno = 0;
  // Tabla real de asignación sesión -> worker, construida sobre la marcha. Es
  // necesaria porque, para una sesión NUEVA (sin cookie todavía), el worker que la
  // atiende se elige por turnos -- el hash de la cookie que ESE worker genere después
  // no tiene ninguna relación con ese turno, así que confiar solo en el hash haría
  // que la segunda petición de una sesión cayera en un worker que nunca la vio (bug
  // real, encontrado y confirmado antes de este arreglo: la secuencia salía [1,1,2,3,4]
  // en vez de [1,2,3,4,5]). Con la tabla, se recuerda explícitamente qué worker creó
  // cada sesión, consultando el hash solo como respaldo si la tabla no tiene la
  // entrada (por ejemplo, si el frontal se reinició pero los workers no).
  const sessionToWorker = new Map();
  const MAX_SESSION_TABLE = 100000; // límite simple para no crecer sin freno en un proceso muy longevo

  return new Promise((resolve, reject) => {
    let listos = 0;
    const timeoutId = setTimeout(() => {
      reject(new Error(`startClusteredServer: los ${workerCount} workers no arrancaron a tiempo (10s).`));
    }, 10000);

    workers.forEach((w) => {
      w.on('message', (msg) => {
        if (!msg || msg.tipo !== 'listo') return;
        listos++;
        if (listos !== workerCount) return;
        clearTimeout(timeoutId);

        const frontal = http.createServer((req, res) => {
          const sid = parseWsidCookie(req.headers.cookie);
          let workerIndex;
          if (sid !== null && sessionToWorker.has(sid)) {
            workerIndex = sessionToWorker.get(sid);
          } else if (sid !== null) {
            // Cookie que el frontal no había visto (ej. reinició él, pero los workers
            // no) -- el hash es la mejor estimación posible sin la tabla.
            workerIndex = hashToWorkerIndex(sid, workerCount);
          } else {
            // Primera visita, sin cookie -- por turnos, cualquier worker vale para
            // crear una sesión nueva.
            workerIndex = siguienteTurno++ % workerCount;
          }
          const targetPort = workerPorts[workerIndex];

          const proxyReq = http.request(
            { hostname: 'localhost', port: targetPort, path: req.url, method: req.method, headers: req.headers },
            (proxyRes) => {
              // Si esta respuesta acaba de crear una sesión nueva, se registra AHORA
              // en la tabla, para que la SIGUIENTE petición de esa misma sesión
              // encuentre ya la asignación correcta, sin depender del hash.
              const nuevaSid = extractWsidFromSetCookie(proxyRes.headers['set-cookie']);
              if (nuevaSid && !sessionToWorker.has(nuevaSid)) {
                if (sessionToWorker.size >= MAX_SESSION_TABLE) {
                  sessionToWorker.delete(sessionToWorker.keys().next().value);
                }
                sessionToWorker.set(nuevaSid, workerIndex);
              }
              res.writeHead(proxyRes.statusCode, proxyRes.headers);
              proxyRes.pipe(res);
            }
          );
          proxyReq.on('error', (e) => {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `No se pudo contactar con el worker interno (puerto ${targetPort}): ${e.message}` }));
          });
          req.pipe(proxyReq);
        });

        frontal.listen(publicPort, () => {
          console.log(`Servidor en cluster: frontal en http://localhost:${publicPort} -- ${workerCount} workers (sesiones pegajosas por cookie)`);
          frontal._clusterWorkers = workers;
          frontal._clusterSessionToWorker = sessionToWorker; // expuesto para tests/depuración
          const closeOriginal = frontal.close.bind(frontal);
          frontal.close = (cb) => {
            workers.forEach((w) => w.kill());
            return closeOriginal(cb);
          };
          resolve(frontal);
        });
      });
    });
  });
}

module.exports = { buildSite, buildSingleFileAsSite, serveSite, startServer, startClusteredServer, hashToWorkerIndex };
