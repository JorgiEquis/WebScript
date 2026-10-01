const { test } = require("node:test");
const assert = require("node:assert/strict");
const { findUndeclaredReferences } = require("../validate-js-body");

function faltantes(code, known) {
	return findUndeclaredReferences(code, known || []);
}

test("detecta un typo real de variable", () => {
	assert.deepEqual(faltantes("contadr = contadr + 1;", ["contador"]), ["contadr"]);
});

test("sin falsos positivos: clave de objeto literal (solo el valor es referencia)", () => {
	assert.deepEqual(faltantes("const obj = { clave: valorReferenciado };", ["valorReferenciado"]), []);
});

test("sin falsos positivos: propiedad de miembro no computada", () => {
	assert.deepEqual(faltantes("obj.propiedad = 1;", ["obj"]), []);
});

test("miembro COMPUTADO sí cuenta como referencia real", () => {
	assert.deepEqual(faltantes("obj[indice] = 1;", ["obj"]), ["indice"]);
});

test("sin falsos positivos: destructuring de objeto (con renombrado)", () => {
	assert.deepEqual(faltantes("const { a, b: renombrada } = origen; console.log(a, renombrada);", ["origen"]), []);
});

test("sin falsos positivos: destructuring de array", () => {
	assert.deepEqual(faltantes("const [x, y] = lista;", ["lista"]), []);
});

test("sin falsos positivos: for-of de WebScript SIN let/const (la variable del bucle es su propia declaración)", () => {
	assert.deepEqual(faltantes("for (n of lista) { total = total + n; }", ["lista", "total"]), []);
});

test("sin falsos positivos: for-of CON let (estilo JS estándar) también funciona", () => {
	assert.deepEqual(faltantes("for (let n of lista) { total = total + n; }", ["lista", "total"]), []);
});

test("sin falsos positivos: for clásico con let i", () => {
	assert.deepEqual(faltantes("for (let i = 0; i < 10; i++) { total = total + i; }", ["total"]), []);
});

test("sin falsos positivos: catch", () => {
	assert.deepEqual(faltantes("try { algo(); } catch (err) { console.log(err.message); }", ["algo"]), []);
});

test("sin falsos positivos: arrow function con su propio parámetro", () => {
	assert.deepEqual(faltantes("[1, 2, 3].map(n => n * factor);", ["factor"]), []);
});

test("sin falsos positivos: función usada antes de su declaración textual (hoisting)", () => {
	assert.deepEqual(faltantes("ayuda(); function ayuda() { return 1; }", []), []);
});

test("sin falsos positivos: etiqueta con break/continue", () => {
	assert.deepEqual(faltantes("fuera: for (let i = 0; i < 1; i++) { break fuera; }", []), []);
});

test("sin falsos positivos: clase declarada y usada con new", () => {
	assert.deepEqual(faltantes('class Cosa { saluda() { return "hola"; } } const c = new Cosa();', []), []);
});

test("sin falsos positivos: template literal con interpolación", () => {
	assert.deepEqual(faltantes("const s = `hola ${nombre}`;", ["nombre"]), []);
});

test("sin falsos positivos: globales de JS/Node conocidos (console, Math, JSON...)", () => {
	assert.deepEqual(faltantes("console.log(Math.max(1, 2)); JSON.stringify({});", []), []);
});

test("sin falsos positivos: new sobre un nombre importado (un DTO)", () => {
	assert.deepEqual(faltantes('const p = new Persona("Ana", 30);', ["Persona"]), []);
});

test("un cuerpo que ni siquiera es JS válido devuelve null (el SyntaxError real lo da new Function, con más detalle)", () => {
	assert.equal(faltantes("esto no es JS valido ///// $$$", []), null);
});

test("integración real: un typo en una var de servidor dentro de watch() se detecta al crear el servidor, con el nombre exacto en el mensaje", () => {
	const { parse } = require("../parser");
	const { createServer } = require("../codegen-server");

	const source = [
		"var contador = 0",
		"",
		"const WSON wsonAlgo =",
		'\t-> to: "/algo"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonAlgo)",
		"",
		"watch(peticion)",
		"\tcontadr = contadr + 1",
		"\tpeticion.content = { contador: contador }",
		"\tWSON.httpSend(peticion)",
	].join("\n");

	assert.throws(() => createServer(parse(source), {}), /"contadr"/);
});

test("integración real: una var declarada dentro de un if y usada fuera en watch() se detecta al crear el servidor (antes solo daba un 500 en la primera petición real)", () => {
	const { parse } = require("../parser");
	const { createServer } = require("../codegen-server");

	const source = [
		"const WSON wsonAlgo =",
		'\t-> to: "/algo"',
		'\t-> via: "GET"',
		"",
		"reactive any peticion = WSON.listen(wsonAlgo)",
		"",
		"watch(peticion)",
		"\tif (true)",
		"\t\tvar resultado = 42",
		"\tpeticion.content = { resultado: resultado }",
		"\tWSON.httpSend(peticion)",
	].join("\n");

	assert.throws(() => createServer(parse(source), {}), /"resultado"/);
});

test("REGRESIÓN (scope real): una variable declarada dentro de un if y usada FUERA se detecta — antes se aceptaba, y el código generado revienta de verdad (let real, no var)", () => {
	assert.deepEqual(faltantes("if (true) { const x = 1; } console.log(x);", []), ["x"]);
});

test("scope real: una variable declarada dentro de un for y usada fuera también se detecta", () => {
	assert.deepEqual(faltantes("for (let i = 0; i < 3; i++) { const y = i; } console.log(y);", []), ["y"]);
});

test("scope real: un parámetro de función no es visible fuera de ella", () => {
	assert.deepEqual(faltantes("function f(x) { return x; } console.log(x);", []), ["x"]);
});

test("scope real: la variable de un catch no es visible fuera de él", () => {
	assert.deepEqual(faltantes("try {} catch (err) {} console.log(err);", []), ["err"]);
});

test("scope real: la variable de un for-of de WebScript (sin let) tampoco es visible fuera del bucle", () => {
	assert.deepEqual(faltantes("for (n of lista) { total = total + n; } console.log(n);", ["lista", "total"]), ["n"]);
});

test("sin falsos positivos con scope real: la misma variable en dos bloques if hermanos (scopes distintos, mismo nombre)", () => {
	assert.deepEqual(
		faltantes("if (a) { const x = 1; console.log(x); } if (b) { const x = 2; console.log(x); }", ["a", "b"]),
		[]
	);
});

test("sin falsos positivos con scope real: una variable del bloque exterior es visible dentro de un if anidado", () => {
	assert.deepEqual(faltantes("const x = 1; if (true) { console.log(x); }", []), []);
});

test("sin falsos positivos con scope real: un parámetro de función es visible dentro de un if anidado de su propio cuerpo", () => {
	assert.deepEqual(faltantes("function f(x) { if (true) { console.log(x); } } f(1);", []), []);
});

test("sin falsos positivos con scope real: una función declarada dentro de un bloque, usada más abajo en el MISMO bloque (hoisting real, no roto por el scope)", () => {
	assert.deepEqual(faltantes("if (true) { ayuda(); function ayuda() { return 1; } }", []), []);
});
