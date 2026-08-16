// Renderiza el árbol de un visual a un string de HTML real, evaluando las expresiones
// contra un "scope" con los valores YA CONOCIDOS (reactive/var globales evaluadas de
// sus literales, y opcionalmente los valores reales de server var para una sesión
// concreta). Se usa en dos sitios:
//   - SSG (tiempo de compilación, site-builder.js): rutas SIN server.X, se evalúa una
//     sola vez con los valores literales iniciales.
//   - SSR real (en cada petición, site-builder.js/startServer): rutas dinámicas, se
//     evalúa con los valores actuales de la sesión.
//
// Si CUALQUIER expresión falla al evaluarse (por ejemplo, usa `document`/`window`, que
// no existen en Node, o depende de datos que en este contexto no están disponibles),
// se aborda todo el intento y se devuelve { ok: false } -- el llamante debe servir la
// concha vacía de siempre (el cliente la rellena vía JS, como ya hacía antes de esto).
// Nunca debe dejar la página peor de lo que estaba sin SSR/SSG.

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Evalúa una expresión JS (texto crudo, tal como aparece en el .ws) contra un scope de
// variables -- SIN necesidad de sustituir nombres a mano, porque aquí evaluamos de
// verdad en vez de generar código: las claves del scope resuelven directamente como
// variables disponibles dentro de la expresión.
function evalExpr(expr, scope) {
  const names = Object.keys(scope);
  const values = names.map(n => scope[n]);
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...names, `return (${expr});`);
    return { ok: true, value: fn(...values) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function renderTemplateNode(node, scope, ctx) {
  if (ctx.failed) return '';
  if (!node) return '';

  if (node.type === 'text') return escapeHtml(node.value);

  if (node.type === 'interpolation') {
    const r = evalExpr(node.expr, scope);
    if (!r.ok) { ctx.failed = true; return ''; }
    return r.value == null ? '' : escapeHtml(r.value);
  }

  if (node.type === 'if') {
    for (const branch of node.branches) {
      const c = evalExpr(branch.condition, scope);
      if (!c.ok) { ctx.failed = true; return ''; }
      if (c.value) return branch.body.map(n => renderTemplateNode(n, scope, ctx)).join('');
    }
    if (node.elseBody) return node.elseBody.map(n => renderTemplateNode(n, scope, ctx)).join('');
    return '';
  }

  if (node.type === 'for') {
    const r = evalExpr(node.iterable, scope);
    if (!r.ok || !r.value || typeof r.value.forEach !== 'function') { ctx.failed = true; return ''; }
    let out = '';
    r.value.forEach(item => {
      if (ctx.failed) return;
      const itemScope = { ...scope, [node.item]: item };
      out += node.body.map(n => renderTemplateNode(n, itemScope, ctx)).join('');
    });
    return out;
  }

  if (node.type === 'element') {
    if (node.tag === 'slot') {
      // <slot/> inserta lo que el padre puso entre <componente>...</componente> --
      // guardado en scope.props.children como HTML ya renderizado (string), evaluado
      // en el momento de la composición, en el scope del PADRE (igual que en cliente).
      const childrenHtml = scope.props && typeof scope.props.children === 'string' ? scope.props.children : '';
      return childrenHtml;
    }

    if (ctx.visualsByName.has(node.tag)) {
      const childVisual = ctx.visualsByName.get(node.tag);
      const props = {};
      for (const [k, v] of Object.entries(node.attrs || {})) {
        if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) {
          const r = evalExpr(v.slice(1, -1), scope);
          if (!r.ok) { ctx.failed = true; return ''; }
          props[k] = r.value;
        } else {
          props[k] = v;
        }
      }
      if ((node.children || []).length > 0) {
        // Los children se renderizan en el scope del PADRE (no en el del hijo que los
        // recibe), igual que hace compiler.js para el cliente -- y se pasan como un
        // único string HTML ya resuelto, para que <slot/> del hijo solo tenga que
        // insertarlo tal cual.
        const childrenHtml = node.children.map(c => renderTemplateNode(c, scope, ctx)).join('');
        if (ctx.failed) return '';
        props.children = childrenHtml;
      }
      return renderVisual(childVisual, ctx, props);
    }

    const tag = node.tag === '__root__' ? 'div' : node.tag;
    const attrs = { ...(node.attrs || {}) };
    let attrsStr = '';
    for (const [k, v] of Object.entries(attrs)) {
      // Los manejadores de eventos (onclick={...}, onXXX={...}) NUNCA se renderizan como
      // atributo HTML estático -- el HTML servido no tiene ningún JS ejecutándose todavía,
      // esos se conectan en el cliente cuando el bundle monta de verdad. Rendericarlos
      // aquí intentaría evaluar el CÓDIGO del handler como si fuera un valor de atributo,
      // produciendo HTML roto o un fallo real.
      if (/^on[a-z]+$/.test(k)) continue;
      if (v === true) { attrsStr += ` ${k}`; continue; }
      if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) {
        const r = evalExpr(v.slice(1, -1), scope);
        if (!r.ok) { ctx.failed = true; return ''; }
        attrsStr += ` ${k}="${escapeHtml(r.value)}"`;
      } else {
        attrsStr += ` ${k}="${escapeHtml(v)}"`;
      }
    }

    if (VOID_TAGS.has(tag)) return `<${tag}${attrsStr}>`;
    const inner = (node.children || []).map(c => renderTemplateNode(c, scope, ctx)).join('');
    return `<${tag}${attrsStr}>${inner}</${tag}>`;
  }

  return '';
}

