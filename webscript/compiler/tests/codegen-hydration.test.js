const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { parse } = require("../parser");
const { generateClientBundle } = require("../codegen-client");
const { renderPageToHTML } = require("../codegen-ssr");

function ssrThenHydrate(sourceLines) {
	const ast = parse(sourceLines.join("\n"));
	const ssrHtml = renderPageToHTML(ast, {});
	const bundle = generateClientBundle(ast, {});

	const dom = new JSDOM(`<!DOCTYPE html><html><body>${ssrHtml}</body></html>`, { runScripts: "dangerously" });
	let error = null;
	dom.window.onerror = (msg) => { error = msg; };

	return { dom, doc: dom.window.document, bundle, mount: () => {
		const script = dom.window.document.createElement("script");
		script.textContent = bundle;
		dom.window.document.body.appendChild(script);
		if (error) throw new Error(error);
	} };
}

test("hidratación: un elemento fuera de if/for es el MISMO nodo tras hidratar, no uno recreado", () => {
	const { doc, mount } = ssrThenHydrate([
		"reactive contador = 0",
		"visual app =",
		'<div id="raiz">',
		"\t<button onclick={contador++}>Sumar</button>",
		"\t<p>Valor: {contador}</p>",
		"</div>",
		"Visual.render(app)",
	]);

	const before = doc.getElementById("raiz");
	before.__marca = "original";

	mount();

	assert.equal(doc.getElementById("raiz").__marca, "original");
});

test("hidratación: la interpolación de texto reutilizada sigue siendo reactiva tras el clic", () => {
	const { doc, mount } = ssrThenHydrate([
		"reactive contador = 0",
		"visual app =",
		"<div>",
		"\t<button onclick={contador++}>Sumar</button>",
		"\t<p>Valor: {contador}</p>",
		"</div>",
		"Visual.render(app)",
	]);
	mount();

	assert.equal(doc.querySelector("p").textContent, "Valor: 0");
	doc.querySelector("button").dispatchEvent(new doc.defaultView.Event("click"));
	assert.equal(doc.querySelector("p").textContent, "Valor: 1");
});

test("hidratación: contenido de slot (sin if/for) reutiliza el mismo nodo", () => {
	const { doc, mount } = ssrThenHydrate([
		'reactive titulo = "Panel"',
		"visual tarjeta =",
		'<div class="tarjeta"><slot /></div>',
		"visual app =",
		"<tarjeta><h3>{titulo}</h3></tarjeta>",
		"Visual.render(app)",
	]);

	const before = doc.querySelector("h3");
	before.__marca = "original";

	mount();

	assert.equal(doc.querySelector("h3").__marca, "original");
	assert.equal(doc.querySelector("h3").textContent, "Panel");
});

test("hidratación: if/else sigue siendo reactivo tras hidratar (se reconstruye localmente, límite conocido)", () => {
	const { doc, mount } = ssrThenHydrate([
		"reactive contador = 0",
		"visual app =",
		"<div>",
		"\t<button onclick={contador++}>Sumar</button>",
		"\tif (contador == 0)",
		"\t\t<p>cero</p>",
		"\telse",
		"\t\t<p>no-cero</p>",
		"</div>",
		"Visual.render(app)",
	]);
	mount();

	assert.equal(doc.querySelectorAll("p")[0].textContent, "cero");
	doc.querySelector("button").dispatchEvent(new doc.defaultView.Event("click"));
	assert.equal(doc.querySelectorAll("p")[0].textContent, "no-cero");
});

test("hidratación: for sigue siendo reactivo tras hidratar, y no rompe hermanos posteriores", () => {
	const { doc, mount } = ssrThenHydrate([
		'reactive frutas = ["a", "b"]',
		"visual app =",
		"<div>",
		"\t<ul>",
		"\t\tfor (f in frutas)",
		"\t\t\t<li>{f}</li>",
		"\t</ul>",
		"\t<p>después</p>",
		"</div>",
		"Visual.render(app)",
	]);
	mount();

	assert.deepEqual(Array.from(doc.querySelectorAll("li")).map((li) => li.textContent), ["a", "b"]);
	assert.equal(doc.querySelector("p").textContent, "después"); // sobrevive a la hidratación del for
});

test("hidratación: composición completa (props+slot dentro de un for) sigue siendo interactiva, cada instancia independiente", () => {
	const { doc, mount } = ssrThenHydrate([
		"reactive contadores = [{ valor: 0 }, { valor: 0 }]",
		"visual contadorItem =",
		'<div class="item">',
		"\t<button onclick={props.item.valor++}>Sumar</button>",
		"\t<p>{props.item.valor}</p>",
		"</div>",
		"visual app =",
		"<div>",
		"\tfor (item in contadores)",
		"\t\t<contadorItem item={item} />",
		"</div>",
		"Visual.render(app)",
	]);
	mount();

	const botones = doc.querySelectorAll(".item button");
	assert.equal(botones.length, 2);
	botones[0].dispatchEvent(new doc.defaultView.Event("click"));
	assert.deepEqual(Array.from(doc.querySelectorAll(".item p")).map((p) => p.textContent), ["1", "0"]);
});

test("sin SSR (body vacío salvo el propio <script>), sigue montando desde cero con create_ como antes", () => {
	const ast = parse(["reactive n = 0", "visual app =", "<p>{n}</p>", "Visual.render(app)"].join("\n"));
	const bundle = generateClientBundle(ast, {});

	const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { runScripts: "dangerously" });
	let error = null;
	dom.window.onerror = (msg) => { error = msg; };
	const script = dom.window.document.createElement("script");
	script.textContent = bundle;
	dom.window.document.body.appendChild(script);
	if (error) throw new Error(error);

	assert.equal(dom.window.document.querySelector("p").textContent, "0");
});
