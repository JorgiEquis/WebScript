// type-check.js — WebScript, v0
//
// La comprobación de tipo primitivo en sí (string/integer/decimal/boolean/
// any) es la misma tanto para los campos de un DTO (.wson) como para
// var/const/reactive tipadas — este módulo la centraliza para que ambos
// sitios apliquen exactamente el mismo criterio. Los MENSAJES de error de
// cada sitio se quedan donde estaban (los del DTO ya están probados con un
// formato concreto) — esto solo comparte la regla de "coincide o no".

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
			return null; // object / clase de usuario: no comprobable aquí
	}
}

// Comprueba `value` contra `declaredType` ("integer", "tipo(array)", etc.).
// Devuelve un mensaje de error si no coincide, o null si está bien — o si
// `declaredType` no es un tipo comprobable aquí (object, clase de usuario,
// o ausente), en cuyo caso no se valida nada (igual que en el DTO).
function typeMismatch(declaredType, value, label) {
	if (!declaredType) return null;

	const arrayMatch = /^(\w+)\(array\)$/.exec(declaredType);
	if (arrayMatch) {
		if (!Array.isArray(value)) return `${label} está declarada como "${declaredType}" pero el valor no es un array`;
		const check = primitiveCheck(arrayMatch[1]);
		if (!check) return null; // array de una clase de usuario: no se valida el contenido aquí
		for (let i = 0; i < value.length; i++) {
			if (!check(value[i])) {
				return `${label}[${i}] debe ser ${arrayMatch[1]}, recibido ${typeof value[i]} (${JSON.stringify(value[i])})`;
			}
		}
		return null;
	}

	const check = primitiveCheck(declaredType);
	if (!check) return null; // object / clase de usuario: no comprobable aquí
	if (!check(value)) {
		return `${label} está declarada como "${declaredType}", recibido ${typeof value} (${JSON.stringify(value)})`;
	}
	return null;
}

module.exports = { primitiveCheck, typeMismatch };
