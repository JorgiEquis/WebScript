const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { parse } = require("../parser");
const { createServer } = require("../codegen-server");
const { connect } = require("../websocket-runtime");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-function-scope-"));
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

const MATEMATICAS = [
	"export function duplicar(x)",
	"\treturn x * 2",
	"",
	"export function triplicarUsandoDuplicar(x)",
	"\treturn duplicar(x) + x",
	"",
	"export function usaImportadaEnIf(x)",
	"\tif (x > 0)",
	"\t\treturn duplicar(x)",
	"\telse",
	"\t\treturn 0",
	"",
	"export function usaImportadaEnFor(lista)",
	"\tvar resultado = []",
	"\tfor (item in lista)",
	"\t\tresultado.push(duplicar(item))",
	"\treturn resultado",
].join("\n");

test("REGRESIÓN: for (item in lista) como bucle imperativo ejecuta su cuerpo de verdad (antes: comentario muerto, sin error)", async () => {
	const dir = tmpDir();
	const src = [
		"const WSON w =",
		'\t-> to: "/probar"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(w)",
		"",
		"watch(peticion)",
		"\tvar resultado = []",
		"\tfor (item in [1, 2, 3])",
		"\t\tresultado.push(item * 2)",
		"\tpeticion.content = { resultado: resultado }",
		"\tWSON.httpSend(peticion)",
	].join("\n");
	const server = await startServer(src, dir);
	try {
		const r = await get(server.address().port, "/probar");
		assert.deepEqual(JSON.parse(r.body), { resultado: [2, 4, 6] });
	} finally {
		server.close();
	}
});

test("REGRESIÓN: una function puede llamar a otra del MISMO fichero .ws (antes: ReferenceError, cada una se compilaba aislada)", async () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "matematicas.ws"), MATEMATICAS);
	const src = [
		'import { triplicarUsandoDuplicar } from "./matematicas.ws"',
		"",
		"const WSON w =",
		'\t-> to: "/probar"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(w)",
		"",
		"watch(peticion)",
		"\tpeticion.content = { resultado: triplicarUsandoDuplicar(4) }",
		"\tWSON.httpSend(peticion)",
	].join("\n");
	const server = await startServer(src, dir);
	try {
		const r = await get(server.address().port, "/probar");
		assert.deepEqual(JSON.parse(r.body), { resultado: 12 }); // duplicar(4)+4 = 12
	} finally {
		server.close();
	}
});

test("REGRESIÓN: una function importada puede usar if/for llamando a una hermana de su mismo fichero", async () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "matematicas.ws"), MATEMATICAS);
	const src = [
		'import { usaImportadaEnIf, usaImportadaEnFor } from "./matematicas.ws"',
		"",
		"const WSON w =",
		'\t-> to: "/probar"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(w)",
		"",
		"watch(peticion)",
		"\tpeticion.content = { desdeIf: usaImportadaEnIf(5), desdeFor: usaImportadaEnFor([1, 2, 3]) }",
		"\tWSON.httpSend(peticion)",
	].join("\n");
	const server = await startServer(src, dir);
	try {
		const r = await get(server.address().port, "/probar");
		assert.deepEqual(JSON.parse(r.body), { desdeIf: 10, desdeFor: [2, 4, 6] });
	} finally {
		server.close();
	}
});

test("REGRESIÓN: una function declarada DIRECTAMENTE en el .wsb (sin online, sin import) ya no es invisible, y puede llamar a algo importado", async () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "matematicas.ws"), MATEMATICAS);
	const src = [
		'import { duplicar } from "./matematicas.ws"',
		"",
		"function localQueLlamaAImportada(x)",
		"\treturn duplicar(x) + 100",
		"",
		"const WSON w =",
		'\t-> to: "/probar"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(w)",
		"",
		"watch(peticion)",
		"\tpeticion.content = { resultado: localQueLlamaAImportada(1) }",
		"\tWSON.httpSend(peticion)",
	].join("\n");
	const server = await startServer(src, dir);
	try {
		const r = await get(server.address().port, "/probar");
		assert.deepEqual(JSON.parse(r.body), { resultado: 102 });
	} finally {
		server.close();
	}
});

test("online function puede llamar a otra online function, a una function normal del mismo .wsb, y a una importada — todo a la vez", async () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "matematicas.ws"), MATEMATICAS);
	const src = [
		'import { duplicar } from "./matematicas.ws"',
		"",
		"function ayudanteLocal(x)",
		"\treturn x + 1000",
		"",
		"online function otraOnline(x)",
		"\treturn x * 10",
		"",
		"online function principal(x)",
		"\treturn duplicar(x) + ayudanteLocal(x) + otraOnline(x)",
	].join("\n");
	const server = await startServer(src, dir);
	try {
		const port = server.address().port;
		const client = await connect(`ws://localhost:${port}/`);
		const respuesta = await new Promise((resolve) => {
			client.parser.on("message", (m) => resolve(JSON.parse(m.text)));
			client.send(JSON.stringify({ type: "call", id: "1", name: "principal", args: [5] }));
		});
		assert.deepEqual(respuesta, { id: "1", type: "result", value: 1065 }); // 10 + 1005 + 50
		client.socket.end();
	} finally {
		server.close();
	}
});

test("comportamiento documentado ante colisión de nombres: una function del propio .wsb con el mismo nombre que algo importado gana ella, sin lanzar ningún error", async () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "matematicas.ws"), MATEMATICAS);
	const src = [
		'import { duplicar } from "./matematicas.ws"',
		"",
		"function duplicar(x)",
		"\treturn x * 999",
		"",
		"const WSON w =",
		'\t-> to: "/probar"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(w)",
		"",
		"watch(peticion)",
		"\tpeticion.content = { resultado: duplicar(2) }",
		"\tWSON.httpSend(peticion)",
	].join("\n");
	const server = await startServer(src, dir);
	try {
		const r = await get(server.address().port, "/probar");
		// Object.assign(importBindings, ...) se aplica DESPUÉS de resolver
		// los imports — la declarada en el propio .wsb sobreescribe a la
		// importada del mismo nombre. Documentado aquí como comportamiento
		// real, no verificado como el diseño ideal para este caso límite.
		assert.deepEqual(JSON.parse(r.body), { resultado: 1998 });
	} finally {
		server.close();
	}
});
