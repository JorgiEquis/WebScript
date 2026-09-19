const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const { parse } = require("../parser");
const { createServer } = require("../codegen-server");

function post(port, body, headers = {}) {
	return new Promise((resolve, reject) => {
		const data = typeof body === "string" ? body : JSON.stringify(body);
		const req = http.request(
			{
				hostname: "localhost",
				port,
				path: "/notas",
				method: "POST",
				headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers },
			},
			(res) => {
				let out = "";
				res.on("data", (c) => (out += c));
				res.on("end", () => resolve({ status: res.statusCode, body: out }));
			}
		);
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}

function withServer(source, wconfig, fn) {
	return new Promise((resolve, reject) => {
		const server = createServer(parse(source), wconfig);
		server.listen(0, async () => {
			try {
				await fn(server.address().port);
				resolve();
			} catch (err) {
				reject(err);
			} finally {
				server.close();
			}
		});
	});
}

const DEMO_SOURCE = [
	'const WSON wsonCrearNota =',
	'\t-> to: "/notas"',
	'\t-> via: "POST"',
	"",
	"reactive any peticion = WSON.listen(wsonCrearNota)",
	"",
	"watch(peticion)",
	"\tvar contenido = WSON.showContent(peticion, null)",
	"\tpeticion.httpCode = 201",
	'\tpeticion.content = { mensaje: "recibido", texto: contenido.texto }',
	"\tWSON.send(peticion)",
].join("\n");

test("servidor real: WSON.listen()+watch()+httpCode+WSON.send() responde una petición HTTP real", async () => {
	await withServer(DEMO_SOURCE, {}, async (port) => {
		const res = await post(port, { texto: "Hola WebScript" });
		assert.equal(res.status, 201);
		assert.deepEqual(JSON.parse(res.body), { mensaje: "recibido", texto: "Hola WebScript" });
	});
});

test("servidor real: ruta/method que no coincide con ningún listen() da 404", async () => {
	await withServer(DEMO_SOURCE, {}, async (port) => {
		const res = await new Promise((resolve) => {
			http.get(`http://localhost:${port}/no-existe`, (r) => {
				let out = "";
				r.on("data", (c) => (out += c));
				r.on("end", () => resolve({ status: r.statusCode }));
			});
		});
		assert.equal(res.status, 404);
	});
});

test("servidor real: rate limiting corta a partir del máximo configurado", async () => {
	await withServer(DEMO_SOURCE, { "rate-limit-max": 2, "rate-limit-window-ms": 60000 }, async (port) => {
		const r1 = await post(port, { texto: "a" });
		const r2 = await post(port, { texto: "b" });
		const r3 = await post(port, { texto: "c" });
		assert.equal(r1.status, 201);
		assert.equal(r2.status, 201);
		assert.equal(r3.status, 429);
	});
});

test("servidor real: rate-limit-max 0 desactiva el límite", async () => {
	await withServer(DEMO_SOURCE, { "rate-limit-max": 0 }, async (port) => {
		for (let i = 0; i < 5; i++) {
			const r = await post(port, { texto: "x" });
			assert.equal(r.status, 201);
		}
	});
});

test("servidor real: CSRF no aplica sin cookie de sesión (sistema externo)", async () => {
	await withServer(DEMO_SOURCE, {}, async (port) => {
		const res = await post(port, { texto: "x" });
		assert.equal(res.status, 201);
	});
});

test("servidor real: CSRF bloquea con sesión y sin token", async () => {
	await withServer(DEMO_SOURCE, {}, async (port) => {
		const res = await post(port, { texto: "x" }, { Cookie: "wsession=abc" });
		assert.equal(res.status, 403);
	});
});

test("servidor real: CSRF bloquea con token que no coincide", async () => {
	await withServer(DEMO_SOURCE, {}, async (port) => {
		const res = await post(
			port,
			{ texto: "x" },
			{ Cookie: "wsession=abc; wcsrf=correcto", "X-WebScript-CSRF": "incorrecto" }
		);
		assert.equal(res.status, 403);
	});
});

test("servidor real: CSRF deja pasar con token que sí coincide", async () => {
	await withServer(DEMO_SOURCE, {}, async (port) => {
		const res = await post(
			port,
			{ texto: "x" },
			{ Cookie: "wsession=abc; wcsrf=correcto", "X-WebScript-CSRF": "correcto" }
		);
		assert.equal(res.status, 201);
	});
});

const path = require("path");

function postJson(port, pathname, body, headers = {}) {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(body);
		const req = http.request(
			{
				hostname: "localhost",
				port,
				path: pathname,
				method: "POST",
				headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers },
			},
			(res) => {
				let out = "";
				res.on("data", (c) => (out += c));
				res.on("end", () => resolve({ status: res.statusCode, body: out }));
			}
		);
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}

