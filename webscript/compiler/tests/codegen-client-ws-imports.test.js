// El bundle de cliente resuelve lo que un .ws importa (y lo que declara).
//
// Antes, al importar una function de un .ws solo viajaba esa function: si
// llamaba a un helper del mismo fichero, o a algo que el .ws importaba, o
// leía una constante EXPORTADA del .ws, el navegador daba `X is not defined`
// al usarla. Todos los tests de este fichero EJECUTAN el bundle en JSDOM (no
// comparan texto): los marcados REGRESIÓN fallaban contra el código anterior.
//
// Diferencia con el servidor (ver DISEÑO.md, "Los imports de un .ws en el
// cliente"): aquí el bundle es un único ámbito, así que las colisiones de
// nombre entre ficheros donde interviene un .ws son un error explícito, y el
// trabajo es dirigido por demanda (solo se trae lo que alcanza lo pedido).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { JSDOM, VirtualConsole } = require("jsdom");
const { parse } = require("../parser");
const { generateClientBundle } = require("../codegen-client");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-client-ws-"));
}

function crear(dir, ficheros) {
	for (const [nombre, contenido] of Object.entries(ficheros)) {
		const destino = path.join(dir, nombre);
		fs.mkdirSync(path.dirname(destino), { recursive: true });
		fs.writeFileSync(destino, Array.isArray(contenido) ? contenido.join("\n") : contenido);
	}
}

// Una página con un botón cuyo clic evalúa `expr` y lo pinta en un <p>.
function pagina(imports, expr, extra = []) {
	return [...imports, "", ...extra, "reactive resultado = 0", "", "visual app =", "<div>", `\t<button onclick={resultado = ${expr}}>ok</button>`, "\t<p>{resultado}</p>", "</div>", "", "Visual.render(app)"].join("\n");
}

function generar(dir, wsf) {
	return generateClientBundle(parse(wsf), { baseDir: dir });
}

// Ejecuta el bundle, hace clic en el botón y devuelve lo que pinta el <p>.
function ejecutar(bundle) {
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { runScripts: "dangerously", virtualConsole: new VirtualConsole() });
	let error = null;
	dom.window.onerror = (msg) => {
		error = msg;
	};
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	if (error) throw new Error(`al cargar: ${error}`);
	dom.window.document.querySelector("button").dispatchEvent(new dom.window.Event("click"));
	if (error) throw new Error(`al hacer clic: ${error}`);
	return dom.window.document.querySelector("p").textContent;
}

function correr(dir, imports, expr, extra) {
	return ejecutar(generar(dir, pagina(imports, expr, extra)));
}

const UTIL = ["export function doble(x)", "\treturn x * 2"];

test("REGRESIÓN: una function de un .ws que llama a un helper NO exportado del mismo .ws funciona", () => {
	const dir = tmpDir();
	crear(dir, { "helper.ws": ["function interno(x)", "\treturn x + 100", "", "export function conHelper(x)", "\treturn interno(x)"] });
	assert.equal(correr(dir, ['import { conHelper } from "./helper.ws"'], "conHelper(1)"), "101", "antes: interno is not defined");
});

test("REGRESIÓN: un segundo `import` del mismo .ws con otros nombres no los pierde (antes `visited` lo saltaba entero)", () => {
	const dir = tmpDir();
	crear(dir, { "dos.ws": ["export function uno()", "\treturn 1", "", "export function dos()", "\treturn 2"] });
	assert.equal(correr(dir, ['import { uno } from "./dos.ws"', 'import { dos } from "./dos.ws"'], "uno() + dos()"), "3", "antes: dos is not defined");
});

test("REGRESIÓN (el caso reportado): un .ws que importa otro .ws puede llamar a lo importado, en el navegador", () => {
	const dir = tmpDir();
	crear(dir, { "util.ws": UTIL, "anidado.ws": ['import { doble } from "./util.ws"', "", "export function cuadruple(x)", "\treturn doble(doble(x))"] });
	assert.equal(correr(dir, ['import { cuadruple } from "./anidado.ws"'], "cuadruple(3)"), "12", "antes: doble is not defined");
});

test("REGRESIÓN: un .ws puede importar de un .js, y el módulo viaja al bundle", () => {
	const dir = tmpDir();
	crear(dir, {
		"ayuda.js": "module.exports = { triple: (x) => x * 3 };",
		"conjs.ws": ['import { triple } from "./ayuda.js"', "", "export function nueve(x)", "\treturn triple(triple(x))"],
	});
	assert.equal(correr(dir, ['import { nueve } from "./conjs.ws"'], "nueve(2)"), "18", "antes: triple is not defined");
});

