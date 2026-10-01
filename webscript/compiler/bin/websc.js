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
	"wsdb-query.js",
	"type-check.js",
	"codegen-ssr.js",
	"resolve-imports.js",
	"runtime.js",
	"wson-runtime.js",
	"websocket-runtime.js",
	"wsclient-runtime.js",
	"validate-js-body.js",
	"check-lib.js",
	"route-pattern.js",
	"discover-files.js",
	"cli.js",
];

const LIB_FILES = ["Visual.ws", "WSON.ws", "WSSchema.ws", "WSDB.ws"];

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

// Mismo motivo que usesVisualQuery, para el sistema NUEVO (sin
// Visual.ws): una página sin `:param` en la ruta que use el `query`
// reservado en su HTML tampoco puede precalcularse una sola vez en el
// build — su contenido varía con la query string de cada petición. Se
// comprueba de forma deliberadamente conservadora (por texto, sin
// analizar árbol): un falso positivo solo hace que la página se sirva con
// SSR dinámico en vez de precalculada (siempre correcto, solo menos
// óptimo); un falso negativo serviría una query string SIEMPRE VACÍA —
// eso sí sería un bug real, y es lo que esto evita.
function usesReservedQuery(ast, target) {
	if (!target) return false;
	return /\bquery\b/.test(JSON.stringify(target.html));
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
//
// Cada declaración se evalúa POR SEPARADO, contra un ámbito que acumula las
// anteriores, y solo se exige que salga bien la que liga `varName` (o las
// que ella necesite). Antes era un único script con todas: cualquier
// declaración importada que no se pudiera evaluar aquí tumbaba el build
// entero aunque no tuviera nada que ver con `varName`. Con imports dentro de
// un .ws ese caso es mucho más fácil de alcanzar (un .ws puede arrastrar una
// const ligada a un módulo .js, o a algo que solo funciona en el navegador,
// que este script no necesita para nada). Los módulos .js embebidos se
// evalúan primero, también de forma tolerante.
function resolveTopLevelValue(ast, varName, wsfFullPath, srcDir) {
	const { collectImportedPieces, extractBoundNames } = loadCompilerModule("codegen-client");
	const Module = require("module");
	const imported = collectImportedPieces(ast, srcDir);
	const localDecls = ast.body.filter(
		(n) => (n.type === "ConstDecl" || n.type === "VarDecl") && !/\bVisual\.(route|params|query)\(/.test(n.expr)
	);
	const allDecls = [...imported.topLevelInits, ...localDecls];
	// require()/__dirname resueltos relativos al propio .wsf, no a
	// bin/websc.js — por si alguna declaración usa require() ella misma.
	const req = Module.createRequire(wsfFullPath);
	const dirName = path.dirname(wsfFullPath);
	const scope = Object.create(null);

	for (const src of imported.jsModuleSources || []) {
		const m = /^\s*const\s+(__jsmod_\d+)/.exec(src);
		if (!m) continue;
		try {
			// eslint-disable-next-line no-new-func
			scope[m[1]] = new Function("require", "__dirname", "__filename", `${src}\nreturn ${m[1]};`)(req, dirName, wsfFullPath);
		} catch {
			// un módulo que solo funciona en el navegador: si nada lo necesita aquí, da igual
		}
	}

	let causa = null;
	for (const decl of allDecls) {
		const bound = extractBoundNames(decl.name);
		try {
			// eslint-disable-next-line no-new-func
			const fn = new Function(
				"require",
				"__dirname",
				"__filename",
				"__scope",
				`with (__scope) { ${decl.type === "ConstDecl" ? "const" : "let"} ${decl.name} = ${decl.expr}; return { ${bound.join(", ")} }; }`
			);
			Object.assign(scope, fn(req, dirName, wsfFullPath, scope));
		} catch (e) {
			if (bound.includes(varName)) causa = e;
		}
	}
	if (!(varName in scope)) throw causa || new Error(`"${varName}" no está definida en ${path.relative(process.cwd(), wsfFullPath)}`);
	return scope[varName];
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

// Un .wsdb v2 ("-> name:") no genera ningún fichero propio en lib/ — su
// API es la de las interfaces fijas Schema/WSDB (ver templates/lib/), las
// mismas para cualquier colección. Lo que sí hace el build es validar
// TODOS los .wsdb del proyecto (v1 y v2), aunque ningún .wsb los importe
// todavía — incluida la resolución de "-> depends" (que el fichero
// nombrado exista y sea v2) — para que un error de declaración salga
// aquí, no en la primera petición real que use la colección.
function validateWsdbFiles(srcDir) {
	const { parse } = loadCompilerModule("parser");
	const { readWsdbV2, resolveDependsTargets } = loadCompilerModule("codegen-wsdb");

	(function walk(dir) {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				walk(full);
				continue;
			}
			if (!e.name.endsWith(".wsdb")) continue;
			const rel = path.relative(process.cwd(), full);
			let ast;
			try {
				ast = parse(fs.readFileSync(full, "utf8"), { isWsdbFile: true });
			} catch (e) {
				throw new Error(`${rel}: ${e.message}`);
			}
			const meta = readWsdbV2(ast, rel);
			if (meta.depends.length > 0) resolveDependsTargets(meta, path.dirname(full), rel);
		}
	})(srcDir);
}

async function cmdBuild(targetDir, { createClients = false } = {}) {
	const srcDir = path.join(targetDir, "src");
	if (!fs.existsSync(srcDir)) {
		console.error(`"${targetDir}" no tiene una carpeta src/.`);
		process.exitCode = 1;
		return;
	}

	// `staticPaths` en wconfig.json: el equivalente, para el sistema nuevo
	// (HTML suelto, sin Visual.ws), de `Visual.staticPaths(screen, valores)`
	// del sistema antiguo. Como una página nueva no declara ningún `screen`
	// (su ruta sale del propio nombre de fichero), la clave es el PATRÓN DE
	// RUTA tal cual — el mismo string que ya calcula `routePatternFor` — y
	// el valor son los combos posibles: un array inline, o la ruta (relativa
	// a la raíz del proyecto, junto a wconfig.json) de un .json con ese
	// array, para no tener que duplicar los datos dentro de wconfig.json.
	//
	//   { "staticPaths": { "/blog/:slug": [{ "slug": "a" }, { "slug": "b" }] } }
	//   { "staticPaths": { "/blog/:slug": "src/posts.json" } }
	//
	// `clients`: qué .ws generar a partir de las `online function` de otro
	// servidor WebScript — mismo trabajo que `websc client-generate <url>
	// --out <fichero>`, pero declarado de una vez para todos los remotos
	// del proyecto en vez de acordarse de cada URL/--out a mano. La clave
	// es la ruta de salida (relativa a la raíz del proyecto); el valor, la
	// URL wss://.
	//
	//   { "clients": { "src/OtroServidor.ws": "wss://otroservidor.com/" } }
	//
	// Ambas se leen aquí (no en dist/server.js, que lee wconfig.json en
	// tiempo de EJECUCIÓN para el resto de opciones) porque generar los
	// .html precalculados y sincronizar los clientes son cosa del BUILD.
	let wconfigStaticPaths = {};
	let wconfigClients = {};
	const wconfigPath = path.join(targetDir, "wconfig.json");
	if (fs.existsSync(wconfigPath)) {
		const wconfig = JSON.parse(fs.readFileSync(wconfigPath, "utf8"));
		wconfigStaticPaths = wconfig.staticPaths || {};
		wconfigClients = wconfig.clients || {};
	}

	// `clients` SOLO se sincroniza con `--create-clients` — a diferencia de
	// todo lo demás que hace `websc build`, esto necesita hablar por red con
	// un servidor remoto que tiene que estar arrancado en ese momento; sin
	// el flag, un `websc build` normal sigue siendo puro y sin red, como
	// siempre. Un fallo de un remoto concreto (no arranca, no responde, no
	// expone nada) NO tumba el build entero: se escribe una clase VACÍA (sin
	// funciones) para ese remoto y se sigue con el siguiente — mismo
	// espíritu que ya tiene el resto del build (un `.wsf` roto no debería
	// impedir compilar los demás). Quien importe una función de esa clase
	// vacía se entera con el error de siempre ("X no está exportado"), más
	// específico y útil que un fallo de red genérico en mitad del build.
	if (createClients) {
		for (const [outPathRel, url] of Object.entries(wconfigClients)) {
			const outPath = path.join(targetDir, outPathRel);
			try {
				const { cuerpo, nombresFunciones } = await generateClientContent(url);
				const contenido = [
					`// ${path.basename(outPath)} — generado por wconfig.json (clients) durante \`websc build --create-clients\` el ${new Date().toISOString()}`,
					"// Este fichero se reescribe ENTERO en cada build con --create-clients — un cambio",
					"// hecho a mano aquí se pierde en la siguiente regeneración.",
					`// Fuente: ${url}`,
					"",
					cuerpo,
					"",
				].join("\n");
				fs.mkdirSync(path.dirname(outPath), { recursive: true });
				fs.writeFileSync(outPath, contenido);
				console.log(`  clients: ${outPathRel}  <- ${url} (${nombresFunciones.length} online function: ${nombresFunciones.join(", ")})`);
			} catch (err) {
				const contenido = [
					`// ${path.basename(outPath)} — generado por wconfig.json (clients) durante \`websc build --create-clients\` el ${new Date().toISOString()}`,
					`// VACÍO: no se pudo generar contra ${url} en este build — ${err.message}`,
					"// El resto del build siguió con normalidad; vuelve a construir con el remoto",
					"// disponible para rellenar esta clase con sus online function reales.",
					"",
				].join("\n");
				fs.mkdirSync(path.dirname(outPath), { recursive: true });
				fs.writeFileSync(outPath, contenido);
				console.log(`  clients: ${outPathRel}  <- ${url}: FALLÓ (${err.message}) — se dejó una clase vacía y se sigue con el resto del build`);
			}
		}
	}

	const { parse } = loadCompilerModule("parser");
	const { classifyWsf, findImplicitPageTarget } = loadCompilerModule("codegen");
	const { generateClientBundle } = loadCompilerModule("codegen-client");
	const { createRequestHandler } = loadCompilerModule("codegen-server");
	const { renderPageToHTML } = loadCompilerModule("codegen-ssr");

	const distDir = path.join(targetDir, "dist");
	fs.rmSync(distDir, { recursive: true, force: true });
	fs.mkdirSync(distDir, { recursive: true });

	const wsfFiles = findWsfFiles(srcDir).map((f) => path.relative(srcDir, f).split(path.sep).join("/"));
	const wsbFiles = findWsbFiles(srcDir).map((f) => path.basename(f));

	validateWsdbFiles(srcDir);

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

		const relNoExt = file.slice(0, -".wsf".length);
		const baseName = path.basename(file, ".wsf");
		const pattern = routePatternFor(ast, relNoExt);
		if (pattern === "/") sawRoot = true;

		// El sistema NUEVO (HTML suelto, sin Visual.ws) da acceso a
		// `params`/`query` calculados contra el patrón de ruta que sale
		// del propio nombre de fichero. Un .wsf del sistema ANTIGUO, con
		// su propio `Visual.route()`, no los recibe (sigue con
		// `Visual.params(screen)`/`Visual.query(screen)`, sin tocar) — así
		// que solo se pasa cuando el fichero NO declara ya su propia ruta.
		const hasExplicitRoute = ast.body.some((n) => (n.type === "ConstDecl" || n.type === "VarDecl") && /^Visual\.route\(/.test(n.expr));
		const routePatternForNewSystem = hasExplicitRoute ? null : pattern;

		const bundle = generateClientBundle(ast, { baseDir: srcDir, routePattern: routePatternForNewSystem });
		// Nombre de los ficheros de SALIDA (bundle, .html): igual que
		// siempre para un fichero suelto en `src/` sin ":" en el nombre
		// (compatibilidad total — antes nadie podía tener uno con ":",
		// así que no hay nada que preservar ahí). Para uno en una
		// subcarpeta (que antes ni se descubría) o con ":param" en el
		// nombre, se aplana con "-" — evita tanto el choque entre dos
		// páginas de igual nombre en carpetas distintas como un ":" suelto
		// en el nombre del fichero de salida.
		const fileSlug = relNoExt.includes("/") || relNoExt.includes(":") ? relNoExt.split("/").join("-").split(":").join("-") : baseName;
		const bundleFile = `${fileSlug}.bundle.js`;
		fs.writeFileSync(path.join(distDir, bundleFile), bundle);

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
				const ssrHtml = renderPageToHTML(ast, { baseDir: srcDir, requestUrl: rutaResuelta, routePattern: routePatternForNewSystem });
				const htmlFile = fileNameForCombo(fileSlug, combo);
				const html = `<!DOCTYPE html>\n<html lang="es">\n<head><meta charset="UTF-8"></head>\n<body>${ssrHtml}<script>${bundle}</script></body>\n</html>\n`;
				fs.writeFileSync(path.join(distDir, htmlFile), html);
				pages.push({ wsfFile: `../src/${file}`, pattern: rutaResuelta, bundleFile, static: true, htmlFile });
			}
			// La ruta dinámica sigue registrada, como red de seguridad: si
			// alguien visita una combinación que no estaba en la lista
			// (contenido nuevo, aún no incluido en el build), responde con
			// SSR real en vez de un 404 sorpresa.
			pages.push({ wsfFile: `../src/${file}`, pattern, bundleFile, static: false, staticPathsFallback: true, newSystemRoute: null });
			continue;
		}

		// Equivalente de lo de arriba para el sistema NUEVO: los combos
		// posibles salen de `wconfig.json` (`staticPaths[patrón]`, ver el
		// comentario al principio de esta función), no de una llamada
		// dentro del fichero — no hay `screen`/Visual.route() al que
		// atarla. Mismo criterio de generación: un .html por combinación,
		// más la ruta dinámica de siempre como red de seguridad.
		const wconfigCombosRaw = routePatternForNewSystem && pattern.includes(":") ? wconfigStaticPaths[pattern] : undefined;
		if (wconfigCombosRaw !== undefined) {
			const combos =
				typeof wconfigCombosRaw === "string"
					? JSON.parse(fs.readFileSync(path.join(targetDir, wconfigCombosRaw), "utf8"))
					: wconfigCombosRaw;
			if (!Array.isArray(combos)) {
				throw new Error(`wconfig.json: staticPaths["${pattern}"] debe ser un array de objetos (o la ruta a un .json con ese array), no ${typeof combos}`);
			}
			for (const combo of combos) {
				const rutaResuelta = resolvePatternWithParams(pattern, combo);
				const ssrHtml = renderPageToHTML(ast, { baseDir: srcDir, requestUrl: rutaResuelta, routePattern: routePatternForNewSystem });
				const htmlFile = fileNameForCombo(fileSlug, combo);
				const html = `<!DOCTYPE html>\n<html lang="es">\n<head><meta charset="UTF-8"></head>\n<body>${ssrHtml}<script>${bundle}</script></body>\n</html>\n`;
				fs.writeFileSync(path.join(distDir, htmlFile), html);
				pages.push({ wsfFile: `../src/${file}`, pattern: rutaResuelta, bundleFile, static: true, htmlFile });
			}
			pages.push({ wsfFile: `../src/${file}`, pattern, bundleFile, static: false, staticPathsFallback: true, newSystemRoute: routePatternForNewSystem });
			continue;
		}

		const isStatic = !pattern.includes(":") && !usesVisualQuery(ast) && !usesReservedQuery(ast, routePatternForNewSystem ? findImplicitPageTarget(ast) : null);
		// `newSystemRoute` viaja hasta pages.json y de ahí al dist/server.js
		// generado: es lo que le dice, EN CADA PETICIÓN dinámica, si debe
		// pasarle `routePattern` a renderPageToHTML (sistema nuevo, sin
		// Visual.route() propio) o no (sistema antiguo, sin tocar).
		const page = { wsfFile: `../src/${file}`, pattern, bundleFile, static: isStatic, newSystemRoute: routePatternForNewSystem };

		if (isStatic) {
			const ssrHtml = renderPageToHTML(ast, { baseDir: srcDir, requestUrl: pattern, routePattern: routePatternForNewSystem });
			const htmlFile = `${fileSlug}.html`;
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
const { createRequestHandler, wireOnlineFunctionsRpc } = require("../compiler/codegen-server");
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
				: \`<!DOCTYPE html>\\n<html lang="es">\\n<head><meta charset="UTF-8"></head>\\n<body>\${renderPageToHTML(page.ast, { baseDir: srcDir, requestUrl: req.url, routePattern: page.newSystemRoute })}<script>\${page.bundle}</script></body>\\n</html>\\n\`;
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(html);
			return;
		}
	}

	if (apiHandler) return apiHandler(req, res);

	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "no encontrado" }));
});

if (apiHandler && apiHandler.onlineFunctions.length > 0) wireOnlineFunctionsRpc(server, apiHandler.onlineFunctions);

const port = wconfig.port || 3000;
server.listen(port, () => console.log(\`Servidor en http://localhost:\${port}/\`));
`;

// Conecta por WebSocket a `url`, pide reflexión, y devuelve el CONTENIDO del
// fichero .ws generado (sin escribirlo) — o lanza si algo falla (sin
// conexión, sin respuesta a tiempo, respuesta no-JSON, o cero `online
// function` expuestas). Compartida entre `websc client-generate` (falla
// rápido, es una herramienta de un solo uso) y `websc build --create-clients`
// (tolerante: quien la llama decide qué hacer si falla — ver más abajo).
async function generateClientContent(url) {
	if (!/^wss?:\/\//.test(url)) throw new Error(`"${url}" no es una URL de WebSocket (debe empezar por ws:// o wss://)`);

	const websocket = require(path.join(SELF_COMPILER_DIR, "websocket-runtime"));
	let ws;
	try {
		ws = await websocket.connect(url);
	} catch (err) {
		throw new Error(`no se ha podido conectar a "${url}": ${err.message}`);
	}

	const funciones = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`"${url}" no respondió a la reflexión en 10 segundos`)), 10000);
		ws.parser.on("message", (msg) => {
			clearTimeout(timer);
			try {
				resolve(JSON.parse(msg.text).functions);
			} catch {
				reject(new Error(`"${url}" respondió algo que no es JSON válido — ¿es de verdad un servidor WebScript?`));
			}
		});
		ws.parser.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		ws.send(JSON.stringify({ type: "reflect" }));
	}).finally(() => ws.socket.end());

	if (!funciones || funciones.length === 0) throw new Error(`"${url}" no expone ninguna "online function" — nada que generar`);

	const cuerpo = funciones
		.map(({ name, params, idempotent }) => {
			const paramList = [...params, "opts"].join(", ");
			const idemComentario = idempotent
				? `\t// -> idempotent en el servidor: pasar { idempotencyKey } en \`opts\` para que reintentar sea seguro`
				: `\t// no declarada -> idempotent: reintentar puede repetir su efecto`;
			return [`export function ${name}(${paramList})`, idemComentario, `\treturn WSClient.create(${JSON.stringify(url)}).llamar(${JSON.stringify(name)}, [${params.join(", ")}], opts)`].join("\n");
		})
		.join("\n\n");

	return { cuerpo, nombresFunciones: funciones.map((f) => f.name) };
}

