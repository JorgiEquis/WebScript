const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { spawn } = require("child_process");

const SERVE_DEMO = path.join(__dirname, "../serve-demo.js");
const SRC_DIR = path.join(__dirname, "../../src");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-serve-demo-"));
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

async function withServeDemo(args, fn) {
	const child = spawn("node", [SERVE_DEMO, ...args]);
	try {
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("no arrancó a tiempo")), 5000);
			child.stdout.on("data", (chunk) => {
				if (chunk.toString().includes("http://localhost")) {
					clearTimeout(timeout);
					resolve();
				}
			});
			child.stderr.on("data", (chunk) => reject(new Error(chunk.toString())));
		});
		await fn();
	} finally {
		child.kill();
	}
}

test("serve-demo.js sin .wsb: solo-frontend, sirve la página y da 404 claro en cualquier otra ruta", async () => {
	const dir = tmpDir();
	fs.writeFileSync(
		path.join(dir, "app.wsf"),
		["reactive contador = 0", "visual app =", "<p>Valor: {contador}</p>", "Visual.render(app)"].join("\n")
	);

	await withServeDemo([path.join(dir, "app.wsf"), "3910"], async () => {
		const pagina = await get(3910, "/");
		assert.match(pagina.body, /Valor: 0/);

		const otra = await get(3910, "/algo");
		assert.equal(otra.status, 404);
		assert.match(JSON.parse(otra.body).error, /no tiene \.wsb/);
	});
});

test("serve-demo.js con .wsb: sigue sirviendo página y API en el mismo servidor, como antes", async () => {
	await withServeDemo(
		[path.join(SRC_DIR, "demo-cliente-servidor.wsf"), path.join(SRC_DIR, "demo-servidor.wsb"), "3911"],
		async () => {
			const pagina = await get(3911, "/");
			assert.match(pagina.body, /<button>Enviar<\/button>/);
		}
	);
});

test("REGRESIÓN nueva capacidad: serve-demo.js sirve VARIAS páginas de golpe, cada una en su propia ruta real (con :params incluidos)", async () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "inicio.wsf"), ["visual app =", "<h1>Página de inicio</h1>", "Visual.render(app)"].join("\n"));
	fs.writeFileSync(
		path.join(dir, "blog.wsf"),
		[
			"const Visual screen = Visual.route('/blog/:slug')",
			"const {slug} = Visual.params(screen)",
			"",
			"visual app =",
			"<h1>Post: {slug}</h1>",
			"",
			"Visual.render(app)",
		].join("\n")
	);

	await withServeDemo([path.join(dir, "inicio.wsf"), path.join(dir, "blog.wsf"), "3912"], async () => {
		const r1 = await get(3912, "/inicio");
		assert.match(r1.body, /<h1>Página de inicio<\/h1>/);

		const r2 = await get(3912, "/blog/mi-post");
		assert.match(r2.body, /<h1>(?:<!--t-->)?Post: mi-post(?:<!--\/t-->)?<\/h1>/);

		const r3 = await get(3912, "/blog/otro-post");
		assert.match(r3.body, /<h1>(?:<!--t-->)?Post: otro-post(?:<!--\/t-->)?<\/h1>/);

		// Con MÁS de una página, ninguna se sirve "de regalo" en "/" — solo
		// pasa con una sola página.
		const raiz = await get(3912, "/");
		assert.equal(raiz.status, 404);
	});
});

test("REGRESIÓN nueva capacidad: serve-demo.js combina varias páginas Y un .wsb en el mismo servidor", async () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "inicio.wsf"), ["visual app =", "<h1>Inicio</h1>", "Visual.render(app)"].join("\n"));
	fs.writeFileSync(
		path.join(dir, "blog.wsf"),
		[
			"const Visual screen = Visual.route('/blog/:slug')",
			"const {slug} = Visual.params(screen)",
			"",
			"visual app =",
			"<h1>Post: {slug}</h1>",
			"",
			"Visual.render(app)",
		].join("\n")
	);
	fs.writeFileSync(
		path.join(dir, "api.wsb"),
		[
			"const WSON wsonSalud =",
			'\t-> to: "/salud"',
			'\t-> via: "GET"',
			"",
			"reactive any peticion = WSON.listen(wsonSalud)",
			"",
			"watch(peticion)",
			"\tpeticion.content = { ok: true }",
			"\tWSON.httpSend(peticion)",
		].join("\n")
	);

	await withServeDemo([path.join(dir, "inicio.wsf"), path.join(dir, "blog.wsf"), path.join(dir, "api.wsb"), "3913"], async () => {
		const r1 = await get(3913, "/inicio");
		assert.match(r1.body, /<h1>Inicio<\/h1>/);

		const r2 = await get(3913, "/blog/x");
		assert.match(r2.body, /<h1>(?:<!--t-->)?Post: x(?:<!--\/t-->)?<\/h1>/);

		const r3 = await get(3913, "/salud");
		assert.deepEqual(JSON.parse(r3.body), { ok: true });
	});
});

