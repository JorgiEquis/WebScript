const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { acceptUpgrade, connect, acceptKeyFor, encodeFrame, FrameParser, OPCODE } = require("../websocket-runtime");

test("acceptKeyFor: coincide con el vector de prueba oficial de la RFC 6455 (§1.3)", () => {
	assert.equal(acceptKeyFor("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

function withServer(onUpgrade) {
	const server = http.createServer();
	server.on("upgrade", onUpgrade);
	return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

test("handshake + framing real: eco de un mensaje corto, servidor y cliente reales", async () => {
	const server = await withServer((req, socket, head) => {
		const ws = acceptUpgrade(req, socket, head);
		ws.parser.on("message", (m) => ws.send(`eco:${m.text}`));
	});
	try {
		const port = server.address().port;
		const client = await connect(`ws://localhost:${port}/algo`);
		client.send("hola");
		const recibido = await new Promise((resolve) => client.parser.once("message", (m) => resolve(m.text)));
		assert.equal(recibido, "eco:hola");
		client.socket.end();
	} finally {
		server.close();
	}
});

test("framing: los tres tamaños de longitud (7 bits, 16 y 64 extendidos) viajan íntegros", async () => {
	const server = await withServer((req, socket, head) => {
		const ws = acceptUpgrade(req, socket, head);
		ws.parser.on("message", (m) => ws.send(`len:${m.text.length}`));
	});
	try {
		const port = server.address().port;
		const client = await connect(`ws://localhost:${port}/`);
		const tamaños = [5, 200, 70000];
		for (const n of tamaños) {
			const respuesta = new Promise((r) => client.parser.once("message", (m) => r(m.text)));
			client.send("x".repeat(n));
			assert.equal(await respuesta, `len:${n}`);
		}
		client.socket.end();
	} finally {
		server.close();
	}
});

test("un GET normal (sin upgrade) convive con el mismo http.Server sin que WebSocket interfiera", async () => {
	const server = http.createServer((req, res) => res.end("normal"));
	server.on("upgrade", (req, socket, head) => {
		const ws = acceptUpgrade(req, socket, head);
		ws.parser.on("message", (m) => ws.send(m.text));
	});
	await new Promise((resolve) => server.listen(0, resolve));
	try {
		const port = server.address().port;
		const body = await new Promise((resolve) => {
			http.get(`http://localhost:${port}/`, (res) => {
				let data = "";
				res.on("data", (c) => (data += c));
				res.on("end", () => resolve(data));
			});
		});
		assert.equal(body, "normal");
	} finally {
		server.close();
	}
});

test("connect() rechaza limpio: puerto cerrado, esquema no soportado, URL inválida", async () => {
	await assert.rejects(() => connect("ws://localhost:1"), /ECONNREFUSED/);
	await assert.rejects(() => connect("http://localhost:1"), /esquema no soportado/);
	await assert.rejects(() => connect("no es una url"), /URL no válida/);
});

test("acceptUpgrade rechaza una petición sin las cabeceras de WebSocket, sin colgar el socket", async () => {
	const server = await withServer((req, socket, head) => {
		const ws = acceptUpgrade(req, socket, head);
		assert.equal(ws, null);
	});
	try {
		const port = server.address().port;
		const net = require("net");
		const socket = net.connect(port, "localhost");
		const respuesta = await new Promise((resolve) => {
			socket.on("connect", () => socket.write("GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")); // sin Sec-WebSocket-Key
			socket.on("data", (d) => resolve(d.toString()));
		});
		assert.match(respuesta, /400/);
		socket.end();
	} finally {
		server.close();
	}
});

test("connect() detecta un Sec-WebSocket-Accept incorrecto (servidor que no completa bien el saludo)", async () => {
	const net = require("net");
	const server = net.createServer((socket) => {
		socket.on("data", () => {
			socket.end(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Accept: valorIncorrecto", "", ""].join("\r\n"));
		});
	});
	await new Promise((resolve) => server.listen(0, resolve));
	try {
		const port = server.address().port;
		await assert.rejects(() => connect(`ws://localhost:${port}/`), /Sec-WebSocket-Accept no coincide/);
	} finally {
		server.close();
	}
});

test("connect() rechaza si el servidor responde con un status distinto de 101", async () => {
	const server = await withServer((req, socket) => {
		socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
	});
	try {
		const port = server.address().port;
		await assert.rejects(() => connect(`ws://localhost:${port}/`), /respondió 404/);
	} finally {
		server.close();
	}
});

test("FrameParser: un mensaje fragmentado (FIN=0 + continuación) se reensambla entero", () => {
	const chunks = [];
	const fakeSocket = { on: (ev, fn) => { if (ev === "data") fakeSocket._onData = fn; }, write: () => {} };
	const parser = new FrameParser(fakeSocket);
	let recibido = null;
	parser.on("message", (m) => (recibido = m.text));

	const primera = encodeFrame("hola ", { opcode: OPCODE.TEXT, fin: false });
	const segunda = encodeFrame("mundo", { opcode: OPCODE.CONTINUATION, fin: true });
	fakeSocket._onData(Buffer.concat([primera, segunda]));
	assert.equal(recibido, "hola mundo");
});

test("FrameParser: un frame partido entre dos llegadas de \"data\" se reconstruye igual", () => {
	const fakeSocket = { on: (ev, fn) => { if (ev === "data") fakeSocket._onData = fn; }, write: () => {} };
	const parser = new FrameParser(fakeSocket);
	let recibido = null;
	parser.on("message", (m) => (recibido = m.text));

	const frame = encodeFrame("mensaje partido a la mitad", { opcode: OPCODE.TEXT });
	const mitad = Math.floor(frame.length / 2);
	fakeSocket._onData(frame.subarray(0, mitad));
	assert.equal(recibido, null, "todavía no debería haber un mensaje completo");
	fakeSocket._onData(frame.subarray(mitad));
	assert.equal(recibido, "mensaje partido a la mitad");
});

test("un PING del otro lado se responde solo con un PONG", async () => {
	const server = await withServer((req, socket, head) => {
		acceptUpgrade(req, socket, head);
	});
	try {
		const port = server.address().port;
		const client = await connect(`ws://localhost:${port}/`);
		const pong = new Promise((resolve) => {
			const orig = client.parser._handleFrame.bind(client.parser);
			client.parser._handleFrame = (frame) => {
				if (frame.opcode === OPCODE.PONG) resolve(true);
				orig(frame);
			};
		});
		client.socket.write(encodeFrame("", { opcode: OPCODE.PING, mask: true }));
		assert.equal(await pong, true);
		client.socket.end();
	} finally {
		server.close();
	}
});

// --- Regresión: un frame mal formado NO puede tumbar el proceso --------
//
// Estos dos bugs eran reales: antes de esta prueba, cualquiera de los dos
// frames de abajo lanzaba una excepción SÍNCRONA dentro del manejador del
// evento "data" del socket — sin nada que la capturase, eso no rompe solo
// esa conexión, tumba el proceso de Node entero, con todas las conexiones
// que tuviera abiertas en ese momento. Confirmado de verdad antes de
// arreglarlo: un cliente que manda uno de estos dos frames paraba el
// servidor con "Error: ... at Socket.emit (node:events...)" sin que nada
// lo capturase, exit code 1.

test("REGRESIÓN: un CONTINUATION suelto (sin mensaje fragmentado en curso) no tumba el proceso — solo esa conexión", async () => {
	const otrasConexionesSiguenVivas = { valor: null };
	const server = await withServer((req, socket, head) => {
		const ws = acceptUpgrade(req, socket, head);
		ws.parser.on("error", () => {}); // se espera el error — no debe propagarse más allá de esta conexión
		ws.parser.on("message", (m) => ws.send(`viva:${m.text}`));
	});
	try {
		const port = server.address().port;

		// Conexión B, normal, que debe seguir funcionando pase lo que pase en A.
		const clienteB = await connect(`ws://localhost:${port}/b`);
		clienteB.parser.on("message", (m) => (otrasConexionesSiguenVivas.valor = m.text));

		// Conexión A: manda un CONTINUATION suelto, malformado a propósito.
		const clienteA = await connect(`ws://localhost:${port}/a`);
		clienteA.socket.write(encodeFrame("basura", { opcode: OPCODE.CONTINUATION, mask: true }));
		await new Promise((r) => setTimeout(r, 100)); // dar tiempo a que, si el proceso fuera a caerse, ya lo hubiera hecho

		// Si seguimos aquí, el proceso no se cayó — ahora se comprueba que
		// la conexión B, ajena al ataque, sigue respondiendo con normalidad.
		clienteB.send("sigo viva");
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(otrasConexionesSiguenVivas.valor, "viva:sigo viva");

		clienteB.socket.end();
	} finally {
		server.close();
	}
});

test("REGRESIÓN: una longitud de frame que supera el máximo cierra esa conexión, sin tumbar el proceso ni acumular el búfer sin límite", async () => {
	const server = await withServer((req, socket, head) => {
		const ws = acceptUpgrade(req, socket, head);
		ws.parser.maxFrameBytes = 1000; // límite bajo, para no tener que mandar megabytes en el test
		ws.parser.on("error", () => {});
	});
	try {
		const port = server.address().port;
		const client = await connect(`ws://localhost:${port}/`);
		const cerrada = new Promise((resolve) => client.socket.on("close", () => resolve(true)));

		// Cabecera de un frame de texto que DECLARA 5000 bytes, pero solo
		// se mandan 10 — si el límite no se comprobara al leer la cabecera
		// (solo al completarse el frame), este test se quedaría esperando
		// para siempre, porque esos 5000 bytes nunca llegan.
		const header = Buffer.from([0x81, 0xfe, 0x13, 0x88]); // FIN+texto, longitud extendida de 16 bits = 5000
		const maskKey = Buffer.from([1, 2, 3, 4]);
		client.socket.write(Buffer.concat([header, maskKey, Buffer.from("solo10byt")]));

		assert.equal(await cerrada, true, "el servidor debe cerrar la conexión al ver la longitud declarada, sin esperar a que lleguen los 5000 bytes");
	} finally {
		server.close();
	}
});

test("cierre correcto del protocolo: al recibir un CLOSE, se devuelve otro CLOSE antes de cortar", async () => {
	const server = await withServer((req, socket, head) => {
		acceptUpgrade(req, socket, head);
	});
	try {
		const port = server.address().port;
		const client = await connect(`ws://localhost:${port}/`);
		const respuestaCierre = new Promise((resolve) => {
			client.parser.on("message", () => {}); // no se espera un "message" — un CLOSE no dispara "message"
			const rawOn = client.socket.on.bind(client.socket);
			client.socket.on("data", (chunk) => {
				if ((chunk[0] & 0x0f) === OPCODE.CLOSE) resolve(true);
			});
		});
		client.socket.write(encodeFrame("", { opcode: OPCODE.CLOSE, mask: true }));
		assert.equal(await respuestaCierre, true, "el servidor debe devolver su propio frame CLOSE, no cortar sin más");
	} finally {
		server.close();
	}
});

