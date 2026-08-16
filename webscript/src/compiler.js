const fs = require('fs');
const path = require('path');
const jsAnalyzer = require('./js-analyzer');

function compile(ast, options = {}) {
  const { cssFilename = 'styles.css', jsFilename = 'bundle.js', serverDataUrl = null, routePath = null } = options;

  const reactives = ast.body.filter(n => n.type === 'ReactiveDecl');
  const globalVars = ast.body.filter(n => n.type === 'VarDecl');
  const functions = ast.body.filter(n => n.type === 'FunctionDecl');
  const wsons = ast.body.filter(n => n.type === 'WsonDecl');
  const styles = ast.body.filter(n => n.type === 'StyleDecl');
  const visuals = ast.body.filter(n => n.type === 'VisualDecl');
  const renderCall = ast.body.find(n => n.type === 'RenderCall');
  const serverVars = ast.body.filter(n => n.type === 'ServerVarDecl');
  const serverReactives = ast.body.filter(n => n.type === 'ServerReactiveDecl');
  const watchDecls = ast.body.filter(n => n.type === 'WatchDecl');
  const serverFunctions = ast.body.filter(n => n.type === 'ServerFunctionDecl');
  const serverWsons = ast.body.filter(n => n.type === 'ServerWsonDecl');
  const postFn = ast.body.find(n => n.type === 'PostFunctionDecl') || null;
  const putFn = ast.body.find(n => n.type === 'PutFunctionDecl') || null;
  const deleteFn = ast.body.find(n => n.type === 'DeleteFunctionDecl') || null;
  const getFn = ast.body.find(n => n.type === 'GetFunctionDecl') || null;
  // "get" NO se incluye aquí -- compileJS solo genera stubs de cliente para
  // post/put/delete. Una "get function" solo existe en rutas sin render() (validado
  // aparte), que nunca generan bundle.js -- no hay ningún cliente que pudiera llamarla,
  // y GET con fetch() tampoco admite mandar un body como sí hacen los otros tres.
  const httpFns = { post: postFn, put: putFn, delete: deleteFn };
  const serverHttpFns = { ...httpFns, get: getFn };

  const globalNames = reactives.map(r => r.name);
  const visualNames = new Set(visuals.map(v => v.name));

  const css = compileCSS(styles);
  const js = compileJS(reactives, globalVars, functions, wsons, visuals, renderCall, globalNames, visualNames, serverDataUrl, httpFns, routePath, styles.map(s => s.name));
  const html = compileHTML(cssFilename, jsFilename);
  const server = compileServerJS(serverVars, serverFunctions, serverHttpFns, serverReactives, watchDecls, serverWsons);

  return { html, css, js, server };
}

// ¿Este archivo lee algún valor de servidor vía "server.NOMBRE" en algún sitio
// (reactive/var globales, locales de un visual, plantillas, bindings)? Si sí, el bundle
// de cliente necesita hacer un fetch de datos antes de montar nada.
function usesServerData(ast) {
  const exprs = [];
  for (const n of ast.body) {
    if (n.type === 'ReactiveDecl' || n.type === 'VarDecl') exprs.push(n.init);
    if (n.type === 'FunctionDecl') exprs.push(n.body);
    if (n.type === 'WsonDecl') { for (const f of n.fields) exprs.push(f.value); }
    if (n.type === 'VisualDecl') {
      for (const r of n.localReactives) exprs.push(r.init);
      for (const v of n.localVars) exprs.push(v.init);
      collectAllTemplateExprs(n.template, exprs);
    }
  }
  return exprs.some(e => /\bserver\.[A-Za-z_$][\w$]*/.test(e));
}

function collectAllTemplateExprs(node, exprs) {
  if (!node) return;
  if (node.type === 'interpolation') { exprs.push(node.expr); return; }
  if (node.type === 'text') return;
  if (node.type === 'if') {
    node.branches.forEach(b => { exprs.push(b.condition); b.body.forEach(n => collectAllTemplateExprs(n, exprs)); });
    if (node.elseBody) node.elseBody.forEach(n => collectAllTemplateExprs(n, exprs));
    return;
  }
  if (node.type === 'for') {
    exprs.push(node.iterable); if (node.keyExpr) exprs.push(node.keyExpr);
    node.body.forEach(n => collectAllTemplateExprs(n, exprs));
    return;
  }
  if (node.type === 'element') {
    for (const v of Object.values(node.attrs || {})) {
      if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) exprs.push(v.slice(1, -1));
    }
    (node.children || []).forEach(c => collectAllTemplateExprs(c, exprs));
  }
}

