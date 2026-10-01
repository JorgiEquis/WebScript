// `websc build` con páginas que usan .ws con imports propios.
//
// Dos cosas que solo se ven al construir de verdad:
// 1. SSR corre en el build (SSG) y en cada petición dinámica de dist/server.js,
//    con los módulos vendorizados de la carpeta del proyecto (acorn incluido).
// 2. `resolveTopLevelValue` (el valor de `posts` en Visual.staticPaths(screen,
//    posts)) evaluaba TODAS las declaraciones importadas en un único script, y
//    conocía cero módulos .js embebidos: en cuanto un .ws arrastraba una
//    const ligada a un .js —algo que ahora sí se trae—, tumbaba el build
//    aunque la página solo usara esa function en un onclick y el build
//    anterior pasara. Se detectó así, con `websc build` real, no con un test
//    unitario.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { execFileSync, spawn } = require("child_process");

const WEBSC_BIN = path.join(__dirname, "../bin/websc.js");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-build-ws-"));
}

function runWebsc(args) {
	return execFileSync("node", [WEBSC_BIN, ...args], { encoding: "utf8" });
}

function get(port, pathname) {
	return new Promise((resolve, reject) => {
		http.get(`http://localhost:${port}${pathname}`, (r) => {
			let out = "";
			r.on("data", (c) => (out += c));
			r.on("end", () => resolve({ status: r.statusCode, body: out }));
		}).on("error", reject);
	});
}

function freePort() {
	return new Promise((resolve) => {
		const net = require("net");
		const srv = net.createServer();
		srv.listen(0, () => {
			const p = srv.address().port;
			srv.close(() => resolve(p));
		});
	});
}

async function withRunningServer(dir, fn) {
	const port = await freePort();
	fs.writeFileSync(path.join(dir, "wconfig.json"), JSON.stringify({ port }));
	const child = spawn("node", [path.join(dir, "dist", "server.js")]);
	try {
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("no arrancó a tiempo")), 5000);
			child.stdout.on("data", (chunk) => {
				if (chunk.toString().includes("Servidor en")) {
					clearTimeout(timeout);
					resolve();
				}
			});
			child.stderr.on("data", (chunk) => reject(new Error(chunk.toString())));
		});
		await fn(port);
	} finally {
		child.kill();
	}
}

function proyecto(ficherosSrc) {
	const dir = path.join(tmpDir(), "proyecto");
	runWebsc(["init", dir]);
	for (const [nombre, contenido] of Object.entries(ficherosSrc)) {
		const destino = path.join(dir, "src", nombre);
		fs.mkdirSync(path.dirname(destino), { recursive: true });
		fs.writeFileSync(destino, Array.isArray(contenido) ? contenido.join("\n") : contenido);
	}
	return dir;
}

const LIB = {
	"posts.json": JSON.stringify([{ slug: "uno" }, { slug: "dos" }]),
	"ayuda.js": "module.exports = { triple: (x) => x * 3 };",
	"lib.ws": ['import { triple } from "./ayuda.js"', "", "export function etiqueta(s)", '\treturn s + ":" + triple(2)'],
};

function blog(cuerpoVisual) {
	return [
		"const Visual screen = Visual.route('/blog/:slug')",
		"const {slug} = Visual.params(screen)",
		"",
		'import posts from "./posts.json"',
		'import { etiqueta } from "./lib.ws"',
		"",
		"Visual.staticPaths(screen, posts)",
		"",
		'reactive resultado = ""',
		"",
		"visual app =",
		...cuerpoVisual,
		"",
		"Visual.render(app)",
	];
}

test("REGRESIÓN: una página estática (staticPaths) cuya plantilla llama a una function de un .ws que importa un .js: el build genera el HTML con el valor ya calculado", () => {
	const dir = proyecto({ ...LIB, "blog.wsf": blog(["<div>", "\t<h1>{etiqueta(slug)}</h1>", "</div>"]) });
	runWebsc(["build", dir]);
	// Antes ni compilaba (triple is not defined al renderizar en servidor).
	assert.match(fs.readFileSync(path.join(dir, "dist", "blog-uno.html"), "utf8"), /<h1>(?:<!--t-->)?uno:6(?:<!--\/t-->)?<\/h1>/);
	assert.match(fs.readFileSync(path.join(dir, "dist", "blog-dos.html"), "utf8"), /<h1>(?:<!--t-->)?dos:6(?:<!--\/t-->)?<\/h1>/);
});

