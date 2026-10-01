// Dos `.wsf` (componentes, o la propia página) que declaran una `function`
// o `const` con el mismo nombre se pisaban en silencio: cuál "ganaba"
// dependía únicamente del orden de los imports, y ganaba para AMBOS
// componentes por igual (no solo para el que declaró la versión perdedora)
// — confirmado con ejecución real: dos componentes con su propio `fmt`
// interno, el segundo importado ganaba en los dos, tanto en el bundle de
// cliente como en SSR (`functions[node.name] = fn` y `function fmt` dos
// veces en el mismo script son el mismo pisado silencioso, solo que
// mecanismos distintos). Antes esto estaba explícitamente exento de la
// comprobación de colisiones que ya existía entre un `.ws` y cualquier otra
// cosa; ahora tiene el mismo criterio: error explícito que nombra los dos
// ficheros, nunca un pisado silencioso.
//
// De camino se encontró un bug relacionado y más fundamental: una `export
// function`/`export const` dentro de un `.wsf` componente era INVISIBLE
// (ni siquiera llegaba a compararse) — el nodo `Export` que envuelve la
// declaración no se desenvolvía en este punto (mismo bug, en otro sitio,
// que ya se había corregido para un `.ws`). Sin `export` sí viajaba.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { JSDOM, VirtualConsole } = require("jsdom");
const { parse } = require("../parser");
const { generateClientBundle } = require("../codegen-client");
const { renderPageToHTML } = require("../codegen-ssr");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-dup-wsf-"));
}

function crear(dir, ficheros) {
	for (const [nombre, contenido] of Object.entries(ficheros)) {
		fs.writeFileSync(path.join(dir, nombre), Array.isArray(contenido) ? contenido.join("\n") : contenido);
	}
}

function ejecutarCliente(dir, wsf) {
	const bundle = generateClientBundle(parse(wsf), { baseDir: dir });
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { runScripts: "dangerously", virtualConsole: new VirtualConsole() });
	let error = null;
	dom.window.onerror = (e) => {
		error = e;
	};
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	if (error) throw new Error(`al cargar: ${error}`);
	return dom.window.document;
}

const PAGINA_DOS_COMPONENTES = [
	'import { CompA } from "./compA.wsf"',
	'import { CompB } from "./compB.wsf"',
	"",
	"visual app =",
	"<div><CompA /><CompB /></div>",
	"",
	"Visual.render(app)",
].join("\n");

test("REGRESIÓN: dos componentes con un helper interno del mismo nombre dan un error explícito que nombra los dos ficheros (cliente)", () => {
	const dir = tmpDir();
	crear(dir, {
		"compA.wsf": ["function fmt(x)", '\treturn "A:" + x', "", "visual CompA =", "<span>{fmt(1)}</span>"],
		"compB.wsf": ["function fmt(x)", '\treturn "B:" + x', "", "visual CompB =", "<span>{fmt(2)}</span>"],
	});
	assert.throws(() => generateClientBundle(parse(PAGINA_DOS_COMPONENTES), { baseDir: dir }), /"fmt" lo declaran a la vez compA\.wsf y compB\.wsf/);
});

test("REGRESIÓN: el mismo caso, en SSR — antes NO daba error, daba el mismo valor equivocado para los dos componentes", () => {
	const dir = tmpDir();
	crear(dir, {
		"compA.wsf": ["function fmt(x)", '\treturn "A:" + x', "", "visual CompA =", "<span>{fmt(1)}</span>"],
		"compB.wsf": ["function fmt(x)", '\treturn "B:" + x', "", "visual CompB =", "<span>{fmt(2)}</span>"],
	});
	assert.throws(() => renderPageToHTML(parse(PAGINA_DOS_COMPONENTES), { baseDir: dir }), /"fmt" lo declaran a la vez compA\.wsf y compB\.wsf/);
});

test("tras renombrar uno de los dos, cada componente muestra su PROPIO valor (antes: los dos mostraban el del segundo import)", () => {
	const dir = tmpDir();
	crear(dir, {
		"compA.wsf": ["function fmt(x)", '\treturn "A:" + x', "", "visual CompA =", "<span>{fmt(1)}</span>"],
		"compB.wsf": ["function fmtB(x)", '\treturn "B:" + x', "", "visual CompB =", "<span>{fmtB(2)}</span>"],
	});
	const html = renderPageToHTML(parse(PAGINA_DOS_COMPONENTES), { baseDir: dir });
	assert.match(html, /A:1/);
	assert.match(html, /B:2/);

	const doc = ejecutarCliente(dir, PAGINA_DOS_COMPONENTES);
	const spans = doc.querySelectorAll("span");
	assert.equal(spans[0].textContent, "A:1");
	assert.equal(spans[1].textContent, "B:2");
});

