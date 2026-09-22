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
		// la clave se queda tal cual.
		const re = new RegExp(`(?<![.\\w])(?<![{,]\\s{0,20})\\b${name}\\b(?!\\s{0,20}:)`, "g");
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
	const result = { reactiveInits: [], functionSources: [], visualDecls: [], styleNames: [], topLevelInits: [], classSources: [], jsModuleSources: [] };

	for (const node of ast.body) {
		if (node.type !== "Import") continue;

		if (isPackageSpecifier(node.from)) {
			// A diferencia del servidor (donde esto es un require() real,
			// sin riesgo), aquí no hay ningún bundler que resuelva las
			// propias dependencias del paquete — incrustar su código a
			// ciegas podría producir un bundle roto de formas difíciles de
			// prever. Se rechaza con un mensaje claro, no en silencio.
			throw new Error(
				`No se puede importar el paquete "${node.from}" desde el cliente: no hay un bundler que resuelva sus propias dependencias (sí funciona en servidor, desde un .wsb). Si es código propio sin dependencias externas, usa una ruta relativa a un .js en su lugar.`
			);
		}

		const targetPath = resolveImportPath(baseDir, node.from);
		if (!targetPath) {
			throw new Error(`No se pudo resolver el import "${node.from}" (buscado desde ${baseDir})`);
		}
		if (visited.has(targetPath)) continue;
		visited.add(targetPath);

		if (targetPath.endsWith(".js")) {
			// JS normal ya existente, sin sus propias dependencias externas
			// — vía de adopción incremental: meter WebScript fichero a
			// fichero en un proyecto Node ya existente. Se incrusta su
			// código fuente tal cual, envuelto en un módulo CommonJS
			// aislado (module.exports/exports) — si ese .js a su vez
			// importara/requiriera otra cosa, eso NO se resuelve aquí (sin
			// bundler, solo se admite un fichero suelto).
			const moduleId = `__jsmod_${result.jsModuleSources.length}`;
			const jsSource = fs.readFileSync(targetPath, "utf8");
			result.jsModuleSources.push(
				`const ${moduleId} = (function () {\n  const module = { exports: {} };\n  const exports = module.exports;\n${jsSource}\n  return module.exports;\n})();`
			);
			if (node.isDefault) {
				result.topLevelInits.push({ type: "ConstDecl", varType: null, name: node.names[0], expr: moduleId });
			} else {
				for (const name of node.names) {
					result.topLevelInits.push({ type: "ConstDecl", varType: null, name, expr: `${moduleId}.${name}` });
				}
			}
			continue;
		}

		if (targetPath.endsWith(".wsdb")) {
			// Una base de datos es, por definición, algo del servidor — no
			// hay forma segura ni con sentido de que el navegador hable con
			// SQLite directamente. Mismo criterio que un paquete de npm:
			// rechazo explícito, con mensaje claro, no un error genérico.
			throw new Error(
				`No se puede importar "${node.from}" desde el cliente: un .wsdb es una base de datos, solo tiene sentido en el servidor (desde un .wsb).`
			);
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
				result.topLevelInits.push({ type: "ConstDecl", varType: null, name: node.names[0], expr: JSON.stringify(jsonContent) });
			} else {
				for (const name of node.names) {
					result.topLevelInits.push({
						type: "ConstDecl",
						varType: null,
						name,
						expr: JSON.stringify(jsonContent[name]),
					});
				}
			}
			continue;
		}

		if (targetPath.endsWith(".wsf")) {
			const targetAst = parse(fs.readFileSync(targetPath, "utf8"));

			// Primero sus propios imports (para que un componente que a su
			// vez use otro componente quede resuelto también).
			const nested = collectImportedPieces(targetAst, path.dirname(targetPath), visited);
			result.reactiveInits.push(...nested.reactiveInits);
			result.functionSources.push(...nested.functionSources);
			result.visualDecls.push(...nested.visualDecls);
			result.topLevelInits.push(...nested.topLevelInits);
			result.classSources.push(...nested.classSources);
			result.jsModuleSources.push(...nested.jsModuleSources);

			result.reactiveInits.push(
				...targetAst.body.filter((n) => n.type === "ReactiveDecl").map((n) => ({ name: n.name, expr: n.expr, varType: n.varType }))
			);
			// Las function declaradas directamente en el .wsf importado
			// (no solo las que a su vez importa de un .ws) también viajan
			// — antes se quedaban fuera, y una función de un componente
			// importado que la usara en su propio onclick/interpolación se
			// quedaba sin definir en el bundle.
			result.functionSources.push(...targetAst.body.filter((n) => n.type === "FunctionDecl").map((n) => ({ node: n })));
			// const/var de nivel superior del .wsf importado — mismo
			// criterio que reactive/function: se traen TODOS sin
			// condición, la pida o no el import por nombre (antes no se
			// traían en absoluto: ReferenceError real al usarlos).
			result.topLevelInits.push(...targetAst.body.filter((n) => n.type === "ConstDecl" || n.type === "VarDecl"));
			result.visualDecls.push(...targetAst.body.filter((n) => n.type === "VisualDecl"));
			result.styleNames.push(...targetAst.body.filter((n) => n.type === "StyleDecl").map((n) => n.name));
			continue;
		}

		if (targetPath.endsWith(".wson")) {
			const wsonAst = parse(fs.readFileSync(targetPath, "utf8"), { isWsonFile: true });
			for (const name of node.names) {
				result.classSources.push(genDtoClassSource(wsonAst, name));
			}
			continue;
		}

		if (targetPath.endsWith(".ws")) {
			const targetAst = parse(fs.readFileSync(targetPath, "utf8"));
			const declared = targetAst.body.map((n) => (n.type === "Export" ? n.declaration : n));

			// TODAS las reactive del .ws se traen sin condición — igual
			// que ya se hace al importar de otro .wsf (línea ~176). Una
			// función importada puede depender de una reactive "hermana"
			// que nadie pidió en el import; sin esto, se quedaba sin
			// definir de verdad (ReferenceError real, no solo un valor
			// perdido — confirmado antes de este arreglo).
			result.reactiveInits.push(
				...targetAst.body
					.filter((n) => n.type === "ReactiveDecl")
					.map((n) => ({ name: n.name, expr: n.expr, varType: n.varType }))
			);
			// const/var de nivel superior del .ws — mismo criterio: se
			// traen todos sin condición (antes no se traían en absoluto).
			result.topLevelInits.push(...targetAst.body.filter((n) => n.type === "ConstDecl" || n.type === "VarDecl"));

			for (const name of node.names) {
				const decl = declared.find((d) => d && d.name === name);
				if (!decl) throw new Error(`"${name}" no está exportado en ${targetPath}`);

				if (decl.type === "FunctionDecl") {
					// Las reactive globales que la función pueda usar son las
					// del propio fichero de origen — ya se trajeron arriba,
					// se resuelven cuando se genera el bundle completo.
					result.functionSources.push({ node: decl });
				}
				// ReactiveDecl y ConstDecl/VarDecl: ya se trajeron arriba
				// (todos, no solo los pedidos por nombre).
			}
			continue;
		}

		throw new Error(`Import no soportado en el cliente: "${node.from}" (solo .wsf, .ws, .wson y .js)`);
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