test("serve-demo.js: un argumento que no es .wsf, .wsb ni un puerto numérico da un error claro", () => {
	const { execFileSync } = require("child_process");
	assert.throws(
		() => execFileSync("node", [SERVE_DEMO, "algo-raro.txt"], { encoding: "utf8" }),
		(err) => {
			assert.equal(err.status, 1);
			assert.match(err.stderr.toString(), /Argumento no reconocido/);
			return true;
		}
	);
});

test("REGRESIÓN nueva capacidad: serve-demo.js acepta un directorio entero, con el mismo criterio de escaneo que websc build", async () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "inicio.wsf"), ["visual app =", "<h1>Inicio</h1>", "Visual.render(app)"].join("\n"));
	fs.writeFileSync(
		path.join(dir, "blog.wsf"),
		[
			"const Visual screen = Visual.route('/blog/:slug')",
			"const {slug} = Visual.params(screen)",
			"",
			"visual app =",
			"<h1>Post: {slug}</h1>",
			"",
			"Visual.render(app)",
		].join("\n")
	);
	fs.writeFileSync(
		path.join(dir, "api.wsb"),
		[
			"const WSON wsonSalud =",
			'\t-> to: "/salud"',
			'\t-> via: "GET"',
			"",
			"reactive any peticion = WSON.listen(wsonSalud)",
			"",
			"watch(peticion)",
			"\tpeticion.content = { ok: true }",
			"\tWSON.httpSend(peticion)",
		].join("\n")
	);

	await withServeDemo([dir, "3914"], async () => {
		const r1 = await get(3914, "/inicio");
		assert.match(r1.body, /<h1>Inicio<\/h1>/);

		const r2 = await get(3914, "/blog/x");
		assert.match(r2.body, /<h1>(?:<!--t-->)?Post: x(?:<!--\/t-->)?<\/h1>/);

		const r3 = await get(3914, "/salud");
		assert.deepEqual(JSON.parse(r3.body), { ok: true });
	});
});

test("serve-demo.js con directorio: un .wsb importado por otro del mismo directorio se excluye del escaneo (no duplica sus rutas)", async () => {
	const dir = tmpDir();
	fs.writeFileSync(
		path.join(dir, "usuarios.wsb"),
		[
			"export const WSON wsonUsuarios =",
			'\t-> to: "/usuarios/:id"',
			'\t-> via: "GET"',
			"",
			"export reactive any peticionUsuarios = WSON.listen(wsonUsuarios)",
			"",
			"watch(peticionUsuarios)",
			"\tpeticionUsuarios.content = { ok: true }",
			"\tWSON.httpSend(peticionUsuarios)",
		].join("\n")
	);
	fs.writeFileSync(
		path.join(dir, "api.wsb"),
		['import { peticionUsuarios } from "./usuarios.wsb"'].join("\n")
	);
	fs.writeFileSync(path.join(dir, "inicio.wsf"), ["visual app =", "<h1>Inicio</h1>", "Visual.render(app)"].join("\n"));

	// Si NO se excluyera usuarios.wsb, esto fallaría al arrancar por
	// colisión de rutas duplicadas (una vez suelta, otra vía import).
	await withServeDemo([dir, "3915"], async () => {
		const res = await get(3915, "/usuarios/7");
		assert.deepEqual(JSON.parse(res.body), { ok: true });
	});
});

test("serve-demo.js: mezcla de un directorio y un fichero suelto de fuera de él", async () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "inicio.wsf"), ["visual app =", "<h1>Inicio</h1>", "Visual.render(app)"].join("\n"));
	const otroDir = tmpDir();
	fs.writeFileSync(path.join(otroDir, "extra.wsf"), ["visual app =", "<h1>Extra</h1>", "Visual.render(app)"].join("\n"));

	await withServeDemo([dir, path.join(otroDir, "extra.wsf"), "3916"], async () => {
		const r1 = await get(3916, "/inicio");
		assert.match(r1.body, /<h1>Inicio<\/h1>/);
		const r2 = await get(3916, "/extra");
		assert.match(r2.body, /<h1>Extra<\/h1>/);
	});
});
