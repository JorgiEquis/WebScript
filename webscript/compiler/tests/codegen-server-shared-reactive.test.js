// Protocolo de `shared global reactive` en el servidor: `subscribe` (envía
// el valor actual de inmediato, y cada actualización futura), `propose`
// (el cliente nunca muta directamente — el servidor reasigna de verdad, lo
// que dispara `watch()` si lo hay, y difunde a todos los suscritos,
// incluido quien propuso). Comparte la MISMA conexión WebSocket que ya usa
// `online function` — un único `upgrade`, distintos `type` de mensaje.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("../parser");
const { createServer } = require("../codegen-server");
const { connect } = require("../websocket-runtime");

async function withServer(source, fn) {
	const server = createServer(parse(source), {}, {});
	try {
		await new Promise((resolve, reject) => {
			server.listen(0, resolve);
			server.on("error", reject);
		});
		await fn(server.address().port, server);
	} finally {
		server.close();
	}
}

function recibirUnMensaje(ws) {
	return new Promise((resolve) => ws.parser.once("message", (msg) => resolve(JSON.parse(msg.text))));
}

test("REGRESIÓN nueva capacidad: 'subscribe' manda el valor ACTUAL de inmediato, sin esperar a que algo cambie", async () => {
	await withServer("shared global reactive contador = 7", async (port) => {
		const ws = await connect(`ws://localhost:${port}/`);
		ws.send(JSON.stringify({ type: "subscribe", name: "contador" }));
		const msg = await recibirUnMensaje(ws);
		assert.deepEqual(msg, { type: "update", name: "contador", value: 7 });
		ws.socket.end();
	});
});

test("REGRESIÓN: 'propose' reasigna de verdad en el servidor, y la difusión llega también a QUIEN PROPUSO, no solo a los demás", async () => {
	await withServer("shared global reactive contador = 0", async (port) => {
		const ws = await connect(`ws://localhost:${port}/`);
		ws.send(JSON.stringify({ type: "subscribe", name: "contador" }));
		await recibirUnMensaje(ws); // el update inicial, con 0
		ws.send(JSON.stringify({ type: "propose", name: "contador", value: 42 }));
		const msg = await recibirUnMensaje(ws);
		assert.deepEqual(msg, { type: "update", name: "contador", value: 42 });
		ws.socket.end();
	});
});

test("REGRESIÓN: un 'propose' llega a TODOS los suscritos, no solo a quien lo mandó", async () => {
	await withServer("shared global reactive contador = 0", async (port) => {
		const a = await connect(`ws://localhost:${port}/`);
		const b = await connect(`ws://localhost:${port}/`);
		a.send(JSON.stringify({ type: "subscribe", name: "contador" }));
		b.send(JSON.stringify({ type: "subscribe", name: "contador" }));
		await recibirUnMensaje(a);
		await recibirUnMensaje(b);
		a.send(JSON.stringify({ type: "propose", name: "contador", value: 42 }));
		const [msgA, msgB] = await Promise.all([recibirUnMensaje(a), recibirUnMensaje(b)]);
		assert.deepEqual(msgA, { type: "update", name: "contador", value: 42 });
		assert.deepEqual(msgB, { type: "update", name: "contador", value: 42 });
		a.socket.end();
		b.socket.end();
	});
});

test("REGRESIÓN: un watch() que corrige el valor propuesto difunde el valor YA CORREGIDO, nunca el propuesto tal cual", async () => {
	const source = ["shared global reactive contador = 0", "", "watch(contador)", "\tif (contador > 10)", "\t\tcontador = 10"].join("\n");
	await withServer(source, async (port) => {
		const ws = await connect(`ws://localhost:${port}/`);
		ws.send(JSON.stringify({ type: "subscribe", name: "contador" }));
		await recibirUnMensaje(ws);
		ws.send(JSON.stringify({ type: "propose", name: "contador", value: 999 }));
		const msg = await recibirUnMensaje(ws);
		assert.deepEqual(msg, { type: "update", name: "contador", value: 10 }, "debe llegar 10 (corregido), no 999");
		ws.socket.end();
	});
});

