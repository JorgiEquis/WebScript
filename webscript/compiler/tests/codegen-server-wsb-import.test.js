const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { parse } = require("../parser");
const { createServer } = require("../codegen-server");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-wsb-import-"));
}

function get(port, pathname) {
	return new Promise((resolve, reject) => {
		http.get(`http://localhost:${port}${pathname}`, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve({ status: res.statusCode, body }));
		}).on("error", reject);
	});
}

function getWithCookie(port, pathname, cookie) {
	return new Promise((resolve, reject) => {
		const headers = cookie ? { Cookie: cookie } : {};
		http.get({ hostname: "localhost", port, path: pathname, headers }, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
		}).on("error", reject);
	});
}

function extractCookie(setCookieHeaders, name) {
	const line = (setCookieHeaders || []).find((c) => c.startsWith(`${name}=`));
	return line ? line.split(";")[0].split("=")[1] : null;
}

function post(port, pathname, data) {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify(data);
		const req = http.request(
			{ hostname: "localhost", port, path: pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
			(res) => {
				let out = "";
				res.on("data", (c) => (out += c));
				res.on("end", () => resolve({ status: res.statusCode, body: out }));
			}
		);
		req.on("error", reject);
		req.write(body);
		req.end();
	});
}

test("import .wsb: una función exportada se puede importar y usar, igual que un .ws", async () => {
	const dir = tmpDir();
	fs.writeFileSync(
		path.join(dir, "utilidades.wsb"),
		["export function saluda(nombre)", "\treturn \"Hola \" + nombre"].join("\n")
	);
	fs.writeFileSync(
		path.join(dir, "api.wsb"),
		[
			'import { saluda } from "./utilidades.wsb"',
			"",
			"const WSON wsonSaludo =",
			'\t-> to: "/saludo"',
			'\t-> via: "GET"',
			"",
			"reactive any peticion = WSON.listen(wsonSaludo)",
			"",
			"watch(peticion)",
			"\tpeticion.content = { mensaje: saluda(\"Ana\") }",
			"\tWSON.httpSend(peticion)",
		].join("\n")
	);

	const server = createServer(parse(fs.readFileSync(path.join(dir, "api.wsb"), "utf8")), {}, { baseDir: dir });
	try {
		await new Promise((resolve) => server.listen(0, resolve));
		const port = server.address().port;
		const res = await get(port, "/saludo");
		assert.deepEqual(JSON.parse(res.body), { mensaje: "Hola Ana" });
	} finally {
		server.close();
	}
});

test("import .wsb: una ruta completa (WSON + reactive + watch) exportada se sirve también desde quien la importa", async () => {
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
			"\tconst { id } = WSON.httpParams(peticionUsuarios)",
			'\tpeticionUsuarios.content = { id: id, nombre: "Usuario " + id }',
			"\tWSON.httpSend(peticionUsuarios)",
		].join("\n")
	);
	fs.writeFileSync(
		path.join(dir, "api.wsb"),
		[
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
		].join("\n")
	);

	const server = createServer(parse(fs.readFileSync(path.join(dir, "api.wsb"), "utf8")), {}, { baseDir: dir });
	try {
		await new Promise((resolve) => server.listen(0, resolve));
		const port = server.address().port;

		const salud = await get(port, "/salud");
		assert.deepEqual(JSON.parse(salud.body), { ok: true });

		const usuario = await get(port, "/usuarios/42");
		assert.deepEqual(JSON.parse(usuario.body), { id: "42", nombre: "Usuario 42" });
	} finally {
		server.close();
	}
});

