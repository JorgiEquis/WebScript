// SSR (HTML en servidor) ve lo mismo que el bundle de cliente.
//
// Antes, renderPageToHTML compilaba cada function importada AISLADA (solo veía
// `state`) e ignoraba por completo las const/var, clases .wson y módulos .js
// importados. Consecuencias, todas reproducidas contra el código anterior:
// una function que llamaba a otra (un helper, o algo que su .ws importa) daba
// `X is not defined` al renderizar; y ni siquiera una const de un .ws sin
// anidar funcionaba en una interpolación (`{SALUDO}`), aunque el navegador la
// tuviera — y `websc build` no captura errores de SSR, así que rompía el build
// de cualquier página estática que lo usara.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { parse } = require("../parser");
const { renderPageToHTML } = require("../codegen-ssr");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-ssr-ws-"));
}

function crear(dir, ficheros) {
	for (const [nombre, contenido] of Object.entries(ficheros)) {
		const destino = path.join(dir, nombre);
		fs.mkdirSync(path.dirname(destino), { recursive: true });
		fs.writeFileSync(destino, Array.isArray(contenido) ? contenido.join("\n") : contenido);
	}
}

function pagina(imports, expr, extra = []) {
	return [...imports, "", ...extra, "visual app =", "<div>", `\t<p>{${expr}}</p>`, "</div>", "", "Visual.render(app)"].join("\n");
}

// Contenido del primer <p> del HTML que renderiza el servidor. Un texto
// dinámico se envuelve en marcadores <!--t-->...<!--/t--> (ver DISEÑO.md,
// necesarios para que la hidratación reubique el nodo aunque renderice
// vacío) — se descartan aquí para comparar solo el contenido real.
function ssr(dir, wsf) {
	const html = renderPageToHTML(parse(wsf), { baseDir: dir });
	const m = /<p[^>]*>(.*?)<\/p>/.exec(html);
	return m ? m[1].replace(/<!--\/?t-->/g, "") : html;
}

const UTIL = ["export function doble(x)", "\treturn x * 2"];

test("REGRESIÓN: una const de un .ws se puede usar en una interpolación (antes SSR ignoraba lo importado: `SALUDO is not defined`, incluso sin anidar)", () => {
	const dir = tmpDir();
	crear(dir, { "simple.ws": ['export const SALUDO = "hola"'] });
	assert.equal(ssr(dir, pagina(['import { SALUDO } from "./simple.ws"'], "SALUDO")), "hola");
});

test("REGRESIÓN: una function de un .ws que llama a un helper NO exportado del mismo .ws funciona en SSR", () => {
	const dir = tmpDir();
	crear(dir, { "helper.ws": ["function interno(x)", "\treturn x + 100", "", "export function conHelper(x)", "\treturn interno(x)"] });
	assert.equal(ssr(dir, pagina(['import { conHelper } from "./helper.ws"'], "conHelper(1)")), "101");
});

test("REGRESIÓN: un segundo `import` del mismo .ws con otros nombres no los pierde en SSR", () => {
	const dir = tmpDir();
	crear(dir, { "dos.ws": ["export function uno()", "\treturn 1", "", "export function dos()", "\treturn 2"] });
	assert.equal(ssr(dir, pagina(['import { uno } from "./dos.ws"', 'import { dos } from "./dos.ws"'], "uno() + dos()")), "3");
});

test("REGRESIÓN (el caso reportado): un .ws que importa otro .ws funciona en SSR", () => {
	const dir = tmpDir();
	crear(dir, { "util.ws": UTIL, "anidado.ws": ['import { doble } from "./util.ws"', "", "export function cuadruple(x)", "\treturn doble(doble(x))"] });
	assert.equal(ssr(dir, pagina(['import { cuadruple } from "./anidado.ws"'], "cuadruple(3)")), "12");
});

test("REGRESIÓN: un .ws que importa de un .js funciona en SSR", () => {
	const dir = tmpDir();
	crear(dir, {
		"ayuda.js": "module.exports = { triple: (x) => x * 3 };",
		"conjs.ws": ['import { triple } from "./ayuda.js"', "", "export function nueve(x)", "\treturn triple(triple(x))"],
	});
	assert.equal(ssr(dir, pagina(['import { nueve } from "./conjs.ws"'], "nueve(2)")), "18");
});

