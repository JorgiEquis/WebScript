const { parseVisualTemplate } = require('./template-parser');
const { validate } = require('./validate');
const fs = require('fs');
const path = require('path');

// Recolecta las líneas del cuerpo de un bloque (post/put/delete/get/server function,
// watch...) preservando la indentación RELATIVA interna -- para que el código
// generado (server.js) siga siendo legible, con sus propios if/for anidados
// correctamente sangrados, en vez de aplanar todo a una sola columna con .trim().
// No afecta a la corrección (JS no depende de la indentación para nada), solo a que
// el archivo generado se pueda leer de verdad.
function collectIndentedBody(lines, startIdx, baseIndent) {
  let j = startIdx;
  const bodyLines = [];
  let bodyBaseIndent = null;
  while (j < lines.length) {
    if (isBlank(lines[j])) { j++; continue; }
    if (lines[j].indent <= baseIndent) break;
    if (bodyBaseIndent === null) bodyBaseIndent = lines[j].indent;
    const extra = Math.max(0, lines[j].indent - bodyBaseIndent);
    bodyLines.push(' '.repeat(extra) + lines[j].text.trim());
    j++;
  }
  return { bodyLines, next: j };
}

function getIndent(line) {
  const match = line.match(/^(\s*)/);
  return match[1].replace(/\t/g, '    ').length;
}

function preprocess(source) {
  return source
    .split('\n')
    .map((text, idx) => ({ text, indent: getIndent(text), num: idx + 1 }))
    .filter((l, idx, arr) => true); // keep all; blank handling done during parsing
}

function isBlank(line) {
  return line.text.trim() === '';
}

function getIndent(line) {
  const match = line.match(/^(\s*)/);
  return match[1].replace(/\t/g, '    ').length;
}

function preprocess(source) {
  return source
    .split('\n')
    .map((text, idx) => ({ text, indent: getIndent(text), num: idx + 1 }))
    .filter((l, idx, arr) => true); // keep all; blank handling done during parsing
}

function isBlank(line) {
  return line.text.trim() === '';
}

// filePath: necesaria para resolver imports relativos ("./compartido.ws"). Si se omite
// y el archivo no tiene ningún import, no pasa nada. Si tiene imports sin filePath,
// error claro en vez de fallar de forma rara más adelante.
// resolving: Set interno para detectar imports circulares (A importa B importa A).
function parseProgram(source, filePath = null, resolving = new Set()) {
  const lines = preprocess(source);
  const body = [];
  let i = 0;

  while (i < lines.length) {
    if (isBlank(lines[i])) { i++; continue; }
    const trimmed = lines[i].text.trim();

    // Comentario de línea completa -- "//" tiene que ser lo primero en la línea
    // (no se soporta comentario al final de una línea con código, para no arriesgarse
    // a comerse un "//" que forme parte de una URL u otra cadena dentro de una expresión).
    if (trimmed.startsWith('//')) { i++; continue; }

    if (trimmed.startsWith('import ') || trimmed.startsWith('import{')) {
      const r = parseImport(lines, i);
      body.push(r.node);
      i = r.next;
    } else if (trimmed.startsWith('route(')) {
      const r = parseRoute(lines, i);
      body.push(r.node);
      i = r.next;
    } else if (trimmed.startsWith('post function ')) {
      const r = parsePostFunction(lines, i);
      body.push(r.node);
      i = r.next;
    } else if (trimmed.startsWith('put function ')) {
      const r = parsePutFunction(lines, i);
      body.push(r.node);
      i = r.next;
    } else if (trimmed.startsWith('delete function ')) {
      const r = parseDeleteFunction(lines, i);
      body.push(r.node);
      i = r.next;
    } else if (trimmed.startsWith('get function ')) {
      const r = parseGetFunction(lines, i);
      body.push(r.node);
      i = r.next;
    } else if (trimmed.startsWith('async server function ')) {
      const r = parseServerFunction(lines, i, true);
      body.push(r.node);
      i = r.next;
    } else if (trimmed.startsWith('server function ')) {
      const r = parseServerFunction(lines, i, false);
      body.push(r.node);
      i = r.next;
    } else if (trimmed.startsWith('server wson ')) {
      const r = parseWson(lines, i, true);
      body.push(r.node);
      i = r.next;
    } else if (trimmed.startsWith('server ')) {
      const r = parseServerDecl(lines, i);
      body.push(r.node);
      i = r.next;
    } else if (trimmed.startsWith('watch(')) {
      const r = parseWatch(lines, i);
      body.push(r.node);
      i = r.next;
    } else if (trimmed.startsWith('reactive ')) {
      const r = parseReactive(lines, i);
      body.push(r.node);
      i = r.next;
    } else if (trimmed.startsWith('var ')) {
      const r = parseVarDecl(lines, i);
      body.push(r.node);
      i = r.next;
    } else if (trimmed.startsWith('async function ')) {
      const r = parseFunctionDecl(lines, i, true);
      body.push(r.node);
      i = r.next;
    } else if (trimmed.startsWith('function ')) {
      const r = parseFunctionDecl(lines, i, false);
      body.push(r.node);
      i = r.next;
    } else if (trimmed.startsWith('wson ')) {
      const r = parseWson(lines, i, false);
      body.push(r.node);
      i = r.next;
    } else if (trimmed.startsWith('style ')) {
      const r = parseStyle(lines, i);
      body.push(r.node);
      i = r.next;
    } else if (trimmed.startsWith('visual ')) {
      const r = parseVisual(lines, i);
      body.push(r.node);
      i = r.next;
    } else if (trimmed.startsWith('render(') || trimmed === 'render(') {
      const r = parseRender(lines, i);
      body.push(r.node);
      i = r.next;
    } else {
      throw new SyntaxError(`Línea ${lines[i].num}: no se reconoce la instrucción -> "${lines[i].text}"`);
    }
  }

  const resolvedBody = resolveImports(body, filePath, resolving);
  const program = { type: 'Program', body: resolvedBody };
  validate(program);
  return program;
}

