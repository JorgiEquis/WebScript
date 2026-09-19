// parser.js — WebScript, v0
//
// Recorre el árbol de líneas del lexer y reconoce, por patrón de texto, las
// declaraciones de nivel superior del lenguaje. Todo lo que no reconoce
// (una etiqueta HTML dentro de un `visual`, una sentencia JS suelta dentro
// de un `watch`, etc.) se queda como nodo "Raw" — es la frontera real de
// este primer corte: estructura del árbol resuelta, contenido de cada nodo
// pendiente de un parser dedicado por contexto (HTML, expresiones JS...).

const TOP_LEVEL_RE = [
	/^import\b/,
	/^export\b/,
	/^style\s+\w+\s*=/,
	/^visual\s+\w+\s*=/,
	/^reactive\b/,
	/^var\b/,
	/^const\b/,
	/^watch\(/,
	/^function\b/,
	/^Visual\.render\(/,
];

function isTopLevelBoundary(text) {
	return TOP_LEVEL_RE.some((re) => re.test(text));
}

// A diferencia de todo lo demás, la plantilla de un `visual` NO se anida
// por indentación (el `<div>` va al margen, igual que la propia cabecera
// `visual nombre =`) — se reconoce por tags abrir/cerrar. Por eso el
// `visual` se trocea aparte de la indentación genérica: se consumen líneas
// hasta la siguiente declaración de nivel superior real, no hasta que baje
// la indentación.
function splitTopLevel(lines) {
	const chunks = [];
	let i = 0;

	while (i < lines.length) {
		const header = lines[i];
		let j = i + 1;

		if (/^visual\s+\w+\s*=/.test(header.text)) {
			while (j < lines.length && !(lines[j].indent === header.indent && isTopLevelBoundary(lines[j].text))) {
				j++;
			}
		} else {
			while (j < lines.length && lines[j].indent > header.indent) {
				j++;
			}
		}

		chunks.push({ header, rest: lines.slice(i + 1, j) });
		i = j;
	}

	return chunks;
}

// Dentro de la plantilla, si/for SÍ vuelven a usar indentación para acotar
// su propio cuerpo (eso no ha cambiado) — solo las líneas HTML sueltas se
// tratan como una secuencia plana, sin anidar por indentación.
function collectIndented(lines, start, parentIndent) {
	const body = [];
	let j = start;
	while (j < lines.length && lines[j].indent > parentIndent) {
		body.push(lines[j]);
		j++;
	}
	return { body, next: j };
}

function parseTemplateSequence(lines) {
	const items = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		let m;

		if ((m = /^if\s*\((.*)\)$/.exec(line.text))) {
			const { body, next } = collectIndented(lines, i + 1, line.indent);
			items.push({ type: "If", cond: m[1], body: parseTemplateSequence(body), line: line.line });
			i = next;
		} else if ((m = /^else if\s*\((.*)\)$/.exec(line.text))) {
			const { body, next } = collectIndented(lines, i + 1, line.indent);
			items.push({ type: "ElseIf", cond: m[1], body: parseTemplateSequence(body), line: line.line });
			i = next;
		} else if (/^else$/.test(line.text)) {
			const { body, next } = collectIndented(lines, i + 1, line.indent);
			items.push({ type: "Else", body: parseTemplateSequence(body), line: line.line });
			i = next;
		} else if ((m = /^for\s*\((\w+)\s+in\s+(.*)\)$/.exec(line.text))) {
			const { body, next } = collectIndented(lines, i + 1, line.indent);
			items.push({ type: "For", item: m[1], list: m[2], body: parseTemplateSequence(body), line: line.line });
			i = next;
		} else {
			items.push({ type: "Raw", text: line.text, line: line.line });
			i++;
		}
	}

	return items;
}

function parseVisualChunk(header, rest) {
	const { buildHtmlTree } = require("./html-parser");
	const m = /^visual\s+(\w+)\s*=\s*(.*)$/.exec(header.text);
	const name = m[1];
	const inline = m[2] || null;

	// Ya no existe estado local por instancia: una `reactive` dentro de un
	// `visual` es un error de diseño, no una declaración válida — el caso
	// que cubría (estado propio por elemento de una lista) se resuelve con
	// `props` + guardando el estado dentro del propio dato.
	const reactiveInside = inline ? [] : rest.filter((l) => /^reactive\b/.test(l.text));
	const templateLines = inline ? rest : rest.filter((l) => !/^reactive\b/.test(l.text));

	const templateItems = inline
		? [{ type: "Raw", text: inline, line: header.line }]
		: parseTemplateSequence(templateLines);

	const html = buildHtmlTree(templateItems);
	const errors = html.errors.concat(
		reactiveInside.map((l) => ({
			line: l.line,
			message: "una 'reactive' dentro de un visual ya no está soportada (no hay estado local por instancia) — usa una reactive global y pásala como prop",
		}))
	);

	return { type: "VisualDecl", name, html: html.children, htmlErrors: errors, line: header.line };
}

const RULES = [
	{
		type: "Import",
		re: /^import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']$/,
		build: (m) => ({ names: m[1].split(",").map((s) => s.trim()), from: m[2] }),
	},
	{
		// export delante de cualquier otra declaración: se re-parsea el resto
		// y se marca como exportada.
		type: "Export",
		re: /^export\s+(.+)$/,
		build: (m, node) => {
			const inner = parseNode({ ...node, text: m[1] });
			return { declaration: inner };
		},
	},
	{
		type: "StyleDecl",
		re: /^style\s+(\w+)\s*=\s*(.*)$/,
		build: (m) => ({ name: m[1], inline: m[2] || null }),
		body: (node) => node.children.map(parsePropertyLine),
	},
	{
		type: "WsonInlineDecl",
		// const WSON nombre = ...   (WSON declarado en código, no en un .wson)
		re: /^const\s+WSON\s+(\w+)\s*=\s*(.*)$/,
		build: (m) => ({ name: m[1] }),
		body: (node) => node.children.map(parseWsonMetaLine),
	},
	{
		type: "ReactiveDecl",
		re: /^reactive\s+(?:(\w+)\s+)?(\w+)\s*=\s*(.*)$/,
		build: (m) => ({
			varType: m[1] || null,
			name: m[2],
			expr: m[3],
			isListen: /^WSON\.listen\(/.test(m[3]),
		}),
	},
	{
		type: "VarDecl",
		re: /^var\s+(?:([\w/]+)\s+)?(\{[^}]*\}|\w+)\s*=\s*(.*)$/,
		build: (m) => ({ varType: m[1] || null, name: m[2], expr: m[3] }),
	},
	{
		type: "ConstDecl",
		re: /^const\s+(?:(\w+)\s+)?(\{[^}]*\}|\w+)\s*=\s*(.*)$/,
		build: (m) => ({ varType: m[1] || null, name: m[2], expr: m[3] }),
	},
	{
		type: "WatchDecl",
		re: /^watch\((\w+)\)$/,
		build: (m) => ({ target: m[1] }),
		body: (node) => node.children.map(parseNode),
	},
	{
		type: "If",
		re: /^if\s*\((.*)\)$/,
		build: (m) => ({ cond: m[1] }),
		body: (node) => node.children.map(parseNode),
	},
	{
		type: "ElseIf",
		re: /^else if\s*\((.*)\)$/,
		build: (m) => ({ cond: m[1] }),
		body: (node) => node.children.map(parseNode),
	},
	{
		type: "Else",
		re: /^else$/,
		build: () => ({}),
		body: (node) => node.children.map(parseNode),
	},
	{
		type: "For",
		re: /^for\s*\((\w+)\s+in\s+(.*)\)$/,
		build: (m) => ({ item: m[1], list: m[2] }),
		body: (node) => node.children.map(parseNode),
	},
	{
		type: "FunctionDecl",
		re: /^function\s+(\w+)\(([^)]*)\)$/,
		build: (m) => ({ name: m[1], params: splitParams(m[2]) }),
		body: (node) => node.children.map(parseNode),
	},
];

