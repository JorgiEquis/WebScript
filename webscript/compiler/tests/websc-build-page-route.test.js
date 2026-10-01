// `websc build` real con el sistema nuevo (HTML suelto, sin Visual.ws): la
// ruta de una página sale de la ruta del propio fichero, con subcarpetas y
// ":param" en el nombre. Antes de esto, `findWsfFiles` era plana (no
// recorría subcarpetas en absoluto: un .wsf en una subcarpeta ni se
// descubría) y `routePatternFor` solo recibía el nombre de fichero sin la
// carpeta — los tests marcados REGRESIÓN fallan contra el código anterior.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { execFileSync, spawn } = require("child_process");

const WEBSC_BIN = path.join(__dirname, "../bin/websc.js");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-build-page-route-"));
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

test("REGRESIÓN: una página nueva (HTML suelto) en una subcarpeta se descubre y se sirve en la ruta correcta", () => {
	const dir = proyecto({ "api/listaProductos.wsf": ["const productos = ['manzana', 'pera']", "", "<ul>", "\tfor (p in productos)", "\t\t<li>{p}</li>", "</ul>"] });
	runWebsc(["build", dir]);
	assert.match(fs.readFileSync(path.join(dir, "dist", "pages.json"), "utf8"), /"pattern": "\/api\/listaProductos"/);
	const html = fs.readFileSync(path.join(dir, "dist", "api-listaProductos.html"), "utf8");
	assert.match(html, /<li>(?:<!--t-->)?manzana(?:<!--\/t-->)?<\/li><li>(?:<!--t-->)?pera(?:<!--\/t-->)?<\/li>/);
});

test("REGRESIÓN: \":param\" en el nombre de fichero da una ruta dinámica real, servida por dist/server.js con params.id correcto", { timeout: 20000 }, async () => {
	const dir = proyecto({ "api/producto:id.wsf": ["<div>", "\t<h1>Producto {params.id}</h1>", "\t<p>Orden: {query.orden}</p>", "</div>"] });
	runWebsc(["build", dir]);
	await withRunningServer(dir, async (port) => {
		const conQuery = await get(port, "/api/producto/42?orden=fecha");
		assert.match(conQuery.body, /Producto 42/);
		assert.match(conQuery.body, /Orden: fecha/);
		const sinQuery = await get(port, "/api/producto/99");
		assert.equal(sinQuery.status, 200);
		assert.match(sinQuery.body, /Producto 99/);
	});
});

test("NO REGRESIÓN: el sistema antiguo (Visual.route() explícito) sigue funcionando exactamente igual, sin params/query reservados de más", { timeout: 20000 }, async () => {
	const dir = proyecto({
		"blog.wsf": [
			"const Visual screen = Visual.route('/blog/:slug')",
			"const {slug} = Visual.params(screen)",
			"visual app =",
			"<h1>Post: {slug}</h1>",
			"Visual.render(app)",
		],
	});
	runWebsc(["build", dir]);
	await withRunningServer(dir, async (port) => {
		const r = await get(port, "/blog/mi-post");
		assert.match(r.body, /Post:(?:<!--t-->)?\s*mi-post/);
	});
});

test("una página en una subcarpeta anidada de dos niveles calcula bien la ruta", () => {
	const dir = proyecto({ "admin/usuarios/lista.wsf": "<p>usuarios</p>" });
	runWebsc(["build", dir]);
	assert.match(fs.readFileSync(path.join(dir, "dist", "pages.json"), "utf8"), /"pattern": "\/admin\/usuarios\/lista"/);
});

test("dos páginas nuevas con el mismo nombre de fichero en subcarpetas distintas no se pisan el bundle", () => {
	const dir = proyecto({
		"api/detalle.wsf": "<p>detalle de api</p>",
		"admin/detalle.wsf": "<p>detalle de admin</p>",
	});
	runWebsc(["build", dir]);
	assert.ok(fs.existsSync(path.join(dir, "dist", "api-detalle.html")));
	assert.ok(fs.existsSync(path.join(dir, "dist", "admin-detalle.html")));
	assert.match(fs.readFileSync(path.join(dir, "dist", "api-detalle.html"), "utf8"), /detalle de api/);
	assert.match(fs.readFileSync(path.join(dir, "dist", "admin-detalle.html"), "utf8"), /detalle de admin/);
});