test("import .wsb: una ruta importada que a su vez importa un DTO .wson se resuelve contra SU PROPIA carpeta de origen", async () => {
	const dir = tmpDir();
	fs.writeFileSync(
		path.join(dir, "persona.wson"),
		['-> from: "app"', '-> to: "/personas"', '-> via: "POST"', "-> content:", "\tnombre: string", "\tedad: integer"].join("\n")
	);
	fs.writeFileSync(
		path.join(dir, "personas.wsb"),
		[
			'import { Persona } from "./persona.wson"',
			"",
			"export const WSON wsonCrearPersona =",
			'\t-> to: "/personas"',
			'\t-> via: "POST"',
			"",
			"export reactive any peticionPersona = WSON.listen(wsonCrearPersona)",
			"",
			"watch(peticionPersona)",
			"\tconst datos = WSON.showContent(peticionPersona)",
			"\tconst p = new Persona(datos.nombre, datos.edad)",
			"\tpeticionPersona.content = { creado: true, nombre: p.nombre, edad: p.edad }",
			"\tWSON.httpSend(peticionPersona)",
		].join("\n")
	);
	fs.writeFileSync(
		path.join(dir, "api.wsb"),
		[
			'import { peticionPersona } from "./personas.wsb"',
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
		].join("\n")
	);

	const server = createServer(parse(fs.readFileSync(path.join(dir, "api.wsb"), "utf8")), {}, { baseDir: dir });
	try {
		await new Promise((resolve) => server.listen(0, resolve));
		const port = server.address().port;
		const res = await post(port, "/personas", { nombre: "Ana", edad: 30 });
		assert.deepEqual(JSON.parse(res.body), { creado: true, nombre: "Ana", edad: 30 });
	} finally {
		server.close();
	}
});

test("import .wsb: una colisión entre ruta propia e importada se detecta igual que entre dos rutas propias", () => {
	const dir = tmpDir();
	fs.writeFileSync(
		path.join(dir, "duplicada.wsb"),
		[
			"export const WSON wsonSalud2 =",
			'\t-> to: "/salud"',
			'\t-> via: "GET"',
			"",
			"export reactive any peticionSalud2 = WSON.listen(wsonSalud2)",
			"",
			"watch(peticionSalud2)",
			"\tWSON.httpSend(peticionSalud2)",
		].join("\n")
	);
	fs.writeFileSync(
		path.join(dir, "api.wsb"),
		[
			'import { peticionSalud2 } from "./duplicada.wsb"',
			"",
			"const WSON wsonSalud =",
			'\t-> to: "/salud"',
			'\t-> via: "GET"',
			"",
			"reactive any peticionSalud = WSON.listen(wsonSalud)",
			"",
			"watch(peticionSalud)",
			"\tWSON.httpSend(peticionSalud)",
		].join("\n")
	);

	assert.throws(
		() => createServer(parse(fs.readFileSync(path.join(dir, "api.wsb"), "utf8")), {}, { baseDir: dir }),
		/[Cc]olisión/
	);
});

test("import .wsb: un nombre que no existe en absoluto da un error claro", () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "otro.wsb"), ["function algo()", "\treturn 1"].join("\n"));
	fs.writeFileSync(
		path.join(dir, "api.wsb"),
		[
			'import { noExiste } from "./otro.wsb"',
			"",
			"const WSON wsonX =",
			'\t-> to: "/x"',
			'\t-> via: "GET"',
			"",
			"reactive any peticion = WSON.listen(wsonX)",
			"",
			"watch(peticion)",
			"\tWSON.httpSend(peticion)",
		].join("\n")
	);

	assert.throws(
		() => createServer(parse(fs.readFileSync(path.join(dir, "api.wsb"), "utf8")), {}, { baseDir: dir }),
		/no está exportado/
	);
});

