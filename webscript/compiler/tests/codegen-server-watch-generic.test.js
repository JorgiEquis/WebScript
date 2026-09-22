const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { parse } = require("../parser");
const { createServer } = require("../codegen-server");

function tmpDir(prefix) {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

async function withServer(source, opts, fn) {
	const server = createServer(parse(source), {}, opts || {});
	try {
		await new Promise((resolve, reject) => {
			server.listen(0, resolve);
			server.on("error", reject);
		});
		await fn(server.address().port);
	} finally {
		server.close();
	}
}

test("watch() sobre una reactive boolean (sin WSON.listen) se dispara al reasignarla desde otro watch()", async () => {
	const source = [
		"reactive boolean activo = false",
		"var vecesActivado = 0",
		"",
		"watch(activo)",
		"\tvecesActivado = vecesActivado + 1",
		"",
		"const WSON wsonActivar =",
		'\t-> to: "/activar"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonActivar)",
		"",
		"watch(peticion)",
		"\tactivo = true",
		"\tpeticion.content = { activo: activo, vecesActivado: vecesActivado }",
		"\tWSON.send(peticion)",
	].join("\n");

	await withServer(source, null, async (port) => {
		const res = await get(port, "/activar");
		assert.deepEqual(JSON.parse(res.body), { activo: true, vecesActivado: 1 });
	});
});

test("watch() sobre reactive string, tipo(array) y un DTO real, todos en cascada desde un único watch() de ruta", async () => {
	const dir = tmpDir("websc-watch-tipos-");
	fs.writeFileSync(
		path.join(dir, "persona.wson"),
		['-> from: "app"', '-> to: "/personas"', '-> via: "POST"', "-> content:", "\tnombre: string", "\tedad: integer"].join("\n")
	);

	const source = [
		'import { Persona } from "./persona.wson"',
		"",
		'reactive string ultimoMensaje = ""',
		"reactive string(array) historial = []",
		"reactive any ultimaPersona = null",
		"",
		"watch(ultimoMensaje)",
		"\thistorial.push(ultimoMensaje)",
		"",
		"watch(ultimaPersona)",
		'\thistorial.push("persona: " + ultimaPersona.nombre)',
		"",
		"const WSON wsonAlgo =",
		'\t-> to: "/algo"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonAlgo)",
		"",
		"watch(peticion)",
		'\tultimoMensaje = "hola"',
		'\tultimaPersona = new Persona("Ana", 30)',
		"\tpeticion.content = { historial: historial }",
		"\tWSON.send(peticion)",
	].join("\n");

	await withServer(source, { baseDir: dir }, async (port) => {
		const res = await get(port, "/algo");
		assert.deepEqual(JSON.parse(res.body), { historial: ["hola", "persona: Ana"] });
	});
});

test("import .wsb: una reactive normal (sin WSON.listen) declarada en un fichero, con watch() declarado en OTRO que la importa", async () => {
	const dir = tmpDir("websc-watch-cruzado-");
	fs.writeFileSync(path.join(dir, "estado.wsb"), ["export reactive boolean activo = false"].join("\n"));
	fs.writeFileSync(
		path.join(dir, "api.wsb"),
		[
			'import { activo } from "./estado.wsb"',
			"",
			"var vecesActivado = 0",
			"",
			"watch(activo)",
			"\tvecesActivado = vecesActivado + 1",
			"",
			"const WSON wsonActivar =",
			'\t-> to: "/activar"',
			'\t-> via: "GET"',
			"",
			"reactive any peticion = WSON.listen(wsonActivar)",
			"",
			"watch(peticion)",
			"\tactivo = true",
			"\tpeticion.content = { activo: activo, vecesActivado: vecesActivado }",
			"\tWSON.send(peticion)",
		].join("\n")
	);

	await withServer(fs.readFileSync(path.join(dir, "api.wsb"), "utf8"), { baseDir: dir }, async (port) => {
		const res = await get(port, "/activar");
		assert.deepEqual(JSON.parse(res.body), { activo: true, vecesActivado: 1 });
	});
});

test("import .wsb: WSON.listen()+reactive en un fichero, watch() de esa misma reactive declarado en OTRO fichero que la importa", async () => {
	const dir = tmpDir("websc-watch-cruzado2-");
	fs.writeFileSync(
		path.join(dir, "origen.wsb"),
		[
			"export const WSON wsonAlgo =",
			'\t-> to: "/algo"',
			'\t-> via: "GET"',
			"",
			"export reactive any peticion = WSON.listen(wsonAlgo)",
		].join("\n")
	);
	fs.writeFileSync(
		path.join(dir, "consumidor.wsb"),
		[
			'import { peticion } from "./origen.wsb"',
			"",
			"watch(peticion)",
			"\tpeticion.content = { ok: true }",
			"\tWSON.send(peticion)",
		].join("\n")
	);

	await withServer(fs.readFileSync(path.join(dir, "consumidor.wsb"), "utf8"), { baseDir: dir }, async (port) => {
		const res = await get(port, "/algo");
		assert.equal(res.status, 200);
		assert.deepEqual(JSON.parse(res.body), { ok: true });
	});
});

test("dos watch() para la misma reactive (colisión) se detectan con un error claro", () => {
	const source = [
		"reactive boolean activo = false",
		"",
		"watch(activo)",
		'\tconsole.log("primero")',
		"",
		"watch(activo)",
		'\tconsole.log("segundo")',
		"",
		"const WSON wsonAlgo =",
		'\t-> to: "/algo"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonAlgo)",
		"",
		"watch(peticion)",
		"\tWSON.send(peticion)",
	].join("\n");

	assert.throws(() => createServer(parse(source), {}), /[Cc]olisión de watch\(\).*"activo"/);
});

test("REGRESIÓN (async/await implícito): un watch() en cascada que hace algo async SÍ se espera de verdad — no fire-and-forget, sin que el usuario escriba await", async () => {
	const externo = http.createServer((req, res) => {
		setTimeout(() => {
			res.writeHead(200);
			res.end("{}");
		}, 300);
	});
	await new Promise((resolve) => externo.listen(0, resolve));
	const puertoExterno = externo.address().port;

	const source = [
		"reactive boolean activo = false",
		"",
		"watch(activo)",
		`\tWSON.send({ to: "http://localhost:${puertoExterno}/", via: "POST", content: {} })`,
		"",
		"const WSON wsonAlgo =",
		'\t-> to: "/algo"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonAlgo)",
		"",
		"watch(peticion)",
		"\tactivo = true",
		"\tpeticion.content = { ok: true }",
		"\tWSON.send(peticion)",
	].join("\n");

	try {
		await withServer(source, null, async (port) => {
			const inicio = Date.now();
			const res = await get(port, "/algo");
			const duracion = Date.now() - inicio;
			assert.equal(res.status, 200);
			// Si de verdad esperó al watch(activo) (que a su vez espera al
			// servidor externo, 300ms), la petición completa no puede haber
			// tardado mucho menos que eso.
			assert.ok(duracion >= 280, `se esperaba >= ~300ms, tardó ${duracion}ms (parece que no esperó la cascada)`);
		});
	} finally {
		externo.close();
	}
});

test("REGRESIÓN (async/await implícito): WSON.send() se espera aunque NO sea la última sentencia del watch()", async () => {
	const externo = http.createServer((req, res) => {
		setTimeout(() => {
			res.writeHead(200);
			res.end("{}");
		}, 300);
	});
	await new Promise((resolve) => externo.listen(0, resolve));
	const puertoExterno = externo.address().port;

	// Importante: esto tiene que ser el watch() de una reactive NORMAL,
	// no el de una ruta — dentro de watch(peticion), "WSON" es el objeto
	// especial ligado a ESA petición entrante (siempre responde a ella,
	// sin mirar el "to"), no un WSON.send() real hacia otro destino.
	const source = [
		"reactive boolean activo = false",
		"var seVioTrasElSend = false",
		"",
		"watch(activo)",
		`\tWSON.send({ to: "http://localhost:${puertoExterno}/", via: "POST", content: {} })`, // NO es la última sentencia
		"\tseVioTrasElSend = true",
		"",
		"const WSON wsonAlgo =",
		'\t-> to: "/algo"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonAlgo)",
		"",
		"watch(peticion)",
		"\tactivo = true",
		"\tpeticion.content = { ok: true }",
		"\tWSON.send(peticion)",
	].join("\n");

	try {
		await withServer(source, null, async (port) => {
			const inicio = Date.now();
			const res = await get(port, "/algo");
			const duracion = Date.now() - inicio;
			assert.equal(res.status, 200);
			assert.ok(duracion >= 280, `se esperaba >= ~300ms, tardó ${duracion}ms (parece que no esperó el send())`);
		});
	} finally {
		externo.close();
	}
});

test("WSON.enqueue() sigue sin bloquear la petición — fire-and-forget A PROPÓSITO, por diseño, no un descuido", async () => {
	const source = [
		"const WSON wsonAlgo =",
		'\t-> to: "/algo"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonAlgo)",
		"",
		"watch(peticion)",
		'\tWSON.enqueue({ to: "http://localhost:9999/no-existe", via: "POST", content: {} })',
		"\tpeticion.content = { ok: true }",
		"\tWSON.send(peticion)",
	].join("\n");

	await withServer(source, null, async (port) => {
		const inicio = Date.now();
		const res = await get(port, "/algo");
		const duracion = Date.now() - inicio;
		assert.equal(res.status, 200);
		assert.ok(duracion < 200, `se esperaba una respuesta casi instantánea, tardó ${duracion}ms`);
	});
});

test("un typo real se sigue detectando en un watch() aunque su cuerpo contenga await inyectado (WSON.send/cascada)", async () => {
	const source = [
		"var contador = 0",
		"",
		"const WSON wsonAlgo =",
		'\t-> to: "/algo"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonAlgo)",
		"",
		"watch(peticion)",
		"\tcontadr = contadr + 1", // typo real
		"\tpeticion.content = { ok: true }",
		"\tWSON.send(peticion)",
	].join("\n");

	assert.throws(() => createServer(parse(source), {}), /"contadr"/);
});

test("un watch() en cascada que falla no tumba la petición original (se registra, no se propaga)", async () => {
	const source = [
		"reactive boolean activo = false",
		"",
		"watch(activo)",
		"\tconst valorNulo = null",
		"\tconst x = valorNulo.algo",
		"",
		"const WSON wsonAlgo =",
		'\t-> to: "/algo"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonAlgo)",
		"",
		"watch(peticion)",
		"\tactivo = true",
		"\tpeticion.content = { ok: true }",
		"\tWSON.send(peticion)",
	].join("\n");

	await withServer(source, null, async (port) => {
		const res = await get(port, "/algo");
		assert.equal(res.status, 200);
		assert.deepEqual(JSON.parse(res.body), { ok: true });
	});
});