test("REGRESIÓN: una colisión de CONST (no solo function) entre dos componentes también da el error explícito", () => {
	const dir = tmpDir();
	crear(dir, {
		"compX.wsf": ["const TITULO = 'X'", "", "visual CompX =", "<span>{TITULO}</span>"],
		"compY.wsf": ["const TITULO = 'Y'", "", "visual CompY =", "<span>{TITULO}</span>"],
	});
	const wsf = ['import { CompX } from "./compX.wsf"', 'import { CompY } from "./compY.wsf"', "", "visual app =", "<div><CompX /><CompY /></div>", "", "Visual.render(app)"].join("\n");
	assert.throws(() => renderPageToHTML(parse(wsf), { baseDir: dir }), /"TITULO" lo declaran a la vez compX\.wsf y compY\.wsf/);
});

test("una colisión entre la PROPIA página y un componente importado también da el error (antes exenta por igual)", () => {
	const dir = tmpDir();
	crear(dir, { "compA.wsf": ["function fmt(x)", '\treturn "A:" + x', "", "visual CompA =", "<span>{fmt(1)}</span>"] });
	const wsf = [
		"function fmt(x)",
		'\treturn "propia:" + x',
		"",
		'import { CompA } from "./compA.wsf"',
		"",
		"visual app =",
		"<div><CompA /><p>{fmt(9)}</p></div>",
		"",
		"Visual.render(app)",
	].join("\n");
	assert.throws(() => generateClientBundle(parse(wsf), { baseDir: dir }), /"fmt" lo declaran a la vez este \.wsf y compA\.wsf/);
});

test("NO REGRESIÓN: el MISMO componente alcanzado por dos caminos (diamante) NO es una colisión — se emite una sola vez", () => {
	const dir = tmpDir();
	crear(dir, {
		"compA.wsf": ["function fmt(x)", '\treturn "A:" + x', "", "visual CompA =", "<span>{fmt(1)}</span>"],
		"compWrapper.wsf": ['import { CompA } from "./compA.wsf"', "", "visual CompWrapper =", "<div><CompA /></div>"],
	});
	const wsf = [
		'import { CompA } from "./compA.wsf"',
		'import { CompWrapper } from "./compWrapper.wsf"',
		"",
		"visual app =",
		"<div><CompA /><CompWrapper /></div>",
		"",
		"Visual.render(app)",
	].join("\n");
	const html = renderPageToHTML(parse(wsf), { baseDir: dir });
	assert.match(html, /A:1/);
	const bundle = generateClientBundle(parse(wsf), { baseDir: dir });
	assert.equal((bundle.match(/function fmt\b/g) || []).length, 1);
});

test("REGRESIÓN (bug encontrado en el camino, más fundamental): `export function` dentro de un componente ya NO es invisible", () => {
	const dir = tmpDir();
	crear(dir, { "compA.wsf": ["export function fmt(x)", '\treturn "A:" + x', "", "visual CompA =", "<span>{fmt(1)}</span>"] });
	const wsf = ['import { CompA } from "./compA.wsf"', "", "visual app =", "<div><CompA /></div>", "", "Visual.render(app)"].join("\n");
	assert.match(renderPageToHTML(parse(wsf), { baseDir: dir }), /A:1/);
	const doc = ejecutarCliente(dir, wsf);
	assert.equal(doc.querySelector("span").textContent, "A:1");
});

test("REGRESIÓN: `export const` de un componente, usado por la RAÍZ (no por el propio componente), ya viaja — antes el filtro por tipo no desenvolvía el nodo Export y era invisible", () => {
	const dir = tmpDir();
	crear(dir, { "compConst.wsf": ["export const TITULO = 'hola'", "", "visual CompConst =", "<span>fijo</span>"] });
	const wsf = ['import { TITULO } from "./compConst.wsf"', "", "visual app =", "<p>{TITULO}</p>", "", "Visual.render(app)"].join("\n");
	assert.match(renderPageToHTML(parse(wsf), { baseDir: dir }), /hola/);
	const doc = ejecutarCliente(dir, wsf);
	assert.equal(doc.querySelector("p").textContent, "hola");
});
