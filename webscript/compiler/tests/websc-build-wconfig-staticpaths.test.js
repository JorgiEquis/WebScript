// `staticPaths` en `wconfig.json` — equivalente, para el sistema nuevo
// (HTML suelto, sin Visual.ws), de `Visual.staticPaths(screen, valores)`
// del sistema antiguo. Sin `screen`, la clave es el PATRÓN DE RUTA; el
// valor, un array inline de combos o la ruta a un .json con ese array.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { execFileSync, spawn } = require("child_process");

const WEBSC_BIN = path.join(__dirname, "../bin/websc.js");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-wconfig-staticpaths-"));
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
	const wconfigPath = path.join(dir, "wconfig.json");
	const wconfig = JSON.parse(fs.readFileSync(wconfigPath, "utf8"));
	wconfig.port = port;
	fs.writeFileSync(wconfigPath, JSON.stringify(wconfig));
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

function proyecto(ficherosSrc, wconfigExtra) {
	const dir = path.join(tmpDir(), "proyecto");
	runWebsc(["init", dir]);
	for (const [nombre, contenido] of Object.entries(ficherosSrc)) {
		const destino = path.join(dir, "src", nombre);
		fs.mkdirSync(path.dirname(destino), { recursive: true });
		fs.writeFileSync(destino, Array.isArray(contenido) ? contenido.join("\n") : contenido);
	}
	if (wconfigExtra) {
		const wconfigPath = path.join(dir, "wconfig.json");
		const wconfig = JSON.parse(fs.readFileSync(wconfigPath, "utf8"));
		Object.assign(wconfig, wconfigExtra);
		fs.writeFileSync(wconfigPath, JSON.stringify(wconfig));
	}
	return dir;
}

test("REGRESIÓN: staticPaths inline en wconfig.json pre-genera un .html por combinación", () => {
	const dir = proyecto(
		{ "blog/entrada:slug.wsf": ["<div>", "\t<h1>Post: {params.slug}</h1>", "</div>"] },
		{ staticPaths: { "/blog/entrada/:slug": [{ slug: "primer-post" }, { slug: "segundo-post" }] } }
	);
	runWebsc(["build", dir]);
	const uno = fs.readFileSync(path.join(dir, "dist", "blog-entrada-slug-primer-post.html"), "utf8");
	const dos = fs.readFileSync(path.join(dir, "dist", "blog-entrada-slug-segundo-post.html"), "utf8");
	assert.match(uno, /Post:(?:<!--t-->)?\s*primer-post/);
	assert.match(dos, /Post:(?:<!--t-->)?\s*segundo-post/);
});

test("REGRESIÓN: staticPaths puede apuntar a un .json externo (ruta relativa a la raíz del proyecto) en vez de un array inline", () => {
	const dir = proyecto(
		{ "blog/entrada:slug.wsf": ["<div>", "\t<h1>Post: {params.slug}</h1>", "</div>"] },
		{ staticPaths: { "/blog/entrada/:slug": "combos.json" } }
	);
	fs.writeFileSync(path.join(dir, "combos.json"), JSON.stringify([{ slug: "desde-json" }]));
	runWebsc(["build", dir]);
	const html = fs.readFileSync(path.join(dir, "dist", "blog-entrada-slug-desde-json.html"), "utf8");
	assert.match(html, /Post:(?:<!--t-->)?\s*desde-json/);
});

test("REGRESIÓN: una combinación NO listada en staticPaths se sirve por SSR dinámico real, con params correctos (red de seguridad)", { timeout: 20000 }, async () => {
	const dir = proyecto(
		{ "blog/entrada:slug.wsf": ["<div>", "\t<h1>Post: {params.slug}</h1>", "</div>"] },
		{ staticPaths: { "/blog/entrada/:slug": [{ slug: "primer-post" }] } }
	);
	runWebsc(["build", dir]);
	await withRunningServer(dir, async (port) => {
		const estatica = await get(port, "/blog/entrada/primer-post");
		assert.match(estatica.body, /Post:(?:<!--t-->)?\s*primer-post/);
		const dinamica = await get(port, "/blog/entrada/no-listado");
		assert.equal(dinamica.status, 200);
		assert.match(dinamica.body, /Post:(?:<!--t-->)?\s*no-listado/);
	});
});

test("NO REGRESIÓN: sin staticPaths en wconfig.json, una página con :param sigue siendo SSR dinámica de siempre (sin pre-generar nada)", () => {
	const dir = proyecto({ "blog/entrada:slug.wsf": ["<div>", "\t<h1>Post: {params.slug}</h1>", "</div>"] });
	runWebsc(["build", dir]);
	assert.equal(fs.existsSync(path.join(dir, "dist", "blog-entrada-slug.html")), false);
	assert.match(fs.readFileSync(path.join(dir, "dist", "pages.json"), "utf8"), /"pattern": "\/blog\/entrada\/:slug"/);
});

test("NO REGRESIÓN: el sistema antiguo (Visual.route() + Visual.staticPaths() en el propio fichero) sigue funcionando exactamente igual, sin relación con wconfig.json", () => {
	const dir = proyecto(
		{
			"posts.json": JSON.stringify([{ slug: "a" }, { slug: "b" }]),
			"blog.wsf": [
				"const Visual screen = Visual.route('/blog/:slug')",
				"const {slug} = Visual.params(screen)",
				'import posts from "./posts.json"',
				"Visual.staticPaths(screen, posts)",
				"visual app =",
				"<h1>Post: {slug}</h1>",
				"Visual.render(app)",
			],
		},
		{ staticPaths: { "/blog/:slug": [{ slug: "ignorado-porque-hay-visual-staticpaths" }] } }
	);
	runWebsc(["build", dir]);
	assert.ok(fs.existsSync(path.join(dir, "dist", "blog-a.html")));
	assert.ok(fs.existsSync(path.join(dir, "dist", "blog-b.html")));
	assert.equal(fs.existsSync(path.join(dir, "dist", "blog-ignorado-porque-hay-visual-staticpaths.html")), false);
});
