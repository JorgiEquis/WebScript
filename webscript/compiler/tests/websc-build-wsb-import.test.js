const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { execFileSync, spawn } = require("child_process");

const WEBSC_BIN = path.join(__dirname, "../bin/websc.js");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-build-wsbimport-"));
}

function runWebsc(args) {
	return execFileSync("node", [WEBSC_BIN, ...args], { encoding: "utf8" });
}

const USUARIOS_WSB = [
	"export const WSON wsonUsuarios =",
	'\t-> to: "/usuarios/:id"',
	'\t-> via: "GET"',
	"",
	"export reactive any peticionUsuarios = WSON.listen(wsonUsuarios)",
	"",
	"watch(peticionUsuarios)",
	"\tconst { id } = WSON.httpParams(peticionUsuarios)",
	'\tpeticionUsuarios.content = { id: id, nombre: "Usuario " + id }',
	"\tWSON.httpSend(peticionUsuarios)",
].join("\n");

const API_WSB = [
	'import { peticionUsuarios } from "./usuarios.wsb"',
	"",
	"const WSON wsonSalud =",
	'\t-> to: "/salud"',
	'\t-> via: "GET"',
	"",
	"reactive any peticionSalud = WSON.listen(wsonSalud)",
	"",
	"watch(peticionSalud)",
	"\tpeticionSalud.content = { ok: true }",
	"\tWSON.httpSend(peticionSalud)",
].join("\n");

function get(port, pathname) {
	return new Promise((resolve, reject) => {
		http.get(`http://localhost:${port}${pathname}`, (r) => {
			let out = "";
			r.on("data", (c) => (out += c));
			r.on("end", () => resolve({ status: r.statusCode, body: out }));
		}).on("error", reject);
	});
}

test("websc build: un .wsb importado por otro se excluye de los ficheros de entrada (no se combina por su cuenta)", () => {
	const dir = path.join(tmpDir(), "proyecto");
	runWebsc(["init", dir]);
	fs.writeFileSync(path.join(dir, "src", "usuarios.wsb"), USUARIOS_WSB);
	fs.writeFileSync(path.join(dir, "src", "api.wsb"), API_WSB);

	runWebsc(["build", dir]);

	const wsbFiles = JSON.parse(fs.readFileSync(path.join(dir, "dist", "wsb-files.json"), "utf8"));
	assert.deepEqual(wsbFiles, ["../src/api.wsb"]); // usuarios.wsb NO aparece: es librería
});

test("websc build: un .wsb exportado y NO importado por nadie se sirve igual por su cuenta", () => {
	const dir = path.join(tmpDir(), "proyecto");
	runWebsc(["init", dir]);
	fs.writeFileSync(path.join(dir, "src", "usuarios.wsb"), USUARIOS_WSB);

	runWebsc(["build", dir]);

	const wsbFiles = JSON.parse(fs.readFileSync(path.join(dir, "dist", "wsb-files.json"), "utf8"));
	assert.deepEqual(wsbFiles, ["../src/usuarios.wsb"]);
});

test(
	"integración real: dist/server.js sirve la ruta propia y la importada, sin colisión ni duplicados",
	{ timeout: 20000 },
	async () => {
		const dir = path.join(tmpDir(), "proyecto");
		runWebsc(["init", dir]);
		fs.writeFileSync(path.join(dir, "src", "usuarios.wsb"), USUARIOS_WSB);
		fs.writeFileSync(path.join(dir, "src", "api.wsb"), API_WSB);
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
				const timeout = setTimeout(() => reject(new Error("no arrancó a tiempo")), 5000);
				child.stdout.on("data", (chunk) => {
					if (chunk.toString().includes("Servidor en")) {
						clearTimeout(timeout);
						resolve();
					}
				});
				child.stderr.on("data", (chunk) => reject(new Error(chunk.toString())));
			});

			const salud = await get(port, "/salud");
			assert.deepEqual(JSON.parse(salud.body), { ok: true });

			const usuario = await get(port, "/usuarios/7");
			assert.deepEqual(JSON.parse(usuario.body), { id: "7", nombre: "Usuario 7" });
		} finally {
			child.kill();
		}
	}
);

