// Convierte un fragmento de HTML (con {expr} de interpolación) en un árbol de nodos.
// Soporta: elementos anidados, atributos, texto, self-closing tags, interpolación en texto.

const VOID_TAGS = new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);

function tokenize(html) {
  const tokens = [];
  const re = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^<>]*>|[^<]+/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    tokens.push(m[0]);
  }
  return tokens;
}

function parseAttrs(tagInner) {
  const attrs = {};
  const nameRe = /([A-Za-z_:][\w:-]*)/g;
  let m;
  while ((m = nameRe.exec(tagInner)) !== null) {
    const name = m[1];
    let pos = nameRe.lastIndex;
    // ¿tiene "=valor"? (con espacios opcionales alrededor del =)
    const eqMatch = /^\s*=\s*/.exec(tagInner.slice(pos));
    if (!eqMatch) { attrs[name] = true; continue; }
    pos += eqMatch[0].length;

    const ch = tagInner[pos];
    let value;
    if (ch === '"' || ch === "'") {
      const closeIdx = tagInner.indexOf(ch, pos + 1);
      value = closeIdx === -1 ? tagInner.slice(pos + 1) : tagInner.slice(pos + 1, closeIdx);
      pos = closeIdx === -1 ? tagInner.length : closeIdx + 1;
    } else if (ch === '{') {
      const end = findInterpolationEnd(tagInner, pos + 1);
      const closeIdx = end === -1 ? tagInner.length : end;
      value = tagInner.slice(pos, closeIdx + (end === -1 ? 0 : 1)); // incluye las llaves, como antes
      pos = closeIdx + (end === -1 ? 0 : 1);
    } else {
      // valor sin comillas (no debería pasar con HTML válido, pero no rompemos)
      const spaceIdx = tagInner.slice(pos).search(/\s/);
      const endIdx = spaceIdx === -1 ? tagInner.length : pos + spaceIdx;
      value = tagInner.slice(pos, endIdx);
      pos = endIdx;
    }
    attrs[name] = value;
    nameRe.lastIndex = pos;
  }
  return attrs;
}

// Colapsa espacio "estructural" (el que incluye un salto de línea, típicamente indentación
// entre tags) a nada, y el espacio "real" en la misma línea (el que separa texto de una
// interpolación, ej. "Hola {nombre}") a un único espacio, sin comérselo.
function normalizeWhitespace(raw) {
  return raw.replace(/[ \t]*\n[ \t]*/g, '').replace(/[ \t]+/g, ' ');
}

// Escanea manualmente en vez de con regex, porque {expr} puede contener llaves anidadas
// de verdad -- el caso más común es un template literal con ${...} dentro, ej.
// {`Hola ${nombre}`}. Un regex que para en la primera "}" corta la expresión a la mitad
// ahí. Aquí se respetan comillas ('/"/`) y se cuenta la profundidad de llaves real.
function findInterpolationEnd(text, start) {
  let depth = 1;
  let inString = null;
  let j = start;
  while (j < text.length) {
    const ch = text[j];
    if (inString) {
      if (ch === '\\') { j += 2; continue; }
      if (ch === inString) inString = null;
      j++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; j++; continue; }
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) return j; }
    j++;
  }
  return -1; // sin cerrar -- lo trata el llamante
}

function parseTextNode(text) {
  // separa texto plano de interpolaciones {expr}, respetando llaves anidadas dentro
  // de strings/template literals
  const nodes = [];
  let i = 0;
  let buffer = '';

  function flushBuffer() {
    if (buffer !== '') {
      const chunk = normalizeWhitespace(buffer);
      if (chunk !== '') nodes.push({ type: 'text', value: chunk });
      buffer = '';
    }
  }

  while (i < text.length) {
    if (text[i] === '{') {
      const end = findInterpolationEnd(text, i + 1);
      if (end === -1) { buffer += text[i]; i++; continue; } // "{" suelta sin cerrar -> texto literal
      flushBuffer();
      nodes.push({ type: 'interpolation', expr: text.slice(i + 1, end).trim() });
      i = end + 1;
      continue;
    }
    buffer += text[i];
    i++;
  }
  flushBuffer();
  return nodes;
}

