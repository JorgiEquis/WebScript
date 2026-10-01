// Una `function` exportada por un `.wsb` (importada por otro `.wsb`) se
// compilaba SOLA y AISLADA (`compileFunctionDecl`) — sin ver ni sus propios
// imports (`doble is not defined` al llamar a algo que ese `.wsb` importa)
// ni sus hermanas del mismo fichero (helpers internos, u otra function
// exportada). Reproducido contra el código anterior antes de corregirlo:
// los tests marcados REGRESIÓN fallan allí.
//
// Diseño (ver DISEÑO.md, "Constantes hermanas..." y la sección de la
// function exportada por un `.wsb`): se resuelve como una entrada más del
// MISMO registro que ya usan los `.ws` (`getWsEntry`/`compileWsRegistry`) —
// mismo ámbito privado por fichero, mismo "todas las function del fichero
// se compilan juntas". La diferencia real con un `.ws`: un `.wsb` SÍ puede
// tener su propio estado de servidor (global, sesión, rutas), así que:
// - Se compila SIEMPRE sin `global` (nunca con el del `.wsb` raíz que
//   importa, para evitar una coincidencia de nombre que "funcionara" por
//   casualidad y resolviera mal en silencio).
// - Si una function ALCANZABLE (la pedida, o algo que ella llama,
//   transitivamente) menciona por nombre una reactive/var/const de nivel
//   superior de SU PROPIO fichero, es un error explícito al compilar — la
//   pregunta de diseño (contra qué estado compilarla) sigue sin resolver
//   ahí, así que se rechaza con claridad en vez de un `ReferenceError`
//   confuso en producción.
// - Sus imports hacia OTRO `.wsb` no se resuelven (encadenaría la misma
//   ambigüedad un nivel más allá): si una function realmente lo necesita,
//   falla en tiempo de EJECUCIÓN con "X is not defined", igual de claro
//   que cualquier otro nombre sin resolver.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { parse } = require("../parser");
const { createServer } = require("../codegen-server");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-wsb-exported-fn-"));
}

function crear(dir, ficheros) {
	for (const [nombre, contenido] of Object.entries(ficheros)) {
		const destino = path.join(dir, nombre);
		fs.mkdirSync(path.dirname(destino), { recursive: true });
		fs.writeFileSync(destino, Array.isArray(contenido) ? contenido.join("\n") : contenido);
	}
}

function get(port, pathname) {
	return new Promise((resolve, reject) => {
		http.get(`http://localhost:${port}${pathname}`, (r) => {
			let out = "";
			r.on("data", (c) => (out += c));
			r.on("end", () => resolve({ status: r.statusCode, body: out }));
		}).on("error", reject);
	});
}

function unaRuta(nombreFn, expr) {
	return [
		`import { ${nombreFn} } from "./otro.wsb"`,
		"",
		"const WSON wsonProbar =",
		'\t-> to: "/probar"',
		'\t-> via: "GET"',
		"",
		"reactive any peticionProbar = WSON.listen(wsonProbar)",
		"",
		"watch(peticionProbar)",
		`\tpeticionProbar.content = { r: ${expr} }`,
		"\tWSON.httpSend(peticionProbar)",
	].join("\n");
}

async function conServidor(dir, src, fn) {
	const server = createServer(parse(src), {}, { baseDir: dir });
	await new Promise((resolve) => server.listen(0, resolve));
	try {
		await fn(server);
	} finally {
		server.close();
	}
}

test("REGRESIÓN (el caso reportado): una function exportada por un .wsb puede llamar a lo que ESE .wsb importa", async () => {
	const dir = tmpDir();
	crear(dir, {
		"util.ws": ["export function doble(x)", "\treturn x * 2"],
		"otro.wsb": ['import { doble } from "./util.ws"', "", "export function usaDoble(x)", "\treturn doble(x)"],
	});
	await conServidor(dir, unaRuta("usaDoble", "usaDoble(5)"), async (server) => {
		const r = await get(server.address().port, "/probar");
		assert.equal(r.body, '{"r":10}', "antes: doble is not defined");
	});
});

test("REGRESIÓN: una function exportada por un .wsb puede llamar a un helper interno del MISMO fichero, sin exportar", async () => {
	const dir = tmpDir();
	crear(dir, { "otro.wsb": ["function interno(x)", "\treturn x + 100", "", "export function usaInterno(x)", "\treturn interno(x)"] });
	await conServidor(dir, unaRuta("usaInterno", "usaInterno(1)"), async (server) => {
		const r = await get(server.address().port, "/probar");
		assert.equal(r.body, '{"r":101}', "antes: interno is not defined");
	});
});