// import { nombre1, nombre2 } from "./archivo.ws"
function parseImport(lines, i) {
  const m = lines[i].text.trim().match(/^import\s*\{\s*([^}]*)\}\s*from\s*["']([^"']+)["']\s*$/);
  if (!m) throw new SyntaxError(`Línea ${lines[i].num}: se esperaba import { nombre1, nombre2 } from "./archivo.ws"`);
  const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
  if (names.length === 0) {
    throw new SyntaxError(`Línea ${lines[i].num}: import sin ningún nombre -- import { algo } from "..."`);
  }
  return { node: { type: 'ImportDecl', names, source: m[2], line: lines[i].num }, next: i + 1 };
}

// Sustituye cada ImportDecl por los nodos reales que importa, leídos y parseados del
// archivo indicado. El archivo importado NO puede tener route() ni render() -- eso lo
// convertiría en una página, no en un almacén compartido de declaraciones.
// Extrae el texto de código de un nodo (para buscar qué otros nombres referencia) --
// una declaración con "init" (reactive/var/server var/server reactive), o con "body"
// (cualquier función, o un watch).
function getCodeText(node) {
  if (node.init !== undefined) return node.init;
  if (node.body !== undefined) return node.body;
  return '';
}

// Comprobación simple de "¿aparece este nombre como identificador suelto en este
// código?" -- deliberadamente permisiva (puede dar algún falso positivo, ej. dentro de
// un comentario o una cadena) porque aquí un falso positivo es inofensivo (se
// importaría una dependencia de más, sin efecto), mientras que un falso NEGATIVO
// causaría un ReferenceError real al compilar.
function referencesIdentifierLoosely(code, name) {
  const re = new RegExp(`(?<![\\w$])(?<![^.]\\.)${name}(?![\\w$])`);
  return re.test(code);
}