// -------- server.js: SOLO variables de servidor, nunca llega al cliente --------
// Todo va dentro de createSessionState() -- una función FÁBRICA, no variables sueltas
// a nivel de módulo. Cada sesión (identificada por cookie en el servidor HTTP) llama a
// createSessionState() UNA vez y se queda con su propia instancia -- así dos visitantes
// nunca comparten el mismo "let totalConIva", cada uno tiene la suya.
function compileServerJS(serverVars, serverFunctions = [], httpFns = {}, serverReactives = [], watchDecls = [], serverWsons = []) {
  const { post: postFn = null, put: putFn = null, delete: deleteFn = null, get: getFn = null } = httpFns;
  const allHttpFns = [
    ['get', 'GET', getFn],
    ['post', 'POST', postFn],
    ['put', 'PUT', putFn],
    ['delete', 'DELETE', deleteFn],
  ].filter(([, , fn]) => fn);

  if (serverVars.length === 0 && serverFunctions.length === 0 && allHttpFns.length === 0 && serverReactives.length === 0 && serverWsons.length === 0) return null;

  const serverReactiveNames = serverReactives.map(d => d.name);

  // Sustituye referencias sueltas a nombres "server reactive" por acceso a través del
  // Proxy __serverReactive -- necesario para que asignarlas (x = ...) dispare los
  // watch() registrados. Las "server var" normales NO se tocan -- siguen siendo
  // variables "let" normales, nadie las observa, no necesitan Proxy.
  function substituteReactiveRefs(body) {
    if (serverReactiveNames.length === 0) return body;
    return injectVars(body, serverReactiveNames, '__serverReactive');
  }

  const inner = [];
  for (const v of serverVars) {
    inner.push(`  let ${v.name} = ${v.init}; // server var`);
  }

  if (serverWsons.length > 0) {
    inner.push('', '  // wson -- estructura de datos para describir un mensaje saliente (from/to/via/content). Declararla NO envía nada -- hace falta llamar a WSON.send(NOMBRE) explícitamente.');
    for (const w of serverWsons) {
      const objLit = w.fields.map(f => `${f.key}: ${substituteReactiveRefs(f.value)}`).join(', ');
      inner.push(`  let ${w.name} = { ${objLit} }; // server wson`);
    }
  }

  if (serverReactiveNames.length > 0) {
    inner.push(
      '',
      '  // server reactive -- observables con watch(). Proxy: asignar dispara los',
      '  // watchers registrados para esa variable (NUNCA con el valor inicial, solo en',
      '  // cambios posteriores -- a diferencia de un "effect" del cliente).',
      `  const __watchers = { ${serverReactiveNames.map(n => `${n}: []`).join(', ')} };`,
      `  const __serverReactive = new Proxy({ ${serverReactives.map(r => `${r.name}: ${r.init}`).join(', ')} }, {`,
      '    set(target, key, value) {',
      '      target[key] = value;',
      '      if (__watchers[key]) __watchers[key].slice().forEach((fn) => fn());',
      '      return true;',
      '    },',
      '  });'
    );
  }

  for (const fn of serverFunctions) {
    inner.push(
      '',
      fn.isAsync
        ? `  // server function ASYNC -- puede usar "await" dentro (fetch/http.*/otra dependencia`
        : `  // server function -- NO se expone al cliente ni tiene endpoint propio. Síncrona`,
      fn.isAsync
        ? `  // asíncrona de Node). Quien la llame debe usar "await" también, o recibirá una`
        : `  // (no puede usar "await" dentro) -- si necesitas eso, declárala "async server function".`,
      fn.isAsync ? `  // Promise en vez del valor real.` : `  // No se expone al cliente ni tiene endpoint propio.`,
      `  ${fn.isAsync ? 'async ' : ''}function ${fn.name}(${fn.params}) {`,
      ...substituteReactiveRefs(fn.body).split('\n').map(l => `    ${l}`),
      `  }`
    );
  }
  for (const [verb, method, fn] of allHttpFns) {
    inner.push(
      '',
      `  // ${verb} function -- corre cuando llega un ${method} a la URL de la propia ruta.`,
      `  // Async: puede hacer "await" a fetch()/http.* para llamar a otros sistemas y esperar`,
      `  // su respuesta antes de devolver la suya.`,
      `  async function ${fn.name}(${fn.params}) {`,
      ...substituteReactiveRefs(fn.body).split('\n').map(l => `    ${l}`),
      `  }`
    );
  }

  for (const w of watchDecls) {
    inner.push(
      '',
      `  // watch(${w.name}) -- corre SOLO en cambios posteriores de "${w.name}", nunca con`,
      `  // el valor inicial. Se dispara sin importar cuál get/post/put/delete function fue`,
      `  // la que cambió la variable. Siempre async (puede usar "await" dentro sin necesitar`,
      `  // ningún prefijo especial) -- nada captura su valor de retorno, así que hacerla`,
      `  // async no rompe ningún patrón existente, a diferencia de "function"/"server function".`,
      `  __watchers.${w.name}.push(async () => {`,
      ...substituteReactiveRefs(w.body).split('\n').map(l => `    ${l}`),
      `  });`
    );
  }

  inner.push(
    '',
    '  return {',
    ...serverVars.map(v => `    get ${v.name}() { return ${v.name}; },\n    set ${v.name}(v) { ${v.name} = v; },`),
    ...serverReactives.map(r => `    get ${r.name}() { return __serverReactive.${r.name}; },\n    set ${r.name}(v) { __serverReactive.${r.name} = v; },`),
    ...allHttpFns.map(([, , fn]) => `    ${fn.name},`),
    '  };'
  );

  // Detecta si algún cuerpo (server function, las cuatro HTTP, o los watch) usa "http.",
  // "whisper(", o "WSON.send("/"WSON.verify("/"WSON.showContent("/"WSON.parse("/
  // "WSON.history(" -- solo se incluye la definición si de verdad se usa, igual que con
  // los stubs de cliente. Cualquiera de los WSON.* también activa "http" aunque el
  // código del usuario no escriba "http." en ningún sitio -- lo usan por dentro.
  const allBodies = [...serverFunctions, ...allHttpFns.map(([, , fn]) => fn), ...watchDecls].map(fn => fn.body);
  const usesWson = allBodies.some(body => /\bWSON\.(send|enqueue|verify|showContent|parse|history|getSignature)\s*\(/.test(body));
  const usesHttpObject = allBodies.some(body => /\bhttp\s*\./.test(body));
  const usesWhisper = allBodies.some(body => /\bwhisper\s*\(/.test(body));
  // "respond(status, cuerpo)" SOLO tiene sentido dentro de una get/post/put/delete
  // function (son las únicas que de verdad escriben una respuesta HTTP) -- se detecta
  // por separado del resto, mirando solo esos cuatro cuerpos, no server function/watch.
  const usesRespond = allHttpFns.some(([, , fn]) => /\brespond\s*\(/.test(fn.body));

  const respondDef = usesRespond
    ? [
      '// respond(status, cuerpo) -- envuelve la respuesta con un código de estado HTTP',
      '// explícito, en vez del 200 por defecto. Un primitivo con nombre propio, no una',
      '// forma especial en el valor de retorno -- así nunca se confunde con datos reales',
      '// que el usuario devuelva y que casualmente tengan un campo llamado "status".',
      '// Sin "respond()", una get/post/put/delete function sigue respondiendo 200 con el',
      '// valor que devuelva, exactamente igual que siempre -- esto es puramente opcional.',
      'function respond(status, body) { return { __wsHttpResponse: true, status: status, body: body }; }',
      '',
    ]
    : [];

  const whisperDef = usesWhisper
    ? [
      '// whisper(...) -- equivalente a console.log(...) en el servidor. Nombre propio',
      '// para que encaje con el resto del vocabulario del lenguaje (http, watch,',
      '// server reactive) -- no añade ninguna capacidad que console.log() no tuviera ya.',
      'function whisper(...args) { console.log(...args); }',
      '',
    ]
    : [];

  const wsonSendDef = usesWson
    ? [
      '// WSON.send(wson) -- envía un objeto WSON ({ from?, to, via?, content, secret?,',
      '// encrypt?, id? }) al sistema (o SISTEMAS, si "to" es un array) que indique "to".',
      '// Es SOLO envío -- construir el WSON (server wson NOMBRE = ...) nunca envía nada por',
      '// sí solo, siempre hace falta llamar a WSON.send() explícitamente. "via" es opcional',
      '// (por defecto POST); "from" es opcional (mensajes anónimos, y viaja como cabecera',
      '// "X-WSON-From" para que el receptor sepa quién lo mandó). De momento SOLO admite "to"',
      '// como URL (o array de URLs) con via POST/PUT/DELETE -- enviar a un email o número de',
      '// teléfono está pensado pero no implementado todavía (necesita conectar un servicio',
      '// real de correo/SMS, algo que no se puede montar ni probar sin credenciales reales).',
      '//',
      '// VARIOS DESTINOS: si "to" es un array, se manda a todos EN PARALELO y se devuelve un',
      '// array de resultados en el mismo orden -- el fallo de UNO no tumba a los demás (cada',
      '// entrada del array indica su propio éxito/error). Con "to" como string de siempre,',
      '// se sigue devolviendo un único resultado, sin cambios.',
      '//',
      '// FIRMA: si el WSON tiene "secret", se firma automáticamente (HMAC-SHA256 de lo que',
      '// de verdad se manda -- el content cifrado, si lo está, o el content tal cual si no)',
      '// y se manda como cabecera "X-WSON-Signature: sha256=<hex>". El secreto en sí nunca',
      '// viaja por la red. WSON.verify(payload, cabeceraFirma, secreto), en el receptor, hace',
      '// la comprobación inversa -- con comparación en tiempo constante',
      '// (crypto.timingSafeEqual), para no filtrar el secreto por temporización.',
      '//',
      '// CIFRADO OPCIONAL: con "encrypt: true" (necesita "secret" también, como clave), el',
      '// "content" se cifra con AES-256-GCM (cifrado AUTENTICADO -- confidencialidad y',
      '// detección de manipulación en un solo paso, no dos por separado) antes de mandarlo.',
      '// La clave de cifrado se deriva del secreto con una sal distinta a la que usa la',
      '// firma, para no reutilizar la misma clave cruda en dos construcciones criptográficas',
      '// distintas. Sistemas que NO son WebScript nunca podrán descifrarlo sin conocer el',
      '// secreto -- por diseño, ya que es justo el punto de cifrarlo. WSON.showContent(',
      '// payload, secreto), en el receptor, descifra -- o si el mensaje no estaba cifrado,',
      '// lo devuelve tal cual, para no obligar al receptor a ramificar su propio código según',
      '// si el emisor cifró o no. Si el descifrado falla (clave equivocada, o manipulado),',
      '// devuelve null -- comprobable con "if (!resultado)", sin necesitar try/catch.',
      '//',
      '// ID DE CORRELACIÓN: automático por envío (no se guarda en el objeto "wson" -- si lo',
      '// hiciera, reenviar el MISMO objeto reutilizaría el mismo id, que sería incorrecto),',
      '// mandado como cabecera "X-WSON-Correlation-Id". Si el propio wson ya trae "id", se',
      '// respeta ese en vez de generar uno nuevo.',
      '//',
      '// WSON.parse(payload, headers, secreto?) -- en el receptor, hace de una vez lo que si',
      '// no serían tres pasos sueltos (leer "from"/"id" de las cabeceras + WSON.verify() +',
      '// WSON.showContent()): devuelve { from, id, content, signatureValid }. Sin "secreto",',
      '// no intenta verificar ni descifrar -- "content" es el payload tal cual, "signatureValid"',
      '// queda "undefined" (ni verdadero ni falso: sencillamente no se comprobó).',
      '//',
      '// WSON.history(filtros?) -- almacén en un FICHERO real (JSONL, una línea JSON por',
      '// evento), junto al propio server.js -- sobrevive a reiniciar el proceso, a',
      '// diferencia del array en memoria que tenía antes (que se perdía sin remedio).',
      '// WSON.send() registra cada envío (incluso los que fallan, con el error incluido),',
      '// WSON.parse() registra cada recepción -- ambos automáticamente, sin llamada aparte.',
      '// Formato JSONL elegido porque se puede AÑADIR una línea sin reescribir el fichero',
      '// entero (mucho más barato que ir regrabando un array JSON completo en cada evento),',
      '// y porque se puede inspeccionar con herramientas normales (cat, tail, grep) sin',
      '// necesitar nada especial. Sin límite de entradas (a diferencia del tope de 1000 que',
      '// tenía la versión en memoria) -- el fichero puede crecer sin freno en un proceso muy',
      '// longevo; no hay rotación de logs implementada, queda documentado como límite',
      '// conocido, no resuelto aquí.',
      '//',
      '// WSON.getSignature(headers) -- atajo para no tener que recordar el nombre exacto de',
      '// la cabecera ("x-wson-signature", en minúsculas) -- devuelve el mismo valor que ya',
      '// espera WSON.verify() como segundo argumento, sin transformarlo, para que sigan',
      '// siendo componibles: WSON.verify(payload, WSON.getSignature(headers), secreto).',
      'function __wsonDeriveKey(secret, salt) {',
      "  return require('crypto').createHash('sha256').update(secret + ':' + salt).digest();",
      '}',
      "const __wsonHistoryFile = require('path').join(__dirname, 'wson-history.jsonl');",
      'function __wsonRecord(entry) {',
      '  const line = JSON.stringify(Object.assign({ timestamp: Date.now() }, entry)) + \'\\n\';',
      '  try {',
      "    require('fs').appendFileSync(__wsonHistoryFile, line);",
      '  } catch (e) {',
      '    // Si por lo que sea no se puede escribir (permisos, disco lleno...), no se tumba',
      '    // la petición por esto -- el registro es un extra, nunca algo crítico para poder',
      '    // responder. Se avisa por consola, nada más.',
      "    console.error('WSON: no se pudo escribir en el historial (' + __wsonHistoryFile + '): ' + e.message);",
      '  }',
      '}',
      'const WSON = {',
      '  send: async (wson) => {',
      "    const via = (wson.via || 'POST').toUpperCase();",
      "    if (via !== 'POST' && via !== 'PUT' && via !== 'DELETE') {",
      "      throw new Error('WSON.send(): via \"' + wson.via + '\" no soportado todavía -- solo POST/PUT/DELETE por ahora (email y teléfono, pendientes de conectar un servicio real).');",
      '    }',
      '    const crypto_ = require(\'crypto\');',
      '    let payload = wson.content;',
      '    if (wson.encrypt) {',
      "      const key = __wsonDeriveKey(wson.secret, 'wson-encrypt');",
      '      const iv = crypto_.randomBytes(12);',
      "      const cipher = crypto_.createCipheriv('aes-256-gcm', key, iv);",
      "      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(wson.content), 'utf8'), cipher.final()]);",
      '      const authTag = cipher.getAuthTag();',
      '      payload = {',
      '        __wsonEncrypted: true,',
      "        iv: iv.toString('base64'),",
      "        ciphertext: ciphertext.toString('base64'),",
      "        authTag: authTag.toString('base64'),",
      '      };',
      '    }',
      "    const correlationId = wson.id || crypto_.randomUUID();",
      "    const headers = { 'X-WSON-Correlation-Id': correlationId };",
      "    if (wson.from) headers['X-WSON-From'] = wson.from;",
      '    if (wson.secret) {',
      "      const sig = crypto_.createHmac('sha256', wson.secret).update(JSON.stringify(payload)).digest('hex');",
      "      headers['X-WSON-Signature'] = 'sha256=' + sig;",
      '    }',
      '    async function __wsonFetchOnce(url) {',
      "      const opts = { method: via, headers: Object.assign({}, headers) };",
      "      if (payload !== undefined) {",
      "        if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';",
      '        opts.body = JSON.stringify(payload);',
      '      }',
      '      const res = await fetch(url, opts);',
      '      const text = await res.text();',
      "      let parsed; try { parsed = JSON.parse(text); } catch (e) { parsed = text; }",
      '      if (!res.ok) {',
      "        const err = new Error('WSON.send(): el destino respondió ' + res.status + (res.statusText ? (' ' + res.statusText) : ''));",
      '        err.status = res.status;',
      '        err.body = parsed;',
      '        throw err;',
      '      }',
      '      return parsed;',
      '    }',
      '    async function __sendOne(destino) {',
      '      const maxAttempts = 1 + (wson.retries || 0);',
      '      const baseDelay = wson.retryDelayMs || 500;',
      '      let lastError;',
      '      for (let attempt = 1; attempt <= maxAttempts; attempt++) {',
      '        try {',
      '          const result = await __wsonFetchOnce(destino);',
      "          __wsonRecord({ direction: 'sent', from: wson.from, to: destino, via: via, content: wson.content, id: correlationId, attempts: attempt });",
      '          return result;',
      '        } catch (e) {',
      '          lastError = e;',
      '          if (attempt < maxAttempts) {',
      '            await new Promise((resolve) => setTimeout(resolve, baseDelay * Math.pow(2, attempt - 1)));',
      '          }',
      '        }',
      '      }',
      "      __wsonRecord({ direction: 'sent', from: wson.from, to: destino, via: via, content: wson.content, id: correlationId, error: lastError.message, attempts: maxAttempts, deadLetter: true });",
      '      throw lastError;',
      '    }',
      '    if (Array.isArray(wson.to)) {',
      '      const results = await Promise.allSettled(wson.to.map((destino) => __sendOne(destino)));',
      "      return results.map((r) => (r.status === 'fulfilled' ? r.value : { error: true, message: r.reason.message }));",
      '    }',
      '    return await __sendOne(wson.to);',
      '  },',
      '  enqueue: (wson) => {',
      "    const correlationId = wson.id || require('crypto').randomUUID();",
      '    WSON.send(Object.assign({}, wson, { id: correlationId })).catch(() => {});',
      '    return correlationId;',
      '  },',
      '  verify: (payload, signatureHeader, secret) => {',
      '    if (!signatureHeader) return false;',
      "    const expected = 'sha256=' + require('crypto').createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');",
      '    const a = Buffer.from(signatureHeader);',
      '    const b = Buffer.from(expected);',
      '    if (a.length !== b.length) return false;',
      "    return require('crypto').timingSafeEqual(a, b);",
      '  },',
      '  showContent: (payload, secret) => {',
      "    if (!payload || typeof payload !== 'object' || !payload.__wsonEncrypted) return payload;",
      '    try {',
      "      const key = __wsonDeriveKey(secret, 'wson-encrypt');",
      "      const crypto_ = require('crypto');",
      "      const iv = Buffer.from(payload.iv, 'base64');",
      "      const authTag = Buffer.from(payload.authTag, 'base64');",
      "      const decipher = crypto_.createDecipheriv('aes-256-gcm', key, iv);",
      '      decipher.setAuthTag(authTag);',
      "      const decrypted = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64')), decipher.final()]);",
      "      return JSON.parse(decrypted.toString('utf8'));",
      '    } catch (e) {',
      '      return null;',
      '    }',
      '  },',
      '  parse: (payload, headers, secret) => {',
      "    const from = headers ? headers['x-wson-from'] : undefined;",
      "    const id = headers ? headers['x-wson-correlation-id'] : undefined;",
      '    let content = payload;',
      '    let signatureValid;',
      '    if (secret) {',
      "      signatureValid = WSON.verify(payload, headers ? headers['x-wson-signature'] : undefined, secret);",
      '      content = WSON.showContent(payload, secret);',
      '    }',
      "    __wsonRecord({ direction: 'received', from: from, content: content, id: id, signatureValid: signatureValid });",
      '    return { from: from, id: id, content: content, signatureValid: signatureValid };',
      '  },',
      '  history: (filtros) => {',
      '    let entries = [];',
      '    try {',
      "      const raw = require('fs').readFileSync(__wsonHistoryFile, 'utf8');",
      "      entries = raw.split('\\n').filter(Boolean).map((line) => {",
      '        try { return JSON.parse(line); } catch (e) { return null; }',
      '      }).filter((e) => e !== null);',
      '    } catch (e) {',
      '      entries = []; // el fichero no existe todavía (nada se ha enviado/recibido aún)',
      '    }',
      '    let results = entries;',
      '    if (filtros) {',
      "      if (filtros.direction) results = results.filter((e) => e.direction === filtros.direction);",
      "      if (filtros.from) results = results.filter((e) => e.from === filtros.from);",
      "      if (filtros.to) results = results.filter((e) => e.to === filtros.to);",
      "      if (filtros.id) results = results.filter((e) => e.id === filtros.id);",
      "      if (filtros.deadLetter) results = results.filter((e) => e.deadLetter === true);",
      '    }',
      '    return results.slice();',
      '  },',
      '  getSignature: (headers) => (headers ? headers[\'x-wson-signature\'] : undefined),',
      '};',
      '',
    ]
    : [];


  const httpObjectDef = usesHttpObject
    ? [
      '// Objeto "http" -- para llamar a OTROS sistemas por HTTP desde una función de',
      '// servidor (a diferencia de post/put/delete function, que sirven peticiones QUE',
      '// LLEGAN a esta ruta; "http" es para las que ESTA ruta hace hacia fuera).',
      '// http.get(url, headers)',
      '// http.post/put/delete(url, body, headers)',
      '// Todas devuelven el cuerpo de la respuesta ya parseado -- JSON si el Content-Type',
      '// o el propio texto lo permiten, o el texto crudo si no es JSON válido.',
      'async function __wsHttpRequest(method, url, body, headers) {',
      '  const opts = { method, headers: Object.assign({}, headers) };',
      '  if (body !== undefined) {',
      "    if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';",
      '    opts.body = JSON.stringify(body);',
      '  }',
      '  const res = await fetch(url, opts);',
      '  const text = await res.text();',
      '  try { return JSON.parse(text); } catch (e) { return text; }',
      '}',
      'const http = {',
      "  get: (url, headers) => __wsHttpRequest('GET', url, undefined, headers),",
      "  post: (url, body, headers) => __wsHttpRequest('POST', url, body, headers),",
      "  put: (url, body, headers) => __wsHttpRequest('PUT', url, body, headers),",
      "  delete: (url, body, headers) => __wsHttpRequest('DELETE', url, body, headers),",
      '};',
      '',
    ]
    : [];

  const lines = [
    "'use strict';",
    '// Modo estricto a propósito: sin esto, asignar a un identificador NUNCA declarado',
    '// dentro de una post/put/delete function o server function (ej. un typo, o intentar',
    '// "escribir" sobre un nombre que en realidad es un visual del cliente) crea una',
    '// variable GLOBAL implícita en el proceso Node -- filtrada fuera de cualquier sesión,',
    '// un bug silencioso y de verdad peligroso. Con \'use strict\', eso es un ReferenceError',
    '// inmediato y claro en vez de una fuga silenciosa entre sesiones.',
    '',
    '// server.js -- variables SOLO de servidor. Este archivo NUNCA se envía al cliente.',
    '// Cada sesión (identificada por cookie, ver site-builder.js) llama a createSessionState()',
    '// UNA vez y se queda con su propia instancia -- el estado NO se comparte entre visitantes.',
    '',
    ...whisperDef,
    ...respondDef,
    ...httpObjectDef,
    ...wsonSendDef,
    'function createSessionState() {',
    ...inner,
    '}',
    '',
    'module.exports = { createSessionState };',
  ];

  return lines.join('\n') + '\n';
}

// -------- CSS --------
function compileCSS(styles) {
  return styles
    .map(s => {
      const decls = s.props.map(p => `  ${p.prop}: ${p.value};`).join('\n');
      return `.${s.name} {\n${decls}\n}`;
    })
    .join('\n\n');
}

// Lookbehind que excluye "identificador ya precedido de acceso a propiedad" (obj.nombre)
// pero SÍ permite el caso de spread (...nombre), donde el punto inmediatamente anterior
// forma parte de "..." y no de un ".nombre" real.
function identifierRegex(name) {
  return new RegExp(`(?<![\\w$])(?<![^.]\\.)${name}(?![\\w$])`, 'g');
}

// ¿Es esta coincidencia una CLAVE de objeto literal ({ nombre: valor } o , nombre: valor)
// en vez de una referencia real al valor de la variable? Sin parser JS real no podemos
// saberlo con certeza, pero "precedido de { o , (con espacios) y seguido de :" es la
// heurística que cubre el caso real que importa: pasar { visitas: x } a una post function.
function isObjectKeyPosition(expr, index, length) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(expr[i])) i--;
  const before = i >= 0 ? expr[i] : '';
  let j = index + length;
  while (j < expr.length && /\s/.test(expr[j])) j++;
  const after = expr[j] || '';
  return (before === '{' || before === ',') && after === ':';
}

// "var contador = 99" -- ¿el identificador que estamos mirando es el NOMBRE de una
// declaración simple (var/let/const), no una referencia? Sin esto, si el nombre
// coincide con una reactive/var/global, se sustituía igual que cualquier referencia
// -- "var contador = 99" se convertía en "var state.contador = 99", JS INVÁLIDO (no
// solo un valor equivocado, un SyntaxError real al ejecutar el bundle). Cubre tanto
// "var NOMBRE" (justo tras la palabra clave) como declaradores separados por coma
// ("var a = 1, NOMBRE = 2") y el declarador de un "for (let NOMBRE of/in ...)".
function isSimpleDeclarationNamePosition(expr, index) {
  const before = expr.slice(0, index);
  // caso 1: justo después de "var"/"let"/"const" (inicio de declaración, o dentro de
  // un "for (let NOMBRE of ...)")
  if (/(?:^|[;{}(]|\bfor\s*\()\s*(?:var|let|const)\s*$/.test(before)) return true;
  // caso 2: declarador separado por coma dentro de la MISMA declaración -- ej.
  // "var a = 1, NOMBRE = 2". Se busca hacia atrás el inicio de sentencia más cercano
  // y se comprueba que arranque con var/let/const y que lo último antes de esta
  // posición sea una coma (no dentro de un valor, ej. un array o llamada).
  const stmtStart = Math.max(before.lastIndexOf(';'), before.lastIndexOf('{'), before.lastIndexOf('\n'), -1) + 1;
  const stmtSoFar = before.slice(stmtStart);
  if (/^\s*(var|let|const)\b/.test(stmtSoFar) && /,\s*$/.test(stmtSoFar)) return true;
  return false;
}

// Encuentra los tramos "const/let/var { ... }" -- un destructuring. Dentro de esos
// tramos, un identificador como "contador" en "{ contador }" (sin ":") NO es una
// referencia a leer -- es el nombre de una variable NUEVA que se está declarando, y
// sustituirlo generaría JS inválido ("const { state.contador } = obj" no parsea).
function findDestructuringSpans(expr) {
  const spans = [];
  const headerRe = /\b(?:const|let|var)\s*\{/g;
  let hm;
  while ((hm = headerRe.exec(expr)) !== null) {
    const braceStart = expr.indexOf('{', hm.index);
    let depth = 1;
    let j = braceStart + 1;
    let inString = null;
    while (j < expr.length && depth > 0) {
      const ch = expr[j];
      if (inString) {
        if (ch === '\\') { j += 2; continue; }
        if (ch === inString) inString = null;
        j++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inString = ch; j++; continue; }
      if (ch === '{') depth++;
      if (ch === '}') { depth--; }
      j++;
    }
    spans.push([braceStart, j]);
  }
  return spans;
}

function isInsideAnySpan(index, spans) {
  return spans.some(([s, e]) => index >= s && index < e);
}

// Encuentra los tramos de TEXTO LITERAL dentro de comillas simples/dobles, y el texto
// (fuera de cualquier ${...}) de un template literal -- las coincidencias ahí NO son
// código, son texto, y nunca deben sustituirse. Sin esto, "el contador vale " + contador
// corrompía el propio texto a "el state.contador vale " + state.contador, porque la regex
// no distinguía "esto es la palabra 'contador' escrita en español" de "esto es la
// variable contador". Dentro de un template literal, lo que SÍ hay que dejar sin excluir
// es el contenido de ${...} -- eso es código de verdad, no texto.
function findStringLiteralSpans(expr) {
  const spans = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === '"' || ch === "'") {
      const start = i;
      const quote = ch;
      i++;
      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === '\\') { i += 2; continue; }
        i++;
      }
      i++;
      spans.push([start, Math.min(i, expr.length)]);
      continue;
    }
    if (ch === '`') {
      i++;
      let textStart = i;
      while (i < expr.length && expr[i] !== '`') {
        if (expr[i] === '\\') { i += 2; continue; }
        if (expr[i] === '$' && expr[i + 1] === '{') {
          spans.push([textStart, i]);
          i += 2;
          let depth = 1;
          while (i < expr.length && depth > 0) {
            if (expr[i] === '{') depth++;
            else if (expr[i] === '}') depth--;
            i++;
          }
          textStart = i;
          continue;
        }
        i++;
      }
      spans.push([textStart, i]);
      i++;
      continue;
    }
    i++;
  }
  return spans;
}

