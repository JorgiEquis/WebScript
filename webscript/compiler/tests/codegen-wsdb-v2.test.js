const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const util = require("util");
const { parse } = require("../parser");
const { buildWsdbV2, resolveDependsTargets } = require("../codegen-wsdb");
const { __wsq, rewriteWhereCalls } = require("../wsdb-query");

function tmpDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "websc-wsdb2-"));
	return path.join(dir, "test.db");
}

// El ejemplo tal cual se diseñó (indentación con espacios, comentarios
// "//" al final de línea, "-> schema" sin dos puntos, campos con "->").
const PERSONAS = `-> name: 'persona'
-> min: 2 // mínimo de registros insertados, no obligatorio
-> max: 5 // máximo de registros insertados, no obligatorio
-> schema
     -> idPerson: integer(10)(primary) // longitud, clave primaria
     -> edad: integer(5)
     -> nombre: string(40)/   // la barra sigue siendo campo opcional
     -> mayor: boolean
     -> altura: decimal(2,3)
`;

function build(source = PERSONAS, dbPath = tmpDbPath()) {
	return buildWsdbV2(parse(source, { isWsdbFile: true }), dbPath, "personas.wsdb");
}

// Ejecuta código como lo haría un handler compilado: pasando por la
// reescritura de .where()/.deleteWhere() y con __wsq disponible.
function run(classes, code) {
	const names = Object.keys(classes);
	// eslint-disable-next-line no-new-func
	return new Function(...names, "__wsq", rewriteWhereCalls(code))(...names.map((n) => classes[n]), __wsq);
}

function seed(Persona) {
	Persona.save({ idPerson: 1, edad: 30, nombre: "Ana", mayor: true, altura: 1.655 });
	Persona.save({ idPerson: 2, edad: 15, nombre: "Juan", mayor: false, altura: 1.7 });
	Persona.save({ idPerson: 3, edad: 40, nombre: "Juan", mayor: true, altura: 1.8 });
	Persona.save({ idPerson: 4, edad: 8, mayor: false, altura: 1.2 });
}

test("wsdb v2: parser — cabecera, comentarios, schema sin ':', longitudes y (primary)", () => {
	const ast = parse(PERSONAS, { isWsdbFile: true });
	const meta = Object.fromEntries(ast.fields.filter((f) => f.type === "MetaField").map((f) => [f.key, f.value]));
	assert.deepEqual(meta, { name: "'persona'", min: "2", max: "5" });
	const campos = ast.fields.find((f) => f.type === "ContentSchema").fields;
	assert.deepEqual(
		campos.map((f) => [f.name, f.fieldType, f.size, f.primary, f.optional]),
		[
			["idPerson", "integer", [10], true, false],
			["edad", "integer", [5], false, false],
			["nombre", "string", [40], false, true],
			["mayor", "boolean", null, false, false],
			["altura", "decimal", [2, 3], false, false],
		]
	);
});

test("wsdb v2: -> name genera las dos clases, Persona y PersonaSchema", () => {
	const { classes, meta } = build();
	assert.deepEqual(Object.keys(classes), ["Persona", "PersonaSchema"]);
	assert.equal(classes.Persona.name, "Persona");
	assert.equal(meta.name, "persona");
});

test("wsdb v2: getSchema() devuelve { campo: 'campo' } en JSON", () => {
	const { PersonaSchema } = build().classes;
	assert.equal(
		JSON.stringify(PersonaSchema.getSchema()),
		'{"idPerson":"idPerson","edad":"edad","nombre":"nombre","mayor":"mayor","altura":"altura"}'
	);
	assert.equal(`${PersonaSchema.getSchema().nombre}`, "nombre");
});