test("import .wsb: una función de nivel superior es importable aunque no lleve 'export' delante (mismo criterio que .ws)", async () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "otro.wsb"), ["function algo()", "\treturn 42"].join("\n"));
	fs.writeFileSync(
		path.join(dir, "api.wsb"),
		[
			'import { algo } from "./otro.wsb"',
			"",
			"const WSON wsonX =",
			'\t-> to: "/x"',
			'\t-> via: "GET"',
			"",
			"reactive any peticion = WSON.listen(wsonX)",
			"",
			"watch(peticion)",
			"\tpeticion.content = { valor: algo() }",
			"\tWSON.httpSend(peticion)",
		].join("\n")
	);

	const server = createServer(parse(fs.readFileSync(path.join(dir, "api.wsb"), "utf8")), {}, { baseDir: dir });
	try {
		await new Promise((resolve) => server.listen(0, resolve));
		const port = server.address().port;
		const res = await get(port, "/x");
		assert.deepEqual(JSON.parse(res.body), { valor: 42 });
	} finally {
		server.close();
	}
});

test("REGRESIÓN bug real: una ruta importada que depende de una var 'hermana' del fichero origen se trae junto con ella (antes se perdía)", async () => {
	const dir = tmpDir();
	fs.writeFileSync(
		path.join(dir, "usuarios.wsb"),
		[
			"var contadorVisitas = 0",
			"",
			"export const WSON wsonUsuarios =",
			'\t-> to: "/usuarios/:id"',
			'\t-> via: "GET"',
			"",
			"export reactive any peticionUsuarios = WSON.listen(wsonUsuarios)",
			"",
			"watch(peticionUsuarios)",
			"\tcontadorVisitas = contadorVisitas + 1",
			"\tconst { id } = WSON.httpParams(peticionUsuarios)",
			"\tpeticionUsuarios.content = { id: id, visitas: contadorVisitas }",
			"\tWSON.httpSend(peticionUsuarios)",
		].join("\n")
	);
	fs.writeFileSync(
		path.join(dir, "api.wsb"),
		[
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
		].join("\n")
	);

	const server = createServer(parse(fs.readFileSync(path.join(dir, "api.wsb"), "utf8")), {}, { baseDir: dir });
	try {
		await new Promise((resolve) => server.listen(0, resolve));
		const port = server.address().port;

		const r1 = await getWithCookie(port, "/usuarios/1");
		assert.deepEqual(JSON.parse(r1.body), { id: "1", visitas: 1 });

		const wsession = extractCookie(r1.headers["set-cookie"], "wsession");
		const r2 = await getWithCookie(port, "/usuarios/2", `wsession=${wsession}`);
		assert.deepEqual(JSON.parse(r2.body), { id: "2", visitas: 2 }); // el contador viajó de verdad con la ruta
	} finally {
		server.close();
	}
});

test("import .wsb: colisión de nombre de estado entre el fichero importador y el origen de una ruta importada se detecta con un error claro", () => {
	const dir = tmpDir();
	fs.writeFileSync(
		path.join(dir, "usuarios.wsb"),
		[
			"var contadorVisitas = 0",
			"",
			"export const WSON wsonUsuarios =",
			'\t-> to: "/usuarios/:id"',
			'\t-> via: "GET"',
			"",
			"export reactive any peticionUsuarios = WSON.listen(wsonUsuarios)",
			"",
			"watch(peticionUsuarios)",
			"\tWSON.httpSend(peticionUsuarios)",
		].join("\n")
	);
	fs.writeFileSync(
		path.join(dir, "api.wsb"),
		[
			'import { peticionUsuarios } from "./usuarios.wsb"',
			"",
			"var contadorVisitas = 100", // mismo nombre que en usuarios.wsb -> colisión
			"",
			"const WSON wsonSalud =",
			'\t-> to: "/salud"',
			'\t-> via: "GET"',
			"",
			"reactive any peticionSalud = WSON.listen(wsonSalud)",
			"",
			"watch(peticionSalud)",
			"\tWSON.httpSend(peticionSalud)",
		].join("\n")
	);

	assert.throws(
		() => createServer(parse(fs.readFileSync(path.join(dir, "api.wsb"), "utf8")), {}, { baseDir: dir }),
		/[Cc]olisión de estado.*contadorVisitas/
	);
});