function resolveImports(body, filePath, resolving) {
  const hasImports = body.some(n => n.type === 'ImportDecl');
  if (!hasImports) return body;

  if (!filePath) {
    throw new SyntaxError(
      `Hay "import" en el archivo pero no se conoce su ruta -- parseProgram(source, filePath) ` +
      `necesita el segundo argumento para resolver imports relativos.`
    );
  }

  const result = [];
  for (const node of body) {
    if (node.type !== 'ImportDecl') { result.push(node); continue; }

    const targetPath = path.resolve(path.dirname(filePath), node.source);
    if (resolving.has(targetPath)) {
      throw new SyntaxError(
        `Línea ${node.line}: import circular -- "${targetPath}" ya se estaba resolviendo ` +
        `(probablemente A importa B que importa A, directa o indirectamente).`
      );
    }
    if (!fs.existsSync(targetPath)) {
      throw new SyntaxError(`Línea ${node.line}: no se encuentra el archivo importado "${node.source}" (resuelto a "${targetPath}").`);
    }

    const importedSource = fs.readFileSync(targetPath, 'utf8');
    const importedAst = parseProgram(importedSource, targetPath, new Set([...resolving, targetPath]));

    if (importedAst.body.some(n => n.type === 'RouteDecl')) {
      throw new SyntaxError(`Línea ${node.line}: no puedes importar "${node.source}" -- tiene route(...), es una página, no un almacén compartido.`);
    }
    if (importedAst.body.some(n => n.type === 'RenderCall')) {
      throw new SyntaxError(`Línea ${node.line}: no puedes importar "${node.source}" -- tiene render(...), es una página, no un almacén compartido.`);
    }

    // "watch" no participa en el mapa por nombre para pedirlo EXPLÍCITAMENTE (no es una
    // declaración con nombre propio, observa una variable ajena) -- pero si esa
    // variable se importa (directa o transitivamente), su(s) watch() deben venir con
    // ella, o si no el comportamiento cambiaría en silencio entre usarla localmente en
    // "otro.ws" y usarla vía import en este archivo.
    const byName = new Map(importedAst.body.filter(n => n.name && n.type !== 'WatchDecl').map(n => [n.name, n]));
    const watchesByVarName = new Map();
    for (const n of importedAst.body) {
      if (n.type !== 'WatchDecl') continue;
      if (!watchesByVarName.has(n.name)) watchesByVarName.set(n.name, []);
      watchesByVarName.get(n.name).push(n);
    }

    const included = new Set();
    const orderedIncluded = [];

    function includeTransitively(depNode) {
      if (included.has(depNode)) return;
      included.add(depNode);
      orderedIncluded.push(depNode);

      if (depNode.type === 'ServerReactiveDecl' && watchesByVarName.has(depNode.name)) {
        for (const w of watchesByVarName.get(depNode.name)) {
          if (included.has(w)) continue;
          included.add(w);
          orderedIncluded.push(w);
          scanAndInclude(w);
        }
      }
      scanAndInclude(depNode);
    }

    function scanAndInclude(depNode) {
      const code = getCodeText(depNode);
      if (!code) return;
      for (const [candidateName, candidateNode] of byName) {
        if (candidateNode === depNode) continue;
        if (referencesIdentifierLoosely(code, candidateName)) {
          includeTransitively(candidateNode);
        }
      }
    }

    for (const wanted of node.names) {
      const found = byName.get(wanted);
      if (!found) {
        const disponibles = [...byName.keys()].join(', ') || '(ninguno)';
        throw new SyntaxError(
          `Línea ${node.line}: "${wanted}" no existe en "${node.source}". Disponibles ahí: ${disponibles}.`
        );
      }
      includeTransitively(found);
    }

    result.push(...orderedIncluded);
  }
  return result;
}


// route("/ruta") -- declara qué URL sirve este archivo. Debe ser la PRIMERA
// declaración del archivo (se valida en validate.js).
function parseRoute(lines, i) {
  const m = lines[i].text.trim().match(/^route\(\s*["']([^"']*)["']\s*\)\s*$/);
  if (!m) throw new SyntaxError(`Línea ${lines[i].num}: se esperaba route("/ruta")`);
  const routePath = m[1];
  if (!routePath.startsWith('/')) {
    throw new SyntaxError(`Línea ${lines[i].num}: la ruta debe empezar con "/", recibido "${routePath}"`);
  }
  return { node: { type: 'RouteDecl', path: routePath, line: lines[i].num }, next: i + 1 };
}

