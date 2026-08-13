const path = require('path');
const { parseProgram } = require('../../src/parser');
const { compile } = require('../../src/compiler');

// Compila una fuente WebScript inline (string) para un test. `filePath` es
// necesario solo si el test usa import; si no, un valor cualquiera sirve.
function compileSource(source, filePath = path.join(__dirname, '__inline__.ws'), options = {}) {
  const ast = parseProgram(source, filePath);
  return compile(ast, options);
}

function parseSource(source, filePath = path.join(__dirname, '__inline__.ws')) {
  return parseProgram(source, filePath);
}

module.exports = { compileSource, parseSource };
