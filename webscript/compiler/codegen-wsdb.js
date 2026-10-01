// codegen-wsdb.js — WebScript, v0
//
// Convierte el AST de un `.wsdb` (parse(source, {isWsdbFile:true})) en dos
// clases JS reales — <Nombre> (datos: save/selectAll/select/delete/
// deleteWhere/after) y <Nombre>Schema (referencias a campo para las
// consultas) — mismo criterio que buildDtoClass (clases reales con
// closures, no texto generado), sobre una tabla SQLite real creada sola
// la primera vez que se usa.
//
// Solo tiene sentido en servidor — no se puede acceder a una base de
// datos desde el navegador (se rechaza explícitamente en el cliente, ver
// codegen-client.js, mismo criterio que un paquete de npm).
//
// Solo existe un formato de .wsdb ("-> name:"). El formato antiguo
// ("-> collection:", con find/findOne/findById/deleteMany) se eliminó:
// parseWsdbFile lo rechaza con un error que explica cómo migrar.

const fs = require("fs");
const path = require("path");
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
	if (fieldType === "number" || fieldType === "float" || fieldType === "decimal") return "REAL";
	if (fieldType === "boolean") return "INTEGER";
	if (fieldType === "string") return "TEXT";
	return "TEXT"; // object, tipo(array), o cualquier otro: JSON serializado
}

