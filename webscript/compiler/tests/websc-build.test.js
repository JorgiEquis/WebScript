const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { execFileSync, spawn } = require("child_process");

const WEBSC_BIN = path.join(__dirname, "../bin/websc.js");
const SRC_DIR = path.join(__dirname, "../../src");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-build-"));
}

function runWebsc(args) {
	return execFileSync("node", [WEBSC_BIN, ...args], { encoding: "utf8" });
}

function copyInto(projectDir, files) {
	for (const file of files) {
		fs.copyFileSync(path.join(SRC_DIR, file), path.join(projectDir, "src", file));
	}
}

test("websc build genera dist/ con pages.json, un bundle por página, y server.js", () => {
	const dir = path.join(tmpDir(), "proyecto");
	runWebsc(["init", dir]);
	copyInto(dir, ["demo-contador.wsf", "demo-servidor.wsb"]);

	runWebsc(["build", dir]);

	assert.ok(fs.existsSync(path.join(dir, "dist", "demo-contador.bundle.js")));
	assert.ok(fs.existsSync(path.join(dir, "dist", "server.js")));
	assert.ok(fs.existsSync(path.join(dir, "dist", "pages.json")));

	const pages = JSON.parse(fs.readFileSync(path.join(dir, "dist", "pages.json"), "utf8"));
	const demoContador = pages.find((p) => p.wsfFile === "../src/demo-contador.wsf" && p.pattern === "/demo-contador");
	assert.ok(demoContador);
	// única página -> también alias en "/"
	assert.ok(pages.some((p) => p.pattern === "/" && p.bundleFile === demoContador.bundleFile));
});

test("una página con Visual.route() con :parámetro conserva el patrón real (el matching es por petición, no precalculado)", () => {
	const dir = path.join(tmpDir(), "proyecto");
	runWebsc(["init", dir]);
	copyInto(dir, ["app.wsf", "contador.wsf", "utils.ws", "api.wsb", "persona.wson"]);

	runWebsc(["build", dir]);

	const pages = JSON.parse(fs.readFileSync(path.join(dir, "dist", "pages.json"), "utf8"));
	assert.ok(pages.some((p) => p.wsfFile === "../src/app.wsf" && p.pattern === "/personas/:id"));
});

test("un .wsf 'library' (sin Visual.render) no genera página propia", () => {
	const dir = path.join(tmpDir(), "proyecto");
	runWebsc(["init", dir]);
	copyInto(dir, ["app.wsf", "contador.wsf", "utils.ws"]);

	runWebsc(["build", dir]);

	assert.ok(!fs.existsSync(path.join(dir, "dist", "contador.bundle.js")));
});

test("dist/server.js hace SSR real por petición: distinto :id da distinto HTML, no precalculado", async () => {
	const dir = path.join(tmpDir(), "proyecto");
	runWebsc(["init", dir]);
	fs.writeFileSync(
		path.join(dir, "src", "pagina.wsf"),
		[
			"const Visual screen = Visual.route('/personas/:id')",
			"const {id} = Visual.params(screen)",
			"",
			"visual app =",
			"<div>",
			"\t<h1>Persona numero {id}</h1>",
			"</div>",
			"",
			"Visual.render(app)",
		].join("\n")
	);
	runWebsc(["build", dir]);

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
			const timeout = setTimeout(() => reject(new Error("no arrancó a tiempo")), 3000);
			child.stdout.on("data", (chunk) => {
				if (chunk.toString().includes("Servidor en")) {
					clearTimeout(timeout);
					resolve();
				}
			});
			child.stderr.on("data", (chunk) => reject(new Error(chunk.toString())));
		});

		const get = (pathname) =>
			new Promise((resolve) => {
				http.get(`http://localhost:${port}${pathname}`, (r) => {
					let out = "";
					r.on("data", (c) => (out += c));
					r.on("end", () => resolve(out));
				});
			});

		const html7 = await get("/personas/7");
		const html99 = await get("/personas/99");

		assert.match(html7, /<h1>Persona numero 7<\/h1>/);
		assert.match(html99, /<h1>Persona numero 99<\/h1>/);
	} finally {
		child.kill();
	}
});

test("dist/server.js generado arranca de verdad y sirve página + API reales", async () => {
	const dir = path.join(tmpDir(), "proyecto");
	runWebsc(["init", dir]);
	copyInto(dir, ["demo-contador.wsf", "demo-servidor.wsb"]);
	runWebsc(["build", dir]);

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
			const timeout = setTimeout(() => reject(new Error("no arrancó a tiempo")), 3000);
			child.stdout.on("data", (chunk) => {
				if (chunk.toString().includes("Servidor en")) {
					clearTimeout(timeout);
					resolve();
				}
			});
			child.stderr.on("data", (chunk) => reject(new Error(chunk.toString())));
		});

		const pageRes = await new Promise((resolve) => {
			http.get(`http://localhost:${port}/`, (r) => {
				let out = "";
				r.on("data", (c) => (out += c));
				r.on("end", () => resolve({ status: r.statusCode, body: out }));
			});
		});
		assert.equal(pageRes.status, 200);
		assert.match(pageRes.body, /function create_app/);

		const apiRes = await new Promise((resolve) => {
			const data = JSON.stringify({ texto: "probado con dist/server.js real" });
			const req = http.request(
				{ hostname: "localhost", port, path: "/notas", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
				(r) => {
					let out = "";
					r.on("data", (c) => (out += c));
					r.on("end", () => resolve({ status: r.statusCode, body: out }));
				}
			);
			req.write(data);
			req.end();
		});
		assert.equal(apiRes.status, 201);
		assert.deepEqual(JSON.parse(apiRes.body), { mensaje: "recibido", texto: "probado con dist/server.js real" });
	} finally {
		child.kill();
	}
});
