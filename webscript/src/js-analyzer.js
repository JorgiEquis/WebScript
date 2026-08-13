// Analizador de expresiones/bloques de código embebidos en un .ws, usando un parser
// JS real (Acorn) para encontrar identificadores "libres" con precisión real de
// scoping -- reemplaza (cuando está disponible) la pila de heurísticas de regex de
// compiler.js/validate.js.
//
// Si "acorn" no está instalado, o el fragmento de código no logra parsear (por
// ejemplo, texto incompleto que solo tiene sentido pegado al resto del handler),
// este módulo devuelve null y el llamante cae automáticamente al motor de regex que
// ya existía -- nunca rompe nada, solo mejora cuando puede.

let acorn = null;
try {
  acorn = require('acorn');
} catch (e) {
  acorn = null;
}

function isAvailable() {
  return !!acorn;
}

// Intenta parsear `code` como una única expresión (interpolaciones, condiciones de
// if, iterables de for); si no consume el texto entero o falla, lo intenta como un
// programa completo (varias sentencias, como el cuerpo de un handler o de una
// función). Devuelve { node, isExpression } o null si ninguna de las dos formas
// logra parsear.
function parseFlexible(code) {
  if (!acorn) return null;
  const trimmed = code.trim();
  if (trimmed === '') return null;

  try {
    const node = acorn.parseExpressionAt(code, 0, { ecmaVersion: 'latest' });
    const rest = code.slice(node.end).trim();
    if (rest === '' || rest === ';') {
      return { node, isExpression: true };
    }
  } catch (e) {
    // no era una única expresión completa -- se intenta como programa abajo
  }

  try {
    const program = acorn.parse(code, {
      ecmaVersion: 'latest',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    });
    return { node: program, isExpression: false };
  } catch (e) {
    return null;
  }
}

