const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("../parser");
const { classifyWsf } = require("../codegen");

test("clasifica como 'page' si llama a Visual.render()", () => {
	const ast = parse("visual app =\n<div></div>\nVisual.render(app)");
	assert.equal(classifyWsf(ast), "page");
});

test("clasifica como 'library' si no llama a Visual.render() (ej. un componente)", () => {
	const ast = parse("visual contadorItem =\n<div>{props.item.valor}</div>");
	assert.equal(classifyWsf(ast), "library");
});
