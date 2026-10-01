// codegen-ssr.js — WebScript, v0
//
// Renderiza el AST de un `visual` a una cadena HTML real, en servidor —
// sin DOM, construyendo el string directamente. Reutiliza la agrupación
// de If/ElseIf/Else y de contenido de slots ya implementada en
// codegen-client.js, para no duplicar esa lógica.
//
// LIMITACIONES DE ESTA VERSIÓN (deliberadas, no descuidos):
// - Es un snapshot: el `state` inicial se evalúa una vez, no hay
//   reactividad en el HTML generado (no puede haberla — es texto).
// - "Render-then-replace", no hidratación real: el cliente, al montar,
//   sustituye TODO el contenido de <body> por el suyo propio. El HTML del
//   servidor solo sirve para el primer pintado (SEO, sin JS, percepción de
//   velocidad) — no se reutilizan sus nodos DOM.
// - Los manejadores de eventos (`onclick={...}`) se omiten en el HTML del
//   servidor (no hay comportamiento posible sin JS) — el atributo
//   simplemente no aparece hasta que el cliente hidrata.

const {
	collectImportedPieces,
	groupChildren,
	groupSlotContent,
	substituteReactive,
	splitInterpolations,
	genFunctionStatement,
	PAGE_DECL_NAME,
} = require("./codegen-client");

const { compileRoutePatternClient } = require("./runtime");
const { typeMismatch } = require("./type-check");
const { findImplicitPageTarget } = require("./codegen");