function parseTemplate(html) {
  const tokens = tokenize(html);
  const root = { type: 'element', tag: '__root__', attrs: {}, children: [] };
  const stack = [root];

  for (const tok of tokens) {
    if (tok.startsWith('<!--')) continue;

    if (tok.startsWith('</')) {
      // cierre de tag
      stack.pop();
      continue;
    }

    if (tok.startsWith('<')) {
      const selfClosing = /\/>\s*$/.test(tok);
      const inner = tok.replace(/^<\/?/, '').replace(/\/?>$/, '').trim();
      const spaceIdx = inner.search(/\s/);
      const tagName = spaceIdx === -1 ? inner : inner.slice(0, spaceIdx);
      const attrsStr = spaceIdx === -1 ? '' : inner.slice(spaceIdx + 1);
      const node = { type: 'element', tag: tagName, attrs: parseAttrs(attrsStr), children: [] };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing && !VOID_TAGS.has(tagName.toLowerCase())) {
        stack.push(node);
      }
      continue;
    }

    // texto
    const textNodes = parseTextNode(tok);
    stack[stack.length - 1].children.push(...textNodes);
  }

  // Si la plantilla tiene un único elemento raíz, lo devolvemos directamente
  if (root.children.length === 1 && root.children[0].type === 'element') {
    return root.children[0];
  }
  return root; // múltiples nodos raíz -> se envuelve en __root__ (se compila como <div>)
}

// Devuelve directamente el array de nodos del nivel superior, sin envolver.
// Lo usa el parser de plantillas (template-parser.js) para tramos de HTML
// plano intercalados entre bloques "if"/"for".
function parseFragment(html) {
  const tokens = tokenize(html);
  const root = { type: 'element', tag: '__root__', attrs: {}, children: [] };
  const stack = [root];

  for (const tok of tokens) {
    if (tok.startsWith('<!--')) continue;
    if (tok.startsWith('</')) { stack.pop(); continue; }
    if (tok.startsWith('<')) {
      const selfClosing = /\/>\s*$/.test(tok);
      const inner = tok.replace(/^<\/?/, '').replace(/\/?>$/, '').trim();
      const spaceIdx = inner.search(/\s/);
      const tagName = spaceIdx === -1 ? inner : inner.slice(0, spaceIdx);
      const attrsStr = spaceIdx === -1 ? '' : inner.slice(spaceIdx + 1);
      const node = { type: 'element', tag: tagName, attrs: parseAttrs(attrsStr), children: [] };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing && !VOID_TAGS.has(tagName.toLowerCase())) stack.push(node);
      continue;
    }
    const textNodes = parseTextNode(tok);
    stack[stack.length - 1].children.push(...textNodes);
  }
  return root.children;
}

// Añade el HTML tokenizado como hijos del tope actual de `stack` (mutada in-place).
// Se usa desde template-parser.js para que un tag abierto ANTES de un if/for
// (ej. <div> antes de un "if") siga abierto en la MISMA pila después del bloque,
// permitiendo que su cierre </div> llegue más adelante en otro tramo de HTML.
function appendHtmlToStack(html, stack) {
  const tokens = tokenize(html);
  for (const tok of tokens) {
    if (tok.startsWith('<!--')) continue;
    if (tok.startsWith('</')) { stack.pop(); continue; }
    if (tok.startsWith('<')) {
      const selfClosing = /\/>\s*$/.test(tok);
      const inner = tok.replace(/^<\/?/, '').replace(/\/?>$/, '').trim();
      const spaceIdx = inner.search(/\s/);
      const tagName = spaceIdx === -1 ? inner : inner.slice(0, spaceIdx);
      const attrsStr = spaceIdx === -1 ? '' : inner.slice(spaceIdx + 1);
      const node = { type: 'element', tag: tagName, attrs: parseAttrs(attrsStr), children: [] };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing && !VOID_TAGS.has(tagName.toLowerCase())) stack.push(node);
      continue;
    }
    const textNodes = parseTextNode(tok);
    stack[stack.length - 1].children.push(...textNodes);
  }
}

module.exports = { parseTemplate, parseFragment, appendHtmlToStack };
