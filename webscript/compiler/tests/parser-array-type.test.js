const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("../parser");

test("REGRESIÓN bug real: 'reactive tipo(array) nombre = ...' se reconoce como ReactiveDecl (antes caía como Raw, sin declarar nada)", () => {
	const ast = parse("reactive string(array) nombres = []");
	assert.equal(ast.body[0].type, "ReactiveDecl");
	assert.equal(ast.body[0].varType, "string(array)");
	assert.equal(ast.body[0].name, "nombres");
});

test("REGRESIÓN bug real: 'var tipo(array) nombre = ...' se reconoce como VarDecl", () => {
	const ast = parse("var integer(array) numeros = [1, 2, 3]");
	assert.equal(ast.body[0].type, "VarDecl");
	assert.equal(ast.body[0].varType, "integer(array)");
});

test("REGRESIÓN bug real: 'const tipo(array) nombre = ...' se reconoce como ConstDecl", () => {
	const ast = parse('const string(array) etiquetas = ["a", "b"]');
	assert.equal(ast.body[0].type, "ConstDecl");
	assert.equal(ast.body[0].varType, "string(array)");
});

test("var sigue soportando Clase/tipo (con barra) además de tipo(array)", () => {
	const ast = parse("var Persona/object p = {}");
	assert.equal(ast.body[0].type, "VarDecl");
	assert.equal(ast.body[0].varType, "Persona/object");
});

test("sin tipo declarado (var/const/reactive planas) sigue funcionando igual", () => {
	const ast = parse("reactive contador = 0");
	assert.equal(ast.body[0].type, "ReactiveDecl");
	assert.equal(ast.body[0].varType, null);
});
