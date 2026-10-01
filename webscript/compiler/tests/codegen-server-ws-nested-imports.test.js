// Los `import` de un `.ws` se resuelven en servidor.
//
// Antes, el lote de function de un `.ws` se compilaba sin nada de lo que ese
// fichero importaba, así que CUALQUIER llamada a algo importado dentro de un
// .ws (otro .ws, un .js, un paquete npm, una clase .wson/.wsdb) fallaba en
// ejecución con `X is not defined` — y una constante exportada que usara un
// import ni siquiera compilaba. Reproducido contra el código anterior antes
// de corregirlo: los tests marcados REGRESIÓN fallan allí.
//
// Diseño (ver DISEÑO.md, "Los imports de un .ws"): cada .ws tiene su ámbito
// de imports PRIVADO, resuelto contra su propia carpeta; las function entre
// .ws se enlazan de forma tardía (sin ordenar lotes, y con ciclos permitidos);
// y un .ws se compila una sola vez por proyecto, contra el `global` del .wsb
// raíz.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { parse } = require("../parser");
const { createServer, resolveImports } = require("../codegen-server");
const { WSClient } = require("../wsclient-runtime");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-ws-nested-"));
}

// crear(dir, { "lib/a.ws": ["línea", ...] | "texto" })
function crear(dir, ficheros) {
	for (const [nombre, contenido] of Object.entries(ficheros)) {
		const destino = path.join(dir, nombre);
		fs.mkdirSync(path.dirname(destino), { recursive: true });
		fs.writeFileSync(destino, Array.isArray(contenido) ? contenido.join("\n") : contenido);
	}
}

async function conServidor(dir, src, fn) {
	const server = createServer(parse(src), {}, { baseDir: dir });
	await new Promise((resolve) => server.listen(0, resolve));
	const client = new WSClient(`ws://localhost:${server.address().port}/`);
	try {
		await fn(client, server);
	} finally {
		client.close();
		server.close();
	}
}

function compilar(dir, src) {
	return createServer(parse(src), {}, { baseDir: dir });
}

const UTIL = ["export function doble(x)", "\treturn x * 2"];

test("REGRESIÓN (el caso reportado): un .ws que importa otro .ws puede llamar a lo importado", async () => {
	const dir = tmpDir();
	crear(dir, {
		"util.ws": UTIL,
		"usa.ws": ['import { doble } from "./util.ws"', "", "export online function cuadruple(x)", "\treturn doble(doble(x))"],
	});
	await conServidor(dir, 'import { cuadruple } from "./usa.ws"', async (c) => {
		assert.equal(await c.llamar("cuadruple", [3]), 12, "antes: doble is not defined");
	});
});

test("REGRESIÓN: el import de un .ws se resuelve contra la carpeta de ESE .ws, no la del .wsb (cadena de dos niveles en una subcarpeta)", async () => {
	const dir = tmpDir();
	crear(dir, {
		"lib/base.ws": ["export function suma(a, b)", "\treturn a + b"],
		"lib/medio.ws": ['import { suma } from "./base.ws"', "", "export function sumaTres(a, b, c)", "\treturn suma(suma(a, b), c)"],
	});
	await conServidor(dir, ['import { sumaTres } from "./lib/medio.ws"', "", "online function probar(a)", "\treturn sumaTres(a, 1, 1)"].join("\n"), async (c) => {
		assert.equal(await c.llamar("probar", [5]), 7);
	});
});

test("REGRESIÓN: un .ws puede importar de un .js", async () => {
	const dir = tmpDir();
	crear(dir, {
		"lib/ayuda.js": "module.exports = { triple: (x) => x * 3 };",
		"lib/conjs.ws": ['import { triple } from "./ayuda.js"', "", "export online function nueveVeces(x)", "\treturn triple(triple(x))"],
	});
	await conServidor(dir, 'import { nueveVeces } from "./lib/conjs.ws"', async (c) => {
		assert.equal(await c.llamar("nueveVeces", [2]), 18);
	});
});

test("REGRESIÓN: un .ws puede importar una clase de un .wson", async () => {
	const dir = tmpDir();
	crear(dir, {
		"lib/persona.wson": ["-> content:", "\tnombre: string"],
		"lib/condto.ws": ['import { Persona } from "./persona.wson"', "", "export online function crear(nombre)", "\tconst p = new Persona(nombre)", "\treturn p.nombre"],
	});
	await conServidor(dir, 'import { crear } from "./lib/condto.ws"', async (c) => {
		assert.equal(await c.llamar("crear", ["Ana"]), "Ana");
	});
});

