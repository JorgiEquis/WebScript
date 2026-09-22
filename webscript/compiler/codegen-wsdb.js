// codegen-wsdb.js — WebScript, v0
//
// Convierte el AST de un `.wsdb` (parse(source, {isWsdbFile:true})) en una
// clase JS real de colección — mismo criterio que buildDtoClass (clase
// real con closures, no texto generado), pero con .save()/.find()/
// .findOne()/.findById()/.delete() sobre una tabla SQLite real, creada
// sola la primera vez que se usa.
//
// Solo tiene sentido en servidor — no se puede acceder a una base de
// datos desde el navegador (se rechaza explícitamente en el cliente, ver
// codegen-client.js, mismo criterio que un paquete de npm).

const { validateField } = require("./codegen-dto");

// Una única conexión por fichero de base de datos, compartida entre
// todas las colecciones que la usen — abrir una conexión por colección
// sería derrochar sin motivo (SQLite ya soporta varias tablas en un
// mismo fichero de sobra).
const connections = new Map();
function getConnection(dbPath) {
	if (connections.has(dbPath)) return connections.get(dbPath);
	// eslint-disable-next-line global-require
	const { Database } = require("node-sqlite3-wasm");
	const fs = require("fs");
	const path = require("path");
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	connections.set(dbPath, db);
	return db;
}

// tipo de campo de WebScript -> tipo de columna SQLite. Un tipo que no es
// primitivo (object, o tipo(array)) se guarda como TEXT con el valor en
// JSON — mismo límite ya documentado para cualquier objeto anidado en el
// resto del lenguaje (no se valida en profundidad más allá de lo que ya
// hace validateField).
function sqlColumnType(fieldType) {
	if (fieldType === "integer") return "INTEGER";
	if (fieldType === "number" || fieldType === "float") return "REAL";
	if (fieldType === "boolean") return "INTEGER";
	if (fieldType === "string") return "TEXT";
	return "TEXT"; // object, tipo(array), o cualquier otro: JSON serializado
}

function isJsonField(fieldType) {
	return !["integer", "number", "float", "boolean", "string"].includes(fieldType);
}

function toColumnValue(field, value) {
	if (value === undefined || value === null) return null;
	if (field.fieldType === "boolean") return value ? 1 : 0;
	if (isJsonField(field.fieldType)) return JSON.stringify(value);
	return value;
}

function fromColumnValue(field, raw) {
	if (raw === null || raw === undefined) return raw;
	if (field.fieldType === "boolean") return !!raw;
	if (isJsonField(field.fieldType)) return JSON.parse(raw);
	return raw;
}

// Operadores de consulta estilo NoSQL sobre columnas reales — el
// subconjunto que cubre el uso normal: igualdad directa
// ({ edad: 30 }) y comparación ({ edad: { gt: 18 } }).
const OPERATORS = { gt: ">", gte: ">=", lt: "<", lte: "<=", ne: "!=" };

