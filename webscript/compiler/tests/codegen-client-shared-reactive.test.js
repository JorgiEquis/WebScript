// Lado cliente de `shared global reactive`: el import de un `.wsb` ya solo
// se permite para nombres `shared` (ver tests existentes de ese rechazo
// específico); aquí se prueba que, una vez importada, el bundle generado
// de verdad trae la conexión WebSocket, la suscripción, la aplicación de
// cada "update" sobre `state`, y que una ESCRITURA se reescribe en una
// llamada a `__proposeShared` en vez de mutar `state` directamente.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { parse } = require("../parser");
const { generateClientBundle, substituteReactive } = require("../codegen-client");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-shared-client-"));
}

function crear(dir, ficheros) {
	for (const [nombre, contenido] of Object.entries(ficheros)) {
		fs.writeFileSync(path.join(dir, nombre), Array.isArray(contenido) ? contenido.join("\n") : contenido);
	}
}

test("REGRESIÓN (el bug real encontrado al probarlo): substituteReactive ya sustituye una lectura dentro de un spread (`{ ...nombre }`) — antes, el punto final de '...' bloqueaba la sustitución igual que un acceso a propiedad", () => {
	assert.equal(substituteReactive("{ ...cursores, x: 1 }", ["cursores"]), "{ ...state.cursores, x: 1 }");
	// no debe romper los casos que ya funcionaban:
	assert.equal(substituteReactive("state.cursores", ["cursores"]), "state.cursores", "un acceso YA cualificado no se vuelve a prefijar");
	assert.equal(substituteReactive("foo.cursores", ["cursores"]), "foo.cursores", "una propiedad de OTRA cosa no se toca");
	assert.equal(substituteReactive("{ cursores: 1 }", ["cursores"]), "{ cursores: 1 }", "una CLAVE de objeto no se toca");
	assert.equal(substituteReactive("cursores + 1", ["cursores"]), "state.cursores + 1", "una lectura suelta sigue sustituyéndose");
});

test("REGRESIÓN nueva capacidad: importar una shared reactive emite la conexión WebSocket, la suscripción y el manejo de 'update'", () => {
	const dir = tmpDir();
	crear(dir, { "servidor.wsb": "shared global reactive contador = 0" });
	const wsf = ['import { contador } from "./servidor.wsb"', "", "<p>{contador}</p>"].join("\n");
	const bundle = generateClientBundle(parse(wsf), { baseDir: dir });
	assert.match(bundle, /const __sharedNames = \["contador"\];/);
	assert.match(bundle, /new WebSocket\(/);
	assert.match(bundle, /type: "subscribe", name: __n/);
	assert.match(bundle, /state\[__msg\.name\] = __msg\.value/);
});

test("REGRESIÓN nueva capacidad: una ESCRITURA sobre la shared se reescribe a __proposeShared, NUNCA a una mutación directa de state", () => {
	const dir = tmpDir();
	crear(dir, { "servidor.wsb": "shared global reactive contador = 0" });
	const wsf = ['import { contador } from "./servidor.wsb"', "", "<button onclick={contador = contador + 1}>+1</button>"].join("\n");
	const bundle = generateClientBundle(parse(wsf), { baseDir: dir });
	assert.match(bundle, /__proposeShared\("contador", \(state\.contador \+ 1\)\)/);
	assert.doesNotMatch(bundle, /\bstate\.contador\s*=(?!=)/, "no debe quedar ninguna asignación directa sin reescribir");
});

test("REGRESIÓN nueva capacidad: una escritura que a la vez LEE la propia shared (un spread, como en el ejemplo real de la pizarra) reescribe la lectura Y la escritura correctamente", () => {
	const dir = tmpDir();
	crear(dir, { "servidor.wsb": "shared global reactive cursores = {}" });
	const wsf = ['import { cursores } from "./servidor.wsb"', "", "<button onclick={cursores = { ...cursores, yo: { x: 10, y: 20 } }}>marcar</button>"].join(
		"\n"
	);
	const bundle = generateClientBundle(parse(wsf), { baseDir: dir });
	assert.match(bundle, /__proposeShared\("cursores", \(\{ \.\.\.state\.cursores, yo: \{ x: 10, y: 20 \} \}\)\)/);
});

test("NO REGRESIÓN: sin ninguna shared reactive importada, no se emite ningún código de WebSocket de más", () => {
	const bundle = generateClientBundle(parse("<p>hola</p>"), {});
	assert.doesNotMatch(bundle, /__sharedNames/);
	assert.doesNotMatch(bundle, /__proposeShared/);
});

test("NO REGRESIÓN: generateClientBundle sin baseDir (sin imports en absoluto) sigue funcionando — el campo nuevo no rompe el camino sin imports", () => {
	const bundle = generateClientBundle(parse("<p>hola</p>"));
	assert.match(bundle, /<p>hola<\/p>|appendChild/);
});