test(
	"integración real: websc build + dist/server.js sirven correctamente un import de .js normal y de un módulo nativo de Node",
	{ timeout: 20000 },
	async () => {
		const dir = path.join(tmpDir(), "proyecto");
		runWebsc(["init", dir]);
		fs.writeFileSync(
			path.join(dir, "src", "utilidades.js"),
			['function saludar(nombre) {', '\treturn "Hola desde .js, " + nombre + "!";', "}", "module.exports = { saludar };"].join(
				"\n"
			)
		);
		fs.writeFileSync(
			path.join(dir, "src", "api.wsb"),
			[
				'import { saludar } from "./utilidades.js"',
				'import path from "path"',
				"",
				"const WSON wsonAlgo =",
				'\t-> to: "/algo"',
				'\t-> via: "GET"',
				"",
				"reactive any peticion = WSON.listen(wsonAlgo)",
				"",
				"watch(peticion)",
				'\tpeticion.content = { mensaje: saludar("Ana"), ext: path.extname("archivo.wsb") }',
				"\tWSON.httpSend(peticion)",
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
				const timeout = setTimeout(() => reject(new Error("no arrancó a tiempo")), 5000);
				child.stdout.on("data", (chunk) => {
					if (chunk.toString().includes("Servidor en")) {
						clearTimeout(timeout);
						resolve();
					}
				});
				child.stderr.on("data", (chunk) => reject(new Error(chunk.toString())));
			});

			const res = await get(port, "/algo");
			assert.deepEqual(JSON.parse(res.body), { mensaje: "Hola desde .js, Ana!", ext: ".wsb" });
		} finally {
			child.kill();
		}
	}
);

test(
	"integración real: websc build + dist/server.js con un .wsdb — node-sqlite3-wasm vendorizado, sin npm install, con persistencia real",
	{ timeout: 20000 },
	async () => {
		const dir = path.join(tmpDir(), "proyecto");
		runWebsc(["init", dir]);
		fs.writeFileSync(
			path.join(dir, "src", "usuarios.wsdb"),
			["-> name: 'usuario'", "-> schema:", "\t-> id: integer(10)(primary)/", "\t-> nombre: string(40)", "\t-> edad: integer(3)"].join("\n")
		);
		fs.writeFileSync(
			path.join(dir, "src", "api.wsb"),
			[
				'import { Usuario } from "./usuarios.wsdb"',
				"",
				"const WSON wsonCrear =",
				'\t-> to: "/usuarios"',
				'\t-> via: "POST"',
				"",
				"reactive any peticionCrear = WSON.listen(wsonCrear)",
				"",
				"watch(peticionCrear)",
				"\tconst datos = WSON.showContent(peticionCrear)",
				"\tconst usuario = Usuario.save({ nombre: datos.nombre, edad: datos.edad })",
				"\tpeticionCrear.content = { id: usuario.id }",
				"\tWSON.httpSend(peticionCrear)",
				"",
				"const WSON wsonListar =",
				'\t-> to: "/usuarios"',
				'\t-> via: "GET"',
				"",
				"reactive any peticionListar = WSON.listen(wsonListar)",
				"",
				"watch(peticionListar)",
				"\tpeticionListar.content = { usuarios: Usuario.selectAll().map(u => u.nombre) }",
				"\tWSON.httpSend(peticionListar)",
			].join("\n")
		);
		runWebsc(["build", dir]);

		// Sin este vendorizado, el server.js real fallaría al arrancar con
		// "Cannot find module 'node-sqlite3-wasm'" — confirma que websc
		// init/build lo trae consigo, sin depender de un npm install del
		// usuario.
		assert.ok(fs.existsSync(path.join(dir, "compiler", "node_modules", "node-sqlite3-wasm")));

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

			const r1 = await new Promise((resolve, reject) => {
				const req = require("http").request(
					{ hostname: "localhost", port, path: "/usuarios", method: "POST", headers: { "Content-Type": "application/json" } },
					(res) => {
						let b = "";
						res.on("data", (c) => (b += c));
						res.on("end", () => resolve(JSON.parse(b)));
					}
				);
				req.on("error", reject);
				req.end(JSON.stringify({ nombre: "Ana", edad: 30 }));
			});
			assert.deepEqual(r1, { id: 1 });

			const r2 = await get(port, "/usuarios");
			assert.deepEqual(JSON.parse(r2.body), { usuarios: ["Ana"] });

			assert.ok(fs.existsSync(path.join(dir, ".wsdb-data", "webscript.db")));
		} finally {
			child.kill();
		}
	}
);