// { contador } o , contador } / , contador , -- atajo de objeto (property shorthand)
// usado para CONSTRUIR un objeto con el valor actual de la variable (no un destructuring,
// esos ya se excluyen aparte). Aquí no basta con sustituir el nombre -- hay que EXPANDIR
// a la forma explícita "contador: state.contador", porque "{ state.contador }" tampoco
// es sintaxis de atajo válida.
function isShorthandPropertyPosition(expr, index, length) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(expr[i])) i--;
  const before = i >= 0 ? expr[i] : '';
  // "${nombre}" (interpolación de template literal) NO es un atajo de objeto, aunque el
  // carácter "antes" sea "{" -- hay que comprobar que ese "{" no sea en realidad parte
  // de "${". Sin esto, "`vale ${contador}`" se expandía mal a "`vale ${contador: state.contador}`".
  if (before === '{' && i > 0 && expr[i - 1] === '$') return false;
  let j = index + length;
  while (j < expr.length && /\s/.test(expr[j])) j++;
  const after = expr[j] || '';
  return (before === '{' || before === ',') && (after === '}' || after === ',');
}

// Cache por texto de expresión -- si el mismo fragmento se comprueba contra varios
// nombres (transform() llama a esto una vez por local y otra por global), solo se
// parsea una vez con Acorn. null en el cache = "no se pudo analizar con AST, usar regex".
const astRefsCache = new Map();
function getAstRefs(expr) {
  if (astRefsCache.has(expr)) return astRefsCache.get(expr);
  const refs = jsAnalyzer.isAvailable() ? jsAnalyzer.analyzeReferences(expr) : null;
  astRefsCache.set(expr, refs);
  return refs;
}

