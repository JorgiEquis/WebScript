// .after(fn): hook tras save()/delete() de WSDB, fire-and-forget (un
// fallo del hook no deshace ni bloquea la operación ya completada).
//
// Asimetría intencional entre save() y delete(): save() siempre devuelve
// una instancia real (un objeto), así que .after() se puede ENCADENAR
// (Persona.save(x).after(fn)). delete()/deleteWhere()
// devuelven un número primitivo A PROPÓSITO — envolverlo en un objeto
// para poder encadenar .after() lo haría "truthy" siempre, incluso con 0
// registros borrados (todo objeto es truthy en JS). Por eso ahí `after`
// es un parámetro, no un método encadenado. Ver DISEÑO.md.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { parse } = require("../parser");
const { buildWsdbV2 } = require("../codegen-wsdb");
const { rewriteWhereCalls, __wsq } = require("../wsdb-query");

function tmpDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "websc-wsdb-after-"));
	return path.join(dir, "test.db");
}

const PERSONA_V2 = `-> name: 'persona'
-> schema:
     -> id: integer(10)(primary)/
     -> nombre: string(40)
`;

function buildV2(source = PERSONA_V2, dbPath = tmpDbPath()) {
	return buildWsdbV2(parse(source, { isWsdbFile: true }), dbPath, "persona.wsdb", path.dirname(dbPath)).classes;
}

function run(classes, code) {
	const names = Object.keys(classes);
	// eslint-disable-next-line no-new-func
	return new Function(...names, "__wsq", rewriteWhereCalls(code))(...names.map((n) => classes[n]), __wsq);
}

