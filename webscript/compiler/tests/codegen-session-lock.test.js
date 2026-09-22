const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { parse } = require("../parser");
const { acquireFileLock, releaseFileLock, createServer, createFileSessionStore, extractSessionStateDecls } = require("../codegen-server");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-lock-"));
}

test("acquireFileLock: adquiere un lock libre de inmediato", async () => {
	const dir = tmpDir();
	const lockPath = path.join(dir, "s.lock");
	await acquireFileLock(lockPath);
	assert.ok(fs.existsSync(lockPath));
	releaseFileLock(lockPath);
});

test("acquireFileLock: un segundo intento ESPERA hasta que el primero se libera", async () => {
	const dir = tmpDir();
	const lockPath = path.join(dir, "s.lock");
	await acquireFileLock(lockPath);

	let segundoAdquirido = false;
	const segundo = acquireFileLock(lockPath, { timeoutMs: 2000, retryDelayMs: 10 }).then(() => {
		segundoAdquirido = true;
	});

	await new Promise((r) => setTimeout(r, 100));
	assert.equal(segundoAdquirido, false); // sigue esperando

	releaseFileLock(lockPath);
	await segundo;
	assert.equal(segundoAdquirido, true);

	releaseFileLock(lockPath);
});

test("acquireFileLock: un lock abandonado (más antiguo que staleMs) se fuerza sin esperar el timeout completo", async () => {
	const dir = tmpDir();
	const lockPath = path.join(dir, "s.lock");
	fs.writeFileSync(lockPath, "99999", { flag: "wx" });
	const antiguo = (Date.now() - 10000) / 1000;
	fs.utimesSync(lockPath, antiguo, antiguo);

	const inicio = Date.now();
	await acquireFileLock(lockPath, { staleMs: 5000, timeoutMs: 3000, retryDelayMs: 20 });
	assert.ok(Date.now() - inicio < 500); // no llegó a esperar el timeout de 3000ms
});

test("acquireFileLock: si nadie lo libera y no está obsoleto, lanza tras agotar el timeout", async () => {
	const dir = tmpDir();
	const lockPath = path.join(dir, "s.lock");
	fs.writeFileSync(lockPath, "99999", { flag: "wx" }); // recién creado: no es obsoleto

	await assert.rejects(() => acquireFileLock(lockPath, { staleMs: 60000, timeoutMs: 100, retryDelayMs: 10 }));
});

test("createFileSessionStore: lock() sin id (sesión aún sin cookie) es un no-op inmediato", async () => {
	const dir = tmpDir();
	const ast = parse("var visitas = 0");
	const store = createFileSessionStore(extractSessionStateDecls(ast, []), {}, dir);

	const release = await store.lock(undefined);
	release(); // no debe lanzar ni bloquear nada
});

// --- La prueba que de verdad importa: concurrencia real, sin pérdidas ----

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
	"\tWSON.send(peticion)",
].join("\n");

test(
	"integración real: 20 peticiones CONCURRENTES para la misma sesión no pierden ningún incremento",
	{ timeout: 20000 },
	async () => {
		const dir = tmpDir();
		const server = createServer(parse(SESSION_SOURCE), { "session-store": "file", "session-dir": dir });
		try {
			await new Promise((resolve, reject) => {
				server.listen(0, resolve);
				server.on("error", reject);
			});
			const port = server.address().port;

			const r0 = await post(port, null, null);
			const wsession = extractCookie(r0.headers["set-cookie"], "wsession");
			const wcsrf = extractCookie(r0.headers["set-cookie"], "wcsrf");
			assert.deepEqual(JSON.parse(r0.body), { visitas: 1 });

			const N = 20;
			const resultados = await Promise.all(
				Array.from({ length: N }, () => post(port, `wsession=${wsession}`, wcsrf))
			);
			const valores = resultados.map((r) => JSON.parse(r.body).visitas).sort((a, b) => a - b);
			const esperados = Array.from({ length: N }, (_, i) => i + 2); // 2..21, sin huecos ni repetidos

			assert.deepEqual(valores, esperados);
		} finally {
			server.close();
		}
	}
);
