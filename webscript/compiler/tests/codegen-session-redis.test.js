const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { parse } = require("../parser");
const { createRedisSessionStore, extractSessionStateDecls, createServer } = require("../codegen-server");

// Estos tests necesitan un Redis real en localhost:6379. Si no está
// disponible (no instalado, o no arrancado), se detecta una vez al
// principio y se saltan todos — no fallan la suite entera por un servicio
// externo que puede no estar presente en cualquier máquina/CI.
let redisDisponible = false;

before(async () => {
	try {
		// eslint-disable-next-line global-require
		const redisModule = require("redis");
		const probeClient = redisModule.createClient({
			url: "redis://localhost:6379",
			socket: { connectTimeout: 500, reconnectStrategy: false },
		});
		probeClient.on("error", () => {});
		await probeClient.connect();
		await probeClient.ping();
		await probeClient.quit();
		redisDisponible = true;
	} catch {
		redisDisponible = false;
	}
});

test("createRedisSessionStore: create()+get() persisten de verdad en Redis, visibles desde OTRO store (simula otro proceso)", async (t) => {
	if (!redisDisponible) return t.skip("Redis no disponible en localhost:6379");

	const ast = parse("var visitas = 0");
	const decls = extractSessionStateDecls(ast, []);
	const store = createRedisSessionStore(decls, {});
	const otroStore = createRedisSessionStore(decls, {}); // simula un proceso distinto, mismo Redis

	try {
		const { id, session } = await store.create();
		session.state.visitas = 5;
		await store.save(id, session);

		const releida = await otroStore.get(id);
		assert.equal(releida.state.visitas, 5);
	} finally {
		await store.close();
		await otroStore.close();
	}
});

test("createRedisSessionStore: lock() espera de verdad hasta que se libera (a través de la red)", async (t) => {
	if (!redisDisponible) return t.skip("Redis no disponible en localhost:6379");

	const ast = parse("var visitas = 0");
	const store = createRedisSessionStore(extractSessionStateDecls(ast, []), {});

	try {
		const { id } = await store.create();
		const release1 = await store.lock(id);

		let lock2Adquirido = false;
		const p2 = store.lock(id).then((r) => {
			lock2Adquirido = true;
			return r;
		});

		await new Promise((r) => setTimeout(r, 150));
		assert.equal(lock2Adquirido, false);

		await release1();
		const release2 = await p2;
		assert.equal(lock2Adquirido, true);
		await release2();
	} finally {
		await store.close();
	}
});

test(
	"integración real: servidor con session-store 'redis', 20 peticiones concurrentes sin pérdidas",
	{ timeout: 20000 },
	async (t) => {
		if (!redisDisponible) return t.skip("Redis no disponible en localhost:6379");

		const source = [
			"var visitas = 0",
			"",
			"const WSON wsonVisita =",
			'\t-> to: "/visita"',
			'\t-> via: "POST"',
			"",
			"reactive any peticion = WSON.listen(wsonVisita)",
			"",
			"watch(peticion)",
			"\tvisitas++",
			"\tpeticion.content = { visitas: visitas }",
			"\tWSON.send(peticion)",
		].join("\n");

		const server = createServer(parse(source), { "session-store": "redis" });

		function post(port, cookie, csrf) {
			return new Promise((resolve, reject) => {
				const data = "{}";
				const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) };
				if (cookie) headers.Cookie = cookie;
				if (csrf) headers["X-WebScript-CSRF"] = csrf;
				const req = http.request({ hostname: "localhost", port, path: "/visita", method: "POST", headers }, (res) => {
					let out = "";
					res.on("data", (c) => (out += c));
					res.on("end", () => resolve({ status: res.statusCode, body: out, headers: res.headers }));
				});
				req.on("error", reject);
				req.write(data);
				req.end();
			});
		}
		function extractCookie(h, name) {
			const line = (h || []).find((c) => c.startsWith(`${name}=`));
			return line ? line.split(";")[0].split("=")[1] : null;
		}

		try {
			await new Promise((resolve, reject) => {
				server.listen(0, resolve);
				server.on("error", reject);
			});
			const port = server.address().port;

			const r0 = await post(port, null, null);
			assert.deepEqual(JSON.parse(r0.body), { visitas: 1 });
			const wsession = extractCookie(r0.headers["set-cookie"], "wsession");
			const wcsrf = extractCookie(r0.headers["set-cookie"], "wcsrf");

			const N = 20;
			const resultados = await Promise.all(Array.from({ length: N }, () => post(port, `wsession=${wsession}`, wcsrf)));
			const valores = resultados.map((r) => JSON.parse(r.body).visitas).sort((a, b) => a - b);
			assert.deepEqual(
				valores,
				Array.from({ length: N }, (_, i) => i + 2)
			);
		} finally {
			server.close();
			await server.sessionStore.close();
		}
	}
);
