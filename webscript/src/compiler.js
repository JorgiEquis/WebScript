const fs = require('fs');
const path = require('path');
const jsAnalyzer = require('./js-analyzer');

function compile(ast, options = {}) {
  const { cssFilename = 'styles.css', jsFilename = 'bundle.js', serverDataUrl = null, routePath = null } = options;

  const reactives = ast.body.filter(n => n.type === 'ReactiveDecl');
  const globalVars = ast.body.filter(n => n.type === 'VarDecl');
  const styles = ast.body.filter(n => n.type === 'StyleDecl');
  const visuals = ast.body.filter(n => n.type === 'VisualDecl');
  const renderCall = ast.body.find(n => n.type === 'RenderCall');
  const serverVars = ast.body.filter(n => n.type === 'ServerVarDecl');
  const serverFunctions = ast.body.filter(n => n.type === 'ServerFunctionDecl');
  const postFn = ast.body.find(n => n.type === 'PostFunctionDecl') || null;

  const globalNames = reactives.map(r => r.name);
  const visualNames = new Set(visuals.map(v => v.name));

  const css = compileCSS(styles);
  const js = compileJS(reactives, globalVars, visuals, renderCall, globalNames, visualNames, serverDataUrl, postFn, routePath);
  const html = compileHTML(cssFilename, jsFilename);
  const server = compileServerJS(serverVars, serverFunctions, postFn);

  return { html, css, js, server };
}

