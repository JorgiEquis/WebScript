#!/usr/bin/env node
// bin/websc.js — WebScript, v0
//
// `websc init <carpeta>`: crea un proyecto nuevo — src/, lib/ (con su
// lock de hashes), wconfig.json, .gitignore, y una copia vendorizada del
// compilador (cada proyecto lleva la suya, como se decidió en DISEÑO.md).
//
// `websc update <carpeta>`: regenera lib/ y compiler/ (con el lock nuevo)
// sin tocar src/, wconfig.json, ni nada del código del usuario.

const fs = require("fs");
const path = require("path");
const { buildLock } = require("../check-lib");

const SELF_COMPILER_DIR = path.resolve(__dirname, ".."); // compiler/ de este propio repo
const PROJECT_ROOT = path.resolve(SELF_COMPILER_DIR, ".."); // raíz del repo, donde vive lib/

// Los mismos ficheros que ya forman el compilador real de este repo — se
// vendorizan tal cual en cada proyecto generado.
const COMPILER_FILES = [
	"lexer.js",
	"html-parser.js",
	"parser.js",
	"codegen.js",
	"codegen-client.js",
	"codegen-server.js",
	"codegen-dto.js",
	"codegen-ssr.js",
	"resolve-imports.js",
	"runtime.js",
	"wson-runtime.js",
	"check-lib.js",
	"cli.js",
];

const LIB_FILES = ["Visual.ws", "WSON.ws"];

const WCONFIG_TEMPLATE =
	JSON.stringify(
		{
			port: 3000,
			"rate-limit-max": 300,
			"rate-limit-window-ms": 60000,
			stylesheets: [],
		},
		null,
		"\t"
	) + "\n";

// Esta plantilla es la que se instala en un proyecto NUEVO (generado por
// `websc init`) — ahí lib/ y compiler/ sí son vendorizados/regenerables.
// No es el .gitignore de este propio repo (aquí compiler/ es código real).
const GENERATED_PROJECT_GITIGNORE = `# Vendorizado por \`websc init\` — regenerable con \`websc update\`
lib/
compiler/
node_modules/
`;

function copyFile(src, dest) {
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(src, dest);
}

function vendorLib(targetDir) {
	const libDir = path.join(targetDir, "lib");
	for (const file of LIB_FILES) {
		copyFile(path.join(PROJECT_ROOT, "lib", file), path.join(libDir, file));
	}
	const lock = buildLock(libDir, LIB_FILES);
	fs.writeFileSync(path.join(libDir, ".websc-lock.json"), JSON.stringify(lock, null, "\t") + "\n");
}

function vendorCompiler(targetDir) {
	for (const file of COMPILER_FILES) {
		copyFile(path.join(SELF_COMPILER_DIR, file), path.join(targetDir, "compiler", file));
	}
}

function writeIfMissing(filePath, content) {
	if (fs.existsSync(filePath)) return false;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	return true;
}

function cmdInit(targetDir) {
	if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
		console.error(`"${targetDir}" ya existe y no está vacío.`);
		process.exitCode = 1;
		return;
	}

	fs.mkdirSync(path.join(targetDir, "src"), { recursive: true });
	vendorLib(targetDir);
	vendorCompiler(targetDir);
	writeIfMissing(path.join(targetDir, "wconfig.json"), WCONFIG_TEMPLATE);
	writeIfMissing(path.join(targetDir, ".gitignore"), GENERATED_PROJECT_GITIGNORE);

	console.log(`Proyecto WebScript creado en ${targetDir}`);
	console.log("  src/        — tu código");
	console.log("  lib/        — núcleo del lenguaje (no editable, protegido)");
	console.log("  compiler/   — compilador vendorizado (regenerable con `websc update`)");
	console.log("  wconfig.json");
}

function cmdUpdate(targetDir) {
	if (!fs.existsSync(targetDir)) {
		console.error(`"${targetDir}" no existe.`);
		process.exitCode = 1;
		return;
	}
	if (!fs.existsSync(path.join(targetDir, "lib")) && !fs.existsSync(path.join(targetDir, "compiler"))) {
		console.error(`"${targetDir}" no parece un proyecto WebScript (no tiene lib/ ni compiler/).`);
		process.exitCode = 1;
		return;
	}

	vendorLib(targetDir);
	vendorCompiler(targetDir);
	console.log(`lib/ y compiler/ actualizados en ${targetDir} — src/ y wconfig.json intactos.`);
}