function isJsonField(fieldType) {
	return !["integer", "number", "float", "decimal", "boolean", "string"].includes(fieldType);
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

// Invoca el hook de after() / el callback de un delete — fire-and-forget,
// igual que WSON.enqueue() o la cascada de -> depends: si lanza o
// rechaza, se avisa por consola y NO se propaga hacia quien llamó a
// save()/delete(). Un hook nunca debe poder tumbar la operación que ya
// se completó con éxito — el guardado/borrado en sí ya ha terminado
// cuando se invoca.
function invokeAfterHook(fn, valor, contexto) {
	try {
		const r = fn(valor);
		if (r && typeof r.catch === "function") {
			r.catch((e) => {
				// eslint-disable-next-line no-console
				console.warn(`Aviso: el hook after() de ${contexto} ha fallado: ${e.message}`);
			});
		}
	} catch (e) {
		// eslint-disable-next-line no-console
		console.warn(`Aviso: el hook after() de ${contexto} ha fallado: ${e.message}`);
	}
}

// ============================================================================
// Clases por .wsdb ("-> name:"): <Nombre> (datos: save/select/delete) y
// <Nombre>Schema (referencias a campo para las consultas). Los sufijos "V2"
// de los nombres internos (buildWsdbV2, readWsdbV2...) son un resto
// histórico de cuando convivía con un formato anterior ya eliminado.
// ============================================================================

const util = require("util");
const { FieldRef, Cond, condToSql } = require("./wsdb-query");

const TIPOS_V2 = new Set(["string", "integer", "decimal", "boolean", "object"]);
const IDENT = /^[A-Za-z_]\w*$/;

function unquote(v) {
	return String(v).trim().replace(/^["'`]|["'`]$/g, "");
}

// Lee y valida la cabecera + el esquema de un .wsdb v2. Todo error de
// declaración sale aquí, al cargar/compilar — nunca en la primera
// petición que toque la colección.
function readWsdbV2(ast, label = ".wsdb") {
	const meta = {};
	for (const f of ast.fields) {
		if (f.type === "MetaField") {
			if (meta[f.key] !== undefined) throw new Error(`${label}: "-> ${f.key}" está declarado dos veces`);
			meta[f.key] = f.value;
		} else if (f.type === "Raw") {
			throw new Error(`${label}, línea ${f.line}: línea no reconocida "${f.text}"`);
		}
	}
	const conocidas = new Set(["name", "min", "max", "depends"]);
	for (const k of Object.keys(meta)) {
		if (!conocidas.has(k)) throw new Error(`${label}: clave desconocida "-> ${k}" (válidas: name, min, max, depends, schema)`);
	}

	const name = unquote(meta.name);
	if (!IDENT.test(name)) throw new Error(`${label}: "-> name: ${meta.name}" no es un nombre válido (letras, números y _, sin empezar por número)`);
	const className = name[0].toUpperCase() + name.slice(1);

	const entero = (k) => {
		if (meta[k] === undefined) return null;
		const v = meta[k].trim();
		if (!/^\d+$/.test(v)) throw new Error(`${label}: "-> ${k}" debe ser un entero no negativo, encontrado "${v}"`);
		return parseInt(v, 10);
	};
	const min = entero("min");
	const max = entero("max");
	if (min !== null && max !== null && min > max) throw new Error(`${label}: "min" (${min}) no puede ser mayor que "max" (${max})`);

	let depends = [];
	if (meta.depends !== undefined) {
		const acorn = require("acorn");
		let expr;
		try {
			expr = acorn.parseExpressionAt(meta.depends, 0, { ecmaVersion: "latest" });
		} catch {
			expr = null;
		}
		if (!expr || expr.type !== "ArrayExpression" || expr.end !== meta.depends.trim().length ||
			!expr.elements.every((e) => e && e.type === "Literal" && typeof e.value === "string")) {
			throw new Error(`${label}: "-> depends" debe ser un array de nombres de colección, p. ej. ['coches', 'trabajadores']`);
		}
		depends = expr.elements.map((e) => e.value.replace(/\.wsdb$/, ""));
	}

	const schemaNode = ast.fields.find((f) => f.type === "ContentSchema");
	if (!schemaNode || schemaNode.fields.length === 0) throw new Error(`${label}: falta "-> schema" con al menos un campo`);
	const fields = schemaNode.fields;
	const vistos = new Set();
	for (const f of fields) {
		const donde = `${label}, campo "${f.name}" (línea ${f.line})`;
		if (vistos.has(f.name)) throw new Error(`${donde}: nombre repetido`);
		vistos.add(f.name);
		const base = f.fieldType.replace(/\(array\)$/, "");
		if (!TIPOS_V2.has(base)) throw new Error(`${donde}: tipo desconocido "${base}" (válidos: ${[...TIPOS_V2].join(", ")})`);
		const esArray = f.fieldType.endsWith("(array)");
		if (f.size) {
			if (esArray || base === "object" || base === "boolean") {
				throw new Error(`${donde}: un campo ${f.fieldType} no admite longitud`);
			}
			if (base === "decimal" && f.size.length !== 2) {
				throw new Error(`${donde}: decimal necesita dos números — decimal(enteros,decimales), p. ej. decimal(2,3)`);
			}
			if (base !== "decimal" && f.size.length !== 1) throw new Error(`${donde}: ${base} lleva un solo número de longitud`);
			if (f.size.some((n) => n < 1) && base !== "decimal") throw new Error(`${donde}: la longitud debe ser al menos 1`);
		}
	}
	const primarias = fields.filter((f) => f.primary);
	if (primarias.length !== 1) {
		throw new Error(`${label}: el esquema necesita exactamente un campo (primary) — tiene ${primarias.length}`);
	}
	const primary = primarias[0];
	if (primary.fieldType !== "integer" && primary.fieldType !== "string") {
		throw new Error(`${label}: la clave primaria "${primary.name}" debe ser integer o string`);
	}
	if (primary.optional && primary.fieldType !== "integer") {
		throw new Error(`${label}: una clave primaria opcional (autonumérica) solo puede ser integer`);
	}

	return { name, className, schemaClassName: `${className}Schema`, min, max, depends, fields, primary };
}

// Validación de tipo (la de siempre, compartida con .wson) + longitud.
// Un decimal se redondea a sus decimales declarados — igual que un
// DECIMAL de SQL — en vez de rechazarse: 0.1 + 0.2 no es 0.3 en coma
// flotante, y exigir igualdad exacta haría fallar valores legítimos.
function checkValueV2(field, value, label) {
	validateField(field, value, label);
	if (value === undefined || value === null || !field.size) return value;
	if (field.fieldType === "string" && value.length > field.size[0]) {
		throw new TypeError(`"${label}" admite como máximo ${field.size[0]} caracteres, recibidos ${value.length}`);
	}
	if (field.fieldType === "integer" && String(Math.abs(value)).length > field.size[0]) {
		throw new TypeError(`"${label}" admite como máximo ${field.size[0]} dígitos, recibido ${value}`);
	}
	if (field.fieldType === "decimal") {
		const [enteros, decimales] = field.size;
		const redondeado = Number(value.toFixed(decimales));
		if (String(Math.trunc(Math.abs(redondeado))).length > enteros && Math.trunc(redondeado) !== 0) {
			throw new TypeError(`"${label}" admite como máximo ${enteros} dígitos enteros, recibido ${value}`);
		}
		return redondeado;
	}
	return value;
}

function sqlColumnDefV2(f) {
	if (f.primary) return f.fieldType === "integer" ? `"${f.name}" INTEGER PRIMARY KEY` : `"${f.name}" TEXT PRIMARY KEY NOT NULL`;
	return `"${f.name}" ${sqlColumnType(f.fieldType)}${f.optional ? "" : " NOT NULL"}`;
}

// "-> depends": para cada nombre, localiza su .wsdb (junto al fichero que
// declara depends, no al dbPath — dos .wsdb pueden compartir el mismo
// fichero .db pero viven donde está su código fuente) y calcula qué campos comparte con `meta` (mismo nombre Y mismo tipo base
// — el shared no exige la misma longitud/opcionalidad). Sin campos
// compartidos, la cascada nunca podría hacer nada: se avisa aquí, una
// sola vez al cargar, en vez de en cada save().
function resolveDependsTargets(meta, sourceDir, label) {
	return meta.depends.map((depName) => {
		const file = path.join(sourceDir, `${depName}.wsdb`);
		if (!fs.existsSync(file)) {
			throw new Error(`${label}: "-> depends" nombra "${depName}", pero no existe "${path.relative(process.cwd(), file)}"`);
		}
		const { parse } = require("./parser");
		let targetAst;
		try {
			targetAst = parse(fs.readFileSync(file, "utf8"), { isWsdbFile: true });
		} catch (e) {
			throw new Error(`${label}: "-> depends" nombra "${depName}", pero "${depName}.wsdb" no es válido: ${e.message}`);
		}
		const targetMeta = readWsdbV2(targetAst, `${depName}.wsdb`);
		const shared = meta.fields
			.filter((f) => targetMeta.fields.some((tf) => tf.name === f.name && tf.fieldType === f.fieldType))
			.map((f) => f.name);
		if (shared.length === 0) {
			// eslint-disable-next-line no-console
			console.warn(
				`Aviso: "-> depends" de ${label} nombra "${depName}", pero no comparten ningún campo con el mismo nombre y tipo — la actualización en cascada hacia "${depName}" no tendrá ningún efecto.`
			);
		}
		return { name: depName, table: targetMeta.name, byName: Object.fromEntries(targetMeta.fields.map((f) => [f.name, f])), shared };
	});
}

function buildWsdbV2(ast, dbPath, label, sourceDir = ".") {
	const meta = readWsdbV2(ast, label);
	const { name: table, className, schemaClassName, fields, primary, min, max } = meta;
	const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
	const db = () => getConnection(dbPath);
	const dependsTargets = meta.depends.length > 0 ? resolveDependsTargets(meta, sourceDir, label) : [];

	// Cascada real: para cada dependencia con campos compartidos, busca en
	// su tabla (mismo fichero .db) el o los registros cuyos campos
	// compartidos coincidan con los valores ANTERIORES (`oldRow`), y les
	// aplica los valores NUEVOS de esos mismos campos — simula una
	// actualización en cascada (no es una clave foránea real: no hay
	// integridad referencial, solo esta copia de valores). Un fallo aquí
	// (tabla destino inexistente, tipo incompatible en tiempo de
	// ejecución...) se avisa por consola y no interrumpe el save()
	// principal, que ya se ha completado.
	function cascadeUpdate(oldRow, newData) {
		for (const dep of dependsTargets) {
			if (dep.shared.length === 0) continue;
			const oldValues = dep.shared.map((name) => fromColumnValue(byName[name], oldRow[name]));
			const newValues = dep.shared.map((name) => newData[name]);
			if (oldValues.every((v, i) => v === newValues[i])) continue; // nada que propagar
			try {
				const setClause = dep.shared.map((name) => `"${name}" = ?`).join(", ");
				const whereClause = dep.shared.map((name) => `"${name}" = ?`).join(" AND ");
				const params = [
					...dep.shared.map((name, i) => toColumnValue(dep.byName[name], newValues[i])),
					...dep.shared.map((name, i) => toColumnValue(dep.byName[name], oldValues[i])),
				];
				const r = db().run(`UPDATE "${dep.table}" SET ${setClause} WHERE ${whereClause}`, params);
				if (r.changes === 0) {
					// eslint-disable-next-line no-console
					console.warn(
						`Aviso: actualización en cascada de "${table}" hacia "${dep.table}" (-> depends): ningún registro tenía ${dep.shared.map((n, i) => `${n} = ${JSON.stringify(oldValues[i])}`).join(", ")} — no se ha actualizado nada allí.`
					);
				}
			} catch (e) {
				// eslint-disable-next-line no-console
				console.warn(`Aviso: la actualización en cascada de "${table}" hacia "${dep.table}" (-> depends) ha fallado: ${e.message}`);
			}
		}
	}

	let tableReady = false;
	function ensureTable() {
		if (tableReady) return;
		const cols = db().all(`PRAGMA table_info("${table}")`);
		if (cols.length === 0) {
			db().exec(`CREATE TABLE "${table}" (${fields.map(sqlColumnDefV2).join(", ")})`);
		} else {
			// Evolución de esquema: un campo nuevo en el .wsdb se añade como
			// columna a la tabla existente (antes, save() fallaba con "no
			// such column"). Un campo obligatorio nuevo sobre una tabla con
			// filas no tiene valor posible para esas filas — error claro.
			const existentes = new Map(cols.map((c) => [c.name, c]));
			const pkActual = cols.find((c) => c.pk);
			if (pkActual && pkActual.name !== primary.name) {
				throw new Error(`La tabla "${table}" ya existe con clave primaria "${pkActual.name}", no "${primary.name}" — cambiar la clave primaria de una colección con datos no se hace automáticamente`);
			}
			for (const f of fields) {
				if (existentes.has(f.name)) continue;
				if (f.primary) throw new Error(`La tabla "${table}" ya existe sin la columna de clave primaria "${f.name}"`);
				const filas = db().get(`SELECT COUNT(*) AS n FROM "${table}"`).n;
				if (!f.optional && filas > 0) {
					throw new Error(`El campo obligatorio nuevo "${f.name}" no se puede añadir a "${table}": ya tiene ${filas} registro(s) sin valor para él. Decláralo opcional (con /) o vacía la colección.`);
				}
				db().exec(`ALTER TABLE "${table}" ADD COLUMN "${f.name}" ${sqlColumnType(f.fieldType)}`);
			}
		}
		tableReady = true;
	}

	function rowToJson(row) {
		const out = {};
		for (const [k, v] of Object.entries(row)) out[k] = byName[k] ? fromColumnValue(byName[k], v) : v;
		return out;
	}

	// Fila COMPLETA (todas las columnas) -> instancia real de `Main`, sin
	// pasar por el constructor (que revalidaría con checkValueV2 algo que
	// ya viene de la propia base de datos — validado una vez, al guardar,
	// no hace falta repetirlo en cada lectura). Solo se usa para filas completas
	// (selectAll(), save()) — NUNCA para una proyección parcial de
	// select(): una instancia de Main a la que le faltan campos, si luego
	// se guarda con Persona.save(), pisaría esos campos ausentes con NULL
	// en la base de datos real, silenciosamente. rowToPartialJson (más
	// abajo) es la versión segura para ese caso.
	function rowToInstance(row) {
		const inst = Object.create(Main.prototype);
		valores.set(inst, rowToJson(row));
		return inst;
	}

	// Igual que rowToJson, pero MARCA el resultado como parcial (una
	// propiedad no enumerable — invisible a JSON.stringify/Object.entries,
	// pero comprobable por static save()/delete()) para poder rechazarlo
	// ahí con un error claro en vez de dejar que pise en silencio los
	// campos que no se seleccionaron. Ver el bug real reproducido en
	// INSTRUCCIONES.md antes de esta corrección: un campo OPCIONAL
	// ausente de la proyección se guardaba como NULL sin ningún aviso.
	function rowToPartialJson(row) {
		const out = rowToJson(row);
		Object.defineProperty(out, PARCIAL, { value: true, enumerable: false });
		return out;
	}

	function fieldName(ref, uso) {
		if (ref instanceof FieldRef) {
			if (ref.collection !== table) throw new Error(`${uso}: el campo "${ref.collection}.${ref.name}" no es de "${table}"`);
			return ref.name;
		}
		if (typeof ref === "string" && byName[ref]) return ref;
		throw new Error(`${uso}: "${ref}" no es un campo de "${table}" (usa ${schemaClassName}.getSchema().campo)`);
	}

	const PARCIAL = Symbol("wsdb-parcial");

	function whereSql(cond) {
		if (cond === null) return { sql: "", params: [] };
		const r = condToSql(cond, { fields: byName, collection: table, toColumnValue });
		return { sql: ` WHERE ${r.sql}`, params: r.params };
	}

	function count(cond = null) {
		ensureTable();
		const w = whereSql(cond);
		return db().get(`SELECT COUNT(*) AS n FROM "${table}"${w.sql}`, w.params).n;
	}

	// Consulta perezosa: Persona.selectAll() devuelve algo que ya se usa
	// como un array normal (length, [i], map, for...of, JSON...), pero la
	// consulta real no se lanza hasta ese primer uso — así
	// selectAll().where(...) no recorre antes la tabla entera. El Proxy
	// rellena su propio array objetivo en el primer acceso y a partir de
	// ahí es ese array tal cual.
	function makeQuery(state) {
		const target = [];
		let hecho = false;
		function run() {
			if (hecho) return;
			hecho = true;
			ensureTable();
			const cols = state.columns ? state.columns.map((c) => `"${c}"`).join(", ") : "*";
			const w = whereSql(state.where);
			const order = state.order.length ? ` ORDER BY ${state.order.map(([c, d]) => `"${c}" ${d}`).join(", ")}` : "";
			const rows = db().all(`SELECT ${cols} FROM "${table}"${w.sql}${order}`, w.params);
			// selectAll() (state.columns === null, todas las columnas) da
			// instancias reales de Main, usables tal cual con save()/delete().
			// select(...campos) (proyección parcial) da objetos planos
			// marcados como parciales — ver rowToPartialJson.
			target.push(...rows.map(state.columns ? rowToPartialJson : rowToInstance));
		}
		const next = (patch) => makeQuery({ ...state, ...patch });
		const builders = {
			where(cond) {
				if (cond !== null && typeof cond === "object" && !(cond instanceof Cond) && !(cond instanceof FieldRef)) {
					throw new Error(`.where() de "${table}" espera una condición (p. ej. schema.edad > 10), no un objeto`);
				}
				const combinada = state.where === null ? cond : new Cond("and", { left: state.where, right: cond });
				return next({ where: combinada });
			},
			sortAsc(ref) {
				return next({ order: [...state.order, [fieldName(ref, "sortAsc()"), "ASC"]] });
			},
			sortDesc(ref) {
				return next({ order: [...state.order, [fieldName(ref, "sortDesc()"), "DESC"]] });
			},
		};
		Object.defineProperty(target, util.inspect.custom, {
			value(depth, opts, inspect) {
				run();
				return inspect([...target], opts);
			},
		});
		const fwd = (trap) => (t, ...args) => {
			run();
			return Reflect[trap](t, ...args);
		};
		return new Proxy(target, {
			get(t, prop, recv) {
				if (typeof prop === "string" && Object.prototype.hasOwnProperty.call(builders, prop)) return builders[prop];
				run();
				return Reflect.get(t, prop, recv);
			},
			set: fwd("set"),
			has: fwd("has"),
			ownKeys: fwd("ownKeys"),
			getOwnPropertyDescriptor: fwd("getOwnPropertyDescriptor"),
			defineProperty: fwd("defineProperty"),
			deleteProperty: fwd("deleteProperty"),
		});
	}

	const valores = new WeakMap();

	class Main {
		constructor(json) {
			if (json === null || typeof json !== "object" || Array.isArray(json)) {
				throw new TypeError(`new ${className}() espera un objeto con los campos, p. ej. new ${className}({ ${fields.map((f) => f.name).slice(0, 2).join(", ")} })`);
			}
			for (const k of Object.keys(json)) {
				if (!byName[k]) throw new TypeError(`${className} no tiene el campo "${k}" (campos: ${fields.map((f) => f.name).join(", ")})`);
			}
			const v = {};
			for (const f of fields) v[f.name] = checkValueV2(f, json[f.name], `${className}.${f.name}`);
			valores.set(this, v);
		}

		toJSON() {
			return { ...valores.get(this) };
		}

		// Inserta o actualiza según exista ya un registro con esa clave
		// primaria. Devuelve el registro tal como ha quedado guardado.
		static save(item) {
			ensureTable();
			if (item !== null && typeof item === "object" && item[PARCIAL]) {
				throw new Error(
					`${className}.save(): este registro viene de select() (una proyección parcial) — guardarlo así pisaría con NULL cualquier campo que no se seleccionó. Usa selectAll() si necesitas guardar el registro, o vuelve a leerlo completo con selectAll().`
				);
			}
			const inst = item instanceof Main ? item : new Main(item);
			const data = valores.get(inst);
			const pk = data[primary.name];
			// El registro ANTERIOR completo (no solo si existe) — hace
			// falta tal cual para la cascada hacia -> depends, que compara
			// contra los valores previos, no contra los nuevos.
			const oldRow = pk !== undefined && pk !== null ? db().get(`SELECT * FROM "${table}" WHERE "${primary.name}" = ?`, [pk]) : null;
			if (oldRow) {
				const otros = fields.filter((f) => !f.primary);
				if (otros.length) {
					db().run(
						`UPDATE "${table}" SET ${otros.map((f) => `"${f.name}" = ?`).join(", ")} WHERE "${primary.name}" = ?`,
						[...otros.map((f) => toColumnValue(f, data[f.name])), pk]
					);
				}
				if (dependsTargets.length > 0) cascadeUpdate(oldRow, data);
			} else {
				if (max !== null && count() >= max) {
					throw new Error(`No se puede insertar en "${table}": ya tiene el máximo de ${max} registro(s)`);
				}
				const cols = fields.filter((f) => !(f.primary && (pk === undefined || pk === null)));
				const r = db().run(
					`INSERT INTO "${table}" (${cols.map((f) => `"${f.name}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
					cols.map((f) => toColumnValue(f, data[f.name]))
				);
				if (pk === undefined || pk === null) data[primary.name] = r.lastInsertRowid;
			}
			const row = db().get(`SELECT * FROM "${table}" WHERE "${primary.name}" = ?`, [data[primary.name]]);
			return rowToInstance(row);
		}

		static selectAll() {
			return makeQuery({ columns: null, where: null, order: [] });
		}

		static select(...refs) {
			if (refs.length === 0) throw new Error(`${className}.select() necesita al menos un campo — para todos, usa selectAll()`);
			return makeQuery({ columns: refs.map((r) => fieldName(r, "select()")), where: null, order: [] });
		}

		// delete(registro) borra por clave primaria. Devuelve cuántos se han
		// borrado (0 o 1).
		// `after` (opcional): se llama con el número de filas borradas (0 o
		// 1). No se encadena con .after() por diseño — ver el comentario en
		// deleteWhere(), donde aplica igual.
		static delete(item, after) {
			if (item === null || typeof item !== "object" || item instanceof Cond || item instanceof FieldRef) {
				throw new Error(`${className}.delete() espera un registro — para borrar por condición, usa ${className}.deleteWhere(condición)`);
			}
			// A diferencia de save(), borrar por un registro parcial de
			// select() SÍ es seguro en sí mismo (delete no escribe columnas,
			// solo necesita la primary) — pero si esa proyección ni siquiera
			// incluyó la primary, el mensaje genérico de "no tiene <pk>" de
			// abajo ya lo cubre con claridad suficiente.
			const pk = item instanceof Main ? valores.get(item)[primary.name] : item[primary.name];
			if (pk === undefined || pk === null) throw new Error(`${className}.delete(): el registro no tiene "${primary.name}"`);
			return deleteByCond(new Cond("cmp", { op: "==", field: new FieldRef(table, primary.name), value: pk }), after);
		}

		// deleteWhere(condición, after?): misma condición que .where(). Nunca
		// vacía la colección por accidente: sin argumento es un error, y
		// vaciarla entera tiene que ser explícito — deleteWhere(true).
		//
		// `after` es un parámetro, NO .after() encadenado — a propósito: a
		// diferencia de save() (devuelve una instancia real, un objeto),
		// delete()/deleteWhere() devuelven un NÚMERO primitivo, y eso es
		// deliberado: `if (Persona.deleteWhere(cond))` debe significar "se
		// borró algo". Envolver ese número en un objeto para poder
		// encadenar .after() lo haría "truthy" SIEMPRE, incluso con 0
		// registros borrados — un objeto nunca es falsy en JS, por muy
		// convincente que sea su valueOf(). Confirmado con código real
		// antes de descartar esa opción (ver DISEÑO.md).
		static deleteWhere(cond, after) {
			if (cond === undefined) throw new Error(`${className}.deleteWhere() necesita una condición (para vaciarla entera: deleteWhere(true))`);
			if (cond !== null && typeof cond === "object" && !(cond instanceof Cond) && !(cond instanceof FieldRef)) {
				throw new Error(`${className}.deleteWhere() espera una condición (p. ej. schema.edad < 10), no un objeto`);
			}
			return deleteByCond(cond, after);
		}
	}

	function deleteByCond(cond, after) {
		ensureTable();
		const w = whereSql(cond);
		db().exec("BEGIN");
		let n;
		try {
			if (min !== null) {
				const borrarian = db().get(`SELECT COUNT(*) AS n FROM "${table}"${w.sql}`, w.params).n;
				const total = count();
				if (borrarian > 0 && total - borrarian < min) {
					throw new Error(`No se puede borrar de "${table}": quedarían ${total - borrarian} registro(s) y el mínimo es ${min}`);
				}
			}
			n = db().run(`DELETE FROM "${table}"${w.sql}`, w.params).changes;
			db().exec("COMMIT");
		} catch (e) {
			db().exec("ROLLBACK");
			throw e;
		}
		// El hook se llama DESPUÉS del COMMIT — nunca dentro de la
		// transacción (si el hook tarda o falla, la transacción ya está
		// cerrada, y un fallo del hook no debe poder forzar un ROLLBACK de
		// un borrado que ya se completó con éxito).
		if (after) invokeAfterHook(after, n, `${className}.delete()`);
		return n;
	}
	// Hook tras save() — encadenable (.after(a).after(b)) porque save()
	// SIEMPRE devuelve una instancia real de Main (un objeto), nunca un
	// primitivo — a diferencia de delete()/deleteWhere(), donde `after`
	// es un parámetro, no un método encadenado (ver el porqué justo
	// encima de deleteWhere()). Fire-and-forget: un fallo del hook nunca
	// deshace el save() ya completado (ver invokeAfterHook). Recibe la
	// propia instancia guardada, y devuelve `this` para poder seguir
	// encadenando. Vale para una function normal o una online function.
	Main.prototype.after = function (fn) {
		invokeAfterHook(fn, this, `${className}.after()`);
		return this;
	};

	Object.defineProperty(Main, "name", { value: className });
	for (const f of fields) {
		Object.defineProperty(Main.prototype, f.name, {
			get() {
				return valores.get(this)[f.name];
			},
			set(v) {
				valores.get(this)[f.name] = checkValueV2(f, v, `${className}.${f.name}`);
			},
			enumerable: true,
		});
	}
	Main.prototype[util.inspect.custom] = function () {
		return `${className} ${util.inspect(valores.get(this))}`;
	};

	const refs = Object.freeze(Object.fromEntries(fields.map((f) => [f.name, new FieldRef(table, f.name)])));
	class Schema {
		static getSchema() {
			return refs;
		}
	}
	Object.defineProperty(Schema, "name", { value: schemaClassName });

	return { meta, classes: { [className]: Main, [schemaClassName]: Schema } };
}

module.exports = { sqlColumnType, readWsdbV2, buildWsdbV2, resolveDependsTargets };