test("wsdb v2: save() inserta y devuelve una instancia real del DTO; con la misma primary, actualiza", () => {
	const { Persona } = build().classes;
	const insertada = Persona.save(new Persona({ idPerson: 1, edad: 30, nombre: "Ana", mayor: true, altura: 1.655 }));
	assert.ok(insertada instanceof Persona, "antes: devolvía un objeto plano, no una instancia de Persona");
	assert.deepEqual(JSON.parse(JSON.stringify(insertada)), { idPerson: 1, edad: 30, nombre: "Ana", mayor: true, altura: 1.655 });

	const actualizada = Persona.save({ idPerson: 1, edad: 31, nombre: "Ana", mayor: true, altura: 1.66 });
	assert.ok(actualizada instanceof Persona);
	assert.equal(actualizada.edad, 31);
	assert.equal(Persona.selectAll().length, 1, "el mismo idPerson no duplica fila");
});

test("wsdb v2: selectAll() devuelve instancias reales del DTO; select(campo) sigue devolviendo JSON plano (proyección parcial)", () => {
	const c = build().classes;
	seed(c.Persona);
	const todas = c.Persona.selectAll();
	assert.equal(todas.length, 4);
	assert.ok(Array.isArray(todas));
	assert.ok(todas[3] instanceof c.Persona, "antes: selectAll() devolvía objetos planos, no instancias de Persona");
	assert.deepEqual(JSON.parse(JSON.stringify(todas[3])), { idPerson: 4, edad: 8, nombre: null, mayor: false, altura: 1.2 });
	const nombres = run(c, "const s = PersonaSchema.getSchema(); return Persona.select(s.nombre)");
	assert.deepEqual([...nombres], [{ nombre: "Ana" }, { nombre: "Juan" }, { nombre: "Juan" }, { nombre: null }]);
	assert.ok(!(nombres[0] instanceof c.Persona), "una proyección parcial NO debe hacerse pasar por una instancia completa del DTO");
});

test("wsdb v2: where() con comparaciones, &&, ||, campo boolean suelto y sort", () => {
	const c = build().classes;
	seed(c.Persona);
	const ids = (code) => [...run(c, `const s = PersonaSchema.getSchema(); return ${code}`)].map((p) => p.idPerson);
	assert.deepEqual(ids("Persona.selectAll().where(s.edad > 10)"), [1, 2, 3]);
	assert.deepEqual(ids("Persona.selectAll().where(s.edad != 15)"), [1, 3, 4]);
	assert.deepEqual(ids("Persona.selectAll().where((s.edad > 10 && s.nombre != 'Juan') || s.mayor).sortDesc(s.edad)"), [3, 1]);
	assert.deepEqual(ids("Persona.selectAll().where(!s.mayor).sortAsc(s.edad)"), [4, 2]);
	assert.deepEqual(ids("Persona.selectAll().where(s.nombre == null)"), [4]);
	assert.deepEqual(ids("Persona.selectAll().where(s.nombre != null).sortDesc(s.nombre).sortAsc(s.idPerson)"), [2, 3, 1]);
	// Valor a la izquierda y variable JS normal mezclada en la condición.
	assert.deepEqual(ids("(() => { const minimo = 20; return Persona.select(s.idPerson).where(minimo < s.edad) })()"), [1, 3]);
});

test("wsdb v2: where() con un campo no boolean suelto da un error claro", () => {
	const c = build().classes;
	seed(c.Persona);
	assert.throws(
		() => run(c, "const s = PersonaSchema.getSchema(); return Persona.selectAll().where(s.edad).length"),
		/solo vale para campos boolean/
	);
});

test("wsdb v2: la consulta es perezosa — no toca la base hasta usarse", () => {
	const dbPath = tmpDbPath();
	const { Persona } = build(PERSONAS, dbPath).classes;
	const q = Persona.selectAll();
	Persona.save({ idPerson: 1, edad: 30, mayor: true, altura: 1 });
	assert.equal(q.length, 1, "se ejecuta en el primer uso, no al llamar a selectAll()");
	assert.equal(JSON.stringify(Persona.select("idPerson")), '[{"idPerson":1}]');
	assert.match(util.inspect(Persona.select("idPerson")), /idPerson: 1/);
});