// reactive [tipo] NAME = EXPR -- el tipo (string/number/boolean) es OPCIONAL, y solo
// se comprueba de forma superficial (ver validate.js): si el valor inicial es un
// literal simple y no coincide, error; si es una expresión compleja, no se valida.
// Intenta reconocer un bloque WSON: "NOMBRE =" (sin nada más en esa línea) seguido de
// líneas indentadas "-> clave: valor". A diferencia de "style" (cuyas propiedades son
// texto CSS literal, sin sustitución), aquí cada "valor" es una expresión JS de verdad
// -- pasa por el mismo motor de sustitución que cualquier otra expresión del lenguaje.
// Se compila sintetizando un objeto literal ("{ clave: valor, ... }") como si fuera el
// valor inicial normal de un reactive/var -- no hace falta ningún nodo de AST nuevo,
// ni tratamiento especial en el compilador: para todo lo demás, es una reactive/var
// cualquiera cuyo valor inicial resulta ser un objeto.
// Devuelve null si esta línea no es un bloque WSON (para que el llamador siga con el
// parseo normal de una sola línea).
function tryParseWsonBlock(lines, i, headerRe) {
  const header = lines[i].text.trim().match(headerRe);
  if (!header) return null;
  const baseIndent = lines[i].indent;

  let j = i + 1;
  const props = [];
  while (j < lines.length) {
    if (isBlank(lines[j])) { j++; continue; }
    if (lines[j].indent <= baseIndent) break;
    const t = lines[j].text.trim();
    if (!t.startsWith('->')) break;
    const propMatch = t.slice(2).trim().match(/^([A-Za-z_$][\w$]*)\s*:\s*(.+)$/);
    if (!propMatch) throw new SyntaxError(`Línea ${lines[j].num}: propiedad WSON inválida -> "${t}"`);
    props.push(`${propMatch[1].trim()}: ${propMatch[2].trim()}`);
    j++;
  }

  if (props.length === 0) return null; // "NOMBRE =" sin nada detrás NI -> debajo -- no es WSON, es un error normal de "falta el valor"

  return { header, init: `{ ${props.join(', ')} }`, next: j };
}

