// Las `function`/`online function` importadas de un `.ws` aparte reciben
// EXACTAMENTE la misma regla que las declaradas directamente en el `.wsb`:
// acceso a `global reactive/var/const` (resuelto contra el .wsb que las
// importa), disparo del watch() de una global que reasignen, y un error
// claro al compilar si tocan una reactive/var de SESIÓN. Antes de esto no
// tenían ni lo uno ni lo otro: `ReferenceError` en tiempo de ejecución al
// tocar una global, y ningún error al tocar una de sesión (se compilaban
// dentro de resolveImports, antes de conocer el estado del .wsb).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { parse } = require("../parser");
const { createServer, resolveImports } = require("../codegen-server");
const { WSClient } = require("../wsclient-runtime");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-ws-global-"));
}

function writeFiles(dir, files) {
	for (const [name, lines] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), lines.join("\n"));
}

function startServer(src, dir) {
	const server = createServer(parse(src), {}, { baseDir: dir });
	return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

function get(port, pathname) {
	return new Promise((resolve, reject) => {
		http.get(`http://localhost:${port}${pathname}`, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve(JSON.parse(body)));
		}).on("error", reject);
	});
}

const LOGICA_WS = [
	"export online function incrementar()",
	"\tvisitasTotales = visitasTotales + 1",
	"\treturn visitasTotales",
];

test("REGRESIÓN: una online function importada de un .ws ve la global reactive del .wsb que la importa, y persiste entre llamadas RPC", async () => {
	const dir = tmpDir();
	writeFiles(dir, { "logica.ws": LOGICA_WS });
	const server = await startServer(['import { incrementar } from "./logica.ws"', "", "global reactive integer visitasTotales = 0"].join("\n"), dir);
	const client = new WSClient(`ws://localhost:${server.address().port}/`);
	try {
		assert.equal(await client.llamar("incrementar", []), 1, "antes: ReferenceError (visitasTotales is not defined)");
		assert.equal(await client.llamar("incrementar", []), 2);
		assert.equal(await client.llamar("incrementar", []), 3);
	} finally {
		client.close();
		server.close();
	}
});

test("REGRESIÓN: una function importada de un .ws que toca una reactive de SESIÓN da un error claro al compilar, que dice de qué fichero viene", () => {
	const dir = tmpDir();
	writeFiles(dir, { "logica.ws": ["export function sumar()", "\tmisVisitas = misVisitas + 1", "\treturn misVisitas"] });
	const src = ['import { sumar } from "./logica.ws"', "", "reactive integer misVisitas = 0"].join("\n");
	assert.throws(
		() => createServer(parse(src), {}, { baseDir: dir }),
		/function sumar \(importada de "\.\/logica\.ws"\): "misVisitas" es una reactive\/var POR SESIÓN/
	);
});

test("la protección alcanza también a un helper NO exportado del .ws (se compila en el mismo lote que la importada, y esta puede llamarlo)", () => {
	const dir = tmpDir();
	writeFiles(dir, {
		"logica.ws": ["function helperInterno()", "\treturn carrito.length", "", "export function total()", "\treturn helperInterno()"],
	});
	const src = ['import { total } from "./logica.ws"', "", "reactive array carrito = []"].join("\n");
	assert.throws(() => createServer(parse(src), {}, { baseDir: dir }), /function helperInterno \(importada de "\.\/logica\.ws"\): "carrito"/);
});

test("un helper NO exportado del .ws también ve la global, llamado desde una online function exportada", async () => {
	const dir = tmpDir();
	writeFiles(dir, {
		"logica.ws": ["function doble()", "\treturn base * 2", "", "export online function leerDoble()", "\treturn doble()"],
	});
	const server = await startServer(['import { leerDoble } from "./logica.ws"', "", "global var base = 21"].join("\n"), dir);
	const client = new WSClient(`ws://localhost:${server.address().port}/`);
	try {
		assert.equal(await client.llamar("leerDoble", []), 42);
	} finally {
		client.close();
		server.close();
	}
});

test("el watch() de una global reactive se dispara cuando la reasigna una online function importada de un .ws", async () => {
	const dir = tmpDir();
	writeFiles(dir, { "logica.ws": LOGICA_WS });
	const server = await startServer(
		[
			'import { incrementar } from "./logica.ws"',
			"",
			"global reactive integer visitasTotales = 0",
			"global var integer vecesDisparado = 0",
			"",
			"watch(visitasTotales)",
			"\tvecesDisparado = vecesDisparado + 1",
			"",
			"online function leerDisparos()",
			"\treturn vecesDisparado",
		].join("\n"),
		dir
	);
	const client = new WSClient(`ws://localhost:${server.address().port}/`);
	try {
		await client.llamar("incrementar", []);
		await client.llamar("incrementar", []);
		await client.llamar("incrementar", []);
		assert.equal(await client.llamar("leerDisparos", []), 3);
	} finally {
		client.close();
		server.close();
	}
});

