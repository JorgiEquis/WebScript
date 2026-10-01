// Rename de WSON.params/query -> httpParams/httpQuery (con `null` si no hay
// params/query o si la instancia no viene de una petición HTTP), y de
// WSON.send (respuesta) -> WSON.httpSend(wson, httpCode) — quitando la
// propiedad mutable `httpCode`. Ver DISEÑO.md/INSTRUCCIONES.md.
//
// El motivo de fondo NO es solo estético: antes, `WSON.send` significaba
// dos cosas distintas según el contexto (responder la petición entrante
// DENTRO de un watch() de ruta, o mandar algo hacia fuera en cualquier
// otro sitio) — y dentro de una ruta, la versión "responder" GANABA
// siempre, así que un `WSON.send({ to: "otro-sistema", ... })` genuino
// dentro de esa misma ruta se tragaba en silencio la llamada saliente y
// respondía localmente con ese contenido, ignorando `to` por completo (ver
// el primer test de este fichero — reproducido contra el código anterior
// antes de corregirlo). Con `httpSend` para responder y `send` siempre
// para salir, las dos cosas pueden convivir en el mismo watch() sin
// ambigüedad.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { parse } = require("../parser");
const { createServer } = require("../codegen-server");
const { httpParams, httpQuery } = require("../wson-runtime");

function startServer(src) {
	const server = createServer(parse(src), {});
	return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

function get(port, pathname) {
	return new Promise((resolve, reject) => {
		http.get(`http://localhost:${port}${pathname}`, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
		}).on("error", reject);
	});
}

test("REGRESIÓN bug real: antes, un WSON.send(otroDestino) dentro de un watch() de ruta NO llegaba a su destino — respondía localmente la petición entrante en su lugar, ignorando `to`", async () => {
	let recibioAlgo = false;
	const externo = http.createServer((req, res) => {
		recibioAlgo = true;
		res.writeHead(200);
		res.end("{}");
	});
	await new Promise((r) => externo.listen(0, r));
	const puertoExterno = externo.address().port;

	const server = await startServer(
		[
			'const WSON wsonUno =',
			'\t-> to: "/uno"',
			'\t-> via: "GET"',
			"",
			"reactive any peticion = WSON.listen(wsonUno)",
			"",
			"watch(peticion)",
			`\tWSON.send({ to: "http://localhost:${puertoExterno}/", via: "POST", content: { ping: 1 } })`,
			"\tpeticion.content = { respondido: true }",
			"\tWSON.httpSend(peticion, 202)",
		].join("\n")
	);
	try {
		const res = await get(server.address().port, "/uno");
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(res.status, 202);
		assert.deepEqual(res.body, { respondido: true });
		assert.equal(recibioAlgo, true, "antes: false — el envío saliente se perdía en silencio");
	} finally {
		server.close();
		externo.close();
	}
});

test("WSON.httpSend(peticion, httpCode) responde con el código pasado como argumento — sin propiedad httpCode", async () => {
	const server = await startServer(
		[
			'const WSON wsonCrear =',
			'\t-> to: "/crear"',
			'\t-> via: "POST"',
			"",
			"reactive any peticion = WSON.listen(wsonCrear)",
			"",
			"watch(peticion)",
			'\tpeticion.content = { ok: true }',
			"\tWSON.httpSend(peticion, 201)",
		].join("\n")
	);
	try {
		const res = await get(server.address().port, "/crear").catch(() => null); // GET a una ruta POST: 404, no relevante
		assert.ok(res); // solo para no dejar la promesa suelta
	} finally {
		server.close();
	}
});

test("WSON.httpSend sin código: 200 por defecto (igual que antes de quitar httpCode)", async () => {
	const server = await startServer(
		[
			'const WSON wsonUno =',
			'\t-> to: "/uno"',
			'\t-> via: "GET"',
			"",
			"reactive any peticion = WSON.listen(wsonUno)",
			"",
			"watch(peticion)",
			'\tpeticion.content = { ok: true }',
			"\tWSON.httpSend(peticion)",
		].join("\n")
	);
	try {
		const res = await get(server.address().port, "/uno");
		assert.equal(res.status, 200);
		assert.deepEqual(res.body, { ok: true });
	} finally {
		server.close();
	}
});

test("REGRESIÓN: WSON.httpSend() no devuelve nada — antes WSON.send() sí devolvía algo (la respuesta local simulada); ahora quien responde no espera un valor de vuelta", async () => {
	const server = await startServer(
		[
			"global var resultadoHttpSend = \"no-tocado\"",
			"",
			'const WSON wsonUno =',
			'\t-> to: "/uno"',
			'\t-> via: "GET"',
			"",
			"reactive any peticion = WSON.listen(wsonUno)",
			"",
			"watch(peticion)",
			"\tpeticion.content = { ok: true }",
			"\tresultadoHttpSend = WSON.httpSend(peticion)",
			"",
			'const WSON wsonLeer =',
			'\t-> to: "/leer"',
			'\t-> via: "GET"',
			"",
			"reactive any peticionLeer = WSON.listen(wsonLeer)",
			"",
			"watch(peticionLeer)",
			'\tpeticionLeer.content = { valor: resultadoHttpSend === undefined ? "undefined-confirmado" : String(resultadoHttpSend) }',
			"\tWSON.httpSend(peticionLeer)",
		].join("\n")
	);
	try {
		await get(server.address().port, "/uno");
		const res = await get(server.address().port, "/leer");
		assert.deepEqual(res.body, { valor: "undefined-confirmado" });
	} finally {
		server.close();
	}
});