test("wsdb v2: validación de longitud (string, integer, decimal) y de campos desconocidos", () => {
	const { Persona } = build().classes;
	const base = { idPerson: 7, edad: 1, mayor: false, altura: 1 };
	assert.throws(() => new Persona({ ...base, nombre: "x".repeat(41) }), /máximo 40 caracteres/);
	assert.throws(() => new Persona({ ...base, edad: 123456 }), /máximo 5 dígitos/);
	assert.throws(() => new Persona({ ...base, altura: 123.4 }), /máximo 2 dígitos enteros/);
	assert.throws(() => new Persona({ ...base, edda: 1 }), /no tiene el campo "edda"/);
	assert.throws(() => new Persona({ ...base, edad: "1" }), /debe ser integer/);
	// Un decimal se redondea a sus decimales declarados, como DECIMAL en SQL.
	assert.equal(new Persona({ ...base, altura: 0.1 + 0.2 }).altura, 0.3);
	assert.equal(new Persona({ ...base, altura: 1.23456 }).altura, 1.235);
	// Y en cada reasignación, no solo en el constructor.
	const p = new Persona(base);
	assert.throws(() => {
		p.nombre = "y".repeat(50);
	}, /máximo 40/);
});

test("wsdb v2: max impide insertar de más (pero no actualizar)", () => {
	const { Persona } = build().classes;
	for (let i = 1; i <= 5; i++) Persona.save({ idPerson: i, edad: i, mayor: false, altura: 1 });
	assert.throws(() => Persona.save({ idPerson: 6, edad: 6, mayor: false, altura: 1 }), /máximo de 5/);
	assert.equal(Persona.save({ idPerson: 5, edad: 50, mayor: false, altura: 1 }).edad, 50);
});

test("wsdb v2: delete(registro) por primary, deleteWhere(condición), y min lo respeta", () => {
	const c = build().classes;
	seed(c.Persona);
	assert.equal(c.Persona.delete({ idPerson: 4 }), 1);
	assert.equal(run(c, "const s = PersonaSchema.getSchema(); return Persona.deleteWhere(s.edad < 20)"), 1);
	assert.equal(c.Persona.selectAll().length, 2);
	// Quedarían 0 y el mínimo es 2: no se borra nada (transacción deshecha).
	assert.throws(() => run(c, "const s = PersonaSchema.getSchema(); return Persona.deleteWhere(s.edad > 0)"), /mínimo es 2/);
	assert.equal(c.Persona.selectAll().length, 2);
	assert.throws(() => c.Persona.deleteWhere(), /necesita una condición/);
	assert.throws(() => c.Persona.delete(), /espera un registro/);
});

test("wsdb v2: primary integer opcional se autonumera", () => {
	const src = PERSONAS.replace("integer(10)(primary)", "integer(10)(primary)/").replace("-> min: 2", "");
	const { Persona } = build(src).classes;
	const a = Persona.save({ edad: 1, mayor: false, altura: 1 });
	const b = Persona.save({ edad: 2, mayor: false, altura: 1 });
	assert.equal(a.idPerson, 1);
	assert.equal(b.idPerson, 2);
});

test("wsdb v2: un campo nuevo en el esquema se añade a la tabla existente", () => {
	const dbPath = tmpDbPath();
	build(PERSONAS, dbPath).classes.Persona.save({ idPerson: 1, edad: 30, mayor: true, altura: 1 });

	const conEmail = PERSONAS + "     -> email: string(80)/\n";
	const { Persona } = build(conEmail, dbPath).classes;
	const p = Persona.save({ idPerson: 2, edad: 20, mayor: false, altura: 1, email: "a@b.es" });
	assert.equal(p.email, "a@b.es");
	assert.equal(Persona.selectAll()[0].email, null);

	const conObligatorio = PERSONAS + "     -> dni: string(9)\n";
	assert.throws(() => build(conObligatorio, dbPath).classes.Persona.selectAll().length, /obligatorio nuevo "dni"/);
});