// Encuentra las referencias reales a `name` dentro de `expr`. Si Acorn está
// disponible y el fragmento parsea, usa el AST (scoping real: distingue solo por
// construcción claves de objeto, destructuring, parámetros de función, atajos...).
// Si no, cae al motor de regex/heurísticas que ya existía -- mismo comportamiento
// de siempre, sin Acorn instalado.
function findIdentifierMatches(expr, name) {
  const astRefs = getAstRefs(expr);
  if (astRefs) {
    return astRefs
      .filter(r => r.name === name)
      .map(r => ({ index: r.start, expand: r.expand }));
  }

  const re = identifierRegex(name);
  const destructuringSpans = findDestructuringSpans(expr);
  const stringSpans = findStringLiteralSpans(expr);
  const matches = [];
  let m;
  while ((m = re.exec(expr)) !== null) {
    if (isObjectKeyPosition(expr, m.index, name.length)) continue;
    if (isSimpleDeclarationNamePosition(expr, m.index)) continue;
    if (isInsideAnySpan(m.index, destructuringSpans)) continue;
    if (isInsideAnySpan(m.index, stringSpans)) continue;
    const expand = isShorthandPropertyPosition(expr, m.index, name.length);
    matches.push({ index: m.index, expand });
  }
  return matches;
}