test("REGRESIÓN: un .ws puede importar un paquete npm, buscado desde SU carpeta", async () => {
	const dir = tmpDir();
	crear(dir, {
		"lib/node_modules/paquete-de-prueba/package.json": '{ "name": "paquete-de-prueba", "main": "index.js" }',
		"lib/node_modules/paquete-de-prueba/index.js": 'module.exports = { etiqueta: (s) => "[" + s + "]" };',
		"lib/conpaquete.ws": ['import { etiqueta } from "paquete-de-prueba"', "", "export online function etiquetar(s)", "\treturn etiqueta(s)"],
	});
	// El paquete solo está instalado bajo lib/ — el .wsb raíz (en dir/) no
	// lo vería. Que funcione demuestra que se busca desde la carpeta del .ws.
	await conServidor(dir, 'import { etiquetar } from "./lib/conpaquete.ws"', async (c) => {
		assert.equal(await c.llamar("etiquetar", ["hola"]), "[hola]");
	});
});

test("REGRESIÓN: un .ws puede importar un .wsdb (desde una subcarpeta) y la base de datos cae en la raíz del proyecto, no dentro de lib/", async () => {
	const dir = tmpDir();
	crear(dir, {
		"personas.wsdb": ["-> name: 'persona'", "-> schema:", "\t-> id: integer(10)(primary)/", "\t-> nombre: string(40)"],
		"lib/datos.ws": ['import { Persona } from "../personas.wsdb"', "", "export online function guardar(nombre)", "\tconst p = Persona.save({ nombre: nombre })", "\treturn p.id"],
	});
	await conServidor(dir, 'import { guardar } from "./lib/datos.ws"', async (c) => {
		assert.equal(await c.llamar("guardar", ["Ana"]), 1);
		assert.equal(await c.llamar("guardar", ["Luis"]), 2);
	});
	assert.ok(fs.existsSync(path.join(dir, ".wsdb-data", "webscript.db")));
	assert.ok(!fs.existsSync(path.join(dir, "lib", ".wsdb-data")), "la base de datos no debe crearse junto al .ws anidado");
});

test("REGRESIÓN: una constante exportada por un .ws puede usar lo que ese .ws importa", async () => {
	const dir = tmpDir();
	crear(dir, {
		"lib/ayuda.js": "module.exports = { triple: (x) => x * 3 };",
		"lib/consts.ws": ['import { triple } from "./ayuda.js"', "", "export const TRIPLE_DE_DOS = triple(2)"],
	});
	await conServidor(dir, ['import { TRIPLE_DE_DOS } from "./lib/consts.ws"', "", "online function leer()", "\treturn TRIPLE_DE_DOS"].join("\n"), async (c) => {
		assert.equal(await c.llamar("leer", []), 6, "antes: ni siquiera compilaba (triple is not defined)");
	});
});

test("tres niveles con un diamante (a y b importan c): cada .ws se compila una sola vez y los tres se ven", async () => {
	const dir = tmpDir();
	crear(dir, {
		"c.ws": ["export function marca()", '\treturn "c"'],
		"b.ws": ['import { marca } from "./c.ws"', "", "export function viaB()", '\treturn "b>" + marca()'],
		"a.ws": ['import { viaB } from "./b.ws"', 'import { marca } from "./c.ws"', "", "export online function viaA()", '\treturn "a>" + viaB() + "|" + marca()'],
	});
	await conServidor(dir, 'import { viaA } from "./a.ws"', async (c) => {
		assert.equal(await c.llamar("viaA", []), "a>b>c|c");
	});
});

test("el diamante comparte UNA instancia: dos caminos hasta el mismo .ws ven el mismo estado global", async () => {
	const dir = tmpDir();
	crear(dir, {
		"contador.ws": ["export function sumar()", "\ttotal = total + 1", "\treturn total"],
		"camino1.ws": ['import { sumar } from "./contador.ws"', "", "export function porUno()", "\treturn sumar()"],
		"camino2.ws": ['import { sumar } from "./contador.ws"', "", "export function porOtro()", "\treturn sumar()"],
	});
	const src = ['import { porUno } from "./camino1.ws"', 'import { porOtro } from "./camino2.ws"', "", "global var integer total = 0", "", "online function alternar()", "\tporUno()", "\tporOtro()", "\treturn porUno()"].join("\n");
	await conServidor(dir, src, async (c) => {
		assert.equal(await c.llamar("alternar", []), 3);
		assert.equal(await c.llamar("alternar", []), 6, "un contador compartido; con dos instancias daría 3 y 3");
	});
});

