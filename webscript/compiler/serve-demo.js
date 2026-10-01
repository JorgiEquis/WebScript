// serve-demo.js — WebScript, v0
//
// Sirve una o varias páginas (.wsf) y, si se le pasan, una o varias APIs
// (.wsb) en el MISMO servidor — necesario para probar en un navegador
// real sin toparse con CORS, sin tener que montar un proyecto entero con
// `websc init` + `websc build`. El/los .wsb son OPCIONALES: sin ellos,
// sirve solo la(s) página(s) (WebScript solo-frontend es un uso normal).
//
// Con una sola página, se sirve en "/" además de en su propia ruta (o su
// nombre de fichero, si no declara Visual.route()) — para poder abrir
// http://localhost:3000/ sin pensar. Con varias, cada una se sirve SOLO
// en su propia ruta real (la de su Visual.route(), con :params incluidos
// si los tiene) — la SSR es real por petición en todos los casos, nunca
// precalculada (para eso está `websc build`, que sí distingue estático
// de dinámico).
//
// Uso:
//   node serve-demo.js <fichero.wsf | .wsb | directorio> [más...] [puerto]
//
// Ejemplos:
//   node serve-demo.js ../src/demo-cliente-servidor.wsf ../src/demo-servidor.wsb 3000
//   node serve-demo.js ../src/app-solo-frontend.wsf 3000        (sin .wsb)
//   node serve-demo.js ../src/inicio.wsf ../src/blog.wsf ../src/api.wsb 3000   (varias páginas)
//   node serve-demo.js ../src 3000   (un directorio entero — mismo criterio que `websc build src/`)

const fs = require("fs");
const path = require("path");
const http = require("http");
const { parse } = require("./parser");
const { generateClientBundle } = require("./codegen-client");
const { createRequestHandler } = require("./codegen-server");
const { renderPageToHTML } = require("./codegen-ssr");
const { compileRoutePatternClient } = require("./runtime");
const { routePatternFor } = require("./route-pattern");
const { findWsfFiles, findWsbFiles } = require("./discover-files");

const args = process.argv.slice(2);
if (args.length === 0) {
	console.error("Uso: node serve-demo.js <fichero.wsf | .wsb | directorio> [más...] [puerto]");
	process.exit(1);
}

// El último argumento es el puerto SOLO si es un número puro — así no
// hace falta contar cuántos ficheros/directorios se han pasado antes.
let port = 3000;
if (/^\d+$/.test(args[args.length - 1])) {
	port = Number(args.pop());
}

// Un argumento que sea un directorio se escanea con el mismo criterio que
// `websc build` (findWsfFiles SÍ recorre subcarpetas — su ruta sale
// entonces de su propia ruta relativa a ese directorio, ver
// route-pattern.js; findWsbFiles sigue plana — un .wsb importado por otro
// del propio directorio se excluye, para no duplicar sus rutas) — así no
// hace falta listar cada fichero uno a uno, igual que ya no hace falta con
// `websc build src/`.
const wsfEntries = [];
const wsbPaths = [];
const desconocidos = [];
for (const arg of args) {
	if (fs.existsSync(arg) && fs.statSync(arg).isDirectory()) {
		// Ruta relativa AL DIRECTORIO ESCANEADO, sin ".wsf" — es lo que
		// decide el patrón de ruta cuando el fichero no declara su propio
		// Visual.route() (src/api/listaProductos.wsf, escaneado desde
		// src/, da "api/listaProductos" → /api/listaProductos).
		for (const fullPath of findWsfFiles(arg)) {
			const relNoExt = path.relative(arg, fullPath).replace(/\.wsf$/, "").split(path.sep).join("/");
			wsfEntries.push({ wsfPath: fullPath, relNoExt });
		}
		wsbPaths.push(...findWsbFiles(arg));
	} else if (arg.endsWith(".wsf")) {
		// Fichero suelto, sin carpeta de referencia: su ruta sale de su
		// propio nombre, como siempre (sin subcarpeta que aportar).
		wsfEntries.push({ wsfPath: arg, relNoExt: path.basename(arg, ".wsf") });
	} else if (arg.endsWith(".wsb")) {
		wsbPaths.push(arg);
	} else {
		desconocidos.push(arg);
	}
}
if (desconocidos.length > 0) {
	console.error(`Argumento no reconocido (se esperaba .wsf, .wsb, un directorio, o un puerto al final): ${desconocidos.join(", ")}`);
	process.exit(1);
}
if (wsfEntries.length === 0) {
	console.error("Hace falta al menos un fichero .wsf");
	process.exit(1);
}

