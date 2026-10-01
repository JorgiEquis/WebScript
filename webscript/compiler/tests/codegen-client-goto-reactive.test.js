// `goto()` (alias reservado de `Visual.navigate()`, sistema nuevo) y la
// REACTIVIDAD de `params`/`query` tras navegar. Antes, `params`/`query`
// se calculaban UNA VEZ al cargar el script (`const params = {...}`) —
// funcionaban en la carga inicial, pero un `goto()` (o el atrás/adelante
// del navegador) no los actualizaba, y una `const` derivada de ellos
// (`const titulo = "Producto " + params.id`) tampoco.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM, VirtualConsole } = require("jsdom");
const { parse } = require("../parser");
const { generateClientBundle } = require("../codegen-client");

function montar(wsf, routePattern, url) {
	const bundle = generateClientBundle(parse(wsf), { routePattern });
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { runScripts: "dangerously", virtualConsole: new VirtualConsole(), url });
	let error = null;
	dom.window.addEventListener("error", (e) => {
		error = e.message;
	});
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	if (error) throw new Error(error);
	return dom.window;
}

test("REGRESIÓN: goto() cambia la URL sin recargar (alias de Visual.navigate())", () => {
	const win = montar(["<div>", "\t<button onclick={goto('/otra')}>ir</button>", "</div>"].join("\n"), null, "http://localhost/pagina");
	win.document.querySelector("button").dispatchEvent(new win.Event("click"));
	assert.equal(win.location.pathname, "/otra");
});

test("REGRESIÓN: params.id se recalcula solo tras goto(), sin recargar", () => {
	const win = montar(
		["<div>", "\t<h1>Producto {params.id}</h1>", "\t<button onclick={goto('/producto/99')}>ver otro</button>", "</div>"].join("\n"),
		"/producto/:id",
		"http://localhost/producto/42"
	);
	assert.equal(win.document.querySelector("h1").textContent, "Producto 42");
	win.document.querySelector("button").dispatchEvent(new win.Event("click"));
	assert.equal(win.location.pathname, "/producto/99");
	assert.equal(win.document.querySelector("h1").textContent, "Producto 99");
});

test("REGRESIÓN (el bug real encontrado al implementar): una const derivada de params/query TAMBIÉN se recalcula tras goto() — antes vivía en un effect() distinto y no se enteraba", () => {
	const wsf = [
		"const titulo = 'Producto ' + params.id",
		"",
		"<div>",
		"\t<h1>{titulo}</h1>",
		"\t<p>Orden: {query.orden}</p>",
		"\t<button onclick={goto('/producto/7?orden=precio')}>ver otro</button>",
		"</div>",
	].join("\n");
	const win = montar(wsf, "/producto/:id", "http://localhost/producto/42?orden=fecha");
	assert.equal(win.document.querySelector("h1").textContent, "Producto 42");
	assert.equal(win.document.querySelector("p").textContent, "Orden: fecha");
	win.document.querySelector("button").dispatchEvent(new win.Event("click"));
	assert.equal(win.document.querySelector("h1").textContent, "Producto 7", "antes: se quedaba en 42, la const no se recalculaba");
	assert.equal(win.document.querySelector("p").textContent, "Orden: precio");
});

test("params.id se recalcula también tras el atrás/adelante del navegador (popstate), no solo tras goto()", () => {
	const win = montar(
		["<div>", "\t<h1>Producto {params.id}</h1>", "\t<button onclick={goto('/producto/99')}>ver otro</button>", "</div>"].join("\n"),
		"/producto/:id",
		"http://localhost/producto/42"
	);
	win.document.querySelector("button").dispatchEvent(new win.Event("click"));
	assert.equal(win.document.querySelector("h1").textContent, "Producto 99");
	win.history.back();
	// history.back() dispara 'popstate' de forma asíncrona incluso en JSDOM;
	// el propio test runner ya deja pasar un tick entre aserciones síncronas
	// consecutivas no basta — se espera explícitamente al evento.
	return new Promise((resolve) => {
		win.addEventListener("popstate", () => {
			assert.equal(win.document.querySelector("h1").textContent, "Producto 42");
			resolve();
		});
	});
});

test("NO REGRESIÓN: sin routePattern (sistema antiguo, o generateClientBundle sin pasarlo) no se emite ningún efecto de params/query", () => {
	const bundle = generateClientBundle(parse("<p>hola</p>"), {});
	assert.doesNotMatch(bundle, /state\.params/);
	assert.doesNotMatch(bundle, /state\.query/);
});

test("NO REGRESIÓN: Visual.navigate() (sistema antiguo) sigue funcionando exactamente igual, sin cambios", () => {
	const win = montar(["<div>", "\t<button onclick={Visual.navigate('/otra')}>ir</button>", "</div>"].join("\n"), null, "http://localhost/pagina");
	win.document.querySelector("button").dispatchEvent(new win.Event("click"));
	assert.equal(win.location.pathname, "/otra");
});