function usesAny(expr, names) {
  return names.some(name => findIdentifierMatches(expr, name).length > 0);
}

function injectVars(expr, names, prefix) {
  let out = expr;
  for (const name of names) {
    const matches = findIdentifierMatches(out, name);
    for (let k = matches.length - 1; k >= 0; k--) {
      const m = matches[k];
      const replacement = m.expand ? `${name}: ${prefix}.${name}` : `${prefix}.${name}`;
      out = out.slice(0, m.index) + replacement + out.slice(m.index + name.length);
    }
  }
  return out;
}

// Igual que injectVars, pero sustituye a un IDENTIFICADOR LOCAL con guion bajo
// (prefix_nombre) en vez de a un acceso de propiedad (prefix.nombre) -- para el caso
// concreto de que una "reactive" referencie a OTRA "reactive" anterior en su propio
// valor inicial, un punto donde "state" todavía no existe (ver initLocalLines más abajo).
function injectVarsAsLocals(expr, names, prefix) {
  let out = expr;
  for (const name of names) {
    const matches = findIdentifierMatches(out, name);
    for (let k = matches.length - 1; k >= 0; k--) {
      const m = matches[k];
      const localName = `${prefix}_${name}`;
      const replacement = m.expand ? `${name}: ${localName}` : localName;
      out = out.slice(0, m.index) + replacement + out.slice(m.index + name.length);
    }
  }
  return out;
}

// Igual que injectVars, pero sustituye a un LITERAL DE TEXTO (JSON.stringify(nombre),
// que para un identificador simple es solo el mismo nombre entre comillas) en vez de a
// un acceso de propiedad -- para "class={estilo}", donde "estilo" es el nombre de un
// "style" declarado. Ese "style" nunca existe como variable JS (se compila SOLO a CSS),
// así que referenciarlo tal cual en una expresión daría ReferenceError -- aquí se
// convierte "estilo" en el string "estilo" directamente, que es literalmente el nombre
// de la clase CSS que "style estilo = ..." genera.
function injectVarsAsStringLiterals(expr, names) {
  let out = expr;
  for (const name of names) {
    const matches = findIdentifierMatches(out, name);
    for (let k = matches.length - 1; k >= 0; k--) {
      const m = matches[k];
      if (m.expand) continue; // un nombre de style en posición de atajo de objeto no tiene sentido, se deja tal cual
      const replacement = JSON.stringify(name);
      out = out.slice(0, m.index) + replacement + out.slice(m.index + name.length);
    }
  }
  return out;
}

