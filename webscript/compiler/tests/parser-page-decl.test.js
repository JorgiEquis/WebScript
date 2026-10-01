// El HTML suelto de una página, sin envolver en `visual nombre = ` — la
// clase Visual.ws y sus métodos siguen existiendo (sistema ADITIVO: nada
// de esto cambia el comportamiento de un .wsf que ya usa `visual` +
// Visual.render()), pero ahora TAMBIÉN se puede escribir el HTML de la
// página directamente a nivel de fichero, sin envolverlo en nada, con
// if/for/interpolación funcionando igual que ya funcionaban dentro de un
// `visual` — reutilizando exactamente el mismo motor (`buildHtmlTree`,
// `parseTemplateSequence`), no uno duplicado.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("../parser");

test("HTML suelto simple produce un nodo PageDecl", () => {
	const ast = parse("<div>hola</div>");
	const page = ast.body.find((n) => n.type === "PageDecl");
	assert.ok(page, "debería haber un PageDecl");
	assert.equal(page.html.length, 1);
	assert.equal(page.html[0].type, "Element");
	assert.equal(page.html[0].name, "div");
});

test("HTML suelto con if/else mezclado, interpolación y onclick — el ejemplo real reportado", () => {
	const ast = parse(
		[
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
		].join("\n")
	);
	assert.deepEqual(
		ast.body.map((n) => n.type + (n.name ? ":" + n.name : "")),
		["ConstDecl:LIMITE", "ReactiveDecl:contador", "FunctionDecl:doble", "PageDecl"]
	);
	const page = ast.body.find((n) => n.type === "PageDecl");
	assert.deepEqual(page.htmlErrors, []);
	assert.equal(page.html[0].name, "html");
});

test("las declaraciones (const/reactive/function) se reconocen igual, vengan ANTES o DESPUÉS del HTML suelto", () => {
	const ast = parse(["<p>{n}</p>", "", "reactive n = 5"].join("\n"));
	assert.deepEqual(
		ast.body.map((n) => n.type),
		["PageDecl", "ReactiveDecl"]
	);
});

test("una 'reactive' MEZCLADA con el HTML suelto (indentada, dentro del bloque) da un error de htmlErrors, no una excepción — mismo límite preexistente que ya tenía un 'visual' con una reactive sin indentar al margen", () => {
	const ast = parse(["<div>", "\treactive n = 5", "\t<p>{n}</p>", "</div>"].join("\n"));
	const page = ast.body.find((n) => n.type === "PageDecl");
	assert.equal(page.htmlErrors.length, 1);
	assert.match(page.htmlErrors[0].message, /reactive.*mezclada con el HTML suelto/);
});

test("un fragmento sin <html> envolvente (un <div> suelto) también es un PageDecl válido", () => {
	const ast = parse(["reactive n = 5", "", "<div>", "\t<p>Valor: {n}</p>", "</div>"].join("\n"));
	const page = ast.body.find((n) => n.type === "PageDecl");
	assert.ok(page);
	assert.equal(page.html[0].name, "div");
});

test("un componente autocerrado (<Componente />) al margen también dispara el HTML suelto", () => {
	const ast = parse(['import { Tarjeta } from "./tarjeta.wsf"', "", "<Tarjeta />"].join("\n"));
	const page = ast.body.find((n) => n.type === "PageDecl");
	assert.ok(page);
	assert.equal(page.html[0].name, "Tarjeta");
});

test("NO REGRESIÓN: `visual nombre = ` sigue funcionando exactamente igual (no produce un PageDecl)", () => {
	const ast = parse(["visual app =", "<p>hola</p>", "", "Visual.render(app)"].join("\n"));
	assert.equal(ast.body.some((n) => n.type === "PageDecl"), false);
	const visual = ast.body.find((n) => n.type === "VisualDecl");
	assert.ok(visual);
	assert.equal(visual.name, "app");
});