test("NO REGRESIÓN: la misma página con la function SOLO en un onclick (SSR no la ejecuta) sigue compilando — resolveTopLevelValue no debe tumbar el build por una const ligada a un .js que no necesita", () => {
	const dir = proyecto({ ...LIB, "blog.wsf": blog(["<div>", "\t<h1>{slug}</h1>", '\t<button onclick={resultado = etiqueta("clic")}>ok</button>', "\t<p>{resultado}</p>", "</div>"]) });
	runWebsc(["build", dir]);
	assert.ok(fs.existsSync(path.join(dir, "dist", "blog-uno.html")));
	assert.ok(fs.existsSync(path.join(dir, "dist", "blog-dos.html")));
});

test("REGRESIÓN: una const importada que no se puede evaluar en el build (usa window) tampoco tumba Visual.staticPaths si no es la que se necesita", () => {
	const dir = proyecto({
		"posts.json": LIB["posts.json"],
		// Sin `export` a propósito: el código anterior no traía las constantes
		// exportadas de un .ws (otro bug), así que con `export` este test no
		// habría fallado nunca aunque el problema existiera.
		"nav.ws": ["const ANCHO = window.innerWidth", "", "export function saludo()", '\treturn "hola"'],
		"blog.wsf": [
			"const Visual screen = Visual.route('/blog/:slug')",
			"const {slug} = Visual.params(screen)",
			"",
			'import posts from "./posts.json"',
			'import { saludo } from "./nav.ws"',
			"",
			"Visual.staticPaths(screen, posts)",
			"",
			"visual app =",
			"<h1>{saludo()} {slug}</h1>",
			"",
			"Visual.render(app)",
		],
	});
	runWebsc(["build", dir]); // antes: window is not defined
	assert.match(fs.readFileSync(path.join(dir, "dist", "blog-uno.html"), "utf8"), /<h1>(?:<!--t-->)?hola uno(?:<!--\/t-->)?<\/h1>/);
});

test("si la variable de Visual.staticPaths() no se puede calcular, el error es el de ESA declaración (no se traga)", () => {
	const dir = proyecto({
		"blog.wsf": [
			"const Visual screen = Visual.route('/blog/:slug')",
			"const {slug} = Visual.params(screen)",
			"",
			"const posts = noExiste()",
			"",
			"Visual.staticPaths(screen, posts)",
			"",
			"visual app =",
			"<h1>{slug}</h1>",
			"",
			"Visual.render(app)",
		],
	});
	assert.throws(() => execFileSync("node", [WEBSC_BIN, "build", dir], { encoding: "utf8", stdio: "pipe" }), (e) => /noExiste is not defined/.test(String(e.stderr)));
});

test(
	"integración real: dist/server.js sirve por SSR dinámico una combinación NO estática, usando el acorn vendorizado del proyecto (la function anidada se ejecuta en servidor)",
	{ timeout: 20000 },
	async () => {
		const dir = proyecto({ ...LIB, "blog.wsf": blog(["<div>", "\t<h1>{etiqueta(slug)}</h1>", "</div>"]) });
		runWebsc(["build", dir]);
		await withRunningServer(dir, async (port) => {
			const estatica = await get(port, "/blog/uno");
			assert.match(estatica.body, /<h1>(?:<!--t-->)?uno:6(?:<!--\/t-->)?<\/h1>/);
			// No está en posts.json: respuesta por SSR real en la petición.
			const dinamica = await get(port, "/blog/nueva-no-listada");
			assert.equal(dinamica.status, 200);
			assert.match(dinamica.body, /<h1>(?:<!--t-->)?nueva-no-listada:6(?:<!--\/t-->)?<\/h1>/);
		});
	}
);