// ¿Este archivo lee algún valor de servidor vía "server.NOMBRE" en algún sitio
// (reactive/var globales, locales de un visual, plantillas, bindings)? Si sí, el bundle
// de cliente necesita hacer un fetch de datos antes de montar nada.
function usesServerData(ast) {
  const exprs = [];
  for (const n of ast.body) {
    if (n.type === 'ReactiveDecl' || n.type === 'VarDecl') exprs.push(n.init);
    if (n.type === 'VisualDecl') {
      for (const r of n.localReactives) exprs.push(r.init);
      for (const v of n.localVars) exprs.push(v.init);
      for (const b of n.bindings) exprs.push(b.kind === 'value' ? b.value : b.code);
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
function compileServerJS(serverVars, serverFunctions = [], postFn = null) {
  if (serverVars.length === 0 && serverFunctions.length === 0 && !postFn) return null;

  const serverNames = serverVars.map(d => d.name);

  function compileInit(expr) {
    let out = expr;
    for (const name of serverNames) {
      const re = new RegExp(`(?<![\\w$])(?<![^.]\\.)${name}(?![\\w$])`, 'g');
      out = out.replace(re, name);
    }
    return out;
  }

  const inner = [];
  for (const v of serverVars) {
    inner.push(`  let ${v.name} = ${compileInit(v.init)}; // server var`);
  }
  for (const fn of serverFunctions) {
    inner.push(
      '',
      `  // server function -- NO se expone al cliente ni tiene endpoint propio.`,
      `  function ${fn.name}(${fn.params}) {`,
      ...fn.body.split('\n').map(l => `    ${l}`),
      `  }`
    );
  }
  if (postFn) {
    inner.push(
      '',
      `  // post function -- corre cuando llega un POST a la URL de la propia ruta.`,
      `  function ${postFn.name}(${postFn.params}) {`,
      ...postFn.body.split('\n').map(l => `    ${l}`),
      `  }`
    );
  }
  inner.push(
    '',
    '  return {',
    ...serverNames.map(n => `    get ${n}() { return ${n}; },\n    set ${n}(v) { ${n} = v; },`),
    ...(postFn ? [`    ${postFn.name},`] : []),
    '  };'
  );

  const lines = [
    "'use strict';",
    '// Modo estricto a propósito: sin esto, asignar a un identificador NUNCA declarado',
    '// dentro de una post function/server function (ej. un typo, o intentar "escribir"',
    '// sobre un nombre que en realidad es un visual del cliente) crea una variable',
    '// GLOBAL implícita en el proceso Node -- filtrada fuera de cualquier sesión, un bug',
    '// silencioso y de verdad peligroso. Con \'use strict\', eso es un ReferenceError',
    '// inmediato y claro en vez de una fuga silenciosa entre sesiones.',
    '',
    '// server.js -- variables SOLO de servidor. Este archivo NUNCA se envía al cliente.',
    '// Cada sesión (identificada por cookie, ver site-builder.js) llama a createSessionState()',
    '// UNA vez y se queda con su propia instancia -- el estado NO se comparte entre visitantes.',
    '',
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
// heurística que cubre el caso real que importa: pasar { visitas: x } a updateServer(...).
function isObjectKeyPosition(expr, index, length) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(expr[i])) i--;
  const before = i >= 0 ? expr[i] : '';
  let j = index + length;
  while (j < expr.length && /\s/.test(expr[j])) j++;
  const after = expr[j] || '';
  return (before === '{' || before === ',') && after === ':';
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

// { contador } o , contador } / , contador , -- atajo de objeto (property shorthand)
// usado para CONSTRUIR un objeto con el valor actual de la variable (no un destructuring,
// esos ya se excluyen aparte). Aquí no basta con sustituir el nombre -- hay que EXPANDIR
// a la forma explícita "contador: state.contador", porque "{ state.contador }" tampoco
// es sintaxis de atajo válida.
function isShorthandPropertyPosition(expr, index, length) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(expr[i])) i--;
  const before = i >= 0 ? expr[i] : '';
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
  const matches = [];
  let m;
  while ((m = re.exec(expr)) !== null) {
    if (isObjectKeyPosition(expr, m.index, name.length)) continue;
    if (isInsideAnySpan(m.index, destructuringSpans)) continue;
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

// -------- JS: genera funciones create_NAME(state, effect, props) para cada visual --------
function compileJS(reactives, globalVars, visuals, renderCall, globalNames, visualNames, serverDataUrl = null, postFn = null, routePath = null) {
  const runtimeSrc = fs.readFileSync(path.join(__dirname, 'runtime', 'reactive.js'), 'utf8')
    .replace(/if \(typeof module[\s\S]*$/m, ''); // quita el export para navegador

  const initialGlobalState = reactives.map(r => `  ${r.name}: ${r.init}`).join(',\n');

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
        if (value === true) {
          lines.push(`  ${varName}.setAttribute(${JSON.stringify(attr)}, "");`);
        } else if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
          const raw = value.slice(1, -1).trim();
          emitReactive(lines, raw, ctx, (compiled) => `${varName}.setAttribute(${JSON.stringify(attr)}, ${compiled});`);
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

    for (const b of v.bindings) {
      if (b.key === 'style') {
        lines.push(`  ${rootVar}.classList.add(${JSON.stringify(b.value)});`);
      } else if (b.key.startsWith('on')) {
        const eventName = b.key.slice(2).toLowerCase();
        const body = b.kind === 'block' ? b.code : b.value;
        const rpcNames = ['updateServer', ...(postFn ? [postFn.name] : [])];
        const rpcPattern = rpcNames.map(n => `\\b${n}\\s*\\(`).join('|');
        const usesRpc = new RegExp(rpcPattern).test(body);
        const injected = transform(body, ctx)
          .split('\n')
          .map(l => '    ' + l)
          .join('\n');
        const asyncKw = usesRpc ? 'async ' : '';
        const awaitedInjected = usesRpc
          ? injected.replace(new RegExp(`(?<!await\\s)(${rpcPattern})`, 'g'), 'await $1')
          : injected;
        lines.push(`  ${rootVar}.addEventListener(${JSON.stringify(eventName)}, ${asyncKw}(event) => {\n${awaitedInjected}\n  });`);
      } else {
        const val = b.kind === 'value' ? b.value : b.code;
        lines.push(`  ${rootVar}.setAttribute(${JSON.stringify(b.key)}, ${JSON.stringify(val)});`);
      }
    }

    lines.push(`  return ${rootVar};`);
    return `function create_${v.name}(state, effect, props = {}) {\n${lines.join('\n')}\n}`;
  }).join('\n\n');

  const mountCalls = renderCall
    ? renderCall.args.map(name => `app.appendChild(create_${name}(state, effect, {}));`).join('\n')
    : '';

  const globalVarLines = globalVars
    .map(v => `let ${v.name} = ${transform(v.init, { localNames: [] })};`)
    .join('\n');

  // ¿Se llama a la post function desde algún handler? Si no se usa en ningún sitio,
  // no generamos el stub de cliente -- no tiene sentido exponerlo si nadie lo llama.
  const postFnCalled = postFn && visuals.some(v =>
    v.bindings.some(b => {
      const body = b.kind === 'block' ? b.code : b.value;
      return new RegExp(`\\b${postFn.name}\\s*\\(`).test(body);
    })
  );

  const postFnStub = postFnCalled
    ? `
// Llama a "post function ${postFn.name}" en el servidor -- POST a la URL de esta
// misma ruta (no al endpoint .server-data.json, ese es de updateServer). Si no se
// compiló dentro de un sitio con rutas (ej. "build" de un solo archivo), usa la URL
// actual de la página como respaldo.
async function ${postFn.name}(${postFn.params}) {
  if (location.protocol === 'file:') {
    throw new Error('"${postFn.name}" necesita un servidor -- abre esta página vía http://, no como archivo local (file://). Usa: node src/cli.js run <carpeta> --serve');
  }
  return fetch(${routePath ? JSON.stringify(routePath) : 'window.location.pathname'}, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(${postFn.params || '{}'}),
  }).then(r => r.json());
}
`
    : '';

  // Si el archivo lee algún "server.NOMBRE", el montaje tiene que esperar a un fetch
  // antes de crear el estado (sus valores iniciales pueden depender de datos de servidor).
  // Si no, se mantiene el montaje síncrono de siempre -- cero coste extra para páginas estáticas.
  const mountBlock = serverDataUrl
    ? `
let server = {};
let state, effect;

// Envía cambios al servidor (POST al mismo endpoint de datos de esta ruta), actualiza
// el snapshot local "server" con la respuesta, y lo devuelve -- para poder hacer
// "await updateServer({...})" y usar el valor fresco justo después si hace falta.
async function updateServer(updates) {
  const data = await fetch(${JSON.stringify(serverDataUrl)}, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  }).then(r => r.json());
  Object.assign(server, data);
  return server;
}
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

  const store = createStore({
${initialGlobalState}
  });
  state = store.store;
  effect = store.effect;

${globalVarLines.split('\n').filter(Boolean).map(l => '  ' + l).join('\n')}

  const app = document.getElementById('app');
  ${mountCalls}
}

document.addEventListener('DOMContentLoaded', () => { __wsInit(); });
`
    : `
// ---- estado reactivo GLOBAL (compartido entre todos los visuales) ----
const { store: state, effect } = createStore({
${initialGlobalState}
});

// ---- variables NO reactivas globales (se calculan una vez, no re-renderizan nada) ----
${globalVarLines}
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