function parseReactive(lines, i) {
  const headerRe = /^reactive\s+(?:(string|number|boolean)\s+)?([A-Za-z_$][\w$]*)\s*=\s*$/;
  const wson = tryParseWsonBlock(lines, i, headerRe);
  if (wson) {
    return {
      node: { type: 'ReactiveDecl', name: wson.header[2], init: wson.init, varType: wson.header[1] || null, line: lines[i].num },
      next: wson.next,
    };
  }
  const m = lines[i].text.trim().match(/^reactive\s+(?:(string|number|boolean)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(.+)$/);
  if (!m) throw new SyntaxError(`Línea ${lines[i].num}: se esperaba "reactive [tipo] NOMBRE = valor"`);
  return {
    node: { type: 'ReactiveDecl', name: m[2], init: m[3].trim(), varType: m[1] || null, line: lines[i].num },
    next: i + 1,
  };
}

// var [tipo] NAME = EXPR -- NO reactivo: se calcula una sola vez, no re-renderiza nada
// al cambiar. Mismo tipado opcional que "reactive".
function parseVarDecl(lines, i) {
  const headerRe = /^var\s+(?:(string|number|boolean)\s+)?([A-Za-z_$][\w$]*)\s*=\s*$/;
  const wson = tryParseWsonBlock(lines, i, headerRe);
  if (wson) {
    return {
      node: { type: 'VarDecl', name: wson.header[2], init: wson.init, varType: wson.header[1] || null, line: lines[i].num },
      next: wson.next,
    };
  }
  const m = lines[i].text.trim().match(/^var\s+(?:(string|number|boolean)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(.+)$/);
  if (!m) throw new SyntaxError(`Línea ${lines[i].num}: se esperaba "var [tipo] NOMBRE = valor"`);
  return {
    node: { type: 'VarDecl', name: m[2], init: m[3].trim(), varType: m[1] || null, line: lines[i].num },
    next: i + 1,
  };
}

// post/put/delete function NOMBRE(args)
//     cuerpo...
// SOLO corre en el servidor, disparado por una petición HTTP con el verbo
// correspondiente (POST/PUT/DELETE) a la URL de la propia ruta. Dentro del cuerpo,
// las server var del mismo archivo se leen/escriben directamente, sin prefijo.
// Puede haber una de CADA verbo por archivo (post + put + delete a la vez, cada una
// disparada por su propio verbo en la misma URL).
function parseHttpMethodFunction(lines, i, keyword, nodeType) {
  const re = new RegExp(`^${keyword}\\s+function\\s+([A-Za-z_$][\\w$]*)\\s*\\(\\s*([^)]*)\\)\\s*$`);
  const header = lines[i].text.trim().match(re);
  if (!header) throw new SyntaxError(`Línea ${lines[i].num}: se esperaba "${keyword} function NOMBRE(args)"`);
  const [, name, params] = header;
  const baseIndent = lines[i].indent;

  const { bodyLines, next: j } = collectIndentedBody(lines, i + 1, baseIndent);

  return {
    node: { type: nodeType, name, params: params.trim(), body: bodyLines.join('\n'), line: lines[i].num },
    next: j,
  };
}

function parsePostFunction(lines, i) {
  return parseHttpMethodFunction(lines, i, 'post', 'PostFunctionDecl');
}
function parsePutFunction(lines, i) {
  return parseHttpMethodFunction(lines, i, 'put', 'PutFunctionDecl');
}
function parseDeleteFunction(lines, i) {
  return parseHttpMethodFunction(lines, i, 'delete', 'DeleteFunctionDecl');
}
function parseGetFunction(lines, i) {
  return parseHttpMethodFunction(lines, i, 'get', 'GetFunctionDecl');
}

// function NOMBRE(params)
//     cuerpo...
// Helper de CLIENTE con cuerpo en varias líneas -- lo que "var NOMBRE = (params) => valor"
// no puede dar, porque el valor de un "var" tiene que caber en una sola línea. Es el
// equivalente cliente de "server function": mismo cuerpo indentado, misma idea, pero
// compila a bundle.js en vez de server.js. Puede llamarse desde cualquier handler o
// desde el valor inicial de otra reactive/var (las funciones en JS quedan "hoisted",
// así que el orden de declaración no importa).
// function NOMBRE(params) / async function NOMBRE(params)
//     cuerpo...
// "async" es OPCIONAL: por defecto (sin él) sigue siendo síncrona, exactamente como
// antes -- necesario porque llamarla SIN "await" esperando su valor de vuelta directo
// es un patrón ya en uso (ej. "duplicar(contador)"), y si fuera async siempre, ese
// valor pasaría a ser una Promise en vez del valor real. Con "async" delante, sí puede
// usar "await" dentro (fetch, u otra dependencia asíncrona) -- a cambio, quien la llame
// tiene que usar "await" también, o recibirá una Promise en vez del valor.
function parseFunctionDecl(lines, i, isAsync) {
  const re = isAsync
    ? /^async\s+function\s+([A-Za-z_$][\w$]*)\s*\(\s*([^)]*)\)\s*$/
    : /^function\s+([A-Za-z_$][\w$]*)\s*\(\s*([^)]*)\)\s*$/;
  const header = lines[i].text.trim().match(re);
  if (!header) throw new SyntaxError(`Línea ${lines[i].num}: se esperaba "${isAsync ? 'async ' : ''}function NOMBRE(params)"`);
  const [, name, params] = header;
  const baseIndent = lines[i].indent;

  const { bodyLines, next: j } = collectIndentedBody(lines, i + 1, baseIndent);

  return {
    node: { type: 'FunctionDecl', name, params: params.trim(), body: bodyLines.join('\n'), isAsync: !!isAsync, line: lines[i].num },
    next: j,
  };
}