async function cmdClientGenerate(url, outPath) {
	if (!outPath) throw new Error('websc client-generate <url> --out <fichero.ws> — falta "--out"');

	// Deliberadamente NO se usa WSClient aquí: WSClient está pensado para
	// un cliente que vive dentro de un servidor en marcha, donde "seguir
	// reintentando en segundo plano" es lo correcto — un fallo de conexión
	// nunca debería hacer caer al servidor. Este comando es justo lo
	// contrario: una herramienta de un solo uso, donde lo correcto es
	// fallar rápido y con un motivo claro. Con WSClient, un servidor que
	// no expone nada (o que ni siquiera existe) se traduciría en un "sin
	// respuesta en 10000ms" genérico tras reintentar en silencio — aquí se
	// conecta directo, una sola vez, y cualquier fallo de conexión se
	// informa tal cual, al momento.
	const { cuerpo, nombresFunciones } = await generateClientContent(url);

	const contenido = [
		`// ${path.basename(outPath)} — generado por \`websc client-generate ${url}\` el ${new Date().toISOString()}`,
		"// Este fichero se reescribe ENTERO cada vez que se ejecuta ese comando — un cambio",
		'// hecho a mano aquí se pierde en la siguiente regeneración. Para actualizarlo tras un',
		"// cambio en el servidor remoto, vuelve a ejecutar el mismo comando.",
		`// Fuente: ${url}`,
		"",
		cuerpo,
		"",
	].join("\n");

	fs.writeFileSync(outPath, contenido);
	console.log(`${outPath}  <- ${url} (${nombresFunciones.length} online function: ${nombresFunciones.join(", ")})`);
}