function esperar(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

test("v2: Persona.save(x).after(fn) llama a fn con la instancia guardada, y devuelve esa misma instancia", () => {
	const { Persona } = buildV2();
	let visto = null;
	const resultado = Persona.save({ nombre: "Ana" }).after((p) => {
		visto = p;
	});
	assert.ok(visto instanceof Persona);
	assert.equal(visto.nombre, "Ana");
	assert.ok(resultado instanceof Persona, ".after() debe devolver la instancia para poder seguir usándola/encadenando");
	assert.equal(resultado.nombre, "Ana");
});

test("v2: .after(a).after(b) encadena las dos llamadas, en orden", () => {
	const { Persona } = buildV2();
	const orden = [];
	Persona.save({ nombre: "Ana" })
		.after(() => orden.push("a"))
		.after(() => orden.push("b"));
	assert.deepEqual(orden, ["a", "b"]);
});

test("v2: .after(fn) admite una online function (async) sin que el llamador tenga que esperarla — fire-and-forget", async () => {
	const { Persona } = buildV2();
	let terminado = false;
	const onlineFunctionSimulada = async (p) => {
		await esperar(150);
		terminado = true;
	};
	const t0 = Date.now();
	const resultado = Persona.save({ nombre: "Ana" }).after(onlineFunctionSimulada);
	const duracion = Date.now() - t0;
	assert.ok(resultado instanceof Persona, ".after() no debe esperar a un hook async para devolver su resultado");
	assert.ok(duracion < 80, `no debería haber bloqueado ~150ms, tardó ${duracion}ms`);
	assert.equal(terminado, false, "el hook async aún no ha terminado en este punto — justamente porque no se esperó");
	await esperar(200);
	assert.equal(terminado, true, "pero sí termina por su cuenta, poco después");
});

test("REGRESIÓN: un hook que lanza una excepción no deshace ni interrumpe el save() ya completado", () => {
	const { Persona } = buildV2();
	const resultado = Persona.save({ nombre: "Ana" }).after(() => {
		throw new Error("fallo intencional del hook");
	});
	assert.ok(resultado instanceof Persona, "el save() ya se completó — un hook roto no debe deshacerlo");
	assert.equal(Persona.selectAll().length, 1, "el registro sigue guardado pese al fallo del hook");
});

test("REGRESIÓN: un hook async que rechaza no deshace el save() ni genera una excepción no controlada", async () => {
	const { Persona } = buildV2();
	const resultado = Persona.save({ nombre: "Ana" }).after(async () => {
		await esperar(5);
		throw new Error("rechazo intencional");
	});
	assert.ok(resultado instanceof Persona);
	await esperar(30); // deja tiempo a que el rechazo se procese (y se avise, no se propague)
	assert.equal(Persona.selectAll().length, 1);
});

test("v2: delete(item, after) y deleteWhere(cond, after) llaman al callback con el número de filas borradas — NO son .after() encadenado", () => {
	const c = buildV2();
	const { Persona } = c;
	Persona.save({ nombre: "Ana" });
	Persona.save({ nombre: "Juan" });

	let vistoDelete = null;
	const [ana] = Persona.selectAll();
	const n1 = Persona.delete(ana, (n) => {
		vistoDelete = n;
	});
	assert.equal(typeof n1, "number", "delete() debe seguir devolviendo un número primitivo, no un objeto encadenable");
	assert.equal(n1, 1);
	assert.equal(vistoDelete, 1);

	let vistoDeleteWhere = null;
	const n2 = run(c, "const s = PersonaSchema.getSchema(); return Persona.deleteWhere(s.nombre == 'Juan', (n) => { globalThis.__vistoDeleteWhere = n; })");
	assert.equal(typeof n2, "number");
	assert.equal(n2, 1);
	assert.equal(globalThis.__vistoDeleteWhere, 1);
	delete globalThis.__vistoDeleteWhere;
});

test("REGRESIÓN (footgun evitado a propósito): deleteWhere() sin resultados sigue siendo `falsy` — no se envuelve en un objeto solo por soportar after()", () => {
	const { Persona } = buildV2();
	Persona.save({ nombre: "Ana" });
	let llamado = false;
	const n = Persona.delete({ id: 999 }, () => {
		llamado = true;
	});
	assert.equal(n, 0);
	assert.equal(!!n, false, "if (Persona.delete(...)) debe seguir significando 'se borró algo' — 0 debe ser falsy de verdad");
	assert.equal(llamado, true, "el callback SÍ se llama igualmente, aunque no se borrara nada — recibe el 0");
});

test("REGRESIÓN: rewriteWhereCalls() debe reescribir la condición de deleteWhere(cond, after) igual que con un solo argumento — antes se saltaba la reescritura en cuanto había un segundo argumento", () => {
	// Prueba directa sobre rewriteWhereCalls, sin pasar por una base de
	// datos: antes de esta corrección, el guard interno exigía
	// EXACTAMENTE un argumento para reescribir, así que añadir `after`
	// como segundo parámetro hacía que la condición (s.nombre == 'Juan')
	// se colara sin traducir a SQL — se evaluaba como JS normal contra un
	// FieldRef, siempre falsa, y deleteWhere() no borraba nada nunca.
	const codigoConAfter = "Persona.deleteWhere(s.nombre == 'Juan', miCallback)";
	const reescrito = rewriteWhereCalls(codigoConAfter);
	assert.match(reescrito, /__wsq\.cmp\(/, "la condición debe traducirse a __wsq.cmp(...), no quedar como JS plano");
	assert.match(reescrito, /,\s*miCallback\)$/, "el segundo argumento (el callback) debe conservarse tal cual, sin tocar");
});

test("v2: extremo a extremo — Persona.deleteWhere(condición, after) SÍ borra de verdad (confirma que rewriteWhereCalls ya no se salta la reescritura)", () => {
	const c = buildV2();
	const { Persona } = c;
	Persona.save({ nombre: "Ana" });
	Persona.save({ nombre: "Juan" });
	const n = run(
		c,
		"const s = PersonaSchema.getSchema(); return Persona.deleteWhere(s.nombre == 'Juan', (count) => {})"
	);
	assert.equal(n, 1, "antes: 0 — la condición sin reescribir nunca coincidía con nada");
	assert.equal(Persona.selectAll().length, 1);
	assert.equal(Persona.selectAll()[0].nombre, "Ana");
});