test("REGRESIÓN: un .ws puede importar una clase de un .wson", () => {
	const dir = tmpDir();
	crear(dir, {
		"persona.wson": ["-> content:", "\tnombre: string"],
		"condto.ws": ['import { Persona } from "./persona.wson"', "", "export function nombreDe(n)", "\tconst p = new Persona(n)", "\treturn p.nombre"],
	});
	assert.equal(correr(dir, ['import { nombreDe } from "./condto.ws"'], 'nombreDe("Ana")'), "Ana", "antes: Persona is not defined");
});

test("REGRESIÓN: una constante de un .ws que usa lo que ese .ws importa se evalúa con ello a la vista", () => {
	const dir = tmpDir();
	crear(dir, {
		"ayuda.js": "module.exports = { triple: (x) => x * 3 };",
		"consts.ws": ['import { triple } from "./ayuda.js"', "", "export const TRIPLE_DE_DOS = triple(2)"],
	});
	assert.equal(correr(dir, ['import { TRIPLE_DE_DOS } from "./consts.ws"'], "TRIPLE_DE_DOS"), "6");
});

test("REGRESIÓN: `export const` y `export reactive` de un .ws llegan al cliente (antes solo llegaban los que no llevaban `export`)", () => {
	const dir = tmpDir();
	crear(dir, {
		"exportada.ws": ["export const CINCO = 5", "const SEIS = 6", "export reactive integer contadorExp = 7", "", "export function suma()", "\treturn CINCO + SEIS + contadorExp"],
	});
	assert.equal(correr(dir, ['import { suma } from "./exportada.ws"'], "suma()"), "18", "antes: CINCO is not defined y contadorExp sin estado inicial");
});

test("tres niveles con un diamante: cada function se emite UNA vez y los tres se ven", () => {
	const dir = tmpDir();
	crear(dir, {
		"c.ws": ["export function marca()", '\treturn "c"'],
		"b.ws": ['import { marca } from "./c.ws"', "", "export function viaB()", '\treturn "b>" + marca()'],
		"a.ws": ['import { viaB } from "./b.ws"', 'import { marca } from "./c.ws"', "", "export function viaA()", '\treturn "a>" + viaB() + "|" + marca()'],
	});
	const bundle = generar(dir, pagina(['import { viaA } from "./a.ws"'], "viaA()"));
	assert.equal(ejecutar(bundle), "a>b>c|c");
	assert.equal((bundle.match(/function marca\b/g) || []).length, 1, "la function compartida no se duplica");
});

test("dos .ws que se importan mutuamente (ciclo) funcionan: las function se elevan en el bundle", () => {
	const dir = tmpDir();
	crear(dir, {
		"par.ws": ['import { esImpar } from "./impar.ws"', "", "export function esPar(n)", "\tif (n == 0)", "\t\treturn true", "\treturn esImpar(n - 1)"],
		"impar.ws": ['import { esPar } from "./par.ws"', "", "export function esImpar(n)", "\tif (n == 0)", "\t\treturn false", "\treturn esPar(n - 1)"],
	});
	assert.equal(correr(dir, ['import { esPar } from "./par.ws"'], "esPar(10)"), "true");
});

// ---------------------------------------------------------------- dirigido por demanda

test("NO REGRESIÓN: un .ws mixto (una function usa un .wsdb, solo de servidor; otra es apta para el navegador) sigue funcionando si solo se pide la segura", () => {
	const dir = tmpDir();
	crear(dir, {
		"personas.wsdb": ["-> name: 'persona'", "-> schema:", "\t-> id: integer(10)(primary)/", "\t-> nombre: string(40)"],
		"mixto.ws": ['import { Persona } from "./personas.wsdb"', "", "export function guardar(nombre)", "\treturn Persona.save({ nombre: nombre })", "", "export function formatear(s)", '\treturn "<" + s + ">"'],
	});
	assert.equal(correr(dir, ['import { formatear } from "./mixto.ws"'], 'formatear("x")'), "<x>", "seguir TODOS los imports de un .ws rompería esto");
});

