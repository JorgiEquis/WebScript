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
const RAW = Symbol("webscript-raw");

// Misma regla que type-check.js (usado por el compilador en Node para
// DTOs y para el estado inicial) — duplicada aquí a propósito: este
// fichero se incrusta tal cual en el bundle del navegador, que no tiene
// require(), así que no puede importarlo.
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

function typeMismatch(declaredType, value, label) {
	if (!declaredType) return null;
	const arrayMatch = /^(\w+)\(array\)$/.exec(declaredType);
	if (arrayMatch) {
		if (!Array.isArray(value)) return `${label} está declarada como "${declaredType}" pero el valor no es un array`;
		const check = primitiveCheck(arrayMatch[1]);
		if (!check) return null;
		for (let i = 0; i < value.length; i++) {
			if (!check(value[i])) {
				return `${label}[${i}] debe ser ${arrayMatch[1]}, recibido ${typeof value[i]} (${JSON.stringify(value[i])})`;
			}
		}
		return null;
	}
	const check = primitiveCheck(declaredType);
	if (!check) return null;
	if (!check(value)) {
		return `${label} está declarada como "${declaredType}", recibido ${typeof value} (${JSON.stringify(value)})`;
	}
	return null;
}

// push/pop/shift/unshift/splice/sort/reverse desplazan elementos leyendo y
// escribiendo varias veces internamente antes de terminar — si eso pasa a
// través del Proxy, cada paso intermedio dispara los effects con el array
// todavía a medio mover (estado inconsistente). Se ejecutan directamente
// sobre el array crudo (sin pasar por get/set en cada paso) y se notifica
// una única vez, ya con el resultado final.
const ARRAY_MUTATORS = ["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"];

function toRaw(value) {
	if (value === null || typeof value !== "object") return value;
	const raw = value[RAW];
	return raw !== undefined ? raw : value;
}