// server function NOMBRE(params)
//     cuerpo...
// Helper de servidor NORMAL -- puede haber varias por archivo, y a diferencia de
// "post function" nunca se expone al cliente: no genera stub, no tiene endpoint HTTP
// propio, y está prohibida en cualquier "visual" (igual que server var). Solo es
// llamable desde otro código de servidor -- típicamente desde dentro de una
// "post function" del mismo archivo.
function parseServerFunction(lines, i, isAsync) {
  const re = isAsync
    ? /^async\s+server\s+function\s+([A-Za-z_$][\w$]*)\s*\(\s*([^)]*)\)\s*$/
    : /^server\s+function\s+([A-Za-z_$][\w$]*)\s*\(\s*([^)]*)\)\s*$/;
  const header = lines[i].text.trim().match(re);
  if (!header) throw new SyntaxError(`Línea ${lines[i].num}: se esperaba "${isAsync ? 'async ' : ''}server function NOMBRE(params)"`);
  const [, name, params] = header;
  const baseIndent = lines[i].indent;

  const { bodyLines, next: j } = collectIndentedBody(lines, i + 1, baseIndent);

  return {
    node: { type: 'ServerFunctionDecl', name, params: params.trim(), body: bodyLines.join('\n'), isAsync: !!isAsync, line: lines[i].num },
    next: j,
  };
}

// server var NAME [= EXPR]
// SOLO existe en el servidor: nunca se compila a bundle.js, y no puede referenciarse
// desde ningún "visual" (eso se valida aparte, en validate.js). El valor inicial es
// opcional -- sin "= valor" arranca en undefined, igual que un "let" normal de JS.
//
// server reactive NAME [= EXPR]
// Igual que "server var", pero ADEMÁS puede observarse con watch(NOMBRE) -- ver más
// abajo. (Existió antes como sinónimo puro de "server var", sin ninguna diferencia de
// comportamiento, y se quitó por eso. Ahora watch() le da un propósito real: solo las
// declaradas "reactive" pueden observarse.)
function parseServerDecl(lines, i) {
  const t = lines[i].text.trim();

  const reactiveWsonRe = /^server\s+reactive\s+([A-Za-z_$][\w$]*)\s*=\s*$/;
  const wsonReactive = tryParseWsonBlock(lines, i, reactiveWsonRe);
  if (wsonReactive) {
    return {
      node: { type: 'ServerReactiveDecl', name: wsonReactive.header[1], init: wsonReactive.init, line: lines[i].num },
      next: wsonReactive.next,
    };
  }
  const varWsonRe = /^server\s+var\s+([A-Za-z_$][\w$]*)\s*=\s*$/;
  const wsonVar = tryParseWsonBlock(lines, i, varWsonRe);
  if (wsonVar) {
    return {
      node: { type: 'ServerVarDecl', name: wsonVar.header[1], init: wsonVar.init, line: lines[i].num },
      next: wsonVar.next,
    };
  }

  const reactiveMatch = t.match(/^server\s+reactive\s+([A-Za-z_$][\w$]*)\s*(?:=\s*(.+))?$/);
  if (reactiveMatch) {
    const [, name, init] = reactiveMatch;
    return {
      node: {
        type: 'ServerReactiveDecl',
        name,
        init: init ? init.trim() : 'undefined',
        line: lines[i].num,
      },
      next: i + 1,
    };
  }
  const m = t.match(/^server\s+var\s+([A-Za-z_$][\w$]*)\s*(?:=\s*(.+))?$/);
  if (!m) throw new SyntaxError(`Línea ${lines[i].num}: se esperaba "server var NOMBRE" o "server reactive NOMBRE" (con o sin "= valor")`);
  const [, name, init] = m;
  return {
    node: {
      type: 'ServerVarDecl',
      name,
      init: init ? init.trim() : 'undefined',
      line: lines[i].num,
    },
    next: i + 1,
  };
}

// watch(NOMBRE)
//     cuerpo...
// Corre en el SERVIDOR cuando "NOMBRE" (una "server reactive") cambia de valor -- NUNCA
// con el valor inicial, solo en cambios POSTERIORES (a diferencia de un "effect" del
// cliente, que sí corre inmediatamente al registrarse). Se dispara sin importar cuál
// get/post/put/delete function fue la que cambió la variable -- se declara una vez, a
// nivel de archivo, y aplica a todas.
function parseWatch(lines, i) {
  const header = lines[i].text.trim().match(/^watch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*$/);
  if (!header) throw new SyntaxError(`Línea ${lines[i].num}: se esperaba "watch(NOMBRE)"`);
  const [, name] = header;
  const baseIndent = lines[i].indent;

  const { bodyLines, next: j } = collectIndentedBody(lines, i + 1, baseIndent);

  return {
    node: { type: 'WatchDecl', name, body: bodyLines.join('\n'), line: lines[i].num },
    next: j,
  };
}