test("...y si se pide la que SÍ usa el .wsdb, el error es claro y nombra el .ws", () => {
	const dir = tmpDir();
	crear(dir, {
		"personas.wsdb": ["-> name: 'persona'", "-> schema:", "\t-> id: integer(10)(primary)/", "\t-> nombre: string(40)"],
		"mixto.ws": ['import { Persona } from "./personas.wsdb"', "", "export function guardar(nombre)", "\treturn Persona.save({ nombre: nombre })"],
	});
	assert.throws(() => generar(dir, pagina(['import { guardar } from "./mixto.ws"'], 'guardar("x")')), /mixto\.ws: No se puede importar "\.\/personas\.wsdb" desde el cliente/);
});

test("un paquete npm que importa un .ws solo estorba si lo usa lo pedido (y entonces el error nombra el .ws)", () => {
	const dir = tmpDir();
	crear(dir, {
		"conpaquete.ws": ['import { etiqueta } from "paquete-x"', "", "export function usaPaquete(s)", "\treturn etiqueta(s)", "", "export function sinPaquete(s)", '\treturn s + "!"'],
	});
	assert.equal(correr(dir, ['import { sinPaquete } from "./conpaquete.ws"'], 'sinPaquete("x")'), "x!");
	assert.throws(() => generar(dir, pagina(['import { usaPaquete } from "./conpaquete.ws"'], 'usaPaquete("x")')), /conpaquete\.ws: No se puede importar el paquete "paquete-x" desde el cliente/);
});

test("solo viaja lo que alcanza lo pedido: una function del .ws que nadie referencia no se emite", () => {
	const dir = tmpDir();
	crear(dir, { "libre.ws": ["export function pedida()", "\treturn 1", "", "export function noPedida()", "\treturn 2"] });
	const bundle = generar(dir, pagina(['import { pedida } from "./libre.ws"'], "pedida()"));
	assert.match(bundle, /function pedida\b/);
	assert.doesNotMatch(bundle, /function noPedida\b/);
});

test("un nombre que solo aparece como PROPIEDAD (o.interno) no arrastra al helper del mismo nombre", () => {
	const dir = tmpDir();
	crear(dir, { "prop.ws": ["function interno()", '\treturn "NO DEBERÍA EMITIRSE"', "", "export function leeProp(o)", "\treturn o.interno"] });
	const bundle = generar(dir, pagina(['import { leeProp } from "./prop.ws"'], "leeProp({ interno: 42 })"));
	assert.equal(ejecutar(bundle), "42");
	assert.doesNotMatch(bundle, /function interno\b/);
});

// ---------------------------------------------------------------- los hermanos del salto por `visited`

test("REGRESIÓN: dos líneas de import del mismo .js, .json o .wson con nombres distintos traen los dos (antes el segundo se perdía)", () => {
	const dir = tmpDir();
	crear(dir, {
		"dosj.js": "module.exports = { x: 1, y: 2 };",
		"dosjson.json": '{ "p": 10, "q": 20 }',
		"dosw.wson": ["-> content:", "\ta: string"],
	});
	assert.equal(correr(dir, ['import { x } from "./dosj.js"', 'import { y } from "./dosj.js"'], "x + y"), "3", "antes: y is not defined");
	assert.equal(correr(dir, ['import { p } from "./dosjson.json"', 'import { q } from "./dosjson.json"'], "p + q"), "30", "antes: q is not defined");
	assert.equal(correr(dir, ['import { A } from "./dosw.wson"', 'import { B } from "./dosw.wson"'], 'new B("z").a'), "z", "antes: B is not defined");
});

test("REGRESIÓN: los ids de los módulos .js embebidos son únicos (un componente que importa un .js y la raíz que importa otro rompían el bundle: __jsmod_0 declarado dos veces)", () => {
	const dir = tmpDir();
	crear(dir, {
		"m1.js": "module.exports = { dosVeces: (x) => x * 2 };",
		"m2.js": "module.exports = { masUno: (x) => x + 1 };",
		"comp.wsf": ['import { dosVeces } from "./m1.js"', "", "visual Comp =", "<span>{dosVeces(5)}</span>"],
	});
	const wsf = pagina(['import { masUno } from "./m2.js"', 'import { Comp } from "./comp.wsf"'], "masUno(1)");
	assert.equal(ejecutar(generar(dir, wsf)), "2", "antes: Identifier '__jsmod_0' has already been declared");
});

// ---------------------------------------------------------------- colisiones: un único ámbito