// Cada página: su AST (para SSR real por petición), su bundle (cacheado,
// no depende de la petición), y su patrón de ruta real — mismo criterio
// que `websc build` (Visual.route() si lo declara; si no, la ruta sale del
// propio fichero — con subcarpetas y ":param" en el nombre, ver
// route-pattern.js), reutilizado desde route-pattern.js. `params`/`query`
// (sistema nuevo, sin Visual.ws) solo se activan cuando el fichero NO
// declara ya su propio Visual.route() — igual criterio que websc build.
const pages = wsfEntries.map(({ wsfPath, relNoExt }) => {
	const baseDir = path.dirname(path.resolve(wsfPath));
	const ast = parse(fs.readFileSync(wsfPath, "utf8"), {});
	const pattern = routePatternFor(ast, relNoExt);
	const hasExplicitRoute = ast.body.some((n) => (n.type === "ConstDecl" || n.type === "VarDecl") && /^Visual\.route\(/.test(n.expr));
	const newSystemRoute = hasExplicitRoute ? null : pattern;
	const bundle = generateClientBundle(ast, { baseDir, routePattern: newSystemRoute });
	return { wsfPath, baseDir, ast, bundle, pattern, newSystemRoute, matcher: compileRoutePatternClient(pattern) };
});

// Con una sola página, se sirve también en "/" (de regalo, para poder
// abrir la raíz sin pensar) — con varias, cada una vive solo en su
// propia ruta, igual que en un proyecto real con websc build.
if (pages.length === 1 && pages[0].pattern !== "/") {
	pages.push({ ...pages[0], pattern: "/", matcher: compileRoutePatternClient("/") });
}

// Todos los .wsb combinados en UN solo handler — mismo criterio que
// `websc build` (rutas de distintos ficheros conviviendo en un único
// servidor).
let apiHandler = null;
if (wsbPaths.length > 0) {
	const combinedBody = [];
	for (const wsbPath of wsbPaths) {
		combinedBody.push(...parse(fs.readFileSync(wsbPath, "utf8"), {}).body);
	}
	// baseDir del primer .wsb — un import relativo dentro de cualquiera de
	// ellos se resuelve contra su PROPIA carpeta vía resolveImports, así
	// que esto solo importa para lo que esté en el nivel superior sin
	// venir de un import.
	apiHandler = createRequestHandler(
		{ type: "Program", body: combinedBody },
		{},
		{ baseDir: path.dirname(path.resolve(wsbPaths[0])) }
	);
}

const server = http.createServer((req, res) => {
	if (req.method === "GET") {
		const url = new URL(req.url, `http://${req.headers.host}`);
		const page = pages.find((p) => p.matcher.regex.test(url.pathname));
		if (page) {
			// SSR real, en cada petición — si la página usa Visual.route()
			// con :params, esto es lo que hace que salga el valor correcto
			// según la URL exacta pedida, no uno precalculado de antes.
			const ssrHtml = renderPageToHTML(page.ast, { baseDir: page.baseDir, requestUrl: req.url, routePattern: page.newSystemRoute });
			const html = `<!DOCTYPE html>\n<html lang="es">\n<head><meta charset="UTF-8"><title>WebScript</title></head>\n<body>${ssrHtml}<script>${page.bundle}</script></body>\n</html>\n`;
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(html);
			return;
		}
	}
	if (apiHandler) {
		apiHandler(req, res);
		return;
	}
	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "no encontrado (ninguna página coincide con esta ruta, y este proyecto de demo no tiene .wsb)" }));
});

server.listen(port, () => {
	console.log(`${wsfEntries.length > 1 ? "Páginas" : "Página"}${apiHandler ? " + API" : ""} en http://localhost:${port}/`);
	for (const p of pages) console.log(`  GET  ${p.pattern}  ->  ${path.basename(p.wsfPath)}`);
	if (apiHandler) console.log(`  resto de rutas    -> la API combinada de ${wsbPaths.map((p) => path.basename(p)).join(", ")}`);
});
