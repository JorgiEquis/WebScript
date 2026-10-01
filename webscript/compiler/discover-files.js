// discover-files.js — WebScript, v0
//
// Encuentra los .wsf/.wsb "servibles" de un directorio, compartido entre
// bin/websc.js y serve-demo.js para que escanear una carpeta entera se
// comporte igual en los dos sitios. findWsfFiles SÍ recorre subcarpetas
// (una página nueva sin Visual.route() saca su ruta de la ruta del propio
// fichero); findWsbFiles sigue plana, sin cambios — no se ha tocado el
// descubrimiento de .wsb.

const fs = require("fs");
const path = require("path");
const { parse } = require("./parser");
const { resolveImportPath } = require("./resolve-imports");

// findWsfFiles SÍ recorre subcarpetas (a diferencia de findWsbFiles, que
// sigue plana a propósito — no se ha pedido tocar el descubrimiento de
// .wsb): la ruta de una página nueva (sin Visual.route()) sale de la ruta
// del propio fichero — src/api/listaProductos.wsf → /api/listaProductos —
// así que hace falta encontrarlo primero. Devuelve rutas COMPLETAS, como
// antes; quien llama calcula la ruta relativa a `srcDir` para el patrón de
// ruta y el nombre de los ficheros de salida.
function findWsfFiles(srcDir) {
	const result = [];
	for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
		const fullPath = path.join(srcDir, entry.name);
		if (entry.isDirectory()) {
			result.push(...findWsfFiles(fullPath));
		} else if (entry.name.endsWith(".wsf")) {
			result.push(fullPath);
		}
	}
	return result;
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