// `typeSchema` (opcional): mapa nombre -> tipo declarado, SOLO para las
// claves de nivel superior de ESTE objeto (el `state` global) — los
// valores anidados que se envuelven recursivamente (líneas de abajo) no
// llevan tipo, porque el tipado de WebScript es de la variable declarada,
// no de cualquier propiedad interna arbitraria.
function reactive(obj, typeSchema) {
	if (!isObject(obj)) return obj;
	if (rawToReactive.has(obj)) return rawToReactive.get(obj);

	const proxy = new Proxy(obj, {
		get(target, key, receiver) {
			if (key === RAW) return target;

			if (Array.isArray(target) && ARRAY_MUTATORS.includes(key)) {
				return (...args) => {
					const result = Array.prototype[key].apply(target, args.map(toRaw));
					trigger(target, "length"); // una sola notificación, ya con el array terminado de mover
					return result;
				};
			}

			track(target, key);
			const value = Reflect.get(target, key, receiver);
			return isObject(value) ? reactive(value) : value;
		},
		set(target, key, value, receiver) {
			if (typeSchema && typeSchema[key]) {
				const msg = typeMismatch(typeSchema[key], toRaw(value), `"${key}"`);
				if (msg) throw new TypeError(msg);
			}
			// Si el valor que se guarda YA es uno de nuestros proxies (algo
			// habitual cuando un método nativo de array como unshift/splice
			// lee un elemento —ya envuelto por el get de arriba— y lo
			// reescribe en otra posición), se desenvuelve antes de guardar.
			// Si no, el array de respaldo acaba con proxies dentro, que se
			// volverían a envolver en el siguiente acceso — perdiendo la
			// identidad del objeto original en cada desplazamiento.
			const result = Reflect.set(target, key, toRaw(value), receiver);
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

function createStore(initial, typeSchema) {
	if (typeSchema) {
		for (const key of Object.keys(typeSchema)) {
			const msg = typeMismatch(typeSchema[key], initial[key], `"${key}"`);
			if (msg) throw new TypeError(msg);
		}
	}
	return reactive(initial, typeSchema);
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

// Pura comparación de patrón contra un pathname — sin ningún concepto de
// reactividad aquí (eso lo gestiona quien la llama: Visual.route(), más
// abajo, leyendo el estado reactivo `routerState.href`).
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

// Estado reactivo de "URL actual" — Visual.route() lo lee (y por tanto
// queda trackeado, como cualquier otra propiedad reactiva) en vez de leer
// window.location directamente. Así, cualquier effect que dependa de la
// ruta (una interpolación con {id}, un if que mire props.matched...) se
// reevalúa solo cuando la URL cambia, sin recargar la página. Dos formas
// de que cambie: navigate() (programático) o el atrás/adelante del propio
// navegador (popstate).
const routerState = reactive({ href: typeof location !== "undefined" ? location.href : "" });

function navigate(url, opts) {
	const target = new URL(url, routerState.href || "http://localhost/").toString();
	if (opts && opts.replace) {
		history.replaceState(null, "", target);
	} else {
		history.pushState(null, "", target);
	}
	routerState.href = target;
}

if (typeof window !== "undefined") {
	window.addEventListener("popstate", () => {
		routerState.href = location.href;
	});
}

// Intercepta clics en <a href="..."> internos automáticamente — sin esto,
// cualquier enlace normal recargaba la página entera, aunque
// Visual.navigate() ya existiera para hacerlo sin recargar. Respeta los
// casos que NO se deben interceptar (mismos que React Router/Vue Router):
// clic modificado (nueva pestaña/ventana), target distinto de _self,
// download, ancla de la misma página (#section, para el scroll nativo),
// y cualquier enlace que no sea del mismo origen (externo, mailto:, tel:).
if (typeof document !== "undefined") {
	document.addEventListener("click", (event) => {
		if (event.defaultPrevented || event.button !== 0) return;
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

		const anchor = event.target.closest && event.target.closest("a[href]");
		if (!anchor) return;
		if (anchor.target && anchor.target !== "_self") return;
		if (anchor.hasAttribute("download")) return;
		if (anchor.getAttribute("rel") === "external") return;

		const hrefAttr = anchor.getAttribute("href") || "";
		if (hrefAttr.startsWith("#")) return; // ancla de la propia página

		let url;
		try {
			url = new URL(anchor.href, location.href);
		} catch {
			return;
		}
		if (url.origin !== location.origin) return;

		event.preventDefault();
		navigate(url.pathname + url.search + url.hash);
	});
}

const Visual = {
	route(pattern) {
		const url = new URL(routerState.href || "http://localhost/");
		const { regex, paramNames } = compileRoutePatternClient(pattern);
		const match = regex.exec(url.pathname);
		const params = {};
		if (match) paramNames.forEach((name, i) => { params[name] = match[i + 1]; });
		const query = Object.fromEntries(url.searchParams.entries());
		return { pattern, matched: !!match, params, query };
	},
	params(instance) {
		return instance.params;
	},
	query(instance) {
		return instance.query;
	},
	navigate,
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
		const url = new URL(instance.to, location.href);
		const method = (instance.via || "POST").toUpperCase();

		// GET/HEAD no pueden llevar body — es el propio estándar fetch el
		// que lo rechaza (TypeError), no una elección nuestra. Antes se
		// mandaba siempre, así que WSON.send() con via: "GET" no funcionaba
		// en absoluto. El content de un GET se manda como query string.
		const isBodyless = method === "GET" || method === "HEAD";
		if (isBodyless && instance.content && typeof instance.content === "object" && !Array.isArray(instance.content)) {
			for (const [k, v] of Object.entries(instance.content)) url.searchParams.set(k, v);
		}

		const fetchOpts = { method, credentials: "same-origin", headers };
		if (!isBodyless) fetchOpts.body = JSON.stringify(instance.content ?? {});

		const res = await fetch(url.toString(), fetchOpts);

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
	module.exports = {
		createStore,
		effect,
		reactive,
		toRaw,
		Visual,
		WSON,
		compileRoutePatternClient,
		findBlockEnd,
		typeMismatch,
		primitiveCheck,
	};
}
