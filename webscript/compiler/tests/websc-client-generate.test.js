const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { execFileSync, spawn } = require("child_process");
const { parse } = require("../parser");
const { createServer } = require("../codegen-server");
const { WSClient } = require("../wsclient-runtime");

const WEBSC_BIN = path.join(__dirname, "../bin/websc.js");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-client-generate-"));
}

function startServer(src, dir) {
	const server = createServer(parse(src), {}, { baseDir: dir });
	return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

// `execFileSync` (usado por los tests de `websc client-generate`, que es un
// comando de CLI) BLOQUEA POR COMPLETO el proceso que lo llama mientras el
// hijo corre — es su propia naturaleza síncrona, no un fallo del propio
// `client-generate`. Si el servidor remoto viviera en ESTE MISMO proceso de
// test (como con `startServer()`, `createServer()` normal), quedaría
// congelado sin poder aceptar la conexión del hijo en cuanto se llamara a
// `execFileSync` — el propio test se bloquearía a sí mismo. Por eso, para
// los tests que invocan `websc client-generate`, el servidor remoto se
// lanza como un PROCESO DE VERDAD, aparte — el mismo patrón que ya
// funcionó al verificar esto a mano, fuera de los tests.
function startRemoteServerProcess(src, dir) {
	fs.writeFileSync(path.join(dir, "__remote.wsb"), src);
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				"-e",
				`
				const { parse } = require(${JSON.stringify(path.join(__dirname, "../parser"))});
				const { createServer } = require(${JSON.stringify(path.join(__dirname, "../codegen-server"))});
				const fs = require("fs");
				const server = createServer(parse(fs.readFileSync(${JSON.stringify(path.join(dir, "__remote.wsb"))}, "utf8")), {}, { baseDir: ${JSON.stringify(dir)} });
				server.listen(0, () => console.log("PUERTO:" + server.address().port));
				`,
			],
			{ stdio: ["ignore", "pipe", "pipe"] }
		);
		child.unref(); // que este hijo no le impida terminar al proceso de test, aunque tarde un poco en morir del todo tras kill()
		let out = "";
		child.stdout.on("data", (d) => {
			out += d;
			const m = out.match(/PUERTO:(\d+)/);
			if (m) resolve({ port: Number(m[1]), stop: () => child.kill("SIGKILL") });
		});
		child.stderr.on("data", (d) => process.stderr.write(`[remoto] ${d}`));
		child.on("error", reject);
	});
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

