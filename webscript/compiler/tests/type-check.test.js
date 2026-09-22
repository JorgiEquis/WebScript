const { test } = require("node:test");
const assert = require("node:assert/strict");
const { primitiveCheck, typeMismatch } = require("../type-check");

test("primitiveCheck: string/integer/decimal/boolean/any", () => {
	assert.equal(primitiveCheck("string")("x"), true);
	assert.equal(primitiveCheck("string")(5), false);
	assert.equal(primitiveCheck("integer")(5), true);
	assert.equal(primitiveCheck("integer")(5.5), false);
	assert.equal(primitiveCheck("decimal")(5.5), true);
	assert.equal(primitiveCheck("decimal")("5.5"), false);
	assert.equal(primitiveCheck("boolean")(true), true);
	assert.equal(primitiveCheck("boolean")(1), false);
	assert.equal(primitiveCheck("any")(null), true);
});

test("primitiveCheck: tipo desconocido (object, clase de usuario) devuelve null (no comprobable)", () => {
	assert.equal(primitiveCheck("object"), null);
	assert.equal(primitiveCheck("Persona"), null);
});

test("typeMismatch: sin declaredType, no valida nada", () => {
	assert.equal(typeMismatch(null, 5, '"x"'), null);
	assert.equal(typeMismatch(undefined, "cualquier cosa", '"x"'), null);
});

test("typeMismatch: primitivo que coincide -> null", () => {
	assert.equal(typeMismatch("string", "hola", '"nombre"'), null);
	assert.equal(typeMismatch("integer", 5, '"edad"'), null);
});

test("typeMismatch: primitivo que NO coincide -> mensaje claro", () => {
	const msg = typeMismatch("integer", "no soy un entero", '"edad"');
	assert.match(msg, /"edad"/);
	assert.match(msg, /integer/);
});

test("typeMismatch: tipo(array) - todos los elementos válidos -> null", () => {
	assert.equal(typeMismatch("string(array)", ["a", "b"], '"nombres"'), null);
});

test("typeMismatch: tipo(array) - el valor no es un array -> mensaje", () => {
	const msg = typeMismatch("string(array)", "no soy un array", '"nombres"');
	assert.match(msg, /array/);
});

test("typeMismatch: tipo(array) - un elemento no coincide -> mensaje con el índice", () => {
	const msg = typeMismatch("integer(array)", [1, 2, "tres"], '"numeros"');
	assert.match(msg, /\[2\]/);
});

test("typeMismatch: object / clase de usuario -> no comprobable, siempre null", () => {
	assert.equal(typeMismatch("object", "cualquier cosa", '"x"'), null);
	assert.equal(typeMismatch("Persona", 42, '"x"'), null);
});
