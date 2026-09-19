// codegen-server.js — WebScript, v0
//
// Convierte el AST de un .wsb en un servidor HTTP real (Node puro, sin
// framework), aplicando WSON.listen()/watch(), CSRF, rate limiting,
// wconfig.json, y resolviendo `import` reales hacia `.wson` (DTOs) y
// `.ws` (funciones/valores compartidos).
//
// LIMITACIONES DE ESTA VERSIÓN (deliberadas, no descuidos):
// - Import solo hacia `.wson` y `.ws` — un `.wsb` no importa a otro `.wsb`
//   todavía (no hay un caso de uso claro para ello aún).
// - Dentro de un `watch()`, las sentencias que no son `WSON.showContent`/
//   `WSON.send`/asignación a `httpCode`/`var`/`const` simples se copian
//   tal cual al JS generado sin comprobar que tengan sentido — es un
//   "mejor esfuerzo", no un intérprete completo de WebScript todavía.
// - Sin sesiones de verdad (no hay `var`/`reactive` de servidor
//   persistidos entre peticiones) — cada petición es independiente.
// - GET / `useRoute` / SSR no están cubiertos por este generador: solo
//   `WSON.listen()` con POST/PUT/DELETE.

const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const WSON = require("./wson-runtime");
const { resolveImportPath } = require("./resolve-imports");
const { buildDtoClass } = require("./codegen-dto");

// --- Resolución de import: .wson -> clase DTO real, .ws -> funciones/valores

function compileFunctionDecl(fnNode) {
	const paramNames = (fnNode.params || []).map((p) => p.name);
	const body = (fnNode.body || []).map(genStatement).join("\n");
	// eslint-disable-next-line no-new-func
	return new Function(...paramNames, body);
}

