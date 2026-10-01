const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { parse } = require("../parser");
const { createServer, extractOnlineFunctions } = require("../codegen-server");
const { connect } = require("../websocket-runtime");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-online-fn-"));
}

// Cliente mínimo de prueba: habla el protocolo reflect/call a mano, sin
// pasar por WSClient (que todavía no existe) — exactamente lo que un
// WSClient real haría por debajo.
async function rpcClient(port) {
	const ws = await connect(`ws://localhost:${port}/`);
	const pending = new Map();
	ws.parser.on("message", (msg) => {
		if (msg.opcode !== 1) return;
		const data = JSON.parse(msg.text);
		if (data.type === "reflect") {
			const resolve = pending.get("__reflect__");
			if (resolve) {
				pending.delete("__reflect__");
				resolve(data.functions);
			}
			return;
		}
		const resolve = pending.get(data.id);
		if (!resolve) return;
		pending.delete(data.id);
		resolve(data);
	});
	let counter = 0;
	return {
		ws,
		reflect: () =>
			new Promise((resolve) => {
				pending.set("__reflect__", resolve);
				ws.send(JSON.stringify({ type: "reflect" }));
			}),
		call: (name, args, idempotencyKey) =>
			new Promise((resolve) => {
				const id = `t${counter++}`;
				pending.set(id, resolve);
				ws.send(JSON.stringify({ type: "call", id, name, args, idempotencyKey }));
			}),
		close: () => ws.socket.end(),
	};
}

test("extractOnlineFunctions: recoge las propias del .wsb y las importadas de un .ws, no las que no son online", () => {
	const dir = tmpDir();
	fs.writeFileSync(
		path.join(dir, "utils.ws"),
		["export online function saludar(nombre)", '\treturn "hola " + nombre', "", "export function interna(x)", "\treturn x"].join("\n")
	);
	const src = [
		'import { saludar, interna } from "./utils.ws"',
		"",
		"online function local(a, b) -> idempotent",
		"\treturn a + b",
	].join("\n");
	const ast = parse(src);
	const found = extractOnlineFunctions(ast, dir);
	assert.deepEqual(
		found.map((f) => f.name).sort(),
		["local", "saludar"]
	);
	const local = found.find((f) => f.name === "local");
	assert.deepEqual(local.params, ["a", "b"]);
	assert.equal(local.idempotent, true);
	const saludar = found.find((f) => f.name === "saludar");
	assert.equal(saludar.idempotent, false);
});

test("REGRESIÓN: dos online function con el mismo nombre (declarada + importada) fallan al cargar, no en silencio", () => {
	const dir = tmpDir();
	fs.writeFileSync(path.join(dir, "utils.ws"), ["export online function local(x)", "\treturn x"].join("\n"));
	const src = ['import { local } from "./utils.ws"', "", "online function local(a)", "\treturn a"].join("\n");
	assert.throws(() => extractOnlineFunctions(parse(src), dir), /declarada más de una vez/);
});

test("de extremo a extremo por WebSocket real: reflect() devuelve las funciones expuestas con su firma", async () => {
	const dir = tmpDir();
	const src = [
		"online function cobrar(monto) -> idempotent",
		"\treturn { cobrado: monto }",
		"",
		"online function consultarSaldo(idCuenta)",
		"\treturn { idCuenta: idCuenta, saldo: 500 }",
	].join("\n");
	const server = createServer(parse(src), {}, { baseDir: dir });
	try {
		await new Promise((resolve) => server.listen(0, resolve));
		const port = server.address().port;
		const client = await rpcClient(port);
		const functions = await client.reflect();
		assert.deepEqual(
			functions.sort((a, b) => a.name.localeCompare(b.name)),
			[
				{ name: "cobrar", params: ["monto"], idempotent: true },
				{ name: "consultarSaldo", params: ["idCuenta"], idempotent: false },
			]
		);
		client.close();
	} finally {
		server.close();
	}
});

test("de extremo a extremo: call() ejecuta la función real y devuelve su resultado", async () => {
	const dir = tmpDir();
	const src = ["online function sumar(a, b)", "\treturn a + b"].join("\n");
	const server = createServer(parse(src), {}, { baseDir: dir });
	try {
		await new Promise((resolve) => server.listen(0, resolve));
		const port = server.address().port;
		const client = await rpcClient(port);
		const respuesta = await client.call("sumar", [3, 4]);
		assert.deepEqual(respuesta, { id: "t0", type: "result", value: 7 });
		client.close();
	} finally {
		server.close();
	}
});

