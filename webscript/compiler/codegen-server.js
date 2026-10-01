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
//   `WSON.send`/`WSON.httpSend`/`var`/`const` simples se copian tal cual
//   al JS generado sin comprobar que tengan sentido — es un "mejor
//   esfuerzo", no un intérprete completo de WebScript todavía.

const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { typeMismatch } = require("./type-check");
const WSON = require("./wson-runtime");
const { findUndeclaredReferences } = require("./validate-js-body");
const { resolveImportPath, isPackageSpecifier, resolvePackage } = require("./resolve-imports");
const { buildDtoClass } = require("./codegen-dto");
const { __wsq, rewriteWhereCalls } = require("./wsdb-query");

// --- Resolución de import: .wson -> clase DTO real, .ws -> funciones/valores

function compileFunctionDecl(fnNode) {
	return compileFunctionBatch([fnNode])[fnNode.name];
}

// Envuelve con `await` cualquier llamada a un identificador SUELTO (no un
// método `objeto.algo()` — eso sigue su propio camino, p. ej. WSON.send()/
// WSON.httpSend()
// o cualquier .wsdb) que esté en `knownNames` — las funciones hermanas
// del mismo lote, o algo inyectado en `extraBindings`/importado. Es lo
// que hace posible "Async/await implícito" también para `function`:
// llamar a otra función (local, importada, u `online function` que en
// realidad habla por WSClient) se espera solo, sin que nadie escriba
// `await` en ningún sitio — ni falta, porque TODAS las `function` se
// compilan ahora como async (ver más abajo), así que awaitar un valor
// normal (no una promesa) es inofensivo: se resuelve igual, solo que en
// el siguiente tick de microtareas.
function injectAwaitForKnownCalls(bodyText, knownNames) {
	if (!knownNames || knownNames.size === 0) return bodyText;
	let ast;
	try {
		ast = acorn.parse(bodyText, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
	} catch {
		return bodyText; // no es JS completo por sí solo — se deja tal cual (mismo criterio que rewriteWhereCalls)
	}
	const targets = [];
	walk.ancestor(ast, {
		CallExpression(node, _state, ancestors) {
			if (node.callee.type !== "Identifier" || !knownNames.has(node.callee.name)) return;
			const parent = ancestors[ancestors.length - 2];
			if (parent && parent.type === "AwaitExpression") return; // ya envuelto (código idempotente, o alguien escribió await a mano)
			targets.push(node);
		},
	});
	if (targets.length === 0) return bodyText;
	targets.sort((a, b) => b.start - a.start);
	let out = bodyText;
	for (const node of targets) out = `${out.slice(0, node.start)}await ${out.slice(node.start, node.end)}${out.slice(node.end)}`;
	return out;
}

// Compila varias `function` A LA VEZ, en un único ámbito compartido — a
// diferencia de una versión anterior de `compileFunctionDecl`, que
// aislaba cada una por completo con su propio `new Function()`, sin
// visibilidad ni de sus hermanas del mismo fichero ni de nada externo
// salvo lo inyectado a mano (así fue como se detectó este límite: ni
// siquiera dos funciones del MISMO fichero podían llamarse entre sí).
// Esto reproduce, en el servidor, lo que el lado cliente ya hacía bien:
// las `function` de un mismo `.wsf`/`.ws` se concatenan como texto JS
// normal en un único script, compartiendo ámbito por las reglas
// corrientes de JS — aquí se hace lo mismo, pero en un `new Function()`
// por lote en vez de un único script para todo el proyecto.
// `extraBindings` son valores adicionales visibles dentro de las
// funciones del lote (p. ej., los imports ya resueltos de un .wsb, para
// que sus propias funciones puedan llamar a algo importado). Devuelve
// `{ nombre: función }` por cada una.
//
// Todas se compilan como `AsyncFunction` (antes: síncronas, sin `await`
// soportado en absoluto en su propio cuerpo) — necesario para que
// `online function`/`function` puedan esperar de verdad el resultado de
// llamar a otra (p. ej. una función generada por `websc client-generate`,
// que habla por WSClient y devuelve una promesa real). El `await` en sí
// nunca lo escribe quien usa el lenguaje: lo inyecta `injectAwaitForKnownCalls`.
// Comprueba que el cuerpo de una function/online function no toque, como
// identificador suelto, ninguna reactive de SESIÓN (declarada sin
// `global`). Antes de esto, tocar una de estas no daba ningún error —
// leía/escribía en silencio la copia GLOBAL compartida, produciendo datos
// incorrectos sin ningún aviso (así se descubrió: una function llamada
// desde un watch() de sesión escribía en un sitio que ese mismo watch()
// nunca llegaba a leer). Ahora es un error claro al compilar.
function checkNoSessionOnlyReferences(bodyText, forbiddenNames, label) {
	if (!forbiddenNames || forbiddenNames.size === 0) return;
	let ast;
	try {
		ast = acorn.parse(bodyText, SERVER_STATE_ACORN_OPTS);
	} catch {
		return; // no analizable con un parser real — no bloqueamos por esto
	}
	const found = new Set();
	walk.ancestor(ast, {
		Identifier(node, _state, ancestors) {
			if (!forbiddenNames.has(node.name)) return;
			const parent = ancestors[ancestors.length - 2];
			if (!parent) return;
			if (ancestors.some((a) => a.type === "ObjectPattern" || a.type === "ArrayPattern" || a.type === "AssignmentPattern" || a.type === "RestElement")) return;
			if (parent.type === "MemberExpression" && !parent.computed && parent.property === node) return;
			if (parent.type === "Property" && !parent.computed && parent.key === node && !parent.shorthand) return;
			if ((parent.type === "BreakStatement" || parent.type === "ContinueStatement" || parent.type === "LabeledStatement") && parent.label === node) return;
			found.add(node.name);
		},
		VariablePattern(node, _state, ancestors) {
			if (!forbiddenNames.has(node.name)) return;
			const parent = ancestors[ancestors.length - 2];
			if (parent && parent.type === "AssignmentExpression" && parent.left === node) found.add(node.name);
		},
	});
	if (found.size > 0) {
		const lista = [...found].map((n) => `"${n}"`).join(", ");
		throw new Error(
			`En ${label}: ${lista} es una reactive/var POR SESIÓN — una function/online function no puede tocarla sin sesión. Decláralo con \`global\` (p. ej. "global reactive ...") si quieres compartirla entre cualquiera que llame.`
		);
	}
}

// `origin` (opcional) se añade a la etiqueta de los errores de compilación
// — p. ej. `importada de "./logica.ws"` — para que un error en una function
// que viene de otro fichero diga DE QUÉ fichero, no solo su nombre.
function compileFunctionBatch(fnNodes, extraBindings = {}, globalInfo = null, { origin = null } = {}) {
	if (fnNodes.length === 0) return {};
	const names = fnNodes.map((n) => n.name);
	const knownNames = new Set([...names, ...Object.keys(extraBindings)]);
	const hasGlobalState = globalInfo && globalInfo.names && globalInfo.names.length > 0;
	const forbiddenNames = (globalInfo && globalInfo.forbiddenNames) || null;
	const globalWatchGroups =
		hasGlobalState && globalInfo.watchedNames && globalInfo.watchedNames.size > 0
			? [{ names: globalInfo.watchedNames, prefix: "getGlobalState().", triggerFn: "__triggerGlobal" }]
			: [];
	const body = fnNodes
		.map((n) => {
			let raw = (n.body || []).map(genStatement).join("\n");
			checkNoSessionOnlyReferences(raw, forbiddenNames, origin ? `function ${n.name} (${origin})` : `function ${n.name}`);
			// "getGlobalState()" como nombre destino, no un identificador
			// suelto — así la sustitución produce `getGlobalState().nombre`,
			// que llama a la función memorizada en el momento de usarse, en
			// vez de cerrar sobre un valor ya creado al compilar (ver el
			// porqué en createRequestHandler: crearlo de forma anticipada
			// tira todo el arranque del servidor si el valor inicial de
			// algún reactive/var no es válido, en vez de fallar solo en la
			// llamada que lo dispare, como ya pasa con cualquier sesión).
			if (hasGlobalState) raw = substituteServerState(raw, globalInfo.names, "getGlobalState()");
			raw = injectAwaitForKnownCalls(raw, knownNames);
			// Si esta function reasigna una reactive `global` que tiene su
			// propio watch(), ese watch() se dispara igual que si la
			// reasignación hubiera ocurrido dentro de un watch() — `global`
			// nunca tiene "sabor sesión" que mezclar (ver DISEÑO.md), así
			// que no hay ambigüedad sobre qué watch() debe correr ni con
			// qué contexto.
			if (globalWatchGroups.length > 0) raw = injectAsyncTriggers(raw, globalWatchGroups);
			return `async function ${n.name}(${(n.params || []).map((p) => p.name).join(", ")}) {\n${raw}\n}`;
		})
		.join("\n\n");
	const extraNames = Object.keys(extraBindings);
	const wrapperBody = `${body}\nreturn { ${names.join(", ")} };`;
	// El envoltorio en sí no necesita ser async — solo declara funciones
	// `async function` (ya en el texto de `body`) y las devuelve.
	// eslint-disable-next-line no-new-func
	const factory = new Function("__wsq", "WSClient", "getGlobalState", "__triggerGlobal", ...extraNames, wrapperBody);
	const getGlobalStateFn = hasGlobalState ? globalInfo.getValue : () => ({});
	const triggerGlobalFn = (globalInfo && globalInfo.triggerGlobal) || (async () => {});
	return factory(__wsq, require("./wsclient-runtime").WSClient, getGlobalStateFn, triggerGlobalFn, ...extraNames.map((n) => extraBindings[n]));
}

// --- Ámbito de imports de un .ws ---------------------------------------
// Un `.ws` puede importar de otro `.ws`, de un `.js`, de un paquete npm, de
// un `.wson` o de un `.wsdb`, igual que un `.wsb`. Esos imports son PRIVADOS
// de ese `.ws` (su ámbito propio, resuelto contra SU carpeta, no contra la
// del `.wsb` que lo importa) — no se filtran a quien lo importa. Antes no se
// resolvían en absoluto: el lote de function de un `.ws` se compilaba sin
// nada de lo que ese fichero importaba, así que cualquier llamada a algo
// importado fallaba en ejecución con `X is not defined` (ver INSTRUCCIONES.md).
//
// Un `registry` recoge, para todo el proyecto, un `entry` por cada `.ws`
// alcanzable (una sola vez por fichero, aunque lo importen varios):
//   scope.bindings  -> lo importado que no es una function de otro .ws
//                      (clases .wson/.wsdb, funciones .js, paquetes, constantes)
//   scope.fnImports -> nombre local -> ruta del .ws del que viene esa function
//   names           -> nombres que pide el ámbito RAÍZ (el .wsb) de ese .ws
//   scopeReady      -> false mientras se resuelven sus propios imports (ciclos)
function createWsRegistry(rootBaseDir) {
	return { rootBaseDir, list: [], byPath: new Map(), compiled: new Map() };
}

// Una function importada de otro .ws se llama a través de este reenviador,
// que busca el lote YA compilado en el momento de la llamada — no al
// compilar. Es lo que hace innecesario ordenar los lotes entre sí, y lo que
// permite que dos .ws se importen mutuamente sin recursar sin fin.
function lateBoundWsFunction(registry, targetPath, name) {
	return (...args) => registry.compiled.get(targetPath)[name](...args);
}

function wsScopeValues(registry, entry) {
	const scope = { ...entry.scope.bindings };
	for (const [localName, depPath] of Object.entries(entry.scope.fnImports)) {
		scope[localName] = lateBoundWsFunction(registry, depPath, localName);
	}
	return scope;
}

// Un export que no es una function (una constante, p. ej.) se evalúa UNA vez,
// con lo que ese .ws importa a la vista, Y CON SUS PROPIAS CONSTANTES
// HERMANAS del mismo fichero (`export const B = A + 1`, con `A` declarada en
// el mismo `.ws`) — antes el ámbito de una constante eran solo los imports
// de su fichero, nunca sus hermanas, así que `A is not defined` incluso
// estando las dos en el mismo sitio. No se puede evaluar mientras el .ws aún
// está resolviendo sus propios imports (importación circular): el ámbito
// estaría a medias, y una constante que use algo aún sin resolver daría un
// `ReferenceError` engañoso en vez de un error que explique la causa.
//
// Una constante hermana solo se añade al ámbito si el texto de `decl.expr`
// la menciona por nombre (igual criterio, por simplicidad y consistencia,
// que el análisis de referencias del cliente) — así una hermana rota o con
// un import que no existe no tumba a las demás si nadie la usa.
//
// Una constante que llama a una FUNCTION hermana del mismo `.ws` sigue sin
// resolverse aquí (`doble is not defined` si `doble` es una function del
// mismo fichero): esa function puede tocar `global`, que en este punto
// (resolución de imports, en el arranque) todavía no existe — se compila
// más tarde, cuando `createRequestHandler` ya sabe qué es `global` y qué es
// de sesión (ver `compileWsRegistry`). Resolverlo exigiría decidir contra
// qué estado compilar esa function en este punto, la misma pregunta de
// diseño abierta que la function exportada por un `.wsb` (ver DISEÑO.md).
function evaluateWsConst(registry, entry, decl) {
	if (!entry.scopeReady) {
		throw new Error(
			`"${decl.name}" de ${entry.targetPath} se pide mientras se resuelven los imports de ese mismo fichero (importación circular): ` +
				"una constante no se puede evaluar hasta tener resuelto todo lo que su fichero importa"
		);
	}
	const scope = { ...wsScopeValues(registry, entry), ...siblingConstScope(registry, entry, decl) };
	const names = Object.keys(scope);
	// eslint-disable-next-line no-new-func
	return new Function(...names, `return (${decl.expr});`)(...names.map((n) => scope[n]));
}

// Constantes/var hermanas del mismo `.ws` que `decl.expr` menciona por
// nombre, cada una resuelta (y cacheada) a través de `getWsConstValue` —
// que a su vez puede necesitar resolver SUS propias hermanas, de forma
// recursiva (cubre cadenas: `const C = B + 1` con `B = A + 1`).
function siblingConstScope(registry, entry, decl) {
	const scope = {};
	for (const sibling of entry.declared) {
		if (!sibling || sibling.name === decl.name) continue;
		if (sibling.type !== "ConstDecl" && sibling.type !== "VarDecl") continue;
		if (!new RegExp(`\\b${sibling.name}\\b`).test(decl.expr)) continue;
		scope[sibling.name] = getWsConstValue(registry, entry, sibling);
	}
	return scope;
}

// Cachea el valor de una constante/var de un `.ws` por nombre (se pida
// desde fuera del fichero, vía `import`, o desde una hermana del mismo
// fichero, vía `siblingConstScope`) — una sola evaluación por nombre, se
// pida una o varias veces. Detecta una dependencia circular ENTRE
// constantes hermanas (`const A = B` / `const B = A`) con un error que
// nombra la constante y el fichero, en vez de una recursión infinita o un
// `ReferenceError` que no explica la causa.
function getWsConstValue(registry, entry, decl) {
	if (!entry.constValues) entry.constValues = new Map();
	if (entry.constValues.has(decl.name)) return entry.constValues.get(decl.name);
	if (!entry.constEvaluating) entry.constEvaluating = new Set();
	if (entry.constEvaluating.has(decl.name)) {
		throw new Error(`"${decl.name}" de ${entry.targetPath}: depende circularmente de otra constante del mismo .ws (a través de sus hermanas)`);
	}
	entry.constEvaluating.add(decl.name);
	try {
		const value = evaluateWsConst(registry, entry, decl);
		entry.constValues.set(decl.name, value);
		return value;
	} finally {
		entry.constEvaluating.delete(decl.name);
	}
}

function getWsEntry(registry, targetPath, from, importer, dbBaseDir) {
	const existing = registry.byPath.get(targetPath);
	if (existing) return existing;

	const { parse } = require("./parser");
	const wsAst = parse(fs.readFileSync(targetPath, "utf8"));
	const declared = wsAst.body.map((n) => (n.type === "Export" ? n.declaration : n));
	const entry = {
		targetPath,
		from,
		importedBy: importer ? importer.targetPath : null,
		declared,
		// Se compilan TODAS las function del fichero a la vez (se pidan o no
		// por nombre) — así una exportada puede llamar a un helper interno sin
		// exportar, y dos exportadas pueden llamarse entre sí.
		fnDecls: declared.filter((d) => d && d.type === "FunctionDecl"),
		names: new Set(),
		scope: { bindings: {}, fnImports: {} },
		scopeReady: false,
	};
	// Se registra ANTES de resolver sus imports: si un ciclo vuelve a este
	// mismo fichero, lo encuentra ya registrado en vez de recursar sin fin.
	registry.byPath.set(targetPath, entry);
	registry.list.push(entry);

	// `targetPath` puede ser un `.wsb` (una function exportada por un .wsb,
	// importada por otro): a diferencia de un `.ws`, un `.wsb` SÍ puede
	// tener su propio estado de servidor (global, sesión, rutas) — así que
	// sus imports hacia OTRO `.wsb` no se resuelven aquí. Encadenar otro
	// `.wsb` reintroduciría, un nivel más allá, la misma pregunta sin
	// resolver: contra qué estado compilar esa cadena. Se filtran esos
	// import ANTES de resolver los demás (los normales — .ws, .js, .wson,
	// .wsdb, paquetes — sí se resuelven con normalidad): si una function
	// realmente necesitara algo de ahí, falla con un "X is not defined"
	// tan claro como cualquier otro nombre sin resolver, no con una
	// recursión silenciosa hacia el estado de otro servidor.
	const importsToResolve = targetPath.endsWith(".wsb")
		? { ...wsAst, body: wsAst.body.filter((n) => n.type !== "Import" || !n.from.endsWith(".wsb")) }
		: wsAst;
	resolveImports(importsToResolve, path.dirname(targetPath), dbBaseDir, { wsRegistry: registry, wsScopeOwner: entry });
	entry.scopeReady = true;
	return entry;
}

// Compila el lote de function de cada entrada del registro, cada una con SU
// ámbito de imports. `globalInfo` es el del .wsb raíz (un .ws no tiene estado
// de servidor propio — ver DISEÑO.md); sin él (uso directo de resolveImports),
// se compila sin estado, como siempre.
//
// Una entrada de origen `.wsb` (una function exportada por un .wsb, ver
// `getWsEntry`) es distinta: SIEMPRE se compila sin `global` en absoluto
// (`globalInfo: null`), nunca con el del `.wsb` raíz que la importa — darle
// el `global` del importador sería tan arbitrario como darle el de su
// propio fichero de origen, y además podría "funcionar" por casualidad si
// coincide un nombre, resolviendo mal en silencio. Antes de compilar, se
// comprueba que ninguna de sus function mencione por nombre una `reactive`/
// `var`/`const` de nivel superior DE ESE MISMO `.wsb` (sea `global` o de
// sesión): si lo hace, es exactamente el hueco sin resolver (contra qué
// estado compilarla) y se da un error explícito, no un `ReferenceError`
// confuso en tiempo de ejecución.
function compileWsRegistry(registry, globalInfo) {
	for (const entry of registry.list) {
		const importer = entry.importedBy ? `, a su vez importada por "${path.relative(registry.rootBaseDir, entry.importedBy)}"` : "";
		const isWsbOrigin = entry.targetPath.endsWith(".wsb");
		if (isWsbOrigin) checkWsbFunctionsDontTouchOwnState(entry);
		const compiled = compileFunctionBatch(entry.fnDecls, wsScopeValues(registry, entry), isWsbOrigin ? null : globalInfo, {
			origin: `importada de "${entry.from}"${importer}`,
		});
		registry.compiled.set(entry.targetPath, compiled);
	}
}

// Nombres de nivel superior de un `.wsb` que son estado real (reactive/var/
// const, sea `global` o de sesión) — ninguno está disponible para una
// function que ese `.wsb` exporta y que otro `.wsb` importa (ver
// `compileWsRegistry`). Solo se comprueban las function REALMENTE
// ALCANZABLES desde lo que se pidió (`entry.names`, más lo que esas llamen
// entre sí, transitivamente) — no todas las del fichero: una function del
// mismo `.wsb` que nadie pidió, y que sí toca su propio estado, no debe
// tumbar la que sí se pidió y no lo toca (mismo criterio — "una hermana que
// nadie usa no tumba a las demás" — que ya se aplicó a las constantes
// hermanas de un `.ws`). Un error aquí nombra la function, el nombre no
// disponible, y el motivo — no deja que llegue a un `ReferenceError` en
// tiempo de ejecución que no explica nada.
function checkWsbFunctionsDontTouchOwnState(entry) {
	const ownStateNames = entry.declared.filter((d) => d && (d.type === "ReactiveDecl" || d.type === "VarDecl" || d.type === "ConstDecl")).map((d) => d.name);
	if (ownStateNames.length === 0) return;

	const fnByName = new Map(entry.fnDecls.map((f) => [f.name, f]));
	const reachable = new Set();
	const queue = [...entry.names];
	while (queue.length > 0) {
		const name = queue.pop();
		if (reachable.has(name) || !fnByName.has(name)) continue;
		reachable.add(name);
		const body = (fnByName.get(name).body || []).map(genStatement).join("\n");
		for (const other of fnByName.keys()) {
			if (other !== name && new RegExp(`\\b${other}\\b`).test(body)) queue.push(other);
		}
	}

	for (const fn of entry.fnDecls) {
		if (!reachable.has(fn.name)) continue;
		const body = (fn.body || []).map(genStatement).join("\n");
		for (const name of ownStateNames) {
			if (new RegExp(`\\b${name}\\b`).test(body)) {
				throw new Error(
					`"${fn.name}" (exportada por ${entry.targetPath}) usa "${name}", que es estado propio de ese .wsb (reactive/var/const de nivel superior): ` +
						"una function exportada por un .wsb no tiene acceso al estado de su fichero de origen (global ni de sesión) — solo a lo que ese .wsb, a su vez, importa de otro sitio (.ws, .js, .wson, .wsdb, un paquete)."
				);
			}
		}
	}
}

// Además de las bindings (nombre -> valor/función ya resuelto), un import
// hacia un .wsb puede traer consigo una RUTA completa (WSON + reactive +
// watch) que hay que añadir al AST antes de extraer las rutas — de ahí que
// esta función devuelva también `extraNodes`.
//
// `deferWsFunctions` (lo usa createRequestHandler): las `function` de un
// `.ws` NO se compilan aquí, sino que se dejan en el registro (`wsRegistry`,
// un lote por fichero, sin repetir aunque se importe desde varias líneas)
// para compilarlas DESPUÉS, cuando ya se sabe qué es `global` y qué es de
// sesión en el .wsb que las importa. Compilarlas aquí mismo era la causa
// de que una function importada de un .ws no tuviera ni acceso a `global`
// ni la protección contra tocar una reactive de sesión: este es el primer
// paso de createRequestHandler, y el estado del .wsb (incluido el que
// traen consigo los import de rutas entre .wsb, que salen de AQUÍ mismo,
// en `extraNodes`) todavía no se conoce. Sin la opción, se compilan al
// momento, sin estado — el comportamiento de siempre, para quien llame a
// resolveImports directamente.
//
// `wsRegistry`/`wsScopeOwner` son internas: la llamada más externa crea el
// registro y lo comparte con las recursivas (imports de rutas entre .wsb,
// e imports propios de cada .ws — con `wsScopeOwner` = el .ws cuyos imports
// se están resolviendo, que es donde van a parar sus resultados).
function resolveImports(ast, baseDir, dbBaseDir, { deferWsFunctions = false, wsRegistry = null, wsScopeOwner = null } = {}) {
	const { parse } = require("./parser");
	const isOutermost = !wsRegistry;
	const registry = wsRegistry || createWsRegistry(baseDir);
	// Los imports de un .ws son privados de ese .ws: van directos a su ámbito.
	const bindings = wsScopeOwner ? wsScopeOwner.scope.bindings : {};
	const extraNodes = [];
	// Un import roto dentro de un .ws anidado no es obvio de localizar (el
	// .wsb raíz no lo escribió): los errores de resolución nombran el .ws.
	const inWs = wsScopeOwner ? `${path.relative(registry.rootBaseDir, wsScopeOwner.targetPath)}: ` : "";

	for (const node of ast.body) {
		if (node.type !== "Import") continue;

		if (isPackageSpecifier(node.from)) {
			// Paquete de npm real (o nativo de Node, "path"/"fs"/...) — Node
			// ya sabe resolverlo caminando por node_modules; solo hace
			// falta un require() real, nada propio del lenguaje aquí.
			const resolvedPkgPath = resolvePackage(baseDir, node.from);
			if (!resolvedPkgPath) {
				throw new Error(`${inWs}No se pudo resolver el paquete "${node.from}" (¿está instalado? buscado desde ${baseDir})`);
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
			throw new Error(`${inWs}No se pudo resolver el import "${node.from}" (buscado desde ${baseDir})`);
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
			const { buildWsdbV2 } = require("./codegen-wsdb");
			let wsdbAst;
			try {
				wsdbAst = parse(fs.readFileSync(targetPath, "utf8"), { isWsdbFile: true });
			} catch (e) {
				throw new Error(`"${node.from}": ${e.message}`);
			}
			// Un solo fichero .db para todo el proyecto (varias colecciones,
			// varias tablas) — igual criterio que ".sessions/": vive junto al
			// proyecto, no junto al código fuente, y no es configurable en
			// esta primera versión (fijo, sencillo).
			const dbPath = path.join(dbBaseDir || registry.rootBaseDir, ".wsdb-data", "webscript.db");
			// El .wsdb define él mismo sus dos clases (<Nombre> y
			// <Nombre>Schema, según "-> name:") — el import tiene que
			// pedirlas por ese nombre exacto.
			const { classes } = buildWsdbV2(wsdbAst, dbPath, path.basename(targetPath), path.dirname(targetPath));
			for (const name of node.names) {
				if (!classes[name]) {
					throw new Error(`"${node.from}" no exporta "${name}" — exporta ${Object.keys(classes).map((n) => `"${n}"`).join(" y ")} (según su "-> name:")`);
				}
				bindings[name] = classes[name];
			}
			continue;
		}

		if (targetPath.endsWith(".ws")) {
			const entry = getWsEntry(registry, targetPath, node.from, wsScopeOwner, dbBaseDir);
			for (const name of node.names) {
				const decl = entry.declared.find((d) => d && d.name === name);
				if (!decl) throw new Error(`${inWs}"${name}" no está exportado en ${targetPath}`);
				if (decl.type === "FunctionDecl") {
					// Desde un .wsb, la function llega al ámbito raíz (se enlaza
					// al compilar); desde otro .ws, se anota en el ámbito de ESE
					// .ws y se llama con enlace tardío — ver lateBoundWsFunction.
					if (wsScopeOwner) wsScopeOwner.scope.fnImports[name] = targetPath;
					else entry.names.add(name);
				} else {
					bindings[name] = getWsConstValue(registry, entry, decl);
				}
			}
			continue;
		}

		if (targetPath.endsWith(".wsb")) {
			// Un .ws es lógica compartida entre .wsf y .wsb (el cliente también
			// lo usa), y un .wsb es solo de servidor: importarlo desde un .ws
			// no tiene sentido y rompería el bundle del cliente.
			if (wsScopeOwner) {
				throw new Error(
					`${path.relative(registry.rootBaseDir, wsScopeOwner.targetPath)} (un .ws) importa "${node.from}": un .ws es lógica compartida (también la usa el cliente) y no puede importar un .wsb`
				);
			}
			const targetBaseDir = path.dirname(targetPath);
			const targetAst = parse(fs.readFileSync(targetPath, "utf8"));
			const declared = targetAst.body.map((n) => (n.type === "Export" ? n.declaration : n));

			for (const name of node.names) {
				const decl = declared.find((d) => d && d.name === name);
				if (!decl) throw new Error(`"${name}" no está exportado en ${targetPath}`);

				if (decl.type === "FunctionDecl") {
					// Se resuelve como una entrada más del mismo registro que ya
					// usan los `.ws` (ver `getWsEntry`) — mismo ámbito por
					// fichero, mismo enlace tardío, mismo "se compilan TODAS las
					// function de ese fichero a la vez" (así una exportada puede
					// llamar a un helper interno sin exportar, o a otra
					// exportada, del MISMO .wsb). Antes se compilaba sola y
					// aislada (`compileFunctionDecl`), sin ver ni sus propios
					// imports ni sus hermanas — `X is not defined` con
					// cualquiera de las dos. `wsScopeOwner` aquí siempre es
					// nulo (una function exportada por un .wsb importando OTRO
					// .wsb ya se filtró en `getWsEntry`), así que el nombre
					// pedido va directo a `entry.names` — igual que hace el
					// ámbito raíz con la de un `.ws`.
					const wsbEntry = getWsEntry(registry, targetPath, node.from, wsScopeOwner, dbBaseDir);
					wsbEntry.names.add(name);
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
					const nested = resolveImports(targetAst, targetBaseDir, dbBaseDir, { wsRegistry: registry });
					Object.assign(bindings, nested.bindings);
					extraNodes.push(...nested.extraNodes);
					continue;
				}
			}
			continue;
		}

		throw new Error(`Import no soportado en el servidor todavía: "${node.from}" (solo .wson, .ws y .wsb)`);
	}

	// Sin `deferWsFunctions`, la llamada más externa compila ya los lotes de
	// todos los .ws alcanzados (sin estado) y enlaza lo que pidió el ámbito
	// raíz. Las llamadas recursivas nunca compilan: se limitan a rellenar el
	// registro compartido.
	const compileNow = isOutermost && !deferWsFunctions;
	if (compileNow) {
		compileWsRegistry(registry, null);
		for (const entry of registry.list) {
			for (const name of entry.names) bindings[name] = registry.compiled.get(entry.targetPath)[name];
		}
	}
	return { bindings, extraNodes, deferredWs: compileNow ? [] : registry.list, wsRegistry: registry };
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
// Convierte una reasignación real (no una simple lectura) de una reactive
// CON SU PROPIO watch() en "reasigna, y además dispara ese watch()" —
// `await __trigger("nombre")` justo después de la línea que reasigna.
//
// `groups` es una lista de { names, prefix, triggerFn } — antes solo
// existía un grupo (las reactives de SESIÓN, con prefijo `serverState.` y
// disparador `__trigger`); ahora también hay un segundo grupo posible
// para las reactives `global` (prefijo `getGlobalState().`, disparador
// `__triggerGlobal`) — dos disparadores distintos, nunca mezclados en una
// misma reactive, porque una reactive es de sesión O global, nunca las
// dos cosas. Se usa tanto para el texto de un watch() como para el de
// una function/online function (una function puede reasignar una
// reactive `global` y disparar su watch() igual que un watch() lo haría).
function injectAsyncTriggers(bodyText, groups) {
	const specs = [];
	for (const g of groups || []) {
		if (!g.names || g.names.size === 0) continue;
		const escapedPrefix = g.prefix.replace(/[.()[\]{}*+?^$|\\]/g, "\\$&");
		for (const name of g.names) {
			specs.push({
				name,
				re: new RegExp(`^\\s*${escapedPrefix}${name}\\s*(=(?!=)|\\+\\+|--|[-+*/%&|^]=|\\*\\*=|&&=|\\|\\|=|\\?\\?=)`),
				triggerFn: g.triggerFn,
			});
		}
	}
	if (specs.length === 0) return bodyText;
	const lines = bodyText.split("\n");
	const out = [];
	for (const line of lines) {
		out.push(line);
		for (const spec of specs) {
			if (spec.re.test(line)) out.push(`await ${spec.triggerFn}(${JSON.stringify(spec.name)});`);
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

const acorn = require("acorn");
const walk = require("acorn-walk");
const { acceptUpgrade, OPCODE } = require("./websocket-runtime");

const SERVER_STATE_ACORN_OPTS = { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true };

// Antes de esta versión, la sustitución se hacía con una expresión
// regular sobre el texto crudo — así que un `nombre` de reactive que
// coincidiera con una palabra suelta DENTRO de un string o de un template
// literal también se sustituía (p. ej. una reactive llamada "persona" y
// un mensaje `"persona creada"` en el propio watch() se corrompía a
// `"serverState.persona creada"`). Se mantiene como red de seguridad para
// el caso (raro) de que el cuerpo del watch(), ya ensamblado, no sea JS
// válido por sí solo — nunca debería pasar dado cómo se construye `raw`
// en genHandlerBody, pero fallar en silencio dejando referencias sin
// cualificar sería peor (ReferenceError en producción) que aplicar la
// heurística antigua.
function substituteServerStateNaive(code, names, targetName = "serverState") {
	let out = code;
	for (const name of names) {
		const re = new RegExp(`(?<![.\\w])(?<![{,][ \\t]{0,20})\\b${name}\\b(?![ \\t]{0,20}:)`, "g");
		out = out.replace(re, `${targetName}.${name}`);
	}
	return out;
}

// Sustituye cada referencia real a una reactive de servidor (`names`) por
// `serverState.<nombre>`, usando un parser real en vez de una expresión
// regular — para no tocar nunca el contenido de un string, un template
// literal o un comentario, que un simple `\b<nombre>\b` no puede
// distinguir del código de verdad.
//
// Casos que NO se sustituyen (son la misma palabra, pero no una lectura
// de la reactive):
// - la propiedad de un acceso `objeto.nombre` (no `nombre` en sí)
// - la CLAVE de un `{ nombre: valor }` (el valor si se sustituye)
// - cualquier identificador dentro de un patrón de desestructuración
//   (`const { nombre } = x`, un parámetro `{ nombre }`, `...nombre`) — ahí
//   `nombre` se está DECLARANDO, no leyendo; sustituirlo generaría una
//   declaración inválida (`const serverState.nombre = ...` no es JS
//   válido)
// - la etiqueta de un `break`/`continue`/una sentencia etiquetada
//
// Caso que SÍ se sustituye y que la versión anterior (regex) dejaba mal:
// una propiedad abreviada `{ nombre }` como VALOR (no como patrón) se
// expande a `{ nombre: serverState.nombre }` — la regex antigua la
// trataba como si fuera una clave y la dejaba tal cual, lo que habría
// producido un `ReferenceError: nombre is not defined` en tiempo de
// ejecución (nunca se detectó porque no hay ningún test que construya un
// objeto así a partir de una reactive).
function substituteServerState(code, names, targetName = "serverState") {
	if (!names || names.length === 0) return code;
	const nameSet = new Set(names);
	let ast;
	try {
		ast = acorn.parse(code, SERVER_STATE_ACORN_OPTS);
	} catch {
		return substituteServerStateNaive(code, names, targetName);
	}

	const actions = [];
	const shorthandDone = new Set(); // "start-end" — evita procesar dos veces la clave y el valor de una misma propiedad abreviada

	walk.ancestor(ast, {
		// acorn-walk enruta el lado izquierdo de una asignación simple
		// (`persona = valor`) como "Pattern" -> "VariablePattern" en vez de
		// como un Identifier normal (mismo mecanismo que usa para
		// declaraciones y parámetros) — y por defecto NO llama a ningún
		// visitor para ese tipo. Sin este visitor propio, el caso más
		// importante de todos (reasignar la reactive para disparar su
		// cascada) se quedaba sin sustituir, dejando `persona = ...` tal
		// cual en vez de `serverState.persona = ...` — un ReferenceError
		// en cuanto se ejecutara.
		VariablePattern(node, _state, ancestors) {
			if (!nameSet.has(node.name)) return;
			const parent = ancestors[ancestors.length - 2];
			// El mismo tipo "VariablePattern" cubre también un `var`/
			// parámetro/`catch` NUEVO con ese nombre — eso sí es una
			// declaración local, no una reactive, y no se toca. Solo nos
			// interesa el caso de una reasignación real (con cualquier
			// operador: =, +=, etc.), que sí lee/escribe la reactive.
			if (parent && parent.type === "AssignmentExpression" && parent.left === node) {
				actions.push({ start: node.start, end: node.end, text: `${targetName}.${node.name}` });
			}
		},
		Identifier(node, _state, ancestors) {
			if (!nameSet.has(node.name)) return;
			// ancestors incluye al propio nodo como último elemento.
			const parent = ancestors[ancestors.length - 2];
			if (!parent) return;

			// Dentro de un patrón de desestructuración (declaración,
			// parámetro, o el lado izquierdo de una asignación) no se toca
			// nada — ver el comentario de arriba.
			if (ancestors.some((a) => a.type === "ObjectPattern" || a.type === "ArrayPattern" || a.type === "AssignmentPattern" || a.type === "RestElement")) {
				return;
			}

			if ((parent.type === "BreakStatement" || parent.type === "ContinueStatement" || parent.type === "LabeledStatement") && parent.label === node) {
				return;
			}
			if (parent.type === "MemberExpression" && !parent.computed && parent.property === node) {
				return; // objeto.nombre — la propiedad no se sustituye
			}
			if (parent.type === "Property" && !parent.computed) {
				if (parent.shorthand) {
					const key = `${node.start}-${node.end}`;
					if (shorthandDone.has(key)) return; // ya se generó la expansión (se visita la clave y el valor por separado, mismo rango)
					shorthandDone.add(key);
					actions.push({ start: node.start, end: node.end, text: `${node.name}: ${targetName}.${node.name}` });
					return;
				}
				if (parent.key === node) return; // { nombre: valor } — la clave no se sustituye, el valor sí (sigue su propio camino)
			}

			actions.push({ start: node.start, end: node.end, text: `${targetName}.${node.name}` });
		},
	});

	if (actions.length === 0) return code;
	actions.sort((a, b) => b.start - a.start);
	let out = code;
	for (const a of actions) out = out.slice(0, a.start) + a.text + out.slice(a.end);
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

// --- `online function`: registro de funciones expuestas a otros servidores

// Recopila las `online function` alcanzables desde este .wsb — las suyas
// propias, y las que traiga consigo un `import { nombre } from "./algo.ws"`
// cuya declaración original, en ese .ws, también sea `online`. No hace
// falta rebuscar el proyecto entero: si no está importada, no se expone —
// mismo criterio que WSON.listen(), que tampoco se descubre solo.
// Recopila las `online function` alcanzables desde este .wsb — las suyas
// propias, y las que traiga consigo un `import { nombre } from "./algo.ws"`
// cuya declaración original, en ese .ws, también sea `online`. No hace
// falta rebuscar el proyecto entero: si no está importada, no se expone —
// mismo criterio que WSON.listen(), que tampoco se descubre solo.
//
// `extraBindings` (imports ya resueltos + function propias no-online del
// mismo .wsb, ver createRequestHandler) queda disponible dentro de las
// declaradas aquí mismo — así una online function puede llamar a una
// function corriente o a algo importado, sin ninguna limitación distinta
// a cualquier otra function. Las importadas de un .ws se compilan JUNTO a
// las demás function de ESE MISMO fichero (sean online o no), para que
// puedan llamarse entre sí igual que si nunca hubieran salido de ahí.
//
// El acceso a `global` (y la protección contra el estado de sesión) llega
// igual a las propias y a las importadas de un `.ws`: ambas se compilan en
// createRequestHandler con el mismo `globalInfo` (antes, las importadas no
// — se compilaban dentro de resolveImports, antes de conocer el estado).
// Recopila las `online function` alcanzables desde este .wsb — las suyas
// propias, y las que traiga consigo un `import { nombre } from "./algo.ws"`
// cuya declaración original, en ese .ws, también sea `online`. No hace
// falta rebuscar el proyecto entero: si no está importada, no se expone —
// mismo criterio que WSON.listen(), que tampoco se descubre solo.
//
// `compiledOwn` son las function de ESTE `.wsb` YA COMPILADAS (junto a
// todas sus hermanas, `online` o no, en un único lote — ver
// createRequestHandler) — aquí no se vuelven a compilar aparte, solo se
// seleccionan por nombre las que sean `online`, para no perder la
// visibilidad cruzada entre una `function` normal y una `online function`
// del mismo fichero (si se compilaran en lotes separados, una no podría
// llamar a la otra según cuál se compilara antes — se detectó así, con
// código real). Las importadas de un .ws sí se compilan aquí, JUNTO a
// las demás function de ESE MISMO fichero (sean online o no), para que
// puedan llamarse entre sí igual que si nunca hubieran salido de ahí.
//
// `compiledWsFiles` (Map ruta -> { nombre: función }), si se pasa, son los
// .ws YA compilados por createRequestHandler (con acceso a `global`) — se
// reutilizan tal cual. Antes aquí se volvía a compilar el .ws por segunda
// vez, así que la MISMA function importada existía en dos instancias
// distintas: una para las llamadas en local y otra, sin estado, para RPC.
function extractOnlineFunctions(ast, baseDir, compiledOwn = {}, compiledWsFiles = null) {
	const { parse } = require("./parser");
	const found = [];
	const seen = new Set();
	const claim = (name, label) => {
		if (seen.has(name)) throw new Error(`"online function ${name}" está declarada más de una vez (revisa los imports) — ${label}`);
		seen.add(name);
	};

	const ownOnlineDecls = ast.body.filter((n) => n.type === "FunctionDecl" && n.online);
	for (const decl of ownOnlineDecls) {
		claim(decl.name, "declarada en este .wsb");
		found.push({ name: decl.name, params: decl.params.map((p) => p.name), idempotent: !!decl.idempotent, fn: compiledOwn[decl.name] });
	}

	if (!baseDir) return found;
	for (const node of ast.body) {
		if (node.type !== "Import" || isPackageSpecifier(node.from)) continue;
		const targetPath = resolveImportPath(baseDir, node.from);
		if (!targetPath || !targetPath.endsWith(".ws")) continue; // solo .ws — un .wsb no debería exponer online functions de otro .wsb
		const wsAst = parse(fs.readFileSync(targetPath, "utf8"));
		const declared = wsAst.body.map((n) => (n.type === "Export" ? n.declaration : n));
		const compiledFile =
			(compiledWsFiles && compiledWsFiles.get(targetPath)) || compileFunctionBatch(declared.filter((d) => d && d.type === "FunctionDecl"));
		for (const name of node.names) {
			const decl = declared.find((d) => d && d.name === name);
			if (decl && decl.type === "FunctionDecl" && decl.online) {
				claim(decl.name, `importada de "${node.from}"`);
				found.push({ name: decl.name, params: decl.params.map((p) => p.name), idempotent: !!decl.idempotent, fn: compiledFile[decl.name] });
			}
		}
	}
	return found;
}

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
// Si WSON.httpSend(...)/WSON.send(...) es la ÚLTIMA sentencia de una rama
// (el caso normal — incluso dentro de if/else), se compila como
// `return WSON.httpSend(...)` en vez de una llamada suelta: así quien
// invoca al handler puede esperar de verdad a que termine (relevante para
// un guardado de sesión asíncrono, como Redis) antes de responder o soltar
// el bloqueo de la sesión.
// Toda sentencia generada pasa por la reescritura de `.where(...)` (ver
// wsdb-query.js) — idempotente, así que da igual que un bloque anidado ya
// venga reescrito desde dentro.
function genStatement(node) {
	return rewriteWhereCalls(genStatementRaw(node));
}

function genStatementRaw(node) {
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
	if (node.type === "For") {
		// Misma semántica que ya usa el lado cliente para esto mismo
		// (codegen-client.js: genFor) — valores del listado, no índices ni
		// claves. Antes no había ningún caso para "For" aquí: caía en el
		// mensaje de "sentencia no reconocida" de más abajo, que solo
		// genera un comentario — el cuerpo del bucle (lo que fuera que
		// acumulara) no se ejecutaba nunca, sin ningún error ni aviso.
		return `for (const ${node.item} of (${node.list})) {\n${(node.body || []).map(genStatement).join("\n")}\n}`;
	}
	return `// TODO codegen-server: sentencia no reconocida (${node.type})`;
}

// "Async/await implícito" (DISEÑO.md): `WSON.send()` (llamada saliente,
// la usa quien invoca) y `WSON.httpSend()` (responde la petición entrante,
// la usa quien fue invocado — ver DISEÑO.md, sección "WSON.httpSend...")
// son las dos únicas llamadas de la API estática de WSON que representan
// "espera esto" de verdad — a diferencia de `WSON.enqueue()`, que es
// fire-and-forget A PROPÓSITO, por diseño (esperar sus reintentos con
// backoff dentro de la misma petición sería contraproducente, no un
// descuido). Se esperan en CUALQUIER posición del cuerpo, no solo si son
// la última sentencia — antes, una de estas que no fuera la última línea
// se disparaba y se olvidaba, exactamente el mismo problema que ya se
// corrigió para la cascada de watch().
function injectSendAwait(bodyText) {
	return bodyText.replace(/(?<!await\s)\bWSON\.(?:send|httpSend)\(/g, (m) => `await ${m}`);
}

function genHandlerBody(watchNode, stateNames, knownFunctionNames, globalNames) {
	if (!watchNode) return "";
	// Dentro del handler, `peticion` (alias del nombre de la reactive) es
	// la instancia ya recibida — showContent/httpParams/httpQuery actúan
	// sobre ese mismo objeto, coherente con la API estática de WSON.
	let raw = (watchNode.body || []).map(genStatement).join("\n");
	raw = substituteServerState(raw, stateNames);
	// Un watch() de sesión (o de una ruta WSON.listen()) también puede
	// leer/escribir una reactive `global` — no hay ambigüedad de sabores
	// aquí: la reactive en sí ya dice si es de sesión o global, nunca las
	// dos cosas, así que combinar las dos sustituciones en el mismo
	// cuerpo es seguro.
	if (globalNames && globalNames.length > 0) raw = substituteServerState(raw, globalNames, "getGlobalState()");
	return injectAwaitForKnownCalls(injectSendAwait(raw), knownFunctionNames);
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
	const faltantes = findUndeclaredReferences(bodyText, [...paramNames, "__trigger", "__triggerGlobal"]);
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
	// Las function de un .ws importado se APLAZAN (deferWsFunctions): se
	// compilan más abajo, en cuanto se sabe qué es `global` y qué es de
	// sesión — ver el comentario de resolveImports.
	const { bindings: importBindings, extraNodes, wsRegistry } = baseDir
		? resolveImports(ast, baseDir, sessionBaseDir, { deferWsFunctions: true })
		: { bindings: {}, extraNodes: [], wsRegistry: createWsRegistry(null) };
	const expandedAst = extraNodes.length > 0 ? { ...ast, body: [...ast.body, ...extraNodes] } : ast;

	const listeners = extractListeners(expandedAst);
	validateNoCollisions(listeners);

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
	// `global` separa de raíz dos cosas que antes compartían un solo
	// mecanismo confuso: una reactive normal es POR SESIÓN, como
	// siempre — una copia propia por visitante, invisible del todo para
	// cualquier function/online function (se comprueba y se rechaza al
	// compilar, ver checkNoSessionOnlyReferences). Una `global reactive`
	// es una única instancia compartida por todo el proceso, alcanzable
	// desde CUALQUIER sitio — un watch(), una function, una online
	// function — sin ningún "sabor" que mezclar, porque nunca tuvo el
	// otro. Antes de esto, TODA reactive de nivel superior se ofrecía
	// como si fuera global a cualquier function/online function que la
	// tocara, en silencio y sin que nadie lo pidiera — el bug real que
	// llevó a este rediseño: una function llamada desde un watch() de
	// sesión escribía en la copia global, no en la de esa sesión, sin
	// ningún error ni aviso.
	const sessionOnlyDecls = sessionDecls.filter((d) => !d.global);
	const globalDecls = sessionDecls.filter((d) => d.global);
	const stateNames = sessionOnlyDecls.map((d) => d.name);
	const sessionTypeSchema = {};
	for (const d of sessionOnlyDecls) {
		if (d.varType) sessionTypeSchema[d.name] = d.varType;
	}
	const globalNames = globalDecls.map((d) => d.name);
	const globalTypeSchema = {};
	for (const d of globalDecls) {
		if (d.varType) globalTypeSchema[d.name] = d.varType;
	}
	const sessionOnlyNamesSet = new Set(stateNames);

	// Creada la PRIMERA VEZ que de verdad hace falta, no al arrancar el
	// servidor: un valor inicial mal tipado, como en cualquier sesión
	// normal, debe dar un error solo en la llamada que lo dispare, nunca
	// tirar el proceso entero al arrancar. Memorizada para las siguientes.
	let globalStateCache = null;
	function getGlobalState() {
		if (!globalStateCache) globalStateCache = wrapReactiveState(instantiateSessionState(globalDecls), globalTypeSchema);
		return globalStateCache;
	}

	// `watch()` sobre cualquier reactive que no sea WSON.listen() — se
	// compilan una vez aquí, y se invocan cuando se les asigna un valor
	// nuevo. Se separan por si su reactive es `global` o de sesión ANTES
	// de compilarlas, porque cada una necesita un mecanismo de disparo
	// distinto (__trigger, por sesión, más abajo — o __triggerGlobal,
	// compartido por todo el proceso, justo aquí debajo) — nunca los dos
	// a la vez, porque una reactive es de un tipo o del otro, no ambos.
	const allPlainWatches = extractPlainWatches(
		expandedAst,
		listeners.map((l) => l.reactiveName)
	);
	const globalNamesSet = new Set(globalNames);
	const globalPlainWatches = allPlainWatches.filter((w) => globalNamesSet.has(w.target));
	const plainWatches = allPlainWatches.filter((w) => !globalNamesSet.has(w.target));
	// `shared global reactive` necesita que CUALQUIER reasignación suya
	// dispare `__triggerGlobal` — no solo las que tienen su propio
	// `watch()` (que ya lo necesitaban para eso) — porque la difusión a
	// los clientes suscritos (ver `wireSharedReactivesRpc`) vive dentro de
	// `__triggerGlobal` y debe ocurrir SIEMPRE que cambie, tenga o no un
	// `watch()` declarado. Sin esto, una `shared global reactive` sin
	// `watch()` (el caso más simple: compartir un valor sin ninguna
	// lógica de validación) nunca se habría difundido en absoluto.
	const sharedGlobalNames = new Set(globalDecls.filter((d) => d.type === "ReactiveDecl" && d.shared).map((d) => d.name));
	const globalWatchedNames = new Set([...globalPlainWatches.map((w) => w.target), ...sharedGlobalNames]);

	// __triggerGlobal se define ANTES de compilar los propios global
	// watches (para que puedan inyectárselo entre sí y encadenar una
	// cascada), pero el mapa que consulta se rellena DESPUÉS de
	// compilarlos — el mismo truco de siempre (closure sobre una
	// variable que se puebla más tarde, nunca invocada antes de eso).
	const globalWatchesByName = new Map();
	// Dos guardas contra un watch() que se dispara a sí mismo sin parar
	// (reproducido con código real: `watch(contador) { contador = contador
	// }` — sin ninguna de las dos, revienta la pila: "Maximum call stack
	// size exceeded"):
	// 1. Si el valor NO cambió de verdad respecto al último disparo que se
	//    atendió, no se llama al watch() — cubre el caso típico (una
	//    corrección/normalización que, aplicada dos veces, da lo mismo:
	//    se ejecuta una vez, corrige, y la segunda vez ya no hay nada que
	//    corregir). No es una ocurrencia nueva: es la misma guarda que ya
	//    usa cualquier motor reactivo (React, Vue) para esto mismo.
	// 2. Un contador de profundidad, como red de seguridad para el caso
	//    que la guarda 1 NO cubre — un valor que cambia de verdad en
	//    cada disparo, sin converger nunca (p. ej. `contador =
	//    contador + 1` sin condición dentro de su propio watch()). Sin
	//    esto, ese caso seguiría reventando la pila; con esto, da un
	//    error claro y accionable en vez de un cuelgue.
	const globalLastTriggeredValues = new Map();
	let globalTriggerDepth = 0;
	const GLOBAL_TRIGGER_MAX_DEPTH = 50;
	// Registro de conexiones WebSocket suscritas a cada `shared global
	// reactive` — por NOMBRE, no por conexión, porque difundir es "para
	// cada suscriptor de este nombre, manda el valor nuevo" (ver
	// `wireSharedReactivesRpc`, que es quien añade/quita conexiones aquí
	// al conectar/desconectar). Vive en este mismo cierre, junto al resto
	// del estado global, por la misma razón: compartido por TODO el
	// proceso, no por sesión ni por conexión.
	const sharedSubscribers = new Map(); // nombre -> Set<ws>
	// Última versión DIFUNDIDA de cada `shared global reactive` — guarda
	// aparte de `globalLastTriggeredValues` (esa es para el `watch()`, y
	// una `shared` puede no tener ninguno). Necesaria porque un `watch()`
	// que corrige su propio valor dispara `__triggerGlobal` DOS veces para
	// el mismo asentamiento final: una vez desde quien causó el cambio
	// original (que sigue ejecutando DESPUÉS de que el `watch()` en
	// cascada ya terminó y ya difundió el valor corregido) y otra desde la
	// propia corrección — sin esta guarda, el mismo valor final se manda
	// dos veces seguidas a cada suscrito. Reproducido con código real
	// antes de añadirla: `propose` con un valor que el `watch()` recorta
	// llegaba a los suscritos como DOS mensajes "update" idénticos.
	const sharedLastBroadcastValues = new Map();

	const __triggerGlobal = async (name) => {
		const fn = globalWatchesByName.get(name);
		if (fn) {
			const current = getGlobalState()[name];
			const changed = !globalLastTriggeredValues.has(name) || globalLastTriggeredValues.get(name) !== current;
			if (changed) {
				globalLastTriggeredValues.set(name, current);
				if (globalTriggerDepth >= GLOBAL_TRIGGER_MAX_DEPTH) {
					console.error(
						`watch("${name}") [global]: posible bucle — se superaron ${GLOBAL_TRIGGER_MAX_DEPTH} disparos en cascada sin converger (cada disparo reasigna un valor DISTINTO al anterior; revisa si el propio watch() necesita una condición de parada).`
					);
				} else {
					globalTriggerDepth++;
					try {
						await fn();
					} catch (err) {
						console.error(`Error en watch("${name}") [global]:`, err && err.message);
					} finally {
						globalTriggerDepth--;
					}
				}
			}
		}
		// La difusión a los suscritos es INDEPENDIENTE de que haya o no un
		// `watch()` — una `shared global reactive` sin ninguna lógica de
		// validación propia (el caso más simple: solo compartir un valor)
		// se difunde igual. Ocurre DESPUÉS de que el `watch()` (si lo hay)
		// haya tenido ocasión de corregir el valor — así quien recibe el
		// `update` ve el valor YA corregido, nunca el provisional.
		if (sharedGlobalNames.has(name)) {
			const currentValue = getGlobalState()[name];
			const alreadyBroadcast = sharedLastBroadcastValues.has(name) && sharedLastBroadcastValues.get(name) === currentValue;
			if (!alreadyBroadcast) {
				sharedLastBroadcastValues.set(name, currentValue);
				const subs = sharedSubscribers.get(name);
				if (subs && subs.size > 0) {
					const payload = JSON.stringify({ type: "update", name, value: currentValue });
					for (const ws of subs) {
						try {
							ws.send(payload);
						} catch {
							// una conexión rota al difundir no debe tumbar la difusión
							// a las demás — se limpiará sola al llegar su "close".
						}
					}
				}
			}
		}
	};

	// Las `function` normales (no `online`) declaradas DIRECTAMENTE en
	// este .wsb no se procesaban en ningún sitio — invisibles del todo
	// para cualquier watch(), como si no existieran. Se compilan JUNTO A
	// las `online function` propias del mismo `.wsb`, en el MISMO lote —
	// no en dos pasadas separadas: si se compilaran aparte, una `function`
	// no podría llamar a una `online function` del mismo fichero ni al
	// revés, según cuál se compilara primero (se detectó exactamente así,
	// probándolo). Con acceso además a todo lo ya importado
	// (`importBindings`) — así pueden llamar a algo traído de un .ws
	// igual que si lo hubieran importado ellas mismas.
	const globalInfo = { names: globalNames, getValue: getGlobalState, forbiddenNames: sessionOnlyNamesSet, watchedNames: globalWatchedNames, triggerGlobal: __triggerGlobal };

	// Las function importadas de un .ws, ya con `globalInfo` — MISMA regla
	// que las declaradas aquí: acceso a `global reactive/var/const` como
	// identificador suelto (resuelto contra el `global` de ESTE .wsb, el que
	// las importa: un .ws no tiene estado de servidor propio), disparo de
	// su watch() si lo reasignan, y error claro al compilar si tocan una
	// reactive/var de SESIÓN. Un lote por fichero, con TODAS sus function
	// (se importen o no por nombre), para que sigan pudiendo llamarse entre
	// sí. Se compilan ANTES que las propias, para que estas puedan
	// llamarlas (mismo orden que antes, cuando salían de resolveImports).
	// Esa misma instancia es la que se expone luego por RPC si es `online`
	// (extractOnlineFunctions ya no la recompila).
	// Cada .ws se compila con SU ámbito de imports (lo que ese .ws importa),
	// no solo con `globalInfo` — ver createWsRegistry. Lo alcanzable
	// transitivamente (un .ws que importa otro .ws...) entra en el mismo
	// registro, sin importar quién lo pidió primero.
	compileWsRegistry(wsRegistry, globalInfo);
	const compiledWsFiles = wsRegistry.compiled;
	for (const d of wsRegistry.list) {
		for (const name of d.names) importBindings[name] = compiledWsFiles.get(d.targetPath)[name];
	}

	const ownFunctionDecls = expandedAst.body.filter((n) => n.type === "FunctionDecl");
	const compiledOwn = compileFunctionBatch(ownFunctionDecls, importBindings, globalInfo);
	Object.assign(importBindings, compiledOwn);

	// Los watch() de una reactive `global` se compilan como si fueran
	// function síncronas de cero argumentos — reutilizando el mismo
	// mecanismo que cualquier function/online function, así heredan
	// gratis: la prohibición de tocar una reactive de sesión sin serlo,
	// el await implícito, y el disparo en cascada de OTROS watches
	// globales que su propio cuerpo pudiera reasignar.
	const globalWatchFnNodes = globalPlainWatches.map((w) => ({ type: "FunctionDecl", name: w.target, params: [], body: w.body }));
	const compiledGlobalWatchFns = compileFunctionBatch(globalWatchFnNodes, importBindings, globalInfo);
	for (const w of globalPlainWatches) globalWatchesByName.set(w.target, compiledGlobalWatchFns[w.target]);

	// `online` es aditivo — expone TAMBIÉN a otros servidores, no
	// sustituye el comportamiento normal de función: una `online
	// function` (propia de este .wsb, o importada de un .ws) se fusiona
	// aquí en el mismo `importBindings` que usa todo lo demás, así que se
	// puede llamar en local exactamente igual que a cualquier otra
	// function (desde un watch(), o desde otra function) — además de
	// estar disponible por RPC para otros servidores. Antes de esto, una
	// `online function` era invisible para cualquier watch()/function del
	// MISMO servidor que la declaraba: ni compilaba (watch(), que sí
	// comprueba referencias no declaradas) ni funcionaba en tiempo de
	// ejecución (function normal, que no lo comprueba y solo fallaba al
	// llamarla de verdad, con un ReferenceError).
	const onlineFunctions = extractOnlineFunctions(expandedAst, baseDir, compiledOwn, compiledWsFiles);
	for (const f of onlineFunctions) importBindings[f.name] = f.fn;

	importBindings.__wsq = __wsq;
	const importNames = Object.keys(importBindings);
	const importValues = importNames.map((n) => importBindings[n]);

	const sessionStore = createSessionStore(sessionOnlyDecls, wconfig, sessionBaseDir || baseDir);

	// Todo nombre que tiene su propio watch() (ruta, reactive de sesión, o
	// reactive global) — una asignación a cualquiera de ellos, en el
	// cuerpo de CUALQUIER watch()/function, lleva su disparo inyectado
	// automáticamente. Dos grupos, nunca mezclados: sesión (`serverState.`
	// -> `__trigger`) y global (`getGlobalState().` -> `__triggerGlobal`)
	// — dispara uno u otro según de qué tipo sea CADA reactive, nunca los
	// dos para la misma.
	const sessionWatchedNames = new Set([...listeners.map((l) => l.reactiveName), ...plainWatches.map((w) => w.target)]);
	const triggerGroups = [
		{ names: sessionWatchedNames, prefix: "serverState.", triggerFn: "__trigger" },
		{ names: globalWatchedNames, prefix: "getGlobalState().", triggerFn: "__triggerGlobal" },
	];
	// Cualquier import (incluidas las function propias del .wsb, ya
	// fusionadas en importBindings) es candidato a "await implícito" si
	// se llama como identificador suelto — mismo mecanismo que ya usan
	// las propias function entre sí (compileFunctionBatch).
	const knownFunctionNames = new Set(importNames);

	const compiledPlainWatches = plainWatches.map((w) => ({
		target: w.target,
		fn: compileWatchFunction(
			[reactiveArgName(w.target), "WSON", "serverState", "getGlobalState", "__triggerGlobal", ...importNames],
			injectAsyncTriggers(genHandlerBody(w, stateNames, knownFunctionNames, globalNames), triggerGroups),
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
			[reactiveArgName(l.reactiveName), "WSON", "serverState", "getGlobalState", "__triggerGlobal", ...importNames],
			injectAsyncTriggers(genHandlerBody(l.watch, stateNames, knownFunctionNames, globalNames), triggerGroups),
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
			// el nombre de la reactive — los métodos WSON.* actúan sobre este
			// mismo objeto. Sin httpCode mutable: el código de estado se pasa
			// como argumento explícito a WSON.httpSend(peticion, httpCode).
			const peticion = {
				to: match.wson.to,
				via: match.wson.via,
				content: parsed.content,
				from: parsed.from,
				id: parsed.id,
				signatureValid,
				_params: params,
				_query: query,
				_secret: match.wson.secret,
				_encrypt: match.wson.encrypt,
				_sent: false,
			};

			// `WSON.httpParams`/`WSON.httpQuery` llegan gratis vía `...WSON`
			// (wson-runtime.js): son genéricas, leen `_params`/`_query` de
			// CUALQUIER instancia, y devuelven `null` si no los hay — no hace
			// falta redefinirlas aquí. `WSON.showContent`/`WSON.httpSend` SÍ
			// necesitan resolver contra el `peticion` de ESTA petición en
			// concreto (secret/encrypt de la ruta, res/sessionStore/sessionId
			// de este cierre) — se exponen como funciones de ámbito local con
			// esos nombres fijos, ya que el handler generado los llama tal
			// cual. Nótese que `WSON.send` NO se sobreescribe aquí: dentro de
			// un watch() de ruta, `WSON.send(x)` sigue siendo el envío
			// SALIENTE de siempre (heredado de `...WSON`) — antes este mismo
			// nombre se usaba, de forma confusa, para las dos cosas a la vez.
			const localWSON = {
				...WSON,
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
				// `httpSend` responde la petición HTTP entrante — no devuelve
				// nada (a diferencia de `WSON.send`, que siempre devuelve la
				// respuesta de la llamada saliente que hizo). El código de
				// estado es un argumento explícito, no una propiedad mutable
				// del WSON (`httpCode` ya no existe como campo).
				httpSend: async (inst, httpCode) => {
					inst._sent = true;
					await sessionStore.save(sessionId, session); // antes de responder: si el proceso muere justo después (o el guardado es a través de la red, como Redis), la sesión ya está a salvo
					res.writeHead(httpCode || 200, { "Content-Type": "application/json" });
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
				//
				// Mismas dos guardas que __triggerGlobal (ver ese
				// comentario para el razonamiento completo), aquí con
				// alcance de UNA SOLA petición — nuevas en cada una, sin
				// arrastrar nada de la anterior: no cambiar si el valor es
				// igual al último disparo YA ATENDIDO en esta petición, y
				// un límite de profundidad como red de seguridad.
				const asyncWatchersByName = new Map(compiledPlainWatches.map((cw) => [cw.target, cw.fn]));
				const sessionLastTriggeredValues = new Map();
				let sessionTriggerDepth = 0;
				const SESSION_TRIGGER_MAX_DEPTH = 50;
				let reactiveState;
				const __trigger = async (name) => {
					const fn = asyncWatchersByName.get(name);
					if (!fn) return;
					const current = reactiveState[name];
					if (sessionLastTriggeredValues.has(name) && sessionLastTriggeredValues.get(name) === current) return;
					sessionLastTriggeredValues.set(name, current);
					if (sessionTriggerDepth >= SESSION_TRIGGER_MAX_DEPTH) {
						console.error(
							`watch("${name}"): posible bucle — se superaron ${SESSION_TRIGGER_MAX_DEPTH} disparos en cascada sin converger (cada disparo reasigna un valor DISTINTO al anterior; revisa si el propio watch() necesita una condición de parada).`
						);
						return;
					}
					sessionTriggerDepth++;
					try {
						await fn(reactiveState[name], WSON, reactiveState, getGlobalState, __triggerGlobal, ...importValues, __trigger);
					} catch (err) {
						// Un watch() en cascada que falla no debe tumbar
						// la petición que lo disparó — ya puede estar
						// respondida, o ser de una reactive distinta.
						console.error(`Error en watch("${name}"):`, err && err.message);
					} finally {
						sessionTriggerDepth--;
					}
				};
				reactiveState = wrapReactiveState(session.state, sessionTypeSchema);

				const result = handler(peticion, localWSON, reactiveState, getGlobalState, __triggerGlobal, ...importValues, __trigger);
				await Promise.resolve(result);
				if (!peticion._sent) {
					await sessionStore.save(sessionId, session); // idem: antes de responder
					res.writeHead(200, { "Content-Type": "application/json" }); // sin WSON.httpSend() explícito: 200 por defecto, como siempre
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
	// Expuesto para que createServer() pueda enganchar el "upgrade" del
	// http.Server real si hay alguna online function que servir — este
	// nivel (createRequestHandler) no tiene acceso al servidor en sí.
	requestHandler.onlineFunctions = onlineFunctions;
	// Lo mismo, para que createServer() pueda enganchar el mismo
	// "upgrade" cuando hay alguna `shared global reactive` que servir,
	// incluso sin ninguna `online function` — son dos motivos
	// independientes para necesitar el mismo WebSocket.
	requestHandler.sharedGlobalReactives = {
		names: sharedGlobalNames,
		getGlobalState,
		triggerGlobal: __triggerGlobal,
		subscribers: sharedSubscribers,
	};

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

	if (handler.onlineFunctions.length > 0 || handler.sharedGlobalReactives.names.size > 0) {
		server.onlineFunctionsRpc = wireWebSocketProtocol(server, handler.onlineFunctions, handler.sharedGlobalReactives);
	}
	return server;
}

// --- Un único WebSocket por servidor, dos protocolos sobre él -------------
//
// `online function` (llamada/respuesta) y `shared global reactive`
// (suscripción/empuje) comparten la MISMA conexión — un mensaje JSON de
// texto con su propio `type` decide a cuál de los dos pertenece. Mensajes,
// en los dos sentidos:
//
//   { type: "reflect" }
//     -> { type: "reflect", functions: [{ name, params, idempotent }] }
//   { type: "call", id, name, args, idempotencyKey? }
//     -> { type: "result", id, value } | { type: "error", id, message }
//   { type: "subscribe", name }
//     -> { type: "update", name, value }   (inmediato, con el valor actual,
//                                            y de nuevo cada vez que cambie)
//   { type: "propose", name, value }
//     -> (nada directamente — si se acepta, llega como un "update" más,
//         igual que a cualquier otro suscrito; ver DISEÑO.md, "shared
//         reactive": el servidor nunca confirma la propuesta en sí, solo
//         difunde el valor real una vez aplicado)
//
// `id` lo pone quien llama y se devuelve tal cual — permite tener varias
// llamadas en curso a la vez sobre la MISMA conexión sin confundir sus
// respuestas (un WSClient real hará varias llamadas concurrentes).
//
// La caché de idempotencia es del SERVIDOR entero (no por conexión): si el
// cliente se reconecta y repite la misma idempotencyKey, tiene que
// encontrar el mismo resultado — es la razón de ser de la clave. Aplica a
// CUALQUIER llamada que la incluya, sin mirar si la función se declaró
// "-> idempotent": el mecanismo (no repetir la ejecución, devolver lo ya
// resuelto) funciona igual en los dos casos — "-> idempotent" es la
// promesa hacia quien llama de que repetir es seguro, no una condición
// para que la caché en sí funcione. Es solo en memoria por ahora — se
// pierde si el proceso se reinicia; ver limitaciones en INSTRUCCIONES.md.
function wireWebSocketProtocol(server, onlineFunctions, sharedGlobalReactives) {
	const byName = new Map(onlineFunctions.map((f) => [f.name, f]));
	const idempotencyCache = new Map(); // key -> { status: "pending"|"done"|"error", value?, error? }
	const { names: sharedNames, getGlobalState, subscribers } = sharedGlobalReactives;

	server.on("upgrade", (req, socket, head) => {
		const ws = acceptUpgrade(req, socket, head);
		if (!ws) return;
		ws.parser.on("error", () => {}); // un mensaje mal formado cierra ESTA conexión, no debe tumbar nada más
		ws.parser.on("message", (msg) => onRpcMessage(ws, msg).catch(() => ws.socket.destroy()));
		// Al cerrarse la conexión, se quita de CUALQUIER lista de
		// suscriptores en la que estuviera — sin esto, una conexión
		// muerta se quedaría para siempre en `subscribers`, acumulando
		// (una fuga de memoria) y gastando intentos de envío que fallan
		// en silencio en cada difusión futura.
		ws.socket.on("close", () => {
			for (const subs of subscribers.values()) subs.delete(ws);
		});
	});

	async function onRpcMessage(ws, msg) {
		if (msg.opcode !== OPCODE.TEXT) return;
		let request;
		try {
			request = JSON.parse(msg.text);
		} catch {
			return; // no es JSON — se ignora, no es motivo para cortar la conexión
		}

		if (request.type === "reflect") {
			ws.send(JSON.stringify({ type: "reflect", functions: onlineFunctions.map((f) => ({ name: f.name, params: f.params, idempotent: f.idempotent })) }));
			return;
		}

		if (request.type === "subscribe") {
			const { name } = request;
			// Un nombre que no es ninguna `shared global reactive` de
			// este servidor se ignora, sin más — no es un error de
			// protocolo grave (podría ser una versión distinta del
			// cliente, o un nombre mal escrito), solo no hay nada que
			// suscribir.
			if (!sharedNames.has(name)) return;
			if (!subscribers.has(name)) subscribers.set(name, new Set());
			subscribers.get(name).add(ws);
			// El valor ACTUAL se manda de inmediato, sin esperar al
			// siguiente cambio — quien se suscribe tarde no debe quedarse
			// a ciegas hasta que algo cambie por su cuenta.
			ws.send(JSON.stringify({ type: "update", name, value: getGlobalState()[name] }));
			return;
		}

		if (request.type === "propose") {
			const { name, value } = request;
			if (!sharedNames.has(name)) return;
			// El cliente nunca muta la reactive directamente — propone, y
			// es el SERVIDOR quien reasigna de verdad. Esa reasignación
			// real es la que dispara `watch()` (si lo hay, con sus
			// guardas contra bucle — ver DISEÑO.md) y la difusión a los
			// demás suscritos — el mismo camino que cualquier otra
			// reasignación de esa reactive, venga de donde venga. Si
			// `watch()` corrige el valor, lo que se difunde es el YA
			// corregido, nunca el propuesto tal cual.
			getGlobalState()[name] = value;
			await sharedGlobalReactives.triggerGlobal(name);
			return;
		}

		if (request.type !== "call") return;
		const { id, name, args, idempotencyKey } = request;
		const respond = (payload) => ws.send(JSON.stringify({ id, ...payload }));

		if (idempotencyKey) {
			const cached = idempotencyCache.get(idempotencyKey);
			if (cached) {
				if (cached.status === "pending") {
					respond({ type: "error", message: `ya hay una llamada en curso con la idempotencyKey "${idempotencyKey}"` });
				} else if (cached.status === "done") {
					respond({ type: "result", value: cached.value });
				} else {
					respond({ type: "error", message: cached.error });
				}
				return;
			}
			idempotencyCache.set(idempotencyKey, { status: "pending" });
		}

		const target = byName.get(name);
		if (!target) {
			const message = `no existe ninguna "online function ${name}"`;
			if (idempotencyKey) idempotencyCache.set(idempotencyKey, { status: "error", error: message });
			respond({ type: "error", message });
			return;
		}

		try {
			const value = await target.fn(...(Array.isArray(args) ? args : []));
			if (idempotencyKey) idempotencyCache.set(idempotencyKey, { status: "done", value });
			respond({ type: "result", value });
		} catch (err) {
			if (idempotencyKey) idempotencyCache.set(idempotencyKey, { status: "error", error: err.message });
			respond({ type: "error", message: err.message });
		}
	}

	return { idempotencyCache, onlineFunctions };
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
	substituteServerState,
	extractOnlineFunctions,
	wireWebSocketProtocol,
	injectAwaitForKnownCalls,
	compileFunctionBatch,
};
