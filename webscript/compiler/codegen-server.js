// codegen-server.js — WebScript, v0
//
// Convierte el AST de un .wsb en un servidor HTTP real (Node puro, sin
// framework), aplicando WSON.listen()/watch(), CSRF, rate limiting,
// sesiones por visitante (memoria o fichero), y resolviendo `import`
// reales hacia `.wson` (DTOs), `.ws` (funciones/valores compartidos) y
// `.wsb` (funciones/valores, o una ruta completa reexportada).
//
// LIMITACIONES DE ESTA VERSIÓN (deliberadas, no descuidos):
// - Dentro de un `watch()`, las sentencias que no son `WSON.showContent`/
//   `WSON.send`/asignación a `httpCode`/`var`/`const` simples se copian
//   tal cual al JS generado sin comprobar que tengan sentido — es un
//   "mejor esfuerzo", no un intérprete completo de WebScript todavía.

const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { typeMismatch } = require("./type-check");
const WSON = require("./wson-runtime");
const { findUndeclaredReferences } = require("./validate-js-body");
const { resolveImportPath, isPackageSpecifier, resolvePackage } = require("./resolve-imports");
const { buildDtoClass } = require("./codegen-dto");

// --- Resolución de import: .wson -> clase DTO real, .ws -> funciones/valores

function compileFunctionDecl(fnNode) {
	const paramNames = (fnNode.params || []).map((p) => p.name);
	const body = (fnNode.body || []).map(genStatement).join("\n");
	// eslint-disable-next-line no-new-func
	return new Function(...paramNames, body);
}

// Además de las bindings (nombre -> valor/función ya resuelto), un import
// hacia un .wsb puede traer consigo una RUTA completa (WSON + reactive +
// watch) que hay que añadir al AST antes de extraer las rutas — de ahí que
// esta función devuelva también `extraNodes`.
function resolveImports(ast, baseDir, dbBaseDir) {
	const { parse } = require("./parser");
	const bindings = {};
	const extraNodes = [];

	for (const node of ast.body) {
		if (node.type !== "Import") continue;

		if (isPackageSpecifier(node.from)) {
			// Paquete de npm real (o nativo de Node, "path"/"fs"/...) — Node
			// ya sabe resolverlo caminando por node_modules; solo hace
			// falta un require() real, nada propio del lenguaje aquí.
			const resolvedPkgPath = resolvePackage(baseDir, node.from);
			if (!resolvedPkgPath) {
				throw new Error(`No se pudo resolver el paquete "${node.from}" (¿está instalado? buscado desde ${baseDir})`);
			}
			const mod = require(resolvedPkgPath);
			if (node.isDefault) {
				bindings[node.names[0]] = mod;
			} else {
				for (const name of node.names) bindings[name] = mod[name];
			}
			continue;
		}

		const targetPath = resolveImportPath(baseDir, node.from);
		if (!targetPath) {
			throw new Error(`No se pudo resolver el import "${node.from}" (buscado desde ${baseDir})`);
		}

		if (targetPath.endsWith(".js")) {
			// JS normal ya existente (no propio del lenguaje) — vía de
			// adopción incremental: meter WebScript fichero a fichero en un
			// proyecto Node ya existente, sin reescribirlo todo de golpe.
			const mod = require(targetPath);
			if (node.isDefault) {
				bindings[node.names[0]] = mod;
			} else {
				for (const name of node.names) bindings[name] = mod[name];
			}
			continue;
		}

		if (targetPath.endsWith(".wson")) {
			const wsonAst = parse(fs.readFileSync(targetPath, "utf8"), { isWsonFile: true });
			for (const name of node.names) bindings[name] = buildDtoClass(wsonAst, name);
			continue;
		}

		if (targetPath.endsWith(".wsdb")) {
			const { buildWsdbClass } = require("./codegen-wsdb");
			const wsdbAst = parse(fs.readFileSync(targetPath, "utf8"), { isWsdbFile: true });
			// Un solo fichero .db para todo el proyecto (varias colecciones,
			// varias tablas) — igual criterio que ".sessions/": vive junto al
			// proyecto, no junto al código fuente, y no es configurable en
			// esta primera versión (fijo, sencillo).
			const dbPath = path.join(dbBaseDir || baseDir, ".wsdb-data", "webscript.db");
			for (const name of node.names) bindings[name] = buildWsdbClass(wsdbAst, name, dbPath);
			continue;
		}

		if (targetPath.endsWith(".ws")) {
			const wsAst = parse(fs.readFileSync(targetPath, "utf8"));
			const declared = wsAst.body.map((n) => (n.type === "Export" ? n.declaration : n));
			for (const name of node.names) {
				const decl = declared.find((d) => d && d.name === name);
				if (!decl) throw new Error(`"${name}" no está exportado en ${targetPath}`);
				if (decl.type === "FunctionDecl") {
					bindings[name] = compileFunctionDecl(decl);
				} else {
					// eslint-disable-next-line no-new-func
					bindings[name] = new Function(`return (${decl.expr});`)();
				}
			}
			continue;
		}

		if (targetPath.endsWith(".wsb")) {
			const targetBaseDir = path.dirname(targetPath);
			const targetAst = parse(fs.readFileSync(targetPath, "utf8"));
			const declared = targetAst.body.map((n) => (n.type === "Export" ? n.declaration : n));

			for (const name of node.names) {
				const decl = declared.find((d) => d && d.name === name);
				if (!decl) throw new Error(`"${name}" no está exportado en ${targetPath}`);

				if (decl.type === "FunctionDecl") {
					bindings[name] = compileFunctionDecl(decl);
					continue;
				}

				if (decl.type === "ReactiveDecl" || decl.type === "VarDecl" || decl.type === "ConstDecl") {
					// Ruta (WSON.listen()), reactive normal, o un var/const
					// de nivel superior — los tres son estado de sesión real
					// por diseño (no solo las `reactive`), así que los tres
					// se traen como declaración real (no como valor estático
					// evaluado una vez), junto con su watch() SI lo tiene en
					// el fichero origen — es opcional: quien importa puede
					// declarar el suyo propio para ese mismo estado en su
					// lugar. También se trae el estado "hermano" del fichero
					// origen y los watch() de ese estado hermano — mismo
					// criterio que ya se usa para .wsf/.ws: un dato puede
					// depender de otro, o de un watch() que nadie pidió en
					// el import.
					let wsonDecl = null;
					if (decl.type === "ReactiveDecl" && decl.isListen) {
						const m = /^WSON\.listen\((\w+)\)$/.exec(decl.expr);
						if (!m) throw new Error(`"${name}" en ${targetPath} no es una ruta WSON.listen() reconocible`);
						wsonDecl = declared.find((d) => d && d.type === "WsonInlineDecl" && d.name === m[1]);
						if (!wsonDecl) throw new Error(`No se pudo importar la ruta "${name}" de ${targetPath}: falta su WSON`);
					}

					const watchDecl = targetAst.body.find((w) => w.type === "WatchDecl" && w.target === name);

					const targetListenNames = new Set(
						targetAst.body
							.map((n) => (n.type === "Export" ? n.declaration : n))
							.filter((n) => n.type === "ReactiveDecl" && n.isListen)
							.map((n) => n.name)
					);
					const targetWsonNames = new Set(declared.filter((d) => d.type === "WsonInlineDecl").map((d) => d.name));
					const siblingStateDecls = targetAst.body
						.map((n) => (n.type === "Export" ? n.declaration : n))
						.filter(
							(n) =>
								(n.type === "VarDecl" || n.type === "ConstDecl" || n.type === "ReactiveDecl") &&
								n.name !== name &&
								!targetListenNames.has(n.name) &&
								!targetWsonNames.has(n.name)
						);
					// Los watch() de ese estado "hermano" también viajan con él.
					const siblingWatchDecls = siblingStateDecls
						.map((sd) => targetAst.body.find((w) => w.type === "WatchDecl" && w.target === sd.name))
						.filter(Boolean);

					extraNodes.push(
						...siblingStateDecls,
						...siblingWatchDecls,
						...(wsonDecl ? [wsonDecl] : []),
						decl,
						...(watchDecl ? [watchDecl] : [])
					);

					// Lo que ese watch() importado necesite (p. ej. un DTO
					// .wson) se resuelve contra la carpeta del fichero
					// ORIGEN de la ruta, no la de quien la importa.
					const nested = resolveImports(targetAst, targetBaseDir, dbBaseDir);
					Object.assign(bindings, nested.bindings);
					extraNodes.push(...nested.extraNodes);
					continue;
				}
			}
			continue;
		}

		throw new Error(`Import no soportado en el servidor todavía: "${node.from}" (solo .wson, .ws y .wsb)`);
	}

	return { bindings, extraNodes };
}

