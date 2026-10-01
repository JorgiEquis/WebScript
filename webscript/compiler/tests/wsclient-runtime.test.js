const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("../parser");
const { createServer } = require("../codegen-server");
const { WSClient } = require("../wsclient-runtime");

function startServer(src) {
	const server = createServer(parse(src), {}, { baseDir: "/tmp" });
	return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

test("WSClient: una llamada hecha ANTES de conectar espera en cola y se resuelve igual", async () => {
	const server = await startServer("online function sumar(a, b)\n\treturn a + b");
	try {
		const port = server.address().port;
		const client = new WSClient(`ws://localhost:${port}/`);
		assert.equal(client.estaLista, false, "recién creado, todavía no puede estar listo");
		const resultado = await client.llamar("sumar", [2, 3]);
		assert.equal(resultado, 5);
		client.close();
	} finally {
		server.close();
	}
});

test("WSClient: reflect() y una llamada a función inexistente dan el resultado/error esperado", async () => {
	const server = await startServer("online function sumar(a, b)\n\treturn a + b");
	try {
		const port = server.address().port;
		const client = new WSClient(`ws://localhost:${port}/`);
		const funciones = await client.reflect();
		assert.deepEqual(funciones, [{ name: "sumar", params: ["a", "b"], idempotent: false }]);
		await assert.rejects(() => client.llamar("noExiste", []), /no existe ninguna "online function noExiste"/);
		client.close();
	} finally {
		server.close();
	}
});

test("WSClient: idempotencyKey funciona igual que llamando a mano por WebSocket — repetir la clave no re-ejecuta", async () => {
	const server = await startServer(
		'online function contar() -> idempotent\n\tglobalThis.__wsClientTestContador = (globalThis.__wsClientTestContador || 0) + 1\n\treturn globalThis.__wsClientTestContador'
	);
	try {
		const port = server.address().port;
		const client = new WSClient(`ws://localhost:${port}/`);
		const primera = await client.llamar("contar", [], { idempotencyKey: "misma-clave" });
		const segunda = await client.llamar("contar", [], { idempotencyKey: "misma-clave" });
		assert.equal(primera, segunda, "la segunda llamada devuelve lo mismo, sin haberse ejecutado otra vez");
		client.close();
	} finally {
		server.close();
		delete global.__wsClientTestContador;
	}
});

test("WSClient: una llamada sin respuesta agota su propio plazo y se rechaza, sin colgarse", async () => {
	const server = await startServer('online function nuncaResponde()\n\treturn new Promise(function(){})');
	try {
		const port = server.address().port;
		const client = new WSClient(`ws://localhost:${port}/`);
		await assert.rejects(() => client.llamar("nuncaResponde", [], { timeoutMs: 150 }), /sin respuesta en 150ms/);
		client.close();
	} finally {
		server.close();
	}
});

test("WSClient: reconexión real — cortar el socket hace caer estaLista, y se reconecta solo por backoff, sin llamar a nada", async () => {
	const server = await startServer("online function sumar(a, b)\n\treturn a + b");
	try {
		const port = server.address().port;
		const client = new WSClient(`ws://localhost:${port}/`, { baseDelayMs: 50 });
		assert.equal(await client.llamar("sumar", [1, 1]), 2);

		client._ws.socket.destroy();
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(client.estaLista, false, "la caída se detecta de inmediato");

		const desde = Date.now();
		while (!client.estaLista && Date.now() - desde < 5000) await new Promise((r) => setTimeout(r, 20));
		assert.equal(client.estaLista, true, "se reconecta solo, sin que nadie llame a connect() de nuevo");

		assert.equal(await client.llamar("sumar", [10, 20]), 30, "la conexión reconectada funciona con normalidad");
		client.close();
	} finally {
		server.close();
	}
});

test("WSClient: una llamada YA EN CURSO se rechaza con un error claro si la conexión cae a mitad — nunca se reintenta sola", async () => {
	const server = await startServer('online function lento()\n\treturn new Promise(function(r){ setTimeout(function(){ r("listo"); }, 400); })');
	try {
		const port = server.address().port;
		const client = new WSClient(`ws://localhost:${port}/`);
		await client.reflect(); // asegura que la conexión inicial ya está lista antes de medir tiempos

		const promesa = client.llamar("lento", [], { timeoutMs: 5000 });
		await new Promise((r) => setTimeout(r, 50)); // la llamada ya viajó, está "en vuelo"
		client._ws.socket.destroy();

		await assert.rejects(() => promesa, /conexión perdida a mitad de la llamada/);
		client.close();
	} finally {
		server.close();
	}
});

test("WSClient: close() rechaza cualquier llamada pendiente y deja de reconectar", async () => {
	const server = await startServer('online function lento()\n\treturn new Promise(function(){})');
	try {
		const port = server.address().port;
		const client = new WSClient(`ws://localhost:${port}/`);
		const promesa = client.llamar("lento", [], { timeoutMs: 5000 });
		await new Promise((r) => setTimeout(r, 30));
		client.close();
		await assert.rejects(() => promesa, /cerrado mientras la llamada seguía pendiente/);
	} finally {
		server.close();
	}
});

test("WSClient.create(): memoriza por URL — misma URL devuelve la MISMA conexión, no una nueva cada vez", async () => {
	const server = await startServer("online function sumar(a, b)\n\treturn a + b");
	try {
		const port = server.address().port;
		const a = WSClient.create(`ws://localhost:${port}/`);
		const b = WSClient.create(`ws://localhost:${port}/`);
		assert.equal(a, b, "misma URL -> misma instancia, no una conexión nueva por llamada");
		assert.equal(await a.llamar("sumar", [1, 2]), 3);
		a.close();

		const c = WSClient.create(`ws://localhost:${port}/`);
		assert.notEqual(c, a, "tras close(), la siguiente create() para esa URL abre una conexión nueva, no reutiliza la cerrada");
		c.close();
	} finally {
		server.close();
	}
});

test("WSClient.create(): URLs distintas dan conexiones distintas", async () => {
	const serverA = await startServer("online function sumar(a, b)\n\treturn a + b");
	const serverB = await startServer("online function sumar(a, b)\n\treturn a + b");
	try {
		const portA = serverA.address().port;
		const portB = serverB.address().port;
		const clienteA = WSClient.create(`ws://localhost:${portA}/`);
		const clienteB = WSClient.create(`ws://localhost:${portB}/`);
		assert.notEqual(clienteA, clienteB);
		clienteA.close();
		clienteB.close();
	} finally {
		serverA.close();
		serverB.close();
	}
});
