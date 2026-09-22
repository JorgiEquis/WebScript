const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { parse } = require("../parser");
const {
	createSessionStore,
	extractSessionStateDecls,
	instantiateSessionState,
	parseCookies,
	isRequestSecure,
	createServer,
} = require("../codegen-server");

test("parseCookies: parsea varias cookies separadas por ;", () => {
	const cookies = parseCookies("wsession=abc123; wcsrf=xyz789; otra=valor");
	assert.equal(cookies.wsession, "abc123");
	assert.equal(cookies.wcsrf, "xyz789");
});

test("parseCookies: sin cabecera, devuelve objeto vacío", () => {
	assert.deepEqual(parseCookies(undefined), {});
});

test("isRequestSecure: true si el socket está cifrado", () => {
	assert.equal(isRequestSecure({ socket: { encrypted: true }, headers: {} }), true);
});

test("isRequestSecure: true si X-Forwarded-Proto es https (detrás de un proxy)", () => {
	assert.equal(isRequestSecure({ socket: {}, headers: { "x-forwarded-proto": "https" } }), true);
});

test("isRequestSecure: false en HTTP plano sin proxy", () => {
	assert.equal(isRequestSecure({ socket: {}, headers: {} }), false);
});

test("instantiateSessionState: evalúa el valor inicial de cada declaración", () => {
	const ast = parse('var visitas = 0\nvar nombre = "invitado"');
	const state = instantiateSessionState(ast.body);
	assert.equal(state.visitas, 0);
	assert.equal(state.nombre, "invitado");
});

test("createSessionStore: create() da sesiones con estado independiente", () => {
	const ast = parse("var visitas = 0");
	const store = createSessionStore(ast.body, {});

	const a = store.create();
	const b = store.create();
	a.session.state.visitas = 5;

	assert.equal(a.session.state.visitas, 5);
	assert.equal(b.session.state.visitas, 0); // no comparte estado con "a"
});

test("createSessionStore: get() devuelve la MISMA sesión (estado persiste) mientras no expire", () => {
	const ast = parse("var visitas = 0");
	const store = createSessionStore(ast.body, {});
	const { id } = store.create();

	store.get(id).state.visitas = 3;
	assert.equal(store.get(id).state.visitas, 3);
});

test("createSessionStore: expiración por inactividad", async () => {
	const ast = parse("var visitas = 0");
	const store = createSessionStore(ast.body, { "session-timeout-ms": 10 });
	const { id } = store.create();

	await new Promise((r) => setTimeout(r, 30));
	assert.equal(store.get(id), null);
});

test("createSessionStore: desalojo LRU al superar session-max", () => {
	const ast = parse("var visitas = 0");
	const store = createSessionStore(ast.body, { "session-max": 2 });

	const a = store.create();
	const b = store.create();
	const c = store.create(); // debería desalojar "a" (la más antigua)

	assert.equal(store.get(a.id), null);
	assert.ok(store.get(b.id));
	assert.ok(store.get(c.id));
});

// --- Integración real con el servidor -------------------------------------

function postWithCookie(port, pathname, body, cookie, csrfToken) {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(body);
		const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) };
		if (cookie) headers.Cookie = cookie;
		if (csrfToken) headers["X-WebScript-CSRF"] = csrfToken;
		const req = http.request({ hostname: "localhost", port, path: pathname, method: "POST", headers }, (res) => {
			let out = "";
			res.on("data", (c) => (out += c));
			res.on("end", () => resolve({ status: res.statusCode, body: out, headers: res.headers }));
		});
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}

function extractCookie(setCookieHeaders, name) {
	const line = (setCookieHeaders || []).find((c) => c.startsWith(`${name}=`));
	return line ? line.split(";")[0].split("=")[1] : null;
}

const SESSION_DEMO_SOURCE = [
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

test("integración real: dos visitantes sin cookie tienen estado de sesión independiente", async () => {
	const server = createServer(parse(SESSION_DEMO_SOURCE), {});
	try {
		await new Promise((resolve, reject) => {
			server.listen(0, resolve);
			server.on("error", reject);
		});
		const port = server.address().port;

		const visitanteA1 = await postWithCookie(port, "/visita", {}, null);
		const visitanteB1 = await postWithCookie(port, "/visita", {}, null);

		assert.deepEqual(JSON.parse(visitanteA1.body), { visitas: 1 });
		assert.deepEqual(JSON.parse(visitanteB1.body), { visitas: 1 }); // no ve la visita de A
	} finally {
		server.close();
	}
});

test("integración real: el mismo visitante (misma cookie de sesión) acumula su propio estado", async () => {
	const server = createServer(parse(SESSION_DEMO_SOURCE), {});
	try {
		await new Promise((resolve, reject) => {
			server.listen(0, resolve);
			server.on("error", reject);
		});
		const port = server.address().port;

		const r1 = await postWithCookie(port, "/visita", {}, null);
		const wsession = extractCookie(r1.headers["set-cookie"], "wsession");
		const wcsrf = extractCookie(r1.headers["set-cookie"], "wcsrf");
		assert.deepEqual(JSON.parse(r1.body), { visitas: 1 });

		const cookie = `wsession=${wsession}`;
		const r2 = await postWithCookie(port, "/visita", {}, cookie, wcsrf);
		assert.deepEqual(JSON.parse(r2.body), { visitas: 2 });

		const r3 = await postWithCookie(port, "/visita", {}, cookie, wcsrf);
		assert.deepEqual(JSON.parse(r3.body), { visitas: 3 });
	} finally {
		server.close();
	}
});