// --- Sesión por visitante ---------------------------------------------
// var/reactive/const de nivel superior del .wsb (fuera de cualquier WSON
// ad-hoc o del propio `reactive ... = WSON.listen(...)`) son estado por
// SESIÓN — una copia propia por visitante, no compartida entre todos.
// Identificada por la cookie `wsession`, con expiración por inactividad y
// desalojo LRU si se supera el máximo — igual que se decidió en DISEÑO.md.

function extractSessionStateDecls(ast, listeners) {
	const listenNames = new Set(listeners.map((l) => l.reactiveName));
	const unwrapped = ast.body.map((n) => (n.type === "Export" ? n.declaration : n));
	const wsonDeclNames = new Set(unwrapped.filter((n) => n.type === "WsonInlineDecl").map((n) => n.name));

	return unwrapped.filter(
		(n) =>
			(n.type === "VarDecl" || n.type === "ReactiveDecl" || n.type === "ConstDecl") &&
			!listenNames.has(n.name) &&
			!wsonDeclNames.has(n.name)
	);
}

function instantiateSessionState(decls) {
	const state = {};
	for (const d of decls) {
		// eslint-disable-next-line no-new-func
		const value = new Function(`return (${d.expr});`)();
		if (d.varType) {
			const msg = typeMismatch(d.varType, value, `"${d.name}"`);
			if (msg) throw new TypeError(msg);
		}
		state[d.name] = value;
	}
	return state;
}

// El estado de servidor vive en un objeto plano, sin ningún punto por el
// que pase TODA asignación (a diferencia del cliente, donde ese punto es
// el `Proxy` reactivo). Este envoltorio le da al servidor el mismo punto
// de paso para la validación de tipo — pase lo que pase, sin que el
// compilador necesite saber dónde ocurre la asignación.
//
// El disparo de watch() NO vive aquí — un `set()` de Proxy es
// intrínsecamente síncrono (debe devolver un booleano, no una promesa), y
// "Async/await implícito" (DISEÑO.md) exige que el compilador detecte y
// espere lo que haga falta esperar, sin que el usuario escriba `await` —
// eso solo se puede hacer generando un `await __trigger(...)` explícito
// justo después de la asignación en el propio código compilado (ver
// injectAsyncTriggers), no escondido dentro de un trap síncrono.
function wrapReactiveState(state, typeSchema) {
	if (!typeSchema || Object.keys(typeSchema).length === 0) return state;
	return new Proxy(state, {
		set(target, key, value, receiver) {
			if (typeSchema[key]) {
				const msg = typeMismatch(typeSchema[key], value, `"${key}"`);
				if (msg) throw new TypeError(msg);
			}
			return Reflect.set(target, key, value, receiver);
		},
	});
}

// Tras substituteServerState, una asignación a una reactive con watch()
// propio (`serverState.activo = ...`, `serverState.activo++`, etc.) se
// completa con un `await __trigger("activo")` justo después — así el
// watch() en cascada SIEMPRE se espera de verdad (nada de
// fire-and-forget), sin que el usuario escriba `await` en ningún sitio:
// exactamente lo que pide "Async/await implícito". Se opera línea a línea
// porque genStatement ya emite una sentencia por línea (incluidos los
// bloques for/while, con sus hijos en líneas propias).
function injectAsyncTriggers(bodyText, watchTargetNames) {
	if (!watchTargetNames || watchTargetNames.size === 0) return bodyText;
	const assignmentRes = [...watchTargetNames].map(
		(name) => new RegExp(`^\\s*serverState\\.${name}\\s*(=(?!=)|\\+\\+|--|[-+*/%&|^]=|\\*\\*=|&&=|\\|\\|=|\\?\\?=)`)
	);
	const names = [...watchTargetNames];
	const lines = bodyText.split("\n");
	const out = [];
	for (const line of lines) {
		out.push(line);
		for (let i = 0; i < assignmentRes.length; i++) {
			if (assignmentRes[i].test(line)) {
				out.push(`await __trigger(${JSON.stringify(names[i])});`);
			}
		}
	}
	return out.join("\n");
}

