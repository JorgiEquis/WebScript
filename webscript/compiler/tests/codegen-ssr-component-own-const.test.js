// Una `const`/`var` de nivel superior de un `.wsf` componente, usada DENTRO
// de la plantilla de ESE MISMO componente, fallaba en SSR — `X is not
// defined` — con o sin `export`, sin relación con ninguna colisión de
// nombres ni con imports. Usar esa misma const desde OTRO fichero (la
// página raíz, u otro componente) sí funcionaba, porque esa vía no pasa por
// `renderComponentSSR`.
//
// Causa: `renderComponentSSR` construía el `ctx` del componente con
// `extraScope: { props }`, que REEMPLAZABA por completo el `extraScope`
// heredado del padre (donde vive toda const de nivel superior, propia y
// de cualquier componente — el modelo es un único ámbito plano, igual que
// en el bundle de cliente) en vez de combinarlo. Se perdía en cada nivel
// de composición. El cuerpo de un `for` ya hacía esto bien (`{
// ...ctx.extraScope, [item]: valor }`) — el mismo patrón, aplicado aquí.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { parse } = require("../parser");
const { renderPageToHTML } = require("../codegen-ssr");
const { generateClientBundle } = require("../codegen-client");
const { JSDOM, VirtualConsole } = require("jsdom");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-comp-const-"));
}

function crear(dir, ficheros) {
	for (const [nombre, contenido] of Object.entries(ficheros)) {
		fs.writeFileSync(path.join(dir, nombre), Array.isArray(contenido) ? contenido.join("\n") : contenido);
	}
}

test("REGRESIÓN: una const propia de un componente, usada en la plantilla de ESE MISMO componente, funciona en SSR", () => {
	const dir = tmpDir();
	crear(dir, { "compA.wsf": ["const TITULO = 'hola'", "", "visual CompA =", "<span>{TITULO}</span>"] });
	const wsf = ['import { CompA } from "./compA.wsf"', "", "visual app =", "<div><CompA /></div>", "", "Visual.render(app)"].join("\n");
	assert.match(renderPageToHTML(parse(wsf), { baseDir: dir }), /hola/);
});

test("NO REGRESIÓN: el bundle de cliente ya funcionaba (ámbito plano) — sigue funcionando", () => {
	const dir = tmpDir();
	crear(dir, { "compA.wsf": ["const TITULO = 'hola'", "", "visual CompA =", "<span>{TITULO}</span>"] });
	const wsf = ['import { CompA } from "./compA.wsf"', "", "visual app =", "<div><CompA /></div>", "", "Visual.render(app)"].join("\n");
	const bundle = generateClientBundle(parse(wsf), { baseDir: dir });
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { runScripts: "dangerously", virtualConsole: new VirtualConsole() });
	let error = null;
	dom.window.onerror = (e) => {
		error = e;
	};
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	if (error) throw new Error(error);
	assert.equal(dom.window.document.querySelector("span").textContent, "hola");
});

test("una const propia que usa una function propia, dentro de la plantilla del mismo componente", () => {
	const dir = tmpDir();
	crear(dir, { "compB.wsf": ["function doble(x)", "\treturn x * 2", "const VALOR = doble(21)", "", "visual CompB =", "<span>{VALOR}</span>"] });
	const wsf = ['import { CompB } from "./compB.wsf"', "", "visual app =", "<div><CompB /></div>", "", "Visual.render(app)"].join("\n");
	assert.match(renderPageToHTML(parse(wsf), { baseDir: dir }), /42/);
});

test("tres niveles de composición, cada uno con SU PROPIA const en su propia plantilla", () => {
	const dir = tmpDir();
	crear(dir, {
		"nivel1.wsf": ["const N1 = 'uno'", "", "visual Nivel1 =", "<p>{N1}</p>"],
		"nivel2.wsf": ['import { Nivel1 } from "./nivel1.wsf"', "const N2 = 'dos'", "", "visual Nivel2 =", "<div>{N2}<Nivel1 /></div>"],
		"nivel3.wsf": ['import { Nivel2 } from "./nivel2.wsf"', "const N3 = 'tres'", "", "visual Nivel3 =", "<section>{N3}<Nivel2 /></section>"],
	});
	const wsf = ['import { Nivel3 } from "./nivel3.wsf"', "", "visual app =", "<Nivel3 />", "", "Visual.render(app)"].join("\n");
	const html = renderPageToHTML(parse(wsf), { baseDir: dir });
	assert.match(html, /uno/);
	assert.match(html, /dos/);
	assert.match(html, /tres/);
});

test("NO REGRESIÓN: `props` NO se filtra hacia un componente hijo que no lo declara", () => {
	const dir = tmpDir();
	crear(dir, {
		"hijo.wsf": ["visual Hijo =", "<span>hijo-fijo</span>"],
		"padreConProps.wsf": ['import { Hijo } from "./hijo.wsf"', "", "visual PadreConProps =", "<div>{props.saludo}<Hijo /></div>"],
	});
	const wsf = ['import { PadreConProps } from "./padreConProps.wsf"', "", "visual app =", '<PadreConProps saludo="hola" />', "", "Visual.render(app)"].join("\n");
	const html = renderPageToHTML(parse(wsf), { baseDir: dir });
	assert.match(html, /hola/);
	assert.match(html, /hijo-fijo/);
});

test("una const propia y un prop del mismo componente, con nombres parecidos, no se confunden", () => {
	const dir = tmpDir();
	crear(dir, { "conProp.wsf": ["const SALUDO = 'de la const'", "", "visual ConProp =", "<div>{SALUDO} - {props.saludo}</div>"] });
	const wsf = ['import { ConProp } from "./conProp.wsf"', "", "visual app =", '<ConProp saludo="del prop" />', "", "Visual.render(app)"].join("\n");
	const html = renderPageToHTML(parse(wsf), { baseDir: dir });
	assert.match(html, /de la const - del prop/);
});

test("un `for` dentro de la plantilla de un componente combina bien SU PROPIA const, `props` y la variable del propio `for`", () => {
	const dir = tmpDir();
	crear(dir, { "conFor.wsf": ["const PREFIJO = 'item-'", "", "visual ConFor =", "<ul>", "\tfor (item in props.items)", "\t\t<li>{PREFIJO}{item}</li>", "</ul>"] });
	const wsf = ['import { ConFor } from "./conFor.wsf"', "", "const lista = ['a', 'b']", "", "visual app =", "<ConFor items={lista} />", "", "Visual.render(app)"].join("\n");
	const html = renderPageToHTML(parse(wsf), { baseDir: dir });
	assert.match(html, /item-a/);
	assert.match(html, /item-b/);
});

test("dos instancias del mismo componente, con props distintos, cada una ve su propio props Y la misma const compartida — E2E-like sin build real", () => {
	const dir = tmpDir();
	crear(dir, { "tarjeta.wsf": ["const PREFIJO = '★ '", "", "visual Tarjeta =", "<h3>{PREFIJO}{props.titulo}</h3>"] });
	const wsf = ['import { Tarjeta } from "./tarjeta.wsf"', "", "visual app =", '<div><Tarjeta titulo="Primera" /><Tarjeta titulo="Segunda" /></div>', "", "Visual.render(app)"].join("\n");
	const html = renderPageToHTML(parse(wsf), { baseDir: dir });
	assert.match(html, /★ Primera/);
	assert.match(html, /★ Segunda/);
});
