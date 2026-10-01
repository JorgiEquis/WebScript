// wsdb-query.js — WebScript, v0
//
// Condiciones de .where() para colecciones .wsdb (formato v2).
//
// El problema: `Persona.selectAll().where(personaSchema.edad > 10)`,
// evaluado como JS normal, calcula `"edad" > 10` (false) ANTES de llamar
// a where() — where() nunca vería la condición, solo su resultado. Así que
// el compilador reescribe el argumento de cada `.where(...)`:
//
//   a > b     ->  __wsq.cmp(">", a, b)
//   a && b   ->  __wsq.and(() => a', () => b')
//   a || b   ->  __wsq.or(() => a', () => b')
//   !a        ->  __wsq.not(a')
//   a (otro)  ->  __wsq.truthy(a)
//
// En ejecución, cada helper mira si alguno de sus operandos es una
// referencia a campo (FieldRef, lo que devuelve XSchema.getSchema()): si
// lo es, construye un nodo de condición que luego se traduce a un WHERE
// parametrizado; si no hay ninguna referencia a campo implicada, devuelve
// EXACTAMENTE lo mismo que la expresión JS original (incluido el
// cortocircuito de && y ||, por eso van en funciones flecha). Así un
// `.where()` de cualquier otra librería (un paquete de npm, p. ej.) sigue
// funcionando igual que si no se hubiera reescrito nada.

const acorn = require("acorn");
const walk = require("acorn-walk");

// --- Tiempo de ejecución ---------------------------------------------------

class FieldRef {
	constructor(collection, name) {
		this.collection = collection;
		this.name = name;
		Object.freeze(this);
	}
	toString() {
		return this.name;
	}
	toJSON() {
		return this.name;
	}
	[Symbol.toPrimitive]() {
		return this.name;
	}
}

class Cond {
	constructor(kind, props) {
		this.kind = kind; // "cmp" | "truthy" | "not" | "and" | "or" | "const"
		Object.assign(this, props);
	}
}

const COMPARADORES = new Set([">", ">=", "<", "<=", "==", "===", "!=", "!=="]);
const INVERSO = { ">": "<", ">=": "<=", "<": ">", "<=": ">=", "==": "==", "===": "===", "!=": "!=", "!==": "!==" };

function jsCompare(op, a, b) {
	switch (op) {
		case ">": return a > b;
		case ">=": return a >= b;
		case "<": return a < b;
		case "<=": return a <= b;
		// eslint-disable-next-line eqeqeq
		case "==": return a == b;
		case "===": return a === b;
		// eslint-disable-next-line eqeqeq
		case "!=": return a != b;
		case "!==": return a !== b;
		default: throw new Error(`Comparador no soportado: ${op}`);
	}
}

const isQueryPart = (v) => v instanceof Cond || v instanceof FieldRef;
const asCond = (v) => (v instanceof Cond ? v : v instanceof FieldRef ? new Cond("truthy", { field: v }) : new Cond("const", { value: !!v }));

const __wsq = {
	cmp(op, a, b) {
		if (!(a instanceof FieldRef) && !(b instanceof FieldRef)) return jsCompare(op, a, b);
		if (a instanceof FieldRef) return new Cond("cmp", { op, field: a, value: b });
		return new Cond("cmp", { op: INVERSO[op], field: b, value: a });
	},
	and(fa, fb) {
		const a = fa();
		if (isQueryPart(a)) return new Cond("and", { left: asCond(a), right: asCond(fb()) });
		if (!a) return a;
		return fb();
	},
	or(fa, fb) {
		const a = fa();
		if (isQueryPart(a)) return new Cond("or", { left: asCond(a), right: asCond(fb()) });
		if (a) return a;
		return fb();
	},
	not(a) {
		return isQueryPart(a) ? new Cond("not", { inner: asCond(a) }) : !a;
	},
	truthy(a) {
		return a;
	},
};