test("REGRESIÓN bug real: un var importado explícitamente por nombre de otro .wsb es estado de sesión REAL, no un valor estático fijo", async () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "valores.wsb"), ["export var contadorServidor = 300"].join("\n"));
	fs.writeFileSync(
		path.join(dir, "api.wsb"),
		[
			'import { contadorServidor } from "./valores.wsb"',
			"",
			"const WSON wsonAlgo =",
			'\t-> to: "/incrementar"',
			'\t-> via: "GET"',
			"",
			"reactive any peticion = WSON.listen(wsonAlgo)",
			"",
			"watch(peticion)",
			"\tcontadorServidor = contadorServidor + 1",
			"\tpeticion.content = { contador: contadorServidor }",
			"\tWSON.httpSend(peticion)",
		].join("\n")
	);

	const server = createServer(parse(fs.readFileSync(path.join(dir, "api.wsb"), "utf8")), {}, { baseDir: dir });
	try {
		await new Promise((resolve) => server.listen(0, resolve));
		const port = server.address().port;

		const r1 = await getWithCookie(port, "/incrementar");
		assert.deepEqual(JSON.parse(r1.body), { contador: 301 });

		const wsession = extractCookie(r1.headers["set-cookie"], "wsession");
		const r2 = await getWithCookie(port, "/incrementar", `wsession=${wsession}`);
		assert.deepEqual(JSON.parse(r2.body), { contador: 302 }); // persiste de verdad, no un valor fijo
	} finally {
		server.close();
	}
});

test("REGRESIÓN nueva capacidad: import de un paquete npm real (nombres) y un módulo nativo de Node (por defecto) funcionan en watch()", async () => {
	const source = [
		'import { parse } from "acorn"',
		'import path from "path"',
		"",
		"const WSON wsonAlgo =",
		'\t-> to: "/algo"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonAlgo)",
		"",
		"watch(peticion)",
		'\tconst ast = parse("1 + 1", { ecmaVersion: "latest" })',
		'\tpeticion.content = { tipo: ast.body[0].type, ext: path.extname("archivo.wsf") }',
		"\tWSON.httpSend(peticion)",
	].join("\n");

	const server = createServer(parse(source), {}, { baseDir: __dirname });
	try {
		await new Promise((resolve) => server.listen(0, resolve));
		const res = await get(server.address().port, "/algo");
		assert.deepEqual(JSON.parse(res.body), { tipo: "ExpressionStatement", ext: ".wsf" });
	} finally {
		server.close();
	}
});

test("REGRESIÓN nueva capacidad: import de un .js normal (CommonJS) funciona en watch(), como vía de adopción incremental", async () => {
	const dir = tmpDir();
	fs.writeFileSync(
		path.join(dir, "utilidades.js"),
		['function saludar(nombre) {', '\treturn "Hola, " + nombre + "!";', "}", "module.exports = { saludar };"].join("\n")
	);
	const source = [
		'import { saludar } from "./utilidades.js"',
		"",
		"const WSON wsonAlgo =",
		'\t-> to: "/algo"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonAlgo)",
		"",
		"watch(peticion)",
		'\tpeticion.content = { mensaje: saludar("Ana") }',
		"\tWSON.httpSend(peticion)",
	].join("\n");

	const server = createServer(parse(source), {}, { baseDir: dir });
	try {
		await new Promise((resolve) => server.listen(0, resolve));
		const res = await get(server.address().port, "/algo");
		assert.deepEqual(JSON.parse(res.body), { mensaje: "Hola, Ana!" });
	} finally {
		server.close();
	}
});

test("import de un paquete npm no instalado da un error claro, no una traza críptica", () => {
	assert.throws(
		() => createServer(parse('import { algo } from "paquete-que-no-existe"'), {}, { baseDir: __dirname }),
		/No se pudo resolver el paquete "paquete-que-no-existe"/
	);
});

