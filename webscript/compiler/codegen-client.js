// codegen-client.js — WebScript, v0
//
// Genera JS de cliente ejecutable a partir del AST de un .wsf "page".
//
// LIMITACIONES DE ESTA VERSIÓN (deliberadas, no descuidos):
// - `for` reconstruye la lista entera en cada cambio — sin el diffing por
//   clave que sí está en el diseño (DISEÑO.md).
// - Solo un nivel de "slot" por nombre — si el mismo `<slot name="x">`
//   aparece más de una vez en la plantilla del hijo, el contenido pasado
//   se consume (se mueve) en el primero y los demás quedan vacíos, porque
//   es un DocumentFragment y no una copia.
// - Import de `.wsb` no soportado desde el cliente (no tendría sentido:
//   un `.wsb` es lógica de servidor, no algo que se ejecute en navegador).

const fs = require("fs");
const { findImplicitPageTarget } = require("./codegen");
const { genDtoClassSource } = require("./codegen-dto");
const path = require("path");
const { resolveImportPath, isPackageSpecifier } = require("./resolve-imports");

const RUNTIME_SOURCE = fs.readFileSync(path.join(__dirname, "runtime.js"), "utf8");

let tempCounter = 0;
function uniq(prefix) {
	tempCounter += 1;
	return `${prefix}${tempCounter}`;
}

function jsString(s) {
	return JSON.stringify(s);
}