function splitParams(s) {
	return s
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => {
			// "string arg1" -> tipado; "arg1" a secas -> sin tipo (sigue
			// siendo válido, el tipado en parámetros es opcional).
			const m = /^([\w/]+)\s+(\w+)$/.exec(p);
			if (m) return { paramType: m[1], name: m[2] };
			return { paramType: null, name: p };
		});
}

// Líneas hijas de un `style`: "-> propiedad: valor"
function parsePropertyLine(node) {
	const m = /^->\s*([\w-]+)\s*:\s*(.+)$/.exec(node.text);
	if (!m) return { type: "Raw", text: node.text, line: node.line };
	return { type: "Property", key: m[1], value: m[2], line: node.line };
}

// Líneas hijas de un WSON ad-hoc o de un fichero .wson: "-> clave: valor",
// con soporte especial para "-> content:" cuyo cuerpo es el esquema del DTO
// (anidado por indentación, sin flecha).
function parseWsonMetaLine(node) {
	const m = /^->\s*(\w+)\s*:\s*(.*)$/.exec(node.text);
	if (!m) return { type: "Raw", text: node.text, line: node.line };

	if (m[1] === "content" && m[2] === "") {
		return {
			type: "ContentSchema",
			fields: node.children.map(parseSchemaField),
			line: node.line,
		};
	}
	return { type: "MetaField", key: m[1], value: m[2], line: node.line };
}