test("dos .ws con un helper interno del MISMO nombre, ambos necesarios, dan un error que nombra los dos ficheros (antes: una function pisaba a la otra en silencio)", () => {
	const dir = tmpDir();
	crear(dir, {
		"lib1.ws": ["function fmt(x)", '\treturn "1:" + x', "", "export function f1(x)", "\treturn fmt(x)"],
		"lib2.ws": ["function fmt(x)", '\treturn "2:" + x', "", "export function f2(x)", "\treturn fmt(x)"],
	});
	assert.throws(
		() => generar(dir, pagina(['import { f1 } from "./lib1.ws"', 'import { f2 } from "./lib2.ws"'], "f1(1) + f2(2)")),
		/"fmt" lo declaran a la vez lib1\.ws y lib2\.ws.*único ámbito compartido/s
	);
});

test("el mismo nombre en un .ws que NO se necesita no da error (dirigido por demanda: no se emite)", () => {
	const dir = tmpDir();
	crear(dir, {
		"lib1.ws": ["function fmt(x)", '\treturn "1:" + x', "", "export function f1(x)", "\treturn fmt(x)"],
		"lib3.ws": ["function fmt(x)", '\treturn "3:" + x', "", "export function soloIdentidad(x)", "\treturn x", "", "export function usaFmt(x)", "\treturn fmt(x)"],
	});
	assert.equal(correr(dir, ['import { soloIdentidad } from "./lib3.ws"', 'import { f1 } from "./lib1.ws"'], "soloIdentidad(7)"), "7");
});

test("una function propia del .wsf con el nombre de un helper de un .ws también es un error explícito", () => {
	const dir = tmpDir();
	crear(dir, { "lib1.ws": ["function fmt(x)", '\treturn "1:" + x', "", "export function f1(x)", "\treturn fmt(x)"] });
	assert.throws(
		() => generar(dir, pagina(['import { f1 } from "./lib1.ws"'], "f1(1)", ["function fmt(x)", "\treturn 'propia'", ""])),
		/"fmt" lo declaran a la vez este \.wsf y lib1\.ws/
	);
});

test("el MISMO .ws alcanzado por dos caminos no es una colisión: se emite una sola vez", () => {
	const dir = tmpDir();
	crear(dir, {
		"contador.ws": ["export function sumar(a, b)", "\treturn a + b"],
		"camino1.ws": ['import { sumar } from "./contador.ws"', "", "export function porUno(x)", "\treturn sumar(x, 1)"],
		"camino2.ws": ['import { sumar } from "./contador.ws"', "", "export function porOtro(x)", "\treturn sumar(x, 2)"],
	});
	const bundle = generar(dir, pagina(['import { porUno } from "./camino1.ws"', 'import { porOtro } from "./camino2.ws"'], "porUno(1) + porOtro(1)"));
	assert.equal(ejecutar(bundle), "5");
	assert.equal((bundle.match(/function sumar\b/g) || []).length, 1);
});

test("una constante de nivel superior con el mismo nombre en dos .ws también es un error explícito (antes: SyntaxError de 'ya declarado' sin decir dónde)", () => {
	const dir = tmpDir();
	crear(dir, {
		"a.ws": ["const LIMITE = 10", "", "export function a()", "\treturn LIMITE"],
		"b.ws": ["const LIMITE = 20", "", "export function b()", "\treturn LIMITE"],
	});
	assert.throws(() => generar(dir, pagina(['import { a } from "./a.ws"', 'import { b } from "./b.ws"'], "a() + b()")), /"LIMITE" lo declaran a la vez a\.ws y b\.ws/);
});

test("un import roto dentro de un .ws nombra ese .ws (nombre no exportado, y fichero inexistente)", () => {
	const dir = tmpDir();
	crear(dir, {
		"c.ws": ["export function marca()", '\treturn "c"'],
		"mal1.ws": ['import { noExiste } from "./c.ws"', "", "export function f()", "\treturn noExiste()"],
		"mal2.ws": ['import { algo } from "./fantasma.ws"', "", "export function f()", "\treturn algo()"],
	});
	assert.throws(() => generar(dir, pagina(['import { f } from "./mal1.ws"'], "f()")), /mal1\.ws: "noExiste" no está exportado/);
	assert.throws(() => generar(dir, pagina(['import { f } from "./mal2.ws"'], "f()")), /mal2\.ws: No se pudo resolver el import "\.\/fantasma\.ws"/);
});
