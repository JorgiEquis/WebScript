// validate-js-body.js — WebScript, v0
//
// Detecta, con un parser JS real (no regex — evita falsos positivos con
// destructuring, plantillas, claves de objeto, etc.), referencias a
// identificadores que no están declarados ni son conocidos — típicamente
// una variable de servidor mal escrita, que de otro modo solo se vería
// como un `ReferenceError` en tiempo de ejecución, en la primera petición
// real que llegara a tocar esa línea.
//
// Hace scope-checking real: una `var`/`const` de WebScript compila a
// `let`/`const` de JS (nunca a `var` real — ver genStatement en
// codegen-server.js/codegen-client.js), así que ya tienen scope de
// bloque de verdad en el código generado. Una variable declarada dentro
// de un `if`/`for` y usada fuera de él revienta de verdad en tiempo de
// ejecución (`ReferenceError`) aunque "parezca" estar en el mismo
// cuerpo — este análisis lo detecta igual que un typo, antes de
// ejecutar nada.

const acorn = require("acorn");
const walk = require("acorn-walk");

// Globales de JS/Node que es razonable usar dentro de un watch() — no son
// "desconocidos" solo por no estar declarados en el propio fichero.
const KNOWN_GLOBALS = new Set([
	"console",
	"JSON",
	"Math",
	"Array",
	"Object",
	"Promise",
	"Number",
	"String",
	"Boolean",
	"Date",
	"RegExp",
	"Error",
	"TypeError",
	"RangeError",
	"SyntaxError",
	"ReferenceError",
	"EvalError",
	"URIError",
	"Symbol",
	"Map",
	"Set",
	"WeakMap",
	"WeakSet",
	"ArrayBuffer",
	"Int8Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"Int16Array",
	"Uint16Array",
	"Int32Array",
	"Uint32Array",
	"Float32Array",
	"Float64Array",
	"BigInt",
	"Reflect",
	"Proxy",
	"Function",
	"undefined",
	"NaN",
	"Infinity",
	"parseInt",
	"parseFloat",
	"isNaN",
	"isFinite",
	"encodeURIComponent",
	"decodeURIComponent",
	"encodeURI",
	"decodeURI",
	"globalThis",
	"structuredClone",
	"setTimeout",
	"setInterval",
	"clearTimeout",
	"clearInterval",
	"queueMicrotask",
	"Buffer",
	"process",
]);

function extractPatternNames(pattern, out) {
	if (!pattern) return;
	switch (pattern.type) {
		case "Identifier":
			out.add(pattern.name);
			break;
		case "ObjectPattern":
			for (const prop of pattern.properties) {
				if (prop.type === "RestElement") extractPatternNames(prop.argument, out);
				else extractPatternNames(prop.value, out);
			}
			break;
		case "ArrayPattern":
			for (const el of pattern.elements) {
				if (el) extractPatternNames(el, out);
			}
			break;
		case "AssignmentPattern":
			extractPatternNames(pattern.left, out);
			break;
		case "RestElement":
			extractPatternNames(pattern.argument, out);
			break;
		default:
			break;
	}
}

// Un scope real, encadenado a su padre — igual que el propio motor de JS:
// mirar "¿está declarado aquí?" sube por la cadena hasta encontrarlo o
// llegar al final (la raíz, con los nombres conocidos: parámetros,
// imports...).
class Scope {
	constructor(parent) {
		this.parent = parent;
		this.names = new Set();
	}
	declare(name) {
		this.names.add(name);
	}
	add(name) {
		// alias — extractPatternNames llama a out.add(...) (se reutiliza
		// igual tanto para un Set plano como para un Scope).
		this.declare(name);
	}
	has(name) {
		for (let s = this; s; s = s.parent) {
			if (s.names.has(name)) return true;
		}
		return false;
	}
}

// "Hoisting" real, pero solo dentro de ESTE bloque: una `var`/`const`
// (siempre `let`/`const` en el código generado) o una `function` nombrada
// declaradas DIRECTAMENTE en esta lista de sentencias (no dentro de un
// `if`/`for` anidado — esas pertenecen a SU PROPIO scope, más profundo)
// quedan visibles en todo el bloque, se usen antes o después en el texto
// — así una función usada antes de "aparecer" más abajo no es un falso
// positivo.
function hoistBlockDeclarations(statements, scope) {
	for (const stmt of statements || []) {
		if (stmt.type === "VariableDeclaration") {
			for (const decl of stmt.declarations) extractPatternNames(decl.id, scope);
		} else if (stmt.type === "FunctionDeclaration" && stmt.id) {
			scope.declare(stmt.id.name);
		} else if (stmt.type === "ClassDeclaration" && stmt.id) {
			scope.declare(stmt.id.name);
		}
	}
}