test("REGRESIÓN (eliminación del formato antiguo): websc build con un .wsdb de \"-> collection:\" falla (exit 1) nombrando el fichero y cómo migrar", () => {
	const dir = path.join(tmpDir(), "proyecto");
	runWebsc(["init", dir]);
	fs.writeFileSync(path.join(dir, "src", "viejo.wsdb"), ['-> collection: "viejos"', "-> schema:", "\tnombre: string"].join("\n"));

	let error = null;
	try {
		runWebsc(["build", dir]);
	} catch (e) {
		error = e;
	}
	assert.ok(error, "el build debe fallar, no ignorar el .wsdb antiguo en silencio");
	assert.equal(error.status, 1);
	const stderr = String(error.stderr);
	assert.match(stderr, /viejo\.wsdb: este \.wsdb usa el formato antiguo/, "nombra el fichero concreto");
	assert.match(stderr, /-> name:/, "y explica el formato actual");
});

test("websc init: lib/WSSchema.ws y lib/WSDB.ws son plantillas fijas (interfaces), protegidas por el lock — un .wsdb v2 no genera nada en lib/", () => {
	const dir = tmpDir();
	runWebsc(["init", dir]);

	const schemaDecl = fs.readFileSync(path.join(dir, "lib", "WSSchema.ws"), "utf8");
	assert.match(schemaDecl, /^interface WSSchema$/m);
	assert.match(schemaDecl, /static getSchema\(\)/);
	const wsdbDecl = fs.readFileSync(path.join(dir, "lib", "WSDB.ws"), "utf8");
	assert.match(wsdbDecl, /^interface WSDB$/m);
	assert.match(wsdbDecl, /static save\(item\)/);
	assert.match(wsdbDecl, /static deleteWhere\(condicion\)/);

	const lockPath = path.join(dir, "lib", ".websc-lock.json");
	const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
	assert.ok(lock["WSSchema.ws"] && lock["WSDB.ws"], "las dos entran en el lock de lib/, igual que WSON.ws/Visual.ws");
	const { validateLibUnmodified } = require("../check-lib");
	fs.appendFileSync(path.join(dir, "lib", "WSSchema.ws"), "\n// editado a mano\n");
	assert.throws(() => validateLibUnmodified(dir), /WSSchema\.ws" ha sido modificado/);
	fs.writeFileSync(path.join(dir, "lib", "WSSchema.ws"), schemaDecl); // deshacer, para el resto de la prueba

	fs.writeFileSync(
		path.join(dir, "src", "personas.wsdb"),
		["-> name: 'persona'", "-> schema", "     -> idPerson: integer(10)(primary)", "     -> nombre: string(40)/"].join("\n")
	);
	runWebsc(["build", dir]);
	assert.equal(fs.readdirSync(path.join(dir, "lib")).filter((f) => f.endsWith(".ws")).sort().join(","), "Visual.ws,WSDB.ws,WSON.ws,WSSchema.ws");
	validateLibUnmodified(dir); // el build no ha tocado lib/ — sigue validando contra el lock de websc init
});

test("websc build: un .wsdb v2 mal declarado hace fallar el build aunque nadie lo importe", () => {
	const dir = tmpDir();
	runWebsc(["init", dir]);
	fs.writeFileSync(path.join(dir, "src", "malo.wsdb"), ["-> name: 'malo'", "-> schema", "     -> a: integer(5)"].join("\n"));
	assert.throws(() => execFileSync("node", [WEBSC_BIN, "build", dir], { encoding: "utf8", stdio: "pipe" }), /exactamente un campo \(primary\)/);
});

test("websc build: -> depends hacia un .wsdb que no existe hace fallar el build (aunque nadie importe ninguno de los dos)", () => {
	const dir = tmpDir();
	runWebsc(["init", dir]);
	fs.writeFileSync(
		path.join(dir, "src", "personas.wsdb"),
		["-> name: 'persona'", "-> depends: ['coches']", "-> schema", "     -> idPerson: integer(10)(primary)"].join("\n")
	);
	assert.throws(
		() => execFileSync("node", [WEBSC_BIN, "build", dir], { encoding: "utf8", stdio: "pipe" }),
		/no existe.*coches\.wsdb/
	);
});
