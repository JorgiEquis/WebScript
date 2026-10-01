const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { parse } = require("../parser");
const { createServer, createFileSessionStore, extractSessionStateDecls } = require("../codegen-server");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-filesession-"));
}

test("createFileSessionStore: create() escribe un .json real en disco", () => {
	const dir = tmpDir();
	const ast = parse("var visitas = 0");
	const store = createFileSessionStore(extractSessionStateDecls(ast, []), { "session-dir": "s" }, dir);

	const { id } = store.create();
	const files = fs.readdirSync(path.join(dir, "s"));
	assert.deepEqual(files, [`${id}.json`]);
});

test("createFileSessionStore: get() lee el estado real del fichero, no de memoria", () => {
	const dir = tmpDir();
	const ast = parse("var visitas = 0");
	const store = createFileSessionStore(extractSessionStateDecls(ast, []), { "session-dir": "s" }, dir);

	const { id, session } = store.create();
	session.state.visitas = 7;
	store.save(id, session); // sin esto, el fichero seguiría con el valor inicial

	// Un store NUEVO (simula un proceso distinto) leyendo del mismo dir.
	const otroStore = createFileSessionStore(extractSessionStateDecls(ast, []), { "session-dir": "s" }, dir);
	assert.equal(otroStore.get(id).state.visitas, 7);
});

test("createFileSessionStore: sin save(), la mutación en memoria no se refleja en disco", () => {
	const dir = tmpDir();
	const ast = parse("var visitas = 0");
	const store = createFileSessionStore(extractSessionStateDecls(ast, []), { "session-dir": "s" }, dir);

	const { id, session } = store.create();
	session.state.visitas = 7; // muta el objeto en memoria, pero no llama a save()

	const relectura = store.get(id);
	assert.equal(relectura.state.visitas, 0); // el fichero no se enteró
});

test("createFileSessionStore: expiración por inactividad borra el fichero", async () => {
	const dir = tmpDir();
	const ast = parse("var visitas = 0");
	const store = createFileSessionStore(extractSessionStateDecls(ast, []), { "session-dir": "s", "session-timeout-ms": 10 }, dir);

	const { id } = store.create();
	await new Promise((r) => setTimeout(r, 30));

	assert.equal(store.get(id), null);
	assert.equal(fs.existsSync(path.join(dir, "s", `${id}.json`)), false);
});

test("createFileSessionStore: desalojo LRU borra el fichero más antiguo", () => {
	const dir = tmpDir();
	const ast = parse("var visitas = 0");
	const store = createFileSessionStore(extractSessionStateDecls(ast, []), { "session-dir": "s", "session-max": 2 }, dir);

	const a = store.create();
	const b = store.create();
	const c = store.create();

	assert.equal(store.get(a.id), null);
	assert.ok(store.get(b.id));
	assert.ok(store.get(c.id));
});

// --- La prueba que de verdad importa: sobrevive a un reinicio real -------

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

const SESSION_SOURCE = [
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
	"\tWSON.httpSend(peticion)",
].join("\n");

async function startServer(sessionDir) {
	const server = createServer(parse(SESSION_SOURCE), { "session-store": "file", "session-dir": sessionDir });
	await new Promise((resolve, reject) => {
		server.listen(0, resolve);
		server.on("error", reject);
	});
	return server;
}

test("integración real: el guardado ocurre ANTES de responder, no en un tick posterior (si el proceso muriera justo tras la respuesta, la sesión ya estaría a salvo)", async () => {
	const dir = tmpDir();
	const server = await startServer(dir);
	try {
		const port = server.address().port;
		const r1 = await postWithCookie(port, "/visita", {}, null);
		const wsession = extractCookie(r1.headers["set-cookie"], "wsession");
		const wcsrf = extractCookie(r1.headers["set-cookie"], "wcsrf");

		const r2 = await postWithCookie(port, "/visita", {}, `wsession=${wsession}`, wcsrf);
		assert.deepEqual(JSON.parse(r2.body), { visitas: 2 });

		// Comprobación directa del fichero, SIN pasar por el store en
		// memoria del proceso — si el guardado fuera asíncrono/posterior a
		// la respuesta, esta lectura podría pillarlo a medias.
		const files = fs.readdirSync(path.join(dir)).filter((f) => f.endsWith(".json"));
		const onDisk = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
		assert.equal(onDisk.state.visitas, 2);
	} finally {
		server.close();
	}
});

test("integración real: la sesión sobrevive a un REINICIO real del servidor (backend de fichero)", async () => {
	const dir = tmpDir();

	// --- "Proceso 1": arranca, dos peticiones, se cierra ---
	const server1 = await startServer(dir);
	let wsession;
	let wcsrf;
	try {
		const port1 = server1.address().port;
		const r1 = await postWithCookie(port1, "/visita", {}, null);
		assert.deepEqual(JSON.parse(r1.body), { visitas: 1 });
		wsession = extractCookie(r1.headers["set-cookie"], "wsession");
		wcsrf = extractCookie(r1.headers["set-cookie"], "wcsrf");

		const r2 = await postWithCookie(port1, "/visita", {}, `wsession=${wsession}`, wcsrf);
		assert.deepEqual(JSON.parse(r2.body), { visitas: 2 });
	} finally {
		server1.close();
	}

	// --- "Proceso 2": servidor NUEVO, mismo directorio de sesiones ---
	const server2 = await startServer(dir);
	try {
		const port2 = server2.address().port;
		const r3 = await postWithCookie(port2, "/visita", {}, `wsession=${wsession}`, wcsrf);
		// La cuenta sigue en 3, no vuelve a 1 — el reinicio no borró la sesión.
		assert.deepEqual(JSON.parse(r3.body), { visitas: 3 });
	} finally {
		server2.close();
	}
});

test("integración real: por defecto (sin session-store), las sesiones NO sobreviven a un reinicio (memoria)", async () => {
	const source = SESSION_SOURCE;

	const server1 = createServer(parse(source), {}); // sin file store: memoria, como antes
	let wsession;
	let wcsrf;
	await new Promise((resolve) => server1.listen(0, resolve));
	try {
		const port1 = server1.address().port;
		const r1 = await postWithCookie(port1, "/visita", {}, null);
		assert.deepEqual(JSON.parse(r1.body), { visitas: 1 });
		wsession = extractCookie(r1.headers["set-cookie"], "wsession");
		wcsrf = extractCookie(r1.headers["set-cookie"], "wcsrf");
	} finally {
		server1.close();
	}

	const server2 = createServer(parse(source), {}); // "reinicio": nueva instancia, memoria vacía
	await new Promise((resolve) => server2.listen(0, resolve));
	try {
		const port2 = server2.address().port;
		// La cookie ya no corresponde a ninguna sesión conocida por este
		// proceso nuevo -> se trata como sesión nueva, vuelve a empezar en 1.
		const r2 = await postWithCookie(port2, "/visita", {}, `wsession=${wsession}`, wcsrf);
		assert.deepEqual(JSON.parse(r2.body), { visitas: 1 });
	} finally {
		server2.close();
	}
});