test("wsdb v2: errores de declaración, al cargar — no en la primera petición", () => {
	const mal = (src, re) => assert.throws(() => build(src), re);
	mal(PERSONAS.replace("(primary)", ""), /exactamente un campo \(primary\)/);
	mal(PERSONAS.replace("-> mayor: boolean", "-> mayor: boolean(1)"), /no admite longitud/);
	mal(PERSONAS.replace("decimal(2,3)", "decimal(5)"), /decimal necesita dos números/);
	mal(PERSONAS.replace("integer(5)", "integr(5)"), /tipo desconocido "integr"/);
	mal(PERSONAS.replace("-> max: 5", "-> max: 1"), /"min" \(2\) no puede ser mayor que "max" \(1\)/);
	mal(PERSONAS.replace("'persona'", "'mi persona'"), /no es un nombre válido/);
	mal(PERSONAS + "-> color: 'rojo'\n", /clave desconocida "-> color"/);
	assert.throws(() => parse(PERSONAS.replace("(primary)", "(primari)"), { isWsdbFile: true }), /modificador desconocido "\(primari\)"/);
});

test("wsdb v2: depends se valida como array de nombres (solo sintaxis, sin resolver los ficheros)", () => {
	const { readWsdbV2 } = require("../codegen-wsdb");
	const conDepends = PERSONAS.replace("-> schema", "-> depends: ['coches', 'trabajadores.wsdb']\n-> schema");
	const meta = readWsdbV2(parse(conDepends, { isWsdbFile: true }), "personas.wsdb");
	assert.deepEqual(meta.depends, ["coches", "trabajadores"]);
	const malFormado = PERSONAS.replace("-> schema", "-> depends: coches\n-> schema");
	assert.throws(() => readWsdbV2(parse(malFormado, { isWsdbFile: true }), "personas.wsdb"), /array de nombres/);
});

// --- "-> depends": actualización en cascada real ---------------------------

function tmpSrcDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "websc-wsdb2-depends-"));
}

function writeWsdb(dir, filename, source) {
	fs.writeFileSync(path.join(dir, filename), source);
}

// Ojo: "modelo"/"matricula" no comparten nombre con nada de PERSONAS — a
// propósito. Si "coche" tuviera también un campo "nombre" (el suyo
// propio, el del coche, no el del dueño), coincidiría por nombre+tipo con
// el "nombre" de persona y entraría en el WHERE combinado de la cascada
// aunque no tenga nada que ver — ver el aviso sobre esto en DISEÑO.md.
const COCHES = `-> name: 'coche'
-> schema
     -> idCoche: integer(10)(primary)
     -> idPerson: integer(10)
     -> modelo: string(40)/
     -> matricula: string(10)/
`;

test("wsdb v2: -> depends exige que el fichero nombrado exista y sea un .wsdb válido (uno del formato antiguo se rechaza con contexto)", () => {
	const dir = tmpSrcDir();
	const conDepends = PERSONAS.replace("-> schema", "-> depends: ['coches']\n-> schema");
	assert.throws(
		() => buildWsdbV2(parse(conDepends, { isWsdbFile: true }), path.join(dir, "w.db"), "personas.wsdb", dir),
		/no existe.*coches\.wsdb/
	);

	writeWsdb(dir, "coches.wsdb", ['-> collection: "coches"', "-> schema:", "\tnombre: string"].join("\n"));
	assert.throws(
		() => buildWsdbV2(parse(conDepends, { isWsdbFile: true }), path.join(dir, "w.db"), "personas.wsdb", dir),
		/personas\.wsdb: "-> depends" nombra "coches", pero "coches\.wsdb" no es válido: .*formato antiguo/s
	);
});