test("dos function EXPORTADAS del mismo .wsb pueden llamarse entre sí", async () => {
	const dir = tmpDir();
	crear(dir, { "otro.wsb": ["export function base(x)", "\treturn x + 1", "", "export function usaBase(x)", "\treturn base(x) * 10"] });
	await conServidor(dir, unaRuta("usaBase", "usaBase(2)"), async (server) => {
		const r = await get(server.address().port, "/probar");
		assert.equal(r.body, '{"r":30}');
	});
});

test("REGRESIÓN: una function exportada que lee su PROPIA global da un error explícito al compilar, no un ReferenceError confuso en ejecución", () => {
	const dir = tmpDir();
	crear(dir, { "otro.wsb": ["global var contador = 0", "", "export function leeContador()", "\treturn contador"] });
	assert.throws(
		() => createServer(parse(unaRuta("leeContador", "leeContador()")), {}, { baseDir: dir }),
		/"leeContador".*usa "contador".*estado propio de ese \.wsb.*no tiene acceso al estado de su fichero de origen/s
	);
});

test("REGRESIÓN: lo mismo con una reactive/var de SESIÓN (no solo global) del fichero de origen", () => {
	const dir = tmpDir();
	crear(dir, { "otro.wsb": ["var visitas = 0", "", "export function leeVisitas()", "\treturn visitas"] });
	assert.throws(() => createServer(parse(unaRuta("leeVisitas", "leeVisitas()")), {}, { baseDir: dir }), /"leeVisitas".*usa "visitas".*estado propio de ese \.wsb/s);
});

test("NO REGRESIÓN: una function del MISMO .wsb que SÍ toca su propia global, pero que NADIE pidió ni se alcanza desde lo pedido, no tumba a las demás", async () => {
	const dir = tmpDir();
	crear(dir, {
		"otro.wsb": ["global var contador = 0", "", "export function leeContador()", "\treturn contador", "", "export function sana()", '\treturn "ok"'],
	});
	await conServidor(dir, unaRuta("sana", "sana()"), async (server) => {
		const r = await get(server.address().port, "/probar");
		assert.equal(r.body, '{"r":"ok"}');
	});
});

test("una function exportada que importa otro .wsb: compila (no se resuelve por adelantado), pero falla claro en EJECUCIÓN si de verdad lo necesita", async () => {
	const dir = tmpDir();
	crear(dir, {
		"tercero.wsb": ["export function algo()", "\treturn 999"],
		"intermedio.wsb": ['import { algo } from "./tercero.wsb"', "", "export function usaTercero()", "\treturn algo()"],
	});
	await conServidor(dir, unaRuta("usaTercero", "usaTercero()").replace(/otro\.wsb/g, "intermedio.wsb"), async (server) => {
		const r = await get(server.address().port, "/probar");
		assert.match(r.body, /algo is not defined/);
	});
});

test("dos function exportadas del mismo .wsb, pedidas desde dos rutas distintas, cada una funciona con su propio valor", async () => {
	const dir = tmpDir();
	crear(dir, {
		"util.ws": ["export function doble(x)", "\treturn x * 2"],
		"otro.wsb": ['import { doble } from "./util.ws"', "", "function interno(x)", "\treturn x + 100", "", "export function usaDoble(x)", "\treturn doble(x)", "", "export function usaInterno(x)", "\treturn interno(x)"],
	});
	const src = [
		'import { usaDoble, usaInterno } from "./otro.wsb"',
		"",
		"const WSON wsonUno =",
		'\t-> to: "/uno"',
		'\t-> via: "GET"',
		"reactive any peticionUno = WSON.listen(wsonUno)",
		"watch(peticionUno)",
		"\tpeticionUno.content = { r: usaDoble(3) }",
		"\tWSON.httpSend(peticionUno)",
		"",
		"const WSON wsonDos =",
		'\t-> to: "/dos"',
		'\t-> via: "GET"',
		"reactive any peticionDos = WSON.listen(wsonDos)",
		"watch(peticionDos)",
		"\tpeticionDos.content = { r: usaInterno(7) }",
		"\tWSON.httpSend(peticionDos)",
	].join("\n");
	await conServidor(dir, src, async (server) => {
		const uno = await get(server.address().port, "/uno");
		const dos = await get(server.address().port, "/dos");
		assert.equal(uno.body, '{"r":6}');
		assert.equal(dos.body, '{"r":107}');
	});
});