function loadCompilerModule(name) {
	return require(path.join(SELF_COMPILER_DIR, name));
}

// Patrón de ruta de una página: el de su Visual.route() tal cual (con
// :params si los tiene — el matching real, por petición, lo hace
// dist/server.js) o, si no declara ninguno, "/" + su propio nombre de
// fichero.
function routePatternFor(ast, baseName) {
	const routeDecl = ast.body.find(
		(n) => (n.type === "ConstDecl" || n.type === "VarDecl") && /^Visual\.route\(/.test(n.expr)
	);
	if (routeDecl) {
		const m = /^Visual\.route\(\s*['"]([^'"]+)['"]\s*\)$/.exec(routeDecl.expr);
		if (m) return m[1];
	}
	return `/${baseName}`;
}

function cmdBuild(targetDir) {
	const srcDir = path.join(targetDir, "src");
	if (!fs.existsSync(srcDir)) {
		console.error(`"${targetDir}" no tiene una carpeta src/.`);
		process.exitCode = 1;
		return;
	}

	const { parse } = loadCompilerModule("parser");
	const { classifyWsf } = loadCompilerModule("codegen");
	const { generateClientBundle } = loadCompilerModule("codegen-client");
	const { createRequestHandler } = loadCompilerModule("codegen-server");

	const distDir = path.join(targetDir, "dist");
	fs.rmSync(distDir, { recursive: true, force: true });
	fs.mkdirSync(distDir, { recursive: true });

	const allFiles = fs.readdirSync(srcDir);
	const wsfFiles = allFiles.filter((f) => f.endsWith(".wsf"));
	const wsbFiles = allFiles.filter((f) => f.endsWith(".wsb"));

	// --- Cliente: un bundle por cada .wsf "page". El SSR NO se precalcula
	// aquí — depende de la URL real de cada petición (p. ej. :id), así que
	// se hace en dist/server.js, en el momento de cada request. Lo único
	// que sí es independiente de la petición (y por tanto cacheable de
	// una vez) es el bundle JS del cliente.
	const pages = [];
	let sawRoot = false;

	for (const file of wsfFiles) {
		const fullPath = path.join(srcDir, file);
		const ast = parse(fs.readFileSync(fullPath, "utf8"));
		if (classifyWsf(ast) !== "page") continue; // library: no genera página propia

		const bundle = generateClientBundle(ast, { baseDir: srcDir });
		const baseName = path.basename(file, ".wsf");
		const bundleFile = `${baseName}.bundle.js`;
		fs.writeFileSync(path.join(distDir, bundleFile), bundle);

		const pattern = routePatternFor(ast, baseName);
		if (pattern === "/") sawRoot = true;
		pages.push({ wsfFile: `../src/${file}`, pattern, bundleFile });
	}

	// Si ninguna página reclamó "/", la primera (orden de aparición en
	// src/) se sirve también ahí, de regalo.
	if (!sawRoot && pages.length > 0) {
		pages.push({ ...pages[0], pattern: "/" });
	}

	fs.writeFileSync(path.join(distDir, "pages.json"), JSON.stringify(pages, null, "\t") + "\n");

	// --- Servidor: valida que TODOS los .wsb combinados no colisionen ---
	const wsbRelativePaths = wsbFiles.map((f) => `../src/${f}`);
	if (wsbFiles.length > 0) {
		const combinedBody = [];
		for (const file of wsbFiles) {
			const ast = parse(fs.readFileSync(path.join(srcDir, file), "utf8"));
			combinedBody.push(...ast.body);
		}
		// Solo para validar en tiempo de build que no colisionan entre sí —
		// dist/server.js vuelve a compilarlos igual al arrancar.
		createRequestHandler({ type: "Program", body: combinedBody }, {}, { baseDir: srcDir });
	}
	fs.writeFileSync(path.join(distDir, "wsb-files.json"), JSON.stringify(wsbRelativePaths, null, "\t") + "\n");

	fs.writeFileSync(path.join(distDir, "server.js"), SERVER_JS_TEMPLATE);

	console.log(`Compilado en ${distDir}`);
	for (const p of pages) console.log(`  GET  ${p.pattern}  ->  SSR de ${p.wsfFile} (+ ${p.bundleFile})`);
	if (wsbFiles.length > 0) console.log(`  API: ${wsbFiles.join(", ")}`);
	console.log("\nEjecutar con: node dist/server.js");
}

const SERVER_JS_TEMPLATE = `#!/usr/bin/env node
// dist/server.js — generado por ` + "`websc build`" + `, no editar a mano.
// Ejecutar: node dist/server.js
//
// SSR real por petición: cada GET que coincide con el patrón de una
// página vuelve a renderizar su HTML contra la URL exacta de esa
// petición (para que :params en Visual.route() salgan bien) — el bundle
// de cliente sí está precompilado y cacheado, porque no depende de la
// petición.

const fs = require("fs");
const path = require("path");
const http = require("http");
const { parse } = require("../compiler/parser");
const { createRequestHandler } = require("../compiler/codegen-server");
const { renderPageToHTML } = require("../compiler/codegen-ssr");
const { compileRoutePatternClient } = require("../compiler/runtime");

const distDir = __dirname;
const projectDir = path.resolve(distDir, "..");
const srcDir = path.join(projectDir, "src");

let wconfig = {};
try {
	wconfig = JSON.parse(fs.readFileSync(path.join(projectDir, "wconfig.json"), "utf8"));
} catch {
	// sin wconfig.json: valores por defecto
}

const pagesInfo = JSON.parse(fs.readFileSync(path.join(distDir, "pages.json"), "utf8"));
const pages = pagesInfo.map((p) => ({
	...p,
	ast: parse(fs.readFileSync(path.join(distDir, p.wsfFile), "utf8")),
	bundle: fs.readFileSync(path.join(distDir, p.bundleFile), "utf8"),
	matcher: compileRoutePatternClient(p.pattern),
}));

const wsbFiles = JSON.parse(fs.readFileSync(path.join(distDir, "wsb-files.json"), "utf8"));

let apiHandler = null;
if (wsbFiles.length > 0) {
	const combinedBody = [];
	for (const rel of wsbFiles) {
		const fullPath = path.join(distDir, rel);
		combinedBody.push(...parse(fs.readFileSync(fullPath, "utf8")).body);
	}
	apiHandler = createRequestHandler({ type: "Program", body: combinedBody }, wconfig, { baseDir: srcDir });
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, \`http://\${req.headers.host}\`);

	if (req.method === "GET") {
		const page = pages.find((p) => p.matcher.regex.test(url.pathname));
		if (page) {
			const ssrHtml = renderPageToHTML(page.ast, { baseDir: srcDir, requestUrl: req.url });
			const html = \`<!DOCTYPE html>\\n<html lang="es">\\n<head><meta charset="UTF-8"></head>\\n<body>\${ssrHtml}<script>\${page.bundle}</script></body>\\n</html>\\n\`;
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(html);
			return;
		}
	}

	if (apiHandler) return apiHandler(req, res);

	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "no encontrado" }));
});

const port = wconfig.port || 3000;
server.listen(port, () => console.log(\`Servidor en http://localhost:\${port}/\`));
`;

function main() {
	const [, , command, target] = process.argv;
	const targetDir = path.resolve(target || ".");

	if (command === "init") return cmdInit(targetDir);
	if (command === "update") return cmdUpdate(targetDir);
	if (command === "build") return cmdBuild(targetDir);

	console.log("Uso:");
	console.log("  websc init <carpeta>    — crear un proyecto nuevo");
	console.log("  websc update <carpeta>  — actualizar lib/ y compiler/ de un proyecto existente");
	console.log("  websc build <carpeta>   — compilar src/ a dist/ (HTML de cliente + server.js)");
	process.exitCode = 1;
}

main();