function generateClientBundle(ast, { baseDir } = {}) {
	const imported = baseDir
		? collectImportedPieces(ast, baseDir)
		: { reactiveInits: [], functionSources: [], visualDecls: [], styleNames: [], topLevelInits: [], classSources: [], jsModuleSources: [] };

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

	const ownVisuals = ast.body.filter((n) => n.type === "VisualDecl");
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

	// const/var de nivel superior SIN relación con la ruta (p. ej. algo
	// derivado de una reactive) — se emiten como JS real, una sola vez.
	const topLevelSources = plainTopLevelDecls.map((n) => genFunctionStatement(n, reactiveNames));

	// Los derivados de ruta se recalculan dentro de un único effect() — la
	// primera ejecución (inmediata, como todo effect()) deja los valores
	// iniciales en `state`, y las siguientes ocurren solas cuando cambia
	// la URL. `reactiveNamesForRouteEffect` NO incluye los propios nombres
	// route-derived (dentro del effect son locals `const` normales, no se
	// prefijan con `state.`), pero SÍ las reactive de verdad del fichero.
	const reactiveNamesForRouteEffect = [...reactiveMap.keys()];
	let routeEffectSource = "";
	if (routeDerivedDecls.length > 0) {
		const body = routeDerivedDecls
			.map((d) => {
				const rhs = substituteReactive(d.expr, reactiveNamesForRouteEffect);
				const assigns = extractBoundNames(d.name)
					.map((n) => `  state.${n} = ${n};`)
					.join("\n");
				return `  const ${d.name} = (${rhs});\n${assigns}`;
			})
			.join("\n");
		routeEffectSource = `effect(() => {\n${body}\n});`;
	}

	const wsonSources = ast.body.filter((n) => n.type === "WsonInlineDecl").map(genWsonInlineSource);

	const renderCall = ast.body.find((n) => n.type === "Raw" && /^Visual\.render\(/.test(n.text));

	const parts = [
		"// Generado por WebScript (codegen-client.js) — no editar a mano",
		RUNTIME_SOURCE,
		...jsModuleSources,
		...classSources,
		typedNames.length > 0
			? `const state = createStore({\n${stateInit}\n}, {\n${typeSchemaLiteral}\n});`
			: `const state = createStore({\n${stateInit}\n});`,
		...functionSources,
		...wsonSources,
		...topLevelSources,
		...(routeEffectSource ? [routeEffectSource] : []),
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