function buildWhere(query) {
	const clauses = [];
	const params = {};
	let i = 0;
	for (const [campo, valor] of Object.entries(query || {})) {
		if (valor !== null && typeof valor === "object" && !Array.isArray(valor)) {
			for (const [op, opValor] of Object.entries(valor)) {
				const sqlOp = OPERATORS[op];
				if (!sqlOp) throw new Error(`Operador de consulta desconocido: "${op}" (usa gt/gte/lt/lte/ne)`);
				const p = `:p${i++}`;
				clauses.push(`${campo} ${sqlOp} ${p}`);
				params[p] = opValor;
			}
		} else {
			const p = `:p${i++}`;
			clauses.push(`${campo} = ${p}`);
			params[p] = valor;
		}
	}
	return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

// A partir del AST de un .wsdb (ver parser.js: parseWsdbFile), construye
// una clase real de colección. `className` no viene en el .wsdb (es solo
// esquema) — lo decide quien lo instancia (el nombre pedido en el
// import).
function buildWsdbClass(wsdbAst, className, dbPath) {
	const collectionMeta = wsdbAst.fields.find((f) => f.type === "MetaField" && f.key === "collection");
	const table = collectionMeta ? collectionMeta.value.replace(/^["']|["']$/g, "") : className.toLowerCase();
	const schemaNode = wsdbAst.fields.find((f) => f.type === "ContentSchema");
	const schemaFields = schemaNode ? schemaNode.fields : [];

	let tableReady = false;
	function ensureTable() {
		if (tableReady) return;
		const db = getConnection(dbPath);
		const columnas = schemaFields.map((f) => `${f.name} ${sqlColumnType(f.fieldType)}`).join(", ");
		db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY AUTOINCREMENT${columnas ? ", " + columnas : ""})`);
		tableReady = true;
	}

	function rowToInstance(row) {
		const inst = Object.create(Collection.prototype);
		inst._id = row.id;
		for (const field of schemaFields) inst[`_${field.name}`] = fromColumnValue(field, row[field.name]);
		return inst;
	}

	class Collection {
		constructor(...args) {
			ensureTable();
			this._id = null;
			schemaFields.forEach((field, i) => {
				validateField(field, args[i], field.name);
				this[`_${field.name}`] = args[i];
			});
		}

		get id() {
			return this._id;
		}

		save() {
			ensureTable();
			const db = getConnection(dbPath);
			const params = {};
			for (const field of schemaFields) params[`:${field.name}`] = toColumnValue(field, this[`_${field.name}`]);
			if (this._id == null) {
				const cols = schemaFields.map((f) => f.name).join(", ");
				const vals = schemaFields.map((f) => `:${f.name}`).join(", ");
				const r = db.run(
					`INSERT INTO ${table} (${cols || "id"}) VALUES (${vals || "NULL"})`,
					schemaFields.length > 0 ? params : undefined
				);
				this._id = r.lastInsertRowid;
			} else {
				const sets = schemaFields.map((f) => `${f.name} = :${f.name}`).join(", ");
				params[":id"] = this._id;
				if (schemaFields.length > 0) db.run(`UPDATE ${table} SET ${sets} WHERE id = :id`, params);
			}
			return this;
		}

		delete() {
			if (this._id == null) return;
			ensureTable();
			getConnection(dbPath).run(`DELETE FROM ${table} WHERE id = :id`, { ":id": this._id });
			this._id = null;
		}

		static find(query) {
			ensureTable();
			const { where, params } = buildWhere(query);
			const rows = getConnection(dbPath).all(`SELECT * FROM ${table} ${where}`, params);
			return rows.map(rowToInstance);
		}

		static findOne(query) {
			ensureTable();
			const { where, params } = buildWhere(query);
			const row = getConnection(dbPath).get(`SELECT * FROM ${table} ${where} LIMIT 1`, params);
			return row ? rowToInstance(row) : null;
		}

		static findById(id) {
			return Collection.findOne({ id });
		}

		static deleteMany(query) {
			ensureTable();
			const { where, params } = buildWhere(query);
			return getConnection(dbPath).run(`DELETE FROM ${table} ${where}`, params).changes;
		}

		static count(query) {
			ensureTable();
			const { where, params } = buildWhere(query);
			return getConnection(dbPath).get(`SELECT COUNT(*) as n FROM ${table} ${where}`, params).n;
		}
	}

	Object.defineProperty(Collection, "name", { value: className });

	for (const field of schemaFields) {
		Object.defineProperty(Collection.prototype, field.name, {
			get() {
				return this[`_${field.name}`];
			},
			set(value) {
				validateField(field, value, field.name);
				this[`_${field.name}`] = value;
			},
			enumerable: true,
		});
	}

	Collection.table = table;
	Collection.schemaFields = schemaFields;
	return Collection;
}

module.exports = { buildWsdbClass, buildWhere, sqlColumnType };