test("dos .ws que se importan mutuamente (ciclo) funcionan: enlace tardío, sin recursión infinita", async () => {
	const dir = tmpDir();
	crear(dir, {
		"par.ws": ['import { esImpar } from "./impar.ws"', "", "export online function esPar(n)", "\tif (n == 0)", "\t\treturn true", "\treturn esImpar(n - 1)"],
		"impar.ws": ['import { esPar } from "./par.ws"', "", "export function esImpar(n)", "\tif (n == 0)", "\t\treturn false", "\treturn esPar(n - 1)"],
	});
	await conServidor(dir, 'import { esPar } from "./par.ws"', async (c) => {
		assert.equal(await c.llamar("esPar", [10]), true);
		assert.equal(await c.llamar("esPar", [7]), false);
	});
});

test("una function de un .ws anidado accede a la `global` del .wsb raíz, y persiste entre llamadas", async () => {
	const dir = tmpDir();
	crear(dir, {
		"contador.ws": ["export function sumar()", "\ttotal = total + 1", "\treturn total"],
		"usacontador.ws": ['import { sumar } from "./contador.ws"', "", "export online function sumarDosVeces()", "\tsumar()", "\treturn sumar()"],
	});
	await conServidor(dir, ['import { sumarDosVeces } from "./usacontador.ws"', "", "global var integer total = 0"].join("\n"), async (c) => {
		assert.equal(await c.llamar("sumarDosVeces", []), 2);
		assert.equal(await c.llamar("sumarDosVeces", []), 4);
	});
});

test("una function de un .ws anidado que toca una reactive de SESIÓN da un error claro al compilar, con la cadena de imports", () => {
	const dir = tmpDir();
	crear(dir, {
		"sesion.ws": ["export function toca()", "\treturn miSesion"],
		"usasesion.ws": ['import { toca } from "./sesion.ws"', "", "export function envuelve()", "\treturn toca()"],
	});
	assert.throws(
		() => compilar(dir, ['import { envuelve } from "./usasesion.ws"', "", 'reactive string miSesion = "x"'].join("\n")),
		/function toca \(importada de "\.\/sesion\.ws", a su vez importada por "usasesion\.ws"\): "miSesion" es una reactive\/var POR SESIÓN/
	);
});

test("los imports de un .ws son PRIVADOS: no se filtran al .wsb que lo importa", async () => {
	const dir = tmpDir();
	crear(dir, {
		"c.ws": ["export function marca()", '\treturn "c"'],
		"a.ws": ['import { marca } from "./c.ws"', "", "export online function viaA()", "\treturn marca()"],
	});
	// a.ws importa `marca`, pero el .wsb NO — no debe verla.
	await conServidor(dir, ['import { viaA } from "./a.ws"', "", "online function espia()", "\treturn marca()"].join("\n"), async (c) => {
		assert.equal(await c.llamar("viaA", []), "c");
		await assert.rejects(() => c.llamar("espia", []), /marca is not defined/);
	});
});

test("dos ámbitos con el mismo nombre local no se pisan: el .ws usa SU `doble`, el .wsb la suya", async () => {
	const dir = tmpDir();
	crear(dir, {
		"util.ws": UTIL,
		"usa-util.ws": ['import { doble } from "./util.ws"', "", "export online function dobleDelWs(x)", "\treturn doble(x)"],
	});
	await conServidor(dir, ['import { dobleDelWs } from "./usa-util.ws"', "", "online function doble(x)", "\treturn x * 100"].join("\n"), async (c) => {
		assert.equal(await c.llamar("dobleDelWs", [5]), 10);
		assert.equal(await c.llamar("doble", [5]), 500);
	});
});

test("una online function de un .ws anidado que el .wsb NO importa por nombre no se expone por RPC (pero la visible puede llamarla)", async () => {
	const dir = tmpDir();
	crear(dir, {
		"oculta.ws": ["export online function secreta()", '\treturn "interna"'],
		"usa-oculta.ws": ['import { secreta } from "./oculta.ws"', "", "export online function visible()", "\treturn secreta()"],
	});
	await conServidor(dir, 'import { visible } from "./usa-oculta.ws"', async (c) => {
		assert.equal(await c.llamar("visible", []), "interna");
		await assert.rejects(() => c.llamar("secreta", []), /no existe ninguna "online function secreta"/);
	});
});