// Traduce una condición (o un valor suelto: FieldRef, booleano...) a SQL
// parametrizado. `fields` = campos del esquema por nombre (para validar
// que el campo existe y convertir el valor a su forma de columna);
// `collection` = nombre de la colección dueña de esas referencias.
function condToSql(value, { fields, collection, toColumnValue }) {
	const params = [];
	function fieldOf(ref) {
		if (ref.collection !== collection) {
			throw new Error(`El campo "${ref.collection}.${ref.name}" no pertenece a la colección "${collection}"`);
		}
		const f = fields[ref.name];
		if (!f) throw new Error(`La colección "${collection}" no tiene el campo "${ref.name}"`);
		return f;
	}
	function gen(c) {
		switch (c.kind) {
			case "const":
				return c.value ? "1" : "0";
			case "truthy": {
				const f = fieldOf(c.field);
				if (f.fieldType !== "boolean") {
					throw new Error(
						`En .where(), "${c.field.name}" sola solo vale para campos boolean — usa una comparación explícita (p. ej. ${c.field.name} != null)`
					);
				}
				return `"${f.name}" = 1`;
			}
			case "not": {
				if (c.inner.kind === "truthy") {
					const f = fieldOf(c.inner.field);
					if (f.fieldType === "boolean") return `COALESCE("${f.name}", 0) = 0`;
				}
				return `NOT (${gen(c.inner)})`;
			}
			case "and":
				return `(${gen(c.left)} AND ${gen(c.right)})`;
			case "or":
				return `(${gen(c.left)} OR ${gen(c.right)})`;
			case "cmp": {
				const f = fieldOf(c.field);
				if (c.value instanceof FieldRef) {
					const g = fieldOf(c.value);
					return `"${f.name}" ${sqlOp(c.op)} "${g.name}"`;
				}
				if (c.value === null || c.value === undefined) {
					if (c.op === "==" || c.op === "===") return `"${f.name}" IS NULL`;
					if (c.op === "!=" || c.op === "!==") return `"${f.name}" IS NOT NULL`;
					throw new Error(`No se puede comparar "${f.name}" ${c.op} null`);
				}
				params.push(toColumnValue(f, c.value));
				return `"${f.name}" ${sqlOp(c.op)} ?`;
			}
			default:
				throw new Error(`Condición desconocida: ${c.kind}`);
		}
	}
	const sql = gen(asCond(value));
	return { sql, params };
}

function sqlOp(op) {
	if (op === "==" || op === "===") return "=";
	if (op === "!=" || op === "!==") return "<>";
	return op;
}

// --- Tiempo de compilación -------------------------------------------------

const ACORN_OPTS = {
	ecmaVersion: "latest",
	sourceType: "script",
	allowReturnOutsideFunction: true,
	allowAwaitOutsideFunction: true,
};

function tryParse(code) {
	try {
		return acorn.parse(code, ACORN_OPTS);
	} catch {
		return null;
	}
}

// Reescribe el argumento de cada `.where(...)` de `code`. Si el texto no
// es JS completo por sí solo (un `else { ... }` suelto, p. ej.), se
// devuelve tal cual: sus sentencias internas ya pasaron por aquí una a
// una al generarse, así que no se pierde nada. Idempotente: un argumento
// ya reescrito (empieza por __wsq.) no se toca otra vez.
// Métodos cuyo argumento es una condición: .where() y .deleteWhere().
const QUERY_METHODS = new Set(["where", "deleteWhere"]);

// .where(condición) siempre tiene exactamente un argumento.
// .deleteWhere(condición, after?) admite un segundo argumento opcional
// (el hook de after — ver codegen-wsdb.js), que NO es una condición y no
// debe reescribirse: solo se traduce el argumento en la posición 0.
function tieneArgumentoDeCondicion(node) {
	const nombre = node.callee.property.name;
	if (nombre === "where") return node.arguments.length === 1;
	if (nombre === "deleteWhere") return node.arguments.length === 1 || node.arguments.length === 2;
	return false;
}

function rewriteWhereCalls(code) {
	if (!/\.(where|deleteWhere)\s*\(/.test(code)) return code;
	const ast = tryParse(code);
	if (!ast) return code;

	const targets = [];
	walk.full(ast, (node) => {
		if (
			node.type === "CallExpression" &&
			node.callee.type === "MemberExpression" &&
			!node.callee.computed &&
			QUERY_METHODS.has(node.callee.property.name) &&
			tieneArgumentoDeCondicion(node) &&
			!isAlreadyRewritten(node.arguments[0])
		) {
			targets.push(node.arguments[0]);
		}
	});
	// Solo los más externos: uno anidado dentro del argumento de otro ya se
	// reescribe como parte de ese (queda dentro de un operando, tal cual).
	const outer = targets.filter((t) => !targets.some((o) => o !== t && o.start <= t.start && t.end <= o.end));
	outer.sort((a, b) => b.start - a.start);

	let out = code;
	for (const arg of outer) {
		out = out.slice(0, arg.start) + transform(arg, code) + out.slice(arg.end);
	}
	return out;
}

function isAlreadyRewritten(node) {
	return (
		node.type === "CallExpression" &&
		node.callee.type === "MemberExpression" &&
		node.callee.object.type === "Identifier" &&
		node.callee.object.name === "__wsq"
	);
}

function transform(node, code) {
	const src = (n) => code.slice(n.start, n.end);
	if (node.type === "LogicalExpression" && (node.operator === "&&" || node.operator === "||")) {
		const fn = node.operator === "&&" ? "and" : "or";
		return `__wsq.${fn}(() => (${transform(node.left, code)}), () => (${transform(node.right, code)}))`;
	}
	if (node.type === "BinaryExpression" && COMPARADORES.has(node.operator)) {
		return `__wsq.cmp(${JSON.stringify(node.operator)}, (${src(node.left)}), (${src(node.right)}))`;
	}
	if (node.type === "UnaryExpression" && node.operator === "!") {
		return `__wsq.not(${transform(node.argument, code)})`;
	}
	return `__wsq.truthy(${src(node)})`;
}

module.exports = { FieldRef, Cond, __wsq, condToSql, rewriteWhereCalls };