test("REGRESIÓN (el bug real encontrado al implementarlo): la corrección de un watch() NO duplica la difusión — un único 'update', no dos", async () => {
	const source = ["shared global reactive contador = 0", "", "watch(contador)", "\tif (contador > 10)", "\t\tcontador = 10"].join("\n");
	await withServer(source, async (port) => {
		const ws = await connect(`ws://localhost:${port}/`);
		const mensajes = [];
		ws.parser.on("message", (msg) => mensajes.push(JSON.parse(msg.text)));
		ws.send(JSON.stringify({ type: "subscribe", name: "contador" }));
		await new Promise((r) => setTimeout(r, 100));
		ws.send(JSON.stringify({ type: "propose", name: "contador", value: 999 }));
		await new Promise((r) => setTimeout(r, 200));
		ws.socket.end();
		assert.deepEqual(mensajes, [
			{ type: "update", name: "contador", value: 0 },
			{ type: "update", name: "contador", value: 10 },
		]);
	});
});

test("NO REGRESIÓN: una 'shared global reactive' SIN ningún watch() se difunde igual (la difusión no depende de que exista un watch())", async () => {
	await withServer("shared global reactive mensaje = 'hola'", async (port) => {
		const ws = await connect(`ws://localhost:${port}/`);
		ws.send(JSON.stringify({ type: "subscribe", name: "mensaje" }));
		await recibirUnMensaje(ws);
		ws.send(JSON.stringify({ type: "propose", name: "mensaje", value: "adiós" }));
		const msg = await recibirUnMensaje(ws);
		assert.deepEqual(msg, { type: "update", name: "mensaje", value: "adiós" });
		ws.socket.end();
	});
});

test("REGRESIÓN: un nombre que no es ninguna shared global reactive de este servidor se ignora, sin tumbar la conexión", async () => {
	await withServer("shared global reactive contador = 0", async (port) => {
		const ws = await connect(`ws://localhost:${port}/`);
		ws.send(JSON.stringify({ type: "subscribe", name: "noExiste" }));
		// seguimos pudiendo usar la MISMA conexión con normalidad después
		ws.send(JSON.stringify({ type: "subscribe", name: "contador" }));
		const msg = await recibirUnMensaje(ws);
		assert.deepEqual(msg, { type: "update", name: "contador", value: 0 });
		ws.socket.end();
	});
});

test("REGRESIÓN: al cerrarse la conexión, se quita del registro de suscriptores (sin fuga de memoria)", async () => {
	await withServer("shared global reactive contador = 0", async (port, server) => {
		const ws = await connect(`ws://localhost:${port}/`);
		ws.send(JSON.stringify({ type: "subscribe", name: "contador" }));
		await recibirUnMensaje(ws);
		const handler = server.listeners("request")[0];
		assert.equal(handler.sharedGlobalReactives.subscribers.get("contador").size, 1);
		ws.socket.end();
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(handler.sharedGlobalReactives.subscribers.get("contador").size, 0);
	});
});

test("NO REGRESIÓN: 'online function' y 'shared global reactive' conviven en la misma conexión, sin interferirse", async () => {
	const source = ["shared global reactive contador = 0", "", "online function saludo(nombre)", '\treturn "hola, " + nombre'].join("\n");
	await withServer(source, async (port) => {
		const ws = await connect(`ws://localhost:${port}/`);
		ws.send(JSON.stringify({ type: "subscribe", name: "contador" }));
		await recibirUnMensaje(ws);
		ws.send(JSON.stringify({ type: "call", id: 1, name: "saludo", args: ["Ana"] }));
		const msg = await recibirUnMensaje(ws);
		assert.deepEqual(msg, { id: 1, type: "result", value: "hola, Ana" });
		ws.socket.end();
	});
});
