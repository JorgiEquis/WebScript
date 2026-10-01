const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { parse } = require("../parser");
const { createServer } = require("../codegen-server");

function get(port, pathname) {
	return new Promise((resolve, reject) => {
		http.get(`http://localhost:${port}${pathname}`, (r) => {
			let out = "";
			r.on("data", (c) => (out += c));
			r.on("end", () => resolve({ status: r.statusCode, body: out }));
		}).on("error", reject);
	});
}

async function withServer(source, fn) {
	const server = createServer(parse(source), {});
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

test("REGRESIÓN bug real: un for dentro de watch() ejecuta de verdad su cuerpo (antes se perdía en silencio, sin error)", async () => {
	const source = [
		"const WSON wsonSuma =",
		'\t-> to: "/suma"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonSuma)",
		"",
		"watch(peticion)",
		"\tconst numeros = [1, 2, 3, 4]",
		"\tvar total = 0",
		"\tfor (n of numeros)",
		"\t\ttotal = total + n",
		"\tpeticion.content = { total: total }",
		"\tWSON.httpSend(peticion)",
	].join("\n");

	await withServer(source, async (port) => {
		const res = await get(port, "/suma");
		assert.deepEqual(JSON.parse(res.body), { total: 10 });
	});
});

test("REGRESIÓN bug real: el estado de servidor SÍ se sustituye dentro del cuerpo de un for (el { del bloque no debe confundirse con el de un objeto literal)", async () => {
	const source = [
		"var acumulado = 0",
		"",
		"const WSON wsonSuma =",
		'\t-> to: "/suma"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonSuma)",
		"",
		"watch(peticion)",
		"\tconst numeros = [10, 20, 30]",
		"\tfor (n of numeros)",
		"\t\tacumulado = acumulado + n",
		"\tpeticion.content = { acumulado: acumulado }",
		"\tWSON.httpSend(peticion)",
	].join("\n");

	await withServer(source, async (port) => {
		const res = await get(port, "/suma");
		assert.deepEqual(JSON.parse(res.body), { acumulado: 60 });
	});
});

test("un if real anidado dentro de un for real dentro de watch() funciona correctamente", async () => {
	const source = [
		"const WSON wsonPares =",
		'\t-> to: "/pares"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonPares)",
		"",
		"watch(peticion)",
		"\tconst numeros = [1, 2, 3, 4, 5, 6]",
		"\tvar pares = []",
		"\tfor (n of numeros)",
		"\t\tif (n % 2 == 0)",
		"\t\t\tpares.push(n)",
		"\tpeticion.content = { pares: pares }",
		"\tWSON.httpSend(peticion)",
	].join("\n");

	await withServer(source, async (port) => {
		const res = await get(port, "/pares");
		assert.deepEqual(JSON.parse(res.body), { pares: [2, 4, 6] });
	});
});

test("un while real dentro de watch() ejecuta de verdad su cuerpo", async () => {
	const source = [
		"const WSON wsonCuenta =",
		'\t-> to: "/cuenta"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonCuenta)",
		"",
		"watch(peticion)",
		"\tvar i = 0",
		"\tvar resultado = 0",
		"\twhile (i < 5)",
		"\t\tresultado = resultado + i",
		"\t\ti = i + 1",
		"\tpeticion.content = { resultado: resultado }",
		"\tWSON.httpSend(peticion)",
	].join("\n");

	await withServer(source, async (port) => {
		const res = await get(port, "/cuenta");
		assert.deepEqual(JSON.parse(res.body), { resultado: 0 + 1 + 2 + 3 + 4 });
	});
});

test("tipado de servidor: una reasignación con tipo incorrecto se rechaza con 400, sin importar en qué línea de watch() ocurra", async () => {
	const source = [
		"var integer visitas = 0",
		"",
		"const WSON wsonVisita =",
		'\t-> to: "/visita"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonVisita)",
		"",
		"watch(peticion)",
		'\tvisitas = "no soy un entero"',
		"\tpeticion.content = { visitas: visitas }",
		"\tWSON.httpSend(peticion)",
	].join("\n");

	await withServer(source, async (port) => {
		const res = await get(port, "/visita");
		assert.equal(res.status, 400);
		assert.match(JSON.parse(res.body).error, /"visitas"/);
	});
});

test("tipado de servidor: se rechaza igual dentro de un for — no hace falta que el compilador sepa dónde ocurre la asignación", async () => {
	const source = [
		"var integer contador = 0",
		"",
		"const WSON wsonAlgo =",
		'\t-> to: "/algo"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonAlgo)",
		"",
		"watch(peticion)",
		'\tconst valores = [1, 2, "tres"]',
		"\tfor (v of valores)",
		"\t\tcontador = v",
		"\tpeticion.content = { contador: contador }",
		"\tWSON.httpSend(peticion)",
	].join("\n");

	await withServer(source, async (port) => {
		const res = await get(port, "/algo");
		assert.equal(res.status, 400);
		assert.match(JSON.parse(res.body).error, /"contador"/);
	});
});

test("tipado de servidor: una reasignación con tipo correcto (incluido ++) sigue funcionando con normalidad", async () => {
	const source = [
		"var integer visitas = 0",
		"",
		"const WSON wsonVisita =",
		'\t-> to: "/visita"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonVisita)",
		"",
		"watch(peticion)",
		"\tvisitas++",
		"\tpeticion.content = { visitas: visitas }",
		"\tWSON.httpSend(peticion)",
	].join("\n");

	await withServer(source, async (port) => {
		const res = await get(port, "/visita");
		assert.equal(res.status, 200);
		assert.deepEqual(JSON.parse(res.body), { visitas: 1 });
	});
});

test("tipado de servidor: sin tipo declarado, cualquier reasignación sigue coliendo (retrocompatible)", async () => {
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
		'\tcontador = "cualquier cosa"',
		"\tpeticion.content = { contador: contador }",
		"\tWSON.httpSend(peticion)",
	].join("\n");

	await withServer(source, async (port) => {
		const res = await get(port, "/algo");
		assert.equal(res.status, 200);
		assert.deepEqual(JSON.parse(res.body), { contador: "cualquier cosa" });
	});
});

test("substituteServerState no sustituye claves de objeto aunque estén justo después del { de un bloque en la línea anterior", async () => {
	// Caso concreto del bug: "for (...) {\nedad: ..." (una clave llamada
	// igual que la variable de servidor, justo tras el { de apertura de un
	// bloque) NO debe confundirse con el { de un objeto literal.
	const source = [
		"var edad = 0",
		"",
		"const WSON wsonAlgo =",
		'\t-> to: "/algo"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonAlgo)",
		"",
		"watch(peticion)",
		"\tedad = 30",
		"\tconst lista = [1]",
		"\tfor (x of lista)",
		"\t\tconst obj = { edad: 99 }",
		"\tpeticion.content = { edad: edad }",
		"\tWSON.httpSend(peticion)",
	].join("\n");

	await withServer(source, async (port) => {
		const res = await get(port, "/algo");
		// edad (estado de servidor) debe ser 30, no verse afectada por la
		// clave "edad" del objeto literal de dentro del for.
		assert.deepEqual(JSON.parse(res.body), { edad: 30 });
	});
});