async function main() {
	const [, , command, target] = process.argv;
	const targetDir = path.resolve(target || ".");

	try {
		if (command === "init") return cmdInit(targetDir);
		if (command === "update") return cmdUpdate(targetDir);
		if (command === "build") return await cmdBuild(targetDir, { createClients: process.argv.includes("--create-clients") });
		if (command === "client-generate") {
			const outIdx = process.argv.indexOf("--out");
			const outPath = outIdx !== -1 ? path.resolve(process.argv[outIdx + 1] || "") : null;
			return await cmdClientGenerate(target, outPath);
		}
	} catch (err) {
		console.error(`Error: ${err.message}`);
		process.exitCode = 1;
		return;
	}

	console.log("Uso:");
	console.log("  websc init <carpeta>    — crear un proyecto nuevo");
	console.log("  websc update <carpeta>  — actualizar lib/ y compiler/ de un proyecto existente");
	console.log("  websc build <carpeta>   — compilar src/ a dist/ (HTML de cliente + server.js)");
	console.log("    --create-clients      — además, sincronizar los .ws de wconfig.json (\"clients\") contra sus servidores remotos");
	console.log("  websc client-generate <url> --out <fichero.ws>  — generar un cliente a partir de las online function de otro servidor WebScript");
	process.exitCode = 1;
}

main();