test("websc client-generate: conecta de verdad, refleja las online function, y escribe un .ws que funciona", async () => {
	const dir = tmpDir();
	const remoto = await startRemoteServerProcess(
		["online function calcularImpuesto(importe) -> idempotent", "\treturn { importe: importe, total: importe * 1.21 }", "", "online function saludo(nombre)", '\treturn "hola, " + nombre'].join("\n"),
		dir
	);
	try {
		const outPath = path.join(dir, "OtroServidor.ws");
		const salida = execFileSync("node", [WEBSC_BIN, "client-generate", `ws://localhost:${remoto.port}/`, "--out", outPath], { encoding: "utf8" });
		assert.match(salida, /calcularImpuesto, saludo/);

		const contenido = fs.readFileSync(outPath, "utf8");
		assert.match(contenido, /export function calcularImpuesto\(importe, opts\)/);
		assert.match(contenido, /export function saludo\(nombre, opts\)/);
		assert.match(contenido, /idempotencyKey.*seguro/, "deja constancia de que calcularImpuesto es idempotent");
		assert.match(contenido, /WSClient\.create\("ws:\/\/localhost:\d+\/"\)\.llamar\("calcularImpuesto"/);

		// El fichero generado, usado de verdad desde un TERCER proceso — el
		// consumidor SÍ puede vivir en este mismo proceso de test, porque a
		// partir de aquí ya no se llama a ningún execFileSync más.
		const consumidorDir = tmpDir();
		fs.copyFileSync(outPath, path.join(consumidorDir, "OtroServidor.ws"));
		const consumidorSrc = [
			'import { calcularImpuesto, saludo } from "./OtroServidor.ws"',
			"",
			"const WSON w =",
			'\t-> to: "/probar"',
			'\t-> via: "GET"',
			"",
			"reactive any peticion = WSON.listen(w)",
			"",
			"watch(peticion)",
			'\tconst impuesto = await calcularImpuesto(100, { idempotencyKey: "factura-1" })',
			'\tconst mensaje = await saludo("Ana")',
			"\tpeticion.content = { impuesto: impuesto, mensaje: mensaje }",
			"\tWSON.httpSend(peticion)",
		].join("\n");
		const consumidor = await startServer(consumidorSrc, consumidorDir);
		try {
			const r = await get(consumidor.address().port, "/probar");
			assert.deepEqual(JSON.parse(r.body), { impuesto: { importe: 100, total: 121 }, mensaje: "hola, Ana" });
		} finally {
			consumidor.close();
			// Las funciones generadas llaman a WSClient.create(), que
			// memoriza la conexión para siempre en el pool del proceso —
			// correcto en un servidor real, pero hay que cerrarla a mano
			// aquí para que el proceso de test no se quede con el socket
			// abierto de fondo.
			WSClient.closeAll();
		}
	} finally {
		remoto.stop();
	}
});

test("websc client-generate: reescribe el fichero ENTERO — una función que desaparece del servidor remoto desaparece también al regenerar", async () => {
	const dir = tmpDir();
	const outPath = path.join(dir, "OtroServidor.ws");

	const remotoV1 = await startRemoteServerProcess("online function a()\n\treturn 1\n\nonline function b()\n\treturn 2", dir);
	try {
		execFileSync("node", [WEBSC_BIN, "client-generate", `ws://localhost:${remotoV1.port}/`, "--out", outPath]);
	} finally {
		remotoV1.stop();
	}
	assert.match(fs.readFileSync(outPath, "utf8"), /export function a\(/);
	assert.match(fs.readFileSync(outPath, "utf8"), /export function b\(/);

	// El servidor "cambia" (uno nuevo, sin "b") y se regenera contra él.
	const remotoV2 = await startRemoteServerProcess("online function a()\n\treturn 1", dir);
	try {
		execFileSync("node", [WEBSC_BIN, "client-generate", `ws://localhost:${remotoV2.port}/`, "--out", outPath]);
		const contenido = fs.readFileSync(outPath, "utf8");
		assert.match(contenido, /export function a\(/);
		assert.doesNotMatch(contenido, /export function b\(/, "b ya no existe en el servidor remoto — no debe quedar huérfana en el fichero regenerado");
	} finally {
		remotoV2.stop();
	}
});

test("websc client-generate: errores claros — sin --out, URL no válida, servidor sin online function", async () => {
	const dir = tmpDir();
	assert.throws(() => execFileSync("node", [WEBSC_BIN, "client-generate", "ws://localhost:1/"], { encoding: "utf8", stdio: "pipe" }), /falta "--out"/);
	assert.throws(
		() => execFileSync("node", [WEBSC_BIN, "client-generate", "http://localhost:1/", "--out", path.join(dir, "x.ws")], { encoding: "utf8", stdio: "pipe" }),
		/no es una URL de WebSocket/
	);

	const remoto = await startRemoteServerProcess(
		['const WSON w =', '\t-> to: "/x"', '\t-> via: "GET"', "", "reactive any p = WSON.listen(w)", "", "watch(p)", "\tWSON.httpSend(p)"].join("\n"),
		dir
	);
	try {
		// Un .wsb sin NINGUNA online function no llega a aceptar la
		// conexión WebSocket en absoluto (wireOnlineFunctionsRpc no se
		// engancha si no hay nada que exponer) — así que el error es de
		// conexión (404), no "no expone ninguna online function" (que solo
		// se daría si el servidor SÍ aceptara la conexión pero devolviera
		// una lista vacía — no ocurre con el diseño actual).
		assert.throws(
			() => execFileSync("node", [WEBSC_BIN, "client-generate", `ws://localhost:${remoto.port}/`, "--out", path.join(dir, "x.ws")], { encoding: "utf8", stdio: "pipe" }),
			/no se ha podido conectar.*404/
		);
	} finally {
		remoto.stop();
	}
});