function withServerAt(wsbPath, wconfig, fn) {
	return new Promise((resolve, reject) => {
		const ast = parse(fs.readFileSync(wsbPath, "utf8"));
		const server = createServer(ast, wconfig, { baseDir: path.dirname(wsbPath) });
		server.listen(0, async () => {
			try {
				await fn(server.address().port);
				resolve();
			} catch (err) {
				reject(err);
			} finally {
				server.close();
			}
		});
	});
}

const API_WSB_PATH = path.join(__dirname, "../../src/api.wsb");
const PERSONA_VALIDA = {
	nombre: "Ana",
	edad: 30,
	altura: 1.7,
	mayorEdad: true,
	direccion: { numero: 5, calle: "Mayor" },
	listaPropiedades: ["coche"],
};

test("integración real (api.wsb + import a persona.wson): crea con DTO real, responde 201", async () => {
	await withServerAt(API_WSB_PATH, {}, async (port) => {
		const res = await postJson(port, "/personas", PERSONA_VALIDA);
		assert.equal(res.status, 201);
	});
});

test("integración real: el DTO importado rechaza un tipo inválido con 400 (no 500)", async () => {
	await withServerAt(API_WSB_PATH, {}, async (port) => {
		const res = await postJson(port, "/personas", { ...PERSONA_VALIDA, edad: "treinta" });
		assert.equal(res.status, 400);
		assert.match(JSON.parse(res.body).error, /"edad" debe ser integer/);
	});
});

test("integración real: el DTO importado rechaza un campo obligatorio ausente", async () => {
	await withServerAt(API_WSB_PATH, {}, async (port) => {
		const { mayorEdad, ...sinMayorEdad } = PERSONA_VALIDA;
		const res = await postJson(port, "/personas", sinMayorEdad);
		assert.equal(res.status, 400);
		assert.match(JSON.parse(res.body).error, /obligatorio "mayorEdad"/);
	});
});

test("integración real: el estado de módulo del servidor (visitasSesion) persiste entre peticiones", async () => {
	await withServerAt(API_WSB_PATH, {}, async (port) => {
		// No se expone directamente, pero dos peticiones válidas seguidas no
		// deben fallar por ningún error de estado compartido mal inicializado.
		const r1 = await postJson(port, "/personas", PERSONA_VALIDA);
		const r2 = await postJson(port, "/personas", PERSONA_VALIDA);
		assert.equal(r1.status, 201);
		assert.equal(r2.status, 201);
	});
});

const GET_SOURCE = [
	'const WSON wsonGetPersona =',
	'\t-> to: "/personas/:id"',
	'\t-> via: "GET"',
	"",
	"reactive any peticion = WSON.listen(wsonGetPersona)",
	"",
	"watch(peticion)",
	"\tvar id = WSON.params(peticion).id",
	'\tpeticion.content = { id: id, nombre: "Ana" }',
	"\tWSON.send(peticion)",
].join("\n");

test("GET vía WSON.listen()+watch() funciona igual que POST/PUT/DELETE", async () => {
	await withServer(GET_SOURCE, {}, async (port) => {
		const res = await new Promise((resolve) => {
			http.get(`http://localhost:${port}/personas/42`, (r) => {
				let out = "";
				r.on("data", (c) => (out += c));
				r.on("end", () => resolve({ status: r.statusCode, body: out }));
			});
		});
		assert.equal(res.status, 200);
		assert.deepEqual(JSON.parse(res.body), { id: "42", nombre: "Ana" });
	});
});

test("dos GET a la misma ruta (con distinto nombre de :param) colisionan, igual que POST", () => {
	const source = [
		"const WSON a =",
		'\t-> to: "/x/:id"',
		'\t-> via: "GET"',
		"reactive any p1 = WSON.listen(a)",
		"watch(p1)",
		"\tvar x = 1",
		"",
		"const WSON b =",
		'\t-> to: "/x/:otro"',
		'\t-> via: "GET"',
		"reactive any p2 = WSON.listen(b)",
		"watch(p2)",
		"\tvar x = 2",
	].join("\n");

	assert.throws(() => createServer(parse(source), {}), /Colisión de rutas/);
});

