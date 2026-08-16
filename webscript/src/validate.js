const jsAnalyzer = require('./js-analyzer');

const LABELS = {
  ReactiveDecl: 'reactive',
  VarDecl: 'var',
  FunctionDecl: 'function',
  StyleDecl: 'style',
  VisualDecl: 'visual',
  ServerVarDecl: 'server var',
  ServerReactiveDecl: 'server reactive',
  ServerFunctionDecl: 'server function',
  PostFunctionDecl: 'post function',
  PutFunctionDecl: 'put function',
  DeleteFunctionDecl: 'delete function',
  GetFunctionDecl: 'get function',
  WatchDecl: 'watch',
  WsonDecl: 'wson',
  ServerWsonDecl: 'server wson',
};

// Espacios de nombres: reactive/var/function/wson/visual/server-var/server-reactive/
// server-function/server-wson/get-post-put-delete-function comparten uno -- colisionan
// de verdad (variable JS muerta, función pisada en silencio, o ambigüedad sobre si un
// nombre es de cliente o de servidor). "style" tiene el suyo propio. "watch" no declara
// ningún nombre (solo referencia uno existente), así que no participa en este espacio.
const SHARED_NAMESPACE = new Set([
  'ReactiveDecl', 'VarDecl', 'FunctionDecl', 'WsonDecl', 'VisualDecl', 'ServerVarDecl', 'ServerReactiveDecl', 'ServerFunctionDecl', 'ServerWsonDecl',
  'PostFunctionDecl', 'PutFunctionDecl', 'DeleteFunctionDecl', 'GetFunctionDecl',
]);

function labelFor(type) {
  return LABELS[type] || type;
}

// Tipado OPCIONAL y superficial: "reactive string x = ..." / "var number y = ...".
// No hay sistema de tipos real -- solo se comprueba cuando el valor inicial es un
// literal simple (cadena/número/booleano). Si es una expresión más compleja (llamada
// a función, aritmética, referencia a otra variable...), no se valida -- no tenemos
// inferencia de tipos, y fingir que sí sería peor que no comprobar nada.
function literalKind(init) {
  const t = init.trim();
  if (/^(['"`])(?:[^\\]|\\.)*\1$/.test(t)) return 'string';
  if (/^-?\d+(\.\d+)?$/.test(t)) return 'number';
  if (t === 'true' || t === 'false') return 'boolean';
  return null;
}

function checkDeclaredType(decl, context) {
  if (!decl.varType) return;
  const actual = literalKind(decl.init);
  if (actual && actual !== decl.varType) {
    throw new SyntaxError(
      `Línea ${decl.line}: "${decl.name}"${context} se declaró como "${decl.varType}" pero el valor ` +
      `inicial (${decl.init}) parece un ${actual}. (Solo se comprueba cuando el valor inicial es un ` +
      `literal simple -- expresiones más complejas no se validan, no hay inferencia de tipos real.)`
    );
  }
}

// Comprueba si `expr` referencia `name` como identificador suelto (no como propiedad de
// otro objeto, ej. "obj.name" no cuenta, ni como clave de objeto literal "{ name: x }").
// Misma lógica que compiler.js, reimplementada aquí para no acoplar validate.js al compilador.
function isObjectKeyPosition(expr, index, length) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(expr[i])) i--;
  const before = i >= 0 ? expr[i] : '';
  let j = index + length;
  while (j < expr.length && /\s/.test(expr[j])) j++;
  const after = expr[j] || '';
  return (before === '{' || before === ',') && after === ':';
}

function isInsideAnySpan(index, spans) {
  return spans.some(([s, e]) => index >= s && index < e);
}

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

// Igual que en compiler.js: tramos de TEXTO LITERAL dentro de comillas (respetando
// ${...} de un template literal, que sí es código) -- sin esto, "referencia" a un
// server var/función podía detectarse por error dentro de una cadena de texto que
// simplemente CONTIENE esa palabra, no una referencia de verdad.
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

function referencesName(expr, name) {
  const astRefs = jsAnalyzer.isAvailable() ? jsAnalyzer.analyzeReferences(expr) : null;
  if (astRefs) {
    return astRefs.some(r => r.name === name);
  }

  const re = new RegExp(`(?<![\\w$])(?<![^.]\\.)${name}(?![\\w$])`, 'g');
  const destructuringSpans = findDestructuringSpans(expr);
  const stringSpans = findStringLiteralSpans(expr);
  let m;
  while ((m = re.exec(expr)) !== null) {
    if (isInsideAnySpan(m.index, stringSpans)) continue;
    if (isObjectKeyPosition(expr, m.index, name.length)) continue;
    if (destructuringSpans.some(([s, e]) => m.index >= s && m.index < e)) continue;
    return true;
  }
  return false;
}

// Recorre un nodo de plantilla y junta todas las expresiones "crudas" que el compilador
// va a evaluar (interpolaciones, atributos {expr}, condiciones de if, iterables de for).
function collectTemplateExprs(node, exprs) {
  if (!node) return;
  if (node.type === 'interpolation') { exprs.push(node.expr); return; }
  if (node.type === 'text') return;
  if (node.type === 'if') {
    for (const b of node.branches) {
      exprs.push(b.condition);
      b.body.forEach(n => collectTemplateExprs(n, exprs));
    }
    if (node.elseBody) node.elseBody.forEach(n => collectTemplateExprs(n, exprs));
    return;
  }
  if (node.type === 'for') {
    exprs.push(node.iterable); if (node.keyExpr) exprs.push(node.keyExpr);
    node.body.forEach(n => collectTemplateExprs(n, exprs));
    return;
  }
  if (node.type === 'element') {
    for (const value of Object.values(node.attrs || {})) {
      if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
        exprs.push(value.slice(1, -1));
      }
    }
    (node.children || []).forEach(c => collectTemplateExprs(c, exprs));
  }
}

