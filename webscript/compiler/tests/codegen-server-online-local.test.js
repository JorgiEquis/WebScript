const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { parse } = require("../parser");
const { createServer } = require("../codegen-server");
const { WSClient } = require("../wsclient-runtime");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-online-local-"));
}

function startServer(src, dir = "/tmp") {
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

test("REGRESIÓN: un watch() puede llamar a una online function del mismo .wsb como si fuera local (antes: error al compilar)", async () => {
	const src = [
		"online function calcularImpuesto(importe)",
		"\treturn { importe: importe, total: importe * 1.21 }",
		"",
		"const WSON w =",
		'\t-> to: "/local"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(w)",
		"",
		"watch(peticion)",
		"\tpeticion.content = calcularImpuesto(100)",
		"\tWSON.httpSend(peticion)",
	].join("\n");
	const server = await startServer(src);
	try {
		const r = await get(server.address().port, "/local");
		assert.deepEqual(JSON.parse(r.body), { importe: 100, total: 121 });
	} finally {
		server.close();
	}
});

test("REGRESIÓN: una function normal puede llamar a una online function del mismo .wsb (antes: ReferenceError en tiempo de ejecución)", async () => {
	const src = [
		"online function calcularImpuesto(importe)",
		"\treturn { importe: importe, total: importe * 1.21 }",
		"",
		"function usaOnlineLocal(x)",
		"\treturn calcularImpuesto(x)",
		"",
		"online function llamaALocal(x)",
		"\treturn usaOnlineLocal(x)",
	].join("\n");
	const server = await startServer(src);
	try {
		const client = new WSClient(`ws://localhost:${server.address().port}/`);
		// llamaALocal -> usaOnlineLocal (function normal) -> calcularImpuesto (otra online function): las tres direcciones a la vez
		assert.deepEqual(await client.llamar("llamaALocal", [10]), { importe: 10, total: 12.1 });
		client.close();
	} finally {
		server.close();
	}
});

test("una online function sigue funcionando por RPC exactamente igual, además de en local", async () => {
	const src = ["online function calcularImpuesto(importe) -> idempotent", "\treturn { importe: importe, total: importe * 1.21 }"].join("\n");
	const server = await startServer(src);
	try {
		const client = new WSClient(`ws://localhost:${server.address().port}/`);
		assert.deepEqual(await client.llamar("calcularImpuesto", [50]), { importe: 50, total: 60.5 });
		client.close();
	} finally {
		server.close();
	}
});

test("online function importada de un .ws también se puede llamar en local desde el .wsb que la importa", async () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "utils.ws"), ["export online function saludar(nombre)", '\treturn "hola, " + nombre'].join("\n"));
	const src = [
		'import { saludar } from "./utils.ws"',
		"",
		"const WSON w =",
		'\t-> to: "/local"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(w)",
		"",
		"watch(peticion)",
		'\tpeticion.content = { mensaje: saludar("Ana") }',
		"\tWSON.httpSend(peticion)",
	].join("\n");
	const server = await startServer(src, dir);
	try {
		const r = await get(server.address().port, "/local");
		assert.deepEqual(JSON.parse(r.body), { mensaje: "hola, Ana" });
	} finally {
		server.close();
	}
});