// Líneas del esquema dentro de "content:" en un .wson: "campo: tipo",
// con anidamiento para objetos.
function parseSchemaField(node) {
	const m = /^(\w+)\s*:\s*(.*)$/.exec(node.text);
	if (!m) return { type: "Raw", text: node.text, line: node.line };

	const [, name, rawType] = m;
	const optional = rawType.endsWith("/");
	const type = optional ? rawType.slice(0, -1) : rawType;

	if (node.children.length > 0) {
		// "object" implícito: hay subcampos anidados. El tipo tras ":" puede
		// venir vacío ("direccion:") o, en teoría, ausente del todo.
		return {
			type: "SchemaField",
			name,
			fieldType: "object",
			optional,
			fields: node.children.map(parseSchemaField),
			line: node.line,
		};
	}
	return { type: "SchemaField", name, fieldType: type, optional, line: node.line };
}

// Fichero .wson "puro": empieza directamente con líneas "-> clave: valor" a
// nivel raíz, sin un "const WSON nombre =" delante.
function parseWsonFile(topLevelNodes) {
	return { type: "WsonSchema", fields: topLevelNodes.map(parseWsonMetaLine) };
}

function parseNode(node) {
	for (const rule of RULES) {
		const m = rule.re.exec(node.text);
		if (!m) continue;
		const built = rule.build(m, node);
		const bodyResult = rule.body ? rule.body(node) : null;
		// Si el cuerpo es un array (If/For/watch/...), va bajo la clave
		// "body"; si ya es un objeto con sus propias claves (style, visual,
		// wson ad-hoc), se mezcla tal cual.
		const bodyProps = Array.isArray(bodyResult)
			? { body: bodyResult }
			: bodyResult || {};
		return { type: rule.type, ...built, ...bodyProps, line: node.line };
	}
	// No reconocida: nodo crudo (HTML, sentencia JS suelta, etc.), con sus
	// hijos también parseados por si son control de flujo o más HTML.
	return {
		type: "Raw",
		text: node.text,
		children: node.children.map(parseNode),
		line: node.line,
	};
}

function parse(source, { isWsonFile = false } = {}) {
	const { tokenize, buildTree } = require("./lexer");

	if (isWsonFile) {
		const tree = buildTree(tokenize(source));
		return parseWsonFile(tree);
	}

	const lines = tokenize(source);
	const chunks = splitTopLevel(lines);

	const body = chunks.map(({ header, rest }) => {
		if (/^visual\s+\w+\s*=/.test(header.text)) {
			return parseVisualChunk(header, rest);
		}
		return parseNode({ ...header, children: buildTree(rest) });
	});

	return { type: "Program", body };
}

module.exports = { parse };
