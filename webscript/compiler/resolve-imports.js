// resolve-imports.js — WebScript, v0
//
// Dado un directorio base y la ruta de un `import`, encuentra el fichero
// real probando las extensiones del lenguaje en orden (más `.js`, para
// poder importar JS normal ya existente). Compartido entre
// codegen-client.js (componentes .wsf, funciones .ws) y codegen-server.js
// (DTOs .wson, funciones .ws).

const fs = require("fs");
const path = require("path");

function resolveImportPath(baseDir, importPath) {
	const candidates = [
		importPath,
		`${importPath}.wsf`,
		`${importPath}.wsb`,
		`${importPath}.ws`,
		`${importPath}.wson`,
		`${importPath}.wsdb`,
		`${importPath}.js`,
	];
	for (const candidate of candidates) {
		const full = path.resolve(baseDir, candidate);
		if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
	}
	return null;
}

// Un import es un paquete de npm (no un fichero propio del proyecto) si
// no empieza por "." ni "/" — mismo criterio que usa Node para distinguir
// un specifier relativo de uno de paquete.
function isPackageSpecifier(importPath) {
	return !importPath.startsWith(".") && !importPath.startsWith("/");
}

// Resuelve un paquete de npm real (o nativo de Node) usando la propia
// resolución de módulos de Node — camina hacia arriba por node_modules
// desde `baseDir`, igual que haría un require() normal ahí.
function resolvePackage(baseDir, packageSpecifier) {
	try {
		return require.resolve(packageSpecifier, { paths: [baseDir] });
	} catch {
		return null;
	}
}

module.exports = { resolveImportPath, isPackageSpecifier, resolvePackage };