test("REGRESIÓN nueva capacidad: un .wsb puede importar un .wsdb y hacer CRUD real, vía HTTP, con SQLite real detrás", async () => {
	const dir = tmpDir();
	fs.writeFileSync(
		path.join(dir, "usuarios.wsdb"),
		["-> name: 'usuario'", "-> schema:", "\t-> id: integer(10)(primary)/", "\t-> nombre: string(40)", "\t-> edad: integer(3)"].join("\n")
	);
	fs.writeFileSync(
		path.join(dir, "api.wsb"),
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
			"\tconst todos = Usuario.selectAll()",
			"\tpeticionListar.content = { usuarios: todos.map(u => ({ id: u.id, nombre: u.nombre, edad: u.edad })) }",
			"\tWSON.httpSend(peticionListar)",
		].join("\n")
	);

	const server = createServer(parse(fs.readFileSync(path.join(dir, "api.wsb"), "utf8")), {}, { baseDir: dir });
	try {
		await new Promise((resolve) => server.listen(0, resolve));
		const port = server.address().port;

		const r1 = await postJson(port, "/usuarios", { nombre: "Ana", edad: 30 });
		assert.deepEqual(JSON.parse(r1.body), { id: 1 });

		const r2 = await postJson(port, "/usuarios", { nombre: "Luis", edad: 25 });
		assert.deepEqual(JSON.parse(r2.body), { id: 2 });

		const r3 = await get(port, "/usuarios");
		assert.deepEqual(JSON.parse(r3.body), {
			usuarios: [
				{ id: 1, nombre: "Ana", edad: 30 },
				{ id: 2, nombre: "Luis", edad: 25 },
			],
		});
	} finally {
		server.close();
	}
});

test("REGRESIÓN (eliminación del formato antiguo): importar un .wsdb de \"-> collection:\" desde un .wsb da un error que nombra el import y cómo migrar", () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "viejo.wsdb"), ['-> collection: "viejos"', "-> schema:", "\tnombre: string"].join("\n"));
	assert.throws(
		() => createServer(parse('import { Viejo } from "./viejo.wsdb"'), {}, { baseDir: dir }),
		/"\.\/viejo\.wsdb": este \.wsdb usa el formato antiguo \("-> collection:"\), que ya no se admite/
	);
});

test("integración real: los datos de un .wsdb sobreviven a un reinicio completo del servidor (fichero .wsdb-data/webscript.db real)", async () => {
	const dir = tmpDir();
	fs.writeFileSync(
		path.join(dir, "usuarios.wsdb"),
		["-> name: 'usuario'", "-> schema:", "\t-> id: integer(10)(primary)/", "\t-> nombre: string(40)"].join("\n")
	);
	const wsbSource = [
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
		"\tUsuario.save({ nombre: datos.nombre })",
		"\tpeticionCrear.content = { ok: true }",
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
	].join("\n");
	fs.writeFileSync(path.join(dir, "api.wsb"), wsbSource);

	const server1 = createServer(parse(wsbSource), {}, { baseDir: dir });
	await new Promise((resolve) => server1.listen(0, resolve));
	const port1 = server1.address().port;
	await postJson(port1, "/usuarios", { nombre: "Ana" });
	server1.close();

	assert.ok(fs.existsSync(path.join(dir, ".wsdb-data", "webscript.db")));

	// Servidor NUEVO (mismo AST reconstruido, sin nada compartido en
	// memoria del anterior) — simula un reinicio real.
	const server2 = createServer(parse(wsbSource), {}, { baseDir: dir });
	try {
		await new Promise((resolve) => server2.listen(0, resolve));
		const port2 = server2.address().port;
		const res = await get(port2, "/usuarios");
		assert.deepEqual(JSON.parse(res.body), { usuarios: ["Ana"] });
	} finally {
		server2.close();
	}
});

