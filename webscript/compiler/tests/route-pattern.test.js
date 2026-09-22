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
