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
const path = require("path");
const { resolveImportPath } = require("./resolve-imports");

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
		const re = new RegExp(`(?<!\\.)\\b${name}\\b`, "g");
		out = out.replace(re, `state.${name}`);
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

// Resuelve recursivamente los `import` de un .wsf: componentes de otro
// .wsf (sus VisualDecl se añaden al bundle) y funciones/reactive de un
// .ws (se traducen a JS real e inyectan también). `visited` evita
// reprocesar el mismo fichero dos veces (imports compartidos/circulares).
function collectImportedPieces(ast, baseDir, visited = new Set()) {
	const { parse } = require("./parser");
	const result = { reactiveInits: [], functionSources: [], visualDecls: [], styleNames: [] };

	for (const node of ast.body) {
		if (node.type !== "Import") continue;

		const targetPath = resolveImportPath(baseDir, node.from);
		if (!targetPath) {
			throw new Error(`No se pudo resolver el import "${node.from}" (buscado desde ${baseDir})`);
		}
		if (visited.has(targetPath)) continue;
		visited.add(targetPath);

		if (targetPath.endsWith(".wsf")) {
			const targetAst = parse(fs.readFileSync(targetPath, "utf8"));

			// Primero sus propios imports (para que un componente que a su
			// vez use otro componente quede resuelto también).
			const nested = collectImportedPieces(targetAst, path.dirname(targetPath), visited);
			result.reactiveInits.push(...nested.reactiveInits);
			result.functionSources.push(...nested.functionSources);
			result.visualDecls.push(...nested.visualDecls);

			result.reactiveInits.push(
				...targetAst.body.filter((n) => n.type === "ReactiveDecl").map((n) => ({ name: n.name, expr: n.expr }))
			);
			result.visualDecls.push(...targetAst.body.filter((n) => n.type === "VisualDecl"));
			result.styleNames.push(...targetAst.body.filter((n) => n.type === "StyleDecl").map((n) => n.name));
			continue;
		}

		if (targetPath.endsWith(".ws")) {
			const targetAst = parse(fs.readFileSync(targetPath, "utf8"));
			const declared = targetAst.body.map((n) => (n.type === "Export" ? n.declaration : n));

			for (const name of node.names) {
				const decl = declared.find((d) => d && d.name === name);
				if (!decl) throw new Error(`"${name}" no está exportado en ${targetPath}`);

				if (decl.type === "FunctionDecl") {
					// Las reactive globales que la función pueda usar son las
					// del propio fichero de origen — se resuelven cuando se
					// genera el bundle completo, no aquí; de momento se marca
					// el nombre para sustituir más adelante.
					result.functionSources.push({ node: decl });
				} else if (decl.type === "ReactiveDecl") {
					result.reactiveInits.push({ name: decl.name, expr: decl.expr });
				}
				// ConstDecl/VarDecl exportado de un .ws: fuera de alcance por
				// ahora (poco común, y no es reactive ni función).
			}
			continue;
		}

		throw new Error(`Import no soportado en el cliente: "${node.from}" (solo .wsf y .ws)`);
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

function genIfChain(parentVar, group, ctx, lines) {
	const anchor = uniq("anchorStart");
	const anchorEnd = uniq("anchorEnd");
	lines.push(`const ${anchor} = document.createComment("if");`);
	lines.push(`const ${anchorEnd} = document.createComment("/if");`);
	lines.push(`${parentVar}.appendChild(${anchor});`);
	lines.push(`${parentVar}.appendChild(${anchorEnd});`);

	const branches = group.chain.map((branch) => ({
		cond: branch.type === "Else" ? "true" : substituteReactive(branch.cond, ctx.reactiveNames),
		body: branch.body || [],
	}));

	lines.push(`effect(() => {`);
	// Solo lo que hay ENTRE los dos marcadores es de este bloque — no todo
	// lo que venga después en el padre (puede incluir hermanos ajenos).
	lines.push(`  while (${anchor}.nextSibling !== ${anchorEnd}) ${anchor}.nextSibling.remove();`);
	branches.forEach((b, idx) => {
		lines.push(`  ${idx === 0 ? "if" : "else if"} (${b.cond}) {`);
		lines.push(`    const frag = document.createDocumentFragment();`);
		const inner = [];
		genChildren("frag", b.body, ctx, inner);
		inner.forEach((l) => lines.push("    " + l));
		lines.push(`    ${anchorEnd}.before(frag);`);
		lines.push(`  }`);
	});
	lines.push(`});`);
}

function genFor(parentVar, node, ctx, lines) {
	const anchor = uniq("anchorStart");
	const anchorEnd = uniq("anchorEnd");
	lines.push(`const ${anchor} = document.createComment("for");`);
	lines.push(`const ${anchorEnd} = document.createComment("/for");`);
	lines.push(`${parentVar}.appendChild(${anchor});`);
	lines.push(`${parentVar}.appendChild(${anchorEnd});`);

	const listExpr = substituteReactive(node.list, ctx.reactiveNames);
	const innerCtx = { ...ctx, reactiveNames: ctx.reactiveNames.filter((n) => n !== node.item) };

	lines.push(`effect(() => {`);
	lines.push(`  while (${anchor}.nextSibling !== ${anchorEnd}) ${anchor}.nextSibling.remove();`);
	lines.push(`  const frag = document.createDocumentFragment();`);
	lines.push(`  for (const ${node.item} of ${listExpr}) {`);
	const inner = [];
	genChildren("frag", node.body || [], innerCtx, inner);
	inner.forEach((l) => lines.push("    " + l));
	lines.push(`  }`);
	lines.push(`  ${anchorEnd}.before(frag);`);
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

	const textVar = uniq("t");
	lines.push(`const ${textVar} = ${cursorVar};`);
	lines.push(`${cursorVar} = ${cursorVar}.nextSibling;`);
	if (!hasExpr) return; // texto estático: ya está bien tal cual desde el SSR

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
	lines.push(`const ${anchor} = ${cursorVar};`);
	lines.push(`const ${anchorEnd} = findBlockEnd(${anchor});`);
	lines.push(`${cursorVar} = ${anchorEnd} ? ${anchorEnd}.nextSibling : ${anchor}.nextSibling;`);

	const branches = group.chain.map((branch) => ({
		cond: branch.type === "Else" ? "true" : substituteReactive(branch.cond, ctx.reactiveNames),
		body: branch.body || [],
	}));

	lines.push(`effect(() => {`);
	lines.push(`  while (${anchor}.nextSibling && ${anchor}.nextSibling !== ${anchorEnd}) ${anchor}.nextSibling.remove();`);
	branches.forEach((b, idx) => {
		lines.push(`  ${idx === 0 ? "if" : "else if"} (${b.cond}) {`);
		lines.push(`    const frag = document.createDocumentFragment();`);
		const inner = [];
		genChildren("frag", b.body, ctx, inner);
		inner.forEach((l) => lines.push("    " + l));
		lines.push(`    ${anchorEnd}.before(frag);`);
		lines.push(`  }`);
	});
	lines.push(`});`);
}

function genHydrateFor(cursorVar, node, ctx, lines) {
	const anchor = uniq("anchorStart");
	const anchorEnd = uniq("anchorEnd");
	lines.push(`const ${anchor} = ${cursorVar};`);
	lines.push(`const ${anchorEnd} = findBlockEnd(${anchor});`);
	lines.push(`${cursorVar} = ${anchorEnd} ? ${anchorEnd}.nextSibling : ${anchor}.nextSibling;`);

	const listExpr = substituteReactive(node.list, ctx.reactiveNames);
	const innerCtx = { ...ctx, reactiveNames: ctx.reactiveNames.filter((n) => n !== node.item) };

	lines.push(`effect(() => {`);
	lines.push(`  while (${anchor}.nextSibling && ${anchor}.nextSibling !== ${anchorEnd}) ${anchor}.nextSibling.remove();`);
	lines.push(`  const frag = document.createDocumentFragment();`);
	lines.push(`  for (const ${node.item} of ${listExpr}) {`);
	const inner = [];
	genChildren("frag", node.body || [], innerCtx, inner);
	inner.forEach((l) => lines.push("    " + l));
	lines.push(`  }`);
	lines.push(`  ${anchorEnd}.before(frag);`);
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

function generateClientBundle(ast, { baseDir } = {}) {
	const imported = baseDir
		? collectImportedPieces(ast, baseDir)
		: { reactiveInits: [], functionSources: [], visualDecls: [], styleNames: [] };

	// Las reactive propias del fichero ganan si hay colisión de nombre con
	// una importada (poco probable, pero más predecible así).
	const reactiveMap = new Map(imported.reactiveInits.map((r) => [r.name, r.expr]));
	for (const n of ast.body.filter((n) => n.type === "ReactiveDecl")) reactiveMap.set(n.name, n.expr);
	const reactiveNames = [...reactiveMap.keys()];

	const ownVisuals = ast.body.filter((n) => n.type === "VisualDecl");
	const allVisuals = [...imported.visualDecls, ...ownVisuals];
	const visualNames = new Set(allVisuals.map((v) => v.name));

	const ownStyleNames = ast.body.filter((n) => n.type === "StyleDecl").map((n) => n.name);
	const styleNames = new Set([...imported.styleNames, ...ownStyleNames]);

	const ctx = { reactiveNames, visualNames, styleNames };

	const stateInit = reactiveNames.map((name) => `  ${name}: ${reactiveMap.get(name)},`).join("\n");
	const functionSources = imported.functionSources.map((f) => genFunctionSource(f.node, reactiveNames));

	// const/var de nivel superior que no son reactive (p. ej.
	// `const Visual screen = Visual.route('/personas/:id')`, o
	// `const {id} = Visual.params(screen)`) — se emiten como JS real, con
	// sustitución de reactive globales por si las usan en su expresión.
	const topLevelDecls = ast.body.filter((n) => n.type === "ConstDecl" || n.type === "VarDecl");
	const topLevelSources = topLevelDecls.map((n) => genFunctionStatement(n, reactiveNames));

	const wsonSources = ast.body.filter((n) => n.type === "WsonInlineDecl").map(genWsonInlineSource);

	const renderCall = ast.body.find((n) => n.type === "Raw" && /^Visual\.render\(/.test(n.text));

	const parts = [
		"// Generado por WebScript (codegen-client.js) — no editar a mano",
		RUNTIME_SOURCE,
		`const state = createStore({\n${stateInit}\n});`,
		...functionSources,
		...wsonSources,
		...topLevelSources,
		...allVisuals.map((v) => generateCreateFunction(v, ctx)),
		...allVisuals.map((v) => generateHydrateFunction(v, ctx)),
	];

	if (renderCall) {
		const m = /^Visual\.render\((\w+)\)$/.exec(renderCall.text);
		if (m) {
			// Si hubo SSR, el body ya trae HTML del servidor — se hidrata de
			// verdad (se reutilizan elementos/texto, solo if/for se
			// reconstruyen localmente; ver limitaciones en codegen-ssr.js).
			// Sin SSR, body está vacío salvo por este propio <script> —
			// document.currentScript lo distingue de contenido real, porque
			// mirar solo "firstChild" nunca sabría diferenciarlos (el script
			// también es un hijo de body).
			parts.push(
				`{ const ssrNode = document.body.firstChild; if (ssrNode && ssrNode !== document.currentScript) { hydrate_${m[1]}({}, {}, ssrNode); } else { document.body.appendChild(create_${m[1]}({}, {})); } }`
			);
		}
	}

	return parts.join("\n\n");
}

module.exports = {
	generateClientBundle,
	substituteReactive,
	splitInterpolations,
	groupChildren,
	groupSlotContent,
	collectImportedPieces,
	genFunctionStatement,
};
