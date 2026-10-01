// Un watch() que reasigna la MISMA reactive que observa podía reventar la
// pila — `RangeError: Maximum call stack size exceeded` — reproducido con
// código real antes de corregirlo: `watch(contador) { contador = contador }`
// (una corrección/normalización que, aplicada dos veces, da lo mismo) ya
// bastaba para tumbarlo. Dos guardas, en `__trigger` (por sesión) y
// `__triggerGlobal` (global):
// 1. Si el valor no cambió de verdad respecto al último disparo atendido,
//    no se llama al watch() — mismo criterio que ya usa cualquier motor
//    reactivo (React, Vue) para esto mismo.
// 2. Un límite de profundidad en cascada, como red de seguridad para el
//    caso que la guarda 1 no cubre — un valor que cambia de verdad en cada
//    disparo, sin converger nunca.
//
// IMPORTANTE sobre cómo se comprueba: la petición HTTP que dispara la
// cascada responde bien SIEMPRE, con o sin el arreglo — el `RangeError`
// ocurre en la continuación asíncrona del propio `watch()`, después de que
// la respuesta ya se envió, así que el código de estado NUNCA lo detecta
// (confirmado: con el código ANTERIOR, los 5 tests de este fichero pasaban
// igual mirando solo el código de estado — un test inútil, que no habría
// detectado el bug real). Por eso aquí se captura `console.error` durante
// la petición y se comprueba su CONTENIDO, no solo que la petición responda.
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

// Captura lo que `console.error` reciba DURANTE `fn`, incluida cualquier
// continuación asíncrona que siga corriendo un rato después de que `fn`
// resuelva (el propio caso que nos ocupa: la cascada de watch() sigue tras
// haberse respondido la petición) — por eso espera un margen extra al
// final, no solo lo que `fn` tarde.
async function capturarConsoleError(fn) {
	const mensajes = [];
	const original = console.error;
	console.error = (...args) => mensajes.push(args.map(String).join(" "));
	try {
		await fn();
		await new Promise((r) => setTimeout(r, 200));
	} finally {
		console.error = original;
	}
	return mensajes;
}

async function withServer(source, fn) {
	const server = createServer(parse(source), {}, {});
	try {
		await new Promise((resolve, reject) => {
			server.listen(0, resolve);
			server.on("error", reject);
		});
		return await capturarConsoleError(() => fn(server.address().port));
	} finally {
		server.close();
	}
}

const RUTA = ["const WSON wsonSubir =", '\t-> to: "/subir"', '\t-> via: "GET"', "", "reactive any peticionSubir = WSON.listen(wsonSubir)"].join("\n");

test("REGRESIÓN (el caso real reportado): watch() GLOBAL que se reasigna a sí mismo con el MISMO valor no revienta la pila", async () => {
	const source = [
		"global reactive contador = 0",
		"",
		"watch(contador)",
		"\tcontador = contador",
		"",
		RUTA,
		"watch(peticionSubir)",
		"\tcontador = 1",
		"\tWSON.httpSend(peticionSubir, 200)",
	].join("\n");
	const mensajes = await withServer(source, async (port) => {
		const r = await get(port, "/subir");
		assert.equal(r.status, 200);
	});
	assert.deepEqual(mensajes, [], "antes: 'Error en watch(\"contador\") [global]: Maximum call stack size exceeded'");
});

test("REGRESIÓN: lo mismo para una reactive de SESIÓN (no global)", async () => {
	const source = [
		"reactive contador = 0",
		"",
		"watch(contador)",
		"\tcontador = contador",
		"",
		RUTA,
		"watch(peticionSubir)",
		"\tcontador = 1",
		"\tWSON.httpSend(peticionSubir, 200)",
	].join("\n");
	const mensajes = await withServer(source, async (port) => {
		const r = await get(port, "/subir");
		assert.equal(r.status, 200);
	});
	assert.deepEqual(mensajes, [], "antes: 'Error en watch(\"contador\"): Maximum call stack size exceeded'");
});

test("REGRESIÓN (red de seguridad, caso que la guarda 1 NO cubre): un watch() GLOBAL que cambia el valor sin parar (nunca converge) avisa con un mensaje claro, no con 'Maximum call stack'", async () => {
	const source = [
		"global reactive contador = 0",
		"",
		"watch(contador)",
		"\tcontador = contador + 1",
		"",
		RUTA,
		"watch(peticionSubir)",
		"\tcontador = 1",
		"\tWSON.httpSend(peticionSubir, 200)",
	].join("\n");
	const mensajes = await withServer(source, async (port) => {
		const r = await get(port, "/subir");
		assert.equal(r.status, 200, "la petición que arrancó la cascada sigue respondiendo con normalidad, aunque el watch() no converja");
	});
	assert.equal(mensajes.length, 1);
	assert.match(mensajes[0], /posible bucle.*50 disparos en cascada sin converger/);
	assert.doesNotMatch(mensajes[0], /Maximum call stack/, "antes: reventaba la pila en vez de avisar con un mensaje claro");
});

test("NO REGRESIÓN: un watch() que corrige el valor UNA VEZ, hacia uno distinto (patrón de recorte/clamp), sigue funcionando — no se bloquea sin necesidad", async () => {
	const source = [
		"global reactive contador = 0",
		"",
		"watch(contador)",
		"\tif (contador > 10)",
		"\t\tcontador = 10",
		"",
		"const WSON wsonSubir =",
		'\t-> to: "/subir"',
		'\t-> via: "GET"',
		"",
		"reactive any peticionSubir = WSON.listen(wsonSubir)",
		"",
		"watch(peticionSubir)",
		"\tcontador = 15",
		"\tpeticionSubir.content = { contador: contador }",
		"\tWSON.httpSend(peticionSubir)",
	].join("\n");
	const mensajes = await withServer(source, async (port) => {
		const r = await get(port, "/subir");
		assert.equal(r.status, 200);
		assert.deepEqual(JSON.parse(r.body), { contador: 10 }, "'async/await implícito': el watch() ya corrió y corrigió ANTES de esta línea, por eso el cuerpo ve 10, no 15");
	});
	assert.deepEqual(mensajes, [], "la corrección (15 -> 10) debe disparase UNA vez y parar ahí, sin avisos de bucle");
});

test("NO REGRESIÓN: un watch() normal (sin reasignarse a sí mismo) sigue disparándose con normalidad", async () => {
	const source = [
		"reactive boolean activo = false",
		"var vecesActivado = 0",
		"",
		"watch(activo)",
		"\tvecesActivado = vecesActivado + 1",
		"",
		RUTA,
		"watch(peticionSubir)",
		"\tactivo = true",
		"\tpeticionSubir.content = { vecesActivado: vecesActivado }",
		"\tWSON.httpSend(peticionSubir)",
	].join("\n");
	const mensajes = await withServer(source, async (port) => {
		const r = await get(port, "/subir");
		assert.equal(r.status, 200);
		assert.deepEqual(JSON.parse(r.body), { vecesActivado: 1 }, "'async/await implícito': el watch(activo) ya corrió ANTES de esta línea, por eso el cuerpo ve 1, no 0");
	});
	assert.deepEqual(mensajes, []);
});
