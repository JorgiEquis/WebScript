const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const fs = require("fs");
const { parse } = require("../parser");
const { generateClientBundle } = require("../codegen-client");

function mount(source) {
	const bundle = generateClientBundle(parse(source));
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { runScripts: "dangerously" });
	let error = null;
	dom.window.onerror = (msg) => { error = msg; };

	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);

	if (error) throw new Error("Error en el bundle generado: " + error);
	return dom.window.document;
}

const path = require("path");

function mountFile(relativePath) {
	const fullPath = path.join(__dirname, "../../src", relativePath);
	const source = fs.readFileSync(fullPath, "utf8");
	const bundle = generateClientBundle(parse(source), { baseDir: path.dirname(fullPath) });

	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { runScripts: "dangerously" });
	let error = null;
	dom.window.onerror = (msg) => { error = msg; };

	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);

	if (error) throw new Error("Error en el bundle generado: " + error);
	return dom.window.document;
}

test("integración real (app.wsf con imports): función de .ws se resuelve de verdad", () => {
	const doc = mountFile("app.wsf");
	assert.equal(doc.querySelector("h1").textContent, "MI APP WEBSCRIPT");
});

test("integración real: el nombre de un style se compila a clase CSS literal, no a variable JS", () => {
	const doc = mountFile("app.wsf");
	assert.equal(doc.querySelector("div").getAttribute("class"), "contenedor");
});

test("integración real: componente importado de otro .wsf se genera de verdad, no como HTML plano", () => {
	const doc = mountFile("app.wsf");
	const botonesSumar = Array.from(doc.querySelectorAll("button")).filter((b) => b.textContent === "Sumar");
	assert.equal(botonesSumar.length, 2); // uno por cada contadorItem generado por el for
});

test("integración real: Visual.route()/params()/query() leen la URL real del navegador", () => {
	const source = [
		"const Visual screen = Visual.route('/personas/:id')",
		"const {id} = Visual.params(screen)",
		"const {tab} = Visual.query(screen)",
		"",
		"visual app =",
		"<div>",
		"\t<p>ID: {id}</p>",
		"\t<p>Tab: {tab}</p>",
		"</div>",
		"",
		"Visual.render(app)",
	].join("\n");

	const bundle = generateClientBundle(parse(source));
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
		runScripts: "dangerously",
		url: "http://localhost/personas/42?tab=datos",
	});
	let error = null;
	dom.window.onerror = (msg) => { error = msg; };
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	if (error) throw new Error(error);

	const doc = dom.window.document;
	assert.equal(doc.querySelectorAll("p")[0].textContent, "ID: 42");
	assert.equal(doc.querySelectorAll("p")[1].textContent, "Tab: datos");
});

test("integración real: cada componente importado dentro de un for mantiene estado independiente", () => {
	const doc = mountFile("app.wsf");
	const botonesSumar = Array.from(doc.querySelectorAll("button")).filter((b) => b.textContent === "Sumar");
	botonesSumar[0].dispatchEvent(new doc.defaultView.Event("click"));
	botonesSumar[0].dispatchEvent(new doc.defaultView.Event("click"));
	const parrafos = Array.from(doc.querySelectorAll("p")).map((p) => p.textContent);
	assert.ok(parrafos.includes("Vas por buen camino: 2"));
	assert.ok(parrafos.includes("Aún no hay clicks"));
});

const CONTADOR_SOURCE = [
	"reactive contador = 0",
	"",
	"visual app =",
	"<div>",
	"\t<button onclick={contador++}>Sumar</button>",
	"\t<p>Valor: {contador}</p>",
	"",
	"\tif (contador == 0)",
	"\t\t<p>cero</p>",
	"\telse",
	"\t\t<p>no-cero</p>",
	"",
	"\t<ul>",
	"\t\tfor (n in [1, 2, 3])",
	"\t\t\t<li>{n}</li>",
	"\t</ul>",
	"</div>",
	"",
	"Visual.render(app)",
].join("\n");

test("integración: texto interpolado se actualiza al hacer clic", () => {
	const doc = mount(CONTADOR_SOURCE);
	assert.equal(doc.querySelector("p").textContent, "Valor: 0");
	doc.querySelector("button").dispatchEvent(new doc.defaultView.Event("click"));
	assert.equal(doc.querySelector("p").textContent, "Valor: 1");
});

test("integración: if/else cambia de rama de forma reactiva", () => {
	const doc = mount(CONTADOR_SOURCE);
	assert.equal(doc.querySelectorAll("p")[1].textContent, "cero");
	doc.querySelector("button").dispatchEvent(new doc.defaultView.Event("click"));
	assert.equal(doc.querySelectorAll("p")[1].textContent, "no-cero");
});

test("integración: for renderiza todos los elementos de la lista", () => {
	const doc = mount(CONTADOR_SOURCE);
	assert.deepEqual(Array.from(doc.querySelectorAll("li")).map((li) => li.textContent), ["1", "2", "3"]);
});

test("REGRESIÓN bug real: el if/else no debe borrar hermanos posteriores (ej. un <ul> más abajo) al re-renderizar", () => {
	const doc = mount(CONTADOR_SOURCE);
	// Antes del fix, el effect del if/else limpiaba con
	// `while (anchor.nextSibling) remove()`, que se llevaba por delante
	// TODO lo que viniera después en el mismo padre — incluido el <ul>.
	for (let i = 0; i < 5; i++) {
		doc.querySelector("button").dispatchEvent(new doc.defaultView.Event("click"));
	}
	assert.ok(doc.querySelector("ul"), "el <ul> debe seguir existiendo tras varios re-renders del if/else");
	assert.equal(doc.querySelectorAll("li").length, 3, "el for no debe perder sus elementos");
});

const COMPOSICION_SOURCE = [
	"reactive contadores = [{ valor: 0 }, { valor: 0 }]",
	"",
	"visual contadorItem =",
	'<div class="item">',
	"\t<button onclick={props.item.valor++}>Sumar</button>",
	"\t<p>{props.item.valor}</p>",
	"</div>",
	"",
	"visual tarjeta =",
	'<div class="tarjeta">',
	'\t<header><slot name="header" /></header>',
	'\t<div class="cuerpo"><slot /></div>',
	"</div>",
	"",
	"visual app =",
	"<div>",
	"\t<tarjeta>",
	'\t\t<h3 slot="header">Contadores</h3>',
	"\t\tfor (item in contadores)",
	"\t\t\t<contadorItem item={item} />",
	"\t</tarjeta>",
	"</div>",
	"",
	"Visual.render(app)",
].join("\n");

test("integración: slot con nombre coloca el contenido en el hueco correcto", () => {
	const doc = mount(COMPOSICION_SOURCE);
	assert.equal(doc.querySelector("header").textContent, "Contadores");
});

test("integración: slot por defecto recibe el resto del contenido (el for con los componentes)", () => {
	const doc = mount(COMPOSICION_SOURCE);
	assert.equal(doc.querySelectorAll(".cuerpo .item").length, 2);
});

test("integración: cada instancia de un componente en un for tiene su prop independiente", () => {
	const doc = mount(COMPOSICION_SOURCE);
	const botones = doc.querySelectorAll(".item button");
	botones[0].dispatchEvent(new doc.defaultView.Event("click"));
	const valores = Array.from(doc.querySelectorAll(".item p")).map((p) => p.textContent);
	assert.deepEqual(valores, ["1", "0"]);
});