test("REGRESIÓN: un .ws que importa una clase de un .wson funciona en SSR (`new Persona(...)`)", () => {
	const dir = tmpDir();
	crear(dir, {
		"persona.wson": ["-> content:", "\tnombre: string"],
		"condto.ws": ['import { Persona } from "./persona.wson"', "", "export function nombreDe(n)", "\tconst p = new Persona(n)", "\treturn p.nombre"],
	});
	assert.equal(ssr(dir, pagina(['import { nombreDe } from "./condto.ws"'], 'nombreDe("Ana")')), "Ana");
});

test("REGRESIÓN: una constante de un .ws que usa lo que ese .ws importa funciona en SSR", () => {
	const dir = tmpDir();
	crear(dir, {
		"ayuda.js": "module.exports = { triple: (x) => x * 3 };",
		"consts.ws": ['import { triple } from "./ayuda.js"', "", "export const TRIPLE_DE_DOS = triple(2)"],
	});
	assert.equal(ssr(dir, pagina(['import { TRIPLE_DE_DOS } from "./consts.ws"'], "TRIPLE_DE_DOS")), "6");
});

test("una function que usa una reactive y un helper del .ws (las tres piezas a la vez)", () => {
	const dir = tmpDir();
	crear(dir, { "estado.ws": ["reactive integer base = 10", "", "function sumaBase(x)", "\treturn x + base", "", "export function conBase(x)", "\treturn sumaBase(x)"] });
	assert.equal(ssr(dir, pagina(['import { conBase } from "./estado.ws"'], "conBase(5)")), "15");
});

test("las function PROPIAS del .wsf también pueden llamarse entre sí en SSR (antes, cada una veía solo `state`)", () => {
	const dir = tmpDir();
	assert.equal(ssr(dir, pagina([], "a(2)", ["function b(x)", "\treturn x * 10", "", "function a(x)", "\treturn b(x) + 1", ""])), "21");
});

test("una const PROPIA del .wsf puede usar una function importada", () => {
	const dir = tmpDir();
	crear(dir, { "estado.ws": ["reactive integer base = 10", "", "export function conBase(x)", "\treturn x + base"] });
	assert.equal(ssr(dir, pagina(['import { conBase } from "./estado.ws"'], "resultado", ["const resultado = conBase(1)", ""])), "11");
});

// ---------------------------------------------------------------- tolerancia

test("NO REGRESIÓN: un valor importado que solo funciona en el navegador (usa window) NO rompe un render que no lo usa", () => {
	const dir = tmpDir();
	crear(dir, { "navegador.ws": ["export const ANCHO = window.innerWidth", "", "export function saludo()", '\treturn "hola"'] });
	// Antes SSR ignoraba lo importado y esto funcionaba; evaluarlo sin tolerancia lo habría roto.
	assert.equal(ssr(dir, pagina(['import { saludo } from "./navegador.ws"'], "saludo()")), "hola");
});

test("...y si la plantilla SÍ lo usa, el error explica la causa real (sin nombres internos)", () => {
	const dir = tmpDir();
	crear(dir, { "navegador.ws": ["export const ANCHO = window.innerWidth"] });
	assert.throws(() => ssr(dir, pagina(['import { ANCHO } from "./navegador.ws"'], "ANCHO")), /"ANCHO" no se pudo calcular al renderizar en el servidor \(SSR\): window is not defined/);
});

test("un módulo .js que toca `document` al cargarse: no rompe si no se usa; si se usa, el error dice la causa y no el id interno __jsmod_N", () => {
	const dir = tmpDir();
	crear(dir, {
		"solonav.js": "const titulo = document.title;\nmodule.exports = { titulo: () => titulo };",
		"usanav.ws": ['import { titulo } from "./solonav.js"', "", "export function conTitulo()", "\treturn titulo()", "", "export function plana()", '\treturn "plana"'],
	});
	assert.equal(ssr(dir, pagina(['import { plana } from "./usanav.ws"'], "plana()")), "plana");
	assert.throws(
		() => ssr(dir, pagina(['import { conTitulo } from "./usanav.ws"'], "conTitulo()")),
		(e) => /"titulo" no se pudo calcular.*document is not defined/.test(e.message) && !/__jsmod_/.test(e.message)
	);
});

test("un error en una const PROPIA de la página sí se propaga (es código de esa página, no de una librería)", () => {
	const dir = tmpDir();
	assert.throws(() => ssr(dir, pagina([], "x", ["const x = noExiste()", ""])), /noExiste is not defined/);
});
