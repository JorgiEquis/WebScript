const { parseVisualTemplate } = require('./template-parser');
const { validate } = require('./validate');
const fs = require('fs');
const path = require('path');

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
    } else if (trimmed.startsWith('server function ')) {
      const r = parseServerFunction(lines, i);
      body.push(r.node);
      i = r.next;
    } else if (trimmed.startsWith('server ')) {
      const r = parseServerDecl(lines, i);
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

    const byName = new Map(importedAst.body.filter(n => n.name).map(n => [n.name, n]));
    for (const wanted of node.names) {
      const found = byName.get(wanted);
      if (!found) {
        const disponibles = [...byName.keys()].join(', ') || '(ninguno)';
        throw new SyntaxError(
          `Línea ${node.line}: "${wanted}" no existe en "${node.source}". Disponibles ahí: ${disponibles}.`
        );
      }
      result.push(found);
    }
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
function parseReactive(lines, i) {
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
  const m = lines[i].text.trim().match(/^var\s+(?:(string|number|boolean)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(.+)$/);
  if (!m) throw new SyntaxError(`Línea ${lines[i].num}: se esperaba "var [tipo] NOMBRE = valor"`);
  return {
    node: { type: 'VarDecl', name: m[2], init: m[3].trim(), varType: m[1] || null, line: lines[i].num },
    next: i + 1,
  };
}

// post function NOMBRE(args)
//     cuerpo...
// SOLO corre en el servidor, disparado por un POST a la URL de la propia ruta (no al
// endpoint .server-data.json, que es de updateServer). Dentro del cuerpo, las
// server reactive/var del mismo archivo se leen/escriben directamente, sin prefijo.
function parsePostFunction(lines, i) {
  const header = lines[i].text.trim().match(/^post\s+function\s+([A-Za-z_$][\w$]*)\s*\(\s*([^)]*)\)\s*$/);
  if (!header) throw new SyntaxError(`Línea ${lines[i].num}: se esperaba "post function NOMBRE(args)"`);
  const [, name, params] = header;
  const baseIndent = lines[i].indent;

  let j = i + 1;
  const bodyLines = [];
  while (j < lines.length) {
    if (isBlank(lines[j])) { j++; continue; }
    if (lines[j].indent <= baseIndent) break;
    bodyLines.push(lines[j].text.trim());
    j++;
  }

  return {
    node: { type: 'PostFunctionDecl', name, params: params.trim(), body: bodyLines.join('\n'), line: lines[i].num },
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
function parseServerFunction(lines, i) {
  const header = lines[i].text.trim().match(/^server\s+function\s+([A-Za-z_$][\w$]*)\s*\(\s*([^)]*)\)\s*$/);
  if (!header) throw new SyntaxError(`Línea ${lines[i].num}: se esperaba "server function NOMBRE(params)"`);
  const [, name, params] = header;
  const baseIndent = lines[i].indent;

  let j = i + 1;
  const bodyLines = [];
  while (j < lines.length) {
    if (isBlank(lines[j])) { j++; continue; }
    if (lines[j].indent <= baseIndent) break;
    bodyLines.push(lines[j].text.trim());
    j++;
  }

  return {
    node: { type: 'ServerFunctionDecl', name, params: params.trim(), body: bodyLines.join('\n'), line: lines[i].num },
    next: j,
  };
}

// server var NAME [= EXPR]
// SOLO existe en el servidor: nunca se compila a bundle.js, y no puede referenciarse
// desde ningún "visual" (eso se valida aparte, en validate.js). El valor inicial es
// opcional -- sin "= valor" arranca en undefined, igual que un "let" normal de JS.
// (Existió "server reactive" como variante, pero se comportaba exactamente igual que
// "server var" -- sin push en tiempo real de por medio la distinción no significaba nada,
// así que se quitó. Si algún día hay WebSocket/push real, puede volver con semántica propia.)
function parseServerDecl(lines, i) {
  const t = lines[i].text.trim();
  const reactiveAttempt = t.match(/^server\s+reactive\s+([A-Za-z_$][\w$]*)/);
  if (reactiveAttempt) {
    throw new SyntaxError(
      `Línea ${lines[i].num}: "server reactive" ya no existe -- usa "server var ${reactiveAttempt[1]}" ` +
      `en su lugar. Se comportaban exactamente igual (ambas persisten mientras el proceso Node esté vivo), ` +
      `así que se unificó en un solo nombre.`
    );
  }
  const m = t.match(/^server\s+var\s+([A-Za-z_$][\w$]*)\s*(?:=\s*(.+))?$/);
  if (!m) throw new SyntaxError(`Línea ${lines[i].num}: se esperaba "server var NOMBRE" (con o sin "= valor")`);
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

  // 2. Recolectar bindings "-> key: value" o "-> key:" seguido de bloque
  const bindings = [];
  while (j < lines.length) {
    if (isBlank(lines[j])) { j++; continue; }
    if (lines[j].indent <= baseIndent) break;
    const t = lines[j].text.trim();
    if (!t.startsWith('->')) break;
    const bindingIndent = lines[j].indent;
    const rest = t.slice(2).trim();
    const colonIdx = rest.indexOf(':');
    if (colonIdx === -1) throw new SyntaxError(`Línea ${lines[j].num}: binding inválido -> "${t}"`);
    const key = rest.slice(0, colonIdx).trim();
    const inlineValue = rest.slice(colonIdx + 1).trim();
    j++;

    if (inlineValue !== '') {
      bindings.push({ key, kind: 'value', value: inlineValue });
    } else {
      // bloque de código indentado
      const codeLines = [];
      while (j < lines.length) {
        if (isBlank(lines[j])) { j++; continue; }
        if (lines[j].indent <= bindingIndent) break;
        codeLines.push(lines[j].text.trim());
        j++;
      }
      bindings.push({ key, kind: 'block', code: codeLines.join('\n') });
    }
  }

  return { node: { type: 'VisualDecl', name, localReactives, localVars, template, bindings, line: declLine }, next: j };
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
  return { node: { type: 'RenderCall', args }, next: j };
}

module.exports = { parseProgram };