// Recorre una plantilla buscando tags que sean composición de otro visual (<Nombre />),
// para construir el grafo de "quién usa a quién" y detectar recursión.
function collectVisualRefs(node, visualNames, refs) {
  if (!node) return;
  if (node.type === 'if') {
    for (const b of node.branches) b.body.forEach(n => collectVisualRefs(n, visualNames, refs));
    if (node.elseBody) node.elseBody.forEach(n => collectVisualRefs(n, visualNames, refs));
    return;
  }
  if (node.type === 'for') {
    node.body.forEach(n => collectVisualRefs(n, visualNames, refs));
    return;
  }
  if (node.type === 'element') {
    if (node.tag !== 'slot' && visualNames.has(node.tag)) refs.add(node.tag);
    (node.children || []).forEach(c => collectVisualRefs(c, visualNames, refs));
  }
}

// DFS con pila de recursión para encontrar un ciclo en el grafo de visuales
// (incluye auto-referencia directa, que es un ciclo de longitud 1).
function findVisualCycle(graph) {
  const visited = new Set();
  const inStack = new Set();
  const stack = [];

  function dfs(node) {
    visited.add(node);
    inStack.add(node);
    stack.push(node);
    for (const next of graph.get(node) || []) {
      if (inStack.has(next)) {
        const idx = stack.indexOf(next);
        return stack.slice(idx).concat(next);
      }
      if (!visited.has(next)) {
        const cycle = dfs(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    inStack.delete(node);
    return null;
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      const cycle = dfs(node);
      if (cycle) return cycle;
    }
  }
  return null;
}

function validate(ast) {
  // Tipado opcional: reactive/var globales y locales (dentro de cada visual)
  for (const decl of ast.body) {
    if (decl.type === 'ReactiveDecl' || decl.type === 'VarDecl') {
      checkDeclaredType(decl, ' (global)');
    }
    if (decl.type === 'VisualDecl') {
      for (const r of decl.localReactives) checkDeclaredType(r, ` (local de visual ${decl.name})`);
      for (const v of decl.localVars) checkDeclaredType(v, ` (local de visual ${decl.name})`);
    }
  }

  // wson / server wson: si "via" es un literal de texto estático (entre comillas), debe
  // ser uno de los tres verbos soportados por ahora (destinos URL). Si es una expresión
  // dinámica (una variable, por ejemplo) no se comprueba aquí -- igual que el resto del
  // tipado opcional del proyecto, solo se valida lo que se puede comprobar en
  // compilación sin ejecutar nada.
  const ALLOWED_VIA = new Set(['POST', 'PUT', 'DELETE']);
  for (const wson of ast.body.filter(n => n.type === 'WsonDecl' || n.type === 'ServerWsonDecl')) {
    const viaField = wson.fields.find(f => f.key === 'via');
    if (!viaField) continue;
    const literalMatch = viaField.value.match(/^["'](.+)["']$/);
    if (!literalMatch) continue; // expresión dinámica, no se comprueba
    const via = literalMatch[1].toUpperCase();
    if (!ALLOWED_VIA.has(via)) {
      throw new SyntaxError(
        `"${labelFor(wson.type)} ${wson.name}" (línea ${viaField.fieldLine}) -- "via: ${JSON.stringify(literalMatch[1])}" ` +
        `no es un verbo soportado. Por ahora (destinos URL) solo se admiten "POST", "PUT" o "DELETE" -- ` +
        `email y número de teléfono como destino están pensados para más adelante, no implementados todavía.`
      );
    }
  }

  // "secret" (firma HMAC del content) y "encrypt" (cifrado AES-256-GCM, necesita
  // "secret" como clave) SOLO tienen sentido en "server wson" -- usarlos en el CLIENTE
  // sería un error de seguridad real: cualquiera con las herramientas de desarrollador
  // del navegador vería el secreto tal cual, en texto plano, en el bundle.js. Se
  // rechaza en compilación, no solo se documenta como mala práctica.
  for (const wson of ast.body.filter(n => n.type === 'WsonDecl')) {
    for (const key of ['secret', 'encrypt']) {
      const field = wson.fields.find(f => f.key === key);
      if (field) {
        throw new SyntaxError(
          `"wson ${wson.name}" (línea ${field.fieldLine}) usa "${key}" -- eso solo tiene sentido en ` +
          `"server wson", nunca en un "wson" de cliente. Un secreto en el bundle.js es visible para ` +
          `cualquiera que abra las herramientas de desarrollador del navegador -- ni siquiera está oculto, ` +
          `solo minificado (y este proyecto ni eso hace). Mueve este wson al servidor.`
        );
      }
    }
  }

  // "encrypt" sin "secret" no tiene ninguna clave con la que cifrar -- se rechaza en
  // compilación en vez de fallar en tiempo de ejecución con un mensaje críptico de
  // Node sobre una clave inválida.
  for (const wson of ast.body.filter(n => n.type === 'ServerWsonDecl')) {
    const encryptField = wson.fields.find(f => f.key === 'encrypt');
    const hasSecret = wson.fields.some(f => f.key === 'secret');
    if (encryptField && !hasSecret) {
      throw new SyntaxError(
        `"server wson ${wson.name}" (línea ${encryptField.fieldLine}) usa "encrypt" sin "secret" -- ` +
        `no hay ninguna clave con la que cifrar. Añade "-> secret: ..." también.`
      );
    }
  }

  const routeDecls = ast.body.filter(n => n.type === 'RouteDecl');
  if (routeDecls.length > 1) {
    throw new SyntaxError(
      `Solo puede haber un "route(...)" por archivo (encontrados en las líneas ${routeDecls.map(r => r.line).join(', ')}).`
    );
  }
  if (routeDecls.length === 1 && ast.body[0].type !== 'RouteDecl') {
    throw new SyntaxError(
      `"route(...)" (línea ${routeDecls[0].line}) debe ser la PRIMERA declaración del archivo.`
    );
  }

  // Como mucho una función por verbo HTTP (get/post/put/delete) por archivo -- cada
  // verbo dispara la suya propia en la URL de la ruta; nada impide tener varias a la vez.
  for (const [type, verb] of [['PostFunctionDecl', 'post'], ['PutFunctionDecl', 'put'], ['DeleteFunctionDecl', 'delete'], ['GetFunctionDecl', 'get']]) {
    const decls = ast.body.filter(n => n.type === type);
    if (decls.length > 1) {
      throw new SyntaxError(
        `Solo puede haber una "${verb} function" por archivo (encontradas en las líneas ${decls.map(f => f.line).join(', ')}).`
      );
    }
  }

  // "get function" solo tiene sentido si el archivo NO tiene render() -- si lo tiene,
  // GET ya significa "servir la página", y no hay forma sin ambigüedad de decidir si
  // una petición GET debe servir el HTML o llamar a la función. Se rechaza explícito
  // en vez de dejar que uno gane en silencio.
  const getFnDecl = ast.body.find(n => n.type === 'GetFunctionDecl');
  const renderDecl = ast.body.find(n => n.type === 'RenderCall');
  if (getFnDecl && renderDecl) {
    throw new SyntaxError(
      `"get function ${getFnDecl.name}" (línea ${getFnDecl.line}) no puede coexistir con ` +
      `"render(...)" (línea ${renderDecl.line}) en el mismo archivo -- en un archivo con ` +
      `render(), GET ya significa "servir la página". "get function" solo tiene sentido en ` +
      `una ruta "solo backend", sin render().`
    );
  }

  // watch(NOMBRE) solo tiene sentido si NOMBRE es una "server reactive" declarada en el
  // mismo archivo -- ni una "server var" normal (esas no se observan, watch no dispararía
  // nunca), ni un nombre inventado.
  const serverReactiveNamesSet = new Set(ast.body.filter(n => n.type === 'ServerReactiveDecl').map(n => n.name));
  for (const w of ast.body.filter(n => n.type === 'WatchDecl')) {
    if (!serverReactiveNamesSet.has(w.name)) {
      const asServerVar = ast.body.some(n => n.type === 'ServerVarDecl' && n.name === w.name);
      throw new SyntaxError(
        `"watch(${w.name})" (línea ${w.line}) -- "${w.name}" no es una "server reactive" ` +
        `declarada en este archivo${asServerVar ? ` (es "server var", que no se puede observar -- usa "server reactive ${w.name}" en su lugar si necesitas watch())` : ''}.`
      );
    }
  }

  // "watch(...)" DENTRO de otro bloque (server function, post/put/delete/get function, o
  // dentro de otro watch) es redundante Y roto: "watch" solo existe como construcción de
  // nivel superior del archivo -- dentro de un cuerpo de función, el texto "watch(x)" no
  // se reconoce como la construcción especial, se trata como una llamada normal a una
  // función que no existe, y revienta con un ReferenceError real en tiempo de ejecución
  // ("watch is not defined"). Redundante además: watch() ya se dispara sin importar cuál
  // función lo cambió, así que "anidarlo dentro de una función concreta" nunca añade nada
  // que declararlo a nivel de archivo no diera ya.
  const functionBodies = ast.body.filter(n =>
    n.type === 'ServerFunctionDecl' || n.type === 'PostFunctionDecl' || n.type === 'PutFunctionDecl' ||
    n.type === 'DeleteFunctionDecl' || n.type === 'GetFunctionDecl' || n.type === 'WatchDecl'
  );
  for (const fn of functionBodies) {
    const nestedWatch = fn.body.match(/\bwatch\s*\(/);
    if (nestedWatch) {
      const etiqueta = fn.type === 'WatchDecl' ? `watch(${fn.name})` : `${labelFor(fn.type)} ${fn.name}`;
      throw new SyntaxError(
        `"${etiqueta}" contiene "watch(...)" dentro de su cuerpo -- ` +
        `"watch" solo existe como declaración de NIVEL SUPERIOR del archivo, nunca dentro de otro bloque ` +
        `(función, if, for). Anidado así, ni siquiera se reconoce como la construcción especial: se trata ` +
        `como una llamada normal a una función "watch" que no existe, y reventaría con un ReferenceError en ` +
        `tiempo de ejecución. Además sería redundante -- watch(NOMBRE) a nivel de archivo YA se dispara sin ` +
        `importar cuál función cambió la variable, así que "meterlo dentro de una función concreta" no ` +
        `añadiría nada. Sácalo a nivel superior del archivo.`
      );
    }
  }

  // Las cuatro funciones HTTP (get/post/put/delete function) deben devolver algo
  // SIEMPRE -- sin esto, ahora mismo no revienta (el despachador convierte
  // "undefined" en "null" y responde 200 igualmente), pero es exactamente el tipo de
  // sorpresa silenciosa que hemos ido cerrando en todo el proyecto: el desarrollador
  // se olvida de un "return" y el cliente recibe "null" sin ningún aviso de que
  // faltaba algo. Comprobación superficial, no un análisis de flujo real: rechaza si
  // no hay NINGÚN "return" en el cuerpo, o si hay un "return" sin ningún valor (bare
  // return, que devuelve undefined explícitamente) -- no detecta el caso más sutil de
  // "algunas ramas de un if devuelven y otras no", eso necesitaría análisis de código
  // real, no una heurística de texto.
  const httpFnTypes = new Set(['GetFunctionDecl', 'PostFunctionDecl', 'PutFunctionDecl', 'DeleteFunctionDecl']);
  for (const fn of ast.body.filter(n => httpFnTypes.has(n.type))) {
    const hasAnyReturn = /\breturn\b/.test(fn.body);
    if (!hasAnyReturn) {
      throw new SyntaxError(
        `"${labelFor(fn.type)} ${fn.name}" (línea ${fn.line}) no tiene ningún "return" -- las cuatro ` +
        `funciones HTTP deben devolver siempre algo. Sin esto, el cliente recibiría "null" sin ningún ` +
        `aviso de que faltaba un valor. Añade "return { ... }" (o lo que corresponda) al final.`
      );
    }
    const hasBareReturn = /\breturn\s*(;|$)/m.test(fn.body);
    if (hasBareReturn) {
      throw new SyntaxError(
        `"${labelFor(fn.type)} ${fn.name}" (línea ${fn.line}) tiene un "return" sin ningún valor -- eso ` +
        `devuelve "undefined" explícitamente, y el cliente lo recibiría como "null" sin ningún aviso. ` +
        `Devuelve algo explícito, aunque sea "return {}" o "return null" a propósito.`
      );
    }
  }

  // Un bloque WSON ("NOMBRE =" seguido de "-> clave: valor" indentado) SOLO existe en
  // una declaración "wson"/"server wson" -- el cuerpo de cualquier función (o de un
  // watch) es texto "casi crudo" que nunca se vuelve a analizar, así que "->" ahí
  // dentro no se reconoce como WSON, se cuela tal cual en el JS generado y revienta con
  // un SyntaxError real ("Unexpected token '>'"). Se rechaza en compilación, con el
  // mismo espíritu que ya hicimos con "watch" anidado -- mejor un error claro aquí que
  // uno críptico en el bundle/server.js.
  const allFnBodies = ast.body.filter(n =>
    httpFnTypes.has(n.type) || n.type === 'ServerFunctionDecl' || n.type === 'FunctionDecl' || n.type === 'WatchDecl'
  );
  for (const fn of allFnBodies) {
    if (/^\s*->\s*(from|to|via|content)\s*:/m.test(fn.body)) {
      const etiqueta = fn.type === 'WatchDecl' ? `watch(${fn.name})` : `${labelFor(fn.type)} ${fn.name}`;
      throw new SyntaxError(
        `"${etiqueta}" contiene algo que parece un bloque WSON ("-> from/to/via/content: valor") dentro de ` +
        `su cuerpo -- eso SOLO funciona en una declaración "wson"/"server wson" de nivel superior, nunca ` +
        `dentro de una función o de un watch. Ahí dentro no se reconoce, se cuela como texto literal en el ` +
        `JS generado y revienta con un SyntaxError real. Declara el WSON aparte, a nivel superior del ` +
        `archivo ("wson NOMBRE =" / "server wson NOMBRE ="), y referencia su nombre desde aquí.`
      );
    }
  }

  // "server function" sin NINGUNA función HTTP (get/post/put/delete) en un archivo
  // que SÍ declara route() es inalcanzable de raíz: no hay ninguna de las cuatro que la
  // llame desde dentro, y un archivo con route() no se puede importar desde otro (ya
  // validado más abajo) -- así que tampoco puede llegarle una llamada desde fuera. Se
  // rechaza en vez de dejar código que nunca puede ejecutarse.
  //
  // "server var" SOLA (sin server function) NO entra en esta prohibición -- una ruta
  // "solo backend" sin ninguna función HTTP sigue sirviendo su estado por GET (el
  // volcado por defecto, ver "WebScript como backend puro"), así que sigue siendo útil.
  //
  // Un archivo SIN route() (una librería pensada para "import", como "compartido.ws")
  // queda fuera de esta comprobación -- ahí "server function" sin llamador propio es
  // exactamente el patrón esperado: espera a que otro archivo la importe y la use.
  if (routeDecls.length > 0 && !renderDecl) {
    const serverFnDecls = ast.body.filter(n => n.type === 'ServerFunctionDecl');
    const hasHttpFn = ast.body.some(n =>
      n.type === 'GetFunctionDecl' || n.type === 'PostFunctionDecl' ||
      n.type === 'PutFunctionDecl' || n.type === 'DeleteFunctionDecl'
    );
    if (serverFnDecls.length > 0 && !hasHttpFn) {
      throw new SyntaxError(
        `"server function ${serverFnDecls[0].name}" (línea ${serverFnDecls[0].line}) es ` +
        `inalcanzable: este archivo declara route(...) pero no tiene ninguna función HTTP ` +
        `(get/post/put/delete function) que pueda llamarla, y un archivo con route() no se ` +
        `puede importar desde otro. Añade al menos una función HTTP, o quita route(...) si ` +
        `esto es en realidad una librería pensada para "import" (ahí sí es un patrón válido).`
      );
    }

    // "reactive"/"var"/"function" (CLIENTE) en una ruta "solo backend" (route() sin
    // render()) son inertes: su código compilado (bundle.js) NUNCA se escribe a disco
    // ahí -- se descarta entero, siempre. Si algo del servidor las referencia (post/put/
    // delete/get/server function, watch), revienta con un ReferenceError real (el nombre
    // no existe en server.js, solo se compiló -- y se tiró -- al lado de cliente); si
    // nadie las referencia, son código muerto sin ningún efecto. Mismo criterio que
    // "server function inalcanzable": se rechaza en compilación en vez de fallar en silencio.
    const clientDecls = ast.body.filter(n => n.type === 'ReactiveDecl' || n.type === 'VarDecl' || n.type === 'FunctionDecl' || n.type === 'WsonDecl');
    if (clientDecls.length > 0) {
      const first = clientDecls[0];
      const alternativa = first.type === 'FunctionDecl'
        ? `"server function ${first.name}"`
        : first.type === 'WsonDecl'
          ? `"server wson ${first.name}"`
          : `"server var ${first.name}"/"server reactive ${first.name}"`;
      throw new SyntaxError(
        `"${labelFor(first.type)} ${first.name}" (línea ${first.line}) no tiene ningún efecto: ` +
        `este archivo declara route(...) pero no render(...), así que es una ruta "solo backend" -- ` +
        `su código de cliente (bundle.js) nunca se escribe a disco, se descarta entero. Si esto es ` +
        `del servidor, usa ${alternativa} en su lugar; si el archivo debería tener página, añade un ` +
        `"visual" y "render(...)".`
      );
    }
  }

  const globalDecls = ast.body.filter(n => SHARED_NAMESPACE.has(n.type) || n.type === 'StyleDecl');

  const seenShared = new Map(); // name -> { type, line }
  const seenStyles = new Map(); // name -> { line }

  for (const decl of globalDecls) {
    if (decl.type === 'StyleDecl') {
      if (seenStyles.has(decl.name)) {
        const prev = seenStyles.get(decl.name);
        throw new SyntaxError(
          `Nombre duplicado "${decl.name}": ya hay un style con ese nombre en la línea ${prev.line}, ` +
          `y se repite en la línea ${decl.line}. Los nombres de style deben ser únicos entre sí.`
        );
      }
      seenStyles.set(decl.name, { line: decl.line });
      continue;
    }

    if (seenShared.has(decl.name)) {
      const prev = seenShared.get(decl.name);
      throw new SyntaxError(
        `Nombre duplicado "${decl.name}": ya se declaró como ${labelFor(prev.type)} en la línea ${prev.line}, ` +
        `y se vuelve a declarar como ${labelFor(decl.type)} en la línea ${decl.line}. ` +
        `Los nombres de reactive, var, visual, server var y server function deben ser únicos entre sí en todo el archivo.`
      );
    }
    seenShared.set(decl.name, { type: decl.type, line: decl.line });
  }

  // Recursión entre visuales: A no puede referenciarse a sí mismo (directa o
  // indirectamente vía B, C...). Se construye el grafo "quién usa a quién" recorriendo
  // cada plantilla en busca de tags-componente, y se busca un ciclo con DFS.
  const allVisuals = ast.body.filter(n => n.type === 'VisualDecl');
  const visualNameSet = new Set(allVisuals.map(v => v.name));
  const visualGraph = new Map();
  for (const v of allVisuals) {
    const refs = new Set();
    collectVisualRefs(v.template, visualNameSet, refs);
    visualGraph.set(v.name, refs);
  }
  const cycle = findVisualCycle(visualGraph);
  if (cycle) {
    if (cycle.length === 2 && cycle[0] === cycle[1]) {
      throw new SyntaxError(`"visual ${cycle[0]}" se referencia a sí mismo (<${cycle[0]} /> dentro de su propia plantilla) -- eso genera un bucle infinito al renderizar.`);
    }
    throw new SyntaxError(`Recursión entre visuales detectada: ${cycle.join(' -> ')} -- eso genera un bucle infinito al renderizar.`);
  }

  // Locales dentro de cada visual (sin cambios respecto a antes)
  for (const v of ast.body.filter(n => n.type === 'VisualDecl')) {
    const localSeen = new Map();
    const localDecls = [
      ...v.localReactives.map(r => ({ ...r, kind: 'reactive' })),
      ...v.localVars.map(r => ({ ...r, kind: 'var' })),
    ];
    for (const decl of localDecls) {
      if (localSeen.has(decl.name)) {
        const prev = localSeen.get(decl.name);
        throw new SyntaxError(
          `Nombre duplicado "${decl.name}" dentro de "visual ${v.name}": ya se declaró como ${prev.kind} ` +
          `en la línea ${prev.line}, y se vuelve a declarar como ${decl.kind} en la línea ${decl.line}. ` +
          `Las "reactive"/"var" locales de un mismo visual deben ser únicas entre sí.`
        );
      }
      localSeen.set(decl.name, decl);
    }
  }

  // "server var" y "server function" NUNCA pueden usarse dentro de un visual (ni en su
  // plantilla, ni en sus bindings/handlers, ni en sus reactive/var locales) -- eso
  // implicaría exponerlos al cliente, que es justo lo que "server" prohíbe. ("post function"
  // es la única excepción: esa SÍ se puede llamar desde un visual, es su razón de ser.)
  const serverNames = ast.body
    .filter(n => n.type === 'ServerVarDecl' || n.type === 'ServerReactiveDecl' || n.type === 'ServerFunctionDecl' || n.type === 'ServerWsonDecl')
    .map(n => n.name);
  const serverNameKind = new Map(
    ast.body
      .filter(n => n.type === 'ServerVarDecl' || n.type === 'ServerReactiveDecl' || n.type === 'ServerFunctionDecl' || n.type === 'ServerWsonDecl')
      .map(n => [n.name, labelFor(n.type)])
  );

  if (serverNames.length > 0) {
    for (const v of ast.body.filter(n => n.type === 'VisualDecl')) {
      const exprs = [];
      collectTemplateExprs(v.template, exprs);
      for (const r of v.localReactives) exprs.push(r.init);
      for (const vr of v.localVars) exprs.push(vr.init);

      for (const expr of exprs) {
        for (const serverName of serverNames) {
          if (referencesName(expr, serverName)) {
            throw new SyntaxError(
              `"visual ${v.name}" referencia "${serverName}", que es "${serverNameKind.get(serverName)}". ` +
              `No puede usarse dentro de ningún visual -- eso lo expondría al cliente en bundle.js, ` +
              `exactamente lo que "server" prohíbe. (La excepción es "post function", que sí se puede llamar.)`
            );
          }
        }
      }
    }

    // El mismo hueco existía en el valor inicial de una "reactive"/"var" GLOBAL (fuera
    // de cualquier visual) -- "reactive x = contador" (a secas, sin "server.") compilaba
    // sin ningún aviso y explotaba en el navegador con un ReferenceError real, porque
    // "contador" (server var) nunca llega al bundle.js. La forma correcta ya existía
    // (server.NOMBRE, que "referencesName" excluye correctamente por el punto delante),
    // pero nadie avisaba si se te olvidaba. Se aplica igual tanto si la "server var" es
    // local como si llegó por "import" -- en ambos casos es el mismo AST, misma regla.
    for (const decl of ast.body.filter(n => n.type === 'ReactiveDecl' || n.type === 'VarDecl')) {
      for (const serverName of serverNames) {
        if (referencesName(decl.init, serverName)) {
          throw new SyntaxError(
            `"${labelFor(decl.type)} ${decl.name}" (línea ${decl.line}) referencia "${serverName}", que es ` +
            `"${serverNameKind.get(serverName)}" -- eso nunca llega al bundle.js, así que fallaría en el ` +
            `navegador con un ReferenceError real. Usa "server.${serverName}" en su lugar (la forma correcta ` +
            `de leer una server var/reactive desde el cliente).`
          );
        }
      }
    }

    // Mismo hueco, pero en los CAMPOS de un "wson" de cliente (from/to/via/content son
    // expresiones normales, con el mismo riesgo que el init de una reactive/var).
    for (const wson of ast.body.filter(n => n.type === 'WsonDecl')) {
      for (const field of wson.fields) {
        for (const serverName of serverNames) {
          if (referencesName(field.value, serverName)) {
            throw new SyntaxError(
              `"wson ${wson.name}" (línea ${field.fieldLine}, campo "${field.key}") referencia "${serverName}", ` +
              `que es "${serverNameKind.get(serverName)}" -- eso nunca llega al bundle.js, así que fallaría en ` +
              `el navegador con un ReferenceError real. Usa "server.${serverName}" en su lugar.`
            );
          }
        }
      }
    }
  }

  // "updateServer" ya no existe -- se unificó con "post function" (ver README). Se
  // detecta explícitamente para dar un error útil en vez de un ReferenceError críptico
  // en el navegador si alguien lo escribe por costumbre.
  for (const v of ast.body.filter(n => n.type === 'VisualDecl')) {
    const exprs = [];
    collectTemplateExprs(v.template, exprs);
    for (const expr of exprs) {
      if (/\bupdateServer\s*\(/.test(expr)) {
        throw new SyntaxError(
          `"visual ${v.name}" usa "updateServer(...)", que ya no existe -- se unificó con ` +
          `"post function". Declara una "post function" que actualice la(s) "server var" que ` +
          `necesites y llámala igual que llamarías a "updateServer".`
        );
      }
    }
  }
}

module.exports = { validate };
