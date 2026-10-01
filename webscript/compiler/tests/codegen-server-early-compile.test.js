const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { execFileSync } = require("child_process");
const { parse } = require("../parser");
const { createServer } = require("../codegen-server");

const WEBSC_BIN = path.join(__dirname, "../bin/websc.js");

const SOURCE_CON_ERROR = [
	"const WSON wsonAlgo =",
	'\t-> to: "/algo"',
	'\t-> via: "GET"',
	"",
	"reactive any peticion = WSON.listen(wsonAlgo)",
	"",
	"watch(peticion)",
	"\testo no es JS valido en absoluto ///// $$$",
	"\tWSON.httpSend(peticion)",
].join("\n");

test("REGRESIÓN bug real: un error de sintaxis en watch() se detecta al CREAR el servidor, no en la primera petición", () => {
	assert.throws(() => createServer(parse(SOURCE_CON_ERROR), {}), /SyntaxError|Unexpected/);
});

test("una ruta sin errores sigue funcionando con normalidad tras compilar una vez al arrancar (no en cada petición)", async () => {
	const source = [
		"const WSON wsonAlgo =",
		'\t-> to: "/algo"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonAlgo)",
		"",
		"watch(peticion)",
		"\tpeticion.content = { ok: true }",
		"\tWSON.httpSend(peticion)",
	].join("\n");

	const server = createServer(parse(source), {});
	try {
		await new Promise((resolve, reject) => {
			server.listen(0, resolve);
			server.on("error", reject);
		});
		const port = server.address().port;

		function get() {
			return new Promise((resolve, reject) => {
				http.get(`http://localhost:${port}/algo`, (r) => {
					let out = "";
					r.on("data", (c) => (out += c));
					r.on("end", () => resolve(out));
				}).on("error", reject);
			});
		}

		assert.deepEqual(JSON.parse(await get()), { ok: true });
		assert.deepEqual(JSON.parse(await get()), { ok: true });
	} finally {
		server.close();
	}
});

test("integración real: websc build falla con un mensaje limpio (sin traza cruda) si hay un error de sintaxis en un watch()", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "websc-syntax-error-"));
	execFileSync("node", [WEBSC_BIN, "init", dir], { encoding: "utf8" });
	fs.writeFileSync(path.join(dir, "src", "api.wsb"), SOURCE_CON_ERROR);

	assert.throws(
		() => execFileSync("node", [WEBSC_BIN, "build", dir], { encoding: "utf8" }),
		(err) => {
			assert.equal(err.status, 1);
			assert.match(err.stderr.toString(), /^Error: /);
			assert.doesNotMatch(err.stderr.toString(), /at new Function|at Object\.<anonymous>/);
			return true;
		}
	);
});

test("integración real: websc build detecta un typo de variable de servidor con un mensaje limpio, señalando el nombre exacto", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "websc-typo-"));
	execFileSync("node", [WEBSC_BIN, "init", dir], { encoding: "utf8" });
	fs.writeFileSync(
		path.join(dir, "src", "api.wsb"),
		[
			"var contador = 0",
			"",
			"const WSON wsonAlgo =",
			'\t-> to: "/algo"',
			'\t-> via: "GET"',
			"",
			"reactive any peticion = WSON.listen(wsonAlgo)",
			"",
			"watch(peticion)",
			"\tcontadr = contadr + 1",
			"\tpeticion.content = { contador: contador }",
			"\tWSON.httpSend(peticion)",
		].join("\n")
	);

	assert.throws(
		() => execFileSync("node", [WEBSC_BIN, "build", dir], { encoding: "utf8" }),
		(err) => {
			assert.equal(err.status, 1);
			assert.match(err.stderr.toString(), /"contadr"/);
			return true;
		}
	);
});