// style NAME =
//   -> prop: value
function parseStyle(lines, i) {
  const header = lines[i].text.trim().match(/^style\s+([A-Za-z_$][\w$-]*)\s*=\s*$/);
  if (!header) throw new SyntaxError(`Línea ${lines[i].num}: se esperaba "style NOMBRE ="`);
  const baseIndent = lines[i].indent;
  const name = header[1];
  const props = [];

  let j = i + 1;
  while (j < lines.length) {
    if (isBlank(lines[j])) { j++; continue; }
    if (lines[j].indent <= baseIndent) break;
    const t = lines[j].text.trim();
    if (!t.startsWith('->')) break;
    const propMatch = t.slice(2).trim().match(/^([A-Za-z-]+)\s*:\s*(.+)$/);
    if (!propMatch) throw new SyntaxError(`Línea ${lines[j].num}: propiedad de estilo inválida -> "${t}"`);
    props.push({ prop: propMatch[1].trim(), value: propMatch[2].trim() });
    j++;
  }

  return { node: { type: 'StyleDecl', name, props, line: lines[i].num }, next: j };
}

// wson NOMBRE = / server wson NOMBRE =
//     -> from: expr        (opcional -- mensaje anónimo si se omite)
//     -> to: expr           (obligatorio -- URL, o más adelante email/teléfono)
//     -> via: expr          (opcional -- "POST" por defecto; también admite "PUT"/"DELETE")
//     -> content: expr      (obligatorio -- el payload del mensaje)
// WSON es solo una ESTRUCTURA DE DATOS -- declararla nunca envía nada por sí sola, hace
// falta llamar a WSON.send(nombre) explícitamente. Mismo patrón exacto que "style"
// (cabecera con "=" vacío, bindings "->" indentados debajo), reutilizado a propósito
// para quedar consistente con el resto del lenguaje -- no una sintaxis nueva de cero.
function parseWson(lines, i, isServer) {
  const keyword = isServer ? 'server\\s+wson' : 'wson';
  const header = lines[i].text.trim().match(new RegExp(`^${keyword}\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*$`));
  if (!header) throw new SyntaxError(`Línea ${lines[i].num}: se esperaba "${isServer ? 'server ' : ''}wson NOMBRE ="`);
  const baseIndent = lines[i].indent;
  const name = header[1];
  const fields = [];

  let j = i + 1;
  while (j < lines.length) {
    if (isBlank(lines[j])) { j++; continue; }
    if (lines[j].indent <= baseIndent) break;
    const t = lines[j].text.trim();
    if (!t.startsWith('->')) break;
    const fieldMatch = t.slice(2).trim().match(/^(from|to|via|content|secret|encrypt|id|retries|retryDelayMs)\s*:\s*(.+)$/);
    if (!fieldMatch) {
      throw new SyntaxError(
        `Línea ${lines[j].num}: campo de WSON inválido -> "${t}" -- las únicas claves ` +
        `válidas son "from", "to", "via", "content", "secret", "encrypt", "id", "retries" y "retryDelayMs".`
      );
    }
    fields.push({ key: fieldMatch[1].trim(), value: fieldMatch[2].trim(), fieldLine: lines[j].num });
    j++;
  }

  const keys = fields.map(f => f.key);
  if (!keys.includes('to')) {
    throw new SyntaxError(`"${isServer ? 'server ' : ''}wson ${name}" (línea ${lines[i].num}) necesita "-> to: ..." -- es el único campo obligatorio junto con "content" (todo mensaje necesita saber a dónde va).`);
  }
  if (!keys.includes('content')) {
    throw new SyntaxError(`"${isServer ? 'server ' : ''}wson ${name}" (línea ${lines[i].num}) necesita "-> content: ..." -- un mensaje sin contenido no tiene sentido.`);
  }
  const dup = keys.find((k, idx) => keys.indexOf(k) !== idx);
  if (dup) {
    throw new SyntaxError(`"${isServer ? 'server ' : ''}wson ${name}" (línea ${lines[i].num}) repite el campo "${dup}" -- cada campo (from/to/via/content) solo puede aparecer una vez.`);
  }

  return {
    node: { type: isServer ? 'ServerWsonDecl' : 'WsonDecl', name, fields, line: lines[i].num },
    next: j,
  };
}

