// Una `reactive` cuyo valor inicial usa una `const`/`var` de nivel superior
// (o una function) fallaba siempre, en servidor y en cliente, aunque por
// motivos distintos:
//
// - CLIENTE: `const state = createStore({ c: LIMITE })` se emitía ANTES que
//   `const LIMITE = 10` en el bundle (todas las const/var de nivel superior
//   se emitían después de `state`, sin excepción, porque las que SÍ leen una
//   reactive necesitan `state` ya creado). Es una TDZ de verdad —
//   `Cannot access 'LIMITE' before initialization` — no un fallo del
//   compilador en sí. Una `reactive` que llamaba a una `function` no tenía
//   este problema: las `function` se elevan (*hoisting* normal de JS) y ya
//   eran invocables desde antes de su posición textual.
// - SERVIDOR (SSR): el valor inicial de cada reactive se evaluaba con `new
//   Function('return (' + expr + ')')()` — SIN NINGÚN ÁMBITO, ni siquiera
//   las function existían todavía en ese punto. Fallaba siempre, con
//   cualquier cosa que no fuera un literal (`LIMITE is not defined`, `doble
//   is not defined`).
//
// El arreglo: las const/var de nivel superior que NO leen ninguna reactive
// (ni de forma directa ni a través de otra que sí lo haga) se adelantan
// antes de crear `state`/calcular los valores iniciales — tanto en el
// bundle de cliente como en SSR, con el mismo criterio en los dos sitios.
// Una CUALQUIERA que contenga una llamada a function se trata siempre como
// "depende de state" (no hay forma de saber si esa function lee una
// reactive por dentro sin analizar su cuerpo) — más conservador, pero
// evita un bug real encontrado en el camino (ver el test de la cadena).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM, VirtualConsole } = require("jsdom");
const { parse } = require("../parser");
const { generateClientBundle } = require("../codegen-client");
const { renderPageToHTML } = require("../codegen-ssr");

function textoSSR(wsf) {
	const html = renderPageToHTML(parse(wsf), {});
	const m = /<p[^>]*>(.*?)<\/p>/.exec(html);
	return m ? m[1].replace(/<!--\/?t-->/g, "") : html;
}

function textoCliente(wsf) {
	const bundle = generateClientBundle(parse(wsf), {});
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { runScripts: "dangerously", virtualConsole: new VirtualConsole() });
	let error = null;
	dom.window.onerror = (e) => {
		error = e;
	};
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	if (error) throw new Error(error);
	return dom.window.document.querySelector("p").textContent;
}

function pagina(cabecera, exprReactive) {
	return [...cabecera, "", `reactive integer c = ${exprReactive}`, "", "visual app =", "<p>{c}</p>", "", "Visual.render(app)"].join("\n");
}

test("REGRESIÓN: una reactive inicializada con una const declarada ANTES en el código fuente — cliente", () => {
	assert.equal(textoCliente(pagina(["const LIMITE = 10"], "LIMITE")), "10");
});

test("REGRESIÓN: la misma página, en SSR", () => {
	assert.equal(textoSSR(pagina(["const LIMITE = 10"], "LIMITE")), "10");
});

test("REGRESIÓN: una reactive inicializada con una const declarada DESPUÉS en el código fuente — cliente (el orden textual no debería importar)", () => {
	const wsf = ["reactive integer c = LIMITE", "", "const LIMITE = 10", "", "visual app =", "<p>{c}</p>", "", "Visual.render(app)"].join("\n");
	assert.equal(textoCliente(wsf), "10");
});

test("REGRESIÓN: una reactive inicializada llamando a una function — en SSR (en cliente ya funcionaba, por el *hoisting* de `function`)", () => {
	assert.equal(textoSSR(pagina(["function doble(x)", "\treturn x * 2"], "doble(5)")), "10");
});

test("NO REGRESIÓN: una const que SÍ lee una reactive (vía `state`) se sigue evaluando DESPUÉS, y sigue funcionando — cliente y SSR", () => {
	const wsf = ["reactive contador = 5", "const doble = contador * 2", "", "visual app =", "<p>{doble}</p>", "", "Visual.render(app)"].join("\n");
	assert.equal(textoCliente(wsf), "10");
	assert.equal(textoSSR(wsf), "10");
});

test("una cadena de consts (A -> B -> reactive), todas PRE-estado, se resuelve en orden — cliente y SSR", () => {
	const wsf = ["const A = 5", "const B = A + 1", "", "reactive integer c = B", "", "visual app =", "<p>{c}</p>", "", "Visual.render(app)"].join("\n");
	assert.equal(textoCliente(wsf), "6");
	assert.equal(textoSSR(wsf), "6");
});

test("REGRESIÓN (bug encontrado en el camino): una const que LLAMA a una function que lee una reactive por dentro se queda POST-estado, y lo que la usa después también — sin esto daba NaN en vez del valor real", () => {
	const wsf = [
		"reactive base = 10",
		"",
		"function conBase(x)",
		"\treturn x + base",
		"",
		"const resultado = conBase(1)",
		"const derivado = resultado * 2",
		"",
		"visual app =",
		"<p>{derivado}</p>",
		"",
		"Visual.render(app)",
	].join("\n");
	assert.equal(textoCliente(wsf), "22");
	assert.equal(textoSSR(wsf), "22");
});

test("una const PRE-estado puede venir de un .js importado (a través de un .ws), y una reactive puede usarla", () => {
	const fs = require("fs");
	const os = require("os");
	const path = require("path");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "websc-reactive-const-"));
	fs.writeFileSync(path.join(dir, "ayuda.js"), "module.exports = { triple: (x) => x * 3 };");
	fs.writeFileSync(path.join(dir, "consts.ws"), ['import { triple } from "./ayuda.js"', "", "export const TRIPLE_DE_DOS = triple(2)"].join("\n"));
	const wsf = ['import { TRIPLE_DE_DOS } from "./consts.ws"', "", "reactive integer c = TRIPLE_DE_DOS", "", "visual app =", "<p>{c}</p>", "", "Visual.render(app)"].join("\n");

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
	assert.equal(dom.window.document.querySelector("p").textContent, "6");

	const html = renderPageToHTML(parse(wsf), { baseDir: dir });
	assert.match(html, /6/);
});
