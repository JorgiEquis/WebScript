const { test } = require("node:test");
const assert = require("node:assert/strict");
const { tokenize, buildTree, bracketDelta } = require("../lexer");

test("ignora líneas en blanco y comentarios de línea completa", () => {
	const lines = tokenize(`
reactive x = 1

// esto es un comentario, fuera
reactive y = 2
`);
	assert.equal(lines.length, 2);
	assert.equal(lines[0].text, "reactive x = 1");
	assert.equal(lines[1].text, "reactive y = 2");
});

test("calcula la indentación con tabs", () => {
	const lines = tokenize("style boton =\n\t-> color: red\n\t\t-> anidado: mas");
	assert.equal(lines[0].indent, 0);
	assert.equal(lines[1].indent, 1);
	assert.equal(lines[2].indent, 2);
});

test("4 espacios cuentan como 1 tab de indentación", () => {
	const lines = tokenize("style boton =\n    -> color: red");
	assert.equal(lines[1].indent, 1);
});

test("bracketDelta ignora paréntesis dentro de cadenas", () => {
	assert.equal(bracketDelta('var x = "(no cuenta"'), 0);
	assert.equal(bracketDelta("var x = new Persona("), 1);
	assert.equal(bracketDelta(")"), -1);
});

test("bracketDelta corta en un comentario // fuera de cadena", () => {
	assert.equal(bracketDelta("var x = 1 // (esto tampoco cuenta"), 0);
});

test("fusiona líneas mientras haya paréntesis sin cerrar (expresión multilínea)", () => {
	const lines = tokenize([
		"var nueva = new Persona(",
		"\tcontenido.nombre,",
		"\tcontenido.altura",
		")",
	].join("\n"));

	// Regresión del bug real: sin la fusión, esto salían 4 líneas sueltas
	// en vez de una única sentencia completa.
	assert.equal(lines.length, 1);
	assert.equal(lines[0].text, "var nueva = new Persona( contenido.nombre, contenido.altura )");
});

test("no fusiona líneas independientes que no dejan paréntesis abiertos", () => {
	const lines = tokenize("var a = 1\nvar b = 2");
	assert.equal(lines.length, 2);
});

test("buildTree anida por indentación creciente y desapila al bajar", () => {
	const lines = tokenize([
		"if (x)",
		"\t<p>uno</p>",
		"\t<p>dos</p>",
		"else",
		"\t<p>tres</p>",
	].join("\n"));
	const tree = buildTree(lines);

	assert.equal(tree.length, 2); // if, else
	assert.equal(tree[0].children.length, 2); // <p>uno</p>, <p>dos</p>
	assert.equal(tree[1].children.length, 1); // <p>tres</p>
});