// -------- JS: genera funciones create_NAME(state, effect, props) para cada visual --------
function compileJS(reactives, globalVars, functions, wsons, visuals, renderCall, globalNames, visualNames, serverDataUrl = null, httpFns = {}, routePath = null, styleNames = []) {
  const { post: postFn = null, put: putFn = null, delete: deleteFn = null } = httpFns;
  const allHttpFns = [
    ['post', 'POST', postFn],
    ['put', 'PUT', putFn],
    ['delete', 'DELETE', deleteFn],
  ].filter(([, , fn]) => fn);

  const runtimeSrc = fs.readFileSync(path.join(__dirname, 'runtime', 'reactive.js'), 'utf8')
    .replace(/if \(typeof module[\s\S]*$/m, ''); // quita el export para navegador

  // El valor inicial de una "reactive" puede referenciar a OTRA "reactive" declarada
  // ANTES en el mismo archivo (ej. "reactive datos = JSON.parse(textoJson)"). En este
  // punto exacto "state" TODAVÍA NO EXISTE (se está construyendo con esta misma
  // llamada a createStore) -- así que sustituir a "state.textoJson" fallaría igual,
  // con un ReferenceError distinto. La solución: calcular cada valor inicial en una
  // variable local previa, en orden de declaración, y que las posteriores referencien
  // esas variables locales (no "state.X") para las reactive anteriores que usen.
  const initLocalLines = [];
  const declaredReactiveNames = [];
  for (const r of reactives) {
    const substitutedInit = injectVarsAsLocals(r.init, declaredReactiveNames, '__init');
    initLocalLines.push(`let __init_${r.name} = ${substitutedInit};`);
    declaredReactiveNames.push(r.name);
  }
  const initialGlobalState = reactives.map(r => `  ${r.name}: __init_${r.name}`).join(',\n');

  let idCounter = 0;
  const nextId = () => `__el${idCounter++}`;

  // ctx = { localNames, boundNames } -- localNames son las reactive locales del visual;
  // boundNames son nombres "atados" por el ámbito léxico actual (la variable de un "for",
  // por ejemplo) que SIEMPRE ganan sobre cualquier reactive/local con el mismo nombre --
  // scoping real, no solo textual.
  function effectiveNames(names, ctx) {
    const bound = ctx.boundNames || [];
    return bound.length === 0 ? names : names.filter(n => !bound.includes(n));
  }

  function transform(expr, ctx) {
    let out = injectVars(expr, effectiveNames(ctx.localNames, ctx), 'localState');
    out = injectVars(out, effectiveNames(globalNames, ctx), 'state');
    return out;
  }

  // Ejecuta makeStatement(compiledExpr) una vez (estático) o la envuelve en effect()/localEffect()
  // según de qué store(s) dependa la expresión. Si depende de ambos, se registra en los dos --
  // cada store solo dispara por sus propias keys, así que no hay doble-disparo cruzado.
  function emitReactive(lines, rawExpr, ctx, makeStatement) {
    const needsLocal = usesAny(rawExpr, effectiveNames(ctx.localNames, ctx));
    const needsGlobal = usesAny(rawExpr, effectiveNames(globalNames, ctx));
    const compiled = transform(rawExpr, ctx);
    const stmt = makeStatement(compiled);
    if (!needsLocal && !needsGlobal) {
      lines.push(`  ${stmt}`);
      return;
    }
    const fn = `() => { ${stmt} }`;
    if (needsGlobal) lines.push(`  effect(${fn});`);
    if (needsLocal) lines.push(`  localEffect(${fn});`);
  }

  // Construye el literal de props { key: expr, ... } a partir de los atributos de un tag-componente
  function buildPropsLiteral(attrs, childrenVar, ctx) {
    const entries = Object.entries(attrs || {}).map(([attr, value]) => {
      if (value === true) return `${JSON.stringify(attr)}: true`;
      if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
        const expr = transform(value.slice(1, -1).trim(), ctx);
        return `${JSON.stringify(attr)}: ${expr}`;
      }
      return `${JSON.stringify(attr)}: ${JSON.stringify(value)}`;
    });
    if (childrenVar) entries.push(`children: ${childrenVar}`);
    return `{ ${entries.join(', ')} }`;
  }

  // Ejecuta bloque de líneas una sola vez (si es estático) o envuelto en effect()/localEffect().
  function wrapEffectBlock(lines, needsLocal, needsGlobal, innerLines) {
    const body = innerLines.join('\n    ');
    if (!needsLocal && !needsGlobal) {
      lines.push(`  (() => {\n    ${body}\n  })();`);
      return;
    }
    const fn = `() => {\n    ${body}\n  }`;
    if (needsGlobal) lines.push(`  effect(${fn});`);
    if (needsLocal) lines.push(`  localEffect(${fn});`);
  }

  // if / else if / else -- se re-renderiza en la misma posición cada vez que cambie
  // alguna variable de la que dependan las condiciones. Se marca la posición con un
  // nodo comentario ("ancla") y en cada ejecución se borra lo anterior y se reconstruye
  // justo delante de esa ancla.
  function emitIf(node, lines, ctx) {
    const anchorVar = nextId();
    const containerVar = nextId();
    const currentVar = `${nextId()}_current`;
    lines.push(`  const ${anchorVar} = document.createComment('if');`);
    lines.push(`  const ${containerVar} = document.createDocumentFragment();`);
    lines.push(`  ${containerVar}.appendChild(${anchorVar});`);
    lines.push(`  let ${currentVar} = [];`);

    const allConditions = node.branches.map(b => b.condition).join(' ; ');
    const needsLocal = usesAny(allConditions, effectiveNames(ctx.localNames, ctx));
    const needsGlobal = usesAny(allConditions, effectiveNames(globalNames, ctx));

    const inner = [];
    inner.push(`${currentVar}.forEach(n => n.remove());`);
    inner.push(`${currentVar} = [];`);
    node.branches.forEach((branch, idx) => {
      const compiledCond = transform(branch.condition, ctx);
      const branchLines = [];
      const branchVars = branch.body.map(n => emitNode(n, branchLines, ctx));
      inner.push(`${idx === 0 ? 'if' : 'else if'} (${compiledCond}) {`);
      inner.push(...branchLines);
      inner.push(`  ${currentVar} = [${branchVars.join(', ')}];`);
      inner.push(`}`);
    });
    if (node.elseBody) {
      const elseLines = [];
      const elseVars = node.elseBody.map(n => emitNode(n, elseLines, ctx));
      inner.push(`else {`);
      inner.push(...elseLines);
      inner.push(`  ${currentVar} = [${elseVars.join(', ')}];`);
      inner.push(`}`);
    }
    inner.push(`const __ref = ${anchorVar}.nextSibling;`);
    inner.push(`${currentVar}.forEach(n => ${anchorVar}.parentNode.insertBefore(n, __ref));`);

    wrapEffectBlock(lines, needsLocal, needsGlobal, inner);
    return containerVar;
  }

  // for (item in iterable [by clave]) -- diffing por clave: si la clave de un ítem ya
  // existía Y el ítem es el mismo objeto (===), se reutiliza el nodo DOM tal cual (ni se
  // borra ni se recrea). Si la clave existe pero el ítem cambió, se reconstruye SOLO ese
  // ítem. Si ya no está en la nueva lista, se elimina. Sin "by" se usa el índice como
  // clave -- sigue siendo correcto, pero pierde el beneficio al reordenar/insertar en medio.
  function emitFor(node, lines, ctx) {
    const anchorVar = nextId();
    const containerVar = nextId();
    const keyedVar = `${nextId()}_keyed`; // Map<clave, {item, nodes}> -- persiste entre renders
    lines.push(`  const ${anchorVar} = document.createComment('for');`);
    lines.push(`  const ${containerVar} = document.createDocumentFragment();`);
    lines.push(`  ${containerVar}.appendChild(${anchorVar});`);
    lines.push(`  const ${keyedVar} = new Map();`);

    const needsLocal = usesAny(node.iterable, effectiveNames(ctx.localNames, ctx));
    const needsGlobal = usesAny(node.iterable, effectiveNames(globalNames, ctx));
    const compiledIterable = transform(node.iterable, ctx);

    // Dentro del cuerpo del bucle, "node.item" pasa a estar "atado" -- si coincide con
    // el nombre de una reactive/local, la de dentro del for gana (scoping real).
    const bodyCtx = { ...ctx, boundNames: [...(ctx.boundNames || []), node.item] };
    const itemLines = [];
    const itemVars = node.body.map(n => emitNode(n, itemLines, bodyCtx));
    const keyExprCompiled = node.keyExpr ? transform(node.keyExpr, bodyCtx) : null;

    const buildFnName = `${nextId()}_build`;
    lines.push(`  function ${buildFnName}(${node.item}) {`);
    lines.push(...itemLines.map(l => '  ' + l));
    // Aplanar cualquier fragmento (de un if/for anidado) a sus nodos REALES antes de
    // devolver -- un fragmento se vacía al insertarse la primera vez, y si se reutiliza
    // tal cual en un render posterior (ítem sin cambios), la reinserción es un no-op sin
    // forma de saber cuánto avanzar al reordenar. Guardando los nodos reales desde el
    // principio, siempre son rastreables (parentNode/nextSibling válidos), nunca un
    // contenedor ya vacío.
    lines.push(`    const __raw = [${itemVars.join(', ')}];`);
    lines.push(`    const __flat = [];`);
    lines.push(`    __raw.forEach(n => { if (n.nodeType === 11) { __flat.push(...n.childNodes); } else { __flat.push(n); } });`);
    lines.push(`    return __flat;`);
    lines.push(`  }`);

    const keyOf = keyExprCompiled || '__idx';

    const inner = [];
    inner.push(`const __items = (${compiledIterable});`);
    inner.push(`const __newKeys = new Set();`);
    inner.push(`__items.forEach((${node.item}, __idx) => { __newKeys.add(${keyOf}); });`);
    inner.push(`for (const [__k, __entry] of ${keyedVar}) {`);
    inner.push(`  if (!__newKeys.has(__k)) { __entry.nodes.forEach(n => n.remove()); ${keyedVar}.delete(__k); }`);
    inner.push(`}`);
    inner.push(`const __ordered = [];`);
    inner.push(`__items.forEach((${node.item}, __idx) => {`);
    inner.push(`  const __k = ${keyOf};`);
    inner.push(`  let __entry = ${keyedVar}.get(__k);`);
    inner.push(`  if (!__entry || __entry.item !== ${node.item}) {`);
    inner.push(`    if (__entry) __entry.nodes.forEach(n => n.remove());`);
    inner.push(`    __entry = { item: ${node.item}, nodes: ${buildFnName}(${node.item}) };`);
    inner.push(`    ${keyedVar}.set(__k, __entry);`);
    inner.push(`  }`);
    inner.push(`  __ordered.push(...__entry.nodes);`);
    inner.push(`});`);
    inner.push(`let __after = ${anchorVar};`);
    // Como los fragmentos (de if/for anidados) ya se aplanaron a nodos reales al
    // construir cada ítem (arriba), cada "n" aquí SIEMPRE es un nodo real -- nunca un
    // fragmento que quede vacío tras insertarse. Por eso basta con encadenar
    // directamente sobre el nodo insertado, sin inferir su posición mirando el DOM
    // después (ese enfoque se rompía con el caso especial del spec de
    // insertBefore(nodo, nodo mismo), que ajusta la referencia POR DENTRO, invisible
    // para este código).
    inner.push(`__ordered.forEach(n => {`);
    inner.push(`  __after.parentNode.insertBefore(n, __after.nextSibling);`);
    inner.push(`  __after = n;`);
    inner.push(`});`);

    wrapEffectBlock(lines, needsLocal, needsGlobal, inner);
    return containerVar;
  }

  function emitNode(node, lines, ctx) {
    if (node.type === 'text') {
      const varName = nextId();
      lines.push(`  const ${varName} = document.createTextNode(${JSON.stringify(node.value)});`);
      return varName;
    }
    if (node.type === 'interpolation') {
      const varName = nextId();
      lines.push(`  const ${varName} = document.createTextNode('');`);
      emitReactive(lines, node.expr, ctx, (compiled) => `${varName}.textContent = ${compiled};`);
      return varName;
    }
    if (node.type === 'if') {
      return emitIf(node, lines, ctx);
    }
    if (node.type === 'for') {
      return emitFor(node, lines, ctx);
    }
    if (node.type === 'element') {
      // <slot/> -> inserta aquí los children que le pasó el padre (via props)
      if (node.tag === 'slot') {
        const varName = nextId();
        lines.push(`  const ${varName} = document.createDocumentFragment();`);
        lines.push(`  (props.children || []).forEach(c => ${varName}.appendChild(c));`);
        return varName;
      }

      // <NombreDeOtroVisual .../> -> composición: llama a create_NombreDeOtroVisual
      // Cada llamada crea su PROPIA instancia de estado local -> aislamiento real entre instancias.
      if (visualNames.has(node.tag)) {
        const varName = nextId();
        let childrenVar = null;
        if (node.children && node.children.length > 0) {
          childrenVar = `${varName}_children`;
          lines.push(`  const ${childrenVar} = [];`);
          for (const child of node.children) {
            const childVar = emitNode(child, lines, ctx);
            lines.push(`  ${childrenVar}.push(${childVar});`);
          }
        }
        const propsLiteral = buildPropsLiteral(node.attrs, childrenVar, ctx);
        lines.push(`  const ${varName} = create_${node.tag}(state, effect, ${propsLiteral});`);
        return varName;
      }

      // elemento HTML normal
      const varName = nextId();
      const tag = node.tag === '__root__' ? 'div' : node.tag;
      lines.push(`  const ${varName} = document.createElement(${JSON.stringify(tag)});`);
      for (const [attr, value] of Object.entries(node.attrs || {})) {
        const isInterpolated = typeof value === 'string' && value.startsWith('{') && value.endsWith('}');
        const isEventAttr = /^on[a-z]+$/.test(attr);

        if (isEventAttr && isInterpolated) {
          // onclick={código} / onXXX={código} -- evento en línea, en CUALQUIER nodo
          // (no solo la raíz). Reutiliza exactamente la misma detección de async/await
          // que ya usábamos para los bindings "-> onXXX:" -- un solo motor, dos formas
          // de invocarlo, para no duplicar la lógica de RPC/await.
          emitEventListener(lines, varName, attr.slice(2).toLowerCase(), value.slice(1, -1).trim(), ctx);
        } else if (value === true) {
          lines.push(`  ${varName}.setAttribute(${JSON.stringify(attr)}, "");`);
        } else if (isInterpolated) {
          // "class={expr}" incluido aquí -- sin caso especial: si "expr" referencia el
          // nombre de un "style" declarado, se sustituye antes por su clase CSS (que es
          // literalmente el mismo nombre); cualquier otra expresión (reactive, ternario,
          // combinación de ambas) sigue el camino normal de interpolación reactiva.
          const raw = value.slice(1, -1).trim();
          const withStyleNames = attr === 'class' ? injectVarsAsStringLiterals(raw, styleNames) : raw;
          emitReactive(lines, withStyleNames, ctx, (compiled) => `${varName}.setAttribute(${JSON.stringify(attr)}, ${compiled});`);
        } else {
          lines.push(`  ${varName}.setAttribute(${JSON.stringify(attr)}, ${JSON.stringify(value)});`);
        }
      }
      for (const child of node.children || []) {
        const childVar = emitNode(child, lines, ctx);
        lines.push(`  ${varName}.appendChild(${childVar});`);
      }
      return varName;
    }
    throw new Error(`Nodo de plantilla desconocido: ${node.type}`);
  }

  // Genera un addEventListener para CUALQUIER nodo (no solo la raíz) -- detecta si el
  // cuerpo necesita ser async (llama a un post/put/delete function, o ya tiene un
  // "await" explícito -- ej. WSON.send()) e inyecta "await" delante de las llamadas a
  // RPC que el usuario no haya puesto ya.
  function emitEventListener(lines, varName, eventName, body, ctx) {
    const rpcNames = allHttpFns.map(([, , fn]) => fn.name);
    const rpcPattern = rpcNames.length > 0 ? rpcNames.map(n => `\\b${n}\\s*\\(`).join('|') : null;
    const usesRpc = rpcPattern ? new RegExp(rpcPattern).test(body) : false;
    const usesExplicitAwait = /\bawait\b/.test(body);
    const needsAsync = usesRpc || usesExplicitAwait;
    const injected = transform(body, ctx)
      .split('\n')
      .map(l => '    ' + l)
      .join('\n');
    const asyncKw = needsAsync ? 'async ' : '';
    const awaitedInjected = usesRpc
      ? injected.replace(new RegExp(`(?<!await\\s)(${rpcPattern})`, 'g'), 'await $1')
      : injected;
    lines.push(`  ${varName}.addEventListener(${JSON.stringify(eventName)}, ${asyncKw}(event) => {\n${awaitedInjected}\n  });`);
  }

  const visualFns = visuals.map(v => {
    const lines = [];
    idCounter = 0;
    const localNames = v.localReactives.map(r => r.name);
    const ctx = { localNames };

    if (localNames.length > 0) {
      const initialLocalState = v.localReactives.map(r => `    ${r.name}: ${r.init}`).join(',\n');
      lines.push(`  const { store: localState, effect: localEffect } = createStore({\n${initialLocalState}\n  });`);
    }

    // "var" locales -- se evalúan UNA sola vez, aquí mismo, y quedan como variables JS normales
    // (pueden leer reactive/local vía state./localState., pero no se re-ejecutan si esas cambian)
    for (const vr of v.localVars) {
      lines.push(`  let ${vr.name} = ${transform(vr.init, ctx)};`);
    }

    const rootVar = emitNode(v.template, lines, ctx);

    lines.push(`  return ${rootVar};`);
    return `function create_${v.name}(state, effect, props = {}) {\n${lines.join('\n')}\n}`;
  }).join('\n\n');

  const mountCalls = renderCall
    ? renderCall.args.map(name => `app.appendChild(create_${name}(state, effect, {}));`).join('\n')
    : '';

  const globalVarLines = globalVars
    .map(v => `let ${v.name} = ${transform(v.init, { localNames: [] })};`)
    .join('\n');

  // "function NOMBRE(params)" de cliente -- helper con cuerpo en varias líneas, algo
  // que "var NOMBRE = (params) => valor" no puede dar (esa solo cabe en una línea). Se
  // declara con "function" normal de JS (no una const con arrow) para que quede
  // "hoisted" -- se puede llamar desde cualquier sitio del bundle, sin importar el
  // orden de declaración, igual que ya pasa con "server function" en server.js.
  const functionLines = functions
    .map(fn => `${fn.isAsync ? 'async ' : ''}function ${fn.name}(${fn.params}) {\n${transform(fn.body, { localNames: [] }).split('\n').map(l => '  ' + l).join('\n')}\n}`)
    .join('\n\n');

  // "wson NOMBRE = -> ..." de cliente -- estructura de datos (from/to/via/content).
  // Declararla nunca envía nada, solo WSON.send(NOMBRE) lo hace.
  const wsonLines = wsons
    .map(w => `let ${w.name} = { ${w.fields.map(f => `${f.key}: ${transform(f.value, { localNames: [] })}`).join(', ')} }; // wson`)
    .join('\n');

  // ¿Se usa WSON.send( en algún sitio de cliente (reactive/var/function/wson/plantillas,
  // incluyendo atributos en línea como onclick={...})? Solo se genera el objeto WSON si
  // de verdad se usa, igual que el resto de helpers condicionales del proyecto.
  const clientBodiesForWsonCheck = [
    ...globalVars.map(v => v.init),
    ...functions.map(fn => fn.body),
    ...visuals.flatMap(v => {
      const exprs = [];
      collectAllTemplateExprs(v.template, exprs);
      return exprs;
    }),
  ];
  const usesWsonSendClient = clientBodiesForWsonCheck.some(body => /\bWSON\.(send|enqueue)\s*\(/.test(body));
  const wsonSendClientDef = usesWsonSendClient
    ? [
      '// WSON.send(wson) -- envía un objeto WSON ({ from?, to, via?, content, retries?,',
      '// retryDelayMs?, id? }) al sistema que indique "to" (o a VARIOS, si "to" es un array',
      '// -- en paralelo, cada uno con su propio éxito/error, sin que el fallo de uno tumbe a',
      '// los demás), directamente desde el navegador (fetch). Declarar el wson nunca envía',
      '// nada por sí solo -- siempre hace falta llamar a WSON.send() explícitamente. "from"',
      '// viaja como cabecera "X-WSON-From". Con "retries", reintenta con espera creciente',
      '// (backoff exponencial) si el destino falla o responde con un código de error --',
      '// tanto fallo de red como un 4xx/5xx cuentan como fallo reintentable. De momento SOLO',
      '// admite "to" como URL con via POST/PUT/DELETE. Sin firma ni cifrado en el cliente --',
      '// eso es exclusivo del servidor (ver WSON.send() de server.js).',
      '//',
      '// WSON.enqueue(wson) -- versión NO bloqueante: devuelve el id de correlación al',
      '// instante, sin esperar a que el envío (con sus reintentos) termine -- pasa en',
      '// segundo plano. Útil para no bloquear la interfaz esperando una confirmación que',
      '// al usuario no le hace falta ver.',
      'const WSON = {',
      '  send: async (wson) => {',
      "    const via = (wson.via || 'POST').toUpperCase();",
      "    if (via !== 'POST' && via !== 'PUT' && via !== 'DELETE') {",
      "      throw new Error('WSON.send(): via \"' + wson.via + '\" no soportado todavía -- solo POST/PUT/DELETE por ahora.');",
      '    }',
      "    const headers = { 'Content-Type': 'application/json' };",
      "    if (wson.from) headers['X-WSON-From'] = wson.from;",
      '    async function __wsonFetchOnce(destino) {',
      '      const res = await fetch(destino, { method: via, headers: headers, body: JSON.stringify(wson.content) });',
      '      const text = await res.text();',
      "      let parsed; try { parsed = JSON.parse(text); } catch (e) { parsed = text; }",
      '      if (!res.ok) {',
      "        const err = new Error('WSON.send(): el destino respondió ' + res.status);",
      '        err.status = res.status;',
      '        throw err;',
      '      }',
      '      return parsed;',
      '    }',
      '    async function __sendOne(destino) {',
      '      const maxAttempts = 1 + (wson.retries || 0);',
      '      const baseDelay = wson.retryDelayMs || 500;',
      '      let lastError;',
      '      for (let attempt = 1; attempt <= maxAttempts; attempt++) {',
      '        try {',
      '          return await __wsonFetchOnce(destino);',
      '        } catch (e) {',
      '          lastError = e;',
      '          if (attempt < maxAttempts) {',
      '            await new Promise((resolve) => setTimeout(resolve, baseDelay * Math.pow(2, attempt - 1)));',
      '          }',
      '        }',
      '      }',
      '      throw lastError;',
      '    }',
      '    if (Array.isArray(wson.to)) {',
      '      const results = await Promise.allSettled(wson.to.map((destino) => __sendOne(destino)));',
      "      return results.map((r) => (r.status === 'fulfilled' ? r.value : { error: true, message: r.reason.message }));",
      '    }',
      '    return await __sendOne(wson.to);',
      '  },',
      '  enqueue: (wson) => {',
      "    const correlationId = wson.id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());",
      '    WSON.send(Object.assign({}, wson, { id: correlationId })).catch(() => {});',
      '    return correlationId;',
      '  },',
      '};',
      '',
    ].join('\n')
    : '';

  // ¿Se llama a cada función (post/put/delete) desde algún handler (incluyendo atributos
  // en línea como onclick={...})? Si nadie la usa, no generamos su stub de cliente -- no
  // tiene sentido exponerla si nadie la llama.
  const stubs = allHttpFns
    .filter(([, , fn]) => visuals.some(v => {
      const exprs = [];
      collectAllTemplateExprs(v.template, exprs);
      return exprs.some(body => new RegExp(`\\b${fn.name}\\s*\\(`).test(body));
    }))
    .map(([verb, method, fn]) => {
      // El cliente manda el primer parámetro (el "body") y, si la función declara un
      // segundo parámetro, también ese (la query string) -- a diferencia de las
      // cabeceras (tercer parámetro), que el cliente nunca "manda" a mano, el navegador
      // ya las pone. La query sí es algo que quien llama elige, así que sí es visible.
      const paramNames = fn.params.split(',').map(s => s.trim()).filter(Boolean);
      const primaryParam = paramNames[0] || 'args';
      const queryParam = paramNames[1] || null;
      const clientParams = queryParam ? `${primaryParam}, ${queryParam}` : primaryParam;
      const baseUrlExpr = routePath ? JSON.stringify(routePath) : 'window.location.pathname';
      const urlLine = queryParam
        ? `  var __url = ${baseUrlExpr};\n  if (${queryParam} && Object.keys(${queryParam}).length > 0) __url += '?' + new URLSearchParams(${queryParam}).toString();`
        : `  var __url = ${baseUrlExpr};`;
      return `
// Llama a "${verb} function ${fn.name}" en el servidor -- ${method} a la URL de esta
// misma ruta${queryParam ? ` (con "${queryParam}" añadido como query string, si se pasa)` : ''}.
// Si no se compiló dentro de un sitio con rutas (ej. "build" de un solo archivo), usa
// la URL actual de la página como respaldo.
async function ${fn.name}(${clientParams}) {
  if (location.protocol === 'file:') {
    throw new Error('"${fn.name}" necesita un servidor -- abre esta página vía http://, no como archivo local (file://). Usa: node src/cli.js run <carpeta> --serve');
  }
${urlLine}
  return fetch(__url, {
    method: '${method}',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(${primaryParam} || {}),
  }).then(r => r.json());
}
`;
    });
  const postFnStub = stubs.join('');

  // Si el archivo lee algún "server.NOMBRE", el montaje tiene que esperar a un fetch
  // antes de crear el estado (sus valores iniciales pueden depender de datos de servidor).
  // Si no, se mantiene el montaje síncrono de siempre -- cero coste extra para páginas estáticas.
  const mountBlock = serverDataUrl
    ? `
let server = {};
let state, effect;
${postFnStub}
async function __wsInit() {
  if (location.protocol === 'file:') {
    document.getElementById('app').innerHTML =
      '<div style="font-family: sans-serif; padding: 24px; color: #b91c1c; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; margin: 24px;">' +
      '<strong>Esta página necesita un servidor.</strong><br>Usa <code>server var</code>/<code>post function</code>, ' +
      'así que no funciona abriendo el archivo directamente (protocolo file://). ' +
      'Levanta el servidor con <code>node src/cli.js run &lt;carpeta&gt; --serve</code> y abre ' +
      '<code>http://localhost:3000' + ${JSON.stringify(routePath || '/')} + '</code> en el navegador.' +
      '</div>';
    return;
  }

  server = await fetch(${JSON.stringify(serverDataUrl)}).then(r => r.json());

${initLocalLines.map(l => '  ' + l).join('\n')}
  const store = createStore({
${initialGlobalState}
  });
  state = store.store;
  effect = store.effect;

${globalVarLines.split('\n').filter(Boolean).map(l => '  ' + l).join('\n')}
${wsonLines ? '\n' + wsonLines.split('\n').map(l => '  ' + l).join('\n') : ''}

  const app = document.getElementById('app');
  ${mountCalls}
}

document.addEventListener('DOMContentLoaded', () => { __wsInit(); });
`
    : `
// ---- estado reactivo GLOBAL (compartido entre todos los visuales) ----
${initLocalLines.join('\n')}
const { store: state, effect } = createStore({
${initialGlobalState}
});

// ---- variables NO reactivas globales (se calculan una vez, no re-renderizan nada) ----
${globalVarLines}
${wsonLines}
${postFnStub}
// ---- montaje ----
document.addEventListener('DOMContentLoaded', () => {
  const app = document.getElementById('app');
  ${mountCalls}
});
`;

  return `${runtimeSrc}
// ---- visuales compilados (cada uno crea su propio estado LOCAL si declara "reactive" interno) ----
${visualFns}
${functionLines ? `\n// ---- funciones de cliente ("function NOMBRE(params)") -- disponibles en todo el archivo, sin importar el orden de declaración ----\n${functionLines}\n` : ''}
${wsonSendClientDef}
${mountBlock}`;
}

// -------- HTML esqueleto --------
function compileHTML(cssFilename = 'styles.css', jsFilename = 'bundle.js') {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>WebScript App</title>
  <link rel="stylesheet" href="${cssFilename}">
</head>
<body>
  <div id="app"></div>
  <script src="${jsFilename}"></script>
</body>
</html>
`;
}

module.exports = { compile, usesServerData };
