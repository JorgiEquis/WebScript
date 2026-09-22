const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { execFileSync, spawn } = require("child_process");

const WEBSC_BIN = path.join(__dirname, "../bin/websc.js");

function tmpDir(prefix) {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

test("Visual.staticPaths(screen, posts): genera un .html real por cada combinación, más la ruta dinámica como respaldo", () => {
	const dir = path.join(tmpDir("websc-staticpaths-"), "proyecto");
	runWebsc(["init", dir]);
	fs.writeFileSync(
		path.join(dir, "src", "posts.json"),
		JSON.stringify([{ slug: "mi-primer-post" }, { slug: "otro-post" }])
	);
	fs.writeFileSync(
		path.join(dir, "src", "blog.wsf"),
		[
			"const Visual screen = Visual.route('/blog/:slug')",
			"const {slug} = Visual.params(screen)",
			"",
			'import posts from "./posts.json"',
			"",
			"Visual.staticPaths(screen, posts)",
			"",
			"visual app =",
			"<h1>Post: {slug}</h1>",
			"",
			"Visual.render(app)",
		].join("\n")
	);

	runWebsc(["build", dir]);

	const pages = JSON.parse(fs.readFileSync(path.join(dir, "dist", "pages.json"), "utf8"));
	const estaticas = pages.filter((p) => p.static && p.pattern.startsWith("/blog/"));
	assert.equal(estaticas.length, 2);

	const fallback = pages.find((p) => p.pattern === "/blog/:slug");
	assert.ok(fallback);
	assert.equal(fallback.static, false);

	const html1 = fs.readFileSync(path.join(dir, "dist", "blog-mi-primer-post.html"), "utf8");
	assert.match(html1, /<h1>Post: mi-primer-post<\/h1>/);
	const html2 = fs.readFileSync(path.join(dir, "dist", "blog-otro-post.html"), "utf8");
	assert.match(html2, /<h1>Post: otro-post<\/h1>/);
});

test("import { campo } from ...json (con llaves): solo esa propiedad, no el fichero entero", () => {
	const dir = path.join(tmpDir("websc-staticpaths-llaves-"), "proyecto");
	runWebsc(["init", dir]);
	fs.writeFileSync(
		path.join(dir, "src", "datos.json"),
		JSON.stringify({ posts: [{ slug: "post-a" }], otraCosa: "no debería usarse" })
	);
	fs.writeFileSync(
		path.join(dir, "src", "blog.wsf"),
		[
			"const Visual screen = Visual.route('/blog/:slug')",
			"const {slug} = Visual.params(screen)",
			"",
			'import { posts } from "./datos.json"',
			"",
			"Visual.staticPaths(screen, posts)",
			"",
			"visual app =",
			"<h1>Post: {slug}</h1>",
			"",
			"Visual.render(app)",
		].join("\n")
	);

	runWebsc(["build", dir]);

	const html = fs.readFileSync(path.join(dir, "dist", "blog-post-a.html"), "utf8");
	assert.match(html, /<h1>Post: post-a<\/h1>/);
});

test("Visual.staticPaths() acepta cualquier const de nivel superior ya resuelto, no solo un import de .json", () => {
	const dir = path.join(tmpDir("websc-staticpaths-const-"), "proyecto");
	runWebsc(["init", dir]);
	fs.writeFileSync(
		path.join(dir, "src", "blog.wsf"),
		[
			"const Visual screen = Visual.route('/blog/:slug')",
			"const {slug} = Visual.params(screen)",
			"",
			'const posts = [{ slug: "post-x" }, { slug: "post-y" }]',
			"",
			"Visual.staticPaths(screen, posts)",
			"",
			"visual app =",
			"<h1>Post: {slug}</h1>",
			"",
			"Visual.render(app)",
		].join("\n")
	);

	runWebsc(["build", dir]);

	const html1 = fs.readFileSync(path.join(dir, "dist", "blog-post-x.html"), "utf8");
	assert.match(html1, /<h1>Post: post-x<\/h1>/);
	const html2 = fs.readFileSync(path.join(dir, "dist", "blog-post-y.html"), "utf8");
	assert.match(html2, /<h1>Post: post-y<\/h1>/);
});

test("integración real: dist/server.js sirve las rutas pre-generadas incluso sin el .wsf ni el .json fuente, y da un 500 claro (aislado) para el fallback", async () => {
	const dir = path.join(tmpDir("websc-staticpaths-runtime-"), "proyecto");
	runWebsc(["init", dir]);
	fs.writeFileSync(
		path.join(dir, "src", "posts.json"),
		JSON.stringify([{ slug: "mi-primer-post" }, { slug: "otro-post" }])
	);
	fs.writeFileSync(
		path.join(dir, "src", "blog.wsf"),
		[
			"const Visual screen = Visual.route('/blog/:slug')",
			"const {slug} = Visual.params(screen)",
			"",
			'import posts from "./posts.json"',
			"",
			"Visual.staticPaths(screen, posts)",
			"",
			"visual app =",
			"<h1>Post: {slug}</h1>",
			"",
			"Visual.render(app)",
		].join("\n")
	);
	runWebsc(["build", dir]);

	fs.rmSync(path.join(dir, "src", "blog.wsf"));
	fs.rmSync(path.join(dir, "src", "posts.json"));

	await withRunningServer(dir, async (port) => {
		const r1 = await get(port, "/blog/mi-primer-post");
		assert.equal(r1.status, 200);
		assert.match(r1.body, /<h1>Post: mi-primer-post<\/h1>/);

		const r2 = await get(port, "/blog/otro-post");
		assert.equal(r2.status, 200);
		assert.match(r2.body, /<h1>Post: otro-post<\/h1>/);

		const r3 = await get(port, "/blog/no-listado");
		assert.equal(r3.status, 500);
		assert.match(JSON.parse(r3.body).error, /No se pudo cargar esta página/);

		const r4 = await get(port, "/blog/mi-primer-post");
		assert.equal(r4.status, 200);
	});
});

test("integración real: el fallback dinámico renderiza un slug nuevo (no listado) cuando el .wsf SÍ existe", async () => {
	const dir = path.join(tmpDir("websc-staticpaths-fallback-"), "proyecto");
	runWebsc(["init", dir]);
	fs.writeFileSync(path.join(dir, "src", "posts.json"), JSON.stringify([{ slug: "mi-primer-post" }]));
	fs.writeFileSync(
		path.join(dir, "src", "blog.wsf"),
		[
			"const Visual screen = Visual.route('/blog/:slug')",
			"const {slug} = Visual.params(screen)",
			"",
			'import posts from "./posts.json"',
			"",
			"Visual.staticPaths(screen, posts)",
			"",
			"visual app =",
			"<h1>Post: {slug}</h1>",
			"",
			"Visual.render(app)",
		].join("\n")
	);
	runWebsc(["build", dir]);

	await withRunningServer(dir, async (port) => {
		const res = await get(port, "/blog/un-post-nuevo");
		assert.equal(res.status, 200);
		assert.match(res.body, /<h1>Post: un-post-nuevo<\/h1>/);
	});
});