function resolveImports(ast, baseDir) {
	const { parse } = require("./parser");
	const bindings = {};

	for (const node of ast.body) {
		if (node.type !== "Import") continue;

		const targetPath = resolveImportPath(baseDir, node.from);
		if (!targetPath) {
			throw new Error(`No se pudo resolver el import "${node.from}" (buscado desde ${baseDir})`);
		}

		if (targetPath.endsWith(".wson")) {
			const wsonAst = parse(fs.readFileSync(targetPath, "utf8"), { isWsonFile: true });
			for (const name of node.names) bindings[name] = buildDtoClass(wsonAst, name);
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

		throw new Error(`Import no soportado en el servidor todavía: "${node.from}" (solo .wson y .ws)`);
	}

	return bindings;
}

// --- Estado de módulo del servidor -----------------------------------
// var/reactive/const de nivel superior del .wsb (fuera de cualquier WSON
// ad-hoc o del propio `reactive ... = WSON.listen(...)`) son estado
// compartido del servidor, persistente entre peticiones — no una sesión
// por visitante todavía (ver limitaciones), pero sí real: un `let` en el
// closure de createServer, no reinicializado en cada request.
function extractModuleState(ast, listeners) {
	const listenNames = new Set(listeners.map((l) => l.reactiveName));
	const wsonDeclNames = new Set(ast.body.filter((n) => n.type === "WsonInlineDecl").map((n) => n.name));

	const decls = ast.body.filter(
		(n) =>
			(n.type === "VarDecl" || n.type === "ReactiveDecl" || n.type === "ConstDecl") &&
			!listenNames.has(n.name) &&
			!wsonDeclNames.has(n.name)
	);

	const names = decls.map((d) => d.name);
	const state = {};
	for (const d of decls) {
		// eslint-disable-next-line no-new-func
		state[d.name] = new Function(`return (${d.expr});`)();
	}
	return { names, state };
}

function substituteServerState(code, names) {
	let out = code;
	for (const name of names) {
		const re = new RegExp(`(?<!\\.)\\b${name}\\b`, "g");
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
	const wsonDecls = {}; // nombre -> { to, via, secret, encrypt }
	for (const node of ast.body) {
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
	for (const node of ast.body) {
		if (node.type === "ReactiveDecl" && node.isListen) {
			const m = /^WSON\.listen\((\w+)\)$/.exec(node.expr);
			if (!m || !wsonDecls[m[1]]) continue;
			const watchNode = ast.body.find((w) => w.type === "WatchDecl" && w.target === node.name);
			listeners.push({ reactiveName: node.name, wson: wsonDecls[m[1]], watch: watchNode });
		}
	}
	return listeners;
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
function genStatement(node) {
	if (node.type === "VarDecl" || node.type === "ConstDecl") {
		return `${node.type === "ConstDecl" ? "const" : "let"} ${node.name} = ${node.expr};`;
	}
	if (node.type === "Raw") {
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

function genHandlerBody(watchNode, stateNames) {
	if (!watchNode) return "";
	// Dentro del handler, `peticion` (alias del nombre de la reactive) es
	// la instancia ya recibida — showContent/params/query actúan sobre ese
	// mismo objeto, coherente con la API estática de WSON.
	const raw = (watchNode.body || []).map(genStatement).join("\n");
	return substituteServerState(raw, stateNames);
}

// --- El servidor en sí -----------------------------------------------------

function timingSafeEqualStr(a, b) {
	const bufA = Buffer.from(String(a));
	const bufB = Buffer.from(String(b));
	if (bufA.length !== bufB.length) return false;
	return crypto.timingSafeEqual(bufA, bufB);
}

function createRequestHandler(ast, wconfig = {}, { baseDir } = {}) {
	const listeners = extractListeners(ast);
	validateNoCollisions(listeners);

	const importBindings = baseDir ? resolveImports(ast, baseDir) : {};
	const importNames = Object.keys(importBindings);
	const importValues = importNames.map((n) => importBindings[n]);

	const { names: stateNames, state: serverState } = extractModuleState(ast, listeners);

	const compiled = listeners.map((l) => ({
		...l,
		pattern: compileRoutePattern(l.wson.to),
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

	function checkCsrf(req) {
		const cookieHeader = req.headers.cookie || "";
		const hasSession = /(?:^|;\s*)wsession=/.test(cookieHeader);
		if (!hasSession) return true; // sin sesión de navegador -> no aplica (sistemas externos)
		const cookieMatch = /(?:^|;\s*)wcsrf=([^;]+)/.exec(cookieHeader);
		const cookieToken = cookieMatch ? cookieMatch[1] : null;
		const headerToken = req.headers["x-webscript-csrf"];
		if (!cookieToken || !headerToken) return false;
		return timingSafeEqualStr(cookieToken, headerToken);
	}

	const requestHandler = (req, res) => {
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

		if (["POST", "PUT", "DELETE"].includes(via) && !checkCsrf(req)) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "CSRF inválido" }));
			return;
		}

		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
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
				send: (inst) => {
					inst._sent = true;
					res.writeHead(inst.httpCode || 200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(inst.content ?? { status: "OK" }));
					return Promise.resolve();
				},
			};

			try {
				// eslint-disable-next-line no-new-func
				const handler = new Function(
					reactiveArgName(match.reactiveName),
					"WSON",
					"serverState",
					...importNames,
					genHandlerBody(match.watch, stateNames)
				);
				const result = handler(peticion, localWSON, serverState, ...importValues);
				Promise.resolve(result).finally(() => {
					if (!peticion._sent) {
						res.writeHead(peticion.httpCode || 200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ status: "OK" }));
					}
				});
			} catch (err) {
				const status = err instanceof TypeError ? 400 : 500; // TypeError = validación de esquema del DTO
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: err.message }));
			}
		});
	};

	return requestHandler;
}

// Envoltorio fino: la mayoría de casos solo quieren un servidor HTTP tal
// cual. `createRequestHandler` está aparte para poder combinar la API con
// una ruta estática (servir el HTML/bundle de cliente desde el mismo
// origen — necesario para probar de verdad en un navegador sin CORS).
function createServer(ast, wconfig = {}, opts = {}) {
	return http.createServer(createRequestHandler(ast, wconfig, opts));
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
};
