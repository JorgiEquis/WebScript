const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const WSON = require("../wson-runtime");

test("sign/verify: firma correcta se verifica", () => {
	const secret = "clave";
	const content = JSON.stringify({ a: 1 });
	const ts = Date.now();
	const firma = WSON.sign(content, ts, secret);
	assert.equal(WSON.verify(content, firma, secret, ts), true);
});

test("sign/verify: contenido manipulado no se verifica", () => {
	const secret = "clave";
	const content = JSON.stringify({ a: 1 });
	const ts = Date.now();
	const firma = WSON.sign(content, ts, secret);
	assert.equal(WSON.verify(content + "x", firma, secret, ts), false);
});

test("sign/verify: fuera de la ventana de validez (5 min) se rechaza", () => {
	const secret = "clave";
	const content = "hola";
	const tsViejo = Date.now() - 10 * 60 * 1000;
	const firma = WSON.sign(content, tsViejo, secret);
	assert.equal(WSON.verify(content, firma, secret, tsViejo), false);
});

test("encryptContent/showContent: cifrar y descifrar da el original", () => {
	const secret = "clave-compartida";
	const original = JSON.stringify({ nombre: "Ana" });
	const cifrado = WSON.encryptContent(original, secret);
	assert.equal(WSON.showContent(cifrado, secret), original);
});

test("showContent: secret equivocado devuelve null, no lanza excepción", () => {
	const cifrado = WSON.encryptContent("hola", "clave-buena");
	assert.equal(WSON.showContent(cifrado, "clave-mala"), null);
});

test("showContent: sin secret, devuelve el content tal cual (no estaba cifrado)", () => {
	assert.equal(WSON.showContent("texto plano", null), "texto plano");
});

test("getSignature/getTimestamp/getToken leen las cabeceras esperadas", () => {
	const headers = {
		"x-wson-signature": "abc",
		"x-wson-timestamp": "123",
		authorization: "Bearer eltoken",
	};
	assert.equal(WSON.getSignature(headers), "abc");
	assert.equal(WSON.getTimestamp(headers), "123");
	assert.equal(WSON.getToken(headers), "eltoken");
});

test("showToken: decodifica un JWT sin verificar la firma", () => {
	const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({ sub: "123" })).toString("base64url");
	const jwt = `${header}.${payload}.firma-no-verificada`;
	const decoded = WSON.showToken(jwt);
	assert.deepEqual(decoded.payload, { sub: "123" });
});

test("parse(): extrae from/id de las cabeceras, sin secret -> signatureValid null, content tal cual", () => {
	const r = WSON.parse('{"nombre":"Ana"}', { "x-wson-from": "sistema-x", "x-wson-correlation-id": "abc-1" }, null, false);
	assert.deepEqual(r, { from: "sistema-x", id: "abc-1", content: '{"nombre":"Ana"}', signatureValid: null });
});

test("REGRESIÓN bug real: parse() con secret pero SIN encrypt no debe intentar descifrar (content debía salir null antes del arreglo)", () => {
	const contenido = '{"nombre":"Ana"}';
	const timestamp = Date.now();
	const firma = WSON.sign(contenido, timestamp, "clave-secreta");
	const r = WSON.parse(contenido, { "x-wson-signature": firma, "x-wson-timestamp": String(timestamp) }, "clave-secreta", false);
	assert.equal(r.signatureValid, true);
	assert.equal(r.content, contenido); // no null: solo estaba firmado, no cifrado
});

test("parse(): con secret Y encrypt, descifra de verdad", () => {
	const contenido = '{"nombre":"Ana"}';
	const timestamp = Date.now();
	const cifrado = WSON.encryptContent(contenido, "clave-secreta");
	const firma = WSON.sign(cifrado, timestamp, "clave-secreta");
	const r = WSON.parse(cifrado, { "x-wson-signature": firma, "x-wson-timestamp": String(timestamp) }, "clave-secreta", true);
	assert.equal(r.signatureValid, true);
	assert.equal(r.content, contenido);
});

test("parse(): firma incorrecta -> signatureValid false", () => {
	const r = WSON.parse("x", { "x-wson-signature": "inventada", "x-wson-timestamp": String(Date.now()) }, "clave-secreta", false);
	assert.equal(r.signatureValid, false);
});

