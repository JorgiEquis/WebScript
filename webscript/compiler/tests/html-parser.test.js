const { test } = require("node:test");
const assert = require("node:assert/strict");
const { scanLine, parseAttrs, buildHtmlTree } = require("../html-parser");

test("scanLine reconoce apertura, texto y cierre en la misma línea", () => {
	const tokens = scanLine("<button onclick={contador++}>Sumar</button>");
	assert.equal(tokens.length, 3);
	assert.equal(tokens[0].kind, "open");
	assert.equal(tokens[0].name, "button");
	assert.equal(tokens[1].kind, "text");
	assert.equal(tokens[1].value, "Sumar");
	assert.equal(tokens[2].kind, "close");
	assert.equal(tokens[2].name, "button");
});

test("scanLine reconoce autocierre", () => {
	const tokens = scanLine("<componente />");
	assert.equal(tokens.length, 1);
	assert.equal(tokens[0].kind, "selfclose");
	assert.equal(tokens[0].name, "componente");
});

test("scanLine no se corta en un '>' dentro de una interpolación", () => {
	// Bug real de la versión anterior: un > de comparación dentro de {} no
	// debe cerrar el tag antes de tiempo.
	const tokens = scanLine('<div data-ok={x > 5}>texto</div>');
	assert.equal(tokens[0].kind, "open");
	assert.equal(tokens[0].name, "div");
	assert.equal(tokens[0].attrs[0].value, "{x > 5}");
});

test("parseAttrs distingue booleano, texto y expresión con llaves anidadas", () => {
	const attrs = parseAttrs('disabled class="fijo" onclick={f({a: 1})}');
	assert.equal(attrs[0].key, "disabled");
	assert.equal(attrs[0].value, null);
	assert.equal(attrs[1].key, "class");
	assert.equal(attrs[1].value, '"fijo"');
	assert.equal(attrs[2].key, "onclick");
	assert.equal(attrs[2].value, "{f({a: 1})}");
});

test("buildHtmlTree empareja apertura y cierre en líneas distintas (regresión pila de tags)", () => {
	const items = [
		{ type: "Raw", text: "<div>", line: 1 },
		{ type: "Raw", text: "<button>Sumar</button>", line: 2 },
		{ type: "Raw", text: "</div>", line: 3 },
	];
	const { children, errors } = buildHtmlTree(items);

	assert.equal(errors.length, 0);
	assert.equal(children.length, 1); // un solo <div> raíz, no dos hermanos sueltos
	assert.equal(children[0].name, "div");
	assert.equal(children[0].children.length, 1);
	assert.equal(children[0].children[0].name, "button");
});

test("buildHtmlTree cuelga un If dentro del elemento abierto, no como hermano suelto", () => {
	const items = [
		{ type: "Raw", text: "<div>", line: 1 },
		{ type: "If", cond: "x", body: [{ type: "Raw", text: "<p>hola</p>", line: 2 }], line: 2 },
		{ type: "Raw", text: "</div>", line: 3 },
	];
	const { children, errors } = buildHtmlTree(items);

	assert.equal(errors.length, 0);
	assert.equal(children[0].children.length, 1);
	assert.equal(children[0].children[0].type, "If");
	assert.equal(children[0].children[0].body[0].name, "p");
});

test("buildHtmlTree reporta error si el cierre no coincide con el tag abierto", () => {
	const items = [
		{ type: "Raw", text: "<div>", line: 1 },
		{ type: "Raw", text: "</span>", line: 2 },
	];
	const { errors } = buildHtmlTree(items);

	// Un cierre que no coincide no desapila nada — así que además del
	// mismatch en sí, el <div> original queda genuinamente sin cerrar.
	// Son dos problemas reales, no uno.
	assert.equal(errors.length, 2);
	assert.match(errors[0].message, /span/);
	assert.match(errors[1].message, /div.*sin cerrar/);
});

test("buildHtmlTree reporta error si queda un tag sin cerrar", () => {
	const items = [{ type: "Raw", text: "<div>", line: 1 }];
	const { errors } = buildHtmlTree(items);
	assert.equal(errors.length, 1);
	assert.match(errors[0].message, /sin cerrar/);
});
