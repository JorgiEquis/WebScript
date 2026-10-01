const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("../parser");
const { routePatternFor } = require("../route-pattern");

test("routePatternFor: usa el patrón de Visual.route() tal cual, con :params incluidos", () => {
	const ast = parse("const Visual screen = Visual.route('/blog/:slug')");
	assert.equal(routePatternFor(ast, "blog"), "/blog/:slug");
});

test("routePatternFor: sin Visual.route(), usa \"/\" + el nombre de fichero", () => {
	const ast = parse("visual app =\n<p>hola</p>");
	assert.equal(routePatternFor(ast, "mipagina"), "/mipagina");
});

// Sistema nuevo (sin Visual.ws): la ruta sale de la ruta del PROPIO
// FICHERO — con subcarpetas y ":param" en el nombre. Visual.route() sigue
// ganando siempre si está presente (comprobado arriba).
const astSinRoute = parse("<p>hola</p>");

test("routePatternFor: subcarpeta simple", () => {
	assert.equal(routePatternFor(astSinRoute, "api/listaProductos"), "/api/listaProductos");
});

test("routePatternFor: subcarpeta anidada (varios niveles)", () => {
	assert.equal(routePatternFor(astSinRoute, "api/v2/listaProductos"), "/api/v2/listaProductos");
});

test("routePatternFor: \":param\" en el nombre de fichero se convierte en un segmento dinámico propio", () => {
	assert.equal(routePatternFor(astSinRoute, "listaProductos:id"), "/listaProductos/:id");
});

test("routePatternFor: un segmento que es SOLO el parámetro (\":id\") no añade ningún literal delante", () => {
	assert.equal(routePatternFor(astSinRoute, ":id"), "/:id");
});

test("routePatternFor: subcarpeta + \":param\" en el fichero, combinados", () => {
	assert.equal(routePatternFor(astSinRoute, "api/producto:id"), "/api/producto/:id");
});