// visual NAME =
// <html template...>
//   -> key: value
//   -> key:
//       code block...
function parseVisual(lines, i) {
  const header = lines[i].text.trim().match(/^visual\s+([A-Za-z_$][\w$]*)\s*=\s*$/);
  if (!header) throw new SyntaxError(`Línea ${lines[i].num}: se esperaba "visual NOMBRE ="`);
  const baseIndent = lines[i].indent;
  const name = header[1];
  const declLine = lines[i].num;

  // 1. Recolectar "reactive" LOCALES declaradas justo después del header (estado privado de esta instancia)
  let j = i + 1;
  const localReactives = [];
  while (j < lines.length) {
    if (isBlank(lines[j])) { j++; continue; }
    const t = lines[j].text.trim();
    const m = t.match(/^reactive\s+(?:(string|number|boolean)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(.+)$/);
    if (!m) break;
    localReactives.push({ name: m[2], init: m[3].trim(), varType: m[1] || null, line: lines[j].num });
    j++;
  }

  // 1b. Recolectar "var" LOCALES (NO reactivas) -- después de las reactive, antes de la plantilla
  const localVars = [];
  while (j < lines.length) {
    if (isBlank(lines[j])) { j++; continue; }
    const t = lines[j].text.trim();
    const m = t.match(/^var\s+(?:(string|number|boolean)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(.+)$/);
    if (!m) break;
    localVars.push({ name: m[2], init: m[3].trim(), varType: m[1] || null, line: lines[j].num });
    j++;
  }

  // 2. Recolectar la plantilla (HTML intercalado con if/for) hasta encontrar una línea "->"
  const templateResult = parseVisualTemplate(lines, j, baseIndent);
  const template = templateResult.template;
  j = templateResult.next;

  // Sintaxis "-> key: value" ELIMINADA -- sustituida por atributos en línea, directamente
  // en cualquier nodo de la plantilla (no solo la raíz): "onclick={código}" en vez de
  // "-> onclick:", "class={expr}" en vez de "-> style: nombre". Se detecta aquí para dar
  // un error de migración claro, en vez de dejar que "->" quede como texto suelto sin
  // reconocer tras la plantilla.
  if (j < lines.length && !isBlank(lines[j]) && lines[j].indent > baseIndent && lines[j].text.trim().startsWith('->')) {
    throw new SyntaxError(
      `Línea ${lines[j].num}: la sintaxis "-> clave: valor" después de la plantilla ya no existe -- ` +
      `ahora los bindings van en línea, dentro de la propia etiqueta, en cualquier nodo (no solo la raíz). ` +
      `"-> onclick: codigo" se escribe "onclick={codigo}" directamente en el elemento; ` +
      `"-> style: nombre" se escribe "class={nombre}" (el nombre de un "style" ya es literalmente su clase CSS).`
    );
  }

  return { node: { type: 'VisualDecl', name, localReactives, localVars, template, line: declLine }, next: j };
}

// render( a, b, c )  -- puede ocupar varias líneas hasta el ")"
function parseRender(lines, i) {
  let text = '';
  let j = i;
  while (j < lines.length) {
    text += lines[j].text + '\n';
    if (lines[j].text.includes(')')) { j++; break; }
    j++;
  }
  const m = text.match(/render\(([\s\S]*)\)/);
  if (!m) throw new SyntaxError(`Línea ${lines[i].num}: "render(...)" mal formado`);
  const args = m[1]
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return { node: { type: 'RenderCall', args, line: lines[i].num }, next: j };
}

module.exports = { parseProgram };