function parseCookies(header) {
	const cookies = {};
	for (const part of (header || "").split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
	}
	return cookies;
}

function isRequestSecure(req) {
	if (req.socket && req.socket.encrypted) return true;
	return req.headers["x-forwarded-proto"] === "https";
}

// Bloqueo de fichero real: creación atómica con la flag "wx" (falla si el
// fichero ya existe) — es una primitiva del propio sistema de ficheros,
// así que protege incluso entre PROCESOS distintos, no solo dentro de uno
// (relevante si algún día se usa `cluster-workers`). Con reintento
// asíncrono (no bloquea el bucle de eventos mientras espera) y detección
// de lock abandonado (si el proceso que lo dejó murió sin liberarlo).
async function acquireFileLock(lockPath, { staleMs = 5000, retryDelayMs = 20, timeoutMs = 5000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
			return;
		} catch (err) {
			if (err.code !== "EEXIST") throw err;
			try {
				const stat = fs.statSync(lockPath);
				if (Date.now() - stat.mtimeMs > staleMs) {
					fs.unlinkSync(lockPath); // se asume abandonado (el proceso que lo tenía murió) — se fuerza
					continue;
				}
			} catch {
				continue; // ha desaparecido justo ahora (otro lo liberó) — reintenta ya
			}
			if (Date.now() > deadline) {
				throw new Error(`No se pudo adquirir el lock de sesión ("${lockPath}") tras ${timeoutMs}ms`);
			}
			await new Promise((r) => setTimeout(r, retryDelayMs));
		}
	}
}

function releaseFileLock(lockPath) {
	try {
		fs.unlinkSync(lockPath);
	} catch {
		// ya no existía (liberado dos veces, o expiró y otro lo cogió) — no pasa nada
	}
}

function createMemorySessionStore(decls, wconfig) {
	const sessions = new Map(); // id -> { state, csrfToken, lastAccess, seq }
	const timeoutMs = wconfig["session-timeout-ms"] ?? 30 * 60 * 1000;
	const maxSessions = wconfig["session-max"] ?? 10000;
	let seqCounter = 0; // para desempatar LRU sin depender de la resolución de Date.now()

	function evictExpired() {
		const now = Date.now();
		for (const [id, s] of sessions) {
			if (now - s.lastAccess > timeoutMs) sessions.delete(id);
		}
	}

	function evictLRUIfFull() {
		if (sessions.size < maxSessions) return;
		let oldestId = null;
		let oldestSeq = Infinity;
		for (const [id, s] of sessions) {
			if (s.seq < oldestSeq) {
				oldestSeq = s.seq;
				oldestId = id;
			}
		}
		if (oldestId) sessions.delete(oldestId);
	}

	return {
		get(id) {
			const s = sessions.get(id);
			if (!s) return null;
			if (Date.now() - s.lastAccess > timeoutMs) {
				sessions.delete(id);
				return null;
			}
			s.lastAccess = Date.now();
			s.seq = seqCounter++;
			return s;
		},
		create() {
			evictExpired();
			evictLRUIfFull();
			const id = crypto.randomUUID();
			const session = {
				state: instantiateSessionState(decls),
				csrfToken: crypto.randomBytes(16).toString("hex"),
				lastAccess: Date.now(),
				seq: seqCounter++,
			};
			sessions.set(id, session);
			return { id, session };
		},
		// El estado se muta in-place (misma referencia guardada en el Map),
		// así que ya está "guardado" — save() no tiene nada que hacer aquí.
		save() {},
		// Mutación in-place sobre el mismo objeto del Map — no hay "escribir
		// a disco" que perder entre peticiones concurrentes, así que no
		// hace falta bloqueo aquí (ver cabecera del fichero de test).
		async lock() {
			return () => {};
		},
		size() {
			return sessions.size;
		},
	};
}