function unquote(raw) {
	return raw.replace(/^["']|["']$/g, "");
}

// Sustituye identificadores reactive por state.NOMBRE — con límite de
// palabra y sin tocar accesos de propiedad (obj.nombre no se toca aunque
// "nombre" sea una reactive, porque ahí "nombre" es una clave, no la
// variable global).
function substituteReactive(expr, reactiveNames) {
	let out = expr;
	for (const name of reactiveNames) {
		// No sustituir si es una CLAVE de objeto literal ({ nombre: ... } o
		// , nombre: ...) — solo el valor debe convertirse en state.nombre,
		// la clave se queda tal cual. Tampoco si ya es un acceso a
		// propiedad de otra cosa (`algo.nombre`) — pero ojo: la exclusión
		// debe mirar "letra+punto" (`\w\.`), NO "cualquier punto", porque
		// el operador de propagación (`...nombre`) también termina en un
		// punto justo antes del nombre — con "cualquier punto" como
		// exclusión, `{ ...cursores }` nunca se sustituía (bug real,
		// encontrado al usar una `shared reactive` dentro de un spread:
		// `{ ...cursores, x: 1 }`).
		const re = new RegExp(`(?<!\\w\\.)(?<![{,]\\s{0,20})\\b${name}\\b(?!\\s{0,20}:)`, "g");
		out = out.replace(re, `state.${name}`);
	}
	return out;
}

// El cliente nunca muta una `shared global reactive` directamente — una
// asignación simple (`state.nombre = EXPR;`, ya reescrita por
// `substituteReactive` desde `nombre = EXPR`) se convierte en una llamada a
// `__proposeShared`, que manda la propuesta al servidor en vez de tocar
// `state`. Deliberadamente por TEXTO, sobre el bundle ya ensamblado entero
// (ver el comentario en `generateClientBundle`, donde se llama) — cubre
// cualquier sitio donde pueda aparecer la asignación (atributos, eventos,
// cuerpos de function) sin tener que tocar cada punto de compilación por
// separado. Solo `=` simple; un operador compuesto (`+=`, `++`...) queda
// sin cubrir — limitación conocida, ver DISEÑO.md.
function rewriteSharedAssignments(text, sharedNames) {
	let out = text;
	for (const name of sharedNames) {
		const re = new RegExp(`\\bstate\\.${name}\\s*=(?!=)\\s*([^;]+);`, "g");
		out = out.replace(re, (_match, expr) => `__proposeShared(${JSON.stringify(name)}, (${expr}));`);
	}
	return out;
}

// Agrupa una lista de hijos: cada `If` arrastra sus `ElseIf`/`Else`
// siguientes en un único grupo (un solo anchor, un solo effect) — si no,
// cada rama se trataría como un bloque reactivo independiente y todas se
// re-evaluarían y pintarían a la vez.
function groupChildren(children) {
	const groups = [];
	let i = 0;
	while (i < children.length) {
		const node = children[i];
		if (node.type === "If") {
			const chain = [node];
			i += 1;
			while (i < children.length && (children[i].type === "ElseIf" || children[i].type === "Else")) {
				chain.push(children[i]);
				const wasElse = children[i].type === "Else";
				i += 1;
				if (wasElse) break;
			}
			groups.push({ type: "IfChain", chain });
		} else {
			groups.push(node);
			i += 1;
		}
	}
	return groups;
}

// Separa el texto de un tag en partes literales e interpolaciones {expr},
// respetando llaves anidadas — igual criterio que el resto del compilador.
function splitInterpolations(text) {
	const parts = [];
	let i = 0;
	while (i < text.length) {
		const start = text.indexOf("{", i);
		if (start === -1) {
			parts.push({ literal: text.slice(i) });
			break;
		}
		if (start > i) parts.push({ literal: text.slice(i, start) });

		let depth = 1;
		let j = start + 1;
		while (j < text.length && depth > 0) {
			if (text[j] === "{") depth += 1;
			else if (text[j] === "}") depth -= 1;
			j += 1;
		}
		parts.push({ expr: text.slice(start + 1, j - 1) });
		i = j;
	}
	return parts;
}

// Contenido pasado entre <componente>...</componente>, agrupado por a qué
// slot va: un Element de nivel superior con atributo slot="nombre" va a
// ese hueco; cualquier otra cosa (con o sin ese atributo) va a "default".
function groupSlotContent(children) {
	const groups = { default: [] };
	for (const child of children) {
		let slotName = "default";
		if (child.type === "Element") {
			const slotAttr = (child.attrs || []).find((a) => a.key === "slot");
			if (slotAttr && slotAttr.value) slotName = unquote(slotAttr.value);
		}
		if (!groups[slotName]) groups[slotName] = [];
		groups[slotName].push(child);
	}
	return groups;
}

// Traduce una sentencia de una función de `.ws` a JS real — mismo criterio
// que codegen-server.js (la mayoría ya es JS casi literal), pero aquí las
// reactive globales sí se sustituyen por `state.NOMBRE` (una función de
// `.ws` puede leerlas, a diferencia de un handler de servidor).
function genFunctionStatement(node, reactiveNames) {
	if (node.type === "VarDecl" || node.type === "ConstDecl") {
		return `${node.type === "ConstDecl" ? "const" : "let"} ${node.name} = ${substituteReactive(node.expr, reactiveNames)};`;
	}
	if (node.type === "Raw") return `${substituteReactive(node.text, reactiveNames)};`;
	if (node.type === "If" || node.type === "ElseIf") {
		const inner = (node.body || []).map((n) => genFunctionStatement(n, reactiveNames)).join("\n");
		return `${node.type === "If" ? "if" : "else if"} (${substituteReactive(node.cond, reactiveNames)}) {\n${inner}\n}`;
	}
	if (node.type === "Else") {
		const inner = (node.body || []).map((n) => genFunctionStatement(n, reactiveNames)).join("\n");
		return `else {\n${inner}\n}`;
	}
	return `// TODO codegen-client: sentencia no reconocida (${node.type})`;
}

function genFunctionSource(fnNode, reactiveNames) {
	const paramNames = (fnNode.params || []).map((p) => p.name);
	const body = (fnNode.body || []).map((n) => genFunctionStatement(n, reactiveNames)).join("\n");
	return `function ${fnNode.name}(${paramNames.join(", ")}) {\n${body}\n}`;
}

// --- Lo que un .wsf trae por `import` (bundle de cliente, SSR y build) ---
//
// Componentes de otro .wsf (sus VisualDecl se añaden al bundle), y
// function/reactive/const de un .ws (se traducen a JS real e inyectan
// también), clases de un .wson, módulos .js y datos .json.
//
// DIFERENCIA CLAVE CON EL SERVIDOR: allí cada .ws tiene su ámbito de imports
// privado (ver codegen-server.js); aquí el bundle es UN ÚNICO TEXTO con UN
// ÚNICO ÁMBITO — todo lo que se trae (function, const/var, clases, módulos
// .js) queda al mismo nivel y se resuelve por nombre. Por eso, dos
// declaraciones con el mismo nombre se pisarían: cuando una de ellas viene
// de un .ws se detecta y se da un error que nombra los dos ficheros, en vez
// de dejar que una gane en silencio (ver `claimName`).
//
// El trabajo es DIRIGIDO POR DEMANDA para los .ws: pedir una function de un
// .ws trae esa function y lo que ELLA referencia (otras function del mismo
// fichero, y los nombres que ese .ws importa) de forma transitiva — no todos
// los imports del fichero. Así un .ws mixto (una function que usa un .wsdb,
// solo de servidor, y otra apta para el navegador) sigue funcionando en el
// cliente mientras solo se pida la segunda. Antes no se seguía NINGÚN import
// de un .ws (una function que llamaba a un helper del mismo fichero, o a algo
// importado, daba `X is not defined` en el navegador), y un segundo `import`
// del mismo fichero perdía sus nombres (`visited` lo saltaba entero).

const ROOT_ORIGIN = "<este .wsf>";

// Nombre interno del HTML suelto de una página (PageDecl) una vez se trata
// como una `visual` más — ver generateClientBundle. Un `visual` real nunca
// puede llamarse así (los nombres de `visual` son identificadores válidos
// de WebScript, y `__page__` no lo es como palabra escrita a mano en el
// fichero), así que no hay colisión posible con algo que el usuario escriba.
const PAGE_DECL_NAME = "__page__";

function createCollectState(rootDir) {
	return {
		rootDir,
		// Ficheros cuyo trabajo "de fichero" (reactive, const/var, componentes...)
		// ya se hizo. Antes `visited`, que además saltaba los NOMBRES de un
		// segundo import del mismo fichero.
		files: new Set(),
		// "ruta::nombre" ya traídos: un mismo nombre pedido desde varias líneas
		// de import (o desde varios ficheros) se trae UNA sola vez.
		requested: new Set(),
		// ruta de .js -> id del módulo embebido (global al recorrido; antes era
		// el nº de módulos de cada resultado parcial, y dos recorridos anidados
		// podían generar el mismo id).
		jsModuleIds: new Map(),
		// ruta de .ws -> análisis (parseado una sola vez)
		wsFiles: new Map(),
		// nombre -> { origin, fromWs }, para detectar colisiones
		claimed: new Map(),
	};
}

function describeOrigin(state, origin) {
	if (origin === ROOT_ORIGIN) return "este .wsf";
	return path.relative(state.rootDir, origin) || origin;
}

// Reserva `name` para `origin`. Pedirlo otra vez desde el mismo origen es
// normal (varias rutas hasta el mismo fichero, diamante) y no es una
// colisión. Cualquier otro caso de origen distinto SÍ lo es — antes, entre
// dos `.wsf` (dos componentes, o un componente y la propia página), no se
// comprobaba: una function/const con el mismo nombre en dos componentes se
// pisaba en silencio, sin aviso, y cuál "ganaba" dependía del orden de los
// imports (confirmado con código: dos componentes con un `fmt` cada uno,
// el segundo importado siempre ganaba, en cliente Y en SSR, para AMBOS
// componentes — no solo para el que lo declaró). Mismo criterio que ya
// tenía la colisión con un `.ws`: preferible un error claro, que nombra
// los dos ficheros, a un pisado silencioso.
function claimName(state, name, origin, fromWs) {
	const prev = state.claimed.get(name);
	if (!prev) {
		state.claimed.set(name, { origin, fromWs });
		return;
	}
	if (prev.origin === origin) return;
	throw new Error(
		`"${name}" lo declaran a la vez ${describeOrigin(state, prev.origin)} y ${describeOrigin(state, origin)}: ` +
			"el bundle de cliente es un único ámbito compartido (a diferencia del servidor, donde cada .ws tiene el suyo), " +
			"así que dos declaraciones con el mismo nombre se pisarían — renombra una de las dos."
	);
}

// Nombres de `candidates` que aparecen REFERENCIADOS en alguno de los
// fragmentos de JS. Sobrestima a propósito (un local que se llame igual que
// un candidato cuenta): traer de más solo es una función sin usar; traer de
// menos sería un `X is not defined` en el navegador. Sí ignora las
// propiedades (`obj.nombre`, `{ nombre: 1 }`) y las declaraciones. Si un
// fragmento no se puede parsear, se escanea por palabra (también
// sobrestimando).
function referencedNames(snippets, candidates) {
	const found = new Set();
	if (candidates.size === 0) return found;
	let acorn = null;
	let walk = null;
	try {
		acorn = require("acorn");
		walk = require("acorn-walk");
	} catch {
		// sin acorn: solo escaneo por palabra
	}
	for (const snippet of snippets) {
		let tree = null;
		if (acorn) {
			try {
				tree = acorn.parse(snippet, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true });
			} catch {
				tree = null;
			}
		}
		if (!tree) {
			for (const c of candidates) {
				if (new RegExp(`(?<![.\\w$])${c.replace(/\$/g, "\\$")}(?![\\w$])`).test(snippet)) found.add(c);
			}
			continue;
		}
		walk.ancestor(tree, {
			Identifier(node, _state, ancestors) {
				if (!candidates.has(node.name)) return;
				const parent = ancestors[ancestors.length - 2];
				if (parent && parent.type === "MemberExpression" && parent.property === node && !parent.computed) return;
				if (parent && parent.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand) return;
				found.add(node.name);
			},
		});
	}
	return found;
}

function emptyPieces() {
	return {
		reactiveInits: [],
		functionSources: [],
		visualDecls: [],
		styleNames: [],
		topLevelInits: [],
		classSources: [],
		jsModuleSources: [],
		sharedWsbReactives: [],
	};
}

// Análisis de un .ws, hecho una sola vez por recorrido.
function loadClientWs(state, targetPath) {
	const cached = state.wsFiles.get(targetPath);
	if (cached) return cached;
	const { parse } = require("./parser");
	const ast = parse(fs.readFileSync(targetPath, "utf8"));
	const declaredByName = new Map();
	const fnByName = new Map();
	const visualByName = new Map();
	for (const n of ast.body) {
		const d = n.type === "Export" ? n.declaration : n;
		if (!d || !d.name) continue;
		if (!declaredByName.has(d.name)) declaredByName.set(d.name, d);
		if (d.type === "FunctionDecl" && !fnByName.has(d.name)) fnByName.set(d.name, d);
		if (d.type === "VisualDecl" && !visualByName.has(d.name)) visualByName.set(d.name, d);
	}
	const importBindings = new Map(); // nombre local -> nodo Import que lo trae
	for (const n of ast.body) {
		if (n.type !== "Import") continue;
		for (const nm of n.names) importBindings.set(nm, n);
	}
	// Declaraciones de nivel superior con el `export` desenvuelto: el AST guarda
	// `export const X` / `export reactive X` como un nodo Export que envuelve la
	// declaración, y filtrar `ast.body` por tipo se las saltaba — una constante
	// o reactive EXPORTADA de un .ws no llegaba nunca al bundle (solo las que no
	// llevaban `export`), y las function de ese .ws que la usaban daban `X is
	// not defined` en el navegador.
	const topDecls = ast.body.map((n) => (n.type === "Export" ? n.declaration : n)).filter(Boolean);
	const ws = { path: targetPath, dir: path.dirname(targetPath), ast, declaredByName, fnByName, visualByName, importBindings, topDecls };
	state.wsFiles.set(targetPath, ws);
	return ws;
}

// Un identificador referenciado desde dentro de un .ws: o es otra function
// del mismo fichero, o es algo que ese .ws importa (y entonces se le pide a
// su fichero de origen, solo ese nombre).
function demandFromWs(state, result, ws, id) {
	if (ws.fnByName.has(id)) {
		requestWsFunction(state, result, ws, id);
	} else if (ws.visualByName.has(id)) {
		requestWsVisual(state, result, ws, id);
	} else if (ws.importBindings.has(id)) {
		const importNode = ws.importBindings.get(id);
		processImport(state, result, importNode, ws.dir, [id], { isWs: true, label: path.relative(state.rootDir, ws.path) });
	}
}

function wsCandidateNames(ws) {
	return new Set([...ws.fnByName.keys(), ...ws.visualByName.keys(), ...ws.importBindings.keys()]);
}

// Trae la `visual nombre = ` de un .ws (una página o un componente puede
// importarla como si fuera de un .wsf — mismo mecanismo, sin `export`
// tampoco aquí: ninguna visual, de un .ws o de un .wsf, lo necesita para
// ser importable por nombre) y, de forma transitiva, lo que su propia
// plantilla referencia (otra function/const/visual del MISMO .ws, o algo
// que ese .ws importa) — igual que ya hace `requestWsFunction` con el
// cuerpo de una function. El análisis de referencias es deliberadamente
// por texto (el árbol HTML no es una expresión JS parseable de un tirón),
// igual de conservador que en el resto del análisis de referencias de este
// fichero: sobrestima (trae de más) antes que dejar algo sin resolver.
function requestWsVisual(state, result, ws, name) {
	const key = `${ws.path}::visual::${name}`;
	if (state.requested.has(key)) return;
	state.requested.add(key);
	const visual = ws.visualByName.get(name);
	result.visualDecls.push(visual);
	// Escaneo por palabra DIRECTO, sin pasar por `referencedNames` (que
	// intenta `acorn` primero): el árbol HTML convertido a texto con
	// `JSON.stringify` PARSEA como JS válido (es, literalmente, un array de
	// objetos) — así que `acorn` lo acepta sin más, y el recorrido de
	// identificadores nunca encuentra los nombres reales, porque están
	// dentro de STRINGS (el valor de un nodo Text), no como sintaxis JS de
	// verdad. `acorn` nunca "falla" aquí, así que el escaneo por palabra de
	// reserva nunca se activaba — confirmado con una reproducción real
	// antes de corregirlo.
	const text = JSON.stringify(visual.html);
	for (const candidate of wsCandidateNames(ws)) {
		if (candidate !== name && new RegExp(`\\b${candidate}\\b`).test(text)) demandFromWs(state, result, ws, candidate);
	}
}

// Trae la function `name` de un .ws y, de forma transitiva, todo lo que ella
// referencia (ver el comentario de arriba).
function requestWsFunction(state, result, ws, name) {
	const key = `${ws.path}::${name}`;
	if (state.requested.has(key)) return;
	state.requested.add(key);
	const node = ws.fnByName.get(name);
	claimName(state, name, ws.path, true);
	result.functionSources.push({ node });
	for (const ref of referencedNames([genFunctionSource(node, [])], wsCandidateNames(ws))) {
		if (ref !== name) demandFromWs(state, result, ws, ref);
	}
}

// Lo que se trae de un .ws al visitarlo por primera vez, se pida lo que se
// pida: TODAS sus reactive y const/var (como siempre — pueden ser estado
// compartido que las function usan sin nombrarlo en el import). Como se
// emiten sin condición, lo que ELLAS referencian también se trae, y antes
// que ellas (las const se evalúan en orden).
function collectWsFileLevel(state, result, ws) {
	const reactives = ws.topDecls.filter((n) => n.type === "ReactiveDecl");
	const consts = ws.topDecls.filter((n) => n.type === "ConstDecl" || n.type === "VarDecl");
	const snippets = [...reactives.map((r) => `void (${r.expr});`), ...consts.map((c) => genFunctionStatement(c, []))];
	for (const ref of referencedNames(snippets, wsCandidateNames(ws))) demandFromWs(state, result, ws, ref);

	result.reactiveInits.push(...reactives.map((n) => ({ name: n.name, expr: n.expr, varType: n.varType })));
	for (const c of consts) {
		for (const bound of extractBoundNames(c.name)) claimName(state, bound, ws.path, true);
	}
	result.topLevelInits.push(...consts);
}

// Procesa un nodo Import pidiendo SOLO los `names` indicados. Para un .wsf o
// la raíz son todos los del import; para un .ws son los que su código
// alcanza (ver requestWsFunction).
function processImport(state, result, node, baseDir, names, importer) {
	const { parse } = require("./parser");
	const where = importer.label ? `${importer.label}: ` : "";

	if (isPackageSpecifier(node.from)) {
		// A diferencia del servidor (donde esto es un require() real,
		// sin riesgo), aquí no hay ningún bundler que resuelva las
		// propias dependencias del paquete — incrustar su código a
		// ciegas podría producir un bundle roto de formas difíciles de
		// prever. Se rechaza con un mensaje claro, no en silencio.
		throw new Error(
			`${where}No se puede importar el paquete "${node.from}" desde el cliente: no hay un bundler que resuelva sus propias dependencias (sí funciona en servidor, desde un .wsb). Si es código propio sin dependencias externas, usa una ruta relativa a un .js en su lugar.`
		);
	}

	const targetPath = resolveImportPath(baseDir, node.from);
	if (!targetPath) {
		throw new Error(`${where}No se pudo resolver el import "${node.from}" (buscado desde ${baseDir})`);
	}
	const firstVisit = !state.files.has(targetPath);
	state.files.add(targetPath);
	const fromWs = importer.isWs;

	// "ruta::nombre" -> true la primera vez que se pide; false si ya estaba.
	const first = (name) => {
		const key = `${targetPath}::${name}`;
		if (state.requested.has(key)) return false;
		state.requested.add(key);
		return true;
	};

	if (targetPath.endsWith(".js")) {
		// JS normal ya existente, sin sus propias dependencias externas
		// — vía de adopción incremental: meter WebScript fichero a
		// fichero en un proyecto Node ya existente. Se incrusta su
		// código fuente tal cual, envuelto en un módulo CommonJS
		// aislado (module.exports/exports) — si ese .js a su vez
		// importara/requiriera otra cosa, eso NO se resuelve aquí (sin
		// bundler, solo se admite un fichero suelto).
		let moduleId = state.jsModuleIds.get(targetPath);
		if (!moduleId) {
			moduleId = `__jsmod_${state.jsModuleIds.size}`;
			state.jsModuleIds.set(targetPath, moduleId);
			const jsSource = fs.readFileSync(targetPath, "utf8");
			result.jsModuleSources.push(
				`const ${moduleId} = (function () {\n  const module = { exports: {} };\n  const exports = module.exports;\n${jsSource}\n  return module.exports;\n})();`
			);
		}
		if (node.isDefault) {
			const name = node.names[0];
			if (first(name)) {
				claimName(state, name, targetPath, fromWs);
				result.topLevelInits.push({ type: "ConstDecl", varType: null, name, expr: moduleId });
			}
		} else {
			for (const name of names) {
				if (!first(name)) continue;
				claimName(state, name, targetPath, fromWs);
				result.topLevelInits.push({ type: "ConstDecl", varType: null, name, expr: `${moduleId}.${name}` });
			}
		}
		return;
	}

	if (targetPath.endsWith(".wsdb")) {
		// Una base de datos es, por definición, algo del servidor — no
		// hay forma segura ni con sentido de que el navegador hable con
		// SQLite directamente. Mismo criterio que un paquete de npm:
		// rechazo explícito, con mensaje claro, no un error genérico.
		throw new Error(
			`${where}No se puede importar "${node.from}" desde el cliente: un .wsdb es una base de datos, solo tiene sentido en el servidor (desde un .wsb).`
		);
	}

	if (targetPath.endsWith(".wsb")) {
		// Un .wsb es lógica de servidor — nada de él tiene sentido en el
		// navegador, CON UNA ÚNICA EXCEPCIÓN DELIBERADA: una `reactive`
		// (o `global reactive`) marcada `shared` puede cruzar esta
		// frontera, porque es justo para lo que existe esa marca — un
		// valor de servidor que se sigue en vivo desde un `.wsf`, con
		// suscripción y actualización por WebSocket (ver DISEÑO.md,
		// "`shared reactive`"). Cualquier otra cosa del `.wsb` (una
		// function, una `reactive` normal sin `shared`, una `const`...)
		// sigue bloqueada — ahora con un motivo específico en vez del
		// rechazo genérico de antes, que no distinguía nada.
		const targetAst = parse(fs.readFileSync(targetPath, "utf8"));
		const declaredByName = new Map();
		for (const n of targetAst.body) {
			const d = n.type === "Export" ? n.declaration : n;
			if (d && d.name) declaredByName.set(d.name, d);
		}
		for (const name of names) {
			const decl = declaredByName.get(name);
			if (!decl) throw new Error(`${where}"${name}" no existe en ${targetPath}`);
			if (decl.type !== "ReactiveDecl" || !decl.shared) {
				throw new Error(
					`${where}"${name}" existe en ${targetPath}, pero no es una reactive "shared": solo una \`reactive\`/\`global reactive\` marcada \`shared\` se puede importar desde un .wsf — el resto de un .wsb (function, reactive normal, const...) es lógica de servidor, sin sentido en el navegador.`
				);
			}
			if (!first(name)) continue;
			claimName(state, name, targetPath, fromWs);
			result.sharedWsbReactives.push({ name, wsbPath: targetPath, global: decl.global, varType: decl.varType });
			// Se trata como cualquier otra reactive importada para LEER
			// (entra en `state`, por eso en `reactiveInits` con su mismo
			// valor inicial DECLARADO en el .wsb) — así `{cursores.x}` ya
			// funciona con la maquinaria de siempre, reactiva de verdad en
			// cuanto llegue un "update" real por WebSocket. ESCRIBIR es
			// aparte — ver `rewriteSharedAssignments`, más abajo: una
			// asignación a este nombre no debe mutar `state` en el
			// cliente, debe proponerse al servidor.
			result.reactiveInits.push({ name, expr: decl.expr, varType: decl.varType });
		}
		return;
	}

	if (targetPath.endsWith(".json")) {
		// El contenido de un .json es dato puro, conocido en tiempo de
		// compilación — se embebe como const literal (JSON válido es
		// JS válido), no como un import en tiempo de ejecución (el
		// bundle de cliente no tiene require()). `import posts from
		// "./posts.json"` liga el contenido entero a `posts`; `import
		// { campo } from "./datos.json"` liga solo esa propiedad.
		const jsonContent = JSON.parse(fs.readFileSync(targetPath, "utf8"));
		if (node.isDefault) {
			const name = node.names[0];
			if (first(name)) {
				claimName(state, name, targetPath, fromWs);
				result.topLevelInits.push({ type: "ConstDecl", varType: null, name, expr: JSON.stringify(jsonContent) });
			}
		} else {
			for (const name of names) {
				if (!first(name)) continue;
				claimName(state, name, targetPath, fromWs);
				result.topLevelInits.push({ type: "ConstDecl", varType: null, name, expr: JSON.stringify(jsonContent[name]) });
			}
		}
		return;
	}

	if (targetPath.endsWith(".wsf")) {
		if (!firstVisit) return;
		const targetAst = parse(fs.readFileSync(targetPath, "utf8"));
		// `export function`/`export const`/`export visual`/`export style`
		// dentro de un .wsf componente se parsean como un nodo Export que
		// ENVUELVE la declaración (igual que en un .ws — ver `topDecls` en
		// loadClientWs). Filtrar `targetAst.body` por tipo sin desenvolver
		// primero los saltaba enteros: una `export function fmt(x)` en un
		// componente importado era invisible, ni siquiera llegaba a
		// `claimName` — no "colisionaba en silencio", directamente NO
		// EXISTÍA, y una plantilla que la usara daba `fmt is not defined`
		// al renderizar (confirmado con código: sin `export` sí viajaba).
		const topDecls = targetAst.body.map((n) => (n.type === "Export" ? n.declaration : n)).filter(Boolean);

		// Primero sus propios imports (para que un componente que a su
		// vez use otro componente quede resuelto también).
		const nested = collectImportedPieces(targetAst, path.dirname(targetPath), state);
		result.reactiveInits.push(...nested.reactiveInits);
		result.functionSources.push(...nested.functionSources);
		result.visualDecls.push(...nested.visualDecls);
		result.topLevelInits.push(...nested.topLevelInits);
		result.classSources.push(...nested.classSources);
		result.jsModuleSources.push(...nested.jsModuleSources);
		result.sharedWsbReactives.push(...nested.sharedWsbReactives);

		result.reactiveInits.push(
			...topDecls.filter((n) => n.type === "ReactiveDecl").map((n) => ({ name: n.name, expr: n.expr, varType: n.varType }))
		);
		// Las function declaradas directamente en el .wsf importado
		// (no solo las que a su vez importa de un .ws) también viajan
		// — antes se quedaban fuera, y una función de un componente
		// importado que la usara en su propio onclick/interpolación se
		// quedaba sin definir en el bundle. `claimName` aquí con
		// `fromWs: false` ya NO tiene el pase libre que tenía antes entre
		// dos .wsf (ver más abajo): dos componentes con un helper interno
		// del mismo nombre dan ahora el mismo error explícito que ya daban
		// dos .ws.
		const ownFns = topDecls.filter((n) => n.type === "FunctionDecl");
		for (const f of ownFns) claimName(state, f.name, targetPath, false);
		result.functionSources.push(...ownFns.map((n) => ({ node: n })));
		// const/var de nivel superior del .wsf importado — mismo
		// criterio que reactive/function: se traen TODOS sin
		// condición, la pida o no el import por nombre (antes no se
		// traían en absoluto: ReferenceError real al usarlos).
		const ownConsts = topDecls.filter((n) => n.type === "ConstDecl" || n.type === "VarDecl");
		for (const c of ownConsts) for (const bound of extractBoundNames(c.name)) claimName(state, bound, targetPath, false);
		result.topLevelInits.push(...ownConsts);
		result.visualDecls.push(...topDecls.filter((n) => n.type === "VisualDecl"));
		result.styleNames.push(...topDecls.filter((n) => n.type === "StyleDecl").map((n) => n.name));
		return;
	}

	if (targetPath.endsWith(".wson")) {
		const wsonAst = parse(fs.readFileSync(targetPath, "utf8"), { isWsonFile: true });
		for (const name of names) {
			if (!first(name)) continue;
			claimName(state, name, targetPath, fromWs);
			result.classSources.push(genDtoClassSource(wsonAst, name));
		}
		return;
	}

	if (targetPath.endsWith(".ws")) {
		const ws = loadClientWs(state, targetPath);
		if (firstVisit) collectWsFileLevel(state, result, ws);
		for (const name of names) {
			const decl = ws.declaredByName.get(name);
			if (!decl) throw new Error(`${where}"${name}" no está exportado en ${targetPath}`);
			// ReactiveDecl y ConstDecl/VarDecl: ya se trajeron al visitar
			// el fichero (todos, no solo los pedidos por nombre).
			if (decl.type === "FunctionDecl") requestWsFunction(state, result, ws, name);
			else if (decl.type === "VisualDecl") requestWsVisual(state, result, ws, name);
		}
		return;
	}

	throw new Error(`${where}Import no soportado en el cliente: "${node.from}" (solo .wsf, .ws, .wson y .js)`);
}

function collectImportedPieces(ast, baseDir, state = null) {
	if (!state) {
		state = createCollectState(baseDir);
		// Lo que declara el propio fichero raíz se reserva de antemano, para
		// detectar una colisión con lo que traiga un .ws.
		for (const n of ast.body) {
			if (n.type === "FunctionDecl") claimName(state, n.name, ROOT_ORIGIN, false);
			else if (n.type === "ConstDecl" || n.type === "VarDecl") for (const b of extractBoundNames(n.name)) claimName(state, b, ROOT_ORIGIN, false);
		}
	}
	const result = emptyPieces();
	for (const node of ast.body) {
		if (node.type !== "Import") continue;
		processImport(state, result, node, baseDir, node.names, { isWs: false, label: null });
	}
	return result;
}

// WSON ad-hoc declarado en un .wsf (const WSON x = -> to: ... -> via: ...)
// se traduce a un objeto plano real. `secret`/`encrypt` se rechazan aquí en
// compilación — es la validación que ya estaba decidida en DISEÑO.md pero
// nunca se llegó a aplicar en ningún sitio hasta ahora.
function genWsonInlineSource(node) {
	const metaValue = (key) => {
		const f = (node.body || []).find((x) => x.type === "MetaField" && x.key === key);
		return f ? f.value.replace(/^["']|["']$/g, "") : null;
	};

	const secret = metaValue("secret");
	const encrypt = metaValue("encrypt");
	if (secret || encrypt === "true") {
		throw new Error(
			`"${node.name}": secret/encrypt no están permitidos en un WSON de cliente (.wsf) — ` +
				"el secreto quedaría expuesto en el bundle del navegador."
		);
	}

	const to = metaValue("to");
	const via = metaValue("via") || "POST";
	const authorization = metaValue("authorization");
	const from = metaValue("from");

	const fields = [`to: ${JSON.stringify(to)}`, `via: ${JSON.stringify(via)}`, "content: {}"];
	if (authorization) fields.push(`authorization: ${JSON.stringify(authorization)}`);
	if (from) fields.push(`from: ${JSON.stringify(from)}`);

	return `const ${node.name} = { ${fields.join(", ")} };`;
}

function genAttr(varName, key, rawValue, ctx, lines) {
	if (key === "slot") return; // routing hacia un slot del padre, no un atributo DOM real

	if (rawValue === null) {
		lines.push(`${varName}.setAttribute(${jsString(key)}, "");`);
		return;
	}

	const isExpr = rawValue.startsWith("{") && rawValue.endsWith("}");
	const exprText = isExpr ? rawValue.slice(1, -1) : null;

	if (key.startsWith("on") && isExpr) {
		const domEvent = key.slice(2).toLowerCase();
		const code = substituteReactive(exprText, ctx.reactiveNames);
		lines.push(`${varName}.addEventListener(${jsString(domEvent)}, () => { ${code}; });`);
		return;
	}

	if (isExpr) {
		const trimmed = exprText.trim();
		if (ctx.styleNames && ctx.styleNames.has(trimmed)) {
			// El nombre de un `style` es literalmente su clase CSS — sin
			// lookup en runtime, y no es una reactive que evaluar.
			lines.push(`${varName}.setAttribute(${jsString(key)}, ${jsString(trimmed)});`);
			return;
		}
		const code = substituteReactive(exprText, ctx.reactiveNames);
		lines.push(`effect(() => { ${varName}.setAttribute(${jsString(key)}, ${code}); });`);
		return;
	}

	lines.push(`${varName}.setAttribute(${jsString(key)}, ${jsString(unquote(rawValue))});`);
}

function genText(parentVar, node, ctx, lines) {
	const parts = splitInterpolations(node.value);
	const hasExpr = parts.some((p) => p.expr !== undefined);

	if (!hasExpr) {
		lines.push(`${parentVar}.appendChild(document.createTextNode(${jsString(node.value)}));`);
		return;
	}

	const textVar = uniq("t");
	lines.push(`const ${textVar} = document.createTextNode("");`);
	lines.push(`${parentVar}.appendChild(${textVar});`);

	const exprParts = parts.map((p) =>
		p.literal !== undefined ? jsString(p.literal) : `(${substituteReactive(p.expr, ctx.reactiveNames)})`
	);
	lines.push(`effect(() => { ${textVar}.textContent = [${exprParts.join(", ")}].join(""); });`);
}

// <slot /> o <slot name="x" />: inserta lo que el padre pasó para ese
// hueco (o nada si no pasó nada). Se hace con el fragment tal cual, sin
// clonar — clonar rompería los effects ya enganchados a esos nodos.
function genSlot(parentVar, node, lines) {
	const nameAttr = (node.attrs || []).find((a) => a.key === "name");
	const slotName = nameAttr && nameAttr.value ? unquote(nameAttr.value) : "default";
	lines.push(`if (slots && slots[${jsString(slotName)}]) ${parentVar}.appendChild(slots[${jsString(slotName)}]);`);
}

// Uso de un componente como tag: <contadorItem item={item} /> o con
// contenido pasado (<tarjeta><h3 slot="header">...</h3>...</tarjeta>).
// El contenido pasado se genera en el scope del PADRE (ctx actual), no
// del hijo — igual que en la versión anterior del lenguaje.
function genComponentCall(parentVar, node, ctx, lines) {
	const propsVar = uniq("props");
	lines.push(`const ${propsVar} = {};`);
	for (const attr of node.attrs || []) {
		if (attr.key === "slot") continue;
		if (attr.value === null) {
			lines.push(`${propsVar}[${jsString(attr.key)}] = true;`);
			continue;
		}
		const isExpr = attr.value.startsWith("{") && attr.value.endsWith("}");
		const value = isExpr
			? substituteReactive(attr.value.slice(1, -1), ctx.reactiveNames)
			: jsString(unquote(attr.value));
		lines.push(`${propsVar}[${jsString(attr.key)}] = ${value};`);
	}

	const slotGroups = groupSlotContent(node.children || []);
	const slotsVar = uniq("slots");
	lines.push(`const ${slotsVar} = {};`);
	for (const [slotName, slotChildren] of Object.entries(slotGroups)) {
		if (slotChildren.length === 0) continue;
		const fragVar = uniq("slotFrag");
		lines.push(`const ${fragVar} = document.createDocumentFragment();`);
		genChildren(fragVar, slotChildren, ctx, lines);
		lines.push(`${slotsVar}[${jsString(slotName)}] = ${fragVar};`);
	}

	lines.push(`${parentVar}.appendChild(create_${node.name}(${propsVar}, ${slotsVar}));`);
}

function genElement(parentVar, node, ctx, lines) {
	if (node.name === "slot") {
		genSlot(parentVar, node, lines);
		return;
	}
	if (ctx.visualNames.has(node.name)) {
		genComponentCall(parentVar, node, ctx, lines);
		return;
	}

	const elVar = uniq("el");
	lines.push(`const ${elVar} = document.createElement(${jsString(node.name)});`);
	for (const attr of node.attrs || []) {
		genAttr(elVar, attr.key, attr.value, ctx, lines);
	}
	genChildren(elVar, node.children || [], ctx, lines);
	lines.push(`${parentVar}.appendChild(${elVar});`);
}

// Diffing de if/else: no hay "identidad de elemento" como en un for (una
// rama no es un dato con el que comparar por referencia), así que lo que
// sí se puede — y se hace — es no tocar nada si la rama activa sigue
// siendo la misma tras reevaluar las condiciones. Antes, cualquier cambio
// que disparara el effect (aunque la rama ganadora fuera la misma)
// destruía y reconstruía el contenido igualmente.
function genIfChain(parentVar, group, ctx, lines) {
	const anchor = uniq("anchorStart");
	const anchorEnd = uniq("anchorEnd");
	const activeVar = uniq("activeBranch");
	lines.push(`const ${anchor} = document.createComment("if");`);
	lines.push(`const ${anchorEnd} = document.createComment("/if");`);
	lines.push(`${parentVar}.appendChild(${anchor});`);
	lines.push(`${parentVar}.appendChild(${anchorEnd});`);
	lines.push(`let ${activeVar} = -1;`);

	const hasExplicitElse = group.chain[group.chain.length - 1].type === "Else";
	const branches = group.chain.map((branch) => ({
		cond: branch.type === "Else" ? "true" : substituteReactive(branch.cond, ctx.reactiveNames),
		body: branch.body || [],
	}));

	lines.push(`effect(() => {`);
	branches.forEach((b, idx) => {
		lines.push(`  ${idx === 0 ? "if" : "else if"} (${b.cond}) {`);
		lines.push(`    if (${activeVar} === ${idx}) return;`); // misma rama que antes: nada que hacer
		lines.push(`    ${activeVar} = ${idx};`);
		lines.push(`    while (${anchor}.nextSibling !== ${anchorEnd}) ${anchor}.nextSibling.remove();`);
		lines.push(`    const frag = document.createDocumentFragment();`);
		const inner = [];
		genChildren("frag", b.body, ctx, inner);
		inner.forEach((l) => lines.push("    " + l));
		lines.push(`    ${anchorEnd}.before(frag);`);
		lines.push(`  }`);
	});
	if (!hasExplicitElse) {
		// Sin `else` explícito: puede que ninguna condición se cumpla — hay
		// que poder "desactivar" también ese caso (rama -1).
		lines.push(`  else {`);
		lines.push(`    if (${activeVar} === -1) return;`);
		lines.push(`    ${activeVar} = -1;`);
		lines.push(`    while (${anchor}.nextSibling !== ${anchorEnd}) ${anchor}.nextSibling.remove();`);
		lines.push(`  }`);
	}
	lines.push(`});`);
}

// Diffing por clave: la clave de cada elemento es el propio valor/objeto
// (un Map ya distingue por referencia si es objeto, y por valor si es
// primitivo — no hace falta sintaxis nueva para declarar una clave). Como
// mutar una propiedad de un elemento no cambia su referencia, esto ya
// reutiliza el nodo correcto en el caso común (reactive de objetos), sin
// que el desarrollador tenga que hacer nada especial.
function genFor(parentVar, node, ctx, lines) {
	const anchor = uniq("anchorStart");
	const anchorEnd = uniq("anchorEnd");
	const keyMapVar = uniq("keyMap");
	lines.push(`const ${anchor} = document.createComment("for");`);
	lines.push(`const ${anchorEnd} = document.createComment("/for");`);
	lines.push(`${parentVar}.appendChild(${anchor});`);
	lines.push(`${parentVar}.appendChild(${anchorEnd});`);
	lines.push(`const ${keyMapVar} = new Map();`);

	const listExpr = substituteReactive(node.list, ctx.reactiveNames);
	const innerCtx = { ...ctx, reactiveNames: ctx.reactiveNames.filter((n) => n !== node.item) };

	lines.push(`effect(() => {`);
	lines.push(`  const list = ${listExpr};`);
	lines.push(`  const nextKeyMap = new Map();`);
	lines.push(`  const frag = document.createDocumentFragment();`);
	lines.push(`  for (const ${node.item} of list) {`);
	lines.push(`    let nodes = ${keyMapVar}.get(${node.item});`);
	lines.push(`    if (nodes) {`);
	lines.push(`      ${keyMapVar}.delete(${node.item});`); // consumido: lo que quede al final son los eliminados
	lines.push(`    } else {`);
	lines.push(`      const itemFrag = document.createDocumentFragment();`);
	const inner = [];
	genChildren("itemFrag", node.body || [], innerCtx, inner);
	inner.forEach((l) => lines.push("      " + l));
	lines.push(`      nodes = Array.from(itemFrag.childNodes);`);
	lines.push(`    }`);
	// appendChild MUEVE un nodo si ya está en el documento — así los
	// elementos reutilizados se reordenan sin recrearse.
	lines.push(`    nodes.forEach((n) => frag.appendChild(n));`);
	lines.push(`    nextKeyMap.set(${node.item}, nodes);`);
	lines.push(`  }`);
	// Lo que sigue entre los marcadores en este punto son solo los
	// elementos NO reutilizados (los reutilizados ya se movieron a frag).
	lines.push(`  while (${anchor}.nextSibling !== ${anchorEnd}) ${anchor}.nextSibling.remove();`);
	lines.push(`  ${anchorEnd}.before(frag);`);
	lines.push(`  ${keyMapVar}.clear();`);
	lines.push(`  for (const [k, v] of nextKeyMap) ${keyMapVar}.set(k, v);`);
	lines.push(`});`);
}

function genChildren(parentVar, children, ctx, lines) {
	const groups = groupChildren(children);
	for (const g of groups) {
		if (g.type === "IfChain") genIfChain(parentVar, g, ctx, lines);
		else if (g.type === "For") genFor(parentVar, g, ctx, lines);
		else if (g.type === "Element") genElement(parentVar, g, ctx, lines);
		else if (g.type === "Text") genText(parentVar, g, ctx, lines);
		else if (g.type === "Raw") lines.push(`// TODO codegen: nodo no reconocido: ${jsString(g.text)}`);
	}
}

// === Modo de hidratación =====================================================
//
// Mismo árbol, mismas reglas de agrupación — pero en vez de crear nodos y
// añadirlos, se consumen los que el SSR ya puso ahí (avanzando un cursor),
// y se les engancha encima el mismo comportamiento (atributos reactivos,
// eventos, effects de texto). El resultado: elementos y texto estático se
// REUTILIZAN de verdad, sin recrearlos.
//
// LIMITACIÓN real y consciente: los bloques `if`/`for` sí se reconstruyen
// (como en modo creación) incluso la primera vez — se sabe dónde empiezan y
// acaban gracias a los marcadores que deja el SSR (`findBlockEnd`), pero no
// se intenta reutilizar node a node su contenido interno, solo la posición.
// Es un reemplazo local (de ese bloque en concreto), no de toda la página.

function genHydrateText(cursorVar, node, ctx, lines) {
	const parts = splitInterpolations(node.value);
	const hasExpr = parts.some((p) => p.expr !== undefined);

	if (!hasExpr) {
		// Texto estático: ya está bien tal cual desde el SSR, sin marcadores
		// (su contenido nunca cambia — nada que la hidratación deba
		// reenganchar). Simplemente se salta el nodo.
		lines.push(`${cursorVar} = ${cursorVar}.nextSibling;`);
		return;
	}

	// Texto DINÁMICO: el SSR lo envolvió en `<!--t-->...<!--/t-->` (ver
	// renderGroupSSR) precisamente porque puede haber renderizado VACÍO — sin
	// el marcador no habría forma de distinguir "aquí no había nada" de "el
	// SSR no llegó a esta rama". Entre los dos comentarios puede haber CERO
	// nodos de texto (contenido vacío) o UNO (el caso normal); si falta, se
	// crea aquí mismo antes de seguir.
	const textVar = uniq("t");
	const anchor = uniq("anchorStart");
	const anchorEnd = uniq("anchorEnd");
	lines.push(`const ${anchor} = ${cursorVar};`); // el comentario "t"
	lines.push(`let ${textVar} = ${anchor}.nextSibling;`);
	lines.push(`if (!${textVar} || ${textVar}.nodeType !== 3) { ${textVar} = document.createTextNode(""); ${anchor}.after(${textVar}); }`);
	lines.push(`const ${anchorEnd} = ${textVar}.nextSibling;`); // el comentario "/t"
	lines.push(`${cursorVar} = ${anchorEnd}.nextSibling;`);

	const exprParts = parts.map((p) =>
		p.literal !== undefined ? jsString(p.literal) : `(${substituteReactive(p.expr, ctx.reactiveNames)})`
	);
	lines.push(`effect(() => { ${textVar}.textContent = [${exprParts.join(", ")}].join(""); });`);
}

// El contenido de un slot vive, en el HTML del SSR, dentro de la posición
// del hijo — pero sus expresiones (si las tiene) son del scope del PADRE.
// Por eso el padre pasa una función de hidratación por slot (no un
// fragment ya construido, como en modo creación) — el hijo solo la llama
// con el cursor actual y sigue desde donde ella lo deje.
function genHydrateSlot(cursorVar, node, lines) {
	const nameAttr = (node.attrs || []).find((a) => a.key === "name");
	const slotName = nameAttr && nameAttr.value ? unquote(nameAttr.value) : "default";
	lines.push(
		`${cursorVar} = (slots && slots[${jsString(slotName)}]) ? slots[${jsString(slotName)}](${cursorVar}) : ${cursorVar};`
	);
}

function genHydrateComponentCall(cursorVar, node, ctx, lines) {
	const propsVar = uniq("props");
	lines.push(`const ${propsVar} = {};`);
	for (const attr of node.attrs || []) {
		if (attr.key === "slot") continue;
		if (attr.value === null) {
			lines.push(`${propsVar}[${jsString(attr.key)}] = true;`);
			continue;
		}
		const isExpr = attr.value.startsWith("{") && attr.value.endsWith("}");
		const value = isExpr
			? substituteReactive(attr.value.slice(1, -1), ctx.reactiveNames)
			: jsString(unquote(attr.value));
		lines.push(`${propsVar}[${jsString(attr.key)}] = ${value};`);
	}

	// Cada slot pasado se compila como una función (cursor) => cursor,
	// hidratando su contenido en el scope del PADRE (ctx actual), no del
	// hijo — igual criterio de scope que en modo creación.
	const slotGroups = groupSlotContent(node.children || []);
	const slotsVar = uniq("slots");
	lines.push(`const ${slotsVar} = {};`);
	for (const [slotName, slotChildren] of Object.entries(slotGroups)) {
		if (slotChildren.length === 0) continue;
		const innerCursor = uniq("c");
		const body = [];
		genHydrateChildren(innerCursor, slotChildren, ctx, body);
		const fn = [`function(${innerCursor}) {`, ...body.map((l) => "\t" + l), `\treturn ${innerCursor};`, `}`].join(
			"\n"
		);
		lines.push(`${slotsVar}[${jsString(slotName)}] = ${fn};`);
	}

	lines.push(`${cursorVar} = hydrate_${node.name}(${propsVar}, ${slotsVar}, ${cursorVar});`);
}

function genHydrateElement(cursorVar, node, ctx, lines) {
	if (node.name === "slot") {
		genHydrateSlot(cursorVar, node, lines);
		return;
	}
	if (ctx.visualNames.has(node.name)) {
		genHydrateComponentCall(cursorVar, node, ctx, lines);
		return;
	}

	const elVar = uniq("el");
	lines.push(`const ${elVar} = ${cursorVar};`);
	lines.push(`${cursorVar} = ${cursorVar}.nextSibling;`);
	for (const attr of node.attrs || []) {
		genAttr(elVar, attr.key, attr.value, ctx, lines); // reutilizable tal cual: pone listeners/effects sobre el nodo existente
	}

	const childCursor = uniq("cursor");
	lines.push(`let ${childCursor} = ${elVar}.firstChild;`);
	genHydrateChildren(childCursor, node.children || [], ctx, lines);
}

function genHydrateIfChain(cursorVar, group, ctx, lines) {
	const anchor = uniq("anchorStart");
	const anchorEnd = uniq("anchorEnd");
	const activeVar = uniq("activeBranch");
	const mountedVar = uniq("mounted");
	lines.push(`const ${anchor} = ${cursorVar};`);
	lines.push(`const ${anchorEnd} = findBlockEnd(${anchor});`);
	lines.push(`${cursorVar} = ${anchorEnd} ? ${anchorEnd}.nextSibling : ${anchor}.nextSibling;`);
	lines.push(`let ${activeVar} = -1;`);
	lines.push(`let ${mountedVar} = false;`);

	const hasExplicitElse = group.chain[group.chain.length - 1].type === "Else";
	const branches = group.chain.map((branch) => ({
		cond: branch.type === "Else" ? "true" : substituteReactive(branch.cond, ctx.reactiveNames),
		body: branch.body || [],
	}));

	lines.push(`effect(() => {`);
	// Primer paso: se hidrata de verdad la rama que ya coincide en el SSR
	// (sus nodos ya existen entre los marcadores) — no se reconstruye nada.
	lines.push(`  if (!${mountedVar}) {`);
	lines.push(`    ${mountedVar} = true;`);
	branches.forEach((b, idx) => {
		const hcursor = uniq("hc");
		lines.push(`    ${idx === 0 ? "if" : "else if"} (${b.cond}) {`);
		lines.push(`      ${activeVar} = ${idx};`);
		lines.push(`      let ${hcursor} = ${anchor}.nextSibling;`);
		const hinner = [];
		genHydrateChildren(hcursor, b.body, ctx, hinner);
		hinner.forEach((l) => lines.push("      " + l));
		lines.push(`    }`);
	});
	lines.push(`    return;`);
	lines.push(`  }`);
	// Cambios posteriores: mismo diffing de rama activa que en creación —
	// si sigue siendo la misma rama, no se toca nada.
	branches.forEach((b, idx) => {
		lines.push(`  ${idx === 0 ? "if" : "else if"} (${b.cond}) {`);
		lines.push(`    if (${activeVar} === ${idx}) return;`);
		lines.push(`    ${activeVar} = ${idx};`);
		lines.push(`    while (${anchor}.nextSibling !== ${anchorEnd}) ${anchor}.nextSibling.remove();`);
		lines.push(`    const frag = document.createDocumentFragment();`);
		const inner = [];
		genChildren("frag", b.body, ctx, inner);
		inner.forEach((l) => lines.push("    " + l));
		lines.push(`    ${anchorEnd}.before(frag);`);
		lines.push(`  }`);
	});
	if (!hasExplicitElse) {
		lines.push(`  else {`);
		lines.push(`    if (${activeVar} === -1) return;`);
		lines.push(`    ${activeVar} = -1;`);
		lines.push(`    while (${anchor}.nextSibling !== ${anchorEnd}) ${anchor}.nextSibling.remove();`);
		lines.push(`  }`);
	}
	lines.push(`});`);
}

function genHydrateFor(cursorVar, node, ctx, lines) {
	const anchor = uniq("anchorStart");
	const anchorEnd = uniq("anchorEnd");
	const keyMapVar = uniq("keyMap");
	const mountedVar = uniq("mounted");
	const hcursor = uniq("hc");

	lines.push(`const ${anchor} = ${cursorVar};`);
	lines.push(`const ${anchorEnd} = findBlockEnd(${anchor});`);
	lines.push(`${cursorVar} = ${anchorEnd} ? ${anchorEnd}.nextSibling : ${anchor}.nextSibling;`);
	lines.push(`const ${keyMapVar} = new Map();`);
	lines.push(`let ${mountedVar} = false;`);

	const listExpr = substituteReactive(node.list, ctx.reactiveNames);
	const innerCtx = { ...ctx, reactiveNames: ctx.reactiveNames.filter((n) => n !== node.item) };

	lines.push(`effect(() => {`);
	lines.push(`  const list = ${listExpr};`);
	lines.push(`  if (!${mountedVar}) {`);
	lines.push(`    ${mountedVar} = true;`);
	// Primer paso: se hidratan de verdad los nodos que ya puso el SSR, uno
	// por elemento, guardándolos en el mapa de claves — nada se tira aquí.
	lines.push(`    let ${hcursor} = ${anchor}.nextSibling;`);
	lines.push(`    for (const ${node.item} of list) {`);
	lines.push(`      const start = ${hcursor};`);
	const hinner = [];
	genHydrateChildren(hcursor, node.body || [], innerCtx, hinner);
	hinner.forEach((l) => lines.push("      " + l));
	lines.push(`      const nodes = [];`);
	lines.push(`      for (let n = start; n && n !== ${hcursor}; n = n.nextSibling) nodes.push(n);`);
	lines.push(`      ${keyMapVar}.set(${node.item}, nodes);`);
	lines.push(`    }`);
	lines.push(`    return;`);
	lines.push(`  }`);
	// Cambios posteriores: mismo diffing por clave que en modo creación.
	lines.push(`  const nextKeyMap = new Map();`);
	lines.push(`  const frag = document.createDocumentFragment();`);
	lines.push(`  for (const ${node.item} of list) {`);
	lines.push(`    let nodes = ${keyMapVar}.get(${node.item});`);
	lines.push(`    if (nodes) {`);
	lines.push(`      ${keyMapVar}.delete(${node.item});`);
	lines.push(`    } else {`);
	lines.push(`      const itemFrag = document.createDocumentFragment();`);
	const inner = [];
	genChildren("itemFrag", node.body || [], innerCtx, inner);
	inner.forEach((l) => lines.push("      " + l));
	lines.push(`      nodes = Array.from(itemFrag.childNodes);`);
	lines.push(`    }`);
	lines.push(`    nodes.forEach((n) => frag.appendChild(n));`);
	lines.push(`    nextKeyMap.set(${node.item}, nodes);`);
	lines.push(`  }`);
	lines.push(`  while (${anchor}.nextSibling !== ${anchorEnd}) ${anchor}.nextSibling.remove();`);
	lines.push(`  ${anchorEnd}.before(frag);`);
	lines.push(`  ${keyMapVar}.clear();`);
	lines.push(`  for (const [k, v] of nextKeyMap) ${keyMapVar}.set(k, v);`);
	lines.push(`});`);
}

function genHydrateChildren(cursorVar, children, ctx, lines) {
	for (const g of groupChildren(children)) {
		if (g.type === "IfChain") genHydrateIfChain(cursorVar, g, ctx, lines);
		else if (g.type === "For") genHydrateFor(cursorVar, g, ctx, lines);
		else if (g.type === "Element") genHydrateElement(cursorVar, g, ctx, lines);
		else if (g.type === "Text") genHydrateText(cursorVar, g, ctx, lines);
		else if (g.type === "Raw") lines.push(`${cursorVar} = ${cursorVar} && ${cursorVar}.nextSibling;`);
	}
}

function generateHydrateFunction(visualDecl, ctx) {
	const lines = [`function hydrate_${visualDecl.name}(props, slots, cursor) {`];
	const body = [];
	genHydrateChildren("cursor", visualDecl.html, ctx, body);
	body.forEach((l) => lines.push("  " + l));
	lines.push(`  return cursor;`, `}`);
	return lines.join("\n");
}

function generateCreateFunction(visualDecl, ctx) {
	const lines = [
		`function create_${visualDecl.name}(props, slots) {`,
		`  const root = document.createDocumentFragment();`,
	];
	const body = [];
	genChildren("root", visualDecl.html, ctx, body);
	body.forEach((l) => lines.push("  " + l));
	lines.push(`  return root;`, `}`);
	return lines.join("\n");
}

// "screen" -> ["screen"]; "{id, tab}" -> ["id", "tab"]
function extractBoundNames(name) {
	if (name.startsWith("{")) {
		return name
			.slice(1, -1)
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	return [name];
}

function generateClientBundle(ast, { baseDir, routePattern = null } = {}) {
	const imported = baseDir ? collectImportedPieces(ast, baseDir) : emptyPieces();

	// Las reactive propias del fichero ganan si hay colisión de nombre con
	// una importada (poco probable, pero más predecible así).
	const reactiveMap = new Map(imported.reactiveInits.map((r) => [r.name, r.expr]));
	const reactiveTypeMap = new Map(imported.reactiveInits.map((r) => [r.name, r.varType || null]));
	for (const n of ast.body.filter((n) => n.type === "ReactiveDecl")) {
		reactiveMap.set(n.name, n.expr);
		reactiveTypeMap.set(n.name, n.varType || null);
	}
	const reactiveNames = [...reactiveMap.keys()];

	// const/var de nivel superior que dependen de Visual.route()/params()/
	// query() (directa o transitivamente, p. ej. `const {id} =
	// Visual.params(screen)` depende de `screen`) se tratan como
	// REACTIVOS de verdad: sus nombres pasan a ser propiedades de `state`,
	// recalculadas dentro de un único `effect()` — así cualquier
	// interpolación que use `id`/`tab` se reevalúa sola cuando cambia la
	// URL (`Visual.route()` ahora lee un estado reactivo interno, ver
	// runtime.js). El resto de const/var de nivel superior (sin relación
	// con la ruta) se compilan igual que antes, una sola vez.
	const topLevelDeclsAll = [...imported.topLevelInits, ...ast.body.filter((n) => n.type === "ConstDecl" || n.type === "VarDecl")];
	const routeDerivedNames = new Set();
	function dependsOnRoute(expr) {
		if (/\bVisual\.(route|params|query)\(/.test(expr)) return true;
		// `params`/`query` sueltas (sistema nuevo) cuentan igual que
		// `Visual.route()`/`params()`/`query()` del sistema antiguo: un
		// `const` que las use también necesita recalcularse solo tras un
		// `goto()`, así que entra en el MISMO mecanismo (routeDerivedDecls
		// → dentro del `effect()` de abajo), no en el camino normal de una
		// vez.
		if (routePattern && /\b(params|query)\b/.test(expr)) return true;
		for (const n of routeDerivedNames) {
			if (new RegExp(`\\b${n}\\b`).test(expr)) return true;
		}
		return false;
	}
	const routeDerivedDecls = [];
	const plainTopLevelDecls = [];
	for (const decl of topLevelDeclsAll) {
		if (dependsOnRoute(decl.expr)) {
			routeDerivedDecls.push(decl);
			extractBoundNames(decl.name).forEach((n) => routeDerivedNames.add(n));
		} else {
			plainTopLevelDecls.push(decl);
		}
	}

	// A partir de aquí, todo lo demás (plantillas, otras funciones) debe
	// tratar id/tab/screen... como reactive de verdad — se añaden a la
	// lista general ANTES de construir el ctx que usan genChildren/etc.
	routeDerivedNames.forEach((n) => reactiveNames.push(n));
	// `params`/`query` (sistema nuevo, sin Visual.ws) son reactivos por el
	// mismo motivo: tras un `goto()` (o el atrás/adelante del navegador),
	// deben recalcularse solos — mismo mecanismo que id/tab arriba, ver
	// más abajo el `effect()` que los recalcula.
	if (routePattern) reactiveNames.push("params", "query");

	// const/var de nivel superior SIN relación con la ruta (p. ej. algo
	// derivado de una reactive) — se emiten como JS real, una sola vez.
	//
	// De estas, las que NO leen ninguna reactive de verdad se adelantan
	// ANTES de `const state = createStore(...)` — así una `reactive` puede
	// usar una de estas const en su propio valor inicial. Antes todas se
	// emitían DESPUÉS de `state` sin excepción (hacía falta para que las que
	// SÍ leen una reactive, vía `state.NOMBRE`, tuvieran `state` ya creado) y
	// una `reactive integer c = LIMITE` daba `Cannot access 'LIMITE' before
	// initialization`: el propio `const LIMITE` estaba en el bundle, pero
	// más abajo — una TDZ de verdad, no un fallo del compilador. Las
	// function no tenían este problema — una `function` declarada más abajo
	// ya era invocable desde antes por el *hoisting* normal de JS — así que
	// solo hacía falta resolver este caso para const/var. Un `const`/`var`
	// que a su vez depende (directa o transitivamente) de otro que SÍ lee
	// una reactive se queda detrás de `state` igual que antes — no hay forma
	// de que exista antes de que exista lo que necesita, y ese caso ya era
	// ambiguo antes de este cambio.
	const trueReactiveNames = new Set(reactiveMap.keys());
	const needsStateNames = new Set(trueReactiveNames);
	function usesAny(expr, names) {
		for (const n of names) {
			if (new RegExp(`\\b${n}\\b`).test(expr)) return true;
		}
		return false;
	}
	// Llamar a una function DE WEBSCRIPT (propia de este .wsf, o importada de
	// un .ws) exige `state` ya completo — no hay forma de saber, sin
	// analizar su cuerpo, si esa function lee una reactive por dentro (p.
	// ej. `conBase(x) { return x + base }`, donde `base` es una reactive: la
	// CONST que la llama, `resultado = conBase(1)`, no menciona "base" en
	// absoluto). Se trata como conservador a propósito: cualquier llamada a
	// una de ESTAS fuerza POST-estado, aunque en muchos casos la function
	// llamada sea inocua — más seguro que adivinar (bug real: sin esto,
	// `resultado` daba `NaN` en vez del valor real). Una llamada a un módulo
	// `.js` embebido o a una clase `.wson` (`new Persona(...)`) NO cuenta:
	// esas nunca tienen acceso a `state` (son JS aislado, sin closure sobre
	// él), así que una const como `TRIPLE_DE_DOS = triple(2)` (de un .js) sí
	// puede adelantarse.
	const riskyFunctionNames = new Set([
		...ast.body.filter((n) => n.type === "FunctionDecl").map((n) => n.name),
		...imported.functionSources.map((f) => f.node.name),
	]);
	function callsRiskyFunction(expr) {
		for (const name of riskyFunctionNames) {
			if (new RegExp(`\\b${name}\\s*\\(`).test(expr)) return true;
		}
		return false;
	}
	{
		let changed = true;
		while (changed) {
			changed = false;
			for (const decl of plainTopLevelDecls) {
				const bound = extractBoundNames(decl.name);
				if (bound.some((n) => needsStateNames.has(n))) continue;
				if (usesAny(decl.expr, needsStateNames) || callsRiskyFunction(decl.expr)) {
					bound.forEach((n) => needsStateNames.add(n));
					changed = true;
				}
			}
		}
	}
	const preStateDecls = [];
	const postStateDecls = [];
	for (const decl of plainTopLevelDecls) {
		const bound = extractBoundNames(decl.name);
		(bound.some((n) => needsStateNames.has(n)) ? postStateDecls : preStateDecls).push(decl);
	}

	// El PageDecl (HTML suelto, sin `visual nombre = `) se trata como una
	// `visual` más, con un nombre interno fijo (`__page__`) — así
	// reutiliza tal cual generateCreateFunction/generateHydrateFunction,
	// sin duplicar la compilación de plantillas para el sistema nuevo.
	const ownPageDecl = ast.body.find((n) => n.type === "PageDecl");
	const ownVisuals = [
		...ast.body.filter((n) => n.type === "VisualDecl"),
		...(ownPageDecl ? [{ type: "VisualDecl", name: PAGE_DECL_NAME, html: ownPageDecl.html, htmlErrors: ownPageDecl.htmlErrors, line: ownPageDecl.line }] : []),
	];
	const allVisuals = [...imported.visualDecls, ...ownVisuals];
	const visualNames = new Set(allVisuals.map((v) => v.name));

	const ownStyleNames = ast.body.filter((n) => n.type === "StyleDecl").map((n) => n.name);
	const styleNames = new Set([...imported.styleNames, ...ownStyleNames]);

	const ctx = { reactiveNames, visualNames, styleNames };

	const stateInit = reactiveNames.map((name) => `  ${name}: ${reactiveMap.get(name)},`).join("\n");
	const typedNames = reactiveNames.filter((name) => reactiveTypeMap.get(name));
	const typeSchemaLiteral = typedNames.map((name) => `  ${jsString(name)}: ${jsString(reactiveTypeMap.get(name))},`).join("\n");
	// Funciones importadas de un .ws + las declaradas DIRECTAMENTE en este
	// propio .wsf (antes solo se traían las importadas — una function
	// declarada aquí mismo se llamaba desde un onclick pero nunca viajaba
	// al bundle: ReferenceError real en el navegador al hacer clic).
	const ownFunctionDecls = ast.body.filter((n) => n.type === "FunctionDecl");
	const functionSources = [...imported.functionSources.map((f) => f.node), ...ownFunctionDecls].map((node) =>
		genFunctionSource(node, reactiveNames)
	);
	// Clases DTO importadas de un .wson — ya vienen como texto JS completo
	// (genDtoClassSource), no como nodos de AST que compilar aquí.
	const classSources = imported.classSources;
	// Módulos .js embebidos — deben ir ANTES que cualquier const/var que
	// los referencie (incluidos los de topLevelInits, más abajo).
	const jsModuleSources = imported.jsModuleSources;

	// const/var de nivel superior POST-estado (leen una reactive vía
	// `state.NOMBRE`, directa o transitivamente) — se emiten como JS real,
	// una sola vez, DESPUÉS de `state` (ver el reparto pre/post arriba).
	const topLevelSources = postStateDecls.map((n) => genFunctionStatement(n, reactiveNames));
	// Las PRE-estado (no leen ninguna reactive) se emiten ANTES de `state`,
	// para que una `reactive` pueda usarlas en su propio valor inicial.
	const preStateSources = preStateDecls.map((n) => genFunctionStatement(n, reactiveNames));

	// Los derivados de ruta (Visual.route()/params()/query() del sistema
	// antiguo, y params/query SUELTAS del sistema nuevo — ver
	// `dependsOnRoute` arriba) se recalculan dentro de un ÚNICO effect() —
	// la primera ejecución (inmediata, como todo effect()) deja los
	// valores iniciales en `state`, y las siguientes ocurren solas cuando
	// cambia la URL (`goto()`, o el atrás/adelante del navegador).
	// `reactiveNamesForRouteEffect` NO incluye los propios nombres
	// route-derived (dentro del effect son locals `const` normales, no se
	// prefijan con `state.`), pero SÍ las reactive de verdad del fichero.
	//
	// `params`/`query` (sistema nuevo) se calculan aquí mismo, ANTES que
	// cualquier `routeDerivedDecls` que las use (`const titulo = "Producto
	// " + params.id`) — dentro del MISMO effect(), como locals normales,
	// para que esa referencia se resuelva por closure normal de JS, sin
	// necesidad de reescribirla a `state.params.id` (ver por qué
	// `reactiveNamesForRouteEffect` no las incluye, arriba). Solo se
	// añaden si quien llama pasa `routePattern` — un .wsf del sistema
	// antiguo no lo recibe, sigue con Visual.params(screen)/query(screen).
	const reactiveNamesForRouteEffect = [...reactiveMap.keys()];
	const paramsQueryPreamble = routePattern
		? [
				`  const __url = new URL(routerState.href || (typeof location !== "undefined" ? location.href : "http://localhost/"));`,
				`  const __route = compileRoutePatternClient(${JSON.stringify(routePattern)});`,
				`  const __routeMatch = __route.regex.exec(__url.pathname);`,
				`  const params = {};`,
				`  if (__routeMatch) __route.paramNames.forEach((n, i) => { params[n] = __routeMatch[i + 1]; });`,
				`  const query = Object.fromEntries(__url.searchParams.entries());`,
				`  state.params = params;`,
				`  state.query = query;`,
			].join("\n")
		: "";
	let routeEffectSource = "";
	if (routeDerivedDecls.length > 0 || paramsQueryPreamble) {
		const body = routeDerivedDecls
			.map((d) => {
				const rhs = substituteReactive(d.expr, reactiveNamesForRouteEffect);
				const assigns = extractBoundNames(d.name)
					.map((n) => `  state.${n} = ${n};`)
					.join("\n");
				return `  const ${d.name} = (${rhs});\n${assigns}`;
			})
			.join("\n");
		routeEffectSource = `effect(() => {\n${paramsQueryPreamble}\n${body}\n});`;
	}

	const wsonSources = ast.body.filter((n) => n.type === "WsonInlineDecl").map(genWsonInlineSource);

	// `shared global reactive` importadas de un `.wsb`: una conexión
	// WebSocket (al mismo origen de la página — nunca una URL declarada,
	// igual que cualquier `fetch()` de esa página) que se suscribe a cada
	// una al conectar, y aplica cualquier `update` que llegue directamente
	// sobre `state` — así cualquier plantilla que la lea ya es reactiva de
	// verdad, sin tocar el motor de reactividad para nada. Las escrituras
	// se tratan aparte — ver `rewriteSharedAssignments`, al final de esta
	// función: una asignación a uno de estos nombres no llega a mutar
	// `state` directamente, se reescribe en una llamada a
	// `__proposeShared`, definida aquí mismo.
	const sharedNames = imported.sharedWsbReactives.map((s) => s.name);
	const sharedWsSource =
		sharedNames.length > 0
			? [
					`const __sharedNames = ${JSON.stringify(sharedNames)};`,
					`const __sharedWs = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/");`,
					`__sharedWs.addEventListener("open", () => { for (const __n of __sharedNames) __sharedWs.send(JSON.stringify({ type: "subscribe", name: __n })); });`,
					`__sharedWs.addEventListener("message", (__ev) => {`,
					`  let __msg;`,
					`  try { __msg = JSON.parse(__ev.data); } catch { return; }`,
					`  if (__msg.type === "update" && __sharedNames.includes(__msg.name)) state[__msg.name] = __msg.value;`,
					`});`,
					// El cliente NUNCA muta una `shared` directamente — solo
					// propone. Si la conexión aún no está lista (reconectando,
					// o la primera propuesta llega antes de que termine el
					// saludo), la propuesta se pierde en silencio — limitación
					// conocida, documentada en DISEÑO.md; un reintento o cola
					// de propuestas pendientes queda para una vuelta futura.
					`function __proposeShared(name, value) { if (__sharedWs.readyState === WebSocket.OPEN) __sharedWs.send(JSON.stringify({ type: "propose", name, value })); }`,
				].join("\n")
			: "";

	const renderCall = ast.body.find((n) => n.type === "Raw" && /^Visual\.render\(/.test(n.text));

	const parts = [
		"// Generado por WebScript (codegen-client.js) — no editar a mano",
		RUNTIME_SOURCE,
		...jsModuleSources,
		...classSources,
		...preStateSources,
		typedNames.length > 0
			? `const state = createStore({\n${stateInit}\n}, {\n${typeSchemaLiteral}\n});`
			: `const state = createStore({\n${stateInit}\n});`,
		...(sharedWsSource ? [sharedWsSource] : []),
		// `routeEffectSource` (derivados de Visual.route()/params()/query()
		// del sistema antiguo, Y params/query sueltas del sistema nuevo —
		// ver `dependsOnRoute` arriba) va ANTES de `topLevelSources`: un
		// `const` POST-estado normal (`const titulo = "Producto " +
		// params.id`) que las use ya entró en `routeDerivedDecls`, no en
		// `topLevelSources` — pero por si acaso algo más las necesitara
		// pronto, este orden es el correcto de todos modos.
		...(routeEffectSource ? [routeEffectSource] : []),
		...functionSources,
		...wsonSources,
		...topLevelSources,
		...allVisuals.map((v) => generateCreateFunction(v, ctx)),
		...allVisuals.map((v) => generateHydrateFunction(v, ctx)),
	];

	// Nombre de lo que se monta al cargar: el de siempre (Visual.render(x)
	// explícito) si está, y si no, el sistema nuevo (aditivo, sin
	// Visual.ws) — ver findImplicitPageTarget en codegen.js. Un PageDecl
	// (HTML suelto) SIEMPRE gana si está presente; si no, exactamente una
	// `visual` declarada se renderiza implícita, sin llamada. Dos o más
	// `visual` sin Visual.render() y sin PageDecl es un fichero librería —
	// no se monta nada — SALVO que alguien llame a generateClientBundle
	// directamente sobre un AST así esperando una página: entonces sí es
	// el conflicto real ("no se sabe cuál renderizar") y se avisa con un
	// error claro, en vez de montar cualquiera de las dos sin criterio.
	let targetName = null;
	if (renderCall) {
		const m = /^Visual\.render\((\w+)\)$/.exec(renderCall.text);
		if (m) targetName = m[1];
	} else {
		const implicitTarget = findImplicitPageTarget(ast);
		if (implicitTarget) {
			targetName = implicitTarget.type === "PageDecl" ? PAGE_DECL_NAME : implicitTarget.name;
		} else if (ownVisuals.filter((v) => v.name !== PAGE_DECL_NAME).length > 1) {
			throw new Error(
				`Este .wsf declara ${ownVisuals.length} \`visual\` y no tiene HTML suelto ni Visual.render(): no se sabe cuál renderizar como página. ` +
					"Deja solo una, envuelve el HTML de la página sin nombre, o llama a Visual.render(la_que_sea) explícitamente."
			);
		}
	}

	if (targetName) {
		// Una página cuyo HTML suelto es literalmente un documento
		// completo (`<html>...</html>`, con su `<head>`) no se puede
		// "montar" dentro de `document.body` — ya ES el documento, y
		// anidar `<html>` dentro de `<body>` no tiene sentido y el propio
		// navegador lo reordenaría. Aquí se asume que el servidor SIEMPRE
		// mandó ese HTML completo como la página (por eso existe: para
		// escribirla como un fichero HTML normal) — se hidrata
		// directamente contra `document.documentElement`, el `<html>` que
		// el navegador ya parseó. Sin SSR no hay nada sensato que crear
		// (una página así no tiene sentido sin servirla ya completa), así
		// que ese camino no se genera para este caso.
		const targetVisual = allVisuals.find((v) => v.name === targetName);
		const rootIsHtmlDocument = targetVisual && targetVisual.html.length === 1 && targetVisual.html[0].type === "Element" && targetVisual.html[0].name.toLowerCase() === "html";
		if (rootIsHtmlDocument) {
			parts.push(`hydrate_${targetName}({}, {}, document.documentElement);`);
		} else {
			// Si hubo SSR, el body ya trae HTML del servidor — se hidrata de
			// verdad (se reutilizan elementos/texto, solo if/for se
			// reconstruyen localmente; ver limitaciones en codegen-ssr.js).
			// Sin SSR, body está vacío salvo por este propio <script> —
			// document.currentScript lo distingue de contenido real, porque
			// mirar solo "firstChild" nunca sabría diferenciarlos (el script
			// también es un hijo de body).
			parts.push(
				`{ const ssrNode = document.body.firstChild; if (ssrNode && ssrNode !== document.currentScript) { hydrate_${targetName}({}, {}, ssrNode); } else { document.body.appendChild(create_${targetName}({}, {})); } }`
			);
		}
	}

	const bundleText = parts.join("\n\n");
	// Última pasada, sobre el texto YA ensamblado entero: cualquier
	// asignación a una `shared` (ya reescrita a `state.nombre = ...` por
	// `substituteReactive`, como cualquier otra reactive) se convierte en
	// una llamada a `__proposeShared` — el cliente nunca muta una `shared`
	// de verdad, solo propone (ver DISEÑO.md). Deliberadamente a nivel de
	// texto completo, no en cada punto de compilación por separado (atrs,
	// eventos, cuerpos de function...) — así cubre CUALQUIER sitio donde
	// pueda aparecer una asignación así, sin tener que tocar cada uno de
	// esos sitios uno a uno ni arriesgarse a olvidar alguno. Limitación
	// deliberada: solo cubre una asignación simple con `=` — un operador
	// compuesto (`+=`, `++`...) sobre una `shared` no se reescribe todavía
	// (documentado en DISEÑO.md).
	return sharedNames.length > 0 ? rewriteSharedAssignments(bundleText, sharedNames) : bundleText;
}

module.exports = {
	generateClientBundle,
	substituteReactive,
	splitInterpolations,
	groupChildren,
	groupSlotContent,
	collectImportedPieces,
	genFunctionStatement,
	extractBoundNames,
	PAGE_DECL_NAME,
};
