const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { parse } = require("../parser");
const { buildDtoClass } = require("../codegen-dto");

const PERSONA_WSON = fs.readFileSync(path.join(__dirname, "../../src/persona.wson"), "utf8");

function PersonaClass() {
	return buildDtoClass(parse(PERSONA_WSON, { isWsonFile: true }), "Persona");
}

test("constructor posicional asigna los campos en el orden del esquema", () => {
	const Persona = PersonaClass();
	const p = new Persona("Ana", 30, 1.7, true, { numero: 5, calle: "Mayor" }, ["a"]);
	assert.equal(p.nombre, "Ana");
	assert.equal(p.edad, 30);
	assert.equal(p.altura, 1.7);
});

test("hereda to/via del propio .wson", () => {
	const Persona = PersonaClass();
	const p = new Persona("Ana", 30, 1.7, true, { numero: 5, calle: "x" }, []);
	assert.equal(p.to, "/personas");
	assert.equal(p.via, "POST");
});

test("rechaza en el constructor un campo obligatorio ausente", () => {
	const Persona = PersonaClass();
	assert.throws(() => new Persona("Sin edad"), /obligatorio "edad"/);
});

test("campo opcional (altura/) ausente no lanza error", () => {
	const Persona = PersonaClass();
	assert.doesNotThrow(() => new Persona("Luis", 25, undefined, false, { numero: 1, calle: "x" }, []));
});

test("el setter revalida el tipo, igual que el constructor", () => {
	const Persona = PersonaClass();
	const p = new Persona("Ana", 30, 1.7, true, { numero: 5, calle: "x" }, []);
	assert.throws(() => {
		p.edad = "no soy un número";
	}, /"edad" debe ser integer/);
});

test("el setter acepta un valor válido", () => {
	const Persona = PersonaClass();
	const p = new Persona("Ana", 30, 1.7, true, { numero: 5, calle: "x" }, []);
	p.edad = 31;
	assert.equal(p.edad, 31);
});

test("objeto anidado (direccion) valida sus propios subcampos", () => {
	const Persona = PersonaClass();
	assert.throws(
		() => new Persona("Ana", 30, 1.7, true, { numero: "no-es-integer", calle: "x" }, []),
		/"direccion\.numero" debe ser integer/
	);
});