function renderVisual(visual, ctx, props) {
  if (ctx.failed) return '';
  const scope = { ...ctx.globalScope, props };

  for (const r of visual.localReactives) {
    const v = evalExpr(r.init, scope);
    if (!v.ok) { ctx.failed = true; return ''; }
    scope[r.name] = v.value;
  }
  for (const v of visual.localVars) {
    const val = evalExpr(v.init, scope);
    if (!val.ok) { ctx.failed = true; return ''; }
    scope[v.name] = val.value;
  }

  return renderTemplateNode(visual.template, scope, ctx);
}

// Punto de entrada. `ast` es el AST completo de la ruta (como el que usa compiler.js).
// `options.serverScope`, si se da, es un objeto con los valores REALES de server var
// para la sesión actual (accesible en las expresiones como "server.NOMBRE").
// Devuelve { ok, html }. Si ok es false, `html` es '' y el llamante debe usar la concha
// vacía de siempre.
function renderRouteToHtml(ast, options = {}) {
  const reactives = ast.body.filter(n => n.type === 'ReactiveDecl');
  const globalVarsList = ast.body.filter(n => n.type === 'VarDecl');
  const visuals = ast.body.filter(n => n.type === 'VisualDecl');
  const styles = ast.body.filter(n => n.type === 'StyleDecl');
  const renderCall = ast.body.find(n => n.type === 'RenderCall');
  if (!renderCall) return { ok: false, html: '' };

  const ctx = {
    visualsByName: new Map(visuals.map(v => [v.name, v])),
    failed: false,
  };

  const globalScope = { server: options.serverScope || {} };
  // El nombre de un "style" es literalmente su propia clase CSS -- se añade al scope
  // como una cadena que se referencia a sí misma, para que "class={estilo}" (o
  // "class={activo ? estilo : 'otra'}") se evalúe correctamente en SSR sin necesitar
  // ninguna sustitución especial, igual que cualquier otra variable del scope.
  for (const s of styles) { globalScope[s.name] = s.name; }
  for (const r of reactives) {
    const v = evalExpr(r.init, globalScope);
    if (!v.ok) return { ok: false, html: '' };
    globalScope[r.name] = v.value;
  }
  for (const v of globalVarsList) {
    const val = evalExpr(v.init, globalScope);
    if (!val.ok) return { ok: false, html: '' };
    globalScope[v.name] = val.value;
  }
  ctx.globalScope = globalScope;

  let html = '';
  for (const name of renderCall.args) {
    const visual = ctx.visualsByName.get(name);
    if (!visual) return { ok: false, html: '' };
    html += renderVisual(visual, ctx, {});
    if (ctx.failed) return { ok: false, html: '' };
  }

  return { ok: true, html };
}

// Inserta el HTML ya renderizado en la concha (<div id="app"></div>) generada por
// compileHTML() en compiler.js. Si por lo que sea la concha no tiene ese marcador
// exacto, devuelve el shell sin tocar (seguro por defecto).
function injectIntoShell(shellHtml, appHtml) {
  const marker = '<div id="app"></div>';
  if (!shellHtml.includes(marker)) return shellHtml;
  return shellHtml.replace(marker, `<div id="app">${appHtml}</div>`);
}

module.exports = { renderRouteToHtml, injectIntoShell, escapeHtml };