test("enqueue(): entrega real, aunque diferida (fire-and-forget)", async () => {
	const recibidos = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			recibidos.push(body);
			res.writeHead(200);
			res.end("{}");
		});
	});
	await new Promise((resolve) => server.listen(0, resolve));
	try {
		const port = server.address().port;
		WSON.enqueue({ to: `http://localhost:${port}/recibir`, via: "POST", content: { mensaje: "hola" } });
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(recibidos.length, 1);
		assert.deepEqual(JSON.parse(recibidos[0]), { mensaje: "hola" });
	} finally {
		server.close();
	}
});

test("enqueue(): reintenta con backoff tras fallos, hasta entregar", async () => {
	let intentos = 0;
	const server = http.createServer((req, res) => {
		intentos++;
		if (intentos < 3) {
			req.socket.destroy();
			return;
		}
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			res.writeHead(200);
			res.end("{}");
		});
	});
	await new Promise((resolve) => server.listen(0, resolve));
	try {
		const port = server.address().port;
		WSON.enqueue({ to: `http://localhost:${port}/recibir`, via: "POST", content: {} }, { retries: 3, baseDelayMs: 50 });
		await new Promise((r) => setTimeout(r, 1500));
		assert.equal(intentos, 3);
	} finally {
		server.close();
	}
});

test("send(): con `to` como array, entrega en paralelo con fallo aislado por destino", async () => {
	const recibidos = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			recibidos.push(body);
			res.writeHead(200);
			res.end("{}");
		});
	});
	await new Promise((resolve) => server.listen(0, resolve));
	try {
		const port = server.address().port;
		const resultado = await WSON.send({
			to: [`http://localhost:${port}/x`, "http://localhost:1/no-existe"],
			via: "POST",
			content: { y: 1 },
		});
		assert.equal(resultado.length, 2);
		assert.equal(resultado[0].status, 200);
		assert.equal(resultado[1].status, null); // aislado: el fallo del segundo no tumba el primero
		assert.equal(recibidos.length, 1);
	} finally {
		server.close();
	}
});

test("REGRESIÓN bug real: send() con via GET no debe reventar — antes mandaba siempre un body, y GET/HEAD no pueden llevarlo", async () => {
	const server = http.createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ url: req.url, method: req.method }));
	});
	await new Promise((resolve) => server.listen(0, resolve));
	try {
		const port = server.address().port;
		const resultado = await WSON.send({ to: `http://localhost:${port}/eco`, via: "GET" });
		assert.equal(resultado.status, 200);
	} finally {
		server.close();
	}
});

test("send() con GET: el content se traduce a query string, no se pierde", async () => {
	const server = http.createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ url: req.url, method: req.method }));
	});
	await new Promise((resolve) => server.listen(0, resolve));
	try {
		const port = server.address().port;
		const resultado = await WSON.send({
			to: `http://localhost:${port}/eco`,
			via: "GET",
			content: { nombre: "Ana", edad: 30 },
		});
		const body = JSON.parse(resultado.body);
		assert.equal(body.method, "GET");
		assert.equal(body.url, "/eco?nombre=Ana&edad=30");
	} finally {
		server.close();
	}
});

test("send() con GET firmado: la firma se calcula sobre lo que de verdad se manda (sin body), y verifica correctamente al otro lado", async () => {
	const server = http.createServer((req, res) => {
		const firmaValida = WSON.verify("", WSON.getSignature(req.headers), "clave-secreta", WSON.getTimestamp(req.headers));
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ firmaValida }));
	});
	await new Promise((resolve) => server.listen(0, resolve));
	try {
		const port = server.address().port;
		const resultado = await WSON.send({
			to: `http://localhost:${port}/eco`,
			via: "GET",
			content: { id: 42 },
			secret: "clave-secreta",
		});
		assert.deepEqual(JSON.parse(resultado.body), { firmaValida: true });
	} finally {
		server.close();
	}
});

test("send() con via HEAD tampoco manda body", async () => {
	const server = http.createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end();
	});
	await new Promise((resolve) => server.listen(0, resolve));
	try {
		const port = server.address().port;
		const resultado = await WSON.send({ to: `http://localhost:${port}/eco`, via: "HEAD" });
		assert.equal(resultado.status, 200);
	} finally {
		server.close();
	}
});

test("showToken: con un string que no es un JWT devuelve null", () => {
	assert.equal(WSON.showToken("no-es-un-jwt"), null);
});
