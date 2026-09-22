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
const { routePatternFor } = require("../route-pattern");
const { findWsfFiles, findWsbFiles } = require("../discover-files");

const SELF_COMPILER_DIR = path.resolve(__dirname, ".."); // compiler/ de este propio paquete
const LIB_TEMPLATE_DIR = path.join(SELF_COMPILER_DIR, "templates", "lib"); // vendorizado DENTRO del paquete, no en una carpeta hermana — así funciona igual instalado globalmente

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
	"codegen-wsdb.js",
	"type-check.js",
	"codegen-ssr.js",
	"resolve-imports.js",
	"runtime.js",
	"wson-runtime.js",
	"validate-js-body.js",
	"check-lib.js",
	"route-pattern.js",
	"discover-files.js",
	"cli.js",
];

const LIB_FILES = ["Visual.ws", "WSON.ws"];

const WCONFIG_TEMPLATE =
	JSON.stringify(
		{
			port: 3000,
			"rate-limit-max": 300,
			"rate-limit-window-ms": 60000,
			"session-store": "memory",
			"session-dir": ".sessions",
			"session-timeout-ms": 1800000,
			"session-max": 10000,
			"session-lock-timeout-ms": 5000,
			"session-lock-stale-ms": 5000,
			"session-lock-retry-ms": 20,
			"redis-url": "redis://localhost:6379",
			"redis-connect-timeout-ms": 3000,
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

# Sesiones persistidas si "session-store": "file" — son datos de sesiones
# de visitantes, no código fuente.
.sessions/
`;

function copyFile(src, dest) {
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(src, dest);
}

function vendorLib(targetDir) {
	const libDir = path.join(targetDir, "lib");
	for (const file of LIB_FILES) {
		copyFile(path.join(LIB_TEMPLATE_DIR, file), path.join(libDir, file));
	}
	const lock = buildLock(libDir, LIB_FILES);
	fs.writeFileSync(path.join(libDir, ".websc-lock.json"), JSON.stringify(lock, null, "\t") + "\n");
}

function copyDirRecursive(src, dest) {
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const s = path.join(src, entry.name);
		const d = path.join(dest, entry.name);
		if (entry.isDirectory()) copyDirRecursive(s, d);
		else fs.copyFileSync(s, d);
	}
}

// Paquetes de los que depende el compilador en sí (no del proyecto del
// usuario) — se vendorizan igual que el resto: copiados de verdad, sin
// que el proyecto generado necesite hacer su propio `npm install` para
// que el compilador funcione.
const COMPILER_DEPENDENCIES = ["acorn", "acorn-walk", "node-sqlite3-wasm"];

function vendorCompiler(targetDir) {
	for (const file of COMPILER_FILES) {
		copyFile(path.join(SELF_COMPILER_DIR, file), path.join(targetDir, "compiler", file));
	}
	for (const dep of COMPILER_DEPENDENCIES) {
		copyDirRecursive(
			path.join(SELF_COMPILER_DIR, "node_modules", dep),
			path.join(targetDir, "compiler", "node_modules", dep)
		);
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
// fichero. Ver route-pattern.js (compartido con serve-demo.js).

// Las dos únicas fuentes de variabilidad por petición que existen hoy son
// :params en la ruta y el query string — sin ninguna de las dos, el HTML
// que produce el SSR es el MISMO para cualquier visitante, así que se
// puede generar una sola vez en el build (SSG) en vez de en cada petición.
function usesVisualQuery(ast) {
	return ast.body.some((n) => (n.type === "ConstDecl" || n.type === "VarDecl") && /Visual\.query\(/.test(n.expr));
}

// Visual.staticPaths(screen, posts) — para una página CON :params cuyos
// valores posibles se conocen de antemano (un blog con tres posts, p.
// ej.): en vez de renderizar por SSR en cada petición, se pre-generan sus
// .html reales en el build, uno por cada combinación en `posts`. `posts`
// es un valor YA CALCULADO en tiempo de compilación — típicamente
// importado de un .json (`import posts from "./posts.json"`), pero puede
// ser cualquier `const`/`var` de nivel superior del propio fichero cuyo
// valor sea conocido sin ejecutar nada por petición. No hace falta ningún
// cuerpo de bloque ni esperar nada: al ser ya un valor resuelto, ni
// siquiera entra en juego "Async/await implícito".
function findStaticPathsCall(ast) {
	return ast.body.find((n) => n.type === "Raw" && /^Visual\.staticPaths\(/.test(n.text));
}

// Resuelve el valor real de `varName` evaluando las declaraciones de
// nivel superior del propio fichero (las suyas y las que traiga por
// import — incluido un .json, que ya llega como const literal) hasta
// llegar a ella. Se excluyen las que dependen de Visual.route()/params()/
// query() — irrelevantes aquí, y el `Visual` real ni siquiera está
// disponible en este contexto de build.
function resolveTopLevelValue(ast, varName, wsfFullPath, srcDir) {
	const { collectImportedPieces } = loadCompilerModule("codegen-client");
	const Module = require("module");
	const imported = collectImportedPieces(ast, srcDir);
	const localDecls = ast.body.filter(
		(n) => (n.type === "ConstDecl" || n.type === "VarDecl") && !/\bVisual\.(route|params|query)\(/.test(n.expr)
	);
	const allDecls = [...imported.topLevelInits, ...localDecls];
	const lines = allDecls.map((n) => `${n.type === "ConstDecl" ? "const" : "let"} ${n.name} = ${n.expr};`);
	const script = [...lines, `return ${varName};`].join("\n");
	// eslint-disable-next-line no-new-func
	const fn = new Function("require", "__dirname", "__filename", script);
	// require()/__dirname resueltos relativos al propio .wsf, no a
	// bin/websc.js — por si alguna declaración usa require() ella misma.
	return fn(Module.createRequire(wsfFullPath), path.dirname(wsfFullPath), wsfFullPath);
}

// Sustituye cada :nombre del patrón por el valor real de esa combinación
// — "/blog/:slug" + { slug: "post-1" } -> "/blog/post-1".
function resolvePatternWithParams(pattern, params) {
	return pattern.replace(/:(\w+)/g, (_, name) => {
		if (!(name in params)) {
			throw new Error(`Visual.staticPaths() no incluye el param ":${name}" que pide la ruta "${pattern}"`);
		}
		return encodeURIComponent(params[name]);
	});
}

// Nombre de fichero seguro para una combinación de params — se unen sus
// valores con "-", saneando cualquier carácter que no sea válido en un
// nombre de fichero (una barra, por ejemplo, si el valor la incluyera).
function fileNameForCombo(baseName, params) {
	const sufijo = Object.values(params)
		.map((v) => String(v).replace(/[^a-zA-Z0-9_-]+/g, "-"))
		.join("-");
	return `${baseName}-${sufijo}.html`;
}

async function cmdBuild(targetDir) {
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
	const { renderPageToHTML } = loadCompilerModule("codegen-ssr");

	const distDir = path.join(targetDir, "dist");
	fs.rmSync(distDir, { recursive: true, force: true });
	fs.mkdirSync(distDir, { recursive: true });

	const wsfFiles = findWsfFiles(srcDir).map((f) => path.basename(f));
	const wsbFiles = findWsbFiles(srcDir).map((f) => path.basename(f));

	// --- Cliente: un bundle por cada .wsf "page". El HTML de una página
	// SIN :params en su ruta ni uso de Visual.query() no puede variar entre
	// visitantes (son las dos únicas fuentes de variabilidad por petición
	// que existen hoy) — se genera UNA VEZ aquí (SSG real), no en cada
	// petición. El resto sigue con SSR dinámico real en dist/server.js.
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

		const staticPathsCall = pattern.includes(":") ? findStaticPathsCall(ast) : null;

		if (staticPathsCall) {
			const m = /^Visual\.staticPaths\(\s*\w+\s*,\s*(\w+)\s*\)$/.exec(staticPathsCall.text);
			if (!m) {
				throw new Error(
					`Visual.staticPaths() en ${file}: formato no reconocido — se espera Visual.staticPaths(screen, nombreDeVariable)`
				);
			}
			// Se conocen de antemano los valores posibles de :params —
			// `posts` ya es un valor resuelto en tiempo de compilación
			// (típicamente importado de un .json), así que se genera un
			// .html por combinación sin ejecutar ni esperar nada más.
			const combos = resolveTopLevelValue(ast, m[1], fullPath, srcDir);
			if (!Array.isArray(combos)) {
				throw new Error(`Visual.staticPaths() en ${file}: "${m[1]}" debe ser un array de objetos, no ${typeof combos}`);
			}
			for (const combo of combos) {
				const rutaResuelta = resolvePatternWithParams(pattern, combo);
				const ssrHtml = renderPageToHTML(ast, { baseDir: srcDir, requestUrl: rutaResuelta });
				const htmlFile = fileNameForCombo(baseName, combo);
				const html = `<!DOCTYPE html>\n<html lang="es">\n<head><meta charset="UTF-8"></head>\n<body>${ssrHtml}<script>${bundle}</script></body>\n</html>\n`;
				fs.writeFileSync(path.join(distDir, htmlFile), html);
				pages.push({ wsfFile: `../src/${file}`, pattern: rutaResuelta, bundleFile, static: true, htmlFile });
			}
			// La ruta dinámica sigue registrada, como red de seguridad: si
			// alguien visita una combinación que no estaba en la lista
			// (contenido nuevo, aún no incluido en el build), responde con
			// SSR real en vez de un 404 sorpresa.
			pages.push({ wsfFile: `../src/${file}`, pattern, bundleFile, static: false, staticPathsFallback: true });
			continue;
		}

		const isStatic = !pattern.includes(":") && !usesVisualQuery(ast);
		const page = { wsfFile: `../src/${file}`, pattern, bundleFile, static: isStatic };

		if (isStatic) {
			const ssrHtml = renderPageToHTML(ast, { baseDir: srcDir, requestUrl: pattern });
			const htmlFile = `${baseName}.html`;
			const html = `<!DOCTYPE html>\n<html lang="es">\n<head><meta charset="UTF-8"></head>\n<body>${ssrHtml}<script>${bundle}</script></body>\n</html>\n`;
			fs.writeFileSync(path.join(distDir, htmlFile), html);
			page.htmlFile = htmlFile;
		}

		pages.push(page);
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
	for (const p of pages) {
		const modo = p.static ? `SSG: ${p.htmlFile} (precalculado en el build)` : `SSR dinámico de ${p.wsfFile}`;
		console.log(`  GET  ${p.pattern}  ->  ${modo} (+ ${p.bundleFile})`);
	}
	if (wsbFiles.length > 0) console.log(`  API: ${wsbFiles.join(", ")}`);
	console.log("\nEjecutar con: node dist/server.js");
}

const SERVER_JS_TEMPLATE = `#!/usr/bin/env node
// dist/server.js — generado por ` + "`websc build`" + `, no editar a mano.
// Ejecutar: node dist/server.js
//
// Cada página es SSG (HTML precalculado en el build, servido tal cual —
// para páginas sin :params en su ruta ni uso de Visual.query(), las
// únicas dos fuentes de variabilidad por petición que existen hoy) o SSR
// dinámico real (se vuelve a renderizar en cada petición, para que
// :params/query salgan bien). El bundle de cliente siempre está
// precompilado y cacheado, sea cual sea el caso.

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
const pages = pagesInfo.map((p) => {
	let ast = null;
	let loadError = null;
	if (!p.static) {
		// Estática (SSG): el HTML ya está en disco, no hace falta el AST.
		// Dinámica: necesita el AST para renderizar en el momento, contra
		// la URL real — pero si su fuente ya no existe (p. ej. un proyecto
		// desplegado solo con las rutas de Visual.staticPaths() ya
		// generadas, sin conservar los .wsf), eso no debe tumbar TODO el
		// servidor al arrancar — solo afecta a esta ruta en concreto, y
		// solo si alguien la visita de verdad.
		try {
			ast = parse(fs.readFileSync(path.join(distDir, p.wsfFile), "utf8"));
		} catch (err) {
			loadError = err.message;
		}
	}
	return {
		...p,
		ast,
		loadError,
		html: p.static ? fs.readFileSync(path.join(distDir, p.htmlFile), "utf8") : null,
		bundle: fs.readFileSync(path.join(distDir, p.bundleFile), "utf8"),
		matcher: compileRoutePatternClient(p.pattern),
	};
});

const wsbFiles = JSON.parse(fs.readFileSync(path.join(distDir, "wsb-files.json"), "utf8"));

let apiHandler = null;
if (wsbFiles.length > 0) {
	const combinedBody = [];
	for (const rel of wsbFiles) {
		const fullPath = path.join(distDir, rel);
		combinedBody.push(...parse(fs.readFileSync(fullPath, "utf8")).body);
	}
	apiHandler = createRequestHandler({ type: "Program", body: combinedBody }, wconfig, { baseDir: srcDir, sessionBaseDir: projectDir });
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, \`http://\${req.headers.host}\`);

	if (req.method === "GET") {
		const page = pages.find((p) => p.matcher.regex.test(url.pathname));
		if (page) {
			if (page.loadError) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: \`No se pudo cargar esta página: \${page.loadError}\` }));
				return;
			}
			const html = page.static
				? page.html
				: \`<!DOCTYPE html>\\n<html lang="es">\\n<head><meta charset="UTF-8"></head>\\n<body>\${renderPageToHTML(page.ast, { baseDir: srcDir, requestUrl: req.url })}<script>\${page.bundle}</script></body>\\n</html>\\n\`;
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

async function main() {
	const [, , command, target] = process.argv;
	const targetDir = path.resolve(target || ".");

	try {
		if (command === "init") return cmdInit(targetDir);
		if (command === "update") return cmdUpdate(targetDir);
		if (command === "build") return await cmdBuild(targetDir);
	} catch (err) {
		console.error(`Error: ${err.message}`);
		process.exitCode = 1;
		return;
	}

	console.log("Uso:");
	console.log("  websc init <carpeta>    — crear un proyecto nuevo");
	console.log("  websc update <carpeta>  — actualizar lib/ y compiler/ de un proyecto existente");
	console.log("  websc build <carpeta>   — compilar src/ a dist/ (HTML de cliente + server.js)");
	process.exitCode = 1;
}

main();
