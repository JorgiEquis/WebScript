// discover-files.js — WebScript, v0
//
// Encuentra los .wsf/.wsb "servibles" de un directorio (no recursivo,
// igual que websc build) — compartido entre bin/websc.js y serve-demo.js,
// para que escanear una carpeta entera se comporte igual en los dos
// sitios.

const fs = require("fs");
const path = require("path");
const { parse } = require("./parser");
const { resolveImportPath } = require("./resolve-imports");

function findWsfFiles(srcDir) {
	return fs
		.readdirSync(srcDir)
		.filter((f) => f.endsWith(".wsf"))
		.map((f) => path.join(srcDir, f));
}

// Un .wsb importado explícitamente por otro .wsb del propio directorio es
// una pieza de librería (rutas/funciones reexportadas) — no se sirve por
// su cuenta, solo a través de quien lo importa (que ya resuelve ese
// `import` por sí mismo, vía resolveImports). Servirlo TAMBIÉN por
// separado duplicaría sus rutas.
function findWsbFiles(srcDir) {
	const allWsbFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith(".wsb"));
	const importedWsbFiles = new Set();
	for (const file of allWsbFiles) {
		const ast = parse(fs.readFileSync(path.join(srcDir, file), "utf8"));
		for (const node of ast.body) {
			if (node.type !== "Import") continue;
			const targetPath = resolveImportPath(srcDir, node.from);
			if (targetPath && targetPath.endsWith(".wsb")) {
				importedWsbFiles.add(path.basename(targetPath));
			}
		}
	}
	return allWsbFiles.filter((f) => !importedWsbFiles.has(f)).map((f) => path.join(srcDir, f));
}

module.exports = { findWsfFiles, findWsbFiles };