// Sesiones persistidas en disco: un .json por sesión. A diferencia de la
// versión en memoria, `get()` devuelve un objeto NUEVO leído del fichero
// cada vez — mutar `session.state` en el handler no se guarda solo, hace
// falta llamar a `save()` después (lo hace createRequestHandler tras cada
// petición, sea cual sea el backend, sin necesitar saber cuál está activo).
//
// LIMITACIÓN real: sin bloqueo de fichero — dos peticiones concurrentes
// para la MISMA sesión pueden pisarse (lectura-modificación-escritura sin
// atomicidad). Aceptable para un solo proceso con tráfico moderado; no es
// una base de datos.
function createFileSessionStore(decls, wconfig, baseDir) {
	const dir = path.resolve(baseDir || ".", wconfig["session-dir"] || ".sessions");
	fs.mkdirSync(dir, { recursive: true });

	const timeoutMs = wconfig["session-timeout-ms"] ?? 30 * 60 * 1000;
	const maxSessions = wconfig["session-max"] ?? 10000;

	// Arranca desde el máximo seq ya usado en disco (si el proceso se
	// reinició, las sesiones existentes ya tienen seq propios) — si no, un
	// reinicio haría que las sesiones nuevas parecieran más "antiguas" que
	// las de antes del reinicio a efectos de desalojo LRU.
	let seqCounter = 0;
	for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
		try {
			const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
			if (typeof data.seq === "number" && data.seq >= seqCounter) seqCounter = data.seq + 1;
		} catch {
			// fichero corrupto/ilegible: se ignora a efectos de arrancar el contador
		}
	}

	// Los ids son UUID (crypto.randomUUID) — se valida el formato antes de
	// construir una ruta de fichero con un valor que viene de una cookie.
	const ID_RE = /^[0-9a-f-]{36}$/i;

	function filePath(id) {
		return path.join(dir, `${id}.json`);
	}

	function readSession(id) {
		try {
			return JSON.parse(fs.readFileSync(filePath(id), "utf8"));
		} catch {
			return null;
		}
	}

	function writeSession(id, session) {
		const data = { state: session.state, csrfToken: session.csrfToken, lastAccess: session.lastAccess, seq: session.seq };
		fs.writeFileSync(filePath(id), JSON.stringify(data));
	}

	function listSessionFiles() {
		try {
			return fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
		} catch {
			return [];
		}
	}

	function evictExpiredAndLRUIfFull() {
		const now = Date.now();
		const entries = [];
		for (const file of listSessionFiles()) {
			const full = path.join(dir, file);
			let data;
			try {
				data = JSON.parse(fs.readFileSync(full, "utf8"));
			} catch {
				continue; // fichero corrupto/ilegible: se ignora, no se borra a ciegas
			}
			if (now - data.lastAccess > timeoutMs) {
				fs.unlinkSync(full);
				continue;
			}
			entries.push({ file: full, seq: data.seq ?? 0 });
		}
		if (entries.length >= maxSessions) {
			entries.sort((a, b) => a.seq - b.seq);
			entries.slice(0, entries.length - maxSessions + 1).forEach((e) => fs.unlinkSync(e.file));
		}
	}

	return {
		get(id) {
			if (!ID_RE.test(id)) return null;
			const data = readSession(id);
			if (!data) return null;
			if (Date.now() - data.lastAccess > timeoutMs) {
				try {
					fs.unlinkSync(filePath(id));
				} catch {
					// ya no existía, no pasa nada
				}
				return null;
			}
			data.lastAccess = Date.now();
			data.seq = seqCounter++;
			writeSession(id, data);
			return data;
		},
		create() {
			evictExpiredAndLRUIfFull();
			const id = crypto.randomUUID();
			const session = {
				state: instantiateSessionState(decls),
				csrfToken: crypto.randomBytes(16).toString("hex"),
				lastAccess: Date.now(),
				seq: seqCounter++,
			};
			writeSession(id, session);
			return { id, session };
		},
		save(id, session) {
			if (ID_RE.test(id)) writeSession(id, session);
		},
		// Protege el ciclo lectura-modificación-escritura de UNA sesión
		// frente a otra petición concurrente para la MISMA sesión — sin
		// esto, la segunda en guardar pisa el incremento de la primera.
		// Sin `id` (visitante sin cookie todavía, sesión por crear) no hay
		// nada que proteger — cada uno tendrá su propio UUID nuevo.
		async lock(id) {
			if (!id || !ID_RE.test(id)) return () => {};
			const lockPath = path.join(dir, `${id}.lock`);
			await acquireFileLock(lockPath, {
				staleMs: wconfig["session-lock-stale-ms"] ?? 5000,
				retryDelayMs: wconfig["session-lock-retry-ms"] ?? 20,
				timeoutMs: wconfig["session-lock-timeout-ms"] ?? 5000,
			});
			let released = false;
			return () => {
				if (released) return; // liberar dos veces sería liberar el lock de otro que lo haya cogido después
				released = true;
				releaseFileLock(lockPath);
			};
		},
		size() {
			return listSessionFiles().length;
		},
	};
}

// Sesiones en Redis: la única opción de las tres que sirve de verdad para
// compartir sesiones entre PROCESOS EN MÁQUINAS DISTINTAS (el backend de
// fichero solo protege dentro del mismo filesystem). `require("redis")` es
// diferido — quien no configure `"session-store": "redis"` no necesita
// tenerlo instalado en absoluto (es una dependencia opcional del paquete).
//
// LIMITACIÓN real: el lock usa `SET NX PX` sobre una única instancia de
// Redis — es el mismo patrón de base que Redlock, pero sin la variante
// multi-nodo (quorum entre varias instancias). Para una sola instancia de
// Redis (el caso normal) es correcto; para tolerar la caída de la propia
// instancia de Redis en medio de un lock, haría falta Redlock de verdad.
function createRedisSessionStore(decls, wconfig) {
	let redisModule;
	try {
		// eslint-disable-next-line global-require
		redisModule = require("redis");
	} catch {
		throw new Error(
			'"session-store": "redis" requiere el paquete opcional "redis" instalado — ejecuta `npm install redis` en el proyecto.'
		);
	}

	const client = redisModule.createClient({
		url: wconfig["redis-url"] || "redis://localhost:6379",
		socket: {
			connectTimeout: wconfig["redis-connect-timeout-ms"] ?? 3000,
			// Por defecto, node-redis reintenta conectar indefinidamente — si
			// Redis está caído de verdad, eso dejaría cualquier petición
			// colgada para siempre en vez de fallar con un error claro. Unos
			// pocos reintentos con backoff, y luego se rinde de verdad.
			reconnectStrategy: (retries) => (retries > 3 ? false : Math.min(retries * 100, 1000)),
		},
	});
	client.on("error", () => {}); // el propio uso (get/set) ya propaga el error a quien lo llame; evita que un error de conexión tumbe el proceso como "uncaught"

	let connectPromise = null;
	async function ensureConnected() {
		if (!connectPromise) connectPromise = client.connect();
		await connectPromise;
	}

	const timeoutMs = wconfig["session-timeout-ms"] ?? 30 * 60 * 1000;
	const keyFor = (id) => `websc:session:${id}`;
	const lockKeyFor = (id) => `websc:lock:${id}`;
	const ID_RE = /^[0-9a-f-]{36}$/i;

	return {
		async get(id) {
			if (!id || !ID_RE.test(id)) return null;
			await ensureConnected();
			const raw = await client.get(keyFor(id));
			if (!raw) return null;
			const data = JSON.parse(raw);
			data.lastAccess = Date.now();
			await client.set(keyFor(id), JSON.stringify(data), { PX: timeoutMs }); // refresca el TTL (expiración por inactividad, gestionada por el propio Redis)
			return data;
		},
		async create() {
			await ensureConnected();
			const id = crypto.randomUUID();
			const session = {
				state: instantiateSessionState(decls),
				csrfToken: crypto.randomBytes(16).toString("hex"),
				lastAccess: Date.now(),
			};
			await client.set(keyFor(id), JSON.stringify(session), { PX: timeoutMs });
			return { id, session };
		},
		async save(id, session) {
			if (!ID_RE.test(id)) return;
			await ensureConnected();
			await client.set(keyFor(id), JSON.stringify(session), { PX: timeoutMs });
		},
		// SET NX PX: igual que el "wx" del backend de fichero, pero atómico
		// a través de la red — sirve entre procesos en máquinas distintas.
		async lock(id) {
			if (!id || !ID_RE.test(id)) return () => {};
			await ensureConnected();
			const lockKey = lockKeyFor(id);
			const token = crypto.randomBytes(8).toString("hex");
			const staleMs = wconfig["session-lock-stale-ms"] ?? 5000;
			const timeoutMsLock = wconfig["session-lock-timeout-ms"] ?? 5000;
			const retryDelayMs = wconfig["session-lock-retry-ms"] ?? 20;
			const deadline = Date.now() + timeoutMsLock;

			for (;;) {
				const acquired = await client.set(lockKey, token, { NX: true, PX: staleMs });
				if (acquired) break;
				if (Date.now() > deadline) {
					throw new Error(`No se pudo adquirir el lock de sesión en Redis ("${lockKey}") tras ${timeoutMsLock}ms`);
				}
				await new Promise((r) => setTimeout(r, retryDelayMs));
			}

			let released = false;
			return async () => {
				if (released) return;
				released = true;
				// Solo borra el lock si sigue siendo el NUESTRO (evita borrar
				// el de otro proceso que lo haya adquirido tras expirar PX).
				const current = await client.get(lockKey);
				if (current === token) await client.del(lockKey);
			};
		},
		async size() {
			await ensureConnected();
			const keys = await client.keys("websc:session:*");
			return keys.length;
		},
		async close() {
			if (connectPromise) await client.quit();
		},
	};
}