function postJson(port, pathname, body) {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ hostname: "localhost", port, path: pathname, method: "POST", headers: { "Content-Type": "application/json" } },
			(res) => {
				let b = "";
				res.on("data", (c) => (b += c));
				res.on("end", () => resolve({ status: res.statusCode, body: b }));
			}
		);
		req.on("error", reject);
		req.end(JSON.stringify(body));
	});
}

test("wsdb v2 vía HTTP: import de Persona/PersonaSchema, save() como upsert y where()/sort dentro de un watch()", async () => {
	const dir = tmpDir();
	fs.writeFileSync(
		path.join(dir, "personas.wsdb"),
		[
			"-> name: 'persona'",
			"-> schema",
			"     -> idPerson: integer(10)(primary)",
			"     -> edad: integer(5)",
			"     -> nombre: string(40)/",
			"     -> mayor: boolean",
		].join("\n")
	);
	fs.writeFileSync(
		path.join(dir, "api.wsb"),
		[
			'import { Persona, PersonaSchema } from "./personas.wsdb"',
			"",
			"const WSON wsonGuardar =",
			'\t-> to: "/personas"',
			'\t-> via: "POST"',
			"",
			"reactive any peticionGuardar = WSON.listen(wsonGuardar)",
			"",
			"watch(peticionGuardar)",
			"\tvar Persona personaInsert = new Persona(WSON.showContent(peticionGuardar))",
			"\tpeticionGuardar.content = Persona.save(personaInsert)",
			"\tWSON.httpSend(peticionGuardar)",
			"",
			"const WSON wsonListar =",
			'\t-> to: "/personas"',
			'\t-> via: "GET"',
			"",
			"reactive any peticionListar = WSON.listen(wsonListar)",
			"",
			"watch(peticionListar)",
			"\tconst PersonaSchema personaSchema = PersonaSchema.getSchema()",
			"\tconst Persona[] personas = Persona.selectAll().where((personaSchema.edad > 10 && personaSchema.nombre != 'Juan') || personaSchema.mayor).sortAsc(personaSchema.nombre)",
			"\tif (personas.length > 0)",
			"\t\tpeticionListar.content = { ids: personas.map(p => p.idPerson) }",
			"\telse",
			"\t\tpeticionListar.content = { ids: Persona.select(personaSchema.idPerson).where(personaSchema.edad < 0) }",
			"\tWSON.httpSend(peticionListar)",
		].join("\n")
	);

	const server = createServer(parse(fs.readFileSync(path.join(dir, "api.wsb"), "utf8")), {}, { baseDir: dir });
	try {
		await new Promise((resolve) => server.listen(0, resolve));
		const port = server.address().port;

		const vacio = await get(port, "/personas");
		assert.deepEqual(JSON.parse(vacio.body), { ids: [] });

		await postJson(port, "/personas", { idPerson: 1, edad: 30, nombre: "Ana", mayor: true });
		await postJson(port, "/personas", { idPerson: 2, edad: 15, nombre: "Juan", mayor: false });
		await postJson(port, "/personas", { idPerson: 3, edad: 40, nombre: "Juan", mayor: true });
		await postJson(port, "/personas", { idPerson: 4, edad: 12, nombre: "Bea", mayor: false });
		const upd = await postJson(port, "/personas", { idPerson: 4, edad: 5, nombre: "Bea", mayor: false });
		assert.deepEqual(JSON.parse(upd.body), { idPerson: 4, edad: 5, nombre: "Bea", mayor: false });

		const lista = await get(port, "/personas");
		assert.deepEqual(JSON.parse(lista.body), { ids: [1, 3] });

		const malo = await postJson(port, "/personas", { idPerson: 9, edad: 1, nombre: "x".repeat(41), mayor: false });
		assert.equal(malo.status, 400);
		assert.match(malo.body, /máximo 40 caracteres/);
	} finally {
		server.close();
	}
});