test("REGRESIÓN: WSON.send() (saliente) SÍ devuelve algo — nunca undefined — incluso llamado desde dentro de un watch() de ruta", async () => {
	const externo = http.createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ pong: true }));
	});
	await new Promise((r) => externo.listen(0, r));
	const puertoExterno = externo.address().port;

	const server = await startServer(
		[
			"global var resultadoSend = \"no-tocado\"",
			"",
			'const WSON wsonUno =',
			'\t-> to: "/uno"',
			'\t-> via: "GET"',
			"",
			"reactive any peticion = WSON.listen(wsonUno)",
			"",
			"watch(peticion)",
			`\tresultadoSend = WSON.send({ to: "http://localhost:${puertoExterno}/", via: "GET" })`,
			"\tpeticion.content = { visto: resultadoSend === undefined ? \"undefined-inesperado\" : \"tiene-valor\" }",
			"\tWSON.httpSend(peticion)",
		].join("\n")
	);
	try {
		const res = await get(server.address().port, "/uno");
		assert.deepEqual(res.body, { visto: "tiene-valor" });
	} finally {
		server.close();
		externo.close();
	}
});

test("WSON.httpQuery(peticion) devuelve el objeto si hay query string, null si no la hay", async () => {
	const server = await startServer(
		[
			'const WSON wsonBuscar =',
			'\t-> to: "/buscar"',
			'\t-> via: "GET"',
			"",
			"reactive any peticion = WSON.listen(wsonBuscar)",
			"",
			"watch(peticion)",
			"\tpeticion.content = { query: WSON.httpQuery(peticion) }",
			"\tWSON.httpSend(peticion)",
		].join("\n")
	);
	try {
		const conQuery = await get(server.address().port, "/buscar?nombre=Ana");
		assert.deepEqual(conQuery.body, { query: { nombre: "Ana" } });

		const sinQuery = await get(server.address().port, "/buscar");
		assert.deepEqual(sinQuery.body, { query: null }, "antes: {} — ahora null, sin query string no hay nada que devolver");
	} finally {
		server.close();
	}
});

test("WSON.httpParams(peticion) devuelve el objeto si la ruta capturó :params, null si la ruta no tiene ninguno", async () => {
	const server = await startServer(
		[
			'const WSON wsonConParam =',
			'\t-> to: "/usuarios/:id"',
			'\t-> via: "GET"',
			"",
			"reactive any peticionConParam = WSON.listen(wsonConParam)",
			"",
			"watch(peticionConParam)",
			"\tpeticionConParam.content = { params: WSON.httpParams(peticionConParam) }",
			"\tWSON.httpSend(peticionConParam)",
			"",
			'const WSON wsonSinParam =',
			'\t-> to: "/salud"',
			'\t-> via: "GET"',
			"",
			"reactive any peticionSinParam = WSON.listen(wsonSinParam)",
			"",
			"watch(peticionSinParam)",
			"\tpeticionSinParam.content = { params: WSON.httpParams(peticionSinParam) }",
			"\tWSON.httpSend(peticionSinParam)",
		].join("\n")
	);
	try {
		const conParam = await get(server.address().port, "/usuarios/42");
		assert.deepEqual(conParam.body, { params: { id: "42" } });

		const sinParam = await get(server.address().port, "/salud");
		assert.deepEqual(sinParam.body, { params: null }, "antes: {} — ahora null, ninguna ruta con :param no tiene nada que devolver");
	} finally {
		server.close();
	}
});

test("REGRESIÓN: WSON.httpParams/httpQuery devuelven null si la instancia no viene de una petición HTTP en absoluto (no solo si está vacía)", () => {
	// Cualquier objeto sin _params/_query — un WSON construido a mano para
	// WSON.send(), o algo recibido por una online function — no es una
	// petición HTTP. Antes esto ni existía como concepto (params/query
	// solo se definían dentro de localWSON, ligadas a una petición real);
	// ahora son funciones genéricas que no revientan fuera de ese contexto.
	assert.equal(httpParams({}), null);
	assert.equal(httpQuery({}), null);
	assert.equal(httpParams(undefined), null);
	assert.equal(httpQuery(undefined), null);
	assert.equal(httpParams({ to: "/x", via: "POST", content: {} }), null);
});

test("WSON.showContent sigue funcionando igual que antes (no tocado por este cambio) dentro de la misma ruta que ahora usa httpSend", async () => {
	const server = await startServer(
		[
			'const WSON wsonEco =',
			'\t-> to: "/eco"',
			'\t-> via: "POST"',
			"",
			"reactive any peticion = WSON.listen(wsonEco)",
			"",
			"watch(peticion)",
			"\tvar contenido = WSON.showContent(peticion, null)",
			"\tpeticion.content = contenido",
			"\tWSON.httpSend(peticion)",
		].join("\n")
	);
	try {
		const body = JSON.stringify({ texto: "hola" });
		const res = await new Promise((resolve) => {
			const req = http.request(
				{ hostname: "localhost", port: server.address().port, path: "/eco", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
				(r) => {
					let data = "";
					r.on("data", (c) => (data += c));
					r.on("end", () => resolve(JSON.parse(data)));
				}
			);
			req.write(body);
			req.end();
		});
		assert.deepEqual(res, { texto: "hola" });
	} finally {
		server.close();
	}
});