// Recorre el AST y devuelve todas las referencias "libres" a identificadores --
// { name, start, end, expand }. "expand" marca los atajos de objeto (`{ contador }`)
// que necesitan expandirse a `contador: prefix.contador`, no solo sustituirse.
// Identificadores sombreados por una variable local del propio fragmento (parámetros
// de función, destructuring, `const`/`let`/`var`, catch) NO se incluyen -- son
// variables nuevas, no referencias a `reactive`/`var` externas.
function analyzeReferences(code) {
  const parsed = parseFlexible(code);
  if (!parsed) return null;

  const refs = [];
  const scopeStack = [new Set()];

  function isBound(name) {
    for (let i = scopeStack.length - 1; i >= 0; i--) {
      if (scopeStack[i].has(name)) return true;
    }
    return false;
  }
  function pushScope() { scopeStack.push(new Set()); }
  function popScope() { scopeStack.pop(); }
  function bindName(name) { scopeStack[scopeStack.length - 1].add(name); }

  function record(node, expand) {
    if (isBound(node.name)) return;
    refs.push({ name: node.name, start: node.start, end: node.end, expand: !!expand });
  }

  // Añade al ámbito actual los nombres que declara un patrón (destructuring,
  // parámetro, identificador simple). Los valores por defecto (AssignmentPattern.right)
  // SÍ pueden referenciar variables externas -- se visitan como expresión normal.
  function bindPattern(pattern) {
    if (!pattern) return;
    switch (pattern.type) {
      case 'Identifier':
        bindName(pattern.name);
        return;
      case 'ObjectPattern':
        for (const prop of pattern.properties) {
          if (prop.type === 'RestElement') { bindPattern(prop.argument); continue; }
          if (prop.value && prop.value.type === 'AssignmentPattern') {
            bindPattern(prop.value.left);
            visitExpr(prop.value.right);
          } else {
            bindPattern(prop.value);
          }
        }
        return;
      case 'ArrayPattern':
        for (const el of pattern.elements) {
          if (!el) continue;
          if (el.type === 'AssignmentPattern') { bindPattern(el.left); visitExpr(el.right); }
          else bindPattern(el);
        }
        return;
      case 'AssignmentPattern':
        bindPattern(pattern.left);
        visitExpr(pattern.right);
        return;
      case 'RestElement':
        bindPattern(pattern.argument);
        return;
      default:
        return;
    }
  }

  function visitExpr(node) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'Identifier':
        record(node, false);
        return;
      case 'Literal':
      case 'ThisExpression':
      case 'Super':
        return;
      case 'MemberExpression':
        visitExpr(node.object);
        if (node.computed) visitExpr(node.property);
        return;
      case 'CallExpression':
      case 'NewExpression':
        visitExpr(node.callee);
        node.arguments.forEach(visitExpr);
        return;
      case 'ArrayExpression':
        node.elements.forEach(el => el && visitExpr(el));
        return;
      case 'ObjectExpression':
        for (const prop of node.properties) {
          if (prop.type === 'SpreadElement') { visitExpr(prop.argument); continue; }
          if (prop.computed) visitExpr(prop.key);
          if (prop.shorthand) record(prop.value, true);
          else visitExpr(prop.value);
        }
        return;
      case 'SpreadElement':
        visitExpr(node.argument);
        return;
      case 'BinaryExpression':
      case 'LogicalExpression':
        visitExpr(node.left);
        visitExpr(node.right);
        return;
      case 'UnaryExpression':
      case 'UpdateExpression':
        visitExpr(node.argument);
        return;
      case 'AssignmentExpression':
        if (node.left.type === 'Identifier') record(node.left, false);
        else if (node.left.type === 'MemberExpression') visitExpr(node.left);
        // destructuring en una asignación SIN declarar ("({a} = obj)") se deja
        // intacto -- caso raro, documentado como límite conocido.
        visitExpr(node.right);
        return;
      case 'ConditionalExpression':
        visitExpr(node.test);
        visitExpr(node.consequent);
        visitExpr(node.alternate);
        return;
      case 'SequenceExpression':
        node.expressions.forEach(visitExpr);
        return;
      case 'TemplateLiteral':
        node.expressions.forEach(visitExpr);
        return;
      case 'TaggedTemplateExpression':
        visitExpr(node.tag);
        visitExpr(node.quasi);
        return;
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        pushScope();
        node.params.forEach(bindPattern);
        if (node.body.type === 'BlockStatement') visitStmt(node.body);
        else visitExpr(node.body);
        popScope();
        return;
      case 'AwaitExpression':
      case 'YieldExpression':
        if (node.argument) visitExpr(node.argument);
        return;
      case 'ChainExpression':
        visitExpr(node.expression);
        return;
      default:
        return;
    }
  }

  function visitStmt(node) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'Program':
      case 'BlockStatement':
        pushScope();
        node.body.forEach(visitStmt);
        popScope();
        return;
      case 'ExpressionStatement':
        visitExpr(node.expression);
        return;
      case 'VariableDeclaration':
        for (const decl of node.declarations) {
          if (decl.init) visitExpr(decl.init);
          bindPattern(decl.id);
        }
        return;
      case 'IfStatement':
        visitExpr(node.test);
        visitStmt(node.consequent);
        if (node.alternate) visitStmt(node.alternate);
        return;
      case 'ForStatement':
        pushScope();
        if (node.init) { if (node.init.type === 'VariableDeclaration') visitStmt(node.init); else visitExpr(node.init); }
        if (node.test) visitExpr(node.test);
        if (node.update) visitExpr(node.update);
        visitStmt(node.body);
        popScope();
        return;
      case 'ForInStatement':
      case 'ForOfStatement':
        pushScope();
        if (node.left.type === 'VariableDeclaration') bindPattern(node.left.declarations[0].id);
        else visitExpr(node.left);
        visitExpr(node.right);
        visitStmt(node.body);
        popScope();
        return;
      case 'WhileStatement':
        visitExpr(node.test);
        visitStmt(node.body);
        return;
      case 'DoWhileStatement':
        visitStmt(node.body);
        visitExpr(node.test);
        return;
      case 'ReturnStatement':
        if (node.argument) visitExpr(node.argument);
        return;
      case 'TryStatement':
        visitStmt(node.block);
        if (node.handler) {
          pushScope();
          if (node.handler.param) bindPattern(node.handler.param);
          visitStmt(node.handler.body);
          popScope();
        }
        if (node.finalizer) visitStmt(node.finalizer);
        return;
      case 'ThrowStatement':
        visitExpr(node.argument);
        return;
      case 'SwitchStatement':
        visitExpr(node.discriminant);
        pushScope();
        for (const c of node.cases) {
          if (c.test) visitExpr(c.test);
          c.consequent.forEach(visitStmt);
        }
        popScope();
        return;
      case 'FunctionDeclaration':
        bindName(node.id.name);
        pushScope();
        node.params.forEach(bindPattern);
        visitStmt(node.body);
        popScope();
        return;
      case 'LabeledStatement':
        visitStmt(node.body);
        return;
      case 'BreakStatement':
      case 'ContinueStatement':
      case 'EmptyStatement':
        return;
      default:
        return;
    }
  }

  if (parsed.isExpression) visitExpr(parsed.node);
  else visitStmt(parsed.node);

  return refs;
}

module.exports = { isAvailable, analyzeReferences };