test("wsdb v2: -> depends sin campos compartidos avisa (una vez) y no falla", () => {
	const dir = tmpSrcDir();
	writeWsdb(dir, "coches.wsdb", ["-> name: 'coche'", "-> schema", "     -> idCoche: integer(10)(primary)", "     -> color: string(10)/"].join("\n"));
	const conDepends = PERSONAS.replace("-> schema", "-> depends: ['coches']\n-> schema");
	const avisos = [];
	const orig = console.warn;
	console.warn = (m) => avisos.push(m);
	try {
		buildWsdbV2(parse(conDepends, { isWsdbFile: true }), path.join(dir, "w.db"), "personas.wsdb", dir);
	} finally {
		console.warn = orig;
	}
	assert.equal(avisos.length, 1);
	assert.match(avisos[0], /no comparten ningún campo/);
});

test("wsdb v2: -> depends propaga una actualización real a la colección dependiente por campos compartidos", () => {
	const dir = tmpSrcDir();
	writeWsdb(dir, "coches.wsdb", COCHES);
	const conDepends = PERSONAS.replace("-> schema", "-> depends: ['coches']\n-> schema");
	const dbPath = path.join(dir, "w.db");
	const { Persona } = buildWsdbV2(parse(conDepends, { isWsdbFile: true }), dbPath, "personas.wsdb", dir).classes;
	const { Coche } = buildWsdbV2(parse(COCHES, { isWsdbFile: true }), dbPath, "coches.wsdb", dir).classes;

	Persona.save({ idPerson: 1, edad: 30, nombre: "Ana", mayor: true, altura: 1.6 });
	Coche.save({ idCoche: 100, idPerson: 1, modelo: "viejo", matricula: "1111ABC" });
	Coche.save({ idCoche: 101, idPerson: 1, modelo: "viejo", matricula: "2222BBB" });
	Coche.save({ idCoche: 200, idPerson: 99, modelo: "de otro", matricula: "9999ZZZ" }); // otra persona, no debe tocarse

	// El único campo compartido (idPerson) no cambia en este update —
	// "edad" sí, pero no es un campo de coche, así que no hay nada que
	// propagar.
	Persona.save({ idPerson: 1, edad: 31, nombre: "Ana", mayor: true, altura: 1.6 });
	assert.deepEqual(
		Coche.selectAll().map((c) => c.idPerson),
		[1, 1, 99],
		"idPerson no cambió: la cascada no tenía nada que propagar"
	);
});

test("wsdb v2: -> depends propaga el valor NUEVO de un campo compartido a todos los que coincidían con el ANTIGUO", () => {
	const dir = tmpSrcDir();
	// "nombre" es compartido de verdad aquí (mismo nombre y tipo en las dos).
	const TRABAJADORES = `-> name: 'trabajador'
-> schema
     -> idTrabajador: integer(10)(primary)
     -> nombre: string(40)/
     -> puesto: string(40)/
`;
	writeWsdb(dir, "trabajadores.wsdb", TRABAJADORES);
	const conDepends = PERSONAS.replace("-> schema", "-> depends: ['trabajadores']\n-> schema");
	const dbPath = path.join(dir, "w.db");
	const { Persona } = buildWsdbV2(parse(conDepends, { isWsdbFile: true }), dbPath, "personas.wsdb", dir).classes;
	const { Trabajador } = buildWsdbV2(parse(TRABAJADORES, { isWsdbFile: true }), dbPath, "trabajadores.wsdb", dir).classes;

	Persona.save({ idPerson: 1, edad: 30, nombre: "Ana", mayor: true, altura: 1.6 });
	Trabajador.save({ idTrabajador: 10, nombre: "Ana", puesto: "Comercial" });
	Trabajador.save({ idTrabajador: 11, nombre: "Ana", puesto: "Becaria" }); // otra "Ana" homónima
	Trabajador.save({ idTrabajador: 12, nombre: "Juan", puesto: "Comercial" });

	Persona.save({ idPerson: 1, edad: 30, nombre: "Ana María", mayor: true, altura: 1.6 });
	assert.deepEqual(
		Trabajador.selectAll()
			.map((t) => t.nombre)
			.sort(),
		["Ana María", "Ana María", "Juan"],
		"las dos filas que coincidían con el nombre ANTIGUO se actualizan al nombre NUEVO"
	);
});

