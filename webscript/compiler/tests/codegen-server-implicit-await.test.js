const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { parse } = require("../parser");
const { createServer, injectAwaitForKnownCalls } = require("../codegen-server");
const { WSClient } = require("../wsclient-runtime");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-implicit-await-"));
}

function startServer(src, dir) {
	const server = createServer(parse(src), {}, { baseDir: dir });
	return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

function get(port, pathname) {
	return new Promise((resolve, reject) => {
		http
			.get(`http://localhost:${port}${pathname}`, (res) => {
				let body = "";
				res.on("data", (c) => (body += c));
				res.on("end", () => resolve({ status: res.statusCode, body }));
			})
			.on("error", reject);
	});
}

// --- Unitario: injectAwaitForKnownCalls -----------------------------------

test("injectAwaitForKnownCalls: envuelve una llamada suelta a un nombre conocido, no una llamada a método", () => {
	const out = injectAwaitForKnownCalls('x = foo(1); y = objeto.foo(2); z = noConocida(3);', new Set(["foo"]));
	assert.equal(out, 'x = await foo(1); y = objeto.foo(2); z = noConocida(3);');
});

test("injectAwaitForKnownCalls: no envuelve dos veces una llamada ya awaited", () => {
	const out = injectAwaitForKnownCalls("x = await foo(1);", new Set(["foo"]));
	assert.equal(out, "x = await foo(1);");
});

test("injectAwaitForKnownCalls: envuelve llamadas anidadas, ambas conocidas", () => {
	const out = injectAwaitForKnownCalls("x = foo(bar(1));", new Set(["foo", "bar"]));
	assert.equal(out, "x = await foo(await bar(1));");
});

// --- De extremo a extremo: function/online function esperan solas --------

test("REGRESIÓN: online function espera sola el resultado de llamar a otra online function, sin escribir await", async () => {
	const dir = tmpDir();
	const src = [
		"online function lenta(x)",
		"\treturn new Promise(function (resolve) { setTimeout(function () { resolve(x * 2); }, 30); })",
		"",
		"online function usaLenta(x)",
		"\tconst resultado = lenta(x)", // sin await
		"\treturn { resultado: resultado }",
	].join("\n");
	const server = await startServer(src, dir);
	try {
		const port = server.address().port;
		const client = new WSClient(`ws://localhost:${port}/`);
		const respuesta = await client.llamar("usaLenta", [5]);
		assert.deepEqual(respuesta, { resultado: 10 }, "si no se hubiera esperado sola, 'resultado' sería una Promise pendiente, no 10");
		client.close();
	} finally {
		server.close();
	}
});

test("REGRESIÓN: una function normal espera sola el resultado de llamar a otra function que devuelve una promesa", async () => {
	const dir = tmpDir();
	fs.writeFileSync(
		path.join(dir, "utils.ws"),
		["export function lenta(x)", "\treturn new Promise(function (resolve) { setTimeout(function () { resolve(x + 1); }, 30); })"].join("\n")
	);
	const src = [
		'import { lenta } from "./utils.ws"',
		"",
		"function usaLenta(x)",
		"\tconst resultado = lenta(x)", // sin await
		"\treturn resultado",
		"",
		"const WSON w =",
		'\t-> to: "/probar"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(w)",
		"",
		"watch(peticion)",
		"\tpeticion.content = { resultado: usaLenta(5) }", // sin await tampoco aquí
		"\tWSON.httpSend(peticion)",
	].join("\n");
	const server = await startServer(src, dir);
	try {
		const r = await get(server.address().port, "/probar");
		assert.deepEqual(JSON.parse(r.body), { resultado: 6 });
	} finally {
		server.close();
	}
});

test("de extremo a extremo real: un watch() llama a una online function de OTRO servidor (vía WSClient) sin escribir await, y espera el resultado real", async () => {
	const dirRemoto = tmpDir();
	const remoto = await startServer("online function cobrar(monto) -> idempotent\n\treturn { importe: monto, total: monto * 1.21 }", dirRemoto);
	try {
		const puertoRemoto = remoto.address().port;
		const dirConsumidor = tmpDir();
		fs.writeFileSync(
			path.join(dirConsumidor, "OtroServidor.ws"),
			`export function cobrar(monto, opts)\n\treturn WSClient.create("ws://localhost:${puertoRemoto}/").llamar("cobrar", [monto], opts)\n`
		);
		const consumidorSrc = [
			'import { cobrar } from "./OtroServidor.ws"',
			"",
			"const WSON w =",
			'\t-> to: "/probar"',
			'\t-> via: "GET"',
			"",
			"reactive any peticion = WSON.listen(w)",
			"",
			"watch(peticion)",
			'\tpeticion.content = cobrar(100, { idempotencyKey: "factura-1" })', // SIN await
			"\tWSON.httpSend(peticion)",
		].join("\n");
		const consumidor = await startServer(consumidorSrc, dirConsumidor);
		try {
			const r = await get(consumidor.address().port, "/probar");
			assert.deepEqual(JSON.parse(r.body), { importe: 100, total: 121 });
		} finally {
			consumidor.close();
			WSClient.closeAll();
		}
	} finally {
		remoto.close();
	}
});