test("REGRESIÓN: la MISMA instancia de una online function importada sirve la llamada local y la RPC — ambas ven la misma global", async () => {
	// Antes, extractOnlineFunctions recompilaba el .ws por su cuenta: la
	// llamada en local y la llamada RPC iban a dos instancias distintas.
	const dir = tmpDir();
	writeFiles(dir, { "logica.ws": LOGICA_WS });
	const server = await startServer(
		[
			'import { incrementar } from "./logica.ws"',
			"",
			"global reactive integer visitasTotales = 0",
			"",
			"online function incrementarEnLocal()",
			"\treturn incrementar()",
		].join("\n"),
		dir
	);
	const client = new WSClient(`ws://localhost:${server.address().port}/`);
	try {
		assert.equal(await client.llamar("incrementar", []), 1);
		assert.equal(await client.llamar("incrementarEnLocal", []), 2);
		assert.equal(await client.llamar("incrementar", []), 3);
	} finally {
		client.close();
		server.close();
	}
});

test("un watch() de sesión (ruta HTTP) llama a una function importada que escribe en una global — el total es compartido, no por visitante", async () => {
	const dir = tmpDir();
	writeFiles(dir, { "logica.ws": LOGICA_WS });
	const server = await startServer(
		[
			'import { incrementar } from "./logica.ws"',
			"",
			"global reactive integer visitasTotales = 0",
			"",
			"const WSON w =",
			'\t-> to: "/visitar"',
			'\t-> via: "GET"',
			"",
			"reactive any peticion = WSON.listen(w)",
			"",
			"watch(peticion)",
			"\tpeticion.content = { total: incrementar() }",
			"\tWSON.httpSend(peticion)",
		].join("\n"),
		dir
	);
	try {
		const port = server.address().port;
		assert.deepEqual(await get(port, "/visitar"), { total: 1 });
		assert.deepEqual(await get(port, "/visitar"), { total: 2 }, "sin cookie = otra sesión, pero la global es la misma");
	} finally {
		server.close();
	}
});

test("el mismo .ws importado por dos .wsb distintos: cada servidor resuelve la global contra SU propio estado", async () => {
	const dir = tmpDir();
	writeFiles(dir, { "logica.ws": LOGICA_WS });
	const imp = 'import { incrementar } from "./logica.ws"';
	const servidorA = await startServer([imp, "", "global reactive integer visitasTotales = 0"].join("\n"), dir);
	const servidorB = await startServer([imp, "", "global reactive integer visitasTotales = 100"].join("\n"), dir);
	const clienteA = new WSClient(`ws://localhost:${servidorA.address().port}/`);
	const clienteB = new WSClient(`ws://localhost:${servidorB.address().port}/`);
	try {
		assert.equal(await clienteA.llamar("incrementar", []), 1);
		assert.equal(await clienteB.llamar("incrementar", []), 101);
		assert.equal(await clienteA.llamar("incrementar", []), 2);
	} finally {
		clienteA.close();
		clienteB.close();
		servidorA.close();
		servidorB.close();
	}
});

test("un .ws importado desde dos líneas de import distintas se compila una sola vez, y sus function siguen llamándose entre sí", async () => {
	const dir = tmpDir();
	writeFiles(dir, {
		"logica.ws": ["export function base()", "\treturn contador", "", "export online function siguiente()", "\tcontador = base() + 1", "\treturn contador"],
	});
	const server = await startServer(
		['import { base } from "./logica.ws"', 'import { siguiente } from "./logica.ws"', "", "global var integer contador = 10", "", "online function leerBase()", "\treturn base()"].join("\n"),
		dir
	);
	const client = new WSClient(`ws://localhost:${server.address().port}/`);
	try {
		assert.equal(await client.llamar("siguiente", []), 11);
		assert.equal(await client.llamar("leerBase", []), 11);
	} finally {
		client.close();
		server.close();
	}
});

test("anidado: un .ws importado por un .wsb cuya RUTA importa otro .wsb también recibe acceso a la global", async () => {
	const dir = tmpDir();
	writeFiles(dir, {
		"logica.ws": ["export function sumarTotal()", "\ttotal = total + 1", "\treturn total"],
		"contador.wsb": [
			'import { sumarTotal } from "./logica.ws"',
			"",
			"global reactive integer total = 0",
			"",
			"export const WSON wsonContar =",
			'\t-> to: "/contar"',
			'\t-> via: "GET"',
			"",
			"export reactive any peticionContar = WSON.listen(wsonContar)",
			"",
			"watch(peticionContar)",
			"\tpeticionContar.content = { total: sumarTotal() }",
			"\tWSON.httpSend(peticionContar)",
		],
	});
	const server = await startServer('import { peticionContar } from "./contador.wsb"', dir);
	try {
		const port = server.address().port;
		assert.deepEqual(await get(port, "/contar"), { total: 1 });
		assert.deepEqual(await get(port, "/contar"), { total: 2 });
	} finally {
		server.close();
	}
});

test("compatibilidad: resolveImports llamado directamente (sin aplazar) sigue devolviendo las function del .ws ya compiladas", async () => {
	const dir = tmpDir();
	writeFiles(dir, { "util.ws": ["export function doble(x)", "\treturn x * 2"] });
	const { bindings, deferredWs } = resolveImports(parse('import { doble } from "./util.ws"'), dir);
	assert.equal(typeof bindings.doble, "function");
	assert.equal(await bindings.doble(4), 8);
	assert.deepEqual(deferredWs, []);
});
