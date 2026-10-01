const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("../parser");
const { createServer } = require("../codegen-server");
const { WSClient } = require("../wsclient-runtime");

function startServer(src, dir = "/tmp") {
	const server = createServer(parse(src), {}, { baseDir: dir });
	return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

test("REGRESIÓN: una global reactive es visible desde una online function del mismo .wsb, y persiste entre llamadas", async () => {
	const server = await startServer(
		["global reactive integer contadorGlobal = 0", "", "online function incrementar()", "\tcontadorGlobal = contadorGlobal + 1", "\treturn contadorGlobal"].join("\n")
	);
	try {
		const client = new WSClient(`ws://localhost:${server.address().port}/`);
		assert.equal(await client.llamar("incrementar", []), 1);
		assert.equal(await client.llamar("incrementar", []), 2);
		assert.equal(await client.llamar("incrementar", []), 3, "persiste entre llamadas — no se reinicia cada vez");
		client.close();
	} finally {
		server.close();
	}
});

test("una function normal y una online function del mismo .wsb comparten la MISMA global reactive", async () => {
	const server = await startServer(
		[
			"global reactive integer contadorGlobal = 5",
			"",
			"function ayudante()",
			"\treturn contadorGlobal * 10",
			"",
			"online function usaAyudante()",
			"\treturn ayudante()",
		].join("\n")
	);
	try {
		const client = new WSClient(`ws://localhost:${server.address().port}/`);
		assert.equal(await client.llamar("usaAyudante", []), 50);
		client.close();
	} finally {
		server.close();
	}
});

test("un global var (no reactive) de nivel superior también es visible desde online function", async () => {
	const server = await startServer(['global var mensaje = "hola"', "", "online function leeMensaje()", "\treturn mensaje"].join("\n"));
	try {
		const client = new WSClient(`ws://localhost:${server.address().port}/`);
		assert.equal(await client.llamar("leeMensaje", []), "hola");
		client.close();
	} finally {
		server.close();
	}
});

test("REGRESIÓN: un valor inicial mal tipado en una global reactive NO tira el arranque del servidor — falla solo en la llamada que lo dispara", async () => {
	const src = ['global reactive integer visitas = "no soy un entero"', "", "online function leeVisitas()", "\treturn visitas"].join("\n");
	// No debe lanzar aquí — el servidor arranca bien.
	const server = createServer(parse(src), {}, { baseDir: "/tmp" });
	try {
		await new Promise((resolve) => server.listen(0, resolve));
		const client = new WSClient(`ws://localhost:${server.address().port}/`);
		await assert.rejects(() => client.llamar("leeVisitas", []), /"visitas" está declarada como "integer"/);
		client.close();
	} finally {
		server.close();
	}
});

test("el estado global es independiente entre dos servidores distintos (cada .wsb, el suyo)", async () => {
	const servidorA = await startServer(["global reactive integer x = 1", "", "online function leer()", "\treturn x"].join("\n"));
	const servidorB = await startServer(["global reactive integer x = 99", "", "online function leer()", "\treturn x"].join("\n"));
	try {
		const clienteA = new WSClient(`ws://localhost:${servidorA.address().port}/`);
		const clienteB = new WSClient(`ws://localhost:${servidorB.address().port}/`);
		assert.equal(await clienteA.llamar("leer", []), 1);
		assert.equal(await clienteB.llamar("leer", []), 99);
		clienteA.close();
		clienteB.close();
	} finally {
		servidorA.close();
		servidorB.close();
	}
});

test("NUEVO: una function/online function que toca una reactive de SESIÓN (sin `global`) da un error claro al compilar, no un bug silencioso", () => {
	const src = ["reactive integer visitas = 0", "", "online function leeVisitas()", "\treturn visitas"].join("\n");
	assert.throws(() => createServer(parse(src), {}, { baseDir: "/tmp" }), /"visitas" es una reactive\/var POR SESIÓN.*Decláralo con `global`/);
});

test("NUEVO: lo mismo para un var de sesión reasignado (no solo leído) desde una function normal", () => {
	const src = ["var contador = 0", "", "function incrementar()", "\tcontador = contador + 1"].join("\n");
	assert.throws(() => createServer(parse(src), {}, { baseDir: "/tmp" }), /"contador" es una reactive\/var POR SESIÓN/);
});

test("NUEVO: una reactive de sesión normal sigue funcionando exactamente igual dentro de watch(), sin la palabra `global`", async () => {
	const src = [
		"reactive integer misVisitas = 0",
		"",
		"const WSON w =",
		'\t-> to: "/visitar"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(w)",
		"",
		"watch(peticion)",
		"\tmisVisitas = misVisitas + 1",
		"\tpeticion.content = { misVisitas: misVisitas }",
		"\tWSON.httpSend(peticion)",
	].join("\n");
	const server = await startServer(src);
	try {
		const http = require("http");
		const get = () =>
			new Promise((resolve) => {
				http.get(`http://localhost:${server.address().port}/visitar`, (res) => {
					let body = "";
					res.on("data", (c) => (body += c));
					res.on("end", () => resolve(JSON.parse(body)));
				});
			});
		assert.deepEqual(await get(), { misVisitas: 1 });
		assert.deepEqual(await get(), { misVisitas: 1 }, "sin cookie, cada petición es una sesión nueva — sigue aislado por visitante como siempre");
	} finally {
		server.close();
	}
});