// wconfig["session-store"]: "memory" (por defecto), "file", o "redis" (la
// única de las tres que sirve entre máquinas distintas — "file" solo
// protege dentro del mismo filesystem). "session-dir" (solo "file") y
// "redis-url" (solo "redis", por defecto "redis://localhost:6379").
function createSessionStore(decls, wconfig, baseDir) {
	if (wconfig["session-store"] === "file") {
		return createFileSessionStore(decls, wconfig, baseDir);
	}
	if (wconfig["session-store"] === "redis") {
		return createRedisSessionStore(decls, wconfig);
	}
	return createMemorySessionStore(decls, wconfig);
}

function substituteServerState(code, names) {
	let out = code;
	for (const name of names) {
		// No sustituir si es una CLAVE de objeto literal ({ nombre: ... } o
		// , nombre: ...) — solo el valor debe convertirse en
		// serverState.nombre, la clave se queda tal cual. El espacio antes
		// de la clave es SOLO en la misma línea ([ \t], no \s) — un salto
		// de línea antes no cuenta, si no un `{` de apertura de bloque
		// (for/if en la línea anterior) se confundiría con el de un objeto
		// literal y dejaría sin sustituir la primera sentencia del cuerpo.
		const re = new RegExp(`(?<![.\\w])(?<![{,][ \\t]{0,20})\\b${name}\\b(?![ \\t]{0,20}:)`, "g");
		out = out.replace(re, `serverState.${name}`);
	}
	return out;
}

// --- Extraer los WSON.listen() declarados en el .wsb --------------------

