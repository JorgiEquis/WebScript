// resolve-imports.js — WebScript, v0
//
// Dado un directorio base y la ruta de un `import`, encuentra el fichero
// real probando las extensiones del lenguaje en orden. Compartido entre
// codegen-client.js (componentes .wsf, funciones .ws) y codegen-server.js
// (DTOs .wson, funciones .ws).

const fs = require("fs");
const path = require("path");

function resolveImportPath(baseDir, importPath) {
	const candidates = [importPath, `${importPath}.wsf`, `${importPath}.wsb`, `${importPath}.ws`, `${importPath}.wson`];
	for (const candidate of candidates) {
		const full = path.resolve(baseDir, candidate);
		if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
	}
	return null;
}

module.exports = { resolveImportPath };