function unquote(raw) {
	return raw.replace(/^["']|["']$/g, "");
}

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// Visual.route()/params()/query() en SSR: mismo comportamiento que en
// cliente (runtime.js), pero resuelto contra la URL de la petición real
// que le pasa el servidor, no contra `window.location` (que no existe en
// Node).
function createSSRVisual(requestUrl) {
	const url = new URL(requestUrl, "http://localhost");
	return {
		route(pattern) {
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
	};
}

// "screen" -> ["screen"]; "{id, tab}" -> ["id", "tab"] — nombres que deja
// disponibles una declaración de nivel superior para las de después y
// para la propia plantilla.
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

// Compila una función importada de .ws (o propia del .wsf) a una función JS
// real, con closure sobre `state` — reutiliza el mismo generador de cuerpo
// que el cliente (sustituye reactive globales por `state.NOMBRE`), pero aquí
// se evalúa de verdad en vez de emitirse como texto para un navegador.
//
// `scope` es el ÁMBITO COMPARTIDO de todo lo que el bundle de cliente deja
// al mismo nivel: las demás function, las const/var de nivel superior, las
// clases .wson y los módulos .js. Es un objeto sin prototipo, y las
// referencias libres del cuerpo se resuelven contra él AL LLAMAR (por eso el
// `with`): una function puede llamar a otra que se compile después, a un
// helper del mismo .ws, o leer una const, exactamente como en el script
// plano del navegador (donde las function se elevan y todo comparte ámbito).
// Antes cada function se compilaba aislada (solo veía `state`), así que
// cualquier llamada entre function fallaba con `X is not defined` al
// renderizar en servidor — aunque en el navegador funcionara.
function compileFunctionForSSR(fnNode, reactiveNames, stateObj, scope) {
	const paramNames = (fnNode.params || []).map((p) => p.name);
	const body = (fnNode.body || []).map((n) => genFunctionStatement(n, reactiveNames)).join("\n");
	// eslint-disable-next-line no-new-func
	const factory = new Function("state", "__ssrScope", `with (__ssrScope) { return function(${paramNames.join(", ")}) {\n${body}\n}; }`);
	return factory(stateObj, scope);
}

// Un valor importado que NO se pudo calcular en servidor (p. ej. una const de
// un .ws que lee `window`, o un .js que solo funciona en el navegador). No
// debe tumbar un render que no lo usa — antes SSR ignoraba lo importado y por
// eso nunca se veía —, así que se sustituye por un valor que falla CON UN
// MENSAJE CLARO solo si la plantilla lo llega a tocar.
function poisonedValue(name, cause) {
	// Si la causa es OTRO valor fallido (una const que lee un módulo .js que
	// no cargó), se conserva solo la causa original: el nombre interno del
	// módulo (`__jsmod_0`) no lo escribió nadie y solo ensucia el mensaje.
	const original = cause && cause.ssrOriginalMessage ? cause.ssrOriginalMessage : cause.message;
	const fail = () => {
		const err = new Error(
			`"${name}" no se pudo calcular al renderizar en el servidor (SSR): ${original}. ` +
				"Si solo lo necesita el navegador (p. ej. usa window o document), no lo uses en una interpolación de la plantilla."
		);
		err.ssrOriginalMessage = original;
		throw err;
	};
	return new Proxy(function () {}, { get: fail, apply: fail, construct: fail });
}

// const/var de nivel superior: `const NOMBRE = (expr)`, con la expresión
// evaluada contra `state` (reactive) y el ámbito compartido. Devuelve los
// nombres que deja ligados (más de uno con destructuring).
function evalTopLevelDecl(decl, stateObj, reactiveNames, scope) {
	const boundNames = extractBoundNames(decl.name);
	const translatedExpr = substituteReactive(decl.expr, reactiveNames);
	// eslint-disable-next-line no-new-func
	const factory = new Function("state", "__ssrScope", `with (__ssrScope) { const ${decl.name} = (${translatedExpr}); return { ${boundNames.join(", ")} }; }`);
	return factory(stateObj, scope);
}

// Módulos .js y clases .wson tal como viajan al navegador (texto JS): se
// evalúan una a una, y una que falle no impide las demás.
function evalEmbeddedSources(imported, scope, templateValues) {
	const sources = [...(imported.jsModuleSources || []), ...(imported.classSources || [])];
	for (const src of sources) {
		const m = /^\s*const\s+(__jsmod_\d+)/.exec(src) || /(?:^|\n)\s*class\s+(\w+)/.exec(src);
		if (!m) continue;
		const name = m[1];
		let value;
		try {
			// eslint-disable-next-line no-new-func
			value = new Function("typeMismatch", `${src}\nreturn ${name};`)(typeMismatch);
		} catch (e) {
			value = poisonedValue(name, e);
		}
		scope[name] = value;
		templateValues[name] = value;
	}
}

// Evalúa una expresión contra el `state` global, las funciones importadas
// disponibles, y cualquier variable de scope local (props de un
// componente, item de un for) — mismo criterio de sustitución que en
// cliente, pero evaluado de verdad aquí mismo (Node), no generado como
// texto para un navegador.
function evalExprInCtx(expr, ctx) {
	const scopeNames = [...Object.keys(ctx.functions || {}), ...Object.keys(ctx.extraScope || {})];
	const scopeValues = [...Object.values(ctx.functions || {}), ...Object.values(ctx.extraScope || {})];
	const translated = substituteReactive(expr, Object.keys(ctx.state));
	// eslint-disable-next-line no-new-func
	const fn = new Function("state", ...scopeNames, `return (${translated});`);
	return fn(ctx.state, ...scopeValues);
}

function renderAttrSSR(attr, ctx) {
	if (attr.key === "slot") return null; // routing hacia un slot, no un atributo real
	if (attr.key.startsWith("on")) return null; // sin comportamiento posible sin JS

	if (attr.value === null) return attr.key; // atributo booleano

	const isExpr = attr.value.startsWith("{") && attr.value.endsWith("}");
	if (!isExpr) return `${attr.key}="${escapeHtml(unquote(attr.value))}"`;

	const exprText = attr.value.slice(1, -1).trim();
	if (ctx.styleNames && ctx.styleNames.has(exprText)) {
		return `${attr.key}="${escapeHtml(exprText)}"`; // nombre de style = clase literal
	}

	return `${attr.key}="${escapeHtml(evalExprInCtx(exprText, ctx))}"`;
}

function renderTextSSR(node, ctx) {
	return splitInterpolations(node.value)
		.map((p) => (p.literal !== undefined ? escapeHtml(p.literal) : escapeHtml(evalExprInCtx(p.expr, ctx))))
		.join("");
}

function renderComponentSSR(node, ctx) {
	const visualAst = ctx.visualsByName.get(node.name);

	const props = {};
	for (const attr of node.attrs || []) {
		if (attr.key === "slot") continue;
		if (attr.value === null) { props[attr.key] = true; continue; }
		const isExpr = attr.value.startsWith("{") && attr.value.endsWith("}");
		props[attr.key] = isExpr ? evalExprInCtx(attr.value.slice(1, -1), ctx) : unquote(attr.value);
	}

	// El contenido pasado entre <componente>...</componente> se renderiza
	// en el scope del PADRE (ctx actual) — igual que en cliente.
	const slotGroups = groupSlotContent(node.children || []);
	const slots = {};
	for (const [slotName, slotChildren] of Object.entries(slotGroups)) {
		if (slotChildren.length === 0) continue;
		slots[slotName] = renderChildrenSSR(slotChildren, ctx);
	}

	// `extraScope` se COMBINA con el del padre, no se reemplaza — igual que
	// ya hace el cuerpo de un `for` (`{ ...ctx.extraScope, [group.item]:
	// item }`) por el mismo motivo. `ctx.extraScope` en la raíz contiene
	// TODA const/var de nivel superior, propia y de cualquier componente
	// importado (el bundle de cliente es un único ámbito plano — ver
	// DISEÑO.md, "Los imports de un .ws en el cliente" — y SSR replica ese
	// mismo modelo con `boundTopLevelNames`). Reemplazarlo entero por solo
	// `{ props }` perdía esa const en CADA nivel de composición: una
	// `const TITULO = "hola"` usada por SU PROPIO componente, en su propia
	// plantilla, daba `TITULO is not defined` al renderizar en servidor —
	// aunque el mismo componente SÍ podía leerla si la usaba otro fichero
	// (la raíz, o un componente distinto), porque esa vía no pasaba por
	// `renderComponentSSR`. Un `props` de un nivel más externo (de un
	// componente que a su vez envuelve a este) no debe filtrarse hacia
	// dentro — por eso `props` se pone AL FINAL, pisando cualquier
	// `props` heredado del padre en el objeto combinado.
	const childCtx = { ...ctx, extraScope: { ...ctx.extraScope, props }, slots };
	return renderChildrenSSR(visualAst.html, childCtx);
}

function renderElementSSR(node, ctx) {
	if (node.name === "slot") {
		const nameAttr = (node.attrs || []).find((a) => a.key === "name");
		const slotName = nameAttr && nameAttr.value ? unquote(nameAttr.value) : "default";
		return (ctx.slots && ctx.slots[slotName]) || "";
	}

	if (ctx.visualsByName.has(node.name)) {
		return renderComponentSSR(node, ctx);
	}

	const attrsStr = (node.attrs || [])
		.map((a) => renderAttrSSR(a, ctx))
		.filter((a) => a !== null)
		.join(" ");
	const openTag = attrsStr ? `<${node.name} ${attrsStr}>` : `<${node.name}>`;

	if (node.selfClosing) return openTag.replace(/>$/, " />");

	const inner = renderChildrenSSR(node.children || [], ctx);
	return `${openTag}${inner}</${node.name}>`;
}

function renderGroupSSR(group, ctx) {
	if (group.type === "IfChain") {
		for (const branch of group.chain) {
			const matches = branch.type === "Else" || evalExprInCtx(branch.cond, ctx);
			if (matches) return `<!--if-->${renderChildrenSSR(branch.body || [], ctx)}<!--/if-->`;
		}
		return "<!--if--><!--/if-->";
	}

	if (group.type === "For") {
		const list = evalExprInCtx(group.list, ctx) || [];
		let out = "";
		for (const item of list) {
			const innerCtx = { ...ctx, extraScope: { ...ctx.extraScope, [group.item]: item } };
			out += renderChildrenSSR(group.body || [], innerCtx);
		}
		return `<!--for-->${out}<!--/for-->`;
	}

	if (group.type === "Element") return renderElementSSR(group, ctx);
	if (group.type === "Text") {
		const parts = splitInterpolations(group.value);
		const hasExpr = parts.some((p) => p.expr !== undefined);
		// Un texto DINÁMICO (con interpolación) se envuelve en marcadores de
		// comentario — igual que `if`/`for` arriba — porque su contenido puede
		// renderizar VACÍO (una reactive que empieza en ""), y un string vacío
		// insertado en HTML no produce ningún nodo: sin un marcador de
		// posición, la hidratación no tiene forma de saber que ahí debía
		// haber un nodo de texto que reutilizar. Antes esto rompía con
		// "Cannot read properties of null (reading 'nextSibling')" y el clic
		// no hacía nada — reproducido con una página SIN ningún `.ws`, no es
		// un caso raro. El texto puramente estático no lo necesita: su
		// contenido nunca cambia después del primer render, así que no hay
		// nada que la hidratación deba reenganchar.
		return hasExpr ? `<!--t-->${renderTextSSR(group, ctx)}<!--/t-->` : renderTextSSR(group, ctx);
	}
	return ""; // "Raw" u otro nodo no reconocido: se omite en SSR
}

function renderChildrenSSR(children, ctx) {
	return groupChildren(children)
		.map((g) => renderGroupSSR(g, ctx))
		.join("");
}

// Punto de entrada: AST de una página (.wsf) -> HTML del `visual` que llama
// a Visual.render(...). Devuelve "" si no hay Visual.render (no es página,
// o algo no se pudo resolver).
function renderPageToHTML(ast, { baseDir, requestUrl = "/", routePattern = null } = {}) {
	const imported = baseDir
		? collectImportedPieces(ast, baseDir)
		: { reactiveInits: [], functionSources: [], visualDecls: [], styleNames: [], topLevelInits: [], classSources: [], jsModuleSources: [] };

	const reactiveMap = new Map(imported.reactiveInits.map((r) => [r.name, r.expr]));
	const reactiveTypeMap = new Map(imported.reactiveInits.map((r) => [r.name, r.varType || null]));
	for (const n of ast.body.filter((n) => n.type === "ReactiveDecl")) {
		reactiveMap.set(n.name, n.expr);
		reactiveTypeMap.set(n.name, n.varType || null);
	}
	const reactiveNames = [...reactiveMap.keys()];

	// El valor inicial de `state` se rellena más abajo, DESPUÉS del reparto
	// pre/post de abajo — pero el objeto en sí se crea ya, porque las
	// function que se compilan a continuación cierran sobre esta misma
	// referencia (leen `state.NOMBRE` al LLAMARSE, no al compilarse, así que
	// no importa que esté vacío todavía).
	const state = {};

	// Ámbito compartido de todo lo que el bundle de cliente deja al mismo
	// nivel (ver compileFunctionForSSR). `templateValues` es lo que, además de
	// las function, puede usar una interpolación de la plantilla.
	const scope = Object.create(null);
	scope.Visual = createSSRVisual(requestUrl);
	const templateValues = {};

	// `params`/`query`: nombres reservados del sistema nuevo (sin
	// Visual.ws) — la ruta dinámica sale del propio nombre de fichero
	// (`listaProductos:id.wsf` → patrón `/listaProductos/:id`, calculado
	// por quien llama — ver route-pattern.js), y aquí se hace el matching
	// real contra la URL de la petición para dar `params.id`; la query
	// string de la propia URL da `query.campo`. Solo se activa si quien
	// llama pasa `routePattern` — un `.wsf` del sistema antiguo, con su
	// propio `Visual.route()`, no lo recibe (sigue usando
	// `Visual.params(screen)`/`Visual.query(screen)`, sin tocar).
	if (routePattern) {
		const { regex, paramNames } = compileRoutePatternClient(routePattern);
		const urlObj = new URL(requestUrl, "http://localhost");
		const match = regex.exec(urlObj.pathname);
		const params = {};
		if (match) paramNames.forEach((name, i) => { params[name] = match[i + 1]; });
		const query = Object.fromEntries(urlObj.searchParams.entries());
		scope.params = params;
		scope.query = query;
		templateValues.params = params;
		templateValues.query = query;
	}

	evalEmbeddedSources(imported, scope, templateValues);

	const functions = {};
	const ownFunctionDecls = ast.body.filter((n) => n.type === "FunctionDecl");
	for (const node of [...imported.functionSources.map((f) => f.node), ...ownFunctionDecls]) {
		const fn = compileFunctionForSSR(node, reactiveNames, state, scope);
		functions[node.name] = fn;
		scope[node.name] = fn;
	}

	// const/var de nivel superior, IMPORTADAS y PROPIAS juntas, repartidas en
	// PRE-estado (no leen ninguna reactive, directa ni transitivamente) y
	// POST-estado (sí) — mismo criterio y mismo motivo que en
	// codegen-client.js: antes TODAS se evaluaban después de construir
	// `state`, y el propio `state` se calculaba con `new Function(...)` SIN
	// NINGÚN ámbito — ni siquiera las function existían todavía —, así que
	// una `reactive` cuyo valor inicial usara una `const` (o una function)
	// daba `X is not defined` al renderizar en servidor, siempre, sin
	// excepción de orden. Ahora las PRE se evalúan aquí, antes de calcular
	// `state`, con el ámbito ya armado (js embebidos, clases, function); las
	// POST siguen evaluándose después, con `state` ya completo, igual que
	// antes. La tolerancia (importada = no tumba el render; propia = sí
	// propaga) se conserva por procedencia, no por el grupo pre/post.
	const allTopDecls = [
		...(imported.topLevelInits || []).map((decl) => ({ decl, tolerant: true })),
		...ast.body.filter((n) => n.type === "ConstDecl" || n.type === "VarDecl").map((decl) => ({ decl, tolerant: false })),
	];
	const needsStateNames = new Set(reactiveMap.keys());
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
	// `resultado` daba `NaN` en vez de `11`). Una llamada a un módulo `.js`
	// embebido o a una clase `.wson` (`new Persona(...)`) NO cuenta: esas
	// nunca tienen acceso a `state` (son JS aislado, sin closure sobre él),
	// así que una const como `TRIPLE_DE_DOS = triple(2)` (de un .js) sí puede
	// adelantarse.
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
			for (const { decl } of allTopDecls) {
				const bound = extractBoundNames(decl.name);
				if (bound.some((n) => needsStateNames.has(n))) continue;
				if (usesAny(decl.expr, needsStateNames) || callsRiskyFunction(decl.expr)) {
					bound.forEach((n) => needsStateNames.add(n));
					changed = true;
				}
			}
		}
	}
	function evalDecl({ decl, tolerant }) {
		let result;
		try {
			result = evalTopLevelDecl(decl, state, reactiveNames, scope);
		} catch (e) {
			if (!tolerant) throw e; // propia: se propaga, es código de esta página
			result = Object.fromEntries(extractBoundNames(decl.name).map((n) => [n, poisonedValue(n, e)]));
		}
		Object.assign(scope, result);
		Object.assign(templateValues, result);
	}
	const preStateEntries = [];
	const postStateEntries = [];
	for (const entry of allTopDecls) {
		const bound = extractBoundNames(entry.decl.name);
		(bound.some((n) => needsStateNames.has(n)) ? postStateEntries : preStateEntries).push(entry);
	}
	preStateEntries.forEach(evalDecl);

	// Snapshot: valores iniciales evaluados una vez, sin reactividad — es
	// texto, no puede actualizarse solo. Se evalúan aquí, con el ámbito ya
	// armado arriba (función, PRE consts, módulos .js, clases .wson).
	for (const [name, expr] of reactiveMap) {
		// eslint-disable-next-line no-new-func
		const value = new Function("__ssrScope", `with (__ssrScope) { return (${expr}); }`)(scope);
		const varType = reactiveTypeMap.get(name);
		if (varType) {
			const msg = typeMismatch(varType, value, `"${name}"`);
			if (msg) throw new TypeError(msg);
		}
		state[name] = value;
	}

	postStateEntries.forEach(evalDecl);
	const boundTopLevelNames = templateValues;

	const ownPageDecl = ast.body.find((n) => n.type === "PageDecl");
	const ownVisuals = [
		...ast.body.filter((n) => n.type === "VisualDecl"),
		...(ownPageDecl ? [{ type: "VisualDecl", name: PAGE_DECL_NAME, html: ownPageDecl.html, htmlErrors: ownPageDecl.htmlErrors, line: ownPageDecl.line }] : []),
	];
	const allVisuals = [...imported.visualDecls, ...ownVisuals];
	const visualsByName = new Map(allVisuals.map((v) => [v.name, v]));

	const ownStyleNames = ast.body.filter((n) => n.type === "StyleDecl").map((n) => n.name);
	const styleNames = new Set([...imported.styleNames, ...ownStyleNames]);

	// Mismo criterio que en generateClientBundle (ver ese fichero para el
	// razonamiento completo): Visual.render() explícito si está; si no, el
	// sistema nuevo (PageDecl siempre gana; si no, una única `visual`
	// implícita; dos o más sin desempate es el conflicto real, con error).
	const renderCall = ast.body.find((n) => n.type === "Raw" && /^Visual\.render\(/.test(n.text));
	let rootVisual = null;
	if (renderCall) {
		const m = /^Visual\.render\((\w+)\)$/.exec(renderCall.text);
		rootVisual = m && visualsByName.get(m[1]);
	} else {
		const implicitTarget = findImplicitPageTarget(ast);
		if (implicitTarget) {
			rootVisual = implicitTarget.type === "PageDecl" ? visualsByName.get(PAGE_DECL_NAME) : implicitTarget;
		} else if (ownVisuals.filter((v) => v.name !== PAGE_DECL_NAME).length > 1) {
			throw new Error(
				`Este .wsf declara ${ownVisuals.length} \`visual\` y no tiene HTML suelto ni Visual.render(): no se sabe cuál renderizar como página. ` +
					"Deja solo una, envuelve el HTML de la página sin nombre, o llama a Visual.render(la_que_sea) explícitamente."
			);
		}
	}
	if (!rootVisual) return "";

	const ctx = { state, visualsByName, styleNames, functions, extraScope: boundTopLevelNames, slots: {} };
	return renderChildrenSSR(rootVisual.html, ctx);
}

module.exports = { renderPageToHTML, escapeHtml };