// Visitors con seguimiento de scope real — el `state` que acorn-walk
// encadena a través de `c(hijo, state)` ES el scope actual; los tipos de
// nodo que abren un scope nuevo (bloque, función, for, catch...) crean un
// `Scope` hijo y siguen la recursión con ESE, en vez del heredado.
function makeVisitors(faltantes) {
	return {
		Identifier(node, scope) {
			if (!scope.has(node.name) && !KNOWN_GLOBALS.has(node.name)) faltantes.add(node.name);
		},
		BlockStatement(node, scope, c) {
			const inner = new Scope(scope);
			hoistBlockDeclarations(node.body, inner);
			for (const stmt of node.body) c(stmt, inner);
		},
		VariableDeclarator(node, scope, c) {
			// El nombre ya se declaró en el hoisting del bloque contenedor
			// (o en la raíz, o en los parámetros) — aquí solo hace falta
			// recorrer su valor inicial, en el MISMO scope (no uno nuevo).
			if (node.init) c(node.init, scope);
		},
		FunctionDeclaration(node, scope, c) {
			// El propio nombre ya se declaró en el hoisting de su bloque
			// contenedor (o es la función raíz que se está analizando).
			const inner = new Scope(scope);
			for (const p of node.params) extractPatternNames(p, inner);
			visitFunctionBody(node.body, inner, c);
		},
		FunctionExpression(node, scope, c) {
			const inner = new Scope(scope);
			if (node.id) inner.declare(node.id.name); // visible dentro de sí misma, para recursión (`function f() { f(); }`)
			for (const p of node.params) extractPatternNames(p, inner);
			visitFunctionBody(node.body, inner, c);
		},
		ArrowFunctionExpression(node, scope, c) {
			const inner = new Scope(scope);
			for (const p of node.params) extractPatternNames(p, inner);
			visitFunctionBody(node.body, inner, c);
		},
		CatchClause(node, scope, c) {
			const inner = new Scope(scope);
			if (node.param) extractPatternNames(node.param, inner);
			c(node.body, inner);
		},
		ForStatement(node, scope, c) {
			const inner = new Scope(scope);
			if (node.init) {
				if (node.init.type === "VariableDeclaration") {
					for (const decl of node.init.declarations) extractPatternNames(decl.id, inner);
					for (const decl of node.init.declarations) if (decl.init) c(decl.init, inner);
				} else {
					c(node.init, inner);
				}
			}
			if (node.test) c(node.test, inner);
			if (node.update) c(node.update, inner);
			c(node.body, inner);
		},
		ForOfStatement(node, scope, c) {
			const inner = new Scope(scope);
			if (node.left.type === "VariableDeclaration") {
				for (const decl of node.left.declarations) extractPatternNames(decl.id, inner);
			} else if (node.left.type === "Identifier") {
				// WebScript no exige let/const en el for-of/for-in (`for (n
				// of lista)`) — la variable del bucle se declara así, no se
				// referencia a una ya existente.
				inner.declare(node.left.name);
			} else {
				c(node.left, inner);
			}
			c(node.right, scope); // el iterable se evalúa en el scope EXTERIOR
			c(node.body, inner);
		},
		ForInStatement(node, scope, c) {
			const inner = new Scope(scope);
			if (node.left.type === "VariableDeclaration") {
				for (const decl of node.left.declarations) extractPatternNames(decl.id, inner);
			} else if (node.left.type === "Identifier") {
				inner.declare(node.left.name);
			} else {
				c(node.left, inner);
			}
			c(node.right, scope);
			c(node.body, inner);
		},
		ClassDeclaration(node, scope, c) {
			// El propio nombre ya se declaró en el hoisting de su bloque
			// contenedor.
			if (node.superClass) c(node.superClass, scope);
			c(node.body, scope);
		},
		ClassExpression(node, scope, c) {
			const inner = node.id ? new Scope(scope) : scope;
			if (node.id) inner.declare(node.id.name);
			if (node.superClass) c(node.superClass, inner);
			c(node.body, inner);
		},
	};
}

// El cuerpo de una función puede ser un BlockStatement (function/arrow
// con llaves) o, para una flecha de una sola expresión, la propia
// expresión — que NO abre un bloque nuevo (sus `const` no tendrían
// dónde vivir), así que se recorre directamente en el scope de la
// función.
function visitFunctionBody(body, scope, c) {
	if (body.type === "BlockStatement") {
		hoistBlockDeclarations(body.body, scope);
		for (const stmt of body.body) c(stmt, scope);
	} else {
		c(body, scope);
	}
}

// Devuelve la lista (sin duplicados) de identificadores usados en
// `bodyText` que no están en `knownNames`, ni declarados dentro del
// scope donde se usan (o uno que lo contenga), ni son globales
// conocidos. Si `bodyText` ni siquiera es JS válido, devuelve null — el
// `SyntaxError` real ya lo dará `new Function()` al compilar, con un
// mensaje más preciso que este análisis.
function findUndeclaredReferences(bodyText, knownNames) {
	let ast;
	try {
		ast = acorn.parse(`(async function() {\n${bodyText}\n})`, { ecmaVersion: "latest", allowReturnOutsideFunction: true });
	} catch {
		return null;
	}

	const root = new Scope(null);
	for (const name of knownNames) root.declare(name);

	const faltantes = new Set();
	walk.recursive(ast, root, makeVisitors(faltantes), walk.base);
	return [...faltantes];
}

module.exports = { findUndeclaredReferences, KNOWN_GLOBALS };
