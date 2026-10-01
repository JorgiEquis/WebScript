// El sistema nuevo (HTML suelto, sin Visual.ws) renderizado de verdad —
// SSR y bundle de cliente, ejecutados con JSDOM, no solo comparación de
// texto. Reutiliza generateClientBundle/renderPageToHTML tal cual (el
// PageDecl se trata como una `visual` más, con el nombre interno
// "__page__" — ver codegen-client.js/codegen-ssr.js), así que la
// hidratación, if/for, interpolación, eventos y demás funcionan
// exactamente igual que ya funcionaban para una `visual`.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM, VirtualConsole } = require("jsdom");
const { parse } = require("../parser");
const { generateClientBundle } = require("../codegen-client");
const { renderPageToHTML } = require("../codegen-ssr");

function ejecutar(bundle, ssrHtml, url) {
	const dom = new JSDOM(ssrHtml ? "<!DOCTYPE html>" + ssrHtml : "<!DOCTYPE html><html><body></body></html>", {
		runScripts: "dangerously",
		virtualConsole: new VirtualConsole(),
		url,
	});
	let error = null;
	dom.window.addEventListener("error", (e) => {
		error = e.message;
	});
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	if (error) throw new Error(error);
	return dom.window.document;
}

test("REGRESIÓN nueva capacidad: el ejemplo real reportado (HTML suelto completo con <html>, if/else, interpolación, onclick) funciona de extremo a extremo", () => {
	const wsf = [
		"const LIMITE = 10",
		"",
		"reactive contador = 0",
		"",
		"function doble(x)",
		"\treturn x * 2",
		"",
		"<html>",
		"<head><title>Prueba</title></head>",
		"<body>",
		"<div>",
		"if (contador > LIMITE)",
		"\t<p>Pasado el límite</p>",
		"else",
		"\t<p>Contador: {contador}</p>",
		"<button onclick={contador = doble(contador + 1)}>sumar</button>",
		"</div>",
		"</body>",
		"</html>",
	].join("\n");
	const ast = parse(wsf);
	const html = renderPageToHTML(ast, {});
	assert.match(html, /<html><head><title>Prueba<\/title><\/head><body>/);
	assert.match(html, /Contador: 0/);

	const bundle = generateClientBundle(ast, {});
	const doc = ejecutar(bundle, html);
	assert.equal(doc.querySelector("p").textContent, "Contador: 0");
	doc.querySelector("button").dispatchEvent(new doc.defaultView.Event("click"));
	assert.equal(doc.querySelector("p").textContent, "Contador: 2");
});

test("un fragmento suelto (sin <html> envolvente) también hidrata y reacciona bien", () => {
	const wsf = ["reactive n = 5", "", "<div>", "\t<p>Valor: {n}</p>", "\t<button onclick={n = n + 1}>subir</button>", "</div>"].join("\n");
	const ast = parse(wsf);
	const html = renderPageToHTML(ast, {});
	const bundle = generateClientBundle(ast, {});
	const doc = ejecutar(bundle, `<html><body>${html}</body></html>`);
	assert.equal(doc.querySelector("p").textContent, "Valor: 5");
	doc.querySelector("button").dispatchEvent(new doc.defaultView.Event("click"));
	assert.equal(doc.querySelector("p").textContent, "Valor: 6");
});

test("NO REGRESIÓN: una única 'visual' sin Visual.render() (estilo antiguo) sigue SIN renderizarse implícitamente — deliberadamente restringido a solo PageDecl, para no romper componentes reutilizables reales como src/contador.wsf", () => {
	const ast = parse(["reactive x = 1", "", "visual app =", "<p>x vale {x}</p>"].join("\n"));
	const html = renderPageToHTML(ast, {});
	assert.equal(html, "");
});

test("REGRESIÓN: params.id y query.campo, nombres reservados, llegan con el valor correcto — SSR y cliente, con una URL real", () => {
	const ast = parse(["<div>", "\t<p>Producto: {params.id}</p>", "\t<p>Orden: {query.orden}</p>", "</div>"].join("\n"));
	const html = renderPageToHTML(ast, { requestUrl: "/producto/42?orden=fecha", routePattern: "/producto/:id" });
	assert.match(html, /Producto: 42/);
	assert.match(html, /Orden: fecha/);

	const bundle = generateClientBundle(ast, { routePattern: "/producto/:id" });
	const doc = ejecutar(bundle, `<html><body>${html}</body></html>`, "http://localhost/producto/42?orden=fecha");
	const ps = doc.querySelectorAll("p");
	assert.equal(ps[0].textContent, "Producto: 42");
	assert.equal(ps[1].textContent, "Orden: fecha");
});

test("NO REGRESIÓN: sin routePattern (una página del sistema antiguo, o generateClientBundle llamado sin él) no se emite el código de params/query del sistema nuevo", () => {
	const ast = parse("<p>hola</p>");
	const bundle = generateClientBundle(ast, {});
	assert.doesNotMatch(bundle, /__routeMatch/);
});