function metaValue(fields, key) {
	const f = fields.find((x) => x.type === "MetaField" && x.key === key);
	return f ? f.value.replace(/^["']|["']$/g, "") : null;
}

function extractListeners(ast) {
	// `export` no debe ocultar la declaración dentro de su propio fichero
	// (igual que en JS: exportar algo no le impide seguir funcionando
	// localmente) — se desenvuelve antes de buscar WSON.listen()/WSON.
	const unwrapped = ast.body.map((n) => (n.type === "Export" ? n.declaration : n));

	const wsonDecls = {}; // nombre -> { to, via, secret, encrypt }
	for (const node of unwrapped) {
		if (node.type === "WsonInlineDecl") {
			wsonDecls[node.name] = {
				to: metaValue(node.body, "to"),
				via: (metaValue(node.body, "via") || "POST").toUpperCase(),
				secret: metaValue(node.body, "secret"),
				encrypt: metaValue(node.body, "encrypt") === "true",
			};
		}
	}

	const listeners = [];
	for (const node of unwrapped) {
		if (node.type === "ReactiveDecl" && node.isListen) {
			const m = /^WSON\.listen\((\w+)\)$/.exec(node.expr);
			if (!m || !wsonDecls[m[1]]) continue;
			const watchNode = ast.body.find((w) => w.type === "WatchDecl" && w.target === node.name);
			listeners.push({ reactiveName: node.name, wson: wsonDecls[m[1]], watch: watchNode });
		}
	}
	return listeners;
}

// `watch()` sirve para cualquier reactive (string, boolean, DTO, array...),
// no solo para las atadas a `WSON.listen()` — esas siguen su propio camino
// (una petición HTTP real que encaja con la ruta), pero cualquier OTRA
// asignación a una reactive con su propio `watch()` también lo dispara,
// dentro de la misma petición que la causó (ver wrapReactiveState).
function extractPlainWatches(ast, listenerReactiveNames) {
	const listenSet = new Set(listenerReactiveNames);
	const seen = new Set();
	const watches = [];
	for (const node of ast.body) {
		if (node.type !== "WatchDecl") continue;
		if (listenSet.has(node.target)) continue; // esos ya los cubre extractListeners
		if (seen.has(node.target)) {
			throw new Error(
				`Colisión de watch(): "${node.target}" tiene más de un watch() declarado (revisa los imports entre .wsb)`
			);
		}
		seen.add(node.target);
		watches.push(node);
	}
	return watches;
}

// --- Colisión de rutas: normaliza :param a un comodín --------------------

function normalizeRoute(to) {
	return to.replace(/:[^/]+/g, ":param");
}

function validateNoCollisions(listeners) {
	const seen = new Map();
	for (const l of listeners) {
		const key = `${l.wson.via} ${normalizeRoute(l.wson.to)}`;
		if (seen.has(key)) {
			throw new Error(
				`Colisión de rutas: "${l.wson.via} ${l.wson.to}" ya está cubierta por otro WSON.listen() en la misma ruta (normalizada: ${key})`
			);
		}
		seen.set(key, l);
	}
}

// --- Matching de ruta con :param -----------------------------------------

function compileRoutePattern(to) {
	const paramNames = [];
	const regexSrc = to
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

// --- Traducir el cuerpo de un watch() a JS real --------------------------
// Reutiliza los nodos ya parseados (VarDecl/ConstDecl con `expr` en texto
// casi-JS, y Raw para el resto) — la mayoría de sentencias de un `.wsb` ya
// SON JS válido dado que la API de WSON es estática (WSON.send(x), no
// x.send()), así que se emiten casi literalmente.
// Si WSON.send(...) es la ÚLTIMA sentencia de una rama (el caso normal —
// incluso dentro de if/else), se compila como `return WSON.send(...)` en
// vez de una llamada suelta: así quien invoca al handler puede esperar de
// verdad a que termine (relevante para un guardado de sesión asíncrono,
// como Redis) antes de responder o soltar el bloqueo de la sesión.
function genStatement(node) {
	if (node.type === "VarDecl" || node.type === "ConstDecl") {
		return `${node.type === "ConstDecl" ? "const" : "let"} ${node.name} = ${node.expr};`;
	}
	if (node.type === "Raw") {
		if (node.children && node.children.length > 0) {
			// Construcción con cuerpo anidado que el parser no reconoce como
			// nodo propio (for/while/similar) — el parser SÍ conserva sus
			// hijos indentados, pero antes se ignoraban aquí: la cabecera se
			// emitía sola y el cuerpo desaparecía en silencio (sin error,
			// sin efecto — un `for` que acumulaba algo simplemente no
			// acumulaba nada). Se envuelve como bloque real.
			const inner = node.children.map(genStatement).join("\n");
			return `${node.text} {\n${inner}\n}`;
		}
		return `${node.text};`;
	}
	if (node.type === "If" || node.type === "ElseIf") {
		return `${node.type === "If" ? "if" : "else if"} (${node.cond}) {\n${(node.body || []).map(genStatement).join("\n")}\n}`;
	}
	if (node.type === "Else") {
		return `else {\n${(node.body || []).map(genStatement).join("\n")}\n}`;
	}
	return `// TODO codegen-server: sentencia no reconocida (${node.type})`;
}

// "Async/await implícito" (DISEÑO.md): `WSON.send()` es la única llamada
// de la API estática de WSON que representa "espera esto" de verdad — a
// diferencia de `WSON.enqueue()`, que es fire-and-forget A PROPÓSITO, por
// diseño (esperar sus reintentos con backoff dentro de la misma petición
// sería contraproducente, no un descuido). Se espera en CUALQUIER
// posición del cuerpo, no solo si es la última sentencia — antes, un
// `WSON.send()` que no fuera la última línea se disparaba y se
// olvidaba, exactamente el mismo problema que ya se corrigió para la
// cascada de watch().
function injectSendAwait(bodyText) {
	return bodyText.replace(/(?<!await\s)\bWSON\.send\(/g, "await WSON.send(");
}

function genHandlerBody(watchNode, stateNames) {
	if (!watchNode) return "";
	// Dentro del handler, `peticion` (alias del nombre de la reactive) es
	// la instancia ya recibida — showContent/params/query actúan sobre ese
	// mismo objeto, coherente con la API estática de WSON.
	const raw = (watchNode.body || []).map(genStatement).join("\n");
	return injectSendAwait(substituteServerState(raw, stateNames));
}

// Compila un cuerpo de watch() a una función real — antes de hacerlo,
// comprueba con un parser JS real (no regex) que no haya referencias a
// nombres sin declarar (típicamente una variable de servidor mal escrita:
// substituteServerState ya convirtió las que SÍ existen en
// `serverState.nombre`, así que lo que quede suelto y no encaje con nada
// conocido es, casi con toda seguridad, un error tipográfico). Sin esto,
// ese error solo se vería como un ReferenceError en tiempo de ejecución,
// en la primera petición real que llegara a ejecutar esa línea.
// Toda función de watch() se compila como async — "Async/await implícito"
// (DISEÑO.md) dice que nunca hace falta escribirlo, y la forma de
// garantizarlo sin tener que demostrar caso por caso qué watch() concreto
// termina llamando a algo asíncrono es compilarlas todas así: un `await`
// dentro de una función normal sin trabajo async real no cambia su
// resultado, solo añade un microtask — precio aceptable por no tener que
// arriesgarse a que un caso raro (una llamada indirecta a través de una
// función importada, por ejemplo) se escape del análisis y vuelva a caer
// en fire-and-forget. `new Function()` no puede crear funciones async
// directamente — se usa el constructor de AsyncFunction, la técnica
// estándar para esto.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function compileWatchFunction(paramNames, bodyText, label) {
	// eslint-disable-next-line no-new-func
	const faltantes = findUndeclaredReferences(bodyText, [...paramNames, "__trigger"]);
	if (faltantes && faltantes.length > 0) {
		const lista = faltantes.map((n) => `"${n}"`).join(", ");
		throw new Error(
			`En ${label}: ${lista} no está${faltantes.length > 1 ? "n" : ""} declarada${faltantes.length > 1 ? "s" : ""} ni importada${faltantes.length > 1 ? "s" : ""}, ni ${faltantes.length > 1 ? "son globales" : "es un global"} conocido${faltantes.length > 1 ? "s" : ""} — revisa si hay un error tipográfico`
		);
	}
	return new AsyncFunction(...paramNames, "__trigger", bodyText);
}

// --- El servidor en sí -----------------------------------------------------

function timingSafeEqualStr(a, b) {
	const bufA = Buffer.from(String(a));
	const bufB = Buffer.from(String(b));
	if (bufA.length !== bufB.length) return false;
	return crypto.timingSafeEqual(bufA, bufB);
}

function createRequestHandler(ast, wconfig = {}, { baseDir, sessionBaseDir } = {}) {
	// Import hacia .wsb puede traer consigo una ruta completa (WSON +
	// reactive + watch) — se empalma en el AST ANTES de extraer las rutas,
	// para que se sirva exactamente igual que si se hubiera escrito aquí.
	const { bindings: importBindings, extraNodes } = baseDir
		? resolveImports(ast, baseDir, sessionBaseDir)
		: { bindings: {}, extraNodes: [] };
	const expandedAst = extraNodes.length > 0 ? { ...ast, body: [...ast.body, ...extraNodes] } : ast;

	const listeners = extractListeners(expandedAst);
	validateNoCollisions(listeners);

	const importNames = Object.keys(importBindings);
	const importValues = importNames.map((n) => importBindings[n]);

	const sessionDecls = extractSessionStateDecls(expandedAst, listeners);
	{
		const seen = new Set();
		for (const d of sessionDecls) {
			if (seen.has(d.name)) {
				throw new Error(
					`Colisión de estado de servidor: "${d.name}" está declarado más de una vez (revisa los imports de rutas entre .wsb — puede que dos ficheros distintos declaren una var/reactive con el mismo nombre)`
				);
			}
			seen.add(d.name);
		}
	}
	const stateNames = sessionDecls.map((d) => d.name);
	const sessionTypeSchema = {};
	for (const d of sessionDecls) {
		if (d.varType) sessionTypeSchema[d.name] = d.varType;
	}
	const sessionStore = createSessionStore(sessionDecls, wconfig, sessionBaseDir || baseDir);

	// `watch()` sobre cualquier reactive que no sea WSON.listen() (string,
	// boolean, DTO, array...) — se compilan una vez aquí (igual mecanismo
	// que el handler de una ruta), y se invocan cuando se les asigna un
	// valor nuevo (ver __trigger, más abajo), no por ninguna petición HTTP
	// en concreto.
	const plainWatches = extractPlainWatches(
		expandedAst,
		listeners.map((l) => l.reactiveName)
	);
	// Todo nombre que tiene su propio watch() (ruta o reactive normal) —
	// una asignación a cualquiera de ellos, en el cuerpo de CUALQUIER
	// watch(), lleva su `await __trigger(...)` inyectado automáticamente.
	const allWatchedNames = new Set([...listeners.map((l) => l.reactiveName), ...plainWatches.map((w) => w.target)]);

	const compiledPlainWatches = plainWatches.map((w) => ({
		target: w.target,
		fn: compileWatchFunction(
			[reactiveArgName(w.target), "WSON", "serverState", ...importNames],
			injectAsyncTriggers(genHandlerBody(w, stateNames), allWatchedNames),
			`watch(${w.target})`
		),
	}));

	const compiled = listeners.map((l) => ({
		...l,
		pattern: compileRoutePattern(l.wson.to),
		// Compilada aquí, una sola vez al crear el servidor, no en cada
		// petición que encaje con esta ruta — antes se recompilaba el
		// mismo texto una y otra vez (trabajo repetido de balde), y un
		// error de sintaxis en el watch() de esta ruta quedaba escondido
		// hasta que llegara la primera petición real, en vez de saltar al
		// arrancar el servidor.
		handlerFn: compileWatchFunction(
			[reactiveArgName(l.reactiveName), "WSON", "serverState", ...importNames],
			injectAsyncTriggers(genHandlerBody(l.watch, stateNames), allWatchedNames),
			`watch(${l.reactiveName})`
		),
	}));

	const rateLimitMax = wconfig["rate-limit-max"] ?? 300;
	const rateLimitWindowMs = wconfig["rate-limit-window-ms"] ?? 60000;
	const rateBuckets = new Map(); // ip -> { count, windowStart }

	function checkRateLimit(ip) {
		if (!rateLimitMax) return true; // 0 = desactivado
		const now = Date.now();
		let bucket = rateBuckets.get(ip);
		if (!bucket || now - bucket.windowStart > rateLimitWindowMs) {
			bucket = { count: 0, windowStart: now };
			rateBuckets.set(ip, bucket);
		}
		bucket.count += 1;
		return bucket.count <= rateLimitMax;
	}

	// La primera petición de una sesión completamente nueva no exige el
	// token — una sesión recién creada no es algo que un atacante pueda
	// secuestrar. En cualquier petición posterior, el header debe coincidir
	// con el token real guardado en la sesión (no solo cookie == header,
	// que sería más débil).
	function checkCsrf(isNewSession, session, req) {
		if (isNewSession) return true;
		const headerToken = req.headers["x-webscript-csrf"];
		if (!headerToken || !session) return false;
		return timingSafeEqualStr(headerToken, session.csrfToken);
	}

	function readRequestBody(req) {
		return new Promise((resolve) => {
			let body = "";
			req.on("data", (chunk) => (body += chunk));
			req.on("end", () => resolve(body));
		});
	}

	const requestHandler = async (req, res) => {
		const ip = req.socket.remoteAddress || "unknown";

		if (!checkRateLimit(ip)) {
			res.writeHead(429, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "rate limit excedido" }));
			return;
		}

		const url = new URL(req.url, `http://${req.headers.host}`);
		const via = req.method.toUpperCase();

		const match = compiled.find((c) => c.wson.via === via && c.pattern.regex.test(url.pathname));
		if (!match) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "no encontrado" }));
			return;
		}

		// Sesión: se resuelve para TODAS las peticiones (no solo las que
		// escriben), porque hasta un GET puede querer leer/actualizar su
		// propio estado de sesión.
		//
		// El bloqueo se adquiere ANTES de leer la sesión y se libera solo
		// al terminar del todo (tras guardar) — así ninguna otra petición
		// para la MISMA sesión puede leer un estado a medio actualizar ni
		// pisar el guardado de esta. Sin cookie todavía (visitante nuevo)
		// no hay nada que bloquear: cada quien tendrá su propio UUID nuevo.
		const cookies = parseCookies(req.headers.cookie);
		const initialSessionId = cookies.wsession;

		let releaseLock;
		try {
			releaseLock = await sessionStore.lock(initialSessionId);
		} catch (err) {
			res.writeHead(503, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "no se pudo adquirir el bloqueo de sesión" }));
			return;
		}

		try {
			let sessionId = initialSessionId;
			let session = sessionId ? await sessionStore.get(sessionId) : null;
			let isNewSession = false;
			if (!session) {
				const created = await sessionStore.create();
				sessionId = created.id;
				session = created.session;
				isNewSession = true;
			}

			if (isNewSession) {
				const secureAttr = isRequestSecure(req) ? "; Secure" : "";
				res.setHeader("Set-Cookie", [
					`wsession=${sessionId}; HttpOnly; SameSite=Lax; Path=/${secureAttr}`,
					// Sin HttpOnly: el patrón de doble envío necesita que el cliente
					// pueda leerlo para devolverlo en la cabecera X-WebScript-CSRF.
					`wcsrf=${session.csrfToken}; SameSite=Lax; Path=/${secureAttr}`,
				]);
			}

			if (["POST", "PUT", "DELETE"].includes(via) && !checkCsrf(isNewSession, session, req)) {
				res.writeHead(403, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "CSRF inválido" }));
				return;
			}

			const body = await readRequestBody(req);

			const paramValues = match.pattern.regex.exec(url.pathname).slice(1);
			const params = Object.fromEntries(match.pattern.paramNames.map((n, i) => [n, paramValues[i]]));
			const query = Object.fromEntries(url.searchParams.entries());

			const parsed = { content: body, from: req.headers["x-wson-from"] || null, id: req.headers["x-wson-correlation-id"] || null };
			const signatureValid = match.wson.secret
				? WSON.verify(body, WSON.getSignature(req.headers), match.wson.secret, WSON.getTimestamp(req.headers))
				: null;

			// Objeto "petición": lo que dentro del watch() se referencia con
			// el nombre de la reactive — trae httpCode mutable y los métodos
			// WSON.* actúan sobre este mismo objeto.
			const peticion = {
				to: match.wson.to,
				via: match.wson.via,
				content: parsed.content,
				from: parsed.from,
				id: parsed.id,
				signatureValid,
				httpCode: null,
				_params: params,
				_query: query,
				_secret: match.wson.secret,
				_encrypt: match.wson.encrypt,
				_sent: false,
			};

			// `WSON.params`/`WSON.query`/`WSON.showContent`/`WSON.send` dentro
			// del handler generado necesitan resolver sobre `peticion` — se
			// exponen aquí como funciones de ámbito local con esos nombres
			// fijos, ya que el handler generado los llama tal cual.
			const localWSON = {
				...WSON,
				params: (inst) => inst._params,
				query: (inst) => inst._query,
				showContent: (inst, secretoExplicito) => {
					if (!inst._encrypt) {
						// Sin `encrypt: true`, el content viaja en claro (el
						// secret, si lo hay, solo firma) — no hay nada que
						// descifrar, solo parsear el JSON tal cual llegó.
						try {
							return JSON.parse(inst.content);
						} catch {
							return inst.content;
						}
					}
					const secreto = secretoExplicito || inst._secret;
					const decrypted = WSON.showContent(inst.content, secreto);
					if (decrypted === null) return null;
					try {
						return JSON.parse(decrypted);
					} catch {
						return decrypted;
					}
				},
				send: async (inst) => {
					inst._sent = true;
					await sessionStore.save(sessionId, session); // antes de responder: si el proceso muere justo después (o el guardado es a través de la red, como Redis), la sesión ya está a salvo
					res.writeHead(inst.httpCode || 200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(inst.content ?? { status: "OK" }));
				},
			};

			try {
				const handler = match.handlerFn;

				// "Async/await implícito" (DISEÑO.md): nunca hace falta
				// escribir await, pero SÍ hay que esperar de verdad — así
				// que __trigger es async y se espera con `await` en el
				// propio texto compilado (injectAsyncTriggers), no
				// disparado y olvidado. Si ESE watch() reasigna otra
				// reactive con watch() propio, se encadena — cada nivel
				// espera de verdad al siguiente, todo dentro de la misma
				// petición que arrancó la cascada.
				const asyncWatchersByName = new Map(compiledPlainWatches.map((cw) => [cw.target, cw.fn]));
				let reactiveState;
				const __trigger = async (name) => {
					const fn = asyncWatchersByName.get(name);
					if (!fn) return;
					try {
						await fn(reactiveState[name], WSON, reactiveState, ...importValues, __trigger);
					} catch (err) {
						// Un watch() en cascada que falla no debe tumbar
						// la petición que lo disparó — ya puede estar
						// respondida, o ser de una reactive distinta.
						console.error(`Error en watch("${name}"):`, err && err.message);
					}
				};
				reactiveState = wrapReactiveState(session.state, sessionTypeSchema);

				const result = handler(peticion, localWSON, reactiveState, ...importValues, __trigger);
				await Promise.resolve(result);
				if (!peticion._sent) {
					await sessionStore.save(sessionId, session); // idem: antes de responder
					res.writeHead(peticion.httpCode || 200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ status: "OK" }));
				}
			} catch (err) {
				await sessionStore.save(sessionId, session);
				const status = err instanceof TypeError ? 400 : 500; // TypeError = validación de esquema del DTO
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: err.message }));
			}
		} catch (err) {
			// Red de seguridad para cualquier error ANTES de llegar al handler
			// (p. ej. una `var` de servidor con un tipo declarado que no
			// coincide con su valor inicial, detectado al crear la sesión) —
			// sin esto, escapaba sin control y tiraba el proceso entero en
			// vez de responder con un error a esta única petición.
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: err.message }));
			}
		} finally {
			await releaseLock();
		}
	};

	// Expuesto para poder cerrar conexiones externas (p. ej. Redis) al
	// apagar el servidor — memoria/fichero no tienen nada que cerrar.
	requestHandler.sessionStore = sessionStore;

	return requestHandler;
}

// Envoltorio fino: la mayoría de casos solo quieren un servidor HTTP tal
// cual. `createRequestHandler` está aparte para poder combinar la API con
// una ruta estática (servir el HTML/bundle de cliente desde el mismo
// origen — necesario para probar de verdad en un navegador sin CORS).
function createServer(ast, wconfig = {}, opts = {}) {
	const handler = createRequestHandler(ast, wconfig, opts);
	const server = http.createServer(handler);
	// Expuesto para poder cerrar conexiones externas (p. ej. Redis) al
	// apagar el servidor — memoria/fichero no tienen nada que cerrar, pero
	// Redis sí (session-store: "redis"): server.sessionStore.close?.().
	server.sessionStore = handler.sessionStore;
	return server;
}

function reactiveArgName(name) {
	return name;
}

module.exports = {
	createServer,
	createRequestHandler,
	extractListeners,
	validateNoCollisions,
	compileRoutePattern,
	normalizeRoute,
	resolveImports,
	createSessionStore,
	createMemorySessionStore,
	createFileSessionStore,
	createRedisSessionStore,
	extractSessionStateDecls,
	instantiateSessionState,
	parseCookies,
	isRequestSecure,
	acquireFileLock,
	releaseFileLock,
};
