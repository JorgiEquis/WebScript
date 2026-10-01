const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { parse } = require("../parser");
const { generateClientBundle } = require("../codegen-client");
const { renderPageToHTML } = require("../codegen-ssr");

function mount(source, url) {
	const bundle = generateClientBundle(parse(source), {});
	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
		runScripts: "dangerously",
		url: url || "http://localhost/",
	});
	let error = null;
	dom.window.onerror = (msg) => {
		error = msg;
	};
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	if (error) throw new Error(error);
	return dom;
}

const ROUTE_SOURCE = [
	"const Visual screen = Visual.route('/personas/:id')",
	"const {id} = Visual.params(screen)",
	"",
	"visual app =",
	"<div>",
	"\t<p>ID actual: {id}</p>",
	"</div>",
	"",
	"Visual.render(app)",
].join("\n");

test("router reactivo: la interpolación refleja el :id de la URL con la que se cargó la página", () => {
	const dom = mount(ROUTE_SOURCE, "http://localhost/personas/7");
	assert.equal(dom.window.document.querySelector("p").textContent, "ID actual: 7");
});

test("router reactivo: Visual.navigate() actualiza la interpolación SIN recargar, y cambia la URL real", () => {
	const dom = mount(ROUTE_SOURCE, "http://localhost/personas/7");
	dom.window.eval('Visual.navigate("/personas/99");');
	assert.equal(dom.window.document.querySelector("p").textContent, "ID actual: 99");
	assert.equal(dom.window.location.pathname, "/personas/99");
});

test("router reactivo: Visual.navigate() reutiliza el nodo DOM, no lo recrea", () => {
	const dom = mount(ROUTE_SOURCE, "http://localhost/personas/7");
	const doc = dom.window.document;
	doc.querySelector("p").__marca = "original";
	dom.window.eval('Visual.navigate("/personas/42");');
	assert.equal(doc.querySelector("p").__marca, "original");
});

test("router reactivo: un popstate (atrás/adelante del navegador) también actualiza la interpolación", () => {
	const dom = mount(ROUTE_SOURCE, "http://localhost/personas/7");
	dom.window.history.pushState(null, "", "/personas/50");
	dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
	assert.equal(dom.window.document.querySelector("p").textContent, "ID actual: 50");
});

test("router reactivo: Visual.query() también es reactivo ante un cambio de query string", () => {
	const source = [
		"const Visual screen = Visual.route('/buscar')",
		"const {termino} = Visual.query(screen)",
		"",
		"visual app =",
		"<p>Buscando: {termino}</p>",
		"",
		"Visual.render(app)",
	].join("\n");
	const dom = mount(source, "http://localhost/buscar?termino=gatos");
	assert.equal(dom.window.document.querySelector("p").textContent, "Buscando: gatos");

	dom.window.eval('Visual.navigate("/buscar?termino=perros");');
	assert.equal(dom.window.document.querySelector("p").textContent, "Buscando: perros");
});

test("router reactivo: navigate({replace:true}) sustituye la entrada del historial en vez de apilar una nueva", () => {
	const dom = mount(ROUTE_SOURCE, "http://localhost/personas/7");
	const historyLengthAntes = dom.window.history.length;
	dom.window.eval('Visual.navigate("/personas/8", { replace: true });');
	assert.equal(dom.window.history.length, historyLengthAntes); // no creció: fue un replace
	assert.equal(dom.window.location.pathname, "/personas/8");
});

test("router reactivo: SSR + hidratación + navegación posterior conservan el mismo nodo del SSR", () => {
	const ast = parse(ROUTE_SOURCE);
	const ssrHtml = renderPageToHTML(ast, { requestUrl: "/personas/7" });
	assert.equal(ssrHtml, "<div><p><!--t-->ID actual: 7<!--/t--></p></div>");

	const bundle = generateClientBundle(ast, {});
	const dom = new JSDOM(`<!DOCTYPE html><html><body>${ssrHtml}</body></html>`, {
		runScripts: "dangerously",
		url: "http://localhost/personas/7",
	});
	let error = null;
	dom.window.onerror = (msg) => {
		error = msg;
	};
	const doc = dom.window.document;
	doc.querySelector("p").__marcaSSR = "del-ssr";

	const script = doc.createElement("script");
	script.textContent = bundle;
	doc.body.appendChild(script);
	if (error) throw new Error(error);

	assert.equal(doc.querySelector("p").__marcaSSR, "del-ssr"); // hidratado, no recreado

	dom.window.eval('Visual.navigate("/personas/123");');
	assert.equal(doc.querySelector("p").textContent, "ID actual: 123");
	assert.equal(doc.querySelector("p").__marcaSSR, "del-ssr"); // sigue siendo el mismo nodo
});

test("sin relación con la ruta: un const de nivel superior normal sigue comportándose igual que antes (una sola vez, no reactivo)", () => {
	const source = ["const saludo = 'hola'", "visual app =", "<p>{saludo}</p>", "Visual.render(app)"].join("\n");
	const dom = mount(source);
	assert.equal(dom.window.document.querySelector("p").textContent, "hola");
});