test("de extremo a extremo: llamar a una función que no existe da un error claro, no cuelga ni rompe la conexión", async () => {
	const dir = tmpDir();
	const server = createServer(parse("online function sumar(a, b)\n\treturn a + b"), {}, { baseDir: dir });
	try {
		await new Promise((resolve) => server.listen(0, resolve));
		const port = server.address().port;
		const client = await rpcClient(port);
		const respuesta = await client.call("noExiste", []);
		assert.equal(respuesta.type, "error");
		assert.match(respuesta.message, /no existe ninguna "online function noExiste"/);
		// la conexión sigue viva tras el error — se puede seguir usando
		const segunda = await client.call("sumar", [1, 2]);
		assert.deepEqual(segunda, { id: "t1", type: "result", value: 3 });
		client.close();
	} finally {
		server.close();
	}
});

test("de extremo a extremo: si la función lanza, se recibe un error, no se cae el servidor", async () => {
	const dir = tmpDir();
	const server = createServer(parse('online function fallar(x)\n\tthrow new Error("algo salió mal: " + x)'), {}, { baseDir: dir });
	try {
		await new Promise((resolve) => server.listen(0, resolve));
		const port = server.address().port;
		const client = await rpcClient(port);
		const respuesta = await client.call("fallar", ["motivo"]);
		assert.equal(respuesta.type, "error");
		assert.match(respuesta.message, /algo salió mal: motivo/);
		client.close();
	} finally {
		server.close();
	}
});

test("idempotencia: repetir la misma idempotencyKey devuelve el mismo resultado SIN ejecutar la función otra vez", async () => {
	const dir = tmpDir();
	// contadorEjecuciones vive en el propio proceso del test servidor: se
	// usa un .ws con estado de módulo para contar ejecuciones reales.
	fs.writeFileSync(
		path.join(dir, "contador.ws"),
		["export online function cobrar(monto) -> idempotent", "\tglobalThis.__vecesEjecutado = (globalThis.__vecesEjecutado || 0) + 1", "\treturn { cobrado: monto, ejecucion: globalThis.__vecesEjecutado }"].join(
			"\n"
		)
	);
	const server = createServer(parse('import { cobrar } from "./contador.ws"'), {}, { baseDir: dir });
	try {
		await new Promise((resolve) => server.listen(0, resolve));
		const port = server.address().port;
		const client = await rpcClient(port);

		const primera = await client.call("cobrar", [100], "pedido-4471");
		assert.deepEqual(primera.value, { cobrado: 100, ejecucion: 1 });

		const segunda = await client.call("cobrar", [100], "pedido-4471");
		assert.deepEqual(segunda.value, { cobrado: 100, ejecucion: 1 }, "misma ejecución que la primera — no se volvió a ejecutar");

		// Una clave DISTINTA sí ejecuta de verdad.
		const tercera = await client.call("cobrar", [200], "pedido-9999");
		assert.deepEqual(tercera.value, { cobrado: 200, ejecucion: 2 });

		client.close();
	} finally {
		server.close();
		delete global.__vecesEjecutado;
	}
});

test("idempotencia: una segunda llamada con la MISMA clave mientras la primera sigue en curso da un error de conflicto, no una ejecución duplicada", async () => {
	const dir = tmpDir();
	fs.writeFileSync(
		path.join(dir, "lento.ws"),
		[
			"export online function lento(x)",
			// `function` normal (a diferencia de watch()) se compila SIN
			// async — no admite `await` en su propio cuerpo, limitación ya
			// existente del lenguaje, no algo nuevo de online function.
			// Devolver la Promise tal cual, en JS puro, sí funciona: quien
			// despacha la llamada (el servidor) espera igual el resultado.
			"\treturn new Promise(function (resolve) { setTimeout(function () { resolve(x); }, 100); })",
		].join("\n")
	);
	const server = createServer(parse('import { lento } from "./lento.ws"'), {}, { baseDir: dir });
	try {
		await new Promise((resolve) => server.listen(0, resolve));
		const port = server.address().port;
		const client = await rpcClient(port);

		const primeraPromesa = client.call("lento", ["a"], "clave-en-curso");
		await new Promise((r) => setTimeout(r, 20)); // dejar que la primera empiece pero no termine
		const segunda = await client.call("lento", ["a"], "clave-en-curso");
		assert.equal(segunda.type, "error");
		assert.match(segunda.message, /ya hay una llamada en curso/);

		const primera = await primeraPromesa;
		assert.deepEqual(primera, { id: "t0", type: "result", value: "a" });

		client.close();
	} finally {
		server.close();
	}
});

test("un .wsb sin ninguna online function no engancha ningún \"upgrade\" — server.onlineFunctionsRpc queda undefined", async () => {
	const server = createServer(parse('const WSON w =\n\t-> to: "/x"\n\t-> via: "GET"\n\nreactive any p = WSON.listen(w)\n\nwatch(p)\n\tWSON.httpSend(p)'), {}, {});
	assert.equal(server.onlineFunctionsRpc, undefined);
	server.close();
});
