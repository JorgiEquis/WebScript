// Auditoría: toda query de WSDB que devuelva registros COMPLETOS debe
// devolver instancias reales del DTO (Persona), no objetos JSON planos —
// para poder usarlas tal cual con .save()/.delete()/getters, igual que ya
// hacía el formato antiguo (ya eliminado). Antes de esta corrección,
// selectAll/select/save devolvían siempre JSON plano.
//
// El motivo NO es solo cosmético: una proyección PARCIAL (select(campo))
// que SÍ se hiciera pasar por una instancia completa del DTO sería
// peligrosa de verdad — guardarla con .save() pisaría con NULL cualquier
// campo que no se seleccionó. Confirmado con código real, contra el
// comportamiento anterior a esta corrección, antes de tocar nada: un
// campo OPCIONAL ausente de la proyección se guardaba como NULL en
// silencio, sin ningún error. Por eso select() (parcial) sigue
// devolviendo JSON plano, marcado internamente para que save()/delete()
// lo rechacen con un error claro si alguien lo intenta.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { parse } = require("../parser");
const { buildWsdbV2 } = require("../codegen-wsdb");
const { rewriteWhereCalls } = require("../wsdb-query");

function tmpDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "websc-wsdb-dto-"));
	return path.join(dir, "test.db");
}

const PERSONA_V2 = `-> name: 'persona'
-> schema:
     -> id: integer(10)(primary)/
     -> nombre: string(40)
     -> edad: integer(5)/
`;

function buildV2(source = PERSONA_V2, dbPath = tmpDbPath()) {
	return buildWsdbV2(parse(source, { isWsdbFile: true }), dbPath, "persona.wsdb", path.dirname(dbPath)).classes;
}

function run(classes, code) {
	const names = Object.keys(classes);
	// eslint-disable-next-line no-new-func
	return new Function(...names, rewriteWhereCalls(code))(...names.map((n) => classes[n]));
}

test("REGRESIÓN: selectAll() devuelve un array de instancias reales del DTO, no JSON plano", () => {
	const { Persona } = buildV2();
	Persona.save({ nombre: "Ana", edad: 30 });
	Persona.save({ nombre: "Juan", edad: 40 });

	const todas = Persona.selectAll();
	assert.equal(todas.length, 2);
	for (const p of todas) assert.ok(p instanceof Persona, "antes: objeto plano, no instancia de Persona");
	assert.equal(todas[0].nombre, "Ana", "los getters del DTO funcionan sobre el resultado");
});

test("REGRESIÓN: save() devuelve una instancia real del DTO, no JSON plano", () => {
	const { Persona } = buildV2();
	const insertada = Persona.save({ nombre: "Ana", edad: 30 });
	assert.ok(insertada instanceof Persona, "antes: devolvía JSON plano");
	assert.equal(insertada.nombre, "Ana");

	// Encadenar save() sobre lo que ya devolvió save() debe funcionar tal
	// cual, sin reconstruir el objeto a mano.
	const actualizada = Persona.save({ id: insertada.id, nombre: "Ana", edad: 31 });
	assert.ok(actualizada instanceof Persona);
	assert.equal(actualizada.edad, 31);
});

test("REGRESIÓN: una instancia real de selectAll() se puede volver a guardar directamente (redondeo completo)", () => {
	const { Persona } = buildV2();
	Persona.save({ nombre: "Ana", edad: 30 });
	const [persona] = Persona.selectAll();
	persona.edad = 31; // el setter del DTO valida igual que en la construcción
	Persona.save(persona);
	assert.equal(Persona.selectAll()[0].edad, 31);
});

test("REGRESIÓN bug real: guardar una proyección parcial (select()) que omite un campo OPCIONAL solía poner ese campo a NULL en silencio — ahora lanza un error claro", () => {
	const c = buildV2();
	const { Persona } = c;
	Persona.save({ nombre: "Ana", edad: 30 });

	const parcial = run(c, "const s = PersonaSchema.getSchema(); return Persona.select(s.id, s.nombre)")[0];
	assert.deepEqual(JSON.parse(JSON.stringify(parcial)), { id: 1, nombre: "Ana" });
	assert.ok(!(parcial instanceof Persona), "una proyección parcial no debe hacerse pasar por una instancia completa");

	assert.throws(() => Persona.save(parcial), /select\(\).*proyección parcial|proyección parcial.*select\(\)/s);

	// Confirmación final: el dato original sigue intacto — antes de esta
	// corrección, la línea de arriba habría puesto "edad" a NULL.
	assert.equal(Persona.selectAll()[0].edad, 30, "antes: se perdía en silencio al guardar el parcial");
});

test("select(campo) sigue devolviendo JSON plano normal para el uso habitual (leer, no guardar)", () => {
	const c = buildV2();
	const { Persona } = c;
	Persona.save({ nombre: "Ana", edad: 30 });
	Persona.save({ nombre: "Juan", edad: 40 });
	const nombres = run(c, "const s = PersonaSchema.getSchema(); return Persona.select(s.nombre)");
	assert.deepEqual([...nombres], [{ nombre: "Ana" }, { nombre: "Juan" }]);
});

test("delete() por una instancia de selectAll() o por un registro parcial de select() (con la primary incluida) funciona igual en los dos casos", () => {
	const c = buildV2();
	const { Persona } = c;
	Persona.save({ nombre: "Ana", edad: 30 });
	Persona.save({ nombre: "Juan", edad: 40 });

	const [completa] = Persona.selectAll();
	Persona.delete(completa);
	assert.equal(Persona.selectAll().length, 1);

	const [parcial] = run(c, "const s = PersonaSchema.getSchema(); return Persona.select(s.id)");
	Persona.delete(parcial);
	assert.equal(Persona.selectAll().length, 0);
});
