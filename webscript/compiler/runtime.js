// runtime.js — WebScript, v0
//
// Sistema de reactividad mínimo: sin virtual DOM, sin librería externa.
// `createStore(obj)` envuelve el objeto en un Proxy; `effect(fn)` corre
// `fn` inmediatamente y vuelve a correrla cada vez que cambia una
// propiedad que `fn` leyó durante su última ejecución (tracking automático
// por lectura, como Vue 3 / SolidJS a bajo nivel).
//
// Reactividad profunda: el `get` del Proxy envuelve también los valores
// anidados (objetos, arrays) en su propio Proxy la primera vez que se
// leen — así que mutar `datos.campo` o hacer `.push()` en un array
// anidado también dispara los effects que dependían de ese dato.

let activeEffect = null;
const targetMap = new WeakMap();

function track(target, key) {
	if (!activeEffect) return;
	let deps = targetMap.get(target);
	if (!deps) {
		deps = new Map();
		targetMap.set(target, deps);
	}
	let dep = deps.get(key);
	if (!dep) {
		dep = new Set();
		deps.set(key, dep);
	}
	dep.add(activeEffect);
}

function trigger(target, key) {
	const deps = targetMap.get(target);
	if (!deps) return;
	const dep = deps.get(key);
	if (!dep) return;
	// Copia: un effect puede desuscribirse/re-suscribirse mientras corre
	// (por ejemplo, un if que deja de leer una rama), y mutar el Set
	// mientras se itera daría resultados inconsistentes.
	[...dep].forEach((fn) => fn());
}

function isObject(v) {
	return v !== null && typeof v === "object";
}

const rawToReactive = new WeakMap();

function reactive(obj) {
	if (!isObject(obj)) return obj;
	if (rawToReactive.has(obj)) return rawToReactive.get(obj);

	const proxy = new Proxy(obj, {
		get(target, key, receiver) {
			track(target, key);
			const value = Reflect.get(target, key, receiver);
			return isObject(value) ? reactive(value) : value;
		},
		set(target, key, value, receiver) {
			const result = Reflect.set(target, key, value, receiver);
			trigger(target, key);
			return result;
		},
		deleteProperty(target, key) {
			const result = Reflect.deleteProperty(target, key);
			trigger(target, key);
			return result;
		},
	});

	rawToReactive.set(obj, proxy);
	return proxy;
}

function createStore(initial) {
	return reactive(initial);
}

function effect(fn) {
	const wrapped = () => {
		const previous = activeEffect;
		activeEffect = wrapped;
		try {
			fn();
		} finally {
			activeEffect = previous;
		}
	};
	wrapped();
	return wrapped;
}

// Hidratación: encuentra el comentario de cierre de un bloque if/for
// marcado por el SSR, contando anidamiento (igual que contar paréntesis) —
// necesario porque un if/for puede contener otro if/for como hijo directo,
// y el cierre del interno no debe confundirse con el del externo.
function findBlockEnd(startNode) {
	let depth = 1;
	let node = startNode.nextSibling;
	while (node) {
		if (node.nodeType === 8) {
			if (node.data === "if" || node.data === "for") depth++;
			else if (node.data === "/if" || node.data === "/for") depth--;
			if (depth === 0) return node;
		}
		node = node.nextSibling;
	}
	return null;
}

// Visual.route()/params()/query() — mismo criterio que WSON: API estática,
// instancia como argumento. `route(patron)` compara el patrón contra la
// URL actual del navegador (una vez, al llamarse — no es reactivo: si la
// URL cambia sin recargar la página, hace falta un router aparte que no
// existe todavía, ver limitaciones del codegen).
function compileRoutePatternClient(pattern) {
	const paramNames = [];
	const regexSrc = pattern
		.split("/")
		.map((segment) => {
			if (segment.startsWith(":")) {
				paramNames.push(segment.slice(1));
				return "([^/]+)";
			}
			return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		})
		.join("/");
	return { regex: new RegExp(`^${regexSrc}$`), paramNames };
}

const Visual = {
	route(pattern) {
		const { regex, paramNames } = compileRoutePatternClient(pattern);
		const match = regex.exec(window.location.pathname);
		const params = {};
		if (match) paramNames.forEach((name, i) => { params[name] = match[i + 1]; });
		const query = Object.fromEntries(new URLSearchParams(window.location.search).entries());
		return { pattern, matched: !!match, params, query };
	},
	params(instance) {
		return instance.params;
	},
	query(instance) {
		return instance.query;
	},
};

// WSON en cliente: sin `secret`/`encrypt` (rechazado en compilación, ver
// codegen-client.js) — un `.send()` desde `.wsf` es un `fetch()` normal.
// CSRF lo pone la cookie de sesión + `credentials: "same-origin"`; si hay
// `authorization`, viaja tal cual como cabecera.
const WSON = {
	async send(instance) {
		const headers = { "Content-Type": "application/json" };
		if (instance.authorization) headers["Authorization"] = instance.authorization;

		// Resuelto explícitamente contra la página actual — no depender de
		// que el entorno resuelva rutas relativas por su cuenta.
		const url = new URL(instance.to, location.href).toString();

		const res = await fetch(url, {
			method: instance.via || "POST",
			credentials: "same-origin",
			headers,
			body: JSON.stringify(instance.content ?? {}),
		});

		let body = null;
		try {
			body = await res.json();
		} catch {
			// respuesta sin cuerpo JSON — se deja como null, no es un error
		}
		return { status: res.status, ok: res.ok, body };
	},
};

// El bundle de cliente incrusta este fichero tal cual dentro de un
// <script> — `module` no existe ahí, así que este bloque no se ejecuta en
// el navegador. En Node (tests, generación) sí, para poder importarlo.
if (typeof module !== "undefined") {
	module.exports = { createStore, effect, reactive, Visual, WSON, compileRoutePatternClient, findBlockEnd };
}
