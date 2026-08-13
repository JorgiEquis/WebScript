const { appendHtmlToStack } = require('./html-parser');

function isBlank(line) {
  return line.text.trim() === '';
}

// Recorre líneas de plantilla y devuelve los nodos hijos de un ámbito (una pila COMPARTIDA
// para todo este nivel de recursión). Un tag HTML abierto antes de un if/for sigue abierto
// en esa misma pila después del bloque -- el if/for no la toca, solo se añade como hijo del
// elemento que esté abierto en ese momento.
function parseBlock(lines, start, opts) {
  const { dedentIndent = -1, isTopLevel = false, visualBaseIndent = -1 } = opts;
  const root = { type: 'element', tag: '__root__', attrs: {}, children: [] };
  const stack = [root];
  let htmlBuffer = [];
  let i = start;

  function flushHtml() {
    if (htmlBuffer.some(l => l.trim() !== '')) {
      // Prefijo "\n" -- si este tramo empieza justo tras un if/for, su primera línea
      // no tiene un salto de línea propio delante (el buffer es un array nuevo), así
      // que su indentación no se reconocería como "estructural" sin este empujón.
      appendHtmlToStack('\n' + htmlBuffer.join('\n'), stack);
    }
    htmlBuffer = [];
  }

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { htmlBuffer.push(''); i++; continue; }

    if (!isTopLevel && line.indent <= dedentIndent) break;

    const t = line.text.trim();
    if (t.startsWith('//')) { i++; continue; } // comentario de línea completa, se ignora
    if (t.startsWith('->')) break;
    const TOP_LEVEL_KEYWORDS = ['reactive ', 'var ', 'style ', 'visual ', 'render(', 'server ', 'post function ', 'import ', 'import{', 'route('];
    if (isTopLevel && line.indent <= visualBaseIndent && TOP_LEVEL_KEYWORDS.some(k => t.startsWith(k))) {
      break;
    }

    // Si llegamos hasta aquí con un "else"/"else if" es que quedó DEMASIADO indentado
    // respecto a su "if" (si estuviera a la indentación correcta, el chequeo de dedent de
    // más arriba ya habría cortado el bloque antes de llegar aquí). En vez de tragárnoslo
    // como texto HTML en silencio, avisamos con la columna exacta que se espera.
    if (!isTopLevel && /^else(\s+if\s*\([\s\S]*\))?\s*$/.test(t)) {
      throw new SyntaxError(
        `Línea ${line.num}: "${t}" parece un "else"/"else if" mal indentado -- está en la columna ` +
        `${line.indent}, pero debe estar EXACTAMENTE en la misma columna que su "if" (columna ${dedentIndent}). ` +
        `Revisa la indentación.`
      );
    }

    if (/^if\s*\(/.test(t)) {
      flushHtml();
      const r = parseIfChain(lines, i);
      stack[stack.length - 1].children.push(r.node);
      i = r.next;
      continue;
    }
    if (/^for\s*\(/.test(t)) {
      flushHtml();
      const r = parseForLoop(lines, i);
      stack[stack.length - 1].children.push(r.node);
      i = r.next;
      continue;
    }

    htmlBuffer.push(line.text);
    i++;
  }

  flushHtml();
  return { nodes: root.children, next: i };
}

function parseIfChain(lines, i) {
  const headerIndent = lines[i].indent;
  const m = lines[i].text.trim().match(/^if\s*\(([\s\S]*)\)\s*$/);
  if (!m) throw new SyntaxError(`Línea ${lines[i].num}: se esperaba "if (condición)"`);

  const branches = [];
  let elseBody = null;

  let r = parseBlock(lines, i + 1, { dedentIndent: headerIndent });
  branches.push({ condition: m[1].trim(), body: r.nodes });
  let j = r.next;

  while (j < lines.length) {
    if (isBlank(lines[j])) { j++; continue; }

    const t = lines[j].text.trim();
    const looksLikeElse = /^else(\s+if\s*\([\s\S]*\))?\s*$/.test(t);

    if (lines[j].indent !== headerIndent) {
      if (looksLikeElse) {
        throw new SyntaxError(
          `Línea ${lines[j].num}: "${t}" parece un "else"/"else if" mal indentado -- está en la columna ` +
          `${lines[j].indent}, pero debe estar EXACTAMENTE en la misma columna que su "if" (columna ${headerIndent}). ` +
          `Revisa la indentación.`
        );
      }
      break;
    }

    const elseIf = t.match(/^else\s+if\s*\(([\s\S]*)\)\s*$/);
    if (elseIf) {
      const rr = parseBlock(lines, j + 1, { dedentIndent: headerIndent });
      branches.push({ condition: elseIf[1].trim(), body: rr.nodes });
      j = rr.next;
      continue;
    }
    if (t === 'else') {
      const rr = parseBlock(lines, j + 1, { dedentIndent: headerIndent });
      elseBody = rr.nodes;
      j = rr.next;
      break;
    }
    break;
  }

  return { node: { type: 'if', branches, elseBody }, next: j };
}

// for (item in lista)              -- sin clave, diffing por índice (funciona, pero
//                                     menos eficiente al reordenar/insertar en medio)
// for (item in lista by item.id)   -- con clave: reutiliza el nodo DOM existente si la
//                                     clave ya existía Y el ítem es el mismo objeto
function parseForLoop(lines, i) {
  const headerIndent = lines[i].indent;
  const m = lines[i].text.trim().match(/^for\s*\(\s*([A-Za-z_$][\w$]*)\s+in\s+(.+?)(?:\s+by\s+(.+?))?\s*\)\s*$/);
  if (!m) throw new SyntaxError(`Línea ${lines[i].num}: se esperaba "for (item in lista)" o "for (item in lista by clave)"`);

  const r = parseBlock(lines, i + 1, { dedentIndent: headerIndent });
  return {
    node: {
      type: 'for',
      item: m[1],
      iterable: m[2].trim(),
      keyExpr: m[3] ? m[3].trim() : null,
      body: r.nodes,
    },
    next: r.next,
  };
}

// Punto de entrada usado por parseVisual: procesa el cuerpo de la plantilla de un visual.
function parseVisualTemplate(lines, start, visualBaseIndent) {
  const { nodes, next } = parseBlock(lines, start, { isTopLevel: true, visualBaseIndent });

  let template;
  if (nodes.length === 1 && nodes[0].type === 'element') {
    template = nodes[0];
  } else {
    template = { type: 'element', tag: '__root__', attrs: {}, children: nodes };
  }
  return { template, next };
}

module.exports = { parseVisualTemplate };