test("una ruta HTTP (watch) llama a una function importada de un .ws que a su vez usa un import — de extremo a extremo", async () => {
	const dir = tmpDir();
	crear(dir, {
		"util.ws": UTIL,
		"usa.ws": ['import { doble } from "./util.ws"', "", "export function cuadruple(x)", "\treturn doble(doble(x))"],
	});
	const src = [
		'import { cuadruple } from "./usa.ws"',
		"",
		"const WSON wsonCalc =",
		'\t-> to: "/cuadruple/:n"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonCalc)",
		"",
		"watch(peticion)",
		"\tconst n = Number(WSON.httpParams(peticion).n)",
		"\tpeticion.content = { resultado: cuadruple(n) }",
		"\tWSON.httpSend(peticion)",
	].join("\n");
	const server = compilar(dir, src);
	await new Promise((resolve) => server.listen(0, resolve));
	try {
		const cuerpo = await new Promise((resolve, reject) => {
			http.get(`http://localhost:${server.address().port}/cuadruple/5`, (res) => {
				let b = "";
				res.on("data", (d) => (b += d));
				res.on("end", () => resolve(JSON.parse(b)));
			}).on("error", reject);
		});
		assert.deepEqual(cuerpo, { resultado: 20 });
	} finally {
		server.close();
	}
});

test("dos servidores sobre el mismo grafo de .ws tienen estado global independiente (un registro por servidor)", async () => {
	const dir = tmpDir();
	crear(dir, {
		"contador.ws": ["export function sumar()", "\ttotal = total + 1", "\treturn total"],
		"usa.ws": ['import { sumar } from "./contador.ws"', "", "export online function uno()", "\treturn sumar()"],
	});
	const imp = 'import { uno } from "./usa.ws"';
	const a = compilar(dir, [imp, "", "global var integer total = 0"].join("\n"));
	const b = compilar(dir, [imp, "", "global var integer total = 100"].join("\n"));
	await Promise.all([new Promise((r) => a.listen(0, r)), new Promise((r) => b.listen(0, r))]);
	const ca = new WSClient(`ws://localhost:${a.address().port}/`);
	const cb = new WSClient(`ws://localhost:${b.address().port}/`);
	try {
		assert.equal(await ca.llamar("uno", []), 1);
		assert.equal(await cb.llamar("uno", []), 101);
		assert.equal(await ca.llamar("uno", []), 2);
	} finally {
		ca.close();
		cb.close();
		a.close();
		b.close();
	}
});

test("un .ws que importa un .wsb da un error claro (un .ws también lo usa el cliente; un .wsb es solo de servidor)", () => {
	const dir = tmpDir();
	crear(dir, {
		"api-ajena.wsb": ["export function hola()", '\treturn "hola"'],
		"malo.ws": ['import { hola } from "./api-ajena.wsb"', "", "export function llama()", "\treturn hola()"],
	});
	assert.throws(() => compilar(dir, 'import { llama } from "./malo.ws"'), /malo\.ws \(un \.ws\) importa "\.\/api-ajena\.wsb": un \.ws es lógica compartida/);
});

test("una constante en una importación circular da un error que explica la causa, no un ReferenceError engañoso", () => {
	const dir = tmpDir();
	crear(dir, {
		"k1.ws": ['import { K2 } from "./k2.ws"', "", "export const K1 = 1"],
		"k2.ws": ['import { K1 } from "./k1.ws"', "", "export const K2 = 2"],
	});
	assert.throws(() => compilar(dir, 'import { K1 } from "./k1.ws"'), /importación circular.*constante no se puede evaluar/s);
});

test("un import roto dentro de un .ws anidado nombra el .ws que lo tiene (nombre no exportado, y fichero inexistente)", () => {
	const dir = tmpDir();
	crear(dir, {
		"c.ws": ["export function marca()", '\treturn "c"'],
		"mal1.ws": ['import { noExiste } from "./c.ws"', "", "export function f()", "\treturn 1"],
		"mal2.ws": ['import { algo } from "./fantasma.ws"', "", "export function f()", "\treturn 1"],
	});
	assert.throws(() => compilar(dir, 'import { f } from "./mal1.ws"'), /mal1\.ws: "noExiste" no está exportado/);
	assert.throws(() => compilar(dir, 'import { f } from "./mal2.ws"'), /mal2\.ws: No se pudo resolver el import "\.\/fantasma\.ws"/);
});

test("compatibilidad: resolveImports llamado directamente (sin aplazar) también resuelve los imports de un .ws, y no deja nada diferido", async () => {
	const dir = tmpDir();
	crear(dir, {
		"util.ws": UTIL,
		"usa-util.ws": ['import { doble } from "./util.ws"', "", "export function dobleDelWs(x)", "\treturn doble(x)"],
	});
	const { bindings, deferredWs } = resolveImports(parse('import { dobleDelWs } from "./usa-util.ws"'), dir);
	assert.equal(await bindings.dobleDelWs(21), 42);
	assert.deepEqual(deferredWs, []);
	assert.equal(bindings.doble, undefined, "y el import privado del .ws no aparece en las bindings del ámbito raíz");
});
