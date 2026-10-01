const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { parse } = require("../parser");
const { createServer, substituteServerState } = require("../codegen-server");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-substitute-state-"));
}

function postJson(port, pathname, body) {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(body);
		const req = http.request(
			{ port, path: pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
			(r) => {
				let out = "";
				r.on("data", (c) => (out += c));
				r.on("end", () => resolve({ status: r.statusCode, body: out }));
			}
		);
		req.on("error", reject);
		req.end(data);
	});
}

// --- Unitarios: substituteServerState ---------------------------------

test("substituteServerState: NO toca el contenido de un string ni de un template literal (el bug original)", () => {
	assert.equal(substituteServerState('var mensaje = "persona creada";', ["persona"]), 'var mensaje = "persona creada";');
	assert.equal(
		substituteServerState("var mensaje = `hola ${persona.nombre}, persona`;", ["persona"]),
		"var mensaje = `hola ${serverState.persona.nombre}, persona`;"
	);
});

test("substituteServerState: sustituye una reasignación real de la reactive (el caso crítico de la cascada)", () => {
	assert.equal(substituteServerState("persona = Persona.save(x);", ["persona"]), "serverState.persona = Persona.save(x);");
	assert.equal(substituteServerState("contador += 1;", ["contador"]), "serverState.contador += 1;");
	assert.equal(substituteServerState("foo.persona = 5;", ["foo"]), "serverState.foo.persona = 5;");
});

test("substituteServerState: no toca la propiedad de un acceso a miembro, sí su objeto", () => {
	assert.equal(substituteServerState("var x = foo.persona;", ["persona"]), "var x = foo.persona;");
	assert.equal(substituteServerState("var x = persona.nombre;", ["persona"]), "var x = serverState.persona.nombre;");
});

test("substituteServerState: en un objeto literal, la clave no se toca pero el valor sí — incluida la forma abreviada", () => {
	assert.equal(substituteServerState("var o = { persona: persona, otra: 1 };", ["persona"]), "var o = { persona: serverState.persona, otra: 1 };");
	// Antes (con regex) esto se dejaba tal cual, tratando el valor como si
	// fuera una clave — lo que habría producido un ReferenceError en
	// tiempo de ejecución.
	assert.equal(substituteServerState("var o = { persona, otra: 1 };", ["persona"]), "var o = { persona: serverState.persona, otra: 1 };");
	assert.equal(substituteServerState("var o = { [persona]: 1 };", ["persona"]), "var o = { [serverState.persona]: 1 };");
});

test("substituteServerState: es correcto sin importar el formato (multilínea, clave en línea distinta a la llave)", () => {
	assert.equal(substituteServerState("var o = {\n  persona: 1\n};", ["persona"]), "var o = {\n  persona: 1\n};");
	assert.equal(substituteServerState("if (x) {\n  persona\n}", ["persona"]), "if (x) {\n  serverState.persona\n}");
});

test("substituteServerState: una declaración o un parámetro con el mismo nombre no se toca (variable local nueva, no la reactive)", () => {
	assert.equal(substituteServerState("const persona = interno;", ["persona"]), "const persona = interno;");
	assert.equal(substituteServerState("function f(persona) {}", ["persona"]), "function f(persona) {}");
	assert.equal(substituteServerState("try {} catch (persona) {}", ["persona"]), "try {} catch (persona) {}");
});

test("substituteServerState: un patrón de desestructuración no se toca (declarar, no leer)", () => {
	assert.equal(substituteServerState("const { persona } = journeyData;", ["persona"]), "const { persona } = journeyData;");
	assert.equal(substituteServerState("function f({ persona }) {}", ["persona"]), "function f({ persona }) {}");
});

test("substituteServerState: una etiqueta de break/continue homónima no se toca", () => {
	assert.equal(
		substituteServerState("persona: while (true) { break persona; }", ["persona"]),
		"persona: while (true) { break persona; }"
	);
});

test("substituteServerState: si el texto no es JS completo por sí solo, no revienta — cae al mecanismo antiguo como red de seguridad (con sus mismas limitaciones)", () => {
	// No debería ocurrir en la práctica (genHandlerBody siempre ensambla
	// el cuerpo entero antes de llamar a esto) — esto solo comprueba que
	// un fragmento inválido por sí solo no hace fallar la función. El
	// mecanismo antiguo, usado aquí como red de seguridad, conserva su
	// propia limitación conocida (una "persona" justo después de "{ " se
	// trata como si fuera una clave y se deja sin sustituir) — es la
	// misma heurística de siempre, no algo nuevo de esta reescritura.
	assert.equal(substituteServerState("else { persona.foo() }", ["persona"]), "else { persona.foo() }");
	assert.equal(substituteServerState("else { console.log(persona) }", ["persona"]), "else { console.log(serverState.persona) }");
});

// --- Integración real por HTTP -----------------------------------------

test("REGRESIÓN: un mensaje que contiene, como palabra suelta, el nombre de una reactive no se corrompe", async () => {
	const dir = tmpDir();
	fs.writeFileSync(
		path.join(dir, "api.wsb"),
		[
			"const WSON wsonGuardar =",
			'\t-> to: "/personas"',
			'\t-> via: "POST"',
			"",
			"reactive any peticionGuardar = WSON.listen(wsonGuardar)",
			"",
			"reactive any persona = null",
			"",
			"watch(persona)",
			'\tconsole.log("comprobaciones con", persona.nombre)',
			"",
			"watch(peticionGuardar)",
			"\tpersona = WSON.showContent(peticionGuardar)",
			'\tpeticionGuardar.content = { mensaje: "persona " + persona.nombre + " creada y validada" }',
			"\tWSON.httpSend(peticionGuardar)",
		].join("\n")
	);

	const server = createServer(parse(fs.readFileSync(path.join(dir, "api.wsb"), "utf8")), {}, { baseDir: dir });
	try {
		await new Promise((resolve) => server.listen(0, resolve));
		const port = server.address().port;
		const r = await postJson(port, "/personas", { nombre: "Ana" });
		assert.deepEqual(JSON.parse(r.body), { mensaje: "persona Ana creada y validada" });
	} finally {
		server.close();
	}
});
