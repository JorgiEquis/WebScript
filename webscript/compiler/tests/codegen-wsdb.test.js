const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { parse } = require("../parser");
const { buildWsdbClass, buildWhere } = require("../codegen-wsdb");

function tmpDbPath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "websc-wsdb-"));
	return path.join(dir, "test.db");
}

const SCHEMA_USUARIOS = [
	'-> collection: "usuarios"',
	"-> schema:",
	"\tnombre: string",
	"\tedad: integer",
	"\tactivo: boolean",
].join("\n");

test("buildWsdbClass: guardar y encontrar un registro real, con id autoasignado", () => {
	const ast = parse(SCHEMA_USUARIOS, { isWsdbFile: true });
	const Usuario = buildWsdbClass(ast, "Usuario", tmpDbPath());

	const u = new Usuario("Ana", 30, true);
	assert.equal(u.id, null);
	u.save();
	assert.equal(u.id, 1);

	const encontrados = Usuario.find();
	assert.equal(encontrados.length, 1);
	assert.equal(encontrados[0].nombre, "Ana");
	assert.equal(encontrados[0].edad, 30);
	assert.equal(encontrados[0].activo, true);
});

test("buildWsdbClass: find() con igualdad y con operadores (gt/gte/lt/lte/ne)", () => {
	const ast = parse(SCHEMA_USUARIOS, { isWsdbFile: true });
	const Usuario = buildWsdbClass(ast, "Usuario", tmpDbPath());
	new Usuario("Ana", 30, true).save();
	new Usuario("Luis", 25, false).save();
	new Usuario("Eva", 40, true).save();

	assert.deepEqual(
		Usuario.find({ nombre: "Ana" }).map((u) => u.nombre),
		["Ana"]
	);
	assert.deepEqual(
		Usuario.find({ edad: { gt: 26 } })
			.map((u) => u.nombre)
			.sort(),
		["Ana", "Eva"]
	);
	assert.deepEqual(Usuario.find({ edad: { gte: 30 } }).length, 2);
	assert.deepEqual(Usuario.find({ edad: { lt: 30 } }).length, 1);
	assert.deepEqual(Usuario.find({ edad: { lte: 30 } }).length, 2);
	assert.deepEqual(Usuario.find({ edad: { ne: 30 } }).length, 2);
});

test("buildWsdbClass: findOne, findById, count, deleteMany", () => {
	const ast = parse(SCHEMA_USUARIOS, { isWsdbFile: true });
	const Usuario = buildWsdbClass(ast, "Usuario", tmpDbPath());
	const u1 = new Usuario("Ana", 30, true);
	u1.save();
	new Usuario("Luis", 25, false).save();

	assert.equal(Usuario.findOne({ nombre: "Ana" }).edad, 30);
	assert.equal(Usuario.findOne({ nombre: "Nadie" }), null);
	assert.equal(Usuario.findById(u1.id).nombre, "Ana");
	assert.equal(Usuario.count(), 2);
	assert.equal(Usuario.count({ activo: true }), 1);

	const borrados = Usuario.deleteMany({ activo: false });
	assert.equal(borrados, 1);
	assert.equal(Usuario.count(), 1);
});

test("buildWsdbClass: actualizar un registro existente con save() (UPDATE, no INSERT duplicado)", () => {
	const ast = parse(SCHEMA_USUARIOS, { isWsdbFile: true });
	const Usuario = buildWsdbClass(ast, "Usuario", tmpDbPath());
	const u = new Usuario("Ana", 30, true);
	u.save();
	const idOriginal = u.id;

	u.edad = 31;
	u.save();

	assert.equal(u.id, idOriginal); // mismo id, no uno nuevo
	assert.equal(Usuario.count(), 1); // sigue siendo un único registro
	assert.equal(Usuario.findById(idOriginal).edad, 31);
});

test("buildWsdbClass: delete() de instancia borra el registro real y limpia su id", () => {
	const ast = parse(SCHEMA_USUARIOS, { isWsdbFile: true });
	const Usuario = buildWsdbClass(ast, "Usuario", tmpDbPath());
	const u = new Usuario("Ana", 30, true);
	u.save();

	u.delete();
	assert.equal(u.id, null);
	assert.equal(Usuario.count(), 0);
});

test("buildWsdbClass: validación de tipo real en el constructor y en cada reasignación posterior", () => {
	const ast = parse(SCHEMA_USUARIOS, { isWsdbFile: true });
	const Usuario = buildWsdbClass(ast, "Usuario", tmpDbPath());

	assert.throws(() => new Usuario("Ana", "no soy un entero", true), /"edad".*integer/);

	const u = new Usuario("Ana", 30, true);
	assert.throws(() => {
		u.edad = "otra vez texto";
	}, /"edad".*integer/);
});

test("buildWsdbClass: persistencia real entre \"reinicios\" (una segunda clase, mismo fichero .db, sin conexión compartida en memoria)", () => {
	const dbPath = tmpDbPath();
	const ast = parse(SCHEMA_USUARIOS, { isWsdbFile: true });

	const Usuario1 = buildWsdbClass(ast, "Usuario", dbPath);
	new Usuario1("Ana", 30, true).save();

	// Se reconstruye la clase desde cero, con el mismo dbPath — simula un
	// proceso nuevo abriendo el mismo fichero.
	const Usuario2 = buildWsdbClass(ast, "Usuario", dbPath);
	const encontrados = Usuario2.find();
	assert.equal(encontrados.length, 1);
	assert.equal(encontrados[0].nombre, "Ana");
});

test("buildWsdbClass: un operador de consulta desconocido da un error claro", () => {
	const ast = parse(SCHEMA_USUARIOS, { isWsdbFile: true });
	const Usuario = buildWsdbClass(ast, "Usuario", tmpDbPath());
	assert.throws(() => Usuario.find({ edad: { operadorRaro: 1 } }), /Operador de consulta desconocido/);
});

test("buildWhere: igualdad simple genera un WHERE parametrizado", () => {
	const { where, params } = buildWhere({ nombre: "Ana" });
	assert.equal(where, "WHERE nombre = :p0");
	assert.deepEqual(params, { ":p0": "Ana" });
});

test("buildWhere: sin filtro, ningún WHERE", () => {
	const { where, params } = buildWhere({});
	assert.equal(where, "");
	assert.deepEqual(params, {});
});