test("wsdb v2: -> depends no cascadea en un insert, y solo cascadea entre .wsdb v2 explícitamente nombrados (no en cadena)", () => {
	const dir = tmpSrcDir();
	writeWsdb(dir, "coches.wsdb", COCHES);
	const conDepends = PERSONAS.replace("-> schema", "-> depends: ['coches']\n-> schema");
	const dbPath = path.join(dir, "w.db");
	const { Persona } = buildWsdbV2(parse(conDepends, { isWsdbFile: true }), dbPath, "personas.wsdb", dir).classes;
	const { Coche } = buildWsdbV2(parse(COCHES, { isWsdbFile: true }), dbPath, "coches.wsdb", dir).classes;

	// La primera vez que se guarda una persona es un INSERT: no hay un
	// "antes" contra el que buscar, así que no hay nada que propagar.
	const avisos = [];
	const orig = console.warn;
	console.warn = (m) => avisos.push(m);
	try {
		Persona.save({ idPerson: 1, edad: 30, nombre: "Ana", mayor: true, altura: 1.6 });
	} finally {
		console.warn = orig;
	}
	assert.equal(avisos.length, 0);
	assert.equal(Coche.selectAll().length, 0, "el insert de Persona no crea nada en Coche");
});

test("wsdb v2 (la solución recomendada): nombrar los campos por lo que representan evita la colisión de la limitación anterior", () => {
	// La recomendación de DISEÑO.md aplicada: "nombre" pasa a llamarse
	// "nombrePersona" en persona, y el coche tiene su PROPIO "nombreCoche"
	// (no "nombre") — así el único nombre que puede coincidir por
	// accidente ya no existe. Si además "coche" quiere sincronizar de
	// verdad el nombre del propietario (por ejemplo, para mostrarlo sin
	// tener que hacer join), declara su PROPIO campo "nombrePersona" — al
	// llamarse igual y ser del mismo tipo en las dos, eso SÍ es
	// intencionado, y "nombreCoche" queda fuera del cálculo de
	// compartidos por no coincidir con nada de persona.
	const dir = tmpSrcDir();
	const personasRenombrado = PERSONAS.replace(/nombre:/g, "nombrePersona:");
	const cocheConNombresEspecificos = `-> name: 'coche'
-> schema
     -> idCoche: integer(10)(primary)
     -> idPerson: integer(10)
     -> nombreCoche: string(40)/
     -> nombrePersona: string(40)/
`;
	writeWsdb(dir, "coches.wsdb", cocheConNombresEspecificos);
	const conDepends = personasRenombrado.replace("-> schema", "-> depends: ['coches']\n-> schema");
	const dbPath = path.join(dir, "w.db");
	const { Persona } = buildWsdbV2(parse(conDepends, { isWsdbFile: true }), dbPath, "personas.wsdb", dir).classes;
	const { Coche } = buildWsdbV2(parse(cocheConNombresEspecificos, { isWsdbFile: true }), dbPath, "coches.wsdb", dir).classes;

	Persona.save({ idPerson: 1, edad: 30, nombrePersona: "Ana", mayor: true, altura: 1.6 });
	Coche.save({ idCoche: 100, idPerson: 1, nombreCoche: "Focus", nombrePersona: "Ana" });

	Persona.save({ idPerson: 1, edad: 30, nombrePersona: "Ana María", mayor: true, altura: 1.6 });
	const coche = Coche.selectAll()[0];
	assert.equal(coche.nombrePersona, "Ana María", "el campo compartido de verdad SÍ se propaga");
	assert.equal(coche.nombreCoche, "Focus", "el propio nombre del coche, no compartido, queda intacto");
});