test("GET y POST a la misma ruta NO colisionan (distinto via)", () => {
	const source = [
		"const WSON a =",
		'\t-> to: "/x"',
		'\t-> via: "GET"',
		"reactive any p1 = WSON.listen(a)",
		"watch(p1)",
		"\tvar x = 1",
		"",
		"const WSON b =",
		'\t-> to: "/x"',
		'\t-> via: "POST"',
		"reactive any p2 = WSON.listen(b)",
		"watch(p2)",
		"\tvar x = 2",
	].join("\n");

	assert.doesNotThrow(() => createServer(parse(source), {}));
});

test("integración real (api.wsb): GET y POST conviven en el mismo fichero, vía WSON.listen()", async () => {
	await withServerAt(API_WSB_PATH, {}, async (port) => {
		const postRes = await postJson(port, "/personas", PERSONA_VALIDA);
		assert.equal(postRes.status, 201);

		const getRes = await new Promise((resolve) => {
			http.get(`http://localhost:${port}/personas/42`, (r) => {
				let out = "";
				r.on("data", (c) => (out += c));
				r.on("end", () => resolve({ status: r.statusCode, body: out }));
			});
		});
		assert.equal(getRes.status, 200);
		assert.deepEqual(JSON.parse(getRes.body), { id: "42", nombre: "Ana", edad: 30 });
	});
});

test("serve-demo.js sirve la página y la API desde el mismo origen", async () => {
	const { spawn } = require("child_process");
	const path = require("path");
	const net = require("net");

	// Puerto libre real, en vez de confiar en uno fijo.
	const port = await new Promise((resolve) => {
		const srv = net.createServer();
		srv.listen(0, () => {
			const p = srv.address().port;
			srv.close(() => resolve(p));
		});
	});

	const child = spawn("node", [
		path.join(__dirname, "../serve-demo.js"),
		path.join(__dirname, "../../src/demo-cliente-servidor.wsf"),
		path.join(__dirname, "../../src/demo-servidor.wsb"),
		String(port),
	]);

	try {
		// Esperar a que el proceso hijo esté escuchando de verdad.
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("serve-demo.js no arrancó a tiempo")), 3000);
			child.stdout.on("data", (chunk) => {
				if (chunk.toString().includes("Página + API")) {
					clearTimeout(timeout);
					resolve();
				}
			});
			child.stderr.on("data", (chunk) => reject(new Error(chunk.toString())));
		});

		const pageRes = await new Promise((resolve) => {
			http.get(`http://localhost:${port}/`, (r) => {
				let out = "";
				r.on("data", (c) => (out += c));
				r.on("end", () => resolve({ status: r.statusCode, body: out }));
			});
		});
		assert.equal(pageRes.status, 200);
		assert.match(pageRes.body, /<script>/);

		const apiRes = await postJson(port, "/notas", { texto: "hola desde el test" });
		assert.equal(apiRes.status, 201);
	} finally {
		child.kill();
	}
});

test("colisión de rutas: /x/:id y /x/:otroNombre se detectan como la misma ruta", () => {
	const source = [
		"const WSON a =",
		'\t-> to: "/x/:id"',
		'\t-> via: "POST"',
		"reactive any p1 = WSON.listen(a)",
		"watch(p1)",
		"\tvar x = 1",
		"",
		"const WSON b =",
		'\t-> to: "/x/:otroNombre"',
		'\t-> via: "POST"',
		"reactive any p2 = WSON.listen(b)",
		"watch(p2)",
		"\tvar x = 2",
	].join("\n");

	assert.throws(() => createServer(parse(source), {}), /Colisión de rutas/);
});

test("colisión de rutas: distinto method en la misma ruta NO colisiona", () => {
	const source = [
		"const WSON a =",
		'\t-> to: "/x"',
		'\t-> via: "POST"',
		"reactive any p1 = WSON.listen(a)",
		"watch(p1)",
		"\tvar x = 1",
		"",
		"const WSON b =",
		'\t-> to: "/x"',
		'\t-> via: "DELETE"',
		"reactive any p2 = WSON.listen(b)",
		"watch(p2)",
		"\tvar x = 2",
	].join("\n");

	assert.doesNotThrow(() => createServer(parse(source), {}));
});
