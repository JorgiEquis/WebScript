// codegen-dto.js — WebScript, v0
//
// Convierte el AST de un `.wson` (parse(source, {isWsonFile:true})) en una
// clase JS real: constructor posicional según el orden de los campos del
// esquema, con validación de tipo en el propio constructor y en cada
// asignación posterior (getters/setters), como se decidió en DISEÑO.md.
//
// LIMITACIÓN: no extiende de la clase WSON de verdad todavía (wson-runtime
// exporta funciones sueltas, no una clase) — el objeto resultante lleva
// to/via/from como propiedades normales, pero no hereda comportamiento de
// WSON.send()/etc. Conectar esto con el runtime y con la resolución de
// `import` en el servidor es la siguiente pieza pendiente.

function primitiveCheck(fieldType) {
	switch (fieldType) {
		case "string":
			return (v) => typeof v === "string";
		case "integer":
			return (v) => Number.isInteger(v);
		case "decimal":
			return (v) => typeof v === "number";
		case "boolean":
			return (v) => typeof v === "boolean";
		case "any":
			return () => true;
		default:
			return null; // object / clase de usuario: no validado aquí
	}
}

function validateField(field, value, path) {
	if (value === undefined || value === null) {
		if (field.optional) return;
		throw new TypeError(`Campo obligatorio "${path}" no informado`);
	}

	if (field.fieldType === "object") {
		if (typeof value !== "object") throw new TypeError(`"${path}" debe ser un object`);
		for (const sub of field.fields || []) {
			validateField(sub, value[sub.name], `${path}.${sub.name}`);
		}
		return;
	}

	const arrayMatch = /^(\w+)\(array\)$/.exec(field.fieldType);
	if (arrayMatch) {
		if (!Array.isArray(value)) throw new TypeError(`"${path}" debe ser un array`);
		const check = primitiveCheck(arrayMatch[1]);
		if (check) {
			value.forEach((item, i) => {
				if (!check(item)) throw new TypeError(`"${path}[${i}]" debe ser ${arrayMatch[1]}`);
			});
		}
		return;
	}

	const check = primitiveCheck(field.fieldType);
	if (check && !check(value)) {
		throw new TypeError(`"${path}" debe ser ${field.fieldType}, recibido ${typeof value}`);
	}
}

// A partir del AST de un .wson (ver parser.js: parseWsonFile), construye
// una clase real. `className` no viene en el .wson (es solo esquema) — lo
// decide quien lo instancia (normalmente el nombre del fichero en mayúsculas).
function buildDtoClass(wsonAst, className) {
	const to = fieldValue(wsonAst, "to");
	const via = fieldValue(wsonAst, "via");
	const from = fieldValue(wsonAst, "from");
	const contentSchema = wsonAst.fields.find((f) => f.type === "ContentSchema");
	const schemaFields = contentSchema ? contentSchema.fields : [];

	class DTO {
		constructor(...args) {
			this.to = to;
			this.via = via;
			this.from = from;
			this.httpCode = null;
			this.id = null;
			this.createdAt = null;

			schemaFields.forEach((field, i) => {
				validateField(field, args[i], field.name);
				this[`_${field.name}`] = args[i];
			});
		}
	}

	Object.defineProperty(DTO, "name", { value: className });

	// Getters/setters que respetan el esquema también al sobreescribir,
	// como se decidió en DISEÑO.md.
	for (const field of schemaFields) {
		Object.defineProperty(DTO.prototype, field.name, {
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

	DTO.schemaFields = schemaFields;
	return DTO;
}

function fieldValue(wsonAst, key) {
	const f = wsonAst.fields.find((x) => x.type === "MetaField" && x.key === key);
	return f ? f.value.replace(/^["']|["']$/g, "") : null;
}

module.exports = { buildDtoClass, validateField };