test("wsdb v2 (limitación conocida): un campo compartido por casualidad (mismo nombre y tipo, distinto significado) participa igual en el WHERE de la cascada", () => {
	// "coche" tiene su PROPIO "nombre" (p. ej. el modelo), sin relación con
	// el de la persona — pero el emparejamiento es solo por nombre+tipo,
	// así que entra igualmente en la condición combinada. Si el valor de
	// Persona.nombre cambia y no coincide con Coche.nombre, la cascada NO
	// encuentra el coche (aunque idPerson sí coincidiría por sí solo) —
	// avisa, no actualiza nada. Ver la nota en DISEÑO.md: conviene que
	// -> depends solo comparta con otra colección los campos pensados de
	// verdad para enlazar o sincronizar, no cualquier nombre coincidente.
	const dir = tmpSrcDir();
	const cochesConNombre = `-> name: 'coche'
-> schema
     -> idCoche: integer(10)(primary)
     -> idPerson: integer(10)
     -> nombre: string(40)/
`;
	writeWsdb(dir, "coches.wsdb", cochesConNombre);
	const conDepends = PERSONAS.replace("-> schema", "-> depends: ['coches']\n-> schema");
	const dbPath = path.join(dir, "w.db");
	const { Persona } = buildWsdbV2(parse(conDepends, { isWsdbFile: true }), dbPath, "personas.wsdb", dir).classes;
	const { Coche } = buildWsdbV2(parse(cochesConNombre, { isWsdbFile: true }), dbPath, "coches.wsdb", dir).classes;

	Persona.save({ idPerson: 1, edad: 30, nombre: "Ana", mayor: true, altura: 1.6 });
	Coche.save({ idCoche: 100, idPerson: 1, nombre: "Focus" }); // el nombre del COCHE

	const avisos = [];
	const orig = console.warn;
	console.warn = (m) => avisos.push(m);
	try {
		Persona.save({ idPerson: 1, edad: 30, nombre: "Ana María", mayor: true, altura: 1.6 });
	} finally {
		console.warn = orig;
	}
	assert.equal(Coche.selectAll()[0].nombre, "Focus", "no se ha tocado — el WHERE combinado (nombre='Ana' Y idPerson=1) no encontró nada");
	assert.equal(avisos.length, 1);
	assert.match(avisos[0], /ningún registro tenía/);
});

test("wsdb v2: -> depends avisa (sin fallar el save) si la colección dependiente nunca se ha usado (su tabla no existe aún)", () => {
	const dir = tmpSrcDir();
	const TRABAJADORES = `-> name: 'trabajador'
-> schema
     -> idTrabajador: integer(10)(primary)
     -> nombre: string(40)/
`;
	writeWsdb(dir, "trabajadores.wsdb", TRABAJADORES);
	const conDepends = PERSONAS.replace("-> schema", "-> depends: ['trabajadores']\n-> schema");
	const dbPath = path.join(dir, "w.db");
	const { Persona } = buildWsdbV2(parse(conDepends, { isWsdbFile: true }), dbPath, "personas.wsdb", dir).classes;
	// Nadie ha usado "trabajador" en este proceso todavía — su tabla no
	// existe en el fichero .db compartido. Un cambio real en el campo
	// compartido ("nombre") intenta la cascada de todos modos.
	Persona.save({ idPerson: 1, edad: 30, nombre: "Ana", mayor: true, altura: 1.6 });

	const avisos = [];
	const orig = console.warn;
	console.warn = (m) => avisos.push(m);
	let resultado;
	try {
		resultado = Persona.save({ idPerson: 1, edad: 30, nombre: "Ana María", mayor: true, altura: 1.6 });
	} finally {
		console.warn = orig;
	}
	assert.equal(resultado.nombre, "Ana María", "el save() de Persona se completa igualmente");
	assert.equal(avisos.length, 1);
	assert.match(avisos[0], /ha fallado.*no such table/);
});

