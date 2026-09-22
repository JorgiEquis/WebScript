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

test("websc build: una página sin :params ni Visual.query() se marca como estática y se pre-renderiza a un .html real", () => {
	const dir = path.join(tmpDir("websc-ssg-"), "proyecto");
	runWebsc(["init", dir]);
	fs.writeFileSync(
		path.join(dir, "src", "inicio.wsf"),
		["visual app =", "<h1>Estática</h1>", "Visual.render(app)"].join("\n")
	);

	runWebsc(["build", dir]);

	const pages = JSON.parse(fs.readFileSync(path.join(dir, "dist", "pages.json"), "utf8"));
	const pagina = pages.find((p) => p.pattern === "/inicio");
	assert.equal(pagina.static, true);
	assert.equal(pagina.htmlFile, "inicio.html");

	const html = fs.readFileSync(path.join(dir, "dist", "inicio.html"), "utf8");
	assert.match(html, /<h1>Estática<\/h1>/);
});

test("websc build: una página con :params en su ruta se marca como dinámica (SSR real, no SSG)", () => {
	const dir = path.join(tmpDir("websc-ssg-"), "proyecto");
	runWebsc(["init", dir]);
	fs.writeFileSync(
		path.join(dir, "src", "persona.wsf"),
		[
			"const Visual screen = Visual.route('/personas/:id')",
			"const {id} = Visual.params(screen)",
			"visual app =",
			"<p>{id}</p>",
			"Visual.render(app)",
		].join("\n")
	);

	runWebsc(["build", dir]);

	const pages = JSON.parse(fs.readFileSync(path.join(dir, "dist", "pages.json"), "utf8"));
	const pagina = pages.find((p) => p.pattern === "/personas/:id");
	assert.equal(pagina.static, false);
	assert.equal(pagina.htmlFile, undefined);
	assert.equal(fs.existsSync(path.join(dir, "dist", "persona.html")), false);
});

test("websc build: una página sin :params pero que usa Visual.query() se marca como dinámica (el query string sí varía por petición)", () => {
	const dir = path.join(tmpDir("websc-ssg-"), "proyecto");
	runWebsc(["init", dir]);
	fs.writeFileSync(
		path.join(dir, "src", "buscar.wsf"),
		[
			"const Visual screen = Visual.route('/buscar')",
			"const {termino} = Visual.query(screen)",
			"visual app =",
			"<p>{termino}</p>",
			"Visual.render(app)",
		].join("\n")
	);

	runWebsc(["build", dir]);

	const pages = JSON.parse(fs.readFileSync(path.join(dir, "dist", "pages.json"), "utf8"));
	const pagina = pages.find((p) => p.pattern === "/buscar");
	assert.equal(pagina.static, false);
});

test(
	"integración real: dist/server.js sirve la página estática incluso sin el .wsf fuente (SSG real, no re-renderiza), y la dinámica sigue funcionando por petición",
	{ timeout: 20000 },
	async () => {
		const dir = path.join(tmpDir("websc-ssg-"), "proyecto");
		runWebsc(["init", dir]);
		fs.writeFileSync(
			path.join(dir, "src", "inicio.wsf"),
			["visual app =", "<h1>Página estática</h1>", "Visual.render(app)"].join("\n")
		);
		fs.writeFileSync(
			path.join(dir, "src", "persona.wsf"),
			[
				"const Visual screen = Visual.route('/personas/:id')",
				"const {id} = Visual.params(screen)",
				"visual app =",
				"<p>Persona {id}</p>",
				"Visual.render(app)",
			].join("\n")
		);
		runWebsc(["build", dir]);

		// Se borra el .wsf de la página estática — si dist/server.js
		// dependiera de él en tiempo de ejecución, esto rompería la ruta.
		fs.rmSync(path.join(dir, "src", "inicio.wsf"));

		const port = await new Promise((resolve) => {
			const net = require("net");
			const srv = net.createServer();
			srv.listen(0, () => {
				const p = srv.address().port;
				srv.close(() => resolve(p));
			});
		});
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

			const estatica = await get(port, "/inicio");
			assert.match(estatica.body, /<h1>Página estática<\/h1>/);

			const p7 = await get(port, "/personas/7");
			assert.match(p7.body, /<p>Persona 7<\/p>/);
			const p99 = await get(port, "/personas/99");
			assert.match(p99.body, /<p>Persona 99<\/p>/);
		} finally {
			child.kill();
		}
	}
);
