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
} = require("./codegen-client");

const { compileRoutePatternClient } = require("./runtime");

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

// Compila una función importada de .ws a una función JS real, con closure
// sobre `state` — reutiliza el mismo generador de cuerpo que el cliente
// (sustituye reactive globales por `state.NOMBRE`), pero aquí se evalúa de
// verdad en vez de emitirse como texto para un navegador.
function compileFunctionForSSR(fnNode, reactiveNames, stateObj) {
	const paramNames = (fnNode.params || []).map((p) => p.name);
	const body = (fnNode.body || []).map((n) => genFunctionStatement(n, reactiveNames)).join("\n");
	// eslint-disable-next-line no-new-func
	const factory = new Function("state", `return function(${paramNames.join(", ")}) {\n${body}\n};`);
	return factory(stateObj);
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

	const childCtx = { ...ctx, extraScope: { props }, slots };
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
	if (group.type === "Text") return renderTextSSR(group, ctx);
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
function renderPageToHTML(ast, { baseDir, requestUrl = "/" } = {}) {
	const imported = baseDir
		? collectImportedPieces(ast, baseDir)
		: { reactiveInits: [], functionSources: [], visualDecls: [], styleNames: [] };

	const reactiveMap = new Map(imported.reactiveInits.map((r) => [r.name, r.expr]));
	for (const n of ast.body.filter((n) => n.type === "ReactiveDecl")) reactiveMap.set(n.name, n.expr);

	// Snapshot: valores iniciales evaluados una vez, sin reactividad — es
	// texto, no puede actualizarse solo.
	const state = {};
	for (const [name, expr] of reactiveMap) {
		// eslint-disable-next-line no-new-func
		state[name] = new Function(`return (${expr});`)();
	}

	const reactiveNames = [...reactiveMap.keys()];
	const functions = {};
	for (const f of imported.functionSources) {
		functions[f.node.name] = compileFunctionForSSR(f.node, reactiveNames, state);
	}

	// const/var de nivel superior (Visual.route(), destructuring de
	// params()/query()...) — se resuelven en orden, cada uno puede usar los
	// anteriores. `Visual` aquí es la versión SSR, resuelta contra
	// `requestUrl` en vez de `window.location`.
	const topScope = { Visual: createSSRVisual(requestUrl), ...functions };
	const boundTopLevelNames = {};
	for (const decl of ast.body.filter((n) => n.type === "ConstDecl" || n.type === "VarDecl")) {
		const boundNames = extractBoundNames(decl.name);
		const scopeNames = Object.keys(topScope);
		const scopeValues = scopeNames.map((n) => topScope[n]);
		const translatedExpr = substituteReactive(decl.expr, reactiveNames);
		const body = `const ${decl.name} = (${translatedExpr}); return { ${boundNames.join(", ")} };`;
		// eslint-disable-next-line no-new-func
		const factory = new Function("state", ...scopeNames, body);
		const result = factory(state, ...scopeValues);
		Object.assign(topScope, result);
		Object.assign(boundTopLevelNames, result);
	}

	const ownVisuals = ast.body.filter((n) => n.type === "VisualDecl");
	const allVisuals = [...imported.visualDecls, ...ownVisuals];
	const visualsByName = new Map(allVisuals.map((v) => [v.name, v]));

	const ownStyleNames = ast.body.filter((n) => n.type === "StyleDecl").map((n) => n.name);
	const styleNames = new Set([...imported.styleNames, ...ownStyleNames]);

	const renderCall = ast.body.find((n) => n.type === "Raw" && /^Visual\.render\(/.test(n.text));
	if (!renderCall) return "";
	const m = /^Visual\.render\((\w+)\)$/.exec(renderCall.text);
	const rootVisual = m && visualsByName.get(m[1]);
	if (!rootVisual) return "";

	const ctx = { state, visualsByName, styleNames, functions, extraScope: boundTopLevelNames, slots: {} };
	return renderChildrenSSR(rootVisual.html, ctx);
}

module.exports = { renderPageToHTML, escapeHtml };