test("wsdb v2: -> depends avisa (sin fallar el save) si ningún registro coincide con los valores anteriores", () => {
	const dir = tmpSrcDir();
	const TRABAJADORES = `-> name: 'trabajador'
-> schema
     -> idTrabajador: integer(10)(primary)
     -> nombre: string(40)/
`;
	writeWsdb(dir, "trabajadores.wsdb", TRABAJADORES);
	const conDepends = PERSONAS.replace("-> schema", "-> depends: ['trabajadores']\n-> schema");
	const dbPath = path.join(dir, "w.db");
	const { Persona } = buildWsdbV2(parse(conDepends, { isWsdbFile: true }), dbPath, "personas.wsdb", dir).classes;
	const { Trabajador } = buildWsdbV2(parse(TRABAJADORES, { isWsdbFile: true }), dbPath, "trabajadores.wsdb", dir).classes;
	// La tabla "trabajador" existe (hay un trabajador), pero ninguno se
	// llama "Ana" — el cambio de nombre de Persona no tiene a quién
	// propagarse.
	Trabajador.save({ idTrabajador: 1, nombre: "Luis" });

	Persona.save({ idPerson: 1, edad: 30, nombre: "Ana", mayor: true, altura: 1.6 });
	const avisos = [];
	const orig = console.warn;
	console.warn = (m) => avisos.push(m);
	let resultado;
	try {
		resultado = Persona.save({ idPerson: 1, edad: 30, nombre: "Ana María", mayor: true, altura: 1.6 });
	} finally {
		console.warn = orig;
	}
	assert.equal(resultado.nombre, "Ana María", "el save() de Persona se completa igualmente");
	assert.equal(avisos.length, 1);
	assert.match(avisos[0], /ningún registro tenía/);
});

test("rewriteWhereCalls: sin referencias a campo, el resultado es idéntico al JS original", () => {
	// Un .where() de otra librería (o con valores normales) no cambia.
	const q = { where: (c) => c, deleteWhere: (c) => c };
	// eslint-disable-next-line no-new-func
	const f = new Function("q", "__wsq", rewriteWhereCalls("let n = 0; const r = [q.where(3 > 2), q.where(0 || 'b'), q.where(!0), q.where(false && n++), q.deleteWhere(1 == '1')]; return [r, n];"));
	assert.deepEqual(f(q, __wsq), [[true, "b", true, false, true], 0], "incluido el cortocircuito de &&");
	// Idempotente.
	const once = rewriteWhereCalls("x.where(a > 1)");
	assert.equal(rewriteWhereCalls(once), once);
	// Texto que no es JS completo por sí solo: se deja tal cual.
	assert.equal(rewriteWhereCalls("else { x.where(a > 1) }"), "else { x.where(a > 1) }");
});

test("wsdb v2: decimal se guarda como columna numérica (compara como número, no como texto) y `== null` es IS NULL", () => {
	// Antes de guardar decimal como REAL, se serializaba como JSON (texto): "100" < "9.5" en orden de texto.
	const src = "-> name: 'cosa'\n-> schema\n     -> id: integer(10)(primary)/\n     -> nombre: string(20)/\n     -> precio: decimal(6,2)";
	const c = buildWsdbV2(parse(src, { isWsdbFile: true }), tmpDbPath(), "cosa.wsdb").classes;
	c.Cosa.save({ nombre: "a", precio: 9.5 });
	c.Cosa.save({ nombre: null, precio: 10.25 });
	c.Cosa.save({ nombre: "c", precio: 100 });
	assert.equal(run(c, "const s = CosaSchema.getSchema(); return Cosa.selectAll().where(s.nombre == null)").length, 1);
	assert.equal(run(c, "const s = CosaSchema.getSchema(); return Cosa.selectAll().where(s.nombre != null)").length, 2);
	const caros = run(c, "const s = CosaSchema.getSchema(); return Cosa.selectAll().where(s.precio > 10)");
	assert.deepEqual([...caros].map((x) => x.precio), [10.25, 100]);
});
