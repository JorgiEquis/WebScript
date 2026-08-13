const jsAnalyzer = require('./js-analyzer');

const LABELS = {
  ReactiveDecl: 'reactive',
  VarDecl: 'var',
  StyleDecl: 'style',
  VisualDecl: 'visual',
  ServerVarDecl: 'server var',
  ServerFunctionDecl: 'server function',
  PostFunctionDecl: 'post function',
};

// Espacios de nombres: reactive/var/visual/server-var/server-function/post-function
// comparten uno -- colisionan de verdad (variable JS muerta, función pisada en silencio,
// o ambigüedad sobre si un nombre es de cliente o de servidor). "style" tiene el suyo propio.
const SHARED_NAMESPACE = new Set([
  'ReactiveDecl', 'VarDecl', 'VisualDecl', 'ServerVarDecl', 'ServerFunctionDecl', 'PostFunctionDecl',
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

function referencesName(expr, name) {
  const astRefs = jsAnalyzer.isAvailable() ? jsAnalyzer.analyzeReferences(expr) : null;
  if (astRefs) {
    return astRefs.some(r => r.name === name);
  }

  const re = new RegExp(`(?<![\\w$])(?<![^.]\\.)${name}(?![\\w$])`, 'g');
  const destructuringSpans = findDestructuringSpans(expr);
  let m;
  while ((m = re.exec(expr)) !== null) {
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

  const postFnDecls = ast.body.filter(n => n.type === 'PostFunctionDecl');
  if (postFnDecls.length > 1) {
    throw new SyntaxError(
      `Solo puede haber una "post function" por archivo (encontradas en las líneas ${postFnDecls.map(f => f.line).join(', ')}).`
    );
  }

  const globalDecls = ast.body.filter(n => LABELS[n.type]);

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
    .filter(n => n.type === 'ServerVarDecl' || n.type === 'ServerFunctionDecl')
    .map(n => n.name);
  const serverNameKind = new Map(
    ast.body
      .filter(n => n.type === 'ServerVarDecl' || n.type === 'ServerFunctionDecl')
      .map(n => [n.name, labelFor(n.type)])
  );

  if (serverNames.length > 0) {
    for (const v of ast.body.filter(n => n.type === 'VisualDecl')) {
      const exprs = [];
      collectTemplateExprs(v.template, exprs);
      for (const r of v.localReactives) exprs.push(r.init);
      for (const vr of v.localVars) exprs.push(vr.init);
      for (const b of v.bindings) {
        if (b.key === 'style') continue; // valor literal (nombre de clase), no una expresión
        exprs.push(b.kind === 'value' ? b.value : b.code);
      }

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
  }
}

module.exports = { validate };
